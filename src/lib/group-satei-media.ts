/**
 * 段2e（計画 2026-11-26-group-satei-2e の「aisecretary の口」）：Mac が事例の PDF を1件ずつ取る口 POST /api/satei/media の中身。
 * - 合言葉：ヘッダ x-satei-token = HMAC-SHA256(鍵 = JOB_API_TOKEN の UTF-8, 文 = "satei-media") の hex。32字未満なら誰も通さない。定数時間で比べる。
 * - 入力 {tid, index: 1..10}。groupSateiPrepOn でなければ 503 OFF。受付票が無い・waiting-cases でない・index 番目が無い → 404 NOT_FOUND。
 * - LINE の content API（1件20秒）。404/410 → 410 GONE、4MB 超 → 413 TOO_LARGE（読みながら数えて止める）、先頭が %PDF でない → 415 NOT_PDF、
 *   ほか・時間切れ → 502 UPSTREAM。成功は PDF のバイト。
 * ログは受付番号・番号・符号だけ（messageId・ファイル名・中身は出さない）。例外は投げない。
 */
import { createHmac } from "node:crypto";
import { timingSafeEqualStr } from "./secure-compare";
import { asCaseItems, asTicket, GS_CASE_ITEMS_MAX, GS_CASE_PDF_MAX, groupSateiPrepOn, gsCaseItemsKey, gsTicketKey, receiptOf } from "./group-satei-data";

export const GS_MEDIA_TOKEN_CONTEXT = "satei-media";
export const GS_MEDIA_KEY_MIN_LENGTH = 32;
export const GS_MEDIA_TIMEOUT_MS = 20_000;

export function gsMediaToken(jobApiToken: string): string {
  return createHmac("sha256", Buffer.from(jobApiToken, "utf8")).update(GS_MEDIA_TOKEN_CONTEXT, "utf8").digest("hex");
}

export function gsMediaAuthorized(header: string | null, jobApiToken: string | undefined): boolean {
  if (typeof jobApiToken !== "string" || jobApiToken.length < GS_MEDIA_KEY_MIN_LENGTH) return false;
  if (typeof header !== "string") return false;
  return timingSafeEqualStr(header, gsMediaToken(jobApiToken));
}

export interface GsMediaDeps {
  env?: Record<string, string | undefined>;
  kv: { get(key: string): Promise<unknown>; lrange(key: string): Promise<unknown[]> } | null;
  /** LINE の content API を呼ぶ（signal で打ち切る） */
  fetchContent(messageId: string, signal: AbortSignal): Promise<Response>;
  timeoutMs?: number;
  log(l: string): void;
}

export type GsMediaResult = { status: number; code: string } | { status: 200; code: "OK"; pdf: Buffer };

const TID_RE = /^[0-9a-f]{16}$/;
const fail = (status: number, code: string): GsMediaResult => ({ status, code });

function parseBody(raw: string): { tid: string; index: number } | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.tid !== "string" || !TID_RE.test(r.tid)) return null;
  if (typeof r.index !== "number" || !Number.isInteger(r.index) || r.index < 1 || r.index > GS_CASE_ITEMS_MAX) return null;
  return { tid: r.tid, index: r.index };
}

/** 本文を読みながら数え、max を超えたら読むのをやめる（null＝超えた） */
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  if (!res.body) {
    const b = Buffer.from(await res.arrayBuffer());
    return b.length > max ? null : b;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export async function handleGsMedia(header: string | null, raw: string, deps: GsMediaDeps): Promise<GsMediaResult> {
  const env = deps.env ?? process.env;
  if (!gsMediaAuthorized(header, env.JOB_API_TOKEN)) {
    deps.log("[group-satei] media unauthorized");
    return fail(401, "UNAUTHORIZED");
  }
  if (!groupSateiPrepOn(env)) return fail(503, "OFF");
  const req = parseBody(raw);
  if (!req) return fail(400, "BAD_REQUEST");
  if (!deps.kv) {
    deps.log("[group-satei] media config-missing");
    return fail(502, "UPSTREAM");
  }
  let tkRaw: unknown;
  let itemsRaw: unknown[];
  try {
    tkRaw = await deps.kv.get(gsTicketKey(req.tid));
    itemsRaw = await deps.kv.lrange(gsCaseItemsKey(req.tid));
  } catch {
    deps.log("[group-satei] media kv-failed");
    return fail(502, "UPSTREAM");
  }
  const tk = asTicket(tkRaw);
  if (!tk || tk.state !== "waiting-cases") return fail(404, "NOT_FOUND");
  const R = receiptOf(tk.no);
  const item = asCaseItems(itemsRaw)[req.index - 1];
  if (!item) {
    deps.log(`[group-satei] media ${R} ${req.index} not-found`);
    return fail(404, "NOT_FOUND");
  }
  const signal = AbortSignal.timeout(deps.timeoutMs ?? GS_MEDIA_TIMEOUT_MS);
  let res: Response;
  try {
    res = await deps.fetchContent(item.m, signal);
  } catch {
    deps.log(`[group-satei] media ${R} ${req.index} upstream`);
    return fail(502, "UPSTREAM");
  }
  if (res.status === 404 || res.status === 410) {
    deps.log(`[group-satei] media ${R} ${req.index} gone`);
    return fail(410, "GONE");
  }
  if (!res.ok) {
    deps.log(`[group-satei] media ${R} ${req.index} upstream ${res.status}`);
    return fail(502, "UPSTREAM");
  }
  let buf: Buffer | null;
  try {
    buf = await readCapped(res, GS_CASE_PDF_MAX);
  } catch {
    deps.log(`[group-satei] media ${R} ${req.index} upstream`);
    return fail(502, "UPSTREAM");
  }
  if (!buf) {
    deps.log(`[group-satei] media ${R} ${req.index} too-large`);
    return fail(413, "TOO_LARGE");
  }
  if (buf.subarray(0, 4).toString("latin1") !== "%PDF") {
    deps.log(`[group-satei] media ${R} ${req.index} not-pdf`);
    return fail(415, "NOT_PDF");
  }
  deps.log(`[group-satei] media ${R} ${req.index} ok`);
  return { status: 200, code: "OK", pdf: buf };
}
