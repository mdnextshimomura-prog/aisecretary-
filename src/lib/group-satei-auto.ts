/**
 * 案件の自動登録（計画 docs/superpowers/plans/2026-11-27-group-satei-auto-deal.md の A2・A3）：
 * 「ぴったり合う」の判定と、物件名・案件名・フォルダ名の作り方。通信はしない。
 * 流れ（登録・見回り）は下の gsAutoDeal・sweepGsAuto。動くのは groupSateiAutoDealOn のときだけ。
 * ログ・KV に物件名・所在・フォルダ名・案件名・userId は出さない（符号・受付番号 G7・案件番号 D231・回数だけ）。
 */
import { GS_PREP_KINDS, type GsPrepKind, type GsRead } from "./group-satei-data";
import { gsBuildingOf } from "./group-satei-case";
import { normalizeProperty } from "./property";
import { candidateDeals, dealKeys, type DealRef } from "./task-record";

/** 受付票ごとの印（gsatei:dec:<tid> の値・Notion の備考の「票 ab12cd34」）に使う tid の頭8字 */
export const gsAutoTid8 = (tid: string) => tid.slice(0, 8);
export const gsAutoMark = (tid: string) => `auto:${gsAutoTid8(tid)}`;
/** Notion の備考に入れる印（作る前にこれで探す＝やり直しで増やさない） */
export const gsAutoNoteMark = (tid: string) => `票 ${gsAutoTid8(tid)}`;

export type GsAutoMatch =
  | { kind: "none" }
  | { kind: "one"; deal: DealRef }
  | { kind: "ask"; reason: "exact2" | "partial" | "buy" | "no-read" | "kind" | "no-key" };

const isPrepKind = (k: unknown): k is GsPrepKind => GS_PREP_KINDS.includes(k as GsPrepKind);

/** 照合の鍵：物件名・建物名（号室を落としたもの）・所在（重なりは1つに） */
export function gsAutoKeys(read: GsRead | null): string[] {
  if (!read) return [];
  const keys = [read.propertyName, gsBuildingOf(read), read.address].map((s) => normalizeProperty(s ?? "")).filter(Boolean);
  return keys.filter((k, i) => keys.indexOf(k) === i);
}

/**
 * 進行中の案件（完了・失注以外）に照らす（A2）。
 * none＝完全一致も部分一致も無い → 自動登録へ／one＝完全一致がちょうど1件（【買】でない）→ その案件で進める／
 * ask＝決められない（完全一致が2件以上・部分一致だけ・【買】の案件・読み取りや鍵が無い）→ 今のカード
 */
export function gsAutoMatch(read: GsRead | null, deals: DealRef[]): GsAutoMatch {
  if (!read) return { kind: "ask", reason: "no-read" };
  if (!isPrepKind(read.kind)) return { kind: "ask", reason: "kind" };
  const keys = gsAutoKeys(read);
  if (keys.length === 0) return { kind: "ask", reason: "no-key" };
  const exact = deals.filter((d) => dealKeys(d.name).some((k) => keys.includes(k)));
  if (exact.length >= 2) return { kind: "ask", reason: "exact2" };
  if (exact.length === 1) {
    return (exact[0].phase ?? "").startsWith("【買】") ? { kind: "ask", reason: "buy" } : { kind: "one", deal: exact[0] };
  }
  const partial = keys.some((k) => candidateDeals(k, deals, deals.length + 1).length > 0);
  return partial ? { kind: "ask", reason: "partial" } : { kind: "none" };
}

const cutCp = (s: string, max: number) => Array.from(s).slice(0, max).join("");
/** NFKC・改行と制御文字を空白に・空白の連続を1つに・前後の空白を落とす */
const tidy = (s: string) => s.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

export const GS_PROP_TITLE_MAX = 60;
export const GS_DEAL_NAME_MAX = 100;
export const GS_FOLDER_NAME_MAX = 80;

/**
 * CRM_物件 の物件名（A3）。マンション：読み取りの物件名（マンション名と号室）、無ければ「<所在> マンション」。
 * 戸建・土地：物件名があればそれ、無ければ「<所在> 戸建」「<所在> 土地」。60字（コードポイント）まで。作れなければ null
 */
export function gsPropTitle(read: GsRead | null): string | null {
  if (!read || !isPrepKind(read.kind)) return null;
  const name = tidy(read.propertyName ?? "");
  const addr = tidy(read.address ?? "");
  const raw = name || (addr ? `${addr} ${read.kind}` : "");
  const out = cutCp(raw, GS_PROP_TITLE_MAX).trim();
  return out || null;
}

/** CRM_案件 の案件名：`査定｜顧客未定｜<物件名>`（crm.ts の「対応内容｜氏名｜物件」と同じ並び。100字まで） */
export const gsDealName = (propTitle: string): string => cutCp(`査定｜顧客未定｜${propTitle}`, GS_DEAL_NAME_MAX).trim();

/** 案件番号の表し方（DEAL-0231）。ログは D231 */
export const gsDealLabel = (dealNo: number): string => `DEAL-${String(dealNo).padStart(4, "0")}`;
export const gsDealCode = (dealNo: number): string => `D${dealNo}`;

/** portal の検査（計画 B1）と同じ形 */
const FOLDER_NAME_RE = /^DEAL-[0-9]{4,6}_売却_顧客未定_.+$/;

/**
 * 案件フォルダの名前（A3）：`DEAL-0231_売却_顧客未定_<物件名>`。P3 と同じ sanitize（/\:*?"<>| → _、前後の空白を落とす、_ の連続を1つに）
 * → 80字（コードポイント）で切る。「顧客未定」に「様」は付けない。作れなければ null
 */
export function gsDealFolderName(dealNo: number, propTitle: string): string | null {
  if (!Number.isInteger(dealNo) || dealNo <= 0 || dealNo > 999_999) return null;
  const prop = tidy(propTitle);
  if (!prop) return null;
  const sanitized = `${gsDealLabel(dealNo)}_売却_顧客未定_${prop}`.replace(/[/\\:*?"<>|]/g, "_").trim().replace(/_+/g, "_");
  const name = cutCp(sanitized, GS_FOLDER_NAME_MAX).trim();
  return FOLDER_NAME_RE.test(name) ? name : null;
}
