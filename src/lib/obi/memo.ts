/**
 * 帯替え用の PDF の控え（設計 2026-10-09 の 9）。既存のメール・タスク用の控え（emailmedia 等）とは別。
 *
 * 置き場：Vercel KV
 *   - sorted set `obi-pdf:z:<groupId>`：member＝`m:<message.id>`、score＝LINE のイベントの時刻（ms）
 *   - hash       `obi-pdf:h:<groupId>`：field＝`m:<message.id>`、value＝詳細（JSON）
 * member に `m:` を付けるのは、KV の読み出しが数字だけの文字列を数値に読み替え、
 * 安全な整数を超える message.id の桁が丸められるのを避けるため。
 *
 * 足すときは zadd（同時に届いても上書きしない。同じ message.id の再送は同じ member なので重複しない）。
 * 1時間より古いものは追加のときに並び（zremrangebyscore）と詳細（hdel）の両方から消し、キー全体の期限も1時間にする。
 */
import { kv } from "@vercel/kv";

export interface ObiPdfRecord {
  messageId: string;
  fileName: string;
  size: number; // LINE の fileSize（バイト）。分からなければ 0
  timestamp: number; // LINE のイベントの時刻（ms）
  userId: string; // 貼った人
}

export const OBI_WINDOW_MS = 30 * 60 * 1000; // 依頼からさかのぼる時間
export const OBI_RETENTION_MS = 60 * 60 * 1000; // 控えを残す時間
export const OBI_MEMO_TTL_SECONDS = 60 * 60;
export const OBI_MAX_FILES = 20;
export const OBI_MAX_TOTAL_BYTES = 25_000_000;
// 「返事は1回だけ」の印の期限。LINE の再送はこれより短い間に来る
export const OBI_NOTIFY_TTL_SECONDS = 24 * 60 * 60;

const MESSAGE_ID_RE = /^\d{1,64}$/;

export interface ObiStore {
  /** 控えに足す。score が removeBefore より小さいものは並びと詳細の両方から消す */
  addPdf(groupId: string, rec: ObiPdfRecord, removeBefore: number): Promise<void>;
  /** 時刻が minTs 以上 maxTs 以下の控え（並びは問わない） */
  listPdfs(groupId: string, minTs: number, maxTs: number): Promise<ObiPdfRecord[]>;
  /** 無ければ置く（NX）。置けたら true */
  setNx(key: string, ttlSeconds: number): Promise<boolean>;
  /** 印があるか（期限内のものだけ） */
  has(key: string): Promise<boolean>;
}

/** createKvObiStore が使う KV の操作（テストで偽物に差し替えられるよう、使う分だけ） */
export interface ObiKvClient {
  hset(key: string, values: Record<string, string>): Promise<unknown>;
  zadd(key: string, sm: { score: number; member: string }): Promise<unknown>;
  zrange(key: string, min: number | "-inf", max: number, opts: { byScore: true }): Promise<string[] | null>;
  zremrangebyscore(key: string, min: number | "-inf", max: number): Promise<unknown>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  hmget(key: string, ...fields: string[]): Promise<Record<string, unknown> | null>;
  expire(key: string, seconds: number): Promise<unknown>;
  set(key: string, value: number, opts: { nx: true; ex: number }): Promise<unknown>;
  exists(key: string): Promise<number>;
}

const zKey = (groupId: string) => `obi-pdf:z:${groupId}`;
const hKey = (groupId: string) => `obi-pdf:h:${groupId}`;
const memberOf = (messageId: string) => `m:${messageId}`;

function parseDetail(v: unknown): ObiPdfRecord | null {
  let o: unknown = v;
  if (typeof v === "string") {
    try {
      o = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (
    typeof r.messageId !== "string" ||
    typeof r.fileName !== "string" ||
    typeof r.size !== "number" ||
    typeof r.timestamp !== "number" ||
    typeof r.userId !== "string"
  ) {
    return null;
  }
  return {
    messageId: r.messageId,
    fileName: r.fileName,
    size: r.size,
    timestamp: r.timestamp,
    userId: r.userId,
  };
}

export function createKvObiStore(client: ObiKvClient): ObiStore {
  return {
    async addPdf(groupId, rec, removeBefore) {
      const z = zKey(groupId);
      const h = hKey(groupId);
      const m = memberOf(rec.messageId);
      // 詳細を先に置く（並びにあるのに詳細が無い、を作らない）
      await client.hset(h, { [m]: JSON.stringify(rec) });
      await client.zadd(z, { score: rec.timestamp, member: m });
      const old = (await client.zrange(z, "-inf", removeBefore - 1, { byScore: true })) ?? [];
      if (old.length > 0) {
        await client.zremrangebyscore(z, "-inf", removeBefore - 1);
        await client.hdel(h, ...old);
      }
      await client.expire(z, OBI_MEMO_TTL_SECONDS);
      await client.expire(h, OBI_MEMO_TTL_SECONDS);
    },
    async listPdfs(groupId, minTs, maxTs) {
      const members = (await client.zrange(zKey(groupId), minTs, maxTs, { byScore: true })) ?? [];
      if (members.length === 0) return [];
      const details = (await client.hmget(hKey(groupId), ...members)) ?? {};
      const out: ObiPdfRecord[] = [];
      for (const m of members) {
        const rec = parseDetail(details[m]);
        if (rec) out.push(rec);
        else console.error("帯替えの控え：詳細が読めないものを飛ばす:", m);
      }
      return out;
    },
    async setNx(key, ttlSeconds) {
      return (await client.set(key, 1, { nx: true, ex: ttlSeconds })) === "OK";
    },
    async has(key) {
      return (await client.exists(key)) > 0;
    },
  };
}

export type MemoryObiStore = ObiStore & {
  /** テスト用：並びと詳細に残っている件数 */
  sizes(groupId: string): { z: number; h: number };
};

/** KV が無い環境（手元・テスト）用。同じインスタンスの中だけで持つ */
export function createMemoryObiStore(now: () => number = Date.now): MemoryObiStore {
  const sets = new Map<string, Map<string, number>>();
  const hashes = new Map<string, Map<string, string>>();
  const flags = new Map<string, number>();
  return {
    async addPdf(groupId, rec, removeBefore) {
      const z = sets.get(groupId) ?? new Map<string, number>();
      const h = hashes.get(groupId) ?? new Map<string, string>();
      const m = memberOf(rec.messageId);
      h.set(m, JSON.stringify(rec));
      z.set(m, rec.timestamp);
      for (const [k, score] of Array.from(z.entries())) {
        if (score < removeBefore) {
          z.delete(k);
          h.delete(k);
        }
      }
      sets.set(groupId, z);
      hashes.set(groupId, h);
    },
    async listPdfs(groupId, minTs, maxTs) {
      const z = sets.get(groupId);
      const h = hashes.get(groupId);
      if (!z || !h) return [];
      const out: ObiPdfRecord[] = [];
      for (const [m, score] of Array.from(z.entries())) {
        if (score < minTs || score > maxTs) continue;
        const rec = parseDetail(h.get(m));
        if (rec) out.push(rec);
      }
      return out;
    },
    async setNx(key, ttlSeconds) {
      const t = now();
      const exp = flags.get(key);
      if (exp !== undefined && exp > t) return false;
      flags.set(key, t + ttlSeconds * 1000);
      return true;
    },
    async has(key) {
      const exp = flags.get(key);
      return exp !== undefined && exp > now();
    },
    sizes(groupId) {
      return { z: sets.get(groupId)?.size ?? 0, h: hashes.get(groupId)?.size ?? 0 };
    },
  };
}

const realKv: ObiKvClient = {
  hset: (key, values) => kv.hset(key, values),
  zadd: (key, sm) => kv.zadd(key, sm),
  zrange: (key, min, max, opts) => kv.zrange<string[]>(key, min, max, opts),
  zremrangebyscore: (key, min, max) => kv.zremrangebyscore(key, min, max),
  hdel: (key, ...fields) => kv.hdel(key, ...fields),
  hmget: (key, ...fields) => kv.hmget<Record<string, unknown>>(key, ...fields),
  expire: (key, seconds) => kv.expire(key, seconds),
  set: (key, value, opts) => kv.set(key, value, opts),
  exists: (key) => kv.exists(key),
};

let memoryFallback: MemoryObiStore | null = null;

/** 本番は KV。KV の設定が無い環境では同じインスタンスの中のメモリ（既存の session.ts と同じ考え方） */
export function getObiStore(): ObiStore {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return createKvObiStore(realKv);
  }
  memoryFallback ??= createMemoryObiStore();
  return memoryFallback;
}

/** 営業部のグループに出た PDF を控える（呼び出し側で shouldRecordObiPdf を確かめてから） */
export async function recordObiPdf(
  store: ObiStore,
  groupId: string,
  rec: ObiPdfRecord
): Promise<void> {
  if (!MESSAGE_ID_RE.test(rec.messageId)) {
    console.error("帯替えの控え：message.id の形が違うので控えない");
    return;
  }
  await store.addPdf(groupId, rec, rec.timestamp - OBI_RETENTION_MS);
}

export type ObiSelection =
  | { kind: "none" }
  | { kind: "too-many"; count: number }
  | { kind: "too-large"; totalBytes: number }
  | { kind: "ok"; pdfs: ObiPdfRecord[] };

function compareId(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * 依頼に使う PDF を選ぶ。
 *   - 依頼の時刻から30分以内（境目を含む）・依頼の時刻以前・message.id が依頼より小さい
 *   - ファイル名が .pdf
 *   - 21件以上なら1件も使わない。控えの大きさの合計が上限を超えても使わない
 *   - 並びは時刻の古い順、同じ時刻は message.id を数として小さい順（安全な整数を超えうるので BigInt）
 */
export function selectObiPdfs(
  records: ObiPdfRecord[],
  request: { messageId: string; timestamp: number }
): ObiSelection {
  const seen = new Set<string>();
  const picked = records.filter((r) => {
    if (!MESSAGE_ID_RE.test(r.messageId) || seen.has(r.messageId)) return false;
    if (!/\.pdf$/i.test(r.fileName.trim())) return false;
    if (r.timestamp < request.timestamp - OBI_WINDOW_MS || r.timestamp > request.timestamp) return false;
    if (compareId(r.messageId, request.messageId) >= 0) return false;
    seen.add(r.messageId);
    return true;
  });
  picked.sort((a, b) => a.timestamp - b.timestamp || compareId(a.messageId, b.messageId));
  if (picked.length === 0) return { kind: "none" };
  if (picked.length > OBI_MAX_FILES) return { kind: "too-many", count: picked.length };
  const totalBytes = picked.reduce((sum, r) => sum + (r.size > 0 ? r.size : 0), 0);
  if (totalBytes > OBI_MAX_TOTAL_BYTES) return { kind: "too-large", totalBytes };
  return { kind: "ok", pdfs: picked };
}
