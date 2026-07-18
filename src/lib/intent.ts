import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// claude.ts と同じモデルを使う（コードベース全体で統一）
const MODEL = "claude-sonnet-4-6";

// 受信メッセージの意図。confirm（下書き確認への返答）は
// 「確認セッションが存在するか」で webhook 側が判定するため、ここには含めない。
export type Intent = "email" | "task" | "other";

export interface IntentResult {
  intent: Intent;
  confidence: number; // 0〜1
}

// email として新処理へ振り分ける最低確信度。これ未満は既存のタスク処理へ落とす
// （＝迷ったら既存挙動を優先し、メール分岐に誤って入らないようにする）。
export const EMAIL_INTENT_THRESHOLD = Number(
  process.env.EMAIL_INTENT_THRESHOLD ?? "0.7"
);

// 「メール送って」等の明確なメール指示か（AI判定より前の確定ルール）。
// AIが稀にタスクと誤判定するため、明示的なメール指示は問答無用でメールへ回す。
export function looksLikeEmailCommand(text: string): boolean {
  const t = text.replace(/\s/g, "");
  return (
    /メール.{0,12}(送信|送っ|送る|送付|出し|書い|書く|作成|して|してほ|ください|お願い)/.test(
      t
    ) ||
    /(送信|返信|返事).{0,8}メール/.test(t) ||
    /メールで.{0,12}(送|返信|連絡|案内)/.test(t)
  );
}

const SYSTEM_PROMPT = `あなたは不動産会社の社内アシスタントです。
LINEで届いた1件の発言が、次のどれを求めているかを分類してください。

- email : メール文面の作成・送信を頼む発言。「〇〇さんにメール送って」「メールで返信して」
  「△△の件でメール書いて」など、メールという手段が明示・強く示唆されているもの。
- task : メール送信以外の、やるべき業務タスク・依頼・指示（資料作成、査定、確認など）。
- other : 雑談・相槌・報告・質問のみなど、上記いずれでもないもの。

判定の注意:
- 「メール」「メールで」「送信」など、メールという手段が明示されていない限り email にしない。
  単に「資料送っておいて」は task 寄り（社内共有の可能性が高い）。
- 迷う場合は confidence を低めにする。

JSONのみを返してください。前置き・説明文・マークダウン記法（\`\`\`など）は一切禁止です。
例: {"intent": "email", "confidence": 0.9}`;

export async function classifyIntent(text: string): Promise<IntentResult> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 128,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `LINEメッセージ:\n${text}` }],
  });

  const out = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  const jsonMatch = out.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // 判定不能時は安全側（既存のタスク処理へ流す）に倒す
    return { intent: "task", confidence: 0 };
  }
  const parsed = JSON.parse(jsonMatch[0]) as Partial<IntentResult>;
  const intent: Intent =
    parsed.intent === "email" || parsed.intent === "task" || parsed.intent === "other"
      ? parsed.intent
      : "task";
  return { intent, confidence: Number(parsed.confidence ?? 0) };
}
