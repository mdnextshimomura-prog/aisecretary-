/**
 * 段2b：足りない項目の決まりと、聞く文・答えの読み方（設計 4）。通信はしない。
 * 種別は CRM_物件 の `種別` が正（案件を選んだあとに呼ぶ）。マンション・戸建・土地のほかは聞かない。
 * 聞くのは1回に1つ（並びの先頭から）。聞く仕組み（KV の印・1対1の文字の取り込み・［分からない］）は 2d と一緒に作る。
 */
import { receiptOf, type GsRead } from "./group-satei-data";
import { normRoom, normYm, numOrNull, scrubNames } from "./group-satei-read";

export type GsFactKey = "address" | "propertyName" | "roomNo" | "exclusiveArea" | "builtYm" | "landArea" | "buildingArea";

export const GS_FACT_LABEL: Record<GsFactKey, string> = {
  address: "所在",
  propertyName: "物件名",
  roomNo: "号室",
  exclusiveArea: "専有面積",
  builtYm: "築年月",
  landArea: "土地面積",
  buildingArea: "建物面積",
};

/** 査定書の表紙・概要に要るもの（設計 4。この順に聞く） */
const NEED: Record<string, GsFactKey[]> = {
  マンション: ["address", "propertyName", "roomNo", "exclusiveArea", "builtYm"],
  戸建: ["address", "landArea", "buildingArea", "builtYm"],
  土地: ["address", "landArea"],
};

export function gsMissingFacts(kind: string | null, read: GsRead | null): GsFactKey[] {
  const need = (kind && Object.prototype.hasOwnProperty.call(NEED, kind) && NEED[kind]) || [];
  const f = read?.facts;
  const has: Record<GsFactKey, boolean> = {
    address: Boolean(read?.address),
    propertyName: Boolean(read?.propertyName),
    roomNo: Boolean(f?.roomNo),
    exclusiveArea: f?.exclusiveArea != null,
    builtYm: Boolean(f?.builtYm),
    landArea: f?.landArea != null,
    buildingArea: f?.buildingArea != null,
  };
  return need.filter((k) => !has[k]);
}

const EXAMPLE: Record<GsFactKey, string> = {
  address: "大阪市旭区大宮1丁目3番27",
  propertyName: "サウスオールシティ",
  roomNo: "1203",
  exclusiveArea: "65.3",
  builtYm: "2005年3月",
  landArea: "120.5",
  buildingArea: "98.2",
};

/** 「【受付 G7】専有面積が分かりません。分かれば送ってください（例：65.3）」 */
export const gsAskText = (key: GsFactKey, no: number) =>
  `【受付 ${receiptOf(no)}】${GS_FACT_LABEL[key]}が分かりません。分かれば送ってください（例：${EXAMPLE[key]}）`;

/** 1対1で返ってきた答えを、その項目の値に読む。読めなければ null（もう一度聞くか、［分からない］を待つ） */
export function gsAnswerFact(key: GsFactKey, text: string): string | number | null {
  const v = text.trim();
  if (!v) return null;
  if (key === "exclusiveArea" || key === "landArea" || key === "buildingArea") return numOrNull(v);
  if (key === "builtYm") return normYm(v);
  if (key === "roomNo") return normRoom(v);
  const s = scrubNames(v);
  return s ? Array.from(s).slice(0, 80).join("") : null;
}
