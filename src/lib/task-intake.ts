/**
 * 新規タスク受付の入口判定。
 *
 * LINEグループの通常会話をAIが拾わないよう、新規受付はAI秘書への
 * 明示メンションを必須にする。社員へのメンションは担当指定としてだけ使う。
 */
export interface MentioneeLike {
  type: "user" | "all";
  userId?: string;
  index?: number;
  length?: number;
}

export function taskMentionState(
  mentionees: MentioneeLike[] | undefined,
  botUserId: string | undefined
): {
  mentionsBot: boolean;
  mentionsAssignee: boolean;
} {
  const list = mentionees ?? [];
  const mentionsBot = Boolean(
    botUserId &&
      list.some((m) => m.type === "user" && m.userId === botUserId)
  );
  const mentionsAssignee = list.some(
    (m) => m.type === "user" && m.userId !== botUserId
  );
  return { mentionsBot, mentionsAssignee };
}

/**
 * 「お願いします」だけで対象も作業も分からない依頼か。
 * 添付がある場合は添付が依頼内容なので、呼び出し側でこの判定を使わない。
 */
export function isContextlessRequest(text: string): boolean {
  const t = (text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000。、,.!！?？「」『』（）()]/g, "");
  if (!t) return true;
  return /^(これ|こちら|この件)?(の)?(対応)?(を)?(お願い(します|いたします|できますか)?|よろしく(お願い(します|いたします)?)?)$/.test(
    t
  );
}

/**
 * メールの下書きを作ってよい発言か。
 * グループでは @AI秘書 のメンションがある発言だけ（社員どうしの「送っといて」に反応しない）。
 * 1対1のトークはメンション不要のまま。
 */
export function emailIntakeAllowed(opts: { isGroup: boolean; mentionsBot: boolean }): boolean {
  return !opts.isGroup || opts.mentionsBot;
}

// ── 受け付けなかった理由のログと返事（2026-11-13） ──
// @秘書 あてなのに Notion に入らず、黙って終わる道が3つあった（メンションと認識されない／
// タスクでない・確信度 0.5 未満／確信度 0.5〜0.7 で候補にも控えない）。理由が分からないので、
// 枝ごとに理由の符号だけのログを1行出し、@秘書 あてと分かるときは短く返事をする。
// ログに本文・userId・groupId・名前は出さない（符号だけ）。

export type TaskIntakeCode =
  | "mention-none" // @秘書 のメンションが無い（ふつうの会話。返事はしない）
  | "typed-mention" // 「@秘書」と手で打っただけで、メンションになっていない
  | "not-task" // AI がタスクでないと判定
  | "low-conf" // タスクらしいが確信度が候補の下限（0.5）未満
  | "candidate-skip" // 確信度は候補の範囲だが、候補に控えなかった（スイッチ off・対象外など）
  | "candidate-saved" // 候補に控えた（今までどおり。返事は候補の仕組みに任せる）
  | "registered"; // Notion に登録した

export const MSG_INTAKE_NOT_REGISTERED =
  "タスクとしては受け付けませんでした。\n期限や担当を書き足して、もう一度 @秘書 を付けて送ってください。";

export const MSG_INTAKE_TYPED_MENTION =
  "AI秘書へのメンションになっていなかったため、受け付けていません。\n「@」を入力して出てくる一覧から AI秘書 を選んで、もう一度送ってください。";

export function logTaskIntake(
  code: TaskIntakeCode,
  log: (line: string) => void = (l) => console.log(l)
): void {
  log(`[task-intake] ${code}`);
}

/** @秘書 あての発言を登録しなかった理由（確信度がしきい値に届かなかったとき）。候補に控えたかは別に決める */
export function unregisteredReason(
  parsed: { isTask: boolean; confidence: number },
  candidateMinConfidence: number
): "not-task" | "low-conf" | "candidate-range" {
  if (!parsed.isTask) return "not-task";
  if (parsed.confidence < candidateMinConfidence) return "low-conf";
  return "candidate-range";
}

/**
 * 本文に「@秘書」「@AI秘書」を手で打っただけで、メンションの印（mentionees）が付いていないか。
 * 本物のメンションの範囲（index〜index+length）に重なる「@…秘書」は数えない
 * （ボットの userId の設定違いで認識できなかった本物のメンションを、手打ちと取り違えない）。
 * 「@秘書課」のように漢字が続くものは別の言葉として数えない。
 */
export function hasTypedBotMention(
  rawText: string | undefined,
  mentionees: MentioneeLike[] | undefined
): boolean {
  const t = rawText ?? "";
  const ranges = (mentionees ?? [])
    .filter((m) => typeof m.index === "number" && typeof m.length === "number")
    .map((m) => [m.index as number, (m.index as number) + (m.length as number)] as const);
  const re = /[@＠](?:[AaＡａ][IiＩｉ])?秘書(?![\u3400-\u4DBF\u4E00-\u9FFF])/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(t)) !== null) {
    const at = hit.index;
    const end = at + hit[0].length;
    if (!ranges.some(([s, e]) => at < e && end > s)) return true;
  }
  return false;
}

type Send = (replyToken: string, text: string) => Promise<unknown>;

async function safeReply(send: Send, replyToken: string, text: string, log: (l: string) => void) {
  try {
    await send(replyToken, text);
  } catch {
    log("[task-intake] reply-failed");
  }
}

/**
 * @秘書 のメンションが認識されなかった発言の後始末（route.ts の「メンションなし」の枝の最後）。
 * グループで「@秘書」を手打ちしただけのときだけ、選び方を返す。ふつうの会話には返事をしない。
 * 候補のその場の返事で replyToken を使ったときは返さない（1回しか使えない）。
 */
export async function finishNoBotMention(o: {
  isGroup: boolean;
  typedMention: boolean;
  replyTokenUsed: boolean;
  replyToken: string;
  send: Send;
  log?: (line: string) => void;
}): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  if (o.isGroup && o.typedMention) {
    logTaskIntake("typed-mention", log);
    if (!o.replyTokenUsed) await safeReply(o.send, o.replyToken, MSG_INTAKE_TYPED_MENTION, log);
    return;
  }
  logTaskIntake("mention-none", log);
}

/**
 * @秘書 あての発言を登録しなかったときの後始末（確信度がしきい値に届かなかった枝の最後）。
 * 候補に控えたときは今までどおり（返事は候補の仕組みに任せる）。それ以外は受け付けなかったことを返す。
 */
export async function finishUnregisteredIntake(o: {
  code: "not-task" | "low-conf" | "candidate-skip" | "candidate-saved";
  replyToken: string;
  send: Send;
  log?: (line: string) => void;
}): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  logTaskIntake(o.code, log);
  if (o.code === "candidate-saved") return;
  await safeReply(o.send, o.replyToken, MSG_INTAKE_NOT_REGISTERED, log);
}
