/**
 * 仕分けのカード（GROUP_INBOX）に「直前のやりとり」を出すための、グループの発言の短い控え（2026-11-28）。
 * 下村さん「結局グループ LINE を見に行くのがめんどくさい」→ カードだけで前後が分かるようにする。
 *
 *   ・置き場：KV の列 ginbox:ctx:<groupId>（直近8件・3時間）。1行 = {m: メッセージID, u: 送り主, t: 本文の頭80字, at}
 *     画像・ファイルは中身を持たず「（画像）」「（ファイル）」とだけ控える
 *   ・控えるのは、候補を受け付けるグループ（LINE_GROUP_ID＋TASK_CANDIDATE_GROUP_IDS）で、GROUP_INBOX が on のあいだだけ。
 *     off・対象外は KV を触らない
 *   ・使うのは仕分ける人の1対1のカードだけ。ログにも、ほかの送り先にも出さない
 * どの関数も例外を投げない。
 */
import { kv } from "@vercel/kv";
import { groupInboxOn } from "./candidate-card";
import { isCandidateGroup } from "./task-candidate";

export const CTX_KEEP = 8;
export const CTX_TTL_SEC = 3 * 60 * 60;
export const CTX_TEXT_MAX = 80;
export const CTX_BEFORE = 3;
/** 控えの書き込み・読み出しは、ここまでしか待たない */
export const CTX_TIMEOUT_MS = 1_500;
export const ctxKey = (groupId: string) => `ginbox:ctx:${groupId}`;

export interface CtxRow {
  /** メッセージ ID */
  m: string;
  /** 送り主の userId（分からなければ null） */
  u: string | null;
  /** 本文の頭（80字まで）。画像・ファイルは「（画像）」「（ファイル）」 */
  t: string;
  at: number;
}
export interface InboxContext {
  /** 依頼の発言が引用していた発言（控えにあるときだけ） */
  quoted: CtxRow | null;
  /** 依頼の発言の前の発言（古い順・3件まで。引用の発言は重ねない） */
  before: CtxRow[];
}

export interface CtxKv {
  /** 列の後ろに足し、直近 keep 件だけ残して、期限を付ける */
  push(key: string, row: CtxRow, keep: number, ttlSec: number): Promise<void>;
  range(key: string): Promise<unknown[]>;
}
const realKv: CtxKv = {
  push: async (key, row, keep, ttl) => {
    await kv.rpush(key, row);
    await kv.ltrim(key, -keep, -1);
    await kv.expire(key, ttl);
  },
  range: (key) => kv.lrange(key, 0, -1),
};

const within = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};
const cutEllipsis = (s: string, n: number) => {
  const a = Array.from(s);
  return a.length > n ? `${a.slice(0, n - 1).join("")}…` : s;
};
const on = (groupId: string | null | undefined): groupId is string =>
  Boolean(groupId) && groupInboxOn() && isCandidateGroup(groupId);

/** グループの発言を1行控える（文字・画像・ファイル）。off・対象外・1対1は何もしない */
export async function recordInboxContext(
  ev: { groupId?: string | null; messageId: string; senderId?: string | null; kind: "text" | "image" | "file"; text?: string; at: number },
  store: CtxKv = realKv
): Promise<void> {
  try {
    if (!on(ev.groupId) || !ev.messageId) return;
    const t =
      ev.kind === "image" ? "（画像）" : ev.kind === "file" ? "（ファイル）" : cutEllipsis((ev.text ?? "").replace(/\s+/g, " ").trim(), CTX_TEXT_MAX);
    if (!t) return;
    const row: CtxRow = { m: ev.messageId, u: ev.senderId ?? null, t, at: ev.at };
    await within(store.push(ctxKey(ev.groupId), row, CTX_KEEP, CTX_TTL_SEC), CTX_TIMEOUT_MS, undefined);
  } catch {
    // 控えられなくても何も止めない（カードに「直前のやりとり」が出ないだけ）
  }
}

function asRow(v: unknown): CtxRow | null {
  const r = v as Partial<CtxRow> | null;
  if (!r || typeof r !== "object" || typeof r.t !== "string" || !r.t) return null;
  // 数字だけの ID は KV の読み出しで数に戻ることがあるので、文字にそろえる
  const m = typeof r.m === "string" || typeof r.m === "number" ? String(r.m) : "";
  if (!m) return null;
  return { m, u: typeof r.u === "string" && r.u ? r.u : null, t: r.t, at: typeof r.at === "number" ? r.at : 0 };
}

/** 依頼の発言の前の3件と、引用された発言を読む。無い・off・読めないときは null */
export async function loadInboxContext(
  o: { groupId?: string | null; messageId: string; quotedMessageId?: string | null },
  store: CtxKv = realKv
): Promise<InboxContext | null> {
  try {
    if (!on(o.groupId)) return null;
    const raw = await within(store.range(ctxKey(o.groupId)), CTX_TIMEOUT_MS, [] as unknown[]);
    const rows = raw.map(asRow).filter((r): r is CtxRow => r !== null);
    const idx = rows.findIndex((r) => r.m === String(o.messageId));
    // 依頼の発言より前だけ（依頼の発言がまだ控えに無ければ、いまある分）
    const pool = idx >= 0 ? rows.slice(0, idx) : rows;
    const quoted = o.quotedMessageId ? (pool.find((r) => r.m === String(o.quotedMessageId)) ?? null) : null;
    const before = pool.slice(-CTX_BEFORE).filter((r) => r !== quoted);
    return quoted || before.length > 0 ? { quoted, before } : null;
  } catch {
    return null;
  }
}
