/**
 * 段2d（計画 docs/superpowers/plans/2026-11-26-group-satei-2d.md）：準備の開始・［いいよ］［直す］・直しの1通・見回り・事例の PDF の控え。
 * portal・LINE・Claude は deps で受ける（本物は group-satei-wire.ts）。例外は投げない。ログは符号と受付番号だけ。
 */
import {
  GS_STAGE2_SET, GS_TICKET_TTL, gsDecKey, gsOpenKey, gsTicketKey, receiptOf,
  type GsPrepKind, type GsTicket,
} from "./group-satei-data";
import type { GsActionDeps, GsOutcome } from "./group-satei-actions";
import type { GsKv } from "./group-satei-open";
import { MSG_GS_NO_FOLDER, msgGsAlready } from "./group-satei-card";
import { gsBuildingOf, msgGsPrepRejected, msgGsPrepStarted, msgGsPrepStopped, msgGsPrepUnknown } from "./group-satei-case";
import { normNotionId, type SateiDeal } from "./satei-deal";
import { MSG_SATEI_DEAL_NOT_FOUND } from "./satei-text";

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
