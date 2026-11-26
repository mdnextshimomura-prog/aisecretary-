/** 段2a：「何の依頼？」の8つ（group-satei-data.ts・group-satei-card.ts） */
import assert from "node:assert/strict";
import {
  asTicket, encodeGsKind, GS_REQ_KINDS, groupSateiStage2On, gsReqLabel, isGsReqKind, ticketIdOf, type GsTicket,
} from "../src/lib/group-satei-data";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const tid = ticketIdOf("m1");
const base: GsTicket = { no: 7, ver: 1, groupId: "C" + "a".repeat(32), requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], read: null, state: "asking" };

t("スイッチ：GROUP_SATEI と GROUP_SATEI_STAGE2 の両方が 1 のときだけ", () => {
  assert.equal(groupSateiStage2On({ GROUP_SATEI: "1", GROUP_SATEI_STAGE2: "1" }), true);
  assert.equal(groupSateiStage2On({ GROUP_SATEI: "1" }), false);
  assert.equal(groupSateiStage2On({ GROUP_SATEI_STAGE2: "1" }), false);
  assert.equal(groupSateiStage2On({ GROUP_SATEI: "1", GROUP_SATEI_STAGE2: "true" }), false);
});
t("8つの符号と言葉（設計 3 のとおり）", () => {
  assert.deepEqual(GS_REQ_KINDS.map((k) => k.code), ["satei", "doc", "check", "sched", "survey", "money", "mail", "other"]);
  assert.deepEqual(GS_REQ_KINDS.map((k) => k.label), ["査定", "資料を送る", "書類の作成・チェック", "日程・内見", "物件調査・謄本", "振込・お金", "メール・電話", "その他"]);
  assert.equal(gsReqLabel("survey"), "物件調査・謄本");
  assert.equal(isGsReqKind("doc"), true);
  assert.equal(isGsReqKind("DOC"), false);
  assert.equal(isGsReqKind(1), false);
});
t("data の形：v1|gk|<受付票>|<版>|<符号>", () => {
  assert.equal(encodeGsKind(tid, 3, "money"), `v1|gk|${tid}|3|money`);
});
t("受付票：requestKind は無い・知っている符号なら読める、知らない符号は壊れた票として読まない", () => {
  assert.ok(asTicket(base));
  assert.equal(asTicket({ ...base, requestKind: "doc" })?.requestKind, "doc");
  assert.equal(asTicket({ ...base, requestKind: "x" }), null);
});
console.log(`group-satei-kind: ${n} ok`);
