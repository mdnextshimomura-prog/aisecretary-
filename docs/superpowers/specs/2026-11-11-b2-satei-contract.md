# B2 査定書の下書き：3つの仕組みの受け渡し（契約）2026-11-11

設計書 `2026-11-11-b2-satei-draft-design.md` を3つのリポジトリに分けて作るときの「名前と形」の正本。3つの計画はここに合わせる。変えるときはここを先に直す。

## 0. 登場するもの
- **aisecretary**（Vercel・LINE）：ボタン、下村さんの本人確認、Notion の読み取り、個人 LINE への送信
- **reins-report**（依頼箱・Railway Postgres／テストは SQLite）：状態の正本
- **line-secretary の査定係**（Mac・新しい launchd `com.shimo.line-secretary.satei`）：作る・検品・Drive・通知の送り直し・保存

## 1. reins-report の Job に足す列（`prisma/schema.prisma`、`db push` 運用。既定値つきで既存の行を壊さない）
| 列 | 型 | 既定 | 中身 |
|---|---|---|---|
| sateiDealId | String | "" | Notion の案件ページ ID（ハイフンなし32桁） |
| sateiDealNo | Int? | null | 案件の ID 番号（DEAL-#### の数字） |
| sateiFolderId | String | "" | 案件フォルダの Drive フォルダ ID |
| sateiInputVersion | String | "" | 入力の版（第4節） |
| sateiGeneration | Int | 0 | 結果を登録するたびに +1。OK はこの値と一致したときだけ |
| sateiVerdict | String | "" | `そのまま出せる`／`要修正`／`差し戻し` |
| sateiFindings | String | "" | 指摘の上位3件（JSON 配列の文字列、各120字まで） |
| sateiDriveMd5 | String | "" | 閲覧用ファイルの Drive md5Checksum |
| sateiNoticeKind | String | "" | `draft`／`failed`／`saved`／`aborted`／"" |
| sateiNoticeState | String | "" | `pending`／`sent`／`unknown`／"" |
| sateiNoticeAttempts | Int | 0 | 送信を試した回数（3回で止めて画面に出す） |
| sateiFailReason | String | "" | `materials`／`timeout`／`folder`／`check`／`internal` |
| sateiMissing | String | "" | 足りない材料（JSON 配列の文字列） |
| sateiCarryReason | String | "" | 前回の差し戻し理由（受付のときに写す） |
| sateiRejectReason | String | "" | 今回の差し戻し理由（200字まで） |
| sateiDecidedBy | String | "" | OK／差し戻しを押した LINE userId |
| sateiSavedFileId | String | "" | 案件フォルダに入れた写しの Drive ID |
使い回す既存の列：`workflow="satei"`、`status`、`lineMessageId`（= `satei:` + LINE の webhookEventId）、`property`（案件名。画面用）、`artifactSha256`（検品した成果物）、`driveFileId`（閲覧用ファイル）、`prepRunId`・`prepLeaseUntil`・`prepHeartbeatAt`・`prepAttempts`、`deliveryClaimId`・`deliveryLeaseUntil`。

## 2. reins-report の機械用 API（すべて `isJobApiRequest`＝`x-job-token`。例外は `jobErrorResponse`）
| 口 | 入力 | 動き | 出力 |
|---|---|---|---|
| `POST /api/jobs/satei/intake` | `{eventId, dealId, dealNo, folderId, dealName, requestedBy}` | AppState のロック行 `satei-intake` を同じトランザクションで更新して直列化。同じ `dealId` で「受付・下準備中・確認待ち・差し戻し・完成・納品中・納品要確認」の satei があれば作らない。`lineMessageId=satei:eventId` が既にあれば同じものを返す。新規なら直前に取消された同じ案件の `sateiRejectReason` を `sateiCarryReason` に写す | `{created, job:{no,status}}` |
| `POST /api/jobs/satei/claim` | `{}` | ① 受付の satei を古い順に1件、または ② 下準備中で `prepLeaseUntil` が過ぎ `prepAttempts<2` のもの。新しい `prepRunId`（cuid）、`prepLeaseUntil=now+10分`、`prepAttempts+1`。受付→下準備中 | `{no, runId, leaseUntil, attempt, dealId, dealNo, folderId, dealName, carryReason}` か `204` |
| `POST /api/jobs/{no}/satei/heartbeat` | `{runId}` | runId 一致・下準備中・期限内なら `prepLeaseUntil=now+10分` | `{leaseUntil}`／`409 SATEI_STALE` |
| `POST /api/jobs/{no}/satei/result` | `{runId, outcome:"draft"\|"failed", inputVersion, artifactSha256?, driveFileId?, driveMd5?, verdict?, findings?, failReason?, missing?}` | runId 一致・期限内のときだけ。draft→確認待ち、failed→失敗。`sateiGeneration+1`、`sateiNoticeKind=draft\|failed`、`sateiNoticeState=pending` | `{status, generation}`／`409 SATEI_STALE` |
| `GET /api/jobs/satei/notices` | – | `sateiNoticeState in (pending, unknown)` かつ `sateiNoticeAttempts<3` | `{jobs:[{no, kind, generation, dealName, driveFileId, verdict, findings, missing, failReason, artifactSha256}]}` |
| `POST /api/jobs/{no}/satei/notice` | `{kind, generation, result:"sent"\|"unknown"\|"failed"}` | kind・generation が今の値と一致したときだけ記録。sent→`sent`、それ以外→`unknown` と attempts+1 | `{state}` |
| `POST /api/jobs/{no}/satei/decide` | `{decision:"ok"\|"reject", by, artifactSha256, generation}` | 確認待ちで sha と generation が一致するときだけ。ok→完成。reject→差し戻し→取消（1トランザクション）。`sateiDecidedBy=by` | `{status}`／`409 SATEI_MISMATCH` |
| `POST /api/jobs/{no}/satei/reason` | `{text}` | 取消の satei で `sateiDecidedBy` がある依頼に限り、`sateiRejectReason` を入れる（1回だけ） | `{ok:true}` |
| `GET /api/jobs/satei/saves` | – | 完成の satei と、納品中で `deliveryLeaseUntil` が過ぎた satei | `{jobs:[{no, status, folderId, artifactSha256, dealName, driveFileId, driveMd5, inputVersion}]}` |
| `POST /api/jobs/{no}/satei/save-claim` | `{}` | 既存の `claimDelivery(no, now, {via:"satei-save"})` を使う（完成→納品中）。期限切れの納品中なら取り直し | `{claimId, leaseUntil}` |
| `POST /api/jobs/{no}/satei/save-done` | `{claimId, savedFileId, sha256}` | claim 一致のとき 納品中→納品済み、`sateiSavedFileId`、`sateiNoticeKind=saved`・`pending` | `{status}` |
| `POST /api/jobs/{no}/satei/save-abort` | `{claimId, reason:"input-changed"\|"draft-changed"\|"folder-mismatch"\|"name-conflict"}` | claim 一致のとき 納品中→完成→差し戻し→取消 を1トランザクション、`sateiFailReason=reason`、`sateiNoticeKind=aborted`・`pending` | `{status}` |
- 既存の `/api/jobs/{no}/transition` など汎用の口は、`workflow==="satei"` なら `409 SATEI_LOCKED` で断る
- `sweepJobs` の「inputBatchId が空の下準備中を30分で失敗」から satei を外す。satei は「下準備中で `prepLeaseUntil+60分 < now` かつ `prepAttempts>=2`」を失敗（`sateiFailReason=timeout`、`sateiNoticeKind=failed`・`pending`）
- `GET /api/jobs?status=完成` に `workflow` の絞り込みを足す（帯替えの配達役は `workflow=obi` を付けて呼ぶ）

## 3. aisecretary
- スイッチ：`TASK_SATEI=1`（既定 off）、`TASK_SATEI_USER_IDS`（カンマ区切り。先頭が通知先＝下村さん）
- 案件カードのボタン：`v1|sa|<dealId>`（ラベル「査定書を作る」、displayText「（ボタン）査定書を作る」）。`TASK_SATEI=1` のときだけ出す
- 個人あてカードのボタン：OK `v1|so|<no>|<generation>|<sha256>`、差し戻し `v1|sr|<no>|<generation>|<sha256>`。［下書きを見る］は uri アクション `https://drive.google.com/file/d/<driveFileId>/view`
- 押されたら：`userId ∈ TASK_SATEI_USER_IDS` を確認（違えば「いまは下村さんだけが使えます」）。`TASK_SATEI` off なら「いまは止めています」。webhookEventId の冪等は既存の `pb:` 予約に乗る
- `sa` の処理：Notion で案件を読む（`案件名`、`ID` の数字、`Driveフォルダ` から `/folders/<id>` を取り出す、`物件` の1件目の CRM_物件 `種別`）。種別がマンションでない→「いまはマンションの案件だけ作れます」。フォルダが無い→「案件の Driveフォルダが未設定です」。そろえば intake を呼び、返事は「受け付けました。結果は個人の LINE に届きます（J番号）」か「作成中です（J番号）」
- `sr` のあと：KV `satei:reason:<userId>` = `<no>`（30分）。その人の次の1対1の文字メッセージを reason API に送り「理由を記録しました」
- 機械用の受け口 `POST /api/satei/notify`：ヘッダ `x-satei-token` = HMAC-SHA256(JOB_API_TOKEN, "satei-notify") の hex を `timingSafeEqualStr` で照合。入力 `{no, kind, generation, dealName, driveFileId?, verdict?, findings?, missing?, failReason?, artifactSha256?}`。通知先に push し、`X-Line-Retry-Key` は `uuidv5(no + ":" + kind + ":" + generation)`（名前空間は固定値をコードに書く）。LINE が 200 → `sent`、409（同じキーで受付済み）→ `sent`、それ以外・例外 → `unknown`。出力 `{result}`
- 文面（kind ごと。ログには J番号・kind・結果だけ）
  - draft：「🏢 査定書の下書きができました（J番号・案件名）」＋判定＋指摘3件＋3ボタン
  - failed：materials→「材料が足りないので作っていません：…（足りないもの）。入れたら［査定書を作る］を押し直してください」、timeout/check/internal→「作れませんでした（理由）。押し直すと最初からやり直します」、folder→「案件フォルダを確かめられませんでした」
  - saved：「案件フォルダの 02_査定・事例 に保存しました」
  - aborted：「資料が変わったので保存していません。［査定書を作る］を押し直してください」（name-conflict は「同じ名前で中身の違うファイルがあるので保存していません」）

## 4. 入力の版
`01_物件資料`・`02_査定・事例` の直下のファイルと `00_案件.md` について、`相対パス + "\0" + SHA-256` を相対パスの昇順に改行で連結し、その SHA-256 の hex。ただし、その案件の satei で登録した `artifactSha256`（依頼箱の saves／claim の応答に付ける `knownArtifacts`）と一致するファイルは除く。Google ドキュメントなど中身を落とせない形式は `相対パス + "\0" + "gdoc:" + modifiedTime`。

## 5. Mac の査定係（line-secretary `src/satei/`）
- 1回の起動（120秒おき・同時に1つだけ。`state/satei.lock`）で ① saves を処理 ② notices を送り直す ③ claim して1件作る、の順
- 作業場所 `cases/satei/J<no>/<runId>/input/`・`/out/`（git 管理外）
- 作る：`claude -p`（realestate-satei、40分）。検品：`codex exec --sandbox read-only --skip-git-repo-check -C <out> -o <file>`（realestate-satei-check、20分）。どちらも期限切れで子プロセスのグループを止める。作業中は5分おきに heartbeat、409 なら止める
- Drive（OAuth・mdnext.proposer）：一覧・ダウンロード・アップロード・md5 取得を `src/satei/drive.js` に新設。下書きは `SATEI_DELIVERY_FOLDER_ID`（`15_AI納品` のフォルダ ID）配下の `年月/査定/` に `J<no>_<案件名>.pdf`
- 通知は aisecretary の `/api/satei/notify`（`AISECRETARY_BASE_URL`）
