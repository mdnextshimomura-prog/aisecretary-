/**
 * 普通のグループの査定依頼：束ねた資料（画像・PDF）と本文から、所在・物件名・種別の見込みを読む（設計 8.1）。
 * 渡す先は Anthropic（Claude）だけ。人の名前は指示文で出させず、さらにコードで名前らしい値を捨てる。
 * AI の呼び出しは create を受け取る（本物は group-satei-wire.ts が Anthropic の client.messages.create を渡す）。
 */
import type { TaskAttachment } from "./claude";
import { GS_BASES, GS_KINDS, type GsBasis, type GsKind, type GsRead } from "./group-satei-data";

export const GS_READ_MODEL = "claude-sonnet-4-6";

export const GS_READ_PROMPT = `あなたは不動産会社の査定の受付係です。LINE のグループに届いた査定の依頼と、添付の資料（写真・登記・地図・チラシ）から、査定する物件を読み取ります。
次の JSON だけを返してください（説明文は要りません）。
{"所在": 住居表示か地番（例「大阪市旭区大宮1丁目3番27」）。分からなければ null,
 "物件名": マンション名と号室（例「サウスオールシティ1203」）。無ければ null,
 "種別の見込み": "マンション" | "戸建" | "土地" | "不明"（登記の「区分建物」はマンション、「居宅」は戸建、「宅地」だけなら土地）,
 "根拠": "本文" | "登記" | "地図" | "チラシ" | "その他",
 "確信度": 0〜1 の数}
所有者・売主・人の名前は、どの欄にも書かないでください。`;

const NAME_RE = /様|邸|さん|氏|所有者|持分/;

export function scrubNames(s: string | null | undefined): string | null {
  const v = typeof s === "string" ? s.trim() : "";
  if (!v || NAME_RE.test(v)) return null;
  return Array.from(v).slice(0, 80).join("");
}

export function parseGsReadText(text: string): GsRead {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no-json");
  const o = JSON.parse(m[0]) as Record<string, unknown>;
  const c = o["確信度"];
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) throw new Error("bad-confidence");
  const kind = GS_KINDS.includes(o["種別の見込み"] as GsKind) ? (o["種別の見込み"] as GsKind) : "不明";
  const basis = GS_BASES.includes(o["根拠"] as GsBasis) ? (o["根拠"] as GsBasis) : "その他";
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  return { address: scrubNames(str(o["所在"])), propertyName: scrubNames(str(o["物件名"])), kind, basis, confidence: c };
}

export interface GsCreateReq {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user"; content: Array<Record<string, unknown>> }>;
}
export type GsCreate = (req: GsCreateReq) => Promise<{ content: Array<{ type: string; text?: string }> }>;

export async function readGsMaterials(
  attachments: TaskAttachment[],
  text: string,
  today: string,
  create: GsCreate,
): Promise<GsRead> {
  const content: Array<Record<string, unknown>> = attachments.map((a) =>
    a.kind === "image"
      ? { type: "image", source: { type: "base64", media_type: a.mediaType, data: a.base64 } }
      : { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.base64 } },
  );
  content.push({
    type: "text",
    text: `今日（日本時間）: ${today}\n添付: ${attachments.length}件\n\nLINE の依頼の本文:\n${text || "（本文なし）"}`,
  });
  const res = await create({
    model: GS_READ_MODEL,
    max_tokens: 512,
    system: GS_READ_PROMPT,
    messages: [{ role: "user", content }],
  });
  const out = res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  return parseGsReadText(out);
}
