/**
 * 普通のグループの査定依頼（group-satei-*.ts）の本物へのつなぎ（段1）。
 * - KV：@vercel/kv（URL と TOKEN の両方があるときだけ）。
 * - 画像・PDF：LINE の content API から取る（ログを出さない。1件8秒）。Claude：Anthropic の SDK（初めて読むときに作る）。
 *   読み取りは資料の取得から Claude の答えまで合わせて40秒まで。
 * - CRM：ログを抑えた Notion Client（makeSateiNotion）。案件の種別は readSateiDealReal。
 * - portal の受付は sateiActionDeps().intake（今の［査定書を作る］と同じ）。
 * 入口（控え・入口 A・入口 B）はどれも、スイッチが off・対象外なら KV にも AI にも触れずに戻る。
 * 例外は投げない（webhook の今の流れ・返事を変えない）。replyToken は使わない（グループには何も返さない）。
 * ログは [group-satei] の符号だけ（ID・名前・本文は出さない）。
 */
import Anthropic from "@anthropic-ai/sdk";
import { kv } from "@vercel/kv";
import { parseTaskFromMessage, type TaskAttachment } from "./claude";
import { GS_MIN, GS_RETRY_NAMESPACE, groupSateiOn } from "./group-satei-data";
import { gsEntryAOk, gsEntryBGate, gsMediaRow, looksLikeSateiWords } from "./group-satei-gate";
import { openGroupSatei, recordGroupSateiMedia, type GsKv, type GsOpenDeps } from "./group-satei-open";
import type { GsActionDeps } from "./group-satei-actions";
import { readGsMaterials, type GsCreate } from "./group-satei-read";
import { pushMessagesWithRetryKey } from "./line";
import { loadMembers } from "./members";
import { normNotionId } from "./satei-deal";
import { uuidv5 } from "./satei-notify";
import { makeSateiNotion, readSateiDealReal, sateiActionDeps } from "./satei-wire";
import { loadActiveDeals } from "./task-record-wire";

const log = (l: string) => console.log(l);
const CONTENT_TIMEOUT_MS = 8_000;
const READ_TIMEOUT_MS = 40_000;
const CRM_TIMEOUT_MS = 8_000;
const MEDIA_KV_TIMEOUT_MS = 3_000;
// Claude に渡せる添付のサイズ上限（photo-ask-wire.ts・media.ts と同じ考え方）
const MAX_BYTES = 3.5 * 1024 * 1024;

let crmClient: ReturnType<typeof makeSateiNotion> | null = null;
const crm = () => (crmClient ??= makeSateiNotion());

export type GroupSateiKv = GsKv & { del(k: string): Promise<void>; srem(k: string, m: string): Promise<void> };

export function groupSateiKv(): GroupSateiKv | null {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return {
    get: (k) => kv.get(k),
    set: async (k, v, ex) => {
      await kv.set(k, v, { ex });
    },
    setNx: async (k, v, ex) => (await kv.set(k, v, { nx: true, ex })) === "OK",
    incr: (k) => kv.incr(k),
    expire: async (k, ex) => {
      await kv.expire(k, ex);
    },
    sadd: async (k, m) => {
      await kv.sadd(k, m);
    },
    srem: async (k, m) => {
      await kv.srem(k, m);
    },
    del: async (k) => {
      await kv.del(k);
    },
    // 末尾に足し、新しい max 件を残し、期限を付け直す
    lpushTrim: async (k, v, max, ex) => {
      await kv.rpush(k, JSON.stringify(v));
      await kv.ltrim(k, -max, -1);
      await kv.expire(k, ex);
    },
    // JSON の文字列のまま返ることがあるが、group-satei-open.ts の asMedia が文字列も読む
    lrange: (k) => kv.lrange(k, 0, -1),
  };
}

/** 待つのを ms で打ち切るだけ。元の処理（fetch・Claude・KV）は取り消さない（裏で続き、結果は捨てる） */
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

/** 1件でも取れない・大きすぎる・時間切れなら例外（一部だけで読まない）。ログは出さない */
export async function loadGroupSateiMaterials(ids: string[], fetchImpl: typeof fetch = fetch): Promise<TaskAttachment[]> {
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
    const ct = res.headers.get("content-type") ?? "";
    // ファイルの content-type が application/octet-stream のこともあるので、頭の %PDF でも見分ける
    const isPdf = /pdf/i.test(ct) || buf.subarray(0, 4).toString("latin1") === "%PDF";
    out.push(
      isPdf
        ? { kind: "pdf", mediaType: "application/pdf", base64: buf.toString("base64") }
        : { kind: "image", mediaType: imageMediaType(ct), base64: buf.toString("base64") },
    );
  }
  return out;
}

// Anthropic の Client は初めて読むときに作る（off のあいだは作らない）
let anthropic: Anthropic | null = null;
const create: GsCreate = (req) =>
  (anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })).messages.create(req as never) as never;

function ymdJst(ms: number): string {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 依頼者の名簿の名前（userId で引く）。引けなければ null（ログは出さない） */
async function requesterName(userId: string): Promise<string | null> {
  try {
    return (await loadMembers()).find((m) => m.userIds.includes(userId))?.name ?? null;
  } catch {
    return null;
  }
}

export function groupSateiOpenDeps(today: string): GsOpenDeps {
  return {
    kv: groupSateiKv(),
    now: () => Date.now(),
    today: () => today,
    ymd: () => ymdJst(Date.now()),
    read: (ids, text) =>
      within(
        (async () => readGsMaterials(await loadGroupSateiMaterials(ids), text, today, create))(),
        READ_TIMEOUT_MS,
      ),
    loadDeals: () => loadActiveDeals(crm()),
    kindOf: async (dealId) => (await readSateiDealReal(normNotionId(dealId), crm()))?.kind ?? null,
    requesterName,
    push: async (to, messages, key) => {
      const status = await pushMessagesWithRetryKey(to, messages, uuidv5(key, GS_RETRY_NAMESPACE));
      return status !== null && ((status >= 200 && status < 300) || status === 409);
    },
    log,
  };
}

export function groupSateiActionDeps(): Omit<GsActionDeps, "reserve" | "complete" | "reply" | "log"> {
  const s = sateiActionDeps();
  return {
    kv: groupSateiKv(),
    dealsDbId: s.dealsDbId,
    readDeal: (dealId) => within(s.readDeal(dealId), CRM_TIMEOUT_MS),
    intake: s.intake,
    loadDeals: async () =>
      (await within(loadActiveDeals(crm()), CRM_TIMEOUT_MS)).map((d) => ({ ...d, id: normNotionId(d.id) })),
  };
}

/** webhook の画像・ファイル：対象グループのときだけ控える。off・対象外なら何もしない。例外は投げない */
export async function recordGroupSateiMediaEvent(m: {
  messageId: string;
  groupId?: string;
  senderId?: string;
  type: "image" | "file";
  fileName?: string;
  at: number;
}): Promise<void> {
  try {
    if (!groupSateiOn(m.groupId)) return;
    const row = gsMediaRow(m);
    if (!row) return;
    await within(recordGroupSateiMedia(row, m.groupId as string, groupSateiKv(), log), MEDIA_KV_TIMEOUT_MS);
  } catch {
    log("[group-satei] skip:media-exception");
  }
}

/** 入口 A（@AI秘書 あてで査定書と判定された依頼。返事を送ったあとに呼ぶ）。例外は投げない */
export async function maybeOpenGroupSateiA(
  p: {
    messageId: string;
    groupId?: string;
    senderId?: string;
    at: number;
    text: string;
    quotedMessageId?: string;
    isTask: boolean;
    requestType: string;
    confidence: number;
  },
  today: string,
): Promise<void> {
  try {
    if (!gsEntryAOk(p)) return;
    await openGroupSatei(
      {
        messageId: p.messageId,
        groupId: p.groupId as string,
        requesterId: p.senderId as string,
        at: p.at,
        text: p.text,
        entry: "A",
        quotedMessageId: p.quotedMessageId,
      },
      groupSateiOpenDeps(today),
    );
  } catch {
    log("[group-satei] skip:exception A");
  }
}

/** 入口 B（メンションの無い、査定の言葉を含む依頼）。AI で査定書・0.5 以上のときだけ開く。例外は投げない */
export async function maybeOpenGroupSateiB(
  p: { messageId: string; groupId?: string; senderId?: string; at: number; text: string; quotedMessageId?: string },
  today: string,
): Promise<void> {
  try {
    const g = gsEntryBGate(p);
    if (!g.ok) {
      // off・言葉の無い発言は黙る（グループのふつうの発言ごとにログを出さない）
      if (g.reason !== "off" && g.reason !== "words" && looksLikeSateiWords(p.text)) log(`[group-satei] skip:${g.reason}`);
      return;
    }
    const parsed = await within(parseTaskFromMessage(p.text, today), READ_TIMEOUT_MS);
    if (!parsed.isTask || parsed.requestType !== "査定書" || parsed.confidence < GS_MIN) {
      log("[group-satei] skip:not-satei");
      return;
    }
    await openGroupSatei(
      {
        messageId: p.messageId,
        groupId: p.groupId as string,
        requesterId: p.senderId as string,
        at: p.at,
        text: p.text,
        entry: "B",
        quotedMessageId: p.quotedMessageId,
      },
      groupSateiOpenDeps(today),
    );
  } catch {
    log("[group-satei] skip:exception B");
  }
}
