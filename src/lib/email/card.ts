import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-4-6";

const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;

// LINEの画像メッセージの実体を取得し、base64とMIMEを返す。
export async function fetchLineImage(
  messageId: string
): Promise<{ base64: string; mediaType: string } | null> {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
  if (!res.ok) {
    console.error("LINE画像取得失敗:", res.status);
    return null;
  }
  const mediaTypeRaw = res.headers.get("content-type") || "image/jpeg";
  // Claudeが受け付けるMIMEに正規化
  const mediaType = /png/i.test(mediaTypeRaw)
    ? "image/png"
    : /webp/i.test(mediaTypeRaw)
      ? "image/webp"
      : /gif/i.test(mediaTypeRaw)
        ? "image/gif"
        : "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), mediaType };
}

export interface CardContact {
  name: string; // 氏名（読めなければ空文字）
  company: string | null;
  title: string | null; // 役職
  email: string | null;
  phone: string | null;
  isBusinessCard: boolean; // 名刺・連絡先らしい画像か
}

const CARD_PROMPT = `あなたは名刺・連絡先情報の読み取りアシスタントです。
渡された画像から、メール送信に使える連絡先情報を抽出してください。

抽出項目（JSON）:
- isBusinessCard: 名刺や連絡先が写った画像ならtrue。それ以外（風景・書類など連絡先が無い）はfalse。
- name: 氏名。読めなければ空文字 ""
- company: 会社名（無ければnull）
- title: 役職（無ければnull）
- email: メールアドレス（無ければnull）。複数あれば代表の1件
- phone: 電話番号（無ければnull）。携帯があれば優先

読み取れない項目は無理に埋めずnull（nameのみ空文字）にしてください。
JSONのみを返してください。前置き・説明文・マークダウン記法（\`\`\`など）は一切禁止です。
例: {"isBusinessCard": true, "name": "田中太郎", "company": "山田不動産", "title": "営業課長", "email": "tanaka@yamada.co.jp", "phone": "090-1234-5678"}`;

export async function readBusinessCard(
  base64: string,
  mediaType: string
): Promise<CardContact> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: CARD_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType as
                | "image/jpeg"
                | "image/png"
                | "image/webp"
                | "image/gif",
              data: base64,
            },
          },
          { type: "text", text: "この画像から連絡先を抽出してください。" },
        ],
      },
    ],
  });

  const out = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  const jsonMatch = out.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("名刺の読み取りに失敗しました");
  }
  const p = JSON.parse(jsonMatch[0]) as Partial<CardContact>;
  return {
    isBusinessCard: Boolean(p.isBusinessCard),
    name: (p.name ?? "").toString(),
    company: p.company ? String(p.company) : null,
    title: p.title ? String(p.title) : null,
    email: p.email ? String(p.email) : null,
    phone: p.phone ? String(p.phone) : null,
  };
}
