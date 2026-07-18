import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@notionhq/client";

// LINEの「#新規」コマンドで紹介客をNotionのCRM_顧客DBへ自動登録する。
// （GitHub未push のまま本番だけに存在していた機能の復元版。
//   コマンド検知 → Claudeで連絡先・状況を柔軟に抽出 → CRM_顧客へページ作成）

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// CRM系DBは専用インテグレーション（CRM_NOTION_TOKEN）で共有されている場合がある。
// あればそちらを優先し、無ければタスク用のNOTION_API_KEYで接続する。
const notion = new Client({
  auth: process.env.CRM_NOTION_TOKEN ?? process.env.NOTION_API_KEY,
});

// CRM_顧客データベース（不動産CRM配下）。envで差し替え可能にしつつ既定値を持つ。
const CRM_DATABASE_ID =
  process.env.NOTION_CRM_DATABASE_ID ?? "656c85bb-e239-4e25-9fdb-de165874e429";

const MODEL = "claude-sonnet-4-6";

// 「#新規」「＃新規」をどの行の行頭でも検知する（前に別の文があっても拾う）。
// ヒットしたら、コマンド記号を除いた本文全体を返す。該当なしは null。
export function detectNewCustomerCommand(text: string): string | null {
  if (!/^[#＃]\s*新規/m.test(text)) return null;
  return text.replace(/^[#＃]\s*新規[ \t:：、]*/m, "").trim();
}

export interface ParsedCustomer {
  name: string; // 氏名（不明なら空文字）
  kana: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  category: "購入したい" | "売却したい" | "購入も売却も検討" | "賃貸・その他" | null;
  timeframe: "すぐに" | "3ヶ月以内" | "半年以内" | "1年以内" | "未定・情報収集中" | null;
  kubun: "個人" | "法人" | null;
  assignee: "有吉" | "杉山" | null;
  referrer: string | null; // 紹介元の名前（人・会社）
  memo: string | null;
}

const SYSTEM_PROMPT = `あなたは不動産会社のCRM入力アシスタントです。
LINEで届いた「新規顧客（主に紹介客）の登録依頼」から、顧客情報を抽出してください。
連絡先の書き方は柔軟です：電話番号だけ・メールだけ・「連絡先はまだ聞けてない」などの状況語だけ、
いずれもあり得ます。無い項目は無理に埋めず null にしてください。

抽出項目（JSON）:
- name: 顧客の氏名（会社名でも可）。不明なら空文字 ""
- kana: 氏名のフリガナ（書かれている場合のみ）
- phone: 電話番号（書かれている場合のみ。ハイフン有無はそのまま）
- email: メールアドレス（書かれている場合のみ）
- address: 住所・エリア（書かれている場合のみ）
- category: 相談内容。「購入したい」「売却したい」「購入も売却も検討」「賃貸・その他」のいずれか。不明は null
- timeframe: 希望時期。「すぐに」「3ヶ月以内」「半年以内」「1年以内」「未定・情報収集中」のいずれか。不明は null
- kubun: 「個人」or「法人」。会社・法人とわかる場合のみ「法人」、明確でなければ null
- assignee: 担当者。「有吉」「杉山」のどちらかが明示されている場合のみ。他は null
- referrer: 紹介元（誰からの紹介か）。書かれている場合のみ
- memo: 上記に収まらない補足（物件の希望条件、連絡先が未取得などの状況、注意点）。無ければ null

JSONのみを返してください。前置き・説明文・マークダウン記法（\`\`\`など）は一切禁止です。
例: {"name": "山本太郎", "kana": null, "phone": "090-1234-5678", "email": null, "address": null, "category": "売却したい", "timeframe": "3ヶ月以内", "kubun": "個人", "assignee": "杉山", "referrer": "田中様", "memo": "実家の戸建てを相続予定"}`;

export async function parseCustomerFromMessage(
  text: string
): Promise<ParsedCustomer> {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 700,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `登録依頼:\n${text}` }],
  });

  const out = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  const jsonMatch = out.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("顧客情報の抽出に失敗しました");
  }
  const p = JSON.parse(jsonMatch[0]) as Partial<ParsedCustomer>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
    allowed.includes(v as T) ? (v as T) : null;
  return {
    name: (p.name ?? "").toString().trim(),
    kana: p.kana ? String(p.kana) : null,
    phone: p.phone ? String(p.phone) : null,
    email: p.email ? String(p.email) : null,
    address: p.address ? String(p.address) : null,
    category: pick(p.category, [
      "購入したい",
      "売却したい",
      "購入も売却も検討",
      "賃貸・その他",
    ] as const),
    timeframe: pick(p.timeframe, [
      "すぐに",
      "3ヶ月以内",
      "半年以内",
      "1年以内",
      "未定・情報収集中",
    ] as const),
    kubun: pick(p.kubun, ["個人", "法人"] as const),
    assignee: pick(p.assignee, ["有吉", "杉山"] as const),
    referrer: p.referrer ? String(p.referrer) : null,
    memo: p.memo ? String(p.memo) : null,
  };
}

// CRM_顧客へページ作成。プロパティ名・選択肢はNotion側スキーマ（日本語）に固定。
export async function createCrmCustomer(
  customer: ParsedCustomer,
  rawMessage: string
): Promise<string> {
  const rt = (s: string) => [{ text: { content: s } }];

  // 紹介元・元メッセージは備考へまとめる（リレーション解決はしない）
  const memoParts = [
    customer.memo,
    customer.referrer ? `紹介元: ${customer.referrer}` : null,
    `元メッセージ: ${rawMessage}`,
  ].filter(Boolean) as string[];

  const response = await notion.pages.create({
    parent: { database_id: CRM_DATABASE_ID },
    properties: {
      氏名: { title: rt(customer.name || "（氏名未確認）") },
      ...(customer.kana && { 氏名カナ: { rich_text: rt(customer.kana) } }),
      ...(customer.phone && { 電話番号: { phone_number: customer.phone } }),
      ...(customer.phone && {
        電話番号_正規化: { rich_text: rt(customer.phone.replace(/[^\d]/g, "")) },
      }),
      ...(customer.email && { メール: { email: customer.email } }),
      ...(customer.email && {
        メール_正規化: { rich_text: rt(customer.email.toLowerCase()) },
      }),
      ...(customer.address && { 住所: { rich_text: rt(customer.address) } }),
      ...(customer.category && {
        ご相談内容: { select: { name: customer.category } },
      }),
      ...(customer.timeframe && {
        希望時期: { select: { name: customer.timeframe } },
      }),
      ...(customer.kubun && { 区分: { select: { name: customer.kubun } } }),
      ...(customer.assignee && {
        "担当（仮）": { select: { name: customer.assignee } },
      }),
      ステータス: { select: { name: "新規" } },
      登録経路: { select: { name: "LINE" } },
      顧客ソース: { select: { name: "紹介" } },
      統合ステータス: { select: { name: "未確認" } },
      備考: { rich_text: rt(memoParts.join("\n")) },
    },
  });

  return response.id;
}

// 登録完了のLINE返信文
export function buildCustomerRegisteredMessage(c: ParsedCustomer): string {
  const lines = [
    "👤 新規顧客をCRMに登録しました",
    "",
    `📋 ${c.name || "（氏名未確認）"}`,
    c.phone ? `📞 ${c.phone}` : null,
    c.email ? `📧 ${c.email}` : null,
    c.category ? `🏷 相談内容：${c.category}` : null,
    c.timeframe ? `⏳ 希望時期：${c.timeframe}` : null,
    c.assignee ? `👤 担当：${c.assignee}` : null,
    c.referrer ? `🤝 紹介元：${c.referrer}` : null,
    !c.phone && !c.email ? "⚠️ 連絡先が未登録です（あとでNotionに追記してください）" : null,
  ].filter(Boolean);
  return lines.join("\n");
}
