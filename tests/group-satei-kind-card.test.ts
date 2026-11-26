/** 段2a：カードの上の段（8つ）と［査定］のあとのカード（group-satei-card.ts） */
import assert from "node:assert/strict";
import { parseGsData, ticketIdOf } from "../src/lib/group-satei-data";
import { gsCard, gsKindOrder, gsSateiNextCard, GS_GUESS_COLOR, msgGsKindRecorded, msgGsKindSatei } from "../src/lib/group-satei-card";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const tid = ticketIdOf("m1");
const D1 = { id: "0123abcd0123456789ab0123456789ab", name: "テスト町1丁目", phase: "査定" };
const allButtons = (c: any): any[] => {
  const out: any[] = [];
  const walk = (x: any) => {
    if (!x || typeof x !== "object") return;
    if (x.type === "button") out.push(x);
    for (const v of Object.values(x)) if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") walk(v);
  };
  walk(c);
  return out;
};
t("段1のカード（opt なし）は今と同じ：上の段は無く、本文は案内1行だけ", () => {
  const c = gsCard(tid, 1, [{ deal: D1, kind: "戸建" }], false, 7);
  assert.equal((c.contents as any).body.contents.length, 1);
  assert.ok(!JSON.stringify(c).includes("v1|gk|"));
  assert.equal(JSON.stringify(c), JSON.stringify(gsCard(tid, 1, [{ deal: D1, kind: "戸建" }], false, 7, undefined)));
  assert.equal(JSON.stringify(c), JSON.stringify(gsCard(tid, 1, [{ deal: D1, kind: "戸建" }], false, 7, {})));
});
t("段2のカード：上の段に8つ（見立てが先頭・色つき）、下の段は段1と同じ", () => {
  const one = gsCard(tid, 1, [{ deal: D1, kind: "戸建" }], false, 7);
  const two = gsCard(tid, 1, [{ deal: D1, kind: "戸建" }], false, 7, { guess: "satei" });
  assert.deepEqual((two.contents as any).footer, (one.contents as any).footer);
  const kinds = allButtons((two.contents as any).body);
  assert.equal(kinds.length, 8);
  assert.equal(kinds[0].action.data, `v1|gk|${tid}|1|satei`);
  assert.equal(kinds[0].style, "primary");
  assert.equal(kinds[0].color, GS_GUESS_COLOR);
  assert.ok(kinds.slice(1).every((b) => b.style === "secondary" && b.color === undefined));
  assert.equal(kinds[1].action.displayText, "（ボタン）【受付 G7】資料を送る");
  assert.ok(JSON.stringify(two).length < 30_000);
});
t("見立てが別の種類なら、それが先頭（残りは設計の順）", () => {
  assert.deepEqual(gsKindOrder("money").map((k) => k.code), ["money", "satei", "doc", "check", "sched", "survey", "mail", "other"]);
});
t("［査定］のあとのカード：一覧から選ぶ・案件がまだ無い", () => {
  const c = gsSateiNextCard(tid, 2, 7);
  const ops = allButtons(c.contents).map((b) => parseGsData(b.action.data)?.op);
  assert.deepEqual(ops, ["gl", "gm"]);
  assert.match(allButtons(c.contents)[0].action.displayText, /【受付 G7】一覧から選ぶ/);
});
t("返事の文", () => {
  assert.equal(msgGsKindRecorded(7, "振込・お金"), "振込・お金として控えました。中身は手作業でお願いします（受付 G7）");
  assert.equal(msgGsKindSatei(7), "査定で進めます。どの案件か選んでください（受付 G7）");
});
console.log(`group-satei-kind-card: ${n} ok`);
