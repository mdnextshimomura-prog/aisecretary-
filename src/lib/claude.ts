import Anthropic from "@anthropic-ai/sdk";
import { REQUEST_TYPES, type RequestType } from "./due-rules";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ParsedTask {
  // メンションなしでも文脈から判定するためのゲートキーパー項目
  isTask: boolean; // タスクとして登録すべき依頼・指示か（雑談・相槌・報告のみ等はfalse）
  confidence: number; // 0〜1。タスクである確信度
  title: string;
  category: "売買" | "賃貸" | "管理" | "買取再販" | "その他";
  urgency: "今日中" | "今週中" | "来週以降";
  // 依頼の種類。期日は claude ではなく due-rules.ts の標準納期表から決める
  requestType: RequestType;
  urgentHint: boolean; // 「急ぎ」「至急」の指定があったか
  dueDate: string | null; // ISO 8601 date string。メッセージに明示があるときだけ入る
  dueTime: string | null; // "HH:mm"。メッセージに時刻の明示があるときだけ入る
  /** 期日をどう決めたかの説明（返信に出す）。webhook 側で埋める */
  dueReason?: string;
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
- dueTime: 期日の時刻（"HH:mm" 24時間表記）。「17時までに」「13時集合」など
  メッセージに時刻の明示があるときだけ設定し、無ければnull。
- assignee: 担当者名（自分・メンバー名、不明な場合はnull）
- memo: 詳細メモ（元メッセージから補足情報を抽出）

- requestType: 依頼の種類。次のいずれか1つ。
  「査定書」… 査定書の作成・査定対応・査定価格のまとめ
  「物件資料」… 物件資料・相場資料・図面などの作成/送付
  「重要事項説明書」… 重説の作成
  「売買契約書」… 売買契約書の作成
  「書類取得」… 登記簿謄本・公課証明・評価証明などの取得
  「業者確認」… 他業者・管理会社・関係先への確認や問い合わせ
  「内見調整」… 内見・現地案内・立会いの調整
  「その他」… 上記に当てはまらないもの
- urgentHint: 「急ぎ」「至急」「今日中に」など急ぎの指定があれば true、無ければ false

**期日は自分で決めないこと。** dueDate/dueTime は「メッセージに日付や時刻の明示があるとき」だけ
その値を入れ、明示が無ければ必ず null にする。明示が無い場合の期日は、こちらで requestType から
標準納期を適用して決める（あなたが推測した日付は使わない）。
- dueDate: 明示があれば "YYYY-MM-DD"、無ければ null
- dueTime: 「17時までに」「13時集合」など時刻の明示があれば "HH:mm"、無ければ null

JSONのみを返してください。説明文は不要です。
例: {"isTask": true, "confidence": 0.9, "title": "...", "category": "売買", "requestType": "査定書", "urgentHint": false, "urgency": "今週中", "dueDate": null, "dueTime": null, "assignee": null, "memo": null}`;

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

  const parsed = JSON.parse(jsonMatch[0]) as ParsedTask;

  // 想定外の requestType が返っても落とさず「その他」に寄せる
  // （プロンプトを変えたときに全件エラーになるのを防ぐ）
  if (!REQUEST_TYPES.includes(parsed.requestType)) {
    parsed.requestType = "その他";
  }
  return parsed;
}
