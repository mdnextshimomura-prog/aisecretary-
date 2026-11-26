/** 段2d：文・カード・検査（group-satei-case.ts。純粋） */
import assert from "node:assert/strict";
import {
  gsBuildingOf, gsCaseRequestMessages, gsCleanLines, gsFixRequest, gsParseFix, gsProposalCard, gsPublicPlace, gsReminderMessages,
  gsSafeText, gsTownOf, msgGsCaseRequested,
} from "../src/lib/group-satei-case";
import { ticketIdOf, type GsRead } from "../src/lib/group-satei-data";
import { cardActions } from "../src/lib/task-card";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const STAFF = "U" + "d".repeat(32);
const tid = ticketIdOf("m1");
const read = (o: Partial<GsRead> = {}): GsRead => ({ address: "大阪市北区天満2丁目3-4", propertyName: "パークハウス天満 1203号室", kind: "マンション", basis: "本文", confidence: 0.9, ...o });
const LINES = ["成約：同じマンション（パークハウス天満）→ 同じ町名 → 同じ小学校区", "　専有55.3〜75.3㎡・築1995〜2015年・過去2年（足りなければ3年）・10〜15件", "売出：同じ条件で、いま売り出し中のものを5件ほど（無ければ無しで）"];
const D = Date.UTC(2026, 10, 26, 9); // JST 11/26（木）18:00

t("検査：号室・番地・番＋数字・数字-数字・9桁以上・様は通さない。ふつうの条件の行は通す", () => {
  for (const s of LINES) assert.equal(gsSafeText(s), true, s);
  for (const s of ["1203号室", "3番地", "3番4", "2-3-4", "１２３４５６７８９０", "山田様", "100013456789"]) assert.equal(gsSafeText(s), false, s);
});
t("行の整え：空白の行を捨て、6行・80字まで。1つでも検査に通らなければ null", () => {
  assert.deepEqual(gsCleanLines([" a ", "", "b"]), ["a", "b"]);
  assert.equal(gsCleanLines([]), null);
  assert.equal(gsCleanLines(["a", 1]), null);
  assert.equal(gsCleanLines(["1203号室を見る"]), null);
  assert.equal(gsCleanLines(new Array(7).fill("a"))!.length, 6);
  assert.equal(Array.from(gsCleanLines(["あ".repeat(90)])![0]).length, 80);
});
t("町名：丁目まで。丁目が無ければ最初の数字の前まで", () => {
  assert.equal(gsTownOf("大阪市北区天満2丁目3-4"), "大阪市北区天満2丁目");
  assert.equal(gsTownOf("大阪市北区天満二丁目3番4号"), "大阪市北区天満二丁目");
  assert.equal(gsTownOf("豊中市新千里東町１－２－３"), "豊中市新千里東町");
  assert.equal(gsTownOf("西宮市甲子園町123番4"), "西宮市甲子園町");
  assert.equal(gsTownOf(null), null);
  assert.equal(gsTownOf("123"), null);
});
t("建物名：号室を落とす（facts.roomNo と末尾の数字＋号室）", () => {
  assert.equal(gsBuildingOf(read()), "パークハウス天満");
  assert.equal(gsBuildingOf(read({ propertyName: "ザ・タワー大阪 3005", facts: { roomNo: "3005", exclusiveArea: null, landArea: null, buildingArea: null, builtYm: null, layout: null, floor: null, totalUnits: null, structure: null } })), "ザ・タワー大阪");
  assert.equal(gsBuildingOf(read({ propertyName: null })), null);
});
t("物件の言い方：マンションは町名・建物名、戸建・土地は町名だけ", () => {
  assert.equal(gsPublicPlace(read(), "マンション"), "大阪市北区天満2丁目・パークハウス天満");
  assert.equal(gsPublicPlace(read(), "戸建"), "大阪市北区天満2丁目");
  assert.equal(gsPublicPlace(read({ address: null, propertyName: null }), "土地"), null);
});
t("相談のカード：［いいよ］［直す］の data に版、押した表示は【受付 G7】", () => {
  const card = gsProposalCard({ tid, ver: 1, no: 7, rev: 2, place: "大阪市北区天満2丁目・パークハウス天満", lines: LINES, previewDeadline: D });
  const acts = cardActions(card);
  assert.deepEqual(acts.map((a) => a.data), [`v1|gy|${tid}|1|2`, `v1|gf|${tid}|1|2`]);
  const json = JSON.stringify(card);
  assert.ok(json.includes("山口さんに頼んでいいですか"));
  assert.ok(json.includes("11/26（木）18時"));
  assert.ok(json.includes("【受付 G7】"));
});
t("グループの依頼：textV2 のメンション＋ボタンなしのカード。名前・号室・番地は入らない", () => {
  const m = gsCaseRequestMessages({ staffId: STAFF, no: 7, place: "大阪市北区天満2丁目・パークハウス天満", lines: LINES, deadline: D })!;
  assert.equal(m.length, 2);
  const v2 = m[0] as { type: string; text: string; substitution: Record<string, { type: string; mentionee: { type: string; userId: string } }> };
  assert.equal(v2.type, "textV2");
  assert.ok(v2.text.startsWith("{staff} "));
  assert.deepEqual(v2.substitution.staff, { type: "mention", mentionee: { type: "user", userId: STAFF } });
  const json = JSON.stringify(m[1]);
  assert.equal(json.includes("\"button\""), false);
  assert.ok(json.includes("期日：11/26（木）18時"));
  assert.ok(json.includes("このトークに PDF を貼ってください"));
  assert.equal(gsCaseRequestMessages({ staffId: STAFF, no: 7, place: "天満2-3", lines: LINES, deadline: D }), null);
});
t("リマインド：textV2 1つ「受付 G7 の事例はいかがでしょうか」", () => {
  const m = gsReminderMessages(STAFF, 7) as Array<{ type: string; text: string }>;
  assert.equal(m.length, 1);
  assert.equal(m[0].text, "{staff} 受付 G7 の事例はいかがでしょうか");
});
t("作り直しの指示：今の行と直しの文を渡し、答えは JSON の lines。検査に通らない答えは null", () => {
  const req = gsFixRequest(LINES, "築年は±5年で", "マンション");
  assert.ok(JSON.stringify(req.messages).includes("築年は±5年で"));
  assert.deepEqual(gsParseFix({ content: [{ type: "text", text: '{"lines":["成約：同じマンション","　築2000〜2010年"]}' }] }), ["成約：同じマンション", "　築2000〜2010年"]);
  assert.equal(gsParseFix({ content: [{ type: "text", text: '{"lines":["1203号室"]}' }] }), null);
  assert.equal(gsParseFix({ content: [{ type: "text", text: "わかりません" }] }), null);
});
t("依頼の返事：期日と、2e までのつなぎの一言", () => {
  const s = msgGsCaseRequested(7, "11/26（木）18時");
  assert.ok(s.includes("山口さんに頼みました（受付 G7・期日 11/26（木）18時）"));
  assert.ok(s.includes("02 に入れて［査定書を作る］"));
});
console.log(`${n} passed`);
