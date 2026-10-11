/**
 * クラウド配達（毎分の見回り）の KV：錠・控え・目次・待ち時間・知らせの id の控え
 * （約束 2026-10-11-obi-cloud-contract.md の「KV の鍵」）。
 *
 *   obi-cloud:lock                       "1"（NX）                90秒
 *   obi-cloud:job:<no>                   控え（下の CloudJobMemo）  書くたびに 3,600 秒
 *   obi-cloud:jobs                       目次（set）。値は受付番号   なし
 *   obi-cloud:notice-msgs                目次（set）。値は <no>:<choiceGen>  なし
 *   obi-cloud:retry:<no>:<sha256>        { count, lastAt }         7日
 *   obi-cloud:notice-msg:<no>:<choiceGen> { messageId, tries }     24時間
 *
 * - 残っている控えは、目次の set（SMEMBERS）で見つける。SCAN は使わない
 * - 控えに入れてよい文の材料は facts の5項目だけ（LINE の ID・groupId・本文・トークン・リンク・生の物件名は入れない）
 * - どの操作も、失敗・2秒の時間切れは例外（「書けた」と言えないものは、書けなかったとして扱う）。
 *   例外にしないのは「消した後の SREM」と「掃除の SREM」だけ（次の回の掃除が拾う）
 * - メモリへの代わりは作らない（KV が無ければ、入口が共通の設定の不足として見回りを飛ばす）
 * 既存の memo.ts は変えない・読み込まない。
 */
import { kv } from "@vercel/kv";
import { readCompletionFacts, type CompletionFacts } from "./cloud-text";

// prepared＝予約が取れた直後／attempt-requested＝portal の delivery/attempt を呼ぶ直前（LINE は呼んでいない）／
// attempting＝portal の attempt が 200 を返した直後・push の直前（LINE を呼んだかもしれない）／sent＝push が通った後
export type CloudStage = "prepared" | "attempt-requested" | "attempting" | "sent";

/** 控えの facts。CompletionFacts（4項目）＋整えた後の物件名。入れてよいのは、この5項目だけ */
export type CloudMemoFacts = CompletionFacts & {
  /** cloudProperty を通した後の文字列（60字＋… まで。空のこともある）。生の物件名は入れない */
  property: string;
};

/** 書く控え（約束の形。leaseUntil・facts は省けない） */
export interface CloudJobMemo {
  v: 1;
  claimId: string;
  sha256: string;
  stage: CloudStage;
  /** 予約の応答の leaseUntil をそのまま */
  leaseUntil: string;
  facts: CloudMemoFacts;
  messageId?: string;
  msgTries?: number;
  /** この控えを最後に書いた時刻（ISO） */
  at: string;
}

/**
 * 読んだ控え。leaseUntil・facts が無い・形が違う控えは、その項目を null にして返す
 * （claimId と sha256 が読めれば、予約を完成へ返す・結果を報告することはできる）
 */
export type CloudJobMemoRead = Omit<CloudJobMemo, "leaseUntil" | "facts"> & {
  leaseUntil: string | null;
  facts: CloudMemoFacts | null;
};

export interface CloudStore {
  acquireLock(): Promise<boolean>; // 置けたら true
  releaseLock(): Promise<void>;
  /** 目次 obi-cloud:jobs の受付番号（小さい順・limit 件まで）。形の違う値は、その場で SREM する */
  listJobNos(limit: number): Promise<number[]>;
  /** 無ければ null。形が違えば "invalid" */
  getJob(no: number): Promise<CloudJobMemoRead | null | "invalid">;
  /** 先に SADD obi-cloud:jobs <no>。足せなければ例外（控えは書かない）。その後に SET */
  putJob(no: number, memo: CloudJobMemo): Promise<void>;
  /** DEL の後に SREM obi-cloud:jobs <no>。DEL の失敗は例外。SREM の失敗は握りつぶす */
  delJob(no: number): Promise<void>;
  /** 掃除。控えの無い番号を目次から外す（SREM。失敗しても例外にしない） */
  unindexJob(no: number): Promise<void>;
  getRetry(no: number, sha256: string): Promise<{ count: number; lastAt: string } | null>;
  bumpRetry(no: number, sha256: string, nowIso: string): Promise<void>; // count を1つ足す
  clearRetry(no: number, sha256: string): Promise<void>;
  /** 目次 obi-cloud:notice-msgs の値（<no>:<choiceGen>）。形の違う値は、その場で SREM する */
  listNoticeMsgs(limit: number): Promise<Array<{ no: number; choiceGen: number }>>;
  getNoticeMsg(no: number, choiceGen: number): Promise<{ messageId: string; tries: number } | null>;
  /** 先に SADD obi-cloud:notice-msgs <no>:<choiceGen>。足せなければ例外（書かない）。その後に SET */
  putNoticeMsg(no: number, choiceGen: number, v: { messageId: string; tries: number }): Promise<void>;
  /** DEL の後に SREM（SREM の失敗は握りつぶす） */
  delNoticeMsg(no: number, choiceGen: number): Promise<void>;
  /** 掃除。値の無い <no>:<choiceGen> を目次から外す（失敗しても例外にしない） */
  unindexNoticeMsg(no: number, choiceGen: number): Promise<void>;
}

/** 使う分だけの KV の操作（テストで偽物に差し替える）。scan は持たない */
export interface CloudKvClient {
  set(key: string, value: string, opts: { ex: number; nx?: true }): Promise<unknown>; // NX で置けなければ null
  get(key: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  /** 値は文字列とは限らない（"12" を数に戻して返すことがある）。読む側で String(…) にそろえる */
  smembers(key: string): Promise<unknown[]>;
}

export const LOCK_KEY = "obi-cloud:lock";
export const JOBS_INDEX_KEY = "obi-cloud:jobs";
export const NOTICE_MSGS_INDEX_KEY = "obi-cloud:notice-msgs";
export const LOCK_TTL_SEC = 90;
export const JOB_MEMO_TTL_SEC = 3_600;
export const RETRY_TTL_SEC = 604_800;
export const NOTICE_MSG_TTL_SEC = 86_400;
/** KV の操作1回の上限 */
export const KV_OP_TIMEOUT_MS = 2_000;

const jobKey = (no: number) => `obi-cloud:job:${no}`;
const retryKey = (no: number, sha256: string) => `obi-cloud:retry:${no}:${sha256}`;
const noticeMsgKey = (no: number, gen: number) => `obi-cloud:notice-msg:${no}:${gen}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MESSAGE_ID_RE = /^\d{1,64}$/;
const NO_RE = /^[1-9][0-9]{0,8}$/;
const NOTICE_MSG_MEMBER_RE = /^([1-9][0-9]{0,8}):(0|[1-9][0-9]{0,14})$/;
const STAGES: ReadonlySet<string> = new Set<CloudStage>(["prepared", "attempt-requested", "attempting", "sent"]);
// 改行・制御文字・見えない文字（整えた後の物件名には残らないはずのもの）。字面は \u のエスケープのまま書く
const PROPERTY_BAD_RE = /[\u0000-\u001F\u007F\u0085\u2028\u2029\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/;
const FACT_KEYS = "fix,outsideErased,outsidePages,property,reviewPages";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === "string" && v !== "" && !Number.isNaN(Date.parse(v));
const intIn = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** 項目の順番によらない比べ方のための並べ直し */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

/** facts の検査。ちょうど5項目で、4項目は約束の読み方で読み直しても同じ・物件名は整えた後の形。違えば null */
export function readMemoFacts(v: unknown): CloudMemoFacts | null {
  if (!isObj(v)) return null;
  if (Object.keys(v).sort().join() !== FACT_KEYS) return null;
  const { property, ...four } = v;
  if (typeof property !== "string") return null;
  if (Array.from(property).length > 61 || PROPERTY_BAD_RE.test(property)) return null;
  const reread = readCompletionFacts(four);
  if (JSON.stringify(canonical(reread)) !== JSON.stringify(canonical(four))) return null;
  return { ...reread, property };
}

function readMemo(raw: unknown): CloudJobMemoRead | "invalid" {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return "invalid";
    }
  }
  if (!isObj(v)) return "invalid";
  if (v.v !== 1) return "invalid";
  if (typeof v.claimId !== "string" || !UUID_RE.test(v.claimId)) return "invalid";
  if (typeof v.sha256 !== "string" || !SHA256_RE.test(v.sha256)) return "invalid";
  if (typeof v.stage !== "string" || !STAGES.has(v.stage)) return "invalid";
  if (!isIso(v.at)) return "invalid";
  if (v.messageId !== undefined && (typeof v.messageId !== "string" || !MESSAGE_ID_RE.test(v.messageId))) return "invalid";
  if (v.msgTries !== undefined && !intIn(v.msgTries, 0, 3)) return "invalid";
  const memo: CloudJobMemoRead = {
    v: 1,
    claimId: v.claimId,
    sha256: v.sha256,
    stage: v.stage as CloudStage,
    leaseUntil: isIso(v.leaseUntil) ? v.leaseUntil : null,
    facts: readMemoFacts(v.facts),
    at: v.at,
  };
  if (v.messageId !== undefined) memo.messageId = v.messageId;
  if (v.msgTries !== undefined) memo.msgTries = v.msgTries;
  return memo;
}

const parseValue = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export class KvTimeout extends Error {
  constructor() {
    super("kv timeout");
    this.name = "KvTimeout";
  }
}

export function createKvCloudStore(client: CloudKvClient, opTimeoutMs: number = KV_OP_TIMEOUT_MS): CloudStore {
  /** 1回の操作に上限を掛ける。超えたら KvTimeout */
  const op = <T>(run: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new KvTimeout()), opTimeoutMs);
      let p: Promise<T>;
      try {
        p = run();
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  /** 失敗してもよい操作（消した後の SREM・掃除の SREM） */
  const quiet = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await op(run);
    } catch {
      /* 次の回の掃除が拾う */
    }
  };

  const getRetry = async (no: number, sha256: string): Promise<{ count: number; lastAt: string } | null> => {
    const v = parseValue(await op(() => client.get(retryKey(no, sha256))));
    if (!isObj(v) || !intIn(v.count, 1, Number.MAX_SAFE_INTEGER) || !isIso(v.lastAt)) return null;
    return { count: v.count, lastAt: v.lastAt };
  };

  return {
    async acquireLock() {
      const r = await op(() => client.set(LOCK_KEY, "1", { nx: true, ex: LOCK_TTL_SEC }));
      return r === "OK";
    },
    async releaseLock() {
      await op(() => client.del(LOCK_KEY));
    },

    async listJobNos(limit) {
      const members = await op(() => client.smembers(JOBS_INDEX_KEY));
      const nos = new Set<number>();
      for (const m of Array.isArray(members) ? members : []) {
        if (typeof m !== "string" && typeof m !== "number") continue; // 外しようがない値は飛ばす
        const s = String(m);
        if (NO_RE.test(s)) nos.add(Number(s));
        else await quiet(() => client.srem(JOBS_INDEX_KEY, s));
      }
      return Array.from(nos)
        .sort((a, b) => a - b)
        .slice(0, limit);
    },
    async getJob(no) {
      const raw = await op(() => client.get(jobKey(no)));
      if (raw === null || raw === undefined) return null;
      return readMemo(raw);
    },
    async putJob(no, memo) {
      // 書く前に、読むときと同じ検査を通す（入れてはいけない項目を、書く側の間違いで入れない）
      const checked = readMemo(JSON.parse(JSON.stringify(memo)));
      if (checked === "invalid" || checked.leaseUntil === null || checked.facts === null) {
        throw new Error("控えの形が違います");
      }
      const value: CloudJobMemo = { ...checked, leaseUntil: checked.leaseUntil, facts: checked.facts };
      await op(() => client.sadd(JOBS_INDEX_KEY, String(no)));
      await op(() => client.set(jobKey(no), JSON.stringify(value), { ex: JOB_MEMO_TTL_SEC }));
    },
    async delJob(no) {
      await op(() => client.del(jobKey(no)));
      await quiet(() => client.srem(JOBS_INDEX_KEY, String(no)));
    },
    async unindexJob(no) {
      await quiet(() => client.srem(JOBS_INDEX_KEY, String(no)));
    },

    getRetry,
    async bumpRetry(no, sha256, nowIso) {
      const cur = await getRetry(no, sha256);
      const next = { count: (cur?.count ?? 0) + 1, lastAt: nowIso };
      await op(() => client.set(retryKey(no, sha256), JSON.stringify(next), { ex: RETRY_TTL_SEC }));
    },
    async clearRetry(no, sha256) {
      await op(() => client.del(retryKey(no, sha256)));
    },

    async listNoticeMsgs(limit) {
      const members = await op(() => client.smembers(NOTICE_MSGS_INDEX_KEY));
      const out: Array<{ no: number; choiceGen: number }> = [];
      const seen = new Set<string>();
      for (const m of Array.isArray(members) ? members : []) {
        if (typeof m !== "string" && typeof m !== "number") continue;
        const s = String(m);
        const hit = NOTICE_MSG_MEMBER_RE.exec(s);
        if (!hit) {
          await quiet(() => client.srem(NOTICE_MSGS_INDEX_KEY, s));
          continue;
        }
        if (seen.has(s)) continue;
        seen.add(s);
        out.push({ no: Number(hit[1]), choiceGen: Number(hit[2]) });
      }
      return out.sort((a, b) => a.no - b.no || a.choiceGen - b.choiceGen).slice(0, limit);
    },
    async getNoticeMsg(no, choiceGen) {
      const v = parseValue(await op(() => client.get(noticeMsgKey(no, choiceGen))));
      if (!isObj(v) || typeof v.messageId !== "string" || !MESSAGE_ID_RE.test(v.messageId) || !intIn(v.tries, 0, 3)) {
        return null;
      }
      return { messageId: v.messageId, tries: v.tries };
    },
    async putNoticeMsg(no, choiceGen, v) {
      if (!MESSAGE_ID_RE.test(v.messageId) || !intIn(v.tries, 0, 3)) throw new Error("知らせの id の控えの形が違います");
      await op(() => client.sadd(NOTICE_MSGS_INDEX_KEY, `${no}:${choiceGen}`));
      await op(() =>
        client.set(noticeMsgKey(no, choiceGen), JSON.stringify({ messageId: v.messageId, tries: v.tries }), {
          ex: NOTICE_MSG_TTL_SEC,
        })
      );
    },
    async delNoticeMsg(no, choiceGen) {
      await op(() => client.del(noticeMsgKey(no, choiceGen)));
      await quiet(() => client.srem(NOTICE_MSGS_INDEX_KEY, `${no}:${choiceGen}`));
    },
    async unindexNoticeMsg(no, choiceGen) {
      await quiet(() => client.srem(NOTICE_MSGS_INDEX_KEY, `${no}:${choiceGen}`));
    },
  };
}

/** 実物の KV（@vercel/kv）。set の引数は「nx あり」と「nx なし」が別の形なので、分けて渡す（既存の memo.ts と同じ） */
export const realCloudKvClient: CloudKvClient = {
  set: (key, value, opts) => (opts.nx ? kv.set(key, value, { ex: opts.ex, nx: true }) : kv.set(key, value, { ex: opts.ex })),
  get: (key) => kv.get(key),
  del: (key) => kv.del(key),
  sadd: (key, member) => kv.sadd(key, member),
  srem: (key, member) => kv.srem(key, member),
  // 目次の値は文字列とは限らない（数に戻って返ることがある）。形は上の listJobNos・listNoticeMsgs が見る
  smembers: (key) => kv.smembers<unknown[]>(key),
};

export const getCloudStore = (): CloudStore => createKvCloudStore(realCloudKvClient);
