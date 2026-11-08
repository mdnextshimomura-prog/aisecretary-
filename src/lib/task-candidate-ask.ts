/**
 * 控えている候補を、1 日 1 回（17 時台）会社グループに聞く。
 * 起こすのは /api/remind-due（10 分おきに外から叩かれる入口）。
 *
 * B1 Task 2（TASK_MENU on のときだけ）：文字の一覧のあとに候補のカルーセル（最大10＋［次の10件］）を付け、
 * 文字＋カードを1回の push（2通・1リクエスト）で送る。候補を受け付けるほかのグループ
 * （TASK_CANDIDATE_GROUP_IDS）にも、そのグループの候補だけを聞く。off なら今と同じ（営業部へ文字だけ）。
 */
import { pushLineMessage, pushTextAndCard } from "./line";
import { loadMembers, type Member } from "./members";
import { jstDateStr } from "./notion";
import {
  buildDigest,
  candidateGroupIds,
  candidatesEnabled,
  isDigestTime,
  type Candidate,
} from "./task-candidate";
import { claimDailyAsk, numberCandidates } from "./task-candidate-store";
import { digestWithCards, nameResolver } from "./candidate-card";
import { menuActive } from "./task-menu";
import type { FlexMessage } from "./task-card";

export interface AskDeps {
  /** groupId は TASK_MENU on のときだけ渡す（営業部は今までと同じ印） */
  claim(dateJst: string, groupId?: string): Promise<boolean>;
  number(
    nowMs: number,
    groupId?: string,
  ): Promise<Parameters<typeof buildDigest>[0]>;
  /** card は TASK_MENU on のときだけ渡す（無ければ今と同じ文字だけの push） */
  push(to: string, text: string, card?: FlexMessage): Promise<boolean>;
  /** 名簿（カードの依頼者・宛先の名前。TASK_MENU on のときだけ読む） */
  members?(): Promise<Member[]>;
}

export type AskResult =
  | "off" // スイッチが入っていない
  | "not-time" // 17 時台ではない
  | "no-group" // 送り先（会社グループ）が設定されていない
  | "already" // 今日はもう聞いた
  | "empty" // 候補が無い
  | "sent"
  | "send-failed";

const realDeps: AskDeps = {
  claim: claimDailyAsk,
  number: numberCandidates,
  push: (to, text, card) =>
    card ? pushTextAndCard(to, text, card) : pushLineMessage(to, text),
  members: loadMembers,
};

/**
 * 条件が揃っていれば候補を聞く。何をしたかを返す（ログ用）。
 * TASK_MENU on でグループが複数あるときは、営業部（LINE_GROUP_ID）の結果を返し、
 * ほかのグループの結果はログに符号だけ出す。候補の本文・題名・グループの ID はログに出さない。
 */
export async function askCandidatesIfDue(
  nowMs: number,
  deps: AskDeps = realDeps,
  groupId: string | undefined = process.env.LINE_GROUP_ID,
  todayJst: string = jstDateStr(0),
): Promise<AskResult> {
  if (!candidatesEnabled()) return "off";
  if (!isDigestTime(nowMs)) return "not-time";
  if (!menuActive()) {
    if (!groupId) return "no-group";
    // 印を先に付ける：見回りが重なっても 2 回聞かない（送信に失敗した日は、その日は聞き直さない。
    // 「@AI秘書 候補」でいつでも一覧を出せる）
    if (!(await deps.claim(todayJst))) return "already";
    const digest = buildDigest(await deps.number(nowMs));
    if (!digest) return "empty";
    return (await deps.push(groupId, digest)) ? "sent" : "send-failed";
  }

  // TASK_MENU on：グループごとに（営業部＋TASK_CANDIDATE_GROUP_IDS）
  const extras = candidateGroupIds().filter((g) => g !== groupId);
  const groups = [...(groupId ? [groupId] : []), ...extras];
  if (groups.length === 0) return "no-group";
  let members: Member[] | null = null;
  const askOne = async (g: string): Promise<AskResult> => {
    if (!(await deps.claim(todayJst, g))) return "already";
    const numbered: Array<Candidate | null> = await deps.number(nowMs, g);
    // 17 時は保留の印が切れる時刻なので、保留は見ない（全部出す）
    if (members === null) {
      members = await (deps.members ?? (async () => []))().catch(
        () => [] as Member[],
      );
    }
    const r = digestWithCards(numbered, new Set(), nameResolver(members));
    if (!r.text) return "empty";
    return (await deps.push(g, r.text, r.card)) ? "sent" : "send-failed";
  };
  // ほかのグループの失敗は営業部の分を止めない（営業部の例外は今までどおり呼び出し側へ）
  let first: AskResult = "no-group";
  for (const g of groups) {
    if (g === groupId) {
      first = await askOne(g);
      continue;
    }
    const r = await askOne(g).catch(() => "send-failed" as const);
    console.log(`[task-candidate] ask extra ${r}`);
  }
  return first;
}
