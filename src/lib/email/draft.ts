import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-4-6";

// LINEの依頼文から抽出する「メール要求」。
// to は宛先の人物名 or アドレスの生テキスト（アドレス解決は contacts.ts が担当）。
export interface EmailRequest {
  to: string;
  cc: string[];
  subject_hint: string; // 件名のヒント（無ければ空文字）
  purpose: string; // 用件・伝えたい内容
  tone: string; // トーン（丁寧/カジュアル等。無指定なら空文字）
  from: string; // 差出人の指定（例: 会社 / 自分 / 社長 / メールアドレス）。無指定なら空文字
}

const EXTRACT_PROMPT = `あなたは不動産会社の秘書です。
社内担当者からのLINE依頼文を読み、メール送信に必要な情報を抽出してください。

抽出する項目（JSON）:
- to: 宛先。人物名（「山田不動産の田中さん」等）またはメールアドレス。1件のみ。不明なら空文字。
- cc: CCに入れる宛先の配列（人物名 or アドレス）。無ければ空配列。
- subject_hint: 件名のヒント。依頼文から読み取れる範囲で。無ければ空文字。
- purpose: メールで伝えたい用件・内容を簡潔に。
- tone: 希望するトーン（例: 丁寧、カジュアル、フォーマル）。指定が無ければ空文字。
- from: 差出人（誰名義で送るか）の指定。「自分から」「社長名義で」「会社から」等があればその語（例: 自分 / 社長 / 会社）を、無ければ空文字。

JSONのみを返してください。前置き・説明文・マークダウン記法（\`\`\`など）は一切禁止です。
例: {"to": "田中さん", "cc": [], "subject_hint": "内見日程", "purpose": "今週土曜の内見可否を確認", "tone": "丁寧", "from": ""}`;

export async function extractEmailRequest(text: string): Promise<EmailRequest> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: EXTRACT_PROMPT,
    messages: [{ role: "user", content: `依頼文:\n${text}` }],
  });

  const out = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  const jsonMatch = out.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("メール要求の抽出に失敗しました");
  }
  const p = JSON.parse(jsonMatch[0]) as Partial<EmailRequest>;
  return {
    to: (p.to ?? "").toString(),
    cc: Array.isArray(p.cc) ? p.cc.map(String) : [],
    subject_hint: (p.subject_hint ?? "").toString(),
    purpose: (p.purpose ?? "").toString(),
    tone: (p.tone ?? "").toString(),
    from: (p.from ?? "").toString(),
  };
}

export interface EmailDraft {
  subject: string;
  body: string;
}

const DRAFT_PROMPT = `あなたは不動産会社の秘書です。日本のビジネスメールとして自然な文面を作成します。

制約:
- 件名は簡潔に（20文字前後）。
- 本文は宛名（「〇〇様」）で始め、あいさつ→用件→結び、の順。
- 署名は「{sender}」の名前で締める（会社名等の詳細が不明な場合は名前のみ）。
- 過度な敬語の重複や冗長表現は避け、読みやすく。
- トーン指定があれば従う。
- 事実が不明な箇所（日時・金額・物件名など）は勝手に創作せず、
  依頼内容から確実に言える範囲だけ書く。曖昧な部分は自然な言い回しで濁す。

JSONのみを返してください。前置き・説明文・マークダウン記法（\`\`\`など）は一切禁止です。
本文中の改行は \\n で表現してください。
例: {"subject": "内見日程のご相談", "body": "田中様\\n\\nお世話になっております。..."}`;

// 追加指示（下書きの修正依頼）があれば editInstruction に渡す。
export async function generateEmailDraft(
  req: EmailRequest,
  senderName: string,
  editInstruction?: string,
  previous?: EmailDraft
): Promise<EmailDraft> {
  const parts = [
    `宛先: ${req.to || "（未指定）"}`,
    req.cc.length ? `CC: ${req.cc.join(", ")}` : null,
    req.subject_hint ? `件名ヒント: ${req.subject_hint}` : null,
    `用件: ${req.purpose}`,
    req.tone ? `トーン: ${req.tone}` : null,
  ].filter(Boolean);

  let userContent = parts.join("\n");
  if (previous && editInstruction) {
    userContent +=
      `\n\n--- 現在の下書き ---\n件名: ${previous.subject}\n本文:\n${previous.body}` +
      `\n\n--- 修正指示 ---\n${editInstruction}\n上記の修正を反映した完成版を返してください。`;
  }

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: DRAFT_PROMPT.replace("{sender}", senderName),
    messages: [{ role: "user", content: userContent }],
  });

  const out = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  const jsonMatch = out.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("メール下書きの生成に失敗しました");
  }
  const d = JSON.parse(jsonMatch[0]) as Partial<EmailDraft>;
  return {
    subject: (d.subject ?? "").toString(),
    body: (d.body ?? "").toString(),
  };
}
