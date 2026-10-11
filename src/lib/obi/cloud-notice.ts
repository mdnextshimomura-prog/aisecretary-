/**
 * クラウド配達の種まきと、差し戻し・失敗の知らせ
 * （設計 2026-10-11 の C8・C13、約束 2026-10-11-obi-cloud-contract.md の入口 4・7 と「K4 の見回り」）。
 *
 *   順番：一覧（差し戻し・失敗）→ notice/claim → notice/attempt が 200 → push → notice/result
 *   - notice/attempt の 200 を受け取ってからだけ LINE を呼ぶ。200 以外・答えが届かないときは送らない
 *   - 知らせを出してよいかは、その回の一覧の応答の peers.mac.noticeClaim だけで決める（KV・メモリに覚えない）
 *   - 種まきの印は KV に持たない（正は portal）。種まきの応答が seeded: true だった回は、知らせを1通も送らない
 *   - 「LINE を呼んだか分からない」ときは送り直さない
 * 差し込み口（deps.checkpoint）は try の外で呼ぶ。
 */
import { noteAuth, signOf } from "./cloud-deliver";
import type {
  CloudJobRow,
  NoticeKey,
  NoticeKind,
  PortalCall,
} from "./cloud-portal";
import {
  failureNoticeText,
  rejectNoticeText,
  type RejectNotice,
} from "./cloud-text";
import { MAX_NOTICES, type TickCtx } from "./cloud-tick";

const GEN_RE = /^(|g\d{1,15}|p[0-9a-f]{8})$/;
const MESSAGE_ID_RE = /^\d{1,64}$/;
/** 1回に見る「知らせの id の報告のやり直し」の数 */
const NOTICE_MSG_SCAN_LIMIT = 10;
/** 知らせの id の報告をあきらめる回数 */
const MAX_MSG_TRIES = 3;

const say = (ctx: TickCtx, no: number, what: string): void =>
  ctx.deps.log(`#J${no} ${what}`);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isAuth = (r: PortalCall<unknown>): boolean =>
  r.kind === "rejected" && (r.status === 401 || r.status === 403);

/**
 * 種まき（スイッチを入れる前から差し戻し・失敗だった依頼に、知らせを出し直さないための印）。
 * "go"＝知らせへ進んでよい／"hold"＝この回は知らせを1通も送らない。
 */
export async function runSeed(ctx: TickCtx): Promise<"go" | "hold"> {
  const { deps } = ctx;
  if (deps.seedMemo.confirmed) return "go";
  if (ctx.state.portalStopped || !ctx.clock.canStartNew()) return "hold";
  const r = noteAuth(
    ctx,
    await deps.portal.noticeSeed(ctx.clock.portalTimeout()),
  );
  if (r.kind !== "ok") {
    // 種まきが済んだと確かめられない回は送らない
    deps.log(`seed-failed ${signOf(r)}`);
    return "hold";
  }
  deps.seedMemo.confirmed = true;
  if (r.value.seeded) {
    ctx.counts.seeded = true;
    deps.log("seeded");
    return "hold";
  }
  return "go";
}

/** 届かなかった「選択肢つきの差し戻しの知らせの id」の報告のやり直し。目次・値が読めなければ、ここだけ飛ばす */
async function retryNoticeMsgs(ctx: TickCtx): Promise<void> {
  const { deps, clock, shared } = ctx;
  let list: Array<{ no: number; choiceGen: number }>;
  try {
    list = await deps.store.listNoticeMsgs(NOTICE_MSG_SCAN_LIMIT);
  } catch {
    deps.log("notice-msg-list-failed");
    return;
  }
  for (const { no, choiceGen } of list) {
    if (ctx.state.portalStopped || !clock.canStartNew()) return;
    let cur: { messageId: string; tries: number } | null;
    try {
      cur = await deps.store.getNoticeMsg(no, choiceGen);
    } catch {
      say(ctx, no, "notice-msg-read-failed");
      return;
    }
    if (cur === null) {
      await deps.store.unindexNoticeMsg(no, choiceGen); // 値は期限で消えた。目次の掃除
      continue;
    }
    const r = noteAuth(
      ctx,
      await deps.portal.reportDeliveryMessage(
        no,
        {
          groupId: shared.groupId,
          messageId: cur.messageId,
          kind: "reject",
          choiceGen,
        },
        clock.portalTimeout(),
      ),
    );
    try {
      if (r.kind === "ok") {
        await deps.store.delNoticeMsg(no, choiceGen);
      } else if (r.kind === "rejected" && !isAuth(r)) {
        // CHOICE_STALE・INVALID_REQUEST・MESSAGE_CONFLICT・そのほかの 4xx：送り直しても変わらない
        await deps.store.delNoticeMsg(no, choiceGen);
        say(ctx, no, `notice-msg-dropped ${r.code}`);
      } else if (r.kind === "unknown") {
        const tries = cur.tries + 1;
        if (tries >= MAX_MSG_TRIES) {
          await deps.store.delNoticeMsg(no, choiceGen);
          say(ctx, no, "notice-msg-gave-up");
        } else {
          await deps.store.putNoticeMsg(no, choiceGen, {
            messageId: cur.messageId,
            tries,
          });
        }
      }
      // 401・403 は残す（鍵が直れば次の回に通る）
    } catch {
      say(ctx, no, "notice-msg-save-failed");
    }
  }
}

interface Candidate {
  no: number;
  key: NoticeKey;
  row: CloudJobRow;
}

/** 一覧の行から、知らせを出してよい行だけを選ぶ（1つでも違えば出さない） */
function pickCandidates(
  rows: CloudJobRow[],
  kind: NoticeKind,
  groupId: string,
): Candidate[] {
  const out: Candidate[] = [];
  for (const row of rows) {
    if (
      row.workflow !== "obi" ||
      row.replyKind !== "line-group" ||
      row.replyGroupId !== groupId
    )
      continue;
    const n = row.groupNotice; // 項目が無い（古い portal）・null は出さない
    if (!isObj(n) || n.kind !== kind) continue;
    if (typeof n.gen !== "string" || !GEN_RE.test(n.gen)) continue;
    if (kind === "failure" && n.gen !== "") continue;
    // 予約を取りに行くのは、taken が null か、取り直せる（retryable）行だけ。時間は呼び手が計算しない
    if (!(n.taken === null || (isObj(n.taken) && n.taken.retryable === true)))
      continue;
    out.push({ no: row.no, key: { kind, gen: n.gen }, row });
  }
  return out;
}

/** 差し戻し・失敗の知らせ（1回に3通まで）。runSeed が "go" のときだけ呼ぶ */
export async function runNotices(ctx: TickCtx): Promise<void> {
  const { deps, clock, shared } = ctx;

  await retryNoticeMsgs(ctx);

  // 一覧を2つ取る。取れなかった一覧の知らせは出さない
  const candidates: Candidate[] = [];
  const lists: Array<
    [NoticeKind, { status: "差し戻し" } | { recentFailed: true }]
  > = [
    ["reject", { status: "差し戻し" }],
    ["failure", { recentFailed: true }],
  ];
  for (const [kind, q] of lists) {
    if (ctx.state.portalStopped || !clock.canStartNew()) break;
    const list = noteAuth(
      ctx,
      await deps.portal.listJobs(q, clock.portalTimeout()),
    );
    if (list.kind !== "ok") {
      deps.log(`list-failed ${kind} ${signOf(list)}`);
      continue;
    }
    // Mac が「予約を取ってから送る版」かは、その回の、その一覧の応答だけで見る（前の回の値は見ない）。
    // false・null・peers なしは、どれも出さない
    if (list.value.macNoticeClaim !== true) {
      if (list.value.jobs.length > 0) deps.log(`notice-held ${kind}`);
      continue;
    }
    candidates.push(...pickCandidates(list.value.jobs, kind, shared.groupId));
  }
  candidates.sort((a, b) => a.no - b.no);

  let pushes = 0; // 3通の枠は「LINE を呼んだ回数」（結果によらない）
  for (const { no, key, row } of candidates) {
    if (
      pushes >= MAX_NOTICES ||
      !clock.canStartNew() ||
      ctx.state.portalStopped
    )
      break;

    const claim = noteAuth(
      ctx,
      await deps.portal.noticeClaim(
        no,
        key,
        shared.groupId,
        clock.portalTimeout(),
      ),
    );
    if (claim.kind === "unknown") {
      say(ctx, no, "notice-claim-unknown");
      continue;
    }
    if (claim.kind === "rejected") {
      if (claim.code === "NOTICE_NOT_SEEDED") {
        // 種まきがまだ。この回の知らせを打ち切り、次の回が種まきからやり直す
        deps.seedMemo.confirmed = false;
        deps.log("notice-not-seeded");
        break;
      }
      // NOTICE_STALE は失敗ではない（警告にしない・数えない）。
      // WRITE_CONFLICT は「答えは届いたが、何も書かれていない」。送らない・この回の中でやり直さない
      say(
        ctx,
        no,
        claim.code === "NOTICE_STALE"
          ? "notice-stale"
          : `notice-claim ${claim.code}`,
      );
      continue;
    }
    if (!claim.value.claimed) {
      say(ctx, no, "notice-taken"); // Mac が先に取った・もう済んでいる
      continue;
    }
    const claimId = claim.value.claimId;
    deps.checkpoint("notice-claimed");

    const reject: RejectNotice | null =
      key.kind === "reject" ? rejectNoticeText(no, row) : null;
    const text = reject ? reject.text : failureNoticeText(no);

    if (!clock.canAttemptNotice()) {
      // 「戻れない所」へ進まない。行は prepared のまま（10分後に取り直せる）
      say(ctx, no, "notice-deferred");
      break;
    }
    const attempt = noteAuth(
      ctx,
      await deps.portal.noticeAttempt(no, key, claimId, clock.portalTimeout()),
    );
    if (attempt.kind !== "ok") {
      // 200 以外では LINE を呼ばない。結果も報告しない・attempt をやり直さない
      if (attempt.kind === "unknown") say(ctx, no, "notice-attempt-unknown");
      else
        say(
          ctx,
          no,
          attempt.code === "NOTICE_STALE"
            ? "notice-stale"
            : `notice-attempt ${attempt.code}`,
        );
      continue;
    }
    deps.checkpoint("notice-attempting");

    let pushed: { ok: boolean; messageId: string | null; rejected?: boolean };
    try {
      pushed = await deps.push(text);
    } catch {
      pushed = { ok: false, messageId: null }; // 投げたら「分からない」
    }
    pushes += 1;
    deps.checkpoint("notice-pushed");

    const state: "sent" | "failed" | "unknown" = pushed.ok
      ? "sent"
      : pushed.rejected === true
        ? "failed"
        : "unknown";
    let result = noteAuth(
      ctx,
      await deps.portal.noticeResult(
        no,
        key,
        claimId,
        state,
        clock.portalTimeout(),
      ),
    );
    if (result.kind === "unknown") {
      // 答えが届かない（通信の失敗・5xx）ときだけ、同じ回にもう1回だけ呼ぶ（同じ予約の同じ結果の再送は成功）
      result = noteAuth(
        ctx,
        await deps.portal.noticeResult(
          no,
          key,
          claimId,
          state,
          clock.portalTimeout(),
        ),
      );
    }
    if (result.kind === "ok") {
      if (state === "sent") {
        ctx.counts.notices += 1;
        say(ctx, no, `notice-sent ${key.kind}`);
      } else {
        say(ctx, no, state === "failed" ? "notice-failed" : "notice-unknown");
      }
    } else if (result.kind === "rejected") {
      // STATE_CONFLICT・WRITE_CONFLICT など：送り直さない・報告もやり直さない・予約も取り直さない
      say(ctx, no, `notice-result ${result.code}`);
    } else {
      say(ctx, no, "notice-result-unknown"); // 次の回へ持ち越さない（portal が10分後に unknown にする）
    }

    // 選択肢つきの差し戻しだけ、送れた知らせの id を portal に報告する（引用の返事の相手を引けるように）。
    // 固定の一言・失敗の知らせは報告しない
    if (
      reject &&
      reject.kind === "choices" &&
      pushed.ok &&
      typeof pushed.messageId === "string" &&
      MESSAGE_ID_RE.test(pushed.messageId)
    ) {
      const messageId = pushed.messageId;
      const m = noteAuth(
        ctx,
        await deps.portal.reportDeliveryMessage(
          no,
          {
            groupId: shared.groupId,
            messageId,
            kind: "reject",
            choiceGen: reject.choiceGen,
          },
          clock.portalTimeout(),
        ),
      );
      if (m.kind === "rejected") {
        say(ctx, no, `notice-msg-dropped ${m.code}`);
      } else if (m.kind === "unknown") {
        try {
          await deps.store.putNoticeMsg(no, reject.choiceGen, {
            messageId,
            tries: 1,
          });
        } catch {
          say(ctx, no, "notice-msg-save-failed"); // あきらめる（知らせは届いている）
        }
      }
    }
  }
}
