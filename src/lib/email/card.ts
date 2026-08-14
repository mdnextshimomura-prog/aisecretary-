import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-4-6";

const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;

// LINEメッセージの実体（画像 or PDF等）を取得し、base64と生のContent-Typeを返す。
export async function fetchLineContent(
  messageId: string
): Promise<{ base64: string; contentType: string } | null> {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
  if (!res.ok) {
    console.error("LINEコンテンツ取得失敗:", messageId, res.status);
    return null;
  }
  const contentType =
    res.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), contentType };
}

function imageMediaType(
  ct: string
): "image/jpeg" | "image/png" | "image/webp" | "image/gif" {
  if (/png/i.test(ct)) return "image/png";
  if (/webp/i.test(ct)) return "image/webp";
  if (/gif/i.test(ct)) return "image/gif";
  return "image/jpeg";
}

export interface CardContact {
  name: string; // 氏名（読めなければ空文字）
  company: string | null; // 会社名（正式名称）
  tradeName: string | null; // 屋号（店名・ブランド名。会社名と別に記載がある場合）
  title: string | null; // 役職
  email: string | null;
  phone: string | null;
  isBusinessCard: boolean; // 名刺・連絡先らしい内容か
}

const CARD_PROMPT = `あなたは名刺・連絡先情報の読み取りアシスタントです。
渡された画像またはPDFから、メール送信に使える連絡先情報を抽出してください。

抽出項目（JSON）:
- isBusinessCard: 名刺や連絡先が含まれるならtrue。それ以外（風景・連絡先の無い資料など）はfalse。
- name: 氏名。読めなければ空文字 ""
- company: 会社名（正式名称。無ければnull）
- tradeName: 屋号・店名・ブランド名（会社名とは別に記載がある場合のみ。無ければnull）
- title: 役職（無ければnull）
- email: メールアドレス（無ければnull）。複数あれば代表の1件
- phone: 電話番号（無ければnull）。携帯があれば優先

読み取れない項目は無理に埋めずnull（nameのみ空文字）にしてください。
JSONのみを返してください。前置き・説明文・マークダウン記法（\`\`\`など）は一切禁止です。
例: {"isBusinessCard": true, "name": "田中太郎", "company": "山田不動産株式会社", "tradeName": "やまだ不動産", "title": "営業課長", "email": "tanaka@yamada.co.jp", "phone": "090-1234-5678"}`;

// 画像 or PDF の中身から連絡先を読み取る。
export async function readContactFromContent(
  base64: string,
  contentType: string
): Promise<CardContact> {
  const isPdf = /pdf/i.test(contentType);
  const contentBlock = isPdf
    ? {
        type: "document" as const,
        source: {
          type: "base64" as const,
          media_type: "application/pdf" as const,
          data: base64,
        },
      }
    : {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: imageMediaType(contentType),
          data: base64,
        },
      };

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: CARD_PROMPT,
    // 画像/PDFのブロック型はSDKバージョン差があるためキャストして渡す
    messages: [
      {
        role: "user",
        content: [
          contentBlock,
          { type: "text", text: "この内容から連絡先を抽出してください。" },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any,
      },
    ],
  });

  const out = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  const jsonMatch = out.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("連絡先の読み取りに失敗しました");
  }
  const p = JSON.parse(jsonMatch[0]) as Partial<CardContact>;
  return {
    isBusinessCard: Boolean(p.isBusinessCard),
    name: (p.name ?? "").toString(),
    company: p.company ? String(p.company) : null,
    tradeName: p.tradeName ? String(p.tradeName) : null,
    title: p.title ? String(p.title) : null,
    email: p.email ? String(p.email) : null,
    phone: p.phone ? String(p.phone) : null,
  };
}
