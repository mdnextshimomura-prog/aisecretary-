import { NextRequest, NextResponse } from "next/server";
import { verifyLineSignature, sendLineMessage, buildTaskRegisteredMessage, getGroupMemberName } from "@/lib/line";
import { parseTaskFromMessage } from "@/lib/claude";
import { createNotionTask } from "@/lib/notion";

interface LineMentionee {
  index: number;
  length: number;
  userId?: string;
  type: "user" | "all";
}

interface LineMessage {
  type: string;
  text: string;
  mention?: {
    mentionees: LineMentionee[];
  };
}

interface LineWebhookEvent {
  type: string;
  replyToken?: string;
  source: { userId: string; type: string; groupId?: string };
  message?: LineMessage;
}

interface LineWebhookBody {
  events: LineWebhookEvent[];
}

const BOT_USER_ID = process.env.LINE_BOT_USER_ID!;

// ボットがメンションされているか確認
function isBotMentioned(message: LineMessage): boolean {
  if (!message.mention) return false;
  return message.mention.mentionees.some((m) => m.userId === BOT_USER_ID);
}

// メンション部分をテキストから除去して純粋なタスク内容だけ取り出す
function stripMentions(message: LineMessage): string {
  if (!message.mention) return message.text;
  const mentionees = [...message.mention.mentionees].sort(
    (a, b) => b.index - a.index
  );
  let text = message.text;
  for (const m of mentionees) {
    text = text.slice(0, m.index) + text.slice(m.index + m.length);
  }
  return text.trim();
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";

  if (!verifyLineSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const body: LineWebhookBody = JSON.parse(rawBody);

  for (const event of body.events) {
    if (event.type !== "message" || event.message?.type !== "text") continue;

    // ボットへのメンションがない場合はスキップ
    if (!isBotMentioned(event.message)) continue;

    const text = stripMentions(event.message);
    const replyToken = event.replyToken!;
    const today = new Date().toISOString().split("T")[0];

    try {
      // 1. Claude でタスク解析
      const parsed = await parseTaskFromMessage(text, today);

      // ボット以外のメンション → 担当者に上書き
      const groupId = event.source.groupId;
      if (groupId && event.message.mention) {
        const others = event.message.mention.mentionees.filter(
          (m) => m.userId && m.userId !== BOT_USER_ID
        );
        if (others.length > 0 && others[0].userId) {
          const name = await getGroupMemberName(groupId, others[0].userId);
          if (name) parsed.assignee = name;
        }
      }

      // 2. Notion に登録
      const notionId = await createNotionTask(parsed, text);

      // 3. LINE に返信
      const reply = buildTaskRegisteredMessage(parsed);
      await sendLineMessage(replyToken, reply);
    } catch (err) {
      console.error("タスク処理エラー:", err);
      await sendLineMessage(
        replyToken,
        "⚠️ タスクの登録中にエラーが発生しました。もう一度お試しください。"
      );
    }
  }

  return NextResponse.json({ status: "ok" });
}
