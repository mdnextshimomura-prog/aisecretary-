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

function classifyFetchError(err: unknown): IntakeOutcome {
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
