import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ParsedTask {
  title: string;
  category: "売買" | "賃貸" | "管理" | "買取再販" | "その他";
  urgency: "今日中" | "今週中" | "来週以降";
  dueDate: string | null; // ISO 8601 date string or null
  assignee: string | null;
  memo: string | null;
}

const SYSTEM_PROMPT = `あなたは不動産業務の秘書アシスタントです。
LINEで受信したメッセージを解析し、タスク情報をJSONで返してください。

以下のフィールドを抽出してください：
- title: タスクのタイトル（簡潔に）
- category: 「売買」「賃貸」「管理」「買取再販」「その他」のいずれか
- urgency: 「今日中」「今週中」「来週以降」のいずれか
- dueDate: 期日（ISO 8601形式 "YYYY-MM-DD"、不明な場合はnull）
- assignee: 担当者名（自分・メンバー名、不明な場合はnull）
- memo: 詳細メモ（元メッセージから補足情報を抽出）

JSONのみを返してください。説明文は不要です。`;

export async function parseTaskFromMessage(
  message: string,
  today: string
): Promise<ParsedTask> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `今日の日付: ${today}\n\nLINEメッセージ:\n${message}`,
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  // JSONブロックを抽出
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Claude からJSONを取得できませんでした");
  }

  return JSON.parse(jsonMatch[0]) as ParsedTask;
}
