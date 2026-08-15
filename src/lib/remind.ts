import { getUpcomingTasks, jstDateStr, setRemindNumber } from "./notion";
import { pushLineMessageWithMentions, sanitizeForTextV2 } from "./line";
import { todayClosure } from "./closures";

// リマインドの送信先＝会社グループ。反響通知と同じグループに送る。
const LINE_GROUP_ID =
  process.env.LINE_GROUP_ID ?? "Cd5fda3261e9bdd012e598884b2e6a696";

// LINEの1メッセージあたりメンション上限（20）に対する安全策
const MAX_MENTIONS = 20;

// 期限超過は溜まっていると際限なく長くなるため、表示件数を絞る。
// 溢れた分は件数だけ伝えてNotionへ誘導する。
const MAX_OVERDUE_SHOWN = 10;

type UpcomingTask = Awaited<ReturnType<typeof getUpcomingTasks>>[number];

// 期日は時刻付き（"2026-08-02T15:00:00+09:00"）で保存されることがある。
// 日付だけを取り出さないと "YYYY-MM-DD" との比較が常に不一致になり、
// 「時刻を指定した本日期限のタスクが明日扱いになる」不具合が起きる。
function dueDateOnly(t: UpcomingTask): string {
  return (t.dueDate ?? "").slice(0, 10);
}

// 期日から何日超過しているか（JST基準の日数差）
function daysOverdue(dueStr: string, todayStr: string): number {
  const due = Date.parse(`${dueStr}T00:00:00Z`);
  const today = Date.parse(`${todayStr}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(today)) return 0;
  return Math.round((today - due) / 86_400_000);
}

export async function sendDailyReminders(): Promise<void> {
  const todayStr = jstDateStr(0);

  // 会社が休みの日は送らない。誰も対応できない日に
  // 「期限超過30件」を毎朝投げても、読まれなくなるだけ。
  const closure = await todayClosure(todayStr);
  if (closure) {
    console.log(`[remind] ${closure}のため送信しない (${todayStr})`);
    return;
  }

  // 期日が明日まで・未完了のタスク（期限超過を含む）を期日の古い順で取得
  const tasks = await getUpcomingTasks();
  if (tasks.length === 0) return;

  const tomorrowStr = jstDateStr(1);

  const overdueTasks = tasks.filter((t) => dueDateOnly(t) < todayStr);
  const todayTasks = tasks.filter((t) => dueDateOnly(t) === todayStr);
  const tomorrowTasks = tasks.filter((t) => dueDateOnly(t) === tomorrowStr);

  let text = "🔔 本日のリマインドです\n";
  const mentions: Record<string, string> = {}; // {key} -> userId
  let mentionCount = 0;

  // 実際に本文へ載せたタスク（この順に1から番号を振り、番号で完了できるようにする）。
  // 期限超過は表示を打ち切るため、載らなかった分には番号を振らない
  // （見えていない番号を指定されても引けないため）。
  const shown: UpcomingTask[] = [];

  // タスク1件を本文に追記し、担当者がメンション可能ならtextV2の置換キーを埋め込む
  const appendTask = (t: UpcomingTask, suffix?: string) => {
    shown.push(t);
    text += `\n${shown.length}. ${sanitizeForTextV2(t.title)}（${
      suffix ?? t.urgency
    }）`;
    if (t.assigneeUserId && t.assignee && mentionCount < MAX_MENTIONS) {
      mentionCount += 1;
      const key = `m${mentionCount}`;
      text += ` {${key}}`;
      mentions[key] = t.assigneeUserId;
    } else if (t.assignee) {
      // userId未取得（メンションで指定されていない）の担当者は名前だけ表示
      text += `（担当：${t.assignee}）`;
    }
  };

  // 期限超過を最初に出す。放置されているものほど上に来るよう古い順のまま扱う。
  if (overdueTasks.length > 0) {
    text += `\n⚠️ 期限超過（${overdueTasks.length}件）`;
    for (const t of overdueTasks.slice(0, MAX_OVERDUE_SHOWN)) {
      appendTask(t, `${daysOverdue(dueDateOnly(t), todayStr)}日超過`);
    }
    const rest = overdueTasks.length - MAX_OVERDUE_SHOWN;
    if (rest > 0) text += `\n…ほか${rest}件（Notionで確認してください）`;
    text += "\n";
  }

  if (todayTasks.length > 0) {
    text += "\n【本日期限】";
    for (const t of todayTasks) appendTask(t);
  }

  if (tomorrowTasks.length > 0) {
    text += "\n\n【明日期限】";
    for (const t of tomorrowTasks) appendTask(t);
  }

  text +=
    "\n\n──────────\n" +
    "終わったものは番号で返信してください\n" +
    "例：「3済」「1,2完了」「4おわった」";

  // 本文に載せた順で番号を確定させてから送る。
  // 送信後に番号を振ると、先に返信されたときに引けないため順序が重要。
  await Promise.all(shown.map((t, i) => setRemindNumber(t.id, i + 1)));

  await pushLineMessageWithMentions(LINE_GROUP_ID, text, mentions);
}
