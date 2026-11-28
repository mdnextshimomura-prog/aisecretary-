# 担当へのまとめ・リプライの取り込み（段階2・3）計画

> 2026-11-28 下村さん決定。段階1（`GROUP_INBOX`＝依頼を下村さんの個人 LINE で仕分ける）は 5814c65 で実装済み。
> 作業場所：この worktree（枝 feat/group-satei-stage2）。**push・デプロイ・環境変数の変更はしない**（下村さんの承認が要る）。
> `.env*` は読まない。`npx prisma generate` はしない。コミットは `type: 日本語`＋末尾に `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`。

## 下村さんの言葉（要件の元）

- 会社のグループにカードは出さない（`GROUP_NO_CARDS` で実装済み）。ボタンは下村さんの個人 LINE だけ。
- 「エージェントからまとまったものの案件名、タスクの期日、進捗のリマインド…報告させるためのリマインドをちゃんとやる」
- 「担当をつけて、小笠原に対してやったら『これどうなりました？』、担当が決まってないやつは『これどうしますか？』」「箇条書きとかで」
- 「必ず返信するやつはそいつに対してリプライで返信させる。そうしたら進捗もこっちで把握して、Notion に反映できる」
- まとめは **1日2回（朝と夕方）に1通ずつ**。急ぎは下村さんが押したときだけその場で（［今すぐ聞く］は今回は作らない＝後回し）。
- 返事が無ければ、下村さんの個人 LINE に［催促する］。

## 今あるもの（読んでから作る）

- 朝8時のリマインド：`src/lib/remind.ts` `sendDailyReminders`（Vercel cron `/api/remind`）。番号つきの一覧を `LINE_GROUP_ID` へ。
  番号は Notion に `setRemindNumber`、返事「3済」「3待ち 売主の書類 金曜」「3延期 10/20」「3不要」は
  `src/lib/task-status-command.ts`・`task-status.ts`・webhook（`src/app/api/webhook/route.ts`）が処理して Notion を更新する。
  メンションは `src/lib/chunk.ts` の `buildChunks`（items の `userId`）と `pushLineChunks`。
- 毎分の見回り：`/api/obi/cloud-tick`（`src/lib/obi/cloud-*.ts`）。相乗りの例は `DUE_REMIND_TICK`（`src/lib/remind-due.ts`）と段2d の見回り。
  Vercel Hobby なので cron は増やさない。夕方の分は見回りに相乗りする（KV の「今日は送った」印で1日1回）。
- 1対1への push（retry key つき）：`pushMessagesWithRetryKey`（`src/lib/line.ts`）。仕分ける人＝`inboxOwner()`（`src/lib/candidate-card.ts`）。
- ［催促する］の作りの手本：`src/lib/group-satei-case.ts` の `gsRemindAskCard`・`group-satei-propose.ts` の `answerGsRemind`・テスト `tests/group-satei-remind-button.test.ts`。
- Notion への追記：`appendTaskNote`（`src/lib/notion.ts`）。
- グループあてのカードは `GROUP_NO_CARDS=1` で外れる（文字だけにする前提で作る）。

## 段階2：朝夕の「担当へのまとめ」（スイッチ `STAFF_DIGEST=1`。既定 off。off なら1バイトも変えない）

1. 文の組み立て（純粋な関数。新しいファイル `src/lib/staff-digest.ts`）。入力は今の朝のリマインドと同じタスクの並び。
   - 見出し：朝「📋 進捗の確認です」／夕方「📋 夕方の進捗の確認です」。
   - 担当ごとにまとめる：`{mention} どうなりましたか？`（担当の userId があればメンション、名前だけなら「◯◯さん どうなりましたか？」）、
     その下に箇条書き `n. 題名（本日期限／2日超過／期日 12/3／期日なし）` ＋ 案件名（物件名）があれば添える ＋ 待ちなら `（待ち：…）`。
   - 担当が決まっていないもの：`担当が決まっていないもの：どうしますか？` の下に同じ箇条書き。
   - 番号は全体の通し番号（今の「3済」の返事がそのまま使える）。
   - 末尾：`このメッセージに返信（リプライ）で、番号をつけて答えてください` ＋ 例（「1済」「2待ち 売主の書類 金曜」「3 アポ取れました。来週火曜です」「4 小笠原が担当します」は段階3で受ける分だけ載せる）。
   - `{` `}` を含む題名は `sanitizeForTextV2`。5000字・メンション20件の上限は `buildChunks` に任せる。
2. 朝：`sendDailyReminders` の中で、`STAFF_DIGEST=1` のときだけ文の形を上のものに替える（選び方・番号の振り方・休みの扱いは今のまま。カードは `GROUP_NO_CARDS` に任せる）。
3. 夕方：JST 17時台に1回、見回りに相乗りして同じ関数を「夕方」の見出しで送る（KV の印 `staffdigest:eve:<JSTの日付>` SET NX。休業日・火水の扱いは朝と同じ決まりに合わせる。朝に送っていない日でも送る）。
   夕方に出すのは「まだ完了していない・今日の朝の対象だったもの＋今日期限・期限超過」。0件なら送らない。
4. まとめのメッセージ ID を控える（段階3 の引用リプライ用）：`staffdigest:msg:<messageId>` = `{at, slot}`（3日）。`pushLineChunks` が ID を返さないなら、ID を返す送り方を足す（既存の関数の中身は変えない）。
5. テスト `tests/staff-digest.test.ts`：文の形・off のとき今と同じ（既存の remind のテストが通ること）・夕方の1日1回・0件。

## 段階3：リプライの取り込みと催促（スイッチは `STAFF_DIGEST` と同じ）

1. 自由な文の進捗：まとめを**引用した**返信、または番号で始まる返信のうち、今の言葉（済・完了・待ち・延期・不要 など）に当たらない
   「`3 アポ取れました。来週火曜です`」を進捗として受ける。
   - 条件を狭くする（雑談を拾わない）：①まとめのメッセージを引用している（`staffdigest:msg:` にある）かつ ②先頭が番号。引用が無い「3 …」は今までどおり扱う（何もしない）。
   - 1通に複数（「1済 2 まだです」）は、今ある番号の読み方が複数を扱えるならそれに合わせ、扱えなければ「番号ごとに1通で送ってください」とは言わず、先頭の1件だけ受けて残りは無視しない方法を選ぶ（改行で分けた各行を1件として読む）。
   - Notion：`appendTaskNote` で「進捗（11/28 小笠原）：アポ取れました。来週火曜です」を足す。状態は変えない。
   - 返事：グループへは短く「📝 3 の進捗を記録しました」（reply。送信枠を使わない）。
   - 「3 小笠原が担当します」のような担当の変更は今回は作らない（進捗として記録されるだけ）。
2. 下村さんへの知らせ：グループでの番号の返事（済・待ち・延期・不要・進捗）を KV の列 `staffdigest:fwd` に足し、
   見回りが30分に1回まとめて1通で 1対1 へ push（`💬 グループの返事（3件）` ＋ `・小笠原さん：天満の資料を送る → 済` の箇条書き。retry key つき。0件なら送らない。送れなければ列に残す）。
   月の送信枠を守るため、1件ずつは送らない。
3. 催促：夕方のまとめを送る前に、朝のまとめに出したタスクのうち「朝から状態が変わっていない・進捗の追記も無い」ものがあれば、
   下村さんの 1対1 へカード「朝のまとめに返事が無いタスクが n件あります」＋担当ごとの箇条書き＋［催促する］（`v1|sd|<JSTの日付>`）。
   押したときだけ、グループへ1回「{担当} 朝の件、進み具合を返信で教えてください（1, 4）」を担当ごとにまとめて1通（メンション）。二度押しは「もう送ってあります」。押せるのは `inboxOwner()` だけ。
   朝に出したタスクは `staffdigest:am:<JSTの日付>` = `[{id, n, title, assignee, assigneeUserId, status}]`（2日）に控える。返事があった ID は `staffdigest:answered:<JSTの日付>`（集合）に足す。
4. テスト `tests/staff-digest-reply.test.ts`：引用＋番号だけ受ける・雑談を拾わない・Notion の追記・まとめて知らせる・催促のカードと二度押し・off なら KV を1回も触らない。

## 守ること

- off（`STAFF_DIGEST` 無し）のとき、送る文・KV・Notion・ログは今と同じ。既存のテストを落とさない
  （`tests/candidate-card.test.ts` の4件と `tests/clarify.ai.test.ts` は今回の前から落ちている。直さなくてよい。増やさない）。
- ログに本文・題名・userId・groupId・messageId を出さない（符号と件数だけ。`[staff-digest] am sent 5`・`reply progress 1`・`fwd sent 3`・`nudge asked 2`・`nudge sent`）。
- グループへ出すのは文字だけ。号室・お客様の名前は、タスクの題名に入っているものはそのまま（今の朝のリマインドと同じ扱い）。
- 確かめ：`npx tsc --noEmit`、`for f in tests/*.test.ts; do npx tsx $f; done`（上の2ファイル以外が全部通る）、`npx next build`。
- 終わったら `CLAUDE.md` に `STAFF_DIGEST` の節を足す（他の節と同じ書き方）。
