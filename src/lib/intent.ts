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
  ambiguous: boolean; // メール/タスク/顧客登録のどれとも取れて判断が割れる
}

// 対応フロー選択（曖昧時の確認で使う）
export type ActionChoice = "email" | "task" | "crm" | "none";

// 曖昧時に出す「どう対応する？」メニュー
export function buildClarificationMenu(): string {
  return [
    "🤔 これはどう対応しますか？",
    "① メールを作成して送る",
    "② タスクとして登録",
    "③ 顧客(CRM)に登録",
    "④ 何もしない",
    "",
    "→ 番号か「メール / タスク / 顧客 / なし」で教えてください。",
  ].join("\n");
}

// ユーザーの選択返答を解釈する。解釈できなければ null。
export function interpretClarification(text: string): ActionChoice | null {
  const t = text.trim();
  const has = (re: RegExp) => re.test(t);
  if (has(/①/) || has(/(?:^|[^\d])1(?![\d])/) || has(/メール/)) return "email";
  if (has(/②/) || has(/(?:^|[^\d])2(?![\d])/) || has(/タスク/)) return "task";
  if (has(/③/) || has(/(?:^|[^\d])3(?![\d])/) || has(/顧客|crm|お客|得意先/i))
    return "crm";
  if (
    has(/④/) ||
    has(/(?:^|[^\d])4(?![\d])/) ||
    has(/なし|何もし|やめ|キャンセル|不要/)
  )
    return "none";
  return null;
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

さらに ambiguous も判定してください:
- ambiguous: その発言が「メール送信」「タスク登録」「顧客(CRM)登録」のうち複数に取れて、
  どれか1つに決めきれない場合は true。明確に1つに決まる、または単なる雑談・質問なら false。
  例:「山田さんの件、対応しといて」→ メールかタスクか不明で ambiguous=true。
  例:「内覧の日程どうする？」→ 雑談/質問なので ambiguous=false（other）。

判定の注意:
- 「メール」「メールで」「送信」など、メールという手段が明示されていない限り email にしない。
  単に「資料送っておいて」は task 寄り（社内共有の可能性が高い）。
- 迷う場合は confidence を低めにし、複数フローに取れるなら ambiguous=true にする。

JSONのみを返してください。前置き・説明文・マークダウン記法（\`\`\`など）は一切禁止です。
例: {"intent": "email", "confidence": 0.9, "ambiguous": false}`;

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
    return { intent: "task", confidence: 0, ambiguous: false };
  }
  const parsed = JSON.parse(jsonMatch[0]) as Partial<IntentResult>;
  const intent: Intent =
    parsed.intent === "email" || parsed.intent === "task" || parsed.intent === "other"
      ? parsed.intent
      : "task";
  return {
    intent,
    confidence: Number(parsed.confidence ?? 0),
    ambiguous: Boolean(parsed.ambiguous),
  };
}
