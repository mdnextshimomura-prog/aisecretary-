/**
 * 段2d（計画 docs/superpowers/plans/2026-11-26-group-satei-2d.md）：準備の開始・［いいよ］［直す］・直しの1通・見回り・事例の PDF の控え。
 * portal・LINE・Claude は deps で受ける（本物は group-satei-wire.ts）。例外は投げない。ログは符号と受付番号だけ。
 */
import { randomUUID } from "node:crypto";
import {
  GS_AMBIG_TTL, GS_CASE_ITEMS_RAW_MAX, GS_CASES_DRAFT_TRIES, GS_CASES_FINISH_MIN_MS, GS_CASES_LATE_MS, GS_CASES_PUSH_TRIES, GS_CASES_QUIET_MS, GS_CASES_TTL, GS_FIX_MAX, GS_FIX_TTL, GS_GROUP_PUSH_MAX, GS_LATE_MS, GS_OK_STALE_MS, GS_PROPOSE_TRIES, GS_REMIND_TRIES, GS_STAGE2_SET, GS_SWEEP_BUDGET_MS, GS_SWEEP_MARGIN_MS, GS_TICKET_TTL, asTicket,
  asCaseItems, groupSateiPrepOn, gsAmbigKey, gsCaseItemsKey, gsCaseStaffId, gsCasesKey, gsDecKey, gsFixKey, gsOkKey, gsOkRetryKey, gsOpenKey, gsRemindKey, gsTicketKey, gsWaitKey, receiptOf,
  type GsAction, type GsCaseItem, type GsMedia, type GsPrepKind, type GsState, type GsTicket,
} from "./group-satei-data";
import type { GsActionDeps, GsOutcome } from "./group-satei-actions";
import type { GsKv } from "./group-satei-open";
import { MSG_GS_BUSY, MSG_GS_NO_FOLDER, msgGsAlready } from "./group-satei-card";
import {
  gsBuildingOf, gsCaseRequestMessages, gsCleanLines, gsReminderMessages, msgGsPrepFailed, msgGsPrepLate, msgGsRemindFailed, msgGsRemindMe, msgGsRemindUnknown, gsCaseRequestPlain, gsProposalCard, gsPublicPlace, msgGsAlreadyRequested, msgGsCaseRequested,
  msgGsCaseSendFailed, msgGsFixAsk, msgGsFixDone, msgGsFixFailed, msgGsFixLimit, msgGsFixUnsafe, msgGsPrepRejected, msgGsPrepStarted, msgGsPrepStopped,
  msgGsPrepUnknown, MSG_GS_PROPOSAL_STALE,
  msgGsCasesAmbig, msgGsCasesDraftUnknown, msgGsCasesFailed, msgGsCasesNoAuto, msgGsCasesSlow, msgGsCasesUnsaved, msgGsCasesNoStart, msgGsCasesSomeFailed, msgGsCasesStarted,
} from "./group-satei-case";
import { gsSateiIntake } from "./group-satei-intake";
import { gsCaseDeadline, gsDeadlineLabel } from "./group-satei-deadline";
import type { GsPrepPortal, SateiPrepNotice } from "./group-satei-prep-portal";
import { isSateiUser, sateiActive, sateiNotifyTarget } from "./satei-data";
import { judgeSateiDeal, normNotionId, type SateiDeal } from "./satei-deal";
import type { SateiCall, SateiIntakeOk, SateiIntakeReq } from "./satei-portal";
import { MSG_SATEI_DEAL_NOT_FOUND } from "./satei-text";
import type { FlexMessage } from "./task-card";
import { gsOutboxAdd, gsOutboxRetry, type GsObKind } from "./group-satei-outbox";
import type { GsCasesNote } from "./group-satei-data";

type Kv = GsKv & { del(key: string): Promise<void>; srem(key: string, member: string): Promise<void> };

/** 受付票を書く。asking 以外は開いている集合から外す（あとから届いた資料を足さない） */
export async function saveGsTicket(kv: Kv, tid: string, tk: GsTicket): Promise<void> {
  await kv.set(gsTicketKey(tid), tk, GS_TICKET_TTL);
  if (tk.state !== "asking" && !tk.provisional) await kv.srem(gsOpenKey(tk.groupId), tid);
}

async function quiet(f: () => Promise<unknown>, deps: { log(l: string): void }, code: string): Promise<void> {
  try {
    await f();
  } catch {
    deps.log(`[group-satei] ${code}`);
  }
}

/** 案件が決まった受付票の準備を portal に頼む。null＝portal が止めている（PREP_DISABLED）ので 2a の道へ */
export async function startGsPrep(
  a: { tid: string; dealId: string },
  tk: GsTicket,
  deal: SateiDeal,
  kind: GsPrepKind,
  userId: string,
  deps: GsActionDeps,
  kv: Kv,
): Promise<GsOutcome | null> {
  const no = tk.no;
  if (!deps.prep) return null;
  if (!deps.dealsDbId || deal.gone || deal.parentDbId !== normNotionId(deps.dealsDbId)) return { text: MSG_SATEI_DEAL_NOT_FOUND, code: "not-found", settled: true };
  if (!deal.folderId) return { text: MSG_GS_NO_FOLDER, code: "no-folder", settled: true };
  if (!(await kv.setNx(gsDecKey(a.tid), `prep:${a.dealId}`, GS_TICKET_TTL))) return { text: msgGsAlready(no), code: "already", settled: true };
  const f = tk.read?.facts;
  let r;
  try {
    r = await deps.prep.intake({
      tid: a.tid, no, dealId: a.dealId, folderId: deal.folderId, kind,
      place: tk.read?.address ?? null,
      building: kind === "マンション" ? gsBuildingOf(tk.read) : null,
      facts: { builtYm: f?.builtYm ?? null, exclusiveArea: f?.exclusiveArea ?? null, landArea: f?.landArea ?? null, buildingArea: f?.buildingArea ?? null },
      requestedBy: userId,
    });
  } catch {
    r = { kind: "unknown" as const, reason: "exception" };
  }
  if (r.kind === "rejected" && (r.code === "PREP_DISABLED" || r.code === "INTAKE_STOPPED")) {
    await quiet(() => kv.del(gsDecKey(a.tid)), deps, "gs prep dec-clear-failed");
    if (r.code === "PREP_DISABLED") return null;
    return { text: msgGsPrepStopped(no), code: `prep stopped ${receiptOf(no)}`, settled: true };
  }
  if (r.kind === "rejected") {
    await quiet(() => kv.del(gsDecKey(a.tid)), deps, "gs prep dec-clear-failed");
    return { text: msgGsPrepRejected(no), code: `prep rejected ${receiptOf(no)}`, settled: true };
  }
  // ok と結果不明は同じ受付票にする（結果不明でも portal に届いていれば、見回りが案を拾う。届いていなければ30分の知らせ）
  const now = (deps.now ?? Date.now)();
  const next: GsTicket = {
    ...tk, state: "gathering", provisional: false, dealId: a.dealId, requestKind: "satei", prepAt: now,
    prep: { kind, rev: 0, lines: [], fixes: 0, sentRev: 0, tries: 0, groupPushes: 0 },
  };
  await quiet(() => saveGsTicket(kv, a.tid, next), deps, "gs save-failed");
  await quiet(() => kv.sadd(GS_STAGE2_SET, a.tid), deps, "gs s2-add-failed");
  return r.kind === "ok"
    ? { text: msgGsPrepStarted(no), code: `prep sent ${receiptOf(no)}`, settled: true }
    : { text: msgGsPrepUnknown(no), code: `prep unknown ${receiptOf(no)}`, settled: true };
}

const sentOk = (status: number | null) => status !== null && ((status >= 200 && status < 300) || status === 409);

/** 手で頼むことにした受付票を閉じる（見回りの集合から外し、portal に manual を残す） */
async function closeManual(tid: string, tk: GsTicket, rev: number, deps: { prep?: GsActionDeps["prep"]; log(l: string): void }, kv: Kv): Promise<void> {
  await quiet(() => saveGsTicket(kv, tid, { ...tk, state: "manual" }), deps, "prep save-failed");
  await quiet(() => kv.srem(GS_STAGE2_SET, tid), deps, "prep s2-rem-failed");
  if (deps.prep) await quiet(() => deps.prep!.decide(tid, { decision: "manual", rev }), deps, "prep decide-failed");
}

/**
 * ［いいよ］の印が取られたまま送れていない票（印を取ったあと push の前に落ちた）を、1回だけ送り直してよいか。
 * まだ proposing（呼ぶ側で確かめ済み）・グループへ0回・印が2分より前のときだけ。送り直しは同じ retry key（LINE が重ねない）
 */
async function mayRetryOk(tid: string, p: NonNullable<GsTicket["prep"]>, now: number, kv: Kv): Promise<boolean> {
  if (p.groupPushes > 0 || p.requestedAt !== undefined) return false;
  const v = await kv.get(gsOkKey(tid)).catch(() => null);
  const at = v && typeof v === "object" ? (v as { at?: unknown }).at : undefined;
  if (typeof at !== "number" || now - at < GS_OK_STALE_MS) return false;
  return kv.setNx(gsOkRetryKey(tid), 1, GS_TICKET_TTL).catch(() => false);
}

/** ［いいよ］（gy）と［直す］（gf）。版（rev）が今の案と同じときだけ */
export async function answerGsProposal(
  a: Extract<GsAction, { op: "gy" | "gf" }>,
  tk: GsTicket,
  userId: string,
  deps: GsActionDeps,
  kv: Kv,
): Promise<GsOutcome> {
  const env = deps.env ?? process.env;
  const no = tk.no;
  const p = tk.prep;
  if (a.op === "gy" && tk.state === "waiting-cases") return { text: msgGsAlreadyRequested(no), code: "already", settled: true };
  if (tk.state !== "proposing" || !p) return { text: msgGsAlready(no), code: "closed", settled: true };
  if (a.rev !== p.rev) return { text: MSG_GS_PROPOSAL_STALE, code: "stale-rev", settled: true };

  if (a.op === "gf") {
    if (p.fixes >= GS_FIX_MAX) {
      await closeManual(a.tid, tk, p.rev, deps, kv);
      return { text: msgGsFixLimit(no), code: `fix-limit ${receiptOf(no)}`, settled: true };
    }
    await kv.set(gsFixKey(userId), { tid: a.tid, rev: p.rev, token: randomUUID() }, GS_FIX_TTL);
    return { text: msgGsFixAsk(no, GS_FIX_MAX - p.fixes), code: `asked ${receiptOf(no)}`, settled: true };
  }

  const staff = gsCaseStaffId(env);
  if (!staff || !deps.push) return { text: MSG_GS_BUSY, code: "config-missing", settled: false };
  const now = (deps.now ?? Date.now)();
  const deadline = gsCaseDeadline(now);
  const place = gsPublicPlace(tk.read, p.kind);
  const plain = gsCaseRequestPlain({ no, place, lines: p.lines, deadline });
  const messages = gsCaseRequestMessages({ staffId: staff, no, place, lines: p.lines, deadline });
  if (!(await kv.setNx(gsOkKey(a.tid), { rev: p.rev, at: now }, GS_TICKET_TTL)) && !(await mayRetryOk(a.tid, p, now, kv))) {
    return { text: msgGsAlreadyRequested(no), code: "already", settled: true };
  }
  if (!messages) {
    await closeManual(a.tid, tk, p.rev, deps, kv);
    return { text: msgGsCaseSendFailed(no, false, plain), code: `case-request unsafe ${receiptOf(no)}`, settled: true };
  }
  let status: number | null;
  let ids: string[] = [];
  try {
    if (deps.pushIds) {
      const r = await deps.pushIds(tk.groupId, messages, `case:${a.tid}`);
      status = r.status;
      ids = r.ids;
    } else {
      status = await deps.push(tk.groupId, messages, `case:${a.tid}`);
    }
  } catch {
    status = null;
  }
  // 段2e（E3）：依頼カード（最後の1通）の messageId。応答から取れたときだけ
  const cardMsgId = ids.length === messages.length ? ids[ids.length - 1] : undefined;
  if (!sentOk(status)) {
    await closeManual(a.tid, { ...tk, prep: { ...p, groupPushes: p.groupPushes + 1 } }, p.rev, deps, kv);
    return { text: msgGsCaseSendFailed(no, status === null, plain), code: `case-request failed ${receiptOf(no)}`, settled: true };
  }
  const next: GsTicket = {
    ...tk, state: "waiting-cases",
    prep: { ...p, deadline, requestedAt: now, groupPushes: p.groupPushes + 1, ...(cardMsgId ? { cardMsgId } : {}) },
  };
  // 受付票の期限は waiting-cases からさらに7日（設計 10。書き直しで7日に付け直す）
  await quiet(() => saveGsTicket(kv, a.tid, next), deps, "prep save-failed");
  await quiet(async () => {
    await kv.sadd(gsWaitKey(tk.groupId), a.tid);
    await kv.expire(gsWaitKey(tk.groupId), GS_CASES_TTL);
  }, deps, "prep wait-add-failed");
  if (deps.prep) await quiet(() => deps.prep!.decide(a.tid, { decision: "ok", rev: p.rev, lines: p.lines, deadline }), deps, "prep decide-failed");
  return { text: msgGsCaseRequested(no, gsDeadlineLabel(deadline)), code: `case-request posted ${receiptOf(no)}`, settled: true };
}

export interface GsFixDeps {
  env?: Record<string, string | undefined>;
  kv: (Kv & { delIfToken(key: string, token: string): Promise<boolean> }) | null;
  /** 作り直した行／{ unsafe: true }＝検査に通らない（人の名前・番地など）／null＝作れなかった */
  revise(lines: string[], text: string, kind: GsPrepKind): Promise<string[] | { unsafe: true } | null>;
  reply(token: string, text: string, card?: FlexMessage): Promise<unknown>;
  now?(): number;
  log(l: string): void;
}

const FIX_TEXT_MAX = 1000;

/**
 * 1対1の文字を［直す］の答えとして受けるか。true＝受けた（返事も済み）、false＝今の流れへ。
 * 受けるのは 2d が on・1対1・TASK_SATEI_USER_IDS の人・空でない文字・印（gsatei:fix:<userId>）があるときだけ。それ以外は KV も読まない…
 * ではなく、印を1回読む（差し戻し理由の受け方と同じ）。印は読んだらすぐ消す（作り直せなかったら［直す］を押し直してもらう）
 */
export async function handleGsFixText(m: { userId?: string; groupId?: string; text: string; replyToken: string }, deps: GsFixDeps): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (!groupSateiPrepOn(env) || m.groupId || !m.userId || !isSateiUser(m.userId, env) || !deps.kv) return false;
  const text = Array.from((m.text ?? "").trim()).slice(0, FIX_TEXT_MAX).join("");
  if (!text) return false;
  const kv = deps.kv;
  const key = gsFixKey(m.userId);
  let mark: { tid?: unknown; rev?: unknown; token?: unknown } | null;
  try {
    const v = await kv.get(key);
    mark = v && typeof v === "object" ? (v as { tid?: unknown; rev?: unknown; token?: unknown }) : null;
  } catch {
    deps.log("[group-satei] fix read-failed");
    return false;
  }
  if (!mark || typeof mark.tid !== "string" || typeof mark.rev !== "number" || typeof mark.token !== "string") return false;
  const tid = mark.tid;
  // 印を消せたときだけ受ける（同時の2通目・消せなかったときは作り直さず今の流れへ）
  let mine = false;
  try {
    mine = await kv.delIfToken(key, mark.token);
  } catch {
    deps.log("[group-satei] fix clear-failed");
  }
  if (!mine) return false;
  const say = async (s: string, card?: FlexMessage) => {
    try {
      await deps.reply(m.replyToken, s, card);
    } catch {
      deps.log("[group-satei] reply-failed fix");
    }
  };
  const tk = asTicket(await kv.get(gsTicketKey(tid)).catch(() => null));
  if (!tk || tk.state !== "proposing" || !tk.prep || tk.prep.rev !== mark.rev) {
    deps.log("[group-satei] fix stale");
    await say(MSG_GS_PROPOSAL_STALE);
    return true;
  }
  const p = tk.prep;
  let got: string[] | { unsafe: true } | null = null;
  try {
    got = await deps.revise(p.lines, text, p.kind);
  } catch {
    got = null;
  }
  if (got && !Array.isArray(got)) {
    // 人の名前・番地が入りそうな作り直しは使わない（前の案のまま・回数に数えない）
    deps.log(`[group-satei] fix unsafe ${receiptOf(tk.no)}`);
    await say(msgGsFixUnsafe(tk.no));
    return true;
  }
  const lines = got;
  if (!lines) {
    deps.log(`[group-satei] fix failed ${receiptOf(tk.no)}`);
    await say(msgGsFixFailed(tk.no));
    return true;
  }
  const next: GsTicket = { ...tk, prep: { ...p, rev: p.rev + 1, lines, fixes: p.fixes + 1, sentRev: p.rev + 1 } };
  // 書く直前に読み直し、まだ同じ版の proposing のときだけ（同時の［いいよ］を上書きしない）
  const fresh = asTicket(await kv.get(gsTicketKey(tid)).catch(() => null));
  if (!fresh || fresh.state !== "proposing" || fresh.prep?.rev !== p.rev) {
    await say(MSG_GS_PROPOSAL_STALE);
    return true;
  }
  await quiet(() => saveGsTicket(kv, tid, next), deps, "fix save-failed");
  const now = (deps.now ?? Date.now)();
  const card = gsProposalCard({ tid, ver: tk.ver, no: tk.no, rev: next.prep!.rev, place: gsPublicPlace(tk.read, p.kind), lines, previewDeadline: gsCaseDeadline(now) });
  deps.log(`[group-satei] fix revised ${receiptOf(tk.no)} r${next.prep!.rev}`);
  await say(msgGsFixDone(tk.no, next.prep!.fixes), card);
  return true;
}

type SweepKv = Kv & {
  smembers(key: string): Promise<unknown[]>;
  /** 段2e：末尾に足し、先頭から max 件に切り、期限を付け直す（無い作りでは PDF を受付票に結びつけない） */
  rpushCap?(key: string, value: unknown, max: number, ex: number): Promise<void>;
};

export interface GsSweepDeps {
  env?: Record<string, string | undefined>;
  kv: SweepKv | null;
  prep: GsPrepPortal | null;
  push(to: string, messages: unknown[], key: string): Promise<number | null>;
  now(): number;
  /** 見回りの開始の時刻（cloud-tick の t0）。無ければ呼ばれた時刻。ここから GS_SWEEP_BUDGET_MS の予算 */
  startedAt?: number;
  /** 段2e：事例を保存したあと、マンションの下書きを始める（段1の［案件を選ぶ］と同じ受付）。無ければ手作業の案内 */
  satei?: {
    dealsDbId: string | null;
    readDeal(dealId: string): Promise<{ deal: SateiDeal; kind: string | null } | null>;
    intake(req: SateiIntakeReq): Promise<SateiCall<SateiIntakeOk>>;
  } | null;
  log(l: string): void;
}

const textMsg = (text: string) => [{ type: "text", text }];

/** 段2f（F3）：下村さんあての1回きりの知らせが送れなかったら控えに積む（見回りが同じ retry key で送り直す） */
/** 送れた・積めたら true（積めなければ false＝閉じる知らせは閉じずにやり直す） */
async function toOutbox(st: number | null, kind: GsObKind, id: string, no: number | null, deps: { now?(): number; log(l: string): void }, kv: SweepKv): Promise<boolean> {
  if (sentOk(st)) return true;
  return gsOutboxAdd(kv, kind, id, (deps.now ?? Date.now)(), deps.log, no === null ? "" : receiptOf(no));
}

/** 失敗・検査に通らない案・2回届かなかった案：下村さんに1回だけ知らせて手作業（グループには何も出さない。見回りから外す） */
async function failToManual(tid: string, tk: GsTicket, to: string, deps: GsSweepDeps, kv: SweepKv, code: string): Promise<void> {
  const st = await deps.push(to, textMsg(msgGsPrepFailed(tk.no)), `prepfail:${tid}`).catch(() => null);
  deps.log(`[group-satei] ${code} ${receiptOf(tk.no)}${sentOk(st) ? "" : " push-failed"}`);
  await closeManual(tid, tk, 0, deps, kv);
}

async function deliverProposal(tid: string, tk: GsTicket, nt: SateiPrepNotice, to: string, deps: GsSweepDeps, kv: SweepKv): Promise<void> {
  const p = tk.prep!;
  const lines = nt.status === "相談中" ? gsCleanLines(nt.lines) : null;
  if (!lines) return failToManual(tid, tk, to, deps, kv, "prep failed");
  if (p.tries >= GS_PROPOSE_TRIES) return failToManual(tid, tk, to, deps, kv, "propose gave-up");
  const card = gsProposalCard({ tid, ver: tk.ver, no: tk.no, rev: 1, place: gsPublicPlace(tk.read, p.kind), lines, previewDeadline: gsCaseDeadline(deps.now()) });
  const st = await deps.push(to, [card], `prop:${tid}:1`).catch(() => null);
  const fresh = asTicket(await kv.get(gsTicketKey(tid)));
  if (!fresh || fresh.state !== "gathering") return;
  const next: GsTicket = sentOk(st)
    ? { ...fresh, state: "proposing", prep: { ...p, rev: 1, lines, sentRev: 1, tries: p.tries + 1 } }
    : { ...fresh, prep: { ...p, tries: p.tries + 1 } };
  await saveGsTicket(kv, tid, next);
  deps.log(`[group-satei] propose ${sentOk(st) ? "sent" : "push-failed"} ${receiptOf(tk.no)} r1`);
  // 2回とも届かなければ、黙って7日待たせない
  if (!sentOk(st) && next.prep!.tries >= GS_PROPOSE_TRIES) await failToManual(tid, next, to, deps, kv, "propose gave-up");
}

async function remind(tid: string, tk: GsTicket, to: string | null, staff: string, deps: GsSweepDeps, kv: SweepKv): Promise<void> {
  const p = tk.prep!;
  if ((await kv.smembers(gsCasesKey(tid))).length > 0) {
    await kv.srem(GS_STAGE2_SET, tid);
    return;
  }
  // 予約してから送る（多くて1回）。はっきり失敗（HTTP の誤り）なら予約を外して次の回に。結果不明は予約を残す（重ねない側）
  if (!(await kv.setNx(gsRemindKey(tid), 1, GS_CASES_TTL))) return;
  const st = await deps.push(tk.groupId, gsReminderMessages(staff, tk.no), `remind:${tid}`).catch(() => null);
  if (st !== null && !sentOk(st)) {
    const fails = (p.remindFails ?? 0) + 1;
    if (fails < GS_REMIND_TRIES) {
      await saveGsTicket(kv, tid, { ...tk, prep: { ...p, remindFails: fails } });
      await quiet(() => kv.del(gsRemindKey(tid)), deps, "remind release-failed");
      deps.log(`[group-satei] remind push-failed ${receiptOf(tk.no)} retry`);
      return;
    }
    await saveGsTicket(kv, tid, { ...tk, prep: { ...p, reminded: true, remindFails: fails, remindNote: "failed" } });
    if (to) {
      const me = await deps.push(to, textMsg(msgGsRemindFailed(tk.no)), `remind-me:${tid}`).catch(() => null);
      await toOutbox(me, "remind-note", tid, tk.no, deps, kv);
    }
    await kv.srem(GS_STAGE2_SET, tid);
    deps.log(`[group-satei] remind push-failed ${receiptOf(tk.no)} gave-up`);
    return;
  }
  await saveGsTicket(kv, tid, { ...tk, prep: { ...p, reminded: true, groupPushes: p.groupPushes + 1, remindNote: sentOk(st) ? "sent" : "unknown" } });
  if (to && p.deadline) {
    const me = sentOk(st) ? msgGsRemindMe(tk.no, gsDeadlineLabel(p.deadline)) : msgGsRemindUnknown(tk.no);
    const ms = await deps.push(to, textMsg(me), `remind-me:${tid}`).catch(() => null);
    await toOutbox(ms, "remind-note", tid, tk.no, deps, kv);
  }
  await kv.srem(GS_STAGE2_SET, tid);
  deps.log(`[group-satei] remind ${sentOk(st) ? "sent" : "push-failed"} ${receiptOf(tk.no)}`);
}

/**
 * 毎分の見回り（D10）：gsatei:s2 の受付票だけを見る。
 * gathering → portal の一覧から案（相談中）を下村さんへ／失敗なら手作業／30分で遅れの知らせ。
 * waiting-cases → 期日を過ぎて PDF の控えが無ければ1回だけリマインド。終わった票は集合から外す。例外は投げない
 */
export async function sweepGsStage2(deps: GsSweepDeps): Promise<void> {
  const env = deps.env ?? process.env;
  if (!groupSateiPrepOn(env) || !deps.kv) return;
  const start = deps.startedAt ?? deps.now();
  await sweepS2Tickets(deps, deps.kv, env, start);
  // 段2f（F3）：最後に控えの送り直しを1件（予算の残りが15秒以上のときだけ。中で確かめる）
  await gsOutboxRetry({ kv: deps.kv, to: sateiNotifyTarget(env), push: deps.push, now: deps.now, startedAt: start, log: deps.log });
}

async function sweepS2Tickets(deps: GsSweepDeps, kv: SweepKv, env: Record<string, string | undefined>, start: number): Promise<void> {
  try {
    const tids = (await kv.smembers(GS_STAGE2_SET)).filter((x): x is string => typeof x === "string");
    if (tids.length === 0) return;
    const to = sateiNotifyTarget(env);
    const staff = gsCaseStaffId(env)!;
    let stopped = false;
    // 新しい票に手を付けてよいか（予算の残りが GS_SWEEP_MARGIN_MS を切ったら、その回はやめて次の回へ）
    const go = () => {
      if (stopped) return false;
      if (deps.now() - start < GS_SWEEP_BUDGET_MS - GS_SWEEP_MARGIN_MS) return true;
      stopped = true;
      deps.log("[group-satei] s2-sweep budget");
      return false;
    };
    const live: Array<{ tid: string; tk: GsTicket }> = [];
    for (const tid of tids) {
      const tk = asTicket(await kv.get(gsTicketKey(tid)));
      if (!tk || !tk.prep || !["gathering", "proposing", "waiting-cases"].includes(tk.state)) {
        await kv.srem(GS_STAGE2_SET, tid);
        continue;
      }
      live.push({ tid, tk });
    }
    const gathering = live.filter((x) => x.tk.state === "gathering");
    // 宛先・portal が無いと案を届けられない（飛ばすのは変えない。見えるように、その回に1度だけ符号でログ）
    if (gathering.length > 0 && !to) deps.log("[group-satei] propose skip:no-target");
    else if (gathering.length > 0 && !deps.prep) deps.log("[group-satei] propose skip:no-portal");
    // 一覧は1回の見回りで1回だけ（案の配達と段2e の結果で同じものを使う）
    let noticesP: Promise<Awaited<ReturnType<GsPrepPortal["notices"]>> | null> | null = null;
    const notices = () => (noticesP ??= deps.prep!.notices().catch(() => null));
    if (gathering.length > 0 && deps.prep && to && go()) {
      const r = await notices();
      const list = r && r.kind === "ok" ? r.value : [];
      if (!r || r.kind !== "ok") deps.log("[group-satei] propose list-failed");
      for (const { tid, tk } of gathering) {
        if (!go()) break;
        const nt = list.find((x) => x.tid === tid);
        if (nt) {
          await deliverProposal(tid, tk, nt, to, deps, kv);
          continue;
        }
        if (!tk.prep!.lateNotified && tk.prepAt && deps.now() - tk.prepAt >= GS_LATE_MS) {
          const st = await deps.push(to, textMsg(msgGsPrepLate(tk.no)), `late:${tid}`).catch(() => null);
          await saveGsTicket(kv, tid, { ...tk, prep: { ...tk.prep!, lateNotified: true } });
          deps.log(`[group-satei] prep late ${receiptOf(tk.no)}${sentOk(st) ? "" : " push-failed"}`);
          await toOutbox(st, "prop-late", tid, tk.no, deps, kv);
        }
      }
    }
    const handed: Array<{ tid: string; tk: GsTicket; seen: number; items: GsCaseItem[] }> = [];
    for (const { tid, tk } of live) {
      if (tk.state !== "waiting-cases") continue;
      const p = tk.prep!;
      // 段2e：受付票に結びついた PDF がある票は催促しない。最後の PDF から2分で portal へ1回だけ渡す（E4）
      const raw = await kv.lrange(gsCaseItemsKey(tid));
      const items = asCaseItems(raw);
      if (p.casesHanded !== undefined) {
        handed.push({ tid, tk, seen: asCaseItems(raw, GS_CASE_ITEMS_RAW_MAX).length, items });
        continue;
      }
      if (items.length > 0) {
        const last = Math.max(...items.map((x) => x.at));
        let changed = false;
        if (deps.prep?.cases && deps.now() - last >= GS_CASES_QUIET_MS) {
          if (!go()) break;
          changed = await handCases(tid, tk, items.length, to, deps, kv);
        }
        // 渡せないまま（結果不明が続く・portal が無い）なら、最後の PDF から30分で下村さんへ1回だけ（H1・M2）
        if (!changed && to) {
          if (!go()) break;
          await casesLate(tid, tk, items, to, deps, kv);
        }
        continue;
      }
      if (p.reminded || p.groupPushes >= GS_GROUP_PUSH_MAX) {
        await kv.srem(GS_STAGE2_SET, tid);
        continue;
      }
      if (p.deadline && deps.now() >= p.deadline) {
        if (!go()) break;
        await remind(tid, tk, to, staff, deps, kv);
      }
    }
    if (handed.length > 0 && !to) deps.log("[group-satei] cases skip:no-target");
    if (handed.length > 0 && to && deps.prep && go()) {
      const r = await notices();
      if (!r || r.kind !== "ok") deps.log("[group-satei] cases list-failed");
      const list = r && r.kind === "ok" ? r.value : [];
      // finishCases は readDeal・受付・push・ack で長くかかるので、残りが厚いときだけ・1回の見回りで1件だけ（M3）
      let finished = false;
      for (const h of handed) {
        const nt = list.find((x) => x.tid === h.tid && (x.status === "事例保存済み" || x.status === "事例失敗"));
        if (!go()) break;
        if (!nt) {
          await casesLate(h.tid, h.tk, h.items, to, deps, kv);
          continue;
        }
        if (finished) continue;
        if (deps.now() - start > GS_SWEEP_BUDGET_MS - GS_CASES_FINISH_MIN_MS) {
          deps.log("[group-satei] cases finish-later");
          finished = true;
          continue;
        }
        finished = true;
        await finishCases(h.tid, h.tk, nt, h.seen, to, deps, kv);
      }
    }
  } catch {
    deps.log("[group-satei] s2-sweep skip:exception");
  }
}

/**
 * 段2e：渡してから（渡せていなければ最後の PDF から）30分たっても portal の結果で閉じていなければ、下村さんへ1回だけ
 * （retry key cases-late:<tid>、印 prep.casesLateNotified）。票は閉じない（あとで結果が来れば finishCases で閉じる）
 */
async function casesLate(tid: string, tk: GsTicket, items: GsCaseItem[], to: string, deps: GsSweepDeps, kv: SweepKv): Promise<void> {
  const p = tk.prep!;
  if (p.casesDone || p.casesLateNotified || items.length === 0) return;
  const since = p.casesHandedAt ?? Math.max(...items.map((x) => x.at));
  if (deps.now() - since < GS_CASES_LATE_MS) return;
  const st = await deps.push(to, textMsg(msgGsCasesSlow(tk.no)), `cases-late:${tid}`).catch(() => null);
  const fresh = asTicket(await kv.get(gsTicketKey(tid)));
  if (fresh && fresh.state === "waiting-cases" && fresh.prep) {
    await saveGsTicket(kv, tid, { ...fresh, prep: { ...fresh.prep, casesLateNotified: true } });
  }
  deps.log(`[group-satei] cases late ${receiptOf(tk.no)}${sentOk(st) ? "" : " push-failed"}`);
  await toOutbox(st, "cases-late", tid, tk.no, deps, kv);
}

/** 段2e：portal に「事例あり」を渡す。ok・PREP_CLOSED（前の回に渡せていた）は渡したことにし、ほかに断られたら手作業の知らせ。票を書き換えたら true */
async function handCases(tid: string, tk: GsTicket, n: number, to: string | null, deps: GsSweepDeps, kv: SweepKv): Promise<boolean> {
  const R = receiptOf(tk.no);
  const r = await deps.prep!.cases!(tid, { count: n }).catch(() => ({ kind: "unknown" as const, reason: "exception" }));
  if (r.kind === "unknown") {
    deps.log(`[group-satei] cases hand-unknown ${R}`);
    return false;
  }
  const fresh = asTicket(await kv.get(gsTicketKey(tid)));
  if (!fresh || fresh.state !== "waiting-cases" || !fresh.prep || fresh.prep.casesHanded !== undefined) return true;
  if (r.kind === "ok" || r.code === "PREP_CLOSED") {
    await saveGsTicket(kv, tid, { ...fresh, prep: { ...fresh.prep, casesHanded: n, casesHandedAt: deps.now() } });
    deps.log(r.kind === "ok" ? `[group-satei] cases handed ${R} ${n}` : `[group-satei] cases closed ${R}`);
    return true;
  }
  // PREP_STALE・404 など：Mac は取り出さない。PDF は人が 02 へ（結果の知らせと同じ文・同じ retry key）
  deps.log(`[group-satei] cases rejected ${R} ${r.code}`);
  if (!to) return false;
  const note: GsCasesNote = { contract: 0, listing: 0, failed: 0, unsaved: 0, draft: "failed" };
  const fp = fresh.prep;
  const tries = (fp.casesPushTries ?? 0) + 1;
  // 控えの作り直しに要る数を先に書く
  await quiet(() => saveGsTicket(kv, tid, { ...fresh, prep: { ...fp, casesNote: note } }), deps, "cases note-save-failed");
  const st = await deps.push(to, textMsg(msgGsCasesFailed(tk.no)), `cases:${tid}`).catch(() => null);
  if (!sentOk(st)) deps.log(`[group-satei] cases push-failed ${R}`);
  // 段2f（L2）：控えに積めなければ閉じない（次の見回りで同じ retry key でやり直す。GS_CASES_PUSH_TRIES 回まで）
  if (!(await toOutbox(st, "cases", tid, tk.no, deps, kv)) && tries < GS_CASES_PUSH_TRIES) {
    await saveGsTicket(kv, tid, { ...fresh, prep: { ...fresh.prep, casesPushTries: tries, casesNote: note } });
    return true;
  }
  await saveGsTicket(kv, tid, { ...fresh, state: "manual", prep: { ...fresh.prep, casesHanded: n, casesHandedAt: deps.now(), casesDone: true, casesPushTries: tries, casesNote: note } });
  await quiet(() => kv.srem(GS_STAGE2_SET, tid), deps, "cases s2-rem-failed");
  await quiet(() => kv.srem(gsWaitKey(tk.groupId), tid), deps, "cases wait-rem-failed");
  return true;
}

type DraftStart = { kind: "ok"; jobNo: number } | { kind: "no"; code: string } | { kind: "unknown" };

/** 段2e（E5）：マンションの下書きを、段1の［案件を選ぶ］と同じ受付で始める（eventId gs<tid>。requestedBy は TASK_SATEI_USER_IDS の先頭） */
async function startDraft(tid: string, tk: GsTicket, deps: GsSweepDeps, env: Record<string, string | undefined>): Promise<DraftStart> {
  const s = deps.satei;
  const by = sateiNotifyTarget(env);
  if (!sateiActive(env)) return { kind: "no", code: "satei-off" };
  if (!s || !s.dealsDbId || !tk.dealId || !by) return { kind: "no", code: "config-missing" };
  let got: { deal: SateiDeal; kind: string | null } | null;
  try {
    got = await s.readDeal(tk.dealId);
  } catch {
    return { kind: "unknown" };
  }
  const j = judgeSateiDeal(got?.deal ?? null, got?.kind ?? null, s.dealsDbId);
  if (!j.ok) return { kind: "no", code: j.reason };
  const r = await gsSateiIntake(tid, j.deal, by, s.intake);
  if (r.kind === "ok") return { kind: "ok", jobNo: r.value.no };
  if (r.kind === "unknown") return { kind: "unknown" };
  return { kind: "no", code: "rejected" };
}

/**
 * 段2e：portal の結果（事例保存済み・事例失敗）を下村さんへ1通（retry key cases:<tid>。2回まで）。
 * 送れたら（2回だめでも）受付票を閉じ、portal に cases-ack、見回りから外す。seen＝結びついた PDF の数（渡したあとの分も）。
 * 保存していない PDF の数は portal の結果から数える（seen − casesCount。casesCount が null なら casesHanded）。
 * 下書きの受付の取り直し（casesDraftTries）と push の取り直し（casesPushTries）は別に数える（それぞれ2回まで）
 */
async function finishCases(tid: string, tk: GsTicket, nt: SateiPrepNotice, seen: number, to: string, deps: GsSweepDeps, kv: SweepKv): Promise<void> {
  const env = deps.env ?? process.env;
  const R = receiptOf(tk.no);
  const p = tk.prep!;
  const tries = (p.casesPushTries ?? 0) + 1;
  const unsaved = Math.max(0, seen - (nt.casesCount ?? p.casesHanded ?? 0));
  let state: GsState = "manual";
  let jobNo: number | undefined;
  const lines: string[] = [];
  // 段2f（F4）：送り直しで文を作り直すための数（文は入れない）
  const note: GsCasesNote = { contract: 0, listing: 0, failed: 0, unsaved, draft: "failed" };
  if (nt.status === "事例保存済み" && nt.cases) {
    const c = nt.cases;
    note.contract = c.contract;
    note.listing = c.listing;
    note.failed = c.failed;
    note.draft = p.kind === "戸建" ? "house" : p.kind === "土地" ? "land" : "manual";
    deps.log(`[group-satei] cases saved ${R} ${c.contract}/${c.listing}/${c.failed}`);
    if (p.kind === "マンション") {
      const d = await startDraft(tid, tk, deps, env);
      if (d.kind === "unknown") {
        const dt = (p.casesDraftTries ?? 0) + 1;
        if (dt < GS_CASES_DRAFT_TRIES) {
          await saveGsTicket(kv, tid, { ...tk, prep: { ...p, casesDraftTries: dt } });
          deps.log(`[group-satei] cases draft-unknown ${R} retry`);
          return;
        }
      }
      if (d.kind === "ok") {
        state = "started";
        jobNo = d.jobNo;
        note.draft = "started";
        note.jobNo = d.jobNo;
        lines.push(msgGsCasesStarted(tk.no, c, d.jobNo));
        deps.log(`[group-satei] cases draft ${R} #J${d.jobNo}`);
      } else if (d.kind === "unknown") {
        // 1回目が実は通っていることがある：押す前に #J の知らせを待つよう案内する（二重の下書きを避ける）
        note.draft = "unknown";
        lines.push(msgGsCasesDraftUnknown(tk.no, c));
        deps.log(`[group-satei] cases draft-no ${R} unknown`);
      } else {
        lines.push(msgGsCasesNoStart(tk.no, c));
        deps.log(`[group-satei] cases draft-no ${R} ${d.code}`);
      }
    } else {
      lines.push(msgGsCasesNoAuto(tk.no, c, p.kind));
    }
    if (c.failed > 0) lines.push(msgGsCasesSomeFailed(c.failed));
  } else {
    deps.log(`[group-satei] cases failed ${R} ${nt.casesFailReason || "unknown"}`);
    lines.push(msgGsCasesFailed(tk.no));
  }
  if (unsaved > 0) lines.push(msgGsCasesUnsaved(unsaved));
  // 送る前に数を書いておく（push が通らなければ、控えから同じ文を作り直す）
  await quiet(async () => {
    const pre = asTicket(await kv.get(gsTicketKey(tid)));
    if (pre && pre.state === "waiting-cases" && pre.prep) await saveGsTicket(kv, tid, { ...pre, prep: { ...pre.prep, casesNote: note } });
  }, deps, "cases note-save-failed");
  const st = await deps.push(to, textMsg(lines.join("\n")), `cases:${tid}`).catch(() => null);
  const fresh = asTicket(await kv.get(gsTicketKey(tid)));
  if (!fresh || fresh.state !== "waiting-cases" || !fresh.prep) return;
  // 段2f（F4）：push は1回。だめなら控えへ積んでから閉じる（2回目の送り直しは控えに任せる。下書きの受付はやり直さない）。
  // 積めなければ閉じない（L2。次の見回りで finishCases をやり直す・同じ retry key。GS_CASES_PUSH_TRIES 回まで）
  if (!(await toOutbox(st, "cases", tid, tk.no, deps, kv)) && tries < GS_CASES_PUSH_TRIES) {
    await saveGsTicket(kv, tid, { ...fresh, prep: { ...fresh.prep, casesPushTries: tries, casesNote: note } });
    deps.log(`[group-satei] cases push-failed ${R} retry`);
    return;
  }
  await saveGsTicket(kv, tid, {
    ...fresh, state, ...(jobNo !== undefined ? { jobNo } : {}),
    prep: { ...fresh.prep, casesDone: true, casesPushTries: tries, casesNote: note },
  });
  await quiet(() => kv.srem(GS_STAGE2_SET, tid), deps, "cases s2-rem-failed");
  await quiet(() => kv.srem(gsWaitKey(tk.groupId), tid), deps, "cases wait-rem-failed");
  if (deps.prep?.casesAck) {
    const a = await deps.prep.casesAck(tid).catch(() => null);
    if (!a || a.kind !== "ok") deps.log(`[group-satei] cases ack-failed ${R}`);
  }
  deps.log(sentOk(st) ? `[group-satei] cases notified ${R}` : `[group-satei] cases push-failed ${R} outbox`);
}

/**
 * グループに PDF が貼られたら（段1の控えの道から呼ぶ）、そのグループの事例待ちの票に控える（D8）。
 * 依頼の時刻より後の PDF だけ。待ちの票が2件以上で区別がつかなければ全部に足す（催促しない側）。
 * 段2e：1件の票に決まったとき（E3 の引用か、待ちの票が1件だけ）だけ、その票の gsatei:caseitems に足す（取り出し・保存の対象）。
 * 決まらなければ下村さんへ1回だけ知らせる（E2。gsatei:ambig:<groupId>:<JST の日>:<候補の tid>）
 */
export async function markGsCasePdf(
  row: GsMedia,
  groupId: string,
  deps: { env?: Record<string, string | undefined>; kv: SweepKv | null; push?(to: string, messages: unknown[], key: string): Promise<number | null>; now?(): number; log(l: string): void },
): Promise<void> {
  const env = deps.env ?? process.env;
  if (row.kind !== "pdf" || !groupSateiPrepOn(env) || !deps.kv) return;
  const kv = deps.kv;
  try {
    const tids = (await kv.smembers(gsWaitKey(groupId))).filter((x): x is string => typeof x === "string");
    const cands: Array<{ tid: string; tk: GsTicket }> = [];
    for (const tid of tids) {
      const tk = asTicket(await kv.get(gsTicketKey(tid)));
      if (!tk || tk.state !== "waiting-cases") {
        await kv.srem(gsWaitKey(groupId), tid);
        continue;
      }
      if (row.at < (tk.prep?.requestedAt ?? Number.POSITIVE_INFINITY)) continue;
      await kv.sadd(gsCasesKey(tid), row.messageId);
      await kv.expire(gsCasesKey(tid), GS_CASES_TTL);
      const count = (await kv.smembers(gsCasesKey(tid))).length;
      deps.log(`[group-satei] cases marked ${receiptOf(tk.no)} ${count}`);
      cands.push({ tid, tk });
    }
    await linkCasePdf(row, groupId, cands, env, deps, kv);
  } catch {
    deps.log("[group-satei] cases skip:exception");
  }
}

const jstDay = (at: number) => new Date(at + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function linkCasePdf(
  row: GsMedia,
  groupId: string,
  cands: Array<{ tid: string; tk: GsTicket }>,
  env: Record<string, string | undefined>,
  deps: { push?(to: string, messages: unknown[], key: string): Promise<number | null>; now?(): number; log(l: string): void },
  kv: SweepKv,
): Promise<void> {
  if (cands.length === 0 || !kv.rpushCap) return;
  const byQuote = row.quoted !== undefined ? cands.filter((c) => c.tk.prep?.cardMsgId === row.quoted) : [];
  const one = byQuote.length === 1 ? byQuote[0] : cands.length === 1 ? cands[0] : null;
  if (!one) {
    // グループ・JST の日・候補の組で1回にまとめる（PDF ごとに出さない。鍵に messageId を入れない）
    const key = gsAmbigKey(groupId, jstDay(row.at), cands.map((c) => c.tid));
    if (!(await kv.setNx(key, 1, GS_AMBIG_TTL))) return;
    const to = sateiNotifyTarget(env);
    const text = msgGsCasesAmbig(cands.map((c) => c.tk.no));
    const st = to && deps.push ? await deps.push(to, textMsg(text), key.slice("gsatei:".length)).catch(() => null) : null;
    deps.log(`[group-satei] cases ambig ${cands.length}${sentOk(st) ? "" : " push-failed"}`);
    if (to && deps.push) await toOutbox(st, "ambig", key.slice("gsatei:ambig:".length), null, deps, kv);
    return;
  }
  if (one.tk.prep?.casesDone) return;
  const before = asCaseItems(await kv.lrange(gsCaseItemsKey(one.tid)), GS_CASE_ITEMS_RAW_MAX);
  if (before.some((x) => x.m === row.messageId)) return;
  await kv.rpushCap(gsCaseItemsKey(one.tid), { m: row.messageId, at: row.at }, GS_CASE_ITEMS_RAW_MAX, GS_CASES_TTL);
  // リマインドのあとで見回りから外れていても、取り出しのために戻す
  await kv.sadd(GS_STAGE2_SET, one.tid);
  deps.log(`[group-satei] cases linked ${receiptOf(one.tk.no)} ${before.length + 1}`);
}
