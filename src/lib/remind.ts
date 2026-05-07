import { PrismaClient } from "@prisma/client";
import { pushLineMessage } from "./line";

const prisma = new PrismaClient();

export async function sendDailyReminders(): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const dayAfterTomorrow = new Date(today);
  dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);

  // 今日・明日が期日のタスクを取得
  const tasks = await prisma.task.findMany({
    where: {
      dueDate: { gte: today, lt: dayAfterTomorrow },
      status: { not: "完了" },
    },
    orderBy: { dueDate: "asc" },
  });

  if (tasks.length === 0) return;

  // ユーザーごとにグループ化してPush送信
  const byUser = new Map<string, typeof tasks>();
  for (const task of tasks) {
    const list = byUser.get(task.lineUserId) ?? [];
    list.push(task);
    byUser.set(task.lineUserId, list);
  }

  for (const [userId, userTasks] of byUser) {
    const todayTasks = userTasks.filter(
      (t) => t.dueDate && t.dueDate < tomorrow
    );
    const tomorrowTasks = userTasks.filter(
      (t) => t.dueDate && t.dueDate >= tomorrow
    );

    const lines: string[] = ["🔔 本日のリマインドです\n"];

    if (todayTasks.length > 0) {
      lines.push("【本日期限】");
      for (const t of todayTasks) {
        lines.push(`・${t.title}（${t.urgency}）`);
      }
    }

    if (tomorrowTasks.length > 0) {
      lines.push("\n【明日期限】");
      for (const t of tomorrowTasks) {
        lines.push(`・${t.title}（${t.urgency}）`);
      }
    }

    await pushLineMessage(userId, lines.join("\n"));
  }
}
