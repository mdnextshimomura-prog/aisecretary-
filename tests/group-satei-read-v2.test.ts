/** 段2b：読み取りを広げる（group-satei-read.ts。AI は差し替え） */
import assert from "node:assert/strict";
import { GS_READ_PROMPT, GS_READ_PROMPT_V2, normRoom, normYm, numOrNull, parseGsReadText, readGsMaterials } from "../src/lib/group-satei-read";

let n = 0;
const t = async (name: string, f: () => void | Promise<void>) => { await f(); n++; console.log("ok", name); };
const V2_ANSWER = JSON.stringify({
  所在: "大阪市北区テスト1丁目2", 物件名: "テストマンション1203", 号室: "1203号室", 種別の見込み: "マンション", 根拠: "チラシ",
  専有面積: "65.3㎡", 土地面積: null, 建物面積: null, 築年月: "2005年3月", 間取り: "3LDK", 階: 12, 総戸数: "120戸", 構造: "SRC", 確信度: 0.8,
});

(async () => {
  await t("段1の指示文は1字も変えていない（V2 は別の文）", () => {
    assert.notEqual(GS_READ_PROMPT_V2, GS_READ_PROMPT);
    assert.match(GS_READ_PROMPT_V2, /名前は、どの欄にも書かないでください/);
    for (const k of ["号室", "専有面積", "土地面積", "建物面積", "築年月", "間取り", "階", "総戸数", "構造"]) assert.ok(GS_READ_PROMPT_V2.includes(`"${k}"`), k);
  });
  await t("facts なしの読み方は段1と同じ形（facts の欄が無い）", () => {
    const r = parseGsReadText(V2_ANSWER);
    assert.equal("facts" in r, false);
  });
  await t("facts ありの読み方：単位・書き方をそろえる", () => {
    const r = parseGsReadText(V2_ANSWER, { facts: true });
    assert.equal(r.propertyName, "テストマンション1203");
    assert.deepEqual(r.facts, { roomNo: "1203", exclusiveArea: 65.3, landArea: null, buildingArea: null, builtYm: "2005-03", layout: "3LDK", floor: 12, totalUnits: 120, structure: "SRC" });
  });
  await t("数・年月・号室の検査", () => {
    assert.equal(numOrNull("1,234.5㎡"), 1234.5);
    assert.equal(numOrNull(0), null);
    assert.equal(numOrNull("不明"), null);
    assert.equal(numOrNull(-3), null);
    assert.equal(normYm("2005/3"), "2005-03");
    assert.equal(normYm("昭和55年"), null);
    assert.equal(normYm("2005-13"), null);
    assert.equal(normRoom("A-101"), "A-101");
    assert.equal(normRoom("山田様"), null);
    assert.equal(normRoom(1203), "1203");
  });
  await t("名前らしい値は facts でも捨てる", () => {
    const r = parseGsReadText(JSON.stringify({ 所在: "大阪市北区1-2", 種別の見込み: "戸建", 根拠: "登記", 構造: "山田様の木造", 確信度: 0.9 }), { facts: true });
    assert.equal(r.facts?.structure, null);
  });
  await t("readGsMaterials：stage2 のときだけ V2 の指示文と facts", async () => {
    let sys = "";
    const create = async (req: { system: string }) => { sys = req.system; return { content: [{ type: "text", text: V2_ANSWER }] }; };
    const one = await readGsMaterials([], "査定", "2026-11-26", create as any);
    assert.equal(sys, GS_READ_PROMPT);
    assert.equal("facts" in one, false);
    const two = await readGsMaterials([], "査定", "2026-11-26", create as any, { stage2: true });
    assert.equal(sys, GS_READ_PROMPT_V2);
    assert.equal(two.facts?.exclusiveArea, 65.3);
  });
  console.log(`group-satei-read-v2: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
