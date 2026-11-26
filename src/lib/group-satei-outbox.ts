/**
 * 段2f（計画 docs/superpowers/plans/2026-11-26-group-satei-2f.md の F3・F4・F5）：下村さんあての1回きりの知らせの控え（outbox）と送り直し。
 * - 控えには文を入れない。種類と受付票の ID（ambig は鍵の残り）だけを持ち、送るときに受付票から文を作り直す。
 * - 送り直しは元の知らせと同じ retry key（届いていたのに失敗に見えた分は LINE が重ねない。retry key は24時間有効）。
 * - 控えの集合 gsatei:outbox（要素 `<種類>:<id>`）と gsatei:ob:<種類>:<id> = {tries, nextAt, firstAt}（1日）。
 * - 見回り（sweepGsStage2 の最後）が1回に1件。だめなら tries+1・nextAt = now + 2分×(tries+1)。5回か firstAt から2時間でやめる。
 * - グループあての依頼カード・催促は対象にしない（グループへの送信は増やさない）。
 * 例外は投げない。ログは種類・受付番号・符号だけ。
 */
import { GS_SWEEP_BUDGET_MS, asTicket, gsTicketKey, receiptOf, type GsCasesNote } from "./group-satei-data";
import {
  msgGsCasesAmbig, msgGsCasesDraftUnknown, msgGsCasesFailed, msgGsCasesNoAuto, msgGsCasesNoStart, msgGsCasesSlow, msgGsCasesSomeFailed,
  msgGsCasesStarted, msgGsCasesUnsaved, msgGsPrepLate, msgGsRemindFailed, msgGsRemindMe, msgGsRemindUnknown,
} from "./group-satei-case";
import { gsDeadlineLabel } from "./group-satei-deadline";
import { msgGsInfoNotStarted } from "./group-satei-facts";

export type GsObKind = "prop-late" | "remind-note" | "cases" | "cases-late" | "ambig" | "info-to";
export const GS_OB_KINDS: readonly GsObKind[] = ["prop-late", "remind-note", "cases", "cases-late", "ambig", "info-to"];
export const GS_OUTBOX_SET = "gsatei:outbox";
export const gsObKey = (kind: GsObKind, id: string) => `gsatei:ob:${kind}:${id}`;
export const GS_OB_TTL = 24 * 60 * 60;
/** 送り直しの回数の上限（最初の失敗から 2+4+6+8+10 分＝約30分） */
export const GS_OB_TRIES = 5;
export const GS_OB_STEP_MS = 2 * 60 * 1000;
/** 最初の失敗からこれを過ぎたら送らない（知らせが古くなる） */
export const GS_OB_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** 見回りの予算（GS_SWEEP_BUDGET_MS）の残りがこれ以上あるときだけ送り直す */
export const GS_OB_MIN_LEFT_MS = 15_000;

export interface GsObEntry {
  tries: number;
  nextAt: number;
  firstAt: number;
}

export interface GsObKv {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ex: number): Promise<void>;
  setNx(key: string, value: unknown, ex: number): Promise<boolean>;
  sadd(key: string, member: string): Promise<void>;
  srem(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<unknown[]>;
  del(key: string): Promise<void>;
}

const TID_RE = /^[0-9a-f]{16}$/;
/** ambig の id は `<groupId>:<JST の日>:<tid>,<tid>…`（gsAmbigKey の頭の gsatei:ambig: を除いたもの） */
const AMBIG_RE = /^[A-Za-z0-9]{1,64}:\d{4}-\d{2}-\d{2}:[0-9a-f]{16}(,[0-9a-f]{16})*$/;
/** 段2b-2（info-to）の id は `<tid>:<聞き方の token の頭8字>` */
const INFO_TO_RE = /^[0-9a-f]{16}:[0-9a-f]{8}$/;

function parseMember(v: unknown): { kind: GsObKind; id: string } | null {
  if (typeof v !== "string") return null;
  const k = GS_OB_KINDS.find((x) => v.startsWith(`${x}:`));
  if (!k) return null;
  const id = v.slice(k.length + 1);
  if (!(k === "ambig" ? AMBIG_RE : k === "info-to" ? INFO_TO_RE : TID_RE).test(id)) return null;
  return { kind: k, id };
}

function asEntry(v: unknown): GsObEntry | null {
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
  const num = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  if (!num(r.tries) || !num(r.nextAt) || !num(r.firstAt)) return null;
  return { tries: r.tries as number, nextAt: r.nextAt as number, firstAt: r.firstAt as number };
}

/** 元の知らせが送れなかったときに積む（同じものが積まれていれば数え直さない）。例外は投げない */
export async function gsOutboxAdd(kv: GsObKv, kind: GsObKind, id: string, now: number, log: (l: string) => void, receipt = ""): Promise<boolean> {
  try {
    const e: GsObEntry = { tries: 0, nextAt: now + GS_OB_STEP_MS, firstAt: now };
    await kv.setNx(gsObKey(kind, id), e, GS_OB_TTL);
    await kv.sadd(GS_OUTBOX_SET, `${kind}:${id}`);
    log(`[group-satei] outbox ${kind}${receipt ? ` ${receipt}` : ""} queued`);
    return true;
  } catch {
    log(`[group-satei] outbox ${kind} queue-failed`);
    return false;
  }
}

/** 元の知らせと同じ retry key */
export function gsObRetryKey(kind: GsObKind, id: string): string {
  if (kind === "prop-late") return `late:${id}`;
  if (kind === "remind-note") return `remind-me:${id}`;
  if (kind === "cases") return `cases:${id}`;
  if (kind === "cases-late") return `cases-late:${id}`;
  if (kind === "info-to") return `info-to:${id}`;
  return `ambig:${id}`;
}

/** 段2e の結果の知らせ（finishCases・handCases と同じ文）。数は受付票の prep.casesNote から */
export function gsCasesNoteText(no: number, n: GsCasesNote): string {
  const c = { contract: n.contract, listing: n.listing };
  const lines: string[] = [];
  if (n.draft === "failed") lines.push(msgGsCasesFailed(no));
  else {
    if (n.draft === "started" && n.jobNo !== undefined) lines.push(msgGsCasesStarted(no, c, n.jobNo));
    else if (n.draft === "unknown") lines.push(msgGsCasesDraftUnknown(no, c));
    else if (n.draft === "house" || n.draft === "land") lines.push(msgGsCasesNoAuto(no, c, n.draft === "house" ? "戸建" : "土地"));
    else lines.push(msgGsCasesNoStart(no, c));
    if (n.failed > 0) lines.push(msgGsCasesSomeFailed(n.failed));
  }
  if (n.unsaved > 0) lines.push(msgGsCasesUnsaved(n.unsaved));
  return lines.join("\n");
}

/** 受付票から文を作り直す。作れない（票が消えた・もう要らない）なら null。receipt はログ用 */
async function rebuild(kind: GsObKind, id: string, kv: GsObKv): Promise<{ text: string; receipt: string } | null> {
  if (kind === "ambig") {
    const tids = id.split(":")[2].split(",");
    const nos: number[] = [];
    for (const tid of tids) {
      const t = asTicket(await kv.get(gsTicketKey(tid)));
      // 候補の票がまだ事例待ちのときだけ（閉じた票の分は聞かない）
      if (!t || t.state !== "waiting-cases" || t.prep?.casesDone) return null;
      nos.push(t.no);
    }
    return { text: msgGsCasesAmbig(nos), receipt: [...nos].sort((a, b) => a - b).map(receiptOf).join(",") };
  }
  if (kind === "info-to") {
    // 段2b-2：30分の見回りで準備へ進めず asking に戻した票。まだ asking のときだけ（押し直したあとは古い）
    const t = asTicket(await kv.get(gsTicketKey(id.split(":")[0])));
    return t && t.state === "asking" ? { text: msgGsInfoNotStarted(t.no), receipt: receiptOf(t.no) } : null;
  }
  const t = asTicket(await kv.get(gsTicketKey(id)));
  if (!t || !t.prep) return null;
  const p = t.prep;
  const receipt = receiptOf(t.no);
  // 案の配達をまだ試していない（＝案が来ていない）ときだけ
  if (kind === "prop-late") return t.state === "gathering" && p.tries === 0 && p.sentRev === 0 ? { text: msgGsPrepLate(t.no), receipt } : null;
  if (kind === "cases-late") return t.state === "waiting-cases" && !p.casesDone ? { text: msgGsCasesSlow(t.no), receipt } : null;
  if (kind === "remind-note") {
    // 事例を待っているあいだだけ（結果が来て閉じたら、催促の話は古い）
    if (t.state !== "waiting-cases" || p.casesDone) return null;
    if (p.remindNote === "failed") return { text: msgGsRemindFailed(t.no), receipt };
    if (p.remindNote === "unknown") return { text: msgGsRemindUnknown(t.no), receipt };
    if (p.remindNote === "sent" && p.deadline) return { text: msgGsRemindMe(t.no, gsDeadlineLabel(p.deadline)), receipt };
    return null;
  }
  if (!p.casesNote) return null;
  return { text: gsCasesNoteText(t.no, p.casesNote), receipt };
}

const sentOk = (status: number | null) => status !== null && ((status >= 200 && status < 300) || status === 409);

export interface GsOutboxDeps {
  kv: GsObKv;
  to: string | null;
  push(to: string, messages: unknown[], key: string): Promise<number | null>;
  now(): number;
  /** 見回りの開始の時刻。ここから GS_SWEEP_BUDGET_MS の予算 */
  startedAt: number;
  log(l: string): void;
}

/**
 * 控えの送り直し（見回りの最後。予算の残りが GS_OB_MIN_LEFT_MS 以上のときだけ・1回に1件）。
 * 呼ぶ側でスイッチ（groupSateiPrepOn）を確かめる。例外は投げない
 */
export async function gsOutboxRetry(deps: GsOutboxDeps): Promise<void> {
  const { kv } = deps;
  const enough = () => GS_SWEEP_BUDGET_MS - (deps.now() - deps.startedAt) >= GS_OB_MIN_LEFT_MS;
  try {
    if (!enough()) return;
    const members = await kv.smembers(GS_OUTBOX_SET);
    for (const raw of members) {
      // 要素を読むあいだにも予算を確かめる（L3）
      if (!enough()) return;
      const m = parseMember(raw);
      if (!m) {
        if (typeof raw === "string") await kv.srem(GS_OUTBOX_SET, raw);
        continue;
      }
      const member = `${m.kind}:${m.id}`;
      const key = gsObKey(m.kind, m.id);
      const drop = async () => {
        await kv.srem(GS_OUTBOX_SET, member);
        await kv.del(key);
      };
      const e = asEntry(await kv.get(key));
      if (!e) {
        await kv.srem(GS_OUTBOX_SET, member);
        continue;
      }
      const now = deps.now();
      if (now - e.firstAt >= GS_OB_MAX_AGE_MS || e.tries >= GS_OB_TRIES) {
        await drop();
        deps.log(`[group-satei] outbox ${m.kind} gave-up`);
        continue;
      }
      if (now < e.nextAt) continue;
      if (!deps.to || !enough()) return;
      const b = await rebuild(m.kind, m.id, kv);
      if (!b) {
        await drop();
        deps.log(`[group-satei] outbox ${m.kind} dropped`);
        continue;
      }
      const st = await deps.push(deps.to, [{ type: "text", text: b.text }], gsObRetryKey(m.kind, m.id)).catch(() => null);
      if (sentOk(st)) {
        await drop();
        deps.log(`[group-satei] outbox ${m.kind} ${b.receipt} sent`);
        return;
      }
      const tries = e.tries + 1;
      const at = deps.now();
      if (tries >= GS_OB_TRIES || at - e.firstAt >= GS_OB_MAX_AGE_MS) {
        await drop();
        deps.log(`[group-satei] outbox ${m.kind} ${b.receipt} gave-up`);
        return;
      }
      await kv.set(key, { tries, nextAt: at + GS_OB_STEP_MS * (tries + 1), firstAt: e.firstAt }, GS_OB_TTL);
      deps.log(`[group-satei] outbox ${m.kind} ${b.receipt} push-failed ${tries}`);
      return;
    }
  } catch {
    deps.log("[group-satei] outbox skip:exception");
  }
}
