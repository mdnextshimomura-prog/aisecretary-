/**
 * B2 査定書：機械から査定を頼む口（POST /api/satei/request）の中身。route は src/app/api/satei/request/route.ts。
 * 約束の正本：agent-hub docs/contracts/2026-11-19-satei-request.md。
 * - 合言葉：ヘッダ x-satei-token = HMAC-SHA256(鍵 = JOB_API_TOKEN, 文 = "satei-request") の小文字 hex（知らせ用とは別）。
 * - 本文 {eventId, dealId} だけ。依頼した人は TASK_SATEI_USER_IDS の先頭、案件名・フォルダは Notion から読む。
 * - ボタンと同じ判定（judgeSateiDeal）のあと、portal の受付を machine:true で呼ぶ（直前が保存済みのときだけ受ける）。
 * - 時間：Notion 5秒 → portal 8秒 → LINE の1行（残りが3秒以上のときだけ。送れなくても受付は取り消さない）。全体は15秒より前に返す。
 * - 返事・ログに、お客様名・案件名・案件の ID を入れない（ログは結果・符号・#J だけ）。
 */
import { createHmac } from "node:crypto";
import { timingSafeEqualStr } from "./secure-compare";
import { sateiActive, sateiNotifyTarget } from "./satei-data";
import { judgeSateiDeal, type SateiDeal } from "./satei-deal";
import { SATEI_KEY_MIN_LENGTH, sateiRetryKey } from "./satei-notify";
import type { SateiCall, SateiIntakeOk, SateiIntakeReq } from "./satei-portal";

export const SATEI_REQUEST_CONTEXT = "satei-request";
export const SATEI_REQUEST_NOTION_MS = 5_000;
/** 受け付けてからこの時間までなら LINE の1行を送る（全体15秒・残り3秒以上） */
export const SATEI_REQUEST_PUSH_BEFORE_MS = 12_000;

const EVENT_ID_RE = /^[0-9A-Za-z]{10,64}$/;
const DEAL_ID_RE = /^[0-9a-f]{32}$/;

export function sateiRequestToken(jobApiToken: string): string {
  return createHmac("sha256", Buffer.from(jobApiToken, "utf8")).update(SATEI_REQUEST_CONTEXT, "utf8").digest("hex");
}

export function sateiRequestAuthorized(header: string | null, jobApiToken: string | undefined): boolean {
  if (typeof jobApiToken !== "string" || jobApiToken.length < SATEI_KEY_MIN_LENGTH) return false;
  if (typeof header !== "string") return false;
  return timingSafeEqualStr(header, sateiRequestToken(jobApiToken));
}

export const msgSateiAutoStarted = (no: number): string => `自動で査定書の作成を始めました（#J${no}）`;

/** portal の断りの符号 → この口の符号。ここに無いものは unknown（約束に無い符号を返さない） */
const REJECT_CODES: Record<string, string> = {
  SATEI_AWAITING_REASON: "SATEI_AWAITING_REASON",
  INTAKE_STOPPED: "INTAKE_STOPPED",
  SATEI_HUMAN_ONLY: "HUMAN_ONLY",
  SATEI_ALREADY_CLOSED: "ALREADY_CLOSED",
  INTAKE_MISMATCH: "EVENT_MISMATCH",
};

export interface SateiRequestDeps {
  env: Record<string, string | undefined>;
  dealsDbId: string | null;
  /** 案件ページと物件の種別。無ければ null。読めなければ例外 */
  readDeal(dealId: string): Promise<{ deal: SateiDeal; kind: string | null } | null>;
  intake(req: SateiIntakeReq): Promise<SateiCall<SateiIntakeOk>>;
  push(to: string, messages: unknown[], retryKey: string): Promise<number | null>;
  now(): number;
  log(line: string): void;
}

type Res = { status: number; body: Record<string, unknown> };
const reply = (body: Record<string, unknown>): Res => ({ status: 200, body });

function parseInput(raw: string): { eventId: string; dealId: string } | null {
  let b: unknown;
  try {
    b = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const o = b as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "eventId" && k !== "dealId")) return null;
  if (typeof o.eventId !== "string" || !EVENT_ID_RE.test(o.eventId)) return null;
  if (typeof o.dealId !== "string" || !DEAL_ID_RE.test(o.dealId)) return null;
  return { eventId: o.eventId, dealId: o.dealId };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

export async function handleSateiRequest(header: string | null, raw: string, deps: SateiRequestDeps): Promise<Res> {
  const started = deps.now();
  if (!sateiRequestAuthorized(header, deps.env.JOB_API_TOKEN)) {
    return { status: 401, body: { error: "Unauthorized" } };
  }
  const input = parseInput(raw);
  if (!input) {
    deps.log("[satei] request bad-input");
    return { status: 400, body: { error: "bad-input" } };
  }
  const to = sateiNotifyTarget(deps.env);
  if (!sateiActive(deps.env) || !to) {
    deps.log(`[satei] request rejected TASK_SATEI_OFF${to ? "" : " config"}`);
    return reply({ result: "rejected", code: "TASK_SATEI_OFF" });
  }
  if (!deps.dealsDbId) {
    deps.log("[satei] request unknown config-missing");
    return reply({ result: "unknown" });
  }
  let got: { deal: SateiDeal; kind: string | null } | null;
  try {
    got = await withTimeout(deps.readDeal(input.dealId), SATEI_REQUEST_NOTION_MS);
  } catch {
    deps.log("[satei] request unknown read-failed");
    return reply({ result: "unknown" });
  }
  const j = judgeSateiDeal(got?.deal ?? null, got?.kind ?? null, deps.dealsDbId);
  if (!j.ok) {
    const code = j.reason === "not-mansion" ? "NOT_MANSION" : j.reason === "no-folder" ? "NO_FOLDER" : "DEAL_NOT_FOUND";
    deps.log(`[satei] request needs_confirm ${code}`);
    return reply({ result: "needs_confirm", code });
  }
  let r: SateiCall<SateiIntakeOk>;
  try {
    r = await deps.intake({
      eventId: input.eventId,
      dealId: j.deal.id,
      dealNo: j.deal.dealNo,
      folderId: j.deal.folderId,
      dealName: j.deal.name,
      requestedBy: to,
    });
  } catch {
    r = { kind: "unknown", reason: "exception" };
  }
  if (r.kind === "rejected") {
    const code = REJECT_CODES[r.code];
    if (code) {
      deps.log(`[satei] request rejected ${code}`);
      return reply({ result: "rejected", code });
    }
    deps.log(`[satei] request unknown portal-${r.status}`);
    return reply({ result: "unknown" });
  }
  if (r.kind === "unknown") {
    deps.log("[satei] request unknown portal");
    return reply({ result: "unknown" });
  }
  const { no, status, created } = r.value;
  let pushed = "skip";
  if (created && deps.now() - started <= SATEI_REQUEST_PUSH_BEFORE_MS) {
    try {
      const s = await deps.push(to, [{ type: "text", text: msgSateiAutoStarted(no) }], sateiRetryKey(no, "auto-start", 0));
      pushed = s === 200 || s === 409 ? "sent" : "unknown";
    } catch {
      pushed = "unknown";
    }
  }
  deps.log(`[satei] request #J${no} ok ${created ? "created" : "same"} line ${pushed}`);
  return reply({ result: "ok", no, status, created });
}
