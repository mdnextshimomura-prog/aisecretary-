/**
 * Webhook のイベントの振り分けのうち、帯替えの分（設計 2026-10-09 の 6・8・9・13・14の2）。
 *
 * route.ts は、今までの流れ（メールの下書き・初動確認・タスク等）の前にこれを呼ぶ：
 *   - 営業部のグループの PDF（file）は、帯替え用の控えに足してから、今までの流れにも渡す
 *     （控えは何度足しても同じ。予約より前に置くので、LINE の再送でも控え直せる）
 *   - 帯替えの依頼（@MD NEXT秘書 ＋ 本文の先頭が依頼語）は、ここで予約を取り、最後まで扱う。
 *     今までの流れには渡さない（メールの下書きの途中でも帯替えを先に扱う：設計 8）
 *   - 番号で直す返事（設計 2026-10-10 の E12）は、帯替えの依頼の判定より前に見る。営業部のグループの
 *     text で、本文の全体が訂正の形に合い、「#J つき」か「引用先が帯替えの知らせ・自分の聞き返し」と
 *     確かめられたときだけ、ここで最後まで扱う（今までの流れには渡さない）。確かめられるまでは
 *     今までの流れの順番・動きを変えない
 *   - それ以外は、順番を変えずに今までの流れへ（rest）
 *
 * 予約・完了・解放の扱いは route.ts の今までのイベントと同じ考え方：
 *   受付が確定して一覧も一致した（onCommitted）後は、何があっても再送させない。
 *   結果不明・一覧が合わない・例外（確定前）は予約を外し、503 で LINE の再送を待つ。
 *
 * route.ts は Notion・Claude などを読み込むため、そのままでは試せない。
 * 振り分けをここに分け、偽物の KV・LINE・portal・予約で確かめる（tests/obi-webhook-event.test.ts）。
 */
import { deliverReply, type ReplyOutcome } from "../line";
import { taskMentionState } from "../task-intake";
import { classifyObiEntry, loadObiConfig, shouldRecordObiPdf, type ObiEnv } from "./config";
import { recordObiPdf, type ObiStore } from "./memo";
import { runObiIntake, OBI_MESSAGES } from "./intake";
import { parseFixBody } from "./fix-parse";
import {
  locateObiFix,
  replyObiFixInterrupted,
  replyObiFixStopped,
  runObiFix,
  OBI_FIX_LATE_START_MS,
  type FixTarget,
  type ObiFixDeps,
  type ObiFixInput,
} from "./fix";

export interface ObiLineEvent {
  type: string;
  replyToken?: string;
  timestamp?: number;
  source: { userId?: string; type?: string; groupId?: string };
  message?: {
    id: string;
    type: string;
    text?: string;
    fileName?: string;
    fileSize?: number;
    /** 引用リプライのとき、引用元のメッセージの ID */
    quotedMessageId?: string;
    mention?: {
      mentionees: Array<{ index: number; length: number; type: "user" | "all"; userId?: string }>;
    };
  };
}

export interface ObiEventDeps {
  env: ObiEnv;
  /** @MD NEXT秘書 の userId（LINE_BOT_USER_ID） */
  botUserId: string | undefined;
  /** Webhook の開始時刻（ms）。受付の締め切りの起点 */
  startedAt: number;
  store: ObiStore;
  /** イベントの予約（src/lib/email/session.ts の reserveEvent・completeEvent・releaseEvent） */
  events: {
    reserve(messageId: string): Promise<{ proceed: boolean; inProgress?: boolean }>;
    complete(messageId: string): Promise<void>;
    release(messageId: string): Promise<void>;
  };
  fetchImpl: typeof fetch;
  lineToken: string;
  now: () => number;
  /** 依頼への reply。timeoutMs で打ち切る（replyLineMessageDetailed の既定 8 秒より短くする） */
  reply: (replyToken: string, text: string, timeoutMs: number) => Promise<ReplyOutcome>;
  /** reply がはっきり断られたときの push。timeoutMs で打ち切る。送れたら true（例外は投げない作り） */
  push: (to: string, text: string, timeoutMs: number) => Promise<boolean>;
  /**
   * 「番号で直す」の返事が push に回ったときに使う。送ったメッセージの ID も返す
   * （聞き返しの ID を控えるため。例外は投げない作り）。
   * rejected: true は「はっきり断られた＝届いていないことが確か」のときだけ
   */
  pushWithId: (
    to: string,
    text: string,
    timeoutMs: number
  ) => Promise<{ ok: boolean; messageId: string | null; rejected?: boolean }>;
}

/** 断り（止めています・下村さんから）の返事の時間の上限。受付の返事（intake.ts）と同じ 5 秒 */
const REFUSAL_REPLY_TIMEOUT_MS = 5_000;
const REFUSAL_PUSH_TIMEOUT_MS = 5_000;

export interface ObiDispatchResult<E> {
  /** true なら Webhook は 503 を返して LINE の再送を待つ */
  needsRetry: boolean;
  /** 今までの流れに渡すイベント（元の順番のまま） */
  rest: E[];
}

/** メンション部分を本文から除く（route.ts の stripMentions と同じ） */
function stripMentionText(message: NonNullable<ObiLineEvent["message"]>): string {
  const text = message.text ?? "";
  if (!message.mention) return text;
  const mentionees = [...message.mention.mentionees].sort((a, b) => b.index - a.index);
  let out = text;
  for (const m of mentionees) out = out.slice(0, m.index) + out.slice(m.index + m.length);
  return out.trim();
}

function validTimestamp(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isSafeInteger(ts) && ts > 0;
}

/** 営業部の PDF を控える。控えられなかったら true（再送が要る） */
async function recordIfObiPdf(event: ObiLineEvent, deps: ObiEventDeps): Promise<boolean> {
  const message = event.message!;
  const fileName = message.fileName ?? "";
  const groupId = event.source.groupId;
  if (
    !groupId ||
    !shouldRecordObiPdf({ sourceType: event.source.type, groupId, fileName }, deps.env)
  ) {
    return false;
  }
  // 時刻が無いと「依頼から30分以内」を決められない。今の時刻で代わりにしない
  if (!validTimestamp(event.timestamp)) {
    console.error("帯替えの控え：イベントの時刻が無いので控えない:", message.id);
    return false;
  }
  try {
    await recordObiPdf(deps.store, groupId, {
      messageId: message.id,
      fileName,
      size: message.fileSize ?? 0,
      timestamp: event.timestamp,
      userId: event.source.userId ?? "",
    });
    return false;
  } catch (err) {
    // KV の障害など。今までの流れ（handleIncomingFile）は止めず、再送で控え直す
    console.error("帯替えの控えに失敗（再送で控え直す）:", message.id, (err as Error)?.message ?? err);
    return true;
  }
}

/**
 * 帯替えとして扱うイベントを1つ、予約を取って最後まで扱う。
 * 戻り値：再送が要るか
 */
async function handleObiText(
  event: ObiLineEvent,
  entry: Exclude<ReturnType<typeof classifyObiEntry>, { kind: "not-obi" }>,
  deps: ObiEventDeps
): Promise<boolean> {
  const message = event.message!;
  const ev = await deps.events.reserve(message.id);
  if (!ev.proceed) {
    // 処理中なら再送で引き継げるよう 503。済みなら何もしない
    if (!ev.inProgress) console.log("処理済みのイベントをスキップ:", message.id);
    return Boolean(ev.inProgress);
  }

  const replyToken = event.replyToken ?? "";
  let committed = false;
  let retry = false;
  try {
    if (entry.kind === "stopped" || entry.kind === "forbidden") {
      await deliverReply(entry.kind === "stopped" ? OBI_MESSAGES.stopped : OBI_MESSAGES.forbidden, {
        reply: (t) => deps.reply(replyToken, t, REFUSAL_REPLY_TIMEOUT_MS),
        push: (t) => deps.push(entry.groupId, t, REFUSAL_PUSH_TIMEOUT_MS),
      });
    } else {
      const r = await runObiIntake(
        {
          requestMessageId: message.id,
          // 無ければ runObiIntake が「依頼の時刻が分かりません」で断る（今の時刻で代わりにしない）
          requestTimestamp: event.timestamp,
          groupId: entry.config.groupId,
          requestText: message.text ?? "",
          property: entry.property,
          // entry.assigneeName（「担当:」）は portal に渡さない（約束）
          startedAt: deps.startedAt,
          config: entry.config,
        },
        {
          store: deps.store,
          fetchImpl: deps.fetchImpl,
          lineToken: deps.lineToken,
          now: deps.now,
          // 時間の上限は runObiIntake が決めて渡す（reply・push とも 5 秒）
          reply: (t, timeoutMs) => deps.reply(replyToken, t, timeoutMs),
          push: (to, t, timeoutMs) => deps.push(to, t, timeoutMs),
          // 受付が確定し一覧も一致した。以後に例外が出ても再送させない（受付を二重にしない）
          onCommitted: () => {
            committed = true;
          },
        }
      );
      if (r.retry && !committed) retry = true;
    }
  } catch (err) {
    console.error("帯替えの処理中の例外:", message.id, (err as Error)?.message ?? err);
    // 確定前なら予約を外して再送でやり直す。確定後は二重にしないため再送させない。
    // どちらでも、ここから別の文言（「エラーが発生しました」など）は返さない
    // （確定後なら受付は通っている。確定前の結果不明なら、受付できなかったとは言えない）
    if (!committed) retry = true;
    else console.error("受付は確定済みのため再送しない:", message.id);
  } finally {
    if (retry) {
      await deps.events.release(message.id).catch(() => undefined);
    } else {
      let recorded = false;
      for (let i = 0; i < 3 && !recorded; i++) {
        try {
          await deps.events.complete(message.id);
          recorded = true;
        } catch (e) {
          console.error(`イベント完了の記録に失敗（${i + 1}/3）:`, (e as Error)?.message ?? e);
        }
      }
    }
  }
  return retry;
}

/** 例外はログに名前だけを出す（文には、かぎ＝message.id などが入りうる。AA4） */
const errName = (err: unknown) => (err as { name?: string })?.name ?? "error";

/** 訂正のイベントを済みにする（3回まで試す。handleObiText の「済み」と同じ扱い）。予約は外さない＝やり直さない */
async function completeFixEvent(deps: ObiEventDeps, messageId: string): Promise<void> {
  let recorded = false;
  for (let i = 0; i < 3 && !recorded; i++) {
    try {
      await deps.events.complete(messageId);
      recorded = true;
    } catch (e) {
      console.error(`帯替えの訂正：イベント完了の記録に失敗（${i + 1}/3）:`, errName(e));
    }
  }
}

/**
 * 「番号で直す」の返事かを見て、そうならここで最後まで扱う（設計 2026-10-10 の E12）。
 *   not-fix … 訂正として扱わない（呼んだ側は、今までどおり帯替えの依頼の判定 → 今までの流れへ）
 *   handled … 扱い終えた（今までの流れには渡さない）
 *
 * **503（再送待ち）は返さない（AA1）。** LINE の Webhook の再送は本番で無効なので、どの場面もここで終える：
 *   - fix の結果不明：runObiFix が「受付の結果を確かめられませんでした…」を1回返す。イベントは済みにする（やり直さない）
 *   - fix を呼んだが送っていないことが確かな失敗（unreachable。AB1）：runObiFix が「…portal に届きません。
 *     少し待ってからもう一度送ってください」を1回返す。イベントは済みにする
 *   - 同じ message.id を別の処理が扱っている途中：何もしない（先の処理の予約を、済みにも解放にもしない）
 *   - fix を呼ぶ前の例外：#J つきは「…portal に届きません。少し待ってからもう一度送ってください」を返して済みにする。
 *     引用の形は、予約を外して今までの流れへ渡す
 *   - fix を呼んだ後・答えの前の例外：結果不明と同じ返事をして済みにする
 * ログに message.id・userId・groupId は出さない（段階と結果の code だけ。AA4）。
 */
async function tryObiFix(event: ObiLineEvent, deps: ObiEventDeps): Promise<"not-fix" | "handled"> {
  const message = event.message!;
  // 見るのは営業部のグループの text だけ
  if (event.source.type !== "group" || !event.source.groupId) return "not-fix";
  const body = parseFixBody(stripMentionText(message));
  if (!body) return "not-fix";
  const loaded = loadObiConfig(deps.env);
  // LINE_GROUP_ID が無い・形が違う：営業部がどこか分からないので何もしない（帯替えの依頼と同じ）
  const groupId = loaded.ok ? loaded.config.groupId : loaded.groupId;
  if (!groupId || groupId !== event.source.groupId) return "not-fix";
  const quoted = typeof message.quotedMessageId === "string" ? message.quotedMessageId : null;
  // #J も引用も無い番号だけの発言は、訂正として扱わない
  if (body.no === null && !quoted) return "not-fix";
  if (!/^\d{1,64}$/.test(message.id)) return "not-fix";

  const fixDeps: ObiFixDeps = {
    store: deps.store,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    reply: (t, timeoutMs) => deps.reply(event.replyToken ?? "", t, timeoutMs),
    push: (to, t, timeoutMs) => deps.pushWithId(to, t, timeoutMs),
  };

  let input: ObiFixInput | null = null;
  let target: Extract<FixTarget, { kind: "target" }> | null = null;
  if (loaded.ok) {
    // 残り時間が足りない（同じ Webhook に先の処理があった。開始+7秒より後）：portal は呼ばない（Z11・AA1）。
    //   引用の形：確かめる時間が無い＝引用先を確かめられないのと同じ。予約せず今までの流れへ
    //   #J つき  ：下で認可の後、「portal に届きません…」を1通につき1回返して済みにする（runObiFix の late）
    const late = deps.now() - deps.startedAt > OBI_FIX_LATE_START_MS;
    if (late && body.no === null) {
      console.error("帯替えの訂正：残り時間が足りない（引用の形。今までの流れへ）");
      return "not-fix";
    }
    if (late) console.error("帯替えの訂正：残り時間が足りない（#J つき。portal を呼ばずに返す）");
    // 許可リストとの照合はここだけ。通っても通らなくても、userId はこの先へ渡さない
    const userId = event.source.userId;
    const allowed = Boolean(userId) && loaded.config.allowedUserIds.includes(userId as string);
    input = {
      messageId: message.id,
      body,
      quotedMessageId: quoted,
      allowed,
      startedAt: deps.startedAt,
      config: loaded.config,
      late,
    };
    let located: FixTarget;
    try {
      located = await locateObiFix(input, fixDeps);
    } catch (err) {
      console.error("帯替えの訂正：対象を決める途中の例外（今までの流れへ）:", errName(err));
      return "not-fix";
    }
    if (located.kind === "rest") return "not-fix";
    target = located;
  } else {
    // 設定が足りない：引用の形は確かめようが無いので今までの流れへ。#J つきにだけ「止めています」
    if (body.no === null) return "not-fix";
    console.error("帯替えの訂正を止めています（設定の不足・不正）:", loaded.problems.join(","));
  }

  // ここから先は訂正として扱う：予約を取り、最後まで扱う（今までの流れには渡さない）
  const ev = await deps.events.reserve(message.id);
  if (!ev.proceed) {
    // 済み：何もしない。別の処理が扱っている途中：何もしない（先の処理の予約を、済みにも解放にもしない）。
    // どちらも 200 で終わる（503 にしない。AA1）
    console.log("帯替えの訂正:", ev.inProgress ? "in-progress（何もしない）" : "already-done（何もしない）");
    return "handled";
  }
  let fixCalled = false;
  let committed = false;
  let toRest = false;
  try {
    if (input && target) {
      await runObiFix(input, target, {
        ...fixDeps,
        onFixCalled: () => {
          fixCalled = true;
        },
        // portal の fix の結果が確かになった（はっきり答えた・送っていないことが確か。AB1）
        onCommitted: () => {
          committed = true;
        },
      });
    } else {
      await replyObiFixStopped({ messageId: message.id, groupId, startedAt: deps.startedAt }, fixDeps);
    }
  } catch (err) {
    const stage = committed ? "after-fix" : fixCalled ? "fix-called" : "before-fix";
    console.error("帯替えの訂正の処理中の例外:", stage, errName(err));
    if (input && target && !committed) {
      if (fixCalled) {
        // fix を呼んだ後・答えの前：結果不明と同じ（「もう一度送ってください」とは言わない）
        await replyObiFixInterrupted(input, "fix-called", fixDeps);
      } else if (target.via === "number") {
        // fix を呼ぶ前（#J つき）：何も変わっていないので、送り直してよい
        await replyObiFixInterrupted(input, "before-fix", fixDeps);
      } else {
        // fix を呼ぶ前（引用の形）：今までの流れへ渡す
        toRest = true;
      }
    }
    // fix がはっきり答えた後の例外・「止めています」の途中の例外は、そのまま済みにする
  } finally {
    if (toRest) {
      // 今までの流れ（route.ts）が自分で予約を取れるよう、ここで取った予約を外す
      await deps.events.release(message.id).catch(() => undefined);
    } else {
      await completeFixEvent(deps, message.id);
    }
  }
  return toRest ? "not-fix" : "handled";
}

/**
 * Webhook の1回分のイベントのうち、帯替えの分を先に扱う。
 * 返す rest を route.ts の今までのループに渡す。
 */
export async function dispatchObiEvents<E extends ObiLineEvent>(
  events: E[],
  deps: ObiEventDeps
): Promise<ObiDispatchResult<E>> {
  let needsRetry = false;
  const rest: E[] = [];
  for (const event of events) {
    const message = event.message;
    if (event.type !== "message" || !message) {
      rest.push(event);
      continue;
    }
    if (message.type === "file") {
      if (await recordIfObiPdf(event, deps)) needsRetry = true;
      rest.push(event); // 今までのファイルの扱い（handleIncomingFile）も行う
      continue;
    }
    if (message.type !== "text") {
      rest.push(event);
      continue;
    }
    // 番号で直す返事（帯替えの依頼の判定より前）。訂正と決まったものだけ、ここで扱い終える
    // 訂正の枝は needsRetry を立てない（503 にしない。AA1）
    if ((await tryObiFix(event, deps)) === "handled") continue;
    const entry = classifyObiEntry(
      {
        sourceType: event.source.type,
        groupId: event.source.groupId,
        userId: event.source.userId,
        // 既存の新規タスクの入口と同じ判定（@MD NEXT秘書 へのメンション）
        mentionsBot: taskMentionState(message.mention?.mentionees, deps.botUserId).mentionsBot,
        text: stripMentionText(message),
      },
      deps.env
    );
    if (entry.kind === "not-obi") {
      rest.push(event);
      continue;
    }
    if (await handleObiText(event, entry, deps)) needsRetry = true;
  }
  return { needsRetry, rest };
}
