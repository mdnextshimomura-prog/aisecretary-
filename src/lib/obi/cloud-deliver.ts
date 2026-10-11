/**
 * クラウド配達の完成の段取り（設計 2026-10-11 の C2・C3・C11、約束 2026-10-11-obi-cloud-contract.md の「K4 の見回り」）。
 *
 * 二重を防ぐ正は portal の予約。「LINE を呼んだか分からない」ときは送り直さない。
 *   順番：予約 → 控え prepared → 控え attempt-requested → portal の delivery/attempt（1b）が 200
 *         → 控え attempting → push → 控え sent → 知らせの id の報告 → 結果 delivered → 控えを消す
 *   - LINE を呼ぶ直前に、新しい配達でも再開でも、必ず portal の attempt を通す（200 以外では push しない）
 *   - 完成へ返す（not_sent）前に、必ず先に控えを消す。消せなければ報告しない
 *   - 控えに入れる文の材料は facts の5項目だけ。ログに出すのは受付番号・段・符号だけ
 * 差し込み口（deps.checkpoint）は try の外で呼ぶ（CloudHalt を握りつぶさない）。
 */
import { issueCloudToken, cloudLink } from "./cloud-dtoken";
import type { CloudJobRow, PortalCall } from "./cloud-portal";
import type { CloudJobMemo, CloudJobMemoRead } from "./cloud-store";
import {
  cloudProperty,
  completionText,
  readCompletionFacts,
} from "./cloud-text";
import type { TickCtx } from "./cloud-tick";

const MESSAGE_ID_RE = /^\d{1,64}$/;
/** 知らせの id の報告をあきらめる回数 */
const MAX_MSG_TRIES = 3;

const iso = (ms: number): string => new Date(ms).toISOString();
const say = (ctx: TickCtx, no: number, what: string): void =>
  ctx.deps.log(`#J${no} ${what}`);

type NotOk = Exclude<PortalCall<unknown>, { kind: "ok" }>;
/** ログに出す符号（4xx は code、分からないときは理由の名前） */
export const signOf = (r: NotOk): string =>
  r.kind === "rejected" ? r.code : r.reason;
/** 401・403＝portal の手前で断られている。その回の portal の仕事を打ち切る印を立てる */
export function noteAuth<T>(ctx: TickCtx, r: PortalCall<T>): PortalCall<T> {
  if (r.kind === "rejected" && (r.status === 401 || r.status === 403))
    ctx.state.portalStopped = true;
  return r;
}
const isAuth = (r: NotOk): boolean =>
  r.kind === "rejected" && (r.status === 401 || r.status === 403);

/** 控えを消す。失敗してもよい所で使う（次の回が拾う）。消せたら true */
async function dropMemo(ctx: TickCtx, no: number): Promise<boolean> {
  try {
    await ctx.deps.store.delJob(no);
    return true;
  } catch {
    say(ctx, no, "memo-del-failed");
    return false;
  }
}
async function resetRetry(
  ctx: TickCtx,
  no: number,
  sha256: string,
): Promise<void> {
  try {
    await ctx.deps.store.clearRetry(no, sha256);
  } catch {
    say(ctx, no, "retry-save-failed");
  }
}
async function countRetry(
  ctx: TickCtx,
  no: number,
  sha256: string,
): Promise<void> {
  try {
    await ctx.deps.store.bumpRetry(no, sha256, iso(ctx.deps.now()));
  } catch {
    say(ctx, no, "retry-save-failed");
  }
}

/**
 * 予約を完成へ返す（not_sent）。先に控えを消す。消せなければ報告しない
 * （逆の順だと、予約は完成へ返ったのに控えが残り、次の回が古い予約で再開しうる）。
 */
export async function giveBack(
  no: number,
  claimId: string,
  sha256: string,
  reason: "push-rejected" | "target" | "config",
  ctx: TickCtx,
): Promise<void> {
  if (!(await dropMemo(ctx, no))) return;
  const r = noteAuth(
    ctx,
    await ctx.deps.portal.reportDeliveryResult(
      no,
      { claimId, outcome: "not_sent", reason },
      ctx.clock.portalTimeout(),
    ),
  );
  if (r.kind === "ok") {
    await countRetry(ctx, no, sha256);
    ctx.counts.notSent += 1;
    say(ctx, no, `not-sent ${reason}`);
  } else if (r.kind === "rejected") {
    say(ctx, no, `not-sent-rejected ${r.code}`);
  } else {
    say(ctx, no, "not-sent-unknown"); // 予約は期限で portal が片付ける
  }
}

/**
 * 送れた後の片付け：知らせの id の報告（3回まで）→ 結果 delivered → 控えを消す。
 * saved は「控え sent が書けているか」（書けていなければ、id の報告を次の回へ持ち越せない）。
 */
export async function finishSent(
  no: number,
  memo: CloudJobMemoRead,
  saved: boolean,
  ctx: TickCtx,
): Promise<void> {
  const { deps, clock, shared } = ctx;
  const tries = memo.msgTries ?? 0;
  if (memo.messageId && tries < MAX_MSG_TRIES) {
    const m = noteAuth(
      ctx,
      await deps.portal.reportDeliveryMessage(
        no,
        {
          groupId: shared.groupId,
          artifactSha256: memo.sha256,
          messageId: memo.messageId,
        },
        clock.portalTimeout(),
      ),
    );
    if (m.kind !== "ok") {
      const next = tries + 1;
      // 約束どおりの形でない控え（leaseUntil・facts が無い）は書き直せない＝「控えが書けていない」と同じ
      if (
        next < MAX_MSG_TRIES &&
        saved &&
        memo.leaseUntil !== null &&
        memo.facts !== null
      ) {
        let rewritten = false;
        try {
          await deps.store.putJob(no, {
            ...memo,
            leaseUntil: memo.leaseUntil,
            facts: memo.facts,
            msgTries: next,
            at: iso(deps.now()),
          });
          rewritten = true;
        } catch {
          /* 書き直せなければ、あきらめて結果へ進む */
        }
        if (rewritten) {
          say(ctx, no, "message-report-retry");
          return; // 次の回に続き
        }
      }
      // リンクは届いている。失うのは、引用の返信で番号を返すことだけ
      say(ctx, no, "message-report-gave-up");
    }
  }
  deps.checkpoint("completion-before-result");
  const r = noteAuth(
    ctx,
    await deps.portal.reportDeliveryResult(
      no,
      { claimId: memo.claimId, outcome: "delivered" },
      clock.portalTimeout(),
    ),
  );
  if (r.kind === "ok") {
    await dropMemo(ctx, no); // 消せなくてもよい（次の回が同じ報告をして消す）
    await resetRetry(ctx, no, memo.sha256);
    ctx.counts.delivered += 1;
    say(ctx, no, "delivered");
  } else if (r.kind === "rejected" && !isAuth(r)) {
    // もう届いている。portal の側は期限で納品要確認
    await dropMemo(ctx, no);
    say(ctx, no, `result-rejected ${r.code}`);
  } else {
    // 届かない・5xx・401・403：控えは sent のまま（次の回にやり直す）
    say(
      ctx,
      no,
      r.kind === "rejected" ? `result-unknown ${r.code}` : "result-unknown",
    );
  }
}

/**
 * 控え（prepared・attempt-requested）から、LINE を呼ぶ所まで進める。新しい予約と、再開の両方が使う。
 * 文は、どちらの回も控えの facts から作る（＝同じ文になる）。
 */
export async function sendPrepared(
  no: number,
  memo: CloudJobMemo,
  ctx: TickCtx,
): Promise<void> {
  const { deps, clock, shared, completion } = ctx;
  ctx.state.completionsUsed += 1;
  if (!clock.canSendCompletion()) {
    say(ctx, no, "deferred"); // 控えはそのまま。次の回へ
    return;
  }
  let text: string | null = null;
  if (completion) {
    try {
      const { token } = issueCloudToken({
        no,
        sha256: memo.sha256,
        groupId: shared.groupId,
        kid: completion.kid,
        key: completion.signingKey,
        nowMs: deps.now(),
        randomJti: deps.randomJti,
      });
      text = completionText({
        no,
        property: memo.facts.property,
        facts: memo.facts,
        link: cloudLink(completion.liffId, token),
        fixGuide: ctx.fixGuide,
      });
    } catch {
      text = null; // 例外の文は出さない
    }
  }
  if (text === null) {
    await giveBack(no, memo.claimId, memo.sha256, "config", ctx);
    return;
  }

  let cur: CloudJobMemo = {
    ...memo,
    stage: "attempt-requested",
    at: iso(deps.now()),
  };
  let wrote = true;
  try {
    await deps.store.putJob(no, cur);
  } catch {
    wrote = false;
  }
  if (!wrote) {
    await giveBack(no, memo.claimId, memo.sha256, "config", ctx); // 書けなければ送らない
    return;
  }
  deps.checkpoint("completion-attempt-requested");

  // 約束の 1b：原子的な「送信中の印」。200 のときだけ先へ進む
  const at = noteAuth(
    ctx,
    await deps.portal.attemptDelivery(no, memo.claimId, clock.portalTimeout()),
  );
  if (at.kind !== "ok") {
    const retryLater =
      at.kind === "unknown" ||
      at.code === "WRITE_CONFLICT" ||
      at.status === 401;
    if (retryLater) {
      // この回は送らない。控えは attempt-requested のまま（次の回に attempt をやり直す）
      say(ctx, no, `attempt-unknown ${signOf(at)}`);
      return;
    }
    // CLAIM_MISMATCH（その予約はもう自分のものではない）・404・400・403・そのほかの 4xx：控えを消すだけ。
    // 送らない・結果も報告しない・待ち時間も数えない
    if (await dropMemo(ctx, no)) say(ctx, no, `memo-stale ${signOf(at)}`);
    return;
  }

  cur = { ...cur, stage: "attempting", at: iso(deps.now()) };
  wrote = true;
  try {
    await deps.store.putJob(no, cur);
  } catch {
    wrote = false;
  }
  if (!wrote) {
    // 書けなければ送らない。控えは attempt-requested のまま（portal の attempt は同じ claimId に冪等）
    say(ctx, no, "memo-save-failed");
    return;
  }
  deps.checkpoint("completion-attempting");

  let pushed: { ok: boolean; messageId: string | null; rejected?: boolean };
  try {
    pushed = await deps.push(text);
  } catch {
    pushed = { ok: false, messageId: null }; // 投げたら「分からない」
  }
  deps.checkpoint("completion-pushed");

  if (!pushed.ok && pushed.rejected === true) {
    // 4xx＝届いていないことが確か
    await giveBack(no, memo.claimId, memo.sha256, "push-rejected", ctx);
    return;
  }
  if (!pushed.ok) {
    // 届いたか分からない。送り直さない
    const r = noteAuth(
      ctx,
      await deps.portal.reportDeliveryResult(
        no,
        { claimId: memo.claimId, outcome: "unknown", reason: "push-unknown" },
        clock.portalTimeout(),
      ),
    );
    if (r.kind === "ok") {
      await dropMemo(ctx, no);
      await resetRetry(ctx, no, memo.sha256);
      ctx.counts.unknown += 1;
      say(ctx, no, "unknown push-unknown");
    } else {
      // 控えは attempting のまま（次の回が interrupted で報告する。どちらも「送り直さない・要確認」）
      say(ctx, no, `unknown-report-failed ${signOf(r)}`);
    }
    return;
  }

  const sent: CloudJobMemo = {
    ...cur,
    stage: "sent",
    msgTries: 0,
    at: iso(deps.now()),
  };
  if (
    typeof pushed.messageId === "string" &&
    MESSAGE_ID_RE.test(pushed.messageId)
  )
    sent.messageId = pushed.messageId;
  let saved = true;
  try {
    await deps.store.putJob(no, sent);
  } catch {
    saved = false; // 書けなくても先へ進む（もう届いている）
    say(ctx, no, "memo-save-failed");
  }
  deps.checkpoint("completion-sent-saved");
  await finishSent(no, sent, saved, ctx);
}

/**
 * 新しい予約から配る（一覧の行1つ）。呼ぶ前に、絞り込み・待ち時間・canStartNew() は済んでいる。
 */
export async function deliverNew(
  row: CloudJobRow,
  ctx: TickCtx,
): Promise<void> {
  const { deps, clock, shared } = ctx;
  const no = row.no;
  const claim = noteAuth(
    ctx,
    await deps.portal.claimDelivery(no, clock.portalTimeout()),
  );
  if (claim.kind === "rejected") {
    say(ctx, no, `claim-skip ${claim.code}`);
    return;
  }
  if (claim.kind === "unknown") {
    // 取れていたとしても控えが無い。期限で portal が納品要確認に回す
    say(ctx, no, `claim-unknown ${claim.reason}`);
    return;
  }
  const c = claim.value;
  if (c.via !== "cloud") {
    // portal が前の版。配達しない。via・reason を付けない not_sent ですぐ返し、予約し直さない時間を数える
    noteAuth(
      ctx,
      await deps.portal.reportDeliveryResult(
        no,
        { claimId: c.claimId, outcome: "not_sent", legacy: true },
        clock.portalTimeout(),
      ),
    );
    await countRetry(ctx, no, c.artifactSha256);
    say(ctx, no, "claim-not-cloud");
    return;
  }
  deps.checkpoint("completion-claimed");

  // 返し先の照合（控えを書く前。「控えがある＝返し先は合っている」にして、控えに ID を入れない）
  if (c.replyKind !== "line-group" || c.replyGroupId !== shared.groupId) {
    await giveBack(no, c.claimId, c.artifactSha256, "target", ctx);
    return;
  }

  const memo: CloudJobMemo = {
    v: 1,
    claimId: c.claimId,
    sha256: c.artifactSha256,
    stage: "prepared",
    leaseUntil: c.leaseUntil,
    // 物件名は、予約の対象を選んだこの回の一覧の行の値を整えたもの（予約の応答の値は使わない。生の値は控えに入れない）
    facts: {
      ...readCompletionFacts(c.raw),
      property: cloudProperty(row.property),
    },
    at: iso(deps.now()),
  };
  let wrote = true;
  try {
    await deps.store.putJob(no, memo);
  } catch {
    wrote = false;
  }
  if (!wrote) {
    await giveBack(no, c.claimId, c.artifactSha256, "config", ctx);
    return;
  }
  deps.checkpoint("completion-prepared");
  await sendPrepared(no, memo, ctx);
}
