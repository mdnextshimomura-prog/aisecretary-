/** group-satei-gate.ts */
import assert from "node:assert/strict";
import { gsEntryAOk, gsEntryBGate, gsMediaRow, looksLikeSateiWords, pickMaterials } from "../src/lib/group-satei-gate";
import type { GsMedia } from "../src/lib/group-satei-data";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const G = "C" + "a".repeat(32);
const SHIMO = "U" + "b".repeat(32);
const BOSS = "U" + "c".repeat(32);
const YAMA = "U" + "d".repeat(32);
const ENV = { GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, TASK_SATEI_USER_IDS: SHIMO };
const NOW = 1_800_000_000_000;
const MIN = 60_000;

t("言葉の絞り込み", () => {
  for (const s of ["査定お願いできますか！", "いくらで売れるか見て", "売却価格を出して", "このあたりの相場は？", "価格を出してください"]) assert.ok(looksLikeSateiWords(s), s);
  for (const s of ["書類関連お願い致します！", "了解です", ""]) assert.ok(!looksLikeSateiWords(s), s);
});
t("言葉の絞り込み：買取金額など（2026-11-28 社長の「買取金額頼む」が査定の入口に入らなかった件）", () => {
  for (const s of [
    "買取金額頼む", "買取価格を教えて", "買取額はどのくらい？", "買い取り金額お願いします", "買い取り 価格を見て", "これいくらで買える？",
    "いくらで買い取れるか", "この物件いくらになる？", "値段を出してほしい", "金額を出してください",
  ]) assert.ok(looksLikeSateiWords(s), s);
  for (const s of ["買取の契約書を作って", "金額の確認お願いします", "値段交渉の件", "買付を出して"]) assert.ok(!looksLikeSateiWords(s), s);
  assert.deepEqual(gsEntryBGate({ groupId: G, senderId: BOSS, text: "買取金額頼む" }, ENV), { ok: true });
  assert.deepEqual(gsEntryBGate({ groupId: G, senderId: BOSS, text: "買取金額頼む" }, {}), { ok: false, reason: "off" });
});
t("入口 A：AI の種類が査定書でなくても、査定の言葉があれば受付票を開く（タスク・0.5以上はそのまま）", () => {
  const p = { groupId: G, senderId: BOSS, isTask: true, requestType: "その他", confidence: 0.9 };
  assert.ok(gsEntryAOk({ ...p, text: "買取金額頼む" }, ENV));
  assert.ok(gsEntryAOk({ ...p, text: "売却の査定お願いします" }, ENV));
  assert.ok(gsEntryAOk({ ...p, requestType: "査定書", text: "これ見て" }, ENV));
  // 言葉が無い・本文を渡さない（前の呼び方）は今までどおり
  assert.ok(!gsEntryAOk({ ...p, text: "書類を送っておいて" }, ENV));
  assert.ok(!gsEntryAOk(p, ENV));
  // しきい値・タスクの判定・本人・スイッチは変えない
  assert.ok(!gsEntryAOk({ ...p, text: "買取金額頼む", confidence: 0.4 }, ENV));
  assert.ok(!gsEntryAOk({ ...p, text: "買取金額頼む", isTask: false }, ENV));
  assert.ok(!gsEntryAOk({ ...p, text: "買取金額頼む", senderId: SHIMO }, ENV));
  assert.ok(!gsEntryAOk({ ...p, text: "買取金額頼む" }, {}));
  assert.ok(!gsEntryAOk({ ...p, text: "買取金額頼む", groupId: "C" + "e".repeat(32) }, ENV));
});
t("入口 B：off・対象外・下村さん本人・言葉なし", () => {
  assert.deepEqual(gsEntryBGate({ groupId: G, senderId: BOSS, text: "査定お願い" }, {}), { ok: false, reason: "off" });
  assert.deepEqual(gsEntryBGate({ groupId: "C" + "e".repeat(32), senderId: BOSS, text: "査定お願い" }, ENV), { ok: false, reason: "off" });
  assert.deepEqual(gsEntryBGate({ groupId: G, senderId: SHIMO, text: "査定お願い" }, ENV), { ok: false, reason: "self" });
  assert.deepEqual(gsEntryBGate({ groupId: G, senderId: BOSS, text: "書類お願い" }, ENV), { ok: false, reason: "words" });
  assert.deepEqual(gsEntryBGate({ groupId: G, text: "査定お願い" }, ENV), { ok: false, reason: "no-sender" });
  assert.deepEqual(gsEntryBGate({ groupId: G, senderId: BOSS, text: "査定お願い" }, ENV), { ok: true });
});
t("入口 A：査定書・0.5以上・下村さん以外・対象グループ", () => {
  const p = { groupId: G, senderId: BOSS, isTask: true, requestType: "査定書", confidence: 0.6 };
  assert.ok(gsEntryAOk(p, ENV));
  assert.ok(!gsEntryAOk({ ...p, requestType: "その他" }, ENV));
  assert.ok(!gsEntryAOk({ ...p, confidence: 0.4 }, ENV));
  assert.ok(!gsEntryAOk({ ...p, isTask: false }, ENV));
  assert.ok(!gsEntryAOk({ ...p, senderId: SHIMO }, ENV));
  assert.ok(!gsEntryAOk(p, {}));
});
t("控えの1行：ファイル名を持たない・PDF かどうかだけ", () => {
  const r = gsMediaRow({ messageId: "f1", groupId: G, senderId: YAMA, type: "file", fileName: "坂本様_登記.pdf", at: NOW });
  assert.deepEqual(r, { messageId: "f1", kind: "pdf", senderId: YAMA, at: NOW });
  assert.ok(!JSON.stringify(r).includes("坂本"));
  assert.equal(gsMediaRow({ messageId: "f2", groupId: G, senderId: YAMA, type: "file", fileName: "x.xlsx", at: NOW })?.kind, "other");
  assert.equal(gsMediaRow({ messageId: "i1", groupId: G, senderId: BOSS, type: "image", at: NOW })?.kind, "image");
  assert.equal(gsMediaRow({ messageId: "i1", senderId: BOSS, type: "image", at: NOW }), null);
  assert.equal(gsMediaRow({ messageId: "i1", groupId: G, type: "image", at: NOW }), null);
});
t("束ねる資料：本人の30分前〜1分後・PDF と画像・other は読まない・8件まで・古い順", () => {
  const media: GsMedia[] = [
    { messageId: "old", kind: "image", senderId: BOSS, at: NOW - 31 * MIN },
    { messageId: "a", kind: "image", senderId: BOSS, at: NOW - 5 * MIN },
    { messageId: "x", kind: "other", senderId: BOSS, at: NOW - 4 * MIN },
    { messageId: "y", kind: "image", senderId: YAMA, at: NOW - 3 * MIN },
    { messageId: "b", kind: "pdf", senderId: BOSS, at: NOW + 30_000 },
    { messageId: "late", kind: "image", senderId: BOSS, at: NOW + 2 * MIN },
  ];
  assert.deepEqual(pickMaterials(media, { requesterId: BOSS, at: NOW, triggerMsgIds: ["m1"] }), ["a", "b"]);
  const many: GsMedia[] = Array.from({ length: 10 }, (_, i) => ({ messageId: `i${i}`, kind: "image", senderId: BOSS, at: NOW - (10 - i) * MIN }));
  assert.deepEqual(pickMaterials(many, { requesterId: BOSS, at: NOW, triggerMsgIds: ["m1"] }), ["i2", "i3", "i4", "i5", "i6", "i7", "i8", "i9"]);
});
t("束ねる資料：発言が引用した画像・発言を引用した資料は、別の人でも足す", () => {
  const media: GsMedia[] = [
    { messageId: "q", kind: "image", senderId: YAMA, at: NOW - 60 * MIN },
    { messageId: "r", kind: "pdf", senderId: YAMA, at: NOW - MIN, quoted: "m1" },
  ];
  assert.deepEqual(pickMaterials(media, { requesterId: BOSS, at: NOW, triggerMsgIds: ["m1"], quotedMessageId: "q" }), ["q", "r"]);
});
t("束ねる資料：引用した資料は8件の上限でも残る", () => {
  const media: GsMedia[] = [
    { messageId: "q", kind: "image", senderId: YAMA, at: NOW - 120 * MIN },
    ...Array.from({ length: 9 }, (_, i): GsMedia => ({ messageId: `i${i}`, kind: "image", senderId: BOSS, at: NOW - (9 - i) * MIN })),
  ];
  const r = pickMaterials(media, { requesterId: BOSS, at: NOW, triggerMsgIds: ["m1"], quotedMessageId: "q" });
  assert.equal(r.length, 8);
  assert.deepEqual(r, ["q", "i2", "i3", "i4", "i5", "i6", "i7", "i8"]);
});
t("入口 B：下村さんの宛先が無ければ no-target", () => {
  assert.deepEqual(gsEntryBGate({ groupId: G, senderId: BOSS, text: "査定お願い" }, { GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G }), { ok: false, reason: "no-target" });
});
console.log(`group-satei-gate: ${n} ok`);
