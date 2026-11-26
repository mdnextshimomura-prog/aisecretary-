/**
 * 段2b-2（計画 docs/superpowers/plans/2026-11-26-group-satei-2b2.md の I2〜I4・I6）：
 * 足りない項目の答え（1対1の次の1通）の取り込みと、30分の見回り。聞く所は group-satei-actions.ts の pick。
 * 動くのは groupSateiPrepOn のときだけ。グループには何も送らない。例外は投げない。
 * ログ・KV には ID・時刻・項目の名前・件数・符号だけ（値は受付票の read にだけ）。
 */
import {
  GS_INFO_MS, GS_INFO_SET, GS_SWEEP_BUDGET_MS, GS_TICKET_TTL, asTicket, groupSateiPrepOn, gsInfoKey, gsTicketKey, receiptOf,
  type GsKind, type GsTicket,
} from "./group-satei-data";
import { gsClaimInfo, gsResumeInfo, type GsOutcome, type GsPickDeps } from "./group-satei-actions";
import { gsApplyInfo, gsInfoParse, isGsFactKey, msgGsInfoDone, msgGsInfoFilled, MSG_GS_INFO_UNREAD, type GsFactKey } from "./group-satei-facts";
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
  let mine = false;
  try {
    mine = await kv.delIfToken(key, token);
  } catch {
    deps.log("[group-satei] info clear-failed");
  }
  if (!mine) return false;
  const say = async (s: string) => {
    try {
      await deps.reply(m.replyToken, s);
    } catch {
      deps.log("[group-satei] reply-failed info");
    }
  };
  const tk = asTicket(await kv.get(gsTicketKey(tid)).catch(() => null));
  if (!tk) {
    deps.log("[group-satei] info stale");
    await say(MSG_GS_EXPIRED);
    return true;
  }
  if (tk.state !== "asking-info" || !tk.info || tk.info.token !== token || !tk.dealId) {
    deps.log(`[group-satei] info stale ${receiptOf(tk.no)}`);
    await say(msgGsInfoDone(tk.no));
    return true;
  }
  // 進めるのは最初の1つだけ（Claude の前に取る＝読んでいるあいだに30分の見回りが進めない）
  let won = false;
  try {
    won = await gsClaimInfo(tid, token, kv);
  } catch {
    won = false;
  }
  if (!won) {
    deps.log(`[group-satei] info already ${receiptOf(tk.no)}`);
    await say(msgGsInfoDone(tk.no));
    return true;
  }
  const keys = tk.info.keys.filter(isGsFactKey);
  let raw: string | null = null;
  try {
    raw = await deps.answer(keys, text);
  } catch {
    raw = null;
  }
  const vals = raw ? gsInfoParse(keys, raw) : {};
  const filled = keys.filter((k) => vals[k] !== undefined);
  let cur: GsTicket = tk;
  if (filled.length > 0) {
    const fresh = asTicket(await kv.get(gsTicketKey(tid)).catch(() => null));
    if (fresh && fresh.state === "asking-info" && fresh.info?.token === token) {
      cur = { ...fresh, read: gsApplyInfo(fresh.read, (fresh.read?.kind ?? fresh.info.kind) as GsKind, vals) };
      try {
        await kv.set(gsTicketKey(tid), cur, GS_TICKET_TTL);
      } catch {
        deps.log(`[group-satei] info save-failed ${receiptOf(tk.no)}`);
      }
    }
  }
  deps.log(`[group-satei] info filled ${receiptOf(tk.no)} ${filled.length}/${keys.length}`);
  const o = await gsResumeInfo(tid, cur, deps, kv);
  deps.log(`[group-satei] info ${o.code}`);
  const head = filled.length > 0 ? msgGsInfoFilled(filled) : MSG_GS_INFO_UNREAD;
  await say(sent(o) ? head : `${head}\n${o.text}`);
  return true;
}

export interface GsInfoSweepDeps extends GsPickDeps {
  kv: (Kv & { smembers(key: string): Promise<unknown[]>; delIfToken?(key: string, token: string): Promise<boolean> }) | null;
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
      if (!(await gsClaimInfo(tid, tk.info.token, kv))) {
        // ［このまま進める］か答えが進めている最中
        continue;
      }
      deps.log(`[group-satei] info timeout ${receiptOf(tk.no)}`);
      const o = await gsResumeInfo(tid, tk, deps, kv);
      deps.log(`[group-satei] info ${o.code}`);
      const to = sateiNotifyTarget(env);
      if (!sent(o) && !o.code.startsWith("prep unknown") && to) {
        const st = await deps.push(to, [{ type: "text", text: o.text }], `info-to:${tid}`).catch(() => null);
        if (st === null || st < 200 || st >= 300) deps.log(`[group-satei] info timeout push-failed ${receiptOf(tk.no)}`);
      }
      return;
    }
  } catch {
    deps.log("[group-satei] info sweep skip:exception");
  }
}
