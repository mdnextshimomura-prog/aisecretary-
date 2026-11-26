/**
 * 段2d（計画 docs/superpowers/plans/2026-11-26-group-satei-2d.md）：準備の開始・［いいよ］［直す］・直しの1通・見回り・事例の PDF の控え。
 * portal・LINE・Claude は deps で受ける（本物は group-satei-wire.ts）。例外は投げない。ログは符号と受付番号だけ。
 */
import { randomUUID } from "node:crypto";
import {
  GS_CASES_TTL, GS_FIX_MAX, GS_FIX_TTL, GS_STAGE2_SET, GS_TICKET_TTL, asTicket, groupSateiPrepOn, gsCaseStaffId, gsDecKey, gsFixKey,
  gsOkKey, gsOpenKey, gsTicketKey, gsWaitKey, receiptOf,
  type GsAction, type GsPrepKind, type GsTicket,
} from "./group-satei-data";
import type { GsActionDeps, GsOutcome } from "./group-satei-actions";
import type { GsKv } from "./group-satei-open";
import { MSG_GS_BUSY, MSG_GS_NO_FOLDER, msgGsAlready } from "./group-satei-card";
import {
  gsBuildingOf, gsCaseRequestMessages, gsCaseRequestPlain, gsProposalCard, gsPublicPlace, msgGsAlreadyRequested, msgGsCaseRequested,
  msgGsCaseSendFailed, msgGsFixAsk, msgGsFixDone, msgGsFixFailed, msgGsFixLimit, msgGsPrepRejected, msgGsPrepStarted, msgGsPrepStopped,
  msgGsPrepUnknown, MSG_GS_PROPOSAL_STALE,
} from "./group-satei-case";
import { gsCaseDeadline, gsDeadlineLabel } from "./group-satei-deadline";
import { isSateiUser } from "./satei-data";
import { normNotionId, type SateiDeal } from "./satei-deal";
import { MSG_SATEI_DEAL_NOT_FOUND } from "./satei-text";
import type { FlexMessage } from "./task-card";

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
  if (!(await kv.setNx(gsOkKey(a.tid), String(p.rev), GS_TICKET_TTL))) return { text: msgGsAlreadyRequested(no), code: "already", settled: true };
  if (!messages) {
    await closeManual(a.tid, tk, p.rev, deps, kv);
    return { text: msgGsCaseSendFailed(no, false, plain), code: `case-request unsafe ${receiptOf(no)}`, settled: true };
  }
  let status: number | null;
  try {
    status = await deps.push(tk.groupId, messages, `case:${a.tid}`);
  } catch {
    status = null;
  }
  if (!sentOk(status)) {
    await closeManual(a.tid, { ...tk, prep: { ...p, groupPushes: p.groupPushes + 1 } }, p.rev, deps, kv);
    return { text: msgGsCaseSendFailed(no, status === null, plain), code: `case-request failed ${receiptOf(no)}`, settled: true };
  }
  const next: GsTicket = { ...tk, state: "waiting-cases", prep: { ...p, deadline, requestedAt: now, groupPushes: p.groupPushes + 1 } };
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
  revise(lines: string[], text: string, kind: GsPrepKind): Promise<string[] | null>;
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
  await quiet(() => kv.delIfToken(key, mark!.token as string), deps, "fix clear-failed");
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
  let lines: string[] | null = null;
  try {
    lines = await deps.revise(p.lines, text, p.kind);
  } catch {
    lines = null;
  }
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
