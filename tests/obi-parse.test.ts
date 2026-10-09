/**
 * 依頼文の読み取りが line-secretary の parse.js と同じ結果になるか（共通の表で確かめる）。
 * 表：tests/fixtures/job-command-cases.json（line-secretary 側にも同じものを置く）
 */
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
