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
  // LINEメンションで担当者を指定された場合の、その人のLINE userId。
  // Claudeの出力には含まれず、Webhook受信時にメンション情報から補完する。
  // リマインド時にこのIDでLINEメンション（@通知）するために保存する。
  assigneeUserId?: string | null;
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
  次のような「事務連絡・予定共有」もfalse（タスク登録しない）：
  ホワイトボードへの記載依頼、外出先・帰社時刻の共有（「戻り12時半です」等）、
  出退勤・移動の報告、日程の周知のみのメッセージ。
- confidence: タスクである確信度を0〜1で。曖昧なら低め、明確な依頼や期日付きなら高めに。

isTaskがtrueのとき、以下も抽出してください（falseのときは空でよい）：
- title: タスクのタイトル（簡潔に）
- category: 「売買」「賃貸」「管理」「買取再販」「その他」のいずれか
- urgency: 「今日中」「今週中」「来週以降」のいずれか
- dueDate: 期日（ISO 8601形式 "YYYY-MM-DD"、不明な場合は下記ルールで決める）
- assignee: 担当者名（自分・メンバー名、不明な場合はnull）
- memo: 詳細メモ（元メッセージから補足情報を抽出）

dueDateの決め方（メッセージに明示の期日があればそれを最優先。無ければ以下）：
1. 査定書・査定対応・査定価格まとめ → 受信日の1週間後（urgencyは「今週中」）
2. 物件資料・相場資料・図面などの資料作成/送付
   - 「急ぎ」「至急」等の指定あり → 受信日当日（「今日中」）
   - 受信が午前（12時まで） → 受信日当日（「今日中」）
   - 受信が午後 → 翌日（「今日中」ではなく翌日期日）
3. 上記以外の一般タスク → 内容から常識的に判断。目安として軽い確認作業は
   午前着なら当日・午後着なら翌日、重い作業は2〜3日後。
※「今日の日時」に受信時刻（日本時間）を渡すので、午前/午後はそれで判定すること。

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
        content: `今日の日時（日本時間・受信時刻）: ${today}\n\nLINEメッセージ:\n${message}`,
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
