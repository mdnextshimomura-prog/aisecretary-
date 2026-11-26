/**
 * 普通のグループの査定依頼：入口 A・B の判定、グループ単位の控えの1行、束ねる資料の選び方（段1）。通信はしない。
 * 束ねる資料（設計 7）：①依頼者本人の画像・PDF で入口の30分前〜1分後 ②入口の発言が引用した資料・入口の発言を引用した資料。
 * 引用の無い他人の資料（③）と、60分後までの後から来る資料は段2。
 */
import {
  GS_AFTER_MS, GS_BEFORE_MS, GS_LATE_ANY_MS, GS_LATE_OWN_MS, GS_MATERIALS_MAX, GS_MIN, asTicket, groupSateiOn,
  type GsEnv, type GsMedia, type GsState,
} from "./group-satei-data";
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

/**
 * 段2f（計画 2026-11-26-group-satei-2f の F1(a)）：この発言をグループ査定が受け持つか（言葉だけで決める。通信はしない）。
 * 対象グループで GROUP_SATEI が on のときだけ。@AI秘書 あて（入口 A）か、入口 B の言葉の判定を通るとき true。
 * 入口 B の AI が「査定でない」とする発言も true になる（photo-ask も査定らしさで出すので、ほぼ同じ結果）。
 */
export function gsClaimsMessage(
  ev: { groupId?: string; senderId?: string; text: string; botMentioned: boolean },
  env: GsEnv = process.env,
): boolean {
  if (!groupSateiOn(ev.groupId, env)) return false;
  if (ev.botMentioned) {
    const target = sateiNotifyTarget(env);
    return Boolean(target && ev.senderId && ev.senderId !== target);
  }
  return gsEntryBGate(ev, env).ok;
}

/** 段2f（F1(b)）：送り主の、同じグループの受付票がまだ動いているとみなす状態と幅（依頼から2時間） */
export const GS_YIELD_STATES: readonly GsState[] = ["asking", "gathering", "proposing", "waiting-cases"];
export const GS_YIELD_MS = 2 * 60 * 60 * 1000;
/** 1回に読む受付票の上限（photo-ask の判定を長くしない） */
export const GS_YIELD_SCAN_MAX = 20;

/** 段2f（F1(b)）：送り主に、同じグループで動いている受付票（依頼から2時間以内）があるか。形の違う票は数えない */
export function gsHasActiveTicket(tickets: unknown[], ev: { groupId?: string; senderId?: string; at: number }, env: GsEnv = process.env): boolean {
  if (!groupSateiOn(ev.groupId, env) || !ev.senderId) return false;
  return tickets.some((raw) => {
    const t = asTicket(raw);
    return Boolean(
      t && t.groupId === ev.groupId && t.requesterId === ev.senderId && GS_YIELD_STATES.includes(t.state) && ev.at - t.at <= GS_YIELD_MS,
    );
  });
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

/**
 * 依頼のあとに届いた画像・PDF を、その受付票に足すか（11/25）。
 * ①受付票の発言・資料を引用したもの ②依頼者本人が30分以内に貼ったもの
 * ③そのグループで開いている票が1件だけのとき、下村さん以外が2時間以内に貼ったもの。
 */
export function lateMediaMatches(
  t: { requesterId: string; at: number; triggerMsgIds: string[]; mediaIds: string[] },
  m: GsMedia,
  openAsking: number,
  adminId: string | null | undefined,
): boolean {
  if (m.kind !== "image" && m.kind !== "pdf") return false;
  if (t.mediaIds.includes(m.messageId) || m.at < t.at) return false;
  if (m.quoted !== undefined && (t.triggerMsgIds.includes(m.quoted) || t.mediaIds.includes(m.quoted))) return true;
  if (m.senderId === t.requesterId && m.at - t.at <= GS_LATE_OWN_MS) return true;
  return openAsking === 1 && m.senderId !== adminId && m.at - t.at <= GS_LATE_ANY_MS;
}
