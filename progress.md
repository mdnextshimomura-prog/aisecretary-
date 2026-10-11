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
