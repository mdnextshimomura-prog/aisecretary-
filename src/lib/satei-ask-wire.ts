/**
 * 「案件はどれですか」のカード（satei-ask.ts）の本物へのつなぎ。
 * - KV：@vercel/kv（URL と TOKEN の両方があるときだけ。無ければ null＝口は unknown を返す）。
 * - CRM：ログを抑えた Notion Client（satei-wire.ts の makeSateiNotion）で、進行中の案件と CRM_物件 の物件名を読む（書かない）。
 * - LINE：push（X-Line-Retry-Key つき）。
 * ログは出さない（呼ぶ側が符号だけ出す）。
 */
import { kv } from "@vercel/kv";
import { pushMessagesWithRetryKey } from "./line";
import { completeEvent, reserveEvent } from "./email/session";
import { makeSateiNotion, readSateiDealPageReal } from "./satei-wire";
import { loadActiveDeals } from "./task-record-wire";
import {
  answerKey,
  SATEI_ASK_INDEX,
  SATEI_ASK_SEQ,
  type SateiAskActionDeps,
  type SateiAskAnswersDeps,
  type SateiAskDeps,
  type SateiAskKv,
} from "./satei-ask";

const crm = makeSateiNotion();

/**
 * 答えを置き（無ければ）、目次に載っていなければ通し番号（INCR）を振って載せる。Redis の中で1回に行うので、
 * 番号の小さい答えは必ず先に見える（Mac が位置を進めても、あとから小さい番号が現れることはない）。
 * 目次の要素は、数字だけの ID が読み出しで数に戻って桁が落ちないよう、頭に a: を付ける。
 * KEYS: 答え・目次・番号　ARGV: 答えの JSON・期限（秒）・目次の要素。新しく置いたら 1
 */
const SAVE_ANSWER_LUA = [
  "local created = 0",
  'if redis.call("EXISTS", KEYS[1]) == 0 then redis.call("SET", KEYS[1], ARGV[1], "EX", tonumber(ARGV[2])) created = 1 end',
  'if not redis.call("ZSCORE", KEYS[2], ARGV[3]) then local n = redis.call("INCR", KEYS[3]) redis.call("ZADD", KEYS[2], n, ARGV[3]) end',
  "return created",
].join(" ");
const log = (line: string) => console.log(line);

export function sateiAskKv(): SateiAskKv | null {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return {
    get: (key) => kv.get(key),
    setNx: async (key, value, ex) => (await kv.set(key, value, { nx: true, ex })) === "OK",
    set: async (key, value, ex) => {
      await kv.set(key, value, { ex });
    },
    del: async (key) => {
      await kv.del(key);
    },
    mget: async (keys) => (keys.length === 0 ? [] : ((await kv.mget(...keys)) as unknown[])),
    saveAnswer: async (askId, answer, ex) =>
      Number(
        await kv.eval(
          SAVE_ANSWER_LUA,
          [answerKey(askId), SATEI_ASK_INDEX, SATEI_ASK_SEQ],
          [JSON.stringify(answer), String(ex), `a:${askId}`],
        ),
      ) === 1,
    indexAfter: async (after, limit) => {
      const flat = (await kv.zrange(SATEI_ASK_INDEX, `(${after}`, "+inf", {
        byScore: true,
        withScores: true,
        offset: 0,
        count: limit,
      })) as unknown[];
      const out: Array<{ askId: string; seq: number }> = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const m = String(flat[i]);
        if (m.startsWith("a:")) out.push({ askId: m.slice(2), seq: Number(flat[i + 1]) });
      }
      return out;
    },
    indexRemove: async (askIds) => {
      if (askIds.length > 0) await kv.zrem(SATEI_ASK_INDEX, ...askIds.map((id) => `a:${id}`));
    },
  };
}

/** 案件の `物件` の1件目の CRM_物件 の物件名（title）。無ければ null。読めなければ例外 */
export async function readDealLabelReal(dealId: string): Promise<string | null> {
  const deal = await readSateiDealPageReal(dealId, crm);
  const propertyId = deal?.propertyIds[0];
  if (!propertyId) return null;
  let page: Record<string, unknown>;
  try {
    page = (await crm.pages.retrieve({ page_id: propertyId })) as unknown as Record<string, unknown>;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "object_not_found" || code === "validation_error") return null;
    throw err;
  }
  if (page.archived || page.in_trash) return null;
  const props = (page.properties as Record<string, unknown> | undefined) ?? {};
  const title = (props["物件名"] as { title?: Array<{ plain_text?: string }> } | undefined)?.title ?? [];
  const name = title.map((t) => t.plain_text ?? "").join("").trim();
  return name || null;
}

export function sateiAskDeps(): SateiAskDeps {
  return {
    env: process.env,
    kv: sateiAskKv(),
    loadDeals: () => loadActiveDeals(crm),
    push: (to, messages, retryKey) => pushMessagesWithRetryKey(to, messages, retryKey),
    now: () => Date.now(),
    log,
  };
}

export function sateiAskAnswersDeps(): SateiAskAnswersDeps {
  return { env: process.env, kv: sateiAskKv(), now: () => Date.now(), log };
}

export function sateiAskActionDeps(): Omit<SateiAskActionDeps, "reserve" | "complete" | "reply" | "log"> &
  Pick<SateiAskActionDeps, "reserve" | "complete"> {
  return {
    kv: sateiAskKv(),
    loadDeals: () => loadActiveDeals(crm),
    readLabel: (dealId) => readDealLabelReal(dealId),
    reserve: reserveEvent,
    complete: completeEvent,
    now: () => Date.now(),
  };
}
