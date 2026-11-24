/** group-satei-card.ts */
import assert from "node:assert/strict";
import { gsCard, gsListCard, gsNoticeText, gsPickLabel, msgGsManual } from "../src/lib/group-satei-card";
import { parseGsData, ticketIdOf } from "../src/lib/group-satei-data";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const tid = ticketIdOf("m1");
const AT = Date.UTC(2026, 10, 23, 2, 55); // JST 11/23 11:55
const D1 = { id: "0123abcd0123456789ab0123456789ab", name: "大宮1丁目 戸建", phase: "査定" };
const D2 = { id: "1123abcd0123456789ab0123456789ab", name: "サウスオールシティ｜1203", phase: "媒介" };

t("知らせの文（大宮の形・作り物）", () => {
  const s = gsNoticeText({ no: 7, at: AT, requesterName: "前田", read: { address: "大阪市北区テスト1丁目2", propertyName: null, kind: "戸建", basis: "登記", confidence: 0.9 }, materials: { images: 2, pdfs: 1, others: 0 } });
  assert.match(s, /査定の依頼がありました/);
  assert.match(s, /11\/23 11:55・前田さん（受付 G7）/);
  assert.match(s, /読み取った物件：大阪市北区テスト1丁目2/);
  assert.match(s, /種別の見込み：戸建（登記から）/);
  assert.match(s, /資料：画像2枚・PDF1件/);
});
t("確信度が低いと「かもしれません」", () => {
  const s = gsNoticeText({ no: 1, at: AT, requesterName: null, read: { address: null, propertyName: "X", kind: "不明", basis: "本文", confidence: 0.6 }, materials: { images: 0, pdfs: 0, others: 0 } });
  assert.match(s, /査定の依頼かもしれません/);
  assert.ok(!s.includes("さん（"));
});
t("読めなかったときも黙らない", () => {
  const s = gsNoticeText({ no: 2, at: AT, requesterName: null, read: null, readFailed: "cap", materials: { images: 1, pdfs: 0, others: 0 } });
  assert.match(s, /資料を読めませんでした（本日の上限）/);
});
t("ボタンの言葉で結果が分かる", () => {
  assert.match(gsPickLabel("サウスオールシティ", "マンション"), /で査定書を作る$/);
  assert.match(gsPickLabel("大宮", "戸建"), /で進める（手作業）$/);
  assert.match(gsPickLabel("大宮", null), /で進める$/);
  assert.ok(Array.from(gsPickLabel("あ".repeat(60), "マンション")).length <= 40);
});
t("カード：候補＋一覧＋案件がまだ無い＋査定ではない、data は読める", () => {
  const c = gsCard(tid, 1, [{ deal: D1, kind: "戸建" }, { deal: D2, kind: "マンション" }], false);
  const btns = (c.contents as any).footer.contents;
  assert.equal(btns.length, 5);
  const ops = btns.map((b: any) => parseGsData(b.action.data)?.op);
  assert.deepEqual(ops, ["gs", "gs", "gl", "gm", "gn"]);
});
t("候補が無ければ一覧・案件なし・査定ではない の3つ", () => {
  const c = gsCard(tid, 1, [], true);
  assert.equal((c.contents as any).footer.contents.length, 3);
  assert.match(JSON.stringify(c), /CRM の案件を確かめられませんでした/);
});
t("一覧のカード：10件＋次の10件", () => {
  const deals = Array.from({ length: 12 }, (_, i) => ({ id: `${String(i).padStart(2, "0")}23abcd0123456789ab0123456789ab`, name: `案件${String(i).padStart(2, "0")}` }));
  const c = gsListCard(tid, 1, 7, deals, 0)!;
  assert.equal((c.contents as any).contents.length, 11);
  assert.equal(gsListCard(tid, 1, 7, deals, 20), null);
});
t("ボタンの表示文：案件名が入る／受付番号が入る（Ruling-A）", () => {
  const c = gsCard(tid, 1, [{ deal: D1, kind: "戸建" }], false, 7);
  const btns = (c.contents as any).footer.contents;
  assert.ok(btns[0].action.displayText.includes("大宮1丁目 戸建"));
  assert.ok(btns[0].action.displayText.startsWith("（ボタン）"));
  const gn = btns[btns.length - 1];
  assert.equal(gn.action.displayText, "（ボタン）【受付 G7】査定の依頼ではない");
  const c2 = gsCard(tid, 1, [], false);
  assert.equal((c2.contents as any).footer.contents[2].action.displayText, "（ボタン）査定の依頼ではない");
});
t("手作業の返事", () => {
  assert.match(msgGsManual(7, "戸建"), /戸建のため自動作成はできません。手作業の査定に回します/);
  assert.match(msgGsManual(7, "土地"), /土地のため/);
  assert.match(msgGsManual(7, null), /物件の種別が分からないため/);
});
console.log(`group-satei-card: ${n} ok`);
