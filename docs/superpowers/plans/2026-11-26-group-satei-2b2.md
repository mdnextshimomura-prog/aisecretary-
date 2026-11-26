# 段2b-2 足りない項目を下村さんに聞く Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** 案件を選んだ（gs）とき、資料から読めなかった項目（所在・物件名・専有面積・築年月・土地面積・建物面積）を下村さんに1回だけまとめて聞き、答えを足してから portal の準備（2d）へ渡す。

**Architecture:** aisecretary だけ。`pick()` の 2d の枝で `startGsPrep` の前に足りない項目を見る。足りなければ受付票を `asking-info` にして、ボタンの返事（reply。送信枠を使わない）で聞く。次の1対1の1通を Claude 1回で読んで facts に足し、`startGsPrep` へ。［このまま進める］か30分で、足りないまま進める。

**Spec:** `docs/superpowers/specs/2026-11-25-group-satei-stage2-design.md` の 4・10 節。`src/lib/group-satei-facts.ts`（足りない項目の決まり・例・答えの読み方。もうある）。

## Global Constraints

- 動くのは `groupSateiPrepOn` のとき（2d と同じ）だけ。off なら今と1バイトも変わらない。新しい環境変数は無い。
- グループには何も送らない。聞くのは押した場所（下村さんの1対1）への返事だけ。
- 号室は聞かない（準備に使わない・グループに出さない）。聞くのは `gsMissingFacts` のうち roomNo を除いたもの。
- 答えの値は `group-satei-read` の検査（numOrNull・normYm・scrubNames など。`gsAnswerFact`）を通ったものだけ使う。人の名前らしい値は捨てる。
- KV・ログには ID・時刻・項目の名前・件数・符号だけ（値は受付票の read.facts にだけ。今と同じ置き場）。ログの形 `[group-satei] info asked G7 2`・`info filled G7 2/2`・`info skipped G7`・`info timeout G7`。
- テスト：`for f in tests/group-satei-*.test.ts tests/photo-ask*.test.ts; do npx tsx $f >/dev/null 2>&1 || echo FAIL $f; done`、`npx tsc --noEmit`、`npx next build`。コミットは日本語＋`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。push しない。

## 決めたこと（Ruling）

- I1：1回にまとめて聞く（設計の「1回に1つ」より手間が少ない）。文：
  ```
  【受付 G7】資料から読めなかった項目があります。分かる分だけ1通で送ってください（喋ったままで大丈夫です）
  ・専有面積（例：65.3）
  ・築年月（例：2005年3月）
  分からなければ［このまま進める］を押してください。30分たつと、このまま進めます
  ```
  ボタン［このまま進める］`v1|gi|<tid>|<ver>`（押せるのは `TASK_SATEI_USER_IDS` の人だけ）。
- I2：印 `gsatei:info:<userId>`＝`{tid, token}`（30分）。答えの取り込みは webhook の1対1の文字の判定で、2d の［直す］の印（`gsatei:fix:`）の直後。ほかの印（`satei:reason:`・`gsatei:fix:`）がその人にあるあいだは聞かずに進める（`info skip:busy`）。消すのは読んだ印と同じ token のときだけ（satei-wire の Lua の決まりと同じ）。
- I3：答えは Claude 1回（JSON。聞いた項目だけ）→ 各項目を `gsAnswerFact` で検査 → 通った分を受付票の `read.facts`（所在・物件名は `read.address`・`read.propertyName`）に足す。読めた項目が0でも、もう一度は聞かずに進める（返事「読み取れなかったので、このまま進めます」）。返事は「受け取りました（専有面積・築年月）。事例の相談の案を作ります」。
- I4：進めるのはどの道も `startGsPrep`（今の関数）。`asking-info` の票は案件・種別・押した人（`info.by`）を受付票に持っておく。30分の自動の進めは毎分の見回り（`sweepGsStage2`）が拾い、下村さんへは知らせない（このあと案のカードが届くため）。
- I5：`asking-info` のあいだに同じカードの別の案件・gm・gn・gk が押されたら「選択済み」（決定の印は `startGsPrep` が取るので、聞いているあいだは仮の印 `gsatei:dec:<tid>`=`info:<dealId>` を先に取り、`startGsPrep` の中でそれを受け入れる）。
- I6：Claude の呼び出しは 1日20回の読み取りの上限とは別に数えない（1件1回だけなので）。15秒で打ち切り、失敗したら I3 の「読み取れなかった」と同じ。

## Tasks

### Task A1：聞く・答えを読む・進める
`group-satei-facts.ts`（まとめて聞く文・聞く項目の選び方）、`group-satei-data.ts`（状態 `asking-info`・`info` の欄・鍵・data `gi`）、`group-satei-actions.ts`（pick の枝・gi・I5）、`group-satei-propose.ts`（`startGsPrep` が仮の印を受け入れる・見回りの30分）、新しい `group-satei-info.ts`（答えの取り込み）、`group-satei-wire.ts`・`src/app/api/webhook/route.ts`（取り込みの入口）、`task-buttons-wire.ts`（gi の振り分け）。テスト `tests/group-satei-2b2.test.ts`：足りない→聞く／足りている→今どおり準備へ／答えで足す（全角・和暦・坪・名前を捨てる）／［このまま進める］／30分／ほかの印があると聞かない／二度押し・古い版／off で今と同じ。CLAUDE.md に段2b-2 の節（2d の節の「足りない項目を聞く仕組みは別の計画」の行も直す）。

### Task R：点検と直し
