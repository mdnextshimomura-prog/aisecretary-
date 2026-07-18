# AI秘書（LINE秘書）— 子エージェント定義

このフォルダは、親エージェント配下で動く **「不動産タスク秘書」子エージェント** の実装兼作業領域です。
このフォルダで起動した Claude セッション／サブエージェントは、まずこのファイルを読んで役割と制約を把握してください。

## このエージェントの責務（スコープ）
LINEで受信した不動産業務メッセージを、構造化タスクに変換してNotionに登録し、リマインドする。

**やること**
- LINEグループでボットがメンションされたメッセージを解析する
- Claude APIでタスク情報（種別・緊急度・期日・担当者）を抽出する
- Notionデータベースにタスクを登録する
- 期日が近いタスクを日次でLINEにリマインド送信する
- **LINEの指示からメールを下書きし、確認を取ってGmailで送信する**（後述「メール送信機能」）

**やらないこと（スコープ外 → 親または別の子に委譲）**
- 物件調査・重要事項説明など不動産書類の作成（別スキル `realestate-*` の領域）
- LINE以外のチャネル（メール受信・Slack等）からの入力
- タスクの自動実行

> 注: 「外部への自動返信はしない」原則の例外として、**LINE指示によるメール送信のみ**を許可した
> （2026-07 追加）。誤送信防止のため、必ず下書き提示→ユーザー承認を挟んでから送信する。

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
| `src/lib/intent.ts` | 発言の意図判定（email / task / other）。emailのみ新処理へ振り分け |
| `src/lib/email/draft.ts` | メール要求の抽出＋文面生成（Claude） |
| `src/lib/email/send.ts` | Gmail APIで送信（`gmail.send`。送信元は `GMAIL_SENDER`） |
| `src/lib/email/session.ts` | 下書き確認セッションの保存（Vercel KV／未設定時はメモリ） |
| `src/lib/email/flow.ts` | メールフロー統括（下書き提示・修正・宛先補完・送信・キャンセル） |
| `src/lib/contacts.ts` | 名前→メールアドレス解決（`EMAIL_CONTACTS` のJSON台帳） |

### メール送信機能（LINE→メール）データフロー
```
LINE発言
  └ webhook/route.ts
       ├ ① 確認セッション有り → email/flow.handleConfirmReply（送信/修正/宛先補完/キャンセル）
       ├ ② 引用リプライのタスク操作（既存・不変）
       ├ ③ intent.classifyIntent = email かつ確信度≥閾値 → email/flow.startEmailFlow（下書き提示）
       └ ④ それ以外 → 既存 parseTaskFromMessage → Notion（不変）
```
- **必ず下書き→承認→送信**。`startEmailFlow` は送信せず下書きをLINE提示してセッション保存。
  ユーザーが「送信」と返して初めて `sendGmail` が走る。
- 宛先が台帳で解決できない場合は送信不可とし、アドレス返信を促す。
- 既存のタスク登録・SUUMO反響は一切変更していない（前段に分岐を追加しただけ）。

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

メール送信機能（任意・使う場合は必須）：
`GMAIL_SENDER`（送信元。既定 mtnext.proposer@gmail.com） / `GMAIL_SENDER_NAME`（署名名） /
`GMAIL_REFRESH_TOKEN`（`gmail.send` スコープ。未設定時は `GOOGLE_REFRESH_TOKEN` を流用／`GOOGLE_CLIENT_ID`・`SECRET` は共用） /
`EMAIL_CONTACTS`（名前→アドレスのJSON台帳） / `EMAIL_INTENT_THRESHOLD`（既定0.7） /
`KV_REST_API_URL` / `KV_REST_API_TOKEN`（Vercel KV。確認セッション保存用。Vercelで KV 作成時に自動注入）

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
