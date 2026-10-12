import { defaultCheckDateFrom } from "../src/lib/task-status-wire";
import type { Closure } from "../src/lib/closures";

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (JSON.stringify(a) === JSON.stringify(b)) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} → ${JSON.stringify(a)}`);
  }
};

eq("休業が無ければ 3 日後", defaultCheckDateFrom("2026-10-12", []), "2026-10-15");

const closures: Closure[] = [
  { name: "臨時休業", start: "2026-10-15", end: "2026-10-16" },
];
eq(
  "3 日後が休業なら翌営業日",
  defaultCheckDateFrom("2026-10-12", closures),
  "2026-10-17"
);

console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
process.exit(fail ? 1 : 0);
