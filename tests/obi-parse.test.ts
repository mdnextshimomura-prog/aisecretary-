/**
 * 依頼文の読み取りが line-secretary の parse.js と同じ結果になるか（共通の表で確かめる）。
 * 表：tests/fixtures/job-command-cases.json（line-secretary 側にも同じものを置く）
 */
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseJobCommand } from "../src/lib/obi/parse";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

const table = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures", "job-command-cases.json"), "utf8")
) as { cases: Array<{ input: string; expected: unknown }> };

ok("共通の表が読める（30件以上）", table.cases.length >= 30, `件数=${table.cases.length}`);

// 表は line-secretary（test/fixtures/job-command-cases.json）と同じバイト。片方だけ直すと、ここで落ちる。
// 直すときは両方のリポジトリの表と、両方のテストのこの値を同時に直す（約束 2026-10-11-obi-fix-contract.md）
const TABLE_SHA256 = "5a5c76d83ec5f2cfb5763e4e3f1b13892c3ae1c509698572fc37651fd96bb31c";
const tableSha = createHash("sha256")
  .update(readFileSync(path.join(__dirname, "fixtures", "job-command-cases.json")))
  .digest("hex");
ok("共通の表のバイトが約束の sha256 と同じ", tableSha === TABLE_SHA256, tableSha);
ok(
  "共通の表に「番号で直す」の行がある（受ける形・受けない形）",
  table.cases.some((c) => c.input === "#J12 3ページ 2" && c.expected !== null) &&
    table.cases.some((c) => c.input === "#J12 3ページ 0" && c.expected === null)
);
ok(
  "共通の表に「対応の選び直し（#J12 9）」の行がある（文法だけ先に入れてある。受ける形・受けない形）",
  table.cases.some((c) => c.input === "#J12 9" && JSON.stringify(c.expected) === JSON.stringify({ action: "rechoose", no: 12 })) &&
    table.cases.some((c) => c.input === "#J12 3ページ 9" && c.expected === null)
);
for (const c of table.cases) {
  const got = parseJobCommand(c.input);
  let same = true;
  try {
    assert.deepStrictEqual(got, c.expected);
  } catch {
    same = false;
  }
  ok(`parseJobCommand(${JSON.stringify(c.input)})`, same, same ? "" : `got=${JSON.stringify(got)}`);
}

console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
process.exit(fail ? 1 : 0);
