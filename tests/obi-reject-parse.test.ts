/**
 * 差し戻しの対応の選択のうち、「言葉」の返事の読み取り（parseChoiceWord。設計 2026-10-11 の E12）。
 * 共通の表 tests/fixtures/job-command-cases.json は変えていないことも、ここで固定する。
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { parseChoiceWord } from "../src/lib/obi/reject-parse";
import { parseFixBody } from "../src/lib/obi/fix-parse";
import { parseJobCommand } from "../src/lib/obi/parse";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

// ── #J なし（引用つきのときだけ使う形） ──
for (const text of [
  "OK",
  "ok",
  "Ok",
  "ＯＫ",
  "ｏｋ",
  "オーケー",
  " OK ",
  "　OK　",
]) {
  ok(
    `「${text}」は ok（#J なし）`,
    same(parseChoiceWord(text), { no: null, word: "ok" }),
    JSON.stringify(parseChoiceWord(text)),
  );
}
for (const text of ["9", "９", "9番", " 9 "]) {
  ok(
    `「${text}」は rechoose（#J なし）`,
    same(parseChoiceWord(text), { no: null, word: "rechoose" }),
    JSON.stringify(parseChoiceWord(text)),
  );
}

// ── #J つき（共通の文法 parseJobCommand の結果を使う） ──
for (const text of [
  "#J4 OK",
  "#j4 ok",
  "＃Ｊ４　ＯＫ",
  "#J4 オーケー",
  "#J4 完成",
  "#J4OK",
]) {
  ok(
    `「${text}」は ok（#J4）`,
    same(parseChoiceWord(text), { no: 4, word: "ok" }),
    JSON.stringify(parseChoiceWord(text)),
  );
}
for (const text of ["#J4 9", "#J4 9番", "#j4 9", "＃Ｊ４　９"]) {
  ok(
    `「${text}」は rechoose（#J4）`,
    same(parseChoiceWord(text), { no: 4, word: "rechoose" }),
    JSON.stringify(parseChoiceWord(text)),
  );
}
ok(
  "「#J123456 OK」は受付番号 123456",
  same(parseChoiceWord("#J123456 OK"), { no: 123456, word: "ok" }),
);

// ── 読まない（null＝今までの流れへ） ──
for (const text of [
  "",
  "   ",
  "OKです",
  "OK！",
  "OK 9",
  "了解",
  "はい",
  "おk",
  "オッケー",
  "99",
  "9ページ",
  "9 9",
  "#J4 直す",
  "#J4 差し戻し",
  "#J4 OK です",
  "#J4",
  "#J4 99",
  "#J OK",
  "#J1234567 OK",
  "J4 OK",
  "OK #J4",
  "#J4 " + " ".repeat(30) + "OK",
]) {
  ok(
    `「${text}」は読まない`,
    parseChoiceWord(text) === null,
    JSON.stringify(parseChoiceWord(text)),
  );
}
// 番号の返事（1〜4・0）は、ここでは読まない（今までどおり parseFixBody が読む）
for (const text of [
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "#J4 2",
  "#J4 0",
  "3ページ 2",
]) {
  ok(
    `「${text}」は読まない（番号は parseFixBody の分）`,
    parseChoiceWord(text) === null && parseFixBody(text) !== null,
  );
}
// 言葉の返事は、parseFixBody では読めない（2つの読み取りが同じ本文を取り合わない）
for (const text of ["OK", "オーケー", "9", "#J4 OK", "#J4 9"]) {
  ok(
    `「${text}」は parseFixBody では読めない`,
    parseFixBody(text) === null && parseChoiceWord(text) !== null,
  );
}
ok(
  "null・undefined は読まない",
  parseChoiceWord(null) === null && parseChoiceWord(undefined) === null,
);

// ── 共通の文法・共通の表は変えていない ──
ok(
  "parseJobCommand の「#J4 OK」は今までどおり",
  same(parseJobCommand("#J4 OK"), { action: "review", no: 4, verdict: "ok" }),
);
ok(
  "parseJobCommand の「#J4 9」は今までどおり",
  same(parseJobCommand("#J4 9"), { action: "rechoose", no: 4 }),
);
ok(
  "parseJobCommand は #J なしの「OK」「9」を読まない（共通の表に足していない）",
  parseJobCommand("OK") === null && parseJobCommand("9") === null,
);
const fixture = readFileSync(
  join(__dirname, "fixtures", "job-command-cases.json"),
);
ok(
  "共通の表の sha256 は変わっていない（88件のまま）",
  createHash("sha256").update(fixture).digest("hex") ===
    "5a5c76d83ec5f2cfb5763e4e3f1b13892c3ae1c509698572fc37651fd96bb31c" &&
    (JSON.parse(fixture.toString("utf8")) as { cases: unknown[] }).cases
      .length === 88,
);

console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
process.exit(fail ? 1 : 0);
