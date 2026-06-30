import { getUpcomingTasks, jstDateStr } from "./notion";
import { pushLineMessageWithMentions } from "./line";

// リマインドの送信先＝会社グループ。反響通知と同じグループに送る。
const LINE_GROUP_ID =
  process.env.LINE_GROUP_ID ?? "Cd5fda3261e9bdd012e598884b2e6a696";

// LINEの1メッセージあたりメンション上限（20）に対する安全策
const MAX_MENTIONS = 20;

type UpcomingTask = Awaited<ReturnType<typeof getUpcomingTasks>>[number];

export async function sendDailyReminders(): Promise<void> {
  // 期日が今日・明日（JST基準）で未完了のタスクをNotionから取得
  const tasks = await getUpcomingTasks();
  if (tasks.length === 0) return;

  const todayStr = jstDateStr(0);
  const todayTasks = tasks.filter((t) => t.dueDate === todayStr);
  const tomorrowTasks = tasks.filter((t) => t.dueDate !== todayStr);

  let text = "🔔 本日のリマインドです\n";
  const mentionees: Array<{ index: number; length: number; userId: string }> =
    [];

  // タスク1件を本文に追記し、担当者がメンション可能ならメンション情報を積む
  const appendTask = (t: UpcomingTask) => {
    text += `\n・${t.title}（${t.urgency}）`;
    if (t.assigneeUserId && t.assignee && mentionees.length < MAX_MENTIONS) {
      text += " ";
      const at = text.length; // 「@」が入る位置
      const mention = `@${t.assignee}`;
      text += mention;
      mentionees.push({
        index: at,
        length: mention.length,
        userId: t.assigneeUserId,
      });
    } else if (t.assignee) {
      // userId未取得（メンションで指定されていない）の担当者は名前だけ表示
      text += `（担当：${t.assignee}）`;
    }
  };

  if (todayTasks.length > 0) {
    text += "\n【本日期限】";
    for (const t of todayTasks) appendTask(t);
  }

  if (tomorrowTasks.length > 0) {
    text += "\n\n【明日期限】";
    for (const t of tomorrowTasks) appendTask(t);
  }

  await pushLineMessageWithMentions(LINE_GROUP_ID, text, mentionees);
}
