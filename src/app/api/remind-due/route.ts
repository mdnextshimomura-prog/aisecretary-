import { NextRequest, NextResponse } from "next/server";
import { getDueSoonTasks, markNotified } from "@/lib/notion";
import { pushLineMessageWithMentions, sanitizeForTextV2 } from "@/lib/line";

// 期限前通知（Vercel Cronから10分おきに呼ばれる）
// - 期日当日に登録されたタスク（短期のもの）: 期限の1時間前に通知
// - それより前に登録されたタスク: 期限の2時間前に通知
// 期日に時刻が無いタスクは 18:00 を期限とみなす。
// 通知は会社グループへ送り、担当者が分かる場合は@メンションを付ける。

const LINE_GROUP_ID =
  process.env.LINE_GROUP_ID ?? "Cd5fda3261e9bdd012e598884b2e6a696";

const DEFAULT_DUE_HOUR = "18:00";
const JST_MS = 9 * 60 * 60 * 1000;

// ISO日時のJSTでの日付部分 "YYYY-MM-DD"
function jstDateOf(iso: string): string {
  return new Date(new Date(iso).getTime() + JST_MS).toISOString().slice(0, 10);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tasks = await getDueSoonTasks();
  const now = Date.now();
  let sent = 0;
  // 起動役（GAS）から叩かれているか可視化するための目印
  console.log(`[remind-due] invoked / 対象候補 ${tasks.length}件`);

  for (const t of tasks) {
    if (!t.dueStart) continue;

    // 期限日時（時刻なしはデフォルト18:00 JST）
    const dueIso =
      t.dueStart.length === 10
        ? `${t.dueStart}T${DEFAULT_DUE_HOUR}:00+09:00`
        : t.dueStart;
    const dueMs = Date.parse(dueIso);
    if (Number.isNaN(dueMs)) continue;

    // 当日登録（今日中タスク）は1時間前、事前に積まれたタスクは2時間前
    const leadMin = jstDateOf(t.createdTime) === jstDateOf(dueIso) ? 60 : 120;
    const notifyAt = dueMs - leadMin * 60 * 1000;
    if (now < notifyAt) continue;

    const dueLabel = new Date(dueMs + JST_MS)
      .toISOString()
      .slice(11, 16); // "HH:mm" (JST)

    let text = `⏰ まもなく期限です（本日${dueLabel}まで）\n・${sanitizeForTextV2(t.title)}`;
    const mentions: Record<string, string> = {};
    if (t.assignee) {
      text += "\n担当: ";
      if (t.assigneeUserId) {
        text += "{m1}";
        mentions.m1 = t.assigneeUserId;
      } else {
        text += `${t.assignee}さん`;
      }
    }

    await pushLineMessageWithMentions(LINE_GROUP_ID, text, mentions);
    await markNotified(t.id); // 送信後に印を付けて二重通知を防ぐ
    sent += 1;
  }

  return NextResponse.json({ status: "ok", checked: tasks.length, sent });
}
