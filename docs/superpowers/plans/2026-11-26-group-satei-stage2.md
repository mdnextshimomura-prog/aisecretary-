# 普通のグループの査定依頼 段2 Implementation Plan（2a・2b の前半）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 段2の小段 2a（「何の依頼？」の8つのボタン・［査定］からの案件選び・押した表示）と、2b の前半（読み取りを広げる・足りない項目の決まり）を aisecretary に作る。あわせて、2d で使う「事例の期日」の関数（純粋関数）を先に作っておく。スイッチ `GROUP_SATEI_STAGE2` を入れるまで、段1の動きは1バイトも変わらない。

**Architecture:** 段1と同じく、判断の部分（`src/lib/group-satei-*.ts`。deps を受け取るだけ・通信しない）と本物へのつなぎ（`group-satei-wire.ts`）を分ける。新しいボタン `v1|gk|` は段1の振り分け（`parseGsData` → `handleGroupSateiPostback`）にそのまま乗るので、`task-buttons-wire.ts`・webhook には手を入れない。知らせのカードは `gsCard` に省略できる引数を1つ足し、スイッチ on のときだけ上の段に8つを出す。

**Tech Stack:** Next.js 14（App Router）・TypeScript・`@vercel/kv`（Upstash）・`@anthropic-ai/sdk`（claude-sonnet-4-6）・LINE Messaging API（Flex）。テストは `npx tsx tests/<名前>.test.ts`（通信は差し替え。外へ出ない）。

**Spec:** `docs/superpowers/specs/2026-11-25-group-satei-stage2-design.md`（16「決まったこと」1〜4 を含む）。前の段は `docs/superpowers/specs/2026-11-24-group-satei-intake-design.md`・`docs/superpowers/plans/2026-11-24-group-satei-intake-stage1.md`。

## Global Constraints

- スイッチ `GROUP_SATEI_STAGE2`（aisecretary。既定 off。`GROUP_SATEI=1` のときだけ意味を持つ）。off なら段1のまま1バイトも変えない（設計 12）。
- ほかの小段のスイッチ：`SATEI_AREA_RESEARCH`（line-secretary。既定 off）・`SATEI_PREP`（portal。既定 off）。入れる順は portal → Mac → aisecretary、止めるのは逆順（設計 12）。この計画で作るのは aisecretary の分だけ。
- 「何の依頼？」の8つと符号は設計 3 のとおり：［査定］`satei`・［資料を送る］`doc`・［書類の作成・チェック］`check`・［日程・内見］`sched`・［物件調査・謄本］`survey`・［振込・お金］`money`・［メール・電話］`mail`・［その他］`other`。data は `v1|gk|<ticketId>|<ver>|<符号>`。
- ボタンは下村さんの1対1だけ。グループには出さない（設計 3・9）。押せるのは `TASK_SATEI_USER_IDS` の人だけ（段1と同じ）。
- ［査定］以外の7つは**受付と記録だけ**（設計 16 の 3）。返事は「〈種類〉として控えました。中身は手作業でお願いします」。
- 決めるのは受付票ごとに最初の1回（段1の `gsatei:dec:<id>` を使う）（設計 3）。
- 押したボタンの表示は「（ボタン）【件名】操作」（`pressedText`。設計 9）。
- 事例の期日：［いいよ］が JST 17:00 より前なら当日 18:00、17:00 以降なら次の営業日の 18:00。火曜・水曜は休みで飛ばす。土日は営業日（設計 16 の 2）。
- 山口さんへの依頼は、依頼が来たグループに出す（設計 16 の 1）。Mac とのやり取りは portal を通す（設計 16 の 4）。
- KV・ログには ID・時刻・種類・符号だけ。ログに LINE の ID・本文・物件名・案件名を出さない。ログの形は `[group-satei] gk kind doc G7` のように符号と受付番号だけ（設計 13・CLAUDE.md）。
- お客様の名前は読まない・残さない（設計 4）。読み取りの欄にも名前を入れない（`scrubNames`）。
- AI の呼び出しは増やさない（2b は同じ1回の読み取りで欄を足す。設計 4）。
- 本物の LINE・Notion・portal・Anthropic はテストで呼ばない（各テストの先頭で `globalThis.fetch` を「外へ出てはいけない」に差し替える）。
- `prisma generate` は流さない。`.env`・`.env.local` は読まない。push・deploy・本番の env の追加はしない（小段ごとに下村さんの承認後に別途）。
- コミットは `type: 日本語` の形。本文に理由を1〜3行。最後の行は `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## 段2の小段（全体の見取り図）

| 小段 | 中身 | 主な場所 | この計画 | 前提（分かっていないこと） |
|---|---|---|---|---|
| 2a | 8つのボタン（記録だけ）＋［査定］から案件選び＋押した表示 | aisecretary | **全部**（Task 2〜6） | なし |
| 2b | 読み取りを広げる（面積・築年など）＋足りなければ聞く | aisecretary | **前半**（Task 7〜9：読み取り・足りない項目の決まり・聞く文と答えの読み方）。聞く仕組みは 2d と一緒 | なし（聞く時期は下の R5） |
| 2c | 地域の調べ（住所・地番だけで公開データ）＋ゼンリン・登記の知らせ | line-secretary（Mac） | 作らない（別の計画） | 不動産情報ライブラリの API 鍵が Mac にあるか／幅員を Web で取れる市の範囲 |
| 2d | 事例の相談［いいよ］［直す］＋山口さんへの依頼カード＋リマインド | portal・Mac・aisecretary | 期日の関数だけ先に（Task 1） | 山口さんの LINE userId（env `GROUP_SATEI_CASE_STAFF_ID`）／portal の依頼箱の `prep` の種類／`POST /api/satei/propose`・`POST /api/satei/case-request` の約束／LINE の月の送信枠 |
| 2e | 事例 PDF の取り出しと保存 → 今の下書きへ | aisecretary・Mac | 作らない | 本物の LINE でグループの PDF を取り出せるか／`POST /api/satei/media` の約束 |
| 2f | 同じ件の知らせが2通になる件（photo-ask と予約を共有）・送れなかったカードの送り直し | aisecretary | 作らない | なし |

各小段で：テストを先に書く → worktree で作る → レビュー → 下村さんの承認 → 本番 → 本物の依頼で確かめる（設計 15）。2c〜2f は、前提が分かってから小段ごとに計画を書く。

## この計画で決めたこと（Ruling。設計に書いていない細部）

- R1 ［査定］は `gsatei:dec` の印を**取らない**。取ると、そのあとの案件選び（`gs`）が「選択済みです」で止まるため。［査定］は受付票に `requestKind: "satei"` を書き（`asking` のまま）、「一覧から選ぶ／案件がまだ無い」のカードを返す（前のカードの候補ボタンも同じ版なのでそのまま押せる）。印を取るのは、7つのボタン（値 `gk:<符号>`）と段1の gs・gn。— 違っていた場合の費用：［査定］を押した時点で閉じる作りに変えるだけ。
- R2 7つのボタンは受付票に印だけ残し、状態は段1の `manual`（手作業）にする。LINEタスク の `種別の依頼` には**まだ書かない**：その欄が Notion に無く（コードにも無い）、受付票はタスクのページ ID を持っていない（入口 B はタスクを作らない、入口 A も ID を控えていない）ため。欄ができたら別の小さな計画で足す（下の「前提」）。
- R3 設計 10 の新しい状態（`kind`・`gathering`・`asking-info`・`proposing`・`waiting-cases`・`saving`・`expired`）は、2a では足さない。種類は `requestKind` の欄で持ち、状態は段1の `asking`／`started`／`manual`／`dismissed` のまま。新しい状態は、使う小段（2b の聞く仕組み・2d）で足す。
- R4 カードの上の段：AI の見立ては1段まるごとの色つき（`primary`・`#1565C0`）、残り7つは2つずつ横に並べる。段1の入口は査定らしいものだけを拾うので、見立てはいつも［査定］（設計 3）。段1の［査定の依頼ではない］（gn）は下の段に残す（［その他］と役目が近いが、段1の押し方を変えない）。
- R5 2b の「足りなければ聞く」は、この計画では決まり（どれが足りないか）・聞く文・答えの読み方だけ作り、聞く仕組み（`gsatei:ask:<userId>` の印・1対1の文字の取り込み・［分からない］のボタン）は 2d と一緒に作る。今は案件を選ぶとすぐ portal の受付（段1）へ進むので、聞いた答えを使う先（2d の「準備」の依頼）がまだ無いため。
- R6 期日の表示は「11/26（木）18時」の形（設計の例「11/26 18時」に曜日を足す。火・水を飛ばしたことが分かるように）。祝日・年末年始は扱わない（設計に無い。決まったら休みの日の表を足す）。17:00 ちょうどは「17時以降」に入れる。
- R7 期日の関数は aisecretary に置く（`src/lib/group-satei-deadline.ts`）。［いいよ］は下村さんの1対1のボタン＝aisecretary の postback で押されるので、押した時刻で期日を決めて portal 経由で Mac に渡す（2d）。
- R8 2b の読み取りは、スイッチ on のときだけ別の指示文（`GS_READ_PROMPT_V2`）を使う。段1の指示文は1字も変えない。物件名は段1と同じ「マンション名と号室」のまま（案件の候補の探し方を変えないため）で、号室は別の欄にも読む。

## 前提（分かっていないこと。推測で埋めない）

- 山口さんの LINE userId（env `GROUP_SATEI_CASE_STAFF_ID`）：2d の前に下村さんに確かめる（名簿にあるか）。
- 不動産情報ライブラリの API 鍵が Mac にあるか：2c の前に確かめる（MCP は Claude 側で使えている）。
- portal の新しい口（依頼箱の `prep`、aisecretary の `POST /api/satei/propose`・`/api/satei/case-request`・`/api/satei/media`）は、まだどこにも無い。2d・2e の前に、受け渡しの約束（契約の文書）を先に書く。
- Notion「LINEタスク」の `種別の依頼` の欄：まだ無い。作るか（セレクトの選択肢は8つの言葉）を下村さんに確かめる（R2）。
- 本物の LINE でグループの PDF を取り出せるか・LINE の月の送信枠：2d・2e の前に確かめる。
- 手元の `npm test` は、この枝の作り始めの時点で `tests/candidate-card.test.ts` の4件が落ちて止まる（この計画とは関係ない。下の「確かめ方」）。

## 確かめ方（全部のタスクで共通）

`npm test` は `&&` でつないであり、途中の `tests/candidate-card.test.ts`（4件。作り始めの時点で落ちている・この計画の変更とは関係ない）で止まる。そのため、各タスクでは自分のテストを1本ずつ流し、最後に次の2つを流す：

```bash
for f in tests/group-satei-*.test.ts; do npx tsx "$f" > /dev/null || echo "FAIL $f"; done
npx tsc --noEmit -p .
```

Expected：`FAIL` の行が1つも出ない。`tsc` は何も出さずに終わる（作り始めの時点で 0 件）。

## ファイルの地図

| ファイル | 役割 | タスク |
|---|---|---|
| `src/lib/group-satei-deadline.ts`（新） | 事例の期日（純粋関数）と表示 | 1 |
| `src/lib/group-satei-data.ts` | スイッチ `groupSateiStage2On`・8つの符号・`encodeGsKind`・受付票の `requestKind`・`gk` の data の読み方・`GsFacts` | 2・4・7 |
| `src/lib/group-satei-card.ts` | カードの上の段（8つ）・［査定］のあとのカード・返事の文 | 3 |
| `src/lib/group-satei-actions.ts` | `gk` の処理（［査定］／7つ）・案件選びで `requestKind` を残す | 4 |
| `src/lib/group-satei-open.ts` | 知らせのカードに8つを出す（スイッチ on のときだけ） | 5 |
| `src/lib/group-satei-read.ts` | 読み取りを広げる（V2 の指示文・欄の読み方） | 7 |
| `src/lib/group-satei-wire.ts` | 本物の読み取りに V2 を渡す（スイッチ on のときだけ） | 7 |
| `src/lib/group-satei-facts.ts`（新） | 足りない項目の決まり・聞く文・答えの読み方 | 8 |
| `tests/group-satei-deadline.test.ts`・`-kind.test.ts`・`-kind-card.test.ts`・`-kind-actions.test.ts`・`-kind-open.test.ts`・`-read-v2.test.ts`・`-facts.test.ts`（新） | 各タスクのテスト | 1〜8 |
| `package.json` | `test` の最後に新しいテストを足す | 1〜8 |
| `CLAUDE.md` | 段2の節を足す | 6・9 |

---

### Task 1: 事例の期日の関数（2d の土台・純粋関数）

**Files:**
- Create: `src/lib/group-satei-deadline.ts`
- Create: `tests/group-satei-deadline.test.ts`
- Modify: `package.json`（`test` の最後）

**Interfaces:**
- Consumes: なし
- Produces: `gsCaseDeadline(pressedAt: number): number`（epoch ミリ秒 → 期日の epoch ミリ秒。数でなければ `RangeError`）、`gsDeadlineLabel(deadline: number): string`（「12/3（木）18時」）、定数 `GS_CLOSE_HOUR = 18`・`GS_CUTOFF_HOUR = 17`・`GS_CLOSED_DAYS = [2, 3]`。2d のグループの依頼カード・リマインド・portal への受け渡しが使う。

- [ ] **Step 1: 落ちるテストを書く**

`tests/group-satei-deadline.test.ts`：

```ts
/** group-satei-deadline.ts（純粋関数。時計は使わない） */
import assert from "node:assert/strict";
import { gsCaseDeadline, gsDeadlineLabel } from "../src/lib/group-satei-deadline";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
/** JST の壁時計の時刻 → epoch ミリ秒 */
const jst = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi);

// 2026-11-26 は木曜。12/1 が火曜、12/2 が水曜
t("木 10:00 → その日の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 11, 26, 10)), jst(2026, 11, 26, 18)));
t("木 16:59 → その日の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 11, 26, 16, 59)), jst(2026, 11, 26, 18)));
t("木 17:00 ちょうど → 次の日（金）の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 11, 26, 17)), jst(2026, 11, 27, 18)));
t("木 23:59 → 金の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 11, 26, 23, 59)), jst(2026, 11, 27, 18)));
t("金 0:30（UTC では木）→ 金の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 11, 27, 0, 30)), jst(2026, 11, 27, 18)));
t("土 17:30 → 日の 18時（土日は営業日）", () => assert.equal(gsCaseDeadline(jst(2026, 11, 28, 17, 30)), jst(2026, 11, 29, 18)));
t("日 9:00 → その日の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 11, 29, 9)), jst(2026, 11, 29, 18)));
t("月 17:00 → 火・水を飛ばして木の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 11, 30, 17)), jst(2026, 12, 3, 18)));
t("火 8:00（休み）→ 木の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 12, 1, 8)), jst(2026, 12, 3, 18)));
t("水 16:00（休み）→ 木の 18時", () => assert.equal(gsCaseDeadline(jst(2026, 12, 2, 16)), jst(2026, 12, 3, 18)));
t("表示の形", () => {
  assert.equal(gsDeadlineLabel(jst(2026, 12, 3, 18)), "12/3（木）18時");
  assert.equal(gsDeadlineLabel(jst(2026, 11, 29, 18)), "11/29（日）18時");
});
t("数でない時刻は例外", () => assert.throws(() => gsCaseDeadline(Number.NaN), RangeError));
t("2週間を15分おき：いつも未来・18時・火水でない・押してから4日未満", () => {
  for (let at = jst(2026, 11, 23, 0); at < jst(2026, 12, 7, 0); at += 15 * 60_000) {
    const d = gsCaseDeadline(at);
    const w = new Date(d + 9 * 3600_000);
    assert.ok(d > at, String(at));
    assert.equal(w.getUTCHours(), 18);
    assert.equal(w.getUTCMinutes(), 0);
    assert.ok(![2, 3].includes(w.getUTCDay()), String(at));
    assert.ok(d - at < 4 * 24 * 3600_000, String(at));
  }
});
console.log(`group-satei-deadline: ${n} ok`);
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx tsx tests/group-satei-deadline.test.ts`
Expected: FAIL（`Cannot find module '../src/lib/group-satei-deadline'`）

- [ ] **Step 3: 作る**

`src/lib/group-satei-deadline.ts`：

```ts
/**
 * 段2：山口さんに頼む事例の期日（設計 2026-11-25-group-satei-stage2-design.md の 16「決まったこと」2）。通信はしない。
 * - ［いいよ］を押した時刻が、営業日（火・水以外。土日は営業日）の JST 17:00 より前 → その日の 18:00。
 * - 17:00 ちょうど以降・火・水に押した → 次の営業日の 18:00。
 * - 祝日・年末年始は扱わない（設計に無い。決まったら GS_CLOSED_DAYS とは別の表で足す）。
 * 戻り値はミリ秒（UTC の epoch）。表示は gsDeadlineLabel。
 */
export const GS_CLOSE_HOUR = 18;
export const GS_CUTOFF_HOUR = 17;
/** 休みの曜日（0=日 … 6=土）。火・水 */
export const GS_CLOSED_DAYS: readonly number[] = [2, 3];

const JST_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** JST の壁時計の 0:00（UTC の欄で読む値）がその曜日か */
const isBusinessDay = (jstMidnight: number) => !GS_CLOSED_DAYS.includes(new Date(jstMidnight).getUTCDay());

export function gsCaseDeadline(pressedAt: number): number {
  if (!Number.isFinite(pressedAt)) throw new RangeError("pressedAt");
  const local = pressedAt + JST_MS;
  let day = Math.floor(local / DAY_MS) * DAY_MS;
  const minutes = Math.floor((local - day) / 60_000);
  if (!(isBusinessDay(day) && minutes < GS_CUTOFF_HOUR * 60)) {
    do day += DAY_MS;
    while (!isBusinessDay(day));
  }
  return day + GS_CLOSE_HOUR * 60 * 60 * 1000 - JST_MS;
}

/** 「11/26（木）18時」の形（グループの依頼カード・リマインド・下村さんへの相談に使う） */
export function gsDeadlineLabel(deadline: number): string {
  const d = new Date(deadline + JST_MS);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAYS[d.getUTCDay()]}）${d.getUTCHours()}時`;
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx tsx tests/group-satei-deadline.test.ts`
Expected: PASS（最後の行 `group-satei-deadline: 13 ok`）

- [ ] **Step 5: テストの一覧に足す**

`package.json` の `"test"` の最後を置き換える。

置き換え前：`tsx tests/group-satei-reread.test.ts"`
置き換え後：`tsx tests/group-satei-reread.test.ts && tsx tests/group-satei-deadline.test.ts"`

- [ ] **Step 6: コミット**

```bash
git add src/lib/group-satei-deadline.ts tests/group-satei-deadline.test.ts package.json
git commit -m "feat: 段2の事例の期日（17時より前は当日18時・火水は休み）の関数を足す

山口さんへの依頼カードとリマインドで使う。［いいよ］を押す aisecretary の側で決めて portal へ渡すため、ここに置く。
まだどこからも呼ばない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: スイッチ・8つの符号・受付票の欄

**Files:**
- Modify: `src/lib/group-satei-data.ts`
- Create: `tests/group-satei-kind.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: 既存の `groupSateiActive(env)`・`GsTicket`・`asTicket`
- Produces: `groupSateiStage2On(env?: GsEnv): boolean`、`type GsReqKind = "satei" | "doc" | "check" | "sched" | "survey" | "money" | "mail" | "other"`、`GS_REQ_KINDS: ReadonlyArray<{ code: GsReqKind; label: string }>`、`isGsReqKind(x: unknown): x is GsReqKind`、`gsReqLabel(code: GsReqKind): string`、`encodeGsKind(tid: string, ver: number, code: GsReqKind): string`、`GsTicket.requestKind?: GsReqKind`

- [ ] **Step 1: 落ちるテストを書く**

`tests/group-satei-kind.test.ts`：

```ts
/** 段2a：「何の依頼？」の8つ（group-satei-data.ts・group-satei-card.ts） */
import assert from "node:assert/strict";
import {
  asTicket, encodeGsKind, GS_REQ_KINDS, groupSateiStage2On, gsReqLabel, isGsReqKind, ticketIdOf, type GsTicket,
} from "../src/lib/group-satei-data";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const tid = ticketIdOf("m1");
const base: GsTicket = { no: 7, ver: 1, groupId: "C" + "a".repeat(32), requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], read: null, state: "asking" };

t("スイッチ：GROUP_SATEI と GROUP_SATEI_STAGE2 の両方が 1 のときだけ", () => {
  assert.equal(groupSateiStage2On({ GROUP_SATEI: "1", GROUP_SATEI_STAGE2: "1" }), true);
  assert.equal(groupSateiStage2On({ GROUP_SATEI: "1" }), false);
  assert.equal(groupSateiStage2On({ GROUP_SATEI_STAGE2: "1" }), false);
  assert.equal(groupSateiStage2On({ GROUP_SATEI: "1", GROUP_SATEI_STAGE2: "true" }), false);
});
t("8つの符号と言葉（設計 3 のとおり）", () => {
  assert.deepEqual(GS_REQ_KINDS.map((k) => k.code), ["satei", "doc", "check", "sched", "survey", "money", "mail", "other"]);
  assert.deepEqual(GS_REQ_KINDS.map((k) => k.label), ["査定", "資料を送る", "書類の作成・チェック", "日程・内見", "物件調査・謄本", "振込・お金", "メール・電話", "その他"]);
  assert.equal(gsReqLabel("survey"), "物件調査・謄本");
  assert.equal(isGsReqKind("doc"), true);
  assert.equal(isGsReqKind("DOC"), false);
  assert.equal(isGsReqKind(1), false);
});
t("data の形：v1|gk|<受付票>|<版>|<符号>", () => {
  assert.equal(encodeGsKind(tid, 3, "money"), `v1|gk|${tid}|3|money`);
});
t("受付票：requestKind は無い・知っている符号なら読める、知らない符号は壊れた票として読まない", () => {
  assert.ok(asTicket(base));
  assert.equal(asTicket({ ...base, requestKind: "doc" })?.requestKind, "doc");
  assert.equal(asTicket({ ...base, requestKind: "x" }), null);
});
console.log(`group-satei-kind: ${n} ok`);
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx tsx tests/group-satei-kind.test.ts`
Expected: FAIL（`groupSateiStage2On` などが export されていない。tsx では `... is not a function` か SyntaxError）

- [ ] **Step 3: 作る**

`src/lib/group-satei-data.ts` の `groupSateiOn` の直後（`export const GS_TICKET_TTL` の前）に足す：

```ts
/** 段2（設計 2026-11-25 の 12）。GROUP_SATEI も on のときだけ。off なら段1のまま */
export const groupSateiStage2On = (env: GsEnv = process.env) => groupSateiActive(env) && env.GROUP_SATEI_STAGE2 === "1";

/** 段2：「何の依頼？」の8つ（設計 3。並びはこの順。AI の見立ては先頭に出す） */
export type GsReqKind = "satei" | "doc" | "check" | "sched" | "survey" | "money" | "mail" | "other";
export const GS_REQ_KINDS: ReadonlyArray<{ code: GsReqKind; label: string }> = [
  { code: "satei", label: "査定" },
  { code: "doc", label: "資料を送る" },
  { code: "check", label: "書類の作成・チェック" },
  { code: "sched", label: "日程・内見" },
  { code: "survey", label: "物件調査・謄本" },
  { code: "money", label: "振込・お金" },
  { code: "mail", label: "メール・電話" },
  { code: "other", label: "その他" },
];
export const isGsReqKind = (x: unknown): x is GsReqKind => typeof x === "string" && GS_REQ_KINDS.some((k) => k.code === x);
export const gsReqLabel = (code: GsReqKind): string => GS_REQ_KINDS.find((k) => k.code === code)?.label ?? "その他";
export const encodeGsKind = (tid: string, ver: number, code: GsReqKind) => `v1|gk|${tid}|${ver}|${code}`;
```

`GsTicket` の最後の欄（`rereads?: number;`）の後ろに足す：

```ts
  /** 段2：押された「何の依頼？」の符号（GROUP_SATEI_STAGE2 on のときだけ書く） */
  requestKind?: GsReqKind;
```

`asTicket` の `if (r.pushed !== undefined && typeof r.pushed !== "boolean") return null;` の次の行に足す：

```ts
  if (r.requestKind !== undefined && !isGsReqKind(r.requestKind)) return null;
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx tsx tests/group-satei-kind.test.ts && npx tsx tests/group-satei-data.test.ts`
Expected: PASS（`group-satei-kind: 4 ok`。段1の `group-satei-data` も通る）

- [ ] **Step 5: テストの一覧に足す**

置き換え前：`tsx tests/group-satei-deadline.test.ts"`
置き換え後：`tsx tests/group-satei-deadline.test.ts && tsx tests/group-satei-kind.test.ts"`

- [ ] **Step 6: コミット**

```bash
git add src/lib/group-satei-data.ts tests/group-satei-kind.test.ts package.json
git commit -m "feat: 段2のスイッチと「何の依頼？」の8つの符号を足す

GROUP_SATEI_STAGE2（既定 off）と、ボタンの data v1|gk| の形、受付票の requestKind の欄。
まだどこからも使わないので、動きは変わらない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: カードの上の段（8つ）と［査定］のあとのカード

**Files:**
- Modify: `src/lib/group-satei-card.ts`
- Create: `tests/group-satei-kind-card.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2 の `encodeGsKind`・`GS_REQ_KINDS`・`GsReqKind`、既存の `pressedText`・`encodeGsList`・`encodeGsManual`・`receiptOf`
- Produces: `gsCard(tid, ver, cands, dealsFailed, no?, opt?: { guess?: GsReqKind }): FlexMessage`（`opt` が無い・`guess` が無いときは段1と同じ JSON）、`gsKindOrder(guess: GsReqKind)`、`gsKindSection(tid, ver, no, guess)`、`gsSateiNextCard(tid: string, ver: number, no: number): FlexMessage`、`GS_GUESS_COLOR = "#1565C0"`、`msgGsKindSatei(no: number): string`、`msgGsKindRecorded(no: number, label: string): string`

- [ ] **Step 1: 落ちるテストを書く**

`tests/group-satei-kind-card.test.ts`：

```ts
/** 段2a：カードの上の段（8つ）と［査定］のあとのカード（group-satei-card.ts） */
import assert from "node:assert/strict";
import { parseGsData, ticketIdOf } from "../src/lib/group-satei-data";
import { gsCard, gsKindOrder, gsSateiNextCard, GS_GUESS_COLOR, msgGsKindRecorded, msgGsKindSatei } from "../src/lib/group-satei-card";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const tid = ticketIdOf("m1");
const D1 = { id: "0123abcd0123456789ab0123456789ab", name: "テスト町1丁目", phase: "査定" };
const allButtons = (c: any): any[] => {
  const out: any[] = [];
  const walk = (x: any) => {
    if (!x || typeof x !== "object") return;
    if (x.type === "button") out.push(x);
    for (const v of Object.values(x)) if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") walk(v);
  };
  walk(c);
  return out;
};
t("段1のカード（opt なし）は今と同じ：上の段は無く、本文は案内1行だけ", () => {
  const c = gsCard(tid, 1, [{ deal: D1, kind: "戸建" }], false, 7);
  assert.equal((c.contents as any).body.contents.length, 1);
  assert.ok(!JSON.stringify(c).includes("v1|gk|"));
  assert.equal(JSON.stringify(c), JSON.stringify(gsCard(tid, 1, [{ deal: D1, kind: "戸建" }], false, 7, undefined)));
  assert.equal(JSON.stringify(c), JSON.stringify(gsCard(tid, 1, [{ deal: D1, kind: "戸建" }], false, 7, {})));
});
t("段2のカード：上の段に8つ（見立てが先頭・色つき）、下の段は段1と同じ", () => {
  const one = gsCard(tid, 1, [{ deal: D1, kind: "戸建" }], false, 7);
  const two = gsCard(tid, 1, [{ deal: D1, kind: "戸建" }], false, 7, { guess: "satei" });
  assert.deepEqual((two.contents as any).footer, (one.contents as any).footer);
  const kinds = allButtons((two.contents as any).body);
  assert.equal(kinds.length, 8);
  assert.equal(kinds[0].action.data, `v1|gk|${tid}|1|satei`);
  assert.equal(kinds[0].style, "primary");
  assert.equal(kinds[0].color, GS_GUESS_COLOR);
  assert.ok(kinds.slice(1).every((b) => b.style === "secondary" && b.color === undefined));
  assert.equal(kinds[1].action.displayText, "（ボタン）【受付 G7】資料を送る");
  assert.ok(JSON.stringify(two).length < 30_000);
});
t("見立てが別の種類なら、それが先頭（残りは設計の順）", () => {
  assert.deepEqual(gsKindOrder("money").map((k) => k.code), ["money", "satei", "doc", "check", "sched", "survey", "mail", "other"]);
});
t("［査定］のあとのカード：一覧から選ぶ・案件がまだ無い", () => {
  const c = gsSateiNextCard(tid, 2, 7);
  const ops = allButtons(c.contents).map((b) => parseGsData(b.action.data)?.op);
  assert.deepEqual(ops, ["gl", "gm"]);
  assert.match(allButtons(c.contents)[0].action.displayText, /【受付 G7】一覧から選ぶ/);
});
t("返事の文", () => {
  assert.equal(msgGsKindRecorded(7, "振込・お金"), "振込・お金として控えました。中身は手作業でお願いします（受付 G7）");
  assert.equal(msgGsKindSatei(7), "査定で進めます。どの案件か選んでください（受付 G7）");
});
console.log(`group-satei-kind-card: ${n} ok`);
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx tsx tests/group-satei-kind-card.test.ts`
Expected: FAIL（`gsKindOrder`・`gsSateiNextCard` などが無い）

- [ ] **Step 3: 作る**

`src/lib/group-satei-card.ts` の先頭の import を置き換える。

置き換え前：

```ts
import {
  encodeGsList, encodeGsManual, encodeGsNone, encodeGsPick, GS_PAGE, GS_SURE, receiptOf, type GsRead,
} from "./group-satei-data";
```

置き換え後：

```ts
import {
  encodeGsKind, encodeGsList, encodeGsManual, encodeGsNone, encodeGsPick, GS_PAGE, GS_REQ_KINDS, GS_SURE, receiptOf,
  type GsRead, type GsReqKind,
} from "./group-satei-data";
```

`export function gsCard(...)` の行を、次の関数たちと新しい `gsCard` の頭に置き換える。

置き換え前：

```ts
export function gsCard(tid: string, ver: number, cands: GsCandidate[], dealsFailed: boolean, no?: number): FlexMessage {
```

置き換え後：

```ts
/** 段2：AI の見立てのボタンの色（ほかのボタンと見分ける） */
export const GS_GUESS_COLOR = "#1565C0";

/** 段2：「何の依頼？」の並び。見立てを先頭に、残りは設計 3 の順 */
export function gsKindOrder(guess: GsReqKind): Array<{ code: GsReqKind; label: string }> {
  return [...GS_REQ_KINDS.filter((k) => k.code === guess), ...GS_REQ_KINDS.filter((k) => k.code !== guess)];
}

function kindButton(tid: string, ver: number, subject: string | null, k: { code: GsReqKind; label: string }, guess: boolean) {
  return {
    type: "button",
    style: guess ? "primary" : "secondary",
    ...(guess ? { color: GS_GUESS_COLOR } : {}),
    height: "sm",
    flex: 1,
    action: {
      type: "postback",
      label: cut(k.label, FLEX_LABEL_MAX),
      data: encodeGsKind(tid, ver, k.code),
      displayText: cut(pressedText(k.label, subject), POSTBACK_TEXT_MAX),
    },
  };
}

/** 段2：カードの上の段。見立ては1段まるごと（色つき）、残り7つは2つずつ並べる */
export function gsKindSection(tid: string, ver: number, no: number | undefined, guess: GsReqKind): Array<Record<string, unknown>> {
  const subj = no !== undefined ? `受付 ${receiptOf(no)}` : null;
  const [head, ...rest] = gsKindOrder(guess);
  const rows: Array<Record<string, unknown>> = [
    { type: "box", layout: "horizontal", contents: [kindButton(tid, ver, subj, head, true)] },
  ];
  for (let i = 0; i < rest.length; i += 2) {
    rows.push({
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      contents: rest.slice(i, i + 2).map((k) => kindButton(tid, ver, subj, k, false)),
    });
  }
  return [small("何の依頼ですか？", "#333333"), ...rows, { type: "separator", margin: "md" }];
}

/** opt.guess があるときだけ（段2）上の段に「何の依頼？」の8つを足す。無ければ段1と同じ JSON */
export function gsCard(
  tid: string,
  ver: number,
  cands: GsCandidate[],
  dealsFailed: boolean,
  no?: number,
  opt?: { guess?: GsReqKind },
): FlexMessage {
```

同じ `gsCard` の中の本文（body）を置き換える。

置き換え前：

```ts
      body: { type: "box", layout: "vertical", spacing: "sm", contents: [small(guide, "#333333")] },
```

置き換え後：

```ts
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [...(opt?.guess ? gsKindSection(tid, ver, no, opt.guess) : []), small(guide, "#333333")],
      },
```

`export const MSG_GS_PAUSED = "いまは止めています";` の直前に足す：

```ts
/** 段2：［査定］を押したあとのカード（案件を選ぶ道。候補は前のカードのボタンがそのまま使える） */
export function gsSateiNextCard(tid: string, ver: number, no: number): FlexMessage {
  const subj = `受付 ${receiptOf(no)}`;
  return {
    type: "flex",
    altText: cut(`査定で進めます：どの案件か選んでください（${receiptOf(no)}）`, ALT_TEXT_MAX),
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "sm", contents: [small("前のカードの候補から選ぶか、一覧から選んでください", "#333333")] },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          button("一覧から選ぶ", encodeGsList(tid, ver, 0), subj, true),
          button("案件がまだ無い（手作業で査定）", encodeGsManual(tid, ver), subj),
        ],
      },
    },
  };
}

export const msgGsKindSatei = (no: number) => `査定で進めます。どの案件か選んでください（受付 ${receiptOf(no)}）`;
export const msgGsKindRecorded = (no: number, label: string) =>
  `${label}として控えました。中身は手作業でお願いします（受付 ${receiptOf(no)}）`;
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx tsx tests/group-satei-kind-card.test.ts && npx tsx tests/group-satei-card.test.ts`
Expected: PASS（`group-satei-kind-card: 5 ok`。段1の `group-satei-card: 9 ok` も変わらない）

- [ ] **Step 5: テストの一覧に足す**

置き換え前：`tsx tests/group-satei-kind.test.ts"`
置き換え後：`tsx tests/group-satei-kind.test.ts && tsx tests/group-satei-kind-card.test.ts"`

- [ ] **Step 6: コミット**

```bash
git add src/lib/group-satei-card.ts tests/group-satei-kind-card.test.ts package.json
git commit -m "feat: 査定の依頼カードの上の段に「何の依頼？」の8つを出せるようにする

見立て（いつもは［査定］）を先頭・色つきにし、残り7つを2つずつ並べる。引数を渡さなければ段1と同じ JSON。
［査定］を押したあとの「一覧から選ぶ／案件がまだ無い」のカードと返事の文も足す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: ボタン `gk` の処理（［査定］／記録だけの7つ）

**Files:**
- Modify: `src/lib/group-satei-data.ts`（`GsAction`・`parseGsData`）
- Modify: `src/lib/group-satei-actions.ts`
- Create: `tests/group-satei-kind-actions.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2 の `groupSateiStage2On`・`isGsReqKind`・`gsReqLabel`、Task 3 の `gsSateiNextCard`・`msgGsKindSatei`・`msgGsKindRecorded`
- Produces: `GsAction` に `{ op: "gk"; tid: string; ver: number; code: GsReqKind }`。`parseGsData("v1|gk|<tid>|<ver>|<符号>")` がそれを返す。`handleGroupSateiPostback` が gk を処理する（シグネチャは変えない）。印 `gsatei:dec:<tid>` の新しい値 `gk:<符号>`。

- [ ] **Step 1: 落ちるテストを書く**

`tests/group-satei-kind-actions.test.ts`：

```ts
/** 段2a：「何の依頼？」のボタン（gk）の処理（group-satei-actions.ts。KV・portal・LINE は差し替え） */
import assert from "node:assert/strict";
import { handleGroupSateiPostback, type GsActionDeps } from "../src/lib/group-satei-actions";
import { asTicket, gsDecKey, gsTicketKey, parseGsData, ticketIdOf, type GsAction, type GsTicket } from "../src/lib/group-satei-data";
import type { SateiDeal } from "../src/lib/satei-deal";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const OTHER = "U" + "c".repeat(32);
const G = "C" + "a".repeat(32);
const DB = "9999abcd0123456789ab0123456789ab";
const DEAL = "0123abcd0123456789ab0123456789ab";
const tid = ticketIdOf("m1");
const base: GsTicket = { no: 7, ver: 1, groupId: G, requesterId: OTHER, at: 1, triggerMsgIds: ["m1"], mediaIds: [], read: null, state: "asking" };
const ON = { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, GROUP_SATEI_STAGE2: "1" };
const OFF = { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G };
const deal: SateiDeal = { id: DEAL, name: "テスト", dealNo: 12, folderId: "folder_abcdefghij", propertyIds: ["p"], gone: false, parentDbId: DB };

function mk(o: { env?: Record<string, string>; ticket?: Partial<GsTicket> } = {}) {
  const m = new Map<string, unknown>();
  m.set(gsTicketKey(tid), { ...base, ...(o.ticket ?? {}) });
  const replies: Array<{ text: string; card?: unknown }> = [];
  const intakes: unknown[] = [];
  const logs: string[] = [];
  const done = new Set<string>();
  const deps: GsActionDeps = {
    env: o.env ?? ON,
    kv: {
      get: async (k) => m.get(k) ?? null,
      set: async (k, v) => { m.set(k, v); },
      setNx: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
      incr: async () => 1, expire: async () => undefined, sadd: async () => undefined,
      lpushTrim: async () => undefined, lrange: async () => [],
      del: async (k) => { m.delete(k); }, srem: async () => undefined,
    },
    dealsDbId: DB,
    readDeal: async () => ({ deal, kind: "マンション" }),
    intake: async (req) => { intakes.push(req); return { kind: "ok", value: { created: true, no: 12, status: "受付" } }; },
    loadDeals: async () => [{ id: DEAL, name: "テスト", phase: "査定" }],
    reserve: async (k) => ({ proceed: !done.has(k) }),
    complete: async (k) => { done.add(k); },
    reply: async (_t, text, card) => { replies.push({ text, card }); },
    log: (l) => logs.push(l),
  };
  return { deps, m, replies, intakes, logs };
}
const press = (x: ReturnType<typeof mk>, a: GsAction, eventId = "e1", userId = SHIMO) =>
  handleGroupSateiPostback(a, { replyToken: "r", webhookEventId: eventId, source: { userId } }, x.deps);
const gk = (code: string, ver = 1): GsAction => parseGsData(`v1|gk|${tid}|${ver}|${code}`)!;
const ticket = (x: ReturnType<typeof mk>) => asTicket(x.m.get(gsTicketKey(tid)))!;

(async () => {
  await t("data：gk は8つの符号だけ読む", async () => {
    assert.deepEqual(parseGsData(`v1|gk|${tid}|1|doc`), { op: "gk", tid, ver: 1, code: "doc" });
    assert.equal(parseGsData(`v1|gk|${tid}|1|xxx`), null);
    assert.equal(parseGsData(`v1|gk|${tid}|1`), null);
    assert.equal(parseGsData(`v1|gk|${tid}|1|doc|x`), null);
  });
  await t("STAGE2 off：止めています・何も書かない", async () => {
    const x = mk({ env: OFF });
    await press(x, gk("doc"));
    assert.equal(x.replies[0].text, "いまは止めています");
    assert.equal(x.m.has(gsDecKey(tid)), false);
    assert.equal(ticket(x).requestKind, undefined);
    assert.ok(x.logs.includes("[group-satei] gk paused stage2"));
  });
  await t("［資料を送る］：記録だけ（印 gk:doc・受付票は manual・返事）", async () => {
    const x = mk();
    await press(x, gk("doc"));
    assert.equal(x.m.get(gsDecKey(tid)), "gk:doc");
    assert.equal(ticket(x).state, "manual");
    assert.equal(ticket(x).requestKind, "doc");
    assert.equal(x.replies[0].text, "資料を送るとして控えました。中身は手作業でお願いします（受付 G7）");
    assert.equal(x.replies[0].card, undefined);
    assert.ok(x.logs.includes("[group-satei] gk kind doc G7"));
    assert.equal(x.intakes.length, 0);
  });
  await t("2回目（別のボタン・別のイベント）は選択済み", async () => {
    const x = mk();
    await press(x, gk("doc"), "e1");
    await press(x, gk("money"), "e2");
    assert.match(x.replies[1].text, /選択済みです（受付 G7）/);
    assert.equal(ticket(x).requestKind, "doc");
  });
  await t("LINE の再送（同じイベント）には返事をしない", async () => {
    const x = mk();
    await press(x, gk("doc"), "e1");
    await press(x, gk("doc"), "e1");
    assert.equal(x.replies.length, 1);
  });
  await t("［査定］：印は取らない・requestKind=satei・案件を選ぶカード、そのあと案件を選べる", async () => {
    const x = mk();
    await press(x, gk("satei"), "e1");
    assert.equal(x.m.has(gsDecKey(tid)), false);
    assert.equal(ticket(x).state, "asking");
    assert.equal(ticket(x).requestKind, "satei");
    assert.equal(x.replies[0].text, "査定で進めます。どの案件か選んでください（受付 G7）");
    assert.ok(JSON.stringify(x.replies[0].card).includes(`v1|gl|${tid}|1|0`));
    await press(x, { op: "gs", tid, ver: 1, dealId: DEAL }, "e2");
    assert.equal(x.intakes.length, 1);
    assert.equal(ticket(x).state, "started");
    assert.equal(ticket(x).requestKind, "satei");
  });
  await t("案件を選んだあとの gk は選択済み", async () => {
    const x = mk();
    await press(x, { op: "gs", tid, ver: 1, dealId: DEAL }, "e1");
    await press(x, gk("doc"), "e2");
    assert.match(x.replies[1].text, /選択済みです/);
    assert.equal(ticket(x).state, "started");
  });
  await t("押せるのは下村さんだけ・古い版は新しいカードへ", async () => {
    const a = mk();
    await press(a, gk("doc"), "e1", OTHER);
    assert.equal(a.replies[0].text, "いまは下村さんだけが使えます");
    const b = mk({ ticket: { ver: 2 } });
    await press(b, gk("doc"));
    assert.match(b.replies[0].text, /新しいカード/);
    assert.equal(b.m.has(gsDecKey(tid)), false);
  });
  await t("案件の選択：STAGE2 on なら requestKind=satei、off なら書かない（段1の票のまま）", async () => {
    const on = mk();
    await press(on, { op: "gs", tid, ver: 1, dealId: DEAL });
    assert.equal(ticket(on).requestKind, "satei");
    const off = mk({ env: OFF });
    await press(off, { op: "gs", tid, ver: 1, dealId: DEAL });
    assert.equal(ticket(off).state, "started");
    assert.equal(ticket(off).requestKind, undefined);
  });
  console.log(`group-satei-kind-actions: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx tsx tests/group-satei-kind-actions.test.ts`
Expected: FAIL（最初のテストで `parseGsData` が gk を読まず `null` を返す）

- [ ] **Step 3: data の読み方を足す**

`src/lib/group-satei-data.ts` の `GsAction` を置き換える。

置き換え前：

```ts
  | { op: "gn"; tid: string; ver: number };
```

置き換え後：

```ts
  | { op: "gn"; tid: string; ver: number }
  | { op: "gk"; tid: string; ver: number; code: GsReqKind };
```

`parseGsData` の `if (p[1] === "gn" && p.length === 4) return { op: "gn", tid, ver };` の次に足す：

```ts
  if (p[1] === "gk") {
    const code = p[4];
    return p.length === 5 && isGsReqKind(code) ? { op: "gk", tid, ver, code } : null;
  }
```

- [ ] **Step 4: 処理を足す**

`src/lib/group-satei-actions.ts` を次のとおり直す（どれも1か所だけ）。

(a) data の import を置き換える。

置き換え前：

```ts
import {
  GS_TICKET_TTL, groupSateiActive, groupSateiOn, gsDecKey, gsEventId, gsOpenKey, gsTicketKey, receiptOf, asTicket,
  type GsAction, type GsEnv, type GsTicket,
} from "./group-satei-data";
```

置き換え後：

```ts
import {
  GS_TICKET_TTL, groupSateiActive, groupSateiOn, groupSateiStage2On, gsDecKey, gsEventId, gsOpenKey, gsReqLabel, gsTicketKey,
  receiptOf, asTicket,
  type GsAction, type GsEnv, type GsTicket,
} from "./group-satei-data";
```

(b) card の import の頭を置き換える。

置き換え前：`  gsListCard, MSG_GS_BUSY,`
置き換え後：`  gsListCard, gsSateiNextCard, msgGsKindRecorded, msgGsKindSatei, MSG_GS_BUSY,`

(c) `Outcome` にカードを足す。

置き換え前：

```ts
interface Outcome {
  text: string;
  code: string;
  settled: boolean;
}
```

置き換え後：

```ts
interface Outcome {
  text: string;
  code: string;
  settled: boolean;
  card?: FlexMessage;
}
```

(d) `const MISMATCH_KINDS = ["マンション", "戸建", "土地"];` の次の行に足す：

```ts
/** 段2：案件を選んだ受付票に「査定」の印を残す（off のあいだは何も足さない＝段1と同じ票） */
const sateiKind = (env: GsEnv): Partial<GsTicket> => (groupSateiStage2On(env) ? { requestKind: "satei" } : {});
```

(e) `pick` の中の3つの `save` に `...sateiKind(env)` を足す（`env` は `pick` の中で `const env = deps.env ?? process.env;` として先に決まっている）。

置き換え前：`await quiet(() => save(kv, a.tid, { ...tk, state: "started", provisional: false, dealId: a.dealId, jobNo }));`
置き換え後：`await quiet(() => save(kv, a.tid, { ...tk, ...sateiKind(env), state: "started", provisional: false, dealId: a.dealId, jobNo }));`

置き換え前：`await quiet(() => save(kv, a.tid, { ...tk, state: "started", provisional: false, dealId: a.dealId, unknown: true }));`
置き換え後：`await quiet(() => save(kv, a.tid, { ...tk, ...sateiKind(env), state: "started", provisional: false, dealId: a.dealId, unknown: true }));`

置き換え前：`await quietKv(() => save(kv, a.tid, { ...tk, state: "manual", provisional: false, dealId: a.dealId }), deps);`
置き換え後：`await quietKv(() => save(kv, a.tid, { ...tk, ...sateiKind(env), state: "manual", provisional: false, dealId: a.dealId }), deps);`

(f) `async function decide(` の直前に足す：

```ts
/**
 * 段2：「何の依頼？」。［査定］は印（gsatei:dec）を取らない（取ると、このあとの案件選び gs が「選択済み」になる）。
 * ほかの7つは記録だけ：印を gk:<符号> で取り、受付票を manual にして閉じる（中身の自動化は別の設計）。
 */
async function chooseKind(a: Extract<GsAction, { op: "gk" }>, tk: GsTicket, deps: GsActionDeps, kv: Kv): Promise<Outcome> {
  const no = tk.no;
  if (a.code === "satei") {
    if (tk.state === "asking" && tk.requestKind !== "satei") {
      await quietKv(() => save(kv, a.tid, { ...tk, requestKind: "satei" }), deps);
    }
    return { text: msgGsKindSatei(no), code: `kind satei ${receiptOf(no)}`, settled: true, card: gsSateiNextCard(a.tid, tk.ver, no) };
  }
  if (!(await kv.setNx(gsDecKey(a.tid), `gk:${a.code}`, GS_TICKET_TTL))) return { text: msgGsAlready(no), code: "already", settled: true };
  await quietKv(() => save(kv, a.tid, { ...tk, state: "manual", provisional: false, requestKind: a.code }), deps);
  return { text: msgGsKindRecorded(no, gsReqLabel(a.code)), code: `kind ${a.code} ${receiptOf(no)}`, settled: true };
}
```

(g) `decide` の中で gk を先に振り分ける（印の確かめ＝「選択済み」「確かめられませんでした」のあと）。

置き換え前：`  if (a.op === "gs") return pick(a, tk, userId, deps, kv);`
置き換え後：

```ts
  if (a.op === "gk") return chooseKind(a, tk, deps, kv);
  if (a.op === "gs") return pick(a, tk, userId, deps, kv);
```

(h) `handleGroupSateiPostback` で、スイッチ off の gk を止める。

置き換え前：

```ts
    return say(MSG_GS_PAUSED, "paused");
  }
  const userId = ev.source.userId;
```

置き換え後：

```ts
    return say(MSG_GS_PAUSED, "paused");
  }
  // 段2のボタン（gk）は GROUP_SATEI_STAGE2 off なら何もしない（on のあいだに出したカードを off のあとに押された）
  if (action.op === "gk" && !groupSateiStage2On(env)) {
    deps.log("[group-satei] gk paused stage2");
    return say(MSG_GS_PAUSED, "paused");
  }
  const userId = ev.source.userId;
```

(i) 返事にカードを付ける。

置き換え前：`    await say(r.text, r.code);`
置き換え後：`    await say(r.text, r.code, r.card);`

- [ ] **Step 5: 通ることを確かめる**

Run: `npx tsx tests/group-satei-kind-actions.test.ts && npx tsx tests/group-satei-actions.test.ts && npx tsc --noEmit -p .`
Expected: PASS（`group-satei-kind-actions: 9 ok`・段1の `group-satei-actions: 28 ok`・tsc は何も出さない）

- [ ] **Step 6: テストの一覧に足す**

置き換え前：`tsx tests/group-satei-kind-card.test.ts"`
置き換え後：`tsx tests/group-satei-kind-card.test.ts && tsx tests/group-satei-kind-actions.test.ts"`

- [ ] **Step 7: コミット**

```bash
git add src/lib/group-satei-data.ts src/lib/group-satei-actions.ts tests/group-satei-kind-actions.test.ts package.json
git commit -m "feat: 「何の依頼？」のボタンを押したときの処理を足す

［査定］は印を取らずに案件選びへ、ほかの7つは記録だけ（印 gk:<符号>・受付票は手作業）で閉じる。
GROUP_SATEI_STAGE2 off のあいだに押されたら「止めています」だけ返す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 知らせのカードに8つを出す（スイッチ on のときだけ）

**Files:**
- Modify: `src/lib/group-satei-open.ts`
- Create: `tests/group-satei-kind-open.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2 の `groupSateiStage2On`、Task 3 の `gsCard(..., opt)`
- Produces: `openGroupSatei`・`runRereadWorker`・`sweepGroupSatei` が出すカード（どれも中の `notifyTicket` を通る）が、スイッチ on のときだけ上の段に8つを持つ。関数のシグネチャは変えない。

- [ ] **Step 1: 落ちるテストを書く**

`tests/group-satei-kind-open.test.ts`：

```ts
/** 段2a：知らせのカードに「何の依頼？」が出るのは GROUP_SATEI_STAGE2 on のときだけ（group-satei-open.ts） */
import assert from "node:assert/strict";
import { openGroupSatei, recordGroupSateiMedia, type GsKv, type GsOpenDeps } from "../src/lib/group-satei-open";
import { type GsRead } from "../src/lib/group-satei-data";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const G = "C" + "a".repeat(32);
const SHIMO = "U" + "b".repeat(32);
const BOSS = "U" + "c".repeat(32);
const BASE_ENV = { GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, TASK_SATEI_USER_IDS: SHIMO, TASK_SATEI: "1" };
const NOW = 1_800_000_000_000;
const D1 = { id: "0123abcd0123456789ab0123456789ab", name: "テスト町1丁目", phase: "査定" };
const READ: GsRead = { address: "大阪市北区テスト1丁目2", propertyName: "テスト町1丁目", kind: "戸建", basis: "登記", confidence: 0.9 };

function mk(env: Record<string, string>) {
  const m = new Map<string, unknown>();
  const kv: GsKv = {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => { m.set(k, v); },
    setNx: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
    incr: async (k) => { const v = Number(m.get(k) ?? 0) + 1; m.set(k, v); return v; },
    expire: async () => undefined,
    sadd: async (k, v) => { const s = (m.get(k) as Set<string>) ?? new Set(); s.add(v); m.set(k, s); },
    lpushTrim: async (k, v, max) => { const a = ((m.get(k) as unknown[]) ?? []); a.push(v); m.set(k, a.slice(-max)); },
    lrange: async (k) => ((m.get(k) as unknown[]) ?? []),
  };
  const pushes: Array<{ messages: unknown[] }> = [];
  const deps: GsOpenDeps = {
    env, kv, now: () => NOW, today: () => "2026-11-24", ymd: () => "2026-11-24",
    read: async () => READ,
    loadDeals: async () => [D1],
    kindOf: async () => "戸建",
    requesterName: async () => "前田",
    push: async (_to, messages) => { pushes.push({ messages }); return true; },
    log: () => undefined,
  };
  return { deps, kv, pushes };
}
const ev = { messageId: "m1", groupId: G, requesterId: BOSS, at: NOW, text: "査定お願いできますか", entry: "B" as const };
async function openWith(env: Record<string, string>) {
  const x = mk(env);
  await recordGroupSateiMedia({ messageId: "img1", kind: "image", senderId: BOSS, at: NOW - 60_000 }, G, x.kv, () => undefined);
  assert.equal(await openGroupSatei(ev, x.deps), "opened");
  assert.equal(x.pushes.length, 1);
  return x.pushes[0].messages[1] as any;
}

(async () => {
  await t("STAGE2 off：カードは段1のまま（gk が無い・本文は案内1行）", async () => {
    const card = await openWith(BASE_ENV);
    assert.ok(!JSON.stringify(card).includes("v1|gk|"));
    assert.equal(card.contents.body.contents.length, 1);
  });
  await t("STAGE2 on：上の段に8つ、先頭は［査定］", async () => {
    const card = await openWith({ ...BASE_ENV, GROUP_SATEI_STAGE2: "1" });
    const s = JSON.stringify(card);
    assert.equal((s.match(/v1\|gk\|/g) ?? []).length, 8);
    assert.ok(s.indexOf("|satei\"") < s.indexOf("|doc\""));
    assert.equal(card.contents.footer.contents[0].action.data.split("|")[1], "gs");
  });
  console.log(`group-satei-kind-open: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx tsx tests/group-satei-kind-open.test.ts`
Expected: FAIL（2つ目のテスト：`v1|gk|` が 0 個）

- [ ] **Step 3: 作る**

`src/lib/group-satei-open.ts` の data の import の行を置き換える。

置き換え前：`  asTicket, groupSateiActive, groupSateiOn, gsDecKey,`
置き換え後：`  asTicket, groupSateiActive, groupSateiOn, groupSateiStage2On, gsDecKey,`

`notifyTicket` の中のカードを作る行を置き換える。

置き換え前：

```ts
  const card = gsCard(tid, ticket.ver, cands, dealsFailed, ticket.no);
```

置き換え後：

```ts
  // 段2：上の段に「何の依頼？」。入口は査定らしいものだけを拾うので、見立てはいつも［査定］（設計 3）
  const stage2 = groupSateiStage2On(deps.env ?? process.env);
  const card = gsCard(tid, ticket.ver, cands, dealsFailed, ticket.no, stage2 ? { guess: "satei" } : undefined);
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx tsx tests/group-satei-kind-open.test.ts && npx tsx tests/group-satei-open.test.ts && npx tsx tests/group-satei-reread.test.ts`
Expected: PASS（`group-satei-kind-open: 2 ok`。段1の open・reread も通る）

- [ ] **Step 5: テストの一覧に足す**

置き換え前：`tsx tests/group-satei-kind-actions.test.ts"`
置き換え後：`tsx tests/group-satei-kind-actions.test.ts && tsx tests/group-satei-kind-open.test.ts"`

- [ ] **Step 6: コミット**

```bash
git add src/lib/group-satei-open.ts tests/group-satei-kind-open.test.ts package.json
git commit -m "feat: 段2のスイッチが on のとき、査定の依頼の知らせに「何の依頼？」を出す

最初の知らせ・読み直し・見回りの掃除の3つとも同じ notifyTicket を通るので、1か所で足りる。
off のときのカードは段1と同じ JSON（テストで確かめる）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 2a の締め（CLAUDE.md・全体の確かめ）

**Files:**
- Modify: `CLAUDE.md`（「普通のグループの査定依頼・段1」の節の最後の箇条の後ろ）

**Interfaces:**
- Consumes: Task 1〜5
- Produces: なし（文書だけ）

- [ ] **Step 1: CLAUDE.md に段2a の節を足す**

`CLAUDE.md` の最後（段1の節の「画像が続くと、その webhook の応答は…」の箇条の後ろ）に足す：

```markdown

（普通のグループの査定依頼・段2a・2026-11-26）`GROUP_SATEI_STAGE2`（`1` かつ `GROUP_SATEI=1` のときだけ動く。既定 off。off なら段1のカード・ボタン・受付票は1バイトも変わらない）。新しい環境変数はこれだけ。設計 `docs/superpowers/specs/2026-11-25-group-satei-stage2-design.md`、計画 `docs/superpowers/plans/2026-11-26-group-satei-stage2.md`。
- 下村さんへの知らせのカードの上の段に「何の依頼？」の8つ（［査定］［資料を送る］［書類の作成・チェック］［日程・内見］［物件調査・謄本］［振込・お金］［メール・電話］［その他］）。AI の見立て（今はいつも［査定］）を先頭・色つき。data `v1|gk|<受付票>|<版>|<符号>`（`satei`・`doc`・`check`・`sched`・`survey`・`money`・`mail`・`other`）。押せるのは `TASK_SATEI_USER_IDS` の人だけ。
- ［査定］は印（`gsatei:dec`）を取らず、受付票に `requestKind: "satei"` を書いて「一覧から選ぶ／案件がまだ無い」のカードを返す（前のカードの候補もそのまま押せる）。案件を選んだ受付票にも `requestKind: "satei"` が残る。
- ほかの7つは記録だけ：印を `gk:<符号>` で取り、受付票を `manual`（`requestKind` つき）にして「〈種類〉として控えました。中身は手作業でお願いします（受付 G7）」。LINEタスク の `種別の依頼` には書かない（欄が無い・受付票がタスクを指していない）。
- スイッチ off のあいだに前のカードの gk を押されたら「いまは止めています」だけ（`[group-satei] gk paused stage2`）。
- ログは `[group-satei] gk kind doc G7`・`gk kind satei G7` の形（符号と受付番号だけ）。
- 事例の期日の関数 `src/lib/group-satei-deadline.ts`（17時より前は当日18時、17時以降・火水は次の営業日の18時。土日は営業日。祝日は扱わない）は 2d で使う。まだどこからも呼ばない。
```

- [ ] **Step 2: 全体を確かめる**

Run:

```bash
for f in tests/group-satei-*.test.ts; do npx tsx "$f" > /dev/null || echo "FAIL $f"; done
npx tsc --noEmit -p .
```

Expected：`FAIL` が1行も出ない。tsc は何も出さない。

- [ ] **Step 3: コミット**

```bash
git add CLAUDE.md
git commit -m "docs: 段2a（何の依頼？の8つ）の動きを CLAUDE.md に書く

スイッチ・data・印の値・ログの形・LINEタスクに書かない理由を残す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: 本番の前に（ここで止める。Claude はしない）**

レビュー（`superpowers:requesting-code-review`）のあと、下村さんに次を確かめてもらう：①本番に出し直してよいか、②Vercel に `GROUP_SATEI_STAGE2=1` を入れてよいか（値を画面に出さない方法で）。入れたら、本物の依頼1件で「8つが出る・［査定］→案件選び・［資料を送る］→控えました」を見る。8つの言葉が半分の幅で切れて見えたら、2つずつの並びを1つずつに変える（`gsKindSection` の `i += 2` を 1 に）。

---

### Task 7: 2b 前半・読み取りを広げる（同じ1回の読み取りで面積・築年など）

**Files:**
- Modify: `src/lib/group-satei-data.ts`（`GsFacts`・`GsRead.facts`）
- Modify: `src/lib/group-satei-read.ts`
- Modify: `src/lib/group-satei-wire.ts`
- Create: `tests/group-satei-read-v2.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2 の `groupSateiStage2On`、既存の `scrubNames`・`readGsMaterials`・`parseGsReadText`
- Produces: `interface GsFacts { roomNo: string | null; exclusiveArea: number | null; landArea: number | null; buildingArea: number | null; builtYm: string | null; layout: string | null; floor: number | null; totalUnits: number | null; structure: string | null }`、`GsRead.facts?: GsFacts`、`GS_READ_PROMPT_V2`、`numOrNull(x: unknown): number | null`、`normYm(x: unknown): string | null`、`normRoom(x: unknown): string | null`、`parseGsReadText(text, opts?: { facts?: boolean })`、`readGsMaterials(attachments, text, today, create, opts?: { stage2?: boolean })`

- [ ] **Step 1: 落ちるテストを書く**

`tests/group-satei-read-v2.test.ts`：

```ts
/** 段2b：読み取りを広げる（group-satei-read.ts。AI は差し替え） */
import assert from "node:assert/strict";
import { GS_READ_PROMPT, GS_READ_PROMPT_V2, normRoom, normYm, numOrNull, parseGsReadText, readGsMaterials } from "../src/lib/group-satei-read";

let n = 0;
const t = async (name: string, f: () => void | Promise<void>) => { await f(); n++; console.log("ok", name); };
const V2_ANSWER = JSON.stringify({
  所在: "大阪市北区テスト1丁目2", 物件名: "テストマンション1203", 号室: "1203号室", 種別の見込み: "マンション", 根拠: "チラシ",
  専有面積: "65.3㎡", 土地面積: null, 建物面積: null, 築年月: "2005年3月", 間取り: "3LDK", 階: 12, 総戸数: "120戸", 構造: "SRC", 確信度: 0.8,
});

(async () => {
  await t("段1の指示文は1字も変えていない（V2 は別の文）", () => {
    assert.notEqual(GS_READ_PROMPT_V2, GS_READ_PROMPT);
    assert.match(GS_READ_PROMPT_V2, /名前は、どの欄にも書かないでください/);
    for (const k of ["号室", "専有面積", "土地面積", "建物面積", "築年月", "間取り", "階", "総戸数", "構造"]) assert.ok(GS_READ_PROMPT_V2.includes(`"${k}"`), k);
  });
  await t("facts なしの読み方は段1と同じ形（facts の欄が無い）", () => {
    const r = parseGsReadText(V2_ANSWER);
    assert.equal("facts" in r, false);
  });
  await t("facts ありの読み方：単位・書き方をそろえる", () => {
    const r = parseGsReadText(V2_ANSWER, { facts: true });
    assert.equal(r.propertyName, "テストマンション1203");
    assert.deepEqual(r.facts, { roomNo: "1203", exclusiveArea: 65.3, landArea: null, buildingArea: null, builtYm: "2005-03", layout: "3LDK", floor: 12, totalUnits: 120, structure: "SRC" });
  });
  await t("数・年月・号室の検査", () => {
    assert.equal(numOrNull("1,234.5㎡"), 1234.5);
    assert.equal(numOrNull(0), null);
    assert.equal(numOrNull("不明"), null);
    assert.equal(numOrNull(-3), null);
    assert.equal(normYm("2005/3"), "2005-03");
    assert.equal(normYm("昭和55年"), null);
    assert.equal(normYm("2005-13"), null);
    assert.equal(normRoom("A-101"), "A-101");
    assert.equal(normRoom("山田様"), null);
    assert.equal(normRoom(1203), "1203");
  });
  await t("名前らしい値は facts でも捨てる", () => {
    const r = parseGsReadText(JSON.stringify({ 所在: "大阪市北区1-2", 種別の見込み: "戸建", 根拠: "登記", 構造: "山田様の木造", 確信度: 0.9 }), { facts: true });
    assert.equal(r.facts?.structure, null);
  });
  await t("readGsMaterials：stage2 のときだけ V2 の指示文と facts", async () => {
    let sys = "";
    const create = async (req: { system: string }) => { sys = req.system; return { content: [{ type: "text", text: V2_ANSWER }] }; };
    const one = await readGsMaterials([], "査定", "2026-11-26", create as any);
    assert.equal(sys, GS_READ_PROMPT);
    assert.equal("facts" in one, false);
    const two = await readGsMaterials([], "査定", "2026-11-26", create as any, { stage2: true });
    assert.equal(sys, GS_READ_PROMPT_V2);
    assert.equal(two.facts?.exclusiveArea, 65.3);
  });
  console.log(`group-satei-read-v2: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx tsx tests/group-satei-read-v2.test.ts`
Expected: FAIL（`GS_READ_PROMPT_V2` などが無い）

- [ ] **Step 3: 型を足す**

`src/lib/group-satei-data.ts` の `export interface GsRead {` の直前に足す：

```ts
/** 段2b：査定書の表紙・概要に要る項目（同じ1回の読み取りで読む。分からなければ null） */
export interface GsFacts {
  /** 号室（物件名とは別に。例 "1203"） */
  roomNo: string | null;
  /** 専有面積（㎡） */
  exclusiveArea: number | null;
  /** 土地面積（㎡） */
  landArea: number | null;
  /** 建物面積（延床・㎡） */
  buildingArea: number | null;
  /** 築年月 "YYYY-MM" */
  builtYm: string | null;
  layout: string | null;
  floor: number | null;
  totalUnits: number | null;
  structure: string | null;
}
```

`GsRead` の `confidence: number;` の後ろに足す：

```ts
  /** 段2b（GROUP_SATEI_STAGE2 on のときだけ読む）。段1の票には無い */
  facts?: GsFacts;
```

- [ ] **Step 4: 読み方を足す**

`src/lib/group-satei-read.ts` の import を置き換える。

置き換え前：`import { GS_BASES, GS_KINDS, GS_MATERIALS_MAX, type GsBasis, type GsKind, type GsRead } from "./group-satei-data";`
置き換え後：`import { GS_BASES, GS_KINDS, GS_MATERIALS_MAX, type GsBasis, type GsFacts, type GsKind, type GsRead } from "./group-satei-data";`

`const NAME_RE =` の行の直前に足す：

```ts
/**
 * 段2b（GROUP_SATEI_STAGE2 on のときだけ使う）：段1の欄はそのまま（物件名は号室つきのまま＝案件の候補の探し方を変えない）、
 * 査定書の表紙・概要に要る欄を足す。AI の呼び出しは増やさない（同じ1回で読む）。
 */
export const GS_READ_PROMPT_V2 = `あなたは不動産会社の査定の受付係です。LINE のグループに届いた査定の依頼と、添付の資料（写真・登記・地図・チラシ）から、査定する物件を読み取ります。
次の JSON だけを返してください（説明文は要りません）。分からない欄は null にしてください。推測で埋めないでください。
{"所在": 住居表示か地番（例「大阪市旭区大宮1丁目3番27」）。分からなければ null,
 "物件名": マンション名と号室（例「サウスオールシティ1203」）。無ければ null,
 "号室": 号室だけ（例「1203」）。無ければ null,
 "種別の見込み": "マンション" | "戸建" | "土地" | "不明"（登記の「区分建物」はマンション、「居宅」は戸建、「宅地」だけなら土地）,
 "根拠": "本文" | "登記" | "地図" | "チラシ" | "その他",
 "専有面積": ㎡の数（例 65.3）か null,
 "土地面積": ㎡の数か null,
 "建物面積": 延床の㎡の数か null,
 "築年月": "YYYY-MM"（例 "2005-03"）か null,
 "間取り": 例 "3LDK" か null,
 "階": 所在階の数か null,
 "総戸数": 数か null,
 "構造": 例 "RC" "SRC" "木造" か null,
 "確信度": 0〜1 の数}
所有者・売主・人の名前は、どの欄にも書かないでください。`;

/** ㎡・階・戸数の数。0 以下・数でない・ばかげて大きい値は null */
export function numOrNull(x: unknown): number | null {
  const v = typeof x === "number" ? x : typeof x === "string" ? Number((x.replace(/,/g, "").match(/\d+(?:\.\d+)?/) ?? [""])[0]) : Number.NaN;
  return Number.isFinite(v) && v > 0 && v < 1_000_000 ? v : null;
}
const intOrNull = (x: unknown): number | null => {
  const v = numOrNull(x);
  return v !== null && Number.isInteger(v) ? v : null;
};

/** "2005-03"・"2005/3"・"2005年3月" → "2005-03"。読めなければ null */
export function normYm(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const m = x.match(/(\d{4})\s*(?:-|\/|年)\s*(\d{1,2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12) return null;
  return `${y}-${String(mo).padStart(2, "0")}`;
}

/** 号室："1203"・"1203号室"・"A-101" だけ通す */
export function normRoom(x: unknown): string | null {
  if (typeof x !== "string" && typeof x !== "number") return null;
  const v = String(x).trim().replace(/号室?$/, "");
  return /^[0-9A-Za-z-]{1,8}$/.test(v) ? v : null;
}
```

`export function parseGsReadText(text: string): GsRead {` を置き換える。

置き換え後：

```ts
function parseFacts(o: Record<string, unknown>): GsFacts {
  const short = (x: unknown, n: number) => {
    const v = scrubNames(typeof x === "string" ? x : null);
    return v ? Array.from(v).slice(0, n).join("") : null;
  };
  return {
    roomNo: normRoom(o["号室"]),
    exclusiveArea: numOrNull(o["専有面積"]),
    landArea: numOrNull(o["土地面積"]),
    buildingArea: numOrNull(o["建物面積"]),
    builtYm: normYm(o["築年月"]),
    layout: short(o["間取り"], 20),
    floor: intOrNull(o["階"]),
    totalUnits: intOrNull(o["総戸数"]),
    structure: short(o["構造"], 20),
  };
}

/** opts.facts（段2b）のときだけ facts を足す。無ければ段1と同じ形 */
export function parseGsReadText(text: string, opts: { facts?: boolean } = {}): GsRead {
```

同じ関数の最後の return を置き換える。

置き換え前：

```ts
  return { address, propertyName, kind, basis, confidence: c };
}
```

置き換え後：

```ts
  const read: GsRead = { address, propertyName, kind, basis, confidence: c };
  return opts.facts ? { ...read, facts: parseFacts(o) } : read;
}
```

`readGsMaterials` の引数と中身を直す。

置き換え前：

```ts
  create: GsCreate,
): Promise<GsRead> {
```

置き換え後：

```ts
  create: GsCreate,
  opts: { stage2?: boolean } = {},
): Promise<GsRead> {
```

置き換え前：

```ts
    max_tokens: 512,
    system: GS_READ_PROMPT,
```

置き換え後：

```ts
    max_tokens: opts.stage2 ? 768 : 512,
    system: opts.stage2 ? GS_READ_PROMPT_V2 : GS_READ_PROMPT,
```

置き換え前：`  return parseGsReadText(out);`
置き換え後：`  return parseGsReadText(out, { facts: Boolean(opts.stage2) });`

- [ ] **Step 5: 本物の読み取りにつなぐ**

`src/lib/group-satei-wire.ts` の data の import を置き換える。

置き換え前：`import { GS_MIN, GS_RETRY_NAMESPACE, groupSateiActive, groupSateiOn, ticketIdOf } from "./group-satei-data";`
置き換え後：`import { GS_MIN, GS_RETRY_NAMESPACE, groupSateiActive, groupSateiOn, groupSateiStage2On, ticketIdOf } from "./group-satei-data";`

`groupSateiOpenDeps` の `read` の中を置き換える。

置き換え前：

```ts
        (async () => readGsMaterials(await loadGroupSateiMaterials(ids), text, today, create))(),
```

置き換え後：

```ts
        (async () =>
          readGsMaterials(await loadGroupSateiMaterials(ids), text, today, create, { stage2: groupSateiStage2On() }))(),
```

- [ ] **Step 6: 通ることを確かめる**

Run: `npx tsx tests/group-satei-read-v2.test.ts && npx tsx tests/group-satei-read.test.ts && npx tsc --noEmit -p .`
Expected: PASS（`group-satei-read-v2: 6 ok`・段1の `group-satei-read: 10 ok`・tsc は何も出さない）

- [ ] **Step 7: テストの一覧に足す**

置き換え前：`tsx tests/group-satei-kind-open.test.ts"`
置き換え後：`tsx tests/group-satei-kind-open.test.ts && tsx tests/group-satei-read-v2.test.ts"`

- [ ] **Step 8: コミット**

```bash
git add src/lib/group-satei-data.ts src/lib/group-satei-read.ts src/lib/group-satei-wire.ts tests/group-satei-read-v2.test.ts package.json
git commit -m "feat: 段2の読み取りで面積・築年月・号室なども読む

GROUP_SATEI_STAGE2 on のときだけ別の指示文を使い、同じ1回の呼び出しで査定書の表紙・概要の欄を読む。
段1の指示文と答えの形は変えない。名前らしい値は捨てる。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 2b 前半・足りない項目の決まり・聞く文・答えの読み方

**Files:**
- Create: `src/lib/group-satei-facts.ts`
- Create: `tests/group-satei-facts.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 7 の `GsFacts`・`numOrNull`・`normYm`・`normRoom`、既存の `scrubNames`・`receiptOf`
- Produces: `type GsFactKey = "address" | "propertyName" | "roomNo" | "exclusiveArea" | "builtYm" | "landArea" | "buildingArea"`、`GS_FACT_LABEL`、`gsMissingFacts(kind: string | null, read: GsRead | null): GsFactKey[]`（聞く順）、`gsAskText(key: GsFactKey, no: number): string`、`gsAnswerFact(key: GsFactKey, text: string): string | number | null`。2d と一緒に作る「聞く仕組み」が使う。

- [ ] **Step 1: 落ちるテストを書く**

`tests/group-satei-facts.test.ts`：

```ts
/** 段2b：足りない項目の決まり（group-satei-facts.ts。純粋関数） */
import assert from "node:assert/strict";
import { gsAnswerFact, gsAskText, gsMissingFacts } from "../src/lib/group-satei-facts";
import type { GsFacts, GsRead } from "../src/lib/group-satei-data";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const EMPTY: GsFacts = { roomNo: null, exclusiveArea: null, landArea: null, buildingArea: null, builtYm: null, layout: null, floor: null, totalUnits: null, structure: null };
const read = (o: Partial<GsRead> = {}, f: Partial<GsFacts> = {}): GsRead =>
  ({ address: "大阪市北区テスト1丁目2", propertyName: "テストマンション1203", kind: "マンション", basis: "チラシ", confidence: 0.8, facts: { ...EMPTY, ...f }, ...o });

t("マンション：所在・物件名・号室・専有面積・築年月の順", () => {
  assert.deepEqual(gsMissingFacts("マンション", read()), ["roomNo", "exclusiveArea", "builtYm"]);
  assert.deepEqual(gsMissingFacts("マンション", read({}, { roomNo: "1203", exclusiveArea: 65.3, builtYm: "2005-03" })), []);
  assert.deepEqual(gsMissingFacts("マンション", read({ address: null, propertyName: null })), ["address", "propertyName", "roomNo", "exclusiveArea", "builtYm"]);
});
t("戸建：所在・土地面積・建物面積・築年月", () => {
  assert.deepEqual(gsMissingFacts("戸建", read({}, { landArea: 120.5 })), ["buildingArea", "builtYm"]);
});
t("土地：所在・土地面積", () => {
  assert.deepEqual(gsMissingFacts("土地", read({ address: null })), ["address", "landArea"]);
});
t("種別が分からない・ほかの種別は聞かない", () => {
  assert.deepEqual(gsMissingFacts(null, read()), []);
  assert.deepEqual(gsMissingFacts("不明", read()), []);
  assert.deepEqual(gsMissingFacts("ビル", read()), []);
});
t("読めていない（段1の票＝facts なし・read なし）は全部足りない", () => {
  assert.deepEqual(gsMissingFacts("土地", null), ["address", "landArea"]);
  const { facts: _f, ...noFacts } = read();
  assert.deepEqual(gsMissingFacts("マンション", noFacts as GsRead), ["roomNo", "exclusiveArea", "builtYm"]);
});
t("聞く文", () => {
  assert.equal(gsAskText("exclusiveArea", 7), "【受付 G7】専有面積が分かりません。分かれば送ってください（例：65.3）");
});
t("答えの読み方", () => {
  assert.equal(gsAnswerFact("exclusiveArea", "65.3㎡です"), 65.3);
  assert.equal(gsAnswerFact("builtYm", "2005年3月"), "2005-03");
  assert.equal(gsAnswerFact("roomNo", "1203号室"), "1203");
  assert.equal(gsAnswerFact("address", "山田様の家"), null);
  assert.equal(gsAnswerFact("address", "大阪市北区1-2"), "大阪市北区1-2");
  assert.equal(gsAnswerFact("landArea", "分からない"), null);
  assert.equal(gsAnswerFact("landArea", "  "), null);
});
console.log(`group-satei-facts: ${n} ok`);
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx tsx tests/group-satei-facts.test.ts`
Expected: FAIL（`Cannot find module '../src/lib/group-satei-facts'`）

- [ ] **Step 3: 作る**

`src/lib/group-satei-facts.ts`：

```ts
/**
 * 段2b：足りない項目の決まりと、聞く文・答えの読み方（設計 4）。通信はしない。
 * 種別は CRM_物件 の `種別` が正（案件を選んだあとに呼ぶ）。マンション・戸建・土地のほかは聞かない。
 * 聞くのは1回に1つ（並びの先頭から）。聞く仕組み（KV の印・1対1の文字の取り込み・［分からない］）は 2d と一緒に作る。
 */
import { receiptOf, type GsRead } from "./group-satei-data";
import { normRoom, normYm, numOrNull, scrubNames } from "./group-satei-read";

export type GsFactKey = "address" | "propertyName" | "roomNo" | "exclusiveArea" | "builtYm" | "landArea" | "buildingArea";

export const GS_FACT_LABEL: Record<GsFactKey, string> = {
  address: "所在",
  propertyName: "物件名",
  roomNo: "号室",
  exclusiveArea: "専有面積",
  builtYm: "築年月",
  landArea: "土地面積",
  buildingArea: "建物面積",
};

/** 査定書の表紙・概要に要るもの（設計 4。この順に聞く） */
const NEED: Record<string, GsFactKey[]> = {
  マンション: ["address", "propertyName", "roomNo", "exclusiveArea", "builtYm"],
  戸建: ["address", "landArea", "buildingArea", "builtYm"],
  土地: ["address", "landArea"],
};

export function gsMissingFacts(kind: string | null, read: GsRead | null): GsFactKey[] {
  const need = (kind && NEED[kind]) || [];
  const f = read?.facts;
  const has: Record<GsFactKey, boolean> = {
    address: Boolean(read?.address),
    propertyName: Boolean(read?.propertyName),
    roomNo: Boolean(f?.roomNo),
    exclusiveArea: f?.exclusiveArea != null,
    builtYm: Boolean(f?.builtYm),
    landArea: f?.landArea != null,
    buildingArea: f?.buildingArea != null,
  };
  return need.filter((k) => !has[k]);
}

const EXAMPLE: Record<GsFactKey, string> = {
  address: "大阪市旭区大宮1丁目3番27",
  propertyName: "サウスオールシティ",
  roomNo: "1203",
  exclusiveArea: "65.3",
  builtYm: "2005年3月",
  landArea: "120.5",
  buildingArea: "98.2",
};

/** 「【受付 G7】専有面積が分かりません。分かれば送ってください（例：65.3）」 */
export const gsAskText = (key: GsFactKey, no: number) =>
  `【受付 ${receiptOf(no)}】${GS_FACT_LABEL[key]}が分かりません。分かれば送ってください（例：${EXAMPLE[key]}）`;

/** 1対1で返ってきた答えを、その項目の値に読む。読めなければ null（もう一度聞くか、［分からない］を待つ） */
export function gsAnswerFact(key: GsFactKey, text: string): string | number | null {
  const v = text.trim();
  if (!v) return null;
  if (key === "exclusiveArea" || key === "landArea" || key === "buildingArea") return numOrNull(v);
  if (key === "builtYm") return normYm(v);
  if (key === "roomNo") return normRoom(v);
  const s = scrubNames(v);
  return s ? Array.from(s).slice(0, 80).join("") : null;
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx tsx tests/group-satei-facts.test.ts`
Expected: PASS（`group-satei-facts: 7 ok`）

- [ ] **Step 5: テストの一覧に足す**

置き換え前：`tsx tests/group-satei-read-v2.test.ts"`
置き換え後：`tsx tests/group-satei-read-v2.test.ts && tsx tests/group-satei-facts.test.ts"`

- [ ] **Step 6: コミット**

```bash
git add src/lib/group-satei-facts.ts tests/group-satei-facts.test.ts package.json
git commit -m "feat: 段2で査定書に足りない項目を決める関数と、聞く文・答えの読み方を足す

マンション・戸建・土地ごとに設計 4 の項目を、その順に返す。まだどこからも呼ばない
（聞く仕組みは、答えを使う 2d の準備の依頼と一緒に作る）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 2b 前半の締め（CLAUDE.md・全体の確かめ）

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md の段2a の節の後ろに足す**

```markdown
- （段2b の前半・2026-11-26）`GROUP_SATEI_STAGE2=1` のとき、資料の読み取り（1日20回・1回の呼び出しは同じ）が別の指示文 `GS_READ_PROMPT_V2` で、号室・専有面積・土地面積・建物面積・築年月・間取り・階・総戸数・構造も読み、受付票の `read.facts` に入れる（物件名は段1と同じ「マンション名と号室」）。名前らしい値は捨てる。off なら段1の指示文と形のまま。足りない項目の決まり `src/lib/group-satei-facts.ts`（マンション＝所在・物件名・号室・専有面積・築年月／戸建＝所在・土地面積・建物面積・築年月／土地＝所在・土地面積）は、まだどこからも呼ばない（聞く仕組みは 2d と一緒）。
```

- [ ] **Step 2: 全体を確かめる**

Run:

```bash
for f in tests/group-satei-*.test.ts; do npx tsx "$f" > /dev/null || echo "FAIL $f"; done
npx tsc --noEmit -p .
```

Expected：`FAIL` が1行も出ない。tsc は何も出さない。

- [ ] **Step 3: コミット**

```bash
git add CLAUDE.md
git commit -m "docs: 段2b の前半（読み取りを広げる・足りない項目の決まり）を CLAUDE.md に書く

まだ聞かない理由（答えの使い先が 2d）も残す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Obsidian の進行ログ**

`~/AI開発/tools/notebooklm-obsidian/vault/20_research/2026-08-08_AI秘書_集約と完了機能_進行ログ.md` の一番上に「やったこと（2a・2b 前半・期日の関数）・決まったこと（R1〜R8）・残り（2b の聞く仕組み・2c〜2f）・次の一手（前提の確かめ：山口さんの userId・API 鍵・種別の依頼の欄）」を足す。名前・ID は書かない。

---

## 2b の後半〜2f（この計画では作らない。次の計画の入口）

- **2b 後半（聞く仕組み）**：`gsatei:ask:<userId>`（30分）の印、1対1の次の文字を `gsAnswerFact` で読んで `read.facts` に入れる、［分からない］のボタン（空のまま進み、査定係が「確認事項」に「〇〇は担当が確かめる」と書く）。受付票の状態 `asking-info` を足す。聞く時期は「案件を選んだあと・2d の準備の依頼の前」。2d と同じ計画で作る。
- **2c（Mac）**：line-secretary の査定係に「地域の調べ」の段。入力は所在と種別だけの小さなファイル（`input/` は sandbox で読めない）。不動産情報ライブラリ → Web。結果は `01_物件資料/地域調査/`。スイッチ `SATEI_AREA_RESEARCH`。
- **2d（portal・Mac・aisecretary）**：portal の依頼箱に `prep`（スイッチ `SATEI_PREP`）、Mac が案を作って `POST /api/satei/propose`、［いいよ］［直す］（直すは2回まで）、［いいよ］の時刻で `gsCaseDeadline` を決めて portal 経由で Mac へ、Mac が `POST /api/satei/case-request` → 依頼が来たグループに山口さんへのメンションつきカード（ボタンなし。号室・番地・名前・REINS の番号を入れない）。期日を過ぎて事例が無ければ1回だけリマインド（グループへ1件最大2通）。
- **2e**：グループに貼られた PDF を「事例待ち」の受付票に結びつける、`POST /api/satei/media`（1回1件・20MB）、Mac が `02_査定・事例/REINS成約/` に `事例_G7_1.pdf` で保存、下書きへ。
- **2f**：photo-ask と予約を共有して2通を防ぐ、`pushed` が false の知らせの送り直し。
