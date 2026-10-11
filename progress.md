# K4（帯替えのクラウド配達・aisecretary）の進み具合

計画：`.worktrees/group-obi/docs/superpowers/plans/2026-10-11-obi-cloud-k4-aisecretary.md`（13タスク。Task 13 は実行しない）
ブランチ：`feat/obi-cloud`（起点 `integration/email-and-media` の `3d0d35a`）。push・デプロイはしていない。

- Task 1（前提の確認）：済。変更前の基準は `npm test` 23本とも通過・tsc 0・build 0。Vercel の変数の有無（Step 5）は未実施（Vercel の操作をしない指示のため）。進行ログは「クラウド／cloud」で検索しただけ（該当なし）。
- Task 3（トークン）：済。計画のコードのまま。Mac の issue とバイト単位で同じ・閲覧ページの verify を通る。
- Task 2（スイッチと設定）：済。計画のコードのまま。
- Task 4（文と共通のテスト用データ）：済。計画のコードのまま。データは約束の付録から取り出し（sha256 cfe54697…eca4・17,892 バイト）、生成スクリプトの出力と同じ・Mac の実物（5cb9d62）と全行一致。Mac の側のファイルはまだ無い。
- Task 5（portal の呼び出し）：済。9つの呼び出し。計画の型のとおり（DeliveryMessageBody などの型名を足しただけ）。
- Task 6（KV の錠・控え・待ち時間）：済。実物の KV の包み（sadd・srem・smembers）は cloud-store.ts に置いた（計画は cloud-entry.ts の中。型は通った）。形の違う待ち時間・知らせの id の値は「無い」と同じに読む。
- Task 7（差し込み口の型・偽物・完成の配達）：済。結果の報告が 401・403 のときは控えを消さずに残す（計画は「rejected → 消す」。鍵が直れば次の回に報告できるように）。古い portal（via が空）へ返すときは、報告の成否によらず待ち時間を数える。
- Task 8（控えの片付け・再開・予約し直さない時間）：済。portal が 401・403 で打ち切られた回は、prepared の控えを完成へ返すこともしない（次の回へ）。interrupted の報告が 401・403 のときは控えを残す。新しい予約の前に、その番号の控えが無いことを KV で読み直す。
- Task 9（種まきと知らせ）：済。notice-held のログは、その一覧に行があるときだけ出す（毎分2行のログを避ける）。id の報告のやり直しが 401・403 のときは控えを残す。
- Task 10（見回りの本体）：済。わざと壊して落ちることを確かめた（attempt の前の push・attempt が通らないのに push・attempting の再開・peers の判定なし・ログに claimId・70秒の待ちなし・not_sent の報告の順・種まきの回の知らせ・notice/attempt が通らないのに push）。cloud-tick.ts と cloud-deliver.ts／cloud-notice.ts は互いに読み込む（計画のファイルの分け方のため。値を使うのは関数が呼ばれたときだけ）。
- Task 11（入口と cron）：済。line.ts は相対パスで読み込む（計画は @/lib/line。tsx のテストから読めるように）。KV の包みは cloud-store.ts の getCloudStore を使う。例外のログの名前は英字だけに絞る。ビルドの一覧に ƒ /api/obi/cloud-tick。ミドルウェアの matcher に /api/obi は入っていない（遮られない）。
- Task 12（記載・テストの登録・全体の確認）：済。`npm test` 32本とも通過（✅ 2,258件。うち新しい9本で 822件）・`npx tsc --noEmit --incremental false -p .` 0・`npm run build` 0（一覧に ƒ /api/obi/cloud-tick）。既存のファイルの差分は `vercel.json`・`package.json`（test の行）・`CLAUDE.md` だけ。
- Task 13（本番へ出す・鍵・変数・スイッチ）：実行していない（下村さんの承認の後に、別に行う）。push・デプロイ・Vercel の操作はしていない。

## 残っている確認（決定ではないもの）
- 本物の portal（K1）・閲覧ページ（K2）・Mac（K3）との通しは未実施（portal は、約束の応答の形どおりに作った偽物）。
- Vercel の変数の有無（`CRON_SECRET` など）は見ていない。本物の KV で、目次の値・控えが文字列で返るか物で返るかは未確認（両方受ける作り）。
- line-secretary の `test/fixtures/obi-cloud-texts.json` は、本番ツリー（feature/v1）にはまだ無い。K3 の作業ツリー（`.worktrees/obi-cloud-mac`）に置かれた物とは、バイト単位で同じ（sha256 cfe54697…eca4）ことを確かめた。
- 閲覧ページの検証は、写し（feature/group-obi-viewer 415518b）で通る。K2 の作業中の版（`.worktrees/obi-cloud-viewer` 9d6c28e。クラウドの鍵の表 `cloudPublicKeys`）でも、固定のトークンが通り `originOf` が cloud になることを、読むだけで確かめた（写しは入れ替えていない。K2 を取り込んだ後に、写しとテストの sha256 を入れ替える）。

## 最終レビューの後の直し（2026-10-11）
- F0（文の基準の変更）：済。共通のテスト用データを新しい版（sha256 fe78ff10…1d83・18,419 バイト）にバイト単位で差し替え、`cloud-text.ts` を Mac の feature/v1 7ff13e4 の並べ方（リンクの前後に空行・案内は1行1番号・選択肢つきは理由が2行目）に合わせた。Mac の実物の関数（7ff13e4）と全行一致を確かめた。
