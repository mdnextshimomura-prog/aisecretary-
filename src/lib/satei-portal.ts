/**
 * B2 査定書：reins-report の依頼箱（契約 第2節）を呼ぶ。鍵はヘッダ `x-job-token`（帯替えと同じ JOB_API_TOKEN）。
 *   POST /api/jobs/satei/intake      … {eventId, dealId, dealNo, folderId, dealName, requestedBy} → {created, job:{no,status}}
 *   POST /api/jobs/{no}/satei/decide … {decision, by, artifactSha256, generation} → {status}／409 SATEI_MISMATCH
 *   POST /api/jobs/{no}/satei/reason … {text} → {ok:true}
 * 結果は3つに分ける：ok（2xx で中身が読めた）／rejected（4xx。はっきり断られた）／unknown（5xx・通信の失敗・中身が読めない）。
 * 例外は投げない。本文・鍵はログに出さない（この関数はログを出さない）。
 */
import { parsePortalBaseUrl } from "./obi/config";

export interface SateiPortalOpts {
  fetchImpl: typeof fetch;
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

export type SateiCall<T> =
  | { kind: "ok"; value: T }
  | { kind: "rejected"; status: number; code: string }
  | { kind: "unknown"; reason: string };

export const SATEI_PORTAL_TIMEOUT_MS = 8_000;

/** 同じ案件の依頼が「差し戻し」で理由待ちのとき、intake が返す code（契約 6-10。名前は reins-report の実装に合わせる） */
export const SATEI_CODE_AWAITING_REASON = "SATEI_AWAITING_REASON";

export function sateiPortalConfig(
  env: Record<string, string | undefined> = process.env,
): { baseUrl: string; token: string } | null {
  const baseUrl = parsePortalBaseUrl(env.PORTAL_BASE_URL);
  const token = env.JOB_API_TOKEN ?? "";
  if (!baseUrl || !token || /\s/.test(token)) return null;
  return { baseUrl, token };
}

type Raw =
  | { kind: "http"; status: number; body: Record<string, unknown> }
  | { kind: "unknown"; reason: string };

async function postJson(
  path: string,
  payload: unknown,
  opts: SateiPortalOpts,
): Promise<Raw> {
  let res: Response;
  try {
    res = await opts.fetchImpl(`${opts.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-job-token": opts.token,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    return {
      kind: "unknown",
      reason: name === "TimeoutError" ? "timeout" : "network",
    };
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      body = parsed as Record<string, unknown>;
  } catch {
    // 中身が読めない（body は {} のまま）
  }
  return { kind: "http", status: res.status, body };
}

function classify<T>(
  raw: Raw,
  read: (body: Record<string, unknown>) => T | null,
): SateiCall<T> {
  if (raw.kind === "unknown") return raw;
  const { status, body } = raw;
  if (status >= 200 && status < 300) {
    const value = read(body);
    return value
      ? { kind: "ok", value }
      : { kind: "unknown", reason: "invalid-success-body" };
  }
  if (status >= 400 && status < 500) {
    return {
      kind: "rejected",
      status,
      code:
        typeof body.code === "string" && body.code
          ? body.code
          : `HTTP_${status}`,
    };
  }
  return { kind: "unknown", reason: `http-${status}` };
}

const isPositiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;

export interface SateiIntakeReq {
  eventId: string;
  dealId: string;
  dealNo: number | null;
  folderId: string;
  dealName: string;
  requestedBy: string;
}

export interface SateiIntakeOk {
  created: boolean;
  no: number;
  status: string;
}

export async function sateiIntake(
  req: SateiIntakeReq,
  opts: SateiPortalOpts,
): Promise<SateiCall<SateiIntakeOk>> {
  const payload: SateiIntakeReq = {
    eventId: req.eventId,
    dealId: req.dealId,
    dealNo: req.dealNo,
    folderId: req.folderId,
    dealName: req.dealName,
    requestedBy: req.requestedBy,
  };
  return classify(
    await postJson("/api/jobs/satei/intake", payload, opts),
    (b) => {
      const job = b.job as { no?: unknown; status?: unknown } | undefined;
      if (
        typeof b.created !== "boolean" ||
        !job ||
        !isPositiveInt(job.no) ||
        typeof job.status !== "string"
      )
        return null;
      return { created: b.created, no: job.no, status: job.status };
    },
  );
}

export interface SateiDecideReq {
  decision: "ok" | "reject";
  by: string;
  artifactSha256: string;
  generation: number;
}

export async function sateiDecide(
  no: number,
  req: SateiDecideReq,
  opts: SateiPortalOpts,
): Promise<SateiCall<{ status: string }>> {
  const payload: SateiDecideReq = {
    decision: req.decision,
    by: req.by,
    artifactSha256: req.artifactSha256,
    generation: req.generation,
  };
  return classify(
    await postJson(`/api/jobs/${no}/satei/decide`, payload, opts),
    (b) => (typeof b.status === "string" ? { status: b.status } : null),
  );
}

export async function sateiReason(
  no: number,
  text: string,
  opts: SateiPortalOpts,
): Promise<SateiCall<{ ok: true }>> {
  return classify(
    await postJson(`/api/jobs/${no}/satei/reason`, { text }, opts),
    (b) => (b.ok === true ? { ok: true as const } : null),
  );
}
