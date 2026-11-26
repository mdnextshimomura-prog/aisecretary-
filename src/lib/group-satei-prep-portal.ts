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
export interface SateiPrepNotice {
  tid: string;
  no: number;
  status: "相談中" | "失敗";
  lines: string[];
  areaDone: boolean;
  failReason: string;
}
export type SateiPrepDecideReq = { decision: "ok"; rev: number; lines: string[]; deadline: number } | { decision: "manual"; rev: number };

export interface GsPrepPortal {
  intake(req: SateiPrepIntakeReq): Promise<SateiCall<{ created: boolean; status: string }>>;
  notices(): Promise<SateiCall<SateiPrepNotice[]>>;
  decide(tid: string, req: SateiPrepDecideReq): Promise<SateiCall<{ status: string }>>;
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
  if (r.status !== "相談中" && r.status !== "失敗") return null;
  if (!Array.isArray(r.lines) || !r.lines.every((s) => typeof s === "string")) return null;
  return { tid: r.tid, no: r.no, status: r.status, lines: r.lines as string[], areaDone: r.areaDone === true, failReason: typeof r.failReason === "string" ? r.failReason : "" };
}

export async function sateiPrepNotices(opts: SateiPortalOpts): Promise<SateiCall<SateiPrepNotice[]>> {
  return classify(await getJson("/api/jobs/satei/prep/notices", opts), (b) =>
    Array.isArray(b.preps) ? b.preps.map(asNotice).filter((x): x is SateiPrepNotice => x !== null) : null,
  );
}

export async function sateiPrepDecide(tid: string, req: SateiPrepDecideReq, opts: SateiPortalOpts): Promise<SateiCall<{ status: string }>> {
  return classify(await postJson(`/api/jobs/satei/prep/${tid}/decide`, req, opts), (b) => (typeof b.status === "string" ? { status: b.status } : null));
}
