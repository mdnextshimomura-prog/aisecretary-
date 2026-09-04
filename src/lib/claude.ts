import Anthropic from "@anthropic-ai/sdk";
import { REQUEST_TYPES, type RequestType } from "./due-rules";
import { cleanPropertyName, normalizeProperty } from "./property";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ParsedTask {
  // @AI秘書で受け付けた内容が、実際にタスクとして成立するかの判定項目
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
  /** 自動割当を行った理由。LINE返信とNotionの履歴に残す。 */
  assignmentReason?: string | null;
  // LINEメンションで担当者を指定された場合の、その人のLINE userId。
  // Claudeの出力には含まれず、Webhook受信時にメンション情報から補完する。
  // リマインド時にこのIDでLINEメンション（@通知）するために保存する。
  assigneeUserId?: string | null;
  // 物件名（原文の表記のまま）。同じ物件のタスクを串刺しにするために使う。
  // 照合用のキーは property.ts で作り、webhook 側で埋める。
  propertyName?: string | null;
  propertyKey?: string | null;
  memo: string | null;
}

// この値以上の確信度のときだけ自動登録する（環境変数で調整可）
export const TASK_CONFIDENCE_THRESHOLD = Number(
  process.env.TASK_CONFIDENCE_THRESHOLD ?? "0.7"
);

const SYSTEM_PROMPT = `あなたは不動産業務の秘書アシスタントです。
LINEグループでAI秘書宛てにメンションされたメッセージを1件ずつ受け取ります。
その発言や直前の添付が「タスクとして登録すべき依頼・指示・約束ごと」かどうかを判断してください。

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
- propertyName: 対象の物件名。**メッセージや添付に書かれている表記をそのまま**入れる
  （勝手に正式名称へ直さない。表記ゆれの吸収はこちらで行う）。
  建物名＋部屋番号（例:「メロディハイム豊中泉ヶ丘626」）、
  戸建・土地は町名＋丁目（例:「上野東2丁目3-4」）。
  複数物件が出てくる場合は依頼の主対象1件だけ。分からなければ null。
  会社名・業者名・人名を物件名に入れないこと。
- memo: 詳細メモ（元メッセージから補足情報を抽出）

- requestType: 依頼の種類。次のいずれか1つ。
  「査定書」… 査定書の作成・査定対応・査定価格のまとめ
  「購入申込書」… 購入申込書・買付証明書の作成（「買付を入れる」「これ買いたい」も含む）
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

**画像やPDFが添付されている場合**、それが依頼の中身そのものです。
このグループでは「資料の写真を送って、担当者をメンションするだけ」という形の依頼が
最も多く、文字は「@杉山 舜 お願いします」程度しかありません。
添付を読み、何についての依頼かを具体的にタイトルへ落としてください。
例:「@小笠原　陸」＋ 販売図面の写真 →「三国本町マンションの販売図面の確認・修正」
物件名・住所・金額など、添付から読み取れた手掛かりは memo に残してください。
添付が業務と無関係（雑談の写真・スクリーンショットの共有のみ）なら isTask は false にします。

JSONのみを返してください。説明文は不要です。
例: {"isTask": true, "confidence": 0.9, "title": "...", "category": "売買", "requestType": "査定書", "urgentHint": false, "urgency": "今週中", "dueDate": null, "dueTime": null, "assignee": null, "propertyName": "メロディハイム豊中泉ヶ丘626", "memo": null}`;

/** タスク判定に添える添付（LINEで直前に届いた画像・PDF） */
export interface TaskAttachment {
  kind: "image" | "pdf";
  mediaType: string;
  base64: string;
}

export async function parseTaskFromMessage(
  message: string,
  today: string,
  attachments: TaskAttachment[] = []
): Promise<ParsedTask> {
  const content: Anthropic.MessageParam["content"] = [];
  for (const a of attachments) {
    if (a.kind === "image") {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: a.mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
          data: a.base64,
        },
      });
    } else {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: a.base64 },
      });
    }
  }
  content.push({
    type: "text",
    text:
      `今日の日時（日本時間・受信時刻）: ${today}\n\n` +
      (attachments.length > 0
        ? `※このメッセージの直前に、上の添付（${attachments.length}件）が同じ人から送られています。依頼の中身は添付にあります。\n\n`
        : "") +
      `LINEメッセージ:\n${message}`,
  });

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
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

  // 物件名を掃除し、表記ゆれを吸収した照合キーを作る
  parsed.propertyName = cleanPropertyName(parsed.propertyName);
  parsed.propertyKey = normalizeProperty(parsed.propertyName) || null;
  return parsed;
}
