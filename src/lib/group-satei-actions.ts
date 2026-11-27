/**
 * 普通のグループの査定依頼：カードのボタン（gs・gl・gm・gn）の処理と、種別での分岐（設計 8.3〜8.4）。
 * 順番：GROUP_SATEI off →「止めています」／TASK_SATEI_USER_IDS に無い →「下村さんだけ」／受付票が無い →「期限切れ」
 * → 版違い →「新しいカード」→ gl は一覧だけ（決めない）→ pb:<webhookEventId> の予約 → 決める（受付票ごとに最初の1回。gsatei:dec）。
 * 例外は投げない。ログは符号・受付番号・J番号だけ。
 */
import { randomUUID } from "node:crypto";
import {
  GS_INFO_DEC, GS_INFO_GO_MS, GS_INFO_GO_TTL, GS_INFO_SET, GS_INFO_TTL, gsFixKey, gsInfoGoKey, gsInfoKey, gsInfoTok,
  GS_TICKET_TTL, groupSateiActive, groupSateiOn, groupSateiPrepOn, groupSateiStage2On, gsDecKey, gsOpenKey, gsReqLabel, gsTicketKey,
  receiptOf, asTicket,
  type GsAction, type GsEnv, type GsPrepKind, type GsTicket,
} from "./group-satei-data";
import type { GsPrepPortal } from "./group-satei-prep-portal";
import { gsSateiIntake } from "./group-satei-intake";
import { answerGsProposal, answerGsRemind, startGsPrep } from "./group-satei-propose";
import type { GsKv } from "./group-satei-open";
import {
  gsListCard, gsSateiNextCard, msgGsKindRecorded, msgGsKindSatei, MSG_GS_BUSY, MSG_GS_LIST_END, MSG_GS_DEALS_FAILED, MSG_GS_EXPIRED, MSG_GS_FORBIDDEN, MSG_GS_NO_FOLDER, MSG_GS_NOT_ACTIVE,
  MSG_GS_PAUSED, MSG_GS_STALE, MSG_GS_UNKNOWN, msgGsAlready, msgGsDismissed, msgGsKindMismatch, msgGsManual, msgGsNoDeal,
} from "./group-satei-card";
import { isSateiUser, sateiActive, sateiReasonKey } from "./satei-data";
import { gsInfoAskText, gsInfoKeys, msgGsInfoDone } from "./group-satei-facts";
import { gsInfoCard } from "./group-satei-card";
import { judgeSateiDeal, normNotionId, SATEI_KIND, type SateiDeal } from "./satei-deal";
import { SATEI_CODE_AWAITING_REASON, type SateiCall, type SateiIntakeOk, type SateiIntakeReq } from "./satei-portal";
import { MSG_SATEI_AWAITING_REASON, MSG_SATEI_DEAL_NOT_FOUND, MSG_SATEI_FAILED, msgSateiAccepted, msgSateiInProgress } from "./satei-text";
import type { DealRef } from "./task-record";
import type { FlexMessage } from "./task-card";

export interface GsActionDeps {
  env?: GsEnv;
  kv: (GsKv & { del(key: string): Promise<void>; srem(key: string, member: string): Promise<void> }) | null;
  dealsDbId: string | null;
  readDeal(dealId: string): Promise<{ deal: SateiDeal; kind: string | null } | null>;
  intake(req: SateiIntakeReq): Promise<SateiCall<SateiIntakeOk>>;
  loadDeals(): Promise<DealRef[]>;
  reserve(key: string): Promise<{ proceed: boolean }>;
  complete(key: string): Promise<void>;
  reply(replyToken: string, text: string, card?: FlexMessage): Promise<unknown>;
  log(line: string): void;
  /** 段2d：portal の準備の依頼箱（無ければ 2d は動かない＝2a のまま） */
  prep?: GsPrepPortal | null;
  /** 段2d：retry key つきの push（HTTP の状態番号。結果不明は null）。key は uuidv5 にする前の名前 */
  push?(to: string, messages: unknown[], key: string): Promise<number | null>;
  /** 段2e：push と同じで、送れた messageId も返す（依頼カードの ID を受付票に残す）。無ければ push を使う */
  pushIds?(to: string, messages: unknown[], key: string): Promise<{ status: number | null; ids: string[] }>;
  /** 山口さんの候補が2つ以上のとき、依頼のグループにいるか（1件3秒。in/out/unknown）。無ければ確かめられない扱い */
  groupMember?(groupId: string, userId: string): Promise<"in" | "out" | "unknown">;
  now?(): number;
}

/** 準備へ進める所（proceedPick・startGsPrep・段2b-2 の再開）が使う部品だけ */
export type GsPickDeps = Pick<GsActionDeps, "env" | "dealsDbId" | "readDeal" | "intake" | "prep" | "now" | "log">;

export interface GsOutcome {
  text: string;
  code: string;
  settled: boolean;
  card?: FlexMessage;
}
type Outcome = GsOutcome;

type Kv = NonNullable<GsActionDeps["kv"]>;
/** 段2b-2：印を token つきで消す（Upstash の EVAL）。無い作りでは読んで比べてから消す */
type InfoKv = Kv & { delIfToken?(key: string, token: string): Promise<boolean> };

/** 決めたあとの KV の失敗は返事を変えない。ログは符号だけ */
async function quietKv(f: () => Promise<void>, deps: { log(l: string): void }): Promise<void> {
  try {
    await f();
  } catch {
    deps.log("[group-satei] gs save-failed");
  }
}

async function save(kv: Kv, tid: string, tk: GsTicket): Promise<void> {
  await kv.set(gsTicketKey(tid), tk, GS_TICKET_TTL);
  if (tk.state !== "asking" && !tk.provisional) await kv.srem(gsOpenKey(tk.groupId), tid);
}

const MISMATCH_KINDS = ["マンション", "戸建", "土地"];
/** 段2：案件を選んだ受付票に「査定」の印を残す（off のあいだは何も足さない＝段1と同じ票） */
const sateiKind = (env: GsEnv): Partial<GsTicket> => (groupSateiStage2On(env) ? { requestKind: "satei" } : {});
/** 印（gsatei:dec）の値の頭。portal の受付の結果が分からないとき */
const UNKNOWN_DEC = "unknown:";

async function pick(raw: Extract<GsAction, { op: "gs" }>, tk: GsTicket, userId: string, deps: GsActionDeps, kv: Kv): Promise<Outcome> {
  // PAGE_ID_RE はハイフン入り・大文字も通すので、比べる前・保存する前にそろえる
  const a = { ...raw, dealId: normNotionId(raw.dealId) };
  const no = tk.no;
  if (!deps.dealsDbId) return { text: MSG_SATEI_DEAL_NOT_FOUND, code: "config-missing", settled: true };
  // 一覧に出した案件だけ（進行中）
  let active: DealRef[];
  try {
    active = await deps.loadDeals();
  } catch {
    return { text: MSG_GS_DEALS_FAILED, code: "deals-failed", settled: false };
  }
  if (!active.some((d) => normNotionId(d.id) === a.dealId)) return { text: MSG_GS_NOT_ACTIVE, code: "not-active", settled: true };
  let got: { deal: SateiDeal; kind: string | null } | null;
  try {
    got = await deps.readDeal(a.dealId);
  } catch {
    return { text: MSG_SATEI_DEAL_NOT_FOUND, code: "read-failed", settled: false };
  }
  if (!got || got.deal.gone) return { text: MSG_SATEI_DEAL_NOT_FOUND, code: "not-found", settled: true };
  const kind = got.kind;
  const warn =
    tk.read && MISMATCH_KINDS.includes(tk.read.kind) && kind && MISMATCH_KINDS.includes(kind) && tk.read.kind !== kind
      ? `\n${msgGsKindMismatch(tk.read.kind)}`
      : "";
  const env = deps.env ?? process.env;
  // 段2b-2：準備へ渡す前に、資料から読めなかった項目を1回だけまとめて聞く（聞いたら、ここでは準備へ進まない）
  if (groupSateiPrepOn(env) && deps.prep && isPrepKind(kind)) {
    const asked = await maybeAskInfo(a, tk, got.deal, kind, userId, deps, kv);
    if (asked) return { ...asked, text: asked.text + warn };
  }
  return proceedPick(a, tk, got, userId, deps, kv, warn, null);
}

const isPrepKind = (k: string | null): k is GsPrepKind => k === "マンション" || k === "戸建" || k === "土地";

/**
 * 案件が決まった受付票を進める（段2d の準備、無ければ 2a の道）。fromInfo＝段2b-2 で聞いたあと（仮の印 info:<dealId> を持っている）。
 * 2a の道へ行くときは仮の印を外してから（2a の道は印を取り直す）
 */
async function proceedPick(
  a: { tid: string; dealId: string },
  tk: GsTicket,
  got: { deal: SateiDeal; kind: string | null },
  userId: string,
  deps: GsPickDeps,
  kv: Kv,
  warn: string,
  /** 段2b-2 で聞いたあと（仮の印 info:<dealId> を持っている）ならその回の token。それ以外は null */
  infoToken: string | null,
): Promise<Outcome> {
  const fromInfo = infoToken !== null;
  const no = tk.no;
  const kind = got.kind;
  const env = deps.env ?? process.env;
  // 段2d：案件が決まったら portal の準備へ（マンション・戸建・土地）。PREP_DISABLED なら下の 2a の道へ（計画 D6）
  if (groupSateiPrepOn(env) && deps.prep && isPrepKind(kind)) {
    const o = await startGsPrep(a, tk, got.deal, kind, userId, deps, kv, infoToken !== null ? { infoDec: `${GS_INFO_DEC}${a.dealId}`, infoToken } : undefined);
    if (o) return { ...o, text: o.text + warn };
  } else if (fromInfo) {
    await kv.del(gsDecKey(a.tid));
  }
  if (!deps.dealsDbId) return { text: MSG_SATEI_DEAL_NOT_FOUND, code: "config-missing", settled: true };
  if (kind === SATEI_KIND && !sateiActive(env)) {
    // TASK_SATEI off：portal へは進まない。印を取らず受付票も asking のまま（on に戻せば同じカードで押し直せる）
    return { text: msgGsManual(no, kind) + warn, code: "manual satei-off", settled: true };
  }
  if (kind === SATEI_KIND) {
    const j = judgeSateiDeal(got.deal, kind, deps.dealsDbId);
    if (!j.ok) {
      return j.reason === "no-folder"
        ? { text: MSG_GS_NO_FOLDER + warn, code: "no-folder", settled: true }
        : { text: MSG_SATEI_DEAL_NOT_FOUND, code: j.reason, settled: true };
    }
    if (!(await kv.setNx(gsDecKey(a.tid), `gs:${a.dealId}`, GS_TICKET_TTL))) return { text: msgGsAlready(no), code: "already", settled: true };
    const r: SateiCall<SateiIntakeOk> = await gsSateiIntake(a.tid, j.deal, userId, deps.intake);
    // ここから先の KV の失敗は返事を変えない（portal の結果のとおりに返す）。ログだけ
    const quiet = (f: () => Promise<void>) => quietKv(f, deps);
    if (r.kind === "ok") {
      const jobNo = r.value.no;
      await quiet(() => save(kv, a.tid, { ...tk, ...sateiKind(env), state: "started", provisional: false, dealId: a.dealId, jobNo }));
      const text = r.value.created ? msgSateiAccepted(jobNo) : msgSateiInProgress(jobNo);
      return { text: text + warn, code: `started ${receiptOf(no)} #J${jobNo}`, settled: true };
    }
    if (r.kind === "unknown") {
      // 結果不明は印の値で覚える（押し直しは portal を呼ばずに「確かめられませんでした」）
      await quiet(() => kv.set(gsDecKey(a.tid), `${UNKNOWN_DEC}${a.dealId}`, GS_TICKET_TTL));
      await quiet(() => save(kv, a.tid, { ...tk, ...sateiKind(env), state: "started", provisional: false, dealId: a.dealId, unknown: true }));
      return { text: MSG_GS_UNKNOWN, code: "unknown", settled: true };
    }
    await quiet(() => kv.del(gsDecKey(a.tid)));
    return r.code === SATEI_CODE_AWAITING_REASON
      ? { text: MSG_SATEI_AWAITING_REASON, code: "awaiting-reason", settled: true }
      : { text: MSG_SATEI_FAILED, code: "rejected", settled: true };
  }
  if (!(await kv.setNx(gsDecKey(a.tid), `gs:${a.dealId}`, GS_TICKET_TTL))) return { text: msgGsAlready(no), code: "already", settled: true };
  await quietKv(() => save(kv, a.tid, { ...tk, ...sateiKind(env), state: "manual", provisional: false, dealId: a.dealId }), deps);
  return { text: msgGsManual(no, kind) + warn, code: `manual ${kind === "戸建" ? "house" : kind === "土地" ? "land" : "unknown-kind"}`, settled: true };
}

/**
 * 段2b-2（I1・I2・I5）：足りない項目があれば、仮の印（gsatei:dec = info:<dealId>）を取り、受付票を asking-info にして聞く。
 * null＝聞かない（足りている・ほかの印がある・案件の形が準備へ進めない・KV に書けない）＝今どおり準備へ
 */
async function maybeAskInfo(
  a: { tid: string; dealId: string },
  tk: GsTicket,
  deal: SateiDeal,
  kind: GsPrepKind,
  userId: string,
  deps: GsActionDeps,
  kv: Kv,
): Promise<Outcome | null> {
  const no = tk.no;
  const keys = gsInfoKeys(kind, tk.read);
  if (keys.length === 0) return null;
  // 準備へ進めない案件（フォルダ無し等）は聞かずに、startGsPrep の今の返事へ
  if (!deps.dealsDbId || deal.gone || deal.parentDbId !== normNotionId(deps.dealsDbId) || !deal.folderId) return null;
  const token = randomUUID();
  // ほかの印（差し戻し理由・［直す］）があれば聞かない。答えを待つ印は SET NX で取る（同じ人の2票が同時でも上書きしない。点検 LOW-8）
  let busy: boolean;
  try {
    busy = Boolean(await kv.get(sateiReasonKey(userId))) || Boolean(await kv.get(gsFixKey(userId)));
    if (!busy) busy = !(await kv.setNx(gsInfoKey(userId), { tid: a.tid, token }, GS_INFO_TTL));
  } catch {
    busy = true;
  }
  if (busy) {
    deps.log(`[group-satei] info skip:busy ${receiptOf(no)}`);
    return null;
  }
  let decOk = false;
  try {
    decOk = await kv.setNx(gsDecKey(a.tid), `${GS_INFO_DEC}${a.dealId}`, GS_TICKET_TTL);
  } finally {
    if (!decOk) await quietKv(() => clearInfoMark(userId, token, kv), deps);
  }
  if (!decOk) return { text: msgGsAlready(no), code: "already", settled: true };
  const now = (deps.now ?? Date.now)();
  const next: GsTicket = {
    ...tk, state: "asking-info", provisional: false, dealId: a.dealId, requestKind: "satei",
    info: { by: userId, kind, keys, at: now, token },
  };
  try {
    await save(kv, a.tid, next);
    await kv.sadd(GS_INFO_SET, a.tid);
  } catch {
    // 聞けないときは今どおり準備へ（票を戻し、仮の印を外す）
    deps.log(`[group-satei] info ask-failed ${receiptOf(no)}`);
    await quietKv(async () => {
      await kv.set(gsTicketKey(a.tid), tk, GS_TICKET_TTL);
      if (tk.state === "asking" || tk.provisional) await kv.sadd(gsOpenKey(tk.groupId), a.tid);
      await kv.srem(GS_INFO_SET, a.tid);
      await clearInfoMark(userId, token, kv);
      await kv.del(gsDecKey(a.tid));
    }, deps);
    return null;
  }
  deps.log(`[group-satei] info asked ${receiptOf(no)} ${keys.length}`);
  return { text: gsInfoAskText(no, keys), code: `info-asked ${receiptOf(no)}`, settled: true, card: gsInfoCard(a.tid, tk.ver, no, token) };
}

/**
 * 段2b-2：この回の聞き方を進めるのは最初の1つだけ（［このまま進める］・答え・30分）。true＝自分が進める。
 * 値は {at}・期限3分。印が無いか3分より古ければ取り直せる（取ったあとに落ちた票を凍らせない。点検 MED-2）
 */
export async function gsClaimInfo(tid: string, token: string, kv: Kv, now: number): Promise<boolean> {
  const key = gsInfoGoKey(tid, token);
  if (await kv.setNx(key, { at: now }, GS_INFO_GO_TTL)) return true;
  const v = await kv.get(key);
  const at = v && typeof v === "object" ? (v as { at?: unknown }).at : undefined;
  if (typeof at === "number" && now - at < GS_INFO_GO_MS) return false;
  await kv.set(key, { at: now }, GS_INFO_GO_TTL);
  return true;
}

/** 段2b-2（点検 MED-1 (a)・LOW-9）：取り込まなかった答えのあと、進める権を返し、答えを待つ印を置き直す（新しい印があれば上書きしない） */
export async function gsReleaseInfo(tid: string, tk: GsTicket, kv: Kv, now: number): Promise<void> {
  const info = tk.info!;
  await kv.del(gsInfoGoKey(tid, info.token));
  const left = Math.ceil((info.at + GS_INFO_TTL * 1000 - now) / 1000);
  if (left > 0) await kv.setNx(gsInfoKey(info.by), { tid, token: info.token }, left);
}

/** 答えを待つ印を、この回の token のときだけ消す */
async function clearInfoMark(by: string, token: string, kv: InfoKv): Promise<void> {
  const key = gsInfoKey(by);
  if (kv.delIfToken) {
    await kv.delIfToken(key, token);
    return;
  }
  const v = await kv.get(key);
  if (v && typeof v === "object" && (v as { token?: unknown }).token === token) await kv.del(key);
}

/**
 * 段2b-2（I4）：asking-info の票を準備へ進める（gsClaimInfo で取ってから呼ぶ）。tk は足した facts を持つ票。
 * 進められなかった（案件が読めない・止めている等）ら、票を asking に戻し、仮の印を外す（同じカードで押し直せる）
 */
export async function gsResumeInfo(tid: string, tk: GsTicket, deps: GsPickDeps, kv: InfoKv): Promise<Outcome> {
  const info = tk.info!;
  const dealId = tk.dealId!;
  await quietKv(() => clearInfoMark(info.by, info.token, kv), deps);
  await quietKv(() => kv.srem(GS_INFO_SET, tid), deps);
  let got: { deal: SateiDeal; kind: string | null } | null = null;
  try {
    got = await deps.readDeal(dealId);
  } catch {
    got = null;
  }
  let o: Outcome;
  if (!got || got.deal.gone) o = { text: MSG_SATEI_DEAL_NOT_FOUND, code: got ? "not-found" : "read-failed", settled: true };
  else {
    try {
      o = await proceedPick({ tid, dealId }, tk, got, info.by, deps, kv, "", info.token);
    } catch {
      o = { text: MSG_GS_BUSY, code: "kv-failed", settled: true };
    }
  }
  // まだ asking-info のまま（準備へ進めなかった）なら戻す
  await quietKv(async () => {
    const fresh = asTicket(await kv.get(gsTicketKey(tid)));
    if (!fresh || fresh.state !== "asking-info" || fresh.info?.token !== info.token) return;
    const { info: _i, dealId: _d, ...rest } = fresh;
    void _i;
    void _d;
    await kv.set(gsTicketKey(tid), { ...rest, state: "asking" }, GS_TICKET_TTL);
    await kv.sadd(gsOpenKey(fresh.groupId), tid);
    const dec = await kv.get(gsDecKey(tid));
    if (typeof dec === "string" && dec.startsWith(GS_INFO_DEC)) await kv.del(gsDecKey(tid));
    deps.log(`[group-satei] info reverted ${receiptOf(tk.no)}`);
  }, deps);
  return o;
}

/** ［このまま進める］（gi） */
async function skipInfo(a: Extract<GsAction, { op: "gi" }>, tk: GsTicket, deps: GsActionDeps, kv: Kv): Promise<Outcome> {
  const no = tk.no;
  if (tk.state !== "asking-info" || !tk.info || !tk.dealId) return { text: msgGsInfoDone(no), code: "info-closed", settled: true };
  // 前の回（聞き直す前）のカードの［このまま進める］では進めない
  if (gsInfoTok(tk.info.token) !== a.tok) return { text: MSG_GS_STALE, code: "info-stale", settled: true };
  if (!(await gsClaimInfo(a.tid, tk.info.token, kv, (deps.now ?? Date.now)()))) return { text: msgGsInfoDone(no), code: "info-already", settled: true };
  deps.log(`[group-satei] info skipped ${receiptOf(no)}`);
  return gsResumeInfo(a.tid, tk, deps, kv);
}

/**
 * 段2：「何の依頼？」。［査定］は印（gsatei:dec）を取らない（取ると、このあとの案件選び gs が「選択済み」になる）。
 * ほかの7つは記録だけ：印を gk:<符号> で取り、受付票を manual にして閉じる（中身の自動化は別の設計）。
 */
async function chooseKind(a: Extract<GsAction, { op: "gk" }>, tk: GsTicket, deps: GsActionDeps, kv: Kv): Promise<Outcome> {
  const no = tk.no;
  if (a.code === "satei") {
    if (tk.state === "asking" && tk.requestKind !== "satei") {
      // 押した時点の控えで丸ごと書かない：書く直前に読み直し、まだ同じ版・asking・印なしのときだけ（読み直しの係の保存を消さない）
      await quietKv(async () => {
        const fresh = asTicket(await kv.get(gsTicketKey(a.tid)));
        if (!fresh || fresh.state !== "asking" || fresh.ver !== tk.ver || fresh.requestKind === "satei") return;
        if (await kv.get(gsDecKey(a.tid))) return;
        await save(kv, a.tid, { ...fresh, requestKind: "satei" });
      }, deps);
    }
    return { text: msgGsKindSatei(no), code: `kind satei ${receiptOf(no)}`, settled: true, card: gsSateiNextCard(a.tid, tk.ver, no) };
  }
  // ［案件がまだ無い］の仮の決定（manual・provisional）のあとは、7つで上書きしない（7日以内の選び直しを残す）
  if (tk.state !== "asking") return { text: msgGsAlready(no), code: "already", settled: true };
  if (!(await kv.setNx(gsDecKey(a.tid), `gk:${a.code}`, GS_TICKET_TTL))) return { text: msgGsAlready(no), code: "already", settled: true };
  await quietKv(() => save(kv, a.tid, { ...tk, state: "manual", provisional: false, requestKind: a.code }), deps);
  return { text: msgGsKindRecorded(no, gsReqLabel(a.code)), code: `kind ${a.code} ${receiptOf(no)}`, settled: true };
}

async function decide(a: Exclude<GsAction, { op: "gl" }>, tk: GsTicket, userId: string, deps: GsActionDeps, kv: Kv): Promise<Outcome> {
  // 段2d：案件はもう決まっている（印は prep:）。［いいよ］［直す］は印を見ずに、受付票の状態と版で決める
  if (a.op === "gy" || a.op === "gf") return answerGsProposal(a, tk, userId, deps, kv);
  // 段2b-2：［このまま進める］は仮の印（info:）を持ったまま、受付票の状態と token で決める
  if (a.op === "gi") return skipInfo(a, tk, deps, kv);
  // 催促はボタンで（2026-11-27）：［催促する］は受付票の状態だけで決める
  if (a.op === "gr") return answerGsRemind(a, tk, deps, kv);
  const dec = await kv.get(gsDecKey(a.tid));
  if (dec) {
    return typeof dec === "string" && dec.startsWith(UNKNOWN_DEC)
      ? { text: MSG_GS_UNKNOWN, code: "unknown-again", settled: true }
      : { text: msgGsAlready(tk.no), code: "already", settled: true };
  }
  if (a.op === "gk") return chooseKind(a, tk, deps, kv);
  if (a.op === "gs") return pick(a, tk, userId, deps, kv);
  if (a.op === "gm") {
    // 連打で7日を延ばさない
    if (tk.provisional) return { text: msgGsNoDeal(tk.no), code: "no-deal-again", settled: true };
    // 同時に押された gs が印を取っていたら上書きしない
    if (await kv.get(gsDecKey(a.tid))) return { text: msgGsAlready(tk.no), code: "already", settled: true };
    await save(kv, a.tid, { ...tk, state: "manual", provisional: true });
    return { text: msgGsNoDeal(tk.no), code: "no-deal", settled: true };
  }
  if (!(await kv.setNx(gsDecKey(a.tid), "gn", GS_TICKET_TTL))) return { text: msgGsAlready(tk.no), code: "already", settled: true };
  await quietKv(() => save(kv, a.tid, { ...tk, state: "dismissed", provisional: false }), deps);
  return { text: msgGsDismissed(tk.no), code: "dismissed", settled: true };
}

export async function handleGroupSateiPostback(
  action: GsAction,
  ev: { replyToken: string; webhookEventId?: string; source: { userId?: string } },
  deps: GsActionDeps,
): Promise<void> {
  const env = deps.env ?? process.env;
  const say = async (text: string, code: string, card?: FlexMessage) => {
    try {
      await deps.reply(ev.replyToken, text, card);
    } catch {
      deps.log(`[group-satei] reply-failed ${action.op} ${code}`);
    }
  };
  if (!groupSateiActive(env)) {
    deps.log(`[group-satei] ${action.op} paused`);
    return say(MSG_GS_PAUSED, "paused");
  }
  // 段2のボタン（gk）は GROUP_SATEI_STAGE2 off なら何もしない（on のあいだに出したカードを off のあとに押された）
  if (action.op === "gk" && !groupSateiStage2On(env)) {
    deps.log("[group-satei] gk paused stage2");
    return say(MSG_GS_PAUSED, "paused");
  }
  // 段2d のボタン（gy・gf）は 2d が off（山口さんの ID が無い・STAGE2 off）なら何もしない
  if ((action.op === "gy" || action.op === "gf" || action.op === "gi" || action.op === "gr") && !groupSateiPrepOn(env)) {
    deps.log(`[group-satei] ${action.op} paused prep`);
    return say(MSG_GS_PAUSED, "paused");
  }
  const userId = ev.source.userId;
  if (!userId || !isSateiUser(userId, env)) {
    deps.log(`[group-satei] ${action.op} forbidden`);
    return say(MSG_GS_FORBIDDEN, "forbidden");
  }
  const kv = deps.kv;
  if (!kv) {
    deps.log(`[group-satei] ${action.op} config-missing`);
    return say(MSG_GS_BUSY, "config-missing");
  }
  let tk: GsTicket | null;
  try {
    tk = asTicket(await kv.get(gsTicketKey(action.tid)));
  } catch {
    deps.log(`[group-satei] ${action.op} kv-failed`);
    return say(MSG_GS_BUSY, "kv-failed");
  }
  if (!tk) {
    deps.log(`[group-satei] ${action.op} expired`);
    return say(MSG_GS_EXPIRED, "expired");
  }
  if (!groupSateiOn(tk.groupId, env)) {
    deps.log(`[group-satei] ${action.op} paused group`);
    return say(MSG_GS_PAUSED, "paused");
  }
  if (tk.ver !== action.ver) {
    deps.log(`[group-satei] ${action.op} stale ${receiptOf(tk.no)}`);
    return say(MSG_GS_STALE, "stale");
  }
  if (action.op === "gl") {
    let deals: DealRef[];
    try {
      deals = await deps.loadDeals();
    } catch {
      deps.log("[group-satei] gl deals-failed");
      return say(MSG_GS_DEALS_FAILED, "deals-failed");
    }
    const card = gsListCard(action.tid, tk.ver, tk.no, deals, action.offset);
    deps.log(`[group-satei] gl shown ${receiptOf(tk.no)}`);
    return card ? say(`どの案件ですか（${receiptOf(tk.no)}）`, "shown", card) : say(MSG_GS_LIST_END, "empty");
  }
  const eventId = ev.webhookEventId;
  if (!eventId) {
    deps.log(`[group-satei] ${action.op} no-event-id`);
    return say(MSG_GS_BUSY, "no-event-id");
  }
  const rkey = `pb:${eventId}`;
  let claim: { proceed: boolean };
  try {
    claim = await deps.reserve(rkey);
  } catch {
    deps.log(`[group-satei] ${action.op} reserve-failed`);
    return say(MSG_GS_BUSY, "busy");
  }
  if (!claim.proceed) {
    deps.log(`[group-satei] ${action.op} duplicate`);
    return;
  }
  let settled = false;
  try {
    let r: Outcome;
    try {
      r = await decide(action, tk, userId, deps, kv);
    } catch {
      r = { text: MSG_GS_BUSY, code: "kv-failed", settled: false };
    }
    settled = r.settled;
    deps.log(`[group-satei] ${action.op} ${r.code}`);
    await say(r.text, r.code, r.card);
  } finally {
    if (settled) await deps.complete(rkey).catch(() => deps.log(`[group-satei] mark-failed ${action.op}`));
  }
}
