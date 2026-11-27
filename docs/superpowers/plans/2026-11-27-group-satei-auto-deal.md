# グループ査定：案件の自動登録とフォルダ作成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** 下村さんが個人 LINE で［査定］を押したとき、①ぴったり合う進行中の CRM_案件 が1件だけならそれで進め、②合う案件が無ければ AI 秘書が CRM_物件・CRM_案件 を登録し、Mac が案件フォルダを作り、Notion に URL を書いて、そのまま事例の案づくりへ進む。③決められないときだけ今のカードを出す。

**Architecture:** 3つのリポジトリ。aisecretary（判定・Notion への登録・URL の書き込み・知らせ）→ portal（準備の行に「新しく作るフォルダの名前」を持たせ、Mac の結果の folderId を行と一覧に載せる）→ Mac（準備の最初に、決まった親フォルダの下へ案件フォルダと 01・02 を作る）。フォルダ作成は今の「準備（prep）」の依頼に相乗りする（新しい依頼箱・新しい口は作らない）。

**Spec（下村さんが決めたこと・2026-11-27）:**
1. ［査定］を押したとき、読み取った物件名・所在にぴったり合う進行中の CRM_案件 が1件だけなら、それを選んだのと同じに進める。
2. 合う案件が無ければ、CRM_物件 と CRM_案件 を自動で登録する（フェーズ「【売】査定」・案件種別「売買仲介」・取引区分「仲介」・取引の立場「売却」・担当（仮）「下村」・物件 relation・備考「グループ査定 受付 G7 から自動登録」。顧客・案件ソースは空）。
3. Mac が案件フォルダ `DEAL-0231_売却_顧客未定_<物件名>` を「担当フォルダの段階の箱（01_相談）」に作り、中に `01_物件資料`・`02_査定・事例` を作る。
4. フォルダの URL を案件の `Driveフォルダ` に書き、`フォルダ状態` を「作成済」に。個人 LINE に「案件 DEAL-0231 として登録しました（受付 G7）」→ 事例の案 → 山口さんへの依頼へ。
5. 合いそうな案件が複数で決められないときだけ、今までどおりのカード。
6. 新しいスイッチ（既定 off。off なら今と1バイトも変わらない）。

## Global Constraints

- スイッチ `GROUP_SATEI_AUTO_DEAL`（aisecretary。既定 off）。off のとき：KV・Notion・portal への呼び出し、返事の文、受付票の形、portal へ送る JSON は今と1バイトも変わらない。portal・Mac の足しは「新しい欄が来たときだけ」動く（来なければ今と同じ）。
- グループへの送信は増やさない（この計画はグループへ1通も足さない）。下村さんの1対1への push も増やさない（登録の知らせは［査定］の返事＝reply。足すのは失敗のときの1通だけ）。
- KV・ログに名前・住所・フォルダ名・案件名を出さない。出すのは符号・受付番号（G7）・案件番号（D231）・回数だけ。受付票に足すのは ID・番号・時刻・段の符号だけ（フォルダ名は入れない。Notion の 物件名 から毎回作り直す）。
- 顧客名をフォルダ名・ログに入れない（フォルダ名の顧客の所は固定の「顧客未定」）。
- 案件の二重登録を防ぐ印：①受付票ごとの印 `gsatei:dec:<tid>` = `auto:<tid の頭8字>`、②Notion の備考に入れる「票 <tid の頭8字>」を作る前に探す、③作る直前に同じ物件名の進行中の案件を（5分の覚えを使わず）探す。
- Notion へ書くのは、この流れで新しく作ったページ（CRM_物件・CRM_案件）と、その案件の `Driveフォルダ`・`フォルダ状態` だけ。既存の案件・物件の欄は書き換えない（ぴったり合った既存の案件にも何も書かない。既存の物件ページを使い回すときも relation を張るだけで物件ページは触らない）。
- 稼働中の本体（`apps/line-secretary`・`apps/reins-report`・`apps/Customer relationship management`）ではテスト・枝の切り替えをしない。作業は worktree。**reins-report の worktree で `prisma generate` を実行しない**（`npm run build` は prisma generate を含むので使わない。`npx next build` を使う）。
- `.env`／`.env.local` は読まない。env を足す・スイッチを入れる・push・deploy は下村さんの承認後。
- コミットは日本語＋ `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`。push しない。

## 調べた事実（根拠）

**aisecretary**（`.worktrees/group-satei-stage2`、feat/group-satei-stage2、HEAD 8249827）
- ［査定］は `chooseKind`（`src/lib/group-satei-actions.ts:338-357`）。`a.code === "satei"` のとき印を取らず、受付票に `requestKind:"satei"` を書いて `gsSateiNextCard` を返す（340-351）。
- ［案件がまだ無い］は `decide` の `gm`（374-381）：受付票を `manual`・`provisional:true` にして `msgGsNoDeal`（`group-satei-card.ts:235`）。
- 案件を選ぶのは `pick`（88-120）：`loadDeals()` の一覧にある ID だけ（100）→ `readDeal` → 2b-2 の `maybeAskInfo`（192-248。**フォルダが無い案件は聞かない**＝205）→ `proceedPick`（128-186）→ `startGsPrep`。
- `startGsPrep`（`group-satei-propose.ts:48-102`）：`deal.folderId` が無ければ `MSG_GS_NO_FOLDER`（62）。印 `prep:<dealId>` を SET NX（63）。仮の印を受け入れる仕組み（`opts.infoDec`・`gsInfoPrepKey`。64-67）が既にある。portal へ `{tid,no,dealId,folderId,kind,place,building,facts,requestedBy}`（72-78）。受付票は `gathering`（93-98）。
- 見回り `sweepS2Tickets`（462-）：`gathering` の票は portal の一覧の行（`notices`）が来たら `deliverProposal`（358-374。`相談中` 以外は `failToManual`）。30分で `msgGsPrepLate`（503-508）。
- portal の口の型 `SateiPrepIntakeReq`・`SateiPrepNotice`・`asNotice`（`group-satei-prep-portal.ts:9-39, 71-86`）。`asNotice` は知らない欄を捨てる（＝portal が欄を足しても古い aisecretary は壊れない）。
- 案件の読み方 `readSateiDealPage`（`satei-deal.ts:44-63`）：`案件名`・`ID`（unique_id の number）・`Driveフォルダ`（url）・`物件`（relation）。`folderIdFromUrl` は `https://drive.google.com/drive/folders/<id>` だけ通す（25-38）。種別は CRM_物件 の `種別`（65-69）。
- 保存直前の照合 `folderMatches`（`satei-folder-check.ts:32-39`）：案件が消えていない・親が CRM_案件・ID 一致・`deal.folderId === input.folderId`。＝ Notion の `Driveフォルダ` に同じ ID の URL が入っていれば通る。
- Notion の Client：`makeSateiNotion`（`satei-wire.ts:34-40`。`CRM_NOTION_TOKEN ?? NOTION_API_KEY`・ログを出さない）。`crm.ts` は `CRM_NOTION_TOKEN` で CRM_顧客・CRM_案件 に `pages.create` している（`crm.ts:23, 282-293, 389-392`）＝この連携は CRM_案件 を作れる前提で既に動いている。
- **CRM_物件 の DB ID を持つ設定は無い**（`src` の `CRM_*` は `CRM_NOTION_TOKEN`・`CRM_ACCOUNTS_DB_ID`・`CRM_ACTIVITIES_DB_ID`・`CRM_DEALS_DB_ID` の4つだけ）。CRM_物件 のページは relation の ID から読んでいるだけ（`satei-wire.ts:71-73`）。DB への作成が通るかはコードからは分からない（下の「分からなかったこと」）。
- 既存の `createDeal`（`crm.ts:269-295`）：案件名 `対応内容｜氏名｜物件`、`案件種別`・`取引区分`・`フェーズ`・`取引の立場`・`備考`。作成後の `ID` は読んでいない。
- 照合 `matchDeals`・`candidateDeals`（`task-record.ts:40-116`）：案件名を「｜」で分けた各部分と全体を `normalizeProperty`（`property.ts:47-71`）にかけ、鍵が完全一致なら exact、4字以上の含み合いなら partial。段1のカードの候補は `propertyName` と `address` の鍵で `candidateDeals`（`group-satei-open.ts:236-238`）。
- 進行中の案件 `loadActiveDeals`（`task-record-wire.ts:24-63`）：フェーズが 完了・失注 以外。**5分覚える**（20-21, 27）。
- CLAUDE.md の段2a（214-221）・2d（223-234）・2b-2（236-247）・2e（249-256）・2f（258-）。

**portal**（reins-report。origin/main = d9148b5。本体の main は 704a7fe で origin/main より古い）
- 準備の行は AppState（key `satei-prep:<tid>`、値 JSON）。表・列は足さない作り（`src/lib/satei-prep.ts:1-6`）。
- `intakeSateiPrep`（150-185）：**`folderId` は必須**（157。`DRIVE_FILE_ID_RE`）。同じ tid の2度目は同じ行（dealId 違いは 409 `INTAKE_MISMATCH`）。
- `claimSateiPrep`（219-235）が Mac へ返す形 `PrepClaim`（213-216。`folderId` を含む）。予約20分・2回まで（15-17）。
- `reportSateiPrep`（249-270）：`{runId, outcome:"proposed", lines, areaDone}`／`{runId, outcome:"failed", failReason}`。`failReason` は `folder|internal|timeout`（26, 257）。
- `listSateiPrepNotices`（280-291）・`decideSateiPrep`（296-320）・`claimPrepCases`（357-378。**`folderId` を行から返す**＝2e の保存先）。
- route：`src/app/api/jobs/satei/prep/route.ts`（201／200、`{created, prep:{tid,status}}`）、`prep/claim`、`prep/[tid]/result` ほか。テスト `test/satei-prep.test.ts`（vitest）。

**Mac**（line-secretary。本体 feature/v1 d3a96d6）
- `runPrep`（`src/satei/prep.js:20-136`）：予約の検査（25。`folderId` は文字ならよい）→ `readCaseFolder(c.folderId)`（61）→ 開けなければ `fail("folder")`（68）→ 地域の調べ → 案 → `prepResult`。ログは `satei-prep #G7 proposed` の形。
- `ensureFolder(parentId, name)`（`drive.js:134-141`）：同じ名前があればその ID、無ければ作る（冪等）。`findFolder`（129-132）。`readCaseFolder`（181-191）は `01_物件資料`・`02_査定・事例`・`00_案件.md` を名前で探す。
- **`00_案件.md` は無くても困らない**：あれば入力の1つとして拾う（`drive.js:314`）・版の計算に入る（`version.js:3`）だけ。必須にしている所は無い。
- **`02_査定・事例` は必須**：下書きの保存は `folder.sateiId` が無いと `folder-mismatch`（`save.js:133-134`）、事例の保存も `sateiId` が無いと `fail("folder")`（`cases.js:124`）。`01_物件資料` は地域の調べの保存先（`area.js:656`）。
- Drive の鍵は `mdnext.proposer` の `SATEI_GOOGLE_REFRESH_TOKEN`（`drive.js:3, 24-31`）。置き場の「②売買」は同じアカウントのマイドライブにある。
- 設定：`SATEI`（`config.js:227-271`）、`sateiPrepFrom`（53-55。`SATEI_PREP=1`）。tick の準備の枝（`tick.js:277-299`）。テストは `npm test`（`node --test test/*.test.js delivery/test/*.test.js`。`package.json:10`）。

**CRM の P3（既存のフォルダ自動作成）**（`.worktrees/p3/scripts/sync/`）
- (a) 名前：`naming.py:5-12, 33-35`。禁止文字 `/\:*?"<>|` を `_` に、前後の空白を落とし、`_` の連続を1つに（sanitize）。80字で切る（clip）。`DEAL-%04d_%s_%s_%s`（番号・種別・顧客＋「様」・物件）。顧客・物件が無い移行分は `DEAL-####_種別_元のフォルダ名`（38-41）。
- (b) 置き場：`deal_folders.py:19-23, 66-71`。`マイドライブ/②売買/<S###_氏名>/01_売買/01_相談/`（買取は `02_買取/01_査定`）。下村さんは `②売買/S003_下村/01_売買/01_相談/`（実在を確認。中に `DEAL-01xx_売却_…` が並んでいる）。サブフォルダは6つ（`01_物件資料`〜`99_古い資料`。16行）。
- (c) `00_案件.md` の8キー（`deal_folders.py:96-116`）：`案件番号`・`種別`・`顧客`・`物件`・`区分`・`担当`・`決済予定`・`Notion`。
- (d) **P3 は今動いていない**：本体の `scripts/sync/` に `deal_folder_sync.py` が無く、`run_crm_sync.sh` は `crm_progression.py --execute` だけ。launchd `com.shimo.crm-sync` はこの本体の `run_crm_sync.sh` を呼ぶ。`tmp/crm_sync.log` に deal_folder・フォルダ の行は0件（末尾は「② 顧客→案件」「③ 案件→取引」だけ）。組み込み版は worktree の `run_crm_sync.v2.sh:28`（未適用）。
- (e) 後で動いても二重に作らない：候補は `フォルダ状態` が 作成済・失敗・旧資料 **以外**（`notion_deals.py:138-146`）。こちらが「作成済」を書いたあとは対象外＝作り直さない・書き戻さない。書く前の数分に P3 が回ると、必須項目不足（顧客名・案件ソース）で `フォルダ状態`=未・`不足理由` を書く（`deal_folder_sync.py:63-71`）が、フォルダは作らない。こちらの「作成済」があとから上書きする（`不足理由` は残る＝害は無い）。
- CRM_物件 の欄（`docs/00_データ辞書.md:121-139`）：`物件名`（title）・`種別`（select：土地／戸建／マンション／収益／その他）・`所在地`（rich_text）・`土地面積㎡`・`建物面積㎡`・`備考`。CRM_物件 の DB ID は CRM のリポジトリの `notion/db_ids.json` の鍵 `properties`。
- 進行ログ（11/27 の行）：CRM_案件 に `フォルダ状態`・`不足理由` の欄あり。本番は 2d・2e・2b-2 が on（11/26 23:57）、催促ボタンの版が本番（11/27 22:4x）。本物の依頼での通しは未確認。

## 決めたこと（Ruling）

### A1 スイッチと設定

| 名前 | 置き場 | 中身 | 誰が |
|---|---|---|---|
| `GROUP_SATEI_AUTO_DEAL` | aisecretary（Vercel production） | `1` のときだけ。既定 off | 承認後に Claude |
| `CRM_PROPERTIES_DB_ID` | aisecretary（Vercel production） | CRM_物件 の DB ID（`notion/db_ids.json` の `properties`） | 承認後に Claude（値を画面に出さない方法） |
| `SATEI_DEAL_PARENT_FOLDER_ID` | Mac（line-secretary の `.env` の末尾に追記） | `②売買/S003_下村/01_売買/01_相談` の Drive フォルダ ID | 承認後に Claude（中身は読まない・追記だけ） |

- `groupSateiAutoDealOn(env)` ＝ `groupSateiPrepOn(env)` かつ `GROUP_SATEI_AUTO_DEAL==="1"` かつ `CRM_PROPERTIES_DB_ID` が32桁の16進（ハイフン入りも可・そろえて使う）かつ `CRM_DEALS_DB_ID` がある。どれか欠ければ off（今のまま）。
- portal に新しい env は無い（`SATEI_PREP` のまま）。

### A2 「ぴったり合う」の判定（既存の照合を再利用）

新しい純粋な関数 `gsAutoMatch(read, deals)`（`src/lib/group-satei-auto.ts`）。`deals` は `loadDeals()`（進行中＝完了・失注以外）。
- 鍵：`read.propertyName`・`gsBuildingOf(read)`・`read.address` を `normalizeProperty` にかけた、空でないもの（重なりは1つに）。
- exact＝案件名を「｜」で分けた各部分・全体の鍵（`task-record.ts` の `dealKeys` を export して使う）のどれかが、鍵のどれかと完全一致する案件。partial＝`candidateDeals` に当たるが exact でない案件。
- 結果：
  - `{kind:"none"}`：exact 0・partial 0 → **自動登録へ**
  - `{kind:"one", deal}`：exact がちょうど1件で、その `phase` が「【買】」で始まらない → **その案件で進める**（partial があっても進める）
  - `{kind:"ask", reason}`：exact 2件以上（`exact2`）／exact 0 で partial 1件以上（`partial`）／exact 1件だがフェーズが【買】（`buy`）→ **今のカード**
- 判定に入る前の条件（どれか欠ければ今のカード）：`read` がある／`read.kind` がマンション・戸建・土地／鍵が1つ以上ある（`no-key`）／`loadDeals` が読めた。
- 理由：`matchDeals` の「完全一致が1件だけ」と同じ線引き。部分一致だけのとき新しく作ると二重登録になりやすいので、人に聞く側に倒す。買いの案件に売却の査定を結びつけない。

### A3 名前の作り方

- **物件名（CRM_物件 の title）** `gsPropTitle(read)`：
  - マンション：`read.propertyName`（今の読み取りは「マンション名と号室」）。無ければ `<所在> マンション`。
  - 戸建・土地：`read.propertyName` があればそれ。無ければ `<所在> 戸建`／`<所在> 土地`。
  - NFKC・前後の空白を落とす・空白の連続を1つに・改行を空白に・60字（コードポイント）で切る。空なら自動登録しない（今のカード）。
  - 例：`パークハウス天満 1203`／`豊中市永楽荘4丁目12-3 戸建`
- **案件名（CRM_案件 の title）**：`査定｜顧客未定｜<物件名>`（100字で切る）。例：`査定｜顧客未定｜パークハウス天満 1203`。— `crm.ts` の `対応内容｜氏名｜物件` と同じ並び。「｜」で分けた部分に物件名がそのまま入るので、同じ物件の次の依頼は A2 の exact に当たる（＝二重に作らない）。
- **フォルダ名** `gsDealFolderName(dealNo, propTitle)`：`DEAL-%04d_売却_顧客未定_<物件名>` を P3 と同じ sanitize（`/\:*?"<>|` → `_`、前後の空白を落とす、`_` の連続を1つに）→ 80字（コードポイント）で切る。例：`DEAL-0231_売却_顧客未定_パークハウス天満 1203`。
  - `<物件名>` は KV に持たず、**準備を頼む直前に Notion の CRM_物件 の title を読んで**作る（2b-2 の答えで読み取りが変わっても、Notion の物件名と同じ名前になる。P3 も物件の title を使う）。
  - 「顧客未定」に「様」は付けない（頼み手の指定どおり。P3 の `folder_name` を通すと「顧客未定様」になるので、P3 の関数は使わず、移行分の形 `DEAL-####_種別_<名前>` に合わせる）。

### A4 Notion へ書く中身（新しいページだけ）

- **CRM_物件**（親 `CRM_PROPERTIES_DB_ID`）：`物件名`＝A3、`種別`＝マンション／戸建／土地、`所在地`＝`read.address`（あれば）、`土地面積㎡`＝`facts.landArea`（あれば）、`建物面積㎡`＝`facts.buildingArea`（あれば。専有面積は入れない）、`備考`＝`グループ査定 受付 G7 から自動登録（票 ab12cd34）`。`ステータス` は入れない。
  - 作る前に、①`備考` に `票 ab12cd34` を含むページ（同じ受付票のやり直し）、②`物件名` が A3 と完全に同じページ、の順で探し、あればそれを使う（**そのページは書き換えない**）。
- **CRM_案件**（親 `CRM_DEALS_DB_ID`）：`案件名`＝A3、`フェーズ`＝`【売】査定`、`案件種別`＝`売買仲介`、`取引区分`＝`仲介`、`取引の立場`＝`売却`、`担当（仮）`＝`下村`、`物件`＝relation、`備考`＝`グループ査定 受付 G7 から自動登録（票 ab12cd34）`。`顧客`・`案件ソース`・`主担当`・`フォルダ状態` は空。
  - 作る前に、①`備考` に `票 ab12cd34` を含む案件（あればそれを使う＝やり直しで増やさない）、②`案件名` が `<物件名>` を含む進行中の案件を **覚えを使わず** 1回探す（当たれば作らずに今のカード。理由の符号 `fresh-dup`）。
- **案件番号**：`pages.create` の答えを `readSateiDealPage` で読み `dealNo`（`properties.ID.unique_id.number`）。null なら1秒待って `pages.retrieve` を1回。まだ null なら失敗（A7 の `id`）。
- **フォルダのあと**（見回り）：その案件の `Driveフォルダ`＝`https://drive.google.com/drive/folders/<folderId>`、`フォルダ状態`＝`作成済`。書く直前にページを読み直し、`Driveフォルダ` が空か同じ URL のときだけ書く（別の URL が入っていたら書かない＝人が先に入れた。A7 の `link-conflict`）。
- Notion の呼び出しは1回 `CRM_TIMEOUT_MS`（今の `within`）。Client は `makeSateiNotion()`（ログに ID・名前を出さない）。

### A5 流れ（aisecretary）

**［査定］（`chooseKind` の satei の枝）**。`groupSateiAutoDealOn` が off なら今の行をそのまま通る。on のとき、今の「`requestKind:"satei"` を書く」のあとに `gsAutoDeal(a, tk, userId, deps, kv)` を呼ぶ。null が返れば今の返事（`msgGsKindSatei`＋`gsSateiNextCard`）。
1. 条件・`gsAutoMatch`。`ask` → null（今のカード。返事の文の頭に1行足す：下の文面 M3）。
2. `one` → `readDeal` → `pick` の後半と同じ道（`maybeAskInfo` → `proceedPick`）。一覧にあるかの確かめ（`pick` の100行目）は、いま `loadDeals` で読んだ中の案件なので済み。返事は M1＋今の文。**Notion には何も書かない。**
3. `none` → 印 `gsatei:dec:<tid>` を `auto:<tid8>` で SET NX（取れなければ「選択済み」）。受付票に `auto = {step:"prop", at, tries:1}` を書き、集合 `gsatei:autoq` に足す。
4. 物件（A4）→ 受付票 `auto.propId`・`step:"deal"` → 案件（A4）→ `auto.dealId`・`auto.dealNo`・`step:"prep"`。`fresh-dup` に当たったら印を外して `auto` を消し、今のカード（M3）。
5. 2b-2：`maybeAskInfo` に `held:"auto:<tid8>"` を渡す（今の印がこの値のときだけ `info:<dealId>` に書き換える。フォルダが無くても `tk.auto?.dealId === dealId` なら聞く）。聞いたら返事は M2＋聞く文。
6. 準備：`startGsPrep`。`deal.folderId` が無く `tk.auto?.dealId === a.dealId` かつ on のときだけ、CRM_物件 の title を読み（`deps.propTitle(propertyId)`）、portal へ `folderId` の代わりに `newFolder:{name}` を送る（B1）。印は今の「仮の印を受け入れる」仕組みで `prep:<dealId>` に（`infoDec` に `auto:<tid8>` か `info:<dealId>`）。受付票は `gathering`、`auto.step:"folder"`。返事は M2。
7. 見回り（`sweepS2Tickets` の `gathering`）：一覧の行が来た票で `tk.auto && !tk.auto.linked` のとき、`deliverProposal` の前に `gsLinkAutoFolder`：
   - 行に `newFolderId` がある → A4 の「フォルダのあと」を書く → `auto.linked:true`・`step:"done"`・`autoq` から外す → そのまま今の `deliverProposal`（`相談中` なら案のカード。`失敗` なら M6 で手作業）。
   - Notion に書けない → その回は案を出さずに次の回へ（`auto.linkTries+1`）。5回だめなら M5 を1通（URL つき）→ `linked:true` にして案を出す（事例の依頼は進める。下書きは Notion に URL が入るまで始まらない＝今の「下書きを始められませんでした」の文になる）。
   - 行が `失敗` で `newFolderId` が無い → M4（フォルダを作れなかった）で手作業（`failToManual` と同じ閉じ方）。
8. そのあと（［いいよ］→ 山口さんへの依頼 → 事例の保存 → 下書き）は今のまま。事例の保存先は portal の行の `folderId`（Mac の結果で埋まる。B3）、下書きは Notion の `Driveフォルダ` を読む（7 で書いてある）。保存直前の照合（`folderMatches`）は Notion の URL の ID と portal の `folderId` が同じなので通る。

**［案件がまだ無い］（gm）**：on で、受付票の `requestKind === "satei"` のときは、A2 を飛ばして 3 から（＝押したら自動登録）。A4 の `fresh-dup` に当たれば M3 で一覧へ。off・査定以外は今のまま（仮の決定）。— Spec 5 は「今までどおりのカード」。カードの形・ボタンは変えず、［案件がまだ無い］の中身だけ「手作業」から「登録する」に替える（決められないときに手作業へ落とさないため。**頼み手の判断が要る点**として最後に挙げる。要らなければ gm は今のままにできる＝Task A2 の1か所）。

**途中で落ちたとき**（毎分の見回り `sweepGsAuto`。2b-2 の見回りの前・予算の残り25秒以上・1回に1件）：`gsatei:autoq` の票で `auto.step` が `prop`・`deal`・`prep` のまま `auto.at` から3分たったものを、同じ段から続ける（A4 の「探してから作る」で増えない）。`auto.tries` 3回でやめて M7 を1通（retry key `auto-fail:<tid>`。送れなければ段2f の控えに種類 `auto-fail`）、印を外し、受付票を `asking`・`provisional` なしに戻す（`auto` は `step:"gave-up"` で残す。案件ができていれば `dealNo` つき）。

**受付票に足す欄** `auto?: {step:"prop"|"deal"|"prep"|"folder"|"done"|"gave-up", at:number, tries:number, propId?:string, dealId?:string, dealNo?:number, linked?:boolean, linkTries?:number}`。状態（`GsState`）は増やさない（古い版の `asTicket` が読めなくならないように）。`asTicket` に `auto` の形の検査を足す。

### B portal の受け渡し（正確な形）

**B1 受付 `POST /api/jobs/satei/prep`**（足す欄だけ）
```json
{ "tid": "…", "no": 7, "dealId": "…", "kind": "マンション", "place": null, "building": null, "facts": {…}, "requestedBy": "U…",
  "newFolder": { "name": "DEAL-0231_売却_顧客未定_パークハウス天満 1203" } }
```
- `folderId` と `newFolder` は**どちらか一方だけ**（両方・どちらも無い → 400 `INVALID_REQUEST`）。`folderId` だけなら今と同じ。
- `newFolder.name` の検査：文字列・80字（コードポイント）以内・`^DEAL-[0-9]{4,6}_売却_顧客未定_.+$`・`/\:*?"<>|` と制御文字（U+0000–001F・007F）を含まない・前後に空白が無い。違えば 400。
- 行（`PrepRow`）に `newFolder: {name:string} | null` を足す（古い行は読むとき null で補う）。`newFolder` の行は `folderId: ""` で始まる。同じ tid の2度目は今どおり同じ行。

**B2 予約 `POST /api/jobs/satei/prep/claim`**
- 体に `{ "caps": ["newFolder"] }` を受ける（無い・形が違えば caps なし）。`newFolder` のある行は、caps に `newFolder` がある呼び手にだけ渡す（古い Mac には渡らない＝行は `受付` のまま。aisecretary の30分の知らせに乗る）。
- 答えに `newFolder: {name} | null` を足す（`folderId` は `""`）。

**B3 結果 `POST /api/jobs/satei/prep/{tid}/result`**
- `{runId, outcome:"proposed", lines, areaDone, folderId}`：行に `newFolder` があり `folderId` が空のとき **`folderId` が必須**（`DRIVE_FILE_ID_RE` かつ10字以上。無ければ 400）。行の `folderId` に入れる。`newFolder` の無い行に `folderId` が来たら無視。
- `{runId, outcome:"failed", failReason, folderId?}`：`failReason` に `folder-create`（作れなかった・同じ番号のフォルダが2つ以上）・`folder-config`（親フォルダの設定が無い）を足す。`folderId` があれば行に入れる（作れたあとに落ちたとき、次に使える）。
- 状態の遷移は今のまま（受付 → 作業中 → 相談中／失敗 → 依頼済み → 事例あり → …）。足すのは行の欄だけ。

**B4 一覧 `GET /api/jobs/satei/prep/notices`**
- 各行に `newFolderId: string | null` を足す（行に `newFolder` があり `folderId` が入っているときだけ ID、ほかは null）。古い aisecretary は読み捨てる。

**B5 後方互換**
- 新 portal＋古い aisecretary：`newFolder` が来ない＝今と同じ。新 portal＋古い Mac：caps が無いので `newFolder` の行は渡らない（今の行は今どおり）。
- 古い portal＋新 aisecretary（スイッチ on）：`folderId` が無いので 400 → aisecretary は「断られた」＝M8。だから portal を先に出す。

### C Mac の受け渡し

- `SATEI.dealParentFolderId`＝`SATEI_DEAL_PARENT_FOLDER_ID`（`config.js` の `sateiPrepFrom` に足す。`/^[A-Za-z0-9_-]{10,}$/` でなければ空）。
- `portal.prepClaim` は体を `{caps:["newFolder"]}` にする（設定の有無に関わらず、作れる版であることを伝える）。
- `runPrep` の最初（`readCaseFolder` の前）に `c.newFolder` があれば `ensureDealFolder`：
  1. 名前を B1 と同じ検査（違えば `claim-invalid`。結果は送らない＝今と同じ）。
  2. `dealParentFolderId` が空 → `fail("folder-config")`（ログ `satei-prep #G7 folder config-missing`）。
  3. 親の直下を `listChildren` し、フォルダで名前が `DEAL-0231_`（名前の頭の `DEAL-<数字>_`）で始まるものを探す。0件 → `ensureFolder(parent, name)`（作る）。1件 → それを使う（名前が違っても。P3 や人が先に作った分・やり直し）。2件以上 → `fail("folder-create")`（ログ `folder dup`。どれかを選ばない）。
  4. `ensureFolder(folderId, "01_物件資料")`・`ensureFolder(folderId, "02_査定・事例")`。
  5. 以後は `c.folderId = folderId` として今の流れ（`readCaseFolder` → 地域の調べ → 案）。
  6. 結果の `send` に `folderId` を足す（`proposed` でも `failed` でも、作れていれば）。
  - Drive の失敗（例外）→ `fail("folder-create")`。SIGTERM は今どおり結果を送らず返る（期限切れで portal が取り直させ、3 の「あれば使う」で二重に作らない）。
- `00_案件.md` と残りの4つのサブフォルダ（`03_契約`〜`99_古い資料`）は作らない（査定係は要らない。下の「人の判断が要ること」）。
- ログ：`satei-prep #G7 folder created`／`folder reused`／`folder dup`／`folder config-missing`（名前・ID は出さない）。

### A6 LINE に出す文（下村さんの1対1だけ。`R(no)`＝`受付 G7`）

- M1（ぴったり合った。返事の頭）：`進行中の案件「<案件名>」に合ったので、この案件で進めます（受付 G7）`＋改行＋今の文（`msgGsPrepStarted` など）
- M2（登録した。返事）：`案件 DEAL-0231 として登録しました（受付 G7）。フォルダを作って、事例の取り方の案を数分でお送りします。顧客と案件ソースは、あとで Notion に入れてください`（2b-2 で聞くときは、この文のあとに聞く文）
- M3（決められない。今のカードの文の頭）：`合いそうな案件が複数あるので、選んでください（受付 G7）`（`fresh-dup` のとき：`同じ物件の進行中の案件が見つかりました。一覧から選んでください（受付 G7）`）＋今のカード
- M4（フォルダを作れなかった。push・retry key `prepfail:<tid>`）：`案件 DEAL-0231 は登録しましたが、案件フォルダを作れませんでした（受付 G7）。フォルダを手で作り、CRM_案件 の Driveフォルダ に入れてください。山口さんへは手で頼んでください`（`folder-config` のときは末尾に `（Mac の親フォルダの設定がありません）`）
- M5（Notion に URL を書けなかった。push・retry key `auto-link:<tid>`）：`案件 DEAL-0231 のフォルダは作りましたが、Notion に書けませんでした（受付 G7）。CRM_案件 の Driveフォルダ に次を入れてください：https://drive.google.com/drive/folders/<id>`（別の URL が入っていたとき：`…Driveフォルダ に別のフォルダが入っています。新しく作ったフォルダは次です：…`）
- M6（案を作れなかった。今の `msgGsPrepFailed` の頭に）：`案件 DEAL-0231 とフォルダは作ってあります。`
- M7（登録が途中で止まった。push）：`案件の自動登録が途中で止まりました（受付 G7）。`＋（案件ができていれば `CRM_案件 DEAL-0231 はできています。`）＋`カードの［一覧から選ぶ］で選ぶか、もう一度［査定］を押してください`
- M8（その場で失敗。返事）：Notion に書けない → `案件を登録できませんでした（受付 G7）。少し待ってから、もう一度［査定］を押してください`（印を外す。`auto` の ID は残す＝押し直しは続きから）／portal に断られた → `案件 DEAL-0231 は登録しましたが、事例の案づくりを受け付けられませんでした（受付 G7）。山口さんへは手で頼んでください`

### A7 失敗のとき（まとめ）

| 何が起きた | 符号（ログ） | 下村さんへ | どこから手作業 |
|---|---|---|---|
| 物件・案件を作れない／番号が読めない | `auto failed G7 notion-prop\|notion-deal\|id` | M8（返事） | 押し直し（続きから）。3回目は M7 |
| 作る直前に同じ物件の案件が見つかった | `auto card G7 fresh-dup` | M3＋カード | 一覧から選ぶ |
| portal が受けない（400・409） | `auto failed G7 intake` | M8 の2つ目 | 山口さんへ手で。案件は残る |
| portal が止めている（PREP_DISABLED・INTAKE_STOPPED）／結果不明 | 今の符号 | 今の文（`msgGsPrepStopped`・`msgGsPrepUnknown`）の頭に `案件 DEAL-0231 として登録しました。` | 今と同じ。**PREP_DISABLED でも 2a の道へは行かない**（フォルダが無いので下書きは始められない） |
| 親フォルダの設定が無い | Mac `folder config-missing`／`auto folder-failed G7 config` | M4 | フォルダを手で作る |
| フォルダを作れない・同じ番号が2つ | Mac `folder dup` ほか／`auto folder-failed G7 create` | M4 | 同上 |
| 同じ名前・同じ番号のフォルダが1つある | Mac `folder reused` | （知らせない） | そのフォルダを使う |
| Notion に URL を書けない（5回） | `auto link-failed G7` | M5（URL つき） | Driveフォルダ を手で入れる。事例の依頼は進む |
| Driveフォルダ に別の URL が入っていた | `auto link-conflict G7` | M5 の別の文 | 人が決める（上書きしない） |
| 途中で落ちた | `auto resumed G7`／`auto gave-up G7` | 3回目に M7 | カードから |
| Mac が古い・止まっている | 今の `prep late G7` | 今の30分の知らせ | 今と同じ |

### A8 途中の不整合を残さない順序

- 物件 → 案件 → portal の順。どの段も「印（票 tid8）で探してから作る」ので、落ちてやり直しても増えない。
- 「案件だけできてフォルダが無い」：受付票が `gathering`・`auto.step:"folder"` で残る → portal の行が Mac を待つ → 見回りが `newFolderId` を受けて Notion に書く。Mac が動かなければ30分の知らせ、portal の行は8日で消える。案件は Notion に残る（`Driveフォルダ` が空＝次に選ぶと今の「Driveフォルダが未設定です」）。
- 「フォルダはできて Notion に書いていない」：一覧の行（`相談中`・8日残る）に `newFolderId` が残るので、毎分の見回りが書き直す。5回で M5。
- P3 との住み分け：こちらは `フォルダ状態` を空で作り、フォルダができたら `作成済`。P3 が後で動いても `作成済` は対象外。こちらのフォルダ名は `DEAL-<番号>_` で始まるので、P3 の `find_existing`（`DEAL-####_*` を担当フォルダの箱から探す）にも「既存」として見つかる。顧客が後で入ってもフォルダ名は変えない（P3 の決まり「フォルダ名は変えない」と同じ）。

## Tasks

出す順は portal → Mac → aisecretary。各リポジトリは新しい worktree。

### portal（reins-report。worktree を origin/main＝d9148b5 から。枝 `feat/satei-prep-new-folder`）

**Task P1：受付・行・予約に newFolder（B1・B2）**
- Files：`src/lib/satei-prep.ts`、`src/app/api/jobs/satei/prep/claim/route.ts`、`test/satei-prep.test.ts`
- Interfaces：Consumes `intakeSateiPrep(input)`・`claimSateiPrep(now)`。Produces `PrepRow.newFolder`、`parseNewFolder(v): {name}|null`（検査）、`claimSateiPrep(now, caps?: string[])`、`PrepClaim.newFolder`。
- テスト：`newFolder だけで受ける（folderId は空）`／`folderId だけは今と同じ行（newFolder は null）`／`両方・どちらも無いは 400`／`名前の形が違う（番号なし・禁止文字・81字・前後の空白・制御文字）は 400`／`同じ tid の2度目は同じ行`／`caps なしの予約は newFolder の行を飛ばし、folderId の行は取る`／`caps ありは newFolder の行を取り、答えに newFolder がある`／`古い行（newFolder の欄なし）を読める`／`route：体が無い・JSON でない・caps が配列でない → caps なし扱い`
- コマンド：`npx vitest run test/satei-prep.test.ts`

**Task P2：結果・一覧に folderId（B3・B4）**
- Files：`src/lib/satei-prep.ts`、`test/satei-prep.test.ts`
- Interfaces：`reportSateiPrep` が `folderId` を受ける。`PREP_FAIL_REASONS` に `folder-create`・`folder-config`。`PrepNotice.newFolderId`。
- テスト：`newFolder の行の proposed は folderId が要る（無いと 400）`／`入った folderId が行と一覧に出る`／`failed＋folderId も行に入る`／`newFolder の無い行の folderId は無視`／`folder-create・folder-config を受ける`／`事例の予約（claimPrepCases）が埋まった folderId を返す`／`一覧：newFolder の無い行は newFolderId が null`
- コマンド：`npx vitest run`、`npx tsc --noEmit`、`npx next build`（**prisma generate はしない**）

### Mac（line-secretary。worktree `.worktrees/satei-deal-folder` を feature/v1＝d3a96d6 から。枝 `feature/satei-deal-folder`）

**Task M1：設定と予約の caps**
- Files：`src/config.js`（`sateiPrepFrom`）、`src/satei/portal.js`（`prepClaim`）、`test/satei-prep-config.test.ts`→`.js`、`test/satei-prep-portal.test.js`
- Interfaces：Produces `SATEI.dealParentFolderId`、`prepClaim` の体 `{caps:["newFolder"]}`。
- テスト：`ID の形でなければ空`／`未設定は空で prep の on/off は変わらない`／`prepClaim の体に caps`

**Task M2：案件フォルダを作る（C）**
- Files：`src/satei/prep.js`（`ensureDealFolder`）、`test/satei-prep.test.js`
- Interfaces：Consumes `claimed.newFolder.name`、`d.drive.listChildren`・`ensureFolder`・`readCaseFolder`。Produces `prepResult` の体に `folderId`、`failReason` `folder-create`・`folder-config`。
- テスト：`newFolder なしは今と同じ呼び出し（Drive の作成を呼ばない）`／`親の設定が無い → folder-config`／`無ければ作り 01・02 も作る → proposed に folderId`／`同じ名前がある → 作らずに使う`／`同じ番号で名前の違うフォルダが1つ → それを使う`／`同じ番号が2つ → folder-create`／`名前の形が違う → claim-invalid（結果を送らない）`／`Drive の例外 → folder-create`／`作ったあと案づくりで失敗 → failed に folderId`／`ログに名前・ID が出ない`／`中断は結果を送らない`
- コマンド：worktree で `npm test`

### aisecretary（今の worktree。枝 feat/group-satei-stage2 の続き）

**Task A1：スイッチ・判定・名前（A1〜A3）**
- Files：`src/lib/group-satei-data.ts`（`groupSateiAutoDealOn`・`GS_AUTO_SET="gsatei:autoq"`・`GsTicket.auto`・`asTicket` の検査）、新 `src/lib/group-satei-auto.ts`（`gsAutoMatch`・`gsPropTitle`・`gsDealName`・`gsDealFolderName`・`gsAutoMark`）、`src/lib/task-record.ts`（`dealKeys` を export するだけ）、`tests/group-satei-auto.test.ts`
- テスト：`exact 1件 → one`／`exact 1件＋partial → one`／`exact 2件 → ask exact2`／`partial だけ → ask partial`／`exact 1件が【買】 → ask buy`／`当たらない → none`／`鍵が無い・種別が不明 → ask`／`建物名だけの案件名に号室つきの読み取りが exact`／`物件名：マンション・戸建・土地・所在だけ・60字`／`フォルダ名：例のとおり・禁止文字・80字・顧客未定に様が付かない`／`スイッチ：4つの条件のどれが欠けても off`／`auto の形が違う票は読まない`

**Task A2：登録と流れ（A4・A5）**
- Files：`src/lib/group-satei-auto.ts`（`gsAutoDeal`・`gsAutoResume`）、新 `src/lib/group-satei-auto-notion.ts`（`findOrCreateProperty`・`findOrCreateDeal`・`readDealNo`・`propTitle`・`linkDealFolder`）、`group-satei-actions.ts`（`chooseKind` の satei の枝・`gm`・`maybeAskInfo` の `held`）、`group-satei-propose.ts`（`startGsPrep` の newFolder）、`group-satei-prep-portal.ts`（`SateiPrepIntakeReq` を `folderId` か `newFolder`）、`group-satei-card.ts`／`-case.ts`（M1〜M8）、`group-satei-wire.ts`（本物の Notion）
- Interfaces：`GsActionDeps.autoDeal?: { findOrCreateProperty, findOrCreateDeal, propTitle }`（無ければ自動登録しない）。`SateiPrepIntakeReq = 今の形 | (folderId の代わりに newFolder:{name})`。
- テスト（`tests/group-satei-auto-actions.test.ts`）：`off：［査定］の返事・KV・呼び出しが今と同じ（Notion・portal を呼ばない）`／`one：Notion に書かず準備へ・返事が M1`／`none：物件→案件→portal の順・portal へ newFolder・返事が M2・受付票が gathering・auto.step が folder`／`ask：今のカード＋M3`／`2b-2：足りない項目があると M2＋聞く文、答えのあと newFolder で準備へ`／`二度押し：2回目は選択済み（Notion は1回）`／`やり直し：票の印のある物件・案件があれば作らない`／`fresh-dup：作らずにカード・印が外れる`／`物件を作れない → M8・印が外れる・押し直しで続きから`／`番号が読めない → retrieve 1回 → だめなら M8`／`portal 400 → M8 の2つ目`／`PREP_DISABLED でも 2a の道へ行かない`／`gm（査定の票）：登録へ／査定でない票の gm は今のまま`／`既存のフォルダつき案件の startGsPrep は今と同じ JSON`／`ログ・KV に物件名・所在・フォルダ名が出ない`

**Task A3：見回り（フォルダ → Notion → 案、落ちた票の続き）**
- Files：`group-satei-propose.ts`（`sweepS2Tickets` の `gsLinkAutoFolder`）、`group-satei-auto.ts`（`sweepGsAuto`）、`group-satei-prep-portal.ts`（`asNotice` に `newFolderId`）、`group-satei-outbox.ts`（種類 `auto-fail`・`auto-link`）、`group-satei-wire.ts`、`src/app/api/obi/cloud-tick` の呼び出し
- テスト（`tests/group-satei-auto-sweep.test.ts`）：`newFolderId つきの相談中 → Notion に URL と 作成済 → 案のカード`／`Notion に書けない → その回は案を出さない → 5回で M5 → 案を出す`／`Driveフォルダ に別の URL → 書かない・M5 の別の文`／`同じ URL が入っている → 書かずに linked`／`失敗（folder-config・folder-create）→ M4・手作業`／`auto の無い票は今と同じ`／`落ちた票（step prop・deal・prep、3分）を続ける・3回で M7・印が外れ asking に戻る`／`予算が足りなければ触らない`／`off で何もしない`／`控え：auto-fail・auto-link を同じ retry key で送り直す`
- 併せて：`satei-folder-check` のテストに `自動で作った案件（Notion に URL を書いたあと）は match` を1件。

**Task A4：CLAUDE.md・点検**
- CLAUDE.md に「案件の自動登録（2026-11-27）」の節（スイッチ・env・印・ログの形・止め方）。環境変数の節に2つ。
- コマンド：`for f in tests/group-satei-*.test.ts tests/photo-ask*.test.ts tests/satei-*.test.ts; do npx tsx $f >/dev/null 2>&1 || echo FAIL $f; done`、`npx tsc --noEmit`、`npx next build`
- Task R：別の目での点検（off で1バイトも変わらないこと・二重登録・Notion に書く範囲）。

## 本番に出す順序とスイッチ

1. portal：枝を main へ → push → Railway。env は足さない。確認：今の行（`folderId` つき）の受付・予約・結果が今と同じ。
2. Mac：`.env` に `SATEI_DEAL_PARENT_FOLDER_ID` を追記 → 本体 feature/v1 を早送り → 査定係の見回りを入れ直す（今の手順どおり）。確認：`satei-tick` が idle・警告なし。
3. aisecretary：push → `vercel deploy --prod`（スイッチ off のまま。**worktree の `.vercel/project.json` を先に確かめる**）。確認：今の［査定］が今のまま。
4. `CRM_PROPERTIES_DB_ID` を入れる → `GROUP_SATEI_AUTO_DEAL=1` を入れて出し直す。
5. 通し：試しの依頼1件（下村さんがグループに投げる）→ DEAL 番号の返事 → フォルダ → Notion の URL と 作成済 → 案のカード。試しの物件・案件・フォルダは終わったら下村さんが消す（Claude は消さない）。
- 止め方：`GROUP_SATEI_AUTO_DEAL` を外して出し直す（途中の票は30分の知らせ・カードで拾える）。portal・Mac は戻さなくてよい（欄が来なければ動かない）。

## 下村さんの承認が要る操作

- 3つのリポジトリの push と本番への反映（Railway・Vercel・Mac 本体の早送りと見回りの入れ直し）。
- env を足す：Vercel（`CRM_PROPERTIES_DB_ID`・`GROUP_SATEI_AUTO_DEAL`）、Mac の `.env`（`SATEI_DEAL_PARENT_FOLDER_ID`）。
- 本物の Notion（CRM_物件・CRM_案件）へ試しの1件を作ること、本物の `01_相談` に試しのフォルダを作ること。
- CRM_物件 の DB を AI 秘書の連携に共有する操作（まだなら。Notion の画面で下村さん）。

## 分からなかったこと／人の判断が要ること

- **［案件がまだ無い］を「押したら自動登録」に替えてよいか**（Ruling A5）。替えないなら、決められないときは今どおり手作業。
- **部分一致だけのとき**（exact 0・partial 1件以上）をカードにした。Spec 2 の「合う案件が無ければ」を「部分一致も無ければ」と読んだ。部分一致を無視して登録するほうがよければ A2 の1行。
- **`00_案件.md` と残りの4つのサブフォルダ**を作らない。P3 と同じ形（8キー・6フォルダ）にそろえるなら Mac の Task M2 に足せる（顧客の行は空）。
- **CRM_物件 の DB が AI 秘書の連携（`CRM_NOTION_TOKEN`）に共有されていて、作成が通るか**は未確認（コードは relation の先を読んでいるだけ）。本番の token が `CRM_NOTION_TOKEN` か `NOTION_API_KEY` かも未確認。
- **本番の CRM_案件 の欄**：`担当（仮）` に選択肢「下村」があるか（無ければ API が新しい選択肢を作る）、`フォルダ状態` に「作成済」があるか、CRM_物件 の欄名（`物件名`・`種別`・`所在地`・`土地面積㎡`・`建物面積㎡`・`備考`）がデータ辞書どおりか。Task A2 の前に `databases.retrieve`（読むだけ）で確かめる。
- **`pages.create` の答えに `ID`（unique_id）の番号が入るか**は実機で未確認（入らないときのための `pages.retrieve` 1回を入れてある）。
- **親フォルダの ID の取り方**：`01_相談` の Drive の ID（Drive の画面の URL か、同期フォルダの xattr）。値は計画・ログに書かない。
- **担当が下村さん以外の査定**は対象外（親フォルダは1つ・担当（仮）は「下村」固定）。
- フォルダ名の「売却」は固定（グループ査定は売却の査定の前提）。購入・買取の査定が来たら名前が合わない。
- P3 を後で動かすとき：こちらの案件は `作成済` なので対象外だが、顧客・案件ソースが空のまま＝P3 の「必須6項目」は満たしていない。P3 側の集計（未・作成可の件数）には出ない。
- 別の目での点検（レビュー）・実機での通しは未実施（この計画は机上の調べだけ）。進行ログ（vault）への追記もこの作業では未実施。

## 取りまとめの裁定（2026-11-27。上の本文より優先）

- Ruling R1：［案件がまだ無い］（gm）は、on かつ査定の票なら「押したら自動登録」に替える（下村さん「案件登録じゃないと動かないのは違う」）。— 間違っていた場合：gm の1か所を戻す。
- Ruling R2：部分一致だけ（exact 0・partial 1件以上）はカード（二重登録を防ぐ側）。下村さんへの説明「似た案件があって決められないときだけ選ぶカード」と同じ。
- Ruling R3：サブフォルダは P3 の決まりと同じ6つを全部作る（`deal_folders.py:16` の並びと名前をそのまま。Mac の定数に写し、テストで名前を固定）。`00_案件.md` は作らない（査定係は不要。P3 を後で動かすときに足す）。— C の 4 は「6つを ensureFolder」に読み替える。
- Ruling R4：本番の CRM_案件 の欄は 11/27 に Notion で確認済み：`担当（仮）` に「下村」あり、`フォルダ状態` に「作成済」あり、`Driveフォルダ` は url、`ID` は連番。CRM_物件 の欄はデータ辞書どおりとして作る（通しの試しで確かめる）。
- Ruling R5：3つのリポジトリは同時に作ってよい（受け渡しの形はこの計画の B・C が正）。出す順は portal → Mac → aisecretary。
