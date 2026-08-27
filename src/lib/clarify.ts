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
