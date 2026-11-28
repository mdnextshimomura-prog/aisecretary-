/**
 * 担当へのまとめ・段階3 を、本物の KV・LINE・Notion・名簿につなぐ（判断と文は staff-digest-reply.ts）。
 * どの入口も、STAFF_DIGEST が off なら KV・Notion・名簿を1回も呼ばずに返る。例外は投げない。
 */
import { kv } from "@vercel/kv";
import { inboxOwner } from "./candidate-card";
import { GS_RETRY_NAMESPACE } from "./group-satei-data";
import { pushLineChunksWithIds, pushMessagesWithRetryKey, sendLineMessage } from "./line";
import { loadMembers } from "./members";
import { appendTaskNote, completeTask, findTaskByRemindNumber, jstDateStr } from "./notion";
import { uuidv5 } from "./satei-notify";
import { DIGEST_GROUP_ID, staffDigestOn } from "./staff-digest";
import {
  askNudge,
  flushForward,
  handleDigestReply,
  handleSdPostback,
  recordReplies,
  saveMorningSnapshot,
  statusWhat,
  type ReplyItem,
  type SdKv,
} from "./staff-digest-reply";
import { applyStatusCommand, followupEnabled, type StatusDeps } from "./task-status";
import { parseStatusCommand } from "./task-status-command";
import { statusDeps } from "./task-status-wire";

const FWD_LIST_MAX = 200;
const FWD_LIST_TTL_SEC = 3 * 24 * 60 * 60;
/** 今ある返事のあとに足す控えは、ここまでしか待たない（KV・名簿が遅くても webhook を止めない） */
const NOTE_TIMEOUT_MS = 3_000;

const realKv: SdKv = {
  get: (key) => kv.get(key),
  set: async (key, value, ex) => {
    await kv.set(key, value, { ex });
  },
  setNx: async (key, value, ex) => (await kv.set(key, value, { nx: true, ex })) === "OK",
  del: async (key) => {
    await kv.del(key);
  },
  rpush: async (key, values) => {
    if (values.length === 0) return;
    await kv.rpush(key, ...values);
    // 送れない日が続いても列を伸ばし続けない
    await kv.ltrim(key, -FWD_LIST_MAX, -1);
    await kv.expire(key, FWD_LIST_TTL_SEC);
  },
  lrange: (key, start, stop) => kv.lrange(key, start, stop),
  ltrim: async (key, start, stop) => {
    await kv.ltrim(key, start, stop);
  },
  sadd: async (key, members, ex) => {
    if (members.length === 0) return;
    await kv.sadd(key, members[0], ...members.slice(1));
    await kv.expire(key, ex);
  },
  smembers: async (key) => (await kv.smembers(key)).map(String),
};

const log = (line: string) => console.log(line);
const pushOwner = (to: string, messages: unknown[], key: string) =>
  pushMessagesWithRetryKey(to, messages, uuidv5(key, GS_RETRY_NAMESPACE));

const within = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

/** 名簿の名前（LINE のプロフィールは読まない）。分からなければ null */
async function senderName(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  try {
    const members = await within(loadMembers(), NOTE_TIMEOUT_MS, []);
    return members.find((m) => m.userIds.includes(userId))?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * グループでの番号・引用の返事でタスクが動いたあとに呼ぶ（今ある返事の後ろ）。
 * 「返事があった」印と、下村さんへの知らせの列に足す。off・1対1・0件なら何もしない。例外は投げない。
 */
export async function noteGroupReply(
  src: { groupId?: string | null; userId?: string | null },
  items: Array<{ id: string; title: string }>,
  what: string
): Promise<void> {
  if (!staffDigestOn() || !src.groupId || items.length === 0) return;
  await noteItems(src.userId, items.map((t) => ({ id: t.id, title: t.title, what })), undefined);
}

async function noteItems(userId: string | null | undefined, items: ReplyItem[], name: string | null | undefined): Promise<void> {
  try {
    await within(
      (async () => {
        const who = name === undefined ? await senderName(userId) : name;
        await recordReplies({ userId, name: who, items, now: Date.now() }, { kv: realKv, owner: inboxOwner(), log });
      })(),
      NOTE_TIMEOUT_MS,
      undefined
    );
  } catch {
    log("[staff-digest] fwd note-failed");
  }
}

/** 状況の返事（applyStatusCommand）が番号で引けたタスクを横で控える（今の処理は変えない） */
export function tapFound(deps: StatusDeps): { deps: StatusDeps; hits: Array<{ id: string; title: string }> } {
  const hits: Array<{ id: string; title: string }> = [];
  return {
    hits,
    deps: {
      ...deps,
      findByNumber: async (n) => {
        const t = await deps.findByNumber(n);
        if (t) hits.push(t);
        return t;
      },
    },
  };
}

/**
 * webhook から：まとめを引用した「番号＋自由な文」の返信を進捗として受ける。
 * parseCompletion は route.ts の「3済」の読み方（今の言葉かどうかの見分けと、進捗と混ざった行の実行に使う）。
 * handled が false なら、呼び手は今までの流れをそのまま続ける。
 */
export async function tryDigestProgressReply(o: {
  text: string;
  quotedMessageId?: string | null;
  groupId?: string | null;
  userId?: string | null;
  replyToken: string;
  parseCompletion(line: string): number[] | null;
}): Promise<{ handled: boolean; committed: boolean }> {
  if (!staffDigestOn() || !o.groupId || !o.quotedMessageId) return { handled: false, committed: false };
  const followup = followupEnabled();
  const today = jstDateStr(0);
  const find = (n: number) => findTaskByRemindNumber(n, { anyDue: followup, inGroup: true });
  try {
    return await handleDigestReply(o, {
      now: Date.now,
      kv: realKv,
      // route.ts と同じ順：状況の言葉（待ち・延期・不要）を先に見てから、番号での完了
      isKnown: (line) => (followup && parseStatusCommand(line, today) !== null) || o.parseCompletion(line) !== null,
      runKnown: async (line) => {
        const cmd = followup ? parseStatusCommand(line, today) : null;
        if (cmd) {
          const tap = tapFound(statusDeps(true));
          const r = await applyStatusCommand(cmd, tap.deps);
          return { text: r.text, changed: r.changed > 0 ? tap.hits.map((t) => ({ ...t, what: statusWhat(cmd) })) : [] };
        }
        const done: Array<{ n: number; id: string; title: string }> = [];
        const notFound: number[] = [];
        for (const n of o.parseCompletion(line) ?? []) {
          const t = await find(n);
          if (!t) {
            notFound.push(n);
            continue;
          }
          await completeTask(t.id);
          done.push({ n, ...t });
        }
        const lines: string[] = [];
        if (done.length > 0) lines.push(`☑️ 完了にしました（${done.length}件）`, ...done.map((d) => `${d.n}. ${d.title}`));
        if (notFound.length > 0) lines.push(`⚠️ ${notFound.join("・")}番は見つかりませんでした`, "（完了済みか、直近のリマインドに無い番号です）");
        return { text: lines.join("\n"), changed: done.map((d) => ({ id: d.id, title: d.title, what: "済" })) };
      },
      findByNumber: find,
      appendNote: appendTaskNote,
      senderName,
      reply: async (text) => {
        await sendLineMessage(o.replyToken, text);
      },
      note: (items, name) => noteItems(o.userId, items, name),
      log,
    });
  } catch {
    log("[staff-digest] reply error");
    return { handled: false, committed: false };
  }
}

/** 毎分の見回りから：たまった返事を30分に1回、下村さんの 1対1 へ1通。例外は投げない */
export async function flushStaffDigestForwardOnTick(now: number): Promise<void> {
  if (!staffDigestOn()) return;
  await flushForward(now, { kv: realKv, owner: inboxOwner(), push: pushOwner, log }).catch(() => undefined);
}

/** 夕方のまとめの直前に：朝のまとめに返事の無いタスクを、下村さんへ［催促する］のカードで知らせる */
export async function askNudgeBeforeEvening(
  day: string,
  all: Array<{ id: string; status: string; dueDate: string }>
): Promise<void> {
  await askNudge(day, all, { kv: realKv, owner: inboxOwner(), push: pushOwner, log });
}

/** 朝のまとめを送れたあとに：出したタスクを控える（催促の判定用） */
export async function saveMorningSnapshotReal(
  day: string,
  ordered: Parameters<typeof saveMorningSnapshot>[1]
): Promise<void> {
  await saveMorningSnapshot(day, ordered, realKv, log);
}

/** ［催促する］（v1|sd|<日付>）の postback */
export async function handleStaffDigestPostback(
  a: { day: string },
  src: { userId?: string | null },
  reply: (text: string) => Promise<void>
): Promise<void> {
  await handleSdPostback(a, src, {
    kv: realKv,
    owner: inboxOwner(),
    now: Date.now,
    pushGroup: (chunks) => pushLineChunksWithIds(DIGEST_GROUP_ID, chunks),
    reply,
    log,
  });
}
