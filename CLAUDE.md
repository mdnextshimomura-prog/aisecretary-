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
| `src/lib/remind.ts` | 日次リマインド（Notion 参照） |
| `src/lib/calendar.ts` | Googleカレンダー連携（**現状フローでは未使用**。残置） |
| `prisma/schema.prisma` | Taskモデル定義（SQLite。リマインド用に残置） |

## 重要な制約・前提（壊さないこと）
- **Notionのプロパティ名は日本語固定**。`notion.ts` の `名前`/`種別` 等を変えるとNotion側スキーマと不整合になる。
- **種別は5択**：売買 / 賃貸 / 管理 / 買取再販 / その他。**緊急度は3択**：今日中 / 今週中 / 来週以降。Notionのセレクト選択肢と一致させること。
- **AI秘書へのメンションがタスク受付の入口**（2026-09-04〜）。メンションの無い発言は解析しない。`confidence >= TASK_CONFIDENCE_THRESHOLD`（既定0.7、env調整可）のときだけNotion登録する。雑談・相槌・報告は黙ってスキップ。
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

（タスクの追いかけ・2026-10-12）`TASK_FOLLOWUP`（`1` のときだけ動く。既定 off）。on にすると、
①「3待ち 売主の書類 金曜」「3延期 10/20」「3不要」の返事（番号つき）と、引用リプライの「待ち …」「延期 …」を受け付ける
（`src/lib/task-status-command.ts`＝読み取り／`task-status.ts`＝Notion の欄と返事／`task-status-wire.ts`＝本物へのつなぎ）、
② 朝のリマインドが「次に確認する日」が先のタスクを出さず、確認日が来たもの・前日から入ったものを足す（`src/lib/remind-select.ts`）、
③ 完了にしたとき「終わり方」を残す。
Notion「LINEタスク」の欄 `状況`・`次に確認する日`・`終わり方` を使う（10/12 に作成済み。消すと on のあいだ登録・更新が失敗する）。
off に戻せば今までの動き。on のあいだに付いた「待ち」は、off にすると毎朝のリマインドにまた出る（欄は残る）。
処理の順：番号つきの発言は、状況の言葉（待ち・延期・不要）として読めるかを先に見てから、番号での完了（「3済」）に回す（「3待ち 決済 金曜」の「済」で完了にしないため）。引用リプライも、状況の言葉を取り消し・完了より先に見る。待ち・延期の後ろは空白か文末に限る（「待ち合わせは…」を待ちと読まない）。
設計は `docs/superpowers/specs/2026-10-12-task-followup-pilot-design.md`。

（タスクの候補・2026-10-12）`TASK_CANDIDATES`（`1` のときだけ動く。既定 off）／`TASK_CANDIDATE_USER_IDS`（試行の対象者の LINE userId。カンマ区切り。空なら誰の発言も控えない）。
on にすると、① @AI秘書 の無い発言でも、会社グループ（`LINE_GROUP_ID`）で、対象者が頼んだ／メンションされた、依頼に見える発言（`looksLikeRequest` の言い回し）だけを AI に読ませ、
タスクらしければ（確信度 0.5 以上）登録せず「候補」として KV に控える（返事はしない）。② @AI秘書 あてで確信度が 0.7 に届かず登録しなかった依頼も、0.5 以上なら候補に控える。
③ 17 時台に 1 回（1 時間の幅。1 日 1 回に絞るのは KV の印）、`/api/remind-due`（10 分おきに外から叩かれる入口）が会社グループへ「タスクにしますか？」と番号つきで聞く。④「1 登録」（1 件ずつ）で通常の登録（`registerTaskFromText`。元の発言の ID が鍵）に回し、
「2 なし」「2,3 なし」で候補から外す。「@AI秘書 候補」でいつでも今の一覧を出す。番号は振り直さない（前に聞いた番号を保ち、新しい分を後ろに足す。全部片付いたら 1 番から）。返事の無い候補は 5 日で消える。
候補への返事・一覧は会社グループの中だけで受ける（別のトークから題名を見たり消したりできない）。候補を消すのは登録できたと分かってから（失敗したら残り、送り直せる）。登録には、控えたときの担当（メンションの相手）と依頼のあった時刻（「明日までに」の基準）を引き継ぐ。聞き返しメニューの返事待ちの人の「2 登録」「4 なし」は、候補の言葉として読まない。
ファイル：`src/lib/task-candidate.ts`（判断・文面）／`task-candidate-store.ts`（KV。`taskcand:*`）／`task-candidate-ask.ts`（17 時に聞く）。
17 時に起こすのは Vercel Cron の `/api/candidates-ask`（`vercel.json`。`CRON_SECRET` が未設定なら誰も通さない）。`/api/remind-due` への相乗りも残してある（1 日 1 回の印で二重には聞かない）。
候補の言葉は「登録」「なし」。タスクの番号の言葉（済・待ち・延期・不要・いらない）とは分けてあり、取り違えないことをテストで固定している。
候補の本文・題名はログに出さない。off に戻せば、メンションの無い発言は今までどおり何もしない（KV に残った候補は 5 日で消える）。

（記録の書き足し・2026-10-12）`TASK_RECORD`（`1` のときだけ動く。既定 off）。on にすると、タスクを作った直後（通常の登録／聞き返しメニュー・候補からの登録／AI 停止時の控えの 3 か所）に、
Notion「LINEタスク」へ `依頼者`・`依頼者ID`・`発生元`（グループの ID）・`担当（ユーザー）`（名簿の「Notionユーザー」から）・`案件`・`案件の状態` を書き足す。担当者を後から替えたときは `担当（ユーザー）` も合わせる。
案件は決めつけない：タスクの物件キーが、進行中（完了・失注以外）の CRM_案件 の名前（「｜」で分けた各部分）と**完全に一致する案件が 1 件だけ**のときに限り `案件` に入れ、状態は「候補あり」。複数・部分一致は `案件` を空のまま「候補あり」にして候補の名前をページ本文に控える。当たらなければ「未割当」、物件名が無ければ「案件なし」。「確定」にするのは人。
登録とは切り離してある：段ごとに分けて書き、どれかが失敗しても登録・返信は止めない（`[task-record] 書けなかった段: …` に段の名前だけ出る）。秘書は案件を作らない。CRM_案件 のフェーズ・歩合・週報の欄には書かない。
ファイル：`src/lib/task-record.ts`（照合と欄の組み立て）／`task-record-wire.ts`（本物へのつなぎ。案件は `CRM_NOTION_TOKEN`（無ければ `NOTION_API_KEY`）と `CRM_DEALS_DB_ID` で読み、5 分覚える）。
前提：`案件` に書くには、本体の連携（`NOTION_API_KEY`）が CRM_案件 を読めること。読めないと `deal-link` で失敗し、状態だけが入る。

（受付の返事のボタン・2026-11-08）`TASK_BUTTONS`（`1` かつ `TASK_FOLLOWUP=1` のときだけ、受付の返事（確定・初動確認の聞き返し・確認失敗のどれでも）に［済］［待ち］［延期］［不要］［担当を変える］のカードを付け、押されたら処理する。既定 off）／`TASK_BUTTONS_ADMIN_IDS`（担当者・依頼者のほかに押せる人＝下村さんの LINE userId。カンマ区切り。未設定なら担当者・依頼者だけ。`JOB_ALLOWED_USER_IDS` とは別）。ファイル：`src/lib/task-buttons.ts`（判断・文面）／`task-card.ts`（カードの見た目）／`task-buttons-wire.ts`（本物へのつなぎ・postback の入口）。ボタンは Flex Message のカード（2026-11-08 にクイックリプライから替えた。PC 版でも出て、発言で消えない）：文字の返事は1文字も変えずに1通目、カードを2通目に足す。`sendLineMessage` が返す ID は1通目（text）のまま。待ち・延期・担当変更のあとはカードを付け直し、済・不要で閉じたら付けない。依頼者ID が空のタスク（`TASK_RECORD=0` の間に登録）は担当者と特権者だけが押せる。

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

（期限前の通知・2026-10-13）「⏰ まもなく期限です」は `src/lib/remind-due.ts`。起こすのは毎分の見回り `/api/obi/cloud-tick` への相乗りで、**スイッチは `DUE_REMIND_TICK=1`（既定 off）**。10 分に 1 回（KV の枠）。`/api/remind-due` を外から叩く仕組みは無い。詳しくは `docs/運用.md`。

## 送り主の制限（2026-11-08 セキュリティ点検）
- webhook は帯替えの判定のあと、各イベントの先頭で送り主を確かめ、許可していない送り主のイベントは何もせず飛ばす（200 のまま、ログには種類と理由だけ）。受付ボタンの postback もこの後ろにある。
- グループ：`LINE_GROUP_ID`（営業部）か `SECRETARY_ALLOWED_GROUP_IDS`（カンマ区切り。業務指示グループ `Cd5fda3261e9bdd012e598884b2e6a696` など）のどれかと一致するときだけ通す。両方空なら全グループ拒否。
- 1対1：`SECRETARY_ALLOWED_USER_IDS`（カンマ区切り）の人だけ。空なら `TASK_BUTTONS_ADMIN_IDS` の人だけ。両方空なら全員拒否。複数人トーク（room）は常に拒否。
- Cron（remind・remind-due・report・candidates-ask）は `CRON_SECRET` 必須。未設定なら 401。
- 新しいグループで Bot を使い始めるときは `SECRETARY_ALLOWED_GROUP_IDS` に足す（Vercel ログの「送り主の制限で読み飛ばし: group group-mismatch」が手がかり）。
