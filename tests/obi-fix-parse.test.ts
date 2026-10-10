/**
 * 「番号で直す」の返事の読み取り（設計 2026-10-10 の E12「訂正の形（文法）」）。
 * 本文の全体が文法に合ったときだけ読む。合わなければ null（今までの流れへ）。
 */
import { parseFixBody, type FixBody } from "../src/lib/obi/fix-parse";
import { parseJobCommand } from "../src/lib/obi/parse";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};
const same = (got: FixBody | null, want: FixBody | null) => JSON.stringify(got) === JSON.stringify(want);
const fx = (no: number | null, code: number, page: number | null, turn = ""): FixBody =>
  ({ no, code, page, turn }) as FixBody;

const accepts: Array<[string, FixBody]> = [
  // 設計の「受ける例」
  ["3ページ 2", fx(null, 2, 3)],
  ["３ページ　２", fx(null, 2, 3)],
  ["2 3ページ", fx(null, 2, 3)],
  ["#J12 2", fx(12, 2, null)],
  ["＃Ｊ１２　３ページ ２", fx(12, 2, 3)],
  ["3ページ 3右", fx(null, 3, 3, "right")],
  ["3ページ 3左", fx(null, 3, 3, "left")],
  ["#J12 0", fx(12, 0, null)],
  ["0", fx(null, 0, null)],
  // 文法の枝
  ["2", fx(null, 2, null)],
  ["3ページの2番", fx(null, 2, 3)],
  ["3ページ2", fx(null, 2, 3)],
  ["3頁 1", fx(null, 1, 3)],
  ["3ページ目 1", fx(null, 1, 3)],
  ["3P 1", fx(null, 1, 3)],
  ["3 ページ 1", fx(null, 1, 3)],
  ["p3 4", fx(null, 4, 3)],
  ["Ｐ３ ４", fx(null, 4, 3)],
  ["4 p3", fx(null, 4, 3)], // 「4ページ目の3番」ではない（P・p は数字と隣り合わせのときだけページの印）
  ["4p 3", fx(null, 3, 4)],
  ["3 P2", fx(null, 3, 2)], // 「3 P」をページと読まない（P2 が2ページ・番号は 3。Z1）
  ["#J12 3 P2", fx(12, 3, 2)],
  ["4", fx(null, 4, null)],
  ["5番", fx(null, 5, null)],
  ["0番", fx(null, 0, null)],
  ["3", fx(null, 3, null)],
  ["3右", fx(null, 3, null, "right")],
  ["3左番", fx(null, 3, null, "left")],
  ["3ページ 3", fx(null, 3, 3)],
  ["3 3ページ", fx(null, 3, 3)],
  ["  3ページ 2  ", fx(null, 2, 3)],
  ["3ページ\n2", fx(null, 2, 3)],
  ["# j 000012 2", fx(12, 2, null)],
  ["#J123456 2", fx(123456, 2, null)],
  ["120ページ 1", fx(null, 1, 120)],
  ["999ページ 1", fx(null, 1, 999)], // 範囲（1〜120）はここでは見ない（返事を出す側で見る）
  ["0ページ 1", fx(null, 1, 0)],
];
for (const [input, want] of accepts) {
  const got = parseFixBody(input);
  ok(`読む：${JSON.stringify(input)}`, same(got, want), JSON.stringify(got));
}

const rejects = [
  "",
  "   ",
  "直して",
  "2番直して",
  "2です",
  "3ページ", // 番号なし
  "3ページ 1 2", // 1通に複数
  "2と3",
  "2 3",
  "6",
  "3ページ 6",
  "12",
  "3ページ 12",
  "3ページ 0", // 0 はページを付けない形だけ
  "0 3ページ",
  "2右", // 右・左は 3 だけ
  "3上",
  "9", // 対応の選び直し（差し戻しの選択肢の設計 2026-10-11）は、訂正の文法では読まない（まだ使わない。今までの流れへ）
  "#J12 9",
  "#J12 OK", // 既存の承認の形（こちらでは読まない）
  "#J12 直す",
  "#J12",
  "#J122", // 数字の並びは途中で切らない（#J12 と 2 に分けない）
  "#J1234567 2", // 受付番号は6桁まで
  "p32", // P3 と 2 に分けない
  "3 p 1", // P・p の前後に空白があるとページの印にしない
  "1234ページ 2", // ページは3桁まで
  "#12 2", // J が無い
  "J12 2",
  "23ページ", // 2 と 3ページ に分けるには空白が要る
  "３ページ　２　お願いします",
];
for (const input of rejects) {
  const got = parseFixBody(input);
  ok(`読まない：${JSON.stringify(input)}`, got === null, JSON.stringify(got));
}

// 長さ：全角を半角にし、前後の空白を除いた後で30文字まで
const pad = (n: number) => `#J12${" ".repeat(n)}3ページ 2`;
ok("ちょうど30文字は読む", pad(20).length === 30 && same(parseFixBody(pad(20)), fx(12, 2, 3)));
ok("31文字は読まない", pad(21).length === 31 && parseFixBody(pad(21)) === null);
ok("前後の空白は長さに数えない", same(parseFixBody(`${" ".repeat(20)}${pad(20)}${" ".repeat(20)}`), fx(12, 2, 3)));
ok("文字でないもの（null・undefined）は読まない", parseFixBody(null) === null && parseFixBody(undefined) === null);

// 既存の読み取り（parseJobCommand）は、訂正の形を依頼・承認として読まない
ok("「3ページ 2」は依頼でも承認でもない", parseJobCommand("3ページ 2") === null);
ok("「#J12 OK」は今までどおり承認", JSON.stringify(parseJobCommand("#J12 OK")) === JSON.stringify({ action: "review", no: 12, verdict: "ok" }));
ok("「#J12 直す」は今までどおり差し戻し", JSON.stringify(parseJobCommand("#J12 直す")) === JSON.stringify({ action: "review", no: 12, verdict: "fix" }));

console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
process.exit(fail ? 1 : 0);
