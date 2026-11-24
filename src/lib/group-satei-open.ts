/**
 * 普通のグループの査定依頼：受付票を開く（設計 6.2・7・8.1〜8.3。段1）。
 * 順番：スイッチ → KV → 受付票の予約（同じ発言では1回）→ 資料を束ねる → 1日の上限 → 読み取り → 候補 → 下村さんへ push。
 * 例外は投げない（ほかの流れを止めない）。本文・名前・ID はログに出さない。
 */
import { candidateDeals, type DealRef } from "./task-record";
import { normalizeProperty } from "./property";
import { sateiNotifyTarget } from "./satei-data";
import {
  GS_CANDIDATES_MAX, GS_MEDIA_MAX, GS_MEDIA_TTL, GS_READS_PER_DAY, GS_SEQ_KEY, GS_TICKET_TTL,
  groupSateiOn, gsMediaKey, gsMsgKey, gsOpenKey, gsReadsKey, gsTicketKey, receiptOf, ticketIdOf,
  type GsEnv, type GsMedia, type GsRead, type GsTicket,
} from "./group-satei-data";
import { pickMaterials } from "./group-satei-gate";
import { gsCard, gsNoticeText, type GsCandidate } from "./group-satei-card";

export interface GsKv {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ex: number): Promise<void>;
  setNx(key: string, value: unknown, ex: number): Promise<boolean>;
  incr(key: string): Promise<number>;
  expire(key: string, ex: number): Promise<void>;
  sadd(key: string, member: string): Promise<void>;
  /** 末尾に足し、max 件に切り、期限を付け直す */
  lpushTrim(key: string, value: unknown, max: number, ex: number): Promise<void>;
  lrange(key: string): Promise<unknown[]>;
}

export interface GsOpenEvent {
  messageId: string;
  groupId: string;
  requesterId: string;
  at: number;
  text: string;
  entry: "A" | "B";
  quotedMessageId?: string;
}

export interface GsOpenDeps {
  env?: GsEnv;
  kv: GsKv | null;
  now(): number;
  today(): string;
  ymd(): string;
  /** 画像・PDF を取り、Claude で読む。1件でも取れない・読めなければ例外 */
  read(mediaIds: string[], text: string): Promise<GsRead>;
  loadDeals(): Promise<DealRef[]>;
  /** 案件の物件の1件目の CRM_物件 の種別。読めなければ null */
  kindOf(dealId: string): Promise<string | null>;
  requesterName(userId: string): Promise<string | null>;
  push(to: string, messages: unknown[], retryKey: string): Promise<boolean>;
  log(line: string): void;
}

function asMedia(v: unknown): GsMedia | null {
  let x = v;
  if (typeof x === "string") {
    try {
      x = JSON.parse(x);
    } catch {
      return null;
    }
  }
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (typeof r.messageId !== "string" || typeof r.senderId !== "string" || typeof r.at !== "number") return null;
  if (r.kind !== "image" && r.kind !== "pdf" && r.kind !== "other") return null;
  return r as unknown as GsMedia;
}

export async function recordGroupSateiMedia(row: GsMedia, groupId: string, kv: GsKv | null, log: (l: string) => void): Promise<void> {
  if (!kv) return;
  try {
    await kv.lpushTrim(gsMediaKey(groupId), row, GS_MEDIA_MAX, GS_MEDIA_TTL);
  } catch {
    log("[group-satei] skip:media-kv");
  }
}

async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); })]);
  } finally {
    clearTimeout(t);
  }
}

export async function openGroupSatei(ev: GsOpenEvent, deps: GsOpenDeps): Promise<"opened" | "duplicate" | "skip"> {
  const env = deps.env ?? process.env;
  if (!groupSateiOn(ev.groupId, env)) return "skip";
  const target = sateiNotifyTarget(env);
  const kv = deps.kv;
  if (!target || !kv) {
    deps.log(`[group-satei] skip:${kv ? "no-target" : "kv"}`);
    return "skip";
  }
  const tid = ticketIdOf(ev.messageId);
  let ticket: GsTicket;
  try {
    // 先に受付票の場所を取り（同じ発言は1回だけ）、取れた側だけが番号を取る＝番号を無駄にしない
    ticket = { no: 0, ver: 1, groupId: ev.groupId, requesterId: ev.requesterId, at: ev.at, triggerMsgIds: [ev.messageId], mediaIds: [], read: null, state: "dismissed", pushed: false };
    if (!(await kv.setNx(gsTicketKey(tid), ticket, GS_TICKET_TTL))) {
      deps.log("[group-satei] skip:duplicate");
      return "duplicate";
    }
    ticket.no = await kv.incr(GS_SEQ_KEY);
    ticket.state = "asking";
    await kv.set(gsTicketKey(tid), ticket, GS_TICKET_TTL);
  } catch {
    deps.log("[group-satei] skip:kv");
    return "skip";
  }
  const receipt = receiptOf(ticket.no);
  let media: GsMedia[] = [];
  try {
    media = (await kv.lrange(gsMediaKey(ev.groupId))).map(asMedia).filter((m): m is GsMedia => m !== null);
  } catch {
    deps.log(`[group-satei] ticket ${receipt} media-kv-failed`);
  }
  ticket.mediaIds = pickMaterials(media, { requesterId: ev.requesterId, at: ev.at, triggerMsgIds: ticket.triggerMsgIds, quotedMessageId: ev.quotedMessageId });
  const kinds = ticket.mediaIds.map((id) => media.find((m) => m.messageId === id)?.kind);
  const materials = { images: kinds.filter((k) => k === "image").length, pdfs: kinds.filter((k) => k === "pdf").length, others: 0 };

  // 1日の上限（数えるのは読む前）
  let capped = false;
  let kvFailed = false;
  try {
    const n = await kv.incr(gsReadsKey(deps.ymd()));
    await kv.expire(gsReadsKey(deps.ymd()), 2 * 24 * 60 * 60);
    capped = n > GS_READS_PER_DAY;
  } catch {
    kvFailed = true;
  }
  if (kvFailed) ticket.readFailed = "cap-kv";
  else if (capped) ticket.readFailed = "cap";
  else {
    try {
      ticket.read = await deps.read(ticket.mediaIds, ev.text);
    } catch {
      ticket.readFailed = "read-failed";
    }
  }

  let cands: GsCandidate[] = [];
  let dealsFailed = false;
  try {
    const deals = await within(deps.loadDeals(), 8_000);
    const keys = [ticket.read?.propertyName, ticket.read?.address].map((s) => normalizeProperty(s ?? "")).filter(Boolean);
    const hits: DealRef[] = [];
    for (const k of keys) for (const d of candidateDeals(k, deals, GS_CANDIDATES_MAX)) if (!hits.some((h) => h.id === d.id)) hits.push(d);
    const top = hits.slice(0, GS_CANDIDATES_MAX);
    const ks = await Promise.allSettled(top.map((d) => within(deps.kindOf(d.id), 8_000)));
    cands = top.map((deal, i) => ({ deal, kind: ks[i].status === "fulfilled" ? (ks[i] as PromiseFulfilledResult<string | null>).value : null }));
  } catch {
    dealsFailed = true;
  }

  try {
    await kv.set(gsTicketKey(tid), ticket, GS_TICKET_TTL);
    for (const id of [...ticket.triggerMsgIds, ...ticket.mediaIds]) await kv.set(gsMsgKey(id), tid, GS_TICKET_TTL);
    await kv.sadd(gsOpenKey(ev.groupId), tid);
  } catch {
    deps.log(`[group-satei] ticket ${receipt} save-failed`);
  }
  try {
    await kv.expire(gsOpenKey(ev.groupId), GS_TICKET_TTL);
  } catch {
    deps.log(`[group-satei] ticket ${receipt} expire-failed`);
  }

  let name: string | null = null;
  try {
    name = await within(deps.requesterName(ev.requesterId), 3_000);
  } catch {
    name = null;
  }
  const text = gsNoticeText({ no: ticket.no, at: ev.at, requesterName: name, read: ticket.read, readFailed: ticket.readFailed, materials });
  const card = gsCard(tid, ticket.ver, cands, dealsFailed, ticket.no);
  let sent = false;
  try {
    sent = await deps.push(target, [{ type: "text", text }, card], `${tid}:${ticket.ver}`);
  } catch {
    sent = false;
  }
  if (sent) {
    ticket.pushed = true;
    try {
      await kv.set(gsTicketKey(tid), ticket, GS_TICKET_TTL);
    } catch {
      deps.log(`[group-satei] ticket ${receipt} pushed-mark-failed`);
    }
  }
  deps.log(
    `[group-satei] ticket ${receipt} opened ${ev.entry} ${ticket.read ? "read ok" : `read ${ticket.readFailed}`} asked ${cands.length}${sent ? "" : " push-failed"}`,
  );
  return "opened";
}
