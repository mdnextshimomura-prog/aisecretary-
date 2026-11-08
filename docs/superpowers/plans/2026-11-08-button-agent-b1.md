# B1 ボタンの入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 業務指示グループで、メニュー・未完了タスク・候補・案件をカードで出し、登録・完了・延期をボタンだけで済ませられるようにする。

**Architecture:** 今の Flex カード（src/lib/task-card.ts・task-buttons.ts・task-buttons-wire.ts・card-ref.ts）と postback の入口（`v1|操作|ID[|追加]`）を広げる。新しい画面はカルーセル（1件1枚・最大10枚＋［次の10件］）。判断は純粋な関数、Notion・KV・LINE は差し替えられる deps に置く（今の task-buttons と同じ形）。route.ts の変更は入口の数行に留める。

**Tech Stack:** Next.js 14 / TypeScript strict / @vercel/kv / @notionhq/client / LINE Messaging API（Flex）。テストは tests/*.test.ts を tsx（package.json の test に足す）。

**Spec:** docs/superpowers/specs/2026-11-08-button-agent-design.md（第4節が B1）

## Global Constraints
- スイッチ `TASK_MENU=1` かつ `TASK_BUTTONS=1` かつ `TASK_FOLLOWUP=1` のときだけ新機能が動く。off なら今と1バイトも変わらない（送る中身・Notion/KV の読み書き・ログ）。
- 候補カード（Task 2）はさらに `TASK_CANDIDATES=1` が必要。候補を受け付けるグループは `LINE_GROUP_ID` に加え、新しい `TASK_CANDIDATE_GROUP_IDS`（カンマ区切り）。未設定なら今と同じ（営業部だけ）。
- 送り主の制限（SECRETARY_ALLOWED_GROUP_IDS 等）が postback より先、は変えない。
- postback の data は300字以内・`v1|操作|ID[|追加]`。表示番号を ID にしない。displayText の扱いは今と同じ（二重判定しない）。
- 押せる人：タスクは今と同じ（担当・依頼者・TASK_BUTTONS_ADMIN_IDS）。候補は「依頼者・メンションされた人・ADMIN」。メニュー・一覧・案件は、送り主の制限を通ったグループのメンバーなら誰でも（見るだけ）。
- 返事は replyToken で（Reply API。push は使わない）。
- Flex：カルーセルは10枚まで、ボタンラベル40字、altText 400字、JSON 30KB 未満（Buffer.byteLength で確認）。
- 本文・顧客情報・userId・物件名をログに出さない（操作名・結果の符号・件数だけ）。
- CRM_案件 の欄には書かない（読むだけ）。
- push・deploy・Vercel 設定変更・Notion/KV の実書き込み・LINE 実送信をしない。テストは外部通信0回（fetch を失敗させる仕掛けを各新テストに）。
- コミット：`type: 日本語` + 理由1〜3行 + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 先に失敗するテスト → 実装 → npm test / npx tsc --noEmit / npm run build。

---

### Task 1: メニューと未完了タスクのカード
**Files:** Create `src/lib/task-menu.ts`（判断・カードの組み立て）, `src/lib/task-menu-wire.ts`（Notion への問い合わせ）; Modify `src/lib/task-buttons.ts`（操作名の追加・振り分け）, `src/app/api/webhook/route.ts`（メニューの言葉の入口）, `CLAUDE.md`; Test `tests/task-menu.test.ts`

要件:
1. 入口：業務指示グループ等（送り主の制限を通ったグループ）で、メンションだけの発言（@秘書 の後ろが空）か「@秘書 メニュー」で、メニューのカードを返す。ボタン［今日・期限切れ］［自分の未完了］［候補］［案件］（候補・案件は Task 2・3 で中身。今は押したら「準備中です」でよい→ Task 2・3 で差し替え）。今は「@秘書」だけの発言で何が起きているかを先に調べ、既存の動き（聞き返し・初動確認など）を壊さないこと。壊すなら「@秘書 メニュー」だけにして報告に書く。
2. ［今日・期限切れ］：未完了（完了以外・アーカイブなし）で、期日が今日以前（JST）か「次に確認する日」が今日以前のタスクを、期日の早い順に最大10件、1件＝今のタスクカード（taskCard）のカルーセル。11件以上なら最後に［次の10件］カード（data にページの続きの目印。Notion の start_cursor をそのまま data に入れず、KV に短い ID で控えるか、オフセットで引き直す）。0件なら「今日・期限切れのタスクはありません」。
3. ［自分の未完了］：押した人の LINE userId が 担当者ID のタスク（未完了）を、期日の早い順に同じ形で。担当者ID が無い人は「あなたが担当のタスクは見つかりませんでした」。
4. 一覧から出したタスクカードの各ボタンは、今のボタン処理にそのままつながる（権限・処理済み判定も今のまま）。一覧のカードの ID は cardref に控える（引用での完了・回答を結び付けるため。saveCardRefs）。
5. Notion の読み込みは1回のクエリ（＋続きのページ）に収める。既存の listTasks / getUpcomingTasks の欄の読み方に合わせる。
6. テスト：off で不変／メニューのボタンの順と文言／今日・期限切れの抽出（境界：今日・昨日・明日・確認日）／自分の未完了／10件＋次の10件／0件／JSON サイズ／fetch 0回。

### Task 2: 候補をカードで登録（原子的な保存）
**Files:** Modify `src/lib/task-candidate-store.ts`, `src/lib/task-candidate.ts`, `src/lib/task-candidate-ask.ts`, `src/app/api/webhook/route.ts`; Create `src/lib/candidate-card.ts`; Test `tests/candidate-card.test.ts`, 既存の候補テスト

要件:
1. 候補の保存を1件ずつのキーに変える：`taskcand:c:<id>`（候補の中身、期限5日）＋目次 `taskcand:index`（ID の集合。sadd/srem など原子的な操作）。一覧の全置換をやめる。既存の `taskcand:items`・`taskcand:numbered` からの移行：読むときに古い形があれば新しい形に移す（または両方を見る）。番号での「1 登録」「2 なし」は今まで通り動くこと（番号→ID の対応は numbered に残してよいが、ボタンは ID で動く）。
2. 登録の予約：［登録する］が同時に2回押されても1回だけ登録する（`taskcand:reg:<id>` を SET NX、期限は数分）。登録できたら候補を消す。失敗したら予約を外して候補を残す。
3. カード：候補1件＝1枚（題名・依頼者・いつの発言か・メンションされた人）。ボタン［登録する］［保留］［いらない］。保留＝その候補を次の17時まで出さない（印を付ける）。いらない＝候補から外す。
4. 17時のまとめ（buildDigest／task-candidate-ask）：TASK_MENU on のとき、文字の一覧のあとにカードのカルーセル（最大10＋［次の10件］）を付ける。off なら今と同じ。17時は push なので、文字＋カードを1回の push に（2通で1リクエスト）。
5. 迷った依頼：@秘書 あてで確信度 0.5〜0.7（今は候補に控えるだけ）のとき、TASK_MENU on ならその場の返事で候補カード1枚を返す（reply）。
6. メニューの［候補］：今の候補をカードで（17時と同じ形）。
7. 受け付けるグループ：`LINE_GROUP_ID` ＋ `TASK_CANDIDATE_GROUP_IDS`。候補ごとに控えたグループを持ち、別のグループからは見えない・押せない。
8. 押せる人：候補の依頼者・メンションされた人・ADMIN。それ以外は「この候補を操作できるのは依頼者・宛先の人・下村さんだけです」。
9. テスト：原子的保存（並行2件の追加で両方残る）／登録の二重押し／保留・いらない／移行（古い形のデータ）／番号の文字コマンドが今まで通り／グループ越しに見えない／押せない人／off で不変／fetch 0回。

### Task 3: 案件をカードで見る
**Files:** Create `src/lib/deal-card.ts`, `src/lib/deal-card-wire.ts`; Modify `src/lib/task-menu.ts`（［案件］）, `src/lib/task-record-wire.ts`（読む欄を足すなら）; Test `tests/deal-card.test.ts`

要件:
1. メニューの［案件］と「@秘書 案件」：進行中の CRM_案件（フェーズ ≠ 完了・失注）を、近いタスクの期日の早い順（タスクの無い案件は後ろ、名前順）に1件1枚、最大10＋［次の10件］。
2. カードの中身：案件名・フェーズ・いちばん近い未完了タスクの期日・残りタスク数（LINEタスクの `案件` relation で数える）。ボタン［タスクを見る］［タスクを足す］。
3. ［タスクを見る］：その案件の未完了タスクを Task 1 と同じタスクカードのカルーセルで。0件なら「この案件の未完了タスクはありません」。
4. ［タスクを足す］：「このあと「@秘書 内容」と送ると、この案件のタスクとして登録します（10分間）」と返し、KV に `dealnext:<groupId>:<userId>` = 案件 ID（期限10分）。その人の次の @秘書 の依頼の登録で `案件` を確定の形で入れる（TASK_RECORD の「候補あり」ではなく、人が選んだので「確定」）。登録後は印を消す。
5. 読むだけ：CRM_案件 の欄には書かない。読めない（権限・DB 未設定）なら「案件を読み取れませんでした」。
6. Notion の読み込み：案件1クエリ＋タスク1クエリ（案件のあるもの）で数える。5分のキャッシュは既存（task-record-wire）に合わせてよい。
7. テスト：並び順／タスク数と近い期日／0件／［タスクを足す］の印と次の登録への反映・期限切れ／読めないとき／off で不変／fetch 0回。

### 最後
- 全体を Codex でレビュー → 直す → 下村さんに見せて承認後に本番（スイッチ TASK_MENU を本番に入れる・TASK_CANDIDATE_GROUP_IDS に業務指示グループを入れるのも承認事項）。
