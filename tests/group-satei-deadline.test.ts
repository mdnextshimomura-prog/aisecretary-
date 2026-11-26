/** group-satei-deadline.ts（純粋関数。時計は使わない） */
import assert from "node:assert/strict";
import { gsCaseDeadline, gsDeadlineLabel } from "../src/lib/group-satei-deadline";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
/** JST の壁時計の時刻 → epoch ミリ秒 */
const jst = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi);

// 2026-11-26 は木曜。12/1 が火曜、12/2 が水曜
t("木 10:00 → その日の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 11, 26, 10)), jst(2026, 11, 26, 18)));
t("木 16:59 → その日の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 11, 26, 16, 59)), jst(2026, 11, 26, 18)));
t("木 17:00 ちょうど → 次の日（金）の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 11, 26, 17)), jst(2026, 11, 27, 18)));
t("木 23:59 → 金の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 11, 26, 23, 59)), jst(2026, 11, 27, 18)));
t("金 0:30（UTC では木）→ 金の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 11, 27, 0, 30)), jst(2026, 11, 27, 18)));
t("土 17:30 → 日の 18時（土日は営業日）", () => assert.equal(gsCaseDeadline(jst(2026, 11, 28, 17, 30)), jst(2026, 11, 29, 18)));
t("日 9:00 → その日の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 11, 29, 9)), jst(2026, 11, 29, 18)));
t("月 17:00 → 火・水を飛ばして木の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 11, 30, 17)), jst(2026, 12, 3, 18)));
t("火 8:00（休み）→ 木の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 12, 1, 8)), jst(2026, 12, 3, 18)));
t("水 16:00（休み）→ 木の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 12, 2, 16)), jst(2026, 12, 3, 18)));
t("表示の形", () => {
  assert.equal(gsDeadlineLabel(jst(2026, 12, 3, 18)), "12/3（木）18時");
  assert.equal(gsDeadlineLabel(jst(2026, 11, 29, 18)), "11/29（日）18時");
});
t("数でない時刻は例外", () => assert.throws(() => gsCaseDeadline(Number.NaN), RangeError));
t("2週間を15分おき：いつも未来・18時・火水でない・押してから4日未満", () => {
  for (let at = jst(2026, 11, 23, 0); at < jst(2026, 12, 7, 0); at += 15 * 60_000) {
    const d = gsCaseDeadline(at);
    const w = new Date(d + 9 * 3600_000);
    assert.ok(d > at, String(at));
    assert.equal(w.getUTCHours(), 18);
    assert.equal(w.getUTCMinutes(), 0);
    assert.ok(![2, 3].includes(w.getUTCDay()), String(at));
    assert.ok(d - at < 4 * 24 * 3600_000, String(at));
  }
});
console.log(`group-satei-deadline: ${n} ok`);
