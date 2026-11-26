/**
 * 段2b-2（計画 docs/superpowers/plans/2026-11-26-group-satei-2b2.md の I2〜I4・I6）：
 * 足りない項目の答え（1対1の次の1通）の取り込みと、30分の見回り。聞く所は group-satei-actions.ts の pick。
 * 動くのは groupSateiPrepOn のときだけ。グループには何も送らない。例外は投げない。
 * ログ・KV には ID・時刻・項目の名前・件数・符号だけ（値は受付票の read にだけ）。
 */
import {
  GS_INFO_MS, GS_INFO_SET, GS_SWEEP_BUDGET_MS, GS_TICKET_TTL, asTicket, groupSateiPrepOn, gsInfoKey, gsInfoTok, gsTicketKey, receiptOf,
  type GsKind, type GsTicket,
} from "./group-satei-data";
import { gsClaimInfo, gsReleaseInfo, gsResumeInfo, type GsOutcome, type GsPickDeps } from "./group-satei-actions";
import {
  gsApplyInfo, gsInfoLooksLikeAnswer, gsInfoParse, isGsFactKey, msgGsInfoDone, msgGsInfoFilled, msgGsInfoRetry, MSG_GS_INFO_NOT_SAVED, MSG_GS_INFO_RETRY,
  type GsFactKey,
} from "./group-satei-facts";
import { gsOutboxAdd } from "./group-satei-outbox";
import { MSG_GS_EXPIRED } from "./group-satei-card";
import type { GsKv } from "./group-satei-open";
import { isSateiUser, sateiNotifyTarget } from "./satei-data";
import type { FlexMessage } from "./task-card";

type Kv = GsKv & { del(key: string): Promise<void>; srem(key: string, member: string): Promise<void> };

export interface GsInfoDeps extends GsPickDeps {
  kv: (Kv & { delIfToken(key: string, token: string): Promise<boolean> }) | null;
  /** Claude 1回（15秒で打ち切りは呼ぶ側）。答えの文字。失敗は null か例外 */
  answer(keys: GsFactKey[], text: string): Promise<string | null>;
  reply(token: string, text: string, card?: FlexMessage): Promise<unknown>;
}

const INFO_TEXT_MAX = 1000;
const sent = (o: GsOutcome) => o.code.startsWith("prep sent");

/**
 * 1対1の文字を足りない項目の答えとして受けるか。true＝受けた（返事も済み）、false＝今の流れへ。
 * 受けるのは 2d が on・1対1・TASK_SATEI_USER_IDS の人・空でない文字・印（gsatei:info:<userId>）があるときだけ。
 * 印は読んだ token のときだけ消す（消せたときだけ受ける）
 */
export async function handleGsInfoText(m: { userId?: string; groupId?: string; text: string; replyToken: string }, deps: GsInfoDeps): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (!groupSateiPrepOn(env) || m.groupId || !m.userId || !isSateiUser(m.userId, env) || !deps.kv) return false;
  const text = Array.from((m.text ?? "").trim()).slice(0, INFO_TEXT_MAX).join("");
  if (!text) return false;
  const kv = deps.kv;
  const now = () => (deps.now ?? Date.now)();
  const key = gsInfoKey(m.userId);
  let mark: { tid?: unknown; token?: unknown } | null;
  try {
    const v = await kv.get(key);
    mark = v && typeof v === "object" ? (v as { tid?: unknown; token?: unknown }) : null;
  } catch {
    deps.log("[group-satei] info read-failed");
    return false;
  }
  if (!mark || typeof mark.tid !== "string" || typeof mark.token !== "string") return false;
  const tid = mark.tid;
  const token = mark.token;
  const say = async (s: string) => {
    try {
      await deps.reply(m.replyToken, s);
    } catch {
      deps.log("[group-satei] reply-failed info");
    }
  };
  // 受付票は印を消す前に読む（読めなければ印を残したまま「もう一度送ってください」。点検 LOW-9）
  let tk: GsTicket | null;
  try {
    tk = asTicket(await kv.get(gsTicketKey(tid)));
  } catch {
    deps.log("[group-satei] info ticket read-failed");
    await say(MSG_GS_INFO_RETRY);
    return true;
  }
  const live = tk && tk.state === "asking-info" && tk.info && tk.info.token === token && tk.dealId ? tk : null;
  // 答えらしい手がかりが1つも無い1通は受けない（印は消さず今の流れへ。点検 MED-1 (b)）
  if (live && !gsInfoLooksLikeAnswer(live.info!.keys.filter(isGsFactKey), text)) {
    deps.log(`[group-satei] info not-answer ${receiptOf(live.no)}`);
    return false;
  }
  let mine = false;
  try {
    mine = await kv.delIfToken(key, token);
  } catch {
    // 印を読めたのに消せない：答えは今の流れへ渡さず、もう一度送ってもらう（点検 LOW-5）
    deps.log("[group-satei] info clear-failed");
    await say(MSG_GS_INFO_NOT_SAVED);
    return true;
  }
  if (!mine) return false;
  if (!tk) {
    deps.log("[group-satei] info stale");
    await say(MSG_GS_EXPIRED);
    return true;
  }
  if (!live) {
    deps.log(`[group-satei] info stale ${receiptOf(tk.no)}`);
    await say(msgGsInfoDone(tk.no));
    return true;
  }
  const info = live.info!;
  // 進めるのは最初の1つだけ（Claude の前に取る＝読んでいるあいだに30分の見回りが進めない）
  let won: boolean;
  try {
    won = await gsClaimInfo(tid, token, kv, now());
  } catch {
    deps.log(`[group-satei] info claim-failed ${receiptOf(live.no)}`);
    await quietRestore(() => kv.setNx(key, { tid, token }, leftSec(info.at, now())), deps);
    await say(msgGsInfoRetry(live.no));
    return true;
  }
  if (!won) {
    deps.log(`[group-satei] info already ${receiptOf(live.no)}`);
    await say(msgGsInfoDone(live.no));
    return true;
  }
  const keys = info.keys.filter(isGsFactKey);
  let raw: string | null = null;
  try {
    raw = await deps.answer(keys, text);
  } catch {
    raw = null;
  }
  const vals = raw ? gsInfoParse(keys, raw) : {};
  const filled = keys.filter((k) => vals[k] !== undefined);
  deps.log(`[group-satei] info filled ${receiptOf(live.no)} ${filled.length}/${keys.length}`);
  if (filled.length === 0) {
    // 読めた項目が0件：取り込まずに印と進める権を元に戻し、今の流れへ（［このまま進める］か30分に任せる。点検 MED-1 (a)）
    await quietRestore(() => gsReleaseInfo(tid, live, kv, now()), deps);
    return false;
  }
  const cur: GsTicket = { ...live, read: gsApplyInfo(live.read, (live.read?.kind ?? info.kind) as GsKind, vals) };
  try {
    await kv.set(gsTicketKey(tid), cur, GS_TICKET_TTL);
  } catch {
    deps.log(`[group-satei] info save-failed ${receiptOf(live.no)}`);
  }
  const o = await gsResumeInfo(tid, cur, deps, kv);
  deps.log(`[group-satei] info ${o.code}`);
  const head = msgGsInfoFilled(filled);
  await say(sent(o) ? head : `${head}\n${o.text}`);
  return true;
}

const leftSec = (at: number, now: number) => Math.max(1, Math.ceil((at + GS_INFO_MS - now) / 1000));
async function quietRestore(f: () => Promise<unknown>, deps: { log(l: string): void }): Promise<void> {
  try {
    await f();
  } catch {
    deps.log("[group-satei] info restore-failed");
  }
}

export interface GsInfoSweepDeps extends GsPickDeps {
  kv: (Kv & { smembers(key: string): Promise<unknown[]>; srem(key: string, member: string): Promise<void>; delIfToken?(key: string, token: string): Promise<boolean> }) | null;
  push(to: string, messages: unknown[], key: string): Promise<number | null>;
  now(): number;
  startedAt?: number;
}

/** 進めるのに要る残り（案件の読み取り8秒＋portal の準備8秒＋KV） */
const INFO_SWEEP_MIN_MS = 25_000;

/**
 * 毎分の見回り（cloud-tick。段2d の見回りの前）：聞いてから30分たった asking-info の票を1件だけ、足りないまま進める。
 * 下村さんへは知らせない（このあと案のカードが届く）。準備へ進めなかったときだけ、その返事の文を1通（0通にしない）
 */
export async function sweepGsInfo(deps: GsInfoSweepDeps): Promise<void> {
  const env = deps.env ?? process.env;
  if (!groupSateiPrepOn(env) || !deps.kv) return;
  const kv = deps.kv;
  const start = deps.startedAt ?? deps.now();
  try {
    const tids = (await kv.smembers(GS_INFO_SET)).filter((x): x is string => typeof x === "string");
    for (const tid of tids) {
      const tk = asTicket(await kv.get(gsTicketKey(tid)));
      if (!tk || tk.state !== "asking-info" || !tk.info || !tk.dealId) {
        await kv.srem(GS_INFO_SET, tid);
        continue;
      }
      if (deps.now() - tk.info.at < GS_INFO_MS) continue;
      if (deps.now() - start > GS_SWEEP_BUDGET_MS - INFO_SWEEP_MIN_MS) {
        deps.log("[group-satei] info sweep budget");
        return;
      }
      if (!(await gsClaimInfo(tid, tk.info.token, kv, deps.now()))) {
        // ［このまま進める］か答えが進めている最中
        continue;
      }
      deps.log(`[group-satei] info timeout ${receiptOf(tk.no)}`);
      const o = await gsResumeInfo(tid, tk, deps, kv);
      deps.log(`[group-satei] info ${o.code}`);
      const to = sateiNotifyTarget(env);
      if (!sent(o) && !o.code.startsWith("prep unknown") && to) {
        // retry key に聞き方の token を入れる（押し直して聞き直した回の知らせを LINE が重複として捨てない。点検 LOW-1）
        const id = `${tid}:${gsInfoTok(tk.info.token)}`;
        const st = await deps.push(to, [{ type: "text", text: o.text }], `info-to:${id}`).catch(() => null);
        if (st === null || !((st >= 200 && st < 300) || st === 409)) {
          deps.log(`[group-satei] info timeout push-failed ${receiptOf(tk.no)}`);
          // 2f の控えに積む（見回りが文を作り直して同じ retry key で送り直す。点検 LOW-2）
          await gsOutboxAdd(kv, "info-to", id, deps.now(), deps.log, receiptOf(tk.no));
        }
      }
      return;
    }
  } catch {
    deps.log("[group-satei] info sweep skip:exception");
  }
}
