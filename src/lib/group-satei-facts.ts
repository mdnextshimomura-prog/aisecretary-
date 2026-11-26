/**
 * 段2b：足りない項目の決まりと、聞く文・答えの読み方（設計 4）。通信はしない。
 * 種別は CRM_物件 の `種別` が正（案件を選んだあとに呼ぶ）。マンション・戸建・土地のほかは聞かない。
 * 段2b-2 では1回にまとめて聞く（gsInfoAskText・計画 I1）。聞く仕組みは group-satei-actions.ts（pick）・group-satei-info.ts。
 */
import { receiptOf, type GsFacts, type GsRead } from "./group-satei-data";
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

/** 段2b-2（計画 I1・Global）：まとめて聞く項目（号室は聞かない＝準備に使わない・グループに出さない） */
export function gsInfoKeys(kind: string | null, read: GsRead | null): GsFactKey[] {
  return gsMissingFacts(kind, read).filter((k) => k !== "roomNo");
}

export const isGsFactKey = (x: unknown): x is GsFactKey => typeof x === "string" && Object.prototype.hasOwnProperty.call(GS_FACT_LABEL, x);

/** 段2b-2（I1）：1回にまとめて聞く文 */
export function gsInfoAskText(no: number, keys: GsFactKey[]): string {
  return [
    `【受付 ${receiptOf(no)}】資料から読めなかった項目があります。分かる分だけ1通で送ってください（喋ったままで大丈夫です）`,
    ...keys.map((k) => `・${GS_FACT_LABEL[k]}（例：${EXAMPLE[k]}）`),
    "分からなければ［このまま進める］を押してください。30分たつと、このまま進めます",
  ].join("\n");
}

/** 段2b-2（I3）：「受け取りました（専有面積・築年月）。事例の相談の案を作ります」 */
export const gsInfoLabels = (keys: GsFactKey[]) => keys.map((k) => GS_FACT_LABEL[k]).join("・");
export const msgGsInfoFilled = (keys: GsFactKey[]) => `受け取りました（${gsInfoLabels(keys)}）。事例の相談の案を作ります`;
export const MSG_GS_INFO_UNREAD = "読み取れなかったので、このまま進めます";
export const msgGsInfoDone = (no: number) => `この受付はもう進めています（受付 ${receiptOf(no)}）`;

/**
 * 段2b-2（I3）：答えの1通を Claude 1回で項目ごとに分ける指示。値は書かれたまま写させ（換算しない）、
 * 検査は gsAnswerFact（numOrNull・normYm・scrubNames）が行う
 */
export function gsInfoSystem(keys: GsFactKey[]): string {
  return [
    "あなたは不動産会社の査定の手伝いです。担当者が送ってきた1通から、聞いた項目の値だけを取り出します。",
    `聞いた項目：${keys.map((k) => GS_FACT_LABEL[k]).join("、")}`,
    `答えは JSON だけ：{${keys.map((k) => `"${GS_FACT_LABEL[k]}":"…"`).join(",")}}。書かれていない項目は null。`,
    "値は書かれたままの言葉を写す（単位・和暦もそのまま。坪を㎡に直すなどの換算はしない。数字を作らない）。人の名前は書かない。",
  ].join("\n");
}

/** Claude の答え（JSON）を、聞いた項目ごとに検査して通った値だけにする */
export function gsInfoParse(keys: GsFactKey[], raw: string): Partial<Record<GsFactKey, string | number>> {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return {};
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (!o || typeof o !== "object") return {};
  const out: Partial<Record<GsFactKey, string | number>> = {};
  for (const k of keys) {
    const v = o[GS_FACT_LABEL[k]];
    if (typeof v !== "string" && typeof v !== "number") continue;
    const got = gsAnswerFact(k, String(v));
    if (got !== null) out[k] = got;
  }
  return out;
}

/** 通った値を受付票の read に足す（所在・物件名は read.address・read.propertyName、ほかは read.facts） */
export function gsApplyInfo(read: GsRead | null, kind: GsRead["kind"], vals: Partial<Record<GsFactKey, string | number>>): GsRead {
  const base: GsRead = read ?? { address: null, propertyName: null, kind, basis: "その他", confidence: 0 };
  const facts: GsFacts = {
    roomNo: null, exclusiveArea: null, landArea: null, buildingArea: null, builtYm: null, layout: null, floor: null, totalUnits: null, structure: null,
    ...(base.facts ?? {}),
  };
  const next: GsRead = { ...base, facts };
  for (const [k, v] of Object.entries(vals) as Array<[GsFactKey, string | number]>) {
    if (k === "address" && typeof v === "string") next.address = v;
    else if (k === "propertyName" && typeof v === "string") next.propertyName = v;
    else if ((k === "exclusiveArea" || k === "landArea" || k === "buildingArea") && typeof v === "number") facts[k] = v;
    else if (k === "builtYm" && typeof v === "string") facts.builtYm = v;
  }
  return next;
}
