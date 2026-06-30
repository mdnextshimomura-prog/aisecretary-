import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ParsedTask {
  // メンションなしでも文脈から判定するためのゲートキーパー項目
  isTask: boolean; // タスクとして登録すべき依頼・指示か（雑談・相槌・報告のみ等はfalse）
  confidence: number; // 0〜1。タスクである確信度
  title: string;
  category: "売買" | "賃貸" | "管理" | "買取再販" | "その他";
  urgency: "今日中" | "今週中" | "来週以降";
  dueDate: string | null; // ISO 8601 date string or null
  assignee: string | null;
  memo: string | null;
}

// この値以上の確信度のときだけ自動登録する（環境変数で調整可）
export const TASK_CONFIDENCE_THRESHOLD = Number(
  process.env.TASK_CONFIDENCE_THRESHOLD ?? "0.7"
);

const SYSTEM_PROMPT = `あなたは不動産業務の秘書アシスタントです。
LINEグループで飛び交うメッセージを1件ずつ受け取ります。メンションの有無に関わらず、
その発言が「タスクとして登録すべき依頼・指示・約束ごと」かどうかを自分で判断してください。

まず判定してください：
- isTask: その発言が、誰かがやるべき具体的なタスク（依頼・指示・期日のある約束）を含むならtrue。
  単なる雑談・相槌・感想・完了報告・質問のみ・スタンプ的な短文などはfalse。
- confidence: タスクである確信度を0〜1で。曖昧なら低め、明確な依頼や期日付きなら高めに。

isTaskがtrueのとき、以下も抽出してください（falseのときは空でよい）：
- title: タスクのタイトル（簡潔に）
- category: 「売買」「賃貸」「管理」「買取再販」「その他」のいずれか
- urgency: 「今日中」「今週中」「来週以降」のいずれか
- dueDate: 期日（ISO 8601形式 "YYYY-MM-DD"、不明な場合はnull）
- assignee: 担当者名（自分・メンバー名、不明な場合はnull）
- memo: 詳細メモ（元メッセージから補足情報を抽出）

JSONのみを返してください。説明文は不要です。
例: {"isTask": true, "confidence": 0.9, "title": "...", "category": "売買", "urgency": "今週中", "dueDate": "2026-07-03", "assignee": null, "memo": null}`;

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
