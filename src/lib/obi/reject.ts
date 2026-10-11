/**
 * 帯替えの差し戻しの「対応を番号で選ぶ」（設計 2026-10-11 の E12・E14・「うまくいかないとき」）。
 *
 * 呼ぶのは webhook-event.ts。何をするか（plan）は reject-plan.ts が、portal の resolve の答えから決める。
 *   locateObiChoiceWord … 言葉の返事（「OK」「9」）が、どの依頼への何の返事かを決める（イベントの予約より前。portal は何も書き換えない）
 *     - 引用つき（#J なし）：引用先を resolve。確認の知らせ（kind: review）への引用のときだけ扱う
 *     - #J つき           ：その番号を resolve。確認待ち（phase: review）のときだけ扱う。「#J4 9」は、確認待ちでなければ断る：
 *                           phase が fix で完成品があれば /reject（rechoose）に渡して portal に断らせ（受付を止めていれば
 *                           CHOICE_DISABLED の固定の文。裁定 V7）、それ以外は portal を呼ばずに「いまその操作ができない状態です」
 *     - 引けない・確かめられない・ほかの知らせ：返事も予約もせず、今までの流れへ
 *     番号の返事（1〜4・0）の対象は、今までどおり fix.ts の locateObiFix が決める
 *   runObiReject … 認可 → portal の /reject（1回だけ）→ 返事
 *
 * 認可は呼ぶ側が済ませ、ここには「許可されたか」の真偽だけが来る（userId は受け取らない。
 * portal・KV・ログ・返事のどこにも出さない）。許可されていなければ /reject は呼ばない。
 *
 * portal を呼ぶのは1通につき resolve 1回＋reject 1回まで（「番号で直す」と同じ。同じ Webhook の中での呼び直しはしない）。
 * 時間も「番号で直す」と同じ予算（fix.ts の定数をそのまま使う）：Webhook の開始から25秒。
 *   返事より前の段階（resolve・reject・返事の印）は開始+17秒までに終える。
 *   reject の時間は min(8秒, 開始+17秒−今−返事の印の1秒)。2秒に満たなければ reject を呼ばない。
 *
 * 返事は1通につき1回。印は「番号で直す」と同じかぎ（`obi-fix-replied:<id>`・結果不明は `obi-fix-pending-notified:<id>`・
 * 断りは `obi-fix-forbidden:<id>`。NX・8日）。同じ発言が訂正と選択の両方の返事を受けることは無い（1通は1つの枝だけを通る）。
 *
 * LINE の Webhook の再送は本番で無効。どの場面でも 503 を返さない（「番号で直す」の AA1 と同じ分け方）。
 *
 * ログに出すのは、処理の段階・受付番号（#J）・action・番号・結果の code・返事の結果だけ。
 * message.id・userId・groupId・本文・リンク・例外の文は出さない。
 */
import type { FixTarget, ObiFixDeps, ObiFixInput, ObiFixStageHooks } from "./fix";
import {
  errName,
  FIX_MIN_MS,
  FIX_MS,
  KV_OP_MS,
  OBI_FIX_MESSAGES,
  OBI_FIX_PORTAL_PHASE_END_MS,
  portalOpts,
  RESOLVE_MS,
  sayOnce,
  unknownTarget,
  type Said,
} from "./fix";
import { OBI_MESSAGES } from "./intake";
import { postFixResolve, postReject, type RejectOutcome } from "./portal";
import type { ChoiceWordBody } from "./reject-parse";
import { planNumberedWord, planQuotedWord, type ChoicePlan } from "./reject-plan";
import { sanitizeForReply } from "./sanitize";

/** 文は設計 2026-10-11 の E14「aisecretary がその場で返す」の表のとおり（unreachable・unknown・rejected は「番号で直す」の文に合わせたもの） */
export const OBI_REJECT_MESSAGES = {
  queuedBandOnly: (no: number) => `#J${no} 帯だけ替えて仕上げます。できたら、ここに確認用のリンクを出します`,
  queuedAi: (no: number) => `#J${no} AI に読ませて仕上げます。できたら、ここに確認用のリンクを出します`,
  human: (no: number) => `#J${no} 担当が確認します`,
  canceled: (no: number) => `#J${no} を取り消しました`,
  approved: (no: number) => `#J${no} を完成にしました。納品の準備ができしだい、ここにリンクを送ります`,
  reopened: (no: number) => `#J${no} 対応を選び直せます。次の知らせに番号で返信してください`,
  /** 出していない番号（CHOICE_NOT_OFFERED）。choices は portal の断りに付いてきた「今出している番号」 */
  notOffered: (no: number, choices: number[]) => `#J${no} で選べるのは ${choices.join("・")} です`,
  /** OK が関門を通らない（GATE_FAILED）。理由の符号（residue など）は文に出さない */
  gateFailed: (no: number) => `#J${no} は LINE では完成にできません。担当が確認します`,
  forbidden: "対応の選択は、帯替えを依頼できる方からお願いします",
  stale: "その知らせは古くなっています。新しい知らせに返信してください",
  unavailable: (no: number) => `#J${no} はいまその操作ができない状態です`,
  /** 受付を止めている（CHOICE_DISABLED。スイッチ off・スイッチを切った後の再送。裁定 U2 の固定の文。受付番号は付けない） */
  disabled: "いま受付を止めています。portal の依頼ボックスを確認してください",
  rejected: (code: string) => `対応を受け付けられませんでした（${code}）。担当に声をかけてください`,
  /** 送っていないことが確か（/reject を呼ぶ前の失敗・つなぐ前の失敗）。何も変わっていないので、送り直してよい */
  unreachable: "対応を受け付けられませんでした（portal に届きません）。少し待ってからもう一度送ってください",
  /** /reject の結果が分からない。「もう一度送ってください」とは書かない（送り直すと別の発言になり、二重の選択になりうる） */
  unknown:
    "受付の結果を確かめられませんでした。届く知らせか portal の依頼ボックスで確かめてください。同じ返信をもう一度送らないでください",
};

export type ObiRejectInput = Pick<ObiFixInput, "messageId" | "allowed" | "startedAt" | "config">;

export interface ObiRejectTarget {
  no: number;
  /** null＝「#J4 9」で、確認待ちでなく、portal にも確かめない（選択待ち・完成品が無いなど。断りの文だけ返す。portal は呼ばない） */
  plan: ChoicePlan | null;
}

export interface ObiRejectResult {
  outcome:
    | "queued"
    | "human"
    | "canceled"
    | "approved"
    | "reopened"
    | "forbidden"
    | "refused"
    /** /reject を呼んだが、結果が分からない（「確かめられませんでした」を1回返した） */
    | "unknown";
}

/** /reject が受け付けた結果 → 文 */
function acceptedMessage(no: number, o: Extract<RejectOutcome, { kind: "accepted" }>): string {
  if (o.result === "queued") return o.choice === 2 ? OBI_REJECT_MESSAGES.queuedAi(no) : OBI_REJECT_MESSAGES.queuedBandOnly(no);
  if (o.result === "human") return OBI_REJECT_MESSAGES.human(no);
  if (o.result === "canceled") return OBI_REJECT_MESSAGES.canceled(no);
  if (o.result === "approved") return OBI_REJECT_MESSAGES.approved(no);
  return OBI_REJECT_MESSAGES.reopened(no);
}

export interface ObiChoiceWordInput {
  word: ChoiceWordBody;
  /** 引用リプライの引用先（無ければ null） */
  quotedMessageId: string | null;
  /** Webhook の開始時刻（ms） */
  startedAt: number;
  config: ObiFixInput["config"];
}

/**
 * 言葉の返事（「OK」「9」「#J4 OK」「#J4 9」）が、どの依頼への何の返事かを決める（イベントの予約より前に呼ぶ）。
 * 認可はここでは見ない（確認の知らせへの返事かどうかが分かるまで「選択」と決められないため。resolve は何も書き換えない）。
 * KV は呼ばない（聞き返しへの引用は番号の形だけ）。portal は resolve を1回だけ。
 *
 * **グループで普通に飛び交う「OK」を横取りしない**：扱うのは、portal が「確認の知らせへの引用」（kind: review）か
 * 「確認待ちの依頼」（phase: review）と答えたときだけ。引けない（NOT_FOUND・FIX_DISABLED など）・確かめられない
 * （時間切れ・つながらない・5xx）ときは、返事も予約もせず今までの流れへ渡す。
 */
export async function locateObiChoiceWord(input: ObiChoiceWordInput, deps: ObiFixDeps): Promise<FixTarget> {
  const { no } = input.word;
  const quoted = input.quotedMessageId;
  if (no === null && (!quoted || !/^\d{1,64}$/.test(quoted))) return { kind: "rest", reason: "no-quote" };
  // #J0：受付番号は1以上（portal に聞くまでもない）。今までの流れへ
  if (no === 0) return { kind: "rest", reason: "no-zero" };

  const timeoutMs = Math.min(RESOLVE_MS, input.startedAt + OBI_FIX_PORTAL_PHASE_END_MS - deps.now());
  if (timeoutMs <= 0) return unknownTarget("no-time");
  const groupId = input.config.groupId;
  const r = await postFixResolve(
    no !== null ? { groupId, no } : { groupId, quotedMessageId: quoted as string },
    portalOpts(input, deps, timeoutMs)
  );
  if (r.kind === "accepted") {
    if (no !== null) {
      // 頼んだ番号と違う依頼が返った：形の違う応答と同じ（確かめられない）
      if (r.resolved.no !== no) return unknownTarget("no-mismatch");
      const d = planNumberedWord(input.word.word, r.resolved);
      if (d.kind === "choice") return { kind: "choice", via: "number", no, plan: d.plan };
      if (d.kind === "unavailable") return { kind: "choice", via: "number", no, plan: null };
      return { kind: "rest", reason: d.reason };
    }
    const d = planQuotedWord(input.word.word, r.resolved);
    if (d.kind === "choice") return { kind: "choice", via: "notice", no: r.resolved.no, plan: d.plan };
    return { kind: "rest", reason: d.kind === "rest" ? d.reason : "word-not-review" };
  }
  if (r.kind === "rejected") {
    // NOT_FOUND＝タスクの確認など別のものへの「OK」。それ以外の断り（FIX_DISABLED など）も、帯替えの知らせ・依頼と確かめられていない
    //   FIX_DISABLED（「番号で直す」を止めているあいだ）は、ふつうの「OK」の引用のたびに出る＝異常ではないので log。ほかの code は error
    if (r.code === "FIX_DISABLED") console.log("帯替えの対応の選択：引けない（今までの流れへ）:", r.code);
    else if (r.code !== "NOT_FOUND") console.error("帯替えの対応の選択：引けない（今までの流れへ）:", sanitizeForReply(r.code));
    return { kind: "rest", reason: r.code };
  }
  return unknownTarget(r.kind === "unknown" ? r.reason : "unreachable");
}

/**
 * 受け付けた答えが、送った中身と合っているか（約束：choose の 1・2 は queued、3 は human、4 は canceled。
 * approve は approved、rechoose は reopened。choice は choose のときの番号、ほかは 0）。
 * 合わない答えは「形の違う応答」と同じ＝結果不明として扱う（違う文を返さない）
 */
function consistent(no: number, plan: ChoicePlan, o: Extract<RejectOutcome, { kind: "accepted" }>): boolean {
  if (o.no !== no || o.choice !== plan.choice) return false;
  if (plan.action === "approve") return o.result === "approved";
  if (plan.action === "rechoose") return o.result === "reopened";
  if (plan.choice === 3) return o.result === "human";
  if (plan.choice === 4) return o.result === "canceled";
  return o.result === "queued";
}

/** portal の断り（/reject）→ 文（設計 E14 の表） */
function rejectionMessage(no: number, o: Extract<RejectOutcome, { kind: "rejected" }>): string {
  switch (o.code) {
    case "CHOICE_DISABLED":
      return OBI_REJECT_MESSAGES.disabled;
    case "CHOICE_STALE":
      return OBI_REJECT_MESSAGES.stale;
    case "CHOICE_UNAVAILABLE":
      return OBI_REJECT_MESSAGES.unavailable(no);
    case "CHOICE_NOT_OFFERED":
      // 今出している番号が付いていない・1つも無い：並べる番号が無いので「いまその操作ができない状態です」
      return o.choices && o.choices.length > 0
        ? OBI_REJECT_MESSAGES.notOffered(no, o.choices)
        : OBI_REJECT_MESSAGES.unavailable(no);
    case "GATE_FAILED":
      return OBI_REJECT_MESSAGES.gateFailed(no);
    case "OBI_BUSY":
      return OBI_MESSAGES.busy(o.busyJobNo);
    case "INTAKE_STOPPED":
      return OBI_MESSAGES.stopped;
    case "NOT_FOUND":
      return OBI_FIX_MESSAGES.notFound(no);
    default:
      // CHOICE_MISMATCH・INVALID_REQUEST・UNAUTHORIZED など（本来起きない）。code は portal の本文から来るので整えてから出す
      return OBI_REJECT_MESSAGES.rejected(sanitizeForReply(o.code));
  }
}

/**
 * 選択と決まったイベントを最後まで扱う（イベントの予約の中で呼ぶ）。
 * どの結果でも、呼ぶ側はイベントを済みにする（やり直さない。503 にしない）。
 * onFixCalled：portal の /reject を呼ぶ直前／onCommitted：/reject の結果が確かになった（名前は「番号で直す」と共用）。
 */
export async function runObiReject(
  input: ObiRejectInput,
  target: ObiRejectTarget,
  deps: ObiFixDeps & ObiFixStageHooks
): Promise<ObiRejectResult> {
  const { messageId } = input;
  const groupId = input.config.groupId;
  const { no, plan } = target;
  const phaseEnd = input.startedAt + OBI_FIX_PORTAL_PHASE_END_MS;
  const repliedKey = `obi-fix-replied:${messageId}`;
  const log = (result: string, said: Said) =>
    console.log("帯替えの対応の選択:", `#J${no}`, `action=${plan?.action ?? "-"}`, `choice=${plan?.choice ?? "-"}`, result, said.delivery);
  const refuse = async (result: string, text: string): Promise<ObiRejectResult> => {
    log(result, await sayOnce(input, groupId, deps, repliedKey, text));
    return { outcome: "refused" };
  };

  // 認可（OK・9 も同じ）。許可されていなければ、/reject は呼ばない
  if (!input.allowed) {
    log("forbidden", await sayOnce(input, groupId, deps, `obi-fix-forbidden:${messageId}`, OBI_REJECT_MESSAGES.forbidden));
    return { outcome: "forbidden" };
  }

  // 「#J4 9」で確認待ちでなく、portal にも確かめない（plan が無い）：portal は呼ばない
  if (!plan) return refuse("not-review", OBI_REJECT_MESSAGES.unavailable(no));

  // reject（1回だけ）。返事の印の1秒を残して、開始+17秒までに終える
  const remaining = phaseEnd - deps.now() - KV_OP_MS;
  if (remaining < FIX_MIN_MS) return refuse("no-time", OBI_REJECT_MESSAGES.unreachable); // 送る前の失敗が確か
  deps.onFixCalled();
  const o = await postReject(
    no,
    { messageId, groupId, action: plan.action, choice: plan.choice, expectGen: plan.expectGen, expectSha256: plan.expectSha256 },
    portalOpts(input, deps, Math.min(FIX_MS, remaining))
  );
  if (o.kind === "accepted" && consistent(no, plan, o)) {
    deps.onCommitted();
    log(o.result, await sayOnce(input, groupId, deps, repliedKey, acceptedMessage(no, o)));
    return { outcome: o.result };
  }
  if (o.kind === "rejected") {
    deps.onCommitted();
    // GATE_FAILED の理由の符号はログにだけ出す（整えてから。改行・見えない文字を除き、40文字まで）
    const why = o.code === "GATE_FAILED" && o.reason ? `:${sanitizeForReply(o.reason)}` : "";
    return refuse(`${sanitizeForReply(o.code)}${why}`, rejectionMessage(no, o));
  }

  // 送っていないことが確かな失敗（postReject の unreachable＝ECONNREFUSED・ENOTFOUND・EAI_AGAIN。「番号で直す」の AB1 と同じ）。
  //    つなぐ前に失敗しているので、portal には何も届いていない＝何も変わっていない。結果不明ではない
  if (o.kind === "unreachable") {
    deps.onCommitted();
    return refuse("reject-unreachable", OBI_REJECT_MESSAGES.unreachable);
  }

  // /reject を呼んだ後、はっきりした答えが無く、届いたかどうかも分からない
  //    （時間切れ・応答の途中の切断・5xx・形の違う応答・送った中身と合わない答え）＝結果不明。
  //    「もう一度送ってください」とは言わない（人が送り直すと message.id が変わり、portal の冪等では二重の選択を防げない）。
  //    1回だけ知らせて、済みにする（やり直さない・503 にしない）。結果は、Mac の後の知らせか portal の依頼ボックスで分かる
  const why = o.kind === "accepted" ? "inconsistent" : o.reason;
  log(`unknown:${why}`, await sayOnce(input, groupId, deps, `obi-fix-pending-notified:${messageId}`, OBI_REJECT_MESSAGES.unknown));
  return { outcome: "unknown" };
}

/**
 * runObiReject が例外で止まったときの返事（webhook-event.ts が、予約を持ったまま呼ぶ。例外は外へ投げない）。
 *   before-call … /reject をまだ呼んでいない（#J つきだけ。引用の形は呼ぶ側が今までの流れへ渡す）。
 *                 何も変わっていないのが確かなので「…portal に届きません。少し待ってからもう一度送ってください」
 *   called      … /reject を呼んだが、答えを受け取る前に止まった。結果不明と同じ「受付の結果を確かめられませんでした…」
 * どちらも1通につき1回（NX）。この後、呼ぶ側はイベントを済みにする（503 にしない）
 */
export async function replyObiRejectInterrupted(
  input: Pick<ObiRejectInput, "messageId" | "startedAt" | "config">,
  stage: "before-call" | "called",
  deps: ObiFixDeps
): Promise<void> {
  const { messageId } = input;
  try {
    const said =
      stage === "before-call"
        ? await sayOnce(input, input.config.groupId, deps, `obi-fix-replied:${messageId}`, OBI_REJECT_MESSAGES.unreachable)
        : await sayOnce(input, input.config.groupId, deps, `obi-fix-pending-notified:${messageId}`, OBI_REJECT_MESSAGES.unknown);
    console.log("帯替えの対応の選択:", `interrupted:${stage}`, said.delivery);
  } catch (err) {
    console.error("帯替えの対応の選択：例外の後の返事を出せない:", stage, errName(err));
  }
}
