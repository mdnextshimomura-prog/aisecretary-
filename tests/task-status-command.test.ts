import fs from "node:fs";
import path from "node:path";
import {
  addDaysStr,
  parseStatusBody,
  parseStatusCommand,
  resolveDateToken,
} from "../src/lib/task-status-command";

let fail = 0;
const ok = (name: string, condition: boolean) => {
  if (condition) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name}`);
  }
};
const eq = (name: string, a: unknown, b: unknown) =>
  ok(`${name} → ${JSON.stringify(a)}`, JSON.stringify(a) === JSON.stringify(b));

// 2026-10-12 は月曜
const TODAY = "2026-10-12";

// ── 日付の言葉 ──
eq("M/D", resolveDateToken("10/20", TODAY), "2026-10-20");
eq("M月D日", resolveDateToken("10月20日", TODAY), "2026-10-20");
eq("過ぎた月日は来年", resolveDateToken("1/5", TODAY), "2027-01-05");
eq("今日", resolveDateToken("今日", TODAY), "2026-10-12");
eq("明日", resolveDateToken("明日", TODAY), "2026-10-13");
eq("明後日", resolveDateToken("明後日", TODAY), "2026-10-14");
eq("金曜＝次の金曜", resolveDateToken("金曜", TODAY), "2026-10-16");
eq("金曜日", resolveDateToken("金曜日", TODAY), "2026-10-16");
eq("月曜＝今日ではなく次の月曜", resolveDateToken("月曜", TODAY), "2026-10-19");
eq("来週金曜", resolveDateToken("来週金曜", TODAY), "2026-10-23");
eq("来週月曜", resolveDateToken("来週月曜", TODAY), "2026-10-19");
eq("ありえない日付", resolveDateToken("13/40", TODAY), null);
eq("日付でない言葉", resolveDateToken("売主の書類", TODAY), null);
eq("addDaysStr 月またぎ", addDaysStr("2026-10-30", 3), "2026-11-02");

// ── 番号つき ──
eq("3待ち 理由 日付", parseStatusCommand("3待ち 売主の書類 金曜", TODAY), {
  kind: "wait",
  note: "売主の書類",
  date: "2026-10-16",
  numbers: [3],
});
eq("3待ち 理由だけ", parseStatusCommand("3待ち 売主の書類", TODAY), {
  kind: "wait",
  note: "売主の書類",
  date: null,
  numbers: [3],
});
eq("3待ち だけ", parseStatusCommand("3待ち", TODAY), {
  kind: "wait",
  note: "",
  date: null,
  numbers: [3],
});
eq("全角数字・空白なし", parseStatusCommand("３待ち銀行の回答", TODAY), {
  kind: "wait",
  note: "銀行の回答",
  date: null,
  numbers: [3],
});
eq("複数番号", parseStatusCommand("1,2待ち 司法書士の返事 10/20", TODAY), {
  kind: "wait",
  note: "司法書士の返事",
  date: "2026-10-20",
  numbers: [1, 2],
});
eq("3延期 日付", parseStatusCommand("3延期 10/20", TODAY), {
  kind: "postpone",
  date: "2026-10-20",
  numbers: [3],
});
eq("3延期 金曜まで", parseStatusCommand("3延期 金曜まで", TODAY), {
  kind: "postpone",
  date: "2026-10-16",
  numbers: [3],
});
eq("3延期 だけ（日付は聞き返す）", parseStatusCommand("3延期", TODAY), {
  kind: "postpone",
  date: null,
  numbers: [3],
});
eq("3不要", parseStatusCommand("3不要", TODAY), { kind: "drop", numbers: [3] });
eq("3いらない", parseStatusCommand("3 いらない", TODAY), {
  kind: "drop",
  numbers: [3],
});
eq("3不要です。", parseStatusCommand("3不要です。", TODAY), {
  kind: "drop",
  numbers: [3],
});

// ── コマンドとみなさないもの ──
eq("数字だけ", parseStatusCommand("3", TODAY), null);
eq("完了は対象外（今の「3済」の処理に任せる）", parseStatusCommand("3済", TODAY), null);
eq("番号が先頭にない", parseStatusCommand("売主の書類待ち 3", TODAY), null);
eq(
  "依頼文（不要のあとに文が続く）",
  parseStatusCommand("3不要な書類を整理しておいてください", TODAY),
  null
);
eq(
  "依頼文（延期のあとが日付でない）",
  parseStatusCommand("3延期の連絡をお客様にしてください", TODAY),
  null
);
eq(
  "長すぎる",
  parseStatusCommand(`3待ち ${"あ".repeat(70)}`, TODAY),
  null
);
eq("0 番や 100 番は番号にしない", parseStatusCommand("100待ち", TODAY), null);
eq("空", parseStatusCommand("", TODAY), null);

// ── 番号なし（引用リプライ用） ──
eq("待ち 理由 日付", parseStatusBody("待ち 売主の書類 金曜", TODAY), {
  kind: "wait",
  note: "売主の書類",
  date: "2026-10-16",
});
eq("延期 10/20", parseStatusBody("延期 10/20", TODAY), {
  kind: "postpone",
  date: "2026-10-20",
});
eq("ふつうの文は拾わない", parseStatusBody("売主の書類を待っています", TODAY), null);

// ── 帯替えの言葉を横取りしない ──
const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "job-command-cases.json"),
    "utf8"
  )
) as { cases: Array<{ input: string }> };
const stolen = fixture.cases.filter(
  (c) =>
    parseStatusCommand(c.input, TODAY) !== null ||
    parseStatusBody(c.input, TODAY) !== null
);
ok(
  `帯替えの共通の表 ${fixture.cases.length} 行に 1 件も当たらない（当たった: ${stolen
    .map((c) => c.input)
    .join(" / ")}）`,
  fixture.cases.length === 88 && stolen.length === 0
);

console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
process.exit(fail ? 1 : 0);
