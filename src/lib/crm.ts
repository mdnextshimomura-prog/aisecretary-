/**
 * crm.ts — LINE「#新規」紹介登録 → CRM_顧客(＋案件) 自動起票
 * ============================================================================
 * MDNEXT秘書に追加された「紹介客のCRM登録」機能。
 * webhook/route.ts が #新規 で始まるメッセージを検知してここに委譲する。
 * 既存のタスク秘書機能とは独立（この分岐に入らないメッセージは無影響）。
 *
 * 送信フォーマット（#新規 から始まる1行・区切りは「/」）:
 *   #新規 氏名/フリガナ/連絡先/売主買主/対応内容/物件/担当者/紹介者
 *   - 必須: 氏名・連絡先。他は不明なら空でOK（中間を飛ばすときも「/」は残す）。
 *   - 連絡先: 電話番号 or メール or 状況語（不明/メール/LINE/紹介者経由 等）。
 *   - 売主買主: 「売主」「買主」等 → CRM_顧客の役割へ。既存客に再送すると役割を追加。
 *   - 対応内容: 査定依頼/媒介予定 等 → 記入があれば CRM_案件 を自動作成。
 *   - 担当者: people欄はAPIで名前設定できないため備考に記録（Notion側で手動設定）。
 *   - 氏名/連絡先 だけの2項目（#新規 氏名/電話）でも登録可（クイック）。
 *
 * 必要な環境変数（.env.local と Vercel の両方）:
 *   CRM_NOTION_TOKEN / CRM_ACCOUNTS_DB_ID / CRM_ACTIVITIES_DB_ID / CRM_DEALS_DB_ID
 * ============================================================================
 */
import { Client } from "@notionhq/client";

const crm = new Client({ auth: process.env.CRM_NOTION_TOKEN });
const ACCOUNTS_DB = process.env.CRM_ACCOUNTS_DB_ID!;
const ACTIVITIES_DB = process.env.CRM_ACTIVITIES_DB_ID!;
const DEALS_DB = process.env.CRM_DEALS_DB_ID!;

/** 連絡先が電話でない場合の「状況語」。これらは電話番号なしで登録を通す。 */
const SITUATION_RE =
  /^(不明|未確認|なし|未取得|確認中|後で|あとで|メール|ﾒｰﾙ|e-?mail|mail|LINE|ライン|らいん|line|SMS|連絡不可|連絡取れ|音信不通|経由|紹介者経由|業者経由)/i;

/**
 * メッセージ内に「#新規／＃新規／♯新規」の行が含まれるか。route.ts の分岐判定に使う。
 * 先頭でなくてもよい（前に別の文があってもOK。行頭の #新規 を拾う）。
 */
export function isNewCustomerCommand(text: string): boolean {
  return /(^|\n)[ 　\t]*[#＃♯][ 　\t]*新規/.test(text);
}

interface ParsedCustomer {
  name: string;
  kana: string;
  phone: string;
  email: string;
  contactNote: string;
  role: string; // 売主/買主/紹介元/地主/投資家 or ""
  dealNote: string; // 対応内容（案件化する内容）
  property: string;
  assigneeName: string; // 担当者名（テキスト。people欄は手動設定）
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

/** 「売主」「買主」等を役割の選択肢名に正規化。該当なしは ""（未設定）。 */
function parseRole(s: string): string {
  const t = (s || "").trim();
  if (!t) return "";
  if (/売/.test(t)) return "売主";
  if (/買/.test(t)) return "買主";
  if (/紹介/.test(t)) return "紹介元";
  if (/地主/.test(t)) return "地主";
  if (/投資/.test(t)) return "投資家";
  return "";
}

/** 役割から取引の立場（購入/売却）を導く。 */
function stanceFromRole(role: string): string {
  if (role === "売主") return "売却";
  if (role === "買主") return "購入";
  return "";
}

/** 対応内容＋立場から案件のフェーズを推定（14フェーズ）。 */
function dealPhaseFromNote(note: string, stance: string): string {
  if (/契約/.test(note)) return "契約";
  if (/決済|引渡/.test(note)) return "決済・引渡";
  if (stance === "売却") {
    if (/査定|見積/.test(note)) return "【売】査定";
    if (/媒介/.test(note)) return "【売】媒介契約";
    if (/販売|広告|掲載|レインズ/.test(note)) return "【売】販売活動";
    if (/内覧|案内|受付|買付|申込/.test(note)) return "【売】内覧・買付受付";
    return "反響";
  }
  if (stance === "購入") {
    if (/紹介|提案/.test(note)) return "【買】物件紹介";
    if (/内覧|案内/.test(note)) return "【買】内覧";
    if (/買付|申込/.test(note)) return "【買】買付申込";
    if (/ローン|融資|審査/.test(note)) return "【買】ローン審査";
    return "反響";
  }
  // 立場不明: 内容から推定
  if (/査定|見積/.test(note)) return "【売】査定";
  if (/媒介/.test(note)) return "【売】媒介契約";
  if (/内覧|案内/.test(note)) return "【買】内覧";
  if (/買付|申込/.test(note)) return "【買】買付申込";
  return "反響";
}

/** 対応内容が実質的な案件か（不明/なし等は案件化しない）。 */
function isRealDeal(note: string): boolean {
  const t = (note || "").trim();
  return !!t && !/^(不明|なし|未定|未確認|-|ー)$/.test(t);
}

/**
 * 「#新規 氏名/フリガナ/連絡先/売主買主/対応内容/物件/担当者/紹介者」をパース。
 * 2項目だけ（氏名/連絡先）のクイック入力にも対応。
 */
export function parseNewCustomer(
  text: string
): ParsedCustomer | { error: string } {
  // メッセージ内の「#新規 …」の行だけを取り出す（前後に別の文があってもよい）。
  const m = text.match(/[#＃♯][ 　\t]*新規[ 　\t]*(.*)/);
  const rest = (m ? m[1] : "").trim();
  if (!rest) return { error: "氏名と連絡先が入力されていません" };
  const parts = rest.split(/[/／]/).map((p) => p.trim());
  const name = parts[0] || "";
  if (!name) return { error: "氏名が入力されていません" };

  let kana = "",
    contactRaw = "",
    role = "",
    dealNote = "",
    property = "",
    assigneeName = "",
    referrer = "";
  if (parts.length <= 2) {
    // クイック: 氏名/連絡先
    contactRaw = parts[1] || "";
  } else {
    kana = parts[1] || "";
    contactRaw = parts[2] || "";
    role = parts[3] || "";
    dealNote = parts[4] || "";
    property = parts[5] || "";
    assigneeName = parts[6] || "";
    referrer = parts[7] || "";
  }

  const { phone, email, note } = classifyContact(contactRaw);
  if (!phone && !email && !note) {
    return {
      error:
        "連絡先が入力されていません。電話番号かメール、" +
        "分からなければ「メール」「LINE」「不明」等の状況を入れてください",
    };
  }
  return {
    name,
    kana,
    phone,
    email,
    contactNote: note,
    role: parseRole(role),
    dealNote,
    property,
    assigneeName,
    referrer,
  };
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

function rolesOf(page: unknown): string[] {
  const p = (
    page as {
      properties?: Record<string, { multi_select?: Array<{ name: string }> }>;
    }
  ).properties?.["役割"];
  return (p?.multi_select ?? []).map((o) => o.name);
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

/** 対応内容から CRM_案件 を作成し、案件名を返す。 */
async function createDeal(
  customerId: string,
  p: ParsedCustomer
): Promise<string> {
  const dealName = `${p.dealNote}｜${p.name}${
    p.property ? "｜" + p.property : ""
  }`.slice(0, 100);
  const remark =
    `LINE #新規 から自動作成。対応内容: ${p.dealNote}` +
    (p.assigneeName ? `／担当: ${p.assigneeName}` : "") +
    (p.referrer ? `／紹介: ${p.referrer}` : "") +
    "。案件ソース(会社案件/自己開拓)と主担当は要手動設定。";
  const stance = stanceFromRole(p.role);
  await crm.pages.create({
    parent: { database_id: DEALS_DB },
    properties: {
      案件名: { title: [{ text: { content: dealName } }] },
      顧客: { relation: [{ id: customerId }] },
      案件種別: { select: { name: "売買仲介" } },
      取引区分: { select: { name: "仲介" } },
      フェーズ: { select: { name: dealPhaseFromNote(p.dealNote, stance) } },
      ...(stance && { 取引の立場: { select: { name: stance } } }),
      備考: { rich_text: [{ text: { content: remark } }] },
    },
  });
  return dealName;
}

function usage(reason: string): string {
  return (
    `登録できませんでした: ${reason}\n\n` +
    "送信フォーマット（#新規 から始まる1行で）:\n" +
    "#新規 氏名/フリガナ/連絡先/売主買主/対応内容/物件/担当者/紹介者\n\n" +
    "・必須は氏名と連絡先。他は不明なら空でOK（中間を飛ばすときも「/」は残す）\n" +
    "・連絡先＝電話番号 or メール。分からなければ「メール」「LINE」「不明」等でもOK"
  );
}

/**
 * 「#新規」メッセージを処理し、LINEに返す文言を返す。
 * 電話/メールで名寄せ。既存客なら役割追加＋履歴、新規なら顧客(＋案件)を作成。
 */
export async function handleNewCustomer(text: string): Promise<string> {
  const parsed = parseNewCustomer(text);
  if ("error" in parsed) return usage(parsed.error);

  const phoneNorm = parsed.phone ? normalizePhone(parsed.phone) : "";
  const emailNorm = parsed.email ? parsed.email.trim().toLowerCase() : "";
  let existing: { id: string; properties?: unknown } | null = null;
  if (phoneNorm) existing = await findAccountByPhone(phoneNorm);
  else if (emailNorm) existing = await findAccountByEmail(emailNorm);

  if (existing) {
    const name = titleOf(existing) || parsed.name;
    // 役割の追加更新（多対応: 売主かつ買主もあり得るので既存に足す）
    let roleMsg = "";
    if (parsed.role) {
      const roles = rolesOf(existing);
      if (!roles.includes(parsed.role)) {
        await crm.pages.update({
          page_id: existing.id,
          properties: {
            役割: {
              multi_select: [...roles, parsed.role].map((n) => ({ name: n })),
            },
          },
        });
        roleMsg = `\n役割に「${parsed.role}」を追加しました。`;
      }
    }
    await createActivity(
      "LINE経由の重複登録試行",
      existing.id,
      `既存顧客にヒット。新規作成せず履歴のみ追記。\n受信原文: ${text}`
    );
    return `既存顧客「${name}」に一致しました。新規登録せず履歴に追記。${roleMsg}`;
  }

  // 新規起票
  const remark = ["LINE #新規 経由で自動起票。"];
  if (parsed.contactNote)
    remark.push(
      `連絡状況: ${parsed.contactNote}（電話番号は未取得。分かったら追記してください）`
    );
  if (parsed.assigneeName)
    remark.push(`担当: ${parsed.assigneeName}（担当者のpeople欄は手動設定してください）`);
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
  if (parsed.role)
    properties["役割"] = { multi_select: [{ name: parsed.role }] };
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

  // 対応内容があれば案件を作成
  let dealMsg = "";
  if (isRealDeal(parsed.dealNote)) {
    try {
      const dealName = await createDeal(page.id, parsed);
      dealMsg = `\n📁 案件「${dealName}」も作成しました（案件ソース・主担当は要設定）。`;
    } catch (err) {
      console.error("案件作成エラー:", err);
      dealMsg = `\n⚠️ 顧客は登録できましたが、案件の作成に失敗しました。手動で作成してください。`;
    }
  }

  const contactLabel = parsed.phone
    ? `電話 ${parsed.phone}`
    : parsed.email
    ? `メール ${parsed.email}`
    : `連絡状況「${parsed.contactNote}」（電話番号は未取得）`;
  const roleLabel = parsed.role ? `／${parsed.role}` : "";
  const reminders = [
    !parsed.phone && !parsed.email ? "連絡先" : "",
    parsed.assigneeName ? "担当者" : "",
    parsed.referrer ? "紹介者リレーション" : "",
  ].filter(Boolean);
  const reminderLine =
    reminders.length > 0
      ? `\n※Notionで設定が必要: ${reminders.join("・")}`
      : "";

  return `✅ 新規顧客「${parsed.name}」を登録しました（${contactLabel}${roleLabel}）。${dealMsg}${reminderLine}`;
}
