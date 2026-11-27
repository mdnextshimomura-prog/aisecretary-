/**
 * 案件の自動登録（計画 docs/superpowers/plans/2026-11-27-group-satei-auto-deal.md の A2・A3）：
 * 「ぴったり合う」の判定と、物件名・案件名・フォルダ名の作り方。通信はしない。
 * 流れ（登録・見回り）は下の gsAutoDeal・sweepGsAuto。動くのは groupSateiAutoDealOn のときだけ。
 * ログ・KV に物件名・所在・フォルダ名・案件名・userId は出さない（符号・受付番号 G7・案件番号 D231・回数だけ）。
 */
import {
  GS_AUTO_SET, GS_AUTO_STALE_MS, GS_AUTO_TRIES, GS_PREP_KINDS, GS_SWEEP_BUDGET_MS, GS_TICKET_TTL, asTicket, groupSateiAutoDealOn, gsDecKey, gsOpenKey, gsTicketKey, receiptOf,
  type GsAuto, type GsEnv, type GsPrepKind, type GsRead, type GsTicket,
} from "./group-satei-data";
import {
  gsBuildingOf, msgGsAutoAsk, msgGsAutoDup, msgGsAutoFailed, msgGsAutoMatched, msgGsAutoRegistered, msgGsAutoRegisteredHead, msgGsAutoStopped, msgGsPrepStopped,
} from "./group-satei-case";
import { gsSateiNextCard, msgGsAlready, msgGsKindSatei, MSG_GS_BUSY } from "./group-satei-card";
import type { GsAutoDealInput, GsAutoDealResult, GsAutoPropertyInput } from "./group-satei-auto-notion";
import type { GsOutcome } from "./group-satei-actions";
import { normNotionId, type SateiDeal } from "./satei-deal";
import { sateiNotifyTarget } from "./satei-data";
import { gsOutboxAdd, type GsObKv } from "./group-satei-outbox";
import { normalizeProperty } from "./property";
import { candidateDeals, dealKeys, type DealRef } from "./task-record";

/** 受付票ごとの印（gsatei:dec:<tid> の値・Notion の備考の「票 ab12cd34」）に使う tid の頭8字 */
export const gsAutoTid8 = (tid: string) => tid.slice(0, 8);
export const gsAutoMark = (tid: string) => `auto:${gsAutoTid8(tid)}`;
/** Notion の備考に入れる印（作る前にこれで探す＝やり直しで増やさない） */
export const gsAutoNoteMark = (tid: string) => `票 ${gsAutoTid8(tid)}`;

export type GsAutoMatch =
  | { kind: "none" }
  | { kind: "one"; deal: DealRef }
  | { kind: "ask"; reason: "exact2" | "partial" | "buy" | "no-read" | "kind" | "no-key" };

const isPrepKind = (k: unknown): k is GsPrepKind => GS_PREP_KINDS.includes(k as GsPrepKind);

/** 照合の鍵：物件名・建物名（号室を落としたもの）・所在（重なりは1つに） */
export function gsAutoKeys(read: GsRead | null): string[] {
  if (!read) return [];
  const keys = [read.propertyName, gsBuildingOf(read), read.address].map((s) => normalizeProperty(s ?? "")).filter(Boolean);
  return keys.filter((k, i) => keys.indexOf(k) === i);
}

/**
 * 進行中の案件（完了・失注以外）に照らす（A2）。
 * none＝完全一致も部分一致も無い → 自動登録へ／one＝完全一致がちょうど1件（【買】でない）→ その案件で進める／
 * ask＝決められない（完全一致が2件以上・部分一致だけ・【買】の案件・読み取りや鍵が無い）→ 今のカード
 */
export function gsAutoMatch(read: GsRead | null, deals: DealRef[]): GsAutoMatch {
  if (!read) return { kind: "ask", reason: "no-read" };
  if (!isPrepKind(read.kind)) return { kind: "ask", reason: "kind" };
  const keys = gsAutoKeys(read);
  if (keys.length === 0) return { kind: "ask", reason: "no-key" };
  const exact = deals.filter((d) => dealKeys(d.name).some((k) => keys.includes(k)));
  if (exact.length >= 2) return { kind: "ask", reason: "exact2" };
  if (exact.length === 1) {
    return (exact[0].phase ?? "").startsWith("【買】") ? { kind: "ask", reason: "buy" } : { kind: "one", deal: exact[0] };
  }
  const partial = keys.some((k) => candidateDeals(k, deals, deals.length + 1).length > 0);
  return partial ? { kind: "ask", reason: "partial" } : { kind: "none" };
}

const cutCp = (s: string, max: number) => Array.from(s).slice(0, max).join("");
/** NFKC・改行と制御文字を空白に・空白の連続を1つに・前後の空白を落とす */
const tidy = (s: string) => s.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

export const GS_PROP_TITLE_MAX = 60;
export const GS_DEAL_NAME_MAX = 100;
export const GS_FOLDER_NAME_MAX = 80;

/**
 * CRM_物件 の物件名（A3）。マンション：読み取りの物件名（マンション名と号室）、無ければ「<所在> マンション」。
 * 戸建・土地：物件名があればそれ、無ければ「<所在> 戸建」「<所在> 土地」。60字（コードポイント）まで。作れなければ null
 */
export function gsPropTitle(read: GsRead | null): string | null {
  if (!read || !isPrepKind(read.kind)) return null;
  const name = tidy(read.propertyName ?? "");
  const addr = tidy(read.address ?? "");
  const raw = name || (addr ? `${addr} ${read.kind}` : "");
  const out = cutCp(raw, GS_PROP_TITLE_MAX).trim();
  return out || null;
}

/** CRM_案件 の案件名：`査定｜顧客未定｜<物件名>`（crm.ts の「対応内容｜氏名｜物件」と同じ並び。100字まで） */
export const gsDealName = (propTitle: string): string => cutCp(`査定｜顧客未定｜${propTitle}`, GS_DEAL_NAME_MAX).trim();

/** 案件番号の表し方（DEAL-0231）。ログは D231 */
export const gsDealLabel = (dealNo: number): string => `DEAL-${String(dealNo).padStart(4, "0")}`;
export const gsDealCode = (dealNo: number): string => `D${dealNo}`;

/** portal の検査（計画 B1）と同じ形 */
const FOLDER_NAME_RE = /^DEAL-[0-9]{4,6}_売却_顧客未定_.+$/;

/**
 * 案件フォルダの名前（A3）：`DEAL-0231_売却_顧客未定_<物件名>`。P3 と同じ sanitize（/\:*?"<>| → _、前後の空白を落とす、_ の連続を1つに）
 * → 80字（コードポイント）で切る。「顧客未定」に「様」は付けない。作れなければ null
 */
export function gsDealFolderName(dealNo: number, propTitle: string): string | null {
  if (!Number.isInteger(dealNo) || dealNo <= 0 || dealNo > 999_999) return null;
  const prop = tidy(propTitle);
  if (!prop) return null;
  const sanitized = `${gsDealLabel(dealNo)}_売却_顧客未定_${prop}`.replace(/[/\\:*?"<>|]/g, "_").trim().replace(/_+/g, "_");
  const name = cutCp(sanitized, GS_FOLDER_NAME_MAX).trim();
  return FOLDER_NAME_RE.test(name) ? name : null;
}

/** Notion の口（本物は group-satei-auto-notion.ts。テストは差し替え）。無ければ自動登録しない */
export interface GsAutoDealDeps {
  findOrCreateProperty(p: GsAutoPropertyInput): Promise<{ id: string }>;
  findOrCreateDeal(p: GsAutoDealInput): Promise<GsAutoDealResult>;
  /** 作った直後に案件番号が読めなかったとき、1秒待って1回だけ読み直す */
  readDealNo(dealId: string): Promise<number | null>;
  /** CRM_物件 の物件名（フォルダ名を作る） */
  propTitle(propertyId: string): Promise<string | null>;
  sleep?(ms: number): Promise<void>;
}

type AutoKv = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ex: number): Promise<void>;
  setNx(key: string, value: unknown, ex: number): Promise<boolean>;
  sadd(key: string, member: string): Promise<void>;
  srem(key: string, member: string): Promise<void>;
  del(key: string): Promise<void>;
};

export interface GsAutoRunDeps {
  env?: GsEnv;
  autoDeal: GsAutoDealDeps;
  loadDeals(): Promise<DealRef[]>;
  readDeal(dealId: string): Promise<{ deal: SateiDeal; kind: string | null } | null>;
  now?(): number;
  log(line: string): void;
}

/** group-satei-actions.ts が渡す続き（actions → auto の向きだけで読み込むため、関数で受ける） */
export interface GsAutoHooks {
  /** ぴったり合った既存の案件で、［案件を選ぶ］と同じ道を進める。案件が読めなければ null */
  existing(dealId: string, tk: GsTicket): Promise<GsOutcome | null>;
  /**
   * 登録した案件で、足りない項目を聞く（noAsk でなければ）→ 準備を頼む。held＝いま持っている印（auto:<tid8>）。
   * resume＝落ちた票の続き（印がもう prep: に書き換わっていても進める）。null＝準備の口が無い
   */
  cont(tk: GsTicket, got: { deal: SateiDeal; kind: string | null }, kind: GsPrepKind, held: string, o: { noAsk: boolean; resume: boolean }): Promise<GsOutcome | null>;
}

const NOTION_ID_RE = /^[0-9a-f]{32}$/;
const remarkOf = (no: number, tid: string) => `グループ査定 受付 ${receiptOf(no)} から自動登録（${gsAutoNoteMark(tid)}）`;

/** 決められないとき：今のカード（［一覧から選ぶ］［案件がまだ無い］）の文の頭に1行足す（M3） */
function askCard(tid: string, tk: GsTicket, head: string, code: string): GsOutcome {
  return { text: `${head}\n${msgGsKindSatei(tk.no)}`, code, settled: true, card: gsSateiNextCard(tid, tk.ver, tk.no) };
}

/**
 * ［査定］（mode match）と、査定の票の［案件がまだ無い］（mode force＝照合を飛ばす。裁定 R1）。
 * null＝自動では進めない（呼ぶ側は今の返事をそのまま返す）。呼ぶ側で groupSateiAutoDealOn を確かめる
 */
export async function gsAutoDeal(
  a: { tid: string },
  tk: GsTicket,
  deps: GsAutoRunDeps,
  kv: AutoKv,
  hooks: GsAutoHooks,
  mode: "match" | "force",
): Promise<GsOutcome | null> {
  const R = receiptOf(tk.no);
  const read = tk.read;
  if (tk.state !== "asking" || !read || !isPrepKind(read.kind)) return null;
  if (mode === "match") {
    let deals: DealRef[];
    try {
      deals = await deps.loadDeals();
    } catch {
      deps.log(`[group-satei] auto card ${R} deals-failed`);
      return null;
    }
    const m = gsAutoMatch(read, deals);
    if (m.kind === "ask") {
      deps.log(`[group-satei] auto card ${R} ${m.reason}`);
      // 読み取り・鍵が無いのは「複数ある」ではないので、今の返事のまま
      return m.reason === "exact2" || m.reason === "partial" || m.reason === "buy" ? askCard(a.tid, tk, msgGsAutoAsk(tk.no), `auto card ${R} ${m.reason}`) : null;
    }
    if (m.kind === "one") {
      const o = await hooks.existing(normNotionId(m.deal.id), tk);
      if (!o) {
        deps.log(`[group-satei] auto card ${R} read-failed`);
        return null;
      }
      deps.log(`[group-satei] auto matched ${R}`);
      // Notion には何も書かない。返事の頭に M1
      return { ...o, text: `${msgGsAutoMatched(tk.no, m.deal.name)}\n${o.text}` };
    }
  }
  if (!gsPropTitle(read)) {
    deps.log(`[group-satei] auto card ${R} no-title`);
    return null;
  }
  return gsAutoRun(a.tid, tk, deps, kv, hooks, false);
}

/**
 * 登録の本体：印 → 物件 → 案件 → （足りない項目を聞く）→ 準備。resume＝毎分の見回りが落ちた票を続けるとき（印はもう持っている。返事はしない）。
 * 途中の段は受付票の auto に ID だけ残す（押し直し・見回りは続きから。Notion の側でも「票の印」で探すので増えない）
 */
export async function gsAutoRun(tid: string, tk: GsTicket, deps: GsAutoRunDeps, kv: AutoKv, hooks: GsAutoHooks, resume: boolean): Promise<GsOutcome> {
  const no = tk.no;
  const R = receiptOf(no);
  const mark = gsAutoMark(tid);
  const now = () => (deps.now ?? Date.now)();
  const ad = deps.autoDeal;
  const read = tk.read as GsRead;
  const kind = read.kind as GsPrepKind;
  const title = gsPropTitle(read) as string;
  const quiet = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch {
      deps.log(`[group-satei] auto save-failed ${R}`);
    }
  };
  if (!resume && !(await kv.setNx(gsDecKey(tid), mark, GS_TICKET_TTL))) return { text: msgGsAlready(no), code: "already", settled: true };
  // 前の回に作れた分の ID は使い回す（押し直しは続きから）
  const prev = tk.auto;
  const ids = { ...(prev?.propId ? { propId: prev.propId } : {}), ...(prev?.dealId ? { dealId: prev.dealId } : {}), ...(prev?.dealNo ? { dealNo: prev.dealNo } : {}) };
  const stepOf = (x: { propId?: string; dealId?: string; dealNo?: number }): GsAuto["step"] => (x.dealId && x.dealNo ? "prep" : x.propId ? "deal" : "prop");
  let auto: GsAuto = resume && prev
    ? { ...prev, step: stepOf(ids), at: now() }
    : { ...ids, step: stepOf(ids), at: now(), tries: (prev && prev.step !== "done" && prev.step !== "gave-up" ? prev.tries : 0) + 1 };
  let cur: GsTicket = { ...tk, auto };
  const saveAuto = async (next: GsAuto) => {
    auto = next;
    cur = { ...cur, auto };
    await kv.set(gsTicketKey(tid), cur, GS_TICKET_TTL);
  };
  try {
    await kv.set(gsTicketKey(tid), cur, GS_TICKET_TTL);
    await kv.sadd(GS_AUTO_SET, tid);
  } catch {
    if (!resume) await quiet(() => kv.del(gsDecKey(tid)));
    return { text: MSG_GS_BUSY, code: "kv-failed", settled: false };
  }
  /** その場の失敗（M8）：印を外す。auto の ID は残す。3回目は M7。見回りの続きでは印も集合もそのまま（次の回にもう一度） */
  const fail = async (why: string): Promise<GsOutcome> => {
    deps.log(`[group-satei] auto failed ${R} ${why}`);
    if (resume) return { text: "", code: `auto retry ${R} ${why}`, settled: true };
    const gaveUp = auto.tries >= GS_AUTO_TRIES;
    await quiet(() => kv.set(gsTicketKey(tid), { ...cur, auto: { ...auto, ...(gaveUp ? { step: "gave-up" as const } : {}), at: now() } }, GS_TICKET_TTL));
    await quiet(() => kv.srem(GS_AUTO_SET, tid));
    await quiet(() => kv.del(gsDecKey(tid)));
    if (gaveUp) deps.log(`[group-satei] auto gave-up ${R}`);
    return { text: gaveUp ? msgGsAutoStopped(no, auto.dealNo) : msgGsAutoFailed(no), code: `auto failed ${R} ${why}`, settled: true };
  };
  try {
    if (!auto.propId) {
      let propId: string;
      try {
        propId = normNotionId((await ad.findOrCreateProperty({
          title, kind, address: read.address ?? null, landArea: read.facts?.landArea ?? null, buildingArea: read.facts?.buildingArea ?? null,
          remark: remarkOf(no, tid), mark: gsAutoNoteMark(tid),
        })).id);
      } catch {
        return fail("notion-prop");
      }
      if (!NOTION_ID_RE.test(propId)) return fail("notion-prop");
      await saveAuto({ ...auto, propId, step: "deal", at: now() });
    }
    if (!auto.dealId || !auto.dealNo) {
      let r: GsAutoDealResult;
      try {
        r = await ad.findOrCreateDeal({ name: gsDealName(title), propTitle: title, propertyId: auto.propId as string, remark: remarkOf(no, tid), mark: gsAutoNoteMark(tid) });
      } catch {
        return fail("notion-deal");
      }
      if (r.kind === "dup") {
        // 作る直前に同じ物件の進行中の案件が見つかった：作らずに今のカードへ（印を外し、auto を消す）
        deps.log(`[group-satei] auto card ${R} fresh-dup`);
        const { auto: _a, ...rest } = cur;
        void _a;
        await quiet(() => kv.set(gsTicketKey(tid), rest, GS_TICKET_TTL));
        await quiet(() => kv.srem(GS_AUTO_SET, tid));
        await quiet(() => kv.del(gsDecKey(tid)));
        return askCard(tid, tk, msgGsAutoDup(no), `auto card ${R} fresh-dup`);
      }
      const dealId = normNotionId(r.id);
      if (!NOTION_ID_RE.test(dealId)) return fail("notion-deal");
      await saveAuto({ ...auto, dealId, at: now() });
      let dealNo = r.dealNo;
      if (dealNo === null) {
        await (ad.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms))))(1000);
        try {
          dealNo = await ad.readDealNo(dealId);
        } catch {
          dealNo = null;
        }
      }
      if (typeof dealNo !== "number" || !Number.isInteger(dealNo) || dealNo <= 0 || dealNo > 999_999) return fail("id");
      await saveAuto({ ...auto, dealNo, step: "prep", at: now() });
      deps.log(`[group-satei] auto registered ${R} ${gsDealCode(dealNo)}`);
    }
    const dealNo = auto.dealNo as number;
    let got: { deal: SateiDeal; kind: string | null } | null;
    try {
      got = await deps.readDeal(auto.dealId as string);
    } catch {
      got = null;
    }
    if (!got || got.deal.gone) return fail("notion-read");
    const o = await hooks.cont(cur, got, isPrepKind(got.kind) ? got.kind : kind, mark, { noAsk: resume, resume });
    if (resume) return o ?? { text: "", code: `auto retry ${R} no-portal`, settled: true };
    await quiet(() => kv.srem(GS_AUTO_SET, tid));
    if (!o) {
      // 準備の口が無い：印を外して、止めていると返す（案件は残る。押し直せる）
      await quiet(() => kv.del(gsDecKey(tid)));
      return { text: `${msgGsAutoRegisteredHead(dealNo)}${msgGsPrepStopped(no)}`, code: `prep stopped ${R}`, settled: true };
    }
    if (o.code.startsWith("prep sent")) return { ...o, text: msgGsAutoRegistered(no, dealNo) };
    if (o.code.startsWith("info-asked")) return { ...o, text: `${msgGsAutoRegistered(no, dealNo)}\n${o.text}` };
    return o;
  } catch {
    return fail("kv");
  }
}

export interface GsAutoSweepDeps extends GsAutoRunDeps {
  kv: (AutoKv & GsObKv) | null;
  /** 続きを進めるための続き（group-satei-actions.ts の autoHooks。userId＝準備の依頼者として portal に渡す人） */
  hooks(tid: string, userId: string): GsAutoHooks;
  push(to: string, messages: unknown[], key: string): Promise<number | null>;
  now(): number;
  startedAt?: number;
}

/** 続きに要る残り（Notion の数回＋portal の受付） */
const AUTO_SWEEP_MIN_MS = 25_000;
const sentOk = (status: number | null) => status !== null && ((status >= 200 && status < 300) || status === 409);

/**
 * 毎分の見回り（cloud-tick。段2b-2 の見回りの前）：登録の途中（step が prop・deal・prep）で落ちた票を、auto.at から3分たったら同じ段から続ける。
 * 1回に1件・予算の残りが25秒以上のときだけ。「印で探してから作る」ので増えない。3回でやめて下村さんへ1通（M7）、印を外して asking に戻す。
 * スイッチ off・Notion の口が無ければ KV も読まない
 */
export async function sweepGsAuto(deps: GsAutoSweepDeps): Promise<void> {
  const env = deps.env ?? process.env;
  if (!groupSateiAutoDealOn(env) || !deps.kv || !deps.autoDeal) return;
  const kv = deps.kv;
  const start = deps.startedAt ?? deps.now();
  try {
    const tids = (await kv.smembers(GS_AUTO_SET)).filter((x): x is string => typeof x === "string");
    for (const tid of tids) {
      const tk = asTicket(await kv.get(gsTicketKey(tid)));
      const auto = tk?.auto;
      if (!tk || !auto || tk.state !== "asking" || !["prop", "deal", "prep"].includes(auto.step)) {
        await kv.srem(GS_AUTO_SET, tid);
        continue;
      }
      // 登録の流れが印を持っている票だけ（その場の失敗で印を外した票は、押し直しを待つ）
      const dec = await kv.get(gsDecKey(tid));
      if (dec !== gsAutoMark(tid) && !(auto.dealId && dec === `prep:${auto.dealId}`)) {
        await kv.srem(GS_AUTO_SET, tid);
        continue;
      }
      if (deps.now() - auto.at < GS_AUTO_STALE_MS) continue;
      if (deps.now() - start > GS_SWEEP_BUDGET_MS - AUTO_SWEEP_MIN_MS) {
        deps.log("[group-satei] auto sweep budget");
        return;
      }
      const R = receiptOf(tk.no);
      const to = sateiNotifyTarget(env);
      if (auto.tries >= GS_AUTO_TRIES || !to) {
        await gaveUp(tid, tk, to, deps, kv);
        return;
      }
      const next: GsTicket = { ...tk, auto: { ...auto, tries: auto.tries + 1, at: deps.now() } };
      await kv.set(gsTicketKey(tid), next, GS_TICKET_TTL);
      deps.log(`[group-satei] auto resumed ${R}`);
      const o = await gsAutoRun(tid, next, deps, kv, deps.hooks(tid, to), true);
      // 準備まで進めた（集合からは準備の中で外れる）／その回はだめ（次の回にもう一度）／それ以外は続けられない
      if (o.code.startsWith("prep sent") || o.code.startsWith("prep unknown") || o.code.startsWith("auto retry")) return;
      await gaveUp(tid, tk, to, deps, kv);
      return;
    }
  } catch {
    deps.log("[group-satei] auto sweep skip:exception");
  }
}

/** 続きをあきらめる：受付票を asking に戻し（仮の決定なし）、印を外し、下村さんへ1通（M7。送れなければ控えへ） */
async function gaveUp(tid: string, tk: GsTicket, to: string | null, deps: GsAutoSweepDeps, kv: AutoKv & GsObKv): Promise<void> {
  const R = receiptOf(tk.no);
  const fresh = asTicket(await kv.get(gsTicketKey(tid))) ?? tk;
  if (fresh.state !== "asking") {
    await kv.srem(GS_AUTO_SET, tid);
    return;
  }
  const base = fresh.auto ?? tk.auto!;
  const { provisional: _p, ...rest } = fresh;
  void _p;
  const next: GsTicket = { ...rest, state: "asking", auto: { ...base, step: "gave-up", at: deps.now() } };
  await kv.set(gsTicketKey(tid), next, GS_TICKET_TTL);
  await kv.sadd(gsOpenKey(next.groupId), tid);
  await kv.srem(GS_AUTO_SET, tid);
  await kv.del(gsDecKey(tid));
  deps.log(`[group-satei] auto gave-up ${R}`);
  if (!to) return;
  const st = await deps.push(to, [{ type: "text", text: msgGsAutoStopped(tk.no, next.auto?.dealNo) }], `auto-fail:${tid}`).catch(() => null);
  if (!sentOk(st)) {
    deps.log(`[group-satei] auto gave-up ${R} push-failed`);
    await gsOutboxAdd(kv, "auto-fail", tid, deps.now(), deps.log, R);
  }
}
