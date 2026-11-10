# B2 査定書の下書き（aisecretary 側）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 案件カードの［査定書を作る］から reins-report に `satei` の依頼を作り、査定係からの通知を下村さんの個人 LINE にカード（［下書きを見る］［OK］［差し戻し］）で届け、OK・差し戻し・差し戻し理由を reins-report に返せるようにする。

**Architecture:** 判断・文面・カードは純関数の `src/lib/satei-*.ts`、本物の Notion・portal・LINE・KV は `src/lib/satei-wire.ts` に置く（task-buttons と同じ「deps を差し替えられる」形）。postback は既存の入口 `handleTaskPostbackEvent` の先頭に1つ分岐を足し、差し戻し理由は webhook の1対1の文字メッセージの流れに1か所だけ足す。査定係からの通知は新しい機械用の受け口 `POST /api/satei/notify`（`x-satei-token`）で受ける。

**Tech Stack:** Next.js 14 / TypeScript strict / @notionhq/client / @vercel/kv / LINE Messaging API（Flex・push の `X-Line-Retry-Key`）/ node:crypto。テストは `tests/*.test.ts` を tsx で、自前の `ok()`／`fail` 方式。

**Spec:** `docs/superpowers/specs/2026-11-11-b2-satei-draft-design.md`（設計）と `docs/superpowers/specs/2026-11-11-b2-satei-contract.md`（受け渡しの正本。第3節がこのリポジトリで作るもの全部、第2節は呼ぶ側として intake・decide・reason を使う。**第6節＝改訂 v2 が第1〜5節より優先**。この計画で効くのは 6-1・6-3・6-10・6-11・6-12）。実装者は両方を読むこと。

## Global Constraints

- スイッチ：`TASK_SATEI=1`（既定 off）、`TASK_SATEI_USER_IDS`（カンマ区切り。先頭が通知先＝下村さん）。**off なら今の動きは1バイトも変わらない**（案件カードの JSON・既存の postback・webhook の流れ・KV の読み書き・ログ）。
- `satei` のボタン（`v1|sa|`・`v1|so|`・`v1|sr|`）は**すべて** `userId ∈ TASK_SATEI_USER_IDS` を確かめる。タスクの「担当者・依頼者も押せる」決まりは使わない。違えば「いまは下村さんだけが使えます」。off のときは「いまは止めています」だけ返して何もしない。
- postback の data（契約 第3節そのまま）：案件カード `v1|sa|<dealId>`（ラベル「査定書を作る」、displayText「（ボタン）査定書を作る」）、個人カード OK `v1|so|<no>|<generation>|<sha256>`、差し戻し `v1|sr|<no>|<generation>|<sha256>`。［下書きを見る］は uri `https://drive.google.com/file/d/<driveFileId>/view`。data は300字以内。
- 二度押しは既存の `pb:<webhookEventId>` の予約（`reserveEvent`／`completeEvent`）に乗る。
- 差し戻し理由：KV `satei:reason:<userId>` = `{ no }`（30分）。その人の次の1対1の文字メッセージだけを reason API に送る（200字まで）。**印は消さずに reason を呼び、成功してから消す**（GETDEL は使わない。契約 6-11）。印の値は `{ no, token }`（token は UUID）で、消すのは「今の値が読んだときと同じ token」のときだけを1回で（Upstash の EVAL）。応答待ちのあいだに別の差し戻しが書き換えた印は消さない。印を消すのは記録できたときと portal が**実際に 4xx を返したとき**だけ。設定不足（status 0）・5xx・結果不明・例外は「記録できませんでした。もう一度送ってください」と返して印は残す。
- 差し戻しのあと portal は「差し戻し」のまま理由を待つ（契約 6-10）。intake が `SATEI_AWAITING_REASON` で断ったら「差し戻しの理由を待っています（理由を返信するか、30分後に押し直してください）」。
- 通知の受け口：`POST /api/satei/notify`、ヘッダ `x-satei-token` = HMAC-SHA256(JOB_API_TOKEN, "satei-notify") の小文字 hex を `timingSafeEqualStr` で照合。`X-Line-Retry-Key` = `uuidv5(no + ":" + kind + ":" + generation)`（名前空間はコードに固定）。LINE が 200 → `sent`、409 → `sent`、それ以外・例外 → `unknown`。**TASK_SATEI off・通知先なし → 送らずに `deferred`**（契約 6-12。portal は回数を増やさない）。出力 `{result}`。
- フォルダの照合の受け口：`POST /api/satei/folder-check`（同じ `x-satei-token`）`{no, dealId, folderId}` → Notion の `Driveフォルダ` を読み `{match:true|false}`。読めない・時間切れは `503`（契約 6-3）。
- **依存パッケージを増やさない**（uuid パッケージは使わず node:crypto で uuidv5 を書く）。
- 既存関数の動きを変えない（`line.ts` は関数を足すだけ。`obi/config.ts` は `parsePortalBaseUrl` に `export` を付けるだけ）。
- ログに出すのは操作名・J番号・kind・結果の符号・件数だけ。案件名・userId・本文・Drive ID・Notion ID は出さない。
- CRM_案件・CRM_物件 は読むだけ（書かない）。
- `.env.local` の中身を読まない・画面に出さない（変数名だけならよい）。Google Drive（~/Library/CloudStorage）は触らない。
- テストは外部への通信0回（fetch・Notion を失敗させる仕掛けを入れる）。新しいテストは package.json の `"test"` の末尾に `&& tsx tests/xxx.test.ts` で足す。
- コミット：`type: 日本語で変更内容` ＋本文に理由1〜3行＋ `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。push しない。
- **本番の env 追加・Vercel への deploy はこの計画に入れない**（下村さんの承認後に別途）。

## ファイルの地図

| ファイル | 役割 | 新規/変更 |
|---|---|---|
| `src/lib/satei-data.ts` | スイッチ・押せる人・通知先・postback data の読み書き・理由の印の鍵 | 新規 |
| `src/lib/satei-deal.ts` | Notion の案件ページ・物件ページを読む純関数、Drive フォルダ ID の取り出し、作れるかの判定 | 新規 |
| `src/lib/satei-portal.ts` | reins-report の intake／decide／reason を呼ぶ（fetch は差し替え） | 新規 |
| `src/lib/satei-text.ts` | 返事の文面・通知の文面・下書きカード | 新規 |
| `src/lib/satei-notify.ts` | 通知の受け口の合言葉・uuidv5・retry key・入力の検査・push 結果の分け方 | 新規 |
| `src/lib/satei-actions.ts` | postback（sa/so/sr）の処理と、差し戻し理由の取り込み（deps 差し替え） | 新規 |
| `src/lib/satei-wire.ts` | 本物の Notion・portal・LINE・KV・予約をつなぐ | 新規 |
| `src/app/api/satei/notify/route.ts` | 機械用の受け口 | 新規 |
| `src/lib/satei-folder-check.ts` | 保存直前のフォルダ照合の受け口の中身（契約 6-3） | 新規 |
| `src/app/api/satei/folder-check/route.ts` | 機械用の受け口（フォルダ照合） | 新規 |
| `src/lib/deal-card.ts` | `dealBubble` に［査定書を作る］（TASK_SATEI=1 のときだけ） | 変更 |
| `src/lib/task-buttons-wire.ts` | postback の入口の先頭で satei の data を振り分け | 変更 |
| `src/lib/line.ts` | retry key を渡せる push 関数 `pushMessagesWithRetryKey` を足す | 変更 |
| `src/lib/obi/config.ts` | `parsePortalBaseUrl` を export | 変更 |
| `src/app/api/webhook/route.ts` | 1対1の文字メッセージで差し戻し理由を受ける（1か所） | 変更 |
| `CLAUDE.md` | B2 の節（スイッチ・ファイル・ログの形） | 変更 |
| `tests/satei-*.test.ts` | 下の各タスク | 新規 |

実物を見て分かった注意点（全タスク共通）：
- `buildDealPage` は `shown.map(dealBubble)` で呼ぶので、**`dealBubble` に引数を足してはいけない**（map の index が入る）。スイッチは関数の中で `sateiActive()` を読む。
- 既存の postback の振り分け（`task-buttons-wire.ts:331`）は先頭で `buttonsActive()` を見て「止めています」を返す。satei は TASK_BUTTONS と別のスイッチなので、その**前**に振り分ける。`v1|sa|`・`v1|so|`・`v1|sr|` は今まで一度も出していない data なので、既存の動きは変わらない（`parseButtonData`・`parseMenuData`・`parseDealData`・`parseCandidateData` はどれも読まない。Task 2 のテストで固定）。
- webhook は postback も1対1の文字も、先に `checkSecretarySource` を通る。下村さんの userId が `SECRETARY_ALLOWED_USER_IDS`（空なら `TASK_BUTTONS_ADMIN_IDS`）に無いと、個人カードの［OK］［差し戻し］と理由の返信は読み飛ばされる（本番の設定のときに確かめる。この計画ではコードを変えない）。
- `src/middleware.ts` の matcher に `/api/satei` は入っていない（入れない。入れると査定係の通知・フォルダ照合が 401 になる）。
- portal が「差し戻し待ち」で intake を断るときの code は、reins-report の計画では `SATEI_AWAITING_REASON` の予定。Task 5 に入る前に reins-report の計画（または実装）でその名前を確かめ、違えば `SATEI_CODE_AWAITING_REASON` の値だけを合わせる。
- KV は読み出しで数字だけの文字列が数に戻る（CLAUDE.md の候補の節）。理由の印は `{ no }` の形で置く。
- Notion の client（@notionhq/client ^2.2）は Notion-Version 2022-06-28 なので、ページの `parent` は `{ type: "database_id", database_id }`。Task 1 で実物を確かめる。

---

### Task 1: worktree を作り、Notion の読み取りを確かめる

**Files:**
- Create（git 管理外・最後に消す）：`tmp/satei-check-notion.ts`

**Interfaces:**
- Consumes：なし
- Produces：worktree `.worktrees/b2-satei`（ブランチ `feat/b2-satei`）。Notion の確認結果（CRM_物件 が読めるか・`parent` の型・欄の型）

- [ ] **Step 1: worktree を切る**

```bash
cd /Users/shimo/AI開発/apps/aisecretary
git status --short          # 何も出ないこと（出たら止めて下村さんに聞く）
git check-ignore -v .worktrees   # .git/info/exclude で除外されていること
git worktree add .worktrees/b2-satei -b feat/b2-satei integration/email-and-media
cd .worktrees/b2-satei
npm ci
npm test                    # 今の状態で全部通る（基準。最後の行が「すべて成功」系で終わり、exit 0）
npx tsc --noEmit            # エラー0
```

- [ ] **Step 2: Notion の確かめ方の小さな台本を書く**（`tmp/` は .gitignore 済み。値・ID・案件名は出さない）

`tmp/satei-check-notion.ts`：

```ts
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.CRM_NOTION_TOKEN ?? process.env.NOTION_API_KEY });
const db = process.env.CRM_DEALS_DB_ID;

(async () => {
  console.log("使う鍵:", process.env.CRM_NOTION_TOKEN ? "CRM_NOTION_TOKEN" : process.env.NOTION_API_KEY ? "NOTION_API_KEY" : "無し");
  if (!db) {
    console.log("CRM_DEALS_DB_ID 未設定");
    process.exit(2);
  }
  let res;
  try {
    res = await notion.databases.query({
      database_id: db,
      page_size: 5,
      filter: { property: "物件", relation: { is_not_empty: true } },
    });
  } catch (e) {
    console.log("CRM_案件の読み取り: NG", (e as { code?: string }).code ?? (e as Error).name);
    process.exit(3);
  }
  console.log("CRM_案件の読み取り: OK（物件のある案件", res.results.length, "件）");
  const page = res.results[0] as unknown as Record<string, any> | undefined;
  if (!page) return console.log("物件のある案件が0件（物件の確かめは手で）");
  const p = page.properties ?? {};
  console.log("parent の型:", page.parent?.type);
  console.log(
    "欄の型:",
    ["案件名", "ID", "Driveフォルダ", "フォルダ状態", "物件"].map((k) => `${k}=${p[k]?.type ?? "無し"}`).join(" "),
  );
  const url = p["Driveフォルダ"]?.url;
  console.log("Driveフォルダの形:", url ? (/\/folders\/[A-Za-z0-9_-]{10,}/.test(url) ? "folders の URL" : "別の形") : "空");
  const rel = p["物件"]?.relation?.[0]?.id;
  try {
    const prop = (await notion.pages.retrieve({ page_id: rel })) as unknown as Record<string, any>;
    const k = prop.properties?.["種別"];
    console.log("CRM_物件の読み取り: OK 種別の型=", k?.type ?? "無し", "値=", k?.select?.name ?? "空");
  } catch (e) {
    console.log("CRM_物件の読み取り: NG", (e as { code?: string }).code ?? (e as Error).name);
  }
})();
```

- [ ] **Step 3: 走らせる**（`.env.local` は node に渡すだけで中身は見ない）

```bash
cd /Users/shimo/AI開発/apps/aisecretary/.worktrees/b2-satei
node --env-file=/Users/shimo/AI開発/apps/aisecretary/.env.local --import tsx tmp/satei-check-notion.ts
```

この実行が権限で止められたら、下村さんに「ターミナルで上の1行を実行して出力を貼ってください（値・ID は出ません）」と頼む。

期待：`parent の型: database_id`、`案件名=title ID=unique_id Driveフォルダ=url フォルダ状態=select 物件=relation`、`CRM_物件の読み取り: OK 種別の型= select`。

- [ ] **Step 4: 結果で分ける**
  - `CRM_案件の読み取り: NG` → 止めて下村さんに聞く（`CRM_DEALS_DB_ID`・連携の共有）。
  - `CRM_物件の読み取り: NG object_not_found` → 下村さんに「Notion の CRM_物件 を、CRM_NOTION_TOKEN の連携（無ければ本体の連携）に共有してください（CRM_物件 のページ右上 … → 接続 → 連携を追加）」と頼む。コードの実装（Task 2 以降）は進めてよいが、**共有が済むまで本番で on にしない**ことを HANDOFF.md と vault の進行ログに書く。
  - `parent の型` が `database_id` でない → Task 4 の `readSateiDealPage` の `parentDbId` の読み方をその型に合わせてから進める（下村さんに報告）。
  - `種別の型` が `select` でない → 止めて聞く。

- [ ] **Step 5: 台本を消す**（`tsc` の対象 `**/*.ts` に入ってしまうため）

```bash
rm tmp/satei-check-notion.ts
git status --short   # 何も出ない
```

（このタスクはコミットしない）

---

### Task 2: スイッチ・押せる人・ボタンの data（satei-data.ts）

**Files:**
- Create: `src/lib/satei-data.ts`
- Test: `tests/satei-data.test.ts`
- Modify: `package.json`（test に足す）

**Interfaces:**
- Consumes：`PAGE_ID_RE`（`src/lib/task-buttons.ts`）、`parseAllowedUserIds`（`src/lib/webhook-source.ts`）
- Produces：
  - `type SateiEnv = Record<string, string | undefined>`
  - `sateiActive(env?: SateiEnv): boolean`
  - `sateiUserIds(env?: SateiEnv): string[]`
  - `isSateiUser(userId: string | null | undefined, env?: SateiEnv): boolean`
  - `sateiNotifyTarget(env?: SateiEnv): string | null`
  - `type SateiDecisionOp = "so" | "sr"`
  - `type SateiAction = { op: "sa"; dealId: string } | { op: SateiDecisionOp; no: number; generation: number; sha256: string }`
  - `encodeSateiStart(dealId: string): string`
  - `encodeSateiDecision(op: SateiDecisionOp, no: number, generation: number, sha256: string): string`
  - `parseSateiData(data: string): SateiAction | null`
  - `sateiReasonKey(userId: string): string`、`SATEI_REASON_TTL = 1800`、`SATEI_REASON_MAX = 200`

- [ ] **Step 1: 失敗するテストを書く** `tests/satei-data.test.ts`

```ts
/**
 * B2 査定書：スイッチ・押せる人・postback の data（satei-data.ts）。外部へ通信しない。
 */
import {
  encodeSateiDecision,
  encodeSateiStart,
  isSateiUser,
  parseSateiData,
  sateiActive,
  sateiNotifyTarget,
  sateiReasonKey,
  sateiUserIds,
  SATEI_REASON_MAX,
  SATEI_REASON_TTL,
} from "../src/lib/satei-data";
import { parseButtonData, parseMenuData } from "../src/lib/task-buttons";
import { parseDealData } from "../src/lib/deal-card";
import { parseCandidateData } from "../src/lib/candidate-card";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};
globalThis.fetch = (async () => {
  throw new Error("このテストで外部へ通信してはいけない");
}) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const DEAL = "0123abcd-0123-4567-89ab-0123456789ab";
const SHA = "a".repeat(64);

ok("既定は off", !sateiActive({}));
ok("TASK_SATEI=1 で on", sateiActive({ TASK_SATEI: "1" }));
ok("1 以外は off", !sateiActive({ TASK_SATEI: "true" }) && !sateiActive({ TASK_SATEI: "0" }));
ok(
  "押せる人は空白・空要素・形の違う値を捨てて読む",
  JSON.stringify(sateiUserIds({ TASK_SATEI_USER_IDS: ` ${SHIMO}, x ,,${STAFF}` })) ===
    JSON.stringify([SHIMO, STAFF]),
);
ok("通知先は先頭の人", sateiNotifyTarget({ TASK_SATEI_USER_IDS: `${SHIMO},${STAFF}` }) === SHIMO);
ok("未設定なら通知先なし", sateiNotifyTarget({}) === null);
ok(
  "入っている人だけ",
  isSateiUser(SHIMO, { TASK_SATEI_USER_IDS: SHIMO }) &&
    !isSateiUser(STAFF, { TASK_SATEI_USER_IDS: SHIMO }) &&
    !isSateiUser(undefined, { TASK_SATEI_USER_IDS: SHIMO }) &&
    !isSateiUser(SHIMO, {}),
);

const sa = encodeSateiStart(DEAL);
ok("sa の data", sa === `v1|sa|${DEAL}`);
ok("sa の往復", JSON.stringify(parseSateiData(sa)) === JSON.stringify({ op: "sa", dealId: DEAL }));
const so = encodeSateiDecision("so", 12, 3, SHA);
ok("so の data", so === `v1|so|12|3|${SHA}`);
ok(
  "so の往復",
  JSON.stringify(parseSateiData(so)) === JSON.stringify({ op: "so", no: 12, generation: 3, sha256: SHA }),
);
const sr = encodeSateiDecision("sr", 7, 1, SHA);
ok(
  "sr の往復",
  JSON.stringify(parseSateiData(sr)) === JSON.stringify({ op: "sr", no: 7, generation: 1, sha256: SHA }),
);
ok("いちばん長い data も 300 字以内", encodeSateiDecision("sr", 999999999, 999999, SHA).length <= 300);
for (const bad of [
  "v1|sa|xyz",
  `v1|sa|${DEAL}|1`,
  `v1|so|0|1|${SHA}`,
  `v1|so|012|1|${SHA}`,
  `v1|so|12|0|${SHA}`,
  `v1|so|12|1|${"A".repeat(64)}`,
  `v1|so|12|1|${"a".repeat(63)}`,
  "v1|so|12|1",
  `v1|sx|12|1|${SHA}`,
  `v2|so|12|1|${SHA}`,
  "",
]) {
  ok(`形の違う data は読まない: ${bad.slice(0, 16)}`, parseSateiData(bad) === null);
}
for (const d of [sa, so, sr]) {
  ok(
    `既存の読み方は ${d.slice(0, 5)} を拾わない`,
    parseButtonData(d) === null &&
      parseMenuData(d) === null &&
      parseDealData(d) === null &&
      parseCandidateData(d) === null,
  );
}
ok("理由の印の鍵", sateiReasonKey(SHIMO) === `satei:reason:${SHIMO}`);
ok("理由の印は30分・200字", SATEI_REASON_TTL === 1800 && SATEI_REASON_MAX === 200);

if (fail > 0) {
  console.log(`\n${fail} 件失敗`);
  process.exit(1);
}
console.log("\nすべて成功");
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx tests/satei-data.test.ts`
Expected: FAIL（`Cannot find module '../src/lib/satei-data'`）

- [ ] **Step 3: 実装** `src/lib/satei-data.ts`

```ts
/**
 * B2 査定書の下書き（2026-11-11）：スイッチ・押せる人・通知先・postback の data。
 * 契約 docs/superpowers/specs/2026-11-11-b2-satei-contract.md 第3節。
 * - TASK_SATEI=1 のときだけ動く（既定 off）。押せるのは TASK_SATEI_USER_IDS の人だけ（先頭が通知先＝下村さん）。
 * - data：案件カード `v1|sa|<dealId>`、個人カード `v1|so|<no>|<generation>|<sha256>`・`v1|sr|…`。
 */
import { PAGE_ID_RE } from "./task-buttons";
import { parseAllowedUserIds } from "./webhook-source";

export type SateiEnv = Record<string, string | undefined>;

const USER_ID_RE = /^U[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const JOB_NO_RE = /^[1-9][0-9]{0,8}$/;
const GENERATION_RE = /^[1-9][0-9]{0,5}$/;
const DATA_MAX = 300;

export function sateiActive(env: SateiEnv = process.env): boolean {
  return env.TASK_SATEI === "1";
}

export function sateiUserIds(env: SateiEnv = process.env): string[] {
  return parseAllowedUserIds(env.TASK_SATEI_USER_IDS).filter((id) => USER_ID_RE.test(id));
}

export function isSateiUser(userId: string | null | undefined, env: SateiEnv = process.env): boolean {
  return typeof userId === "string" && sateiUserIds(env).includes(userId);
}

/** 個人あての通知先（TASK_SATEI_USER_IDS の先頭）。無ければ null */
export function sateiNotifyTarget(env: SateiEnv = process.env): string | null {
  return sateiUserIds(env)[0] ?? null;
}

export type SateiDecisionOp = "so" | "sr";
export type SateiAction =
  | { op: "sa"; dealId: string }
  | { op: SateiDecisionOp; no: number; generation: number; sha256: string };

export function encodeSateiStart(dealId: string): string {
  return `v1|sa|${dealId}`;
}

export function encodeSateiDecision(
  op: SateiDecisionOp,
  no: number,
  generation: number,
  sha256: string,
): string {
  return ["v1", op, String(no), String(generation), sha256].join("|");
}

/** satei のボタンの data を読む。形が違えば null（ほかのボタンの data は読まない） */
export function parseSateiData(data: string): SateiAction | null {
  if (!data || data.length > DATA_MAX) return null;
  const parts = data.split("|");
  if (parts[0] !== "v1") return null;
  if (parts[1] === "sa") {
    return parts.length === 3 && PAGE_ID_RE.test(parts[2]) ? { op: "sa", dealId: parts[2] } : null;
  }
  if ((parts[1] !== "so" && parts[1] !== "sr") || parts.length !== 5) return null;
  const [, op, no, generation, sha256] = parts;
  if (!JOB_NO_RE.test(no) || !GENERATION_RE.test(generation) || !SHA256_RE.test(sha256)) return null;
  return { op: op as SateiDecisionOp, no: Number(no), generation: Number(generation), sha256 };
}

/** ［差し戻し］のあと、次の1対1の文字を理由として受ける印（値は `{ no }`） */
export const sateiReasonKey = (userId: string): string => `satei:reason:${userId}`;
export const SATEI_REASON_TTL = 30 * 60;
export const SATEI_REASON_MAX = 200;
```

- [ ] **Step 4: 通ることを確かめ、test に足す**

```bash
npx tsx tests/satei-data.test.ts   # すべて成功
node -e 'const fs=require("fs");const f="package.json";const p=JSON.parse(fs.readFileSync(f,"utf8"));p.scripts.test+=" && tsx tests/satei-data.test.ts";fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
git diff package.json   # "test" の行の末尾だけが変わっていること（ほかの行が変わっていたら元に戻して手で足す）
npm test
```
Expected: 全部 PASS

- [ ] **Step 5: コミット**

```bash
git add src/lib/satei-data.ts tests/satei-data.test.ts package.json
git commit -m "feat: 査定書のスイッチとボタンの data を足す

B2 の TASK_SATEI・TASK_SATEI_USER_IDS と v1|sa|・v1|so|・v1|sr| の読み書き。
既存のボタンの読み方と重ならないことをテストで固定した。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 案件カードに［査定書を作る］（TASK_SATEI=1 のときだけ）

**Files:**
- Modify: `src/lib/deal-card.ts:17-34`（import）, `src/lib/deal-card.ts:211-228`（`dealBubble` の footer）
- Test: `tests/satei-deal-card.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes：`sateiActive()`・`encodeSateiStart(dealId)`（Task 2）
- Produces：`dealBubble(d: DealSummary)` の footer の3つ目のボタン（on のときだけ）。シグネチャは変えない

- [ ] **Step 1: 失敗するテストを書く** `tests/satei-deal-card.test.ts`

`OFF_JSON` と `OFF_PAGE_SHA` は、変更前のコード（integration/email-and-media の 5d34914）で取った値。

```ts
/**
 * B2 査定書：案件カードの［査定書を作る］。off のとき案件カードの JSON が今と1バイトも変わらないことを固定する。
 */
import { createHash } from "node:crypto";
import { buildDealPage, dealBubble, type DealSummary } from "../src/lib/deal-card";
import { parseSateiData } from "../src/lib/satei-data";
import { FLEX_JSON_MAX } from "../src/lib/task-menu";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};
globalThis.fetch = (async () => {
  throw new Error("このテストで外部へ通信してはいけない");
}) as typeof fetch;

const D: DealSummary = {
  id: "00000001-aaaa-bbbb-cccc-1234567890ab",
  name: "テスト案件",
  phase: "査定",
  count: 2,
  nearestDue: "2026-11-20",
};
const MANY: DealSummary[] = Array.from({ length: 12 }, (_, i) => ({
  ...D,
  id: `${String(i + 1).padStart(8, "0")}-aaaa-bbbb-cccc-1234567890ab`,
  name: `案件${i + 1}`,
}));
// 変更前のコードの出力（5d34914 で取得）
const OFF_JSON =
  '{"type":"bubble","body":{"type":"box","layout":"vertical","spacing":"sm","contents":[{"type":"text","text":"テスト案件","weight":"bold","size":"md","wrap":true},{"type":"box","layout":"baseline","spacing":"sm","contents":[{"type":"text","text":"フェーズ","size":"sm","color":"#888888","flex":3},{"type":"text","text":"査定","size":"sm","wrap":true,"flex":5}]},{"type":"box","layout":"baseline","spacing":"sm","contents":[{"type":"text","text":"近い期日","size":"sm","color":"#888888","flex":3},{"type":"text","text":"11月20日(金)","size":"sm","wrap":true,"flex":5}]},{"type":"box","layout":"baseline","spacing":"sm","contents":[{"type":"text","text":"残りタスク","size":"sm","color":"#888888","flex":3},{"type":"text","text":"2件","size":"sm","wrap":true,"flex":5}]}]},"footer":{"type":"box","layout":"vertical","spacing":"sm","contents":[{"type":"button","style":"primary","height":"sm","action":{"type":"postback","label":"タスクを見る","data":"v1|dt|00000001-aaaa-bbbb-cccc-1234567890ab","displayText":"（ボタン）この案件のタスクを見る"}},{"type":"button","style":"secondary","height":"sm","action":{"type":"postback","label":"タスクを足す","data":"v1|da|00000001-aaaa-bbbb-cccc-1234567890ab","displayText":"（ボタン）この案件にタスクを足す"}}]}}';
const OFF_PAGE_SHA = "f864f94a8cf41df751cb226c126dd198998483d9f9968194ce911fe0bb5d5b5e";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Btn = { type: string; style: string; action: { type: string; label: string; data: string; displayText: string } };
const footerOf = (b: unknown): Btn[] => (b as { footer: { contents: Btn[] } }).footer.contents;

for (const v of [undefined, "", "0", "true"]) {
  if (v === undefined) delete process.env.TASK_SATEI;
  else process.env.TASK_SATEI = v;
  ok(`off（TASK_SATEI=${v ?? "未設定"}）：案件カードの JSON は今と1バイトも同じ`, JSON.stringify(dealBubble(D)) === OFF_JSON);
  ok(
    `off（TASK_SATEI=${v ?? "未設定"}）：12件の一覧の JSON も今と同じ`,
    sha(JSON.stringify(buildDealPage(MANY, 0))) === OFF_PAGE_SHA,
  );
}

process.env.TASK_SATEI = "1";
const on = footerOf(dealBubble(D));
const off = footerOf(JSON.parse(OFF_JSON));
ok("on：ボタンは3つ", on.length === 3);
ok("on：前の2つは今と同じ", JSON.stringify(on.slice(0, 2)) === JSON.stringify(off));
ok("on：3つ目のラベル", on[2]?.action.label === "査定書を作る");
ok("on：3つ目の displayText", on[2]?.action.displayText === "（ボタン）査定書を作る");
ok("on：3つ目は postback・secondary", on[2]?.action.type === "postback" && on[2]?.style === "secondary");
ok("on：data は v1|sa|案件ID", on[2]?.action.data === `v1|sa|${D.id}`);
ok(
  "on：data は satei の読み方で読める",
  JSON.stringify(parseSateiData(on[2]?.action.data ?? "")) === JSON.stringify({ op: "sa", dealId: D.id }),
);
const page = buildDealPage(MANY, 0);
ok(
  "on：一覧の JSON は 30KB 未満",
  page.card !== undefined && Buffer.byteLength(JSON.stringify(page.card.contents), "utf8") < FLEX_JSON_MAX,
);
delete process.env.TASK_SATEI;

if (fail > 0) {
  console.log(`\n${fail} 件失敗`);
  process.exit(1);
}
console.log("\nすべて成功");
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx tests/satei-deal-card.test.ts`
Expected: off の行は PASS、`on：ボタンは3つ` 以下が FAIL

- [ ] **Step 3: 実装**（`src/lib/deal-card.ts`）

import に1行足す（`import type { DealRef } from "./task-record";` の下）：

```ts
import { encodeSateiStart, sateiActive } from "./satei-data";
```

`dealBubble` の footer の `contents` を次に替える（前の2つは1文字も変えない）：

```ts
      contents: [
        button(
          "タスクを見る",
          encodeDealData("dt", d.id),
          "（ボタン）この案件のタスクを見る",
          true,
        ),
        button(
          "タスクを足す",
          encodeDealData("da", d.id),
          "（ボタン）この案件にタスクを足す",
        ),
        // B2 査定書（TASK_SATEI=1 のときだけ。off なら配列は今と同じ2つ）
        ...(sateiActive()
          ? [button("査定書を作る", encodeSateiStart(d.id), "（ボタン）査定書を作る")]
          : []),
      ],
```

ファイル先頭のコメント（B1 Task 3 の説明）の最後に1行足す：

```ts
 * B2（2026-11-11）：TASK_SATEI=1 のときだけ［査定書を作る］（`v1|sa|案件ID`）を3つ目に足す（satei-data.ts）。
```

- [ ] **Step 4: 通ることを確かめ、test に足す**

```bash
npx tsx tests/satei-deal-card.test.ts   # すべて成功
npx tsx tests/deal-card.test.ts         # 既存も通る
node -e 'const fs=require("fs");const f="package.json";const p=JSON.parse(fs.readFileSync(f,"utf8"));p.scripts.test+=" && tsx tests/satei-deal-card.test.ts";fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
npm test
```

- [ ] **Step 5: コミット**

```bash
git add src/lib/deal-card.ts tests/satei-deal-card.test.ts package.json
git commit -m "feat: 案件カードに［査定書を作る］を足す（TASK_SATEI=1 のときだけ）

off のとき案件カードの JSON が今と1バイトも変わらないことを、変更前の出力と比べるテストで固定した。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 案件ページの読み方と「作れるか」の判定（satei-deal.ts）

**Files:**
- Create: `src/lib/satei-deal.ts`
- Test: `tests/satei-deal.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes：なし（Notion のページは `Record<string, unknown>` で受ける）
- Produces：
  - `interface SateiDeal { id: string; name: string; dealNo: number | null; folderId: string | null; propertyIds: string[]; gone: boolean; parentDbId: string | null }`（`id`・`parentDbId` はハイフンなし小文字32桁）
  - `normNotionId(id: string): string`
  - `folderIdFromUrl(url: unknown): string | null`
  - `readSateiDealPage(page: Record<string, unknown>): SateiDeal`
  - `readPropertyKind(page: Record<string, unknown>): string | null`
  - `SATEI_KIND = "マンション"`
  - `type SateiDealJudge = { ok: true; deal: { id: string; name: string; dealNo: number | null; folderId: string } } | { ok: false; reason: "not-found" | "not-mansion" | "no-folder" }`
  - `judgeSateiDeal(deal: SateiDeal | null, kind: string | null, dealsDbId: string): SateiDealJudge`

- [ ] **Step 1: 失敗するテストを書く** `tests/satei-deal.test.ts`

```ts
/**
 * B2 査定書：CRM_案件・CRM_物件 のページの読み方と、作れるかの判定（satei-deal.ts）。
 */
import {
  folderIdFromUrl,
  judgeSateiDeal,
  normNotionId,
  readPropertyKind,
  readSateiDealPage,
  SATEI_KIND,
  type SateiDeal,
} from "../src/lib/satei-deal";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};

const DB = "11111111-2222-3333-4444-555555555555";
const FOLDER = "1AbC_dEf-GhIjKlMnOp";
const P1 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const P2 = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
const page = (over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) => ({
  id: "0123ABCD-0123-4567-89ab-0123456789ab",
  archived: false,
  in_trash: false,
  parent: { type: "database_id", database_id: DB },
  properties: {
    案件名: { type: "title", title: [{ plain_text: "テスト" }, { plain_text: "マンション101" }] },
    ID: { type: "unique_id", unique_id: { prefix: "DEAL", number: 42 } },
    Driveフォルダ: { type: "url", url: `https://drive.google.com/drive/folders/${FOLDER}` },
    物件: { type: "relation", relation: [{ id: P1 }, { id: P2 }] },
    ...props,
  },
  ...over,
});

// ── Drive のフォルダ ID ──
ok("folders の URL", folderIdFromUrl(`https://drive.google.com/drive/folders/${FOLDER}`) === FOLDER);
ok("u/0 つき", folderIdFromUrl(`https://drive.google.com/drive/u/0/folders/${FOLDER}`) === FOLDER);
ok("?usp=sharing つき", folderIdFromUrl(`https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`) === FOLDER);
ok("末尾の / つき", folderIdFromUrl(`https://drive.google.com/drive/folders/${FOLDER}/`) === FOLDER);
ok("前後の空白は削る", folderIdFromUrl(`  https://drive.google.com/drive/folders/${FOLDER} `) === FOLDER);
for (const bad of [
  `http://drive.google.com/drive/folders/${FOLDER}`,
  `https://example.com/drive/folders/${FOLDER}`,
  `https://drive.google.com/file/d/${FOLDER}/view`,
  "https://drive.google.com/drive/folders/short",
  "",
  null,
  undefined,
  42,
]) {
  ok(`フォルダの URL でないものは null: ${String(bad).slice(0, 30)}`, folderIdFromUrl(bad) === null);
}

// ── 案件ページ ──
const d = readSateiDealPage(page());
ok("ID はハイフンなし小文字", d.id === "0123abcd0123456789ab0123456789ab");
ok("案件名はつなげる", d.name === "テストマンション101");
ok("案件番号", d.dealNo === 42);
ok("フォルダ ID", d.folderId === FOLDER);
ok("物件は relation の順", JSON.stringify(d.propertyIds) === JSON.stringify([P1, P2]));
ok("消えていない", d.gone === false);
ok("親の DB", d.parentDbId === normNotionId(DB));
ok("normNotionId", normNotionId("AB-cd") === "abcd");
ok("番号が無ければ null", readSateiDealPage(page({}, { ID: { type: "unique_id", unique_id: { number: null } } })).dealNo === null);
ok("フォルダ欄が空なら null", readSateiDealPage(page({}, { Driveフォルダ: { type: "url", url: null } })).folderId === null);
ok("物件が空なら []", readSateiDealPage(page({}, { 物件: { type: "relation", relation: [] } })).propertyIds.length === 0);
ok("アーカイブは gone", readSateiDealPage(page({ archived: true })).gone === true);
ok("ゴミ箱は gone", readSateiDealPage(page({ in_trash: true })).gone === true);
ok("親が DB でなければ null", readSateiDealPage(page({ parent: { type: "page_id", page_id: DB } })).parentDbId === null);
ok("欄が無くても落ちない", readSateiDealPage({ id: "x" }).name === "");

// ── 物件の種別 ──
ok("種別を読む", readPropertyKind({ properties: { 種別: { type: "select", select: { name: "マンション" } } } }) === "マンション");
ok("種別が空なら null", readPropertyKind({ properties: { 種別: { type: "select", select: null } } }) === null);
ok("種別の欄が無ければ null", readPropertyKind({ properties: {} }) === null);

// ── 判定 ──
const good: SateiDeal = d;
const j = judgeSateiDeal(good, SATEI_KIND, DB);
ok(
  "マンション＋フォルダあり → 作れる",
  j.ok === true &&
    JSON.stringify(j.deal) ===
      JSON.stringify({ id: good.id, name: good.name, dealNo: 42, folderId: FOLDER }),
);
ok("ページが無い → not-found", JSON.stringify(judgeSateiDeal(null, SATEI_KIND, DB)) === JSON.stringify({ ok: false, reason: "not-found" }));
ok("消えている → not-found", !judgeSateiDeal({ ...good, gone: true }, SATEI_KIND, DB).ok);
ok(
  "ほかの DB のページ → not-found",
  JSON.stringify(judgeSateiDeal(good, SATEI_KIND, "99999999-2222-3333-4444-555555555555")) ===
    JSON.stringify({ ok: false, reason: "not-found" }),
);
ok("戸建 → not-mansion", JSON.stringify(judgeSateiDeal(good, "戸建", DB)) === JSON.stringify({ ok: false, reason: "not-mansion" }));
ok("種別が分からない → not-mansion", JSON.stringify(judgeSateiDeal(good, null, DB)) === JSON.stringify({ ok: false, reason: "not-mansion" }));
ok(
  "フォルダ未設定 → no-folder",
  JSON.stringify(judgeSateiDeal({ ...good, folderId: null }, SATEI_KIND, DB)) ===
    JSON.stringify({ ok: false, reason: "no-folder" }),
);
ok(
  "種別の判定がフォルダより先",
  JSON.stringify(judgeSateiDeal({ ...good, folderId: null }, "土地", DB)) ===
    JSON.stringify({ ok: false, reason: "not-mansion" }),
);

if (fail > 0) {
  console.log(`\n${fail} 件失敗`);
  process.exit(1);
}
console.log("\nすべて成功");
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx tests/satei-deal.test.ts`
Expected: FAIL（`Cannot find module '../src/lib/satei-deal'`）

- [ ] **Step 3: 実装** `src/lib/satei-deal.ts`

```ts
/**
 * B2 査定書：CRM_案件 のページ（案件名・ID・Driveフォルダ・物件）と CRM_物件 の `種別` を読み、作れるかを決める。
 * 欄の名前は 2026-11-11 に確認済み（契約 第3節）。Notion への通信はしない（ページは satei-wire.ts が読む）。
 */
export interface SateiDeal {
  /** Notion のページ ID（ハイフンなし小文字32桁） */
  id: string;
  name: string;
  /** `ID`（unique_id）の数字。無ければ null */
  dealNo: number | null;
  /** `Driveフォルダ`（https://drive.google.com/drive/folders/<id>）の <id>。無い・形が違えば null */
  folderId: string | null;
  /** `物件`（relation → CRM_物件）のページ ID（並びのまま） */
  propertyIds: string[];
  /** アーカイブ・ゴミ箱 */
  gone: boolean;
  /** 親の DB の ID（ハイフンなし小文字）。DB の子でなければ null */
  parentDbId: string | null;
}

export const SATEI_KIND = "マンション";

export const normNotionId = (id: string): string => id.replace(/-/g, "").toLowerCase();

const FOLDER_PATH_RE = /\/folders\/([A-Za-z0-9_-]{10,200})\/?$/;

export function folderIdFromUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "drive.google.com") return null;
  const m = u.pathname.match(FOLDER_PATH_RE);
  return m ? m[1] : null;
}

type Props = Record<string, unknown>;
const propsOf = (page: Record<string, unknown>): Props =>
  (page.properties as Props | undefined) ?? {};

export function readSateiDealPage(page: Record<string, unknown>): SateiDeal {
  const p = propsOf(page);
  const title = (p["案件名"] as { title?: Array<{ plain_text?: string }> } | undefined)?.title ?? [];
  const n = (p["ID"] as { unique_id?: { number?: unknown } } | undefined)?.unique_id?.number;
  const url = (p["Driveフォルダ"] as { url?: unknown } | undefined)?.url;
  const rel = (p["物件"] as { relation?: Array<{ id?: unknown }> } | undefined)?.relation ?? [];
  const parent = page.parent as { type?: string; database_id?: unknown } | undefined;
  return {
    id: normNotionId(String(page.id ?? "")),
    name: title.map((t) => t.plain_text ?? "").join("").trim(),
    dealNo: typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null,
    folderId: folderIdFromUrl(url),
    propertyIds: rel.map((r) => r.id).filter((id): id is string => typeof id === "string"),
    gone: Boolean(page.archived || page.in_trash),
    parentDbId:
      parent?.type === "database_id" && typeof parent.database_id === "string"
        ? normNotionId(parent.database_id)
        : null,
  };
}

/** CRM_物件 の `種別`（select）の名前。無ければ null */
export function readPropertyKind(page: Record<string, unknown>): string | null {
  const k = (propsOf(page)["種別"] as { select?: { name?: unknown } | null } | undefined)?.select?.name;
  return typeof k === "string" && k ? k : null;
}

export type SateiDealJudge =
  | { ok: true; deal: { id: string; name: string; dealNo: number | null; folderId: string } }
  | { ok: false; reason: "not-found" | "not-mansion" | "no-folder" };

/**
 * 作れるか。順番：ページが無い・消えた・CRM_案件 の子でない → not-found、
 * 種別がマンションでない（分からないも含む）→ not-mansion、フォルダが無い → no-folder。
 */
export function judgeSateiDeal(
  deal: SateiDeal | null,
  kind: string | null,
  dealsDbId: string,
): SateiDealJudge {
  if (!deal || deal.gone || !deal.id || deal.parentDbId !== normNotionId(dealsDbId)) {
    return { ok: false, reason: "not-found" };
  }
  if (kind !== SATEI_KIND) return { ok: false, reason: "not-mansion" };
  if (!deal.folderId) return { ok: false, reason: "no-folder" };
  return {
    ok: true,
    deal: { id: deal.id, name: deal.name, dealNo: deal.dealNo, folderId: deal.folderId },
  };
}
```

- [ ] **Step 4: 通ることを確かめ、test に足す**

```bash
npx tsx tests/satei-deal.test.ts
node -e 'const fs=require("fs");const f="package.json";const p=JSON.parse(fs.readFileSync(f,"utf8"));p.scripts.test+=" && tsx tests/satei-deal.test.ts";fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
npm test
```

- [ ] **Step 5: コミット**

```bash
git add src/lib/satei-deal.ts tests/satei-deal.test.ts package.json
git commit -m "feat: 査定書の案件ページの読み方と作れるかの判定を足す

CRM_案件 の案件名・ID・Driveフォルダ・物件と CRM_物件 の種別を読む純関数。
マンション以外・フォルダ未設定・ほかの DB のページを断る。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: reins-report の intake・decide・reason を呼ぶ（satei-portal.ts）

**Files:**
- Create: `src/lib/satei-portal.ts`
- Modify: `src/lib/obi/config.ts:36`（`function parsePortalBaseUrl` → `export function parsePortalBaseUrl`。中身は変えない）
- Test: `tests/satei-portal.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes：`parsePortalBaseUrl(raw: string | undefined): string | null`（obi/config.ts）
- Produces：
  - `interface SateiPortalOpts { fetchImpl: typeof fetch; baseUrl: string; token: string; timeoutMs: number }`
  - `type SateiCall<T> = { kind: "ok"; value: T } | { kind: "rejected"; status: number; code: string } | { kind: "unknown"; reason: string }`
  - `SATEI_PORTAL_TIMEOUT_MS = 8000`
  - `SATEI_CODE_AWAITING_REASON = "SATEI_AWAITING_REASON"`（契約 6-10。同じ案件が差し戻しで理由待ちのとき intake が返す code）
  - `sateiPortalConfig(env?: Record<string, string | undefined>): { baseUrl: string; token: string } | null`
  - `interface SateiIntakeReq { eventId: string; dealId: string; dealNo: number | null; folderId: string; dealName: string; requestedBy: string }`
  - `interface SateiIntakeOk { created: boolean; no: number; status: string }`
  - `sateiIntake(req: SateiIntakeReq, opts: SateiPortalOpts): Promise<SateiCall<SateiIntakeOk>>`
  - `interface SateiDecideReq { decision: "ok" | "reject"; by: string; artifactSha256: string; generation: number }`
  - `sateiDecide(no: number, req: SateiDecideReq, opts: SateiPortalOpts): Promise<SateiCall<{ status: string }>>`
  - `sateiReason(no: number, text: string, opts: SateiPortalOpts): Promise<SateiCall<{ ok: true }>>`

- [ ] **Step 1: 失敗するテストを書く** `tests/satei-portal.test.ts`

```ts
/**
 * B2 査定書：reins-report の intake・decide・reason（契約 第2節）を呼ぶ部分。fetch は差し替え。
 */
import {
  sateiDecide,
  sateiIntake,
  sateiPortalConfig,
  sateiReason,
  SATEI_CODE_AWAITING_REASON,
  type SateiIntakeReq,
  type SateiPortalOpts,
} from "../src/lib/satei-portal";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};
globalThis.fetch = (async () => {
  throw new Error("このテストで本物の fetch を使ってはいけない");
}) as typeof fetch;

type Call = { url: string; init: RequestInit };
function fakeFetch(status: number, body: unknown, calls: Call[], err?: Error): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (err) throw err;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
const opts = (f: typeof fetch): SateiPortalOpts => ({
  fetchImpl: f,
  baseUrl: "https://portal.example.test",
  token: "tok",
  timeoutMs: 1000,
});
const SHIMO = "U" + "b".repeat(32);
const SHA = "c".repeat(64);
const REQ: SateiIntakeReq = {
  eventId: "01HEVENTID",
  dealId: "0123abcd0123456789ab0123456789ab",
  dealNo: 42,
  folderId: "1AbC_dEf-GhIjKlMnOp",
  dealName: "テスト",
  requestedBy: SHIMO,
};
const headerOf = (c: Call, k: string) => (c.init.headers as Record<string, string>)[k];

(async () => {
  // ── intake ──
  let c: Call[] = [];
  const r1 = await sateiIntake(REQ, opts(fakeFetch(201, { created: true, job: { no: 5, status: "受付" } }, c)));
  ok("intake の口", c[0]?.url === "https://portal.example.test/api/jobs/satei/intake" && c[0]?.init.method === "POST");
  ok("鍵は x-job-token", headerOf(c[0], "x-job-token") === "tok");
  ok("本文は JSON", headerOf(c[0], "content-type") === "application/json");
  ok("本文は契約の6項目", c[0]?.init.body === JSON.stringify(REQ));
  ok(
    "201 created → 新規",
    r1.kind === "ok" && r1.value.created === true && r1.value.no === 5 && r1.value.status === "受付",
  );
  c = [];
  const r2 = await sateiIntake(REQ, opts(fakeFetch(200, { created: false, job: { no: 4, status: "下準備中" } }, c)));
  ok("created=false → 作っていない（既にある）", r2.kind === "ok" && r2.value.created === false && r2.value.no === 4);
  const r3 = await sateiIntake(REQ, opts(fakeFetch(409, { code: SATEI_CODE_AWAITING_REASON }, [])));
  ok(
    "差し戻しの理由待ち → 断り（code そのまま）",
    r3.kind === "rejected" && r3.status === 409 && r3.code === "SATEI_AWAITING_REASON",
  );
  const r4 = await sateiIntake(REQ, opts(fakeFetch(400, "not json", [])));
  ok("4xx で中身が読めない → HTTP_400", r4.kind === "rejected" && r4.code === "HTTP_400");
  const r5 = await sateiIntake(REQ, opts(fakeFetch(500, {}, [])));
  ok("5xx → 分からない", r5.kind === "unknown");
  const r6 = await sateiIntake(REQ, opts(fakeFetch(0, {}, [], new Error("boom"))));
  ok("通信の例外 → 分からない", r6.kind === "unknown");
  const r7 = await sateiIntake(REQ, opts(fakeFetch(200, {}, [])));
  ok("成功なのに中身が読めない → 分からない", r7.kind === "unknown");
  const r8 = await sateiIntake(REQ, opts(fakeFetch(201, { created: true, job: { no: 0, status: "受付" } }, [])));
  ok("番号が正の整数でない → 分からない", r8.kind === "unknown");

  // ── decide ──
  c = [];
  const d1 = await sateiDecide(
    12,
    { decision: "ok", by: SHIMO, artifactSha256: SHA, generation: 3 },
    opts(fakeFetch(200, { status: "完成" }, c)),
  );
  ok("decide の口", c[0]?.url === "https://portal.example.test/api/jobs/12/satei/decide");
  ok(
    "decide に sha・generation を渡す",
    c[0]?.init.body === JSON.stringify({ decision: "ok", by: SHIMO, artifactSha256: SHA, generation: 3 }),
  );
  ok("decide 200 → ok", d1.kind === "ok" && d1.value.status === "完成");
  const d2 = await sateiDecide(
    12,
    { decision: "reject", by: SHIMO, artifactSha256: SHA, generation: 3 },
    opts(fakeFetch(409, { code: "SATEI_MISMATCH" }, [])),
  );
  ok("decide 409 → SATEI_MISMATCH の断り", d2.kind === "rejected" && d2.status === 409 && d2.code === "SATEI_MISMATCH");

  // ── reason ──
  c = [];
  const s1 = await sateiReason(12, "事例が古い", opts(fakeFetch(200, { ok: true }, c)));
  ok("reason の口", c[0]?.url === "https://portal.example.test/api/jobs/12/satei/reason");
  ok("reason の本文", c[0]?.init.body === JSON.stringify({ text: "事例が古い" }));
  ok("reason 200 → ok", s1.kind === "ok");
  const s2 = await sateiReason(12, "x", opts(fakeFetch(409, { code: "SATEI_STALE" }, [])));
  ok("reason 409 → 断り", s2.kind === "rejected");

  // ── 設定 ──
  const cfg = sateiPortalConfig({ PORTAL_BASE_URL: "https://p.example.test/", JOB_API_TOKEN: "t" });
  ok("末尾の / を落とす", cfg?.baseUrl === "https://p.example.test" && cfg?.token === "t");
  ok("鍵が無い → null", sateiPortalConfig({ PORTAL_BASE_URL: "https://p.example.test" }) === null);
  ok("鍵に空白 → null", sateiPortalConfig({ PORTAL_BASE_URL: "https://p.example.test", JOB_API_TOKEN: "t t" }) === null);
  ok("http（localhost 以外）→ null", sateiPortalConfig({ PORTAL_BASE_URL: "http://p.example.test", JOB_API_TOKEN: "t" }) === null);

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx tests/satei-portal.test.ts`
Expected: FAIL（`Cannot find module '../src/lib/satei-portal'`）

- [ ] **Step 3: 実装**

`src/lib/obi/config.ts` の36行目の `function parsePortalBaseUrl(` を `export function parsePortalBaseUrl(` に替える（中身は1文字も変えない）。

`src/lib/satei-portal.ts`：

```ts
/**
 * B2 査定書：reins-report の依頼箱（契約 第2節）を呼ぶ。鍵はヘッダ `x-job-token`（帯替えと同じ JOB_API_TOKEN）。
 *   POST /api/jobs/satei/intake      … {eventId, dealId, dealNo, folderId, dealName, requestedBy} → {created, job:{no,status}}
 *   POST /api/jobs/{no}/satei/decide … {decision, by, artifactSha256, generation} → {status}／409 SATEI_MISMATCH
 *   POST /api/jobs/{no}/satei/reason … {text} → {ok:true}
 * 結果は3つに分ける：ok（2xx で中身が読めた）／rejected（4xx。はっきり断られた）／unknown（5xx・通信の失敗・中身が読めない）。
 * 例外は投げない。本文・鍵はログに出さない（この関数はログを出さない）。
 */
import { parsePortalBaseUrl } from "./obi/config";

export interface SateiPortalOpts {
  fetchImpl: typeof fetch;
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

export type SateiCall<T> =
  | { kind: "ok"; value: T }
  | { kind: "rejected"; status: number; code: string }
  | { kind: "unknown"; reason: string };

export const SATEI_PORTAL_TIMEOUT_MS = 8_000;

/** 同じ案件の依頼が「差し戻し」で理由待ちのとき、intake が返す code（契約 6-10。名前は reins-report の実装に合わせる） */
export const SATEI_CODE_AWAITING_REASON = "SATEI_AWAITING_REASON";

export function sateiPortalConfig(
  env: Record<string, string | undefined> = process.env,
): { baseUrl: string; token: string } | null {
  const baseUrl = parsePortalBaseUrl(env.PORTAL_BASE_URL);
  const token = env.JOB_API_TOKEN ?? "";
  if (!baseUrl || !token || /\s/.test(token)) return null;
  return { baseUrl, token };
}

type Raw =
  | { kind: "http"; status: number; body: Record<string, unknown> }
  | { kind: "unknown"; reason: string };

async function postJson(path: string, payload: unknown, opts: SateiPortalOpts): Promise<Raw> {
  let res: Response;
  try {
    res = await opts.fetchImpl(`${opts.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-job-token": opts.token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    return { kind: "unknown", reason: name === "TimeoutError" ? "timeout" : "network" };
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // 中身が読めない（body は {} のまま）
  }
  return { kind: "http", status: res.status, body };
}

function classify<T>(raw: Raw, read: (body: Record<string, unknown>) => T | null): SateiCall<T> {
  if (raw.kind === "unknown") return raw;
  const { status, body } = raw;
  if (status >= 200 && status < 300) {
    const value = read(body);
    return value ? { kind: "ok", value } : { kind: "unknown", reason: "invalid-success-body" };
  }
  if (status >= 400 && status < 500) {
    return { kind: "rejected", status, code: typeof body.code === "string" && body.code ? body.code : `HTTP_${status}` };
  }
  return { kind: "unknown", reason: `http-${status}` };
}

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

export interface SateiIntakeReq {
  eventId: string;
  dealId: string;
  dealNo: number | null;
  folderId: string;
  dealName: string;
  requestedBy: string;
}

export interface SateiIntakeOk {
  created: boolean;
  no: number;
  status: string;
}

export async function sateiIntake(req: SateiIntakeReq, opts: SateiPortalOpts): Promise<SateiCall<SateiIntakeOk>> {
  const payload: SateiIntakeReq = {
    eventId: req.eventId,
    dealId: req.dealId,
    dealNo: req.dealNo,
    folderId: req.folderId,
    dealName: req.dealName,
    requestedBy: req.requestedBy,
  };
  return classify(await postJson("/api/jobs/satei/intake", payload, opts), (b) => {
    const job = b.job as { no?: unknown; status?: unknown } | undefined;
    if (typeof b.created !== "boolean" || !job || !isPositiveInt(job.no) || typeof job.status !== "string") return null;
    return { created: b.created, no: job.no, status: job.status };
  });
}

export interface SateiDecideReq {
  decision: "ok" | "reject";
  by: string;
  artifactSha256: string;
  generation: number;
}

export async function sateiDecide(
  no: number,
  req: SateiDecideReq,
  opts: SateiPortalOpts,
): Promise<SateiCall<{ status: string }>> {
  const payload: SateiDecideReq = {
    decision: req.decision,
    by: req.by,
    artifactSha256: req.artifactSha256,
    generation: req.generation,
  };
  return classify(await postJson(`/api/jobs/${no}/satei/decide`, payload, opts), (b) =>
    typeof b.status === "string" ? { status: b.status } : null,
  );
}

export async function sateiReason(no: number, text: string, opts: SateiPortalOpts): Promise<SateiCall<{ ok: true }>> {
  return classify(await postJson(`/api/jobs/${no}/satei/reason`, { text }, opts), (b) =>
    b.ok === true ? { ok: true as const } : null,
  );
}
```

- [ ] **Step 4: 通ることを確かめ、test に足す**

```bash
npx tsx tests/satei-portal.test.ts
npx tsx tests/obi-config.test.ts      # export を足しただけで既存が変わらない
node -e 'const fs=require("fs");const f="package.json";const p=JSON.parse(fs.readFileSync(f,"utf8"));p.scripts.test+=" && tsx tests/satei-portal.test.ts";fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
npm test
```

- [ ] **Step 5: コミット**

```bash
git add src/lib/satei-portal.ts src/lib/obi/config.ts tests/satei-portal.test.ts package.json
git commit -m "feat: 査定書の依頼箱（intake・decide・reason）を呼ぶ部分を足す

契約第2節の3つの口を、結果を ok／rejected／unknown に分けて呼ぶ。
PORTAL_BASE_URL の確かめ方は帯替えと同じ関数を使う（export を足しただけ）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 返事・通知の文面と下書きカード（satei-text.ts）

**Files:**
- Create: `src/lib/satei-text.ts`
- Test: `tests/satei-text.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes：`encodeSateiDecision`（Task 2）、`ALT_TEXT_MAX`・`FLEX_LABEL_MAX`・`POSTBACK_TEXT_MAX`・`FlexMessage`（task-card.ts）
- Produces：
  - 定数 `MSG_SATEI_PAUSED`・`MSG_SATEI_FORBIDDEN`・`MSG_SATEI_NOT_MANSION`・`MSG_SATEI_NO_FOLDER`・`MSG_SATEI_DEAL_NOT_FOUND`・`MSG_SATEI_BUSY`・`MSG_SATEI_FAILED`・`MSG_SATEI_UNKNOWN`・`MSG_SATEI_AWAITING_REASON`（契約 6-10）
  - `jobTag(no: number): string`（`#J12`）
  - `msgSateiAccepted(no)`・`msgSateiInProgress(no)`・`msgSateiOk(no)`・`msgSateiRejectAsk(no)`・`msgSateiRejected(no)`・`msgSateiStale(no)`・`msgSateiReasonSaved(no)`・`msgSateiReasonFailed(no)`（通信の失敗＝もう一度送ってもらう。契約 6-11）・`msgSateiReasonClosed(no)`（portal がはっきり断った＝理由を受ける段を過ぎた）（すべて `(no: number) => string`）
  - `type SateiNoticeKind = "draft" | "failed" | "saved" | "aborted"`
  - `interface SateiNotice { no: number; kind: SateiNoticeKind; generation: number; dealName: string; driveFileId: string | null; verdict: string | null; findings: string[]; missing: string[]; failReason: string | null; artifactSha256: string | null }`
  - `driveViewUrl(fileId: string): string`
  - `sateiNoticeText(n: SateiNotice): string`（draft 以外）
  - `sateiDraftCard(n: SateiNotice): FlexMessage | null`（draft で必要な値がそろわなければ null）
  - `sateiNoticeMessages(n: SateiNotice): unknown[] | null`（draft → `[card]`、ほか → `[{type:"text",text}]`）

- [ ] **Step 1: 失敗するテストを書く** `tests/satei-text.test.ts`

```ts
/**
 * B2 査定書：返事・通知の文面と下書きカード（satei-text.ts）。
 */
import { parseSateiData } from "../src/lib/satei-data";
import {
  driveViewUrl,
  jobTag,
  MSG_SATEI_AWAITING_REASON,
  msgSateiAccepted,
  msgSateiInProgress,
  msgSateiReasonClosed,
  msgSateiReasonFailed,
  msgSateiRejectAsk,
  sateiDraftCard,
  sateiNoticeMessages,
  sateiNoticeText,
  type SateiNotice,
} from "../src/lib/satei-text";
import type { FlexMessage } from "../src/lib/task-card";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};

const SHA = "b".repeat(64);
const DRAFT: SateiNotice = {
  no: 12,
  kind: "draft",
  generation: 3,
  dealName: "テストマンション101",
  driveFileId: "1FileId_abcdefghij",
  verdict: "要修正",
  findings: ["指摘1", "指摘2", "指摘3", "指摘4"],
  missing: [],
  failReason: null,
  artifactSha256: SHA,
};
const HEAD = "【査定書 #J12・テストマンション101】\n";

ok("J番号の形", jobTag(12) === "#J12");
ok("受付の返事", msgSateiAccepted(5) === "受け付けました。結果は個人の LINE に届きます（#J5）");
ok("作成中の返事", msgSateiInProgress(4) === "作成中です（#J4）");
ok(
  "差し戻しの返事",
  msgSateiRejectAsk(12) === "差し戻しました（#J12）。理由を一言返信してください（次の1通を理由として記録します）",
);
ok(
  "理由待ちの返事（契約 6-10）",
  MSG_SATEI_AWAITING_REASON === "差し戻しの理由を待っています（理由を返信するか、30分後に押し直してください）",
);
ok("理由の記録に失敗（契約 6-11）", msgSateiReasonFailed(12) === "記録できませんでした。もう一度送ってください（#J12）");
ok("理由を受ける段を過ぎた", msgSateiReasonClosed(12) === "理由を記録できませんでした。この差し戻しはもう閉じています（#J12）");

// ── 下書きカード ──
const msgs = sateiNoticeMessages(DRAFT);
ok("draft は Flex 1通", msgs !== null && msgs.length === 1 && (msgs[0] as FlexMessage).type === "flex");
const card = sateiDraftCard(DRAFT) as FlexMessage;
const json = JSON.stringify(card);
ok("見出し", json.includes("🏢 査定書の下書きができました（#J12・テストマンション101）"));
ok("altText も見出し", card.altText === "🏢 査定書の下書きができました（#J12・テストマンション101）");
ok("判定", json.includes("判定：要修正"));
ok("指摘は上位3件まで", json.includes("・指摘3") && !json.includes("指摘4"));
type Act = { type: string; label: string; uri?: string; data?: string; displayText?: string };
const acts = ((card.contents as { footer: { contents: Array<{ action: Act }> } }).footer.contents).map((b) => b.action);
ok("ボタンは3つ", acts.length === 3);
ok("下書きを見る＝Drive の閲覧 URL", acts[0].type === "uri" && acts[0].label === "下書きを見る" && acts[0].uri === "https://drive.google.com/file/d/1FileId_abcdefghij/view");
ok("driveViewUrl", driveViewUrl("X") === "https://drive.google.com/file/d/X/view");
ok(
  "OK の data の往復",
  acts[1].label === "OK" &&
    JSON.stringify(parseSateiData(acts[1].data ?? "")) === JSON.stringify({ op: "so", no: 12, generation: 3, sha256: SHA }),
);
ok(
  "差し戻しの data の往復",
  acts[2].label === "差し戻し" &&
    JSON.stringify(parseSateiData(acts[2].data ?? "")) === JSON.stringify({ op: "sr", no: 12, generation: 3, sha256: SHA }),
);
ok("ラベルは40字以内", acts.every((a) => Array.from(a.label).length <= 40));
const long = JSON.stringify(sateiDraftCard({ ...DRAFT, findings: ["あ".repeat(300)] }));
ok("指摘は1件120字まで", long.includes(`・${"あ".repeat(120)}"`) && !long.includes("あ".repeat(121)));
ok("指摘が無ければ「指摘：なし」", JSON.stringify(sateiDraftCard({ ...DRAFT, findings: [] })).includes("指摘：なし"));
ok("案件名が空なら（無題）", JSON.stringify(sateiDraftCard({ ...DRAFT, dealName: "" })).includes("（#J12・（無題））"));
ok("Drive ID が無い draft は作らない", sateiNoticeMessages({ ...DRAFT, driveFileId: null }) === null);
ok("sha が無い draft は作らない", sateiDraftCard({ ...DRAFT, artifactSha256: null }) === null);
ok("判定が無い draft は作らない", sateiDraftCard({ ...DRAFT, verdict: null }) === null);

// ── 文字の通知 ──
const base: SateiNotice = { ...DRAFT, kind: "failed", driveFileId: null, verdict: null, findings: [], artifactSha256: null };
ok(
  "failed materials",
  sateiNoticeText({ ...base, failReason: "materials", missing: ["成約事例のPDF", "専有面積"] }) ===
    `${HEAD}材料が足りないので作っていません：成約事例のPDF、専有面積。入れたら［査定書を作る］を押し直してください`,
);
ok("failed timeout", sateiNoticeText({ ...base, failReason: "timeout" }) === `${HEAD}作れませんでした（時間切れ）。押し直すと最初からやり直します`);
ok("failed check", sateiNoticeText({ ...base, failReason: "check" }) === `${HEAD}作れませんでした（検品できませんでした）。押し直すと最初からやり直します`);
ok("failed internal", sateiNoticeText({ ...base, failReason: "internal" }) === `${HEAD}作れませんでした（内部のエラー）。押し直すと最初からやり直します`);
ok("failed 理由なし → internal と同じ", sateiNoticeText({ ...base, failReason: null }) === `${HEAD}作れませんでした（内部のエラー）。押し直すと最初からやり直します`);
ok("failed folder", sateiNoticeText({ ...base, failReason: "folder" }) === `${HEAD}案件フォルダを確かめられませんでした`);
ok("saved", sateiNoticeText({ ...base, kind: "saved" }) === `${HEAD}案件フォルダの 02_査定・事例 に保存しました`);
ok(
  "aborted input-changed",
  sateiNoticeText({ ...base, kind: "aborted", failReason: "input-changed" }) ===
    `${HEAD}資料が変わったので保存していません。［査定書を作る］を押し直してください`,
);
ok(
  "aborted name-conflict",
  sateiNoticeText({ ...base, kind: "aborted", failReason: "name-conflict" }) ===
    `${HEAD}同じ名前で中身の違うファイルがあるので保存していません`,
);
const sm = sateiNoticeMessages({ ...base, kind: "saved" });
ok("draft 以外は文字1通", JSON.stringify(sm) === JSON.stringify([{ type: "text", text: `${HEAD}案件フォルダの 02_査定・事例 に保存しました` }]));

if (fail > 0) {
  console.log(`\n${fail} 件失敗`);
  process.exit(1);
}
console.log("\nすべて成功");
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx tests/satei-text.test.ts`
Expected: FAIL（`Cannot find module '../src/lib/satei-text'`）

- [ ] **Step 3: 実装** `src/lib/satei-text.ts`

```ts
/**
 * B2 査定書：返事・個人あての通知の文面と、下書きのカード（契約 第3節の「文面」）。
 * J番号は帯替えと同じ `#J<no>` の形。draft 以外の通知は、どの依頼か分かるよう頭に【査定書 #J番号・案件名】を付ける。
 */
import { encodeSateiDecision } from "./satei-data";
import {
  ALT_TEXT_MAX,
  FLEX_LABEL_MAX,
  POSTBACK_TEXT_MAX,
  type FlexMessage,
} from "./task-card";

const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");

export const jobTag = (no: number): string => `#J${no}`;

export const MSG_SATEI_PAUSED = "いまは止めています";
export const MSG_SATEI_FORBIDDEN = "いまは下村さんだけが使えます";
export const MSG_SATEI_NOT_MANSION = "いまはマンションの案件だけ作れます";
export const MSG_SATEI_NO_FOLDER = "案件の Driveフォルダが未設定です";
export const MSG_SATEI_DEAL_NOT_FOUND = "案件を読み取れませんでした";
export const MSG_SATEI_BUSY = "いま操作を受け付けられません。少し待ってからもう一度押してください";
export const MSG_SATEI_FAILED = "⚠️ 受け付けられませんでした。少し時間をおいてもう一度お試しください。";
export const MSG_SATEI_UNKNOWN = "受け付けられたか確かめられませんでした。少し待ってからもう一度押してください";
/** 同じ案件が差し戻しで理由待ちのあいだの［査定書を作る］（契約 6-10 の文） */
export const MSG_SATEI_AWAITING_REASON =
  "差し戻しの理由を待っています（理由を返信するか、30分後に押し直してください）";

export const msgSateiAccepted = (no: number) => `受け付けました。結果は個人の LINE に届きます（${jobTag(no)}）`;
export const msgSateiInProgress = (no: number) => `作成中です（${jobTag(no)}）`;
export const msgSateiOk = (no: number) => `OK を受け付けました。案件フォルダに保存したら知らせます（${jobTag(no)}）`;
export const msgSateiRejectAsk = (no: number) =>
  `差し戻しました（${jobTag(no)}）。理由を一言返信してください（次の1通を理由として記録します）`;
export const msgSateiRejected = (no: number) => `差し戻しました（${jobTag(no)}）`;
export const msgSateiStale = (no: number) => `この下書きは古いか、もう処理済みです（${jobTag(no)}）`;
export const msgSateiReasonSaved = (no: number) => `理由を記録しました（${jobTag(no)}）`;
/** 通信の失敗・結果不明（印は残すので、次の1通をもう一度理由として受ける。契約 6-11 の文） */
export const msgSateiReasonFailed = (no: number) => `記録できませんでした。もう一度送ってください（${jobTag(no)}）`;
/** portal がはっきり断った（30分を過ぎて取消になった・もう理由が入っている）。印は消す */
export const msgSateiReasonClosed = (no: number) =>
  `理由を記録できませんでした。この差し戻しはもう閉じています（${jobTag(no)}）`;

export type SateiNoticeKind = "draft" | "failed" | "saved" | "aborted";

export interface SateiNotice {
  no: number;
  kind: SateiNoticeKind;
  generation: number;
  dealName: string;
  driveFileId: string | null;
  verdict: string | null;
  /** 指摘（上位3件・各120字に切ったもの） */
  findings: string[];
  missing: string[];
  failReason: string | null;
  artifactSha256: string | null;
}

const DEAL_NAME_MAX = 60;
const FINDINGS_MAX = 3;
const FINDING_LEN = 120;

const nameOf = (n: SateiNotice) => cut(n.dealName.trim() || "（無題）", DEAL_NAME_MAX);

export const driveViewUrl = (fileId: string): string => `https://drive.google.com/file/d/${fileId}/view`;

const FAIL_LABEL: Record<string, string> = {
  timeout: "時間切れ",
  check: "検品できませんでした",
  internal: "内部のエラー",
};

function bodyOf(n: SateiNotice): string {
  if (n.kind === "saved") return "案件フォルダの 02_査定・事例 に保存しました";
  if (n.kind === "aborted") {
    return n.failReason === "name-conflict"
      ? "同じ名前で中身の違うファイルがあるので保存していません"
      : "資料が変わったので保存していません。［査定書を作る］を押し直してください";
  }
  // failed（draft は呼ばれない）
  if (n.failReason === "materials") {
    const what = n.missing.length > 0 ? n.missing.join("、") : "（一覧なし）";
    return `材料が足りないので作っていません：${what}。入れたら［査定書を作る］を押し直してください`;
  }
  if (n.failReason === "folder") return "案件フォルダを確かめられませんでした";
  const label = FAIL_LABEL[n.failReason ?? ""] ?? FAIL_LABEL.internal;
  return `作れませんでした（${label}）。押し直すと最初からやり直します`;
}

/** draft 以外の通知の文 */
export function sateiNoticeText(n: SateiNotice): string {
  return `【査定書 ${jobTag(n.no)}・${nameOf(n)}】\n${bodyOf(n)}`;
}

const postback = (label: string, data: string, displayText: string, primary: boolean) => ({
  type: "button",
  style: primary ? "primary" : "secondary",
  height: "sm",
  action: {
    type: "postback",
    label: cut(label, FLEX_LABEL_MAX),
    data,
    displayText: cut(displayText, POSTBACK_TEXT_MAX),
  },
});

/** 下書きのカード（判定・指摘3件・［下書きを見る］［OK］［差し戻し］）。必要な値がそろわなければ null */
export function sateiDraftCard(n: SateiNotice): FlexMessage | null {
  if (!n.driveFileId || !n.artifactSha256 || !n.verdict) return null;
  const head = `🏢 査定書の下書きができました（${jobTag(n.no)}・${nameOf(n)}）`;
  const findings = n.findings.slice(0, FINDINGS_MAX).map((f) => ({
    type: "text",
    text: `・${cut(f, FINDING_LEN)}`,
    size: "sm",
    color: "#555555",
    wrap: true,
  }));
  return {
    type: "flex",
    altText: cut(head, ALT_TEXT_MAX),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: head, weight: "bold", size: "md", wrap: true },
          { type: "text", text: `判定：${n.verdict}`, size: "sm", wrap: true },
          ...(findings.length > 0 ? findings : [{ type: "text", text: "指摘：なし", size: "sm", wrap: true }]),
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: { type: "uri", label: "下書きを見る", uri: driveViewUrl(n.driveFileId) },
          },
          postback("OK", encodeSateiDecision("so", n.no, n.generation, n.artifactSha256), "（ボタン）査定書OK", true),
          postback(
            "差し戻し",
            encodeSateiDecision("sr", n.no, n.generation, n.artifactSha256),
            "（ボタン）査定書を差し戻す",
            false,
          ),
        ],
      },
    },
  };
}

/** push する中身（draft はカード1通、ほかは文字1通）。draft で値がそろわなければ null */
export function sateiNoticeMessages(n: SateiNotice): unknown[] | null {
  if (n.kind === "draft") {
    const card = sateiDraftCard(n);
    return card ? [card] : null;
  }
  return [{ type: "text", text: sateiNoticeText(n) }];
}
```

注意：`sateiDraftCard` の OK・差し戻しの data は `generation` が 1 以上でないと `parseSateiData` で読めない（契約：結果を登録するたびに +1 なので draft の generation は 1 以上）。Task 7 の入力の検査で draft の `generation >= 1` を確かめる。

- [ ] **Step 4: 通ることを確かめ、test に足す**

```bash
npx tsx tests/satei-text.test.ts
node -e 'const fs=require("fs");const f="package.json";const p=JSON.parse(fs.readFileSync(f,"utf8"));p.scripts.test+=" && tsx tests/satei-text.test.ts";fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
npm test
```

- [ ] **Step 5: コミット**

```bash
git add src/lib/satei-text.ts tests/satei-text.test.ts package.json
git commit -m "feat: 査定書の返事・通知の文面と下書きカードを足す

契約第3節の文面（draft・failed・saved・aborted）と、［下書きを見る］［OK］［差し戻し］のカード。
OK・差し戻しの data が satei の読み方で往復できることをテストで固定した。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: retry key つきの push と通知の受け口の中身（line.ts・satei-notify.ts）

**Files:**
- Modify: `src/lib/line.ts`（ファイルの最後に関数を1つ足す。既存の関数は変えない）
- Create: `src/lib/satei-notify.ts`
- Test: `tests/satei-notify.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes：`timingSafeEqualStr`（secure-compare.ts）、`sateiActive`・`sateiNotifyTarget`（Task 2）、`sateiNoticeMessages`・`SateiNotice`・`SateiNoticeKind`（Task 6）
- Produces：
  - `line.ts`：`pushMessagesWithRetryKey(to: string, messages: unknown[], retryKey: string, timeoutMs?: number, fetchImpl?: typeof fetch): Promise<number | null>`（HTTP の状態番号。例外・時間切れは null）
  - `SATEI_TOKEN_HEADER = "x-satei-token"`、`SATEI_TOKEN_CONTEXT = "satei-notify"`、`SATEI_KEY_MIN_LENGTH = 32`、`SATEI_RETRY_NAMESPACE = "3f0c6a1e-8d2b-4c5e-9a71-b2d4e6f80a13"`
  - `sateiNotifyToken(jobApiToken: string): string`
  - `sateiNotifyAuthorized(header: string | null, jobApiToken: string | undefined): boolean`
  - `uuidv5(name: string, namespace: string): string`
  - `sateiRetryKey(no: number, kind: string, generation: number): string`
  - `parseNotifyInput(body: unknown): SateiNotice | null`
  - `pushResultOf(status: number | null): "sent" | "unknown"`（push したときの結果。送らなかったときの `deferred` は handleSateiNotify が返す）
  - `interface SateiNotifyDeps { env: Record<string, string | undefined>; push(to: string, messages: unknown[], retryKey: string): Promise<number | null>; log(line: string): void }`
  - `handleSateiNotify(header: string | null, raw: string, deps: SateiNotifyDeps): Promise<{ status: number; body: Record<string, unknown> }>`

- [ ] **Step 1: 失敗するテストを書く** `tests/satei-notify.test.ts`

uuidv5 の期待値は Python の `uuid.uuid5` で確かめた値（`uuid5(NAMESPACE_DNS, "python.org")` は Python の公式文書の例）。

```ts
/**
 * B2 査定書：通知の受け口（合言葉・uuidv5・retry key・入力の検査・push の結果）と line.ts の retry key つき push。
 */
import { createHmac } from "node:crypto";
import {
  handleSateiNotify,
  parseNotifyInput,
  pushResultOf,
  sateiNotifyAuthorized,
  sateiNotifyToken,
  sateiRetryKey,
  SATEI_RETRY_NAMESPACE,
  uuidv5,
  type SateiNotifyDeps,
} from "../src/lib/satei-notify";
import { pushMessagesWithRetryKey } from "../src/lib/line";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};
globalThis.fetch = (async () => {
  throw new Error("このテストで本物の fetch を使ってはいけない");
}) as typeof fetch;

const KEY = "k".repeat(40);
const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const TOKEN = createHmac("sha256", Buffer.from(KEY, "utf8")).update("satei-notify", "utf8").digest("hex");

// ── 合言葉 ──
ok("合言葉＝HMAC-SHA256(JOB_API_TOKEN, satei-notify) の hex", sateiNotifyToken(KEY) === TOKEN);
ok("正しい合言葉は通す", sateiNotifyAuthorized(TOKEN, KEY));
ok("鍵違いは断る", !sateiNotifyAuthorized("0".repeat(64), KEY));
ok("長さ違いは断る", !sateiNotifyAuthorized(TOKEN.slice(1), KEY));
ok("ヘッダ無しは断る", !sateiNotifyAuthorized(null, KEY));
ok("JOB_API_TOKEN が無いと誰も通さない", !sateiNotifyAuthorized(TOKEN, undefined));
ok("JOB_API_TOKEN が32字未満なら誰も通さない", !sateiNotifyAuthorized(sateiNotifyToken("short"), "short"));

// ── uuidv5・retry key ──
ok("uuidv5 は公開の例と同じ", uuidv5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8") === "886313e1-3b8a-5372-9b90-0c9aee199e5d");
ok("名前空間は固定値", SATEI_RETRY_NAMESPACE === "3f0c6a1e-8d2b-4c5e-9a71-b2d4e6f80a13");
ok("retry key は no:kind:generation の uuidv5", sateiRetryKey(123, "draft", 1) === "6a59ac01-411c-518b-86eb-27eb8c85f188");
ok("同じ入力なら同じ値", sateiRetryKey(123, "draft", 1) === sateiRetryKey(123, "draft", 1));
ok("世代が違えば別の値", sateiRetryKey(123, "draft", 2) === "d711292f-b1cf-5375-9b71-c53ad7e23e89");
ok("種類が違えば別の値", sateiRetryKey(123, "saved", 1) !== sateiRetryKey(123, "draft", 1));
ok(
  "UUID の形（版5・変種10）",
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sateiRetryKey(1, "failed", 0)),
);

// ── push の結果 ──
ok("200 → sent", pushResultOf(200) === "sent");
ok("409（同じキーで受付済み）→ sent", pushResultOf(409) === "sent");
ok("400 → unknown", pushResultOf(400) === "unknown");
ok("500 → unknown", pushResultOf(500) === "unknown");
ok("例外（null）→ unknown", pushResultOf(null) === "unknown");

// ── 入力の検査 ──
const SHA = "c".repeat(64);
const DRAFT = {
  no: 12,
  kind: "draft",
  generation: 3,
  dealName: "テスト",
  driveFileId: "1FileId_abcdefghij",
  verdict: "要修正",
  findings: ["a", "b", "c", "d"],
  artifactSha256: SHA,
};
const p1 = parseNotifyInput(DRAFT);
ok("draft を読む", p1 !== null && p1.no === 12 && p1.kind === "draft" && p1.generation === 3 && p1.findings.length === 3);
ok("findings は JSON 配列の文字列でも読む", parseNotifyInput({ ...DRAFT, findings: JSON.stringify(["x"]) })?.findings[0] === "x");
ok("missing は JSON 配列の文字列でも読む", parseNotifyInput({ no: 1, kind: "failed", generation: 1, dealName: "a", failReason: "materials", missing: '["謄本"]' })?.missing[0] === "謄本");
ok("draft で sha が無い → null", parseNotifyInput({ ...DRAFT, artifactSha256: undefined }) === null);
ok("draft で Drive ID が無い → null", parseNotifyInput({ ...DRAFT, driveFileId: "" }) === null);
ok("draft で generation 0 → null", parseNotifyInput({ ...DRAFT, generation: 0 }) === null);
ok("知らない kind → null", parseNotifyInput({ ...DRAFT, kind: "other" }) === null);
ok("知らない判定 → null", parseNotifyInput({ ...DRAFT, verdict: "まあまあ" }) === null);
ok("知らない failReason → null", parseNotifyInput({ no: 1, kind: "failed", generation: 1, dealName: "a", failReason: "x" }) === null);
ok("no が0 → null", parseNotifyInput({ ...DRAFT, no: 0 }) === null);
ok("配列 → null", parseNotifyInput([DRAFT]) === null);

// ── 受け口 ──
const env = { JOB_API_TOKEN: KEY, TASK_SATEI: "1", TASK_SATEI_USER_IDS: `${SHIMO},${STAFF}` };
function mk(status: number | null | "throw", e: Record<string, string | undefined> = env) {
  const pushes: Array<{ to: string; messages: unknown[]; key: string }> = [];
  const logs: string[] = [];
  const deps: SateiNotifyDeps = {
    env: e,
    push: async (to, messages, key) => {
      pushes.push({ to, messages, key });
      if (status === "throw") throw new Error("boom");
      return status;
    },
    log: (l) => logs.push(l),
  };
  return { pushes, logs, deps };
}
const RAW = JSON.stringify(DRAFT);

(async () => {
  let m = mk(200);
  let r = await handleSateiNotify("0".repeat(64), RAW, m.deps);
  ok("鍵違い → 401・送らない", r.status === 401 && m.pushes.length === 0);
  r = await handleSateiNotify(null, RAW, m.deps);
  ok("ヘッダ無し → 401", r.status === 401 && m.pushes.length === 0);
  m = mk(200, { ...env, TASK_SATEI: "" });
  r = await handleSateiNotify("bad", RAW, m.deps);
  ok("off でも鍵違いは 401", r.status === 401);

  m = mk(200);
  r = await handleSateiNotify(TOKEN, RAW, m.deps);
  ok("200 → sent", r.status === 200 && r.body.result === "sent");
  ok("通知先は TASK_SATEI_USER_IDS の先頭", m.pushes[0]?.to === SHIMO);
  ok("retry key は依頼・種類・世代から", m.pushes[0]?.key === sateiRetryKey(12, "draft", 3));
  ok("draft はカード1通", m.pushes[0]?.messages.length === 1 && (m.pushes[0]?.messages[0] as { type: string }).type === "flex");
  ok("ログは J番号・kind・結果だけ", m.logs.includes("[satei] notify #J12 draft sent") && !m.logs.join("").includes("テスト") && !m.logs.join("").includes(SHIMO));

  m = mk(409);
  r = await handleSateiNotify(TOKEN, RAW, m.deps);
  ok("409 → sent（二重に届けない）", r.status === 200 && r.body.result === "sent");
  m = mk(500);
  r = await handleSateiNotify(TOKEN, RAW, m.deps);
  ok("500 → unknown", r.body.result === "unknown");
  m = mk(null);
  r = await handleSateiNotify(TOKEN, RAW, m.deps);
  ok("時間切れ（null）→ unknown", r.body.result === "unknown");
  m = mk("throw");
  r = await handleSateiNotify(TOKEN, RAW, m.deps);
  ok("例外 → unknown", r.status === 200 && r.body.result === "unknown");

  m = mk(200);
  await handleSateiNotify(TOKEN, RAW, m.deps);
  await handleSateiNotify(TOKEN, RAW, m.deps);
  ok("送り直しても同じ retry key", m.pushes.length === 2 && m.pushes[0].key === m.pushes[1].key);

  m = mk(200, { ...env, TASK_SATEI: "" });
  r = await handleSateiNotify(TOKEN, RAW, m.deps);
  ok("off → 送らず deferred（契約 6-12）", r.status === 200 && r.body.result === "deferred" && m.pushes.length === 0);
  m = mk(200, { ...env, TASK_SATEI_USER_IDS: "" });
  r = await handleSateiNotify(TOKEN, RAW, m.deps);
  ok("通知先が無い → 送らず deferred", r.body.result === "deferred" && m.pushes.length === 0);
  m = mk(200);
  r = await handleSateiNotify(TOKEN, "{not json", m.deps);
  ok("JSON でない → 400", r.status === 400 && m.pushes.length === 0);
  r = await handleSateiNotify(TOKEN, JSON.stringify({ ...DRAFT, kind: "x" }), m.deps);
  ok("形が違う → 400", r.status === 400 && m.pushes.length === 0);
  m = mk(200);
  r = await handleSateiNotify(TOKEN, JSON.stringify({ no: 7, kind: "saved", generation: 2, dealName: "テスト" }), m.deps);
  ok("saved は文字1通", r.body.result === "sent" && (m.pushes[0]?.messages[0] as { type: string }).type === "text");

  // ── line.ts の retry key つき push ──
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (st: number): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: st });
    }) as typeof fetch;
  const st = await pushMessagesWithRetryKey(SHIMO, [{ type: "text", text: "x" }], "key-1", 1000, f(409));
  const h = calls[0]?.init.headers as Record<string, string>;
  ok("push の口", calls[0]?.url === "https://api.line.me/v2/bot/message/push");
  ok("X-Line-Retry-Key を付ける", h["X-Line-Retry-Key"] === "key-1");
  ok("本文は to と messages", calls[0]?.init.body === JSON.stringify({ to: SHIMO, messages: [{ type: "text", text: "x" }] }));
  ok("状態番号を返す（409）", st === 409);
  const st2 = await pushMessagesWithRetryKey(SHIMO, [], "k", 1000, (async () => {
    throw new Error("x");
  }) as typeof fetch);
  ok("例外 → null（投げない）", st2 === null);

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx tests/satei-notify.test.ts`
Expected: FAIL（`Cannot find module '../src/lib/satei-notify'`）

- [ ] **Step 3: 実装**

`src/lib/line.ts` の**最後**に足す（`PUSH_TIMEOUT_MS` は同じファイルの上で定義済み）：

```ts
/**
 * 個人あての push（B2 査定書の通知・2026-11-11）。X-Line-Retry-Key（UUID）を付けるので、同じキーで送り直しても
 * LINE は2通目を届けず 409 を返す。返すのは HTTP の状態番号（時間切れ・通信の失敗は null。例外は投げない）。
 * 本文・宛先はログに出さない。既存の push 関数は変えていない。
 */
export async function pushMessagesWithRetryKey(
  to: string,
  messages: unknown[],
  retryKey: string,
  timeoutMs: number = PUSH_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch
): Promise<number | null> {
  try {
    const res = await fetchImpl("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "X-Line-Retry-Key": retryKey,
      },
      body: JSON.stringify({ to, messages }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!res.ok && res.status !== 409) console.error("LINE push（retry key つき）を断られた:", res.status);
    return res.status;
  } catch (err) {
    console.error("LINE push（retry key つき）の結果が分からない:", (err as { name?: string })?.name ?? "Error");
    return null;
  }
}
```

`src/lib/satei-notify.ts`：

```ts
/**
 * B2 査定書：査定係（Mac）からの通知の受け口の中身（契約 第3節）。route は src/app/api/satei/notify/route.ts。
 * - 合言葉：ヘッダ x-satei-token = HMAC-SHA256(鍵 = JOB_API_TOKEN, 文 = "satei-notify") の小文字 hex。
 *   JOB_API_TOKEN が無い・32字未満なら誰も通さない（帯替えの見回りの入口と同じ考え方）。
 * - 送り先：TASK_SATEI_USER_IDS の先頭（下村さん）。X-Line-Retry-Key = uuidv5(no:kind:generation)。
 * - LINE が 200 → sent、409（同じキーで受付済み）→ sent、それ以外・例外 → unknown。出力 {result}。
 * - TASK_SATEI が off・通知先が無いときは送らず {result:"deferred"}（契約 6-12。portal は試行回数を増やさず pending のまま）。
 * ログは `[satei] notify #J12 draft sent` の形だけ（案件名・宛先は出さない）。
 */
import { createHash, createHmac } from "node:crypto";
import { timingSafeEqualStr } from "./secure-compare";
import { sateiActive, sateiNotifyTarget } from "./satei-data";
import { sateiNoticeMessages, type SateiNotice, type SateiNoticeKind } from "./satei-text";

export const SATEI_TOKEN_HEADER = "x-satei-token";
export const SATEI_TOKEN_CONTEXT = "satei-notify";
export const SATEI_KEY_MIN_LENGTH = 32;
/** X-Line-Retry-Key の uuidv5 の名前空間（固定。変えると送り直しの二重防止が効かなくなる） */
export const SATEI_RETRY_NAMESPACE = "3f0c6a1e-8d2b-4c5e-9a71-b2d4e6f80a13";

export function sateiNotifyToken(jobApiToken: string): string {
  return createHmac("sha256", Buffer.from(jobApiToken, "utf8")).update(SATEI_TOKEN_CONTEXT, "utf8").digest("hex");
}

export function sateiNotifyAuthorized(header: string | null, jobApiToken: string | undefined): boolean {
  if (typeof jobApiToken !== "string" || jobApiToken.length < SATEI_KEY_MIN_LENGTH) return false;
  if (typeof header !== "string") return false;
  return timingSafeEqualStr(header, sateiNotifyToken(jobApiToken));
}

/** RFC 4122 の版5（SHA-1）の UUID。依存を増やさないため node:crypto で書く */
export function uuidv5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (ns.length !== 16) throw new Error("uuidv5: namespace must be a UUID");
  const h = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export function sateiRetryKey(no: number, kind: string, generation: number): string {
  return uuidv5(`${no}:${kind}:${generation}`, SATEI_RETRY_NAMESPACE);
}

const KINDS: ReadonlySet<string> = new Set<SateiNoticeKind>(["draft", "failed", "saved", "aborted"]);
const VERDICTS: ReadonlySet<string> = new Set(["そのまま出せる", "要修正", "差し戻し"]);
const FAIL_REASONS: ReadonlySet<string> = new Set([
  "materials",
  "timeout",
  "folder",
  "check",
  "internal",
  "input-changed",
  "draft-changed",
  "folder-mismatch",
  "name-conflict",
]);
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DEAL_NAME_IN_MAX = 200;

/** 文字列の配列（JSON 配列の文字列でもよい）。空・無しは []。形が違えば null */
function strList(v: unknown, max: number, len: number): string[] | null {
  let x = v;
  if (x === undefined || x === null || x === "") return [];
  if (typeof x === "string") {
    try {
      x = JSON.parse(x);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(x)) return null;
  const out: string[] = [];
  for (const s of x) {
    if (typeof s !== "string") return null;
    const t = s.trim();
    if (t) out.push(Array.from(t).slice(0, len).join(""));
  }
  return out.slice(0, max);
}

/** 任意の文字列の欄：無し・空は null、形が合えばその値、合わなければ undefined（＝入力が不正） */
function optStr(v: unknown, valid: (s: string) => boolean): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "string" && valid(v) ? v : undefined;
}

export function parseNotifyInput(body: unknown): SateiNotice | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const { no, kind, generation } = b;
  if (typeof no !== "number" || !Number.isInteger(no) || no <= 0) return null;
  if (typeof kind !== "string" || !KINDS.has(kind)) return null;
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0) return null;
  const dealName = typeof b.dealName === "string" ? Array.from(b.dealName.trim()).slice(0, DEAL_NAME_IN_MAX).join("") : "";
  const driveFileId = optStr(b.driveFileId, (s) => DRIVE_ID_RE.test(s));
  const verdict = optStr(b.verdict, (s) => VERDICTS.has(s));
  const failReason = optStr(b.failReason, (s) => FAIL_REASONS.has(s));
  const artifactSha256 = optStr(b.artifactSha256, (s) => SHA256_RE.test(s));
  const findings = strList(b.findings, 3, 120);
  const missing = strList(b.missing, 20, 60);
  if (
    driveFileId === undefined ||
    verdict === undefined ||
    failReason === undefined ||
    artifactSha256 === undefined ||
    findings === null ||
    missing === null
  ) {
    return null;
  }
  // draft はカードのボタンに要る値がそろっていること（generation は結果の登録ごとに +1 なので 1 以上）
  if (kind === "draft" && (!driveFileId || !verdict || !artifactSha256 || generation < 1)) return null;
  return {
    no,
    kind: kind as SateiNoticeKind,
    generation,
    dealName,
    driveFileId,
    verdict,
    findings,
    missing,
    failReason,
    artifactSha256,
  };
}

export type SateiPushResult = "sent" | "unknown";

export function pushResultOf(status: number | null): SateiPushResult {
  return status === 200 || status === 409 ? "sent" : "unknown";
}

export interface SateiNotifyDeps {
  env: Record<string, string | undefined>;
  /** LINE の push（retry key つき）。HTTP の状態番号、時間切れ・通信の失敗は null */
  push(to: string, messages: unknown[], retryKey: string): Promise<number | null>;
  log(line: string): void;
}

export async function handleSateiNotify(
  header: string | null,
  raw: string,
  deps: SateiNotifyDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!sateiNotifyAuthorized(header, deps.env.JOB_API_TOKEN)) {
    return { status: 401, body: { error: "Unauthorized" } };
  }
  if (!sateiActive(deps.env)) {
    deps.log("[satei] notify off");
    return { status: 200, body: { result: "deferred", skipped: "off" } };
  }
  const to = sateiNotifyTarget(deps.env);
  if (!to) {
    deps.log("[satei] notify config-missing");
    return { status: 200, body: { result: "deferred", skipped: "config" } };
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    deps.log("[satei] notify bad-input");
    return { status: 400, body: { error: "bad-input" } };
  }
  const n = parseNotifyInput(body);
  const messages = n ? sateiNoticeMessages(n) : null;
  if (!n || !messages) {
    deps.log("[satei] notify bad-input");
    return { status: 400, body: { error: "bad-input" } };
  }
  let status: number | null;
  try {
    status = await deps.push(to, messages, sateiRetryKey(n.no, n.kind, n.generation));
  } catch {
    status = null;
  }
  const result = pushResultOf(status);
  deps.log(`[satei] notify #J${n.no} ${n.kind} ${result}`);
  return { status: 200, body: { result } };
}
```

- [ ] **Step 4: 通ることを確かめ、test に足す**

```bash
npx tsx tests/satei-notify.test.ts
npx tsx tests/line-reply.test.ts      # 既存の line.ts のテストが変わらない
node -e 'const fs=require("fs");const f="package.json";const p=JSON.parse(fs.readFileSync(f,"utf8"));p.scripts.test+=" && tsx tests/satei-notify.test.ts";fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
npm test
```

- [ ] **Step 5: コミット**

```bash
git add src/lib/line.ts src/lib/satei-notify.ts tests/satei-notify.test.ts package.json
git commit -m "feat: 査定書の通知の受け口の中身と retry key つき push を足す

x-satei-token の照合、uuidv5（node:crypto）の X-Line-Retry-Key、200/409 を sent とする分け方。
off・通知先なしは送らずに deferred を返す（契約 6-12）。
line.ts は関数を1つ足しただけで、既存の push の動きは変えていない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: ボタンの処理と差し戻し理由の取り込み（satei-actions.ts）

**Files:**
- Create: `src/lib/satei-actions.ts`
- Test: `tests/satei-actions.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes：Task 2 の `isSateiUser`・`sateiActive`・`sateiReasonKey`・`SATEI_REASON_TTL`・`SATEI_REASON_MAX`・`SateiAction`、Task 4 の `judgeSateiDeal`・`SateiDeal`、Task 5 の `SateiCall`・`SateiIntakeReq`・`SateiIntakeOk`・`SateiDecideReq`・`SATEI_CODE_AWAITING_REASON`、Task 6 の文面（`MSG_SATEI_AWAITING_REASON`・`msgSateiReasonFailed`・`msgSateiReasonClosed` を含む）、`DealKv`（deal-card.ts）
- Produces：
  - `interface SateiActionDeps { dealsDbId: string | null; readDeal(dealId: string): Promise<{ deal: SateiDeal; kind: string | null } | null>; intake(req: SateiIntakeReq): Promise<SateiCall<SateiIntakeOk>>; decide(no: number, req: SateiDecideReq): Promise<SateiCall<{ status: string }>>; kv: Pick<DealKv, "set"> | null; newToken(): string; reserve(key: string): Promise<{ proceed: boolean }>; complete(key: string): Promise<void>; reply(replyToken: string, text: string): Promise<unknown>; log(line: string): void }`（`newToken` は理由の印に入れる一意の値。本物は `crypto.randomUUID()`）
  - `interface SateiPostbackEvent { replyToken: string; webhookEventId?: string; source: { userId?: string; groupId?: string } }`
  - `handleSateiPostback(action: SateiAction, ev: SateiPostbackEvent, deps: SateiActionDeps): Promise<void>`
  - `interface SateiReasonKv { get(key: string): Promise<unknown>; delIfToken(key: string, token: string): Promise<boolean> }`（「GET して token が一致したら DEL」を1回で。本物は Task 9 の Lua）
  - `interface SateiReasonDeps { kv: SateiReasonKv | null; reason(no: number, text: string): Promise<SateiCall<{ ok: true }>>; reply(replyToken: string, text: string): Promise<unknown>; log(line: string): void }`（契約 6-11：GETDEL は使わない）
  - `interface SateiReasonMessage { userId?: string; groupId?: string; text: string; replyToken: string }`
  - `handleSateiReasonText(m: SateiReasonMessage, deps: SateiReasonDeps): Promise<boolean>`（true＝理由として扱った。false＝今の流れへ）

- [ ] **Step 1: 失敗するテストを書く** `tests/satei-actions.test.ts`

```ts
/**
 * B2 査定書：ボタン（sa・so・sr）の処理と、差し戻し理由の取り込み（satei-actions.ts）。deps はすべて差し替え。
 */
import {
  handleSateiPostback,
  handleSateiReasonText,
  type SateiActionDeps,
  type SateiReasonDeps,
} from "../src/lib/satei-actions";
import { encodeSateiDecision, parseSateiData, sateiReasonKey, type SateiAction } from "../src/lib/satei-data";
import type { SateiDeal } from "../src/lib/satei-deal";
import type { SateiCall, SateiDecideReq, SateiIntakeOk, SateiIntakeReq } from "../src/lib/satei-portal";
import * as T from "../src/lib/satei-text";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};
globalThis.fetch = (async () => {
  throw new Error("このテストで外部へ通信してはいけない");
}) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const GROUP = "C" + "a".repeat(32);
const DB = "11112222333344445555666677778888";
const DEAL = "0123abcd0123456789ab0123456789ab";
const SHA = "e".repeat(64);
const GOOD: SateiDeal = {
  id: DEAL,
  name: "テスト案件",
  dealNo: 42,
  folderId: "1AbC_dEf-GhIjKlMnOp",
  propertyIds: ["p1"],
  gone: false,
  parentDbId: DB,
};

function mk(o: {
  deal?: SateiDeal | null;
  kind?: string | null;
  readThrows?: boolean;
  intake?: SateiCall<SateiIntakeOk>;
  decide?: SateiCall<{ status: string }>;
  proceed?: boolean;
  reserveThrows?: boolean;
  kv?: boolean;
} = {}) {
  const r = {
    replies: [] as string[],
    logs: [] as string[],
    intakes: [] as SateiIntakeReq[],
    decides: [] as Array<{ no: number; req: SateiDecideReq }>,
    kvSets: [] as Array<{ key: string; value: unknown; ex: number }>,
    reserved: [] as string[],
    completed: [] as string[],
    reads: 0,
  };
  const deps: SateiActionDeps = {
    dealsDbId: DB,
    readDeal: async () => {
      r.reads++;
      if (o.readThrows) throw new Error("notion");
      if (o.deal === null) return null;
      return { deal: o.deal ?? GOOD, kind: o.kind === undefined ? "マンション" : o.kind };
    },
    intake: async (req) => {
      r.intakes.push(req);
      return o.intake ?? { kind: "ok", value: { created: true, no: 5, status: "受付" } };
    },
    decide: async (no, req) => {
      r.decides.push({ no, req });
      return o.decide ?? { kind: "ok", value: { status: "完成" } };
    },
    kv:
      o.kv === false
        ? null
        : {
            set: async (key, value, ex) => {
              r.kvSets.push({ key, value, ex });
            },
          },
    newToken: () => "tok-new",
    reserve: async (k) => {
      r.reserved.push(k);
      if (o.reserveThrows) throw new Error("kv");
      return { proceed: o.proceed !== false };
    },
    complete: async (k) => {
      r.completed.push(k);
    },
    reply: async (_t, text) => {
      r.replies.push(text);
    },
    log: (l) => r.logs.push(l),
  };
  return { r, deps };
}
const ev = (userId: string = SHIMO, groupId?: string) => ({
  replyToken: "rt",
  webhookEventId: "01HEVENTID",
  source: { userId, groupId },
});
const SA = parseSateiData(`v1|sa|${DEAL}`) as SateiAction;
const SO = parseSateiData(encodeSateiDecision("so", 12, 3, SHA)) as SateiAction;
const SR = parseSateiData(encodeSateiDecision("sr", 12, 3, SHA)) as SateiAction;
const on = () => {
  process.env.TASK_SATEI = "1";
  process.env.TASK_SATEI_USER_IDS = SHIMO;
};
const quiet = (logs: string[]) => !logs.join("\n").includes(SHIMO) && !logs.join("\n").includes("テスト案件");

(async () => {
  // ── off の古いボタン ──
  delete process.env.TASK_SATEI;
  process.env.TASK_SATEI_USER_IDS = SHIMO;
  for (const a of [SA, SO, SR]) {
    const m = mk();
    await handleSateiPostback(a, ev(), m.deps);
    ok(
      `off：${a.op} は「いまは止めています」だけ（読まない・呼ばない・予約しない）`,
      m.r.replies.length === 1 &&
        m.r.replies[0] === T.MSG_SATEI_PAUSED &&
        m.r.reads === 0 &&
        m.r.intakes.length === 0 &&
        m.r.decides.length === 0 &&
        m.r.reserved.length === 0 &&
        m.r.kvSets.length === 0,
    );
  }

  // ── 下村さん以外 ──
  on();
  for (const a of [SA, SO, SR]) {
    const m = mk();
    await handleSateiPostback(a, ev(STAFF, GROUP), m.deps);
    ok(
      `下村さん以外：${a.op} は断る`,
      m.r.replies[0] === T.MSG_SATEI_FORBIDDEN && m.r.reads === 0 && m.r.intakes.length === 0 && m.r.decides.length === 0 && m.r.reserved.length === 0,
    );
  }
  process.env.TASK_SATEI_USER_IDS = "";
  {
    const m = mk();
    await handleSateiPostback(SA, ev(), m.deps);
    ok("押せる人の設定が空なら誰も押せない", m.r.replies[0] === T.MSG_SATEI_FORBIDDEN && m.r.intakes.length === 0);
  }
  on();

  // ── 作る（sa）──
  {
    const m = mk();
    await handleSateiPostback(SA, ev(SHIMO, GROUP), m.deps);
    ok("sa：受け付けた返事", m.r.replies[0] === T.msgSateiAccepted(5));
    ok(
      "sa：intake に契約の6項目",
      JSON.stringify(m.r.intakes[0]) ===
        JSON.stringify({ eventId: "01HEVENTID", dealId: DEAL, dealNo: 42, folderId: "1AbC_dEf-GhIjKlMnOp", dealName: "テスト案件", requestedBy: SHIMO }),
    );
    ok("sa：予約は pb:イベントID、終わったら完了印", m.r.reserved[0] === "pb:01HEVENTID" && m.r.completed[0] === "pb:01HEVENTID");
    ok("sa：返事に案件名を入れない", !m.r.replies[0].includes("テスト案件"));
    ok("sa：ログに案件名・userId を出さない", quiet(m.r.logs) && m.r.logs.includes("[satei] sa accepted"));
  }
  {
    const m = mk({ intake: { kind: "ok", value: { created: false, no: 4, status: "下準備中" } } });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：intake の created=false → 作成中です", m.r.replies[0] === T.msgSateiInProgress(4));
  }
  for (const kind of ["戸建", "土地", null]) {
    const m = mk({ kind });
    await handleSateiPostback(SA, ev(), m.deps);
    ok(`sa：種別 ${kind ?? "不明"} → マンションだけ`, m.r.replies[0] === T.MSG_SATEI_NOT_MANSION && m.r.intakes.length === 0);
  }
  {
    const m = mk({ deal: { ...GOOD, folderId: null } });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：フォルダ未設定 → 未設定です", m.r.replies[0] === T.MSG_SATEI_NO_FOLDER && m.r.intakes.length === 0);
  }
  {
    const m = mk({ deal: null });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：案件が無い → 読み取れませんでした", m.r.replies[0] === T.MSG_SATEI_DEAL_NOT_FOUND && m.r.intakes.length === 0);
  }
  {
    const m = mk({ deal: { ...GOOD, parentDbId: "99990000000000000000000000000000" } });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：CRM_案件 でないページ → 読み取れませんでした", m.r.replies[0] === T.MSG_SATEI_DEAL_NOT_FOUND && m.r.intakes.length === 0);
  }
  {
    const m = mk({ readThrows: true });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：Notion が読めない → 読み取れませんでした・完了印なし", m.r.replies[0] === T.MSG_SATEI_DEAL_NOT_FOUND && m.r.completed.length === 0);
  }
  {
    const m = mk();
    m.deps.dealsDbId = null;
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：CRM_DEALS_DB_ID 未設定 → 読み取れませんでした・Notion を読まない", m.r.replies[0] === T.MSG_SATEI_DEAL_NOT_FOUND && m.r.reads === 0);
  }
  {
    const m = mk({ intake: { kind: "rejected", status: 400, code: "BAD" } });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：intake に断られた → 受け付けられませんでした", m.r.replies[0] === T.MSG_SATEI_FAILED);
  }
  {
    const m = mk({ intake: { kind: "rejected", status: 409, code: "SATEI_AWAITING_REASON" } });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：同じ案件が差し戻しの理由待ち → 理由を待っています（契約 6-10）", m.r.replies[0] === T.MSG_SATEI_AWAITING_REASON);
  }
  {
    const m = mk({ intake: { kind: "unknown", reason: "timeout" } });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：intake が分からない → 確かめられませんでした・完了印なし", m.r.replies[0] === T.MSG_SATEI_UNKNOWN && m.r.completed.length === 0);
  }
  {
    const m = mk({ proceed: false });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("二度押し（同じイベント）→ 何もしない", m.r.replies.length === 0 && m.r.reads === 0 && m.r.intakes.length === 0);
  }
  {
    const m = mk({ reserveThrows: true });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("予約できない → いま受け付けられません", m.r.replies[0] === T.MSG_SATEI_BUSY && m.r.intakes.length === 0);
  }
  {
    const m = mk();
    await handleSateiPostback(SA, { replyToken: "rt", source: { userId: SHIMO } }, m.deps);
    ok("イベント ID が無い → 受け付けない", m.r.replies[0] === T.MSG_SATEI_FAILED && m.r.intakes.length === 0);
  }

  // ── OK（so）──
  {
    const m = mk();
    await handleSateiPostback(SO, ev(), m.deps);
    ok(
      "so：sha・generation を portal に渡す",
      m.r.decides[0]?.no === 12 &&
        JSON.stringify(m.r.decides[0]?.req) === JSON.stringify({ decision: "ok", by: SHIMO, artifactSha256: SHA, generation: 3 }),
    );
    ok("so：返事", m.r.replies[0] === T.msgSateiOk(12));
    ok("so：理由の印は置かない", m.r.kvSets.length === 0);
  }
  // ── 差し戻し（sr）──
  {
    const m = mk({ decide: { kind: "ok", value: { status: "差し戻し" } } });
    await handleSateiPostback(SR, ev(), m.deps);
    ok(
      "sr：decision=reject で sha・generation を渡す",
      JSON.stringify(m.r.decides[0]?.req) === JSON.stringify({ decision: "reject", by: SHIMO, artifactSha256: SHA, generation: 3 }),
    );
    ok(
      "sr：理由の印（no と一意の token）を30分置く",
      m.r.kvSets[0]?.key === sateiReasonKey(SHIMO) && JSON.stringify(m.r.kvSets[0]?.value) === JSON.stringify({ no: 12, token: "tok-new" }) && m.r.kvSets[0]?.ex === 1800,
    );
    ok("sr：理由を聞く返事", m.r.replies[0] === T.msgSateiRejectAsk(12));
  }
  {
    const m = mk({ kv: false });
    await handleSateiPostback(SR, ev(), m.deps);
    ok("sr：KV が無い → 差し戻しだけ伝える", m.r.replies[0] === T.msgSateiRejected(12));
  }
  {
    const m = mk({ decide: { kind: "rejected", status: 409, code: "SATEI_MISMATCH" } });
    await handleSateiPostback(SR, ev(), m.deps);
    ok("sr：409（版違い・処理済み）→ 古い下書き・印を置かない", m.r.replies[0] === T.msgSateiStale(12) && m.r.kvSets.length === 0);
  }
  {
    const m = mk({ decide: { kind: "rejected", status: 400, code: "BAD" } });
    await handleSateiPostback(SO, ev(), m.deps);
    ok("so：409 以外の断り → 受け付けられませんでした", m.r.replies[0] === T.MSG_SATEI_FAILED);
  }
  {
    const m = mk({ decide: { kind: "unknown", reason: "timeout" } });
    await handleSateiPostback(SO, ev(), m.deps);
    ok("so：分からない → 確かめられませんでした・完了印なし", m.r.replies[0] === T.MSG_SATEI_UNKNOWN && m.r.completed.length === 0);
  }

  // ── 差し戻し理由の取り込み ──
  type Mark = { no: number; token: string };
  const MA: Mark = { no: 12, token: "tok-A" };
  function mkR(
    o: {
      mark?: unknown;
      reasons?: Array<SateiCall<{ ok: true }>>;
      kv?: boolean;
      getThrows?: boolean;
      delThrows?: boolean;
      /** reason の応答待ちのあいだに起きること（別の差し戻しが印を書き換える、など） */
      during?: (store: Map<string, unknown>) => void;
    } = {},
  ) {
    const store = new Map<string, unknown>();
    if (o.mark !== undefined) store.set(sateiReasonKey(SHIMO), o.mark);
    const results = [...(o.reasons ?? [])];
    const r = {
      gets: [] as string[],
      dels: [] as Array<{ key: string; token: string }>,
      reasons: [] as Array<{ no: number; text: string }>,
      replies: [] as string[],
      logs: [] as string[],
    };
    const deps: SateiReasonDeps = {
      kv:
        o.kv === false
          ? null
          : {
              get: async (k) => {
                r.gets.push(k);
                if (o.getThrows) throw new Error("kv");
                return store.get(k) ?? null;
              },
              // 本物は Lua（GET して token が一致したら DEL）で1回に行う。ここでは同じ約束を Map で
              delIfToken: async (k, token) => {
                r.dels.push({ key: k, token });
                if (o.delThrows) throw new Error("kv");
                const v = store.get(k) as { token?: unknown } | undefined;
                if (v && v.token === token) {
                  store.delete(k);
                  return true;
                }
                return false;
              },
            },
      reason: async (no, text) => {
        r.reasons.push({ no, text });
        o.during?.(store);
        return results.shift() ?? { kind: "ok", value: { ok: true } };
      },
      reply: async (_t, text) => {
        r.replies.push(text);
      },
      log: (l) => r.logs.push(l),
    };
    return { r, deps, store };
  }
  const msg = (over: Partial<{ userId: string; groupId: string; text: string }> = {}) => ({
    userId: SHIMO,
    text: "事例が古い",
    replyToken: "rt",
    ...over,
  });

  const KEY = sateiReasonKey(SHIMO);
  delete process.env.TASK_SATEI;
  {
    const m = mkR({ mark: MA });
    ok("理由：off → 今の流れへ・KV を読まない", (await handleSateiReasonText(msg(), m.deps)) === false && m.r.gets.length === 0);
  }
  on();
  {
    const m = mkR({ mark: MA });
    ok("理由：グループの発言は横取りしない・KV を読まない", (await handleSateiReasonText(msg({ groupId: GROUP }), m.deps)) === false && m.r.gets.length === 0);
  }
  {
    const m = mkR({ mark: MA });
    ok("理由：下村さん以外の1対1は横取りしない・KV を読まない", (await handleSateiReasonText(msg({ userId: STAFF }), m.deps)) === false && m.r.gets.length === 0);
  }
  {
    const m = mkR();
    ok(
      "理由：印が無ければ今の流れへ（reason を呼ばない・返事しない・消さない）",
      (await handleSateiReasonText(msg(), m.deps)) === false && m.r.reasons.length === 0 && m.r.replies.length === 0 && m.r.dels.length === 0,
    );
  }
  {
    const m = mkR({ mark: MA });
    const first = await handleSateiReasonText(msg(), m.deps);
    ok("理由：印があれば reason に送る", first === true && JSON.stringify(m.r.reasons) === JSON.stringify([{ no: 12, text: "事例が古い" }]));
    ok("理由：成功してから、読んだ印の token を付けて消す", JSON.stringify(m.r.dels) === JSON.stringify([{ key: KEY, token: "tok-A" }]) && !m.store.has(KEY));
    ok("理由：記録しました", m.r.replies[0] === T.msgSateiReasonSaved(12));
    ok("理由：ログは J番号と結果だけ", m.r.logs.includes("[satei] reason #J12 saved") && !m.r.logs.join("").includes("事例") && !m.r.logs.join("").includes("tok-A"));
    const second = await handleSateiReasonText(msg({ text: "次の依頼" }), m.deps);
    ok("理由：次の発言は横取りしない（成功で印が消えた）", second === false && m.r.reasons.length === 1);
  }
  {
    // ③ A の reason の応答待ちのあいだに、差し戻し B が印を書き換える → A のあとも B の印が残る
    const MB: Mark = { no: 13, token: "tok-B" };
    const m = mkR({ mark: MA, during: (s) => s.set(KEY, MB) });
    await handleSateiReasonText(msg(), m.deps);
    ok("理由：A の処理中に B が印を更新すると、A のあとも B の印が残る", JSON.stringify(m.store.get(KEY)) === JSON.stringify(MB));
    ok("理由：A は自分の token でだけ消そうとする", JSON.stringify(m.r.dels) === JSON.stringify([{ key: KEY, token: "tok-A" }]));
    const next = await handleSateiReasonText(msg({ text: "B の理由" }), m.deps);
    ok("理由：次の1通は B の理由になる", next === true && m.r.reasons[1]?.no === 13 && m.r.reasons[1]?.text === "B の理由" && !m.store.has(KEY));
  }
  {
    // 契約 6-11：通信の失敗では印を残し、もう一度送ってもらう
    const m = mkR({ mark: MA, reasons: [{ kind: "unknown", reason: "network" }] });
    const first = await handleSateiReasonText(msg(), m.deps);
    ok("理由：通信失敗 → 記録できませんでした。もう一度送ってください", first === true && m.r.replies[0] === T.msgSateiReasonFailed(12));
    ok("理由：通信失敗では印が残る（消さない）", m.r.dels.length === 0 && m.store.has(KEY));
    const again = await handleSateiReasonText(msg({ text: "事例が古い（再送）" }), m.deps);
    ok(
      "理由：残った印で次の1通をもう一度受け、成功したら消す",
      again === true && m.r.reasons.length === 2 && m.r.reasons[1].text === "事例が古い（再送）" && !m.store.has(KEY) && m.r.replies[1] === T.msgSateiReasonSaved(12),
    );
  }
  for (const [label, res] of [
    ["設定不足（status 0）", { kind: "rejected", status: 0, code: "CONFIG" }],
    ["5xx", { kind: "rejected", status: 503, code: "HTTP_503" }],
    ["結果不明", { kind: "unknown", reason: "http-500" }],
  ] as Array<[string, SateiCall<{ ok: true }>]>) {
    // ④ 印を消すのは portal が実際に 4xx を返したときだけ
    const m = mkR({ mark: MA, reasons: [res] });
    const r1 = await handleSateiReasonText(msg(), m.deps);
    ok(`理由：${label}で印が残る・もう一度送ってください`, r1 === true && m.r.replies[0] === T.msgSateiReasonFailed(12) && m.r.dels.length === 0 && m.store.has(KEY));
  }
  {
    const m = mkR({ mark: MA });
    m.deps.reason = async () => {
      throw new Error("boom");
    };
    const r1 = await handleSateiReasonText(msg(), m.deps);
    ok("理由：例外で印が残る・もう一度送ってください", r1 === true && m.r.replies[0] === T.msgSateiReasonFailed(12) && m.store.has(KEY));
  }
  {
    const m = mkR({ mark: MA, reasons: [{ kind: "rejected", status: 409, code: "SATEI_STALE" }] });
    const r1 = await handleSateiReasonText(msg(), m.deps);
    ok("理由：4xx ではっきり断られた → 閉じていますと返し印を消す", r1 === true && m.r.replies[0] === T.msgSateiReasonClosed(12) && !m.store.has(KEY));
    ok("理由：断られたあとの発言は横取りしない", (await handleSateiReasonText(msg({ text: "次" }), m.deps)) === false);
  }
  {
    const m = mkR({ mark: MA, delThrows: true });
    ok("理由：成功後に印を消せなくても記録しましたと返す", (await handleSateiReasonText(msg(), m.deps)) === true && m.r.replies[0] === T.msgSateiReasonSaved(12) && m.r.logs.includes("[satei] reason clear-failed"));
  }
  {
    const m = mkR({ mark: MA });
    await handleSateiReasonText(msg({ text: "あ".repeat(250) }), m.deps);
    ok("理由：200字に切る", Array.from(m.r.reasons[0]?.text ?? "").length === 200);
  }
  {
    const m = mkR({ mark: MA });
    ok("理由：空白だけの発言は使わない・KV も読まない", (await handleSateiReasonText(msg({ text: "   " }), m.deps)) === false && m.r.gets.length === 0);
  }
  for (const bad of ["12", { no: 12 }, { no: 12, token: "" }, { no: 0, token: "t" }]) {
    const m = mkR({ mark: bad });
    ok(`理由：印の形が違えば今の流れへ（${JSON.stringify(bad)}）`, (await handleSateiReasonText(msg(), m.deps)) === false && m.r.reasons.length === 0);
  }
  {
    const m = mkR({ mark: MA, kv: false });
    ok("理由：KV が無ければ今の流れへ", (await handleSateiReasonText(msg(), m.deps)) === false);
  }
  {
    const m = mkR({ mark: MA, getThrows: true });
    ok("理由：KV が読めなければ今の流れへ", (await handleSateiReasonText(msg(), m.deps)) === false && m.r.reasons.length === 0);
  }
  delete process.env.TASK_SATEI;
  delete process.env.TASK_SATEI_USER_IDS;

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx tests/satei-actions.test.ts`
Expected: FAIL（`Cannot find module '../src/lib/satei-actions'`）

- [ ] **Step 3: 実装** `src/lib/satei-actions.ts`

```ts
/**
 * B2 査定書：ボタン（v1|sa|・v1|so|・v1|sr|）の処理と、差し戻し理由（次の1対1の文字）の取り込み。
 * 本物の Notion・portal・LINE・KV は satei-wire.ts。ここは deps を受け取るだけ。
 * 順番：TASK_SATEI off →「いまは止めています」だけ／押した人が TASK_SATEI_USER_IDS に無い →「いまは下村さんだけ」
 * → `pb:<webhookEventId>` の予約（二度押し・再送は何もしない）→ 処理。
 * ログは `[satei] sa accepted` の形（操作名・結果の符号・J番号だけ。案件名・userId・本文は出さない）。
 */
import type { DealKv } from "./deal-card";
import {
  isSateiUser,
  sateiActive,
  sateiReasonKey,
  SATEI_REASON_MAX,
  SATEI_REASON_TTL,
  type SateiAction,
} from "./satei-data";
import { judgeSateiDeal, type SateiDeal } from "./satei-deal";
import {
  SATEI_CODE_AWAITING_REASON,
  type SateiCall,
  type SateiDecideReq,
  type SateiIntakeOk,
  type SateiIntakeReq,
} from "./satei-portal";
import {
  MSG_SATEI_AWAITING_REASON,
  MSG_SATEI_BUSY,
  MSG_SATEI_DEAL_NOT_FOUND,
  MSG_SATEI_FAILED,
  MSG_SATEI_FORBIDDEN,
  MSG_SATEI_NO_FOLDER,
  MSG_SATEI_NOT_MANSION,
  MSG_SATEI_PAUSED,
  MSG_SATEI_UNKNOWN,
  msgSateiAccepted,
  msgSateiInProgress,
  msgSateiOk,
  msgSateiReasonClosed,
  msgSateiReasonFailed,
  msgSateiReasonSaved,
  msgSateiRejectAsk,
  msgSateiRejected,
  msgSateiStale,
} from "./satei-text";

export interface SateiActionDeps {
  /** CRM_DEALS_DB_ID（無ければ案件を読まずに「読み取れませんでした」） */
  dealsDbId: string | null;
  /** 案件ページと、物件の1件目の種別。ページが無ければ null。読めなければ例外 */
  readDeal(dealId: string): Promise<{ deal: SateiDeal; kind: string | null } | null>;
  intake(req: SateiIntakeReq): Promise<SateiCall<SateiIntakeOk>>;
  decide(no: number, req: SateiDecideReq): Promise<SateiCall<{ status: string }>>;
  /** 差し戻し理由の印を置く KV（設定が無ければ null） */
  kv: Pick<DealKv, "set"> | null;
  /** 印に入れる一意の値（あとで「自分が読んだ印」だけを消すため。本物は crypto.randomUUID） */
  newToken(): string;
  reserve(key: string): Promise<{ proceed: boolean }>;
  complete(key: string): Promise<void>;
  reply(replyToken: string, text: string): Promise<unknown>;
  log(line: string): void;
}

export interface SateiPostbackEvent {
  replyToken: string;
  webhookEventId?: string;
  source: { userId?: string; groupId?: string };
}

interface Outcome {
  text: string;
  code: string;
  /** false＝結果が分からない・読めなかった（完了印を付けない） */
  settled: boolean;
}

async function startSatei(
  dealId: string,
  eventId: string,
  userId: string,
  deps: SateiActionDeps,
): Promise<Outcome> {
  if (!deps.dealsDbId) return { text: MSG_SATEI_DEAL_NOT_FOUND, code: "config-missing", settled: true };
  let got: { deal: SateiDeal; kind: string | null } | null;
  try {
    got = await deps.readDeal(dealId);
  } catch {
    return { text: MSG_SATEI_DEAL_NOT_FOUND, code: "read-failed", settled: false };
  }
  const j = judgeSateiDeal(got?.deal ?? null, got?.kind ?? null, deps.dealsDbId);
  if (!j.ok) {
    const text =
      j.reason === "not-mansion"
        ? MSG_SATEI_NOT_MANSION
        : j.reason === "no-folder"
          ? MSG_SATEI_NO_FOLDER
          : MSG_SATEI_DEAL_NOT_FOUND;
    return { text, code: j.reason, settled: true };
  }
  let r: SateiCall<SateiIntakeOk>;
  try {
    r = await deps.intake({
      eventId,
      dealId: j.deal.id,
      dealNo: j.deal.dealNo,
      folderId: j.deal.folderId,
      dealName: j.deal.name,
      requestedBy: userId,
    });
  } catch {
    r = { kind: "unknown", reason: "exception" };
  }
  if (r.kind === "ok") {
    return r.value.created
      ? { text: msgSateiAccepted(r.value.no), code: "accepted", settled: true }
      : { text: msgSateiInProgress(r.value.no), code: "in-progress", settled: true };
  }
  if (r.kind === "rejected") {
    // 契約 6-10：同じ案件が差し戻しで理由待ち（理由が来るか、30分で sweep が取消にするまで）
    return r.code === SATEI_CODE_AWAITING_REASON
      ? { text: MSG_SATEI_AWAITING_REASON, code: "awaiting-reason", settled: true }
      : { text: MSG_SATEI_FAILED, code: "rejected", settled: true };
  }
  return { text: MSG_SATEI_UNKNOWN, code: "unknown", settled: false };
}

async function decideSatei(
  a: Extract<SateiAction, { op: "so" | "sr" }>,
  userId: string,
  deps: SateiActionDeps,
): Promise<Outcome> {
  let r: SateiCall<{ status: string }>;
  try {
    r = await deps.decide(a.no, {
      decision: a.op === "so" ? "ok" : "reject",
      by: userId,
      artifactSha256: a.sha256,
      generation: a.generation,
    });
  } catch {
    r = { kind: "unknown", reason: "exception" };
  }
  if (r.kind === "rejected") {
    return r.status === 409
      ? { text: msgSateiStale(a.no), code: "stale", settled: true }
      : { text: MSG_SATEI_FAILED, code: "rejected", settled: true };
  }
  if (r.kind === "unknown") return { text: MSG_SATEI_UNKNOWN, code: "unknown", settled: false };
  if (a.op === "so") return { text: msgSateiOk(a.no), code: "ok", settled: true };
  // 差し戻し：次の1対1の文字を理由として受ける印（30分）。置けなければ理由は聞かない
  if (deps.kv) {
    try {
      await deps.kv.set(sateiReasonKey(userId), { no: a.no, token: deps.newToken() }, SATEI_REASON_TTL);
      return { text: msgSateiRejectAsk(a.no), code: "rejected-ask", settled: true };
    } catch {
      deps.log("[satei] sr reason-wait-failed");
    }
  }
  return { text: msgSateiRejected(a.no), code: "rejected-no-ask", settled: true };
}

/** satei のボタンが押されたとき。例外は投げない（返事で知らせる） */
export async function handleSateiPostback(
  action: SateiAction,
  ev: SateiPostbackEvent,
  deps: SateiActionDeps,
): Promise<void> {
  const say = async (text: string, code: string) => {
    try {
      await deps.reply(ev.replyToken, text);
    } catch {
      deps.log(`[satei] reply-failed ${action.op} ${code}`);
    }
  };
  if (!sateiActive()) {
    deps.log(`[satei] ${action.op} paused`);
    await say(MSG_SATEI_PAUSED, "paused");
    return;
  }
  const userId = ev.source.userId;
  if (!userId || !isSateiUser(userId)) {
    deps.log(`[satei] ${action.op} forbidden`);
    await say(MSG_SATEI_FORBIDDEN, "forbidden");
    return;
  }
  const eventId = ev.webhookEventId;
  if (!eventId) {
    deps.log(`[satei] ${action.op} no-event-id`);
    await say(MSG_SATEI_FAILED, "no-event-id");
    return;
  }
  const key = `pb:${eventId}`;
  let claim: { proceed: boolean };
  try {
    claim = await deps.reserve(key);
  } catch {
    deps.log(`[satei] ${action.op} reserve-failed`);
    await say(MSG_SATEI_BUSY, "busy");
    return;
  }
  if (!claim.proceed) {
    deps.log(`[satei] ${action.op} duplicate`);
    return;
  }
  let settled = false;
  try {
    const r =
      action.op === "sa"
        ? await startSatei(action.dealId, eventId, userId, deps)
        : await decideSatei(action, userId, deps);
    settled = r.settled;
    deps.log(`[satei] ${action.op} ${r.code}`);
    await say(r.text, r.code);
  } finally {
    // 結果が分からないときは完了印を付けない（予約は残す。押し直しは新しいイベント ID で通る）
    if (settled) await deps.complete(key).catch(() => deps.log(`[satei] mark-failed ${action.op}`));
  }
}

/**
 * 理由の印の KV。契約 6-11 のとおり GETDEL は使わず、読む（get）→ reason の結果を見てから消す。
 * 消すのは「今の値が読んだときと同じ token のときだけ」を1回で（delIfToken）。reason の応答待ちのあいだに
 * 別の差し戻しが印を書き換えても、その新しい印は消さない。
 */
export interface SateiReasonKv {
  get(key: string): Promise<unknown>;
  /** 今の値の token が一致したら消して true。違う・無ければ何もせず false */
  delIfToken(key: string, token: string): Promise<boolean>;
}

export interface SateiReasonDeps {
  kv: SateiReasonKv | null;
  reason(no: number, text: string): Promise<SateiCall<{ ok: true }>>;
  reply(replyToken: string, text: string): Promise<unknown>;
  log(line: string): void;
}

export interface SateiReasonMessage {
  userId?: string;
  groupId?: string;
  text: string;
  replyToken: string;
}

/**
 * 1対1の文字メッセージを、差し戻し理由として受けるか。true＝受けた（返事も済み）、false＝今の流れへ。
 * 受けるのは TASK_SATEI=1・1対1・TASK_SATEI_USER_IDS の人・空でない文字・印（`satei:reason:<userId>`）があるときだけ。
 * それ以外は KV も読まない。
 * 契約 6-11：印は消さずに reason を呼ぶ。
 *   ok       → 印を消して「理由を記録しました」
 *   unknown  → 印を残して「記録できませんでした。もう一度送ってください」（次の1通をもう一度理由として受ける。印は30分で消える）
 *   rejected で status が 4xx → portal が実際に断った（30分を過ぎて取消・もう理由が入っている）。もう一度送っても通らないので
 *              印を消し、「この差し戻しはもう閉じています」（印を残すと、その後の1対1の発言を30分まで吸い込み続けるため）
 *   それ以外（status 0＝設定不足・5xx・unknown・例外）→ 通信できなかったものとして印を残し「もう一度送ってください」
 * 消すときは読んだ印の token を付けて delIfToken（別の差し戻しが書き換えた新しい印は消さない）。
 */
export async function handleSateiReasonText(m: SateiReasonMessage, deps: SateiReasonDeps): Promise<boolean> {
  if (!sateiActive() || m.groupId || !m.userId || !isSateiUser(m.userId) || !deps.kv) return false;
  const text = Array.from((m.text ?? "").trim()).slice(0, SATEI_REASON_MAX).join("");
  if (!text) return false;
  const key = sateiReasonKey(m.userId);
  let v: unknown;
  try {
    v = await deps.kv.get(key);
  } catch {
    deps.log("[satei] reason read-failed");
    return false;
  }
  const mark = v && typeof v === "object" ? (v as { no?: unknown; token?: unknown }) : null;
  const no = mark?.no;
  const token = mark?.token;
  if (typeof no !== "number" || !Number.isInteger(no) || no <= 0) return false;
  if (typeof token !== "string" || !token) return false;
  let r: SateiCall<{ ok: true }>;
  try {
    r = await deps.reason(no, text);
  } catch {
    r = { kind: "unknown", reason: "exception" };
  }
  // 印を消すのは、記録できたときと、portal が実際に 4xx で断ったときだけ
  const closed = r.kind === "rejected" && r.status >= 400 && r.status < 500;
  const outcome = r.kind === "ok" ? "saved" : closed ? "closed" : "retry";
  deps.log(`[satei] reason #J${no} ${outcome}`);
  if (outcome !== "retry") {
    try {
      await deps.kv.delIfToken(key, token);
    } catch {
      // 消せなくても次の1通は reason が「もう入っている」と 4xx で断り、そこで消える
      deps.log("[satei] reason clear-failed");
    }
  }
  const reply =
    outcome === "saved" ? msgSateiReasonSaved(no) : outcome === "closed" ? msgSateiReasonClosed(no) : msgSateiReasonFailed(no);
  try {
    await deps.reply(m.replyToken, reply);
  } catch {
    deps.log("[satei] reply-failed reason");
  }
  return true;
}
```

- [ ] **Step 4: 通ることを確かめ、test に足す**

```bash
npx tsx tests/satei-actions.test.ts
node -e 'const fs=require("fs");const f="package.json";const p=JSON.parse(fs.readFileSync(f,"utf8"));p.scripts.test+=" && tsx tests/satei-actions.test.ts";fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
npm test
```

- [ ] **Step 5: コミット**

```bash
git add src/lib/satei-actions.ts tests/satei-actions.test.ts package.json
git commit -m "feat: 査定書のボタンの処理と差し戻し理由の取り込みを足す

本人確認・off の古いボタン・種別とフォルダの判定・intake/decide の結果ごとの返事・理由の印（30分）。
理由の印は reason が成功するか portal が 4xx で断ったときだけ、読んだ token と同じなら消す（契約 6-11・レビュー③④）。差し戻しの理由待ちの intake は専用の返事（6-10）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 本物につなぐ（satei-wire.ts・postback の振り分け・通知の route）

**Files:**
- Create: `src/lib/satei-wire.ts`
- Create: `src/app/api/satei/notify/route.ts`
- Modify: `src/lib/task-buttons-wire.ts`（import・`PostbackIo` に `satei?`・`handleTaskPostbackEvent` の io の組み立ての直後に振り分け）
- Test: `tests/satei-postback-wire.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes：Task 2〜8 のすべて、`defaultDealKv()`（deal-card-wire.ts）、`reserveEvent`・`completeEvent`（email/session.ts）、`replyTextAndCard`・`sendLineMessage`・`pushMessagesWithRetryKey`（line.ts）
- Produces：
  - `readSateiDealReal(dealId: string): Promise<{ deal: SateiDeal; kind: string | null } | null>`
  - `sateiActionDeps(): SateiActionDeps`
  - `sateiReasonKv(): SateiReasonKv | null`（get と、Upstash の EVAL で「GET して token を含めば DEL」の delIfToken）
  - `sateiReasonDeps(): SateiReasonDeps`
  - `sateiNotifyDeps(): SateiNotifyDeps`
  - `PostbackIo.satei?: Partial<SateiActionDeps>`（テスト用の差し替え）
  - `POST /api/satei/notify`

- [ ] **Step 1: 失敗するテストを書く** `tests/satei-postback-wire.test.ts`

```ts
/**
 * B2 査定書：postback の入口（handleTaskPostbackEvent）の振り分け。satei の data だけを satei に回し、
 * ほかのボタンの扱いは今と同じであることを確かめる。外部へ通信したら失敗。
 */
import { Client } from "@notionhq/client";
import { handleTaskPostbackEvent, type PostbackEventLike } from "../src/lib/task-buttons-wire";
import { MSG_PAUSED, type ButtonDeps } from "../src/lib/task-buttons";
import type { SateiActionDeps } from "../src/lib/satei-actions";
import type { SateiDeal } from "../src/lib/satei-deal";
import { MSG_SATEI_PAUSED, msgSateiAccepted } from "../src/lib/satei-text";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};
let outside = 0;
globalThis.fetch = (async () => {
  outside++;
  throw new Error("このテストで外部へ通信してはいけない");
}) as typeof fetch;
Client.prototype.request = (async () => {
  outside++;
  throw new Error("このテストで Notion へ通信してはいけない");
}) as typeof Client.prototype.request;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const SHIMO = "U" + "b".repeat(32);
const DB = "11112222333344445555666677778888";
const DEAL = "0123abcd0123456789ab0123456789ab";
const PAGE = "0123abcd-0123-4567-89ab-0123456789ab";
const GOOD: SateiDeal = { id: DEAL, name: "テスト案件", dealNo: 42, folderId: "1AbC_dEf-GhIjKlMnOp", propertyIds: ["p"], gone: false, parentDbId: DB };

const replies: string[] = [];
const intakes: number[] = [];
const ev = (data: string): PostbackEventLike => ({
  type: "postback",
  replyToken: "rt",
  webhookEventId: `ev-${Math.random()}`,
  source: { userId: SHIMO, groupId: "C" + "a".repeat(32) },
  postback: { data },
});
const satei: Partial<SateiActionDeps> = {
  dealsDbId: DB,
  readDeal: async () => ({ deal: GOOD, kind: "マンション" }),
  intake: async () => {
    intakes.push(1);
    return { kind: "ok", value: { created: true, no: 5, status: "受付" } };
  },
  decide: async () => ({ kind: "ok", value: { status: "完成" } }),
  kv: null,
};
const over = {
  deps: {} as ButtonDeps,
  reply: async (_t: string, text: string) => {
    replies.push(text);
    return { textId: "m1", cardId: null };
  },
  reserve: async () => ({ proceed: true }),
  complete: async () => undefined,
  cardRefs: null,
  log: () => undefined,
  satei,
};
const reset = () => {
  replies.length = 0;
  intakes.length = 0;
};

(async () => {
  // タスクのボタン・メニューは off のまま
  delete process.env.TASK_BUTTONS;
  delete process.env.TASK_FOLLOWUP;
  delete process.env.TASK_MENU;
  process.env.TASK_SATEI_USER_IDS = SHIMO;

  delete process.env.TASK_SATEI;
  reset();
  await handleTaskPostbackEvent(ev(`v1|sa|${PAGE}`), over);
  ok("TASK_SATEI off：古い［査定書を作る］は「いまは止めています」", replies[0] === MSG_SATEI_PAUSED && intakes.length === 0);
  reset();
  await handleTaskPostbackEvent(ev("v1|lt|0"), over);
  ok("TASK_SATEI off：メニューのボタンは今と同じ（止めています）", replies[0] === MSG_PAUSED);

  process.env.TASK_SATEI = "1";
  reset();
  await handleTaskPostbackEvent(ev(`v1|sa|${PAGE}`), over);
  ok("TASK_SATEI=1：TASK_BUTTONS が off でも satei は動く", replies[0] === msgSateiAccepted(5) && intakes.length === 1);
  reset();
  await handleTaskPostbackEvent(ev(`v1|done|${PAGE}`), over);
  ok("TASK_SATEI=1：タスクのボタンは今と同じ（止めています）", replies[0] === MSG_PAUSED && intakes.length === 0);
  reset();
  await handleTaskPostbackEvent(ev("v1|lt|0"), over);
  ok("TASK_SATEI=1：メニューのボタンは今と同じ（止めています）", replies[0] === MSG_PAUSED);
  reset();
  await handleTaskPostbackEvent(ev("x|sa|y"), over);
  ok("v1| で始まらない data は何もしない", replies.length === 0);

  ok("外部への通信は0回", outside === 0, String(outside));
  delete process.env.TASK_SATEI;
  delete process.env.TASK_SATEI_USER_IDS;

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx tests/satei-postback-wire.test.ts`
Expected: FAIL（`TASK_SATEI off：古い［査定書を作る］は…` が MSG_PAUSED になる、`TASK_SATEI=1：TASK_BUTTONS が off でも…` が FAIL。型エラー `satei` が `PostbackIo` に無い、で落ちてもよい）

- [ ] **Step 3: 実装**

`src/lib/satei-wire.ts`：

```ts
/**
 * B2 査定書：satei-actions.ts・satei-notify.ts を本物の Notion・portal・LINE・KV・予約につなぐ。
 * - 案件：CRM_NOTION_TOKEN（無ければ NOTION_API_KEY）で CRM_案件 のページと、`物件` の1件目の CRM_物件 を読む（書かない）。
 * - portal：PORTAL_BASE_URL・JOB_API_TOKEN（帯替えと同じ）。そろわなければ呼ばずに断り扱い（ログ config-missing portal）。
 * - KV：deal-card-wire.ts の defaultDealKv（URL と TOKEN の両方があるときだけ）。
 * ログは出さない（呼ぶ側が操作名と結果の符号だけ出す）。例外：config-missing の1行。
 */
import { randomUUID } from "node:crypto";
import { Client } from "@notionhq/client";
import { kv } from "@vercel/kv";
import { pushMessagesWithRetryKey, replyTextAndCard, sendLineMessage } from "./line";
import { defaultDealKv } from "./deal-card-wire";
import { completeEvent, reserveEvent } from "./email/session";
import { readPropertyKind, readSateiDealPage, type SateiDeal } from "./satei-deal";
import {
  sateiDecide,
  sateiIntake,
  sateiPortalConfig,
  sateiReason,
  SATEI_PORTAL_TIMEOUT_MS,
  type SateiCall,
  type SateiPortalOpts,
} from "./satei-portal";
import type { SateiActionDeps, SateiReasonDeps, SateiReasonKv } from "./satei-actions";
import type { SateiNotifyDeps } from "./satei-notify";

const crmNotion = new Client({ auth: process.env.CRM_NOTION_TOKEN ?? process.env.NOTION_API_KEY });
const log = (line: string) => console.log(line);

async function retrieve(pageId: string): Promise<Record<string, unknown> | null> {
  try {
    return (await crmNotion.pages.retrieve({ page_id: pageId })) as unknown as Record<string, unknown>;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "object_not_found" || code === "validation_error") return null;
    throw err;
  }
}

/** 案件ページと物件の1件目の種別。案件ページが無ければ null。物件が読めない・無ければ kind は null */
export async function readSateiDealReal(
  dealId: string,
): Promise<{ deal: SateiDeal; kind: string | null } | null> {
  const page = await retrieve(dealId);
  if (!page) return null;
  const deal = readSateiDealPage(page);
  const propertyId = deal.propertyIds[0];
  const prop = propertyId ? await retrieve(propertyId) : null;
  const kind = prop && !prop.archived && !prop.in_trash ? readPropertyKind(prop) : null;
  return { deal, kind };
}

function portalOpts(): SateiPortalOpts | null {
  const c = sateiPortalConfig();
  return c ? { fetchImpl: fetch, baseUrl: c.baseUrl, token: c.token, timeoutMs: SATEI_PORTAL_TIMEOUT_MS } : null;
}

async function withPortal<T>(run: (o: SateiPortalOpts) => Promise<SateiCall<T>>): Promise<SateiCall<T>> {
  const o = portalOpts();
  if (!o) {
    log("[satei] config-missing portal");
    return { kind: "rejected", status: 0, code: "CONFIG" };
  }
  return run(o);
}

export function sateiActionDeps(): SateiActionDeps {
  return {
    dealsDbId: process.env.CRM_DEALS_DB_ID || null,
    readDeal: readSateiDealReal,
    intake: (req) => withPortal((o) => sateiIntake(req, o)),
    decide: (no, req) => withPortal((o) => sateiDecide(no, req, o)),
    kv: defaultDealKv(),
    newToken: () => randomUUID(),
    reserve: reserveEvent,
    complete: completeEvent,
    reply: (token, text) => replyTextAndCard(token, text),
    log,
  };
}

/**
 * 理由の印の KV（URL と TOKEN の両方があるときだけ）。delIfToken は Upstash の EVAL（Lua）で
 * 「GET して token を含めば DEL」を1回で行う。token は UUID なので、値が JSON で保存されていても部分一致で確かめられる
 * （@vercel/kv が文字列の引数を引用符つきで送っても `"uuid"` は保存した JSON の中にそのまま現れる）。
 */
const DEL_IF_TOKEN_LUA =
  'local v = redis.call("GET", KEYS[1]) if v and string.find(v, ARGV[1], 1, true) then return redis.call("DEL", KEYS[1]) end return 0';

export function sateiReasonKv(): SateiReasonKv | null {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return {
    get: (key) => kv.get(key),
    delIfToken: async (key, token) => Number(await kv.eval(DEL_IF_TOKEN_LUA, [key], [token])) === 1,
  };
}

export function sateiReasonDeps(): SateiReasonDeps {
  return {
    kv: sateiReasonKv(),
    reason: (no, text) => withPortal((o) => sateiReason(no, text, o)),
    reply: (token, text) => sendLineMessage(token, text),
    log,
  };
}

export function sateiNotifyDeps(): SateiNotifyDeps {
  return {
    env: process.env,
    push: (to, messages, retryKey) => pushMessagesWithRetryKey(to, messages, retryKey),
    log,
  };
}
```

`src/lib/task-buttons-wire.ts` の変更：

1. import に足す（`import { dealDeps } from "./deal-card-wire";` の下）：

```ts
import { parseSateiData } from "./satei-data";
import { handleSateiPostback, type SateiActionDeps } from "./satei-actions";
import { sateiActionDeps } from "./satei-wire";
```

2. `PostbackIo` の最後（`candidates?: Partial<CandidateActionDeps>;` の下）に足す：

```ts
  /** 査定書のボタン（B2。v1|sa|・v1|so|・v1|sr|）。省いた部品は本物（satei-wire.ts） */
  satei?: Partial<SateiActionDeps>;
```

3. `handleTaskPostbackEvent` の io の組み立てに `satei: over.satei,` を足し（`candidates: over.candidates,` の下）、`const op = parseButtonData(data)?.op ?? "invalid";` の**直前**に足す：

```ts
  // B2 査定書のボタン（v1|sa|・v1|so|・v1|sr|）。TASK_BUTTONS・TASK_MENU とは別のスイッチ（TASK_SATEI）なので、
  // 「止めています」の判定より前に振り分ける。off・押せる人・二度押しの扱いは satei-actions.ts。
  // この3つの data は今まで出していないので、ほかのボタンの扱いは変わらない
  const satei = parseSateiData(data);
  if (satei) {
    await handleSateiPostback(
      satei,
      { replyToken, webhookEventId: event.webhookEventId, source: event.source },
      {
        ...sateiActionDeps(),
        reserve: io.reserve,
        complete: io.complete,
        reply: (token, text) => io.reply(token, text),
        log: io.log,
        ...io.satei,
      },
    );
    return;
  }
```

`src/app/api/satei/notify/route.ts`：

```ts
import { NextRequest, NextResponse } from "next/server";
import { handleSateiNotify, SATEI_TOKEN_HEADER } from "@/lib/satei-notify";
import { sateiNotifyDeps } from "@/lib/satei-wire";

// B2 査定書：Mac の査定係からの通知（契約 第3節）。合言葉はヘッダ x-satei-token（satei-notify.ts）。
// src/middleware.ts の matcher には入れない（入れると査定係が 401 になる）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "cache-control": "no-store" };
const BODY_MAX = 32 * 1024;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > BODY_MAX) {
    return NextResponse.json({ error: "too-large" }, { status: 413, headers: NO_STORE });
  }
  const r = await handleSateiNotify(req.headers.get(SATEI_TOKEN_HEADER), raw, sateiNotifyDeps());
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

export function GET(): NextResponse {
  return NextResponse.json(
    { error: "Method Not Allowed" },
    { status: 405, headers: { ...NO_STORE, allow: "POST" } },
  );
}
```

- [ ] **Step 4: 通ることを確かめ、test に足す**

```bash
npx tsx tests/satei-postback-wire.test.ts
npx tsx tests/deal-card.test.ts
npx tsx tests/task-buttons-wire.test.ts
npx tsx tests/candidate-card.test.ts
node -e 'const fs=require("fs");const f="package.json";const p=JSON.parse(fs.readFileSync(f,"utf8"));p.scripts.test+=" && tsx tests/satei-postback-wire.test.ts";fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
npm test
npx tsc --noEmit
```

- [ ] **Step 5: コミット**

```bash
git add src/lib/satei-wire.ts src/app/api/satei/notify/route.ts src/lib/task-buttons-wire.ts tests/satei-postback-wire.test.ts package.json
git commit -m "feat: 査定書のボタンと通知の受け口を本物につなぐ

postback の入口の先頭で v1|sa|・v1|so|・v1|sr| だけを satei に回し、ほかのボタンは今のまま。
POST /api/satei/notify を足した（x-satei-token。middleware の対象には入れない）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 保存直前のフォルダ照合の受け口（POST /api/satei/folder-check・契約 6-3）

**Files:**
- Create: `src/lib/satei-folder-check.ts`
- Create: `src/app/api/satei/folder-check/route.ts`
- Modify: `src/lib/satei-wire.ts`（案件ページだけを読む関数と deps を足す）
- Test: `tests/satei-folder-check.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes：`sateiNotifyAuthorized(header, jobApiToken)`・`SATEI_TOKEN_HEADER`（Task 7。同じ合言葉）、`sateiActive`（Task 2）、`normNotionId`・`SateiDeal`・`readSateiDealPage`（Task 4）、`PAGE_ID_RE`（task-buttons.ts）、satei-wire.ts の `retrieve`（Task 9。ファイル内の関数）
- Produces：
  - `FOLDER_CHECK_TIMEOUT_MS = 5000`
  - `interface FolderCheckInput { no: number; dealId: string; folderId: string }`
  - `parseFolderCheckInput(body: unknown): FolderCheckInput | null`
  - `folderMatches(deal: SateiDeal, input: FolderCheckInput, dealsDbId: string): boolean`
  - `interface FolderCheckDeps { env: Record<string, string | undefined>; readDealPage(dealId: string): Promise<SateiDeal | null>; timeoutMs?: number; log(line: string): void }`
  - `handleSateiFolderCheck(header: string | null, raw: string, deps: FolderCheckDeps): Promise<{ status: number; body: Record<string, unknown> }>`
  - satei-wire.ts：`readSateiDealPageReal(dealId: string): Promise<SateiDeal | null>`、`sateiFolderCheckDeps(): FolderCheckDeps`
  - `POST /api/satei/folder-check`

決めたこと（契約 6-3 の細部）：
- 照合は「Notion の案件ページの `Driveフォルダ` の ID が、送られた folderId と同じ」かつ「そのページが CRM_DEALS_DB_ID の子・消えていない・送られた dealId のページ」。どれかが違えば `{match:false}`（査定係は save-abort の `folder-mismatch`）。
- 読めない（Notion の例外・ページが見つからない＝権限が外れたのか消えたのか分からない）・5秒で時間切れ → `503`（査定係は書かずに次の回へ）。
- `TASK_SATEI` off・`CRM_DEALS_DB_ID` 未設定 → `503`（照合できないので書かせない）。合言葉が違えば off でも先に `401`。

- [ ] **Step 1: 失敗するテストを書く** `tests/satei-folder-check.test.ts`

```ts
/**
 * B2 査定書：保存直前のフォルダ照合の受け口（契約 6-3）。Notion は差し替え。外部へ通信しない。
 */
import {
  folderMatches,
  handleSateiFolderCheck,
  parseFolderCheckInput,
  type FolderCheckDeps,
} from "../src/lib/satei-folder-check";
import { sateiNotifyToken } from "../src/lib/satei-notify";
import type { SateiDeal } from "../src/lib/satei-deal";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};
globalThis.fetch = (async () => {
  throw new Error("このテストで外部へ通信してはいけない");
}) as typeof fetch;

const KEY = "k".repeat(40);
const TOKEN = sateiNotifyToken(KEY);
const DB = "11112222-3333-4444-5555-666677778888";
const DEAL = "0123abcd-0123-4567-89ab-0123456789ab";
const FOLDER = "1AbC_dEf-GhIjKlMnOp";
const GOOD: SateiDeal = {
  id: "0123abcd0123456789ab0123456789ab",
  name: "テスト案件",
  dealNo: 42,
  folderId: FOLDER,
  propertyIds: [],
  gone: false,
  parentDbId: "11112222333344445555666677778888",
};
const env = { JOB_API_TOKEN: KEY, TASK_SATEI: "1", CRM_DEALS_DB_ID: DB };
const IN = { no: 12, dealId: DEAL, folderId: FOLDER };

function mk(read: () => Promise<SateiDeal | null>, e: Record<string, string | undefined> = env, timeoutMs = 1000) {
  const r = { reads: 0, logs: [] as string[] };
  const deps: FolderCheckDeps = {
    env: e,
    readDealPage: async () => {
      r.reads++;
      return read();
    },
    timeoutMs,
    log: (l) => r.logs.push(l),
  };
  return { r, deps };
}

// ── 純関数 ──
ok("入力を読む", JSON.stringify(parseFolderCheckInput(IN)) === JSON.stringify(IN));
ok("ハイフンなしの dealId も読む", parseFolderCheckInput({ ...IN, dealId: GOOD.id }) !== null);
ok("no が0 → null", parseFolderCheckInput({ ...IN, no: 0 }) === null);
ok("dealId の形が違う → null", parseFolderCheckInput({ ...IN, dealId: "x" }) === null);
ok("folderId の形が違う → null", parseFolderCheckInput({ ...IN, folderId: "a/b" }) === null);
ok("配列 → null", parseFolderCheckInput([IN]) === null);
ok("一致", folderMatches(GOOD, IN, DB));
ok("フォルダ違い", !folderMatches({ ...GOOD, folderId: "9ZzZ_otherFolderId" }, IN, DB));
ok("フォルダ欄が空", !folderMatches({ ...GOOD, folderId: null }, IN, DB));
ok("消えたページ", !folderMatches({ ...GOOD, gone: true }, IN, DB));
ok("ほかの DB のページ", !folderMatches({ ...GOOD, parentDbId: "99990000000000000000000000000000" }, IN, DB));
ok("違う案件のページ", !folderMatches({ ...GOOD, id: "ffffffff0123456789ab0123456789ab" }, IN, DB));

(async () => {
  const RAW = JSON.stringify(IN);
  let m = mk(async () => GOOD);
  let r = await handleSateiFolderCheck(TOKEN, RAW, m.deps);
  ok("一致 → 200 {match:true}", r.status === 200 && r.body.match === true);
  ok("ログは J番号と結果だけ", m.r.logs.includes("[satei] folder-check #J12 match") && !m.r.logs.join("").includes(FOLDER) && !m.r.logs.join("").includes("0123abcd"));

  m = mk(async () => ({ ...GOOD, folderId: "9ZzZ_otherFolderId" }));
  r = await handleSateiFolderCheck(TOKEN, RAW, m.deps);
  ok("不一致 → 200 {match:false}", r.status === 200 && r.body.match === false && m.r.logs.includes("[satei] folder-check #J12 mismatch"));

  m = mk(async () => {
    throw new Error("notion");
  });
  r = await handleSateiFolderCheck(TOKEN, RAW, m.deps);
  ok("Notion の失敗 → 503", r.status === 503 && r.body.match === undefined);

  m = mk(async () => null);
  r = await handleSateiFolderCheck(TOKEN, RAW, m.deps);
  ok("ページが見つからない（読めない）→ 503", r.status === 503);

  m = mk(() => new Promise<SateiDeal | null>(() => undefined), env, 50);
  r = await handleSateiFolderCheck(TOKEN, RAW, m.deps);
  ok("時間切れ → 503", r.status === 503);

  m = mk(async () => GOOD);
  r = await handleSateiFolderCheck("0".repeat(64), RAW, m.deps);
  ok("鍵違い → 401・Notion を読まない", r.status === 401 && m.r.reads === 0);
  r = await handleSateiFolderCheck(null, RAW, m.deps);
  ok("ヘッダ無し → 401", r.status === 401 && m.r.reads === 0);
  m = mk(async () => GOOD, { ...env, TASK_SATEI: "" });
  r = await handleSateiFolderCheck("bad", RAW, m.deps);
  ok("off でも鍵違いは 401", r.status === 401);
  r = await handleSateiFolderCheck(TOKEN, RAW, m.deps);
  ok("off → 503・Notion を読まない", r.status === 503 && m.r.reads === 0);
  m = mk(async () => GOOD, { ...env, CRM_DEALS_DB_ID: "" });
  r = await handleSateiFolderCheck(TOKEN, RAW, m.deps);
  ok("CRM_DEALS_DB_ID 未設定 → 503", r.status === 503 && m.r.reads === 0);
  m = mk(async () => GOOD);
  r = await handleSateiFolderCheck(TOKEN, "{bad", m.deps);
  ok("JSON でない → 400", r.status === 400 && m.r.reads === 0);
  r = await handleSateiFolderCheck(TOKEN, JSON.stringify({ ...IN, folderId: "" }), m.deps);
  ok("形が違う → 400", r.status === 400 && m.r.reads === 0);

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx tests/satei-folder-check.test.ts`
Expected: FAIL（`Cannot find module '../src/lib/satei-folder-check'`）

- [ ] **Step 3: 実装**

`src/lib/satei-folder-check.ts`：

```ts
/**
 * B2 査定書：保存直前のフォルダ照合（契約 6-3）。査定係（Mac）が案件フォルダへ書く直前に呼ぶ。
 * - 合言葉は通知の受け口と同じ x-satei-token（satei-notify.ts）。
 * - {no, dealId, folderId} → Notion の CRM_案件 のページの `Driveフォルダ` を読み {match:true|false}。
 * - 読めない・見つからない・5秒で時間切れ・TASK_SATEI off・CRM_DEALS_DB_ID 未設定 → 503（査定係は書かずに次の回へ）。
 * ログは `[satei] folder-check #J12 match` の形だけ（ID・案件名は出さない）。
 */
import { sateiActive } from "./satei-data";
import { normNotionId, type SateiDeal } from "./satei-deal";
import { sateiNotifyAuthorized } from "./satei-notify";
import { PAGE_ID_RE } from "./task-buttons";

export const FOLDER_CHECK_TIMEOUT_MS = 5_000;
const FOLDER_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const DEAL_ID_RE = /^[0-9a-f]{32}$/i;

export interface FolderCheckInput {
  no: number;
  dealId: string;
  folderId: string;
}

export function parseFolderCheckInput(body: unknown): FolderCheckInput | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { no, dealId, folderId } = body as Record<string, unknown>;
  if (typeof no !== "number" || !Number.isInteger(no) || no <= 0) return null;
  if (typeof dealId !== "string" || !(PAGE_ID_RE.test(dealId) || DEAL_ID_RE.test(dealId))) return null;
  if (typeof folderId !== "string" || !FOLDER_ID_RE.test(folderId)) return null;
  return { no, dealId, folderId };
}

export function folderMatches(deal: SateiDeal, input: FolderCheckInput, dealsDbId: string): boolean {
  return (
    !deal.gone &&
    deal.parentDbId === normNotionId(dealsDbId) &&
    deal.id === normNotionId(input.dealId) &&
    deal.folderId === input.folderId
  );
}

export interface FolderCheckDeps {
  env: Record<string, string | undefined>;
  /** CRM_案件 のページ。見つからなければ null。読めなければ例外 */
  readDealPage(dealId: string): Promise<SateiDeal | null>;
  timeoutMs?: number;
  log(line: string): void;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

const unavailable = (error: string) => ({ status: 503, body: { error } });

export async function handleSateiFolderCheck(
  header: string | null,
  raw: string,
  deps: FolderCheckDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!sateiNotifyAuthorized(header, deps.env.JOB_API_TOKEN)) {
    return { status: 401, body: { error: "Unauthorized" } };
  }
  if (!sateiActive(deps.env)) {
    deps.log("[satei] folder-check off");
    return unavailable("off");
  }
  const dealsDbId = deps.env.CRM_DEALS_DB_ID ?? "";
  if (!dealsDbId) {
    deps.log("[satei] folder-check config-missing");
    return unavailable("config");
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "bad-input" } };
  }
  const input = parseFolderCheckInput(body);
  if (!input) return { status: 400, body: { error: "bad-input" } };
  let deal: SateiDeal | null;
  try {
    deal = await withTimeout(deps.readDealPage(input.dealId), deps.timeoutMs ?? FOLDER_CHECK_TIMEOUT_MS);
  } catch {
    deps.log(`[satei] folder-check #J${input.no} unavailable`);
    return unavailable("unavailable");
  }
  if (!deal) {
    deps.log(`[satei] folder-check #J${input.no} not-found`);
    return unavailable("unavailable");
  }
  const match = folderMatches(deal, input, dealsDbId);
  deps.log(`[satei] folder-check #J${input.no} ${match ? "match" : "mismatch"}`);
  return { status: 200, body: { match } };
}
```

`src/lib/satei-wire.ts` に足す（`readSateiDealReal` の上に `readSateiDealPageReal` を置き、`readSateiDealReal` はそれを使う形に替える。import に `import type { FolderCheckDeps } from "./satei-folder-check";` を足す）：

```ts
/** 案件ページだけ（物件は読まない）。見つからなければ null。読めなければ例外 */
export async function readSateiDealPageReal(dealId: string): Promise<SateiDeal | null> {
  const page = await retrieve(dealId);
  return page ? readSateiDealPage(page) : null;
}

/** 案件ページと物件の1件目の種別。案件ページが無ければ null。物件が読めない・無ければ kind は null */
export async function readSateiDealReal(
  dealId: string,
): Promise<{ deal: SateiDeal; kind: string | null } | null> {
  const deal = await readSateiDealPageReal(dealId);
  if (!deal) return null;
  const propertyId = deal.propertyIds[0];
  const prop = propertyId ? await retrieve(propertyId) : null;
  const kind = prop && !prop.archived && !prop.in_trash ? readPropertyKind(prop) : null;
  return { deal, kind };
}

export function sateiFolderCheckDeps(): FolderCheckDeps {
  return { env: process.env, readDealPage: readSateiDealPageReal, log };
}
```

`src/app/api/satei/folder-check/route.ts`：

```ts
import { NextRequest, NextResponse } from "next/server";
import { handleSateiFolderCheck } from "@/lib/satei-folder-check";
import { SATEI_TOKEN_HEADER } from "@/lib/satei-notify";
import { sateiFolderCheckDeps } from "@/lib/satei-wire";

// B2 査定書：保存直前のフォルダ照合（契約 6-3）。合言葉はヘッダ x-satei-token（通知の受け口と同じ）。
// src/middleware.ts の matcher には入れない（入れると査定係が 401 になる）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "cache-control": "no-store" };
const BODY_MAX = 4 * 1024;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > BODY_MAX) {
    return NextResponse.json({ error: "too-large" }, { status: 413, headers: NO_STORE });
  }
  const r = await handleSateiFolderCheck(req.headers.get(SATEI_TOKEN_HEADER), raw, sateiFolderCheckDeps());
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

export function GET(): NextResponse {
  return NextResponse.json(
    { error: "Method Not Allowed" },
    { status: 405, headers: { ...NO_STORE, allow: "POST" } },
  );
}
```

- [ ] **Step 4: 通ることを確かめ、test に足す**

```bash
npx tsx tests/satei-folder-check.test.ts
npx tsx tests/satei-postback-wire.test.ts   # satei-wire.ts の差し替えで既存の振り分けが変わらない
node -e 'const fs=require("fs");const f="package.json";const p=JSON.parse(fs.readFileSync(f,"utf8"));p.scripts.test+=" && tsx tests/satei-folder-check.test.ts";fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
npm test
npx tsc --noEmit
```

- [ ] **Step 5: コミット**

```bash
git add src/lib/satei-folder-check.ts src/app/api/satei/folder-check/route.ts src/lib/satei-wire.ts tests/satei-folder-check.test.ts package.json
git commit -m "feat: 査定書の保存直前のフォルダ照合の受け口を足す

査定係が案件フォルダへ書く直前に、Notion の Driveフォルダ と依頼のフォルダ ID が同じかを答える（契約 6-3）。
読めない・時間切れは 503 で、査定係は書かずに次の回へ回す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: webhook の1対1の文字で差し戻し理由を受ける

**Files:**
- Modify: `src/app/api/webhook/route.ts`（import 2行・`// ① メール下書きの確認セッションがある場合は最優先。` の直前に1か所）
- Test: `tests/satei-webhook-order.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes：`handleSateiReasonText(m, deps)`（Task 8）、`sateiReasonDeps()`（Task 9）
- Produces：route.ts の中の分岐（外へは何も出さない）

置き場所の理由：理由を聞いたあとの次の1通は、メールの下書き・初動確認への回答・番号での完了より先に受けないと、そちらに吸い込まれる。一方で `handleSateiReasonText` は TASK_SATEI=1・1対1・TASK_SATEI_USER_IDS の人・印ありのときしか true を返さず、それ以外は KV も読まずに false（＝今の流れのまま）。メニュー・「@秘書 案件」の入口はグループだけなので、その後ろに置いても順番の影響は無い。

- [ ] **Step 1: 失敗するテストを書く** `tests/satei-webhook-order.test.ts`

（route.ts の POST を丸ごと動かすのは重いので、置き場所と条件を元のファイルの並びで固定する。動きそのものは Task 8 のテストで確かめてある）

```ts
/**
 * B2 査定書：webhook の差し戻し理由の取り込みの置き場所。
 * 文字メッセージの判定のあと・メールの下書きの確認より前に1か所だけあり、true のときだけ次のイベントへ進むこと。
 */
import { readFileSync } from "node:fs";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};

const src = readFileSync("src/app/api/webhook/route.ts", "utf8");
const at = (s: string) => src.indexOf(s);
const call = "await handleSateiReasonText(";
ok("取り込みは1か所だけ", src.split(call).length === 2);
ok("import がある", src.includes('import { handleSateiReasonText } from "@/lib/satei-actions";') && src.includes('import { sateiReasonDeps } from "@/lib/satei-wire";'));
ok("文字メッセージの判定より後", at('if (event.message.type !== "text") continue;') < at(call));
ok("「@秘書 案件」の入口より後", at("dealWordEntry({") < at(call));
ok("メールの下書きの確認より前", at(call) < at("const draftSession = await getDraftSession("));
ok("初動確認への回答より前", at(call) < at("const pending = await getPendingTaskConfirm("));
const block = src.slice(at(call), at(call) + 600);
ok("1対1の送り主の ID・本文・replyToken を渡す", block.includes("userId: source.userId") && block.includes("groupId: source.groupId") && block.includes("text: event.message.text") && block.includes("replyToken"));
ok("受けたときだけ確定して次へ", /markCommitted\(\);\s*continue;/.test(block));

if (fail > 0) {
  console.log(`\n${fail} 件失敗`);
  process.exit(1);
}
console.log("\nすべて成功");
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx tests/satei-webhook-order.test.ts`
Expected: FAIL（`取り込みは1か所だけ` など）

- [ ] **Step 3: 実装**（`src/app/api/webhook/route.ts`）

import に足す（`import { recordAfterCreateWithPick } from "@/lib/deal-card-wire";` の下）：

```ts
import { handleSateiReasonText } from "@/lib/satei-actions";
import { sateiReasonDeps } from "@/lib/satei-wire";
```

`// ① メール下書きの確認セッションがある場合は最優先。` の行の**直前**に足す：

```ts
    // B2 査定書の差し戻し理由（2026-11-11）。TASK_SATEI=1・1対1・TASK_SATEI_USER_IDS の人で、
    // ［差し戻し］から30分以内の印（satei:reason:<userId>）があるときだけ、この1通を理由として依頼箱へ送る。
    // それ以外は KV も読まずに false が返り、下の今の流れ（メールの下書き・初動確認・番号での完了など）へ進む。
    if (
      await handleSateiReasonText(
        {
          userId: source.userId,
          groupId: source.groupId,
          text: event.message.text,
          replyToken,
        },
        sateiReasonDeps(),
      )
    ) {
      markCommitted();
      continue;
    }

```

- [ ] **Step 4: 通ることを確かめ、test に足す**

```bash
npx tsx tests/satei-webhook-order.test.ts
npx tsx tests/webhook-source-gate.test.ts   # route.ts を本物で動かす既存のテスト（TASK_SATEI 未設定で今と同じ）
node -e 'const fs=require("fs");const f="package.json";const p=JSON.parse(fs.readFileSync(f,"utf8"));p.scripts.test+=" && tsx tests/satei-webhook-order.test.ts";fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
npm test
npx tsc --noEmit
```

- [ ] **Step 5: コミット**

```bash
git add src/app/api/webhook/route.ts tests/satei-webhook-order.test.ts package.json
git commit -m "feat: 1対1の次の1通を査定書の差し戻し理由として受ける

［差し戻し］の印がある30分のあいだの次の1通を依頼箱の reason に送る（成功で印が消える。契約 6-11）。
印が無い・off・グループ・ほかの人の発言は KV も読まずに今の流れへ渡す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: CLAUDE.md に B2 の節を足す

**Files:**
- Modify: `CLAUDE.md`（「（朝のリマインドをカードで・2026-11-10）…」の段落のあと、`## よく使うコマンド` の前）

**Interfaces:**
- Consumes：Task 2〜11 の名前
- Produces：なし（文書）

- [ ] **Step 1: 節を足す**（下の文をそのまま入れる）

```markdown
（B2・査定書の下書き・2026-11-11）`TASK_SATEI`（`1` のときだけ動く。既定 off。off なら案件カードの JSON は1バイトも変わらず、前に出したボタン `v1|sa|`・`v1|so|`・`v1|sr|` を押されても「いまは止めています」とだけ返して何もしない。差し戻し理由の取り込みも KV を読まない）／`TASK_SATEI_USER_IDS`（押せる人の LINE userId。カンマ区切り。**先頭が個人あての通知先＝下村さん**。タスクの「担当者・依頼者も押せる」決まりは使わない。違う人には「いまは下村さんだけが使えます」）。設計は `docs/superpowers/specs/2026-11-11-b2-satei-draft-design.md`、受け渡しの正本は `…-b2-satei-contract.md`。
- 入口：案件カード（B1・`TASK_MENU=1` のときに出る）の3つ目［査定書を作る］（`v1|sa|案件ID`）。postback の振り分けは TASK_BUTTONS の「止めています」の判定より前（TASK_SATEI だけで動く）。二度押しは `pb:<webhookEventId>` の予約。
- ［査定書を作る］：CRM_案件 のページ（`案件名`・`ID` の数字・`Driveフォルダ` の `/folders/<id>`・`物件` の1件目）と CRM_物件 の `種別` を読む（書かない。CRM_DEALS_DB_ID の子のページだけ）。マンションでない（分からないも含む）→「いまはマンションの案件だけ作れます」、フォルダが無い →「案件の Driveフォルダが未設定です」。そろえば reins-report の `POST /api/jobs/satei/intake` を呼び、押した場所へ「受け付けました。結果は個人の LINE に届きます（#J番号）」か、同じ案件で終わっていない依頼があれば「作成中です（#J番号）」。案件名・金額は返事に入れない。
- 個人あての通知：Mac の査定係が `POST /api/satei/notify`（ヘッダ `x-satei-token` = HMAC-SHA256(JOB_API_TOKEN, "satei-notify") の hex。JOB_API_TOKEN が32字未満なら誰も通さない。`src/middleware.ts` の matcher には入れない）を呼び、`TASK_SATEI_USER_IDS` の先頭へ push（`X-Line-Retry-Key` = uuidv5(no:kind:generation)、名前空間は `satei-notify.ts` に固定。LINE が 200・409 → `sent`、ほか → `unknown`）。draft はカード（判定・指摘3件・［下書きを見る］＝Drive の閲覧 URL・［OK］`v1|so|no|generation|sha256`・［差し戻し］`v1|sr|…`）、failed・saved・aborted は頭に【査定書 #J番号・案件名】を付けた文字。TASK_SATEI off・通知先が無いときは送らず `{result:"deferred"}`（portal は試行回数を増やさない）。push は月の送信枠を1通使う。
- ［OK］［差し戻し］：`POST /api/jobs/{no}/satei/decide` に sha256・generation を付けて送る（版違い・処理済みの 409 →「この下書きは古いか、もう処理済みです」）。差し戻しを押すと portal は「差し戻し」のまま理由を待つ（理由が来るか30分で取消）。そのあいだ同じ案件の［査定書を作る］は「差し戻しの理由を待っています（理由を返信するか、30分後に押し直してください）」（intake の `SATEI_AWAITING_REASON`）。差し戻しのあとは KV `satei:reason:<userId>` = `{no, token}`（token は UUID・30分）を置き、その人の**次の1対1の文字メッセージ**を `POST /api/jobs/{no}/satei/reason`（200字まで）に送る。印は**消さずに**呼び、成功したら消して「理由を記録しました」、portal が実際に 4xx で断ったら（もう閉じている）印を消して「この差し戻しはもう閉じています」、それ以外（設定不足・5xx・結果不明・例外）は印を残して「記録できませんでした。もう一度送ってください」。消すのは読んだ印と同じ token のときだけ（`satei-wire.ts` の Lua で GET と DEL を1回に。応答待ちのあいだに別の差し戻しが置いた新しい印は消さない）。GETDEL は使わない。取り込みは webhook の文字メッセージの判定のあと・メールの下書きの確認より前の1か所（`handleSateiReasonText`）。印が無いあいだ、ほかの1対1の発言は今の流れへ。
- 保存直前のフォルダ照合：査定係が `POST /api/satei/folder-check`（同じ `x-satei-token`）`{no, dealId, folderId}` を呼ぶ。Notion の CRM_案件 のページの `Driveフォルダ` と同じなら `{match:true}`、違う・消えた・別の DB のページなら `{match:false}`、読めない・見つからない・5秒で時間切れ・TASK_SATEI off・CRM_DEALS_DB_ID 未設定なら `503`（査定係は書かずに次の回へ）。
- 前提の設定：PORTAL_BASE_URL・JOB_API_TOKEN（帯替えと同じ）、CRM_NOTION_TOKEN（無ければ NOTION_API_KEY）・CRM_DEALS_DB_ID（**CRM_案件 と CRM_物件 の両方をその連携に共有**）、KV。個人カードのボタンと理由の返信は送り主の制限を通るので、**下村さんの userId を `SECRETARY_ALLOWED_USER_IDS`（空なら `TASK_BUTTONS_ADMIN_IDS`）にも入れる**。秘書の LINE と下村さんが友だちであること。
- ファイル：`src/lib/satei-data.ts`（スイッチ・押せる人・data）／`satei-deal.ts`（案件・物件の読み方と判定）／`satei-portal.ts`（依頼箱の intake・decide・reason）／`satei-text.ts`（文面・カード）／`satei-notify.ts`（受け口の合言葉・uuidv5・入力の検査）／`satei-actions.ts`（ボタンと理由の処理）／`satei-wire.ts`（本物の Notion・portal・LINE・KV）／`satei-folder-check.ts`（フォルダ照合）／`src/app/api/satei/notify/route.ts`・`folder-check/route.ts`。`line.ts` の `pushMessagesWithRetryKey` は retry key つきの push（既存の push は変えていない）。
- ログ：`[satei] sa accepted`・`[satei] so stale`・`[satei] sr rejected-ask`・`[satei] reason #J12 saved`・`[satei] notify #J12 draft sent`・`[satei] folder-check #J12 match`・`[satei] config-missing portal` の形（操作名・J番号・kind・結果の符号だけ。案件名・userId・本文・Drive ID は出さない）。
- 本番で on にする・env を足すのは下村さんの承認後（値を画面に出さない方法で入れる）。
```

- [ ] **Step 2: 確かめる**

```bash
grep -n "B2・査定書の下書き" CLAUDE.md
npm test
```

- [ ] **Step 3: コミット**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md に B2 査定書の下書きの節を足す

スイッチ・押せる人・通知とフォルダ照合の受け口・差し戻し理由の取り込み（契約 v2）・前提の設定・ファイル・ログの形を残す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: 全体の確認と引き継ぎ

**Files:**
- Modify（git 管理外の記録）：`~/AI開発/tools/notebooklm-obsidian/vault/20_research/2026-08-08_AI秘書_集約と完了機能_進行ログ.md`（追記）
- Modify: `HANDOFF.md`（無ければ作る。プロジェクト直下）

**Interfaces:**
- Consumes：全タスク
- Produces：テスト・型・ビルドが通った `feat/b2-satei` ブランチ

- [ ] **Step 1: 全部通ることを確かめる**

```bash
cd /Users/shimo/AI開発/apps/aisecretary/.worktrees/b2-satei
npm test            # 最後まで ✅、exit 0
npx tsc --noEmit    # エラー0
npm run build       # 成功（.env は無くてよい。失敗したら出力の最初のエラーを直す。env が要る失敗なら下村さんに聞く）
git status --short  # 何も出ない
git log --oneline integration/email-and-media..HEAD   # Task 2〜12 の11コミット
```

- [ ] **Step 2: off で今と同じことを目で確かめる**

```bash
git diff integration/email-and-media..HEAD --stat
git diff integration/email-and-media..HEAD -- src/lib/line.ts src/lib/obi/config.ts src/lib/deal-card.ts src/lib/task-buttons-wire.ts src/app/api/webhook/route.ts
```

確かめること：`line.ts` は関数の追加だけ、`obi/config.ts` は `export` の1語だけ、`deal-card.ts` は import 1行・コメント1行・配列の末尾の spread だけ、`task-buttons-wire.ts` は import 3行・`PostbackIo` 1項目・io 1行・振り分け1つ、`route.ts` は import 2行・分岐1つ。新しい受け口は `src/app/api/satei/notify`・`folder-check` の2つだけ。それ以外の差分があれば理由を確かめる。

- [ ] **Step 3: 引き継ぎを書く**

`HANDOFF.md` に「どこまで：B2 の aisecretary 側を feat/b2-satei に実装（未 push・未 deploy）／何待ち：reins-report 側（契約 第2節）と line-secretary の査定係／Task 1 の Notion の確認結果（CRM_物件 が読めたか）／本番で on にする前に要る設定と確かめ：試験環境の Vercel KV（Upstash）で `kv.eval` の Lua（理由の印の delIfToken）が通ること、TASK_SATEI・TASK_SATEI_USER_IDS の追加、SECRETARY_ALLOWED_USER_IDS に下村さんが入っているか、CRM_物件 の共有、秘書の LINE と下村さんの友だち／次の一手：下村さんの承認後に env を入れて deploy、試験用の案件で通しの試験（設計 第11節）」を書く。

vault の進行ログに、同じ内容と「決めたこと（契約 v2 第6節で採用済みを含む）：J番号は `#J<no>`、draft 以外の通知の頭に【査定書 #J番号・案件名】、off の判定を本人確認より先、satei の postback は TASK_BUTTONS と別に動く、notify の off・通知先なしは deferred、理由の印は成功してから消す（通信失敗は残す・はっきり断られたら消す）、folder-check は off・未設定・見つからないも 503」を追記する（vault は git 管理外。コミットしない）。

- [ ] **Step 4: コミット**（HANDOFF.md が git 管理なら）

```bash
git add HANDOFF.md
git commit -m "docs: B2 査定書の aisecretary 側の引き継ぎを残す

本番の env 追加・deploy は下村さんの承認後に別途行うため、その前提と次の一手を書いた。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**この計画に入れないこと：** `git push`、Vercel への deploy、本番の環境変数（TASK_SATEI・TASK_SATEI_USER_IDS など）の追加・変更、Notion の共有設定の変更、LINE の実送信。どれも下村さんの承認後に別途行う。
