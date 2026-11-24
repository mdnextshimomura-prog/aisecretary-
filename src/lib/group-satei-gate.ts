/**
 * 普通のグループの査定依頼：入口 A・B の判定、グループ単位の控えの1行、束ねる資料の選び方（段1）。通信はしない。
 * 束ねる資料（設計 7）：①依頼者本人の画像・PDF で入口の30分前〜1分後 ②入口の発言が引用した資料・入口の発言を引用した資料。
 * 引用の無い他人の資料（③）と、60分後までの後から来る資料は段2。
 */
import { GS_AFTER_MS, GS_BEFORE_MS, GS_MATERIALS_MAX, GS_MIN, groupSateiOn, type GsEnv, type GsMedia } from "./group-satei-data";
import { sateiNotifyTarget } from "./satei-data";

export const GS_WORDS: readonly string[] = ["査定", "価格を出して", "いくらで売れ", "売却価格", "相場"];

export function looksLikeSateiWords(text: string): boolean {
  const s = (text ?? "").replace(/[\s　]/g, "");
  return GS_WORDS.some((w) => s.includes(w));
}

export type GsSkip = "off" | "self" | "no-target" | "no-sender" | "words";

export function gsEntryBGate(
  ev: { groupId?: string; senderId?: string; text: string },
  env: GsEnv = process.env,
): { ok: true } | { ok: false; reason: GsSkip } {
  if (!groupSateiOn(ev.groupId, env)) return { ok: false, reason: "off" };
  const target = sateiNotifyTarget(env);
  if (!target) return { ok: false, reason: "no-target" };
  if (!ev.senderId) return { ok: false, reason: "no-sender" };
  if (ev.senderId === target) return { ok: false, reason: "self" };
  if (!looksLikeSateiWords(ev.text)) return { ok: false, reason: "words" };
  return { ok: true };
}

export function gsEntryAOk(
  p: { groupId?: string; senderId?: string; isTask: boolean; requestType: string; confidence: number },
  env: GsEnv = process.env,
): boolean {
  if (!groupSateiOn(p.groupId, env)) return false;
  const target = sateiNotifyTarget(env);
  if (!target || !p.senderId || p.senderId === target) return false;
  return p.isTask && p.requestType === "査定書" && p.confidence >= GS_MIN;
}

export function gsMediaRow(m: {
  messageId: string;
  groupId?: string;
  senderId?: string;
  type: "image" | "file";
  fileName?: string;
  at: number;
}): GsMedia | null {
  if (!m.groupId || !m.senderId || !m.messageId) return null;
  const kind = m.type === "image" ? "image" : /\.pdf$/i.test(m.fileName ?? "") ? "pdf" : "other";
  return { messageId: m.messageId, kind, senderId: m.senderId, at: m.at };
}

export function pickMaterials(
  media: GsMedia[],
  ev: { requesterId: string; at: number; triggerMsgIds: string[]; quotedMessageId?: string },
): string[] {
  const readable = media.filter((m) => m.kind === "image" || m.kind === "pdf");
  const byTime = (a: GsMedia, b: GsMedia) => a.at - b.at;
  const isRef = (m: GsMedia) =>
    (ev.quotedMessageId !== undefined && m.messageId === ev.quotedMessageId) ||
    (m.quoted !== undefined && ev.triggerMsgIds.includes(m.quoted));
  const isOwn = (m: GsMedia) => m.senderId === ev.requesterId && m.at >= ev.at - GS_BEFORE_MS && m.at <= ev.at + GS_AFTER_MS;
  // 引用でつながる資料を先に確保し、残りの枠に本人の窓の新しいものを足す（古い順に返す）
  const refs = readable.filter(isRef).sort(byTime).slice(-GS_MATERIALS_MAX);
  const refIds = new Set(refs.map((m) => m.messageId));
  const own = readable.filter((m) => isOwn(m) && !refIds.has(m.messageId)).sort(byTime);
  const room = GS_MATERIALS_MAX - refs.length;
  const fill = room > 0 ? own.slice(-room) : [];
  const all = [...refs, ...fill].filter((m, i, a) => a.findIndex((x) => x.messageId === m.messageId) === i);
  return all.sort(byTime).map((m) => m.messageId);
}
