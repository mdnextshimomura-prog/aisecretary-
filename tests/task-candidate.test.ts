import fs from "node:fs";
import path from "node:path";
import {
  buildDigest,
  isCandidateListRequest,
  isDigestTime,
  looksLikeRequest,
  parseCandidateCommand,
  pruneExpired,
  shouldCapture,
  type Candidate,
} from "../src/lib/task-candidate";
import {
  parseStatusBody,
  parseStatusCommand,
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

// ── 依頼に見えるか ──
eq(
  "依頼：お願いします",
  looksLikeRequest("見積書を明日までに送付お願いします"),
  true,
);
eq("依頼：しといて", looksLikeRequest("この図面を直しといて"), true);
eq(
  "依頼：確認して",
  looksLikeRequest("管理会社に鍵の場所を確認してください"),
  true,
);
eq("雑談", looksLikeRequest("今日は暑いですね"), false);
eq("報告", looksLikeRequest("先ほど帰社しました"), false);
eq("短すぎる", looksLikeRequest("お願い"), false);
eq("長すぎる", looksLikeRequest("お願いします" + "あ".repeat(400)), false);

// ── 控えるか ──
const base = {
  groupId: "G_MAIN",
  mainGroupId: "G_MAIN",
  senderId: "U_BOSS",
  mentionedUserIds: [] as string[],
  text: "見積書を明日までに送付お願いします",
  pilot: ["U_A", "U_B"],
};
eq("対象外の人どうしの依頼は控えない", shouldCapture(base), false);
eq("対象者が頼んだら控える", shouldCapture({ ...base, senderId: "U_A" }), true);
eq(
  "対象者あてのメンションがあれば控える",
  shouldCapture({ ...base, mentionedUserIds: ["U_B"] }),
  true,
);
eq(
  "別のグループは控えない",
  shouldCapture({ ...base, senderId: "U_A", groupId: "G_OTHER" }),
  false,
);
eq(
  "1対1は控えない",
  shouldCapture({ ...base, senderId: "U_A", groupId: undefined }),
  false,
);
eq(
  "会社グループが未設定なら控えない",
  shouldCapture({ ...base, senderId: "U_A", mainGroupId: undefined }),
  false,
);
eq(
  "対象者が空なら控えない",
  shouldCapture({ ...base, senderId: "U_A", pilot: [] }),
  false,
);
eq(
  "依頼に見えなければ控えない",
  shouldCapture({ ...base, senderId: "U_A", text: "今日は暑いですね" }),
  false,
);

// ── 返事の言葉 ──
eq("1 登録", parseCandidateCommand("1 登録"), {
  action: "register",
  numbers: [1],
});
eq("全角・空白なし", parseCandidateCommand("１登録"), {
  action: "register",
  numbers: [1],
});
eq("2,3 なし", parseCandidateCommand("2,3 なし"), {
  action: "skip",
  numbers: [2, 3],
});
eq("数字だけは読まない", parseCandidateCommand("1"), null);
eq(
  "後ろに文が続くと読まない",
  parseCandidateCommand("1 登録しておいてください"),
  null,
);
eq("いらないは候補の言葉にしない", parseCandidateCommand("1 いらない"), null);
eq("0 番は読まない", parseCandidateCommand("0 登録"), null);
eq("候補のひとこと", isCandidateListRequest(" 候補 "), true);
eq("文の中の候補は違う", isCandidateListRequest("候補を出してください"), false);

// ── 言葉の取り違えが無いこと ──
for (const s of ["1 登録", "2,3 なし", "候補"]) {
  ok(
    `「${s}」はタスクの番号の言葉（待ち・延期・不要）として読まれない`,
    parseStatusCommand(s, "2026-10-12") === null &&
      parseStatusBody(s, "2026-10-12") === null,
  );
}
for (const s of [
  "3待ち 売主の書類",
  "3延期 10/20",
  "3不要",
  "3済",
  "3いらない",
]) {
  ok(`「${s}」は候補の言葉として読まれない`, parseCandidateCommand(s) === null);
}
const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "job-command-cases.json"),
    "utf8",
  ),
) as { cases: Array<{ input: string }> };
const stolen = fixture.cases.filter(
  (c) =>
    parseCandidateCommand(c.input) !== null || isCandidateListRequest(c.input),
);
ok(
  `帯替えの共通の表 ${fixture.cases.length} 行に 1 件も当たらない（当たった: ${stolen.map((c) => c.input).join(" / ")}）`,
  fixture.cases.length === 88 && stolen.length === 0,
);

// ── 期限切れ・時刻・文面 ──
const cand = (p: Partial<Candidate>): Candidate => ({
  id: "m1",
  text: "見積書を送付お願いします",
  title: "見積書の送付",
  assignee: null,
  senderId: "U_A",
  createdAt: 0,
  ...p,
});
const DAY = 24 * 60 * 60 * 1000;
eq(
  "5 日たった候補は消す",
  pruneExpired(
    [
      cand({ id: "old", createdAt: 0 }),
      cand({ id: "new", createdAt: 4 * DAY }),
    ],
    5 * DAY,
  ).map((c) => c.id),
  ["new"],
);
// 2026-10-12 17:05 JST = 08:05 UTC
eq("17:05 は聞く時刻", isDigestTime(Date.UTC(2026, 9, 12, 8, 5)), true);
eq("17:10 は過ぎている", isDigestTime(Date.UTC(2026, 9, 12, 8, 10)), false);
eq("16:59 はまだ", isDigestTime(Date.UTC(2026, 9, 12, 7, 59)), false);
eq("候補が無ければ文面なし", buildDigest([]), null);
eq("済みの番号だけなら文面なし", buildDigest([null, null]), null);
const digest = buildDigest([
  cand({ title: "見積書の送付", assignee: "有吉 勇弥" }),
  null,
  cand({ title: "鍵の返却" }),
]) as string;
ok("文面：件数は残っている分", digest.includes("（2件）"));
ok(
  "文面：番号は元の並びのまま（済みは飛ばす）",
  digest.includes("1. 見積書の送付（担当：有吉 勇弥）") &&
    digest.includes("3. 鍵の返却") &&
    !digest.includes("2. "),
);
ok(
  "文面：返し方の案内",
  digest.includes("「1 登録」") && digest.includes("なし"),
);

console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
process.exit(fail ? 1 : 0);
