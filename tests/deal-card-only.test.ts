/** 一時的な絞り込み（deal-card-only.ts） */
import assert from "node:assert/strict";
import { onlyDeals, ONLY_DEAL_IDS } from "../src/lib/deal-card-only";

const deals = [
  { id: "aaaaaaaa-1111-2222-3333-444444444444", name: "A" },
  { id: "41afd849-2778-8125-8cda-e91077fec212", name: "サウスオールシティ" },
  { id: "bbbbbbbb11112222333344444444ffff", name: "B" },
];
let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("空なら全件そのまま", () => assert.deepEqual(onlyDeals(deals, []), deals));
t("ハイフンあり・なしでも一致する", () =>
  assert.deepEqual(onlyDeals(deals, ["41AFD849277881258CDAE91077FEC212"]).map((d) => d.name), ["サウスオールシティ"]));
t("いまの設定はサウスオールシティ1件だけ", () =>
  assert.deepEqual(onlyDeals(deals).map((d) => d.name), ["サウスオールシティ"]));
t("一致が無ければ空（全件に戻さない）", () => assert.deepEqual(onlyDeals(deals, ["ffff"]), []));
t("設定は1件", () => assert.equal(ONLY_DEAL_IDS.length, 1));
console.log(`deal-card-only: ${n} ok`);
