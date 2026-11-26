/** 段2d：受付票の新しい状態・山口さんの ID・［いいよ］［直す］の data（group-satei-data.ts。純粋） */
import assert from "node:assert/strict";
import {
  asTicket, encodeGsFix, encodeGsYes, groupSateiPrepOn, gsCaseStaffId, parseGsData, ticketIdOf, type GsTicket,
} from "../src/lib/group-satei-data";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const STAFF = "U" + "d".repeat(32);
const ON = { GROUP_SATEI: "1", GROUP_SATEI_STAGE2: "1", GROUP_SATEI_CASE_STAFF_ID: STAFF };
const tid = ticketIdOf("m1");
const base: GsTicket = { no: 7, ver: 1, groupId: "C" + "a".repeat(32), requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], read: null, state: "asking" };

t("山口さんの ID：U＋32桁の16進だけ。前後の空白は落とす", () => {
  assert.equal(gsCaseStaffId({ GROUP_SATEI_CASE_STAFF_ID: ` ${STAFF} ` }), STAFF);
  for (const v of [undefined, "", "U123", "u" + "d".repeat(32), STAFF + "x"]) assert.equal(gsCaseStaffId({ GROUP_SATEI_CASE_STAFF_ID: v }), null, String(v));
});
t("2d が動くのは STAGE2 と山口さんの ID がそろったときだけ", () => {
  assert.equal(groupSateiPrepOn(ON), true);
  assert.equal(groupSateiPrepOn({ ...ON, GROUP_SATEI_STAGE2: "0" }), false);
  assert.equal(groupSateiPrepOn({ ...ON, GROUP_SATEI: "0" }), false);
  assert.equal(groupSateiPrepOn({ ...ON, GROUP_SATEI_CASE_STAFF_ID: "" }), false);
});
t("data：gy・gf は版（rev 1〜9）つき", () => {
  assert.equal(encodeGsYes(tid, 2, 1), `v1|gy|${tid}|2|1`);
  assert.equal(encodeGsFix(tid, 2, 3), `v1|gf|${tid}|2|3`);
  assert.deepEqual(parseGsData(encodeGsYes(tid, 2, 1)), { op: "gy", tid, ver: 2, rev: 1 });
  assert.deepEqual(parseGsData(encodeGsFix(tid, 2, 3)), { op: "gf", tid, ver: 2, rev: 3 });
  for (const bad of [`v1|gy|${tid}|2`, `v1|gy|${tid}|2|0`, `v1|gy|${tid}|2|10`, `v1|gf|${tid}|2|x`, `v1|gy|${tid}|2|1|x`]) assert.equal(parseGsData(bad), null, bad);
});
t("受付票：新しい3つの状態を読む。prep の形が違えば読まない", () => {
  for (const state of ["gathering", "proposing", "waiting-cases"] as const) assert.equal(asTicket({ ...base, state })?.state, state);
  const prep = { kind: "マンション", rev: 1, lines: ["成約：…"], fixes: 0, sentRev: 1, tries: 1, groupPushes: 0 };
  assert.deepEqual(asTicket({ ...base, state: "proposing", prep })?.prep, prep);
  assert.equal(asTicket({ ...base, state: "proposing", prep: { ...prep, lines: [1] } }), null);
  assert.equal(asTicket({ ...base, state: "proposing", prep: { ...prep, kind: "ビル" } }), null);
  assert.equal(asTicket({ ...base, state: "waiting" }), null);
});
console.log(`${n} passed`);
