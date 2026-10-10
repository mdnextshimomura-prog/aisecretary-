/**
 * portal の帯替えの受付 `POST {PORTAL_BASE_URL}/api/jobs/intake` を呼ぶ（設計 12・13・14の2・15）。
 * 形は docs/superpowers/plans/2026-10-09-group-obi-contract.md の「P1 が作り、P2 が使う」。
 * `assigneeName` はこの入口では受け付けないので送らない（依頼文の「担当:」は読んでも捨てる）。
 *
 * 結果は4つに分ける：
 *   accepted    … 受付番号と保存した PDF の一覧が返った（201 新規・200 同じ依頼の照合一致）
 *   rejected    … portal がはっきり断った（4xx・503 INTAKE_STOPPED）
 *   unreachable … 送る前に失敗したのが確か（名前が引けない・接続を拒まれた）
 *   unknown     … 届いたか分からない（時間切れ・通信の切断・5xx・成功なのに中身が読めない）
 */
import type { FetchedPdf } from "./fetch-pdfs";

export interface IntakeRequest {
  lineMessageId: string;
  property: string;
  requestText: string;
  requestedBy: string;
  replyGroupId: string;
  files: Array<{ fileName: string; bytes: Uint8Array }>;
}

export interface IntakeInput {
  name: string;
  sha256: string;
  size: number;
}

export type IntakeOutcome =
  | { kind: "accepted"; no: number; created: boolean; inputs: IntakeInput[] }
  | { kind: "rejected"; code: string; httpStatus: number; busyJobNo?: number }
  | { kind: "unreachable" }
  | { kind: "unknown"; reason: string };

const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

function parseInputs(v: unknown): IntakeInput[] | null {
  if (!Array.isArray(v)) return null;
  const out: IntakeInput[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") return null;
    const r = x as Record<string, unknown>;
    if (typeof r.name !== "string" || typeof r.sha256 !== "string" || typeof r.size !== "number") {
      return null;
    }
    out.push({ name: r.name, sha256: r.sha256, size: r.size });
  }
  return out;
}

function classifyFetchError(err: unknown): { kind: "unreachable" } | { kind: "unknown"; reason: string } {
  const e = err as { name?: string; cause?: { code?: string } } | undefined;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return { kind: "unknown", reason: "timeout" };
  if (e?.cause?.code && UNREACHABLE_CODES.has(e.cause.code)) return { kind: "unreachable" };
  return { kind: "unknown", reason: "network" };
}

export async function postIntake(
  req: IntakeRequest,
  opts: { fetchImpl: typeof fetch; baseUrl: string; token: string; timeoutMs: number }
): Promise<IntakeOutcome> {
  const form = new FormData();
  form.append("workflow", "obi");
  form.append("lineMessageId", req.lineMessageId);
  form.append("property", req.property);
  if (req.requestText) form.append("requestText", req.requestText);
  if (req.requestedBy) form.append("requestedBy", req.requestedBy);
  form.append("replyKind", "line-group");
  form.append("replyGroupId", req.replyGroupId);
  for (const f of req.files) {
    form.append("files", new Blob([toArrayBuffer(f.bytes)], { type: "application/pdf" }), f.fileName);
  }

  let res: Response;
  try {
    res = await opts.fetchImpl(`${opts.baseUrl}/api/jobs/intake`, {
      method: "POST",
      headers: { "x-job-token": opts.token },
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    return classifyFetchError(err);
  }

  let body: Record<string, unknown> = {};
  let bodyOk = true;
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    else bodyOk = false;
  } catch {
    bodyOk = false;
  }

  if (res.status === 200 || res.status === 201) {
    const inputs = bodyOk ? parseInputs(body.inputs) : null;
    const no = body.no;
    if (typeof no === "number" && Number.isInteger(no) && no > 0 && inputs) {
      return { kind: "accepted", no, created: res.status === 201, inputs };
    }
    // 成功の番号なのに中身が読めない＝受付できたかもしれない
    return { kind: "unknown", reason: "invalid-success-body" };
  }
  const code = typeof body.code === "string" ? body.code : "";
  if (res.status === 503 && code === "INTAKE_STOPPED") {
    return { kind: "rejected", code, httpStatus: 503 };
  }
  if (res.status >= 500) return { kind: "unknown", reason: `http-${res.status}` };
  if (res.status >= 400) {
    const busy = body.busyJobNo;
    return {
      kind: "rejected",
      code: code || `HTTP_${res.status}`,
      httpStatus: res.status,
      ...(typeof busy === "number" && Number.isInteger(busy) && busy > 0 ? { busyJobNo: busy } : {}),
    };
  }
  return { kind: "unknown", reason: `http-${res.status}` };
}

/**
 * 返ってきた一覧が送った PDF と一致するか（設計 13）。
 * 約束：portal の inputs は「初回に保存した順」なので、順番では比べず、
 * 件数と sha256 の集合（＋同じ sha256 の大きさ）で比べる。送る側で同じ sha256 は1つにしてある。
 */
export function inputsMatch(sent: FetchedPdf[], got: IntakeInput[]): boolean {
  if (sent.length !== got.length) return false;
  const sizeBySha = new Map<string, number>();
  for (const f of sent) sizeBySha.set(f.sha256, f.size);
  if (sizeBySha.size !== sent.length) return false;
  const seen = new Set<string>();
  for (const g of got) {
    if (seen.has(g.sha256)) return false;
    seen.add(g.sha256);
    if (sizeBySha.get(g.sha256) !== g.size) return false;
  }
  return true;
}


// ── 番号で直す（設計 2026-10-10・約束 2026-10-11-obi-fix-contract.md） ──
//
// 2つの入口を呼ぶ。どちらも本文は JSON、鍵はヘッダ `x-job-token`。結果は受付（postIntake）と同じ4つに分ける。
//   POST /api/jobs/fix/resolve … 引用先・受付番号から、直せる依頼かを引く（何も書き換えない）
//   POST /api/jobs/{no}/fix    … 訂正を受け付ける（冪等のかぎは訂正の発言の message.id）
// **発言者を表す項目は送らない**（userId・表示名。誰が訂正できるかは呼ぶ前に確かめてある）。

export type FixEstimate = "ok" | "closed" | "expired" | "not-ready" | "unavailable";
const FIX_ESTIMATES = new Set<string>(["ok", "closed", "expired", "not-ready", "unavailable"]);

export interface FixResolved {
  no: number;
  /** 引用なら「その知らせが指す完成品」、番号なら「今の完成品」。fix の expectSha256 にそのまま渡す */
  artifactSha256: string;
  /** artifactSha256 が今の完成品と同じか */
  current: boolean;
  /** 今の1冊のページ数（分からなければ 0） */
  pageCount: number;
  /** 1〜5 を送ったときの見込み */
  fixable: FixEstimate;
  /** 0 を送ったときの見込み */
  closable: FixEstimate;
  /**
   * 引用で引いたとき、その知らせの種類。"completion"＝完成の知らせ。番号で引いたとき・項目の無い portal は ""。
   * "completion"・"" 以外（差し戻しの選択肢の設計 2026-10-11 の "reject"・"review" など。いまの portal は返さない）への引用は、
   * 「番号で直す」の返事として扱わない（約束の「差し戻しの選択肢のための土台」P1・P4）
   */
  kind: string;
  /** 今の依頼が待っている返事の種類。「番号で直す」は "fix"。項目の無い portal は "fix" とみなす（P1・P4。いまは読むだけで、分岐には使わない） */
  phase: string;
}

export type FixResolveRequest =
  | { groupId: string; quotedMessageId: string }
  | { groupId: string; no: number };

export type FixResolveOutcome =
  | { kind: "accepted"; resolved: FixResolved }
  | { kind: "rejected"; code: string; httpStatus: number }
  | { kind: "unreachable" }
  | { kind: "unknown"; reason: string };

interface PortalOpts {
  fetchImpl: typeof fetch;
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

type JsonCall =
  | { kind: "http"; status: number; body: Record<string, unknown>; bodyOk: boolean }
  | { kind: "unreachable" }
  | { kind: "unknown"; reason: string };

async function postJson(path: string, payload: Record<string, unknown>, opts: PortalOpts): Promise<JsonCall> {
  let res: Response;
  try {
    res = await opts.fetchImpl(`${opts.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-job-token": opts.token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    return classifyFetchError(err);
  }
  let body: Record<string, unknown> = {};
  let bodyOk = true;
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    else bodyOk = false;
  } catch {
    bodyOk = false;
  }
  return { kind: "http", status: res.status, body, bodyOk };
}

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * 断りの共通の分け方。503 は、portal がはっきり止めていると答えた code（stopCodes）のときだけ断り。
 * それ以外の 5xx は「届いたか分からない」。
 */
function rejectionOf(
  call: Extract<JsonCall, { kind: "http" }>,
  stopCodes: string[]
): { kind: "rejected"; code: string; httpStatus: number } | { kind: "unknown"; reason: string } {
  const code = typeof call.body.code === "string" ? call.body.code : "";
  if (call.status === 503 && stopCodes.includes(code)) return { kind: "rejected", code, httpStatus: 503 };
  if (call.status >= 400 && call.status < 500) {
    return { kind: "rejected", code: code || `HTTP_${call.status}`, httpStatus: call.status };
  }
  return { kind: "unknown", reason: `http-${call.status}` };
}

export async function postFixResolve(req: FixResolveRequest, opts: PortalOpts): Promise<FixResolveOutcome> {
  const payload: Record<string, unknown> = { source: "line-group", groupId: req.groupId };
  if ("quotedMessageId" in req) payload.quotedMessageId = req.quotedMessageId;
  else payload.no = req.no;
  const call = await postJson("/api/jobs/fix/resolve", payload, opts);
  if (call.kind !== "http") return call;
  if (call.status === 200) {
    const b = call.body;
    if (
      call.bodyOk &&
      isPositiveInt(b.no) &&
      typeof b.artifactSha256 === "string" &&
      /^[0-9a-f]{64}$/.test(b.artifactSha256) &&
      typeof b.current === "boolean" &&
      typeof b.pageCount === "number" &&
      Number.isInteger(b.pageCount) &&
      b.pageCount >= 0 &&
      typeof b.fixable === "string" &&
      FIX_ESTIMATES.has(b.fixable) &&
      typeof b.closable === "string" &&
      FIX_ESTIMATES.has(b.closable) &&
      // kind・phase は、あれば文字列（無い portal は今までどおり受ける。文字列でなければ形の違う応答）
      (b.kind === undefined || typeof b.kind === "string") &&
      (b.phase === undefined || typeof b.phase === "string")
    ) {
      return {
        kind: "accepted",
        resolved: {
          no: b.no,
          artifactSha256: b.artifactSha256,
          current: b.current,
          pageCount: b.pageCount,
          fixable: b.fixable as FixEstimate,
          closable: b.closable as FixEstimate,
          kind: typeof b.kind === "string" ? b.kind : "",
          phase: typeof b.phase === "string" ? b.phase : "fix",
        },
      };
    }
    return { kind: "unknown", reason: "invalid-success-body" };
  }
  return rejectionOf(call, ["FIX_DISABLED"]);
}
