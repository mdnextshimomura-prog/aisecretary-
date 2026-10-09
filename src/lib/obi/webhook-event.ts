/**
 * Webhook のイベントの振り分けのうち、帯替えの分（設計 2026-10-09 の 6・8・9・13・14の2）。
 *
 * route.ts は、今までの流れ（メールの下書き・初動確認・タスク等）の前にこれを呼ぶ：
 *   - 営業部のグループの PDF（file）は、帯替え用の控えに足してから、今までの流れにも渡す
 *     （控えは何度足しても同じ。予約より前に置くので、LINE の再送でも控え直せる）
 *   - 帯替えの依頼（@MD NEXT秘書 ＋ 本文の先頭が依頼語）は、ここで予約を取り、最後まで扱う。
 *     今までの流れには渡さない（メールの下書きの途中でも帯替えを先に扱う：設計 8）
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
import { classifyObiEntry, shouldRecordObiPdf, type ObiEnv } from "./config";
import { recordObiPdf, type ObiStore } from "./memo";
import { runObiIntake, OBI_MESSAGES } from "./intake";

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
