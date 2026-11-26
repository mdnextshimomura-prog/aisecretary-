/** 段2b：足りない項目の決まり（group-satei-facts.ts。純粋関数） */
import assert from "node:assert/strict";
import { gsAnswerFact, gsAskText, gsMissingFacts } from "../src/lib/group-satei-facts";
import type { GsFacts, GsRead } from "../src/lib/group-satei-data";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const EMPTY: GsFacts = { roomNo: null, exclusiveArea: null, landArea: null, buildingArea: null, builtYm: null, layout: null, floor: null, totalUnits: null, structure: null };
const read = (o: Partial<GsRead> = {}, f: Partial<GsFacts> = {}): GsRead =>
  ({ address: "大阪市北区テスト1丁目2", propertyName: "テストマンション1203", kind: "マンション", basis: "チラシ", confidence: 0.8, facts: { ...EMPTY, ...f }, ...o });

t("マンション：所在・物件名・号室・専有面積・築年月の順", () => {
  assert.deepEqual(gsMissingFacts("マンション", read()), ["roomNo", "exclusiveArea", "builtYm"]);
  assert.deepEqual(gsMissingFacts("マンション", read({}, { roomNo: "1203", exclusiveArea: 65.3, builtYm: "2005-03" })), []);
  assert.deepEqual(gsMissingFacts("マンション", read({ address: null, propertyName: null })), ["address", "propertyName", "roomNo", "exclusiveArea", "builtYm"]);
});
t("戸建：所在・土地面積・建物面積・築年月", () => {
  assert.deepEqual(gsMissingFacts("戸建", read({}, { landArea: 120.5 })), ["buildingArea", "builtYm"]);
});
t("土地：所在・土地面積", () => {
  assert.deepEqual(gsMissingFacts("土地", read({ address: null })), ["address", "landArea"]);
});
t("種別が分からない・ほかの種別は聞かない", () => {
  assert.deepEqual(gsMissingFacts(null, read()), []);
  assert.deepEqual(gsMissingFacts("不明", read()), []);
  assert.deepEqual(gsMissingFacts("ビル", read()), []);
});
t("読めていない（段1の票＝facts なし・read なし）は全部足りない", () => {
  assert.deepEqual(gsMissingFacts("土地", null), ["address", "landArea"]);
  const { facts: _f, ...noFacts } = read();
  assert.deepEqual(gsMissingFacts("マンション", noFacts as GsRead), ["roomNo", "exclusiveArea", "builtYm"]);
});
t("聞く文", () => {
  assert.equal(gsAskText("exclusiveArea", 7), "【受付 G7】専有面積が分かりません。分かれば送ってください（例：65.3）");
});
t("答えの読み方", () => {
  assert.equal(gsAnswerFact("exclusiveArea", "65.3㎡です"), 65.3);
  assert.equal(gsAnswerFact("builtYm", "2005年3月"), "2005-03");
  assert.equal(gsAnswerFact("roomNo", "1203号室"), "1203");
  assert.equal(gsAnswerFact("address", "山田様の家"), null);
  assert.equal(gsAnswerFact("address", "大阪市北区1-2"), "大阪市北区1-2");
  assert.equal(gsAnswerFact("landArea", "分からない"), null);
  assert.equal(gsAnswerFact("landArea", "  "), null);
});
console.log(`group-satei-facts: ${n} ok`);
