/**
 * 個人 LINE へ先に送るまとめ（STAFF_DIGEST_DM）を、本物の KV・LINE・Notion・名簿につなぐ（判断と文は staff-digest-dm.ts）。
 * どの入口も、STAFF_DIGEST_DM が off なら KV・LINE・Notion・名簿を1回も呼ばずに返る。例外は投げない。
 */
import { kv } from "@vercel/kv";
import { closureOn, loadClosures } from "./closures";
import { completeEvent, reserveEvent } from "./email/session";
import { GS_RETRY_NAMESPACE } from "./group-satei-data";
import { pushMessagesWithRetryKeyIds, sendLineMessage } from "./line";
import { appendTaskNote } from "./notion";
import { uuidv5 } from "./satei-notify";
import type { Chunk } from "./chunk";
import { DIGEST_GROUP_ID, digestMsgKey, fetchLikeMorning, realSendDeps, type DigestBuildCtx, type DigestMessage, type DigestSlot, type DigestTask } from "./staff-digest";
import {
  asDmUserRec,
  DM_NOTICE_TTL_SEC,
  dmNoticeKey,
  dmPassageCandidate,
  dmUserKey,
  handleDmReply,
  pageKey,
  runDmEscalationOnTick,
  sendDigestWithDm,
  staffDigestDmOn,
  type DmUserRec,
} from "./staff-digest-dm";
import { bounded, chunkToMessage } from "./staff-digest-reply";
import { knownLineDeps, noteItems, sdRealKv, senderName } from "./staff-digest-reply-wire";
import { followupEnabled } from "./task-status";
import { checkSecretarySource } from "./webhook-source";

const log = (line: string) => console.log(line);
const USER_RE = /^U[0-9a-f]{32}$/;
const PROFILE_TIMEOUT_MS = 3_000;
const DM_PUSH_TIMEOUT_MS = 6_000;
const ESC_PUSH_TIMEOUT_MS = 8_000;

/**
 * 張り出しをグループへ送る（5通までを1回の push。束ごとに retry key つき＝印を外してやり直しても、届いていれば LINE が重ねない）。
 * 送れた通数（2xx・409）・渡した順のメッセージ ID・結果の分からなかった通数（時間切れ・5xx）を返す。例外は投げない。
 */
async function pushEscalation(chunks: Chunk[], key: string): Promise<{ sent: number; ids: Array<string | null>; unknown: number }> {
  const ids: Array<string | null> = chunks.map(() => null);
  let sent = 0;
  let unknown = 0;
  for (let at = 0; at < chunks.length; at += 5) {
    const part = chunks.slice(at, at + 5);
    const r = await pushMessagesWithRetryKeyIds(DIGEST_GROUP_ID, part.map(chunkToMessage), uuidv5(`${key}:${at / 5}`, GS_RETRY_NAMESPACE), ESC_PUSH_TIMEOUT_MS).catch(
      () => ({ status: null as number | null, ids: [] as string[] })
    );
    if (r.status !== null && ((r.status >= 200 && r.status < 300) || r.status === 409)) {
      sent += part.length;
      if (r.ids.length === part.length) r.ids.forEach((id, i) => (ids[at + i] = id));
    } else if (r.status === null || r.status >= 500) unknown += part.length;
  }
  return { sent, ids, unknown };
}

/**
 * 友だちか（LINE の GET /v2/bot/profile/{userId}）。200＝true、404＝false、ほか（5xx・401・時間切れ・例外・設定なし）＝null。
 * 本文（名前・アイコンなど）は読まずに捨てる。ログは出さない。例外は投げない。
 */
export async function lineFriendStatus(
  userId: string,
  o: { token?: string; fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<boolean | null> {
  const token = o.token ?? process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "";
  if (!token || !USER_RE.test(userId)) return null;
  const f = o.fetch ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? PROFILE_TIMEOUT_MS);
  try {
    const res = await f(`https://api.line.me/v2/bot/profile/${userId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
      cache: "no-store",
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 朝・夕方のまとめを送る（友だちの担当は 1対1 へ、ほかは今までどおりグループへ）。STAFF_DIGEST_DM=1 の道からだけ呼ぶ */
export async function sendDigestWithDmReal<T extends DigestTask>(
  slot: DigestSlot,
  ctx: DigestBuildCtx,
  messages: DigestMessage[],
  ordered: Array<{ task: T; n: number }>,
  now: number
): Promise<number> {
  return sendDigestWithDm(slot, ctx, messages, ordered, now, {
    ...realSendDeps,
    kv: sdRealKv,
    allowListed: (userId) => checkSecretarySource({ type: "user", userId }).ok,
    profile: (userId) => lineFriendStatus(userId),
    pushUser: (userId, texts, key) =>
      pushMessagesWithRetryKeyIds(
        userId,
        texts.map((text) => ({ type: "text", text })),
        uuidv5(key, GS_RETRY_NAMESPACE),
        DM_PUSH_TIMEOUT_MS
      ),
  });
}

/** 毎分の見回りから：1対1 へ送って返事の無い分を、9時台（朝の分）・18時台（夕方の分）に1回だけグループへ張り出す。例外は投げない */
export async function runStaffDigestDmEscalationOnTick(now: number): Promise<void> {
  if (!staffDigestDmOn()) return;
  try {
    await runDmEscalationOnTick(now, process.env, {
      ...realSendDeps,
      push: pushEscalation,
      followup: followupEnabled(),
      kv: sdRealKv,
      // 引けないときは営業日として扱う（朝・夕方のまとめと同じ fail-open）
      closedToday: async (day) => closureOn(day, await loadClosures().catch(() => [])) !== null,
      fetchTasks: fetchLikeMorning,
    });
  } catch {
    log("[staff-digest] esc error");
  }
}

interface PassageEvent {
  type?: string;
  replyToken?: string;
  source?: { type?: string; userId?: string };
  message?: { id?: string; type?: string; text?: string; quotedMessageId?: string };
}

/**
 * 送り主の制限で断られた 1対1 のうち、個人 LINE のまとめを送った担当の返事だけを通す細い口。
 * 受ける条件（全部）：STAFF_DIGEST_DM=1・1対1 のメッセージ・許可リストに無い人・その人の控え staffdigest:dmuser:<userId> が生きている。
 * true を返したら、そのイベントはここで終わり（呼び手は何もせず次へ。ほかの機能へは渡さない）。
 * false は今までどおり「送り主の制限で読み飛ばし」。off・対象外は KV も読まない。例外は投げない。
 */
export async function staffDmPassage(
  event: PassageEvent,
  gateReason: string,
  parseCompletion: (line: string) => number[] | null
): Promise<boolean> {
  if (!dmPassageCandidate(event, gateReason)) return false;
  const userId = event.source!.userId as string;
  const messageId = event.message!.id as string;
  let rec: DmUserRec | null;
  try {
    rec = asDmUserRec(await bounded(sdRealKv.get(dmUserKey(userId))));
  } catch {
    log("[staff-digest] dm reply kv-failed");
    return false;
  }
  if (!rec) return false;
  // ここから先は、何があってもこの口で終わり（今ある機能へ落とさない）
  try {
    // 同じイベントが届き直しても2回書かない（今ある予約と同じ仕組み）
    const ev = await reserveEvent(messageId);
    if (!ev.proceed) return true;
    const replyToken = event.replyToken ?? "";
    // その人に送ったタスクだけ（番号が次の朝に振り直されたあと、同じ番号の別のタスクに当てない）
    const mine = new Map(rec.nums.map((n, i) => [n, pageKey(rec!.taskIds[i])]));
    const k = knownLineDeps(parseCompletion, (n, t) => mine.get(n) === pageKey(t.id));
    await handleDmReply({ kind: event.message?.type === "text" ? "text" : "other", text: event.message?.text }, rec, {
      now: Date.now,
      isKnown: k.isKnown,
      isOther: k.isOther,
      numbersOf: k.numbersOf,
      runKnown: k.runKnown,
      findByNumber: k.find,
      appendNote: appendTaskNote,
      senderName: () => senderName(userId),
      reply: async (text) => {
        if (replyToken) await sendLineMessage(replyToken, text);
      },
      note: (items, name) => noteItems(userId, items, name),
      // 引用先が、その人あての 1対1 のまとめか（番号の無い文のときだけ読む。2.5秒まで）
      quotedNums: async () => {
        const q = event.message?.quotedMessageId;
        if (!q) return null;
        const m = (await bounded(sdRealKv.get(digestMsgKey(q)))) as { dm?: unknown; uid?: unknown; nums?: unknown } | null;
        if (!m || m.dm !== true || m.uid !== userId || !Array.isArray(m.nums)) return null;
        return m.nums.filter((x): x is number => typeof x === "number");
      },
      noticeOnce: async () => (await kv.set(dmNoticeKey(userId), 1, { nx: true, ex: DM_NOTICE_TTL_SEC })) === "OK",
      log,
    });
    await completeEvent(messageId).catch(() => undefined);
  } catch {
    log("[staff-digest] dm reply error");
  }
  return true;
}
