# AI秘書（LINE秘書）— 子エージェント定義

> 📌 **参照元・記録先は常に Obsidian。**経緯・判断・進行状況の「正」は vault にある。
> コード内のコメントや古い .md より vault を優先する。
> `~/AI開発/tools/notebooklm-obsidian/vault/20_research/2026-08-08_AI秘書_集約と完了機能_進行ログ.md`
> **作業前に読み、作業後に追記する。**
>
> 📍 このアプリは AI秘書システムの一部。設計の詳細は `~/AI開発/apps/ai-secretary/docs/`（統合ハブ）。
> 仕様変更・機能追加の前に `ai-secretary/CLAUDE.md` も読むこと。
> 中核ロジック（`claude.ts`/`notion.ts`）は `apps/lineworks-secretary` にも複製がある。

このフォルダは、親エージェント配下で動く **「不動産タスク秘書」子エージェント** の実装兼作業領域です。
このフォルダで起動した Claude セッション／サブエージェントは、まずこのファイルを読んで役割と制約を把握してください。

## このエージェントの責務（スコープ）
LINEで受信した不動産業務メッセージを、構造化タスクに変換してNotionに登録し、リマインドする。

**やること**
- LINEグループでボットがメンションされたメッセージを解析する
- Claude APIでタスク情報（種別・緊急度・期日・担当者）を抽出する
- Notionデータベースにタスクを登録する
- 期日が近いタスクを日次でLINEにリマインド送信する

**やらないこと（スコープ外 → 親または別の子に委譲）**
- 物件調査・重要事項説明など不動産書類の作成（別スキル `realestate-*` の領域）
- LINE以外のチャネル（メール・Slack等）からの入力
- タスクの自動実行・外部への自動返信以外のアクション

## アーキテクチャ（データフロー）
```
LINEグループ（@ボット メンション）
   │  POST
   ▼
src/app/api/webhook/route.ts   … 署名検証 → メンション判定 → メンション除去
   │
   ├─ src/lib/claude.ts   parseTaskFromMessage()  … Claude(sonnet)でJSON抽出
   ├─ src/lib/notion.ts   createNotionTask()       … Notion DBへページ作成
   └─ src/lib/line.ts     sendLineMessage()        … 登録完了をLINE返信

リマインド（cron / Vercel Scheduled）
   └─ src/app/api/remind/route.ts → src/lib/remind.ts → pushLineMessage()
```

## 主要ファイルの地図
| ファイル | 役割 |
|---|---|
| `src/app/api/webhook/route.ts` | LINE Webhook入口。署名検証・メンション判定・担当者上書き |
| `src/lib/claude.ts` | メッセージ→タスクJSON解析（model: claude-sonnet-4-6） |
| `src/lib/notion.ts` | Notion登録・期日近接タスク取得。**プロパティ名は日本語**（名前/種別/緊急度/期日/担当者/ステータス/元メッセージ） |
| `src/lib/line.ts` | LINE送信・署名検証・完了メッセージ整形 |
| `src/lib/remind.ts` | 日次リマインド（Prisma/SQLite参照） |
| `src/lib/calendar.ts` | Googleカレンダー連携（**現状フローでは未使用**。残置） |
| `prisma/schema.prisma` | Taskモデル定義（SQLite。リマインド用に残置） |

## 重要な制約・前提（壊さないこと）
- **Notionのプロパティ名は日本語固定**。`notion.ts` の `名前`/`種別` 等を変えるとNotion側スキーマと不整合になる。
- **種別は5択**：売買 / 賃貸 / 管理 / 買取再販 / その他。**緊急度は3択**：今日中 / 今週中 / 来週以降。Notionのセレクト選択肢と一致させること。
- **メンション不要・文脈で自動判定**：全発言を `parseTaskFromMessage` に渡し、Claudeが `isTask`＋`confidence` を返す。`confidence >= TASK_CONFIDENCE_THRESHOLD`（既定0.7、env調整可）のときだけNotion登録する。雑談・相槌・報告は黙ってスキップ。
- **担当者**：メンションがあればそのテキストから名前を取得して上書き（任意）。LINE APIは使わない。
- **永続化の主軸はNotion**。SQLite/Google Calendarは過去に主軸から外した（remind.tsのみSQLite参照）。

## 環境変数（`.env.local`。git管理外 → 移行時は手動で再設定）
`ANTHROPIC_API_KEY` / `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` / `LINE_BOT_USER_ID` /
`NOTION_API_KEY` / `NOTION_DATABASE_ID` /
（任意）`TASK_CONFIDENCE_THRESHOLD`（自動登録の確信度しきい値。既定0.7。上げると誤登録減・取りこぼし増） /
（任意）`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` / `GOOGLE_CALENDAR_ID`
（グループからの帯替え・2026-10-09）`LINE_GROUP_ID`（既存。営業部の groupId）/ `PORTAL_BASE_URL`（portal の https の起点。末尾の / は不要）/
`JOB_API_TOKEN`（portal の `x-job-token`。LINE秘書と同じ鍵）/ `JOB_ALLOWED_USER_IDS`（帯替えを依頼できる LINE userId。カンマ区切り）
— `LINE_GROUP_ID` が無い・不正なら帯替えは何もしない（どのグループでも返事も控えもしない）。それ以外が1つでも欠ける・形が違うと、営業部の依頼にだけ「止めています」と返す（他の機能は変わらない）。追加・変更は下村さんの承認後、値を画面に出さない方法で入れる。
Webhook の `maxDuration` は 300（既存機能の既定を縮めないため）。帯替えの受付は内部で開始+58秒に収める。プランが許さずデプロイが失敗したら、下村さんと相談して 60 に戻す。
LINE の Webhook の再送が無効だと、portal の結果不明・一覧の不一致のときに再送が来ない（結果は Discord・portal で確かめる）。
（番号で直す・2026-10-11）帯替えの完成の知らせへの番号の返事（「3ページ 2」を引用で／「#J12 3ページ 2」／「0」）を `src/lib/obi/fix-parse.ts`・`fix.ts` が扱う。**環境変数の追加は無い**（上の4つをそのまま使う。訂正できる人も `JOB_ALLOWED_USER_IDS`）。止めるスイッチは portal の `OBI_FIX_ENABLED`（aisecretary の側には無い）。訂正は Webhook の開始から25秒に収める。
営業部のグループの「番号の形の引用リプライ」は、先に portal へ引用先を聞く（帯替えの知らせでなければ今までの流れへ渡す）。**LINE の Webhook の再送は無効が前提**：訂正の枝は 503 を返さない。引用先を確かめられない（時間切れ・つながらない・5xx）ときは、その場で今までの流れへ渡す（その発言は訂正として扱われない。「#J12 3ページ 2」の形なら通る）。`#J` つきで portal に届かないとき（fix を呼ぶ前）は「…portal に届きません。少し待ってからもう一度送ってください」を返す。portal の fix の結果が分からないときは「受付の結果を確かめられませんでした。届く知らせか portal の依頼ボックスで確かめてください。同じ番号をもう一度送らないでください」を1回返して済みにする（送り直しは求めない。人が送り直すと別の発言になり、二重の訂正になりうる）。
訂正のログには message.id・userId・groupId を出さない（処理の段階・受付番号 #J・番号・ページ・結果の code だけ）。
運用上の事実（2026-10-11 の最終レビューで分かったこと。作りは変えていない）：
- 引用つきの「数字だけの返信」は、訂正かどうかを確かめるために KV 1回＋portal の resolve 1回（上限6秒）を呼ぶ。portal が応答しないあいだ、そういう返信に限り、今までの流れ（タスクの判定など）へ渡るのが最大約7秒遅れる。
- portal の `OBI_FIX_ENABLED` が off のあいだは、そういう返信のたびにログが1行出る（「引用先を引けない（今までの流れへ）: FIX_DISABLED」。返事はしない）。
- イベントの予約・完了（KV）には時間の上限が無い。KV が落ちていると `#J` つきの発言は 500 になる（既存の帯替えの受付と同じ作り）。
（差し戻しの対応を番号で選ぶ・2026-10-11）帯替えの差し戻しの知らせ（選択肢つき）・確認の知らせへの返事（「1」〜「4」を引用で／「OK」「9」を引用で／「#J4 1」「#J4 OK」「#J4 9」）を `src/lib/obi/reject-parse.ts`（言葉の読み取り）・`reject-plan.ts`（何をするかの決め方）・`reject.ts`（認可〜portal の `/reject`〜返事）が扱う。入口は「番号で直す」と同じ `webhook-event.ts` の `tryObiFix`。**環境変数の追加は無い**（選べる人も `JOB_ALLOWED_USER_IDS`）。止めるスイッチは portal の `OBI_REJECT_CHOICES`（aisecretary の側には無い。off のあいだ portal は選択肢の知らせ・確認の知らせを作らないので、引用の形・「#J4 1」「#J4 OK」の枝は動かない。「#J4 9」にだけ、下の箇条のとおり「いま受付を止めています…」が返る）。時間・返事の印・503 を返さないことは「番号で直す」と同じ。
- 何の返事かは、portal の resolve の答えで決める：引用つきは引用先の知らせの種類 `kind`（`reject`＝選択肢の知らせ／`review`＝確認の知らせ／`completion`＝完成の知らせ）、`#J` つきは依頼の状態 `phase`（`choose`／`review`／`fix`）。選択肢の知らせ・確認の知らせ・確認待ちの依頼と確かめられたときだけ扱い、それ以外は返事をせず今までの流れへ渡す（グループのふつうの「OK」「1」を横取りしない）。
- 営業部のグループの**引用つきの「OK」「ok」「オーケー」「9」だけの返信**は、確認の知らせへの返事かを確かめるために portal の resolve を1回呼ぶ（上限6秒。KV は呼ばない）。portal が応答しないあいだ、そういう返信に限り、今までの流れへ渡るのが最大約6秒遅れる。`OBI_FIX_ENABLED` が off のあいだは、そのたびにログが1行出る（「引けない（今までの流れへ）: FIX_DISABLED」。返事はしない）。
- 「#J12 OK」は、依頼が確認待ち（`phase: review`）のときだけ完成（approve）にする。それ以外は今までどおり今までの流れへ渡す（グループには「#J12 OK」の既存の扱いが無い。既存の「#J12 OK／直す」は Mac の秘書室だけ）。そのために resolve を1回呼ぶ。
- 「#J12 9」は、依頼が確認待ち（`phase: review`）なら選び直し（rechoose）。確認待ちでないとき、`phase` が `fix` で完成品があれば、同じ rechoose を portal の `/reject` に渡して portal に断らせる：選択肢のスイッチ（`OBI_REJECT_CHOICES`）が off なら `CHOICE_DISABLED`＝「いま受付を止めています。portal の依頼ボックスを確認してください」、on なら `CHOICE_UNAVAILABLE`＝「#J12 はいまその操作ができない状態です」（off のあいだ `phase` は常に `fix` で、resolve の答えだけでは見分けられないため）。選択待ち・完成品の無い依頼は、portal を呼ばずに「いまその操作ができない状態です」。依頼を引けない・確かめられないときは、返事をせず今までの流れへ渡す。
- 共通の表 `tests/fixtures/job-command-cases.json` は変えていない（88件）。引用つきの「OK」「9」は aisecretary だけの読み（`parseChoiceWord`）で、表に足さない。
（クラウド配達・2026-10-11）グループから頼まれた帯替えの完成リンク・差し戻しの知らせ・失敗の一言を、Mac が止まっていても出す毎分の見回り `POST /api/obi/cloud-tick`（`src/lib/obi/cloud-*.ts`）。**起こすのは portal**（Railway の worker が毎分、portal の web を経由してたたく。Vercel の cron は使わない＝Hobby プランは毎分の cron を受けない。`vercel.json` に、この入口の cron は無い）。**スイッチは `OBI_CLOUD_DELIVERY`（`1` のときだけ動く。既定 off）。off のあいだ、見回りは KV・portal・LINE を1回も呼ばずに `{ "skipped": "off" }` を返す。**
足した環境変数：`OBI_CLOUD_DELIVERY` / `OBI_CLOUD_SIGNING_KEY`（クラウド専用の Ed25519 の秘密鍵。PKCS8 の PEM。改行は `\n` と書いてよい。Mac の鍵とは別）/ `OBI_CLOUD_KID`（`cloud-2026-10` の形）/ `OBI_CLOUD_LIFF_ID`（Mac の `DELIVERY.liffId` と同じ値）/ `OBI_CLOUD_FIX_GUIDE`（`1` で完成の知らせの末尾に番号の案内。**Mac の `JOB_FIX_GUIDE` と同じ値にする**。Mac は 2026-10-11 に既定が on になったので、ふつうは `1` を入れる）。既存の `PORTAL_BASE_URL`・`JOB_API_TOKEN`・`LINE_GROUP_ID`・`LINE_CHANNEL_ACCESS_TOKEN`・`KV_REST_API_URL`・`KV_REST_API_TOKEN` もそのまま使う。追加・変更は下村さんの承認後、値を画面に出さない方法で入れる。
- 見回りの入口の合言葉は、ヘッダ `x-obi-tick-token` に、`HMAC-SHA256(鍵 = JOB_API_TOKEN の UTF-8, 文 = "obi-cloud-tick.v1")` の小文字16進64桁（portal と共有の `JOB_API_TOKEN` から両方が導く。新しい環境変数は無い。比べ方は定数時間）。`JOB_API_TOKEN` が無い・32字未満なら誰も通さない（`401`）。`GET` は `405`。`CRON_SECRET`（`Authorization: Bearer`）の道は、この入口には無い。止めるときは `OBI_CLOUD_DELIVERY` を外す（または portal 側の中継を止める）。既存の `/api/remind`・`/api/report`・`/api/remind-due` は、未設定だと `Bearer undefined` で通る書き方のまま（今回は直していない）。
- 設定の不足は2種類：共通の分（portal・鍵・グループ・LINE・KV）が欠けると見回りを丸ごと飛ばす（`skipped: "config"`）。完成だけに要る3つ（署名鍵・kid・LIFF の ID）が欠けると、完成の配達だけ飛ばし、種まき・知らせは進める（`completionSkipped: "config"`）。応答・ログに出るのは変数の名前だけ。
- 二重を防ぐ正は portal の予約。「LINE を呼んだか分からない」ときは送り直さない（完成は portal の `納品要確認`、知らせは Discord と依頼ボックスに出る）。LINE を呼ぶ直前には、新しい配達でも再開でも、必ず portal の原子的な印（`POST …/delivery/attempt`）を通す（通らなければ送らない）。KV の控え `obi-cloud:job:<no>` が「準備中」「印を頼んだ」（`prepared`・`attempt-requested`）のまま止まった分は、次の回に再開する（attempt をやり直す）。「送信中」（`attempting`＝portal の印が通った後）で止まった分は、結果不明として送り直さない。残っている控えは、KV の目次（`obi-cloud:jobs`・`obi-cloud:notice-msgs`）で見つける（`SCAN` は使わない）。控えに入れる文の材料は5項目（要確認のページ数・消した数・ページ・直しの符号・整えた物件名）だけ。
- 差し戻し・失敗の知らせは、portal の一覧の応答の `peers.mac.noticeClaim` が `true` のときだけ出す（Mac が「予約を取ってから送る版」であること）。**Mac を前の版に戻すときは、必ず先に `OBI_CLOUD_DELIVERY` を外す**（戻したままクラウドを on にすると、知らせが二重になる）。
- 文は Mac と一字一句同じ。共通のテスト用データ `tests/fixtures/obi-cloud-texts.json`（sha256 をテストで固定。line-secretary の `test/fixtures/` と同じバイト。今の版は Mac の feature/v1 `7ff13e4` の文＝sha256 `fe78ff10…1d83`）。片方だけ直さない。Mac の `fixtext.js` の `FIX_GUIDE_QUOTE_OK` を `false` に変えるときは、同じ変更で `src/lib/obi/cloud-text.ts` も変える。
- リンクのトークンは Mac の `src/dtoken.js` と同じ規約（`tests/fixtures/dtoken-mac.cjs`・`dtoken-viewer.cjs` は写し。元を変えたら写し直してテストの sha256 を直す。閲覧ページの写しは K2 の枝 `feature/obi-cloud-viewer` `9d6c28e` の版＝クラウドの鍵は別の表 `cloudPublicKeys` で受ける）。スイッチを入れる前の確認・もう一度 on にするときの注意は `docs/運用.md` の 0。
- ログ（`cloud-tick #J12 delivered` の形）に出すのは、受付番号・段の名前・結果の符号・変数の名前だけ。LINE の ID・本文・物件名・トークン・リンク・鍵・予約の番号は出さない。
- 止め方・戻し方・鍵が漏れたときの手順は `docs/運用.md`。
文法は `src/lib/obi/fix-parse.ts` が正で、line-secretary の `src/jobs/parse.js` と共通の表 `tests/fixtures/job-command-cases.json`（sha256 をテストで固定）の全行で同じ結果にしてある。片方だけ直さない。

## よく使うコマンド
```bash
npm run dev          # ローカル開発
npm run build        # prisma generate + next build（Vercelのビルドもこれ）
npm run db:push      # Prismaスキーマ反映
npm run db:studio    # DB確認
```
デプロイ先は Vercel（`.vercel/` あり）。

## 親エージェントへの返却契約（このエージェントの入出力）
- **入力**：LINE Webhookイベント（外部トリガ）。親から直接呼ぶ場合は「解析したいメッセージ文字列＋今日の日付」。
- **出力**：Notionに登録されたタスク（`notionId`）と、LINE返信用の整形済みメッセージ。
- 失敗時はLINEにエラー文を返し、`console.error` に記録する（webhook/route.ts）。
