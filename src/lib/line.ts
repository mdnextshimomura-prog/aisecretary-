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
