/**
 * タスクの「候補」。
 *
 * 9/4 に新規受付を @AI秘書 のメンション必須にしてから、登録が 0 件になった
 * （付け忘れると何も残らない）。その前はメンション不要で、全部の発言が登録されて台帳が荒れた。
 * 間を取る：メンションの無い依頼は登録せず「候補」として控え、1 日 1 回まとめて
 * 「タスクにしますか？」と聞く。「1 登録」と返ったものだけ、通常の登録に回す。
 *
 * このファイルは判断と文面だけ（純粋関数）。控えの置き場は task-candidate-store.ts。
 */

import { isContextlessRequest } from "./task-intake";

/** 候補の機能を使うか。外せば今までどおり（メンションの無い発言は何もしない）。 */
export function candidatesEnabled(): boolean {
  return process.env.TASK_CANDIDATES === "1";
}

/** 試行の対象者（LINE userId）。空なら誰の発言も候補にしない。 */
export function pilotUserIds(): string[] {
  return (process.env.TASK_CANDIDATE_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Candidate {
  /** 元の発言の LINE メッセージID。登録するときの二重登録防止の鍵にもなる */
  id: string;
  /** 元の発言（メンションを除いた本文） */
  text: string;
  /** AI が付けた題名 */
  title: string;
  /** 担当（AI の読み、またはメンションの名前）。分からなければ null */
  assignee: string | null;
  /** 担当の LINE userId（メンションで指定されたとき）。無ければ null */
  assigneeUserId: string | null;
  /** 頼んだ人の LINE userId */
  senderId: string | null;
  /** 控えた時刻（ミリ秒） */
  createdAt: number;
}

const MIN_LENGTH = 6;
const MAX_LENGTH = 400;

// 依頼に見える言い回し。ここを通ったものだけ AI に渡す（全部の発言を AI に読ませない）
const REQUEST_CUES =
  /(お願い|おねがい|ください|下さい|頂けますか|いただけますか|もらえますか|もらえる\?|もらえる？|できますか|しといて|しておいて|やっといて|やっておいて|よろしく|頼む|頼みます|までに|送って|作って|作成して|確認して|対応して|連絡して|手配して|調べて|出して|直して|修正して|提出して|用意して|準備して)/;

/** 依頼に見えるか（AI に渡す前の安いふるい）。 */
export function looksLikeRequest(text: string): boolean {
  const t = (text ?? "").trim();
  if (t.length < MIN_LENGTH || t.length > MAX_LENGTH) return false;
  return REQUEST_CUES.test(t);
}

/** この発言を候補として AI に読ませるか。 */
export function shouldCapture(opts: {
  groupId: string | undefined;
  /** 候補を集めるグループ（会社グループ）。そこ以外の発言は控えない */
  mainGroupId: string | undefined;
  senderId: string | undefined;
  /** Bot 以外にメンションされた人 */
  mentionedUserIds: string[];
  text: string;
  pilot: string[];
}): boolean {
  if (!opts.groupId || !opts.mainGroupId || opts.groupId !== opts.mainGroupId) {
    return false;
  }
  if (opts.pilot.length === 0) return false;
  const involved =
    (opts.senderId !== undefined && opts.pilot.includes(opts.senderId)) ||
    opts.mentionedUserIds.some((id) => opts.pilot.includes(id));
  if (!involved) return false;
  // 「お願いします」だけの発言は、何の依頼か分からないので AI に渡さない
  if (isContextlessRequest(opts.text)) return false;
  return looksLikeRequest(opts.text);
}

function normalize(text: string): string {
  return (text ?? "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .trim();
}

export type CandidateCommand =
  | { action: "register"; numbers: number[] }
  | { action: "skip"; numbers: number[] };

// 完了・待ちの番号（「3済」「3待ち」「3不要」）と取り違えないよう、言葉を分けてある。
// 「いらない」「不要」はタスクの番号の言葉（task-status-command.ts）なので、候補では使わない。
const COMMAND_RE = /^(\d{1,2}(?:[\s,、，・]+\d{1,2})*)\s*(登録|なし)$/;

/** 「1 登録」「2,3 なし」を読む。 */
export function parseCandidateCommand(text: string): CandidateCommand | null {
  const m = normalize(text).match(COMMAND_RE);
  if (!m) return null;
  const nums = (m[1].match(/\d+/g) ?? []).map(Number);
  if (nums.some((n) => n < 1)) return null;
  const numbers = nums.filter((n, i) => nums.indexOf(n) === i);
  return { action: m[2] === "登録" ? "register" : "skip", numbers };
}

/** 「候補」のひとこと（いま控えている候補を見せて、という頼み）。 */
export function isCandidateListRequest(text: string): boolean {
  return normalize(text) === "候補";
}

/** 返事の無い候補を消すまでの長さ（5 日。土日・定休をまたいでも 3 営業日ほど残る）。 */
export const CANDIDATE_TTL_MS = 5 * 24 * 60 * 60 * 1000;

export function pruneExpired(
  list: Candidate[],
  nowMs: number,
  ttlMs: number = CANDIDATE_TTL_MS,
): Candidate[] {
  return list.filter((c) => nowMs - c.createdAt < ttlMs);
}

const JST_MS = 9 * 60 * 60 * 1000;

/**
 * 17 時台（JST）か。10 分おきの見回りが少しずれても、その日の分を聞き逃さないよう 1 時間の幅にする。
 * 1 日 1 回に絞るのは、置き場の印（claimDailyAsk）の役目。
 */
export function isDigestTime(nowMs: number): boolean {
  return new Date(nowMs + JST_MS).getUTCHours() === 17;
}

/**
 * 候補を聞く文面。番号は並び順（1 始まり）。済みの番号（null）は飛ばす。
 * 候補が無ければ null。
 */
export function buildDigest(numbered: Array<Candidate | null>): string | null {
  const lines: string[] = [];
  numbered.forEach((c, i) => {
    if (!c) return;
    lines.push(
      `${i + 1}. ${c.title}${c.assignee ? `（担当：${c.assignee}）` : ""}`,
    );
  });
  if (lines.length === 0) return null;
  return [
    `📝 タスクにしますか？（${lines.length}件）`,
    ...lines,
    "",
    "タスクにする：「1 登録」",
    "しない：「2 なし」（まとめて「2,3 なし」も可）",
    "※ 朝のリマインドの番号とは別です（「済」「待ち」はリマインドの番号に効きます）",
    "返事が無いものは数日で消えます",
  ].join("\n");
}
