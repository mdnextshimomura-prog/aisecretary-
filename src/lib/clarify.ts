/**
 * 初動確認 — 「その依頼、いま着手できるか？」を判定して質問を返す。
 *
 * 背景（トーク履歴 2025.10〜2026.08 の実測）:
 *   社長からの依頼は条件が省かれることが多く、担当者が聞き返して初めて着手できる。
 *   実例：
 *     20:10 社長「@小笠原　陸 これ買いたい」（買付証明書.pdf 添付）
 *     20:19 小笠原「土地としてでしょうか？」
 *     20:26 社長「収益」
 *     20:31 小笠原「賃貸状況なにかわかる資料ありますでしょうか？」
 *   → 着手可能になるまで21分・3往復。同種の確認質問が10ヶ月で168件あった。
 *
 * この仕組みの狙いは「聞き返しをなくす」ことではなく、
 * **聞き返しを依頼の直後に・提案の形で・自動で出す**こと。
 * 人間が気づくまでの数時間を消す。
 *
 * ★最重要の設計方針（絶対に壊さないこと）★
 *   質問を出すかどうかに関わらず、**タスクは必ず即座にNotionへ登録する**。
 *   確認は「登録の門番」ではなく「登録済みタスクへの追記」として動く。
 *   確認待ちを登録の条件にすると、誰も答えなかった依頼が消える。
 *   それは現状（全部登録される）より明確に悪い。
 */
import Anthropic from "@anthropic-ai/sdk";
import type { RequestType } from "./due-rules";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-4-6";

/** 確認待ちタスクのNotionステータス名（select は API 側で自動追加される） */
export const STATUS_PENDING = "要確認";

export interface RequiredField {
  key: string;
  /** 質問文に出す項目名 */
  label: string;
  /**
   * 既定の提案。ここが埋まっていると「〜でよろしいですか？」と聞ける。
   * null なら「どうしますか？」と聞くしかない項目。
   */
  suggest: string | null;
  /**
   * true = これが無いと物理的に着手できない項目。
   * false = 慣例やテンプレートで埋められる項目（提案を強めに出す）。
   */
  critical: boolean;
}

/**
 * 依頼種別ごとの「初動に必要な項目」。
 *
 * suggest の値は不動産実務の慣例に基づく暫定値。
 * **実務と合わない値は運用しながらここだけ直せばよい**（他のファイルは触らない）。
 */
const CHECKLIST: Partial<Record<RequestType, RequiredField[]>> = {
  購入申込書: [
    { key: "buyer", label: "買主名義", suggest: null, critical: true },
    { key: "price", label: "購入金額（指値）", suggest: null, critical: true },
    { key: "deposit", label: "手付金", suggest: "売買代金の5%", critical: false },
    { key: "loan", label: "融資利用の有無", suggest: "融資利用あり・ローン特約あり", critical: false },
    { key: "settlement", label: "決済（引渡）希望日", suggest: "契約から45日後", critical: false },
    { key: "expiry", label: "申込の有効期限", suggest: "発行日から7日間", critical: false },
  ],
  査定書: [
    // ↓ 履歴の「土地としてでしょうか？」がそのままここ
    { key: "basis", label: "査定の前提", suggest: null, critical: true },
    { key: "purpose", label: "用途（提出先）", suggest: "売主様への提示用", critical: false },
    { key: "range", label: "価格の出し方", suggest: "上限・下限の幅で提示", critical: false },
  ],
  物件資料: [
    { key: "kind", label: "必要な資料", suggest: null, critical: true },
    { key: "recipient", label: "提出先", suggest: null, critical: false },
    { key: "format", label: "形式", suggest: "PDF", critical: false },
  ],
  重要事項説明書: [
    { key: "parties", label: "売主・買主", suggest: null, critical: true },
    { key: "contractDate", label: "契約予定日", suggest: null, critical: true },
    { key: "price", label: "売買代金", suggest: null, critical: true },
  ],
  売買契約書: [
    { key: "parties", label: "売主・買主", suggest: null, critical: true },
    { key: "contractDate", label: "契約予定日", suggest: null, critical: true },
    { key: "price", label: "売買代金", suggest: null, critical: true },
    { key: "settlement", label: "決済日", suggest: "契約から45日後", critical: false },
  ],
  書類取得: [
    { key: "kind", label: "取得する書類", suggest: null, critical: true },
    { key: "cost", label: "費用の負担", suggest: "会社立替", critical: false },
  ],
  業者確認: [
    { key: "question", label: "確認したい内容", suggest: null, critical: true },
    { key: "target", label: "確認先", suggest: null, critical: false },
  ],
  内見調整: [
    { key: "datetime", label: "希望日時", suggest: null, critical: true },
    { key: "attendee", label: "同行者", suggest: null, critical: false },
  ],
};

export function checklistFor(type: RequestType): RequiredField[] {
  return CHECKLIST[type] ?? [];
}

export interface ClarifyResult {
  /** 不足している項目（critical を先頭に並べ替え済み） */
  missing: RequiredField[];
  /** メッセージ・添付から読み取れた条件（メモに残す） */
  found: Record<string, string>;
  /** 物件が特定できていないか（種別によらず初動を止める最大要因） */
  propertyUnknown: boolean;
}

const EXTRACT_PROMPT = `あなたは不動産会社の営業事務です。
依頼メッセージから、指定された確認項目それぞれについて
「すでに書かれているか」「書かれていないか」を判定してください。

判定の基準：
- **明示されている**、または**文脈から一意に読み取れる**場合のみ「あり」とする
- 推測でしか埋まらないものは「なし」とする
- 添付画像やPDFに書かれている内容も「あり」に含める

必ず次のJSONのみを返してください（説明文やコードフェンスは付けない）：
{
  "found": { "項目key": "読み取れた値", ... },
  "missing": ["項目key", ...]
}
found に入れるのは読み取れたものだけ。読み取れなかった key を missing に入れます。`;

/**
 * 依頼メッセージを確認項目リストと突き合わせ、不足を洗い出す。
 *
 * isTask が true と判定されたものにだけ呼ぶこと。
 * 全メッセージに呼ぶと、雑談にまでAPIコストがかかる。
 *
 * 失敗時は「不足なし」として扱う（fail-open）。
 * 確認機能が落ちても、タスク登録という本体機能は止めない。
 */
export async function detectMissing(
  text: string,
  type: RequestType,
  propertyName: string | null,
  attachments: unknown[] = []
): Promise<ClarifyResult> {
  const fields = checklistFor(type);
  const propertyUnknown = !propertyName;

  if (fields.length === 0) {
    return { missing: [], found: {}, propertyUnknown };
  }

  const list = fields
    .map((f) => `- ${f.key}: ${f.label}`)
    .join("\n");

  try {
    const content: unknown[] = [
      ...attachments,
      {
        type: "text",
        text:
          `依頼種別: ${type}\n` +
          `対象物件: ${propertyName ?? "（不明）"}\n\n` +
          `確認項目:\n${list}\n\n` +
          `依頼メッセージ:\n${text || "（本文なし・添付のみ）"}`,
      },
    ];

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: EXTRACT_PROMPT,
      messages: [{ role: "user", content: content as never }],
    });

    const raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("")
      .replace(/```json\s*|```/g, "")
      .trim();

    const parsed = JSON.parse(raw) as {
      found?: Record<string, string>;
      missing?: string[];
    };

    const missingKeys = new Set(parsed.missing ?? []);
    const missing = fields
      .filter((f) => missingKeys.has(f.key))
      // critical を先に出す。答えるのが1つだけでも前に進むようにする
      .sort((a, b) => Number(b.critical) - Number(a.critical));

    return { missing, found: parsed.found ?? {}, propertyUnknown };
  } catch (err) {
    console.error("[clarify] 不足項目の判定に失敗（確認をスキップ）:", err);
    return { missing: [], found: {}, propertyUnknown };
  }
}

/**
 * 確認メッセージを組み立てる。
 *
 * 方針：**「どうしますか？」で終わらせない。**
 * 提案がある項目は「これでよいか」の形にして、「はい」だけで前に進めるようにする。
 * 提案が無い項目（金額・名義など、こちらで決めようがないもの）だけを質問にする。
 */
export function buildClarifyMessage(
  taskTitle: string,
  result: ClarifyResult,
  propertyName: string | null,
  remindNumber?: number
): string {
  const ask = result.missing.filter((f) => !f.suggest);
  const propose = result.missing.filter((f) => f.suggest);

  let msg = `📝 「${taskTitle}」を登録しました。\n`;
  msg += `着手前に確認させてください。\n`;

  if (result.propertyUnknown) {
    msg += `\n❓ どの物件のご依頼でしょうか？\n`;
  } else if (propertyName) {
    msg += `\n物件：${propertyName}\n`;
  }

  if (Object.keys(result.found).length > 0) {
    msg += `\n【いただいている条件】\n`;
    for (const v of Object.values(result.found)) {
      msg += `・${v}\n`;
    }
  }

  if (ask.length > 0) {
    msg += `\n【ご指示ください】\n`;
    for (const f of ask) msg += `・${f.label}\n`;
  }

  if (propose.length > 0) {
    msg += `\n【この内容で進めてよろしいですか】\n`;
    for (const f of propose) msg += `・${f.label}：${f.suggest}\n`;
  }

  msg += `\n──────────\n`;
  if (ask.length === 0 && !result.propertyUnknown) {
    // 全部提案で埋まっている＝「はい」だけで着手できる状態
    msg += `「はい」で確定します。変更があればその項目だけ教えてください。`;
  } else {
    msg += `このメッセージに返信する形でお答えください。\n`;
    msg += `未回答でもタスクは残ります`;
    if (remindNumber) msg += `（リマインド番号 ${remindNumber}）`;
    msg += `。`;
  }

  return msg;
}

/** 「はい」「OK」など、提案をそのまま承認する返事か */
export function isApproval(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[\s　！!。、.]/g, "");
  if (t.length > 12) return false; // 長文は具体的な指示とみなす
  // 末尾の「です／だ」は許すが、「か」は許さない。
  // 「大丈夫ですか」は承認ではなく問い返しなので、ここで弾く必要がある。
  return /^(はい|うん|ok|おけ|おっけー|よろしく|それで(いい|ok)?|大丈夫|問題ない|了解|りょうかい|りょかい|承知|お願いします?|オッケー|yes|y)(です|だ)?$/.test(
    t
  );
}

/**
 * 確認への「具体的な回答」を解釈する。
 *
 * なぜ必要か:
 *   実際の返事は「はい」だけではない。履歴でも社長の回答は
 *   「収益」「月曜日で可」のように**具体的な値**で返ってくる。
 *   さらに「買主の名義を仲介会社宛てに変えて」のように、
 *   **一度決まった内容を上書きする**指示も来る。
 *
 *   これを拾えないと、回答が新規タスクとして解析され、
 *   同じ依頼が二重に登録される（回答は元のタスクに届かない）。
 *
 * isAnswer=false のときは呼び出し側で通常のタスク解析に流すこと。
 * 確認待ちの最中に**別の新しい依頼**が飛んでくる場面は普通にあるため、
 * 「確認待ち中の発言はすべて回答」とみなしてはいけない。
 */
export interface AnswerResult {
  isAnswer: boolean;
  confidence: number;
  /** key -> 確定値 */
  updates: Record<string, string>;
  /** 既に決まっていた値を上書きした key */
  overrides: string[];
  /** 依頼内容そのものの変更（項目に収まらない指示）があれば、その要約 */
  amendment: string | null;
}

const ANSWER_PROMPT = `あなたは不動産会社の営業事務です。
「条件を確認中のタスク」があり、そこへ新しい発言が届きました。
この発言が**その確認への回答か**、それとも**無関係な別の依頼か**を判定してください。

判定の指針：
- 確認項目のどれかに値を与えている、または既に決まっていた値を変更する指示なら「回答」
- 「〜に変えて」「〜ではなく〜で」は、**既存の値を上書きする回答**として扱う
- 確認項目と関係のない新しい依頼・別物件の話・雑談は「回答ではない」
- 迷ったら isAnswer は false にする（誤って回答扱いにすると、新しい依頼が失われる）

確認項目に収まらないが依頼内容の修正にあたる指示（宛先の変更、書式の指定など）は
amendment に日本語の要約で入れてください。

必ず次のJSONのみを返してください（説明文やコードフェンスは付けない）：
{
  "isAnswer": true/false,
  "confidence": 0〜1の数値,
  "updates": { "項目key": "確定した値" },
  "overrides": ["上書きした項目key"],
  "amendment": "項目に収まらない修正指示の要約 または null"
}`;

export async function interpretAnswer(
  text: string,
  fields: RequiredField[],
  settled: Record<string, string>,
  taskTitle: string
): Promise<AnswerResult> {
  const miss: AnswerResult = {
    isAnswer: false,
    confidence: 0,
    updates: {},
    overrides: [],
    amendment: null,
  };
  if (!text.trim() || fields.length === 0) return miss;

  const list = fields
    .map((f) => {
      const cur = settled[f.key];
      return `- ${f.key}: ${f.label}${cur ? `（現在の値: ${cur}）` : "（未定）"}`;
    })
    .join("\n");

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: ANSWER_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `確認中のタスク: ${taskTitle}\n\n` +
            `確認項目:\n${list}\n\n` +
            `届いた発言:\n${text}`,
        },
      ],
    });

    const raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("")
      .replace(/```json\s*|```/g, "")
      .trim();

    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return miss;
    const parsed = JSON.parse(m[0]) as Partial<AnswerResult>;

    return {
      isAnswer: Boolean(parsed.isAnswer),
      confidence: Number(parsed.confidence ?? 0),
      updates: parsed.updates ?? {},
      overrides: parsed.overrides ?? [],
      amendment: parsed.amendment ?? null,
    };
  } catch (err) {
    // 失敗時は「回答ではない」に倒す。通常のタスク解析へ流れるので、
    // 最悪でも新規タスクとして残る。黙って消えるより手戻りが小さい。
    console.error("[clarify] 回答の解釈に失敗（通常解析へ）:", err);
    return miss;
  }
}

/** 回答が反映された結果をLINEに返す文面 */
export function buildAnswerAppliedMessage(
  taskTitle: string,
  applied: string[],
  overridden: string[],
  amendment: string | null,
  remaining: string[]
): string {
  let msg = `📝 「${taskTitle}」に反映しました。\n`;
  if (applied.length > 0) {
    msg += `\n【確定】\n` + applied.map((a) => `・${a}`).join("\n") + `\n`;
  }
  if (overridden.length > 0) {
    msg += `\n🔄 変更：${overridden.join("・")}\n`;
  }
  if (amendment) {
    msg += `\n📌 ${amendment}\n`;
  }
  if (remaining.length > 0) {
    msg +=
      `\n【残りのご指示待ち】\n` +
      remaining.map((r) => `・${r}`).join("\n") +
      `\n\nこちらが決まり次第、着手します。`;
  } else {
    msg += `\n✅ 条件が揃いました。着手できる状態にしました。`;
  }
  return msg;
}
