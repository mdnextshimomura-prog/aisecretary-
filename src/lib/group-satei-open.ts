/**
 * 普通のグループの査定依頼：受付票を開く（設計 6.2・7・8.1〜8.3。段1）。
 * 順番：スイッチ → KV → 受付票の予約（同じ発言では1回）→ 資料を束ねる → 1日の上限 → 読み取り → 候補 → 下村さんへ push。
 * 例外は投げない（ほかの流れを止めない）。本文・名前・ID はログに出さない。
 */
import { candidateDeals, type DealRef } from "./task-record";
import { normalizeProperty } from "./property";
import { sateiNotifyTarget } from "./satei-data";
import {
  GS_CANDIDATES_MAX, GS_DEFER_MS, GS_MATERIALS_MAX, GS_MEDIA_MAX, GS_MEDIA_TTL, GS_QUIET_MS, GS_READS_PER_DAY,
  GS_LOCK_TTL_S, GS_POLL_MS, GS_REREAD_MAX, GS_ROUND_MS, GS_SEQ_KEY, GS_TICKET_TTL, GS_WORKER_DEADLINE_MS,
  asTicket, groupSateiActive, groupSateiOn, gsDecKey, gsLateKey, gsMediaKey, gsMsgKey, gsOpenKey, gsReadsKey, gsRereadAtKey,
  gsRereadLockKey, gsTicketKey, receiptOf, ticketIdOf,
  type GsEnv, type GsMedia, type GsRead, type GsTicket,
} from "./group-satei-data";
import { lateMediaMatches, pickMaterials } from "./group-satei-gate";
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
    // 読んでいるあいだに貼られた資料も足せるよう、開いている票の目次には先に入れる（11/25 レビュー 1）
    await kv.sadd(gsOpenKey(ev.groupId), tid);
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

  ticket.materials = { images: materials.images, pdfs: materials.pdfs };

  // 読んでいるあいだに貼られた資料：あとの資料の控えへ回し、知らせはそれも読んでから1回にする
  let lateNow = 0;
  try {
    const after = (await kv.lrange(gsMediaKey(ev.groupId))).map(asMedia).filter((m): m is GsMedia => m !== null);
    const admin = sateiNotifyTarget(env);
    for (const m of after) {
      if (ticket.mediaIds.includes(m.messageId)) continue;
      // ほかに開いている票があるかは見ない＝本人の資料と引用だけ（他人の資料は attachLateMedia の判定で）
      if (!lateMediaMatches(ticket, m, 2, admin)) continue;
      await kv.sadd(gsLateKey(tid), lateMember(m));
      lateNow++;
    }
    if (lateNow) await kv.expire(gsLateKey(tid), GS_TICKET_TTL);
  } catch {
    deps.log(`[group-satei] ticket ${receipt} late-scan-failed`);
  }

  // 文字だけで読めず資料も無い（社長の「文字 → 画像」の型）か、読むあいだに資料が増えた：
  // すぐ知らせず待つ。待って読み直して知らせるのは、同じ呼び出しの runRereadWorker（webhook の時間の中）
  const noMaterial = !ticket.read && ticket.mediaIds.length === 0 && ticket.readFailed === "read-failed";
  if (noMaterial || lateNow > 0) {
    if (noMaterial) ticket.readFailed = "no-material";
    ticket.deferred = true;
    await saveTicket(kv, tid, ticket, receipt, deps);
    try {
      await kv.set(gsRereadAtKey(tid), deps.now() + (lateNow > 0 ? GS_QUIET_MS : GS_DEFER_MS), GS_TICKET_TTL);
      deps.log(`[group-satei] ticket ${receipt} opened ${ev.entry} deferred`);
      return "opened";
    } catch {
      // 待つ印が置けなければ、待たずに今知らせる（黙らない）
      ticket.deferred = false;
      deps.log(`[group-satei] ticket ${receipt} defer-failed`);
      await saveTicket(kv, tid, ticket, receipt, deps);
    }
  } else {
    await saveTicket(kv, tid, ticket, receipt, deps);
  }

  const { sent, asked } = await notifyTicket(tid, ticket, deps, kv, false);
  deps.log(
    `[group-satei] ticket ${receipt} opened ${ev.entry} ${ticket.read ? "read ok" : `read ${ticket.readFailed}`} asked ${asked}${sent ? "" : " push-failed"}`,
  );
  return "opened";
}

/** 受付票・発言の引き・開いている票の目次を書く（失敗はログだけ） */
async function saveTicket(kv: GsKv, tid: string, ticket: GsTicket, receipt: string, deps: { log(l: string): void }): Promise<void> {
  try {
    await kv.set(gsTicketKey(tid), ticket, GS_TICKET_TTL);
    for (const id of [...ticket.triggerMsgIds, ...ticket.mediaIds]) await kv.set(gsMsgKey(id), tid, GS_TICKET_TTL);
    await kv.sadd(gsOpenKey(ticket.groupId), tid);
  } catch {
    deps.log(`[group-satei] ticket ${receipt} save-failed`);
  }
  try {
    await kv.expire(gsOpenKey(ticket.groupId), GS_TICKET_TTL);
  } catch {
    deps.log(`[group-satei] ticket ${receipt} expire-failed`);
  }
}

/** 候補を出し、下村さんへ文字＋カードを push（retry key は受付票と版）。通れば pushed を書く */
async function notifyTicket(
  tid: string,
  ticket: GsTicket,
  deps: GsOpenDeps,
  kv: GsKv,
  reread: boolean,
): Promise<{ sent: boolean; asked: number }> {
  const target = sateiNotifyTarget(deps.env ?? process.env);
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
  let name: string | null = null;
  try {
    name = await within(deps.requesterName(ticket.requesterId), 3_000);
  } catch {
    name = null;
  }
  const text = gsNoticeText({
    no: ticket.no,
    at: ticket.at,
    requesterName: name,
    read: ticket.read,
    readFailed: ticket.readFailed,
    materials: ticket.materials ?? { images: 0, pdfs: 0 },
    reread,
    canReread: (ticket.rereads ?? 0) < GS_REREAD_MAX && ticket.mediaIds.length < GS_MATERIALS_MAX,
  });
  const card = gsCard(tid, ticket.ver, cands, dealsFailed, ticket.no);
  let sent = false;
  if (target) {
    try {
      sent = await deps.push(target, [{ type: "text", text }, card], `${tid}:${ticket.ver}`);
    } catch {
      sent = false;
    }
  }
  if (sent) {
    ticket.pushed = true;
    try {
      // 押されたあと（状態・版が変わった・決定の印がある）の票を、手元の asking で上書きしない（11/25 レビュー 2）
      const now = asTicket(await kv.get(gsTicketKey(tid)));
      const decided = await kv.get(gsDecKey(tid));
      if (now && now.state === "asking" && now.ver === ticket.ver && !decided) {
        await kv.set(gsTicketKey(tid), { ...now, pushed: true }, GS_TICKET_TTL);
      }
    } catch {
      deps.log(`[group-satei] ticket ${receiptOf(ticket.no)} pushed-mark-failed`);
    }
  }
  return { sent, asked: cands.length };
}

export type GsRereadKv = GsKv & {
  smembers(key: string): Promise<unknown[]>;
  srem(key: string, member: string): Promise<void>;
  del(key: string): Promise<void>;
};

const lateMember = (m: GsMedia) => `${m.kind}:${m.messageId}`;
function parseLate(v: unknown): { kind: "image" | "pdf"; id: string } | null {
  const s = typeof v === "string" ? v : "";
  const i = s.indexOf(":");
  const kind = s.slice(0, i);
  const id = s.slice(i + 1);
  return (kind === "image" || kind === "pdf") && id ? { kind, id } : null;
}

/**
 * あとから届いた画像・PDF を、そのグループの開いている受付票に足す（11/25）。
 * 受付票そのものは書き換えない（同時に届いた画像どうし・ボタンの処理と書き合いにならないよう、
 * 足すのは受付票ごとの集合への sadd と、読み直す時刻だけ）。足した受付票の ID を返す（読み直すのは runRereadWorker）。
 * 例外は投げない。
 */
export async function attachLateMedia(
  row: GsMedia,
  groupId: string,
  deps: { env?: GsEnv; kv: GsRereadKv | null; now(): number; log(l: string): void },
): Promise<string | null> {
  const env = deps.env ?? process.env;
  if (!groupSateiOn(groupId, env)) return null;
  const kv = deps.kv;
  if (!kv) return null;
  try {
    const tids = (await kv.smembers(gsOpenKey(groupId))).filter((x): x is string => typeof x === "string");
    const open: Array<{ tid: string; t: GsTicket }> = [];
    for (const tid of tids) {
      const t = asTicket(await kv.get(gsTicketKey(tid)));
      if (t && t.state === "asking") open.push({ tid, t });
    }
    open.sort((a, b) => b.t.at - a.t.at);
    const admin = sateiNotifyTarget(env);
    for (const { tid, t } of open) {
      if (!lateMediaMatches(t, row, open.length, admin)) continue;
      const receipt = receiptOf(t.no);
      if (!t.deferred && ((t.rereads ?? 0) >= GS_REREAD_MAX || t.mediaIds.length >= GS_MATERIALS_MAX)) {
        deps.log(`[group-satei] ticket ${receipt} late-media over`);
        return null;
      }
      // 読み直す時刻を先に延ばしてから資料を足す（読む側が「静かになった」と見て、この資料を取りこぼさない）
      await kv.set(gsRereadAtKey(tid), deps.now() + GS_QUIET_MS, GS_TICKET_TTL);
      await kv.sadd(gsLateKey(tid), lateMember(row));
      await kv.expire(gsLateKey(tid), GS_TICKET_TTL);
      await kv.set(gsMsgKey(row.messageId), tid, GS_TICKET_TTL);
      deps.log(`[group-satei] ticket ${receipt} late-media`);
      return tid;
    }
  } catch {
    deps.log("[group-satei] skip:late-media-kv");
  }
  return null;
}

export interface GsWorkerDeps extends GsOpenDeps {
  kv: GsRereadKv | null;
  sleep(ms: number): Promise<void>;
}

/**
 * 読み直しの係（11/25）。webhook の中（gsJobs。maxDuration 300 秒）で動き、毎分の見回りには頼らない。
 * - 受付票ごとに1つだけ（印 gsatei:rlock:<tid>）。印を取れなければ、取れるまで待ってから、自分の資料が残っていれば引き継ぐ。
 * - 読み直す時刻（最後の資料から1分・資料なしは90秒）まで待ち、読み直して知らせる。読むあいだに資料が増えたら、もう1周。
 * - 開始から 250 秒で打ち切る（関数の上限 300 秒の内側）。1周に要る時間（読み取り40秒＋候補＋送信）が残らなければ始めない。
 * 例外は投げない。
 */
export async function runRereadWorker(tid: string, deps: GsWorkerDeps): Promise<void> {
  const env = deps.env ?? process.env;
  if (!groupSateiActive(env)) return;
  const kv = deps.kv;
  if (!kv) return;
  const start = deps.now();
  const left = () => GS_WORKER_DEADLINE_MS - (deps.now() - start);
  try {
    for (;;) {
      if (await hasNothingToDo(tid, kv)) return;
      if (await kv.setNx(gsRereadLockKey(tid), 1, GS_LOCK_TTL_S)) break;
      // ほかの呼び出しが読んでいる：終わるのを待つ（その係が残りも拾うので、多くはここで仕事が無くなる）
      if (left() < GS_ROUND_MS) return;
      await deps.sleep(GS_POLL_MS);
    }
    try {
      for (let round = 0; round < GS_REREAD_MAX + 1; round++) {
        // 静かになるまで待つ（資料が届くたびに時刻が延びる）
        for (;;) {
          const at = Number(await kv.get(gsRereadAtKey(tid)));
          const wait = Number.isFinite(at) ? at - deps.now() : 0;
          if (wait <= 0) break;
          if (left() - GS_ROUND_MS < Math.min(wait, GS_POLL_MS)) break;
          await deps.sleep(Math.min(wait, GS_POLL_MS));
        }
        if (left() < GS_ROUND_MS) {
          deps.log("[group-satei] reread out-of-time");
          return;
        }
        const more = await rereadOne(tid, deps, kv);
        if (!more) return;
      }
    } finally {
      await kv.del(gsRereadLockKey(tid)).catch(() => undefined);
    }
  } catch {
    deps.log("[group-satei] reread skip:exception");
  }
}

/** まだ asking で、待っている最初の知らせか、足していない資料があるか */
async function hasNothingToDo(tid: string, kv: GsRereadKv): Promise<boolean> {
  const t = asTicket(await kv.get(gsTicketKey(tid)));
  if (!t || t.state !== "asking" || (await kv.get(gsDecKey(tid)))) return true;
  if (t.deferred) return false;
  const late = (await kv.smembers(gsLateKey(tid))).map(parseLate).filter((x) => x && !t.mediaIds.includes(x.id));
  return late.length === 0 || (t.rereads ?? 0) >= GS_REREAD_MAX || t.mediaIds.length >= GS_MATERIALS_MAX;
}

/** 1回読み直して知らせる。まだ足していない資料が残っていれば true（もう1周） */
async function rereadOne(tid: string, deps: GsOpenDeps, kv: GsRereadKv): Promise<boolean> {
  const t = asTicket(await kv.get(gsTicketKey(tid)));
  if (!t || t.state !== "asking" || (await kv.get(gsDecKey(tid)))) return false;
  const receipt = receiptOf(t.no);
  const late = (await kv.smembers(gsLateKey(tid))).map(parseLate).filter((x): x is { kind: "image" | "pdf"; id: string } => x !== null);
  const fresh = late.filter((l) => !t.mediaIds.includes(l.id));
  const room = Math.max(0, GS_MATERIALS_MAX - t.mediaIds.length);
  const added = fresh.slice(0, room);
  if (!t.deferred && (added.length === 0 || (t.rereads ?? 0) >= GS_REREAD_MAX)) return false;
  const mediaIds = [...t.mediaIds, ...added.map((l) => l.id)];
  const base = t.materials ?? { images: 0, pdfs: 0 };
  const materials = {
    images: base.images + added.filter((l) => l.kind === "image").length,
    pdfs: base.pdfs + added.filter((l) => l.kind === "pdf").length,
  };

  let read: GsRead | null = t.deferred && added.length === 0 ? t.read : null;
  let readFailed: string | undefined = t.deferred && added.length === 0 ? t.readFailed : undefined;
  if (!(t.deferred && added.length === 0)) {
    let capped = false;
    try {
      const n = await kv.incr(gsReadsKey(deps.ymd()));
      await kv.expire(gsReadsKey(deps.ymd()), 2 * 24 * 60 * 60);
      capped = n > GS_READS_PER_DAY;
    } catch {
      readFailed = "cap-kv";
    }
    if (!readFailed && capped) readFailed = "cap";
    if (!readFailed) {
      try {
        read = await deps.read(mediaIds, "");
      } catch {
        readFailed = "read-failed";
      }
    }
  }

  // 読んでいるあいだに押された・版が進んだ → 書かない（11/25 レビュー 2）
  const now = asTicket(await kv.get(gsTicketKey(tid)));
  if (!now || now.state !== "asking" || now.ver !== t.ver || (await kv.get(gsDecKey(tid)))) {
    deps.log(`[group-satei] ticket ${receipt} reread stale`);
    return false;
  }
  const wasDeferred = Boolean(t.deferred);
  const next: GsTicket = { ...now, mediaIds, materials, read, deferred: false, pushed: false };
  if (readFailed) next.readFailed = readFailed;
  else delete next.readFailed;
  if (!wasDeferred) {
    next.ver = now.ver + 1;
    next.rereads = (now.rereads ?? 0) + 1;
  }
  await saveTicket(kv, tid, next, receipt, deps);
  for (const l of added) await kv.srem(gsLateKey(tid), `${l.kind}:${l.id}`);
  const { sent } = await notifyTicket(tid, next, deps, kv, !wasDeferred);
  deps.log(
    `[group-satei] ticket ${receipt} reread ${next.read ? "read ok" : `read ${next.readFailed}`} ${wasDeferred ? "first" : `v${next.ver}`}${sent ? "" : " push-failed"}`,
  );
  // 読むあいだに届いた資料が残っていれば、もう1周（11/25 レビュー 3）
  const rest = (await kv.smembers(gsLateKey(tid))).map(parseLate).filter((x) => x && !mediaIds.includes(x.id));
  return rest.length > 0 && (next.rereads ?? 0) < GS_REREAD_MAX && mediaIds.length < GS_MATERIALS_MAX;
}
