/**
 * 案件ページに LINE の動きを溜める（deal-log.ts）を、本物の KV・Notion・名簿・CRM の案件につなぐ。
 * DEAL_LOG=1 のときだけ動く。off のあいだは KV・Notion・名簿を1回も呼ばない（Notion の Client も作らない）。
 * Notion は CRM の連携（CRM_NOTION_TOKEN、無ければ NOTION_API_KEY）で、SDK のログを出さない Client を使う（ID をログに出さないため）。
 */
import { Client } from "@notionhq/client";
import { kv } from "@vercel/kv";
import {
  DL_LAST_TTL_SEC, DL_MSG_TTL_SEC, DL_Q, DL_Q_MAX, DL_Q_TTL_SEC,
  captureDealLog, dealLogOn, flushDealLog,
  type DlCaptureDeps, type DlCaptureKv, type DlEvent, type DlFlushKv, type DlNotion, type DlOutcome,
} from "./deal-log";
import { loadMembers } from "./members";
import { loadActiveDeals } from "./task-record-wire";

// 発言の印を SET NX で取り、取れたときだけ：列に足す・切り詰める・期限を付ける・「最後のひも付け」を書く。
// 1回の呼び出しなので、途中で待つのをやめても、期限の無い列（発言の控え）や片方だけの印を残さない
const COMMIT_LUA =
  "if not redis.call('SET', KEYS[2], ARGV[4], 'NX', 'EX', tonumber(ARGV[5])) then return 0 end " +
  "redis.call('RPUSH', KEYS[1], ARGV[1]) redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1) redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3])) " +
  "if ARGV[6] ~= '' then redis.call('SET', KEYS[3], ARGV[6], 'EX', tonumber(ARGV[7])) end return 1";
// 列の頭の taken 行を消し、手を付けなかった行を頭に（順番のまま）・失敗した行を後ろに戻して、期限を付け直す
const SETTLE_LUA =
  "redis.call('LTRIM', KEYS[1], tonumber(ARGV[1]), -1) local nh = tonumber(ARGV[3]) " +
  "for i = 3 + nh, 4, -1 do redis.call('LPUSH', KEYS[1], ARGV[i]) end " +
  "for i = 4 + nh, #ARGV do redis.call('RPUSH', KEYS[1], ARGV[i]) end " +
  "if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end return 1";

const captureKv: DlCaptureKv = {
  get: (key) => kv.get(key),
  commit: async (c) => {
    const r = await kv.eval(
      COMMIT_LUA,
      [DL_Q, c.msgKey, c.lastKey ?? `${c.msgKey}:-`],
      [
        JSON.stringify(c.row), String(DL_Q_MAX), String(DL_Q_TTL_SEC), JSON.stringify(c.row.dealId), String(DL_MSG_TTL_SEC),
        c.lastKey && c.last ? JSON.stringify(c.last) : "", String(DL_LAST_TTL_SEC),
      ],
    );
    return Number(r) === 1;
  },
};
const flushKv: DlFlushKv = {
  get: (key) => kv.get(key),
  set: async (key, value, ex) => {
    await kv.set(key, value, { ex });
  },
  setNx: async (key, value, ex) => (await kv.set(key, value, { nx: true, ex })) === "OK",
  peek: (count) => kv.lrange(DL_Q, 0, count - 1),
  settle: async (taken, head, tail) => {
    await kv.eval(SETTLE_LUA, [DL_Q], [String(taken), String(DL_Q_TTL_SEC), String(head.length), ...head.map((r) => JSON.stringify(r)), ...tail.map((r) => JSON.stringify(r))]);
  },
};

let quiet: Client | null = null;
const crm = (): Client => {
  quiet ??= new Client({ auth: process.env.CRM_NOTION_TOKEN ?? process.env.NOTION_API_KEY, logger: () => undefined });
  return quiet;
};
const realNotion: DlNotion = {
  list: async (pageId, cursor) => {
    const r = await crm().blocks.children.list({ block_id: pageId, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    return { results: r.results, next: r.has_more ? (r.next_cursor ?? null) : null };
  },
  append: async (pageId, children) => {
    await crm().blocks.children.append({ block_id: pageId, children: children as Parameters<Client["blocks"]["children"]["append"]>[0]["children"] });
  },
};

const captureDeps = (): DlCaptureDeps => ({
  on: true,
  botUserId: process.env.LINE_BOT_USER_ID ?? null,
  loadDeals: () => loadActiveDeals(crm()),
  nameOf: async (userId) => (await loadMembers()).find((m) => m.userIds.includes(userId))?.name ?? null,
  kv: captureKv,
});

/**
 * webhook の1回の POST のあいだの控え。add は待たずに始めるだけ（同じ POST の中では届いた順に1件ずつ＝
 * 「文字 → 続きの画像」が同じ束で来ても、文字の印が先に付く）。done を POST の返す直前に待つ。
 * off のあいだは何も呼ばず、ログも出さない。どちらも例外を投げない。
 */
export function dealLogBatch(): { add(ev: DlEvent): void; done(): Promise<void> } {
  const on = dealLogOn();
  let chain: Promise<void> = Promise.resolve();
  let seen = 0;
  let hit = 0;
  let failed = 0;
  return {
    add(ev) {
      if (!on || !ev.groupId) return;
      seen++;
      chain = chain.then(async () => {
        const r: DlOutcome = await captureDealLog(ev, captureDeps()).catch(() => "error" as const);
        if (r === "name" || r === "quote" || r === "follow") hit++;
        else if (r === "error") failed++;
      });
    },
    async done() {
      if (!on || seen === 0) return;
      await chain.catch(() => undefined);
      // 件数だけ（本文・名前・ID は出さない）。skip＝案件を決められなかった発言（溜めない）
      console.log(`[deal-log] in ${seen} hit ${hit} skip ${seen - hit - failed} error ${failed}`);
    },
  };
}

/** 毎分の見回りから：2分に1回、たまった行を案件のページへ。off なら KV も触らない。例外は投げない */
export async function flushDealLogOnTick(now: number): Promise<void> {
  if (!dealLogOn()) return;
  await flushDealLog(now, {
    on: true,
    kv: flushKv,
    notion: realNotion,
    loadDeals: () => loadActiveDeals(crm()),
    log: (line) => console.log(line),
  }).catch(() => undefined);
}
