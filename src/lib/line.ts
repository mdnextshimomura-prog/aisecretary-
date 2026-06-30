import crypto from "crypto";
import type { ParsedTask } from "./claude";

const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET!;

// LINE署名検証
export function verifyLineSignature(
  body: string,
  signature: string
): boolean {
  const hash = crypto
    .createHmac("sha256", CHANNEL_SECRET)
    .update(body)
    .digest("base64");
  return hash === signature;
}

// LINEメッセージ送信
export async function sendLineMessage(
  replyToken: string,
  text: string
): Promise<void> {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

// グループメンバーの表示名を取得
export async function getGroupMemberName(
  groupId: string,
  userId: string
): Promise<string | null> {
  const res = await fetch(
    `https://api.line.me/v2/bot/group/${groupId}/member/${userId}`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return (data.displayName as string) ?? null;
}

// Push通知（replyTokenなし）
export async function pushLineMessage(
  to: string,
  text: string
): Promise<void> {
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text }],
    }),
  });
}

// LINEメンション付きPush送信。
// mentionees の index/length は text 内の「@名前」部分の位置（JSの文字列インデックス＝
// LINE仕様のUTF-16コード単位と一致）。userId を指定するとその人に通知が飛ぶ。
export async function pushLineMessageWithMentions(
  to: string,
  text: string,
  mentionees: Array<{ index: number; length: number; userId: string }>
): Promise<void> {
  const message: Record<string, unknown> = { type: "text", text };
  if (mentionees.length > 0) {
    message.mention = {
      mentionees: mentionees.map((m) => ({
        index: m.index,
        length: m.length,
        type: "user",
        userId: m.userId,
      })),
    };
  }
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [message] }),
  });
}

// タスク登録完了メッセージ生成
export function buildTaskRegisteredMessage(task: ParsedTask): string {
  const dueLine = task.dueDate
    ? `📅 期日：${formatDate(task.dueDate)}`
    : null;
  const assigneeLine = task.assignee
    ? `👤 担当：${task.assignee}`
    : null;

  const lines = [
    "✅ タスク登録しました",
    "",
    `📋 ${task.title}`,
    `🏷 種別：${task.category}`,
    `🔥 緊急度：${task.urgency}`,
    dueLine,
    assigneeLine,
  ].filter(Boolean);

  return lines.join("\n");
}

function formatDate(isoDate: string): string {
  const d = new Date(isoDate);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
