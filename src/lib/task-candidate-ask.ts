/**
 * 控えている候補を、1 日 1 回（17 時台）会社グループに聞く。
 * 起こすのは /api/remind-due（10 分おきに外から叩かれる入口）。
 */
import { pushLineMessage } from "./line";
import { jstDateStr } from "./notion";
import { buildDigest, candidatesEnabled, isDigestTime } from "./task-candidate";
import { claimDailyAsk, numberCandidates } from "./task-candidate-store";

export interface AskDeps {
  claim(dateJst: string): Promise<boolean>;
  number(nowMs: number): Promise<Parameters<typeof buildDigest>[0]>;
  push(to: string, text: string): Promise<boolean>;
}

export type AskResult =
  | "off" // スイッチが入っていない
  | "not-time" // 17 時台ではない
  | "no-group" // 送り先（会社グループ）が設定されていない
  | "already" // 今日はもう聞いた
  | "empty" // 候補が無い
  | "sent"
  | "send-failed";

/**
 * 条件が揃っていれば候補を聞く。何をしたかを返す（ログ用）。
 * 候補の本文・題名はログに出さない。
 */
export async function askCandidatesIfDue(
  nowMs: number,
  deps: AskDeps = {
    claim: claimDailyAsk,
    number: numberCandidates,
    push: pushLineMessage,
  },
  groupId: string | undefined = process.env.LINE_GROUP_ID,
  todayJst: string = jstDateStr(0),
): Promise<AskResult> {
  if (!candidatesEnabled()) return "off";
  if (!isDigestTime(nowMs)) return "not-time";
  if (!groupId) return "no-group";
  // 印を先に付ける：見回りが重なっても 2 回聞かない（送信に失敗した日は、その日は聞き直さない。
  // 「@AI秘書 候補」でいつでも一覧を出せる）
  if (!(await deps.claim(todayJst))) return "already";
  const digest = buildDigest(await deps.number(nowMs));
  if (!digest) return "empty";
  return (await deps.push(groupId, digest)) ? "sent" : "send-failed";
}
