/**
 * 帯替えの差し戻しの「対応を番号で選ぶ」（設計 2026-10-11 の E12・E14・「うまくいかないとき」）。
 *
 * 呼ぶのは webhook-event.ts。何をするか（plan）は reject-plan.ts が、portal の resolve の答えから決めてある。
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
import type { ObiFixDeps, ObiFixInput, ObiFixStageHooks } from "./fix";
import { FIX_MS, KV_OP_MS, OBI_FIX_PORTAL_PHASE_END_MS, portalOpts, sayOnce, type Said } from "./fix";
import { postReject, type RejectOutcome } from "./portal";
import type { ChoicePlan } from "./reject-plan";

/** 文は設計 2026-10-11 の E14「aisecretary がその場で返す」の表のとおり（unreachable・unknown・rejected は「番号で直す」の文に合わせたもの） */
export const OBI_REJECT_MESSAGES = {
  queuedBandOnly: (no: number) => `#J${no} 帯だけ替えて仕上げます。できたら、ここに確認用のリンクを出します`,
  queuedAi: (no: number) => `#J${no} AI に読ませて仕上げます。できたら、ここに確認用のリンクを出します`,
  human: (no: number) => `#J${no} 担当が確認します`,
  canceled: (no: number) => `#J${no} を取り消しました`,
  approved: (no: number) => `#J${no} を完成にしました。納品の準備ができしだい、ここにリンクを送ります`,
  reopened: (no: number) => `#J${no} 対応を選び直せます。次の知らせに番号で返信してください`,
  forbidden: "対応の選択は、帯替えを依頼できる方からお願いします",
  unavailable: (no: number) => `#J${no} はいまその操作ができない状態です`,
  rejected: (code: string) => `対応を受け付けられませんでした（${code}）。担当に声をかけてください`,
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
  deps.onFixCalled();
  const o = await postReject(
    no,
    { messageId, groupId, action: plan.action, choice: plan.choice, expectGen: plan.expectGen, expectSha256: plan.expectSha256 },
    portalOpts(input, deps, Math.min(FIX_MS, remaining))
  );
  if (o.kind === "accepted") {
    deps.onCommitted();
    log(o.result, await sayOnce(input, groupId, deps, repliedKey, acceptedMessage(no, o)));
    return { outcome: o.result };
  }
  if (o.kind === "rejected") {
    deps.onCommitted();
    return refuse(o.code, OBI_REJECT_MESSAGES.rejected(o.code));
  }
  log(`unknown:${o.kind}`, await sayOnce(input, groupId, deps, `obi-fix-pending-notified:${messageId}`, OBI_REJECT_MESSAGES.unknown));
  return { outcome: "unknown" };
}
