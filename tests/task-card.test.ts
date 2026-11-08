/**
 * タスクのカード（Flex Message）の見た目の部品（task-card.ts）。LINE には送らない。
 */
import {
  buildTaskCard,
  cardActions,
  cardButton,
  dueFromParsed,
  formatDue,
  FLEX_LABEL_MAX,
} from "../src/lib/task-card";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};

ok("日付だけ", formatDue("2026-11-20") === "11月20日(金)", String(formatDue("2026-11-20")));
ok("日時", formatDue("2026-11-20T17:00:00+09:00") === "11月20日(金) 17:00");
ok("月曜", formatDue("2026-11-09") === "11月9日(月)");
ok("空は null", formatDue(null) === null && formatDue("") === null);
ok("読めない形は null", formatDue("来週") === null);
ok("解析結果の期日（時刻つき）", dueFromParsed({ dueDate: "2026-11-20", dueTime: "09:30" }) === "2026-11-20T09:30:00+09:00");
ok("解析結果の期日（日付だけ）", dueFromParsed({ dueDate: "2026-11-20", dueTime: null }) === "2026-11-20");
ok("解析結果の期日なし", dueFromParsed({ dueDate: null, dueTime: "09:30" }) === null);

const info = { pageId: "p", title: "  ", due: "bad", assignee: "  " };
const c = buildTaskCard(info, []);
const j = JSON.stringify(c);
ok("無題は（無題）", j.includes("（無題）") && c.altText === "【タスク】（無題）", c.altText);
ok("読めない期日・空白の担当は未定", (j.match(/"未定"/g) ?? []).length === 2);
ok("ボタンが無ければ footer なし", !("footer" in c.contents) && cardActions(c).length === 0);
ok("bubble", c.type === "flex" && c.contents.type === "bubble");

const c2 = buildTaskCard(
  { pageId: "p", title: "t", due: null, assignee: null },
  [cardButton("x".repeat(50), "v1|done|p", "y".repeat(400), true)],
  "いつに延期しますか？",
);
const a = cardActions(c2)[0];
ok("ラベルは 40 字で切る", Array.from(a.label).length === FLEX_LABEL_MAX);
ok("displayText は 300 字で切る", a.displayText.length === 300);
ok("postback", a.type === "postback" && a.data === "v1|done|p");
ok("問いかけの行を出す", JSON.stringify(c2).includes("いつに延期しますか？"));
ok("1つの bubble は 30KB 未満（UTF-8 のバイト数）", Buffer.byteLength(JSON.stringify(c2.contents), "utf8") < 30 * 1024);
{
  // 一番大きいカード：担当の候補 13 人（名前 40 字）＋長いタスク名
  const big = buildTaskCard(
    { pageId: "1234abcd-1234-1234-1234-1234567890ab", title: "長".repeat(500), due: "2026-11-20T17:00:00+09:00", assignee: "担".repeat(100) },
    Array.from({ length: 13 }, (_, i) =>
      cardButton("名".repeat(60), `v1|as|1234abcd-1234-1234-1234-1234567890ab|U${String(i).padStart(32, "0")}`, "表".repeat(400)),
    ),
    "誰に替えますか？",
  );
  const bytes = Buffer.byteLength(JSON.stringify(big.contents), "utf8");
  ok("最大の想定でも bubble は 30KB 未満（UTF-8）", bytes < 30 * 1024, String(bytes));
}

if (fail > 0) {
  console.log(`\n${fail} 件失敗`);
  process.exit(1);
}
console.log("\nすべて成功");
