/**
 * crm.ts — LINE「#新規」紹介登録 → CRM_顧客 自動起票
 * ============================================================================
 * MDNEXT秘書に追加された「紹介客のCRM登録」機能。
 * webhook/route.ts が #新規 で始まるメッセージを検知してここに委譲する。
 * 既存のタスク秘書機能とは独立（この分岐に入らないメッセージは無影響）。
 *
 * 送信フォーマット: #新規 氏名/フリガナ/連絡先/物件/紹介者
 *   - フリガナ・物件・紹介者は省略可。氏名と連絡先は必須。
 *   - 連絡先は「電話番号」「メールアドレス」または状況語（不明/メール/LINE/紹介者経由 等）。
 *   - 2番目が連絡先に見えるときはフリガナ省略（氏名/連絡先/…）として解釈。
 *
 * 必要な環境変数（.env.local と Vercel の両方）:
 *   CRM_NOTION_TOKEN / CRM_ACCOUNTS_DB_ID / CRM_ACTIVITIES_DB_ID
 *
 * 正規化ルールの正は normalize.py（Customer relationship managementリポジトリ）。
 * ============================================================================
 */
import { Client } from "@notionhq/client";

const crm = new Client({ auth: process.env.CRM_NOTION_TOKEN });
const ACCOUNTS_DB = process.env.CRM_ACCOUNTS_DB_ID!;
const ACTIVITIES_DB = process.env.CRM_ACTIVITIES_DB_ID!;

/** 連絡先が電話でない場合の「状況語」。これらは電話番号なしで登録を通す。 */
const SITUATION_RE =
  /^(不明|未確認|なし|未取得|確認中|後で|あとで|メール|ﾒｰﾙ|e-?mail|mail|LINE|ライン|らいん|line|SMS|連絡不可|連絡取れ|音信不通|経由|紹介者経由|業者経由)/i;

/** 「#新規／＃新規／♯新規」で始まるか。route.ts の分岐判定に使う。 */
export function isNewCustomerCommand(text: string): boolean {
  return /^[#＃♯]\s*新規/.test(text.trim());
}

interface ParsedCustomer {
  name: string;
  kana: string;
  phone: string; // 妥当な電話番号のみ。無ければ ""
  email: string; // メールアドレス。無ければ ""
  contactNote: string; // 電話・メール以外の状況語（不明/メール/LINE 等）
  property: string;
  referrer: string;
}

/** 電話番号の正規化（normalize.py の normalize_phone と同一ルール）。 */
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

/** フリガナ正規化（NFKCで半角カナ→全角、ひらがな→カタカナ、空白除去）。 */
export function normalizeKana(s: string): string {
  if (!s) return "";
  let t = s.normalize("NFKC");
  t = t.replace(/[ぁ-ゖ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
  return t.replace(/[\s　]/g, "");
}

function isValidPhone(s: string): boolean {
  return /^0\d{9,10}$/.test(normalizePhone(s));
}

/** その文字列が「連絡先（電話/メール/状況語）」として成立するか。フリガナ有無の判定に使う。 */
function looksLikeContact(s: string): boolean {
  const t = (s || "").trim();
  if (!t) return false;
  return isValidPhone(t) || t.includes("@") || SITUATION_RE.test(t);
}

/** 連絡先欄を 電話 / メール / 状況語 に振り分ける。 */
function classifyContact(s: string): {
  phone: string;
  email: string;
  note: string;
} {
  const t = (s || "").trim();
  if (!t) return { phone: "", email: "", note: "" };
  if (isValidPhone(t)) return { phone: t, email: "", note: "" };
  if (t.includes("@")) return { phone: "", email: t, note: "" };
  return { phone: "", email: "", note: t };
}

/**
 * 「#新規 氏名/フリガナ/連絡先/物件/紹介者」をパース。
 * 2番目が連絡先に見えるときはフリガナ省略「氏名/連絡先/…」と解釈（後方互換）。
 */
export function parseNewCustomer(
  text: string
): ParsedCustomer | { error: string } {
  const rest = text.trim().replace(/^[#＃♯]\s*新規/, "").trim();
  if (!rest) return { error: "氏名と連絡先が入力されていません" };
  const parts = rest.split(/[/／]/).map((p) => p.trim());
  const name = parts[0] || "";
  if (!name) return { error: "氏名が入力されていません" };

  let kana: string, contactRaw: string, property: string, referrer: string;
  if (looksLikeContact(parts[1] || "")) {
    kana = "";
    contactRaw = parts[1] || "";
    property = parts[2] || "";
    referrer = parts[3] || "";
  } else {
    kana = parts[1] || "";
    contactRaw = parts[2] || "";
    property = parts[3] || "";
    referrer = parts[4] || "";
  }

  const { phone, email, note } = classifyContact(contactRaw);
  if (!phone && !email && !note) {
    return {
      error:
        "連絡先が入力されていません。電話番号かメール、" +
        "分からなければ「メール」「LINE」「不明」等の状況を入れてください",
    };
  }
  return { name, kana, phone, email, contactNote: note, property, referrer };
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

async function findAccountByEmail(emailNorm: string) {
  const res = await crm.databases.query({
    database_id: ACCOUNTS_DB,
    filter: { property: "メール_正規化", rich_text: { equals: emailNorm } },
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
    "送信フォーマット（#新規 から始まる1行で）:\n" +
    "#新規 氏名/フリガナ/連絡先/物件/紹介者\n\n" +
    "・連絡先＝電話番号 or メール。分からなければ「メール」「LINE」「不明」等でもOK\n" +
    "・フリガナ・物件・紹介者は省略可。区切りは「/」"
  );
}

/**
 * 「#新規」メッセージを処理し、LINEに返す文言を返す。
 * 電話 or メールで名寄せ（状況語のみの場合は名寄せせず新規）。
 */
export async function handleNewCustomer(text: string): Promise<string> {
  const parsed = parseNewCustomer(text);
  if ("error" in parsed) return usage(parsed.error);

  // 名寄せ: 電話 or メール で既存客を照合
  let existing: { id: string; properties?: unknown } | null = null;
  const phoneNorm = parsed.phone ? normalizePhone(parsed.phone) : "";
  const emailNorm = parsed.email ? parsed.email.trim().toLowerCase() : "";
  if (phoneNorm) existing = await findAccountByPhone(phoneNorm);
  else if (emailNorm) existing = await findAccountByEmail(emailNorm);

  if (existing) {
    const name = titleOf(existing) || parsed.name;
    await createActivity(
      "LINE経由の重複登録試行",
      existing.id,
      `既存顧客にヒットしたため新規作成せず履歴のみ追記。\n受信原文: ${text}`
    );
    return `既存顧客「${name}」に一致したため、新規登録せず履歴に追記しました。`;
  }

  // 新規起票
  const remark = ["LINE #新規 経由で自動起票。"];
  if (parsed.contactNote)
    remark.push(
      `連絡状況: ${parsed.contactNote}（電話番号は未取得。連絡先が分かったらNotionに追記してください）`
    );
  if (parsed.referrer)
    remark.push(
      `紹介者: ${parsed.referrer}（「紹介者」リレーションは手動設定してください）`
    );
  if (parsed.property) remark.push(`問合せ物件: ${parsed.property}`);

  const properties: Record<string, unknown> = {
    氏名: { title: [{ text: { content: parsed.name } }] },
    区分: { select: { name: "個人" } },
    顧客ソース: { select: { name: "紹介" } },
    登録経路: { select: { name: "LINE" } },
    ステータス: { select: { name: "新規" } },
    統合ステータス: { select: { name: "未確認" } },
    備考: { rich_text: [{ text: { content: remark.join("\n") } }] },
  };
  if (parsed.kana)
    properties["氏名カナ"] = {
      rich_text: [{ text: { content: normalizeKana(parsed.kana) } }],
    };
  if (parsed.phone) {
    properties["電話番号"] = { phone_number: parsed.phone };
    properties["電話番号_正規化"] = {
      rich_text: [{ text: { content: phoneNorm } }],
    };
  }
  if (parsed.email) {
    properties["メール"] = { email: parsed.email };
    properties["メール_正規化"] = {
      rich_text: [{ text: { content: emailNorm } }],
    };
  }

  const page = await crm.pages.create({
    parent: { database_id: ACCOUNTS_DB },
    properties: properties as never,
  });

  await createActivity(
    "LINE紹介登録受付",
    page.id,
    `LINEの #新規 フォーマットから自動起票。\n受信原文: ${text}`
  );

  const contactLabel = parsed.phone
    ? `電話 ${parsed.phone}`
    : parsed.email
    ? `メール ${parsed.email}`
    : `連絡状況「${parsed.contactNote}」で登録（電話番号は未取得）`;

  const referrerLine = parsed.referrer
    ? `\n紹介者「${parsed.referrer}」は備考に記録済み。Notionの「紹介者」リレーション設定をお願いします。`
    : "";
  const contactReminder =
    !parsed.phone && !parsed.email
      ? "\n※連絡先が分かったらNotionに追記してください。"
      : "";

  return `✅ 新規顧客「${parsed.name}」を登録しました（${contactLabel}）。${referrerLine}${contactReminder}`;
}
