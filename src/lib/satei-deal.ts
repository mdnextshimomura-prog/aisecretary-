/**
 * B2 査定書：CRM_案件 のページ（案件名・ID・Driveフォルダ・物件）と CRM_物件 の `種別` を読み、作れるかを決める。
 * 欄の名前は 2026-11-11 に確認済み（契約 第3節）。Notion への通信はしない（ページは satei-wire.ts が読む）。
 */
export interface SateiDeal {
  /** Notion のページ ID（ハイフンなし小文字32桁） */
  id: string;
  name: string;
  /** `ID`（unique_id）の数字。無ければ null */
  dealNo: number | null;
  /** `Driveフォルダ`（https://drive.google.com/drive/folders/<id>）の <id>。無い・形が違えば null */
  folderId: string | null;
  /** `物件`（relation → CRM_物件）のページ ID（並びのまま） */
  propertyIds: string[];
  /** アーカイブ・ゴミ箱 */
  gone: boolean;
  /** 親の DB の ID（ハイフンなし小文字）。DB の子でなければ null */
  parentDbId: string | null;
}

export const SATEI_KIND = "マンション";

export const normNotionId = (id: string): string => id.replace(/-/g, "").toLowerCase();

const FOLDER_PATH_RE = /\/folders\/([A-Za-z0-9_-]{10,200})\/?$/;

export function folderIdFromUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "drive.google.com") return null;
  const m = u.pathname.match(FOLDER_PATH_RE);
  return m ? m[1] : null;
}

type Props = Record<string, unknown>;
const propsOf = (page: Record<string, unknown>): Props =>
  (page.properties as Props | undefined) ?? {};

export function readSateiDealPage(page: Record<string, unknown>): SateiDeal {
  const p = propsOf(page);
  const title = (p["案件名"] as { title?: Array<{ plain_text?: string }> } | undefined)?.title ?? [];
  const n = (p["ID"] as { unique_id?: { number?: unknown } } | undefined)?.unique_id?.number;
  const url = (p["Driveフォルダ"] as { url?: unknown } | undefined)?.url;
  const rel = (p["物件"] as { relation?: Array<{ id?: unknown }> } | undefined)?.relation ?? [];
  const parent = page.parent as { type?: string; database_id?: unknown } | undefined;
  return {
    id: normNotionId(String(page.id ?? "")),
    name: title.map((t) => t.plain_text ?? "").join("").trim(),
    dealNo: typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null,
    folderId: folderIdFromUrl(url),
    propertyIds: rel.map((r) => r.id).filter((id): id is string => typeof id === "string"),
    gone: Boolean(page.archived || page.in_trash),
    parentDbId:
      parent?.type === "database_id" && typeof parent.database_id === "string"
        ? normNotionId(parent.database_id)
        : null,
  };
}

/** CRM_物件 の `種別`（select）の名前。無ければ null */
export function readPropertyKind(page: Record<string, unknown>): string | null {
  const k = (propsOf(page)["種別"] as { select?: { name?: unknown } | null } | undefined)?.select?.name;
  return typeof k === "string" && k ? k : null;
}

export type SateiDealJudge =
  | { ok: true; deal: { id: string; name: string; dealNo: number | null; folderId: string } }
  | { ok: false; reason: "not-found" | "not-mansion" | "no-folder" };

/**
 * 作れるか。順番：ページが無い・消えた・CRM_案件 の子でない → not-found、
 * 種別がマンションでない（分からないも含む）→ not-mansion、フォルダが無い → no-folder。
 */
export function judgeSateiDeal(
  deal: SateiDeal | null,
  kind: string | null,
  dealsDbId: string,
): SateiDealJudge {
  if (!deal || deal.gone || !deal.id || deal.parentDbId !== normNotionId(dealsDbId)) {
    return { ok: false, reason: "not-found" };
  }
  if (kind !== SATEI_KIND) return { ok: false, reason: "not-mansion" };
  if (!deal.folderId) return { ok: false, reason: "no-folder" };
  return {
    ok: true,
    deal: { id: deal.id, name: deal.name, dealNo: deal.dealNo, folderId: deal.folderId },
  };
}
