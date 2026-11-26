/**
 * 段2d：portal（reins-report）の「準備」の依頼箱を呼ぶ（計画 2026-11-26-group-satei-2d の受け渡しの約束）。鍵は x-job-token。
 * 結果は satei-portal.ts と同じ3つ（ok／rejected／unknown）。受付の 503 PREP_DISABLED・INTAKE_STOPPED だけは rejected に読み替える
 * （呼び手が 2a の道へ戻す・止めていると返すため）。例外は投げない。ログは出さない。
 */
import { classify, getJson, postJson, type SateiCall, type SateiPortalOpts } from "./satei-portal";
import type { GsPrepKind } from "./group-satei-data";

export interface SateiPrepIntakeReq {
  tid: string;
  no: number;
  dealId: string;
  folderId: string;
  kind: GsPrepKind;
  place: string | null;
  building: string | null;
  facts: { builtYm: string | null; exclusiveArea: number | null; landArea: number | null; buildingArea: number | null };
  requestedBy: string;
}
export interface SateiPrepCases {
  contract: number;
  listing: number;
  failed: number;
}
export type SateiPrepCasesFail = "" | "folder" | "fetch" | "internal" | "timeout";
export interface SateiPrepNotice {
  tid: string;
  no: number;
  /** 事例保存済み・事例失敗は段2e（事例の PDF の取り出しと保存の結果） */
  status: "相談中" | "失敗" | "事例保存済み" | "事例失敗";
  lines: string[];
  areaDone: boolean;
  failReason: string;
  /** 段2e の行（事例保存済み・事例失敗）だけに付ける。相談中・失敗の行は段2d と同じ形のまま */
  cases?: SateiPrepCases | null;
  casesFailReason?: SateiPrepCasesFail;
}
export type SateiPrepDecideReq = { decision: "ok"; rev: number; lines: string[]; deadline: number } | { decision: "manual"; rev: number };

export interface GsPrepPortal {
  intake(req: SateiPrepIntakeReq): Promise<SateiCall<{ created: boolean; status: string }>>;
  notices(): Promise<SateiCall<SateiPrepNotice[]>>;
  decide(tid: string, req: SateiPrepDecideReq): Promise<SateiCall<{ status: string }>>;
  /** 段2e：事例あり（count＝結びついた PDF の数）。無い作り（段2d だけ）なら portal へ渡さない */
  cases?(tid: string, req: { count: number }): Promise<SateiCall<{ status: string }>>;
  /** 段2e：結果を知らせ終えた（portal の行を完了に） */
  casesAck?(tid: string): Promise<SateiCall<{ status: string }>>;
}

const TID_RE = /^[0-9a-f]{16}$/;
const STOP_CODES = new Set(["PREP_DISABLED", "INTAKE_STOPPED"]);

export async function sateiPrepIntake(req: SateiPrepIntakeReq, opts: SateiPortalOpts): Promise<SateiCall<{ created: boolean; status: string }>> {
  const payload: SateiPrepIntakeReq = {
    tid: req.tid, no: req.no, dealId: req.dealId, folderId: req.folderId, kind: req.kind, place: req.place, building: req.building,
    facts: { builtYm: req.facts.builtYm, exclusiveArea: req.facts.exclusiveArea, landArea: req.facts.landArea, buildingArea: req.facts.buildingArea },
    requestedBy: req.requestedBy,
  };
  const raw = await postJson("/api/jobs/satei/prep", payload, opts);
  if (raw.kind === "http" && raw.status === 503 && typeof raw.body.code === "string" && STOP_CODES.has(raw.body.code)) {
    return { kind: "rejected", status: 503, code: raw.body.code };
  }
  return classify(raw, (b) => {
    const prep = b.prep as { status?: unknown } | undefined;
    return typeof b.created === "boolean" && prep && typeof prep.status === "string" ? { created: b.created, status: prep.status } : null;
  });
}

function asNotice(v: unknown): SateiPrepNotice | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.tid !== "string" || !TID_RE.test(r.tid) || typeof r.no !== "number" || !Number.isInteger(r.no)) return null;
  if (r.status !== "相談中" && r.status !== "失敗" && r.status !== "事例保存済み" && r.status !== "事例失敗") return null;
  if (!Array.isArray(r.lines) || !r.lines.every((s) => typeof s === "string")) return null;
  const base = { tid: r.tid, no: r.no, lines: r.lines as string[], areaDone: r.areaDone === true, failReason: typeof r.failReason === "string" ? r.failReason : "" };
  if (r.status === "相談中" || r.status === "失敗") return { ...base, status: r.status };
  const cases = asCases(r.cases);
  if (r.status === "事例保存済み" && !cases) return null;
  const fr = r.casesFailReason;
  const casesFailReason: SateiPrepCasesFail = fr === "folder" || fr === "fetch" || fr === "internal" || fr === "timeout" ? fr : "";
  return { ...base, status: r.status, cases, casesFailReason };
}

const isCountN = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10;
function asCases(v: unknown): SateiPrepCases | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  return isCountN(c.contract) && isCountN(c.listing) && isCountN(c.failed) ? { contract: c.contract, listing: c.listing, failed: c.failed } : null;
}

export async function sateiPrepNotices(opts: SateiPortalOpts): Promise<SateiCall<SateiPrepNotice[]>> {
  return classify(await getJson("/api/jobs/satei/prep/notices", opts), (b) =>
    Array.isArray(b.preps) ? b.preps.map(asNotice).filter((x): x is SateiPrepNotice => x !== null) : null,
  );
}

export async function sateiPrepDecide(tid: string, req: SateiPrepDecideReq, opts: SateiPortalOpts): Promise<SateiCall<{ status: string }>> {
  return classify(await postJson(`/api/jobs/satei/prep/${tid}/decide`, req, opts), (b) => (typeof b.status === "string" ? { status: b.status } : null));
}

const statusOf = (b: Record<string, unknown>) => (typeof b.status === "string" ? { status: b.status } : null);

/** 段2e：POST /api/jobs/satei/prep/{tid}/cases {count} */
export async function sateiPrepCases(tid: string, req: { count: number }, opts: SateiPortalOpts): Promise<SateiCall<{ status: string }>> {
  return classify(await postJson(`/api/jobs/satei/prep/${tid}/cases`, { count: req.count }, opts), statusOf);
}

/** 段2e：POST /api/jobs/satei/prep/{tid}/cases-ack {} */
export async function sateiPrepCasesAck(tid: string, opts: SateiPortalOpts): Promise<SateiCall<{ status: string }>> {
  return classify(await postJson(`/api/jobs/satei/prep/${tid}/cases-ack`, {}, opts), statusOf);
}
