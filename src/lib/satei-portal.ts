/**
 * B2 査定書：reins-report の依頼箱（契約 第2節）を呼ぶ。鍵はヘッダ `x-job-token`（帯替えと同じ JOB_API_TOKEN）。
 *   POST /api/jobs/satei/intake      … {eventId, dealId, dealNo, folderId, dealName, requestedBy} → {created, job:{no,status}}
 *   POST /api/jobs/satei/resume      … 上の6項目＋resumeFrom（上限からの［もう一度作る］）→ 同じ形／409 SATEI_RESUME_STALE
 *   POST /api/jobs/{no}/satei/decide … {decision, by, artifactSha256, generation} → {status}／409 SATEI_MISMATCH
 *   POST /api/jobs/{no}/satei/reason … {text} → {ok:true}
 * 結果は3つに分ける：ok（2xx で中身が読めた）／rejected（4xx。はっきり断られた）／unknown（5xx・通信の失敗・中身が読めない）。
 * 例外は投げない。本文・鍵はログに出さない（この関数はログを出さない）。
 */
import { parsePortalBaseUrl } from "./obi/config";
import { PAGE_ID_RE } from "./task-buttons";

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
  /** 上限からの［もう一度作る］のときだけ：差し戻しで閉じた元の依頼の番号（portal は元の依頼ごとに1つだけ作る） */
  resumeFrom?: number;
}

/** 再開のボタンが古い（元の依頼が最新の差し戻しでない・再開した依頼が終わっている）とき intake が返す code */
export const SATEI_CODE_RESUME_STALE = "SATEI_RESUME_STALE";

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
    ...(req.resumeFrom !== undefined ? { resumeFrom: req.resumeFrom } : {}),
  };
  // 再開は専用の口（古い portal では 404＝断り。portal だけを古い版へ戻しても、古いボタンから通常の受付として作らない）
  const path = req.resumeFrom !== undefined ? "/api/jobs/satei/resume" : "/api/jobs/satei/intake";
  return classify(
    await postJson(path, payload, opts),
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

/**
 * 機械からの受付（aisecretary POST /api/satei/request。約束 agent-hub 2026-11-19-satei-request）。
 * 本文に machine:true を足す（portal は直前の依頼が保存済みのときだけ受ける）。
 * 受付を止めている（503 INTAKE_STOPPED）ときは、はっきり断られた扱いにする（人のボタンの sateiIntake は今のまま）
 */
export async function sateiMachineIntake(
  req: SateiIntakeReq,
  opts: SateiPortalOpts,
): Promise<SateiCall<SateiIntakeOk>> {
  const raw = await postJson(
    "/api/jobs/satei/intake",
    {
      eventId: req.eventId,
      dealId: req.dealId,
      dealNo: req.dealNo,
      folderId: req.folderId,
      dealName: req.dealName,
      requestedBy: req.requestedBy,
      machine: true,
    },
    opts,
  );
  if (raw.kind === "http" && raw.status === 503 && raw.body.code === "INTAKE_STOPPED") {
    return { kind: "rejected", status: 503, code: "INTAKE_STOPPED" };
  }
  return classify(raw, (b) => {
    const job = b.job as { no?: unknown; status?: unknown } | undefined;
    if (typeof b.created !== "boolean" || !job || !isPositiveInt(job.no) || typeof job.status !== "string") return null;
    return { created: b.created, no: job.no, status: job.status };
  });
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

/** reason の応答の `redo`（自動の作り直しの結果）。null＝無い・形が違う（スイッチ off・古い portal を含む） */
export type SateiRedo =
  | { kind: "started"; no: number; autoCount: number }
  | { kind: "limit"; dealId: string | null }
  | { kind: "skipped" };

export interface SateiReasonOk {
  ok: true;
  redo?: SateiRedo | null;
}

/** 形が違うものは null（今の文）。符号の中身（skipped の文字列）は使わない */
export function parseSateiRedo(v: unknown): SateiRedo | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (isPositiveInt(r.no) && isPositiveInt(r.autoCount)) return { kind: "started", no: r.no, autoCount: r.autoCount };
  // dealId は［もう一度作る］のため（古い portal は返さない＝ボタンを付けない）
  if (r.limit === true) return { kind: "limit", dealId: typeof r.dealId === "string" && PAGE_ID_RE.test(r.dealId) ? r.dealId : null };
  if (typeof r.skipped === "string") return { kind: "skipped" };
  return null;
}

export async function sateiReason(
  no: number,
  text: string,
  opts: SateiPortalOpts,
): Promise<SateiCall<SateiReasonOk>> {
  return classify(
    await postJson(`/api/jobs/${no}/satei/reason`, { text }, opts),
    (b) => (b.ok === true ? { ok: true as const, redo: parseSateiRedo(b.redo) } : null),
  );
}
