/** group-satei-data.ts（外へは出ない） */
import assert from "node:assert/strict";
import {
  asTicket, encodeGsList, encodeGsManual, encodeGsNone, encodeGsPick, groupSateiOn, gsEventId,
  parseGsData, receiptOf, ticketIdOf,
} from "../src/lib/group-satei-data";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const G = "C" + "a".repeat(32);
const DEAL = "0123abcd0123456789ab0123456789ab";

t("off なら対象外", () => assert.equal(groupSateiOn(G, { GROUP_SATEI_GROUP_IDS: G }), false));
t("on でもグループが無ければ対象外", () => assert.equal(groupSateiOn(G, { GROUP_SATEI: "1" }), false));
t("on かつ対象グループ", () => assert.equal(groupSateiOn(G, { GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: `x,${G}` }), true));
t("groupId が無ければ対象外", () => assert.equal(groupSateiOn(undefined, { GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G }), false));
t("受付票の ID は同じ発言なら同じ・16字の16進", () => {
  assert.equal(ticketIdOf("123"), ticketIdOf("123"));
  assert.notEqual(ticketIdOf("123"), ticketIdOf("124"));
  assert.match(ticketIdOf("123"), /^[0-9a-f]{16}$/);
});
t("portal の依頼 ID の形に収まる", () => assert.match(gsEventId(ticketIdOf("1")), /^[0-9A-Za-z]{10,64}$/));
t("受付番号", () => assert.equal(receiptOf(7), "G7"));
const tid = ticketIdOf("m1");
t("data の往復", () => {
  assert.deepEqual(parseGsData(encodeGsPick(tid, 2, DEAL)), { op: "gs", tid, ver: 2, dealId: DEAL });
  assert.deepEqual(parseGsData(encodeGsList(tid, 1, 10)), { op: "gl", tid, ver: 1, offset: 10 });
  assert.deepEqual(parseGsData(encodeGsManual(tid, 1)), { op: "gm", tid, ver: 1 });
  assert.deepEqual(parseGsData(encodeGsNone(tid, 1)), { op: "gn", tid, ver: 1 });
});
t("ほかのボタンの data は読まない", () => {
  for (const d of [`v1|sa|${DEAL}`, `v1|qa|abcdefghij|${DEAL}`, "v1|gs|XYZ|1|" + DEAL, `v1|gs|${tid}|0|${DEAL}`, `v1|gl|${tid}|1|501`, `v1|gm|${tid}`, "", "v1|gn|" + tid + "|1|x"])
    assert.equal(parseGsData(d), null, d);
});
t("受付票の検査（本文の欄は持たない）", () => {
  const ok = { no: 3, ver: 1, groupId: G, requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], read: null, state: "asking" };
  assert.equal(asTicket(ok)?.no, 3);
  assert.equal(asTicket(JSON.stringify(ok))?.state, "asking");
  assert.equal(asTicket({ ...ok, state: "x" }), null);
  assert.equal(asTicket(null), null);
});
console.log(`group-satei-data: ${n} ok`);
