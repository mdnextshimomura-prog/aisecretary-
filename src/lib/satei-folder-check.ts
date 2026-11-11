/**
 * B2 査定書：保存直前のフォルダ照合（契約 6-3）。査定係（Mac）が案件フォルダへ書く直前に呼ぶ。
 * - 合言葉は通知の受け口と同じ x-satei-token（satei-notify.ts）。
 * - {no, dealId, folderId} → Notion の CRM_案件 のページの `Driveフォルダ` を読み {match:true|false}。
 * - 読めない・見つからない・5秒で時間切れ・TASK_SATEI off・CRM_DEALS_DB_ID 未設定 → 503（査定係は書かずに次の回へ）。
 * ログは `[satei] folder-check #J12 match` の形だけ（ID・案件名は出さない）。
 */
import { sateiActive } from "./satei-data";
import { normNotionId, type SateiDeal } from "./satei-deal";
import { sateiNotifyAuthorized } from "./satei-notify";
import { PAGE_ID_RE } from "./task-buttons";

export const FOLDER_CHECK_TIMEOUT_MS = 5_000;
const FOLDER_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const DEAL_ID_RE = /^[0-9a-f]{32}$/i;

export interface FolderCheckInput {
  no: number;
  dealId: string;
  folderId: string;
}

export function parseFolderCheckInput(body: unknown): FolderCheckInput | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { no, dealId, folderId } = body as Record<string, unknown>;
  if (typeof no !== "number" || !Number.isInteger(no) || no <= 0) return null;
  if (typeof dealId !== "string" || !(PAGE_ID_RE.test(dealId) || DEAL_ID_RE.test(dealId))) return null;
  if (typeof folderId !== "string" || !FOLDER_ID_RE.test(folderId)) return null;
  return { no, dealId, folderId };
}

export function folderMatches(deal: SateiDeal, input: FolderCheckInput, dealsDbId: string): boolean {
  return (
    !deal.gone &&
    deal.parentDbId === normNotionId(dealsDbId) &&
    deal.id === normNotionId(input.dealId) &&
    deal.folderId === input.folderId
  );
}

export interface FolderCheckDeps {
  env: Record<string, string | undefined>;
  /** CRM_案件 のページ。見つからなければ null。読めなければ例外 */
  readDealPage(dealId: string): Promise<SateiDeal | null>;
  timeoutMs?: number;
  log(line: string): void;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

const unavailable = (error: string) => ({ status: 503, body: { error } });

export async function handleSateiFolderCheck(
  header: string | null,
  raw: string,
  deps: FolderCheckDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!sateiNotifyAuthorized(header, deps.env.JOB_API_TOKEN)) {
    return { status: 401, body: { error: "Unauthorized" } };
  }
  if (!sateiActive(deps.env)) {
    deps.log("[satei] folder-check off");
    return unavailable("off");
  }
  const dealsDbId = deps.env.CRM_DEALS_DB_ID ?? "";
  if (!dealsDbId) {
    deps.log("[satei] folder-check config-missing");
    return unavailable("config");
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "bad-input" } };
  }
  const input = parseFolderCheckInput(body);
  if (!input) return { status: 400, body: { error: "bad-input" } };
  let deal: SateiDeal | null;
  try {
    deal = await withTimeout(deps.readDealPage(input.dealId), deps.timeoutMs ?? FOLDER_CHECK_TIMEOUT_MS);
  } catch {
    deps.log(`[satei] folder-check #J${input.no} unavailable`);
    return unavailable("unavailable");
  }
  if (!deal) {
    deps.log(`[satei] folder-check #J${input.no} not-found`);
    return unavailable("unavailable");
  }
  const match = folderMatches(deal, input, dealsDbId);
  deps.log(`[satei] folder-check #J${input.no} ${match ? "match" : "mismatch"}`);
  return { status: 200, body: { match } };
}
