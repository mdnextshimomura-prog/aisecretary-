/** 一時的な絞り込み（deal-card-only.ts） */
import assert from "node:assert/strict";
import { dealCardOnlyIds, onlyDeals, ONLY_DEAL_IDS } from "../src/lib/deal-card-only";

const deals = [
  { id: "aaaaaaaa-1111-2222-3333-444444444444", name: "A" },
  { id: "41afd849-2778-8125-8cda-e91077fec212", name: "サウスオールシティ" },
  { id: "bbbbbbbb11112222333344444444ffff", name: "B" },
  { id: "420fd849-2778-81ab-b697-ff511d9e5e87", name: "サンクレイドル津田沼" },
];
let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

t("空なら全件そのまま", () => assert.deepEqual(onlyDeals(deals, []), deals));
t("ハイフンあり・なしでも一致する", () =>
  assert.deepEqual(onlyDeals(deals, ["41AFD849277881258CDAE91077FEC212"]).map((d) => d.name), ["サウスオールシティ"]));
t("いまの設定はサウスオールシティと津田沼の2件だけ", () =>
  assert.deepEqual(onlyDeals(deals).map((d) => d.name), ["サウスオールシティ", "サンクレイドル津田沼"]));
t("一致が無ければ空（全件に戻さない）", () => assert.deepEqual(onlyDeals(deals, ["ffff"]), []));
t("設定は2件", () => assert.equal(ONLY_DEAL_IDS.length, 2));
t("env が無ければ今の2件", () => assert.deepEqual(dealCardOnlyIds({}), ONLY_DEAL_IDS));
t("env が空文字でも今の2件（入れ忘れで全件にしない）", () => assert.deepEqual(dealCardOnlyIds({ DEAL_CARD_ONLY_IDS: " " }), ONLY_DEAL_IDS));
t("all なら絞らない", () => assert.deepEqual(dealCardOnlyIds({ DEAL_CARD_ONLY_IDS: "all" }), []));
t("カンマ区切りの ID", () =>
  assert.deepEqual(dealCardOnlyIds({ DEAL_CARD_ONLY_IDS: "41afd849277881258cdae91077fec212, bbbbbbbb11112222333344444444ffff" }),
    ["41afd849277881258cdae91077fec212", "bbbbbbbb11112222333344444444ffff"]));
t("形の違う ID は捨てる（全部捨てたら今の2件）", () => assert.deepEqual(dealCardOnlyIds({ DEAL_CARD_ONLY_IDS: "xyz" }), ONLY_DEAL_IDS));
console.log(`deal-card-only: ${n} ok`);
