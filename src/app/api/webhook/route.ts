import { NextRequest, NextResponse } from "next/server";
import { verifyLineSignature, sendLineMessage, buildTaskRegisteredMessage } from "@/lib/line";
import { parseTaskFromMessage, TASK_CONFIDENCE_THRESHOLD } from "@/lib/claude";
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

    // メンションは必須ではない。全発言をClaudeに渡し、タスクかどうかを判定させる。
    const text = stripMentions(event.message);
    if (!text) continue;
    const replyToken = event.replyToken!;
    // JST（日本時間）の日時を渡す。UTCのままだと朝9時まで前日扱いになる上、
    // 午前/午後で期日を変えるルールの判定に受信時刻が必要。
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16)
      .replace("T", " ");

    // 1. Claude でタスク判定＋解析。解析自体が失敗した発言は雑談扱いで黙ってスキップ。
    let parsed;
    try {
      parsed = await parseTaskFromMessage(text, today);
    } catch (err) {
      console.error("タスク解析エラー（スキップ）:", err);
      continue;
    }

    // タスクでない、または確信度が低い発言は登録しない（雑談・相槌・報告など）
    if (!parsed.isTask || parsed.confidence < TASK_CONFIDENCE_THRESHOLD) {
      continue;
    }

    // メンションがあれば、その名前を担当者として優先採用（ボット自身のメンションは除く）
    if (event.message.mention) {
      const others = event.message.mention.mentionees.filter(
        (m) => m.type === "user" && m.userId !== BOT_USER_ID
      );
      if (others.length > 0) {
        const m = others[0];
        const raw = event.message.text.slice(m.index, m.index + m.length);
        const name = raw.startsWith("@") ? raw.slice(1) : raw;
        if (name) parsed.assignee = name;
        // リマインド時にLINEメンション（@通知）するため userId も保存する
        if (m.userId) parsed.assigneeUserId = m.userId;
      }
    }

    try {
      // 2. Notion に登録
      await createNotionTask(parsed, text);

      // 3. LINE に「登録しました」と返信
      const reply = buildTaskRegisteredMessage(parsed);
      await sendLineMessage(replyToken, reply);
    } catch (err) {
      console.error("タスク登録エラー:", err);
      await sendLineMessage(
        replyToken,
        "⚠️ タスクの登録中にエラーが発生しました。もう一度お試しください。"
      );
    }
  }

  return NextResponse.json({ status: "ok" });
}
