/**
 * 画像のあとの「@下村」だけの名指し（photo-ask.ts）の本物へのつなぎ。
 * 画像は既存の控え（emailmedia:<group>:<user>）から ID で取り、既存のタスク判定（Claude）で読む。
 * 控えは消さない（あとで @AI秘書 あての依頼が来たときに今までどおり使う）。
 * ログは符号だけ：画像は自前で取る（既存の fetchLineContent は失敗時に ID を出す）、CRM はログを抑えた Notion Client で読む。
 * それぞれに時間の上限を付ける。
 */
import { Client } from "@notionhq/client";
import { kv } from "@vercel/kv";
import { parseTaskFromMessage, type TaskAttachment } from "./claude";
import { getPendingMediaList } from "./email/session";
import { pushMessagesWithRetryKey } from "./line";
import { PHOTO_ASK_RESERVE_TTL, type PhotoAskDeps } from "./photo-ask";
import { uuidv5 } from "./satei-notify";
import { loadActiveDeals } from "./task-record-wire";
import { GS_STAGE2_SET, gsOpenKey, gsTicketKey, gsWaitKey } from "./group-satei-data";
import { GS_YIELD_SCAN_MAX } from "./group-satei-gate";

// X-Line-Retry-Key の uuidv5 の名前空間（固定。変えると送り直しの二重防止が効かなくなる）
export const PHOTO_ASK_RETRY_NAMESPACE = "7b1e4c2a-5d3f-4a8b-9c6e-0f2d4a6b8c1e";
const CONTENT_TIMEOUT_MS = 8_000;
const READ_TIMEOUT_MS = 40_000;
const DEALS_TIMEOUT_MS = 8_000;
// 段2f：グループ査定の受付票を読む上限（譲るかの判定。押されたあと gathering 以降の票は open から外れるので、待ち・見回りの集合も見る）
const GS_TICKETS_TIMEOUT_MS = 3_000;

/** 段2f（F1(b)）：そのグループの開いている票・事例待ちの票と、見回りの票（ほかのグループの分は photo-ask 側で外す） */
export async function listGsTicketsReal(groupId: string): Promise<unknown[]> {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return [];
  const ids = new Set<string>();
  for (const k of [gsOpenKey(groupId), gsWaitKey(groupId), GS_STAGE2_SET]) {
    for (const x of (await kv.smembers<unknown[]>(k)) ?? []) if (typeof x === "string") ids.add(x);
  }
  const list = Array.from(ids).slice(0, GS_YIELD_SCAN_MAX);
  return Promise.all(list.map((tid) => kv.get(gsTicketKey(tid))));
}
// Claude に渡せる添付のサイズ上限（media.ts と同じ考え方）
const MAX_BYTES = 3.5 * 1024 * 1024;

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function imageMediaType(ct: string): TaskAttachment["mediaType"] {
  if (/png/i.test(ct)) return "image/png";
  if (/webp/i.test(ct)) return "image/webp";
  if (/gif/i.test(ct)) return "image/gif";
  return "image/jpeg";
}

/** 1枚でも取れない・大きすぎる・時間切れなら例外（一部の画像だけで判定しない）。ログは出さない */
export async function loadPhotoAskImages(ids: string[], fetchImpl: typeof fetch = fetch): Promise<TaskAttachment[]> {
  const out: TaskAttachment[] = [];
  for (const id of ids) {
    const res = await fetchImpl(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(id)}/content`, {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN ?? ""}` },
      signal: AbortSignal.timeout(CONTENT_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) throw new Error("content");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) throw new Error("size");
    out.push({ kind: "image", mediaType: imageMediaType(res.headers.get("content-type") ?? ""), base64: buf.toString("base64") });
  }
  return out;
}

// CRM はログを抑えた Client で読む（SDK の既定のログは失敗時に応答の中身を出すため）
let quietNotion: Client | null = null;
const quietCrm = () =>
  (quietNotion ??= new Client({ auth: process.env.CRM_NOTION_TOKEN ?? process.env.NOTION_API_KEY, logger: () => undefined }));

export function photoAskDeps(
  today: string,
  o: { fetchImpl?: typeof fetch; parse?: typeof parseTaskFromMessage } = {},
): PhotoAskDeps {
  const fetchImpl = o.fetchImpl ?? fetch;
  const parse = o.parse ?? parseTaskFromMessage;
  return {
    listMedia: (groupId, senderId) => getPendingMediaList(groupId, senderId),
    // KV が無い（手元の開発）ときは予約できない＝聞かない（二重に聞くより聞かない側に倒す）
    reserve: async (key) => {
      if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return false;
      return (await kv.set(`photoask:${key}`, 1, { nx: true, ex: PHOTO_ASK_RESERVE_TTL })) === "OK";
    },
    read: async (ids, text) => {
      const attachments = await loadPhotoAskImages(ids, fetchImpl);
      const p = await within(parse(text, today, attachments), READ_TIMEOUT_MS);
      return {
        isTask: p.isTask,
        requestType: p.requestType,
        confidence: p.confidence,
        propertyName: p.propertyName ?? null,
        propertyKey: p.propertyKey ?? null,
      };
    },
    loadDeals: () => within(loadActiveDeals(quietCrm()), DEALS_TIMEOUT_MS),
    push: async (to, text, card, key) => {
      const messages = card ? [{ type: "text", text }, card] : [{ type: "text", text }];
      const status = await pushMessagesWithRetryKey(to, messages, uuidv5(key, PHOTO_ASK_RETRY_NAMESPACE), undefined, fetchImpl);
      return status !== null && ((status >= 200 && status < 300) || status === 409);
    },
    log: (l) => console.log(l),
    listGsTickets: (groupId) => within(listGsTicketsReal(groupId), GS_TICKETS_TIMEOUT_MS),
  };
}
