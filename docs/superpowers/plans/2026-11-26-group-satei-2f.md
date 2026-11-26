# 段2f 2通を防ぐ・送れなかった知らせの送り直し Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** ①画像のあとの名指し（photo-ask）とグループ査定（group-satei）が同じ依頼で下村さんへ2通送るのを止める。②下村さんあての知らせが LINE の不調で届かなかったとき、決まった回数だけ送り直す。

**Architecture:** aisecretary だけ。photo-ask は push の前に「この依頼はグループ査定が受け持つか」を同期の判定で確かめて譲る。送り直しは、下村さんあての1回きりの知らせを「控え（outbox）」に積み、毎分の見回りが同じ retry key で送り直す。控えには文を入れず、種類と受付票の ID だけを持ち、送るときに受付票から文を作り直す。

**Spec:** `docs/superpowers/specs/2026-11-25-group-satei-stage2-design.md` の 14・15 節（2f）。2d・2e の計画。

## Global Constraints

- スイッチは増やさない。photo-ask の譲りは「`groupSateiActive` かつ そのグループが `GROUP_SATEI_GROUP_IDS` に入っている」ときだけ。送り直しは `groupSateiPrepOn` のとき（2d・2e の知らせ）と `groupSateiActive` のとき（段1の最初の知らせ）だけ。off なら今と1バイトも変わらない。
- グループへの送信は増やさない（グループあての依頼カード・催促は送り直さない。今の作りのまま）。
- KV・ログには ID・時刻・種類・回数・符号だけ。控えに文・名前・住所を入れない。
- LINE の retry key は元の知らせと同じものを使う（届いていたのに失敗に見えた分は LINE が重ねない。retry key は24時間有効）。
- テスト：`for f in tests/group-satei-*.test.ts tests/photo-ask*.test.ts; do npx tsx $f >/dev/null 2>&1 || echo FAIL $f; done`、`npx tsc --noEmit`、`npx next build`。コミットは日本語＋`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。push しない。

## 決めたこと（Ruling）

- F1：photo-ask が譲るのは次のどれか（push の前、Claude を呼ぶ前に判定してよい）：
  (a) その発言がグループ査定の入口 A（@AI秘書 あて）か入口 B の言葉の判定（`査定`・`価格を出して` などの今の gate）を通る、
  (b) 送り主に、同じグループで開いている受付票（`gsatei:open:<groupId>` にある票で requesterId が送り主、state が asking・kind・gathering・proposing・waiting-cases のどれか、依頼から2時間以内）がある。
  譲ったらログ `[photo-ask] skip:group-satei`。予約（`photoask:*`）は取らない。— 設計の「予約を共有」を、競争の無い同期の判定に置き換えた。グループ査定のほうが受付票・ボタンを持つので、そちらを残す — 入口 B の AI が「査定でない」とした発言は、photo-ask からも出ない（どちらも査定らしさで出すので、ほぼ同じ結果）。
- F2：段1の最初の知らせ（`notifyTicket`）の送り直しは、今の掃除（`sweepGroupSatei`。毎分・3分後から）に上限を付ける。受付票に `pushTries` を数え、10回（約10分以上）だめなら掃除の対象から外してログ `[group-satei] ticket G7 push gave-up`。— 今は上限なしで受付票の7日のあいだ毎分送り続ける。
- F3：控え `gsatei:outbox`（集合。要素は `<種類>:<tid>`）と `gsatei:ob:<種類>:<tid>`＝`{tries, nextAt, firstAt}`（1日）。種類と元の retry key：
  - `prop-late`（2d の「30分たっても案が来ない」）
  - `remind-note`（2d の催促のあと下村さんへの1行）
  - `cases`（2e の結果の知らせ。いまは2回で諦めて黙る＝2e の点検 L6）
  - `cases-late`（2e の「保存がまだ終わっていません」）
  - `ambig`（2e の「どの受付か決められません」。tid の代わりに今の ambig の鍵の残り）
  知らせを送って失敗したら控えに積む（今の印は今どおり付ける＝同じ知らせを新しく作り直さない）。見回り（`sweepGsStage2` の最後。予算の残りが15秒以上のときだけ、1回に1件）が `nextAt` を過ぎたものを、受付票から文を作り直して同じ retry key で送る。送れたら控えから消す。だめなら `tries+1`、`nextAt = now + 2分×tries`、5回（最初の失敗から約30分）か `firstAt` から2時間でやめてログ `[group-satei] outbox <種類> G7 gave-up`。受付票が消えた・作り直せないときは控えから消す。
- F4：`cases` の文を作り直すのに要る数（成約・売出・失敗・保存していない数・下書きの結果の種類と #J）は、送る前に受付票の `prep.casesNote = {contract, listing, failed, unsaved, draft: "started"|"manual"|"unknown"|"house"|"land"|"failed", jobNo?}` に書いておく（文は入れない）。2e の今の「push 2回」のうち2回目は控えに任せる（push は1回、だめなら控えへ）。
- F5：2d の［いいよ］のあとグループへの依頼カードが送れなかったときの下村さんへの知らせ（案の文面つき）と、案の push（`propose`）は送り直しの対象にしない。前者は返事（reply）で出ていて、後者は今の2回の作りがあるため。

## Tasks

### Task A1：photo-ask の譲り（F1）
`src/lib/photo-ask.ts`（判定）・`photo-ask-wire.ts`（KV の読み）・`group-satei-gate.ts`（入口の判定を純粋な関数として外に出す。今の振る舞いを変えない）。テスト：譲る3つの場合、譲らない場合（グループが対象外・GROUP_SATEI off・受付票が古い・別の人の票・閉じた票）、off で今と同じ。CLAUDE.md の photo-ask の節と段1の注意（「両方 on にしない」）を書き直す。

### Task A2：最初の知らせの送り直しの上限（F2）
`group-satei-data.ts`（`pushTries`・検査）・`group-satei-open.ts`。テスト：失敗が続くと10回で外れる、途中で送れれば pushed、押されたあとの票は書かない（今の決まり）。

### Task A3：控えと送り直し（F3・F4・F5）
新しい `src/lib/group-satei-outbox.ts`（積む・取り出す・作り直す・数える）と `group-satei-propose.ts` の5か所。テスト：積む→次の見回りで同じ retry key で送る→消える／5回・2時間で諦める／受付票が消えたら消える／予算が足りなければ触らない／off で何もしない／ログに文が出ない。CLAUDE.md に段2f の節。

### Task R：点検と直し
