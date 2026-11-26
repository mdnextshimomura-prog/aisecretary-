# 段2e 事例 PDF の取り出しと保存 → 下書きへ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 山口さんがグループに貼った事例 PDF を受付票に結びつけ、Mac が aisecretary 経由で取り出して案件フォルダの `02_査定・事例/REINS成約/`（売出は `REINS売出/`）に保存し、マンションは今の査定（下書き）へ進める。

**Architecture:** 受け渡しは 2d と同じく portal（reins-report）の準備の行 `satei-prep:<tid>` を通す。aisecretary が「事例あり」を portal に知らせ、Mac が claim して aisecretary の新しい口 `POST /api/satei/media` から PDF を1件ずつ取り、Drive API で保存して portal に結果を返す。aisecretary の毎分の見回りが結果を読み、下村さんへ知らせ、マンションは段1と同じ受付（eventId `gs<tid>`）を呼ぶ。

**Spec:** `docs/superpowers/specs/2026-11-25-group-satei-stage2-design.md` の 7・8・14 節。2d の計画 `docs/superpowers/plans/2026-11-26-group-satei-2d.md`。

## Global Constraints

- スイッチは増やさない。aisecretary は `groupSateiPrepOn`（GROUP_SATEI_STAGE2=1 かつ GROUP_SATEI_CASE_STAFF_ID）、portal は `SATEI_PREP`、Mac は `SATEI_PREP`。off なら 2d のまま1バイトも変えない。
- ログ・KV には ID・時刻・件数・符号だけ。PDF の中身・ファイル名・案件名・userId は出さない。ログの形 `[group-satei] cases handed G7 3`・`cases saved G7 2/1/0`・`[satei-cases] G7 saved 3`。
- グループには何も送らない（2e で増えるグループへの送信は 0）。下村さんへの push は1件につき最大2通（結果1通＋送り直し1回）。
- 元のファイル名は使わない。保存名は `事例_G7_<i>.pdf`（i は 1 始まり、受付票に結びついた順）。
- 1件の PDF は 4MB まで（Vercel の応答の上限 4.5MB のため）。1受付票 10件まで。
- LINE の保管期間の保証が無いので、最後の PDF から2分で portal に渡し、Mac は見回り（2分おき）で準備より先に取る。
- 既存の 2d のテストを壊さない。テストの出し方：aisecretary は `npx tsx tests/group-satei-*.test.ts` を1本ずつ＋`npx tsc --noEmit`＋`npx next build`（`npm test` は既知の4件で止まる）。portal は `npx vitest run`＋`npx tsc --noEmit`（prisma generate はしない）。Mac は `LINE_SECRETARY_ENV_FILE=/nonexistent/line-secretary-test.env node --test test/*.test.js delivery/test/*.test.js`。
- コミットは `type: 日本語` ＋本文1〜3行＋`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。push しない。

## 決めたこと（Ruling）

- E1：成約か売出かは Mac が `pdftotext`（既存の poppler のサンドボックス）で決める。本文に「成約」があれば成約、文字があって「成約」が無ければ売出、文字が取れなければ成約（設計の既定の置き場）。— 中身を見ないと分けられない — 間違えても 02 の中なので作成役は読める。
- E2：待ちの受付票が同じグループに2件以上あって引用でも決まらない PDF は、保存に回さず、下村さんへ1回だけ「どの受付のものか決められません。02 に入れてください」。設計の「受付票のボタンで選ぶ」は 2f 以降。— ボタンの道は作りが大きい — 手作業が1回増えるだけ。
- E3：引用で決めるのは、2d の依頼カードの push が返した messageId（`prep.cardMsgId`）と一致したときだけ。push の応答から取れなければ引用の道は無し。
- E4：portal に渡すのは最後の PDF から2分たってから1回。渡したあとに貼られた PDF は自動では保存せず、結果の知らせに「あとから貼られた n件は保存していません。02 に入れてください」と書く。
- E5：下書きを始めるのは aisecretary（段1の `pick()` の受付と同じ関数。eventId `gs<tid>`、requestedBy は `TASK_SATEI_USER_IDS` の先頭）。TASK_SATEI off・フォルダ無し・受付に断られたら「下書きを始められませんでした。案件カードの［査定書を作る］を押してください」で手作業。
- E6：知らせたあと aisecretary は portal に `cases-ack` を送り、portal の行を `完了` にする（notices に出し続けない）。

## 受け渡しの約束（3か所で同じ）

### portal（`src/lib/satei-prep.ts`・認証 `isJobApiRequest`）

状態を足す：`依頼済み → 事例あり → 事例作業中 → 事例保存済み | 事例失敗 → 完了`。行に `casesCount:number|null, casesRunId, casesLeaseUntil, casesAttempts, cases:{contract,listing,failed}|null, casesFailReason:""|"folder"|"fetch"|"internal"|"timeout"` を足す（古い行は欠けていてよい＝null 扱い）。

| 口 | 入力 | 出力 |
|---|---|---|
| `POST /api/jobs/satei/prep/{tid}/cases` | `{count: 1..10 の整数}` | 依頼済み→事例あり（casesCount=count）で 200 `{status}`。事例ありで count が同じか大きい→casesCount を更新して 200。事例作業中・保存済み・失敗・完了→409 `PREP_CLOSED`。ほかの状態→409 `PREP_STALE`。無い→404。off→503 `PREP_DISABLED` |
| `POST /api/jobs/satei/prep/cases/claim` | `{}` | 事例ありの行（無ければ事例作業中で予約切れ・attempts<2 の行）を1件、事例作業中に（予約20分）。200 `{tid,no,runId,leaseUntil,attempt,dealId,folderId,kind,count}`。無い・off は 204。予約が2回目も切れた行は掃除で `事例失敗(timeout)` |
| `POST /api/jobs/satei/prep/{tid}/cases-result` | `{runId, outcome:"saved", contract, listing, failed}`（0以上の整数、contract+listing≥1、合計=casesCount）か `{runId, outcome:"failed", failReason:"folder"\|"fetch"\|"internal"}` | 事例作業中かつ runId 一致のときだけ → 事例保存済み／事例失敗。200 `{status}`。runId 違い・状態違い→409 `PREP_STALE` |
| `POST /api/jobs/satei/prep/{tid}/cases-ack` | `{}` | 事例保存済み・事例失敗→完了で 200。完了なら 200 のまま（冪等）。ほか→409 `PREP_STALE` |
| `GET /api/jobs/satei/prep/notices`（既存） | | 既存の要素に加え、事例保存済み・事例失敗の行も `{tid,no,status,lines:[],areaDone,failReason:"",cases:{contract,listing,failed}\|null,casesFailReason}` で返す。既存の要素には `cases:null, casesFailReason:""` を足す |

書き換えは既存の `swapPrep`（CAS）。8日の掃除は既存のまま。

### aisecretary の口 `POST /api/satei/media`

- ヘッダ `x-satei-token` = HMAC-SHA256(JOB_API_TOKEN の UTF-8, `"satei-media"`) の hex。32字未満なら誰も通さない。比べ方は定数時間。`src/middleware.ts` の matcher に入れない。GET は 405。
- 入力 `{tid: string, index: 1..10}`。
- `groupSateiPrepOn` でなければ 503 `{code:"OFF"}`。受付票が無い・`waiting-cases` でない→404 `{code:"NOT_FOUND"}`。`gsatei:caseitems:<tid>` の index 番目が無い→404。
- LINE の content API から取る（1件20秒で打ち切り）。LINE の 404/410→410 `{code:"GONE"}`、4MB を超えた→413 `{code:"TOO_LARGE"}`（読みながら数えて止める）、先頭が `%PDF` でない→415 `{code:"NOT_PDF"}`、ほかの失敗・時間切れ→502 `{code:"UPSTREAM"}`。
- 成功は 200、`content-type: application/pdf`、本文は PDF のバイト。`cache-control: no-store`。

### Mac（line-secretary）

- 見回りで `SATEI_PREP` が on かつ `AISECRETARY_BASE_URL` があるとき、**準備の claim より先に** `prep/cases/claim`。取れたら `runCases(claim)`、その回はほかの claim をしない。
- `runCases`：`readCaseFolder(folderId)` → だめなら failed `folder`。i=1..count で `/api/satei/media {tid,index:i}`（30秒、502 だけ1回だけ取り直す）。取れたら一時フォルダに置き、`pdftotext` で E1 の判定 → `ensureFolder(sateiId,"REINS成約"|"REINS売出")` → 同じ名前 `事例_G<no>_<i>.pdf` がどちらかのフォルダにあればそのまま成功扱い、無ければ `uploadPdf`。取れない・保存できない件は failed に数える。1件も保存できなければ failed（取り出しの失敗が多ければ `fetch`、Drive なら `folder`、ほか `internal`）。全部の後で `cases-result`。一時ファイルは消す。
- ログ `[satei-cases] G7 saved 2/1/0`（成約/売出/失敗）・`[satei-cases] G7 failed fetch`。

## aisecretary の変更

- `GsPrep` に `cardMsgId?: string, casesHanded?: number, casesHandedAt?: number, casesDone?: boolean, casesPushTries?: number` を足す（`isGsPrep` も）。
- `gsatei:caseitems:<tid>`：JSON の配列 `[{m: messageId, at}]`（14日、10件まで、同じ messageId は足さない）。`markGsCasePdf` が既存の `gsatei:cases` に加えて、E2・E3 の決まりで1件に決まったときだけ足す。決まらないときは `gsatei:ambig:<messageId>` setNx（1日）が取れたら下村さんへ push（retry key `ambig:<messageId>`）。
- 2d の依頼カードの push が messageId を返すなら `prep.cardMsgId` に残す。
- `sweepGsStage2`：waiting-cases の票で caseitems が n 件・最後の at から2分・`casesHanded !== n`（かつ未 handed）→ portal `cases {count:n}`。ok なら `casesHanded=n, casesHandedAt`。PREP_CLOSED はログだけ。
- 同じ見回りで、handed の票があれば notices を（既に呼んでいれば同じ結果を使い）1回だけ呼び、`事例保存済み`／`事例失敗` の tid について：
  - 保存済み・マンション → `readDeal(tk.dealId)`＋`judgeSateiDeal`＋受付（段1と同じ関数を切り出して共有）。ok → state `started`・jobNo、文「事例を保存しました（成約 n件・売出 m件）。下書きを作ります（受付 G7・#J12）」。だめ → `manual`、文「事例を保存しました（…）。下書きを始められませんでした。案件カードの［査定書を作る］を押してください（受付 G7）」。
  - 保存済み・戸建／土地 → `manual`、「事例を保存しました（…）。戸建（土地）の下書きは自動で作れません。資料は 01・02 にそろえました（受付 G7）」。
  - 失敗 → `manual`、「事例の PDF を取り出せませんでした。案件フォルダの 02 に入れてください（受付 G7）」。
  - failed>0 なら「取り出せなかった PDF が n件あります。02 に入れてください」、E4 の後から分があれば その行も足す。
  - push（retry key `cases:<tid>`、2回まで。2回だめなら手作業のまま諦めログ）→ 送れたら `casesDone` → portal `cases-ack` → `gsatei:s2` から外す。
- リマインド：`casesHanded` がある票は催促しない。

## Tasks

### Task P1: portal の事例の状態と4つの口（reins-report `.worktrees/group-satei-2d`）
上の約束どおりに `src/lib/satei-prep.ts` に状態・欄・関数（`markPrepCases`・`claimPrepCases`・`resultPrepCases`・`ackPrepCases`、notices の拡張、掃除の timeout）と `src/app/api/jobs/satei/prep/[tid]/cases/route.ts`・`cases-result/route.ts`・`cases-ack/route.ts`・`prep/cases/claim/route.ts` を足す。既存のテストの形に合わせて状態遷移・CAS・runId・入力の検査・off・冪等のテストを先に書く。

### Task M1: Mac の取り出しと保存（line-secretary `.worktrees/satei-prep`）
`src/satei/notify.js` の post を使い回して `fetchCaseMedia({tid,index})`（文 `"satei-media"`、バイナリを返す、4MB+α で打ち切る）、`src/satei/portal.js` に `casesClaim`・`casesResult`、新しい `src/satei/cases.js` の `runCases`、`tick.js` に準備より先の claim、`docs/運用.md` に1節。Drive・portal・aisecretary・pdftotext は依存注入でテストする（判定 E1、同名の既存ファイル、502 の取り直し、1件も取れない、フォルダ無し、一時ファイルの掃除）。

### Task A1: aisecretary の結びつけ・口・見回り（`.worktrees/group-satei-stage2`）
上の「aisecretary の変更」を全部。`src/app/api/satei/media/route.ts`、`group-satei-propose.ts`（mark・sweep・知らせ）、`group-satei-prep-portal.ts`（cases・cases-ack・notices の型）、`group-satei-actions.ts` の受付の切り出し、`group-satei-data.ts`、テスト `tests/group-satei-2e.test.ts`。CLAUDE.md の段2d の後ろに段2e の節を足す。

### Task R: 3か所まとめての点検と直し
約束（パス・入力・出力・符号・状態）が3か所で一字一句合うか、プライバシー、時間の予算、二重の push・二重の保存を点検し、指摘を直す。
