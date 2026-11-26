/**
 * 普通のグループの査定依頼：カードのボタン（gs・gl・gm・gn）の処理と、種別での分岐（設計 8.3〜8.4）。
 * 順番：GROUP_SATEI off →「止めています」／TASK_SATEI_USER_IDS に無い →「下村さんだけ」／受付票が無い →「期限切れ」
 * → 版違い →「新しいカード」→ gl は一覧だけ（決めない）→ pb:<webhookEventId> の予約 → 決める（受付票ごとに最初の1回。gsatei:dec）。
 * 例外は投げない。ログは符号・受付番号・J番号だけ。
 */
import {
  GS_TICKET_TTL, groupSateiActive, groupSateiOn, groupSateiStage2On, gsDecKey, gsEventId, gsOpenKey, gsReqLabel, gsTicketKey,
  receiptOf, asTicket,
  type GsAction, type GsEnv, type GsTicket,
} from "./group-satei-data";
import type { GsKv } from "./group-satei-open";
import {
  gsListCard, gsSateiNextCard, msgGsKindRecorded, msgGsKindSatei, MSG_GS_BUSY, MSG_GS_LIST_END, MSG_GS_DEALS_FAILED, MSG_GS_EXPIRED, MSG_GS_FORBIDDEN, MSG_GS_NO_FOLDER, MSG_GS_NOT_ACTIVE,
  MSG_GS_PAUSED, MSG_GS_STALE, MSG_GS_UNKNOWN, msgGsAlready, msgGsDismissed, msgGsKindMismatch, msgGsManual, msgGsNoDeal,
} from "./group-satei-card";
import { isSateiUser, sateiActive } from "./satei-data";
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
}

interface Outcome {
  text: string;
  code: string;
  settled: boolean;
  card?: FlexMessage;
}

type Kv = NonNullable<GsActionDeps["kv"]>;

/** 決めたあとの KV の失敗は返事を変えない。ログは符号だけ */
async function quietKv(f: () => Promise<void>, deps: GsActionDeps): Promise<void> {
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
    let r: SateiCall<SateiIntakeOk>;
    try {
      r = await deps.intake({ eventId: gsEventId(a.tid), dealId: j.deal.id, dealNo: j.deal.dealNo, folderId: j.deal.folderId, dealName: j.deal.name, requestedBy: userId });
    } catch {
      r = { kind: "unknown", reason: "exception" };
    }
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
