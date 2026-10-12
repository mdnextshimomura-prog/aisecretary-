# タスクの追いかけ ① 出口（LINE から状況を返す・朝の知らせを絞る） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LINE で「3待ち 売主の書類 金曜」「3延期 10/20」「3不要」と返すと Notion「LINEタスク」に状況が残り、朝のリマインドは「待ち」を確認日まで出さなくなる。

**Architecture:** 言葉の読み取り（純粋関数）・Notion に書く欄の組み立て（純粋関数）・朝に出すかの判定（純粋関数）を小さな新規ファイルに分け、テストを付ける。`route.ts` と `remind.ts` は、それらを呼ぶ数行だけを足す。すべて環境変数 `TASK_FOLLOWUP=1` のときだけ動き、外せば今の動きに戻る。

**Tech Stack:** Next.js 14 (App Router) / TypeScript / `@notionhq/client` 2.3（API 2022-06-28、`database_id` 方式）/ テストは `tsx` で 1 ファイルずつ実行（テストランナーなし）

**Spec:** `docs/superpowers/specs/2026-10-12-task-followup-pilot-design.md`（5 章・6 章・10 章）

この計画は設計書のうち「出口」だけを扱う。入口（候補）・記録とひも付け・管理職の画面は別の計画（②③④）にする。

## Global Constraints

- 作業場所は worktree `.worktrees/task-followup`（枝 `feat/task-followup`、起点は `integration/email-and-media` の `951fdb1`）。本番ツリー（リポジトリ直下）のファイルは変えない。
- `git push` しない（GitHub は公開設定）。デプロイしない。どちらも下村さんの承認が要る。
- `.env*` を開かない・書かない。環境変数の値を画面に出さない。
- Notion の既存の欄は、型も名前も変えない。ステータスの選択肢名「完了」「要確認」「進行中」「未着手」は文字列一致で使われている。
- 使う Notion の欄（10/12 に作成済み）：`状況`(rich_text)、`次に確認する日`(date)、`終わり方`(select: 完了／不要／重複)。
- 新しい動きは `process.env.TASK_FOLLOWUP === "1"` のときだけ。それ以外は 1 バイトも挙動を変えない。
- 新しい返し方は「数字だけ」の形にしない（営業部のグループでは、引用つきの数字だけ・「OK」・「9」を帯替えの枝が先に確かめるため）。帯替えの共通の表 `tests/fixtures/job-command-cases.json` の全 88 行が、新しい読み取りに 1 件も当たらないことをテストで固定する。
- `route.ts` の帯替えの振り分け（`dispatchObiEvents`）より前には何も足さない。
- テストは `npx tsx tests/<名前>.test.ts` で 1 本ずつ実行する。新しいテストは `package.json` の `"test"` の並びの末尾に足す。
- テスト用のデータに実在の顧客名・物件名・LINE の ID を使わない。
- コミットは `type: 日本語で変更内容` の形。末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 朝のリマインドは今までどおり全件を出す（件数で打ち切らない）。過去に「LINE だけで消し込めないと進まない」と判断して全件にした経緯があるため（`src/lib/chunk.ts` の冒頭）。絞るのは「待ち」を確認日まで出さないことだけ。

---

### Task 1: 状況の言葉を読み取る（`task-status-command.ts`）

**Files:**
- Create: `src/lib/task-status-command.ts`
- Test: `tests/task-status-command.test.ts`
- Modify: `package.json`（`"test"` の末尾に 1 本足す）

**Interfaces:**
- Consumes: なし
- Produces:
  - `type StatusBody = { kind: "wait"; note: string; date: string | null } | { kind: "postpone"; date: string | null } | { kind: "drop" }`
  - `type StatusCommand = StatusBody & { numbers: number[] }`
  - `resolveDateToken(token: string, todayJst: string): string | null`（`YYYY-MM-DD`）
  - `parseStatusBody(text: string, todayJst: string): StatusBody | null`（番号なし。引用リプライ用）
  - `parseStatusCommand(text: string, todayJst: string): StatusCommand | null`（番号つき）
  - `addDaysStr(day: string, n: number): string`

- [ ] **Step 1: 失敗するテストを書く**

`tests/task-status-command.test.ts`:

```ts
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
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx tests/task-status-command.test.ts`
Expected: `Cannot find module '../src/lib/task-status-command'` で失敗する。

- [ ] **Step 3: 実装する**

`src/lib/task-status-command.ts`:

```ts
/**
 * LINE から返す「状況の言葉」を読み取る。
 *
 *   「3待ち 売主の書類 金曜」→ 相手待ち（理由と、次に確認する日）
 *   「3延期 10/20」         → 期日を変える
 *   「3不要」               → やらなくてよくなった（記録は残す）
 *
 * 完了（「3済」）はここでは扱わない。route.ts の parseNumberedCompletion が今までどおり読む。
 *
 * 数字だけの返事はコマンドにしない。営業部のグループでは、引用つきの数字だけの返事を
 * 帯替えの訂正の枝が先に確かめるため、形を分けておく。
 */

export type StatusBody =
  | { kind: "wait"; note: string; date: string | null }
  | { kind: "postpone"; date: string | null }
  | { kind: "drop" };

export type StatusCommand = StatusBody & { numbers: number[] };

const MAX_COMMAND_LENGTH = 60;
const MAX_NOTE_LENGTH = 40;

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function addDaysStr(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function normalize(text: string): string {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/／/g, "/")
    .replace(/　/g, " ")
    .trim();
}

/** 日付の言葉を YYYY-MM-DD にする。読めなければ null。 */
export function resolveDateToken(token: string, todayJst: string): string | null {
  const t = normalize(token).replace(/(まで|までに|に|へ|。)$/, "");
  if (t === "今日" || t === "本日") return todayJst;
  if (t === "明日") return addDaysStr(todayJst, 1);
  if (t === "明後日") return addDaysStr(todayJst, 2);

  const md = t.match(/^(\d{1,2})[/月](\d{1,2})日?$/);
  if (md) {
    const month = Number(md[1]);
    const dayOfMonth = Number(md[2]);
    const year = Number(todayJst.slice(0, 4));
    for (const y of [year, year + 1]) {
      const d = new Date(Date.UTC(y, month - 1, dayOfMonth));
      // 13/40 のような日付は、月日がずれるので弾く
      if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== dayOfMonth) {
        return null;
      }
      const s = d.toISOString().slice(0, 10);
      if (s >= todayJst) return s;
    }
    return null;
  }

  const wd = t.match(/^(来週)?([日月火水木金土])(曜|曜日)?$/);
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[2]);
    const today = new Date(`${todayJst}T00:00:00Z`).getUTCDay();
    if (wd[1]) {
      // 来週＝次の月曜から始まる週
      const toNextMonday = ((8 - today) % 7) || 7;
      const offsetFromMonday = (target + 6) % 7;
      return addDaysStr(todayJst, toNextMonday + offsetFromMonday);
    }
    // 「金曜」＝今日より後で最初に来る金曜（今日が金曜なら来週の金曜）
    const diff = ((target - today + 7) % 7) || 7;
    return addDaysStr(todayJst, diff);
  }
  return null;
}

const BODY_RE = /^(待ち|まち|延期|不要|いらない)(.*)$/;

/** 番号なしの本文（「待ち 売主の書類 金曜」）を読む。引用リプライ用。 */
export function parseStatusBody(text: string, todayJst: string): StatusBody | null {
  const t = normalize(text);
  if (t.length === 0 || t.length > MAX_COMMAND_LENGTH) return null;
  const m = t.match(BODY_RE);
  if (!m) return null;
  const word = m[1];
  const rest = m[2].trim();

  if (word === "不要" || word === "いらない") {
    // 後ろに文が続くなら依頼文（「不要な書類を整理して」）
    return rest.replace(/^(です|でした)?[。.!！]*$/, "") === ""
      ? { kind: "drop" }
      : null;
  }

  if (word === "延期") {
    if (rest === "") return { kind: "postpone", date: null };
    const date = resolveDateToken(rest, todayJst);
    // 後ろが日付として読めないなら依頼文（「延期の連絡をしてください」）
    return date ? { kind: "postpone", date } : null;
  }

  // 待ち：最後の語が日付なら「次に確認する日」、残りが理由
  const tokens = rest.split(/\s+/).filter(Boolean);
  let date: string | null = null;
  if (tokens.length > 0) {
    const last = resolveDateToken(tokens[tokens.length - 1], todayJst);
    if (last) {
      date = last;
      tokens.pop();
    }
  }
  const note = tokens.join(" ");
  if (note.length > MAX_NOTE_LENGTH) return null;
  return { kind: "wait", note, date };
}

const HEAD_RE = /^(\d{1,3}(?:[\s,、，・]+\d{1,3})*)\s*(.+)$/;

/** 番号つき（「3待ち 売主の書類 金曜」「1,2延期 10/20」）を読む。 */
export function parseStatusCommand(
  text: string,
  todayJst: string
): StatusCommand | null {
  const t = normalize(text);
  if (t.length === 0 || t.length > MAX_COMMAND_LENGTH) return null;
  const m = t.match(HEAD_RE);
  if (!m) return null;
  const nums = (m[1].match(/\d+/g) ?? []).map(Number);
  if (nums.some((n) => n < 1 || n > 99)) return null;
  const numbers = nums.filter((n, i) => nums.indexOf(n) === i);
  if (numbers.length === 0) return null;
  const body = parseStatusBody(m[2], todayJst);
  return body ? { ...body, numbers } : null;
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx tsx tests/task-status-command.test.ts`
Expected: 最後の行が `🎉 全て通過`。

- [ ] **Step 5: `package.json` の `"test"` に足す**

`"test"` の文字列の末尾（最後の `tsx tests/….test.ts` の後ろ）に ` && tsx tests/task-status-command.test.ts` を足す。

Run: `npm test 2>&1 | tail -3`
Expected: 最後のテストまで進み、終了コード 0。

- [ ] **Step 6: コミット**

```bash
git add src/lib/task-status-command.ts tests/task-status-command.test.ts package.json
git commit -m "feat: LINE から返す状況の言葉（待ち・延期・不要）を読み取る

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 状況を Notion に書く・返事を組み立てる（`task-status.ts`）

**Files:**
- Create: `src/lib/task-status.ts`
- Test: `tests/task-status.test.ts`
- Modify: `src/lib/notion.ts`（末尾に `updateTaskProps` を足す。`findTaskByRemindNumber` に引数を 1 つ足す）
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 の `StatusCommand`, `StatusBody`, `addDaysStr`
- Produces:
  - `followupEnabled(): boolean`（`process.env.TASK_FOLLOWUP === "1"`）
  - `waitProps(note: string, checkDate: string)`, `postponeProps(dueDate: string)`, `closeProps(reason: "完了" | "不要" | "重複")` … Notion の `properties` に渡す形
  - `interface StatusDeps { findByNumber(n: number): Promise<{ id: string; title: string } | null>; update(pageId: string, props: Record<string, unknown>): Promise<void>; defaultCheckDate(): Promise<string>; }`
  - `applyStatusCommand(cmd: StatusCommand, deps: StatusDeps): Promise<{ text: string; changed: number }>`
  - `applyStatusToTask(body: StatusBody, task: { id: string; title: string }, deps: Pick<StatusDeps, "update" | "defaultCheckDate">): Promise<string>`
  - `notion.ts`: `updateTaskProps(pageId: string, properties: Record<string, unknown>): Promise<void>`、`findTaskByRemindNumber(num: number, opts?: { anyDue?: boolean })`

- [ ] **Step 1: 失敗するテストを書く**

`tests/task-status.test.ts`:

```ts
import {
  applyStatusCommand,
  applyStatusToTask,
  closeProps,
  postponeProps,
  waitProps,
  type StatusDeps,
} from "../src/lib/task-status";

let fail = 0;
const ok = (name: string, condition: boolean) => {
  if (condition) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name}`);
  }
};
const eq = (name: string, a: unknown, b: unknown) =>
  ok(`${name}`, JSON.stringify(a) === JSON.stringify(b));

// ── Notion に渡す形 ──
eq("待ち：進行中にして、状況と確認日を入れる", waitProps("売主の書類", "2026-10-16"), {
  ステータス: { select: { name: "進行中" } },
  状況: { rich_text: [{ text: { content: "売主の書類" } }] },
  次に確認する日: { date: { start: "2026-10-16" } },
});
eq("待ち：理由が空なら状況は空にする", waitProps("", "2026-10-16"), {
  ステータス: { select: { name: "進行中" } },
  状況: { rich_text: [] },
  次に確認する日: { date: { start: "2026-10-16" } },
});
eq("延期：期日を変え、期限前の通知をもう一度出せるようにする", postponeProps("2026-10-20"), {
  期日: { date: { start: "2026-10-20" } },
  通知済み: { checkbox: false },
});
eq("不要：完了にして終わり方を残す", closeProps("不要"), {
  ステータス: { select: { name: "完了" } },
  終わり方: { select: { name: "不要" } },
});

// ── 適用と返事 ──
function fakeDeps(tasks: Record<number, { id: string; title: string }>) {
  const updates: Array<{ pageId: string; props: Record<string, unknown> }> = [];
  const deps: StatusDeps = {
    findByNumber: async (n) => tasks[n] ?? null,
    update: async (pageId, props) => {
      updates.push({ pageId, props });
    },
    defaultCheckDate: async () => "2026-10-15",
  };
  return { deps, updates };
}

(async () => {
  {
    const { deps, updates } = fakeDeps({ 3: { id: "p3", title: "見積を送る" } });
    const r = await applyStatusCommand(
      { kind: "wait", note: "売主の書類", date: "2026-10-16", numbers: [3] },
      deps
    );
    eq("待ち：1 件書く", updates, [
      { pageId: "p3", props: waitProps("売主の書類", "2026-10-16") },
    ]);
    ok("待ち：返事に題名・状況・確認日が入る", r.text.includes("3. 見積を送る") && r.text.includes("売主の書類") && r.text.includes("10/16"));
    eq("待ち：変えた件数", r.changed, 1);
  }
  {
    const { deps, updates } = fakeDeps({ 3: { id: "p3", title: "見積を送る" } });
    const r = await applyStatusCommand(
      { kind: "wait", note: "", date: null, numbers: [3] },
      deps
    );
    eq("待ち：日付なしは既定の確認日を使う", updates[0].props, waitProps("", "2026-10-15"));
    ok("待ち：返事に既定の確認日が入る", r.text.includes("10/15"));
  }
  {
    const { deps, updates } = fakeDeps({ 3: { id: "p3", title: "見積を送る" } });
    const r = await applyStatusCommand(
      { kind: "postpone", date: null, numbers: [3] },
      deps
    );
    eq("延期：日付なしは何も書かない", updates, []);
    ok("延期：日付を付けるよう返す", r.text.includes("3延期 10/20"));
    eq("延期：変えた件数は 0", r.changed, 0);
  }
  {
    const { deps, updates } = fakeDeps({
      1: { id: "p1", title: "鍵を返す" },
      2: { id: "p2", title: "図面を直す" },
    });
    const r = await applyStatusCommand(
      { kind: "postpone", date: "2026-10-20", numbers: [1, 2, 7] },
      deps
    );
    eq("延期：見つかった分だけ書く", updates.map((u) => u.pageId), ["p1", "p2"]);
    ok("延期：見つからない番号を知らせる", r.text.includes("7番は見つかりませんでした"));
    eq("延期：変えた件数", r.changed, 2);
  }
  {
    const { deps, updates } = fakeDeps({ 4: { id: "p4", title: "案内の準備" } });
    const r = await applyStatusCommand({ kind: "drop", numbers: [4] }, deps);
    eq("不要：完了・終わり方＝不要で書く", updates[0].props, closeProps("不要"));
    ok("不要：記録が残ることを返す", r.text.includes("記録は残ります"));
  }
  {
    const { deps, updates } = fakeDeps({});
    const text = await applyStatusToTask(
      { kind: "wait", note: "銀行の回答", date: null },
      { id: "q1", title: "ローンの確認" },
      deps
    );
    eq("引用リプライ：その 1 件に書く", updates, [
      { pageId: "q1", props: waitProps("銀行の回答", "2026-10-15") },
    ]);
    ok("引用リプライ：返事に題名が入る", text.includes("ローンの確認"));
  }
  {
    const { deps } = fakeDeps({ 3: { id: "p3", title: "見積を送る" } });
    deps.update = async () => {
      throw new Error("notion down");
    };
    let threw = false;
    try {
      await applyStatusCommand({ kind: "drop", numbers: [3] }, deps);
    } catch {
      threw = true;
    }
    ok("Notion の失敗は握りつぶさず呼び出し側へ投げる", threw);
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx tests/task-status.test.ts`
Expected: `Cannot find module '../src/lib/task-status'` で失敗する。

- [ ] **Step 3: 実装する**

`src/lib/task-status.ts`:

```ts
/**
 * 読み取った状況の言葉を、Notion の欄と LINE の返事にする。
 *
 * Notion と LINE を直接呼ばず、deps で受け取る（route.ts にはテストが無いので、
 * 判断の部分をここに出してテストする）。
 */
import type { StatusBody, StatusCommand } from "./task-status-command";

/** 新しい追いかけ方（状況の返事・朝の知らせの絞り込み）を使うか。外せば今までの動きに戻る。 */
export function followupEnabled(): boolean {
  return process.env.TASK_FOLLOWUP === "1";
}

export type CloseReason = "完了" | "不要" | "重複";

export function waitProps(note: string, checkDate: string) {
  return {
    ステータス: { select: { name: "進行中" } },
    状況: { rich_text: note ? [{ text: { content: note } }] : [] },
    次に確認する日: { date: { start: checkDate } },
  };
}

export function postponeProps(dueDate: string) {
  return {
    期日: { date: { start: dueDate } },
    // 期限前の通知（/api/remind-due）を、新しい期日でもう一度出せるようにする
    通知済み: { checkbox: false },
  };
}

export function closeProps(reason: CloseReason) {
  return {
    ステータス: { select: { name: "完了" } },
    終わり方: { select: { name: reason } },
  };
}

export interface StatusDeps {
  findByNumber(n: number): Promise<{ id: string; title: string } | null>;
  update(pageId: string, props: Record<string, unknown>): Promise<void>;
  /** 「待ち」で日付を省いたときの、次に確認する日 */
  defaultCheckDate(): Promise<string>;
}

const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

async function applyBody(
  body: StatusBody,
  pageId: string,
  deps: Pick<StatusDeps, "update" | "defaultCheckDate">
): Promise<{ checkDate?: string }> {
  if (body.kind === "wait") {
    const checkDate = body.date ?? (await deps.defaultCheckDate());
    await deps.update(pageId, waitProps(body.note, checkDate));
    return { checkDate };
  }
  if (body.kind === "postpone") {
    // date が null のときは呼び出し側で弾く
    await deps.update(pageId, postponeProps(body.date as string));
    return {};
  }
  await deps.update(pageId, closeProps("不要"));
  return {};
}

const NEED_DATE =
  "⚠️ 延期する日を付けてください\n例：「3延期 10/20」「3延期 金曜」";

function head(body: StatusBody, count: number, checkDate?: string): string[] {
  if (body.kind === "wait") {
    const lines = [`⏸ 待ちにしました（${count}件）`];
    if (body.note) lines.push(`状況：${body.note}`);
    if (checkDate) lines.push(`次に確認する日：${md(checkDate)}（この日までは知らせません）`);
    return lines;
  }
  if (body.kind === "postpone") {
    return [`📅 期日を ${md(body.date as string)} に変えました（${count}件）`];
  }
  return [`🗑 不要にしました（${count}件。記録は残ります）`];
}

/** 番号つきの返事（「3待ち …」）を適用する。 */
export async function applyStatusCommand(
  cmd: StatusCommand,
  deps: StatusDeps
): Promise<{ text: string; changed: number }> {
  if (cmd.kind === "postpone" && !cmd.date) return { text: NEED_DATE, changed: 0 };

  const done: string[] = [];
  const notFound: number[] = [];
  let checkDate: string | undefined;
  for (const n of cmd.numbers) {
    const t = await deps.findByNumber(n);
    if (!t) {
      notFound.push(n);
      continue;
    }
    const r = await applyBody(cmd, t.id, deps);
    checkDate = r.checkDate ?? checkDate;
    done.push(`${n}. ${t.title}`);
  }

  const lines: string[] = [];
  if (done.length > 0) lines.push(...head(cmd, done.length, checkDate), ...done);
  if (notFound.length > 0) {
    if (done.length > 0) lines.push("");
    lines.push(
      `⚠️ ${notFound.join("・")}番は見つかりませんでした`,
      "（完了済みか、直近の知らせに無い番号です）"
    );
  }
  return { text: lines.join("\n"), changed: done.length };
}

/** 引用リプライ（対象が 1 件に決まっている）に適用する。 */
export async function applyStatusToTask(
  body: StatusBody,
  task: { id: string; title: string },
  deps: Pick<StatusDeps, "update" | "defaultCheckDate">
): Promise<string> {
  if (body.kind === "postpone" && !body.date) return NEED_DATE;
  const r = await applyBody(body, task.id, deps);
  return [...head(body, 1, r.checkDate), `📋 ${task.title}`].join("\n");
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx tsx tests/task-status.test.ts`
Expected: `🎉 全て通過`。

- [ ] **Step 5: `notion.ts` に書き込みの口を足す**

`src/lib/notion.ts` の `completeTask` の直後に足す:

```ts
// 状況の返事（待ち・延期・不要）で、欄をまとめて書き換える。
// 欄の組み立ては task-status.ts（テストあり）が行い、ここは渡すだけ。
export async function updateTaskProps(
  pageId: string,
  properties: Record<string, unknown>
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: properties as Parameters<
      typeof notion.pages.update
    >[0]["properties"],
  });
}
```

同じファイルの `findTaskByRemindNumber` を、次のとおり引数 1 つ足す形に変える（既定の動きは変えない）:

```ts
export async function findTaskByRemindNumber(
  num: number,
  opts: { anyDue?: boolean } = {}
): Promise<{ id: string; title: string } | null> {
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    page_size: 1,
    filter: {
      and: [
        { property: "リマインド番号", number: { equals: num } },
        { property: "ステータス", select: { does_not_equal: "完了" } },
        // anyDue：新しい知らせ方では、期日が先のタスクにも番号が付く。
        // 古い番号の取り違えは、知らせるたびに載せなかったタスクの番号を消すことで防ぐ（Task 4）
        ...(opts.anyDue
          ? []
          : [{ property: "期日", date: { on_or_before: jstDateStr(1) } }]),
      ],
    },
  });
```

（関数の残り＝`const page = response.results[0];` 以降はそのまま。）

- [ ] **Step 6: 型と全テストを確かめる**

`package.json` の `"test"` の末尾に ` && tsx tests/task-status.test.ts` を足す。

Run: `npx tsc --noEmit 2>&1 | tail -5; npm test 2>&1 | tail -3`
Expected: `tsc` は何も出さない。テストは終了コード 0。

- [ ] **Step 7: コミット**

```bash
git add src/lib/task-status.ts src/lib/notion.ts tests/task-status.test.ts package.json
git commit -m "feat: 状況の返事を Notion の欄と LINE の返事にする

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Webhook につなぐ（番号つき・引用リプライ）

**Files:**
- Modify: `src/app/api/webhook/route.ts`（import、② 番号での完了の直後、③ 引用リプライの (a2) の直後）
- Create: `src/lib/task-status-wire.ts`
- Test: `tests/task-status-wire.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 `parseStatusCommand`, `parseStatusBody`, `addDaysStr`／Task 2 `followupEnabled`, `applyStatusCommand`, `applyStatusToTask`, `StatusDeps`／`notion.ts` の `findTaskByRemindNumber`, `updateTaskProps`, `jstDateStr`／`closures.ts` の `loadClosures`, `shiftToBusinessDay`
- Produces:
  - `defaultCheckDateFrom(todayJst: string, closures: Closure[]): string`（3 日後。休業日なら翌営業日）
  - `statusDeps(): StatusDeps`（本物の Notion につないだ deps）

- [ ] **Step 1: 失敗するテストを書く**

`tests/task-status-wire.test.ts`:

```ts
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
```

先に `src/lib/closures.ts` の `Closure` の項目名を読み、上の `closures` の形（`name`／`start`／`end`）が違っていたら、実際の項目名に合わせてテストを直す。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx tests/task-status-wire.test.ts`
Expected: `Cannot find module '../src/lib/task-status-wire'` で失敗する。

- [ ] **Step 3: 実装する**

`src/lib/task-status-wire.ts`:

```ts
/**
 * 状況の返事を、本物の Notion と休業日カレンダーにつなぐ。
 * 判断は task-status.ts、言葉の読み取りは task-status-command.ts。
 */
import { loadClosures, shiftToBusinessDay, type Closure } from "./closures";
import { findTaskByRemindNumber, jstDateStr, updateTaskProps } from "./notion";
import { addDaysStr } from "./task-status-command";
import type { StatusDeps } from "./task-status";

/** 「待ち」で日付を省いたときの確認日。3 日後、休業日なら翌営業日。 */
export function defaultCheckDateFrom(todayJst: string, closures: Closure[]): string {
  return shiftToBusinessDay(addDaysStr(todayJst, 3), closures).date.slice(0, 10);
}

export function statusDeps(): StatusDeps {
  return {
    findByNumber: (n) => findTaskByRemindNumber(n, { anyDue: true }),
    update: updateTaskProps,
    defaultCheckDate: async () =>
      defaultCheckDateFrom(jstDateStr(0), await loadClosures().catch(() => [])),
  };
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx tsx tests/task-status-wire.test.ts`
Expected: `🎉 全て通過`。

- [ ] **Step 5: `route.ts` に足す**

import を足す（既存の `@/lib/notion` の import の下）:

```ts
import { parseStatusBody, parseStatusCommand } from "@/lib/task-status-command";
import {
  applyStatusCommand,
  applyStatusToTask,
  followupEnabled,
} from "@/lib/task-status";
import { statusDeps } from "@/lib/task-status-wire";
```

**(1) 番号つき**：`// ② 番号での完了報告` のブロック（`if (numbers) { … continue; }`）の**直後**、`// ③ 引用リプライ` の前に足す:

```ts
    // ②' 番号での状況の返事（「3待ち 売主の書類 金曜」「3延期 10/20」「3不要」）。
    // 完了（「3済」）は上の②が先に拾う。スイッチが off のあいだは何もしない。
    if (followupEnabled()) {
      const statusCmd = parseStatusCommand(
        stripMentions(event.message),
        jstDateStr(0)
      );
      if (statusCmd) {
        try {
          const r = await applyStatusCommand(statusCmd, statusDeps());
          if (r.changed > 0) markCommitted();
          await sendLineMessage(replyToken, r.text);
        } catch (err) {
          console.error("状況の返事の処理エラー:", err);
          await sendLineMessage(
            replyToken,
            "⚠️ 状況を書き込めませんでした。もう一度お試しください。"
          );
        }
        continue;
      }
    }
```

**(2) 引用リプライ**：`// (a2) 「完了／終わりました」` の `if (isCompleteIntent(…)) { … continue; }` の**直後**、`// (b) @メンション` の前に足す:

```ts
        // (a3) 「待ち 売主の書類 金曜」「延期 10/20」→ 状況・期日を書き換える。
        // 「不要」「いらない」は上の (a) が今までどおり取り消し（ページを消す）として扱う。
        if (followupEnabled()) {
          const body = parseStatusBody(
            stripMentions(event.message),
            jstDateStr(0)
          );
          if (body && body.kind !== "drop") {
            try {
              const text = await applyStatusToTask(body, task, statusDeps());
              markCommitted();
              await sendLineMessage(replyToken, text);
            } catch (err) {
              console.error("状況の返事（引用）の処理エラー:", err);
              await sendLineMessage(
                replyToken,
                "⚠️ 状況を書き込めませんでした。もう一度お試しください。"
              );
            }
            continue;
          }
        }
```

`applyStatusToTask` が「延期する日を付けてください」を返したとき（日付なしの延期）は何も書いていないが、`markCommitted()` を呼んでも害は無い（この発言を二度処理しない印）。

- [ ] **Step 6: 型・全テスト・ビルドを確かめる**

`package.json` の `"test"` の末尾に ` && tsx tests/task-status-wire.test.ts` を足す。

Run: `npx tsc --noEmit 2>&1 | tail -5; npm test 2>&1 | tail -3`
Expected: `tsc` は何も出さない。テストは終了コード 0（帯替えの `tests/obi-*webhook*.test.ts` を含む）。

Run: `npm run build 2>&1 | tail -15`
Expected: `next build` が成功する。worktree に `.env.local` が無くて環境変数の不足で落ちる場合は、落ちた理由（変数の名前）を記録し、ビルドは「未実施」と報告する。`.env.local` を写さない。

- [ ] **Step 7: コミット**

```bash
git add src/lib/task-status-wire.ts src/app/api/webhook/route.ts tests/task-status-wire.test.ts package.json
git commit -m "feat: 番号つき・引用リプライの状況の返事を Webhook につなぐ（TASK_FOLLOWUP=1 のときだけ）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 朝の知らせで「待ち」を確認日まで出さない

**Files:**
- Create: `src/lib/remind-select.ts`
- Test: `tests/remind-select.test.ts`
- Modify: `src/lib/notion.ts`（`getUpcomingTasks` に引数と戻り値の項目を足す。`clearStaleRemindNumbers` を足す）
- Modify: `src/lib/remind.ts`（`sendDailyReminders`）
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2 `followupEnabled`
- Produces:
  - `interface RemindRow { dueDate: string; nextCheck: string | null; createdDate: string }`
  - `shouldRemind(t: RemindRow, today: string, tomorrow: string, yesterday: string): boolean`
  - `bucketOf(t: RemindRow, today: string, tomorrow: string): "overdue" | "today" | "tomorrow" | "other"`
  - `notion.ts`: `getUpcomingTasks(opts?: { followup?: boolean })` の戻り値に `nextCheck: string | null`, `note: string`, `createdDate: string` を足す。`clearStaleRemindNumbers(keepIds: string[]): Promise<number>`

- [ ] **Step 1: 失敗するテストを書く**

`tests/remind-select.test.ts`:

```ts
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
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx tests/remind-select.test.ts`
Expected: `Cannot find module '../src/lib/remind-select'` で失敗する。

- [ ] **Step 3: 実装する**

`src/lib/remind-select.ts`:

```ts
/**
 * 朝の知らせに載せるかどうかの判定（TASK_FOLLOWUP=1 のとき）。
 *
 * 今までは「未完了で、期日が明日まで」を毎朝すべて並べていた。
 * 「待ち」と返したものまで毎朝出るので、読まれなくなっていた。
 *   ・「次に確認する日」が先のものは出さない
 *   ・確認日が来たもの、入ったばかりのものは、期日が先でも出す
 */
export interface RemindRow {
  /** Notion の期日そのまま（"YYYY-MM-DD" か ISO 日時。無ければ ""） */
  dueDate: string;
  /** 次に確認する日（"YYYY-MM-DD"）。無ければ null */
  nextCheck: string | null;
  /** 登録した日（JST の "YYYY-MM-DD"） */
  createdDate: string;
}

export function shouldRemind(
  t: RemindRow,
  today: string,
  tomorrow: string,
  yesterday: string
): boolean {
  const check = t.nextCheck ? t.nextCheck.slice(0, 10) : null;
  if (check && check > today) return false;
  const due = t.dueDate.slice(0, 10);
  if (due && due <= tomorrow) return true;
  if (check) return true;
  return t.createdDate >= yesterday;
}

export function bucketOf(
  t: RemindRow,
  today: string,
  tomorrow: string
): "overdue" | "today" | "tomorrow" | "other" {
  const due = t.dueDate.slice(0, 10);
  if (!due || due > tomorrow) return "other";
  if (due < today) return "overdue";
  return due === today ? "today" : "tomorrow";
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx tsx tests/remind-select.test.ts`
Expected: `🎉 全て通過`。

- [ ] **Step 5: `notion.ts` の `getUpcomingTasks` を広げる**

シグネチャと戻り値の型に足す:

```ts
export async function getUpcomingTasks(opts: { followup?: boolean } = {}): Promise<
  Array<{
    id: string;
    title: string;
    dueDate: string;
    urgency: string;
    assignee: string | null;
    assigneeUserId: string | null;
    /** 「要確認」＝初動確認の回答待ち。リマインドで別枠に出して回答を促す */
    status: string;
    url: string;
    /** 次に確認する日（"YYYY-MM-DD"）。無ければ null */
    nextCheck: string | null;
    /** 状況（待ち相手・理由のひとこと）。無ければ "" */
    note: string;
    /** 登録した日（JST の "YYYY-MM-DD"） */
    createdDate: string;
  }>
> {
```

問い合わせを、`opts.followup` のときだけ広げる（`const response = await notion.databases.query({ … })` を置き換える）:

```ts
  const tomorrowStr = jstDateStr(1);
  const notDone = { property: "ステータス", select: { does_not_equal: "完了" } };
  const dueSoon = { property: "期日", date: { on_or_before: tomorrowStr } };

  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    sorts: [{ property: "期日", direction: "ascending" }],
    filter: opts.followup
      ? {
          and: [
            notDone,
            {
              or: [
                dueSoon,
                // 確認日が来たもの（待ちにしていたもの）
                { property: "次に確認する日", date: { on_or_before: jstDateStr(0) } },
                // 入ったばかりのもの（期日が先でも一度は知らせる）
                {
                  timestamp: "created_time",
                  created_time: { on_or_after: `${jstDateStr(-1)}T00:00:00+09:00` },
                },
              ],
            },
          ],
        }
      : { and: [dueSoon, notDone] },
  });
```

`return response.results.map((page) => { … })` の中で、返すオブジェクトに 3 項目を足す:

```ts
      nextCheck:
        (props["次に確認する日"] as { date: { start: string } | null } | undefined)
          ?.date?.start?.slice(0, 10) ?? null,
      note:
        (props["状況"] as { rich_text: Array<{ plain_text: string }> } | undefined)
          ?.rich_text?.map((r) => r.plain_text).join("") ?? "",
      createdDate: new Date(
        Date.parse((p.created_time as string) ?? "") + 9 * 60 * 60 * 1000
      )
        .toISOString()
        .slice(0, 10),
```

`created_time` が無い・読めないときに `Invalid Date` で落ちないよう、上の `createdDate` は次の形にする:

```ts
      createdDate: (() => {
        const ms = Date.parse((p.created_time as string) ?? "");
        return Number.isNaN(ms)
          ? ""
          : new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
      })(),
```

同じファイルの `setRemindNumber` の直後に足す:

```ts
// 今回の知らせに載せなかったタスクの番号を消す。
// 新しい知らせ方では期日が先のタスクにも番号が付くので、古い番号が残っていると
// 「3済」が別のタスクに当たる。知らせるたびに、載せた分以外の番号を消しておく。
export async function clearStaleRemindNumbers(keepIds: string[]): Promise<number> {
  const keep = new Set(keepIds);
  let cleared = 0;
  let cursor: string | undefined;
  do {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      start_cursor: cursor,
      filter: {
        and: [
          { property: "リマインド番号", number: { is_not_empty: true } },
          { property: "ステータス", select: { does_not_equal: "完了" } },
        ],
      },
    });
    for (const page of response.results) {
      if (keep.has(page.id)) continue;
      await notion.pages.update({
        page_id: page.id,
        properties: { リマインド番号: { number: null } },
      });
      cleared++;
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);
  return cleared;
}
```

- [ ] **Step 6: `remind.ts` の `sendDailyReminders` を変える**

import を足す:

```ts
import { clearStaleRemindNumbers } from "./notion";
import { bucketOf, shouldRemind } from "./remind-select";
import { followupEnabled } from "./task-status";
```

（`clearStaleRemindNumbers` は、既存の `./notion` からの import の並びに足してよい。）

`const tasks = await getUpcomingTasks();` から `const tomorrowTasks = …` までを、次に置き換える:

```ts
  // 期日が明日まで・未完了のタスク（期限超過を含む）を期日の古い順で取得。
  // 新しい知らせ方（TASK_FOLLOWUP=1）では、「待ち」を確認日まで外し、
  // 確認日が来たもの・入ったばかりのものを足す。
  const followup = followupEnabled();
  const tomorrowStr = jstDateStr(1);
  const fetched = await getUpcomingTasks({ followup });
  const tasks = followup
    ? fetched.filter((t) => shouldRemind(t, todayStr, tomorrowStr, jstDateStr(-1)))
    : fetched;
  if (tasks.length === 0) return;

  // 初動確認の回答待ち。期日の枠に混ぜず先頭に独立させる。
  // 混ぜると「担当者がやっていない」ように見えるが、実際は
  // **依頼者の回答が無くて着手できない**状態で、動かすべき人が違う。
  const pendingTasks = tasks.filter((t) => t.status === STATUS_PENDING);
  const actionable = tasks.filter((t) => t.status !== STATUS_PENDING);

  const bucket = (t: UpcomingTask) => bucketOf(t, todayStr, tomorrowStr);
  const overdueTasks = actionable.filter((t) => bucket(t) === "overdue");
  const todayTasks = actionable.filter((t) => bucket(t) === "today");
  const tomorrowTasks = actionable.filter((t) => bucket(t) === "tomorrow");
  // 期日が先・期日なし（確認日が来たもの／入ったばかりのもの）。off のあいだは常に空
  const otherTasks = actionable.filter((t) => bucket(t) === "other");
```

（元の `const tomorrowStr = jstDateStr(1);` と、元の `pendingTasks`〜`tomorrowTasks` の 5 行は、上の置き換えに含まれるので消す。off のときの `overdue`／`today`／`tomorrow` の振り分けは、元の `dueDateOnly(t) < todayStr` などと同じ結果になる。）

`push` の中で、状況を行に足す（`if (t.assignee && !t.assigneeUserId) …` の前）:

```ts
    if (t.note) text += `（待ち：${sanitizeForTextV2(t.note)}）`;
```

`if (tomorrowTasks.length > 0) { … }` の直後に足す:

```ts
  if (otherTasks.length > 0) {
    items.push({ text: `\n【確認する日が来たもの・新しく入ったもの】` });
    for (const t of otherTasks) {
      push(t, dueDateOnly(t) ? `期日 ${dueDateOnly(t).slice(5).replace("-", "/")}` : "期日なし");
    }
  }
```

`footer` を、スイッチで出し分ける:

```ts
  const footer =
    "\n\n──────────\n" +
    "終わったものは番号で返信してください\n" +
    "例：「3済」「1,2完了」「4おわった」" +
    (followup
      ? "\n相手待ち：「3待ち 売主の書類 金曜」\n期日を変える：「3延期 10/20」\nやらなくてよい：「3不要」"
      : "");
```

番号を振る行の前に、古い番号を消す（`await Promise.all(shown.map(…setRemindNumber…))` の直前）:

```ts
  if (followup) {
    await clearStaleRemindNumbers(shown.map((t) => t.id)).catch((e) =>
      console.error("[remind] 古い番号の掃除でエラー（続行）:", e)
    );
  }
```

- [ ] **Step 7: ほかの呼び出し元を確かめる**

Run: `grep -rn "getUpcomingTasks(" src scripts tests | grep -v "export async function"`
Expected: `src/lib/remind.ts` の 1 か所だけ。ほかに呼び出し元があれば、引数なし（今までの動き）のままで型が通ることを確かめる。

Run: `grep -rn "findTaskByRemindNumber(" src | grep -v "export async function"`
Expected: `route.ts`（②番号での完了。引数 1 つのまま＝今までの動き）と `task-status-wire.ts`。

`route.ts` の②（番号での完了）も、新しい知らせ方のときは期日が先のタスクを引けるようにする。`const t = await findTaskByRemindNumber(n);` を次に変える:

```ts
          const t = await findTaskByRemindNumber(n, { anyDue: followupEnabled() });
```

- [ ] **Step 8: 型・全テストを確かめる**

`package.json` の `"test"` の末尾に ` && tsx tests/remind-select.test.ts` を足す。

Run: `npx tsc --noEmit 2>&1 | tail -5; npm test 2>&1 | tail -3`
Expected: `tsc` は何も出さない。テストは終了コード 0。

- [ ] **Step 9: コミット**

```bash
git add src/lib/remind-select.ts src/lib/notion.ts src/lib/remind.ts src/app/api/webhook/route.ts tests/remind-select.test.ts package.json
git commit -m "feat: 朝の知らせで「待ち」を確認日まで出さず、確認日が来たもの・新着を足す（TASK_FOLLOWUP=1 のときだけ）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 完了に「終わり方」を残す・文書を合わせる

**Files:**
- Modify: `src/lib/notion.ts`（`completeTask`）
- Modify: `CLAUDE.md`（環境変数の節に `TASK_FOLLOWUP` を足す）
- Modify: `docs/運用.md`（止め方・戻し方）

**Interfaces:**
- Consumes: Task 2 `followupEnabled`, `closeProps`
- Produces: なし

- [ ] **Step 1: `completeTask` を変える**

```ts
export async function completeTask(pageId: string): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: followupEnabled()
      ? // 終わり方（完了／不要／重複）を残す。「不要」は状況の返事（3不要）が入れる
        (closeProps("完了") as Parameters<
          typeof notion.pages.update
        >[0]["properties"])
      : { ステータス: { select: { name: "完了" } } },
  });
}
```

`notion.ts` の先頭の import に足す:

```ts
import { closeProps, followupEnabled } from "./task-status";
```

`task-status.ts` は `notion.ts` を import していない（型だけ `task-status-command.ts` から取る）ので、循環しない。

- [ ] **Step 2: 型・全テストを確かめる**

Run: `npx tsc --noEmit 2>&1 | tail -5; npm test 2>&1 | tail -3`
Expected: `tsc` は何も出さない。テストは終了コード 0。

- [ ] **Step 3: `CLAUDE.md` の「環境変数」の節の末尾に足す**

```markdown
（タスクの追いかけ・2026-10-12）`TASK_FOLLOWUP`（`1` のときだけ動く。既定 off）。on にすると、
①「3待ち 売主の書類 金曜」「3延期 10/20」「3不要」の返事（番号つき）と、引用リプライの「待ち …」「延期 …」を受け付ける
（`src/lib/task-status-command.ts`＝読み取り／`task-status.ts`＝Notion の欄と返事／`task-status-wire.ts`＝本物へのつなぎ）、
② 朝のリマインドが「次に確認する日」が先のタスクを出さず、確認日が来たもの・前日から入ったものを足す（`src/lib/remind-select.ts`）、
③ 完了にしたとき「終わり方」を残す。
Notion「LINEタスク」の欄 `状況`・`次に確認する日`・`終わり方` を使う（10/12 に作成済み。消すと on のあいだ登録・更新が失敗する）。
off に戻せば今までの動き。on のあいだに付いた「待ち」は、off にすると毎朝のリマインドにまた出る（欄は残る）。
設計は `docs/superpowers/specs/2026-10-12-task-followup-pilot-design.md`。
```

あわせて、同じファイルの古い記述 2 か所を今の作りに直す:
- 「**メンション不要・文脈で自動判定**：全発言を…」→「**AI秘書へのメンションがタスク受付の入口**（2026-09-04〜）。メンションの無い発言は解析しない。`confidence >= TASK_CONFIDENCE_THRESHOLD`（既定0.7）のときだけ Notion 登録する。」
- 主要ファイルの表の `src/lib/remind.ts` の説明「日次リマインド（Prisma/SQLite参照）」→「日次リマインド（Notion 参照）」

- [ ] **Step 4: `docs/運用.md` に足す**

先に `docs/運用.md` の見出しの並びを読み、末尾に次の節を足す:

```markdown
## タスクの追いかけ（TASK_FOLLOWUP）

- 入れる：Vercel の環境変数に `TASK_FOLLOWUP=1` を足して再デプロイ（下村さんの承認後）。
- 止める：`TASK_FOLLOWUP` を外して再デプロイ。状況の返事（待ち・延期・不要）は受け付けなくなり、朝のリマインドは今までどおり全件を出す。Notion の欄と、入っている値はそのまま残る。
- 入れる前に確かめること：Notion「LINEタスク」に `状況`・`次に確認する日`・`終わり方` の 3 つの欄があること（無いと、on のあいだ状況の返事と完了が失敗する）。
- 入れた日の朝のリマインド：前日までに振った番号のうち、今回載せなかったタスクの番号を消す。古いリマインドの番号で「3済」と返すと「見つかりませんでした」になることがある（新しいリマインドの番号で返してもらう）。
```

- [ ] **Step 5: コミット**

```bash
git add src/lib/notion.ts CLAUDE.md docs/運用.md
git commit -m "feat: 完了に終わり方を残し、追いかけのスイッチの入れ方・止め方を文書にする

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## この計画のあと（下村さんの承認が要るもの）

1. 本番ツリー（`integration/email-and-media`）への取り込みと、Vercel へのデプロイ。
2. Vercel の環境変数 `TASK_FOLLOWUP=1` の追加（値を画面に出さない方法で）。
3. 入れた翌朝のリマインドを見て、「待ち」にしたタスクが出ていないこと・番号での返事が通ることを確かめる。

## 設計書との対応

| 設計書 | この計画 |
|---|---|
| 5 章「返し方の例」4 つ | 済＝既存、待ち・延期・不要＝Task 1〜3 |
| 5 章「引用リプライでも同じ言葉」 | Task 3（待ち・延期。不要は今までどおり取り消し） |
| 5 章「待ちは確認日まで出さない」「新しく入ったもの・確認日が来たもの」 | Task 4 |
| 5 章「番号での返信は期日が先のものにも効く」 | Task 2（`anyDue`）・Task 4（古い番号の掃除） |
| 5 章「人ごとにまとめ、多いときは上位だけ」 | **入れない**（Global Constraints の最後の行。全件を出す過去の判断を優先） |
| 5 章「日付を省いたら 3 営業日後」 | Task 3（3 日後。休業日なら翌営業日。週の定休日は休業日カレンダーに入っている分だけ効く） |
| 6 章の欄のうち `状況`・`次に確認する日`・`終わり方` | Task 2・4・5 |
| 10 章「スイッチで切れる」「帯替えの表で固定」 | Global Constraints・Task 1 |
| 4 章（入口）・7 章（ひも付け）・8 章（画面）・6 章の残りの欄 | 別の計画（②③④） |
