/**
 * crm.ts — LINE「#新規」紹介登録 → CRM_顧客 自動起票
 * ============================================================================
 * MDNEXT秘書に追加された「紹介客のCRM登録」機能。
 * webhook/route.ts が #新規 で始まるメッセージを検知してここに委譲する。
 * 既存のタスク秘書機能とは完全に独立（この分岐に入らないメッセージは無影響）。
 *
 * 必要な環境変数（.env.local と Vercel の両方）:
 *   CRM_NOTION_TOKEN       … CRM側インテグレーション「CRM自動化」のトークン
 *   CRM_ACCOUNTS_DB_ID     … CRM_顧客 のDB ID
 *   CRM_ACTIVITIES_DB_ID   … CRM_履歴 のDB ID
 *
 * ロジックの正は Customer relationship management リポジトリ:
 *   scripts/dedupe/normalize.py（正規化ルール）/ docs/00_データ辞書.md（スキーマ）
 * 正規化ルール変更時は normalize.py・line_intake.gs・本ファイルを同時更新すること。
 * ============================================================================
 */
import { Client } from "@notionhq/client";

const crm = new Client({ auth: process.env.CRM_NOTION_TOKEN });
const ACCOUNTS_DB = process.env.CRM_ACCOUNTS_DB_ID!;
const ACTIVITIES_DB = process.env.CRM_ACTIVITIES_DB_ID!;

/** 「#新規」または「＃新規」で始まるか。route.ts の分岐判定に使う。 */
export function isNewCustomerCommand(text: string): boolean {
  return /^[#＃]新規/.test(text.trim());
}

interface ParsedCustomer {
  name: string;
  kana: string;
  phone: string;
  property: string;
  referrer: string;
}

/**
 * 「#新規 氏名/フリガナ/電話/物件/紹介者」をパース。区切りは半角/全角スラッシュ。
 * 後方互換: 2番目が電話番号のときは旧形式「氏名/電話/物件/紹介者」（フリガナ省略）とみなす。
 */
export function parseNewCustomer(
  text: string
): ParsedCustomer | { error: string } {
  const rest = text.trim().replace(/^[#＃]新規/, "").trim();
  if (!rest) return { error: "氏名と電話番号が入力されていません" };
  const parts = rest.split(/[/／]/).map((p) => p.trim());
  const name = parts[0] || "";
  if (!name) return { error: "氏名が入力されていません" };

  // 2番目が電話番号として成立するなら旧形式（フリガナなし）と判定
  const secondIsPhone = /^0\d{9,10}$/.test(normalizePhone(parts[1] || ""));
  let kana: string, phone: string, property: string, referrer: string;
  if (secondIsPhone) {
    kana = "";
    phone = parts[1] || "";
    property = parts[2] || "";
    referrer = parts[3] || "";
  } else {
    kana = parts[1] || "";
    phone = parts[2] || "";
    property = parts[3] || "";
    referrer = parts[4] || "";
  }
  if (!phone) return { error: "電話番号が入力されていません（名寄せに必須です）" };
  return { name, kana, phone, property, referrer };
}

/**
 * 電話番号の正規化。normalize.py / line_intake.gs と同一ルール
 * （全角→半角 → 数字以外除去 → 81始まりは0に変換）。
 */
export function normalizePhone(s: string): string {
  if (!s) return "";
  let str = String(s).replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
  str = str.replace(/＋/g, "+");
  let digits = str.replace(/[^0-9]/g, "");
  if (digits.startsWith("81")) digits = "0" + digits.slice(2);
  return digits;
}

/**
 * フリガナ正規化。normalize.py の normalize_kana に準拠。
 * NFKCで半角カナ→全角カナ（濁点結合込み）、ひらがな→カタカナ、空白除去。
 */
export function normalizeKana(s: string): string {
  if (!s) return "";
  let t = s.normalize("NFKC");
  t = t.replace(/[ぁ-ゖ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
  return t.replace(/[\s　]/g, "");
}

function titleOf(page: unknown): string {
  const props =
    (
      page as {
        properties?: Record<
          string,
          { type: string; title?: Array<{ plain_text: string }> }
        >;
      }
    ).properties ?? {};
  for (const k of Object.keys(props)) {
    if (props[k].type === "title") {
      return (props[k].title ?? []).map((t) => t.plain_text).join("");
    }
  }
  return "";
}

async function findAccountByPhone(phoneNorm: string) {
  const res = await crm.databases.query({
    database_id: ACCOUNTS_DB,
    filter: { property: "電話番号_正規化", rich_text: { equals: phoneNorm } },
    page_size: 1,
  });
  return res.results[0] ?? null;
}

async function createActivity(
  subject: string,
  accountId: string,
  content: string
): Promise<void> {
  await crm.pages.create({
    parent: { database_id: ACTIVITIES_DB },
    properties: {
      件名: { title: [{ text: { content: subject } }] },
      日時: { date: { start: new Date().toISOString() } },
      種別: { select: { name: "LINE" } },
      顧客: { relation: [{ id: accountId }] },
      内容: { rich_text: [{ text: { content: content.slice(0, 1900) } }] },
    },
  });
}

function usage(reason: string): string {
  return (
    `登録できませんでした: ${reason}\n\n` +
    "送信フォーマット:\n#新規 氏名/フリガナ/電話番号/物件/紹介者\n" +
    "（フリガナ・物件・紹介者は省略可。氏名と電話番号は必須。区切りは「/」）"
  );
}

/**
 * 「#新規」メッセージを処理し、LINEに返す文言を返す。
 * 既存客（電話番号一致）は新規作成せず履歴追記のみ（名寄せ）。
 */
export async function handleNewCustomer(text: string): Promise<string> {
  const parsed = parseNewCustomer(text);
  if ("error" in parsed) return usage(parsed.error);

  const phoneNorm = normalizePhone(parsed.phone);
  if (!/^0\d{9,10}$/.test(phoneNorm)) {
    return usage(
      `電話番号の形式が不正です（正規化後: ${phoneNorm}）。携帯・固定の10〜11桁で入力してください`
    );
  }

  // 名寄せ: 電話番号_正規化で既存客を照合
  const existing = await findAccountByPhone(phoneNorm);
  if (existing) {
    const name = titleOf(existing) || parsed.name;
    await createActivity(
      "LINE経由の重複登録試行",
      existing.id,
      `既存顧客にヒットしたため新規作成せず履歴のみ追記。\n受信原文: ${text}\n` +
        `パース: 氏名=${parsed.name} / 電話=${parsed.phone}（正規化 ${phoneNorm}） / ` +
        `物件=${parsed.property || "-"} / 紹介者=${parsed.referrer || "-"}`
    );
    return (
      `既存顧客「${name}」に一致したため、新規登録せず履歴に追記しました。\n` +
      `（電話番号: ${phoneNorm}）`
    );
  }

  // 新規起票
  const remark = ["LINE #新規 経由で自動起票。"];
  if (parsed.referrer)
    remark.push(
      `紹介者: ${parsed.referrer}（「紹介者」リレーションは手動設定してください）`
    );
  if (parsed.property) remark.push(`問合せ物件: ${parsed.property}`);

  const page = await crm.pages.create({
    parent: { database_id: ACCOUNTS_DB },
    properties: {
      氏名: { title: [{ text: { content: parsed.name } }] },
      ...(parsed.kana && {
        氏名カナ: {
          rich_text: [{ text: { content: normalizeKana(parsed.kana) } }],
        },
      }),
      区分: { select: { name: "個人" } },
      電話番号: { phone_number: parsed.phone },
      電話番号_正規化: { rich_text: [{ text: { content: phoneNorm } }] },
      顧客ソース: { select: { name: "紹介" } },
      登録経路: { select: { name: "LINE" } },
      ステータス: { select: { name: "新規" } },
      統合ステータス: { select: { name: "未確認" } },
      備考: { rich_text: [{ text: { content: remark.join("\n") } }] },
    },
  });

  await createActivity(
    "LINE紹介登録受付",
    page.id,
    `LINEの #新規 フォーマットから自動起票。\n受信原文: ${text}\n` +
      `問合せ物件: ${parsed.property || "-"} / 紹介者: ${parsed.referrer || "-"}`
  );

  return (
    `✅ 新規顧客「${parsed.name}」を登録しました。` +
    (parsed.referrer
      ? `\n紹介者「${parsed.referrer}」は備考に記録済み。Notionの「紹介者」リレーション設定をお願いします。`
      : "\n※紹介者が未入力です。分かり次第Notionで設定してください。")
  );
}
