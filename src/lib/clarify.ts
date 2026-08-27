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

export type { RequiredField } from "./checklist.generated";
import { CHECKLIST, DERIVE_RULES, type RequiredField } from "./checklist.generated";

/**
 * 確認項目の定義は docs/依頼チェックリスト.md（正本）にある。
 * ビルド時に checklist.generated.ts へ焼き込まれる。項目を足したいときは
 * .md の表に1行足して `npm run build:checklist` を実行する。
 */

/**
 * 決まった項目から自動的に決まる項目を埋める。
 *
 * 「うちで買う」と答えた直後に「買主様のお名前は？」と聞き返すのを防ぐ。
 * 答えれば分かることを聞き返すのが、コミュニケーションコストの正体なので、
 * ここで潰しておく。ルールは docs/依頼チェックリスト.md の「自動補完ルール」。
 *
 * @returns 自動で埋まった key の一覧
 */
export function applyDerivedValues(settled: Record<string, string>): string[] {
  const filled: string[] = [];
  // ルール適用でさらに別のルールが成立することがあるので、変化が止まるまで回す
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const r of DERIVE_RULES) {
      const src = settled[r.when];
      if (!src || !src.includes(r.contains)) continue;
      if (settled[r.set]) continue; // 既に値があるものは上書きしない
      settled[r.set] = r.value;
      filled.push(r.set);
      changed = true;
    }
    if (!changed) break;
  }
  return filled;
}

const WD = ["日", "月", "火", "水", "木", "金", "土"];

/** "2026-08-28" → "8/28（金）"。LINEに出す日付は読める形にする */
export function jpDate(iso: string): string {
  const m = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const d = new Date(`${m[0]}T00:00:00Z`);
  return `${Number(m[2])}/${Number(m[3])}（${WD[d.getUTCDay()]}）`;
}

/** 提案文の {期日} を実際の日付に置き換える */
export function fillPlaceholders(
  fields: RequiredField[],
  vars: { 期日?: string }
): RequiredField[] {
  const resolved: Record<string, string> = {};
  if (vars.期日) resolved["期日"] = jpDate(vars.期日);
  return fields.map((f) => {
    if (!f.suggest) return f;
    let v = f.suggest;
    for (const [k, val] of Object.entries(resolved)) {
      v = v.replaceAll(`{${k}}`, val);
    }
    return v === f.suggest ? f : { ...f, suggest: v };
  });
}

export function checklistFor(type: RequestType): RequiredField[] {
  return CHECKLIST[type] ?? CHECKLIST["その他"] ?? [];
}

export interface ClarifyResult {
  /** 不足している項目（critical を先頭に並べ替え済み） */
  missing: RequiredField[];
  /** メッセージ・添付から読み取れた条件（メモに残す） */
  found: Record<string, string>;
  /** 物件が特定できていないか（種別によらず初動を止める最大要因） */
  propertyUnknown: boolean;
  /**
   * 条件の判定そのものに失敗したか。
   *
   * true のときを「不足なし＝着手可能」と同じ扱いにしてはいけない。
   * 判定できていないだけで、条件が揃っている保証はどこにも無い。
   * タスクの登録は続行（fail-open）しつつ、状態は要確認に倒す。
   */
  failed: boolean;
}

/** 根拠が原文にあるかを見るための正規化（全半角・空白・記号の揺れを吸収） */
function normalizeForMatch(s: string): string {
  return (s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]/g, "")
    .replace(/[「」『』（）()、。,.・:：]/g, "");
}

const EXTRACT_PROMPT = `あなたは不動産会社の営業事務です。
依頼メッセージから、指定された確認項目それぞれについて
**依頼者が実際に書いた内容だけ**を抜き出してください。

判定の基準：
- 依頼文（または添付）に**書かれている値だけ**を found に入れる
- **【必須】と付いた項目は、はっきり書かれていない限り絶対に found に入れない。**
  「たぶんこうだろう」で埋めてはいけない。ここを推測で埋めると、
  担当者が間違った前提のまま作業して事故になる
- 業界の常識・一般的なケース・確率の高さを根拠に補完しない
- 値が「不明」「未定」「なし」しか書けない項目は found に入れない

例：「この物件の査定お願い」だけの場合、査定の前提（更地か収益か実需か）は
**書かれていない**。found に入れず missing に入れること。

必ず次のJSONのみを返してください（説明文やコードフェンスは付けない）：
{
  "found": {
    "項目key": { "value": "読み取れた値", "evidence": "そう読み取れる根拠になった原文の一部をそのまま抜き出す" }
  }
}
evidence は**依頼文に実在する文字列をそのまま**入れてください。要約・言い換え・
自分で書いた文は不可です。添付から読み取った場合は evidence に "添付" と書いてください。
読み取れなかった項目は found に入れないでください（missing は返さなくて構いません）。`;

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
  attachments: unknown[] = [],
  /** 標準納期から決めた期日。提案文の {期日} に入る */
  dueDate?: string
): Promise<ClarifyResult> {
  const fields = fillPlaceholders(checklistFor(type), { 期日: dueDate });
  const propertyUnknown = !propertyName;

  if (fields.length === 0) {
    return { missing: [], found: {}, propertyUnknown, failed: false };
  }

  const list = fields
    .map((f) => `- ${f.key}: ${f.label}${f.critical ? "  【必須】" : ""}`)
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

    // JSON以外の前置き・後書きが混ざることがある。そのまま parse すると
    // 例外になり、fail-open で「不足なし」＝確認機能が黙って無効になる。
    // 中括弧の範囲だけを取り出す（interpretAnswer と同じ扱い）。
    const j = raw.match(/\{[\s\S]*\}/);
    if (!j) {
      console.error("[clarify] JSONを取り出せなかった:", raw.slice(0, 200));
      return { missing: [], found: {}, propertyUnknown, failed: true };
    }
    const parsed = JSON.parse(j[0]) as {
      found?: Record<string, { value?: string; evidence?: string } | string>;
    };

    // 不足は **found から機械的に決める**。モデルが返す missing をそのまま使うと、
    // 同じ依頼文でも判定が揺れた（「査定の前提は文脈で分かる」と判断して
    // missing から落とす回があった）。突き合わせはこちらで行う。
    const haystack = normalizeForMatch(text);
    const found: Record<string, string> = {};

    for (const [k, raw] of Object.entries(parsed.found ?? {})) {
      const v = typeof raw === "string" ? { value: raw, evidence: "" } : raw ?? {};
      const val = String(v.value ?? "").trim();
      // 「不明」「なし」等を値として返してくることがある。埋まっていない扱いにする
      if (!val || /^(不明|未定|なし|null|-|—)$/.test(val)) continue;

      const field = fields.find((f) => f.key === k);
      // 必須項目は**原文に根拠がある場合だけ**採用する。
      // 業界の常識から推測して埋められると、担当者が誤った前提で動いて事故になる。
      // （検証で「この物件の査定お願い」から前提を「実需」と断定する事例を確認）
      if (field?.critical) {
        const ev = String(v.evidence ?? "").trim();
        const fromAttachment = attachments.length > 0 && /添付|画像|pdf|資料/i.test(ev);
        if (!fromAttachment && !(ev && haystack.includes(normalizeForMatch(ev)))) {
          console.warn(`[clarify] 必須項目 ${k} を原文の根拠なしと判断して不足に戻した`);
          continue;
        }
      }
      found[k] = val;
    }

    const missing = fields
      .filter((f) => !(f.key in found))
      // critical を先に出す。答えるのが1つだけでも前に進むようにする
      .sort((a, b) => Number(b.critical) - Number(a.critical));

    return { missing, found, propertyUnknown, failed: false };
  } catch (err) {
    // 登録は止めない（タスクを失わないことが最優先）。ただし「条件が揃った」とは
    // 扱わない。failed=true を見て呼び出し側が要確認に倒す。
    console.error("[clarify] 不足項目の判定に失敗:", err);
    return { missing: [], found: {}, propertyUnknown, failed: true };
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
  /** この発言が確認中のタスクに関するものだという確信度（値の解釈の確度ではない） */
  /**
   * これは確認中のタスクとは別の、新しい依頼か。
   *
   * isAnswer とは独立に聞く。以前は「updates か amendment があれば回答」と
   * 補正していたが、モデルが新規依頼から期限などを拾って updates に入れた場合、
   * **新しい依頼が確認への回答として吸い込まれて消える**。
   * 新規依頼の取りこぼしは、確認の取りこぼしより遥かに損害が大きい。
   */
  isNewRequest: boolean;
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

confidence は**「確認中のタスクに関する発言かどうか」の確信度**です。
指示の中身の解釈に迷う場合でも、そのタスクについての発言だと分かるなら高い値にしてください
（解釈の迷いは amendment の末尾に「（要確認）」と書いて表現します）。

**isNewRequest** を必ず判定してください。この発言が「確認中のタスクとは別の、
新しくやってほしいこと」を含むなら true です。別物件の話、別種類の作業依頼、
「別件だけど」で始まるものは true。true のときは updates を空にしてください。

確認項目に収まらないが**そのタスクの内容を修正する指示**（宛先の変更、書式の指定など）は
amendment に日本語の要約で入れてください。
**amendment を入れる場合は isAnswer を必ず true にしてください。**
それはそのタスクへの指示であって、新しい依頼ではないためです。

amendment はそのままLINEで社長に返信されます。**40字以内の日本語**で、
項目のkey（英字）や理由の説明は書かず、何をどう変えるかだけを書いてください。
指示が曖昧で二通りに読める場合は、末尾に「（要確認）」と付けてください。

必ず次のJSONのみを返してください（説明文やコードフェンスは付けない）：
{
  "isAnswer": true/false,
  "isNewRequest": true/false,
  "confidence": 0〜1の数値,   // 「この発言が確認中のタスクに関するものだ」という確信度。
                            // 値の解釈が曖昧でも、そのタスクの話だと分かるなら高くする
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
    isNewRequest: false,
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
    const isNewRequest = Boolean(parsed.isNewRequest);

    // 新しい依頼と判定されたものは、何があっても回答として扱わない。
    // ここで吸い込むと依頼そのものが消える（登録もされない）。
    if (isNewRequest) {
      return { ...miss, isNewRequest: true, confidence: Number(parsed.confidence ?? 0) };
    }

    const amendment = parsed.amendment ?? null;

    // 「回答ではない」と明示されたものは尊重する。
    //
    // 以前は updates が入っていれば回答として拾い直していたが、
    // {isAnswer:false, confidence:0.2, updates:{deadline:"明日"}} のような
    // **新しい依頼から期限だけ拾った応答**まで回答に化けて、
    // 元の依頼が登録されずに消えていた。
    //
    // 拾い直すのは amendment がある場合だけにする。amendment は定義上
    // 「このタスクへの修正指示」なので、別依頼と取り違える余地が小さい。
    const isAnswer = Boolean(parsed.isAnswer) || Boolean(amendment);
    const raised = !parsed.isAnswer && Boolean(amendment);

    return {
      isAnswer,
      isNewRequest: false,
      confidence: raised
        ? Math.max(Number(parsed.confidence ?? 0), 0.7)
        : Number(parsed.confidence ?? 0),
      // 回答でないものの updates は捨てる。呼び出し側へ渡すと事故の元になる
      updates: isAnswer ? parsed.updates ?? {} : {},
      overrides: isAnswer ? parsed.overrides ?? [] : [],
      amendment,
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

/**
 * 条件が揃ったタスクを担当者へ引き渡すメッセージ。
 *
 * ここがこの仕組みの出口。社長とのやりとりで要件を詰めたあと、
 * **担当者にメンションを飛ばして「この条件で着手してください」まで持っていく**。
 * ここが無いと、条件は揃ったのに誰も気づかないまま止まる。
 *
 * @returns text は {assignee} を含む。呼び出し側で substitution に userId を渡す
 */
export function buildHandoffMessage(
  taskTitle: string,
  propertyName: string | null,
  settled: Record<string, string>,
  fields: RequiredField[],
  assigneeName: string | null,
  hasMention: boolean
): string {
  const labelOf = (k: string) => fields.find((f) => f.key === k)?.label ?? k;

  let msg = hasMention ? "{assignee}\n" : "";
  msg += `✅ 条件が固まりました。着手をお願いします。\n\n`;
  msg += `【${taskTitle}】\n`;
  if (propertyName) msg += `物件：${propertyName}\n`;
  if (!hasMention && assigneeName) msg += `担当：${assigneeName}\n`;

  // .md の並び順で出す。社長が答えた順に出すと毎回並びが変わって読みにくい
  const ordered = fields.filter((f) => settled[f.key]);
  if (ordered.length > 0) {
    msg += `\n`;
    for (const f of ordered) msg += `・${f.label}：${settled[f.key]}\n`;
  }
  msg += `\n──────────\n終わったら番号で返信してください。`;
  return msg;
}

/**
 * 確認待ちタスクに回答を適用する **純粋関数**。
 *
 * webhook の中に直接書いていたときは、テストが同じ処理を書き写す形になり
 * 「テストは通るが本番は別物」という状態だった。ここに出して両方から使う。
 *
 * 完了条件の判断もここに集約する。呼び出し側で判定を書くと、
 * 承認パスと回答パスで条件がずれる（実際に、回答パスだけ提案分を
 * settled に入れ忘れて引き渡し文が歯抜けになっていた）。
 */
export interface PendingState {
  fields: RequiredField[];
  awaitingKeys: string[];
  proposalKeys: string[];
  settled: Record<string, string>;
}

export interface ApplyResult {
  /** 「項目名：値」の形。返信に出す */
  applied: string[];
  /** 自動補完で埋まった項目名 */
  derived: string[];
  /** まだ指示待ちの項目名 */
  remaining: string[];
  /** 条件が揃い、担当者へ引き渡せる状態か */
  complete: boolean;
}

function labelIn(fields: RequiredField[], key: string): string {
  return fields.find((f) => f.key === key)?.label ?? key;
}

/** 提案をすべて承認したときの適用（「はい」への応答） */
export function applyApproval(p: PendingState): ApplyResult {
  const applied: string[] = [];
  for (const k of p.proposalKeys) {
    const f = p.fields.find((x) => x.key === k);
    if (!f?.suggest) continue;
    p.settled[k] = f.suggest;
    applied.push(`${f.label}：${f.suggest}`);
  }
  p.proposalKeys = [];
  return finish(p, applied, []);
}

/** 具体的な回答の適用（項目の指定・上書き） */
export function applyAnswer(
  p: PendingState,
  updates: Record<string, string>
): ApplyResult {
  const applied: string[] = [];
  for (const [k, raw] of Object.entries(updates)) {
    // 定義に無いキーを書き込ませない。モデルが勝手なキーを返しても
    // settled が汚れないようにする
    if (!p.fields.some((f) => f.key === k)) continue;
    // 空文字や「不明」で必須項目が埋まったことにしない。
    // 埋まった扱いになると awaitingKeys から外れ、値が無いまま
    // 「条件が揃った」と判断されて担当者へ流れてしまう。
    const v = String(raw ?? "").trim();
    if (!v || /^(不明|未定|なし|null|-|—|\?|？)$/.test(v)) continue;
    p.settled[k] = v;
    p.awaitingKeys = p.awaitingKeys.filter((x) => x !== k);
    p.proposalKeys = p.proposalKeys.filter((x) => x !== k);
    applied.push(`${labelIn(p.fields, k)}：${v}`);
  }
  const derived: string[] = [];
  for (const k of applyDerivedValues(p.settled)) {
    p.awaitingKeys = p.awaitingKeys.filter((x) => x !== k);
    p.proposalKeys = p.proposalKeys.filter((x) => x !== k);
    derived.push(`${labelIn(p.fields, k)}：${p.settled[k]}`);
  }
  return finish(p, applied, derived);
}

/**
 * 完了判定と、完了時の提案値の確定。
 *
 * 指示待ちが無くなった時点で、未承認のまま残っている提案を settled に入れる。
 * ここをやらないと、引き渡し文に手付金や決済日が出ず、担当者は結局
 * 社長に聞き直すことになる（この仕組みが無意味になる）。
 */
function finish(
  p: PendingState,
  applied: string[],
  derived: string[]
): ApplyResult {
  const complete = p.awaitingKeys.length === 0;
  if (complete && p.proposalKeys.length > 0) {
    for (const k of p.proposalKeys) {
      const f = p.fields.find((x) => x.key === k);
      if (f?.suggest && !p.settled[k]) {
        p.settled[k] = f.suggest;
        applied.push(`${f.label}：${f.suggest}`);
      }
    }
    p.proposalKeys = [];
  }
  return {
    applied,
    derived,
    remaining: p.awaitingKeys.map((k) => labelIn(p.fields, k)),
    complete,
  };
}

/** 物件が特定できていないときに足す確認項目（種別によらず初動を止めるため） */
export const PROPERTY_FIELD: RequiredField = {
  key: "property",
  label: "対象の物件",
  suggest: null,
  critical: true,
};
