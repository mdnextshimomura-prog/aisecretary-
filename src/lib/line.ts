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

// LINEメッセージ送信。送ったメッセージのID（引用リプライの照合に使う）を返す。
export async function sendLineMessage(
  replyToken: string,
  text: string
): Promise<string | null> {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
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
  if (!res.ok) return null;
  const data = (await res.json()) as {
    sentMessages?: Array<{ id: string }>;
  };
  return data.sentMessages?.[0]?.id ?? null;
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

// LINEメンション付きPush送信（textV2形式）。
// 通常の text メッセージに mention を付けても送信時は無視される（受信専用の仕様）ため、
// 本物のメンション（相手に通知が飛び、青くハイライトされる）には textV2 の
// substitution 置換を使う。text 中の {key} が substitution のメンションに置換される。
// 注意: userId がそのグループのメンバーでないとメンションにならない。
export async function pushLineMessageWithMentions(
  to: string,
  text: string,
  mentions: Record<string, string> // key（textの{key}） -> LINE userId
): Promise<void> {
  const keys = Object.keys(mentions);
  const message: Record<string, unknown> =
    keys.length === 0
      ? { type: "text", text }
      : {
          type: "textV2",
          text,
          substitution: Object.fromEntries(
            keys.map((k) => [
              k,
              {
                type: "mention",
                mentionee: { type: "user", userId: mentions[k] },
              },
            ])
          ),
        };
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [message] }),
  });
  if (!res.ok) {
    console.error("LINE push失敗:", res.status, await res.text());
  }
}

// textV2では { } が置換記法として解釈されるため、本文に含めない
export function sanitizeForTextV2(s: string): string {
  return s.replace(/\{/g, "（").replace(/\}/g, "）");
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
