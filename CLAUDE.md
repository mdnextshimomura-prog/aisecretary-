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
- **AI秘書へのメンションがタスク受付の入口**（2026-09-04〜）。メンションの無い発言は解析しない。`confidence >= TASK_CONFIDENCE_THRESHOLD`（既定0.7、env調整可）のときだけNotion登録する。雑談・相槌・報告は黙ってスキップ（メンションの無い発言には返事をしない）。
  - （2026-11-13）@AI秘書 あてで登録しなかったとき（タスクでない・確信度 0.5 未満・0.5〜0.7 で候補に控えなかった）は「タスクとしては受け付けませんでした…」を返す（候補に控えたときは今までどおり）。グループで「@秘書」を手打ちしただけ（メンションの印が無い）のときは一覧から選ぶよう返す。ログは `[task-intake] mention-none|typed-mention|not-task|low-conf|candidate-skip|candidate-saved|registered` の符号だけ（本文・ID・名前は出さない）。`src/lib/task-intake.ts`・`tests/task-intake-outcome.test.ts`。
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

（ボタンの入口 B1・メニューと未完了タスク・2026-11-08）`TASK_MENU`（`1` かつ `TASK_BUTTONS=1` かつ `TASK_FOLLOWUP=1` のときだけ動く。既定 off。off なら入口も postback も今と同じ）。グループで「@秘書 メニュー」（下書き・初動確認への回答より先に受ける）か、「@秘書」だけで直前の資料が無い発言（今は「どの案件について…」の聞き返しを返していたところ）に、メニューのカード［今日・期限切れ］［自分の未完了］［候補］［案件］を返す。資料つきの「@秘書」だけ（写真→@秘書）は今までどおりタスクの受付。［今日・期限切れ］＝未完了で期日か「次に確認する日」が今日（JST）以前（ただし次に確認する日が今日より先＝待ちのものは、期限切れでも出さない。朝のリマインドと同じ考え方）、［自分の未完了］＝担当者ID が押した人（名簿の別アカウントも）。どちらも、グループから押したときは Notion の `発生元` が押したグループの ID と一致するタスクだけ（問い合わせの条件に入れ、手元でも絞り直す）。1対1（許可者）から押したときは全体。**発生元が空の古いタスク（`TASK_RECORD=0` の間に登録したもの）はグループからの一覧には出ない**（別グループのタスクを見せないことを優先）。どちらも期日の早い順に1件＝今のタスクカードのカルーセル（最大10枚＋［次の10件］。data は `v1|lt|10` の形でオフセット＝0〜500 の整数。JSON を 30KB 未満に収めるために件数を減らしたページの続きは `v1|lt|7` のようになる。Notion の cursor は入れない）。［候補］は下の「候補をカードで」、［案件］は下の「案件をカードで」。押せるのは送り主の制限を通ったグループの人なら誰でも（見るだけ。タスクのボタンの権限は今のまま）。読むだけなので予約・完了印は使わない。一覧のカードの ID は、載せたタスクが1件のときだけ cardref に控える（2件以上のカルーセルは引用されてもどのタスクか決められないため）。ファイル：`src/lib/task-menu.ts`（判断・カード）／`task-menu-wire.ts`（Notion の読み込み）／postback の振り分けは `task-buttons.ts` の `parseMenuData` と `task-buttons-wire.ts`。ログは `[task-menu] lt shown 10` の形（操作名・件数・符号だけ）。

（B1・候補をカードで・2026-11-08）`TASK_MENU=1`（上の3つ）かつ `TASK_CANDIDATES=1` のときだけ動く。どちらか off なら今と同じ（文字の「1 登録」「2 なし」・17 時は営業部へ文字だけ・KV も今の `taskcand:items`／`taskcand:numbered` のまま。off の置き場は1バイトも変えていない）。新しい環境変数 `TASK_CANDIDATE_GROUP_IDS`（候補を受け付けるほかのグループ。カンマ区切り。`LINE_GROUP_ID` に足す。TASK_MENU off のあいだは使わない）。
- TASK_CANDIDATE_GROUP_IDS に入れるグループは SECRETARY_ALLOWED_GROUP_IDS にも入れる（入っていないと17時の知らせは届くが、返事・ボタンは送り主の制限で読み飛ばされる）。
- 置き場（TASK_MENU on）：候補1件＝`taskcand:c:<id>`（期限5日）＋目次 `taskcand:index`（集合。要素は `c:<id>`＝数字だけの ID が KV の読み出しで数に戻って桁が落ちないよう頭に付ける。sadd/srem で原子的）。全置換はしない。番号はグループごとの `taskcand:num:<groupId>`（番号を振るときだけ書く）。保留 `taskcand:hold:<id>`、登録の予約 `taskcand:reg:<id>`（SET NX・5分）、17 時の印は営業部は今までと同じ `taskcand:asked:<日付>`、ほかのグループは `…:<groupId>`。古い形が残っていれば読むときに新しい形へ移し（営業部の番号も引き継ぐ）、古いキーを消す（移行の元は GETDEL で1回だけ取り出し、取れた側だけが移す＝並行した移行で消した候補を作り直さない）。17 時の配信でも保留中は出さない。**on にしてから off に戻すと、on のあいだに控えた候補は見えなくなる**（5日で消える。元の発言は LINE に残る）。KV の設定が片方だけ（URL か TOKEN だけ）のときは候補を控えない（`[task-candidate] kv-partial skip`）。
- カード：候補1件＝1枚（題名・依頼者・発言の時刻・宛先＝メンションされた人。名前は名簿から）。ボタン［登録する］［保留］［いらない］（data `v1|cr|ID`・`v1|ch|ID`・`v1|cx|ID`。ID は元の発言の ID）。最大10枚＋［次の10件］（`v1|lc|オフセット`）。登録は予約（SET NX）が取れた1回だけ `registerTaskFromText`（文字の「1 登録」と同じ。元の発言の ID が鍵）に回し、登録できたら候補を消す・失敗したら予約を外して候補を残す。文字の「n 登録」「n なし」も on のあいだはボタンと同じ押せる人・同じ予約（失敗・例外で外す）で扱い、片付けは番号ではなく候補の ID で行う（登録の間に番号が振り直されても別の候補を消さない。off は今のまま誰でも）。保留＝次の 17 時まで出さない。いらない＝候補から外す。
- 出る所：17 時（文字の一覧のあとにカルーセル。文字＋カードを1回の push＝`pushTextAndCard`。受け付ける各グループへそのグループの分だけ）／メニューの［候補］／「@秘書 候補」（17 時と同じ形。保留中は出さない）／@秘書 あてで確信度 0.5〜0.7 の依頼（候補に控えたうえで、その場の返事でカード1枚）。
- その場で聞く（2026-11-09）：`TASK_CANDIDATE_INSTANT=1`（かつ上の候補カードが on）のとき、メンションの無い依頼を候補に**新しく**控えたら、その場の返事（reply。月の送信枠を使わない）で「📝 タスクにしますか？…」の文字＋候補カード1枚を返す。同じ発言の2度目・控えられなかったときは出さない。replyToken の期限のため、発言の時刻から50秒を過ぎそうなら送らない（`instant-card too-late`）。名簿は3秒・送信は残り時間まで待ち、LINE が断った（HTTP エラー）・時間切れ・例外は `reply-failed instant-card` を1行だけ出す（`replyInstantCandidateCard`）。送れなくても候補は残り、17時のまとめでも聞く（押されなかった分・保留の分）。off なら今までどおり黙って控える。グループの全員に見える（社長の発言にも返す）ので、on にするのは下村さんの承認後。ログは `[task-candidate] instant-card shown 1`／`reply-failed instant-card`。
- 見える・押せる：控えたグループの中だけ（別のグループ・1対1からは「この候補は見つかりませんでした…」）。押せる人は依頼者・メンションされた人・`TASK_BUTTONS_ADMIN_IDS`（名簿で同じ人の別アカウントも）。それ以外は「この候補を操作できるのは依頼者・宛先の人・下村さんだけです」。ファイル：`src/lib/candidate-card.ts`（カード・判断）／`task-candidate-store.ts`（置き場）。ログは `[task-candidate] cr busy` の形（操作名・符号・件数だけ）。

（B1・案件をカードで・2026-11-08）`TASK_MENU=1`（上の3つ）のときだけ動く。off なら入口も postback も今と同じ（「@秘書 案件」は今の流れへ、登録のときに KV も読まない）。新しい環境変数は無い（案件は `TASK_RECORD` と同じ `CRM_NOTION_TOKEN`（無ければ `NOTION_API_KEY`）・`CRM_DEALS_DB_ID` で読み、5分覚える）。
- 入口：メニューの［案件］（`v1|ld|オフセット`）と、グループの「@秘書 案件」（「案件一覧」も。メニューと同じく下書き・初動確認への回答より先に受ける）。進行中（フェーズ ≠ 完了・失注）の CRM_案件 を1件1枚、最大10枚＋［次の10件］。並びは、いちばん近い未完了タスクの期日の早い順 → タスクはあるが期日の無い案件 → タスクの無い案件（どちらも名前順）。
- カード：案件名・フェーズ・近い期日・残りタスク数（LINEタスクの `案件` relation で数える）。**残りタスク数・近い期日は、押したグループの `発生元` のタスクだけで数える**（別グループのタスクの件数を見せない。1対1は全体）。案件そのもの（名前・フェーズ）は社内の CRM なのでグループで絞らない。ボタン［タスクを見る］（`v1|dt|案件ID[|オフセット]`）［タスクを足す］（`v1|da|案件ID`）。案件 ID は Notion のページ ID（形を確かめる）。
- ［タスクを見る］：その案件の未完了タスクを一覧と同じタスクカードのカルーセルで（同じく発生元で絞る。0件なら「この案件の未完了タスクはありません」。1件のときだけ cardref に控える）。
- ［タスクを足す］：グループの中だけ（1対1は「［タスクを足す］はグループの中で使えます」）。進行中の案件に無い ID には付けない。KV に `dealnext:<groupId>:<userId>`＝案件 ID（10分）を置き、「このあと「@秘書 内容」と送ると、この案件のタスクとして登録します（10分間）」と返す。その人の次の @秘書 の依頼（通常の登録・聞き返しメニューからの登録・AI 停止時の控え）の**登録が成功したとき**に、印を GETDEL で取る（読むのと同時に消す。同じ人の2件の依頼が並行しても片方だけに付く）。取れたら `案件` を入れて `案件の状態` を「確定」にする（初動確認の聞き返しになっても登録は成功なので同じ。取ったあと書けなければ印は失われ、ログに write-failed だけ出る）。TASK_RECORD の自動の照合より優先（照合は飛ばす）。TASK_RECORD が off でも、印があれば案件だけは書く。候補（17時・カード）からの登録では使わない（押した人と依頼者が違うため）。
- ［タスクを足す］で案件を書くには、本体の連携（NOTION_API_KEY）に CRM_案件 を共有しておくこと（2026-11-08 時点の手元の設定では未共有＝404。共有が無いと一覧は出るが案件は付かず、ログに write-failed だけ出る）。
- 聞き返しメニューへの回答での登録にも印が使われる（［タスクを足す］の前に出していた保留中の依頼にも付きうる）。
- 読むだけ：CRM_案件 の欄には書かない。読めない（権限・`CRM_DEALS_DB_ID` 未設定）なら「案件を読み取れませんでした」。Notion は案件1クエリ＋タスク1クエリ（案件のあるもの。＋続きのページ）。
- ファイル：`src/lib/deal-card.ts`（判断・カード・印）／`deal-card-wire.ts`（本物の Notion・KV、`recordAfterCreateWithPick`）。ログは `[task-menu] ld shown 10`・`[deal-card] pick applied` の形（操作名・件数・符号だけ。案件名・userId は出さない）。

（朝のリマインドをカードで・2026-11-10）`TASK_REMIND_CARDS`（`1` かつ `TASK_BUTTONS=1` かつ `TASK_FOLLOWUP=1` のときだけ動く。既定 off。off なら朝のリマインドは今と1バイトも変わらない）。朝8時の文字の一覧（番号つき）を今までどおり送ったあとに、同じタスクを同じ順で受付と同じタスクカード（［済］［待ち］［延期］［不要］［担当を変える］）のカルーセルにして1通足す（`pushCard`＝push。月の送信枠を1日1通×グループの人数ぶん使う）。題名の頭に文字の一覧と同じ番号（「3. 」）。最大10枚（JSON が 30KB 以上なら減らす）。残りがあれば最後に「残り◯件」のカード：どちらも番号での返信を案内し、`TASK_MENU=1` なら［今日・期限切れ］（`v1|lt|0`。明日期限・別グループ発生のタスクは入らない）も付ける。押したあとの権限・処理は今のタスクのボタンのまま。カードが送れなくても文字の一覧は届いているので、朝のリマインドは止めない。10時の棚卸し（`/api/report`）は対象外（文字だけ）。ファイル：`src/lib/remind-cards.ts`。1枚でも 30KB を超えるとき（担当名などが極端に長い）はカードを送らない。ログは `[remind] cards shown N`／`[remind] cards push-failed`／`[remind] cards too-large`（件数だけ）。

（B2・査定書の下書き・2026-11-11）`TASK_SATEI`（`1` のときだけ動く。既定 off。off なら案件カードの JSON は1バイトも変わらず、前に出したボタン `v1|sa|`・`v1|so|`・`v1|sr|` を押されても「いまは止めています」とだけ返して何もしない。差し戻し理由の取り込みも KV を読まない）／`TASK_SATEI_USER_IDS`（押せる人の LINE userId。カンマ区切り。**先頭が個人あての通知先＝下村さん**。タスクの「担当者・依頼者も押せる」決まりは使わない。違う人には「いまは下村さんだけが使えます」）。設計は `docs/superpowers/specs/2026-11-11-b2-satei-draft-design.md`、受け渡しの正本は `…-b2-satei-contract.md`。
- 入口：案件カード（B1・`TASK_MENU=1` のときに出る）の3つ目［査定書を作る］（`v1|sa|案件ID`）。postback の振り分けは TASK_BUTTONS の「止めています」の判定より前（TASK_SATEI だけで動く）。二度押しは `pb:<webhookEventId>` の予約。
- ［査定書を作る］：CRM_案件 のページ（`案件名`・`ID` の数字・`Driveフォルダ` の `/folders/<id>`・`物件` の1件目）と CRM_物件 の `種別` を読む（書かない。CRM_DEALS_DB_ID の子のページだけ）。マンションでない（分からないも含む）→「いまはマンションの案件だけ作れます」、フォルダが無い →「案件の Driveフォルダが未設定です」。そろえば reins-report の `POST /api/jobs/satei/intake` を呼び、押した場所へ「受け付けました。結果は個人の LINE に届きます（#J番号）」か、同じ案件で終わっていない依頼があれば「作成中です（#J番号）」。案件名・金額は返事に入れない。
- 個人あての通知：Mac の査定係が `POST /api/satei/notify`（ヘッダ `x-satei-token` = HMAC-SHA256(JOB_API_TOKEN, "satei-notify") の hex。JOB_API_TOKEN が32字未満なら誰も通さない。`src/middleware.ts` の matcher には入れない）を呼び、`TASK_SATEI_USER_IDS` の先頭へ push（`X-Line-Retry-Key` = uuidv5(no:kind:generation)、名前空間は `satei-notify.ts` に固定。LINE が 200・409 → `sent`、ほか → `unknown`）。draft はカード（判定・指摘3件・［下書きを見る］＝Drive の閲覧 URL・［OK］`v1|so|no|generation|sha256`・［差し戻し］`v1|sr|…`）、failed・saved・aborted は頭に【査定書 #J番号・案件名】を付けた文字。TASK_SATEI off・通知先が無いときは送らず `{result:"deferred"}`（portal は試行回数を増やさない）。push は月の送信枠を1通使う。
- ［OK］［差し戻し］：`POST /api/jobs/{no}/satei/decide` に sha256・generation を付けて送る（版違い・処理済みの 409 →「この下書きは古いか、もう処理済みです」）。差し戻しを押すと portal は「差し戻し」のまま理由を待つ（理由が来るか30分で取消）。そのあいだ同じ案件の［査定書を作る］は「差し戻しの理由を待っています（理由を返信するか、30分後に押し直してください）」（intake の `SATEI_AWAITING_REASON`）。差し戻しのあとは KV `satei:reason:<userId>` = `{no, token}`（token は UUID・30分）を置き、その人の**次の1対1の文字メッセージ**を `POST /api/jobs/{no}/satei/reason`（200字まで）に送る。印は**消さずに**呼び、成功したら消して「理由を記録しました」、portal が実際に 4xx で断ったら（もう閉じている）印を消して「この差し戻しはもう閉じています」、それ以外（設定不足・5xx・結果不明・例外）は印を残して「記録できませんでした。もう一度送ってください」。消すのは読んだ印と同じ token のときだけ（`satei-wire.ts` の Lua で GET と DEL を1回に。応答待ちのあいだに別の差し戻しが置いた新しい印は消さない）。GETDEL は使わない。取り込みは webhook の文字メッセージの判定のあと・メールの下書きの確認より前の1か所（`handleSateiReasonText`）。印が無いあいだ、ほかの1対1の発言は今の流れへ。
- 保存直前のフォルダ照合：査定係が `POST /api/satei/folder-check`（同じ `x-satei-token`）`{no, dealId, folderId}` を呼ぶ。Notion の CRM_案件 のページの `Driveフォルダ` と同じなら `{match:true}`、違う・消えた・別の DB のページなら `{match:false}`、読めない・見つからない・5秒で時間切れ・TASK_SATEI off・CRM_DEALS_DB_ID 未設定なら `503`（査定係は書かずに次の回へ）。
- 前提の設定：PORTAL_BASE_URL・JOB_API_TOKEN（帯替えと同じ）、CRM_NOTION_TOKEN（無ければ NOTION_API_KEY）・CRM_DEALS_DB_ID（**CRM_案件 と CRM_物件 の両方をその連携に共有**）、KV。個人カードのボタンと理由の返信は送り主の制限を通るので、**下村さんの userId を `SECRETARY_ALLOWED_USER_IDS`（空なら `TASK_BUTTONS_ADMIN_IDS`）にも入れる**。秘書の LINE と下村さんが友だちであること。
- ファイル：`src/lib/satei-data.ts`（スイッチ・押せる人・data）／`satei-deal.ts`（案件・物件の読み方と判定）／`satei-portal.ts`（依頼箱の intake・decide・reason）／`satei-text.ts`（文面・カード）／`satei-notify.ts`（受け口の合言葉・uuidv5・入力の検査）／`satei-actions.ts`（ボタンと理由の処理）／`satei-wire.ts`（本物の Notion・portal・LINE・KV。satei 用の Notion Client は `makeSateiNotion` で作り、SDK のログを出さない logger を指定している＝ID をログに出さないため）／`satei-folder-check.ts`（フォルダ照合）／`src/app/api/satei/notify/route.ts`・`folder-check/route.ts`。`line.ts` の `pushMessagesWithRetryKey` は retry key つきの push（既存の push は変えていない）。
- ログ：`[satei] sa accepted`・`[satei] so stale`・`[satei] sr rejected-ask`・`[satei] reason #J12 saved`・`[satei] notify #J12 draft sent`・`[satei] folder-check #J12 match`・`[satei] config-missing portal` の形（操作名・J番号・kind・結果の符号だけ。案件名・userId・本文・Drive ID は出さない）。
- 本番で on にする・env を足すのは下村さんの承認後（値を画面に出さない方法で入れる）。

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
