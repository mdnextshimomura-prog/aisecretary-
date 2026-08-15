/**
 * 未完了タスクの棚卸しレポート。
 *
 * 用途: お盆明けなど、休業を挟んだ後に「何が溜まっていて、何が完了報告の
 *       出ていないまま残っているか」を一覧にする。
 *
 * 使い方:
 *   node scripts/report-open-tasks.mjs [休業開始日 休業終了日]
 *   例) node scripts/report-open-tasks.mjs 2026-08-13 2026-08-19
 *   休業日を渡さない場合は「今日より前／以降」で分けるだけ。
 *
 * .env.local を読むので、Vercelの環境変数とは別に手元で完結する。
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "@notionhq/client";

const ROOT = path.resolve(import.meta.dirname, "..");

// .env.local から必要な値だけ取り出す（値は表示しない）
function loadEnv() {
  const f = path.join(ROOT, ".env.local");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnv();

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DB = process.env.NOTION_DATABASE_ID;
if (!DB) {
  console.error("NOTION_DATABASE_ID が見つかりません（.env.local を確認）");
  process.exit(1);
}

const [closeStart, closeEnd] = process.argv.slice(2);
const jst = new Date(Date.now() + 9 * 3600e3);
const today = jst.toISOString().slice(0, 10);

const txt = (p) => (p?.rich_text ?? []).map((t) => t.plain_text).join("");
const sel = (p) => p?.select?.name ?? null;

async function fetchAll() {
  const out = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DB,
      page_size: 100,
      start_cursor: cursor,
      filter: { property: "ステータス", select: { does_not_equal: "完了" } },
      sorts: [{ property: "期日", direction: "ascending" }],
    });
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out.map((p) => ({
    title: p.properties["名前"]?.title?.[0]?.plain_text ?? "（無題）",
    due: p.properties["期日"]?.date?.start?.slice(0, 10) ?? null,
    assignee: sel(p.properties["担当者"]) ?? "担当なし",
    category: sel(p.properties["種別"]) ?? "",
    property: txt(p.properties["物件名"]) || null,
    created: p.created_time.slice(0, 10),
    // 朝のリマインドが走ると 1..N が振られる。リマインドが実際に動いたかの確認に使う
    remindNo: p.properties["リマインド番号"]?.number ?? null,
    url: p.url,
  }));
}

const days = (a, b) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

const tasks = await fetchAll();

// 休業期間が渡されていれば、登録日で「休業中に溜まった分」を切り出す
const inClosure = (d) => closeStart && closeEnd && d >= closeStart && d <= closeEnd;
const duringClosure = tasks.filter((t) => inClosure(t.created));
const beforeClosure = tasks.filter((t) => !inClosure(t.created) && (!closeStart || t.created < closeStart));
const afterClosure = tasks.filter((t) => closeStart && t.created > closeEnd);

const overdue = tasks.filter((t) => t.due && t.due < today);
const line = (t) => {
  const od = t.due && t.due < today ? `${days(today, t.due)}日超過` : t.due ? `期日${t.due}` : "期日なし";
  return `  ・${t.title}${t.property ? `【${t.property}】` : ""}（${od}／${t.assignee}）`;
};
const byAssignee = (list) =>
  Object.entries(
    list.reduce((a, t) => ((a[t.assignee] = (a[t.assignee] || 0) + 1), a), {})
  ).sort((a, b) => b[1] - a[1]);

console.log(`■ 未完了タスクの棚卸し（${today} 時点）`);
console.log(`  未完了 ${tasks.length}件／うち期限超過 ${overdue.length}件`);
if (closeStart) console.log(`  休業期間: ${closeStart} 〜 ${closeEnd}`);

console.log(`\n【1】休業前から残っていて、完了報告が出ていないもの … ${beforeClosure.length}件`);
beforeClosure.forEach((t) => console.log(line(t)));

if (closeStart) {
  console.log(`\n【2】休業中に届いて溜まったもの … ${duringClosure.length}件`);
  duringClosure.forEach((t) => console.log(line(t)));
  console.log(`\n【3】休業明けに届いたもの … ${afterClosure.length}件`);
  afterClosure.forEach((t) => console.log(line(t)));
}

// 朝のリマインドが動いたかの確認。動くと本文に載せた順で 1..N が振られる。
const numbered = tasks.filter((t) => (t.remindNo ?? 0) >= 1).length; // 0は検証で書いた値なので除く
console.log(
  `\n■ 朝のリマインドの実行確認: ${
    numbered > 0
      ? `番号が振られたタスク ${numbered}件 → リマインドは動いている`
      : "番号が振られたタスクが0件 → 今朝のリマインドが動いていない可能性"
  }`
);

console.log(`\n■ 担当者別の未完了件数`);
byAssignee(tasks).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}件  ${k}`));

const props = tasks.filter((t) => t.property);
if (props.length) {
  console.log(`\n■ 物件別（複数タスクが残っているもの）`);
  Object.entries(props.reduce((a, t) => ((a[t.property] = (a[t.property] || 0) + 1), a), {}))
    .filter(([, v]) => v > 1)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}件  ${k}`));
}
