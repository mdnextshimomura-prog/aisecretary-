/**
 * B2 査定書：査定係（Mac）からの通知の受け口の中身（契約 第3節）。route は src/app/api/satei/notify/route.ts。
 * - 合言葉：ヘッダ x-satei-token = HMAC-SHA256(鍵 = JOB_API_TOKEN, 文 = "satei-notify") の小文字 hex。
 *   JOB_API_TOKEN が無い・32字未満なら誰も通さない（帯替えの見回りの入口と同じ考え方）。
 * - 送り先：TASK_SATEI_USER_IDS の先頭（下村さん）。X-Line-Retry-Key = uuidv5(no:kind:generation)。
 * - LINE が 200 → sent、409（同じキーで受付済み）→ sent、それ以外・例外 → unknown。出力 {result}。
 * - TASK_SATEI が off・通知先が無いときは送らず {result:"deferred"}（契約 6-12。portal は試行回数を増やさず pending のまま）。
 * ログは `[satei] notify #J12 draft sent` の形だけ（案件名・宛先は出さない）。
 */
import { createHash, createHmac } from "node:crypto";
import { timingSafeEqualStr } from "./secure-compare";
import { sateiActive, sateiNotifyTarget } from "./satei-data";
import { sateiNoticeMessages, type SateiNotice, type SateiNoticeKind } from "./satei-text";

export const SATEI_TOKEN_HEADER = "x-satei-token";
export const SATEI_TOKEN_CONTEXT = "satei-notify";
export const SATEI_KEY_MIN_LENGTH = 32;
/** X-Line-Retry-Key の uuidv5 の名前空間（固定。変えると送り直しの二重防止が効かなくなる） */
export const SATEI_RETRY_NAMESPACE = "3f0c6a1e-8d2b-4c5e-9a71-b2d4e6f80a13";

export function sateiNotifyToken(jobApiToken: string): string {
  return createHmac("sha256", Buffer.from(jobApiToken, "utf8")).update(SATEI_TOKEN_CONTEXT, "utf8").digest("hex");
}

export function sateiNotifyAuthorized(header: string | null, jobApiToken: string | undefined): boolean {
  if (typeof jobApiToken !== "string" || jobApiToken.length < SATEI_KEY_MIN_LENGTH) return false;
  if (typeof header !== "string") return false;
  return timingSafeEqualStr(header, sateiNotifyToken(jobApiToken));
}

/** RFC 4122 の版5（SHA-1）の UUID。依存を増やさないため node:crypto で書く */
export function uuidv5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (ns.length !== 16) throw new Error("uuidv5: namespace must be a UUID");
  const h = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export function sateiRetryKey(no: number, kind: string, generation: number): string {
  return uuidv5(`${no}:${kind}:${generation}`, SATEI_RETRY_NAMESPACE);
}

const KINDS: ReadonlySet<string> = new Set<SateiNoticeKind>(["draft", "failed", "saved", "aborted"]);
const VERDICTS: ReadonlySet<string> = new Set(["そのまま出せる", "要修正", "差し戻し"]);
const FAIL_REASONS: ReadonlySet<string> = new Set([
  "materials",
  "timeout",
  "folder",
  "check",
  "internal",
  "input-changed",
  "draft-changed",
  "folder-mismatch",
  "name-conflict",
]);
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DEAL_NAME_IN_MAX = 200;

/** 文字列の配列（JSON 配列の文字列でもよい）。空・無しは []。形が違えば null */
function strList(v: unknown, max: number, len: number): string[] | null {
  let x = v;
  if (x === undefined || x === null || x === "") return [];
  if (typeof x === "string") {
    try {
      x = JSON.parse(x);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(x)) return null;
  const out: string[] = [];
  for (const s of x) {
    if (typeof s !== "string") return null;
    const t = s.trim();
    if (t) out.push(Array.from(t).slice(0, len).join(""));
  }
  return out.slice(0, max);
}

/** 任意の文字列の欄：無し・空は null、形が合えばその値、合わなければ undefined（＝入力が不正） */
function optStr(v: unknown, valid: (s: string) => boolean): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "string" && valid(v) ? v : undefined;
}

export function parseNotifyInput(body: unknown): SateiNotice | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const { no, kind, generation } = b;
  if (typeof no !== "number" || !Number.isInteger(no) || no <= 0) return null;
  if (typeof kind !== "string" || !KINDS.has(kind)) return null;
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0) return null;
  const dealName = typeof b.dealName === "string" ? Array.from(b.dealName.trim()).slice(0, DEAL_NAME_IN_MAX).join("") : "";
  const driveFileId = optStr(b.driveFileId, (s) => DRIVE_ID_RE.test(s));
  const verdict = optStr(b.verdict, (s) => VERDICTS.has(s));
  const failReason = optStr(b.failReason, (s) => FAIL_REASONS.has(s));
  const artifactSha256 = optStr(b.artifactSha256, (s) => SHA256_RE.test(s));
  const findings = strList(b.findings, 3, 120);
  const missing = strList(b.missing, 20, 60);
  if (
    driveFileId === undefined ||
    verdict === undefined ||
    failReason === undefined ||
    artifactSha256 === undefined ||
    findings === null ||
    missing === null
  ) {
    return null;
  }
  // draft はカードのボタンに要る値がそろっていること（generation は結果の登録ごとに +1 なので 1 以上）
  if (kind === "draft" && (!driveFileId || !verdict || !artifactSha256 || generation < 1)) return null;
  return {
    no,
    kind: kind as SateiNoticeKind,
    generation,
    dealName,
    driveFileId,
    verdict,
    findings,
    missing,
    failReason,
    artifactSha256,
  };
}

export type SateiPushResult = "sent" | "unknown";

export function pushResultOf(status: number | null): SateiPushResult {
  return status === 200 || status === 409 ? "sent" : "unknown";
}

export interface SateiNotifyDeps {
  env: Record<string, string | undefined>;
  /** LINE の push（retry key つき）。HTTP の状態番号、時間切れ・通信の失敗は null */
  push(to: string, messages: unknown[], retryKey: string): Promise<number | null>;
  log(line: string): void;
}

export async function handleSateiNotify(
  header: string | null,
  raw: string,
  deps: SateiNotifyDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!sateiNotifyAuthorized(header, deps.env.JOB_API_TOKEN)) {
    return { status: 401, body: { error: "Unauthorized" } };
  }
  if (!sateiActive(deps.env)) {
    deps.log("[satei] notify off");
    return { status: 200, body: { result: "deferred", skipped: "off" } };
  }
  const to = sateiNotifyTarget(deps.env);
  if (!to) {
    deps.log("[satei] notify config-missing");
    return { status: 200, body: { result: "deferred", skipped: "config" } };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    deps.log("[satei] notify bad-input");
    return { status: 400, body: { error: "bad-input" } };
  }
  const n = parseNotifyInput(body);
  const messages = n ? sateiNoticeMessages(n) : null;
  if (!n || !messages) {
    deps.log("[satei] notify bad-input");
    return { status: 400, body: { error: "bad-input" } };
  }
  let status: number | null;
  try {
    status = await deps.push(to, messages, sateiRetryKey(n.no, n.kind, n.generation));
  } catch {
    status = null;
  }
  const result = pushResultOf(status);
  deps.log(`[satei] notify #J${n.no} ${n.kind} ${result}`);
  return { status: 200, body: { result } };
}
