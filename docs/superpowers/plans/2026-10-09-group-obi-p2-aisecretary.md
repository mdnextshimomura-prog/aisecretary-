# グループからの帯替え P2（MD NEXT秘書 Webhook）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 営業部の LINE グループで下村さんが「@MD NEXT秘書 帯替え ○○」と送ると、直近30分にグループへ出た PDF を MD NEXT秘書が LINE から取り出して portal の `POST /api/jobs/intake` に1回で受付け、グループに「#J12 受付しました」を返す。

**Architecture:** 新しいモジュールを `src/lib/obi/` にまとめる（依頼文の読み取り・入口の確認・PDF の控え・LINE からの取り出し・portal の呼び出し・受付全体・Webhook のイベントの振り分け）。受付全体（`runObiIntake`）と振り分け（`dispatchObiEvents`）は KV・fetch・reply・push・時計・イベントの予約をすべて引数で受け取り、tsx のテストで偽物に差し替えて確かめる。Webhook（`src/app/api/webhook/route.ts`）は、今までのループの前で `dispatchObiEvents` を呼び、帯替えとして扱わなかったイベント（`rest`）だけを今までのループに渡す（ループの中身は変えない）。ほかは `maxDuration = 60`・型の2項目・開始時刻だけ。

**Tech Stack:** Next.js 14.2（App Router・Vercel）、TypeScript 5.9、`@vercel/kv` 3.0、Node の `fetch`・`FormData`・`Blob`・`AbortSignal.timeout`・`crypto`。テストは `tsx` で動かすスクリプト（`npm test`）。**新しい依存は足さない**（足すには下村さんの承認が要る）。

**Spec:** `docs/superpowers/specs/2026-10-09-group-obi-intake-design.md`（正）／受け渡しの約束：`docs/superpowers/plans/2026-10-09-group-obi-contract.md`

**P3 への受け渡し（共通テストデータ）：** 依頼文の読み取りの共通の表は、この計画の Task 2 で **`/Users/shimo/AI開発/apps/aisecretary/tests/fixtures/job-command-cases.json`**（リポジトリの中では `tests/fixtures/job-command-cases.json`）に作る。正本はこの1か所。P3 はこれを `apps/line-secretary/test/fixtures/job-command-cases.json` に**中身を変えずに**写し、`src/jobs/parse.js` が全件同じ結果を出すことをテストで固定する（違いが出たら P3 は parse.js ではなく表を疑い、止めて報告。約束のとおり）。この計画は line-secretary を触らない。

**本番に出す順番：** P1 → P4 → P3 → P2（この計画は最後）。P2 のデプロイは、ほかの3つの本番確認が済んでから。環境変数は一番最後（下村さんの承認後）。詳しくは末尾の「本番に出す手順（ロールアウト）」。

**作業場所：** `/Users/shimo/AI開発/apps/aisecretary/.worktrees/group-obi`（ブランチ `feat/group-obi`。本番が動かしている `integration/email-and-media` から作ったもの）。実装は新しい worktree で行う場合も、このブランチから切る。

## Global Constraints

- 依頼できるのは `JOB_ALLOWED_USER_IDS`（カンマ区切りの LINE userId）に完全一致する人だけ。userId は `^U[0-9a-f]{32}$`、groupId は `^C[0-9a-f]{32}$`
- 扱うのは `source.type === 'group'` かつ `source.groupId === LINE_GROUP_ID` だけ。個別トーク・他のグループは今までどおりの流れ（portal を呼ばない・PDF を控えない）
- `LINE_GROUP_ID` が未設定・形が不正なら、営業部がどこか分からないので**帯替えの機能は何もしない**（どのグループでも返事も PDF の控えもしない。今までの流れのまま）
- `LINE_GROUP_ID` は正しく、`JOB_ALLOWED_USER_IDS`・`PORTAL_BASE_URL`・`JOB_API_TOKEN` のどれかが未設定・形が不正なら、**営業部のグループの依頼の形の発言にだけ**「いま帯替えの受付を止めています」と返す（PDF は控えない。他のグループ・依頼の形でない発言は今までどおり）。既存の機能の動きは変えない
- LINE のイベントの時刻（`timestamp`）が無い・不正なら、PDF は控えず、依頼は受付けない（「依頼の時刻が分かりません」と短く断る）。**今の時刻（`Date.now()`）で代わりにしない**
- 使う PDF：依頼のイベントの時刻からさかのぼって30分以内・依頼より前、営業部に出た `.pdf`（大小問わず）。21件以上なら1件も使わない。合計 25,000,000 バイトまで（控えの大きさで先に断り、取り出すときも本文を少しずつ読み、読んだ合計が上限を超えた時点で読むのをやめる。Content-Length には頼らない）
- 並び：時刻の古い順、同じ時刻は message.id を `BigInt` で比べて小さい順
- 控えの置き場：KV の sorted set（member＝message.id、score＝イベントの時刻）＋ message.id ごとの詳細（hash）。`zadd` で足し、古いものは追加のときに `zremrangebyscore` と詳細の削除で消す。キー全体の期限は1時間
- 時間：締め切りは Webhook の開始から55秒。LINE の取得は1件15秒・全体30秒まで、portal は1回20秒まで。`export const maxDuration = 60`
- 1件でも取れない・`%PDF-` で始まらないなら受付全体をやめる。同じ sha256 は先に出たものだけ残す
- portal の返事が届かない（時間切れ・通信の失敗・5xx）は「結果不明」。受付できなかったとは言わない。締め切りの中で同じ `lineMessageId`・同じ PDF で**1回だけ**呼び直す（portal を呼ぶのは1つの Webhook の中で最大2回）
- 「済み」の境目：portal から受付番号と PDF の一覧が返り、**その一覧が送った PDF と一致した**（件数と sha256 の集合）時点。ここで初めて `onCommitted`（再送させない印）を付け、イベントを完了にする。その後の返事の失敗では受付を取り消さない
- 一覧が合わないときは済みにしない（`completeEvent` を呼ばず予約を外し、503 で再送を待つ）。返事は「受付を確かめられませんでした」を1回だけ（`obi-unconfirmed-notified:<lineMessageId>` の NX）。受付の返事は出さない
- 返事は reply → LINE が 400 番台で断ったときだけ push。結果不明なら送り直さない
- 受付の返事・確かめ中の返事・確かめられない返事は依頼1つにつき1回：`obi-accepted-notified:<lineMessageId>`・`obi-pending-notified:<lineMessageId>`・`obi-unconfirmed-notified:<lineMessageId>` を NX（期限24時間）で置けたときだけ送る。**NX の直後に落ちるとその1通は出ない（受け入れる。二重にはしない）**。受付の確定の後に NX が例外（KV の障害）なら、返事は出さず再送もさせない
- 返事に入れるファイル名・物件名は、改行・制御文字を取り、40文字まで
- portal への本文は約束どおり：`workflow=obi`・`lineMessageId`・`property`（1〜100文字）・`requestText`（〜1000文字）・`requestedBy`（〜60文字）・`replyKind=line-group`・`replyGroupId`・`files`（出た順）。鍵はヘッダ `x-job-token`。**`assigneeName` は送らない**（約束：intake は受け付けない。依頼文の「担当:」は読んでも捨てる）
- 環境変数の追加（`PORTAL_BASE_URL`・`JOB_API_TOKEN`・`JOB_ALLOWED_USER_IDS`）は**下村さんの承認後**、値を画面に出さない方法で Vercel に入れる。この計画では値を書かない・設定しない
- `git push`・デプロイはしない（する前に下村さんに確認）
- テストの実行で `| tail` などのパイプを付けない（終了コードが隠れる）。付けるなら `set -o pipefail;` を先に置く
- 最後のタスクの完了前に `npm run build`（`prisma generate`＋`next build`）が通ることを必ず確かめる
- コミット：`type: 日本語` で、最後の行に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

---

## ファイルの地図

| ファイル | 種類 | 役割 |
|---|---|---|
| `src/lib/obi/parse.ts` | 新規 | line-secretary `src/jobs/parse.js` の移植（`parseJobCommand`） |
| `tests/fixtures/job-command-cases.json` | 新規 | 依頼文の読み取りの共通テスト表（line-secretary にも同じものを置く） |
| `src/lib/obi/sanitize.ts` | 新規 | 返事・portal に渡す文字の整え（40文字・制御文字・ファイル名・物件名の代わり） |
| `src/lib/obi/config.ts` | 新規 | 設定の読み取り（`loadObiConfig`）・入口の判定（`classifyObiEntry`）・控えに足すか（`shouldRecordObiPdf`） |
| `src/lib/line.ts` | 変更 | reply の結果を3つに分ける `replyLineMessageDetailed`・`deliverReply` を足す（既存の関数は変えない） |
| `src/lib/obi/memo.ts` | 新規 | 帯替え用の PDF の控え（KV／メモリ）・NX・PDF の選び方 |
| `src/lib/obi/fetch-pdfs.ts` | 新規 | LINE から全部取り出す（全部取れたときだけ）・sha256・同じ中身を1つに |
| `src/lib/obi/portal.ts` | 新規 | `POST /api/jobs/intake` の呼び出しと結果の分け方・一覧の照合 |
| `src/lib/obi/intake.ts` | 新規 | 受付全体（`runObiIntake`）と返事の文面（`OBI_MESSAGES`） |
| `src/lib/obi/webhook-event.ts` | 新規 | Webhook のイベントの振り分けの帯替えの分（`dispatchObiEvents`）：PDF の控え・依頼の予約〜完了／解放。route.ts から切り出して偽物で試せるようにしたもの |
| `src/app/api/webhook/route.ts` | 変更 | `maxDuration`・型の2項目（`fileSize`・`timestamp`）・開始時刻・`dispatchObiEvents` を今までのループの前で呼び、`rest` だけをループに渡す（ループの中身は変えない） |
| `tests/obi-*.test.ts`・`tests/line-reply.test.ts` | 新規 | tsx のテスト（既存の `ok()` の書き方）。`tests/obi-webhook-event.test.ts` が Webhook の振り分けの試験 |
| `package.json` | 変更 | `npm test` に新しいテストを足す |
| `CLAUDE.md` | 変更 | 環境変数の欄に3つを足す（値は書かない） |

---

### Task 1: 前提の確認（コードは触らない）

**Files:** なし（確認だけ。結果は作業メモと最終報告に書く）

**Interfaces:**
- Consumes: なし
- Produces: 「Vercel で `maxDuration = 60` が使える」「LINE の Webhook の再送の設定（有効／無効）」の確認結果。Task 9 の前提

- [ ] **Step 1: Vercel のプランで関数の実行時間 60 秒が使えるか確かめる**

  `vercel.json`（`crons` だけ）と `.vercel/project.json`（プロジェクト名 `aisecretary`）には実行時間の設定もプランの情報も無いので、手元のファイルだけでは分からない。次のどちらかで確かめる：
  - Vercel MCP の読み取り（`get_project` でプロジェクト `aisecretary` を見て、Fluid compute の有無とチームのプランを確認）。**書き込み系（`update_project` 等）は使わない**
  - 下村さんに、Vercel の画面（Project `aisecretary` → Settings → Functions）で「Max Duration に 60 秒を指定できるか」を見てもらう

  判断：Hobby・Pro のどちらでも 60 秒は上限の内側のはずだが、**確かめられないまま先に進まない**。60 秒が許されない（上限が 60 秒未満）と分かったら、ここで止めて下村さんに相談する（締め切り55秒の設計が成り立たないため）。

- [ ] **Step 2: LINE の Webhook の再送の設定を下村さんに確かめてもらう（手作業）**

  LINE Developers コンソール → チャネル「MD NEXT秘書」→ Messaging API 設定 → 「Webhookの再送」が有効かどうか。Claude は画面を操作しない（設定を変えるのも下村さん）。
  - 有効：結果不明のとき 503 を返せば LINE が再送してくる（設計 14の2 の 2・3）
  - 無効：再送は来ない。結果不明のときは「確かめています」の返事だけが出て、結果は Discord・portal で確かめてもらう（コードは同じ。最終報告と CLAUDE.md の注記に書く）

- [ ] **Step 3: worktree で依存を入れ、今のテスト・型の確認・ビルドが通ることを見る（変更前の基準）**

```bash
cd /Users/shimo/AI開発/apps/aisecretary/.worktrees/group-obi
npm ci
npm test
npx tsc --noEmit --incremental false -p .
npm run build
```
  Expected: `npm test` の最後が `🎉 全て通過`、`tsc` は何も出さずに終わる（終了コード 0）、`npm run build`（`build-checklist`＋`prisma generate`＋`next build`）は終了コード 0。通らなければ先に進まず報告する（この計画の変更より前からの問題）。`npm ci` は lockfile どおりに入れるだけで、依存は増やさない。出力は `| tail` などで切らない（終了コードが隠れるため）。`npm run build` が `src/lib/checklist.generated.ts` を書き換えて差分が出たら、`git checkout -- src/lib/checklist.generated.ts` で戻してから進む（この計画の変更ではないため）。

- [ ] **Step 4: P1（portal）の進み具合を確かめる**

  `apps/reins-report` の P1 計画（`docs/superpowers/plans/2026-10-09-group-obi-p1-portal.md`）の `POST /api/jobs/intake` が本番に出ているか。**出ていなくても P2 の実装とテストは進められる**（portal は偽物で試す）。ただし P2 のデプロイは P1・P4・P3 の本番確認が済んだ後（末尾の「本番に出す手順（ロールアウト）」）。

（このタスクはコミットしない）

---

### Task 2: 依頼文の読み取りの移植と共通テスト表

**Files:**
- Create: `src/lib/obi/parse.ts`
- Create: `tests/fixtures/job-command-cases.json`
- Create: `tests/obi-parse.test.ts`
- Modify: `package.json:11`（`test` に足す）

**Interfaces:**
- Consumes: なし
- Produces:
```ts
export type JobCommand =
  | { action: "review"; no: number; verdict: "ok" | "fix" }
  | { action: "request"; workflow: "obi" | "satei"; property: string; assigneeName: string };
export function parseJobCommand(text: string | null | undefined): JobCommand | null;
```
  共通テスト表 `tests/fixtures/job-command-cases.json`（形：`{ "about": string, "cases": [{ "input": string, "expected": JobCommand | null }] }`）。**line-secretary へのコピーは P3 か後続の作業で行う**（`apps/line-secretary/test/fixtures/job-command-cases.json` に同じ中身を置き、`test/jobs-parse.test.js` から `node:test` で同じ表を回す）。この計画では line-secretary を触らない。

- [ ] **Step 1: 共通テスト表を作る**

  中身は line-secretary の `test/jobs-parse.test.js` の23行と、帯替えまわりの追加12行。`expected` は line-secretary の `src/jobs/parse.js` を実際に動かして作った値（2026-10-09 確認）。

  `tests/fixtures/job-command-cases.json`:
```json
{
  "about": "依頼文の読み取りの共通テスト表。aisecretary（src/lib/obi/parse.ts）と line-secretary（src/jobs/parse.js）が同じ結果を返すことを固定する。expected は line-secretary の parse.js を実行して作った。片方だけ直すときは、この表を両方のリポジトリで同時に直すこと。",
  "cases": [
    {"input":"帯替えして 香椎2丁目の戸建","expected":{"action":"request","workflow":"obi","property":"香椎2丁目の戸建","assigneeName":""}},
    {"input":"帯替えお願いします","expected":{"action":"request","workflow":"obi","property":"","assigneeName":""}},
    {"input":"査定して グランドメゾン香椎 305 担当田中","expected":{"action":"request","workflow":"satei","property":"グランドメゾン香椎 305","assigneeName":"田中"}},
    {"input":"査定 ○○マンション3階 担当：佐藤さん","expected":{"action":"request","workflow":"satei","property":"○○マンション3階","assigneeName":"佐藤"}},
    {"input":"＃Ｊ１２　ＯＫ","expected":{"action":"review","no":12,"verdict":"ok"}},
    {"input":"#j12 直す","expected":{"action":"review","no":12,"verdict":"fix"}},
    {"input":"#J12OK","expected":{"action":"review","no":12,"verdict":"ok"}},
    {"input":"#12 送って","expected":null},
    {"input":"明日帯替えしておいて","expected":null},
    {"input":"査定書の件ありがとう","expected":null},
    {"input":"査定","expected":{"action":"request","workflow":"satei","property":"","assigneeName":""}},
    {"input":"査定を ○○マンション","expected":{"action":"request","workflow":"satei","property":"○○マンション","assigneeName":""}},
    {"input":"帯替え依頼 架空邸","expected":{"action":"request","workflow":"obi","property":"架空邸","assigneeName":""}},
    {"input":"査定額も書き足して","expected":null},
    {"input":"帯替えの件で質問","expected":null},
    {"input":"帯替えの件ですが、明日でいいです","expected":null},
    {"input":"","expected":null},
    {"input":"   ","expected":null},
    {"input":"帯替えをお願いします 香椎2丁目","expected":{"action":"request","workflow":"obi","property":"香椎2丁目","assigneeName":""}},
    {"input":"査定依頼お願いします ○○","expected":{"action":"request","workflow":"satei","property":"○○","assigneeName":""}},
    {"input":"査定して下さい 香椎","expected":{"action":"request","workflow":"satei","property":"香椎","assigneeName":""}},
    {"input":"査定してください 香椎","expected":{"action":"request","workflow":"satei","property":"香椎","assigneeName":""}},
    {"input":"帯替え下さい 香椎","expected":{"action":"request","workflow":"obi","property":"香椎","assigneeName":""}},
    {"input":"オビ替え 香椎","expected":{"action":"request","workflow":"obi","property":"香椎","assigneeName":""}},
    {"input":"おび替えして","expected":{"action":"request","workflow":"obi","property":"","assigneeName":""}},
    {"input":"帯かえ　香椎３丁目","expected":{"action":"request","workflow":"obi","property":"香椎3丁目","assigneeName":""}},
    {"input":"帯変えお願い 担当 田中さん 架空ハイツ","expected":{"action":"request","workflow":"obi","property":"架空ハイツ","assigneeName":"田中"}},
    {"input":"帯替え 担当:佐藤 架空邸 101","expected":{"action":"request","workflow":"obi","property":"架空邸 101","assigneeName":"佐藤"}},
    {"input":"帯替え\n架空邸","expected":{"action":"request","workflow":"obi","property":"架空邸","assigneeName":""}},
    {"input":"帯替え。架空邸","expected":null},
    {"input":"帯替えして、架空邸。","expected":{"action":"request","workflow":"obi","property":"架空邸","assigneeName":""}},
    {"input":"帯替えしてほしい","expected":{"action":"request","workflow":"obi","property":"ほしい","assigneeName":""}},
    {"input":"  帯替え 架空邸  ","expected":{"action":"request","workflow":"obi","property":"架空邸","assigneeName":""}},
    {"input":"帯替えを","expected":{"action":"request","workflow":"obi","property":"","assigneeName":""}},
    {"input":"帯替え  架空 　 ハイツ","expected":{"action":"request","workflow":"obi","property":"架空 ハイツ","assigneeName":""}}
  ]
}
```

- [ ] **Step 2: 失敗するテストを書く**

  `tests/obi-parse.test.ts`:
```ts
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
```

- [ ] **Step 3: 失敗を確かめる**

  Run: `npx tsx tests/obi-parse.test.ts`
  Expected: FAIL（`Cannot find module '../src/lib/obi/parse'`）

- [ ] **Step 4: 移植する**

  `src/lib/obi/parse.ts`:
```ts
/**
 * 帯替え・査定の依頼文の読み取り（設計 2026-10-09 の 7）。
 *
 * line-secretary の src/jobs/parse.js をそのまま移したもの。秘書室とグループで
 * 依頼の読み方がずれないよう、**同じ入力から同じ結果になること**を共通の表
 * tests/fixtures/job-command-cases.json で固定している（line-secretary 側にも同じ表を置く）。
 * ここを直すときは、parse.js と表も同時に直すこと。
 */
export type JobCommand =
  | { action: "review"; no: number; verdict: "ok" | "fix" }
  | {
      action: "request";
      workflow: "obi" | "satei";
      property: string;
      assigneeName: string;
    };

// 全角英数・全角空白・全角＃だけを半角に正規化する（他の記号はそのまま。担当の "：" 等は正規化しない）
function normalizeFullWidth(s: string): string {
  return String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .replace(/＃/g, "#");
}

const REVIEW_RE = /^#\s*J\s*(\d{1,6})\s*(OK|オーケー|完成|直す|直して|差し戻し)$/i;
const OBI_WORDS = ["帯替え", "帯かえ", "帯変え", "オビ替え", "おび替え"];
// 長い語を先に試す（"してください" の前に "して" だけ剥がしてしまわないため）
const FILLERS = ["してください", "して下さい", "お願いします", "下さい", "お願い", "して", "依頼", "を"];
const ASSIGNEE_RE = /担当[:：\s]*(\S+?)(さん)?(\s|$)/;

function verdictOf(word: string): "ok" | "fix" {
  return /^ok$/i.test(word) || word === "オーケー" || word === "完成" ? "ok" : "fix";
}

function isRequestSeparator(rest: string): boolean {
  return rest === "" || /^\s/.test(rest) || FILLERS.some((filler) => rest.startsWith(filler));
}

// 読み飛ばす語を、先頭からなくなるまで繰り返し除く（「をお願いします」「依頼お願いします」のように続くため）
function stripFiller(text: string): string {
  let rest = text;
  for (;;) {
    const filler = FILLERS.find((f) => rest.startsWith(f));
    if (!filler) return rest;
    rest = rest.slice(filler.length);
  }
}

function extractAssignee(text: string): { rest: string; assigneeName: string } {
  const m = text.match(ASSIGNEE_RE);
  if (!m || m.index === undefined) return { rest: text, assigneeName: "" };
  const rest = text.slice(0, m.index) + " " + text.slice(m.index + m[0].length);
  return { rest, assigneeName: m[1] };
}

function toProperty(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[、。]+|[、。]+$/g, "")
    .slice(0, 100);
}

export function parseJobCommand(text: string | null | undefined): JobCommand | null {
  const normalized = normalizeFullWidth(String(text || "")).trim();
  if (!normalized) return null;

  const review = normalized.match(REVIEW_RE);
  if (review) {
    return { action: "review", no: Number(review[1]), verdict: verdictOf(review[2]) };
  }

  let workflow: "obi" | "satei" | null = null;
  let rest = "";
  const obiWord = OBI_WORDS.find((w) => normalized.startsWith(w));
  if (obiWord) {
    workflow = "obi";
    rest = normalized.slice(obiWord.length);
  } else if (normalized.startsWith("査定")) {
    workflow = "satei";
    rest = normalized.slice(2);
  }
  if (!workflow) return null;
  // 依頼語の直後が区切り（空白・読み飛ばす語・文末）のときだけ依頼にする。
  // 「査定額も書き足して」「帯替えの件ですが」を依頼に取らないため
  if (!isRequestSeparator(rest)) return null;

  rest = stripFiller(rest);
  const { rest: withoutAssignee, assigneeName } = extractAssignee(rest);
  const property = toProperty(withoutAssignee);
  return { action: "request", workflow, property, assigneeName };
}
```

- [ ] **Step 5: 通ることを確かめる**

  Run: `npx tsx tests/obi-parse.test.ts`
  Expected: 36行の `✅` と `🎉 全て通過`

- [ ] **Step 6: `npm test` に足す**

  `package.json` の `"test"` の行を次にする：
```json
    "test": "tsx tests/clarify.reducer.test.ts && tsx tests/session.store.test.ts && tsx tests/apihealth.test.ts && tsx tests/clarify-target.test.ts && tsx tests/assignment.test.ts && tsx tests/task-intake.test.ts && tsx tests/obi-parse.test.ts",
```
  Run: `npm test` → Expected: 最後が `🎉 全て通過`

- [ ] **Step 7: コミット**

```bash
git add src/lib/obi/parse.ts tests/fixtures/job-command-cases.json tests/obi-parse.test.ts package.json
git commit -m "$(cat <<'EOF'
feat: 帯替えの依頼文の読み取りを line-secretary から移し、共通のテスト表で固定する

秘書室とグループで依頼の読み方がずれないよう、同じ入力から同じ結果になることを JSON の表で確かめる。
表は line-secretary にも同じものを置く（P3 か後続で写す）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 入口の確認（設定・誰から・どこから）と文字の整え

**Files:**
- Create: `src/lib/obi/sanitize.ts`
- Create: `src/lib/obi/config.ts`
- Create: `tests/obi-config.test.ts`
- Modify: `package.json:11`

**Interfaces:**
- Consumes: `parseJobCommand(text)`（Task 2）
- Produces:
```ts
// sanitize.ts
export function sanitizeForReply(s: string, max?: number /* 既定 40 */): string;
export function sanitizeUploadName(name: string): string; // 100文字まで・末尾 .pdf
export function propertyFor(parsedProperty: string, firstFileName: string): string; // 1〜100文字
// config.ts
export interface ObiConfig { groupId: string; allowedUserIds: string[]; portalBaseUrl: string; jobApiToken: string }
export type ObiEnv = Record<string, string | undefined>;
export function loadObiConfig(env?: ObiEnv): { ok: true; config: ObiConfig } | { ok: false; groupId: string | null; problems: string[] };
export type ObiEntry =
  | { kind: "not-obi" }
  | { kind: "stopped"; groupId: string }
  | { kind: "forbidden"; groupId: string }
  | { kind: "request"; config: ObiConfig; property: string; assigneeName: string /* 読むが portal には渡さない */ };
export interface ObiEntryInput { sourceType: string | undefined; groupId: string | undefined; userId: string | undefined; mentionsBot: boolean; text: string }
export function classifyObiEntry(input: ObiEntryInput, env?: ObiEnv): ObiEntry;
export function shouldRecordObiPdf(input: { sourceType: string | undefined; groupId: string | undefined; fileName: string }, env?: ObiEnv): boolean;
```

判断（設計に書かれていない所）：
- 「メンションがあり」（設計 8）は **@MD NEXT秘書 へのメンション**とする（既存の新規タスクの入口と同じ `taskMentionState(...).mentionsBot`）。社員へのメンションだけでは帯替えにしない
- `LINE_GROUP_ID` 自体が欠けている・不正なら、**どのグループでも not-obi**（返事も控えもしない）。営業部がどこか分からないので、どのグループにも「止めています」を出さない（下村さんの裁定 2026-10-09）
- `LINE_GROUP_ID` は正しく、ほかの設定が欠けている場合、**営業部のグループの依頼の形の発言だけ** stopped（「止めています」）。営業部以外のグループ・依頼の形でない発言は今までどおり（not-obi）。PDF の控えは設定が全部揃っているときだけ
- 物件名が無い依頼（「帯替えお願いします」）は、portal の `property` が必須（1〜100文字）なので、**最初の PDF の名前（.pdf を除く）**を物件名にする。それも空なら「帯替え」
- `JOB_API_TOKEN` に空白・改行が混ざっていたら、削らずに止める
- `PORTAL_BASE_URL` は https のみ（localhost・127.0.0.1 だけ http を許す）。クエリ・# ・利用者情報つきは不正

- [ ] **Step 1: 失敗するテストを書く**

  `tests/obi-config.test.ts`:
```ts
/**
 * 帯替えの入口の確認（設計 6・7・8）。値は偽物。設定は env を引数で渡す。
 */
import {
  loadObiConfig,
  classifyObiEntry,
  shouldRecordObiPdf,
  type ObiEnv,
} from "../src/lib/obi/config";
import { sanitizeForReply, sanitizeUploadName, propertyFor } from "../src/lib/obi/sanitize";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

const G = "C" + "a".repeat(32);
const G2 = "C" + "e".repeat(32);
const SHIMO = "U" + "b".repeat(32);
const OTHER = "U" + "c".repeat(32);
const env: ObiEnv = {
  LINE_GROUP_ID: G,
  JOB_ALLOWED_USER_IDS: ` ${SHIMO} , ${"U" + "d".repeat(32)}`,
  PORTAL_BASE_URL: "https://portal.example.test/",
  JOB_API_TOKEN: "tok-123",
};
const req = (over: Partial<Parameters<typeof classifyObiEntry>[0]> = {}) => ({
  sourceType: "group",
  groupId: G,
  userId: SHIMO,
  mentionsBot: true,
  text: "帯替え 架空邸",
  ...over,
});

// ── 設定の読み取り ──
{
  const r = loadObiConfig(env);
  ok("揃った設定は使える", r.ok);
  if (r.ok) {
    ok("PORTAL_BASE_URL の末尾の / を除く", r.config.portalBaseUrl === "https://portal.example.test");
    ok("許可リストはカンマ区切り・前後の空白を除く", r.config.allowedUserIds.length === 2 && r.config.allowedUserIds[0] === SHIMO);
  }
  const bad = (name: string, over: ObiEnv, problem: string) => {
    const x = loadObiConfig({ ...env, ...over });
    ok(name, !x.ok && x.problems.includes(problem), JSON.stringify(x.ok ? "ok" : x.problems));
  };
  bad("LINE_GROUP_ID が無いと止める", { LINE_GROUP_ID: undefined }, "LINE_GROUP_ID");
  bad("LINE_GROUP_ID の形が違うと止める", { LINE_GROUP_ID: "Cxyz" }, "LINE_GROUP_ID");
  bad("許可リストが空だと止める", { JOB_ALLOWED_USER_IDS: " , " }, "JOB_ALLOWED_USER_IDS");
  bad("許可リストに形の違う ID があると止める", { JOB_ALLOWED_USER_IDS: `${SHIMO},Uabc` }, "JOB_ALLOWED_USER_IDS");
  bad("PORTAL_BASE_URL が http（localhost 以外）だと止める", { PORTAL_BASE_URL: "http://portal.example.test" }, "PORTAL_BASE_URL");
  bad("PORTAL_BASE_URL が URL でないと止める", { PORTAL_BASE_URL: "portal" }, "PORTAL_BASE_URL");
  bad("JOB_API_TOKEN が無いと止める", { JOB_API_TOKEN: "" }, "JOB_API_TOKEN");
  bad("JOB_API_TOKEN に改行が混ざると止める", { JOB_API_TOKEN: "tok\n" }, "JOB_API_TOKEN");
  const local = loadObiConfig({ ...env, PORTAL_BASE_URL: "http://localhost:3000" });
  ok("localhost だけは http を許す（手元の確認用）", local.ok);
}

// ── 入口の判定 ──
{
  const r = classifyObiEntry(req(), env);
  ok("営業部・下村さん・@秘書・先頭が帯替え → 依頼", r.kind === "request" && r.property === "架空邸", JSON.stringify(r));
  ok("担当の指定も読む", (() => { const x = classifyObiEntry(req({ text: "帯替え 担当:佐藤 架空邸" }), env); return x.kind === "request" && x.assigneeName === "佐藤"; })());
  ok("@秘書 のメンションが無ければ扱わない", classifyObiEntry(req({ mentionsBot: false }), env).kind === "not-obi");
  ok("先頭が依頼語でなければ扱わない（メール本文の途中の「帯替え」）", classifyObiEntry(req({ text: "先方に帯替えした資料を送って" }), env).kind === "not-obi");
  ok("「帯替えの件で質問」は依頼にしない", classifyObiEntry(req({ text: "帯替えの件で質問" }), env).kind === "not-obi");
  ok("査定の依頼は扱わない（今までどおり）", classifyObiEntry(req({ text: "査定 架空邸" }), env).kind === "not-obi");
  ok("個別トークは扱わない", classifyObiEntry(req({ sourceType: "user", groupId: undefined }), env).kind === "not-obi");
  ok("複数人トーク（room）は扱わない", classifyObiEntry(req({ sourceType: "room", groupId: undefined }), env).kind === "not-obi");
  ok("他のグループは扱わない", classifyObiEntry(req({ groupId: G2 }), env).kind === "not-obi");
  ok("許可リストにない人は forbidden", classifyObiEntry(req({ userId: OTHER }), env).kind === "forbidden");
  ok("userId が無いと forbidden", classifyObiEntry(req({ userId: undefined }), env).kind === "forbidden");
  ok("鍵が無いと stopped", classifyObiEntry(req(), { ...env, JOB_API_TOKEN: undefined }).kind === "stopped");
  ok("LINE_GROUP_ID が無いと、営業部の ID のグループでも何もしない（not-obi）", classifyObiEntry(req(), { ...env, LINE_GROUP_ID: undefined }).kind === "not-obi");
  ok("LINE_GROUP_ID が無いと、他のグループでも何もしない（not-obi）", classifyObiEntry(req({ groupId: G2 }), { ...env, LINE_GROUP_ID: undefined }).kind === "not-obi");
  ok("LINE_GROUP_ID の形が違っても何もしない（not-obi）", classifyObiEntry(req(), { ...env, LINE_GROUP_ID: "Cxyz" }).kind === "not-obi");
  ok("LINE_GROUP_ID が無いと、許可リスト外の人にも返事をしない（not-obi）", classifyObiEntry(req({ userId: OTHER }), { ...env, LINE_GROUP_ID: undefined }).kind === "not-obi");
  ok("営業部の ID は正しく他が欠けている：営業部の依頼の形は stopped", classifyObiEntry(req(), { ...env, PORTAL_BASE_URL: undefined }).kind === "stopped");
  ok("営業部の ID は正しく他が欠けている：他のグループは not-obi", classifyObiEntry(req({ groupId: G2 }), { ...env, PORTAL_BASE_URL: undefined }).kind === "not-obi");
  ok("営業部の ID は正しく他が欠けている：依頼の形でない発言は not-obi", classifyObiEntry(req({ text: "おはようございます" }), { ...env, JOB_API_TOKEN: undefined }).kind === "not-obi");
}

// ── PDF の控えに足すか ──
{
  const base = { sourceType: "group", groupId: G, fileName: "図面.PDF" };
  ok("営業部の .PDF（大文字）は控える", shouldRecordObiPdf(base, env));
  ok(".pdfx は控えない", !shouldRecordObiPdf({ ...base, fileName: "a.pdfx" }, env));
  ok("画像の名前は控えない", !shouldRecordObiPdf({ ...base, fileName: "a.jpg" }, env));
  ok("他のグループは控えない", !shouldRecordObiPdf({ ...base, groupId: G2 }, env));
  ok("個別トークは控えない", !shouldRecordObiPdf({ ...base, sourceType: "user", groupId: undefined }, env));
  ok("設定が欠けていたら控えない", !shouldRecordObiPdf(base, { ...env, JOB_ALLOWED_USER_IDS: "" }));
  ok("LINE_GROUP_ID が無ければ控えない", !shouldRecordObiPdf(base, { ...env, LINE_GROUP_ID: undefined }));
}

// ── 文字の整え ──
{
  ok("改行は空白に、制御文字は除く", sanitizeForReply("a\nb\u0007c‮") === "a bc");
  const long = sanitizeForReply("あ".repeat(50));
  ok("40文字まで（超えたら末尾を…に）", Array.from(long).length === 40 && long.endsWith("…"), long);
  ok("区切り文字を潰して .pdf を付ける", sanitizeUploadName("../x/y") === ".._x_y.pdf");
  ok("100文字を超える名前は .pdf を残して切る", (() => { const n = sanitizeUploadName("い".repeat(150) + ".pdf"); return Array.from(n).length === 100 && n.endsWith(".pdf"); })());
  ok("物件名があればそれ", propertyFor("架空邸", "a.pdf") === "架空邸");
  ok("物件名が空なら最初の PDF の名前", propertyFor("", "図面A.pdf") === "図面A");
  ok("どちらも空なら「帯替え」", propertyFor("", ".pdf") === "帯替え");
}

console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: 失敗を確かめる**

  Run: `npx tsx tests/obi-config.test.ts`
  Expected: FAIL（`Cannot find module '../src/lib/obi/config'`）

- [ ] **Step 3: 文字の整えを書く**

  `src/lib/obi/sanitize.ts`:
```ts
/**
 * 返事・portal に渡す文字の整え（設計「返事に入れるファイル名・物件名は、改行・制御文字を取り、40文字までにする」）。
 *
 * LINE のファイル名や依頼文は誰でも好きに付けられる。改行や見えない文字が入ると、
 * グループの返事の見た目を崩したり、別の行の文に見せかけたりできるため取り除く。
 */
// 改行・タブを含む制御文字（C0・DEL・C1）
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// 幅のない文字・文字の向きを変える文字
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁤﻿]/g;

function cut(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : s;
}

/** 返事に書く1項目（ファイル名・物件名）。改行は空白に、制御文字は除き、max 文字まで */
export function sanitizeForReply(s: string, max = 40): string {
  const flat = String(s ?? "")
    .replace(INVISIBLE_RE, "")
    .replace(/\r\n|\r|\n/g, " ")
    .replace(CONTROL_RE, "")
    .replace(/ {2,}/g, " ")
    .trim();
  return cut(flat, max);
}

/** portal に送るファイル名。区切り文字（/ \）を潰し、100文字まで、末尾は必ず .pdf */
export function sanitizeUploadName(name: string): string {
  let s = String(name ?? "")
    .replace(INVISIBLE_RE, "")
    .replace(CONTROL_RE, "")
    .replace(/[\\/]/g, "_")
    .trim();
  if (!/\.pdf$/i.test(s)) s = `${s || "file"}.pdf`;
  const chars = Array.from(s);
  if (chars.length > 100) s = chars.slice(0, 96).join("") + ".pdf";
  return s;
}

/**
 * portal に送る物件名（必須・1〜100文字）。
 * 依頼文に物件名が無い（「帯替えお願いします」だけ）ときは、最初の PDF の名前（.pdf を除く）を使う。
 * それも空なら「帯替え」。
 */
export function propertyFor(parsedProperty: string, firstFileName: string): string {
  const p = sanitizeForReply(parsedProperty, 100);
  if (p) return p;
  const base = sanitizeForReply(String(firstFileName ?? "").replace(/\.pdf$/i, ""), 100);
  return base || "帯替え";
}
```

- [ ] **Step 4: 入口の確認を書く**

  `src/lib/obi/config.ts`:
```ts
/**
 * グループからの帯替えの入口の確認（設計 2026-10-09 の 6）。
 *
 * 「どこから・誰から」を固定し、合わなければ何もしない（fail closed）。
 *   - 営業部のグループ（LINE_GROUP_ID）からだけ
 *   - 発言者が JOB_ALLOWED_USER_IDS のどれかと完全一致
 *   - LINE_GROUP_ID が欠ける・形が違うなら、営業部がどこか分からないので帯替えの機能は何もしない
 *     （どのグループでも返事も控えもしない。今までの流れのまま）
 *   - LINE_GROUP_ID は正しく、ほかの設定（JOB_ALLOWED_USER_IDS・PORTAL_BASE_URL・JOB_API_TOKEN）が
 *     欠ける・形が違うなら、営業部の依頼の形の発言にだけ「止めています」と返す（控えもしない）
 * 値はログに出さない（出すのは「どの項目がだめか」だけ）。
 */
import { parseJobCommand } from "./parse";

const USER_ID_RE = /^U[0-9a-f]{32}$/;
const GROUP_ID_RE = /^C[0-9a-f]{32}$/;

export interface ObiConfig {
  groupId: string;
  allowedUserIds: string[];
  portalBaseUrl: string; // 末尾の / は除いてある
  jobApiToken: string;
}

export type ObiEnv = Record<string, string | undefined>;

export type ObiConfigResult =
  | { ok: true; config: ObiConfig }
  | {
      ok: false;
      /** LINE_GROUP_ID だけは正しい場合の値（他のグループの発言を「止めています」にしないため） */
      groupId: string | null;
      problems: string[];
    };

function parsePortalBaseUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  if (u.search || u.hash || u.username || u.password) return null;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

export function loadObiConfig(env: ObiEnv = process.env): ObiConfigResult {
  const problems: string[] = [];

  const groupId = env.LINE_GROUP_ID ?? "";
  const groupOk = GROUP_ID_RE.test(groupId);
  if (!groupOk) problems.push("LINE_GROUP_ID");

  const allowedUserIds = (env.JOB_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedUserIds.length === 0 || !allowedUserIds.every((id) => USER_ID_RE.test(id))) {
    problems.push("JOB_ALLOWED_USER_IDS");
  }

  const portalBaseUrl = parsePortalBaseUrl(env.PORTAL_BASE_URL);
  if (!portalBaseUrl) problems.push("PORTAL_BASE_URL");

  const jobApiToken = env.JOB_API_TOKEN ?? "";
  // 前後の空白・改行が混ざった値は直さずに止める（勝手に削ると、違う鍵で通ってしまう事故に気づけない）
  if (!jobApiToken || /\s/.test(jobApiToken)) problems.push("JOB_API_TOKEN");

  if (problems.length > 0) {
    return { ok: false, groupId: groupOk ? groupId : null, problems };
  }
  return {
    ok: true,
    config: { groupId, allowedUserIds, portalBaseUrl: portalBaseUrl!, jobApiToken },
  };
}

export type ObiEntry =
  | { kind: "not-obi" }
  | { kind: "stopped"; groupId: string }
  | { kind: "forbidden"; groupId: string }
  | {
      kind: "request";
      config: ObiConfig;
      property: string;
      /** 「担当:」は読むが portal には渡さない（約束：intake は assigneeName を受け付けない） */
      assigneeName: string;
    };

export interface ObiEntryInput {
  sourceType: string | undefined;
  groupId: string | undefined;
  userId: string | undefined;
  /** @MD NEXT秘書 へのメンションがあるか */
  mentionsBot: boolean;
  /** メンションを除いた本文 */
  text: string;
}

/**
 * 帯替えの依頼かどうかの判定（設計 6・7・8）。
 *
 * 帯替えとして扱うのは「@MD NEXT秘書 へのメンションがあり、本文の先頭が依頼語」のときだけ。
 * それ以外・個別トーク・他のグループは not-obi（今までどおりの流れへ）。
 */
export function classifyObiEntry(input: ObiEntryInput, env: ObiEnv = process.env): ObiEntry {
  if (!input.mentionsBot) return { kind: "not-obi" };
  const cmd = parseJobCommand(input.text);
  if (!cmd || cmd.action !== "request" || cmd.workflow !== "obi") return { kind: "not-obi" };
  if (input.sourceType !== "group" || !input.groupId) return { kind: "not-obi" };

  const loaded = loadObiConfig(env);
  if (!loaded.ok) {
    // LINE_GROUP_ID が無い・形が違う：どのグループが営業部か分からない。
    // どのグループでも帯替えとして扱わない（返事も控えもしない。今までの流れのまま）
    if (!loaded.groupId) return { kind: "not-obi" };
    // 営業部の ID は分かっていて、それと違うグループなら、帯替えとして扱わない
    if (loaded.groupId !== input.groupId) return { kind: "not-obi" };
    console.error("帯替えの受付を止めています（設定の不足・不正）:", loaded.problems.join(","));
    return { kind: "stopped", groupId: input.groupId };
  }
  const { config } = loaded;
  if (input.groupId !== config.groupId) return { kind: "not-obi" };
  if (!input.userId || !config.allowedUserIds.includes(input.userId)) {
    return { kind: "forbidden", groupId: input.groupId };
  }
  return { kind: "request", config, property: cmd.property, assigneeName: cmd.assigneeName };
}

/** 帯替え用の PDF の控えに足すファイルか（営業部のグループ・設定が揃っている・.pdf） */
export function shouldRecordObiPdf(
  input: { sourceType: string | undefined; groupId: string | undefined; fileName: string },
  env: ObiEnv = process.env
): boolean {
  if (input.sourceType !== "group" || !input.groupId) return false;
  if (!/\.pdf$/i.test(String(input.fileName ?? "").trim())) return false;
  const loaded = loadObiConfig(env);
  return loaded.ok && loaded.config.groupId === input.groupId;
}
```

- [ ] **Step 5: 通ることを確かめる**

  Run: `npx tsx tests/obi-config.test.ts`
  Expected: すべて `✅`、最後が `🎉 全て通過`（「帯替えの受付を止めています（設定の不足・不正）: JOB_API_TOKEN」などの行が出るのは正しい動き。項目の名前だけで値は出ない）

- [ ] **Step 6: `npm test` に足す**

```json
    "test": "tsx tests/clarify.reducer.test.ts && tsx tests/session.store.test.ts && tsx tests/apihealth.test.ts && tsx tests/clarify-target.test.ts && tsx tests/assignment.test.ts && tsx tests/task-intake.test.ts && tsx tests/obi-parse.test.ts && tsx tests/obi-config.test.ts",
```
  Run: `npm test` → Expected: `🎉 全て通過`

- [ ] **Step 7: コミット**

```bash
git add src/lib/obi/sanitize.ts src/lib/obi/config.ts tests/obi-config.test.ts package.json
git commit -m "$(cat <<'EOF'
feat: グループからの帯替えの入口の確認（営業部・許可した人・設定が揃っているときだけ）

合わなければ何もしない（fail closed）。LINE_GROUP_ID が無ければ帯替えは何もせず、ほかの設定が欠けたら営業部の依頼にだけ止めていると返す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: reply の結果を「送れた・はっきり失敗・不明」に分ける

**Files:**
- Modify: `src/lib/line.ts:176`（ファイルの末尾に足す。既存の `sendLineMessage`（20-40行）・`pushLineMessage`（59-79行）は変えない）
- Create: `tests/line-reply.test.ts`
- Modify: `package.json:11`

**Interfaces:**
- Consumes: 既存の `pushLineMessage(to, text): Promise<boolean>`（`src/lib/line.ts:59`。通信の失敗では例外を投げる）
- Produces:
```ts
export type ReplyOutcome = { kind: "sent"; messageId: string | null } | { kind: "rejected"; status: number } | { kind: "unknown" };
export async function replyLineMessageDetailed(replyToken: string, text: string, timeoutMs?: number /* 既定 8000 */): Promise<ReplyOutcome>; // 例外を投げない
export type ReplyDelivery = "replied" | "pushed" | "push-failed" | "unknown";
export async function deliverReply(text: string, io: { reply: (text: string) => Promise<ReplyOutcome>; push: (text: string) => Promise<boolean> }): Promise<ReplyDelivery>; // io の例外は外へ出す
```

- [ ] **Step 1: 失敗するテストを書く**

  `tests/line-reply.test.ts`:
```ts
/**
 * reply の結果を「送れた・はっきり失敗・不明」に分ける（設計 14）。LINE は偽物の fetch に差し替える。
 */
import {
  replyLineMessageDetailed,
  deliverReply,
  pushLineMessage,
  sendLineMessage,
  type ReplyOutcome,
} from "../src/lib/line";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
let respond: () => Promise<Response> = async () => new Response("{}", { status: 200 });
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
  return respond();
}) as typeof fetch;

const json = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function main() {
  // ── reply の3つの結果 ──
  respond = json(200, { sentMessages: [{ id: "m1" }] });
  let r = await replyLineMessageDetailed("rt", "こんにちは");
  ok("200 は送れた（送ったメッセージの ID つき）", r.kind === "sent" && r.messageId === "m1", JSON.stringify(r));
  ok("reply の宛先と本文", calls[0].url.endsWith("/v2/bot/message/reply") && calls[0].body?.replyToken === "rt");

  respond = json(400, { message: "Invalid reply token" });
  r = await replyLineMessageDetailed("rt", "x");
  ok("400 ははっきり失敗", r.kind === "rejected" && r.status === 400, JSON.stringify(r));

  respond = json(500, {});
  r = await replyLineMessageDetailed("rt", "x");
  ok("500 は不明", r.kind === "unknown");

  respond = async () => {
    throw new TypeError("fetch failed");
  };
  r = await replyLineMessageDetailed("rt", "x");
  ok("通信の失敗は不明（例外を投げない）", r.kind === "unknown");

  respond = async () => {
    throw new DOMException("timed out", "TimeoutError");
  };
  r = await replyLineMessageDetailed("rt", "x");
  ok("時間切れは不明", r.kind === "unknown");

  // ── reply → push の送り直し ──
  const pushes: string[] = [];
  const io = (outcome: ReplyOutcome, pushOk = true) => ({
    reply: async () => outcome,
    push: async (t: string) => {
      pushes.push(t);
      return pushOk;
    },
  });
  ok("送れたら push しない", (await deliverReply("a", io({ kind: "sent", messageId: null }))) === "replied" && pushes.length === 0);
  ok("はっきり失敗なら push で送り直す", (await deliverReply("b", io({ kind: "rejected", status: 400 }))) === "pushed" && pushes.join() === "b");
  ok("push も失敗したら push-failed", (await deliverReply("c", io({ kind: "rejected", status: 400 }, false))) === "push-failed");
  pushes.length = 0;
  ok("不明なら送り直さない", (await deliverReply("d", io({ kind: "unknown" }))) === "unknown" && pushes.length === 0);

  // ── 本物の reply/push の組み合わせ（帯替えの受付で webhook がつなぐ形） ──
  calls.length = 0;
  let n = 0;
  respond = async () => (n++ === 0 ? json(400, {})() : json(200, {})());
  const d = await deliverReply("受付しました", {
    reply: (t) => replyLineMessageDetailed("rt", t),
    push: (t) => pushLineMessage("Cgroup", t).catch(() => false),
  });
  ok("reply 400 → push で同じ本文をグループへ", d === "pushed" && calls[1].url.endsWith("/v2/bot/message/push") && calls[1].body?.to === "Cgroup", JSON.stringify(calls.map((c) => c.url)));

  // ── 既存の sendLineMessage は今の動きのまま ──
  respond = json(400, {});
  ok("sendLineMessage は 400 で null を返す（今どおり）", (await sendLineMessage("rt", "x")) === null);

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
```

- [ ] **Step 2: 失敗を確かめる**

  Run: `npx tsx tests/line-reply.test.ts`
  Expected: FAIL（`replyLineMessageDetailed is not a function` などの例外で止まる）

- [ ] **Step 3: `src/lib/line.ts` の末尾（176行の `}` の後）に足す**

```ts


// ── 返事の結果を3つに分けて返す（設計 2026-10-09 の 14） ──
//
// sendLineMessage は「送れた／送れなかった」しか返さず、通信の失敗では例外を投げる。
// 帯替えの受付の返事は、LINE が 400 番台で断った（期限切れ・使用済みの replyToken）ときだけ
// push で送り直し、通信の失敗など結果が分からないときは送り直さない（二重の返事を避ける）。
// 既存の呼び出し元は sendLineMessage のまま（動きを変えない）。
export type ReplyOutcome =
  | { kind: "sent"; messageId: string | null }
  | { kind: "rejected"; status: number }
  | { kind: "unknown" };

const REPLY_TIMEOUT_MS = 8_000;

export async function replyLineMessageDetailed(
  replyToken: string,
  text: string,
  timeoutMs: number = REPLY_TIMEOUT_MS
): Promise<ReplyOutcome> {
  let res: Response;
  try {
    res = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    // 届いたかどうか分からない（時間切れ・通信の切断）
    console.error("LINE reply の結果が分からない:", (err as { name?: string })?.name ?? err);
    return { kind: "unknown" };
  }
  if (res.status >= 400 && res.status < 500) {
    console.error("LINE reply を断られた:", res.status);
    return { kind: "rejected", status: res.status };
  }
  if (!res.ok) {
    console.error("LINE reply の結果が分からない（5xx）:", res.status);
    return { kind: "unknown" };
  }
  try {
    const data = (await res.json()) as { sentMessages?: Array<{ id: string }> };
    return { kind: "sent", messageId: data.sentMessages?.[0]?.id ?? null };
  } catch {
    return { kind: "sent", messageId: null };
  }
}

export type ReplyDelivery = "replied" | "pushed" | "push-failed" | "unknown";

/**
 * reply → （はっきり断られたときだけ）push の順で1回だけ送る。
 * io の関数が投げた例外は外へそのまま出す（呼び出し側が「途中で止まった」を扱えるように）。
 */
export async function deliverReply(
  text: string,
  io: {
    reply: (text: string) => Promise<ReplyOutcome>;
    push: (text: string) => Promise<boolean>;
  }
): Promise<ReplyDelivery> {
  const r = await io.reply(text);
  if (r.kind === "sent") return "replied";
  if (r.kind === "unknown") return "unknown"; // 送り直さない（二重の返事を避ける）
  const pushed = await io.push(text);
  if (!pushed) console.error("reply を断られ、push でも送れなかった");
  return pushed ? "pushed" : "push-failed";
}
```

- [ ] **Step 4: 通ることを確かめる**

  Run: `npx tsx tests/line-reply.test.ts`
  Expected: すべて `✅`、`🎉 全て通過`

- [ ] **Step 5: `npm test` に足し、型を確かめる**

```json
    "test": "tsx tests/clarify.reducer.test.ts && tsx tests/session.store.test.ts && tsx tests/apihealth.test.ts && tsx tests/clarify-target.test.ts && tsx tests/assignment.test.ts && tsx tests/task-intake.test.ts && tsx tests/obi-parse.test.ts && tsx tests/obi-config.test.ts && tsx tests/line-reply.test.ts",
```
  Run: `npm test && npx tsc --noEmit --incremental false -p .`
  Expected: `🎉 全て通過`、tsc は何も出さない

- [ ] **Step 6: コミット**

```bash
git add src/lib/line.ts tests/line-reply.test.ts package.json
git commit -m "$(cat <<'EOF'
feat: LINE の reply の結果を「送れた・はっきり失敗・不明」に分け、はっきり失敗のときだけ push で送り直す

帯替えの受付の返事を二重にしないため。既存の sendLineMessage の動きは変えない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 帯替え用の PDF の控え（KV の sorted set＋詳細）と PDF の選び方

**Files:**
- Create: `src/lib/obi/memo.ts`
- Create: `tests/obi-memo.test.ts`
- Modify: `package.json:11`

**Interfaces:**
- Consumes: `@vercel/kv` の `kv`（既存の `src/lib/email/session.ts:1` と同じ）
- Produces:
```ts
export interface ObiPdfRecord { messageId: string; fileName: string; size: number; timestamp: number; userId: string }
export const OBI_WINDOW_MS: number;          // 30分
export const OBI_RETENTION_MS: number;       // 60分
export const OBI_MEMO_TTL_SECONDS: number;   // 3600
export const OBI_MAX_FILES: number;          // 20
export const OBI_MAX_TOTAL_BYTES: number;    // 25_000_000
export const OBI_NOTIFY_TTL_SECONDS: number; // 86400
export interface ObiStore {
  addPdf(groupId: string, rec: ObiPdfRecord, removeBefore: number): Promise<void>;
  listPdfs(groupId: string, minTs: number, maxTs: number): Promise<ObiPdfRecord[]>;
  setNx(key: string, ttlSeconds: number): Promise<boolean>;
}
export interface ObiKvClient { /* hset・zadd・zrange(byScore)・zremrangebyscore・hdel・hmget・expire・set(nx,ex) */ }
export function createKvObiStore(client: ObiKvClient): ObiStore;
export type MemoryObiStore = ObiStore & { sizes(groupId: string): { z: number; h: number } };
export function createMemoryObiStore(now?: () => number): MemoryObiStore;
export function getObiStore(): ObiStore; // KV の設定があれば KV、無ければメモリ
export async function recordObiPdf(store: ObiStore, groupId: string, rec: ObiPdfRecord): Promise<void>;
export type ObiSelection = { kind: "none" } | { kind: "too-many"; count: number } | { kind: "too-large"; totalBytes: number } | { kind: "ok"; pdfs: ObiPdfRecord[] };
export function selectObiPdfs(records: ObiPdfRecord[], request: { messageId: string; timestamp: number }): ObiSelection;
```

設計への補足（Codex の残りの指摘 a）：古いものを並びから消すときは、**同じ message.id の詳細も消す**（`zrange` で消す対象を先に読み、`zremrangebyscore` の後に `hdel`）。並びの member は `m:<message.id>`（KV の読み出しが数字だけの文字列を数値に読み替え、安全な整数を超える id が丸められるのを避けるため）。境目：30分ちょうど前は使う。依頼と同じ時刻でも id が依頼より小さければ使う。

- [ ] **Step 1: 失敗するテストを書く**

  `tests/obi-memo.test.ts`:
```ts
/**
 * 帯替え用の PDF の控え（設計 9）。メモリの控えと、KV の操作の順番（偽物の KV）を確かめる。
 */
import {
  createMemoryObiStore,
  createKvObiStore,
  recordObiPdf,
  selectObiPdfs,
  OBI_WINDOW_MS,
  type ObiKvClient,
  type ObiPdfRecord,
} from "../src/lib/obi/memo";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

const G = "C" + "a".repeat(32);
const U = "U" + "b".repeat(32);
const T = 1_760_000_000_000;
const MIN = 60_000;
const rec = (id: string, ts: number, name = `${id}.pdf`, size = 1000): ObiPdfRecord => ({
  messageId: id,
  fileName: name,
  size,
  timestamp: ts,
  userId: U,
});

async function main() {
  // ── メモリの控え ──
  {
    const s = createMemoryObiStore(() => T);
    await recordObiPdf(s, G, rec("100", T - 75 * MIN));
    await recordObiPdf(s, G, rec("200", T - 10 * MIN));
    ok("1時間より古いものは追加のときに並びと詳細の両方から消える", s.sizes(G).z === 1 && s.sizes(G).h === 1, JSON.stringify(s.sizes(G)));
    const got = await s.listPdfs(G, T - OBI_WINDOW_MS, T);
    ok("時刻の範囲で引ける", got.length === 1 && got[0].messageId === "200");
    await recordObiPdf(s, G, rec("200", T - 10 * MIN));
    ok("同じ message.id の再送は重複しない", (await s.listPdfs(G, 0, T)).length === 1);
    await recordObiPdf(s, G, rec("abc", T));
    ok("数字でない message.id は控えない", (await s.listPdfs(G, 0, T)).length === 1);
    ok("別のグループの控えは混ざらない", (await s.listPdfs("C" + "f".repeat(32), 0, T)).length === 0);
    ok("NX：1回目は置ける", await s.setNx("k", 60));
    ok("NX：2回目は置けない", !(await s.setNx("k", 60)));
  }
  {
    let now = T;
    const s = createMemoryObiStore(() => now);
    await s.setNx("k", 60);
    now += 61_000;
    ok("NX：期限が切れたらまた置ける", await s.setNx("k", 60));
  }

  // ── KV の控え（偽物の KV で、呼ぶ順番と引数を確かめる） ──
  {
    const calls: unknown[][] = [];
    const zrangeResults: string[][] = [];
    let hmgetResult: Record<string, unknown> | null = null;
    let setResult: unknown = "OK";
    const fake: ObiKvClient = {
      hset: async (k, v) => { calls.push(["hset", k, v]); return 1; },
      zadd: async (k, sm) => { calls.push(["zadd", k, sm]); return 1; },
      zrange: async (k, min, max, o) => { calls.push(["zrange", k, min, max, o]); return zrangeResults.shift() ?? []; },
      zremrangebyscore: async (k, min, max) => { calls.push(["zremrangebyscore", k, min, max]); return 1; },
      hdel: async (k, ...f) => { calls.push(["hdel", k, ...f]); return 1; },
      hmget: async (k, ...f) => { calls.push(["hmget", k, ...f]); return hmgetResult; },
      expire: async (k, sec) => { calls.push(["expire", k, sec]); return 1; },
      set: async (k, v, o) => { calls.push(["set", k, v, o]); return setResult; },
    };
    const s = createKvObiStore(fake);
    const z = `obi-pdf:z:${G}`;
    const h = `obi-pdf:h:${G}`;
    const r = rec("9007199254740993", T);
    zrangeResults.push(["m:100", "m:101"]);
    await recordObiPdf(s, G, r);
    const cut = T - 60 * MIN - 1;
    const expected = [
      ["hset", h, { "m:9007199254740993": JSON.stringify(r) }],
      ["zadd", z, { score: T, member: "m:9007199254740993" }],
      ["zrange", z, "-inf", cut, { byScore: true }],
      ["zremrangebyscore", z, "-inf", cut],
      ["hdel", h, "m:100", "m:101"],
      ["expire", z, 3600],
      ["expire", h, 3600],
    ];
    ok("足す：詳細→並び→古いものを並びと詳細から消す→期限1時間", JSON.stringify(calls) === JSON.stringify(expected), JSON.stringify(calls));

    calls.length = 0;
    await recordObiPdf(s, G, rec("300", T));
    ok("古いものが無ければ消さない", !calls.some((c) => c[0] === "zremrangebyscore" || c[0] === "hdel"));

    calls.length = 0;
    zrangeResults.push(["m:200", "m:300", "m:400"]);
    hmgetResult = {
      "m:200": JSON.stringify(rec("200", T - MIN)),
      "m:300": rec("300", T - MIN), // KV が JSON を読み替えて返した形
      "m:400": null, // 詳細が消えている
    };
    const listed = await s.listPdfs(G, T - OBI_WINDOW_MS, T);
    ok("引く：時刻の範囲で並びを引き、詳細をまとめて読む", JSON.stringify(calls[0]) === JSON.stringify(["zrange", z, T - OBI_WINDOW_MS, T, { byScore: true }]) && calls[1][0] === "hmget");
    ok("引く：文字列・読み替え済みのどちらも読め、詳細の無いものは飛ばす", listed.map((x) => x.messageId).join() === "200,300", JSON.stringify(listed));

    calls.length = 0;
    ok("NX：OK なら true", await s.setNx("obi-accepted-notified:1", 86400));
    ok("NX：nx と期限24時間で置く", JSON.stringify(calls[0]) === JSON.stringify(["set", "obi-accepted-notified:1", 1, { nx: true, ex: 86400 }]));
    setResult = null;
    ok("NX：置けなければ false", !(await s.setNx("obi-accepted-notified:1", 86400)));
  }

  // ── 依頼に使う PDF の選び方 ──
  {
    const req = { messageId: "500", timestamp: T };
    const s1 = selectObiPdfs(
      [
        rec("100", T - OBI_WINDOW_MS), // ちょうど30分前：使う
        rec("101", T - OBI_WINDOW_MS - 1), // 30分より前：使わない
        rec("102", T), // 依頼と同じ時刻・依頼より前の id：使う
        rec("600", T - 1000), // 依頼より後の id：使わない
        rec("103", T - 1000, "a.jpg"), // PDF でない：使わない
        rec("104", T + 1), // 依頼より後の時刻：使わない
      ],
      req
    );
    ok("30分の境目・依頼より後・PDF 以外の扱い", s1.kind === "ok" && s1.pdfs.map((p) => p.messageId).join() === "100,102", JSON.stringify(s1));

    const big = "9007199254740999";
    const s2 = selectObiPdfs(
      [rec("9007199254740995", T - 5000), rec("9007199254740993", T - 5000), rec("10", T - 6000), rec("9", T - 5000)],
      { messageId: big, timestamp: T }
    );
    ok("時刻の古い順・同じ時刻は id を数として小さい順（安全な整数を超えても）", s2.kind === "ok" && s2.pdfs.map((p) => p.messageId).join() === "10,9,9007199254740993,9007199254740995", JSON.stringify(s2));

    const many = (n: number) => Array.from({ length: n }, (_, i) => rec(String(i + 1), T - 1000));
    const s20 = selectObiPdfs(many(20), req);
    ok("20件は全部使う", s20.kind === "ok" && s20.pdfs.length === 20);
    const s21 = selectObiPdfs(many(21), req);
    ok("21件以上は1件も使わない", s21.kind === "too-many" && s21.count === 21);

    const s3 = selectObiPdfs([rec("1", T - 1, "a.pdf", 12_500_000), rec("2", T - 1, "b.pdf", 12_500_000)], req);
    ok("合計 25,000,000 バイトちょうどは使う", s3.kind === "ok");
    const s4 = selectObiPdfs([rec("1", T - 1, "a.pdf", 12_500_000), rec("2", T - 1, "b.pdf", 12_500_001)], req);
    ok("合計が上限を超えたら使わない", s4.kind === "too-large" && s4.totalBytes === 25_000_001);

    ok("同じ message.id が2つあっても1つ", (() => { const x = selectObiPdfs([rec("1", T - 1), rec("1", T - 1)], req); return x.kind === "ok" && x.pdfs.length === 1; })());
    ok("無ければ none", selectObiPdfs([], req).kind === "none");
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
```

- [ ] **Step 2: 失敗を確かめる**

  Run: `npx tsx tests/obi-memo.test.ts`
  Expected: FAIL（`Cannot find module '../src/lib/obi/memo'`）

- [ ] **Step 3: 控えを書く**

  `src/lib/obi/memo.ts`:
```ts
/**
 * 帯替え用の PDF の控え（設計 2026-10-09 の 9）。既存のメール・タスク用の控え（emailmedia 等）とは別。
 *
 * 置き場：Vercel KV
 *   - sorted set `obi-pdf:z:<groupId>`：member＝`m:<message.id>`、score＝LINE のイベントの時刻（ms）
 *   - hash       `obi-pdf:h:<groupId>`：field＝`m:<message.id>`、value＝詳細（JSON）
 * member に `m:` を付けるのは、KV の読み出しが数字だけの文字列を数値に読み替え、
 * 安全な整数を超える message.id の桁が丸められるのを避けるため。
 *
 * 足すときは zadd（同時に届いても上書きしない。同じ message.id の再送は同じ member なので重複しない）。
 * 1時間より古いものは追加のときに並び（zremrangebyscore）と詳細（hdel）の両方から消し、キー全体の期限も1時間にする。
 */
import { kv } from "@vercel/kv";

export interface ObiPdfRecord {
  messageId: string;
  fileName: string;
  size: number; // LINE の fileSize（バイト）。分からなければ 0
  timestamp: number; // LINE のイベントの時刻（ms）
  userId: string; // 貼った人
}

export const OBI_WINDOW_MS = 30 * 60 * 1000; // 依頼からさかのぼる時間
export const OBI_RETENTION_MS = 60 * 60 * 1000; // 控えを残す時間
export const OBI_MEMO_TTL_SECONDS = 60 * 60;
export const OBI_MAX_FILES = 20;
export const OBI_MAX_TOTAL_BYTES = 25_000_000;
// 「返事は1回だけ」の印の期限。LINE の再送はこれより短い間に来る
export const OBI_NOTIFY_TTL_SECONDS = 24 * 60 * 60;

const MESSAGE_ID_RE = /^\d{1,64}$/;

export interface ObiStore {
  /** 控えに足す。score が removeBefore より小さいものは並びと詳細の両方から消す */
  addPdf(groupId: string, rec: ObiPdfRecord, removeBefore: number): Promise<void>;
  /** 時刻が minTs 以上 maxTs 以下の控え（並びは問わない） */
  listPdfs(groupId: string, minTs: number, maxTs: number): Promise<ObiPdfRecord[]>;
  /** 無ければ置く（NX）。置けたら true */
  setNx(key: string, ttlSeconds: number): Promise<boolean>;
}

/** createKvObiStore が使う KV の操作（テストで偽物に差し替えられるよう、使う分だけ） */
export interface ObiKvClient {
  hset(key: string, values: Record<string, string>): Promise<unknown>;
  zadd(key: string, sm: { score: number; member: string }): Promise<unknown>;
  zrange(key: string, min: number | "-inf", max: number, opts: { byScore: true }): Promise<string[] | null>;
  zremrangebyscore(key: string, min: number | "-inf", max: number): Promise<unknown>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  hmget(key: string, ...fields: string[]): Promise<Record<string, unknown> | null>;
  expire(key: string, seconds: number): Promise<unknown>;
  set(key: string, value: number, opts: { nx: true; ex: number }): Promise<unknown>;
}

const zKey = (groupId: string) => `obi-pdf:z:${groupId}`;
const hKey = (groupId: string) => `obi-pdf:h:${groupId}`;
const memberOf = (messageId: string) => `m:${messageId}`;

function parseDetail(v: unknown): ObiPdfRecord | null {
  let o: unknown = v;
  if (typeof v === "string") {
    try {
      o = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (
    typeof r.messageId !== "string" ||
    typeof r.fileName !== "string" ||
    typeof r.size !== "number" ||
    typeof r.timestamp !== "number" ||
    typeof r.userId !== "string"
  ) {
    return null;
  }
  return {
    messageId: r.messageId,
    fileName: r.fileName,
    size: r.size,
    timestamp: r.timestamp,
    userId: r.userId,
  };
}

export function createKvObiStore(client: ObiKvClient): ObiStore {
  return {
    async addPdf(groupId, rec, removeBefore) {
      const z = zKey(groupId);
      const h = hKey(groupId);
      const m = memberOf(rec.messageId);
      // 詳細を先に置く（並びにあるのに詳細が無い、を作らない）
      await client.hset(h, { [m]: JSON.stringify(rec) });
      await client.zadd(z, { score: rec.timestamp, member: m });
      const old = (await client.zrange(z, "-inf", removeBefore - 1, { byScore: true })) ?? [];
      if (old.length > 0) {
        await client.zremrangebyscore(z, "-inf", removeBefore - 1);
        await client.hdel(h, ...old);
      }
      await client.expire(z, OBI_MEMO_TTL_SECONDS);
      await client.expire(h, OBI_MEMO_TTL_SECONDS);
    },
    async listPdfs(groupId, minTs, maxTs) {
      const members = (await client.zrange(zKey(groupId), minTs, maxTs, { byScore: true })) ?? [];
      if (members.length === 0) return [];
      const details = (await client.hmget(hKey(groupId), ...members)) ?? {};
      const out: ObiPdfRecord[] = [];
      for (const m of members) {
        const rec = parseDetail(details[m]);
        if (rec) out.push(rec);
        else console.error("帯替えの控え：詳細が読めないものを飛ばす:", m);
      }
      return out;
    },
    async setNx(key, ttlSeconds) {
      return (await client.set(key, 1, { nx: true, ex: ttlSeconds })) === "OK";
    },
  };
}

export type MemoryObiStore = ObiStore & {
  /** テスト用：並びと詳細に残っている件数 */
  sizes(groupId: string): { z: number; h: number };
};

/** KV が無い環境（手元・テスト）用。同じインスタンスの中だけで持つ */
export function createMemoryObiStore(now: () => number = Date.now): MemoryObiStore {
  const sets = new Map<string, Map<string, number>>();
  const hashes = new Map<string, Map<string, string>>();
  const flags = new Map<string, number>();
  return {
    async addPdf(groupId, rec, removeBefore) {
      const z = sets.get(groupId) ?? new Map<string, number>();
      const h = hashes.get(groupId) ?? new Map<string, string>();
      const m = memberOf(rec.messageId);
      h.set(m, JSON.stringify(rec));
      z.set(m, rec.timestamp);
      for (const [k, score] of Array.from(z.entries())) {
        if (score < removeBefore) {
          z.delete(k);
          h.delete(k);
        }
      }
      sets.set(groupId, z);
      hashes.set(groupId, h);
    },
    async listPdfs(groupId, minTs, maxTs) {
      const z = sets.get(groupId);
      const h = hashes.get(groupId);
      if (!z || !h) return [];
      const out: ObiPdfRecord[] = [];
      for (const [m, score] of Array.from(z.entries())) {
        if (score < minTs || score > maxTs) continue;
        const rec = parseDetail(h.get(m));
        if (rec) out.push(rec);
      }
      return out;
    },
    async setNx(key, ttlSeconds) {
      const t = now();
      const exp = flags.get(key);
      if (exp !== undefined && exp > t) return false;
      flags.set(key, t + ttlSeconds * 1000);
      return true;
    },
    sizes(groupId) {
      return { z: sets.get(groupId)?.size ?? 0, h: hashes.get(groupId)?.size ?? 0 };
    },
  };
}

const realKv: ObiKvClient = {
  hset: (key, values) => kv.hset(key, values),
  zadd: (key, sm) => kv.zadd(key, sm),
  zrange: (key, min, max, opts) => kv.zrange<string[]>(key, min, max, opts),
  zremrangebyscore: (key, min, max) => kv.zremrangebyscore(key, min, max),
  hdel: (key, ...fields) => kv.hdel(key, ...fields),
  hmget: (key, ...fields) => kv.hmget<Record<string, unknown>>(key, ...fields),
  expire: (key, seconds) => kv.expire(key, seconds),
  set: (key, value, opts) => kv.set(key, value, opts),
};

let memoryFallback: MemoryObiStore | null = null;

/** 本番は KV。KV の設定が無い環境では同じインスタンスの中のメモリ（既存の session.ts と同じ考え方） */
export function getObiStore(): ObiStore {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return createKvObiStore(realKv);
  }
  memoryFallback ??= createMemoryObiStore();
  return memoryFallback;
}

/** 営業部のグループに出た PDF を控える（呼び出し側で shouldRecordObiPdf を確かめてから） */
export async function recordObiPdf(
  store: ObiStore,
  groupId: string,
  rec: ObiPdfRecord
): Promise<void> {
  if (!MESSAGE_ID_RE.test(rec.messageId)) {
    console.error("帯替えの控え：message.id の形が違うので控えない");
    return;
  }
  await store.addPdf(groupId, rec, rec.timestamp - OBI_RETENTION_MS);
}

export type ObiSelection =
  | { kind: "none" }
  | { kind: "too-many"; count: number }
  | { kind: "too-large"; totalBytes: number }
  | { kind: "ok"; pdfs: ObiPdfRecord[] };

function compareId(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * 依頼に使う PDF を選ぶ。
 *   - 依頼の時刻から30分以内（境目を含む）・依頼の時刻以前・message.id が依頼より小さい
 *   - ファイル名が .pdf
 *   - 21件以上なら1件も使わない。控えの大きさの合計が上限を超えても使わない
 *   - 並びは時刻の古い順、同じ時刻は message.id を数として小さい順（安全な整数を超えうるので BigInt）
 */
export function selectObiPdfs(
  records: ObiPdfRecord[],
  request: { messageId: string; timestamp: number }
): ObiSelection {
  const seen = new Set<string>();
  const picked = records.filter((r) => {
    if (!MESSAGE_ID_RE.test(r.messageId) || seen.has(r.messageId)) return false;
    if (!/\.pdf$/i.test(r.fileName.trim())) return false;
    if (r.timestamp < request.timestamp - OBI_WINDOW_MS || r.timestamp > request.timestamp) return false;
    if (compareId(r.messageId, request.messageId) >= 0) return false;
    seen.add(r.messageId);
    return true;
  });
  picked.sort((a, b) => a.timestamp - b.timestamp || compareId(a.messageId, b.messageId));
  if (picked.length === 0) return { kind: "none" };
  if (picked.length > OBI_MAX_FILES) return { kind: "too-many", count: picked.length };
  const totalBytes = picked.reduce((sum, r) => sum + (r.size > 0 ? r.size : 0), 0);
  if (totalBytes > OBI_MAX_TOTAL_BYTES) return { kind: "too-large", totalBytes };
  return { kind: "ok", pdfs: picked };
}
```

- [ ] **Step 4: 通ることを確かめる**

  Run: `npx tsx tests/obi-memo.test.ts`
  Expected: すべて `✅`、`🎉 全て通過`（「message.id の形が違うので控えない」「詳細が読めないものを飛ばす: m:400」のログが出るのは正しい動き）

- [ ] **Step 5: `npm test` に足し、型を確かめる**

```json
    "test": "tsx tests/clarify.reducer.test.ts && tsx tests/session.store.test.ts && tsx tests/apihealth.test.ts && tsx tests/clarify-target.test.ts && tsx tests/assignment.test.ts && tsx tests/task-intake.test.ts && tsx tests/obi-parse.test.ts && tsx tests/obi-config.test.ts && tsx tests/line-reply.test.ts && tsx tests/obi-memo.test.ts",
```
  Run: `npm test && npx tsc --noEmit --incremental false -p .`
  Expected: `🎉 全て通過`、tsc は何も出さない（`realKv` の型が `@vercel/kv` と合っていることもここで確かめる）

- [ ] **Step 6: コミット**

```bash
git add src/lib/obi/memo.ts tests/obi-memo.test.ts package.json
git commit -m "$(cat <<'EOF'
feat: 帯替え用の PDF の控え（KV の sorted set と詳細）と、依頼に使う PDF の選び方

同時に届いても上書きしない zadd で足し、1時間より古いものは並びと詳細の両方から消す。
30分以内・依頼より前・20件まで・合計25MBまでを、時刻と message.id（BigInt）の順で選ぶ。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: LINE から PDF を全部取り出す（全部取れたときだけ）

**Files:**
- Create: `src/lib/obi/fetch-pdfs.ts`
- Create: `tests/obi-fetch.test.ts`
- Modify: `package.json:11`

**Interfaces:**
- Consumes: `ObiPdfRecord`・`OBI_MAX_TOTAL_BYTES`（Task 5）、`sanitizeUploadName`（Task 3）
- Produces:
```ts
export interface FetchedPdf { messageId: string; fileName: string; bytes: Uint8Array; size: number; sha256: string }
export type FetchPdfsResult =
  | { kind: "ok"; files: FetchedPdf[] }
  | { kind: "failed"; fileName: string; reason: "unavailable" | "timeout" | "not-pdf" }
  | { kind: "too-large"; totalBytes: number };
export const LINE_FETCH_PER_FILE_MS: number; // 15000
export async function fetchObiPdfs(pdfs: ObiPdfRecord[], opts: { fetchImpl: typeof fetch; lineToken: string; now: () => number; deadline: number }): Promise<FetchPdfsResult>;
export function dedupeBySha256(files: FetchedPdf[]): FetchedPdf[];
```
  `failed.fileName` は控えにある元の名前（返事に書くときは呼び出し側で `sanitizeForReply` する）。`FetchedPdf.fileName` は portal に送る名前（整え済み）。

  本文は `res.body` を少しずつ読み、**それまでの PDF と合わせた読んだ量が 25,000,000 バイトを超えた時点で読むのをやめて流れを止める**（`reader.cancel()`）。`arrayBuffer()` で全部読んでから測ることはしない。Content-Length は「付いていて上限を超えるなら読まずにやめる」近道にだけ使い、頼らない（付かないことも、正しくないこともある）。

- [ ] **Step 1: 失敗するテストを書く**

  `tests/obi-fetch.test.ts`:
```ts
/**
 * LINE から PDF を全部取り出す（設計 10・11）。LINE は偽物の fetch。
 */
import { createHash } from "node:crypto";
import { fetchObiPdfs, dedupeBySha256 } from "../src/lib/obi/fetch-pdfs";
import type { ObiPdfRecord } from "../src/lib/obi/memo";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

const T = 1_760_000_000_000;
const U = "U" + "b".repeat(32);
const pdf = (s: string) => new TextEncoder().encode(`%PDF-1.7\n${s}`);
const bigPdf = (n: number) => {
  const b = new Uint8Array(n);
  b.set(new TextEncoder().encode("%PDF-"));
  return b;
};
const rec = (id: string, name = `${id}.pdf`): ObiPdfRecord => ({ messageId: id, fileName: name, size: 0, timestamp: T, userId: U });
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ab = (u8: Uint8Array) => {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
};

type Behavior = Uint8Array | number | "timeout" | "network";
function makeFetch(map: Record<string, Behavior>, seen: string[], contentLength: Record<string, string> = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const id = String(url).match(/message\/(\d+)\/content$/)?.[1] ?? "";
    seen.push(id);
    if (new Headers(init?.headers).get("authorization") !== "Bearer line-token") {
      return new Response("no", { status: 401 });
    }
    const b = map[id];
    if (b === "timeout") throw new DOMException("timed out", "TimeoutError");
    if (b === "network") throw new TypeError("fetch failed");
    if (typeof b === "number") return new Response("x", { status: b });
    const headers: Record<string, string> = { "content-type": "application/pdf" };
    if (contentLength[id]) headers["content-length"] = contentLength[id];
    return new Response(ab(b), { status: 200, headers });
  }) as typeof fetch;
}
const opts = (fetchImpl: typeof fetch, deadline = T + 30_000, now = () => T) => ({ fetchImpl, lineToken: "line-token", now, deadline });

async function main() {
  {
    const seen: string[] = [];
    const a = pdf("a");
    const b = pdf("b");
    const r = await fetchObiPdfs([rec("1", "図面\nA.pdf"), rec("2")], opts(makeFetch({ "1": a, "2": b }, seen)));
    ok("全部取れたら順番どおりに返す", r.kind === "ok" && r.files.map((f) => f.messageId).join() === "1,2", JSON.stringify(r.kind));
    if (r.kind === "ok") {
      ok("sha256 と大きさを計算する", r.files[0].sha256 === sha(a) && r.files[0].size === a.byteLength);
      ok("送る名前は整える（改行を除く）", r.files[0].fileName === "図面A.pdf", r.files[0].fileName);
    }
    ok("LINE の content の URL を叩く", seen.join() === "1,2");
  }
  {
    const seen: string[] = [];
    const r = await fetchObiPdfs([rec("1"), rec("2"), rec("3")], opts(makeFetch({ "1": pdf("a"), "2": 404, "3": pdf("c") }, seen)));
    ok("1件でも取れなければ全体をやめる（その名前を返す）", r.kind === "failed" && r.reason === "unavailable" && r.fileName === "2.pdf", JSON.stringify(r));
    ok("やめた後は取りに行かない", seen.join() === "1,2");
  }
  {
    const r = await fetchObiPdfs([rec("1")], opts(makeFetch({ "1": new TextEncoder().encode("<html>") }, [])));
    ok("%PDF- で始まらなければやめる", r.kind === "failed" && r.reason === "not-pdf");
  }
  {
    const r = await fetchObiPdfs([rec("1")], opts(makeFetch({ "1": "timeout" }, [])));
    ok("LINE の時間切れは失敗", r.kind === "failed" && r.reason === "timeout");
    const r2 = await fetchObiPdfs([rec("1")], opts(makeFetch({ "1": "network" }, [])));
    ok("通信の失敗は失敗", r2.kind === "failed" && r2.reason === "unavailable");
  }
  {
    const seen: string[] = [];
    const r = await fetchObiPdfs([rec("1")], opts(makeFetch({ "1": pdf("a") }, seen), T - 1));
    ok("締め切りを過ぎていたら取りに行かずに時間切れ", r.kind === "failed" && r.reason === "timeout" && seen.length === 0);
  }
  {
    const r = await fetchObiPdfs([rec("1"), rec("2")], opts(makeFetch({ "1": bigPdf(13_000_000), "2": bigPdf(13_000_000) }, [])));
    ok("取り出した実際のバイト数の合計でも上限を確かめる", r.kind === "too-large" && r.totalBytes === 26_000_000, JSON.stringify(r.kind));
  }
  {
    const seen: string[] = [];
    const r = await fetchObiPdfs([rec("1")], opts(makeFetch({ "1": pdf("a") }, seen, { "1": "30000000" })));
    ok("content-length が上限を超えていたら読まずにやめる", r.kind === "too-large");
  }
  {
    // Content-Length の無い、終わりの無い応答（1,000,000 バイトずつ流れてくる）
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1_000_000);
    chunk.set(new TextEncoder().encode("%PDF-"));
    const endless: typeof fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(chunk.slice());
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "content-type": "application/pdf" } }
      )) as typeof fetch;
    const r = await fetchObiPdfs([rec("1")], opts(endless));
    ok("Content-Length が無くても、読んだ量が上限を超えた所でやめる", r.kind === "too-large" && r.totalBytes === 26_000_000, JSON.stringify(r.kind === "too-large" ? r.totalBytes : r.kind));
    ok("上限を超えた後は読み続けない（流れを止める）", cancelled && pulls <= 28, `pulls=${pulls}`);
  }
  {
    // 前の PDF で使った分を差し引いた残りで止める
    let pulls = 0;
    const chunk = new Uint8Array(1_000_000);
    chunk.set(new TextEncoder().encode("%PDF-"));
    const first = bigPdf(20_000_000);
    const mixed: typeof fetch = (async (url: string | URL | Request) =>
      String(url).includes("/1/")
        ? new Response(ab(first), { status: 200 })
        : new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                pulls++;
                controller.enqueue(chunk.slice());
              },
            }),
            { status: 200 }
          )) as typeof fetch;
    const r = await fetchObiPdfs([rec("1"), rec("2")], opts(mixed));
    ok("2件目は残り（5,000,000 バイト）を超えた所でやめる", r.kind === "too-large" && r.totalBytes === 26_000_000 && pulls <= 8, `pulls=${pulls}`);
  }
  {
    const r = await fetchObiPdfs([rec("1"), rec("2"), rec("3")], opts(makeFetch({ "1": pdf("same"), "2": pdf("other"), "3": pdf("same") }, [])));
    const d = r.kind === "ok" ? dedupeBySha256(r.files) : [];
    ok("同じ中身は先に出たものを残して1つに", d.map((f) => f.messageId).join() === "1,2", d.map((f) => f.messageId).join());
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
```

- [ ] **Step 2: 失敗を確かめる**

  Run: `npx tsx tests/obi-fetch.test.ts`
  Expected: FAIL（`Cannot find module '../src/lib/obi/fetch-pdfs'`）

- [ ] **Step 3: 取り出しを書く**

  `src/lib/obi/fetch-pdfs.ts`:
```ts
/**
 * 控えた PDF を LINE から全部取り出す（設計 2026-10-09 の 10・11）。
 *
 * 1件でも取れない（LINE 側の保存期間切れなど）・`%PDF-` で始まらない・時間切れなら、
 * 受付全体をやめる。受付の返事に書いたファイルと portal に入ったファイルを必ず一致させるため、
 * 「取れた分だけ送る」はしない。
 */
import { createHash } from "crypto";
import { OBI_MAX_TOTAL_BYTES, type ObiPdfRecord } from "./memo";
import { sanitizeUploadName } from "./sanitize";

export interface FetchedPdf {
  messageId: string;
  fileName: string; // portal に送る名前（sanitizeUploadName 済み）
  bytes: Uint8Array;
  size: number;
  sha256: string; // 16進64桁
}

export type FetchPdfsResult =
  | { kind: "ok"; files: FetchedPdf[] }
  | { kind: "failed"; fileName: string; reason: "unavailable" | "timeout" | "not-pdf" }
  | { kind: "too-large"; totalBytes: number };

export const LINE_FETCH_PER_FILE_MS = 15_000;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

function isPdf(b: Uint8Array): boolean {
  return b.length >= PDF_MAGIC.length && PDF_MAGIC.every((c, i) => b[i] === c);
}

/**
 * 本文を少しずつ読み、読んだ量が limit を超えた時点で読むのをやめる。
 * Content-Length は付かないこともあり、付いていても正しいとは限らないので頼らない
 * （arrayBuffer() で全部を読んでから大きさを見ると、巨大な応答でメモリを使い切る）。
 */
async function readBodyLimited(
  res: Response,
  limit: number
): Promise<{ kind: "ok"; bytes: Uint8Array } | { kind: "too-large"; read: number }> {
  if (!res.body) return { kind: "ok", bytes: new Uint8Array(0) };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    if (read > limit) {
      await reader.cancel().catch(() => undefined);
      return { kind: "too-large", read };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(read);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { kind: "ok", bytes };
}

export async function fetchObiPdfs(
  pdfs: ObiPdfRecord[],
  opts: {
    fetchImpl: typeof fetch;
    lineToken: string;
    now: () => number;
    /** 取り出し全体の締め切り（絶対時刻 ms） */
    deadline: number;
  }
): Promise<FetchPdfsResult> {
  const files: FetchedPdf[] = [];
  let total = 0;
  for (const p of pdfs) {
    const remaining = opts.deadline - opts.now();
    if (remaining <= 0) return { kind: "failed", fileName: p.fileName, reason: "timeout" };
    let bytes: Uint8Array;
    try {
      const res = await opts.fetchImpl(
        `https://api-data.line.me/v2/bot/message/${p.messageId}/content`,
        {
          headers: { Authorization: `Bearer ${opts.lineToken}` },
          signal: AbortSignal.timeout(Math.min(LINE_FETCH_PER_FILE_MS, remaining)),
          cache: "no-store",
        }
      );
      if (!res.ok) {
        console.error("帯替え：LINE の PDF を取り出せない:", p.messageId, res.status);
        return { kind: "failed", fileName: p.fileName, reason: "unavailable" };
      }
      // Content-Length が付いていて上限を超えるなら、読まずにやめる（近道。頼るのは下の読み取り）
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > 0 && total + declared > OBI_MAX_TOTAL_BYTES) {
        await res.body?.cancel().catch(() => undefined);
        return { kind: "too-large", totalBytes: total + declared };
      }
      // 実際に読んだバイト数の合計が上限を超えた時点で読むのをやめる
      const body = await readBodyLimited(res, OBI_MAX_TOTAL_BYTES - total);
      if (body.kind === "too-large") return { kind: "too-large", totalBytes: total + body.read };
      bytes = body.bytes;
    } catch (err) {
      const name = (err as { name?: string })?.name;
      console.error("帯替え：LINE の PDF の取り出しに失敗:", p.messageId, name);
      return {
        kind: "failed",
        fileName: p.fileName,
        reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "unavailable",
      };
    }
    if (!isPdf(bytes)) return { kind: "failed", fileName: p.fileName, reason: "not-pdf" };
    // 控えの大きさは LINE の申告。取り出した実際のバイト数でも確かめ直してある（readBodyLimited）
    total += bytes.byteLength;
    files.push({
      messageId: p.messageId,
      fileName: sanitizeUploadName(p.fileName),
      bytes,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return { kind: "ok", files };
}

/** 同じ中身（sha256 が同じ）の PDF を1つにまとめる。先に出たものを残す（設計 11） */
export function dedupeBySha256(files: FetchedPdf[]): FetchedPdf[] {
  const seen = new Set<string>();
  return files.filter((f) => {
    if (seen.has(f.sha256)) return false;
    seen.add(f.sha256);
    return true;
  });
}
```

- [ ] **Step 4: 通ることを確かめる**

  Run: `npx tsx tests/obi-fetch.test.ts`
  Expected: すべて `✅`、`🎉 全て通過`

- [ ] **Step 5: `npm test` に足し、型を確かめる**

```json
    "test": "tsx tests/clarify.reducer.test.ts && tsx tests/session.store.test.ts && tsx tests/apihealth.test.ts && tsx tests/clarify-target.test.ts && tsx tests/assignment.test.ts && tsx tests/task-intake.test.ts && tsx tests/obi-parse.test.ts && tsx tests/obi-config.test.ts && tsx tests/line-reply.test.ts && tsx tests/obi-memo.test.ts && tsx tests/obi-fetch.test.ts",
```
  Run: `npm test && npx tsc --noEmit --incremental false -p .`
  Expected: `🎉 全て通過`、tsc は何も出さない

- [ ] **Step 6: コミット**

```bash
git add src/lib/obi/fetch-pdfs.ts tests/obi-fetch.test.ts package.json
git commit -m "$(cat <<'EOF'
feat: 帯替えの PDF を LINE から全部取り出す（1件でも取れなければ受付全体をやめる）

%PDF- で始まるか、本文を少しずつ読み実際の合計が25MBを超えたらそこで読むのをやめ、sha256 で同じ中身を1つにまとめる。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: portal の受付（POST /api/jobs/intake）の呼び出し

**Files:**
- Create: `src/lib/obi/portal.ts`
- Create: `tests/obi-portal.test.ts`
- Modify: `package.json:11`

**Interfaces:**
- Consumes: `FetchedPdf`（Task 6）。portal 側の形は約束（`2026-10-09-group-obi-contract.md` の「P1 が作り、P2 が使う」）
- Produces:
```ts
export interface IntakeRequest { lineMessageId: string; property: string; requestText: string; requestedBy: string; replyGroupId: string; files: Array<{ fileName: string; bytes: Uint8Array }> } // assigneeName は持たない（約束）
export interface IntakeInput { name: string; sha256: string; size: number }
export type IntakeOutcome =
  | { kind: "accepted"; no: number; created: boolean; inputs: IntakeInput[] }
  | { kind: "rejected"; code: string; httpStatus: number; busyJobNo?: number }
  | { kind: "unreachable" }
  | { kind: "unknown"; reason: string };
export async function postIntake(req: IntakeRequest, opts: { fetchImpl: typeof fetch; baseUrl: string; token: string; timeoutMs: number }): Promise<IntakeOutcome>;
export function inputsMatch(sent: FetchedPdf[], got: IntakeInput[]): boolean;
```

判断（設計に書かれていない所）：
- 「送る前に失敗が確か」（設計の表）＝ fetch の例外の原因が `ECONNREFUSED`・`ENOTFOUND`・`EAI_AGAIN` のときだけ。それ以外の通信の失敗・時間切れ・5xx・成功の番号なのに中身が読めない、は「結果不明」
- `503` でも本文の `code` が `INTAKE_STOPPED` なら断り（受付停止中ははっきりしている）
- 一覧の照合は「件数と sha256 の集合」（同じ sha256 の大きさも合わせて見る）。約束どおり順番では比べない（portal の `inputs` は初回に保存した順）。名前は portal 側で整えられることがあるので比べない
- 送る項目は約束の8つ（`workflow`・`lineMessageId`・`property`・`requestText`・`requestedBy`・`replyKind`・`replyGroupId`・`files`）だけ。`assigneeName` は送らない

- [ ] **Step 1: 失敗するテストを書く**

  `tests/obi-portal.test.ts`:
```ts
/**
 * portal の受付（POST /api/jobs/intake）の呼び出しと結果の分け方（設計 12・13・14の2・15）。portal は偽物。
 */
import { postIntake, inputsMatch, type IntakeRequest } from "../src/lib/obi/portal";
import type { FetchedPdf } from "../src/lib/obi/fetch-pdfs";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

const G = "C" + "a".repeat(32);
const req: IntakeRequest = {
  lineMessageId: "600000000000000100",
  property: "架空邸",
  requestText: "帯替え 架空邸",
  requestedBy: "LINEグループ（営業部）",
  replyGroupId: G,
  files: [
    { fileName: "a.pdf", bytes: new TextEncoder().encode("%PDF-a") },
    { fileName: "b.pdf", bytes: new TextEncoder().encode("%PDF-b") },
  ],
};

let seenUrl = "";
let seenToken = "";
let seenForm: FormData | null = null;
const fakeFetch = (respond: () => Promise<Response>): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenToken = new Headers(init?.headers).get("x-job-token") ?? "";
    seenForm = init?.body as FormData;
    return respond();
  }) as typeof fetch;
const json = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const call = (respond: () => Promise<Response>) =>
  postIntake(req, { fetchImpl: fakeFetch(respond), baseUrl: "https://portal.example.test", token: "tok", timeoutMs: 20_000 });
const inputs = [
  { name: "a.pdf", sha256: "1".repeat(64), size: 6 },
  { name: "b.pdf", sha256: "2".repeat(64), size: 6 },
];

async function main() {
  let r = await call(json(201, { no: 12, status: "下準備中", created: true, inputs }));
  ok("201 は受付（新規）", r.kind === "accepted" && r.no === 12 && r.created && r.inputs.length === 2, JSON.stringify(r));
  ok("宛先と鍵", seenUrl === "https://portal.example.test/api/jobs/intake" && seenToken === "tok");
  const f = seenForm as unknown as FormData;
  ok("本文の項目（workflow・lineMessageId・property・replyKind・replyGroupId）",
    f.get("workflow") === "obi" && f.get("lineMessageId") === req.lineMessageId && f.get("property") === "架空邸" &&
    f.get("replyKind") === "line-group" && f.get("replyGroupId") === G && f.get("requestText") === "帯替え 架空邸");
  ok("assigneeName は送らない（約束：intake は受け付けない）", f.get("assigneeName") === null);
  const keys = Array.from(new Set(Array.from(f.keys()))).sort().join();
  ok("送る項目は約束の項目だけ", keys === "files,lineMessageId,property,replyGroupId,replyKind,requestText,requestedBy,workflow", keys);
  const files = f.getAll("files") as File[];
  ok("PDF を出た順に名前つきで送る", files.length === 2 && files[0].name === "a.pdf" && files[1].name === "b.pdf" && files[0].type === "application/pdf");

  r = await call(json(200, { no: 12, status: "下準備中", created: false, inputs }));
  ok("200 は同じ依頼の照合一致（受付済み）", r.kind === "accepted" && !r.created);

  r = await call(json(201, { no: "12", inputs }));
  ok("成功の番号なのに中身が読めなければ不明", r.kind === "unknown");
  r = await call(async () => new Response("<html>", { status: 200 }));
  ok("成功の番号で JSON でなければ不明", r.kind === "unknown");

  r = await call(json(409, { code: "OBI_BUSY", message: "busy", busyJobNo: 11 }));
  ok("OBI_BUSY は断り（処理中の番号つき）", r.kind === "rejected" && r.code === "OBI_BUSY" && r.busyJobNo === 11, JSON.stringify(r));
  r = await call(json(409, { code: "INTAKE_MISMATCH", message: "x" }));
  ok("INTAKE_MISMATCH は断り", r.kind === "rejected" && r.code === "INTAKE_MISMATCH" && r.busyJobNo === undefined);
  r = await call(json(503, { code: "INTAKE_STOPPED", message: "x" }));
  ok("503 INTAKE_STOPPED は断り（不明にしない）", r.kind === "rejected" && r.code === "INTAKE_STOPPED");
  r = await call(json(503, { code: "OTHER" }));
  ok("それ以外の 503 は不明", r.kind === "unknown");
  r = await call(json(500, { code: "INTERNAL" }));
  ok("500 は不明", r.kind === "unknown");
  r = await call(async () => new Response("bad", { status: 400 }));
  ok("JSON でない 400 は HTTP_400 で断り", r.kind === "rejected" && r.code === "HTTP_400");

  r = await call(async () => {
    throw new DOMException("timed out", "TimeoutError");
  });
  ok("時間切れは不明", r.kind === "unknown");
  r = await call(async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  });
  ok("接続を拒まれた（送る前の失敗が確か）は unreachable", r.kind === "unreachable");
  r = await call(async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  });
  ok("名前が引けないのも unreachable", r.kind === "unreachable");
  r = await call(async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  });
  ok("途中で切れたのは不明", r.kind === "unknown");

  const sent = [
    { sha256: "1".repeat(64), size: 6 },
    { sha256: "2".repeat(64), size: 6 },
  ] as FetchedPdf[];
  ok("一覧の一致：同じ順・同じ sha256・同じ大きさ", inputsMatch(sent, inputs));
  ok("一覧の一致：順番が違っても集合が同じなら一致（portal は初回の順で返す）", inputsMatch(sent, [inputs[1], inputs[0]]));
  ok("一覧の不一致：sha256 が違う", !inputsMatch(sent, [inputs[0], { ...inputs[1], sha256: "3".repeat(64) }]));
  ok("一覧の不一致：同じ sha256 が2つ", !inputsMatch(sent, [inputs[0], inputs[0]]));
  ok("一覧の不一致：大きさ違い", !inputsMatch(sent, [inputs[0], { ...inputs[1], size: 7 }]));
  ok("一覧の不一致：件数違い", !inputsMatch(sent, [inputs[0]]));

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
```

- [ ] **Step 2: 失敗を確かめる**

  Run: `npx tsx tests/obi-portal.test.ts`
  Expected: FAIL（`Cannot find module '../src/lib/obi/portal'`）

- [ ] **Step 3: 呼び出しを書く**

  `src/lib/obi/portal.ts`:
```ts
/**
 * portal の帯替えの受付 `POST {PORTAL_BASE_URL}/api/jobs/intake` を呼ぶ（設計 12・13・14の2・15）。
 * 形は docs/superpowers/plans/2026-10-09-group-obi-contract.md の「P1 が作り、P2 が使う」。
 * `assigneeName` はこの入口では受け付けないので送らない（依頼文の「担当:」は読んでも捨てる）。
 *
 * 結果は4つに分ける：
 *   accepted    … 受付番号と保存した PDF の一覧が返った（201 新規・200 同じ依頼の照合一致）
 *   rejected    … portal がはっきり断った（4xx・503 INTAKE_STOPPED）
 *   unreachable … 送る前に失敗したのが確か（名前が引けない・接続を拒まれた）
 *   unknown     … 届いたか分からない（時間切れ・通信の切断・5xx・成功なのに中身が読めない）
 */
import type { FetchedPdf } from "./fetch-pdfs";

export interface IntakeRequest {
  lineMessageId: string;
  property: string;
  requestText: string;
  requestedBy: string;
  replyGroupId: string;
  files: Array<{ fileName: string; bytes: Uint8Array }>;
}

export interface IntakeInput {
  name: string;
  sha256: string;
  size: number;
}

export type IntakeOutcome =
  | { kind: "accepted"; no: number; created: boolean; inputs: IntakeInput[] }
  | { kind: "rejected"; code: string; httpStatus: number; busyJobNo?: number }
  | { kind: "unreachable" }
  | { kind: "unknown"; reason: string };

const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

function parseInputs(v: unknown): IntakeInput[] | null {
  if (!Array.isArray(v)) return null;
  const out: IntakeInput[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") return null;
    const r = x as Record<string, unknown>;
    if (typeof r.name !== "string" || typeof r.sha256 !== "string" || typeof r.size !== "number") {
      return null;
    }
    out.push({ name: r.name, sha256: r.sha256, size: r.size });
  }
  return out;
}

function classifyFetchError(err: unknown): IntakeOutcome {
  const e = err as { name?: string; cause?: { code?: string } } | undefined;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return { kind: "unknown", reason: "timeout" };
  if (e?.cause?.code && UNREACHABLE_CODES.has(e.cause.code)) return { kind: "unreachable" };
  return { kind: "unknown", reason: "network" };
}

export async function postIntake(
  req: IntakeRequest,
  opts: { fetchImpl: typeof fetch; baseUrl: string; token: string; timeoutMs: number }
): Promise<IntakeOutcome> {
  const form = new FormData();
  form.append("workflow", "obi");
  form.append("lineMessageId", req.lineMessageId);
  form.append("property", req.property);
  if (req.requestText) form.append("requestText", req.requestText);
  if (req.requestedBy) form.append("requestedBy", req.requestedBy);
  form.append("replyKind", "line-group");
  form.append("replyGroupId", req.replyGroupId);
  for (const f of req.files) {
    form.append("files", new Blob([toArrayBuffer(f.bytes)], { type: "application/pdf" }), f.fileName);
  }

  let res: Response;
  try {
    res = await opts.fetchImpl(`${opts.baseUrl}/api/jobs/intake`, {
      method: "POST",
      headers: { "x-job-token": opts.token },
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    return classifyFetchError(err);
  }

  let body: Record<string, unknown> = {};
  let bodyOk = true;
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    else bodyOk = false;
  } catch {
    bodyOk = false;
  }

  if (res.status === 200 || res.status === 201) {
    const inputs = bodyOk ? parseInputs(body.inputs) : null;
    const no = body.no;
    if (typeof no === "number" && Number.isInteger(no) && no > 0 && inputs) {
      return { kind: "accepted", no, created: res.status === 201, inputs };
    }
    // 成功の番号なのに中身が読めない＝受付できたかもしれない
    return { kind: "unknown", reason: "invalid-success-body" };
  }
  const code = typeof body.code === "string" ? body.code : "";
  if (res.status === 503 && code === "INTAKE_STOPPED") {
    return { kind: "rejected", code, httpStatus: 503 };
  }
  if (res.status >= 500) return { kind: "unknown", reason: `http-${res.status}` };
  if (res.status >= 400) {
    const busy = body.busyJobNo;
    return {
      kind: "rejected",
      code: code || `HTTP_${res.status}`,
      httpStatus: res.status,
      ...(typeof busy === "number" && Number.isInteger(busy) && busy > 0 ? { busyJobNo: busy } : {}),
    };
  }
  return { kind: "unknown", reason: `http-${res.status}` };
}

/**
 * 返ってきた一覧が送った PDF と一致するか（設計 13）。
 * 約束：portal の inputs は「初回に保存した順」なので、順番では比べず、
 * 件数と sha256 の集合（＋同じ sha256 の大きさ）で比べる。送る側で同じ sha256 は1つにしてある。
 */
export function inputsMatch(sent: FetchedPdf[], got: IntakeInput[]): boolean {
  if (sent.length !== got.length) return false;
  const sizeBySha = new Map<string, number>();
  for (const f of sent) sizeBySha.set(f.sha256, f.size);
  if (sizeBySha.size !== sent.length) return false;
  const seen = new Set<string>();
  for (const g of got) {
    if (seen.has(g.sha256)) return false;
    seen.add(g.sha256);
    if (sizeBySha.get(g.sha256) !== g.size) return false;
  }
  return true;
}
```

- [ ] **Step 4: 通ることを確かめる**

  Run: `npx tsx tests/obi-portal.test.ts`
  Expected: すべて `✅`、`🎉 全て通過`

- [ ] **Step 5: `npm test` に足し、型を確かめる**

```json
    "test": "tsx tests/clarify.reducer.test.ts && tsx tests/session.store.test.ts && tsx tests/apihealth.test.ts && tsx tests/clarify-target.test.ts && tsx tests/assignment.test.ts && tsx tests/task-intake.test.ts && tsx tests/obi-parse.test.ts && tsx tests/obi-config.test.ts && tsx tests/line-reply.test.ts && tsx tests/obi-memo.test.ts && tsx tests/obi-fetch.test.ts && tsx tests/obi-portal.test.ts",
```
  Run: `npm test && npx tsc --noEmit --incremental false -p .`
  Expected: `🎉 全て通過`、tsc は何も出さない

- [ ] **Step 6: コミット**

```bash
git add src/lib/obi/portal.ts tests/obi-portal.test.ts package.json
git commit -m "$(cat <<'EOF'
feat: portal の帯替えの受付（/api/jobs/intake）を呼び、結果を受付・断り・届かない・不明に分ける

時間切れ・通信の切断・5xx は「結果不明」として扱い、受付できなかったとは言わない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 受付全体（選ぶ → 取り出す → portal → 照合 → 返事）

**Files:**
- Create: `src/lib/obi/intake.ts`
- Create: `tests/obi-intake.test.ts`
- Modify: `package.json:11`

**Interfaces:**
- Consumes: `deliverReply`・`ReplyOutcome`（Task 4）、`ObiConfig`（Task 3）、`sanitizeForReply`・`propertyFor`（Task 3）、`ObiStore`・`selectObiPdfs`・`OBI_WINDOW_MS`・`OBI_NOTIFY_TTL_SECONDS`（Task 5）、`fetchObiPdfs`・`dedupeBySha256`（Task 6）、`postIntake`・`inputsMatch`・`IntakeOutcome`・`IntakeRequest`（Task 7）
- Produces:
```ts
export const OBI_DEADLINE_MS: number; // 55000
export const OBI_MESSAGES: { stopped: string; forbidden: string; noPdf: string; tooMany(count: number): string; tooLarge: string; fetchFailed(name: string): string; notPdf(name: string): string; timeUp: string; noTimestamp: string; busy(no?: number): string; unreachable: string; rejected(code: string): string; pending: string; accepted(no: number, property: string, names: string[]): string; unconfirmed: string };
export interface ObiIntakeInput { requestMessageId: string; requestTimestamp: number | undefined; groupId: string; requestText: string; property: string; startedAt: number; config: ObiConfig } // 担当（assigneeName）は持たない
export interface ObiIntakeDeps { store: ObiStore; fetchImpl: typeof fetch; lineToken: string; now: () => number; reply: (text: string) => Promise<ReplyOutcome>; push: (to: string, text: string) => Promise<boolean>; onCommitted: () => void }
export interface ObiIntakeResult { outcome: "accepted" | "refused" | "pending" | "unconfirmed"; retry: boolean }
export async function runObiIntake(input: ObiIntakeInput, deps: ObiIntakeDeps): Promise<ObiIntakeResult>;
```

時間の配分（設計 10）：締め切り＝`startedAt + 55秒`。取り出しの締め切り＝`min(今+30秒, 締め切り−10秒)`（portal のために10秒残す）。portal は1回 `min(20秒, 残り)`、残りが5秒未満なら呼ばない。**portal を呼ぶのは最大2回**（最初の1回＋結果不明のときの呼び直し1回。締め切りに余裕があっても3回目は呼ばない）。一度も呼べなかったときは portal に受付は無いので「時間がかかりました」で断る。

済みの境目（裁定 2026-10-09）：
- portal が受付番号を返し、`inputsMatch`（件数と sha256 の集合）が真のときだけ `onCommitted()` を呼ぶ
- 一覧が合わないときは `onCommitted()` を呼ばず、`obi-unconfirmed-notified:<id>` を NX で置けたときだけ「受付を確かめられませんでした」を返し、`{ outcome: "unconfirmed", retry: true }`（Webhook は予約を外し、`completeEvent` を呼ばずに 503）。受付の返事も、ほかの返事も出さない
- portal 自身が `INTAKE_MISMATCH`（409）で断ったときも、返事は同じ「受付を確かめられませんでした」（こちらは portal がはっきり断ったので、イベントは済みにする）
- 依頼の時刻（`requestTimestamp`）が無い・不正なら、選ぶ前に「依頼の時刻が分かりません」で断る（portal を呼ばない。今の時刻で代わりにしない）

途中で止まる場面（Codex の残りの指摘 b）：テストでは依存の関数が例外を投げる＝落ちた、とし、同じ控えのままもう一度呼ぶ＝LINE の再送、で確かめる。
- NX を置いた直後に落ちる → 再送でも受付の返事は出ない（1通落ちる。受け入れる・二重にはしない）
- reply を送っている途中で落ちる → 再送で二重に送らない
- reply が 400 → push の途中で落ちる → 再送で二重に送らない
- reply の結果が不明 → push しない
- 確かめ中の NX の直後に落ちる → 受付は確定していないので、再送で受付が分かれば受付の返事は出す
- 受付の確定の後に、受付の返事の NX が例外（KV の障害）→ 返事も push も出さず、再送もさせない（`retry: false`）

- [ ] **Step 1: 失敗するテストを書く**

  `tests/obi-intake.test.ts`:
```ts
/**
 * グループからの帯替えの受付の全体（設計 9〜15・14の2）。LINE・KV・portal は偽物。
 *
 * 途中で止まる場面は「依存の関数が例外を投げる」で表し、同じ控え（KV）のまま
 * もう一度呼ぶ（＝LINE の再送）ことで、返事が二重にならないことを確かめる。
 */
import { createHash } from "node:crypto";
import { runObiIntake, OBI_MESSAGES, type ObiIntakeDeps, type ObiIntakeInput } from "../src/lib/obi/intake";
import { createMemoryObiStore, recordObiPdf, type MemoryObiStore } from "../src/lib/obi/memo";
import type { ObiConfig } from "../src/lib/obi/config";
import type { ReplyOutcome } from "../src/lib/line";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

const G = "C" + "a".repeat(32);
const U = "U" + "b".repeat(32);
const T = 1_760_000_000_000;
const REQ_ID = "600000000000000100";
const config: ObiConfig = {
  groupId: G,
  allowedUserIds: [U],
  portalBaseUrl: "https://portal.example.test",
  jobApiToken: "tok",
};
const enc = (s: string) => new TextEncoder().encode(s);
const pdf = (s: string) => enc(`%PDF-1.7\n${s}`);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ab = (u8: Uint8Array) => {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type PortalAnswer = Response | "timeout" | "refused" | ((form: FormData) => Promise<Response>);

interface World {
  store: MemoryObiStore;
  clock: { t: number };
  line: Record<string, Uint8Array | number>;
  lineDelayMs: number; // 1件取り出すごとに進める時間
  portal: PortalAnswer[]; // 呼ばれるたびに先頭から使う（最後の1つは使い回す）
  portalDelayMs: number;
  portalForms: FormData[];
  replies: string[];
  pushes: string[];
  replyMode: "sent" | "rejected" | "unknown" | "crash" | "crash-after-send";
  pushMode: "ok" | "fail" | "crash-after-send";
  committed: number;
}

function world(): World {
  const clock = { t: T + 1000 };
  return {
    store: createMemoryObiStore(() => clock.t),
    clock,
    line: {},
    lineDelayMs: 0,
    portal: [],
    portalDelayMs: 0,
    portalForms: [],
    replies: [],
    pushes: [],
    replyMode: "sent",
    pushMode: "ok",
    committed: 0,
  };
}

/** portal の受付の成功応答（送られた PDF から一覧を作る） */
const accept = (no: number, status = 201) => async (form: FormData) => {
  const inputs = [];
  for (const f of form.getAll("files") as File[]) {
    const b = new Uint8Array(await f.arrayBuffer());
    inputs.push({ name: f.name, sha256: sha(b), size: b.byteLength });
  }
  return json(status, { no, status: "下準備中", created: status === 201, inputs });
};

function deps(w: World): ObiIntakeDeps {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const m = u.match(/message\/(\d+)\/content$/);
    if (m) {
      w.clock.t += w.lineDelayMs;
      const b = w.line[m[1]];
      if (b === undefined || typeof b === "number") return new Response("x", { status: typeof b === "number" ? b : 404 });
      return new Response(ab(b), { status: 200 });
    }
    if (u === "https://portal.example.test/api/jobs/intake") {
      w.portalForms.push(init?.body as FormData);
      w.clock.t += w.portalDelayMs;
      const a = w.portal.length > 1 ? w.portal.shift()! : w.portal[0];
      if (a === "timeout") throw new DOMException("timed out", "TimeoutError");
      if (a === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      if (typeof a === "function") return a(init?.body as FormData);
      return a.clone();
    }
    throw new Error(`想定外の宛先: ${u}`);
  }) as typeof fetch;
  return {
    store: w.store,
    fetchImpl,
    lineToken: "line-token",
    now: () => w.clock.t,
    reply: async (text: string): Promise<ReplyOutcome> => {
      if (w.replyMode === "crash") throw new Error("crash");
      w.replies.push(text);
      if (w.replyMode === "crash-after-send") throw new Error("crash");
      if (w.replyMode === "rejected") return { kind: "rejected", status: 400 };
      if (w.replyMode === "unknown") return { kind: "unknown" };
      return { kind: "sent", messageId: "bot-1" };
    },
    push: async (to: string, text: string) => {
      w.pushes.push(`${to}|${text}`);
      if (w.pushMode === "crash-after-send") throw new Error("crash");
      return w.pushMode === "ok";
    },
    onCommitted: () => {
      w.committed++;
    },
  };
}

const input = (over: Partial<ObiIntakeInput> = {}): ObiIntakeInput => ({
  requestMessageId: REQ_ID,
  requestTimestamp: T,
  groupId: G,
  requestText: "帯替え 架空邸",
  property: "架空邸",
  startedAt: T + 1000,
  config,
  ...over,
});

/** 控えに PDF を足し、LINE の偽物に中身を置く */
async function seed(w: World, items: Array<{ id: string; name: string; ago: number; body?: Uint8Array | number; size?: number }>) {
  for (const it of items) {
    await recordObiPdf(w.store, G, { messageId: it.id, fileName: it.name, size: it.size ?? 100, timestamp: T - it.ago, userId: U });
    w.line[it.id] = it.body ?? pdf(it.name);
  }
}
const run = (w: World, over: Partial<ObiIntakeInput> = {}) => runObiIntake(input(over), deps(w));

async function main() {
  // ── 正常：3件（うち1件は同じ中身）→ 2件を出た順に送り、受付の返事を1回 ──
  {
    const w = world();
    await seed(w, [
      { id: "600000000000000003", name: "b.pdf", ago: 60_000 },
      { id: "600000000000000002", name: "a.pdf", ago: 120_000 },
      { id: "600000000000000004", name: "a-copy.pdf", ago: 30_000, body: pdf("a.pdf") },
      { id: "600000000000000200", name: "later.pdf", ago: -5_000 }, // 依頼より後：使わない
    ]);
    w.portal = [accept(12)];
    const r = await run(w);
    ok("受付できた（済みにする・再送しない）", r.outcome === "accepted" && !r.retry && w.committed === 1, JSON.stringify(r));
    const files = (w.portalForms[0].getAll("files") as File[]).map((f) => f.name);
    ok("同じ中身は先に出たものだけ・出た順に送る", files.join() === "a.pdf,b.pdf", files.join());
    ok("portal に依頼の項目を渡す", w.portalForms[0].get("lineMessageId") === REQ_ID && w.portalForms[0].get("replyGroupId") === G && w.portalForms[0].get("property") === "架空邸");
    ok("assigneeName は portal に送らない", w.portalForms[0].get("assigneeName") === null);
    ok("受付の返事", w.replies.join("\n") === "#J12 受付しました（物件：架空邸／PDF：a.pdf ほか1件）。完成したらここにリンクを出します", w.replies.join("\n"));
  }

  // ── 物件名が無い依頼は最初の PDF の名前を物件名に ──
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "図面A.pdf", ago: 60_000 }]);
    w.portal = [accept(13)];
    await run(w, { property: "" });
    ok("物件名が空なら最初の PDF の名前", w.portalForms[0].get("property") === "図面A" && w.replies[0].includes("物件：図面A／PDF：図面A.pdf）"), w.replies[0]);
  }

  // ── 返事に入れる名前は整える（改行を除き40文字まで） ──
  {
    const w = world();
    const longName = "長".repeat(30) + "\n" + "名".repeat(30) + ".pdf";
    await seed(w, [{ id: "600000000000000002", name: longName, ago: 60_000 }]);
    w.portal = [accept(14)];
    await run(w);
    const m = w.replies[0].match(/PDF：(.*)）。/);
    ok("返事のファイル名は改行なし・40文字まで", !!m && !m[1].includes("\n") && Array.from(m[1]).length === 40, w.replies[0]);
  }

  // ── 断る場面（portal を呼ばない） ──
  {
    const w = world();
    const r = await run(w);
    ok("PDF が無い", r.outcome === "refused" && w.replies[0] === OBI_MESSAGES.noPdf && w.portalForms.length === 0);
  }
  {
    const w = world();
    await seed(w, Array.from({ length: 21 }, (_, i) => ({ id: `60000000000000${String(i + 1).padStart(4, "0")}`, name: `${i}.pdf`, ago: 60_000 })));
    const r = await run(w);
    ok("21件以上は1件も使わずに断る", r.outcome === "refused" && w.replies[0] === OBI_MESSAGES.tooMany(21) && w.portalForms.length === 0);
  }
  {
    const w = world();
    await seed(w, [
      { id: "600000000000000002", name: "a.pdf", ago: 60_000, size: 20_000_000 },
      { id: "600000000000000003", name: "b.pdf", ago: 50_000, size: 5_000_001 },
    ]);
    const r = await run(w);
    ok("控えの大きさの合計が上限を超えたら断る", r.outcome === "refused" && w.replies[0] === OBI_MESSAGES.tooLarge);
  }
  {
    const w = world();
    await seed(w, [
      { id: "600000000000000002", name: "a.pdf", ago: 60_000 },
      { id: "600000000000000003", name: "b.pdf", ago: 50_000, body: 410 },
    ]);
    const r = await run(w);
    ok("1件でも取り出せなければ全体をやめる", r.outcome === "refused" && w.replies[0] === OBI_MESSAGES.fetchFailed("b.pdf") && w.portalForms.length === 0, w.replies[0]);
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000, body: enc("<html>") }]);
    await run(w);
    ok("PDF でなければやめる", w.replies[0] === OBI_MESSAGES.notPdf("a.pdf"));
  }
  {
    const w = world();
    const r = await run(w, { requestMessageId: "abc" });
    ok("依頼の id の形が違えば断る", r.outcome === "refused" && w.replies[0] === OBI_MESSAGES.rejected("INVALID_REQUEST"));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(40)];
    const r = await run(w, { requestTimestamp: undefined });
    ok("依頼の時刻が無ければ受付けない（今の時刻で代わりにしない）", r.outcome === "refused" && !r.retry && w.replies[0] === OBI_MESSAGES.noTimestamp && w.portalForms.length === 0 && w.committed === 0, w.replies.join("|"));
    const r2 = await run(w, { requestTimestamp: Number.NaN });
    ok("依頼の時刻が数でなくても受付けない", r2.outcome === "refused" && w.replies[1] === OBI_MESSAGES.noTimestamp && w.portalForms.length === 0);
  }

  // ── 時間の配分 ──
  {
    const w = world();
    await seed(w, [
      { id: "600000000000000002", name: "a.pdf", ago: 60_000 },
      { id: "600000000000000003", name: "b.pdf", ago: 50_000 },
    ]);
    w.lineDelayMs = 46_000; // 1件目で取り出しの締め切り（開始+45秒）を過ぎる
    const r = await run(w);
    ok("LINE の取得の時間切れは失敗（portal を呼ばない）", r.outcome === "refused" && w.replies[0] === OBI_MESSAGES.fetchFailed("b.pdf") && w.portalForms.length === 0, w.replies[0]);
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.lineDelayMs = 52_000; // 取り出しが長引き、portal に使える時間が5秒未満
    const r = await run(w);
    ok("portal に使える時間が無ければ送らずに断る", r.outcome === "refused" && w.replies[0] === OBI_MESSAGES.timeUp && w.portalForms.length === 0, w.replies[0]);
  }

  // ── portal の断り ──
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [json(409, { code: "OBI_BUSY", message: "busy", busyJobNo: 11 })];
    const r = await run(w);
    ok("前の帯替えを処理中（番号つき）", r.outcome === "refused" && !r.retry && w.committed === 0 && w.replies[0] === "前の帯替え（#J11）を処理中です。終わってからもう一度送ってください", w.replies[0]);
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [json(409, { code: "OBI_BUSY", message: "busy" })];
    await run(w);
    ok("番号が無ければ番号なしで", w.replies[0] === "前の帯替えを処理中です。終わってからもう一度送ってください");
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [json(503, { code: "INTAKE_STOPPED", message: "x" })];
    await run(w);
    ok("受付停止中", w.replies[0] === OBI_MESSAGES.stopped);
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [json(409, { code: "INTAKE_MISMATCH", message: "x" })];
    const r = await run(w);
    ok("portal の INTAKE_MISMATCH は「確かめられませんでした」（済みにしない受付の返事は出さない）", r.outcome === "refused" && w.committed === 0 && w.replies[0] === OBI_MESSAGES.unconfirmed, w.replies[0]);
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [json(400, { code: "INVALID_REQUEST", message: "x" })];
    await run(w);
    ok("それ以外の断りは code を書く", w.replies[0] === OBI_MESSAGES.rejected("INVALID_REQUEST"));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = ["refused"];
    const r = await run(w);
    ok("portal につながらない（送る前の失敗が確か）", r.outcome === "refused" && !r.retry && w.replies[0] === OBI_MESSAGES.unreachable);
  }

  // ── 結果不明 → 締め切りの中でもう一度 ──
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = ["timeout", accept(15, 200)];
    const r = await run(w);
    ok("1回目が不明でも、2回目で分かればふつうに続ける", r.outcome === "accepted" && w.portalForms.length === 2 && w.replies[0].startsWith("#J15 受付しました"), w.replies.join("|"));
    ok("2回目も同じ lineMessageId・同じ PDF", w.portalForms[1].get("lineMessageId") === REQ_ID && (w.portalForms[1].getAll("files") as File[]).length === 1);
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = ["timeout", "refused"];
    const r = await run(w);
    ok("不明の後の「つながらない」は不明のまま（受付できなかったと言わない）", r.outcome === "pending" && r.retry && w.replies[0] === OBI_MESSAGES.pending, w.replies.join("|"));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [json(502, {})];
    w.portalDelayMs = 20_000; // 1回で20秒かかる → 2回目の後も残りは15秒あるが、3回目は呼ばない
    const r = await run(w);
    ok("結果不明：済みにせず再送を待つ・確かめ中の返事", r.outcome === "pending" && r.retry && w.committed === 0 && w.replies.join() === OBI_MESSAGES.pending);
    ok("portal は1回の Webhook で最大2回（最初＋呼び直し1回）", w.portalForms.length === 2, String(w.portalForms.length));

    // LINE の再送（同じ控え）：まだ不明 → 確かめ中の返事は二度と出さない
    w.clock.t = T + 70_000;
    const r2 = await run(w, { startedAt: w.clock.t });
    ok("再送でも不明なら、確かめ中の返事は出さない", r2.retry && w.replies.length === 1);

    // さらに再送：portal が同じ依頼を照合して 200 → 受付の返事を1回
    w.portal = [accept(16, 200)];
    w.portalDelayMs = 0;
    w.clock.t = T + 140_000;
    const r3 = await run(w, { startedAt: w.clock.t });
    ok("再送で結果が分かったらふつうに続ける", r3.outcome === "accepted" && !r3.retry && w.committed === 1 && w.replies[1].startsWith("#J16 受付しました"), w.replies.join("|"));
  }

  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = ["timeout", "timeout", accept(18)];
    const r = await run(w);
    ok("2回とも不明なら3回目は呼ばない（締め切りに余裕があっても）", r.outcome === "pending" && w.portalForms.length === 2, String(w.portalForms.length));
  }

  // ── 受付番号は返ったが一覧が合わない：済みにしない ──
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [json(201, { no: 17, inputs: [{ name: "a.pdf", sha256: "0".repeat(64), size: 1 }] })];
    const r = await run(w);
    ok("一覧が合わない：済みにせず（onCommitted を呼ばず）再送を待つ", r.outcome === "unconfirmed" && r.retry && w.committed === 0, JSON.stringify(r));
    ok("一覧が合わない：「確かめられませんでした」だけを返す（受付の返事は出さない）", w.replies.join("|") === OBI_MESSAGES.unconfirmed && !w.replies.some((t) => t.includes("受付しました")), w.replies.join("|"));
    w.clock.t = T + 70_000;
    const r2 = await run(w, { startedAt: w.clock.t });
    ok("一覧が合わない：再送でも返事は二度と出さない", r2.outcome === "unconfirmed" && w.replies.length === 1 && w.committed === 0);
  }
  {
    const w = world();
    await seed(w, [
      { id: "600000000000000002", name: "a.pdf", ago: 60_000 },
      { id: "600000000000000003", name: "b.pdf", ago: 50_000 },
    ]);
    w.portal = [
      async (form: FormData) => {
        const res = await accept(19)(form);
        const body = (await res.json()) as { inputs: unknown[] };
        return json(201, { no: 19, inputs: [body.inputs[0]] }); // 1件足りない
      },
    ];
    const r = await run(w);
    ok("一覧の件数が足りない：済みにしない", r.outcome === "unconfirmed" && w.committed === 0);
  }
  {
    const w = world();
    await seed(w, [
      { id: "600000000000000002", name: "a.pdf", ago: 60_000 },
      { id: "600000000000000003", name: "b.pdf", ago: 50_000 },
    ]);
    w.portal = [
      async (form: FormData) => {
        const res = await accept(22)(form);
        const body = (await res.json()) as { inputs: unknown[] };
        return json(200, { no: 22, inputs: [...body.inputs].reverse() }); // 初回の保存順で返った
      },
    ];
    const r = await run(w);
    ok("一覧の順番が違っても、sha256 の集合と件数が同じなら受付", r.outcome === "accepted" && w.committed === 1 && w.replies[0].startsWith("#J22 受付しました"));
  }

  // ── 受付の確定の後に、返事の印（NX）が KV の障害で置けない ──
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(23)];
    const d = deps(w);
    d.store = {
      ...w.store,
      setNx: async () => {
        throw new Error("KV down");
      },
    };
    const r = await runObiIntake(input(), d);
    ok("印が置けない：受付は済み・再送させない・返事も push も出さない", r.outcome === "accepted" && !r.retry && w.committed === 1 && w.replies.length === 0 && w.pushes.length === 0, JSON.stringify(r));
  }

  // ── 返事の送り方（reply → はっきり失敗のときだけ push） ──
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(20)];
    w.replyMode = "rejected";
    await run(w);
    ok("reply が 400 → push でグループへ送り直す", w.pushes.length === 1 && w.pushes[0].startsWith(`${G}|#J20 受付しました`), w.pushes.join("|"));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(21)];
    w.replyMode = "unknown";
    await run(w);
    ok("reply の結果が不明なら push しない（二重を避ける）", w.replies.length === 1 && w.pushes.length === 0);
  }

  // ── 途中で止まる場面（落ちた後に LINE が再送してくる） ──
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(30)];
    w.replyMode = "crash"; // NX を置いた直後、送る前に落ちる
    let crashed = false;
    await run(w).catch(() => (crashed = true));
    ok("NX の直後に落ちた：受付は確定済み", crashed && w.committed === 1);
    w.replyMode = "sent";
    w.portal = [accept(30, 200)];
    const r = await run(w);
    ok("NX の直後に落ちた：再送でも受付の返事は出さない（1通落ちるのは受け入れる・二重にしない）", r.outcome === "accepted" && w.replies.length === 0 && w.pushes.length === 0);
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(31)];
    w.replyMode = "crash-after-send"; // reply を送っている途中で落ちる
    await run(w).catch(() => undefined);
    w.replyMode = "sent";
    w.portal = [accept(31, 200)];
    await run(w);
    ok("reply の途中で落ちた：再送で二重に送らない", w.replies.length === 1 && w.pushes.length === 0, String(w.replies.length));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(32)];
    w.replyMode = "rejected";
    w.pushMode = "crash-after-send"; // reply 400 → push の途中で落ちる
    await run(w).catch(() => undefined);
    w.replyMode = "sent";
    w.pushMode = "ok";
    w.portal = [accept(32, 200)];
    await run(w);
    ok("reply 400 → push の途中で落ちた：再送で二重に送らない", w.replies.length === 1 && w.pushes.length === 1);
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = ["timeout"];
    w.portalDelayMs = 30_000;
    w.replyMode = "crash"; // 確かめ中の NX の直後に落ちる
    let crashed = false;
    await run(w).catch(() => (crashed = true));
    ok("確かめ中の NX の直後に落ちた：受付は確定していない", crashed && w.committed === 0);
    w.replyMode = "sent";
    w.portalDelayMs = 0;
    w.portal = [accept(33, 200)];
    w.clock.t = T + 100_000;
    const r = await run(w, { startedAt: w.clock.t });
    ok("その後の再送で受付が分かれば受付の返事は出す", r.outcome === "accepted" && w.replies.length === 1 && w.replies[0].startsWith("#J33"));
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
```

- [ ] **Step 2: 失敗を確かめる**

  Run: `npx tsx tests/obi-intake.test.ts`
  Expected: FAIL（`Cannot find module '../src/lib/obi/intake'`）

- [ ] **Step 3: 受付全体を書く**

  `src/lib/obi/intake.ts`:
```ts
/**
 * グループからの帯替えの受付（設計 2026-10-09 の 9〜15）。
 *
 * 1回の Webhook の中で最後まで行う（同期）：
 *   控えから PDF を選ぶ → LINE から全部取り出す → 同じ中身を1つに →
 *   portal の /api/jobs/intake に1回で送る → 返った一覧を照合 → グループに返事
 *
 * 時間：Webhook の開始から55秒を締め切りにし、各段階は残り時間を分け合う
 *   LINE の取得は1件15秒・全体30秒まで（portal のために10秒は残す）、portal は1回20秒まで。
 *   Webhook の関数は maxDuration = 60。既存のイベントの予約（3分）より短いので、
 *   別の処理が同じ依頼を途中から引き継ぐことはない。
 *
 * 「済み」の境目：portal から受付番号と PDF の一覧が返り、**その一覧が送った PDF と一致した**時点
 * （件数と sha256 の集合。onCommitted）。その後の返事の失敗では受付を取り消さない。
 * 一覧が合わないときは済みにせず「受付を確かめられませんでした」と1回だけ返し、再送を待つ（retry）。
 * portal の結果が分からないときは「結果不明」として LINE の再送を待つ（retry）。
 * portal は1つの依頼につき、1回の Webhook の中で最大2回（最初の1回＋締め切りの中での呼び直し1回）。
 *
 * 返事は依頼1つにつき1回だけ：受付の返事は `obi-accepted-notified:<id>`、結果不明の返事は
 * `obi-pending-notified:<id>`、一覧が合わないときの返事は `obi-unconfirmed-notified:<id>` を
 * NX（期限24時間）で置けたときだけ送る。受付の確定の後に NX が KV の障害で置けないときは、
 * 返事を出さずにログだけ残す（二重を避ける。受付は portal・Discord で見える）。
 * **NX を置いた直後に落ちると、その返事は出ない**（二重に出すよりよい。受付は portal の一覧と
 * Discord で見える）。これは設計で受け入れた動き。
 */
import { deliverReply, type ReplyOutcome } from "../line";
import type { ObiConfig } from "./config";
import {
  OBI_NOTIFY_TTL_SECONDS,
  OBI_WINDOW_MS,
  selectObiPdfs,
  type ObiStore,
} from "./memo";
import { dedupeBySha256, fetchObiPdfs } from "./fetch-pdfs";
import { inputsMatch, postIntake, type IntakeOutcome, type IntakeRequest } from "./portal";
import { propertyFor, sanitizeForReply } from "./sanitize";

export const OBI_DEADLINE_MS = 55_000;
const LINE_FETCH_TOTAL_MS = 30_000;
const PORTAL_RESERVE_MS = 10_000; // 取り出しの段階で portal のために残す時間
const PORTAL_CALL_MS = 20_000;
const PORTAL_MIN_MS = 5_000; // これより短い残り時間では portal を呼ばない（呼び直さない）
const MAX_PORTAL_ATTEMPTS = 2; // 最初の1回＋呼び直し1回
const REQUEST_TEXT_MAX = 1000;
const REQUESTED_BY = "LINEグループ（営業部）";

export const OBI_MESSAGES = {
  stopped: "いま帯替えの受付を止めています",
  forbidden: "帯替えの依頼は下村さんからお願いします",
  noPdf: "直近30分に PDF がありません。PDF を貼ってからもう一度送ってください",
  tooMany: (count: number) =>
    `直近30分の PDF が${count}件あり、上限（20件・合計25MB）を超えるため受付できませんでした（1件も使っていません）。PDF を減らしてからもう一度送ってください`,
  tooLarge:
    "直近30分の PDF の合計が上限（20件・合計25MB）を超えるため受付できませんでした（1件も使っていません）。PDF を減らしてからもう一度送ってください",
  fetchFailed: (name: string) =>
    `受付できませんでした（${name} を取り出せません）。貼り直してからもう一度送ってください`,
  notPdf: (name: string) =>
    `受付できませんでした（${name} は PDF として読めません）。貼り直してからもう一度送ってください`,
  timeUp: "受付できませんでした（PDF の取り出しに時間がかかりました）。少し待ってからもう一度送ってください",
  noTimestamp: "受付できませんでした（依頼の時刻が分かりません）。もう一度送ってください",
  busy: (no?: number) =>
    no
      ? `前の帯替え（#J${no}）を処理中です。終わってからもう一度送ってください`
      : "前の帯替えを処理中です。終わってからもう一度送ってください",
  unreachable: "受付できませんでした（portal に届きません）。少し待ってからもう一度送ってください",
  rejected: (code: string) => `受付できませんでした（${code}）。portal の一覧を確かめてください`,
  pending:
    "受付の結果を確かめています。同じ依頼をもう一度送らないでください。結果は Discord の AI会社か portal の一覧で確かめられます",
  accepted: (no: number, property: string, names: string[]) => {
    const files = names.length > 1 ? `${names[0]} ほか${names.length - 1}件` : names[0];
    return `#J${no} 受付しました（物件：${property}／PDF：${files}）。完成したらここにリンクを出します`;
  },
  unconfirmed:
    "受付を確かめられませんでした（portal に入った PDF が送ったものと合いません）。同じ依頼はもう一度送らず、portal の一覧を確かめてください",
};

export interface ObiIntakeInput {
  requestMessageId: string; // 依頼の LINE message.id（数字の文字列）
  /** 依頼の LINE イベントの時刻（ms）。無い・不正なら受付けない（今の時刻で代わりにしない） */
  requestTimestamp: number | undefined;
  groupId: string; // 営業部（config.groupId と同じ）
  requestText: string; // 依頼の本文（そのまま。portal の requestText に入れる）
  property: string; // parseJobCommand の property（空のこともある）。「担当:」は portal に渡さないので持たない
  startedAt: number; // Webhook の開始時刻（ms）
  config: ObiConfig;
}

export interface ObiIntakeDeps {
  store: ObiStore;
  fetchImpl: typeof fetch;
  lineToken: string;
  now: () => number;
  /** 依頼への reply（結果を3つに分けて返す。例外は投げない作り） */
  reply: (text: string) => Promise<ReplyOutcome>;
  /** reply がはっきり断られたときの push（送れたら true） */
  push: (to: string, text: string) => Promise<boolean>;
  /** portal で受付が確定し、一覧も一致した（以後は再送させない） */
  onCommitted: () => void;
}

export interface ObiIntakeResult {
  /** unconfirmed＝portal は受付番号を返したが、一覧が送った PDF と合わない（済みにしない） */
  outcome: "accepted" | "refused" | "pending" | "unconfirmed";
  /** true なら Webhook はこのイベントを済みにせず、5xx で LINE の再送を待つ */
  retry: boolean;
}

function rejectionMessage(o: Extract<IntakeOutcome, { kind: "rejected" }>): string {
  if (o.code === "OBI_BUSY") return OBI_MESSAGES.busy(o.busyJobNo);
  if (o.code === "INTAKE_STOPPED") return OBI_MESSAGES.stopped;
  if (o.code === "INPUT_TOO_LARGE") return OBI_MESSAGES.tooLarge;
  if (o.code === "INTAKE_MISMATCH") return OBI_MESSAGES.unconfirmed;
  return OBI_MESSAGES.rejected(sanitizeForReply(o.code));
}

export async function runObiIntake(
  input: ObiIntakeInput,
  deps: ObiIntakeDeps
): Promise<ObiIntakeResult> {
  const deadline = input.startedAt + OBI_DEADLINE_MS;
  const say = (text: string) =>
    deliverReply(text, { reply: deps.reply, push: (t) => deps.push(input.groupId, t) });
  const refuse = async (text: string): Promise<ObiIntakeResult> => {
    await say(text);
    return { outcome: "refused", retry: false };
  };

  if (!/^\d{1,64}$/.test(input.requestMessageId)) {
    return refuse(OBI_MESSAGES.rejected("INVALID_REQUEST"));
  }
  // 依頼の時刻が無いと「30分以内」を決められない。今の時刻で代わりにしない（再送で窓がずれるため）
  const requestTimestamp = input.requestTimestamp;
  if (
    typeof requestTimestamp !== "number" ||
    !Number.isSafeInteger(requestTimestamp) ||
    requestTimestamp <= 0
  ) {
    return refuse(OBI_MESSAGES.noTimestamp);
  }

  // ① 控えから選ぶ（依頼の時刻から30分以内・依頼より前）
  const records = await deps.store.listPdfs(
    input.groupId,
    requestTimestamp - OBI_WINDOW_MS,
    requestTimestamp
  );
  const sel = selectObiPdfs(records, {
    messageId: input.requestMessageId,
    timestamp: requestTimestamp,
  });
  if (sel.kind === "none") return refuse(OBI_MESSAGES.noPdf);
  if (sel.kind === "too-many") return refuse(OBI_MESSAGES.tooMany(sel.count));
  if (sel.kind === "too-large") return refuse(OBI_MESSAGES.tooLarge);

  // ② LINE から全部取り出す。1件でもだめならやめる
  const fetched = await fetchObiPdfs(sel.pdfs, {
    fetchImpl: deps.fetchImpl,
    lineToken: deps.lineToken,
    now: deps.now,
    deadline: Math.min(deps.now() + LINE_FETCH_TOTAL_MS, deadline - PORTAL_RESERVE_MS),
  });
  if (fetched.kind === "too-large") return refuse(OBI_MESSAGES.tooLarge);
  if (fetched.kind === "failed") {
    const name = sanitizeForReply(fetched.fileName);
    return refuse(
      fetched.reason === "not-pdf" ? OBI_MESSAGES.notPdf(name) : OBI_MESSAGES.fetchFailed(name)
    );
  }
  // 同じ中身は1つに（先に出たものを残す）。この一覧を正本として送る・照合する・返事に書く
  const files = dedupeBySha256(fetched.files);
  const property = propertyFor(input.property, files[0].fileName);
  const request: IntakeRequest = {
    lineMessageId: input.requestMessageId,
    property,
    requestText: Array.from(input.requestText).slice(0, REQUEST_TEXT_MAX).join(""),
    requestedBy: REQUESTED_BY,
    replyGroupId: input.config.groupId,
    files: files.map((f) => ({ fileName: f.fileName, bytes: f.bytes })),
  };

  // ③ portal へ1回で送る。結果が分からなければ、締め切りの中で同じ内容をもう1回だけ（同じ
  //    lineMessageId なので portal 側で二重にならない）。呼ぶのは最大2回
  let outcome: IntakeOutcome | null = null;
  let sawUnknown = false;
  for (let i = 0; i < MAX_PORTAL_ATTEMPTS; i++) {
    const remaining = deadline - deps.now();
    if (remaining < PORTAL_MIN_MS) break;
    outcome = await postIntake(request, {
      fetchImpl: deps.fetchImpl,
      baseUrl: input.config.portalBaseUrl,
      token: input.config.jobApiToken,
      timeoutMs: Math.min(PORTAL_CALL_MS, remaining),
    });
    if (outcome.kind === "unknown") {
      sawUnknown = true;
      continue;
    }
    // 前の呼び出しが届いたか分からないまま「つながらない」になっても、受付できなかったとは言えない
    if (outcome.kind === "unreachable" && sawUnknown) continue;
    break;
  }
  // 一度も送っていない＝portal に受付は無い
  if (outcome === null) return refuse(OBI_MESSAGES.timeUp);

  if (outcome.kind === "accepted") {
    // 一覧が送った PDF と合わなければ済みにしない（受付の返事も出さない）。
    // 「確かめられませんでした」を1回だけ返し、再送を待つ
    if (!inputsMatch(files, outcome.inputs)) {
      console.error("帯替え：portal の一覧が送った PDF と合わない:", outcome.no);
      if (
        await deps.store.setNx(
          `obi-unconfirmed-notified:${input.requestMessageId}`,
          OBI_NOTIFY_TTL_SECONDS
        )
      ) {
        await say(OBI_MESSAGES.unconfirmed);
      }
      return { outcome: "unconfirmed", retry: true };
    }
    deps.onCommitted();
    let first: boolean;
    try {
      first = await deps.store.setNx(
        `obi-accepted-notified:${input.requestMessageId}`,
        OBI_NOTIFY_TTL_SECONDS
      );
    } catch (err) {
      // 受付は確定済み。印が置けないまま送ると二重になりうるので、返事は出さずにログだけ
      console.error(
        "帯替え：受付の返事の印を置けない（返事は出さない）:",
        input.requestMessageId,
        (err as Error)?.message ?? err
      );
      return { outcome: "accepted", retry: false };
    }
    if (first) {
      await say(
        OBI_MESSAGES.accepted(
          outcome.no,
          sanitizeForReply(property),
          files.map((f) => sanitizeForReply(f.fileName))
        )
      );
    }
    return { outcome: "accepted", retry: false };
  }
  if (outcome.kind === "rejected") return refuse(rejectionMessage(outcome));
  if (outcome.kind === "unreachable" && !sawUnknown) return refuse(OBI_MESSAGES.unreachable);

  // ④ 結果不明：受付できなかったとは言わない。返事は1回だけにして、LINE の再送を待つ
  console.error("帯替え：portal の受付の結果が分からない:", input.requestMessageId);
  if (
    await deps.store.setNx(
      `obi-pending-notified:${input.requestMessageId}`,
      OBI_NOTIFY_TTL_SECONDS
    )
  ) {
    await say(OBI_MESSAGES.pending);
  }
  return { outcome: "pending", retry: true };
}
```

- [ ] **Step 4: 通ることを確かめる**

  Run: `npx tsx tests/obi-intake.test.ts`
  Expected: すべて `✅`、`🎉 全て通過`（「portal の受付の結果が分からない」「一覧が送った PDF と合わない」「受付の返事の印を置けない（返事は出さない）: … KV down」のログは、その場面を試しているので正しい）

- [ ] **Step 5: `npm test` に足し、型を確かめる**

```json
    "test": "tsx tests/clarify.reducer.test.ts && tsx tests/session.store.test.ts && tsx tests/apihealth.test.ts && tsx tests/clarify-target.test.ts && tsx tests/assignment.test.ts && tsx tests/task-intake.test.ts && tsx tests/obi-parse.test.ts && tsx tests/obi-config.test.ts && tsx tests/line-reply.test.ts && tsx tests/obi-memo.test.ts && tsx tests/obi-fetch.test.ts && tsx tests/obi-portal.test.ts && tsx tests/obi-intake.test.ts",
```
  Run: `npm test && npx tsc --noEmit --incremental false -p .`
  Expected: `🎉 全て通過`、tsc は何も出さない

- [ ] **Step 6: コミット**

```bash
git add src/lib/obi/intake.ts tests/obi-intake.test.ts package.json
git commit -m "$(cat <<'EOF'
feat: グループからの帯替えの受付を1回の処理で最後まで行う（選ぶ・取り出す・portal・照合・返事）

受付番号と一致する一覧が返った時点で済みにし、一覧が合わない・結果不明なら返事を1回だけにして再送を待つ。
portal は最大2回。依頼の時刻が無ければ受付けない。担当は portal に送らない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Webhook につなぐ（振り分けの切り出し・maxDuration・PDF の控え・帯替えの分岐）

**Files:**
- Create: `src/lib/obi/webhook-event.ts`
- Create: `tests/obi-webhook-event.test.ts`
- Modify: `src/app/api/webhook/route.ts:2-8`（line の import）
- Modify: `src/app/api/webhook/route.ts:96`（notion の import の後に import と `maxDuration`）
- Modify: `src/app/api/webhook/route.ts:200`（`LineMessage` に `fileSize`）
- Modify: `src/app/api/webhook/route.ts:207-212`（`LineWebhookEvent` に `timestamp`）
- Modify: `src/app/api/webhook/route.ts:552-569`（`obiEventDeps` を足し、`POST` の先頭に `startedAt`、今までのループの前で `dispatchObiEvents`、ループは `obi.rest` を回す）
- Modify: `package.json:11`

**Interfaces:**
- Consumes: `classifyObiEntry`・`shouldRecordObiPdf`・`ObiEnv`（Task 3）、`deliverReply`・`replyLineMessageDetailed`・`ReplyOutcome`（Task 4）、`ObiStore`・`recordObiPdf`・`getObiStore`（Task 5）、`runObiIntake`・`OBI_MESSAGES`（Task 8）。既存の `taskMentionState`（`src/lib/task-intake.ts:12`。読み込みの副作用なし）・`reserveEvent`／`completeEvent`／`releaseEvent`（`src/lib/email/session.ts:687-700`。route.ts:63-65 で読み込み済み）・`pushLineMessage`（line.ts:59）
- Produces:
```ts
// src/lib/obi/webhook-event.ts
export interface ObiLineEvent { type: string; replyToken?: string; timestamp?: number; source: { userId?: string; type?: string; groupId?: string }; message?: { id: string; type: string; text?: string; fileName?: string; fileSize?: number; mention?: { mentionees: Array<{ index: number; length: number; type: "user" | "all"; userId?: string }> } } }
export interface ObiEventDeps { env: ObiEnv; botUserId: string | undefined; startedAt: number; store: ObiStore; events: { reserve(id: string): Promise<{ proceed: boolean; inProgress?: boolean }>; complete(id: string): Promise<void>; release(id: string): Promise<void> }; fetchImpl: typeof fetch; lineToken: string; now: () => number; reply: (replyToken: string, text: string) => Promise<ReplyOutcome>; push: (to: string, text: string) => Promise<boolean> }
export interface ObiDispatchResult<E> { needsRetry: boolean; rest: E[] }
export async function dispatchObiEvents<E extends ObiLineEvent>(events: E[], deps: ObiEventDeps): Promise<ObiDispatchResult<E>>;
// route.ts から外に出すのは maxDuration だけ
```

なぜ切り出すか：route.ts は Notion・Claude などを読み込むので、そのままではテストから `POST` を呼べない。また今までのループの中身（約780行・`continue` が40か所余り・内側にもループ）を関数に移すのは危ない。そこで**帯替えの分だけを `dispatchObiEvents` に切り出し、今までのループの前で呼ぶ**。帯替えとして扱わなかったイベントは元の順番のまま `rest` に入り、今までのループ（中身は1文字も変えない）が扱う。テストは `dispatchObiEvents` を偽物の KV・LINE・portal・予約（`reserve`／`complete`／`release`）で呼び、「今までの流れへ行くか（`rest` に入るか）」「`completeEvent` を呼ぶか」「503 になるか（`needsRetry`）」を確かめる。

つなぎ方の要点：
- 帯替えの依頼（stopped・forbidden・request）は `dispatchObiEvents` の中で `reserveEvent` → 処理 → `completeEvent`／`releaseEvent` まで行う。考え方は今までのループと同じ：確定（`onCommitted`）の後は何があっても再送させない。結果不明・一覧の不一致・確定前の例外は予約を外し（`completeEvent` を呼ばない）、`needsRetry` を立てる
- route.ts は `let needsRetry = obi.needsRetry` から始めるので、帯替えの再送要求は今までどおりバッチの最後の 503（route.ts:1349-1352）になる
- 依頼は今までのループに渡さないので、メールの下書きの確認（route.ts:646 の `getDraftSession`）より必ず先に扱われる（設計 8）。先頭が依頼語でない発言（下書きへの「送信」など）は `rest` に入り、今までどおり下書きの返事として扱われる
- PDF の控えは予約より前に行う（`zadd` なので何度足しても同じ）。控えに失敗しても今までの流れ（`handleIncomingFile`）は止めず、`needsRetry` を立てて再送で控え直す（予約済みの今までの処理は再送でスキップされる）
- 1回分に帯替えの依頼と他のイベントが混ざると、帯替えの依頼を先に扱い、他は元の順番のまま後で扱う（帯替えの依頼は今までの流れと状態を共有しないので、順番が変わっても結果は同じ。帯替えが長引いて 60 秒で切られた場合、他のイベントは予約前なので LINE の再送で扱われる）
- 「担当:」は `classifyObiEntry` が読むが、`runObiIntake` に渡さない（portal に送らない）
- イベントの時刻が無い PDF は控えない。時刻が無い依頼は `runObiIntake` が「依頼の時刻が分かりません」で断る（`Date.now()` は使わない）
- `event.source.type` は振り分けの中で直接読むので、今までのループの `source`（route.ts:613-617）は変えない

- [ ] **Step 1: 失敗するテストを書く**

  `tests/obi-webhook-event.test.ts`:
```ts
/**
 * Webhook のイベントの振り分け（帯替えの分）を、偽物の KV・LINE・portal・予約で確かめる。
 * route.ts は dispatchObiEvents の rest だけを今までのループに渡し、needsRetry なら 503 を返す。
 *
 * 「今までの流れ」（メールの下書き・タスク等）は rest に入ったかどうかで確かめる。
 */
import { createHash } from "node:crypto";
import { dispatchObiEvents, type ObiEventDeps, type ObiLineEvent } from "../src/lib/obi/webhook-event";
import { createMemoryObiStore, recordObiPdf, type MemoryObiStore, type ObiStore } from "../src/lib/obi/memo";
import { OBI_MESSAGES } from "../src/lib/obi/intake";
import type { ObiEnv } from "../src/lib/obi/config";
import type { ReplyOutcome } from "../src/lib/line";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

const G = "C" + "a".repeat(32);
const G2 = "C" + "e".repeat(32);
const SHIMO = "U" + "b".repeat(32);
const OTHER = "U" + "c".repeat(32);
const BOT = "U" + "f".repeat(32);
const T = 1_760_000_000_000;
const env: ObiEnv = {
  LINE_GROUP_ID: G,
  JOB_ALLOWED_USER_IDS: SHIMO,
  PORTAL_BASE_URL: "https://portal.example.test",
  JOB_API_TOKEN: "tok",
};
const enc = (s: string) => new TextEncoder().encode(s);
const pdf = (s: string) => enc(`%PDF-1.7\n${s}`);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ab = (u8: Uint8Array) => {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type PortalAnswer = "accept" | "timeout" | "mismatch";

interface World {
  store: ObiStore & Partial<Pick<MemoryObiStore, "sizes">>;
  memory: MemoryObiStore;
  clock: { t: number };
  line: Record<string, Uint8Array>;
  portal: PortalAnswer[];
  portalForms: FormData[];
  replies: Array<{ token: string; text: string }>;
  pushes: string[];
  reserved: string[];
  completed: string[];
  released: string[];
  reserveAnswer: { proceed: boolean; inProgress?: boolean };
}

function world(): World {
  const clock = { t: T + 1000 };
  const memory = createMemoryObiStore(() => clock.t);
  return {
    store: memory,
    memory,
    clock,
    line: {},
    portal: ["accept"],
    portalForms: [],
    replies: [],
    pushes: [],
    reserved: [],
    completed: [],
    released: [],
    reserveAnswer: { proceed: true },
  };
}

async function portalAnswer(w: World, form: FormData): Promise<Response> {
  const a = w.portal.length > 1 ? w.portal.shift()! : w.portal[0];
  if (a === "timeout") throw new DOMException("timed out", "TimeoutError");
  const inputs = [];
  for (const f of form.getAll("files") as File[]) {
    const b = new Uint8Array(await f.arrayBuffer());
    inputs.push({ name: f.name, sha256: a === "mismatch" ? "0".repeat(64) : sha(b), size: b.byteLength });
  }
  return json(201, { no: 12, status: "下準備中", created: true, inputs });
}

function deps(w: World, envOver: ObiEnv = env): ObiEventDeps {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const m = u.match(/message\/(\d+)\/content$/);
    if (m) {
      const b = w.line[m[1]];
      return b ? new Response(ab(b), { status: 200 }) : new Response("x", { status: 404 });
    }
    if (u === "https://portal.example.test/api/jobs/intake") {
      w.portalForms.push(init?.body as FormData);
      return portalAnswer(w, init?.body as FormData);
    }
    throw new Error(`想定外の宛先: ${u}`);
  }) as typeof fetch;
  return {
    env: envOver,
    botUserId: BOT,
    startedAt: w.clock.t,
    store: w.store,
    events: {
      reserve: async (id) => {
        w.reserved.push(id);
        return w.reserveAnswer;
      },
      complete: async (id) => {
        w.completed.push(id);
      },
      release: async (id) => {
        w.released.push(id);
      },
    },
    fetchImpl,
    lineToken: "line-token",
    now: () => w.clock.t,
    reply: async (token: string, text: string): Promise<ReplyOutcome> => {
      w.replies.push({ token, text });
      return { kind: "sent", messageId: "bot-1" };
    },
    push: async (to: string, text: string) => {
      w.pushes.push(`${to}|${text}`);
      return true;
    },
  };
}

/** @MD NEXT秘書 へのメンションつきのテキストのイベント */
const textEvent = (
  id: string,
  body: string,
  over: { groupId?: string; userId?: string; sourceType?: string; timestamp?: number | null; mention?: boolean } = {}
): ObiLineEvent => {
  const prefix = "@MD NEXT秘書 ";
  const mention = over.mention ?? true;
  return {
    type: "message",
    replyToken: `rt-${id}`,
    timestamp: over.timestamp === null ? undefined : over.timestamp ?? T,
    source: {
      type: over.sourceType ?? "group",
      groupId: over.groupId ?? G,
      userId: over.userId ?? SHIMO,
    },
    message: {
      id,
      type: "text",
      text: mention ? prefix + body : body,
      ...(mention
        ? { mention: { mentionees: [{ index: 0, length: prefix.length - 1, type: "user" as const, userId: BOT }] } }
        : {}),
    },
  };
};
const fileEvent = (
  id: string,
  fileName: string,
  over: { groupId?: string; timestamp?: number | null } = {}
): ObiLineEvent => ({
  type: "message",
  replyToken: `rt-${id}`,
  timestamp: over.timestamp === null ? undefined : over.timestamp ?? T - 60_000,
  source: { type: "group", groupId: over.groupId ?? G, userId: OTHER },
  message: { id, type: "file", fileName, fileSize: 100 },
});

/** 営業部に PDF を1件控え、LINE の偽物に中身を置く */
async function seedPdf(w: World, id = "600000000000000002", name = "a.pdf") {
  await recordObiPdf(w.memory, G, { messageId: id, fileName: name, size: 100, timestamp: T - 60_000, userId: OTHER });
  w.line[id] = pdf(name);
}

const REQ = "600000000000000100";

async function main() {
  // ── 他のグループ：今までの流れへ（portal を呼ばない・予約もしない） ──
  {
    const w = world();
    const ev = textEvent(REQ, "帯替え 架空邸", { groupId: G2 });
    const r = await dispatchObiEvents([ev], deps(w));
    ok("他のグループの依頼の形は今までの流れへ", r.rest.length === 1 && r.rest[0] === ev && !r.needsRetry);
    ok("他のグループ：portal も返事も予約もない", w.portalForms.length === 0 && w.replies.length === 0 && w.reserved.length === 0);
  }
  {
    const w = world();
    const ev = textEvent(REQ, "帯替え 架空邸", { sourceType: "user", groupId: undefined });
    const r = await dispatchObiEvents([ev], deps(w));
    ok("個別トークは今までの流れへ", r.rest.length === 1 && w.reserved.length === 0);
  }

  // ── メールの下書きの途中でも、先頭が依頼語なら帯替え（今までの流れに渡さない） ──
  {
    const w = world();
    await seedPdf(w);
    // 今までの流れ（メールの下書き中なら handleConfirmReply が拾う）は rest に入ったものだけを見る
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w));
    ok("依頼は今までの流れに渡さない（下書きの返事として拾われない）", r.rest.length === 0 && !r.needsRetry);
    ok("依頼は portal に送り、受付の返事を reply で返す", w.portalForms.length === 1 && w.replies.length === 1 && w.replies[0].token === `rt-${REQ}` && w.replies[0].text.startsWith("#J12 受付しました"), JSON.stringify(w.replies));
    ok("依頼の予約を取り、済みにする", w.reserved.join() === REQ && w.completed.join() === REQ && w.released.length === 0);
  }
  {
    const w = world();
    const ev = textEvent(REQ, "送信");
    const r = await dispatchObiEvents([ev], deps(w));
    ok("先頭が依頼語でない発言（下書きへの「送信」）は今までの流れへ", r.rest.length === 1 && w.reserved.length === 0);
  }
  {
    const w = world();
    const ev = textEvent(REQ, "帯替え 架空邸", { mention: false });
    const r = await dispatchObiEvents([ev], deps(w));
    ok("@MD NEXT秘書 のメンションが無ければ今までの流れへ", r.rest.length === 1 && w.reserved.length === 0);
  }

  // ── 1回分に複数のイベント：順番を変えずに今までの流れへ ──
  {
    const w = world();
    w.line["600000000000000090"] = pdf("x");
    const f = fileEvent("600000000000000090", "図面.pdf");
    const req = textEvent(REQ, "帯替え 架空邸");
    const other = textEvent("600000000000000101", "明日の予定は？", { mention: false });
    const img: ObiLineEvent = { type: "message", replyToken: "rt-i", timestamp: T, source: { type: "group", groupId: G, userId: OTHER }, message: { id: "600000000000000102", type: "image" } };
    const follow: ObiLineEvent = { type: "follow", replyToken: "rt-f", timestamp: T, source: { type: "user", userId: OTHER } };
    const r = await dispatchObiEvents([f, req, other, img, follow], deps(w));
    ok("PDF・依頼以外は元の順番のまま今までの流れへ", r.rest.length === 4 && r.rest[0] === f && r.rest[1] === other && r.rest[2] === img && r.rest[3] === follow);
    ok("同じ回の先に出た PDF を控えてから依頼を扱う", w.portalForms.length === 1 && (w.portalForms[0].getAll("files") as File[])[0].name === "図面.pdf");
  }

  // ── PDF の控え ──
  {
    const w = world();
    const f = fileEvent("600000000000000003", "図面.PDF");
    const r = await dispatchObiEvents([f], deps(w));
    ok("営業部の PDF は控え、今までの流れ（handleIncomingFile）にも渡す", w.memory.sizes(G).z === 1 && r.rest[0] === f && !r.needsRetry);
    const g = fileEvent("600000000000000004", "図面.pdf", { groupId: G2 });
    await dispatchObiEvents([g], deps(w));
    ok("他のグループの PDF は控えない", w.memory.sizes(G2).z === 0);
  }
  {
    const w = world();
    const f = fileEvent("600000000000000003", "図面.pdf", { timestamp: null });
    const r = await dispatchObiEvents([f], deps(w));
    ok("イベントの時刻が無い PDF は控えない（今の時刻で代わりにしない）", w.memory.sizes(G).z === 0 && r.rest.length === 1 && !r.needsRetry);
  }
  {
    const w = world();
    w.store = {
      ...w.memory,
      addPdf: async () => {
        throw new Error("KV down");
      },
    };
    const f = fileEvent("600000000000000003", "図面.pdf");
    const r = await dispatchObiEvents([f], deps(w));
    ok("控えに失敗：今までの流れは止めずに、503 で再送を待つ", r.needsRetry && r.rest[0] === f);
  }

  // ── 依頼の時刻が無い：受付けない ──
  {
    const w = world();
    await seedPdf(w);
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸", { timestamp: null })], deps(w));
    ok("依頼の時刻が無い：portal を呼ばず、短く断る", w.portalForms.length === 0 && w.replies.map((x) => x.text).join() === OBI_MESSAGES.noTimestamp && r.rest.length === 0 && !r.needsRetry);
    ok("依頼の時刻が無い：済みにする（再送しても時刻は付かない）", w.completed.join() === REQ);
  }

  // ── 一覧が合わない：済みにしない ──
  {
    const w = world();
    await seedPdf(w);
    w.portal = ["mismatch"];
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w));
    ok("一覧が合わない：completeEvent を呼ばない", w.completed.length === 0 && w.released.join() === REQ, JSON.stringify({ c: w.completed, r: w.released }));
    ok("一覧が合わない：503 で再送を待つ", r.needsRetry);
    ok("一覧が合わない：「確かめられませんでした」だけを返す", w.replies.map((x) => x.text).join("|") === OBI_MESSAGES.unconfirmed && w.pushes.length === 0);
  }

  // ── 結果不明：再送を待つ ──
  {
    const w = world();
    await seedPdf(w);
    w.portal = ["timeout"];
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w));
    ok("結果不明：予約を外し（completeEvent を呼ばない）、503", r.needsRetry && w.completed.length === 0 && w.released.join() === REQ);
    ok("結果不明：portal は2回まで・確かめ中の返事", w.portalForms.length === 2 && w.replies.map((x) => x.text).join() === OBI_MESSAGES.pending);
  }

  // ── 受付の確定の後に、返事の印（NX）が KV の障害で置けない ──
  {
    const w = world();
    await seedPdf(w);
    w.store = {
      ...w.memory,
      setNx: async () => {
        throw new Error("KV down");
      },
    };
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w));
    ok("印が置けない：済みにする・再送させない", !r.needsRetry && w.completed.join() === REQ && w.released.length === 0);
    ok("印が置けない：返事も push も出さない", w.replies.length === 0 && w.pushes.length === 0);
  }

  // ── 受付の確定の後に返事が例外で落ちる：再送させない ──
  {
    const w = world();
    await seedPdf(w);
    const d = deps(w);
    d.reply = async () => {
      throw new Error("crash");
    };
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], d);
    ok("確定後の例外：再送させず済みにする", !r.needsRetry && w.completed.join() === REQ);
  }
  // ── 確定の前に例外：再送でやり直す ──
  {
    const w = world();
    await seedPdf(w);
    w.store = {
      ...w.memory,
      listPdfs: async () => {
        throw new Error("KV down");
      },
    };
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w));
    ok("確定前の例外：予約を外して 503", r.needsRetry && w.released.join() === REQ && w.completed.length === 0);
  }

  // ── 「担当:」は portal に渡さない ──
  {
    const w = world();
    await seedPdf(w);
    await dispatchObiEvents([textEvent(REQ, "帯替え 担当:佐藤 架空邸")], deps(w));
    const f = w.portalForms[0];
    ok("担当を書いても assigneeName は送らない・物件名は読む", !!f && f.get("assigneeName") === null && f.get("property") === "架空邸");
  }

  // ── 予約 ──
  {
    const w = world();
    w.reserveAnswer = { proceed: false };
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w));
    ok("済みの依頼の再送は何もしない（今までの流れにも渡さない）", !r.needsRetry && r.rest.length === 0 && w.portalForms.length === 0 && w.replies.length === 0);
    w.reserveAnswer = { proceed: false, inProgress: true };
    const r2 = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w));
    ok("処理中の依頼の再送は 503（処理中の側が落ちていたら引き継ぐ）", r2.needsRetry && r2.rest.length === 0);
  }

  // ── 許可リスト外 ──
  {
    const w = world();
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸", { userId: OTHER })], deps(w));
    ok("許可リスト外の人：下村さんから、とだけ返す", w.replies.map((x) => x.text).join() === OBI_MESSAGES.forbidden && w.portalForms.length === 0 && r.rest.length === 0 && w.completed.join() === REQ);
  }

  // ── 設定 ──
  {
    const w = world();
    await seedPdf(w);
    const noGroup = { ...env, LINE_GROUP_ID: undefined };
    const f = fileEvent("600000000000000003", "図面.pdf");
    const r1 = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸"), f], deps(w, noGroup));
    const r2 = await dispatchObiEvents([textEvent("600000000000000104", "帯替え 架空邸", { groupId: G2 })], deps(w, noGroup));
    ok("LINE_GROUP_ID が無い：どのグループの依頼も今までの流れへ（返事なし）", r1.rest.length === 2 && r2.rest.length === 1 && w.replies.length === 0 && w.reserved.length === 0 && w.portalForms.length === 0);
    ok("LINE_GROUP_ID が無い：PDF も控えない", w.memory.sizes(G).z === 1 /* seedPdf の1件だけ */);
  }
  {
    const w = world();
    const noToken = { ...env, JOB_API_TOKEN: undefined };
    const r1 = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w, noToken));
    ok("LINE_GROUP_ID は正しく鍵が無い：営業部の依頼の形には「止めています」", r1.rest.length === 0 && w.replies.map((x) => x.text).join() === OBI_MESSAGES.stopped && w.portalForms.length === 0 && w.completed.join() === REQ);
    const r2 = await dispatchObiEvents([textEvent("600000000000000105", "帯替え 架空邸", { groupId: G2 })], deps(w, noToken));
    ok("LINE_GROUP_ID は正しく鍵が無い：他のグループは今までの流れへ", r2.rest.length === 1 && w.replies.length === 1);
    const r3 = await dispatchObiEvents([textEvent("600000000000000106", "おはようございます")], deps(w, noToken));
    ok("LINE_GROUP_ID は正しく鍵が無い：依頼の形でない発言は今までの流れへ", r3.rest.length === 1 && w.replies.length === 1);
    await dispatchObiEvents([fileEvent("600000000000000003", "図面.pdf")], deps(w, noToken));
    ok("LINE_GROUP_ID は正しく鍵が無い：PDF は控えない", w.memory.sizes(G).z === 0);
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
```

- [ ] **Step 2: 失敗を確かめる**

  Run: `npx tsx tests/obi-webhook-event.test.ts`
  Expected: FAIL（`Cannot find module '../src/lib/obi/webhook-event'`）

- [ ] **Step 3: 振り分けを書く**

  `src/lib/obi/webhook-event.ts`:
```ts
/**
 * Webhook のイベントの振り分けのうち、帯替えの分（設計 2026-10-09 の 6・8・9・13・14の2）。
 *
 * route.ts は、今までの流れ（メールの下書き・初動確認・タスク等）の前にこれを呼ぶ：
 *   - 営業部のグループの PDF（file）は、帯替え用の控えに足してから、今までの流れにも渡す
 *     （控えは何度足しても同じ。予約より前に置くので、LINE の再送でも控え直せる）
 *   - 帯替えの依頼（@MD NEXT秘書 ＋ 本文の先頭が依頼語）は、ここで予約を取り、最後まで扱う。
 *     今までの流れには渡さない（メールの下書きの途中でも帯替えを先に扱う：設計 8）
 *   - それ以外は、順番を変えずに今までの流れへ（rest）
 *
 * 予約・完了・解放の扱いは route.ts の今までのイベントと同じ考え方：
 *   受付が確定して一覧も一致した（onCommitted）後は、何があっても再送させない。
 *   結果不明・一覧が合わない・例外（確定前）は予約を外し、503 で LINE の再送を待つ。
 *
 * route.ts は Notion・Claude などを読み込むため、そのままでは試せない。
 * 振り分けをここに分け、偽物の KV・LINE・portal・予約で確かめる（tests/obi-webhook-event.test.ts）。
 */
import { deliverReply, type ReplyOutcome } from "../line";
import { taskMentionState } from "../task-intake";
import { classifyObiEntry, shouldRecordObiPdf, type ObiEnv } from "./config";
import { recordObiPdf, type ObiStore } from "./memo";
import { runObiIntake, OBI_MESSAGES } from "./intake";

export interface ObiLineEvent {
  type: string;
  replyToken?: string;
  timestamp?: number;
  source: { userId?: string; type?: string; groupId?: string };
  message?: {
    id: string;
    type: string;
    text?: string;
    fileName?: string;
    fileSize?: number;
    mention?: {
      mentionees: Array<{ index: number; length: number; type: "user" | "all"; userId?: string }>;
    };
  };
}

export interface ObiEventDeps {
  env: ObiEnv;
  /** @MD NEXT秘書 の userId（LINE_BOT_USER_ID） */
  botUserId: string | undefined;
  /** Webhook の開始時刻（ms）。受付の締め切りの起点 */
  startedAt: number;
  store: ObiStore;
  /** イベントの予約（src/lib/email/session.ts の reserveEvent・completeEvent・releaseEvent） */
  events: {
    reserve(messageId: string): Promise<{ proceed: boolean; inProgress?: boolean }>;
    complete(messageId: string): Promise<void>;
    release(messageId: string): Promise<void>;
  };
  fetchImpl: typeof fetch;
  lineToken: string;
  now: () => number;
  reply: (replyToken: string, text: string) => Promise<ReplyOutcome>;
  push: (to: string, text: string) => Promise<boolean>;
}

export interface ObiDispatchResult<E> {
  /** true なら Webhook は 503 を返して LINE の再送を待つ */
  needsRetry: boolean;
  /** 今までの流れに渡すイベント（元の順番のまま） */
  rest: E[];
}

/** メンション部分を本文から除く（route.ts の stripMentions と同じ） */
function stripMentionText(message: NonNullable<ObiLineEvent["message"]>): string {
  const text = message.text ?? "";
  if (!message.mention) return text;
  const mentionees = [...message.mention.mentionees].sort((a, b) => b.index - a.index);
  let out = text;
  for (const m of mentionees) out = out.slice(0, m.index) + out.slice(m.index + m.length);
  return out.trim();
}

function validTimestamp(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isSafeInteger(ts) && ts > 0;
}

/** 営業部の PDF を控える。控えられなかったら true（再送が要る） */
async function recordIfObiPdf(event: ObiLineEvent, deps: ObiEventDeps): Promise<boolean> {
  const message = event.message!;
  const fileName = message.fileName ?? "";
  const groupId = event.source.groupId;
  if (
    !groupId ||
    !shouldRecordObiPdf({ sourceType: event.source.type, groupId, fileName }, deps.env)
  ) {
    return false;
  }
  // 時刻が無いと「依頼から30分以内」を決められない。今の時刻で代わりにしない
  if (!validTimestamp(event.timestamp)) {
    console.error("帯替えの控え：イベントの時刻が無いので控えない:", message.id);
    return false;
  }
  try {
    await recordObiPdf(deps.store, groupId, {
      messageId: message.id,
      fileName,
      size: message.fileSize ?? 0,
      timestamp: event.timestamp,
      userId: event.source.userId ?? "",
    });
    return false;
  } catch (err) {
    // KV の障害など。今までの流れ（handleIncomingFile）は止めず、再送で控え直す
    console.error("帯替えの控えに失敗（再送で控え直す）:", message.id, (err as Error)?.message ?? err);
    return true;
  }
}

/**
 * 帯替えとして扱うイベントを1つ、予約を取って最後まで扱う。
 * 戻り値：再送が要るか
 */
async function handleObiText(
  event: ObiLineEvent,
  entry: Exclude<ReturnType<typeof classifyObiEntry>, { kind: "not-obi" }>,
  deps: ObiEventDeps
): Promise<boolean> {
  const message = event.message!;
  const ev = await deps.events.reserve(message.id);
  if (!ev.proceed) {
    // 処理中なら再送で引き継げるよう 503。済みなら何もしない
    if (!ev.inProgress) console.log("処理済みのイベントをスキップ:", message.id);
    return Boolean(ev.inProgress);
  }

  const replyToken = event.replyToken ?? "";
  let committed = false;
  let retry = false;
  try {
    if (entry.kind === "stopped" || entry.kind === "forbidden") {
      await deliverReply(entry.kind === "stopped" ? OBI_MESSAGES.stopped : OBI_MESSAGES.forbidden, {
        reply: (t) => deps.reply(replyToken, t),
        push: (t) => deps.push(entry.groupId, t),
      });
    } else {
      const r = await runObiIntake(
        {
          requestMessageId: message.id,
          // 無ければ runObiIntake が「依頼の時刻が分かりません」で断る（今の時刻で代わりにしない）
          requestTimestamp: event.timestamp,
          groupId: entry.config.groupId,
          requestText: message.text ?? "",
          property: entry.property,
          // entry.assigneeName（「担当:」）は portal に渡さない（約束）
          startedAt: deps.startedAt,
          config: entry.config,
        },
        {
          store: deps.store,
          fetchImpl: deps.fetchImpl,
          lineToken: deps.lineToken,
          now: deps.now,
          reply: (t) => deps.reply(replyToken, t),
          push: (to, t) => deps.push(to, t),
          // 受付が確定し一覧も一致した。以後に例外が出ても再送させない（受付を二重にしない）
          onCommitted: () => {
            committed = true;
          },
        }
      );
      if (r.retry && !committed) retry = true;
    }
  } catch (err) {
    console.error("帯替えの処理中の例外:", message.id, (err as Error)?.message ?? err);
    // 確定前なら予約を外して再送でやり直す。確定後は二重にしないため再送させない
    if (!committed) retry = true;
    else console.error("受付は確定済みのため再送しない:", message.id);
  } finally {
    if (retry) {
      await deps.events.release(message.id).catch(() => undefined);
    } else {
      let recorded = false;
      for (let i = 0; i < 3 && !recorded; i++) {
        try {
          await deps.events.complete(message.id);
          recorded = true;
        } catch (e) {
          console.error(`イベント完了の記録に失敗（${i + 1}/3）:`, (e as Error)?.message ?? e);
        }
      }
    }
  }
  return retry;
}

/**
 * Webhook の1回分のイベントのうち、帯替えの分を先に扱う。
 * 返す rest を route.ts の今までのループに渡す。
 */
export async function dispatchObiEvents<E extends ObiLineEvent>(
  events: E[],
  deps: ObiEventDeps
): Promise<ObiDispatchResult<E>> {
  let needsRetry = false;
  const rest: E[] = [];
  for (const event of events) {
    const message = event.message;
    if (event.type !== "message" || !message) {
      rest.push(event);
      continue;
    }
    if (message.type === "file") {
      if (await recordIfObiPdf(event, deps)) needsRetry = true;
      rest.push(event); // 今までのファイルの扱い（handleIncomingFile）も行う
      continue;
    }
    if (message.type !== "text") {
      rest.push(event);
      continue;
    }
    const entry = classifyObiEntry(
      {
        sourceType: event.source.type,
        groupId: event.source.groupId,
        userId: event.source.userId,
        // 既存の新規タスクの入口と同じ判定（@MD NEXT秘書 へのメンション）
        mentionsBot: taskMentionState(message.mention?.mentionees, deps.botUserId).mentionsBot,
        text: stripMentionText(message),
      },
      deps.env
    );
    if (entry.kind === "not-obi") {
      rest.push(event);
      continue;
    }
    if (await handleObiText(event, entry, deps)) needsRetry = true;
  }
  return { needsRetry, rest };
}
```

- [ ] **Step 4: 通ることを確かめる**

  Run: `npx tsx tests/obi-webhook-event.test.ts`
  Expected: すべて `✅`、`🎉 全て通過`（「イベントの時刻が無いので控えない」「帯替えの控えに失敗（再送で控え直す）: … KV down」「受付は確定済みのため再送しない」などのログは、その場面を試しているので正しい）

- [ ] **Step 5: line の import に1つ足す（route.ts:2-8）**

  変更前：
```ts
  pushLineMessage,
  pushLineMessageWithMentions,
} from "@/lib/line";
```
  変更後：
```ts
  pushLineMessage,
  pushLineMessageWithMentions,
  replyLineMessageDetailed,
} from "@/lib/line";
```

- [ ] **Step 6: notion の import の後（route.ts:96 の `} from "@/lib/notion";` の次）に足す**

```ts
import { dispatchObiEvents, type ObiEventDeps } from "@/lib/obi/webhook-event";
import { getObiStore } from "@/lib/obi/memo";

// 帯替えの受付（LINE からの PDF の取り出し＋portal への送信）を1回の処理で終えるため60秒まで延ばす。
// 受付の締め切り（開始から55秒）はこれより短くしてある（src/lib/obi/intake.ts）。
export const maxDuration = 60;
```

- [ ] **Step 7: 型に2項目を足す（route.ts:200・207-212）**

  `LineMessage` の `fileName?` の次の行に：
```ts
  fileSize?: number; // ファイルメッセージの大きさ（バイト。type === "file"）
```
  `LineWebhookEvent` の `type: string;` の次の行に：
```ts
  timestamp?: number; // イベントの時刻（ms）。帯替えの PDF の選び方に使う（無ければ帯替えは扱わない）
```

- [ ] **Step 8: 本物の部品をまとめる関数と、締め切りの起点（route.ts:554-555）**

  変更前（`registerCustomer` の閉じ括弧の後）：
```ts
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
```
  変更後：
```ts
// 帯替えの振り分け（src/lib/obi/webhook-event.ts）に渡す本物の部品
function obiEventDeps(startedAt: number): ObiEventDeps {
  return {
    env: process.env,
    botUserId: BOT_USER_ID,
    startedAt,
    store: getObiStore(),
    events: { reserve: reserveEvent, complete: completeEvent, release: releaseEvent },
    fetchImpl: fetch,
    lineToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "",
    now: Date.now,
    reply: (replyToken, text) => replyLineMessageDetailed(replyToken, text),
    push: (to, text) => pushLineMessage(to, text).catch(() => false),
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 帯替えの受付の締め切りは、この時刻から数える
  const startedAt = Date.now();
  const rawBody = await req.text();
```

- [ ] **Step 9: 今までのループの前で振り分け、ループは `rest` を回す（route.ts:561-569）**

  変更前：
```ts
  const body: LineWebhookBody = JSON.parse(rawBody);

  // 処理を完了できなかったイベントがあれば非2xxを返してLINEに再送させる。
  // 200で返すとLINEは再送をやめるため、処理中の側が落ちていた場合に
  // 誰も引き継がず依頼が永久に消える。
  let needsRetry: boolean = false;

  for (const event of body.events) {
```
  変更後：
```ts
  const body: LineWebhookBody = JSON.parse(rawBody);

  // ⓪ 帯替え（設計 2026-10-09）。営業部の PDF を控え、帯替えの依頼はここで最後まで扱う。
  //    依頼は今までの流れ（メールの下書き・初動確認・タスク等）には渡さない（設計 8）。
  //    それ以外のイベントは元の順番のまま obi.rest に入り、下の今までのループで扱う。
  const obi = await dispatchObiEvents(body.events, obiEventDeps(startedAt));

  // 処理を完了できなかったイベントがあれば非2xxを返してLINEに再送させる。
  // 200で返すとLINEは再送をやめるため、処理中の側が落ちていた場合に
  // 誰も引き継がず依頼が永久に消える。
  // 帯替えの結果不明・一覧の不一致・控えの失敗も、ここから 503 になる。
  let needsRetry: boolean = obi.needsRetry;

  for (const event of obi.rest) {
```
  ループの中身（route.ts:570-1347）と、その後の 503／200 の返し方（route.ts:1349-1353）は変えない。

- [ ] **Step 10: route.ts の変更が上の5か所だけであることを確かめる**

```bash
git diff --stat -- src/app/api/webhook/route.ts
git diff -- src/app/api/webhook/route.ts
grep -n '^export const maxDuration = 60;$' src/app/api/webhook/route.ts
```
  Expected: `1 file changed, 35 insertions(+), 2 deletions(-)`（消したのは `let needsRetry: boolean = false;` と `for (const event of body.events) {` の2行だけ）。`grep` は1行出る。ループの中の行が差分に出ていたら戻す。

- [ ] **Step 11: `npm test` に足し、全体と型を確かめる**

```json
    "test": "tsx tests/clarify.reducer.test.ts && tsx tests/session.store.test.ts && tsx tests/apihealth.test.ts && tsx tests/clarify-target.test.ts && tsx tests/assignment.test.ts && tsx tests/task-intake.test.ts && tsx tests/obi-parse.test.ts && tsx tests/obi-config.test.ts && tsx tests/line-reply.test.ts && tsx tests/obi-memo.test.ts && tsx tests/obi-fetch.test.ts && tsx tests/obi-portal.test.ts && tsx tests/obi-intake.test.ts && tsx tests/obi-webhook-event.test.ts",
```
  Run: `npm test && npx tsc --noEmit --incremental false -p .`
  Expected: 各テストの最後が `🎉 全て通過`（終了コード 0）、tsc は何も出さない。出力をパイプで切らない。

- [ ] **Step 12: コミット**

```bash
git add src/lib/obi/webhook-event.ts tests/obi-webhook-event.test.ts src/app/api/webhook/route.ts package.json
git commit -m "$(cat <<'EOF'
feat: Webhook にグループからの帯替えをつなぐ（振り分けを切り出し、今までのループの前で扱う）

依頼は自分で予約を取り、一致する一覧が返ったときだけ済みにする。結果不明・不一致は予約を外して 503。
今までのループの中身は変えず、帯替えとして扱わなかったイベントだけを渡す。60秒まで延ばす。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: 環境変数の記載・ビルドの確認・ロールアウトの手順

**Files:**
- Modify: `CLAUDE.md:62-66`（環境変数の欄）

**Interfaces:**
- Consumes: Task 1 の確認結果
- Produces: 下村さんが承認・設定するための一覧（値は書かない）。`npm run build` が通ったという確認

- [ ] **Step 1: `CLAUDE.md` の環境変数の欄（66行の `GOOGLE_CALENDAR_ID` の行の後）に足す**

```markdown
（グループからの帯替え・2026-10-09）`LINE_GROUP_ID`（既存。営業部の groupId）/ `PORTAL_BASE_URL`（portal の https の起点。末尾の / は不要）/
`JOB_API_TOKEN`（portal の `x-job-token`。LINE秘書と同じ鍵）/ `JOB_ALLOWED_USER_IDS`（帯替えを依頼できる LINE userId。カンマ区切り）
— `LINE_GROUP_ID` が無い・不正なら帯替えは何もしない（どのグループでも返事も控えもしない）。それ以外が1つでも欠ける・形が違うと、営業部の依頼にだけ「止めています」と返す（他の機能は変わらない）。追加・変更は下村さんの承認後、値を画面に出さない方法で入れる。
LINE の Webhook の再送が無効だと、portal の結果不明・一覧の不一致のときに再送が来ない（結果は Discord・portal で確かめる）。
```

- [ ] **Step 2: 全体のテスト・型・ビルドを確かめる（このタスクの完了の条件）**

```bash
cd /Users/shimo/AI開発/apps/aisecretary/.worktrees/group-obi
npm test
npx tsc --noEmit --incremental false -p .
npm run build
git status --short
```
  Expected: `npm test` は各テストの最後が `🎉 全て通過`（終了コード 0）、tsc は何も出さない、`npm run build`（`build-checklist`＋`prisma generate`＋`next build`）は終了コード 0 で、`next build` の一覧に `ƒ /api/webhook` が出る。出力を `| tail` などで切らない。
  - `npm run build` が失敗したら、このタスクを完了にしない。Task 1 Step 3 の基準（変更前のビルド）と見比べ、この計画の変更が原因ならその場で直してから Step 2 をやり直す。変更前から失敗していたなら、直さずに止めて下村さんに報告する
  - `git status --short` に `src/lib/checklist.generated.ts` など、この計画で変えていないファイルが出たら `git checkout -- <そのファイル>` で戻す（ビルドの副産物をコミットしない）。`.next/` は `.gitignore` 済み

- [ ] **Step 3: コミット**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: グループからの帯替えの環境変数（PORTAL_BASE_URL・JOB_API_TOKEN・JOB_ALLOWED_USER_IDS）を記載する

値は書かない。追加は下村さんの承認後に行う。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: 最終報告に下の「本番に出す手順（ロールアウト）」をそのまま載せる（Claude は実行しない）**

  あわせて Obsidian の進行ログ（`~/AI開発/tools/notebooklm-obsidian/vault/20_research/2026-08-08_AI秘書_集約と完了機能_進行ログ.md`）に、この変更と判断（下の「判断した所」）を追記する。

---

## 本番に出す手順（ロールアウト）

約束（`2026-10-09-group-obi-contract.md`）の順番どおり **P1 → P4 → P3 → P2**。P2（この計画）は最後。各段は前の段の本番確認の後。`git push`・デプロイ・環境変数の設定は、どれも**実行の前に下村さんに確認を取る**。Claude は Vercel の書き込み系（`update_project`・`create_project_env`・`edit_project_env` 等）を使わない。

1. **P1（portal・Railway）**：`POST /api/jobs/intake`・`OBI_BUSY` の `busyJobNo`・claim の応答の `replyKind`／`replyGroupId` が本番に出て、P1 の計画の本番確認が済んでいること
2. **P4（閲覧ページ・Vercel `mdnext-doc-delivery`）**：`aud`／`g` の検査と分けて渡す処理が本番に出て、今までの秘書室あてのリンクが今どおり開けること
3. **P3（Mac の LINE秘書）**：本番ツリーへ fast-forward 済みで、秘書室あての納品が今どおり動くこと（グループあての納品は P2 が動くまで起きない）
4. **P2 の前の手作業の確認（下村さん）**：
   - Vercel の `aisecretary` で関数の Max Duration に **60 秒**を指定できること（Task 1 Step 1 の結果。できなければデプロイしない）
   - LINE Developers のチャネル「MD NEXT秘書」の **Webhook の再送**が有効か（Task 1 Step 2 の結果。無効でも出せるが、結果不明・一覧の不一致のときは再送が来ず、Discord・portal で確かめることになる）
   - Vercel の `aisecretary` に `LINE_GROUP_ID` が営業部の groupId で入っていること（値は画面に出さずに確かめる。入っていなければ帯替えは何もしない）
5. **P2 のコードのデプロイ**：P1・P4・P3 の本番確認が済んでから、下村さんの承認を得て `feat/group-obi` を本番の流れ（`integration/email-and-media` 側）へ取り込み、Vercel にデプロイする。この時点では `PORTAL_BASE_URL`・`JOB_API_TOKEN`・`JOB_ALLOWED_USER_IDS` が無いので、帯替えは営業部の依頼にだけ「止めています」と返し、PDF も控えない。今までの機能（タスク・メール・画像・ファイル）が今どおり動くことを確かめる
6. **環境変数（一番最後・下村さんの承認後）**：`PORTAL_BASE_URL`・`JOB_API_TOKEN`・`JOB_ALLOWED_USER_IDS`（下村さんの userId だけ）を、値を画面に出さない方法で Vercel の `aisecretary`（Production）に入れ、再デプロイする
7. **実地の確認**：本番の営業部のグループで、テスト用の図面（実在のお客様の資料は使わない）を1件貼り、下村さんが「@MD NEXT秘書 帯替え テスト」と送る → 「#J○ 受付しました」→ 完成リンクがグループに出る → 別の社員がリンクを開ける、まで確かめる
8. **戻し方**：おかしければ `JOB_ALLOWED_USER_IDS` を外して再デプロイする（営業部の依頼には「止めています」だけが返り、portal は呼ばれない）。コードを戻すのは下村さんの承認後

---

## 判断した所（設計に書かれていなかったもの）

| 所 | 判断 |
|---|---|
| 設計 8 の「メンションがあり」 | @MD NEXT秘書 へのメンション（`mentionsBot`）。社員へのメンションだけでは帯替えにしない |
| 物件名の無い依頼 | portal の `property` は必須なので、最初の PDF の名前（.pdf を除く）。それも空なら「帯替え」 |
| `requestedBy` | 「LINEグループ（営業部）」（人の名前は書かない。許可リストの人だけが依頼できる） |
| `LINE_GROUP_ID` が無い・不正 | 帯替えは何もしない（どのグループでも返事・控えなし）。営業部がどこか分からないため（裁定 2026-10-09） |
| `LINE_GROUP_ID` だけ正しく、他の設定が欠けている | 営業部の依頼の形にだけ「止めています」。他のグループ・依頼の形でない発言は今までどおり。PDF は控えない（裁定 2026-10-09） |
| 「担当:」 | 依頼文から読むが portal には送らない（約束：intake は `assigneeName` を受け付けない。裁定 2026-10-09） |
| イベントの時刻が無い | PDF は控えない。依頼は「依頼の時刻が分かりません」で断る。`Date.now()` で代わりにしない（裁定 2026-10-09） |
| 「送る前に失敗が確か」 | `ECONNREFUSED`・`ENOTFOUND`・`EAI_AGAIN` だけ。結果不明の後の「つながらない」は不明のまま |
| portal の呼び直し | 1回の Webhook で最大2回（最初＋1回）。締め切りに余裕があっても3回目は呼ばない（裁定 2026-10-09） |
| 依頼と同じ時刻の PDF | 時刻が同じでも message.id が依頼より小さければ使う。30分ちょうど前も使う |
| 控えを消す基準 | 新しく足した PDF の時刻から1時間より前（30分の窓より長く持ち、LINE の再送でも同じ PDF を選べるように） |
| PDF の控えの失敗 | 今までの流れ（`handleIncomingFile`）は止めず、503 で再送を待つ（控えは予約より前なので再送で控え直せる） |
| LINE からの取り出しの大きさ | 本文を少しずつ読み、読んだ合計が 25,000,000 バイトを超えた時点でやめる。Content-Length は近道にだけ使う（裁定 2026-10-09） |
| 一覧の照合 | 件数と sha256 の集合（同じ sha256 の大きさも）。順番では比べない（約束） |
| 受付番号は返ったが一覧が合わない | 済みにしない（`onCommitted` を呼ばない・`completeEvent` を呼ばず予約を外して 503）。「受付を確かめられませんでした」を NX で1回だけ。受付の返事は出さない（裁定 2026-10-09）。再送でも合わなければ同じ（返事は出ない）。LINE の再送の回数が尽きたら止まる |
| portal の `INTAKE_MISMATCH`（409） | 返事は「受付を確かめられませんでした」。portal がはっきり断ったのでイベントは済みにする |
| portal を一度も呼べなかった（取り出しで時間を使い切った） | portal に受付は無いので「時間がかかりました」で断る（結果不明にしない） |
| 受付の確定の後に NX が KV の障害で置けない | 返事も push も出さずにログだけ。再送もさせない（二重を避ける。受付は portal・Discord で見える）（裁定 2026-10-09） |
| Webhook の振り分け | 帯替えの分を `dispatchObiEvents` に切り出し、今までのループの前で呼ぶ。今までのループの中身は変えない。1回分に混ざったときは帯替えの依頼が先、他は元の順番のまま |
| 許可リスト外・止めていますの返事 | 依頼と同じく予約を取り、済みにする（LINE の再送で二重に返さない） |
| `replyWithPushFallback` | 使う所が無くなったので足さない（`deliverReply` に reply／push を渡す） |
| Codex の指摘 d（Drive の Range 応答の確認） | P4（閲覧ページ）の範囲。この計画には該当なし |

## Self-Review

**1. 設計の各項目と、受け持つタスク**

| 設計 | 内容 | タスク |
|---|---|---|
| 1 | 依頼は下村さんだけ | 3（`JOB_ALLOWED_USER_IDS`）・10（値は下村さんの userId だけを入れる手順） |
| 2 | 30分以内・誰が貼ったものでも | 5（`selectObiPdfs`。貼った人で絞らない） |
| 3 | MD NEXT秘書がその場で portal へ | 8・9 |
| 4 | 返事はグループに（秘書室の控えは P3） | 8（reply／push 先はグループ） |
| 5 | グループのリンクは一員なら開ける | P3・P4 の範囲（P2 は `replyKind=line-group`・`replyGroupId` を送る：7） |
| 6 | 入口の固定・ID の形・設定不足で停止・許可外への返事 | 3・9（`LINE_GROUP_ID` の有無で分ける裁定を含む） |
| 7 | 依頼の形・共通テストデータ | 2・3（表の置き場は冒頭の「P3 への受け渡し」） |
| 8 | メール下書きより先（先頭が依頼語＋メンションのときだけ） | 3・9（`obi-webhook-event` で、依頼は今までの流れに渡らない・「送信」は渡る、を確かめる） |
| 9 | PDF の控え（.pdf・中身・sorted set＋hash・zadd・古いものの削除・1時間・21件以上は断る・並び） | 5・9（時刻が無いものは控えない） |
| 10 | 同期・maxDuration 60・25,000,000 バイト・55秒の配分 | 1（プランの確認）・5・6（少しずつ読んで上限で止める）・8・9 |
| 11 | 全部取れたときだけ・`%PDF-`・sha256 で1つに | 6・8 |
| 12 | portal の受付を1回の呼び出しに | 7（P2 側の呼び出し。`assigneeName` を送らない。portal の中身は P1） |
| 13 | 済みの境目（一覧が一致した時点） | 8（`inputsMatch` が真のときだけ `onCommitted`）・9（不一致は `completeEvent` を呼ばない） |
| 14 | reply → はっきり失敗のときだけ push・不明は送り直さない | 4・8 |
| 14の2 | 結果不明・同じ内容で1回呼び直す・NX で1回・5xx で再送待ち・再送の設定の確認 | 1・8（最大2回）・9（`needsRetry` → 503）・10（ロールアウト 4） |
| 15 | `busyJobNo` を返事に | 7・8 |
| 16〜19 | replyKind の記録・宛先ごとの納品・リンクの印・分けて渡す | P1・P3・P4 の範囲（P2 は 16 の `replyKind`・`replyGroupId` を送るだけ） |
| 影響する所 | `source.type` を使う（振り分けの中で読む）・file を控えに・`line.ts` の3つの結果・環境変数・40文字 | 3・4・9・10 |
| うまくいかないときの表 | 全行 | 3（設定不足・許可外）・8（それ以外）・9（返事の出し方と済み／再送）。「個別トーク・他のグループ」は 3 の not-obi |
| 確かめ方（aisecretary） | 入口・依頼の形・メール優先・控え・取得失敗・portal の各エラー・reply の3つ・済みの境目・途中で止まる場面 | 2〜9 のテスト |

Codex の指摘：a → Task 5（`zremrangebyscore`＋`hdel`、テストで呼ぶ順番を固定）／b → Task 5（期限24時間）・Task 8（NX 直後・reply の途中・400→push の途中・不明・確定後の NX の例外のテスト、落ちる1通は受け入れると明記）／c → Task 9（`dispatchObiEvents` が結果不明・不一致で予約を外し `needsRetry`、route.ts はそれを 503 に）／d → 該当なし（P4）。

2回目のレビューの裁定（2026-10-09）：1 済みの境目は一覧の一致の後（Task 8・9）／2 portal は最大2回（Task 8）／3 `LINE_GROUP_ID` の有無で分ける（Task 3・9）／4 時刻が無ければ控えず受付けない（Task 8・9）／5 `assigneeName` を送らない（Task 7・8・9）／6 共通テストデータの置き場（冒頭）／7 少しずつ読んで上限で止める（Task 6）／8 文字列の順番の試験をやめ、振り分けを切り出して偽物で試す（Task 9）／9 確定後の NX の例外（Task 8・9）／10 パイプを付けない・`npm run build` を必須に（Global Constraints・Task 1・10）／11 ロールアウトの手順（末尾）。

**2. 書き残しの確認**：各タスクのコードは全文。「TBD」「後で」「Task N と同じ」は無い。手作業（Task 1・10・ロールアウト）は Claude が実行しないものとして手順を書いた。

**3. 名前と型の突き合わせ**：`ObiConfig`・`ObiEnv`・`classifyObiEntry`・`shouldRecordObiPdf`（3）→ 8・9／`ReplyOutcome`・`deliverReply`・`replyLineMessageDetailed`（4）→ 8・9／`ObiStore`・`ObiPdfRecord`・`selectObiPdfs`・`recordObiPdf`・`getObiStore`（5）→ 6・8・9／`FetchedPdf`・`fetchObiPdfs`・`dedupeBySha256`（6）→ 7・8／`IntakeRequest`・`IntakeOutcome`・`postIntake`・`inputsMatch`（7）→ 8／`runObiIntake`・`OBI_MESSAGES`（8）→ 9／`dispatchObiEvents`・`ObiEventDeps`（9）→ route.ts。このコードは計画を書くときに scratchpad の写しで `npm test`（全テスト）・`npx tsc --noEmit --incremental false -p .`・`next build` を通して確かめた（2026-10-09。写しでは `prisma generate` は本体の node_modules を書き換えるので省いた。本番の手順では Task 10 Step 2 の `npm run build` で通す）。
