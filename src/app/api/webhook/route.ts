import { NextRequest, NextResponse } from "next/server";
import { verifyLineSignature, sendLineMessage, buildTaskRegisteredMessage } from "@/lib/line";
import { parseTaskFromMessage } from "@/lib/claude";
import { createNotionTask } from "@/lib/notion";

interface LineWebhookEvent {
  type: string;
  replyToken?: string;
  source: { userId: string; type: string };
  message?: { type: string; text: string };
}

interface LineWebhookBody {
  events: LineWebhookEvent[];
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

    const text = event.message.text;
    const userId = event.source.userId;
    const replyToken = event.replyToken!;
    const today = new Date().toISOString().split("T")[0];

    try {
      // 1. Claude でタスク解析
      const parsed = await parseTaskFromMessage(text, today);

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
