/**
 * 一時的な絞り込み（2026-11-16 下村さんの指示）：［案件］のカードに出す案件を、ここに書いた案件だけにする。
 * B2 査定書を本物の案件（DEAL-238 サウスオールシティ レフトウィング1414号室）で試すあいだだけ使う。
 * 空の配列に戻せば今までどおり（進行中の案件をすべて出す）。CRM_案件 には何も書かない。
 * 試し終わったら、このファイルごと消すか ONLY_DEAL_IDS を [] に戻して出し直す。
 */
import type { DealRef } from "./task-record";

/** Notion のページ ID（ハイフンなし小文字） */
export const ONLY_DEAL_IDS: readonly string[] = [
  "41afd849277881258cdae91077fec212", // DEAL-238 売却 渡邉様 サウスオールシティ レフトウィング1414号室
  "420fd849277881abb697ff511d9e5e87", // DEAL-239 【下村】サンクレイドル津田沼3号棟 222号室（2026-11-22 下村さんの指示：J14 の押し直し・B の実地の確認）
];

const norm = (id: string) => id.replace(/-/g, "").toLowerCase();

/** ids が空なら deals をそのまま返す。空でなければ ids に入っている案件だけ（並びは deals のまま） */
export function onlyDeals(deals: DealRef[], ids: readonly string[] = ONLY_DEAL_IDS): DealRef[] {
  if (ids.length === 0) return deals;
  const keep = new Set(ids.map(norm));
  return deals.filter((d) => keep.has(norm(d.id)));
}
