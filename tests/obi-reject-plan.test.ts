/**
 * 差し戻しの対応の選択：読んだ返事と resolve の答え（kind・phase）から何をするかを決める計算
 * （reject-plan.ts。設計 2026-10-11 の E12・約束の「読み方」）。
 */
import { parseFixBody } from "../src/lib/obi/fix-parse";
import type { FixResolved } from "../src/lib/obi/portal";
import {
  planNumberedNumber,
  planNumberedWord,
  planQuotedNumber,
  planQuotedWord,
} from "../src/lib/obi/reject-plan";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const SHA = "1".repeat(64);
const resolved = (over: Partial<FixResolved> = {}): FixResolved => ({
  no: 4,
  artifactSha256: "",
  current: true,
  pageCount: 0,
  fixable: "unavailable",
  closable: "unavailable",
  kind: "",
  phase: "fix",
  rejectRound: 0,
  choiceGen: 41,
  messageGen: null,
  choices: [],
  ...over,
});
const body = (text: string) => parseFixBody(text)!;

// ══ 引用つきの番号 ══
// 選択肢の知らせ（reject）への引用：番号1つ（1〜4）だけが選択。世代は引用先の知らせのもの（今の世代ではない）
const REJECT = resolved({ kind: "reject", phase: "choose", messageGen: 40, choiceGen: 41, choices: [1, 3, 4] });
for (const [text, choice] of [["1", 1], ["2", 2], ["3", 3], ["4", 4], ["２", 2], ["2番", 2]] as Array<[string, number]>) {
  const d = planQuotedNumber(body(text), REJECT);
  ok(
    `reject への引用の「${text}」：choose ${choice}（expectGen は引用先の世代・sha は付けない）`,
    same(d, { kind: "choice", plan: { action: "choose", choice, expectGen: 40, expectSha256: "" } }),
    JSON.stringify(d),
  );
}
ok(
  "reject への引用の「2」：出していない番号でも choose にする（決めるのは portal。CHOICE_NOT_OFFERED）",
  planQuotedNumber(body("2"), REJECT).kind === "choice",
);
for (const text of ["0", "5", "3ページ 2", "2 3ページ", "3右", "3左", "P2 1"]) {
  const d = planQuotedNumber(body(text), REJECT);
  ok(`reject への引用の「${text}」：選択として扱わない（今までの流れへ）`, d.kind === "rest" && d.reason === "reject-not-choice", JSON.stringify(d));
}
ok(
  "reject への引用で世代 0：0 のまま渡す",
  same(planQuotedNumber(body("1"), resolved({ kind: "reject", phase: "choose", messageGen: 0 })), {
    kind: "choice",
    plan: { action: "choose", choice: 1, expectGen: 0, expectSha256: "" },
  }),
);
ok(
  "reject への引用なのに、引用先の世代が無い：選択として扱わない",
  same(planQuotedNumber(body("1"), resolved({ kind: "reject", phase: "choose", messageGen: null })), { kind: "rest", reason: "no-message-gen" }),
);
ok(
  "reject への引用は、依頼の状態（phase）を見ない（古い知らせかどうかは portal が CHOICE_STALE・CHOICE_UNAVAILABLE で答える）",
  planQuotedNumber(body("1"), resolved({ kind: "reject", phase: "review", messageGen: 40 })).kind === "choice",
);

// 確認の知らせ（review）への引用：0 は approve、1〜5 は「番号で直す」へ
const REVIEW = resolved({ kind: "review", phase: "review", artifactSha256: SHA, messageGen: 41, choiceGen: 41 });
ok(
  "review への引用の「0」：approve（expectGen は引用先の世代・sha はその知らせの成果物）",
  same(planQuotedNumber(body("0"), REVIEW), { kind: "choice", plan: { action: "approve", choice: 0, expectGen: 41, expectSha256: SHA } }),
  JSON.stringify(planQuotedNumber(body("0"), REVIEW)),
);
for (const text of ["1", "2", "3", "4", "5", "3ページ 2", "3右"]) {
  ok(`review への引用の「${text}」：「番号で直す」へ（特別な枝を作らない。T1）`, same(planQuotedNumber(body(text), REVIEW), { kind: "fix" }));
}
ok(
  "review への引用の「0」で成果物の sha256 が無い：選択として扱わない",
  same(planQuotedNumber(body("0"), { ...REVIEW, artifactSha256: "" }), { kind: "rest", reason: "no-artifact" }),
);
ok(
  "review への引用の「0」で引用先の世代が無い：選択として扱わない",
  same(planQuotedNumber(body("0"), { ...REVIEW, messageGen: null }), { kind: "rest", reason: "no-message-gen" }),
);

// 完成の知らせ・項目なし：今までどおり「番号で直す」。知らない種類：今までの流れへ
for (const kind of ["completion", ""]) {
  for (const text of ["0", "2", "3ページ 2"]) {
    ok(`kind "${kind}" への引用の「${text}」：今までどおり「番号で直す」`, same(planQuotedNumber(body(text), resolved({ kind, phase: "choose", messageGen: 40 })), { kind: "fix" }));
  }
}
ok("知らない種類への引用：今までの流れへ", same(planQuotedNumber(body("2"), resolved({ kind: "something-new", messageGen: 40 })), { kind: "rest", reason: "notice-kind" }));

// ══ 引用つきの言葉（OK・9） ══
ok(
  "review への引用の「OK」：approve",
  same(planQuotedWord("ok", REVIEW), { kind: "choice", plan: { action: "approve", choice: 0, expectGen: 41, expectSha256: SHA } }),
);
ok(
  "review への引用の「9」：rechoose",
  same(planQuotedWord("rechoose", REVIEW), { kind: "choice", plan: { action: "rechoose", choice: 0, expectGen: 41, expectSha256: SHA } }),
);
ok(
  "古い確認の知らせへの「OK」：引用先の世代・成果物のまま渡す（portal が CHOICE_STALE で答える）",
  same(planQuotedWord("ok", { ...REVIEW, messageGen: 39, choiceGen: 41, current: false }), {
    kind: "choice",
    plan: { action: "approve", choice: 0, expectGen: 39, expectSha256: SHA },
  }),
);
for (const kind of ["reject", "completion", "", "something-new"]) {
  for (const word of ["ok", "rechoose"] as const) {
    const d = planQuotedWord(word, resolved({ kind, phase: "review", artifactSha256: SHA, messageGen: 41 }));
    ok(`kind "${kind}" への引用の ${word}：扱わない（返事をせず今までの流れへ）`, d.kind === "rest" && d.reason === "word-not-review", JSON.stringify(d));
  }
}
ok("review への引用の「OK」で世代が無い：扱わない", same(planQuotedWord("ok", { ...REVIEW, messageGen: null }), { kind: "rest", reason: "no-message-gen" }));
ok("review への引用の「9」で sha256 が無い：扱わない", same(planQuotedWord("rechoose", { ...REVIEW, artifactSha256: "" }), { kind: "rest", reason: "no-artifact" }));

// ══ #J つきの番号（「#J4 2」） ══
const CHOOSING = resolved({ phase: "choose", choiceGen: 41, messageGen: null, choices: [1, 3, 4] });
for (const [text, choice] of [["#J4 1", 1], ["#J4 2", 2], ["#J4 3", 3], ["#J4 4", 4]] as Array<[string, number]>) {
  ok(
    `phase choose の「${text}」：choose ${choice}（expectGen は今の世代）`,
    same(planNumberedNumber(body(text), CHOOSING), { action: "choose", choice, expectGen: 41, expectSha256: "" }),
    JSON.stringify(planNumberedNumber(body(text), CHOOSING)),
  );
}
for (const text of ["#J4 0", "#J4 5", "#J4 3ページ 2", "#J4 3右"]) {
  ok(`phase choose の「${text}」：選択ではない（今までどおり「番号で直す」）`, planNumberedNumber(body(text), CHOOSING) === null);
}
for (const phase of ["fix", "review", "something-new"]) {
  ok(`phase ${phase} の「#J4 2」：選択ではない（今までどおり「番号で直す」）`, planNumberedNumber(body("#J4 2"), resolved({ phase, artifactSha256: SHA })) === null);
}

// ══ #J つきの言葉（「#J4 OK」「#J4 9」） ══
const REVIEWING = resolved({ phase: "review", artifactSha256: SHA, choiceGen: 41, messageGen: null });
ok(
  "phase review の「#J4 OK」：approve（expectGen は今の世代・sha は今の成果物）",
  same(planNumberedWord("ok", REVIEWING), { kind: "choice", plan: { action: "approve", choice: 0, expectGen: 41, expectSha256: SHA } }),
);
ok(
  "phase review の「#J4 9」：rechoose",
  same(planNumberedWord("rechoose", REVIEWING), { kind: "choice", plan: { action: "rechoose", choice: 0, expectGen: 41, expectSha256: SHA } }),
);
for (const phase of ["fix", "choose", "something-new"]) {
  ok(
    `phase ${phase} の「#J4 OK」：扱わない（今までの流れへ。グループの「#J12 OK」は今までどおり）`,
    same(planNumberedWord("ok", resolved({ phase, artifactSha256: SHA })), { kind: "rest", reason: "ok-not-review" }),
  );
}
// 確認待ちでない「#J4 9」：phase が fix で完成品があるときだけ、/reject（rechoose）に渡して portal に断らせる（V7）。
// 選択肢のスイッチが off のあいだ phase は常に fix なので、「受付を止めている」（CHOICE_DISABLED）を見分けられるのは portal だけ
ok(
  "phase fix・完成品ありの「#J4 9」：rechoose を /reject に渡す（世代・成果物は今のもの。断り方は portal が決める）",
  same(planNumberedWord("rechoose", resolved({ phase: "fix", artifactSha256: SHA, choiceGen: 41 })), {
    kind: "choice",
    plan: { action: "rechoose", choice: 0, expectGen: 41, expectSha256: SHA },
  }),
);
ok(
  "phase fix・項目の無い portal（世代が 0）の「#J4 9」：同じ（expectGen は 0）",
  same(planNumberedWord("rechoose", resolved({ phase: "fix", artifactSha256: SHA, choiceGen: 0 })), {
    kind: "choice",
    plan: { action: "rechoose", choice: 0, expectGen: 0, expectSha256: SHA },
  }),
);
ok(
  "phase fix・完成品が無い「#J4 9」：/reject の本文を作れないので、断りの文だけ（いまその操作ができない状態です）",
  same(planNumberedWord("rechoose", resolved({ phase: "fix", artifactSha256: "" })), { kind: "unavailable" }),
);
for (const phase of ["choose", "something-new"]) {
  for (const artifactSha256 of [SHA, ""]) {
    ok(
      `phase ${phase}（完成品${artifactSha256 ? "あり" : "なし"}）の「#J4 9」：断りの文だけ（portal には渡さない）`,
      same(planNumberedWord("rechoose", resolved({ phase, artifactSha256 })), { kind: "unavailable" }),
    );
  }
}
ok("phase review なのに sha256 が無い：扱わない", same(planNumberedWord("ok", { ...REVIEWING, artifactSha256: "" }), { kind: "rest", reason: "no-artifact" }));

console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
process.exit(fail ? 1 : 0);
