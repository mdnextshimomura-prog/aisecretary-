import { bucketOf, shouldRemind, type RemindRow } from "../src/lib/remind-select";

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (JSON.stringify(a) === JSON.stringify(b)) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} → ${JSON.stringify(a)}`);
  }
};

const TODAY = "2026-10-12";
const TOMORROW = "2026-10-13";
const YESTERDAY = "2026-10-11";
const row = (p: Partial<RemindRow>): RemindRow => ({
  dueDate: "",
  nextCheck: null,
  createdDate: "2026-09-01",
  ...p,
});
const remind = (p: Partial<RemindRow>) =>
  shouldRemind(row(p), TODAY, TOMORROW, YESTERDAY);

eq("期限切れは出す", remind({ dueDate: "2026-10-01" }), true);
eq("今日が期限は出す", remind({ dueDate: "2026-10-12" }), true);
eq("時刻つきの今日期限も出す", remind({ dueDate: "2026-10-12T15:00:00+09:00" }), true);
eq("明日が期限は出す", remind({ dueDate: "2026-10-13" }), true);
eq("期限が先で、古いタスクは出さない", remind({ dueDate: "2026-10-20" }), false);
eq("期限切れでも、確認日が先なら出さない（待ち）", remind({ dueDate: "2026-10-01", nextCheck: "2026-10-16" }), false);
eq("確認日が今日なら出す", remind({ dueDate: "2026-10-01", nextCheck: "2026-10-12" }), true);
eq("確認日を過ぎていたら出す", remind({ dueDate: "2026-10-30", nextCheck: "2026-10-10" }), true);
eq("昨日入ったばかりのタスクは、期限が先でも出す", remind({ dueDate: "2026-10-30", createdDate: "2026-10-11" }), true);
eq("今日入ったタスクも出す", remind({ dueDate: "2026-10-30", createdDate: "2026-10-12" }), true);
eq("期日なし・古い・確認日なしは出さない", remind({}), false);

eq("枠：期限切れ", bucketOf(row({ dueDate: "2026-10-01" }), TODAY, TOMORROW), "overdue");
eq("枠：本日", bucketOf(row({ dueDate: "2026-10-12T09:00:00+09:00" }), TODAY, TOMORROW), "today");
eq("枠：明日", bucketOf(row({ dueDate: "2026-10-13" }), TODAY, TOMORROW), "tomorrow");
eq("枠：その他（期限が先・期日なし）", [
  bucketOf(row({ dueDate: "2026-10-30" }), TODAY, TOMORROW),
  bucketOf(row({}), TODAY, TOMORROW),
], ["other", "other"]);

console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
process.exit(fail ? 1 : 0);
