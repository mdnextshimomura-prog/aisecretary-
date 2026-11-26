# 普通のグループの査定依頼 段2d（事例の相談・山口さんへの依頼・リマインド）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 下村さんが案件を選んだあと、Mac の査定係が「REINS の事例の取り方の案」を作り、下村さんの個人LINEで［いいよ］［直す］を聞き、［いいよ］で依頼が来たグループに山口さんあての依頼カードを出し、期日を過ぎても事例の PDF が無ければ1回だけ催促する。3つのリポジトリ（portal・Mac・aisecretary）にまたがる。スイッチを入れるまで、どの作りも今の動きを1バイトも変えない。

**Architecture:** aisecretary が案件決定のときに portal の新しい「準備」の依頼箱（AppState の行）へ依頼を置く → Mac の査定係が見回りで取り、地域の調べ（2c の `runArea`。スイッチ on のときだけ）と査定スキルの既定から案の行を作って portal へ返す → aisecretary が毎分の見回りで portal から案を取りに行き、下村さんへ push → ［いいよ］［直す］は aisecretary の postback で処理し、グループへの依頼・リマインドも aisecretary が出す（LINE の鍵と groupId を持っているのは aisecretary だけ）。portal には決めた結果を記録だけする。

**Tech Stack:** aisecretary＝Next.js（Vercel）・TypeScript・`@vercel/kv`・LINE Messaging API（push・textV2 のメンション・Flex）・Anthropic SDK（［直す］の作り直し1回）・テストは `tsx` と `node:assert`。portal（reins-report）＝Next.js（Railway）・Prisma（本番は db push 運用）・vitest（隔離 SQLite）。Mac（line-secretary）＝Node.js（CommonJS）・`node:test`・launchd の査定係（120秒おき）。

**Spec:** `docs/superpowers/specs/2026-11-25-group-satei-stage2-design.md`（§2 の段7・8、§6、§10〜§14、§16、§17）。前の計画 `docs/superpowers/plans/2026-11-26-group-satei-stage2.md`（2a・2b 前半。R1〜R8 はそのまま有効）。

## Global Constraints

- スイッチ（設計 12）：aisecretary は `GROUP_SATEI_STAGE2`（既定 off。`GROUP_SATEI=1` のときだけ意味を持つ）、portal は `SATEI_PREP`（既定 off）、Mac は `SATEI_PREP`（既定 off。Mac の env）と `SATEI_AREA_RESEARCH`（2c。既定 off）。off なら今の動きを1バイトも変えない。入れる順は portal → Mac → aisecretary、止めるのは逆順。
- 新しい環境変数は aisecretary の `GROUP_SATEI_CASE_STAFF_ID`（山口さんの LINE userId。1人）だけ（設計 6.2・11）。portal と Mac の `SATEI_PREP` はスイッチ。
- 事例の期日：［いいよ］が JST 17:00 より前なら当日 18:00、17:00 以降なら次の営業日の 18:00。火曜・水曜は休み。土日は営業日（設計 16 の 2）。関数は aisecretary の `src/lib/group-satei-deadline.ts`（`gsCaseDeadline`・`gsDeadlineLabel`）をそのまま使う。
- 山口さんへの依頼は、依頼が来たグループに出す（設計 16 の 1）。Mac とのやり取りは portal を通す（設計 16 の 4）。
- グループへの送信は、依頼とリマインドの2つだけ。1件につきグループへ最大2回（設計 6.2）。ボタンは下村さんの1対1だけで、グループのカードにはボタンを付けない（設計 9）。
- グループの文に入れないもの：お客様の名前・REINS の物件番号・号室・番地（設計 6.2）。
- ［直す］は「直すところを1通で送ってください（喋ったままで大丈夫です）」→ 答えで作り直して、もう一度［いいよ］［直す］。2回まで。3回目は手で頼む案内（設計 6.1）。
- リマインド：期日を過ぎても事例の PDF の控えが無ければ、グループに1回だけ「@山口さん 受付 G7 の事例はいかがでしょうか」、下村さんの個人LINEにも1行。2回目は出さない（設計 6.2）。
- 受付票の期限：`waiting-cases` になったときから、さらに7日（設計 10）。
- 事例の条件は査定スキル realestate-satei の「事例の採用」に合わせる（設計 6.1）。既定は `references/attachments.md` §2（直近2年・最大3年・10〜15件、同一町名優先、マンションは同一マンション内優先、面積は前後10㎡、無ければ小学校の学区）と `references/comparables.md`（築年 ±10年、土地は同一用途地域、売出事例は「あれば使う」）。社内ルール（attachments.md）が comparables.md より優先。
- KV・ログには ID・時刻・種類・符号だけ。ログに LINE の ID・本文・所在・物件名・案件名を出さない。ログの形は `[group-satei] prep sent G7`・`propose sent G7 r1`・`case-request posted G7`・`remind sent G7`（設計 13）。portal・Mac のログも符号と受付番号だけ。
- お客様の名前は読まない・残さない。Notion の案件名（お客様の名前が入りうる）はグループの文にも portal にも渡さない。
- 本物の LINE・Notion・portal・Anthropic・Drive・Web はテストで呼ばない（aisecretary は各テストの先頭で `globalThis.fetch` を「外へ出てはいけない」に差し替える。Mac は `fetchImpl`・`drive`・`spawn` を偽物にする）。
- reins-report のどの worktree でも `prisma generate`・`npm run build`・`npm run setup` を流さない（共有の node_modules の Prisma の作りが入れ替わり、本体のテストが落ちる）。この計画は schema.prisma を変えない。
- `.env`・`.env.local` は読まない。push・deploy・本番の env の追加・スイッチの on はしない（リポジトリごとに下村さんの承認後に別途）。
- line-secretary の本体の checkout（`/Users/shimo/AI開発/apps/line-secretary`）・reins-report の本体の checkout では作業しない（見張り・本番が使っている）。worktree だけで作る。
- コミットは `type: 日本語` の形。本文に理由を1〜3行。最後の行は `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

---

## 受け渡しの形（5行）

1. 案件決定（aisecretary の gs）→ portal `POST /api/jobs/satei/prep`（受付票の番号・案件 ID・フォルダ・種別・所在・建物名・面積と築年月）。受付票は `gathering`。
2. Mac が `POST /api/jobs/satei/prep/claim` で取り、（on なら）地域の調べ → 案の行を作って `POST /api/jobs/satei/prep/{tid}/result`（portal は `相談中`）。
3. aisecretary の毎分の見回りが `GET /api/jobs/satei/prep/notices` で案を取りに行き、下村さんへ push（［いいよ］［直す］）。受付票は `proposing`。
4. ［直す］は aisecretary の中で完結（次の1通を Claude 1回で作り直し、返事でカードを出し直す）。［いいよ］は aisecretary がその場でグループへ山口さんあての依頼を push し、portal に `decide ok`（期日・最終の行）を記録。受付票は `waiting-cases`。
5. 見回りが期日を過ぎた `waiting-cases` を見て、事例の PDF の控え（受付票ごとの集合）が無ければ1回だけ催促。PDF の取り出し・保存は 2e。

## この計画で決めたこと（Ruling。設計に書いていない細部・設計からのずれ）

- D1 案は **aisecretary が portal から取りに行く**（毎分の見回り）。設計 11 の「Mac が aisecretary の `POST /api/satei/propose` を呼ぶ」は作らない。portal を通すこと（決定 4）は同じで、aisecretary の新しい受け口・合言葉が要らず、送れたかの控えは aisecretary の KV の1か所だけになる。遅れは最大1分。— 違っていた場合の費用：Mac から押す口を足すだけ（案の形は同じ）。
- D2 ［いいよ］のあとのグループへの依頼は **aisecretary がその場で出す**。設計 11 の「Mac が `POST /api/satei/case-request`」は作らない。groupId を portal・Mac に渡さずに済み、押してから依頼までが2分待ちにならない。portal には `decide`（ok・期日・最終の行）を記録だけする（2e が使う）。
- D3 ［直す］の作り直しは **aisecretary の Claude 1回**（読み取りと同じ `GS_READ_MODEL`）。答えは行の配列で、Mac の最初の案と同じ検査（`gsCleanLines`）を通す。作り直せなかったら回数に数えない。portal へは送らない（最後の ok に最終の行を載せる）。
- D4 portal の置き場は **既存の表 AppState の行**（key `satei-prep:<受付票の番号16桁>`、value は JSON）。新しい表・列を足さない＝本番の db push で何も変わらず、`prisma generate` が要らない。書き換えは「読んだ値のままのときだけ」（`updateMany where {key, value}`）。8日たった行は掃除で消す。
- D5 Mac の案は **純粋関数**（`src/satei/proposal.js`）。資料は読み直さず、aisecretary の読み取り（2b の `read.facts`）の面積・築年月と、地域の調べの小学校区・用途地域だけを使う。地域の調べは `SATEI_AREA_RESEARCH=1` のときだけ（2c の `runArea` をそのまま。結果は案件フォルダの `01_物件資料/地域調査/調査結果.md` に残り、あとの下書きで同じ町丁目なら使い回される＝2c の作り）。
- D6 2d が動くのは **`GROUP_SATEI_STAGE2=1` かつ `GROUP_SATEI_CASE_STAFF_ID` が `U`＋32桁の16進のときだけ**（`groupSateiPrepOn`）。env が無ければ 2a のまま（マンションは今の受付、戸建・土地は手作業）。portal が `503 PREP_DISABLED` を返したときも 2a の道へ戻る（印を外して今の処理を続ける）。新しいスイッチは足さない。
- D7 **2b 後半（足りない項目を聞く）はこの計画に入れない**。前の計画は「2d と同じ計画で」としていたが、2d を小さく保つため分ける。欠けた面積・築年は案の行に「※専有面積・築年は資料で確かめられず（幅は山口さんにお任せ）」と出し、下村さんが［直す］で足せる。聞く仕組みは別の小さな計画（2b-2）。
- D8 「事例の PDF がまだ」の控えは **受付票ごとの集合 `gsatei:cases:<tid>`**（14日）。グループの PDF の控え（段1の `recordGroupSateiMediaEvent`）で、そのグループに `waiting-cases` の票があれば、依頼の時刻より後の PDF の messageId を足す。待ちの票が2件以上で区別がつかないときは**全部に足す**（催促しない側に倒す。誤った催促のほうが重い）。引用での結びつけ・取り出し・保存は 2e。段1の控え（3時間・30件、R7）には頼らない。
- D9 グループへの依頼は **push 1回に2つのメッセージ**：textV2（山口さんへのメンション＋1行）と、ボタンなしの Flex のカード（物件・条件・期日）。Flex はメンションを持てないため。リマインドは textV2 1つ。受付票の `prep.groupPushes` で最大2回を守る。
- D10 リマインド・案の配達・遅れの知らせは、毎分の見回り（`/api/obi/cloud-tick`）の最後に相乗り（`sweepGroupSateiStage2OnTick`。前段で40秒を使っていたら次の回）。対象は集合 `gsatei:s2`（`gathering`・`proposing`・`waiting-cases` の票）だけ。集合が空なら KV を1回読むだけで portal も LINE も呼ばない。
- D11 portal の予約は 20分（地域の調べ 10分＋読み書き）・取り直しは1回（計2回）。2回目も切れたら掃除が `失敗`（timeout）にする。
- D12 **遅れの知らせ**：`gathering` のまま30分たったら、下村さんに1回だけ「事例の取り方の案がまだできていません（受付 G7）。Mac の査定係が止まっているかもしれません。山口さんへは手で頼んでも大丈夫です」。黙って止まらないため（設計に無い。足した）。
- D13 グループのカードの「物件：」は aisecretary が作る：読み取りの所在を「丁目」まで（無ければ最初の数字の前まで）＋マンションなら物件名から号室を除いたもの。案件名は使わない。
- D14 送る前の検査 `gsSafeText`：数字＋号室・数字＋番地・数字＋番＋数字・数字-数字・9桁以上の数字・「様」が1つでもあれば、その行・文は使わない（案ならその案を捨てて手で頼む案内、物件名ならその部分だけ落とす）。
- D15 2e までのつなぎ：［いいよ］の返事に「PDF が貼られたら、案件フォルダの 02 に入れて［査定書を作る］を押してください（自動の保存は次の段）」を付ける。2d だけ先に出すかは下村さんに聞く（下の「下村さんに聞くこと」）。
- D16 案の push は同じ版で2回まで（設計 14「次の見回りで1回だけ送り直す」。同じ retry key）。2回とも結果が分からなければログだけ（30分の遅れの知らせが出る）。
- D17 ［いいよ］のグループへの push が断られた・結果不明のときは、受付票を `manual` にして、下村さんに「山口さんへの依頼を送れませんでした（送れたか確かめられませんでした）。手で頼んでください」＋依頼の文面（設計 14）。送り直しはしない。
- D18 portal の受付停止（`jobs.intake.stopped`）中は「準備」の受付も断る（`503 INTAKE_STOPPED`）。aisecretary は「いま受付を止めています」と返して印を外す。

## 前提（分かっていないこと。推測で埋めない）

- **山口さんの LINE userId**（`GROUP_SATEI_CASE_STAFF_ID`）：名簿（portal の StaffLineUser か aisecretary の members）にあるかを下村さんに確かめる。無ければ 2d は動かない（D6）。
- **Bot と山口さんが、依頼の来るグループ（まず業務指示）に入っているか**：Bot は段1で入っている前提だが、textV2 のメンションは相手がそのグループの人でないと効かない。下村さんに確かめる。
- **LINE の月の送信枠**：push の数え方（グループへの push はグループの人数ぶん数えるか）と今月の残りを、下村さんが LINE Official Account Manager で確かめる。1件あたりの push は、個人あて最大4回（案・遅れ・失敗・催促の1行。ふつうは案の1回）、グループあて最大2回。返事（reply）は数えない。
- **portal の DB の変更**：無い（D4。AppState の行だけ）。本番の起動時の `prisma db push` は差分なしのはず。出す前に `npm run schema:prod` → `prisma validate` で確かめるのは本体の手順どおり（この計画では流さない）。
- **不動産情報ライブラリの API 鍵**（2c の `SATEI_REINFOLIB_KEY`）が Mac にあるか：2c の前提のまま。無くても案は作れる（学区・用途地域が空になるだけ）。
- **2e（PDF の取り出しと保存）はまだ無い**：2d だけを出すと、山口さんが貼った PDF は人が 02 に入れる（D15）。
- aisecretary の `npm test` は途中の `tests/candidate-card.test.ts`（4件。前から落ちている）で止まる。確かめ方は下の「確かめ方」のとおり1本ずつ流す。

## 下村さんに聞くこと（本当に決めてほしいものだけ）

1. **2d を 2e より先に本番に出すか**：先に出す（山口さんへの依頼と催促は自動、貼られた PDF は人が 02 に入れて［査定書を作る］）／2e ができるまで待って一緒に出す。
2. **山口さんの LINE userId と、山口さんが業務指示グループに入っているか**（前提の1・2。値は下村さんが Vercel の env に入れる）。

## 作る場所（worktree・枝）と順番

| リポジトリ | worktree | 枝 | 元 | node_modules |
|---|---|---|---|---|
| portal（reins-report） | `/Users/shimo/AI開発/apps/reins-report/.worktrees/group-satei-2d` | `feat/group-satei-2d` | `4e016e2`（`feat/b2-satei` の先頭。本番の origin/main は 4e016e2 の後に歩合の 5e94abc だけ。重なるファイルは無い） | `../b2-satei/node_modules` へのリンク（4e016e2 の schema と同じ Prisma の作り。確かめ済み）。`npm ci`・`prisma generate` はしない |
| Mac（line-secretary） | `/Users/shimo/AI開発/apps/line-secretary/.worktrees/satei-prep` | `feature/satei-prep` | `feature/satei-area`（ff96dc1。2c の `runArea` を使う） | `../../node_modules` へのリンク（satei-area と同じ） |
| aisecretary | `/Users/shimo/AI開発/apps/aisecretary/.worktrees/group-satei-stage2`（今の worktree） | `feat/group-satei-stage2`（2a・2b 前半の続き） | — | 今のまま（`../b2-satei/node_modules`） |

worktree と枝は、実行する人が作る（`git worktree add -b <枝> <場所> <元>`、続けて `ln -s <node_modules の場所> <worktree>/node_modules`）。この計画を書いた時点では作っていない。

作る順：portal（P1〜P3）→ Mac（M1〜M4）→ aisecretary（A1〜A7）。約束（下の「受け渡しの約束」）が先に決まっているので、3つを並べて作ってもよいが、レビューはこの順。出す順も同じ（portal → Mac → aisecretary）。

## 確かめ方

- portal：`cd /Users/shimo/AI開発/apps/reins-report/.worktrees/group-satei-2d && npx vitest run test/satei-prep.test.ts`（隔離の `prisma/test.db` に db push --skip-generate するだけ。generate しない）。最後に `npx vitest run test/satei-*.test.ts` と `npx tsc --noEmit`。
- Mac：`cd /Users/shimo/AI開発/apps/line-secretary/.worktrees/satei-prep && LINE_SECRETARY_ENV_FILE=/nonexistent/line-secretary-test.env node --test test/satei-prep*.test.js`。最後に `npm test`。
- aisecretary：自分のテストを `npx tsx tests/<file>.test.ts` で1本ずつ。最後に

```bash
cd /Users/shimo/AI開発/apps/aisecretary/.worktrees/group-satei-stage2
for f in tests/group-satei-*.test.ts tests/satei-portal.test.ts; do npx tsx "$f" > /dev/null || echo "FAIL $f"; done
npx tsc --noEmit -p .
```

Expected：`FAIL` の行が1つも出ない。`tsc` は何も出さずに終わる。

## 受け渡しの約束（portal の新しい口。鍵はどれも `x-job-token` = JOB_API_TOKEN）

| 口 | 呼ぶ人 | 本文 | 応答 |
|---|---|---|---|
| `POST /api/jobs/satei/prep` | aisecretary | `{tid, no, dealId, folderId, kind, place, building, facts:{builtYm, exclusiveArea, landArea, buildingArea}, requestedBy}` | 201／200 `{created, prep:{tid, status}}`。off は `503 PREP_DISABLED`、受付停止は `503 INTAKE_STOPPED`、同じ tid で別の案件は `409 INTAKE_MISMATCH` |
| `POST /api/jobs/satei/prep/claim` | Mac | `{}` | 200 `{tid, no, runId, leaseUntil, attempt, dealId, folderId, kind, place, building, facts}`／204（無い・off） |
| `POST /api/jobs/satei/prep/{tid}/result` | Mac | `{runId, outcome:"proposed", lines, areaDone}` か `{runId, outcome:"failed", failReason:"folder"|"internal"}` | 200 `{status}`。runId が今のものでない・作業中でない → `409 PREP_STALE` |
| `GET /api/jobs/satei/prep/notices` | aisecretary | — | 200 `{preps:[{tid, no, status:"相談中"|"失敗", lines, areaDone, failReason}]}`（8日以内。off は `[]`） |
| `POST /api/jobs/satei/prep/{tid}/decide` | aisecretary | `{decision:"ok", rev, lines, deadline}` か `{decision:"manual", rev}` | 200 `{status}`（同じ決定の送り直しは同じ答え）。もう別の決定で閉じている → `409 PREP_CLOSED` |

- `tid`＝aisecretary の受付票の番号（16桁の小文字16進）、`no`＝受付番号（G7 の 7）、`kind`＝`マンション`・`戸建`・`土地`、`place`＝読み取りの所在（120字まで。無ければ null）、`building`＝号室を除いた建物名（60字まで・マンションだけ。無ければ null）、`lines`＝案の行（1〜8行・1行100字まで）、`deadline`＝期日のミリ秒。
- 行の状態：`受付` → `作業中` → `相談中` → `依頼済み`／`手作業`。ほかに `失敗`（Mac の失敗・取り直しも切れた）→ `手作業`。8日たった行は消す。

## ファイルの地図

**portal（reins-report）**

| ファイル | 役割 | タスク |
|---|---|---|
| `src/lib/satei-prep.ts`（新） | 準備の依頼箱（行の形・受付・予約・結果・一覧・決定・掃除） | P1〜P3 |
| `src/lib/job-errors.ts` | `prep_disabled`・`prep_stale`・`prep_closed` の code | P1 |
| `src/app/api/jobs/satei/prep/route.ts`（新） | 受付 | P1 |
| `src/app/api/jobs/satei/prep/claim/route.ts`（新） | 予約 | P2 |
| `src/app/api/jobs/satei/prep/[tid]/result/route.ts`（新） | 結果 | P2 |
| `src/app/api/jobs/satei/prep/notices/route.ts`（新） | 一覧 | P3 |
| `src/app/api/jobs/satei/prep/[tid]/decide/route.ts`（新） | 決定 | P3 |
| `test/satei-prep.test.ts`（新） | 上のテスト | P1〜P3 |
| `CLAUDE.md` | 準備の依頼箱の節 | P3 |

**Mac（line-secretary）**

| ファイル | 役割 | タスク |
|---|---|---|
| `src/config.js` | `sateiPrepFrom`（`SATEI_PREP`）を SATEI に足す | M1 |
| `src/satei/portal.js` | `prepClaim`・`prepResult` | M1 |
| `src/satei/proposal.js`（新） | 案の行（純粋関数）・調査結果.md の項目の読み方 | M2 |
| `src/satei/area.js` | `runArea` に見出しの受付の名前（`label`）を渡せるようにする | M3 |
| `src/satei/prep.js`（新） | 1件の準備（フォルダ → 地域の調べ → 案 → 結果） | M3 |
| `src/satei/tick.js` | 見回りに準備を足す（on のときだけ） | M4 |
| `test/satei-prep-config.test.js`・`satei-prep-portal.test.js`・`satei-proposal.test.js`・`satei-prep.test.js`・`satei-prep-tick.test.js`（新） | 上のテスト | M1〜M4 |
| `docs/運用.md` | 準備の段の運用 | M4 |

**aisecretary**

| ファイル | 役割 | タスク |
|---|---|---|
| `src/lib/group-satei-data.ts` | 新しい状態・`GsPrep`・鍵・山口さんの ID・`gy`／`gf` の data | A1 |
| `src/lib/group-satei-case.ts`（新） | 純粋：検査・物件の言い方・案のカード・グループの文・作り直しの指示文と読み方・返事の文 | A2 |
| `src/lib/satei-portal.ts` | `postJson`・`classify` を出し、`getJson` を足す | A3 |
| `src/lib/group-satei-prep-portal.ts`（新） | portal の準備の口（受付・一覧・決定） | A3 |
| `src/lib/group-satei-propose.ts`（新） | 準備の開始・［いいよ］［直す］・直しの1通・見回り・事例の PDF の控え | A4〜A6 |
| `src/lib/group-satei-actions.ts` | 案件決定で準備へ・`gy`／`gf` の振り分け・`GsActionDeps` に任意の口 | A4・A5 |
| `src/lib/group-satei-wire.ts` | 本物の portal・push・Claude・KV・見回り・PDF の控え | A4〜A6 |
| `src/app/api/webhook/route.ts` | 1対1の直しの1通を受ける（差し戻し理由の後ろ） | A5 |
| `src/app/api/obi/cloud-tick/route.ts` | 見回りの相乗り | A6 |
| `tests/group-satei-prep-data.test.ts`・`-case.test.ts`・`-prep-portal.test.ts`・`-prep-actions.test.ts`・`-propose.test.ts`・`-stage2-sweep.test.ts`（新） | 上のテスト | A1〜A6 |
| `package.json` | `test` の最後に新しいテスト | A1〜A6 |
| `CLAUDE.md` | 段2d の節 | A7 |

---

# portal（reins-report）

作業場所：`/Users/shimo/AI開発/apps/reins-report/.worktrees/group-satei-2d`（枝 `feat/group-satei-2d`）。

### Task P1: 準備の依頼箱の形と受付（POST /api/jobs/satei/prep）

**Files:**
- Create: `src/lib/satei-prep.ts`
- Create: `src/app/api/jobs/satei/prep/route.ts`
- Modify: `src/lib/job-errors.ts`（`JobErrorCode` の末尾と `OUTWARD` の末尾）
- Test: `test/satei-prep.test.ts`

**Interfaces:**
- Consumes: `prisma`（`@/lib/db`）、`JobError`、`isIntakeStopped`・`isUniqueConstraintError`（`@/lib/jobs`）、`DRIVE_FILE_ID_RE`・`UUID_RE`（`@/lib/job-cloud`）
- Produces: `PrepRow`・`PrepStatus`・`PrepKind`・`PrepFacts`・`prepKey(tid)`・`sateiPrepOn()`・`readPrep(tid)`・`swapPrep(raw, next)`・`allPreps()`・`intakeSateiPrep(input, now?)` → `{created, row}`。定数 `PREP_LEASE_MS`・`PREP_MAX_ATTEMPTS`・`PREP_KEEP_MS`・`PREP_LINES_MAX`・`PREP_LINE_LEN`。

- [ ] **Step 1: 失敗するテストを書く**

`test/satei-prep.test.ts`：

```ts
// 段2d：査定の「準備」（事例の取り方の案）の依頼箱（計画 aisecretary docs/superpowers/plans/2026-11-26-group-satei-2d.md）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/db', () => {
  const { PrismaClient } = require('@prisma/client');
  return { prisma: new PrismaClient({ datasources: { db: { url: `file:${process.cwd()}/prisma/test.db` } } }) };
});

import { prisma } from '@/lib/db';
import * as intake from '@/app/api/jobs/satei/prep/route';
import { prepKey, readPrep } from '@/lib/satei-prep';
import { DEAL, DEAL2, FOLDER, TOKEN, USER, json } from './helpers/satei';

const TID = '0123456789abcdef';
const TID2 = 'fedcba9876543210';
const body = (over: Record<string, unknown> = {}) => ({
  tid: TID, no: 7, dealId: DEAL, folderId: FOLDER, kind: 'マンション',
  place: '大阪市北区天満2丁目3-4', building: 'パークハウス天満',
  facts: { builtYm: '2005-03', exclusiveArea: 65.3, landArea: null, buildingArea: null },
  requestedBy: USER, ...over,
});
const post = (b: unknown, token = true) => intake.POST(json('/api/jobs/satei/prep', 'POST', b, token));

beforeEach(async () => {
  process.env.JOB_API_TOKEN = TOKEN;
  process.env.SATEI_PREP = '1';
  await prisma.appState.deleteMany({ where: { OR: [{ key: { startsWith: 'satei-prep:' } }, { key: 'jobs.intake.stopped' }] } });
});
afterEach(async () => {
  delete process.env.SATEI_PREP;
  await prisma.appState.deleteMany({ where: { OR: [{ key: { startsWith: 'satei-prep:' } }, { key: 'jobs.intake.stopped' }] } });
});

describe('POST /api/jobs/satei/prep（受付）', () => {
  it('新しい準備は 201。AppState に1行（受付・試した回数 0）', async () => {
    const res = await post(body());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ created: true, prep: { tid: TID, status: '受付' } });
    const got = await readPrep(TID);
    expect(got?.row).toMatchObject({ v: 1, tid: TID, no: 7, status: '受付', kind: 'マンション', attempts: 0, lines: [], decidedRev: 0 });
    expect(got?.row.facts).toEqual({ builtYm: '2005-03', exclusiveArea: 65.3, landArea: null, buildingArea: null });
  });

  it('同じ tid の2度目は 200 で同じもの（増えない）', async () => {
    await post(body());
    const res = await post(body());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: false, prep: { tid: TID, status: '受付' } });
    expect(await prisma.appState.count({ where: { key: { startsWith: 'satei-prep:' } } })).toBe(1);
  });

  it('同じ tid で別の案件は 409 INTAKE_MISMATCH', async () => {
    await post(body());
    const res = await post(body({ dealId: DEAL2 }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('INTAKE_MISMATCH');
  });

  it('SATEI_PREP が 1 でなければ 503 PREP_DISABLED（行を作らない）', async () => {
    process.env.SATEI_PREP = '0';
    const res = await post(body());
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('PREP_DISABLED');
    expect(await prisma.appState.findUnique({ where: { key: prepKey(TID) } })).toBeNull();
  });

  it('受付停止中は 503 INTAKE_STOPPED', async () => {
    await prisma.appState.create({ data: { key: 'jobs.intake.stopped', value: '1' } });
    const res = await post(body({ tid: TID2 }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('INTAKE_STOPPED');
  });

  it('鍵が無ければ 401', async () => {
    expect((await post(body(), false)).status).toBe(401);
  });

  it('形の違う欄は 400（tid・種別・面積・築年月・userId）', async () => {
    for (const over of [{ tid: 'XYZ' }, { kind: 'ビル' }, { facts: { exclusiveArea: -1 } }, { facts: { builtYm: '2005/03' } }, { requestedBy: 'x' }, { place: 5 }]) {
      const res = await post(body(over));
      expect(res.status, JSON.stringify(over)).toBe(400);
    }
  });

  it('所在・建物名は空なら null、長ければ切る（120字・60字）', async () => {
    await post(body({ place: '', building: 'あ'.repeat(80) }));
    const row = (await readPrep(TID))!.row;
    expect(row.place).toBeNull();
    expect(Array.from(row.building!).length).toBe(60);
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run test/satei-prep.test.ts`
Expected: FAIL（`@/app/api/jobs/satei/prep/route` が無い）

- [ ] **Step 3: エラーの code を足す**

`src/lib/job-errors.ts` の `JobErrorCode` の最後の行（`| 'satei_obi_busy' …`）の後ろに：

```ts
  // 段2d：査定の「準備」（事例の取り方の案）の依頼箱（satei-prep.ts）
  | 'prep_disabled' // SATEI_PREP が 1 でない（止めてある）
  | 'prep_stale' // runId・状態が今のものと合わない（古い係）
  | 'prep_closed' // 別の決定で閉じている
```

`OUTWARD` の最後（`satei_obi_busy: …,` の後ろ）に：

```ts
  prep_disabled: { code: 'PREP_DISABLED', status: 503 },
  prep_stale: { code: 'PREP_STALE', status: 409 },
  prep_closed: { code: 'PREP_CLOSED', status: 409 },
```

- [ ] **Step 4: 依頼箱の形と受付を書く**

`src/lib/satei-prep.ts`：

```ts
// 段2d：査定の「準備」（事例の取り方の案づくり）の依頼箱。aisecretary の設計 2026-11-25-group-satei-stage2 §11、
// 計画 aisecretary docs/superpowers/plans/2026-11-26-group-satei-2d.md（受け渡しの約束）。
// 置き場は AppState の行（key = satei-prep:<tid>、value = JSON）。新しい表・列は足さない（本番の db push・prisma generate が要らない。D4）。
// 書き換えは「読んだ値のままのときだけ」（updateMany where {key, value}）。
// スイッチ SATEI_PREP（"1" のときだけ受ける。既定 off）。off のとき：受付 503 PREP_DISABLED・予約 204・一覧 []。決定は off でも受ける（閉じるだけ）。
// ログに LINE の userId・所在・物件名は出さない（この部品はログを出さない）。
import crypto from 'crypto';
import { prisma } from './db';
import { JobError } from './job-errors';
import { DRIVE_FILE_ID_RE } from './job-cloud';
import { isIntakeStopped } from './jobs';

export const PREP_KEY_PREFIX = 'satei-prep:';
// 予約の長さ（地域の調べ 10 分＋地理院・不動産情報ライブラリ・Drive の読み書き）。延長はしない
export const PREP_LEASE_MS = 20 * 60 * 1000;
// 取れる回数（時間切れの取り直しは1回だけ）
export const PREP_MAX_ATTEMPTS = 2;
// 行を残す長さ（受付票の期限 7 日＋1 日）
export const PREP_KEEP_MS = 8 * 24 * 60 * 60 * 1000;
export const PREP_LINES_MAX = 8;
export const PREP_LINE_LEN = 100;
export const PREP_KINDS = ['マンション', '戸建', '土地'] as const;
export type PrepKind = (typeof PREP_KINDS)[number];
export const PREP_STATUSES = ['受付', '作業中', '相談中', '依頼済み', '手作業', '失敗'] as const;
export type PrepStatus = (typeof PREP_STATUSES)[number];
export const PREP_FAIL_REASONS = ['folder', 'internal', 'timeout'] as const;

export type PrepFacts = { builtYm: string | null; exclusiveArea: number | null; landArea: number | null; buildingArea: number | null };

export type PrepRow = {
  v: 1;
  tid: string;
  no: number;
  status: PrepStatus;
  dealId: string;
  folderId: string;
  kind: PrepKind;
  place: string | null;
  building: string | null;
  facts: PrepFacts;
  requestedBy: string;
  runId: string;
  leaseUntil: number;
  attempts: number;
  lines: string[];
  areaDone: boolean;
  failReason: string;
  decidedRev: number;
  deadline: number | null;
  createdAt: number;
  updatedAt: number;
};

const TID_RE = /^[0-9a-f]{16}$/;
const DEAL_ID_RE = /^[0-9a-f]{32}$/;
const LINE_USER_RE = /^U[0-9a-f]{32}$/;
const YM_RE = /^(19|20)[0-9]{2}-(0[1-9]|1[0-2])$/;

export const sateiPrepOn = () => process.env.SATEI_PREP === '1';
export const prepKey = (tid: string) => `${PREP_KEY_PREFIX}${tid}`;

export const badPrep = (field: string) => new JobError('invalid', `${field} の形が正しくありません`);
// 文字数で切る（絵文字を割らない）
export const cutText = (s: string, n: number) => Array.from(s).slice(0, n).join('');

export function requireTid(v: unknown): string {
  if (typeof v !== 'string' || !TID_RE.test(v)) throw badPrep('tid');
  return v;
}
function optText(v: unknown, n: number, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw badPrep(field);
  const t = v.trim();
  return t ? cutText(t, n) : null;
}
function optArea(v: unknown, field: string): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 100000) throw badPrep(field);
  return v;
}
function parseFacts(v: unknown): PrepFacts {
  if (v === undefined || v === null) return { builtYm: null, exclusiveArea: null, landArea: null, buildingArea: null };
  if (typeof v !== 'object' || Array.isArray(v)) throw badPrep('facts');
  const f = v as Record<string, unknown>;
  const ym = f.builtYm;
  if (ym !== undefined && ym !== null && (typeof ym !== 'string' || !YM_RE.test(ym))) throw badPrep('facts.builtYm');
  return {
    builtYm: typeof ym === 'string' ? ym : null,
    exclusiveArea: optArea(f.exclusiveArea, 'facts.exclusiveArea'),
    landArea: optArea(f.landArea, 'facts.landArea'),
    buildingArea: optArea(f.buildingArea, 'facts.buildingArea'),
  };
}

export function parsePrepRow(value: string): PrepRow | null {
  try {
    const r = JSON.parse(value) as PrepRow;
    return r && r.v === 1 && TID_RE.test(r.tid) && (PREP_STATUSES as readonly string[]).includes(r.status) ? r : null;
  } catch {
    return null;
  }
}

export async function readPrep(tid: string): Promise<{ row: PrepRow; raw: string } | null> {
  const r = await prisma.appState.findUnique({ where: { key: prepKey(tid) } });
  const row = r ? parsePrepRow(r.value) : null;
  return row && r ? { row, raw: r.value } : null;
}

export async function allPreps(): Promise<Array<{ row: PrepRow; raw: string }>> {
  const rows = await prisma.appState.findMany({ where: { key: { startsWith: PREP_KEY_PREFIX } }, orderBy: { key: 'asc' } });
  const out: Array<{ row: PrepRow; raw: string }> = [];
  for (const r of rows) {
    const row = parsePrepRow(r.value);
    if (row) out.push({ row, raw: r.value });
  }
  return out;
}

/** 読んだ値（raw）のままのときだけ next を書く。負けたら false */
export async function swapPrep(raw: string, next: PrepRow): Promise<boolean> {
  const res = await prisma.appState.updateMany({ where: { key: prepKey(next.tid), value: raw }, data: { value: JSON.stringify(next) } });
  return res.count === 1;
}

export type PrepIntakeResult = { created: boolean; row: PrepRow };

/** aisecretary が案件を決めたときに呼ぶ。同じ tid の2度目は同じものを返す（増やさない） */
export async function intakeSateiPrep(input: Record<string, unknown>, now: number = Date.now()): Promise<PrepIntakeResult> {
  if (!sateiPrepOn()) throw new JobError('prep_disabled', '事例の相談の準備はいま止めています');
  const tid = requireTid(input.tid);
  const no = input.no;
  if (typeof no !== 'number' || !Number.isSafeInteger(no) || no <= 0) throw badPrep('no');
  if (typeof input.dealId !== 'string' || !DEAL_ID_RE.test(input.dealId)) throw badPrep('dealId');
  const dealId = input.dealId;
  if (typeof input.folderId !== 'string' || !DRIVE_FILE_ID_RE.test(input.folderId)) throw badPrep('folderId');
  if (typeof input.kind !== 'string' || !(PREP_KINDS as readonly string[]).includes(input.kind)) throw badPrep('kind');
  if (typeof input.requestedBy !== 'string' || !LINE_USER_RE.test(input.requestedBy)) throw badPrep('requestedBy');
  const row: PrepRow = {
    v: 1, tid, no, status: '受付', dealId, folderId: input.folderId, kind: input.kind as PrepKind,
    place: optText(input.place, 120, 'place'), building: optText(input.building, 60, 'building'), facts: parseFacts(input.facts),
    requestedBy: input.requestedBy, runId: '', leaseUntil: 0, attempts: 0, lines: [], areaDone: false, failReason: '',
    decidedRev: 0, deadline: null, createdAt: now, updatedAt: now,
  };
  // 二度押しの判定は停止の判定より先（受けた依頼には同じ答えを返す）
  const same = (got: { row: PrepRow }): PrepIntakeResult => {
    if (got.row.dealId !== dealId) throw new JobError('intake_mismatch', '同じ受付で、別の案件の準備があります');
    return { created: false, row: got.row };
  };
  const existing = await readPrep(tid);
  if (existing) return same(existing);
  if (await isIntakeStopped()) throw new JobError('stopped', '現在受付を止めています');
  try {
    await prisma.appState.create({ data: { key: prepKey(tid), value: JSON.stringify(row) } });
    return { created: true, row };
  } catch (e) {
    // 同じ tid の同時の受付：先に入った方を返す（主キーの重なり P2002）
    if ((e as { code?: string } | null)?.code !== 'P2002') throw e;
    const race = await readPrep(tid);
    if (!race) throw e;
    return same(race);
  }
}

/** 予約の鍵の材料（claim が使う） */
export const newRunId = () => crypto.randomUUID();
```

`src/app/api/jobs/satei/prep/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { isJobApiRequest } from '@/lib/job-auth';
import { jobErrorResponse, readJsonObject, unauthorized } from '@/lib/job-http';
import { intakeSateiPrep } from '@/lib/satei-prep';

export const dynamic = 'force-dynamic';

// POST — aisecretary が、案件を決めた受付票の「準備」（事例の取り方の案）を頼む（段2d・受け渡しの約束）。鍵が必須。
// 新しく作れば 201、同じ tid の2度目は 200（どちらも { created, prep: { tid, status } }）。SATEI_PREP off は 503 PREP_DISABLED
export async function POST(request: NextRequest) {
  if (!isJobApiRequest(request)) return unauthorized();
  try {
    const r = await intakeSateiPrep(await readJsonObject(request));
    return NextResponse.json({ created: r.created, prep: { tid: r.row.tid, status: r.row.status } }, { status: r.created ? 201 : 200 });
  } catch (e) {
    return jobErrorResponse(e);
  }
}
```

- [ ] **Step 5: 通ることを確かめる**

Run: `npx vitest run test/satei-prep.test.ts`
Expected: PASS（8件）

- [ ] **Step 6: コミット**

```bash
git add src/lib/satei-prep.ts src/app/api/jobs/satei/prep/route.ts src/lib/job-errors.ts test/satei-prep.test.ts
git commit -m "feat: 段2dの査定の準備の依頼箱（AppState の行）と受付の口を足す

案件を決めた受付票の、事例の取り方の案づくりを Mac に渡すため。表は足さない（db push・generate が要らない）。
SATEI_PREP が 1 のときだけ受ける。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task P2: 予約と結果（claim・result）・掃除

**Files:**
- Modify: `src/lib/satei-prep.ts`（末尾に足す）
- Create: `src/app/api/jobs/satei/prep/claim/route.ts`
- Create: `src/app/api/jobs/satei/prep/[tid]/result/route.ts`
- Test: `test/satei-prep.test.ts`（describe を足す）

**Interfaces:**
- Consumes: P1 の `allPreps`・`readPrep`・`swapPrep`・`requireTid`・`badPrep`・`cutText`・`newRunId`・定数
- Produces: `sweepSateiPrep(now?)` → 数、`claimSateiPrep(now?)` → `PrepClaim | null`、`reportSateiPrep(tid, input, now?)` → `{status}`、型 `PrepClaim`（`{tid, no, runId, leaseUntil: string, attempt, dealId, folderId, kind, place, building, facts}`）

- [ ] **Step 1: 失敗するテストを足す**

`test/satei-prep.test.ts` の import に `import * as claim from '@/app/api/jobs/satei/prep/claim/route';`・`import * as result from '@/app/api/jobs/satei/prep/[tid]/result/route';`・`import { claimSateiPrep, sweepSateiPrep, PREP_LEASE_MS } from '@/lib/satei-prep';` を足し、末尾に：

```ts
const tidParams = (tid: string) => ({ params: Promise.resolve({ tid }) });
const doClaim = async () => claim.POST(json('/api/jobs/satei/prep/claim', 'POST', {}));
const doResult = (tid: string, b: unknown) => result.POST(json(`/api/jobs/satei/prep/${tid}/result`, 'POST', b), tidParams(tid));

describe('POST /api/jobs/satei/prep/claim・{tid}/result', () => {
  it('受付が無ければ 204。off も 204', async () => {
    expect((await doClaim()).status).toBe(204);
    await post(body());
    process.env.SATEI_PREP = '0';
    expect((await doClaim()).status).toBe(204);
  });

  it('取ると作業中・runId・20分の期限・attempt 1。物件の欄を返す（案件名は返さない）', async () => {
    await post(body());
    const res = await doClaim();
    expect(res.status).toBe(200);
    const c = await res.json();
    expect(c).toMatchObject({ tid: TID, no: 7, attempt: 1, dealId: DEAL, folderId: FOLDER, kind: 'マンション', place: '大阪市北区天満2丁目3-4', building: 'パークハウス天満' });
    expect(c.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect('dealName' in c).toBe(false);
    expect((await readPrep(TID))!.row.status).toBe('作業中');
    expect((await doClaim()).status).toBe(204);
  });

  it('期限が切れたら1回だけ取り直せる。2回目も切れたら掃除が失敗（timeout）にする', async () => {
    await post(body());
    const t0 = Date.now();
    const a = await claimSateiPrep(t0);
    const b = await claimSateiPrep(t0 + PREP_LEASE_MS + 1);
    expect(b?.attempt).toBe(2);
    expect(b?.runId).not.toBe(a?.runId);
    expect(await claimSateiPrep(t0 + 2 * PREP_LEASE_MS + 2)).toBeNull();
    expect((await readPrep(TID))!.row).toMatchObject({ status: '失敗', failReason: 'timeout' });
  });

  it('結果 proposed：相談中・行と地域の調べの印を残す。行は空白を捨て100字で切る', async () => {
    await post(body());
    const c = await (await doClaim()).json();
    const res = await doResult(TID, { runId: c.runId, outcome: 'proposed', lines: ['成約：同じマンション', ' ', 'あ'.repeat(120)], areaDone: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: '相談中' });
    const row = (await readPrep(TID))!.row;
    expect(row.lines.length).toBe(2);
    expect(Array.from(row.lines[1]).length).toBe(100);
    expect(row.areaDone).toBe(true);
  });

  it('結果 failed：失敗と理由', async () => {
    await post(body());
    const c = await (await doClaim()).json();
    const res = await doResult(TID, { runId: c.runId, outcome: 'failed', failReason: 'folder' });
    expect(await res.json()).toEqual({ status: '失敗' });
    expect((await readPrep(TID))!.row.failReason).toBe('folder');
  });

  it('古い runId・作業中でない行は 409 PREP_STALE。無い tid は 404', async () => {
    await post(body());
    const c = await (await doClaim()).json();
    const stale = await doResult(TID, { runId: '00000000-0000-4000-8000-000000000000', outcome: 'failed', failReason: 'internal' });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('PREP_STALE');
    await doResult(TID, { runId: c.runId, outcome: 'failed', failReason: 'internal' });
    expect((await doResult(TID, { runId: c.runId, outcome: 'failed', failReason: 'internal' })).status).toBe(409);
    expect((await doResult(TID2, { runId: c.runId, outcome: 'failed', failReason: 'internal' })).status).toBe(404);
  });

  it('行が無い・多すぎる・形が違う proposed は 400', async () => {
    await post(body());
    const c = await (await doClaim()).json();
    for (const lines of [[], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], [1], 'x']) {
      expect((await doResult(TID, { runId: c.runId, outcome: 'proposed', lines })).status, JSON.stringify(lines)).toBe(400);
    }
  });

  it('8日たった行は掃除で消える', async () => {
    await post(body());
    expect(await sweepSateiPrep(Date.now() + 9 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(await readPrep(TID)).toBeNull();
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run test/satei-prep.test.ts`
Expected: FAIL（claim・result の route が無い）

- [ ] **Step 3: 予約・結果・掃除を書く**

`src/lib/satei-prep.ts` の末尾に：

```ts
// ---------- 掃除・予約（POST /api/jobs/satei/prep/claim）・結果（POST /api/jobs/satei/prep/{tid}/result） ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 8日たった行を消し、取り直しも切れた作業中を失敗（timeout）にする。数を返す */
export async function sweepSateiPrep(now: number = Date.now()): Promise<number> {
  let n = 0;
  for (const { row, raw } of await allPreps()) {
    if (now - row.updatedAt > PREP_KEEP_MS) {
      const res = await prisma.appState.deleteMany({ where: { key: prepKey(row.tid), value: raw } });
      n += res.count;
      continue;
    }
    if (row.status === '作業中' && row.leaseUntil < now && row.attempts >= PREP_MAX_ATTEMPTS) {
      if (await swapPrep(raw, { ...row, status: '失敗', failReason: 'timeout', runId: '', updatedAt: now })) n++;
    }
  }
  return n;
}

export type PrepClaim = {
  tid: string; no: number; runId: string; leaseUntil: string; attempt: number;
  dealId: string; folderId: string; kind: PrepKind; place: string | null; building: string | null; facts: PrepFacts;
};

/** Mac の査定係が1件取る。受付か、作業中で期限が切れて取った回数が2未満のもの。古い順。off なら null */
export async function claimSateiPrep(now: number = Date.now()): Promise<PrepClaim | null> {
  if (!sateiPrepOn()) return null;
  await sweepSateiPrep(now);
  const cands = (await allPreps())
    .filter(({ row }) => row.status === '受付' || (row.status === '作業中' && row.leaseUntil < now && row.attempts < PREP_MAX_ATTEMPTS))
    .sort((a, b) => a.row.createdAt - b.row.createdAt);
  for (const { row, raw } of cands) {
    const next: PrepRow = { ...row, status: '作業中', runId: newRunId(), leaseUntil: now + PREP_LEASE_MS, attempts: row.attempts + 1, updatedAt: now };
    if (await swapPrep(raw, next)) {
      return {
        tid: next.tid, no: next.no, runId: next.runId, leaseUntil: new Date(next.leaseUntil).toISOString(), attempt: next.attempts,
        dealId: next.dealId, folderId: next.folderId, kind: next.kind, place: next.place, building: next.building, facts: next.facts,
      };
    }
  }
  return null;
}

function parseLines(v: unknown): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw badPrep('lines');
  const lines = (v as string[]).map((x) => x.trim()).filter((x) => x !== '').map((x) => cutText(x, PREP_LINE_LEN));
  if (lines.length === 0 || lines.length > PREP_LINES_MAX) throw badPrep('lines');
  return lines;
}

/** Mac が案（proposed）か失敗（failed）を返す。runId が今のもの・作業中のときだけ（期限が切れていても、取り直されていなければ受ける） */
export async function reportSateiPrep(tid: string, input: Record<string, unknown>, now: number = Date.now()): Promise<{ status: PrepStatus }> {
  requireTid(tid);
  if (typeof input.runId !== 'string' || !UUID.test(input.runId)) throw badPrep('runId');
  const outcome = input.outcome;
  if (outcome !== 'proposed' && outcome !== 'failed') throw badPrep('outcome');
  const lines = outcome === 'proposed' ? parseLines(input.lines) : [];
  if (input.areaDone !== undefined && typeof input.areaDone !== 'boolean') throw badPrep('areaDone');
  const failReason = outcome === 'failed' ? input.failReason : '';
  if (outcome === 'failed' && (typeof failReason !== 'string' || !(PREP_FAIL_REASONS as readonly string[]).includes(failReason))) {
    throw badPrep('failReason');
  }
  const got = await readPrep(tid);
  if (!got) throw new JobError('not_found', '準備が見つかりません');
  const { row, raw } = got;
  if (row.status !== '作業中' || row.runId !== input.runId) throw new JobError('prep_stale', '準備の実行が今のものと合いません');
  const next: PrepRow =
    outcome === 'proposed'
      ? { ...row, status: '相談中', lines, areaDone: input.areaDone === true, updatedAt: now }
      : { ...row, status: '失敗', failReason: failReason as string, updatedAt: now };
  if (!(await swapPrep(raw, next))) throw new JobError('prep_stale', '準備の実行が今のものと合いません');
  return { status: next.status };
}
```

`src/app/api/jobs/satei/prep/claim/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { isJobApiRequest } from '@/lib/job-auth';
import { jobErrorResponse, readOptionalJsonObject, unauthorized } from '@/lib/job-http';
import { claimSateiPrep } from '@/lib/satei-prep';

export const dynamic = 'force-dynamic';

// POST — Mac の査定係が「準備」を1件取る（段2d）。鍵が必須。本文は {}（見ない）。取れれば 200、無い・off は 204
export async function POST(request: NextRequest) {
  if (!isJobApiRequest(request)) return unauthorized();
  try {
    await readOptionalJsonObject(request);
    const c = await claimSateiPrep();
    if (!c) return new NextResponse(null, { status: 204 });
    return NextResponse.json(c);
  } catch (e) {
    return jobErrorResponse(e);
  }
}
```

`src/app/api/jobs/satei/prep/[tid]/result/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { isJobApiRequest } from '@/lib/job-auth';
import { jobErrorResponse, readJsonObject, unauthorized } from '@/lib/job-http';
import { reportSateiPrep } from '@/lib/satei-prep';

export const dynamic = 'force-dynamic';

// POST { runId, outcome: "proposed", lines, areaDone } | { runId, outcome: "failed", failReason } — Mac の結果（段2d）
export async function POST(request: NextRequest, ctx: { params: Promise<{ tid: string }> }) {
  if (!isJobApiRequest(request)) return unauthorized();
  try {
    const { tid } = await ctx.params;
    return NextResponse.json(await reportSateiPrep(tid, await readJsonObject(request)));
  } catch (e) {
    return jobErrorResponse(e);
  }
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run test/satei-prep.test.ts`
Expected: PASS（P1 の8件＋8件）

- [ ] **Step 5: コミット**

```bash
git add src/lib/satei-prep.ts src/app/api/jobs/satei/prep/claim/route.ts "src/app/api/jobs/satei/prep/[tid]/result/route.ts" test/satei-prep.test.ts
git commit -m "feat: 段2dの準備を Mac が取る口と、案・失敗を返す口を足す

予約は20分・取り直しは1回。古い係の結果は PREP_STALE で断る。8日たった行は掃除で消す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task P3: 案の一覧と決定（notices・decide）・CLAUDE.md

**Files:**
- Modify: `src/lib/satei-prep.ts`（末尾に足す）
- Create: `src/app/api/jobs/satei/prep/notices/route.ts`
- Create: `src/app/api/jobs/satei/prep/[tid]/decide/route.ts`
- Modify: `CLAUDE.md`（査定の節の後ろに1節）
- Test: `test/satei-prep.test.ts`（describe を足す）

**Interfaces:**
- Consumes: P1・P2 の部品
- Produces: `listSateiPrepNotices(now?)` → `PrepNotice[]`（`{tid, no, status, lines, areaDone, failReason}`）、`decideSateiPrep(tid, input, now?)` → `{status}`

- [ ] **Step 1: 失敗するテストを足す**

import に `import * as notices from '@/app/api/jobs/satei/prep/notices/route';`・`import * as decide from '@/app/api/jobs/satei/prep/[tid]/decide/route';` を足し、末尾に：

```ts
const doNotices = async () => notices.GET(json('/api/jobs/satei/prep/notices', 'GET'));
const doDecide = (tid: string, b: unknown) => decide.POST(json(`/api/jobs/satei/prep/${tid}/decide`, 'POST', b), tidParams(tid));
const proposed = async () => {
  await post(body());
  const c = await (await doClaim()).json();
  await doResult(TID, { runId: c.runId, outcome: 'proposed', lines: ['成約：同じマンション', '売出：5件ほど'], areaDone: false });
};

describe('GET /api/jobs/satei/prep/notices・POST {tid}/decide', () => {
  it('一覧は相談中と失敗だけ（受付・作業中は出さない）', async () => {
    await post(body({ tid: TID2 }));
    await proposed();
    const b = await (await doNotices()).json();
    expect(b.preps).toEqual([{ tid: TID, no: 7, status: '相談中', lines: ['成約：同じマンション', '売出：5件ほど'], areaDone: false, failReason: '' }]);
  });

  it('off の一覧は空', async () => {
    await proposed();
    process.env.SATEI_PREP = '0';
    expect((await (await doNotices()).json()).preps).toEqual([]);
  });

  it('ok：依頼済み・最後の版・期日・最終の行。同じ ok の送り直しは同じ答え。一覧から消える', async () => {
    await proposed();
    const b = { decision: 'ok', rev: 2, lines: ['成約：直した行'], deadline: 1_800_000_000_000 };
    expect(await (await doDecide(TID, b)).json()).toEqual({ status: '依頼済み' });
    expect((await readPrep(TID))!.row).toMatchObject({ status: '依頼済み', decidedRev: 2, deadline: 1_800_000_000_000, lines: ['成約：直した行'] });
    expect(await (await doDecide(TID, b)).json()).toEqual({ status: '依頼済み' });
    expect((await (await doNotices()).json()).preps).toEqual([]);
  });

  it('manual：受付・作業中・相談中・失敗から手作業。依頼済みのあとは 409 PREP_CLOSED', async () => {
    await post(body());
    expect(await (await doDecide(TID, { decision: 'manual', rev: 0 })).json()).toEqual({ status: '手作業' });
    await post(body({ tid: TID2 }));
    const c = await (await doClaim()).json();
    await doResult(TID2, { runId: c.runId, outcome: 'proposed', lines: ['x'] });
    await doDecide(TID2, { decision: 'ok', rev: 1, lines: ['x'], deadline: 1 });
    const res = await doDecide(TID2, { decision: 'manual', rev: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PREP_CLOSED');
  });

  it('ok は相談中のときだけ（受付のままなら 409 PREP_CLOSED）。形の違う決定は 400', async () => {
    await post(body());
    expect((await doDecide(TID, { decision: 'ok', rev: 1, lines: ['x'], deadline: 1 })).status).toBe(409);
    expect((await doDecide(TID, { decision: 'yes', rev: 1 })).status).toBe(400);
    expect((await doDecide(TID, { decision: 'ok', rev: 1, lines: ['x'] })).status).toBe(400);
  });

  it('手作業のあとに Mac の結果が来ても PREP_STALE（案を上書きしない）', async () => {
    await post(body());
    const c = await (await doClaim()).json();
    await doDecide(TID, { decision: 'manual', rev: 0 });
    expect((await doResult(TID, { runId: c.runId, outcome: 'proposed', lines: ['x'] })).status).toBe(409);
    expect((await readPrep(TID))!.row.status).toBe('手作業');
  });
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx vitest run test/satei-prep.test.ts`
Expected: FAIL（notices・decide の route が無い）

- [ ] **Step 3: 一覧と決定を書く**

`src/lib/satei-prep.ts` の末尾に：

```ts
// ---------- 案の一覧（GET /api/jobs/satei/prep/notices）・決定（POST /api/jobs/satei/prep/{tid}/decide） ----------

export type PrepNotice = { tid: string; no: number; status: '相談中' | '失敗'; lines: string[]; areaDone: boolean; failReason: string };

/** aisecretary の毎分の見回りが取りに来る。相談中と失敗（8日以内）。off は [] */
export async function listSateiPrepNotices(now: number = Date.now()): Promise<PrepNotice[]> {
  if (!sateiPrepOn()) return [];
  return (await allPreps())
    .map(({ row }) => row)
    .filter((r) => (r.status === '相談中' || r.status === '失敗') && now - r.updatedAt <= PREP_KEEP_MS)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => ({ tid: r.tid, no: r.no, status: r.status as '相談中' | '失敗', lines: r.lines, areaDone: r.areaDone, failReason: r.failReason }));
}

const MANUAL_FROM: readonly PrepStatus[] = ['受付', '作業中', '相談中', '失敗'];

/** aisecretary が［いいよ］（ok）か手で頼む（manual）を記録する。同じ決定の送り直しは同じ答え。off でも受ける */
export async function decideSateiPrep(tid: string, input: Record<string, unknown>, now: number = Date.now()): Promise<{ status: PrepStatus }> {
  requireTid(tid);
  const decision = input.decision;
  if (decision !== 'ok' && decision !== 'manual') throw badPrep('decision');
  const rev = input.rev;
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0 || rev > 20) throw badPrep('rev');
  const lines = decision === 'ok' ? parseLines(input.lines) : [];
  const deadline = input.deadline;
  if (decision === 'ok' && (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= 0)) throw badPrep('deadline');
  for (let i = 0; i < 3; i++) {
    const got = await readPrep(tid);
    if (!got) throw new JobError('not_found', '準備が見つかりません');
    const { row, raw } = got;
    const want: PrepStatus = decision === 'ok' ? '依頼済み' : '手作業';
    if (row.status === want) return { status: row.status };
    const allowed = decision === 'ok' ? row.status === '相談中' : MANUAL_FROM.includes(row.status);
    if (!allowed) throw new JobError('prep_closed', '準備はもう別の決定で閉じています');
    const next: PrepRow =
      decision === 'ok'
        ? { ...row, status: '依頼済み', decidedRev: rev, lines, deadline: deadline as number, runId: '', updatedAt: now }
        : { ...row, status: '手作業', decidedRev: rev, runId: '', updatedAt: now };
    if (await swapPrep(raw, next)) return { status: next.status };
  }
  throw new JobError('write_conflict', '同時の書き込みに続けて負けました');
}
```

`src/app/api/jobs/satei/prep/notices/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { isJobApiRequest } from '@/lib/job-auth';
import { jobErrorResponse, unauthorized } from '@/lib/job-http';
import { listSateiPrepNotices } from '@/lib/satei-prep';

export const dynamic = 'force-dynamic';

// GET — aisecretary の毎分の見回りが、下村さんに出す案（相談中）と失敗を取りに来る（段2d）。{ preps: [...] }
export async function GET(request: NextRequest) {
  if (!isJobApiRequest(request)) return unauthorized();
  try {
    return NextResponse.json({ preps: await listSateiPrepNotices() });
  } catch (e) {
    return jobErrorResponse(e);
  }
}
```

`src/app/api/jobs/satei/prep/[tid]/decide/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { isJobApiRequest } from '@/lib/job-auth';
import { jobErrorResponse, readJsonObject, unauthorized } from '@/lib/job-http';
import { decideSateiPrep } from '@/lib/satei-prep';

export const dynamic = 'force-dynamic';

// POST { decision: "ok", rev, lines, deadline } | { decision: "manual", rev } — aisecretary の記録（段2d）。{ status }
export async function POST(request: NextRequest, ctx: { params: Promise<{ tid: string }> }) {
  if (!isJobApiRequest(request)) return unauthorized();
  try {
    const { tid } = await ctx.params;
    return NextResponse.json(await decideSateiPrep(tid, await readJsonObject(request)));
  } catch (e) {
    return jobErrorResponse(e);
  }
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run test/satei-prep.test.ts`
Expected: PASS（22件）

- [ ] **Step 5: CLAUDE.md に節を足す**

`CLAUDE.md` の査定（B2）の節の後ろに：

```markdown
### 査定の「準備」の依頼箱（段2d・2026-11-26）

- 事例の取り方の案づくりを、aisecretary（受付）→ Mac（予約・結果）→ aisecretary（一覧・決定）で受け渡す。計画 `apps/aisecretary/docs/superpowers/plans/2026-11-26-group-satei-2d.md`（受け渡しの約束）。
- スイッチ `SATEI_PREP`（`1` のときだけ受ける。既定 off）。off：受付 503 PREP_DISABLED・予約 204・一覧 []。決定は off でも受ける。
- 置き場は AppState の行（key `satei-prep:<tid>`）。**表・列は足していない**（db push の差分なし）。書き換えは読んだ値のままのときだけ。8日たった行は掃除で消す。
- 口：`POST /api/jobs/satei/prep`・`POST /api/jobs/satei/prep/claim`・`POST /api/jobs/satei/prep/{tid}/result`・`GET /api/jobs/satei/prep/notices`・`POST /api/jobs/satei/prep/{tid}/decide`。鍵は `x-job-token`。
- 予約は20分・取り直し1回。2回目も切れたら失敗（timeout）。受付停止（jobs.intake.stopped）中は受付も 503。
- 行に持つのは受付票の番号・受付番号・案件 ID・フォルダ・種別・所在・建物名・面積と築年月・依頼した人の userId・案の行。案件名は持たない。
```

- [ ] **Step 6: 全体を確かめる**

Run: `npx vitest run test/satei-*.test.ts && npx tsc --noEmit`
Expected: どちらも PASS／何も出ない（既存の satei のテストは変わらない）

- [ ] **Step 7: コミット**

```bash
git add src/lib/satei-prep.ts src/app/api/jobs/satei/prep/notices/route.ts "src/app/api/jobs/satei/prep/[tid]/decide/route.ts" test/satei-prep.test.ts CLAUDE.md
git commit -m "feat: 段2dの案の一覧と、［いいよ］・手で頼むの記録の口を足す

aisecretary が案を取りに来て下村さんへ出し、決めた結果（期日・最終の行）を残す。2e が依頼済みの行を使う。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

# Mac（line-secretary）

作業場所：`/Users/shimo/AI開発/apps/line-secretary/.worktrees/satei-prep`（枝 `feature/satei-prep`、元 `feature/satei-area`）。

### Task M1: スイッチ SATEI_PREP と portal の口

**Files:**
- Modify: `src/config.js`（`sateiAreaFrom` の後ろに関数、`SATEI` に展開、`module.exports` に出す）
- Modify: `src/satei/portal.js`
- Test: `test/satei-prep-config.test.js`・`test/satei-prep-portal.test.js`（新）

**Interfaces:**
- Produces: `config.sateiPrepFrom(env)` → `{ prep: boolean }`、`config.SATEI.prep`、`portal.prepClaim(opts)`・`portal.prepResult(tid, body, opts)`（戻り値は `request` と同じ `{ok, status, body, code}`）

- [ ] **Step 1: 失敗するテストを書く**

`test/satei-prep-config.test.js`：

```js
// test/satei-prep-config.test.js
// 段2d の準備（事例の取り方の案）のスイッチ。既定 off
const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config.js");

test("sateiPrepFrom：SATEI_PREP=1 のときだけ on", () => {
  assert.deepEqual(config.sateiPrepFrom({}), { prep: false });
  for (const v of ["0", "on", "true", " 1", ""]) assert.equal(config.sateiPrepFrom({ SATEI_PREP: v }).prep, false, v);
  assert.deepEqual(config.sateiPrepFrom({ SATEI_PREP: "1" }), { prep: true });
});

test("config.SATEI：テストの env（ファイル無し）では off", () => {
  assert.equal(config.SATEI.prep, false);
});
```

`test/satei-prep-portal.test.js`：

```js
// test/satei-prep-portal.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const portal = require("../src/satei/portal.js");

const CFG = { JOBS: { portalBaseUrl: "https://portal.example.test", apiToken: "a".repeat(32), portalTimeoutMs: 1000 } };
const BASE = "https://portal.example.test";
function fakeFetch(status, body, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error("no body"); return body; }, headers: { get: () => null } };
  };
}
const opts = (status, body, calls) => ({ fetchImpl: fakeFetch(status, body, calls), config: CFG });

test("prepClaim：POST /api/jobs/satei/prep/claim に {}。204 は ok で body なし", async () => {
  const calls = [];
  const r = await portal.prepClaim(opts(204, undefined, calls));
  assert.equal(calls[0].url, `${BASE}/api/jobs/satei/prep/claim`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {});
  assert.deepEqual([r.ok, r.status, r.body], [true, 204, null]);
});

test("prepResult：tid の口へ本文をそのまま。409 は code を返す", async () => {
  const calls = [];
  const body = { runId: "r", outcome: "failed", failReason: "internal" };
  const r = await portal.prepResult("0123456789abcdef", body, opts(409, { code: "PREP_STALE" }, calls));
  assert.equal(calls[0].url, `${BASE}/api/jobs/satei/prep/0123456789abcdef/result`);
  assert.deepEqual(JSON.parse(calls[0].init.body), body);
  assert.deepEqual([r.ok, r.status, r.code], [false, 409, "PREP_STALE"]);
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `LINE_SECRETARY_ENV_FILE=/nonexistent/line-secretary-test.env node --test test/satei-prep-config.test.js test/satei-prep-portal.test.js`
Expected: FAIL（`sateiPrepFrom is not a function`・`prepClaim is not a function`）

- [ ] **Step 3: 書く**

`src/config.js` の `sateiAreaFrom` の関数の後ろに：

```js
// 査定係の「準備」（段2d。aisecretary の計画 2026-11-26-group-satei-2d）。既定 off（SATEI_PREP=1 のときだけ on）。
// on のとき、見回りが依頼箱の準備（POST /api/jobs/satei/prep/claim）を1件取り、事例の取り方の案を返す。off のときは呼ばない（今の作りのまま）
function sateiPrepFrom(e) {
  return { prep: (e || {}).SATEI_PREP === "1" };
}
```

`SATEI: {` の中の `...sateiAreaFrom(env),` の次の行に `...sateiPrepFrom(env),` を足す。`module.exports.sateiAreaFrom` を出しているところ（無ければ `module.exports.sateiReady = sateiReady;` の近く）に `module.exports.sateiPrepFrom = sateiPrepFrom;` を足す（`sateiAreaFrom` の出し方と同じ形にそろえる）。

`src/satei/portal.js` の `saveAbort` の後ろに：

```js
// 段2d の準備（事例の取り方の案）。予約（204＝無い・off）と結果
function prepClaim(opts = {}) {
  return request("/api/jobs/satei/prep/claim", { method: "POST", body: {}, ...opts });
}
function prepResult(tid, body, opts = {}) {
  return request(`/api/jobs/satei/prep/${p(tid)}/result`, { method: "POST", body, ...opts });
}
```

`module.exports` に `prepClaim, prepResult` を足す。

- [ ] **Step 4: 通ることを確かめる**

Run: `LINE_SECRETARY_ENV_FILE=/nonexistent/line-secretary-test.env node --test test/satei-prep-config.test.js test/satei-prep-portal.test.js test/satei-area-config.test.js test/satei-portal.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/config.js src/satei/portal.js test/satei-prep-config.test.js test/satei-prep-portal.test.js
git commit -m "feat: 段2dの準備のスイッチ SATEI_PREP と、依頼箱の準備の口を足す

既定 off。off のあいだ見回りは準備の口を呼ばない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task M2: 事例の取り方の案（純粋関数）

**Files:**
- Create: `src/satei/proposal.js`
- Test: `test/satei-proposal.test.js`

**Interfaces:**
- Produces: `caseProposal({ kind, facts, building, school, zoning })` → `string[]`（2〜4行・1行100字まで）、`areaItem(text, label)` → `string | null`

条件の出どころ（ファイルの先頭のコメントにも書く）：
`~/AI開発/tools/claude-setup/claude/skills/realestate-satei/references/attachments.md` §2「成約事例は原則として直近2年（最大3年）以内、10〜15件」「同一町名の直近事例を優先」「マンションは同一マンション内の事例があれば優先」「面積は前後10㎡程度」「ファミリー層なら小学校の学区を優先」、`references/comparables.md`「築年 ±10年」「土地：同一用途地域」「売出事例は『あれば使う』」。設計の例（半径500m・築±5年・過去3年・10件）は例なので使わない（設計 6.1「条件の決め方は査定スキルに合わせる」）。

- [ ] **Step 1: 失敗するテストを書く**

`test/satei-proposal.test.js`：

```js
// test/satei-proposal.test.js
// 段2d：事例の取り方の案（査定スキルの事例の既定。純粋関数）
const test = require("node:test");
const assert = require("node:assert/strict");
const { caseProposal, areaItem } = require("../src/satei/proposal.js");

test("マンション：同じマンション → 同じ町名 → 同じ小学校区、専有±10㎡・築±10年・2年（最大3年）・10〜15件、売出5件", () => {
  const lines = caseProposal({ kind: "マンション", facts: { exclusiveArea: 65.3, builtYm: "2005-03" }, building: "パークハウス天満", school: "天満小学校" });
  assert.deepEqual(lines, [
    "成約：同じマンション（パークハウス天満）→ 同じ町名 → 同じ小学校区（天満小学校）",
    "　専有55.3〜75.3㎡・築1995〜2015年・過去2年（足りなければ3年）・10〜15件",
    "売出：同じ条件で、いま売り出し中のものを5件ほど（無ければ無しで）",
  ]);
});

test("戸建：土地・建物 ±10㎡・築±10年。学区が分からなければ名前を付けない", () => {
  const lines = caseProposal({ kind: "戸建", facts: { landArea: 120, buildingArea: 95.5, builtYm: "1998-07" }, building: "無視される", school: null });
  assert.equal(lines[0], "成約：同じ町名 → 同じ小学校区");
  assert.equal(lines[1], "　土地110〜130㎡・建物85.5〜105.5㎡・築1988〜2008年・過去2年（足りなければ3年）・10〜15件");
});

test("土地：地積 ±10㎡・用途地域が同じ（分かれば名前）。築年は出さない", () => {
  const lines = caseProposal({ kind: "土地", facts: { landArea: 8 }, zoning: "第一種住居地域" });
  assert.equal(lines[1], "　地積1〜18㎡・用途地域が同じ（第一種住居地域）・過去2年（足りなければ3年）・10〜15件");
});

test("面積・築年が無ければ「※…は資料で確かめられず」を足す", () => {
  const lines = caseProposal({ kind: "マンション", facts: {}, building: null });
  assert.equal(lines[0], "成約：同じマンション → 同じ町名 → 同じ小学校区");
  assert.equal(lines[1], "　過去2年（足りなければ3年）・10〜15件");
  assert.equal(lines[3], "※専有面積・築年は資料で確かめられず（幅は山口さんにお任せ）");
});

test("建物名に号室・番地の形が残っていたら使わない（グループに出るため）", () => {
  for (const b of ["パークハウス 1203号室", "天満2-3", "山田様邸"]) {
    assert.equal(caseProposal({ kind: "マンション", facts: {}, building: b })[0], "成約：同じマンション → 同じ町名 → 同じ小学校区", b);
  }
});

test("areaItem：調査結果.md の「- 項目：値（出典）」から値だけ。未確認・区域外は null", () => {
  const text = ["# 地域の調べ（G7）", "- 小学校区：天満小学校（https://example.test）", "- 用途地域：未確認", "- 洪水：区域外"].join("\n");
  assert.equal(areaItem(text, "小学校区"), "天満小学校");
  assert.equal(areaItem(text, "用途地域"), null);
  assert.equal(areaItem(text, "洪水"), null);
  assert.equal(areaItem(text, "中学校区"), null);
  assert.equal(areaItem(null, "小学校区"), null);
});
```

- [ ] **Step 2: 落ちることを確かめる**

Run: `LINE_SECRETARY_ENV_FILE=/nonexistent/line-secretary-test.env node --test test/satei-proposal.test.js`
Expected: FAIL（`Cannot find module '../src/satei/proposal.js'`）

- [ ] **Step 3: 書く**

`src/satei/proposal.js`：

```js
// src/satei/proposal.js
// 段2d：REINS の事例の取り方の案（下村さんに［いいよ］［直す］を聞き、山口さんへの依頼に使う行）。純粋関数。
// 条件は査定スキル realestate-satei の事例の既定に合わせる（設計 2026-11-25-group-satei-stage2 §6.1）：
//   references/attachments.md §2（社内ルール。優先）：成約は直近2年（最大3年）・10〜15件、同一町名優先、
//     マンションは同一マンション内優先、面積は前後10㎡程度、無ければ小学校の学区。
//   references/comparables.md：築年 ±10年、土地は同一用途地域、売出事例は「あれば使う」。
// 行はグループにも出る（建物名・学区・用途地域だけ。号室・番地・人の名前は入れない）。分からない欄は「資料で確かめられず」と書く
const LINE_MAX = 100;
const NAME_MAX = 30;
const cut = (s, n) => Array.from(String(s)).slice(0, n).join("");
// グループに出してはいけない形（aisecretary の gsSafeText と同じ考え方）
const NG_RE = /[0-9]+\s*号室|[0-9]+\s*番地|[0-9]+番[0-9]|[0-9]+-[0-9]+|[0-9]{9,}|様/u;
const UNKNOWN_RE = /^(未確認|不明|取れなかった|分からない|わからない|区域外|[-－―])/u;

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const fmt = (v) => String(Math.round(v * 10) / 10);
function range(v, unit) {
  const x = num(v);
  return x === null ? null : `${fmt(Math.max(x - 10, 1))}〜${fmt(x + 10)}${unit}`;
}
function builtYear(ym) {
  const m = /^((?:19|20)\d{2})-(0[1-9]|1[0-2])$/.exec(String(ym || ""));
  return m ? Number(m[1]) : null;
}
function safeName(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t && !NG_RE.test(t.normalize("NFKC")) ? cut(t, NAME_MAX) : null;
}

// 調査結果.md（2c の area.js が書く「- 項目：値（出典）」）から値を読む。分からない・区域外は null
function areaItem(text, label) {
  for (const line of String(typeof text === "string" ? text : "").split(/\r?\n/)) {
    const m = /^\s*[-*・]\s*([^：:]{1,20}?)\s*[：:]\s*(.*)$/.exec(line);
    if (!m || m[1].trim() !== label) continue;
    const v = m[2].replace(/\s*[（(][^（）()]*[）)]\s*$/u, "").trim();
    if (!v || UNKNOWN_RE.test(v)) return null;
    return safeName(v);
  }
  return null;
}

function caseProposal({ kind, facts, building = null, school = null, zoning = null } = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const b = kind === "マンション" ? safeName(building) : null;
  const s = safeName(school);
  const where = [
    kind === "マンション" ? `同じマンション${b ? `（${b}）` : ""}` : null,
    "同じ町名",
    `同じ小学校区${s ? `（${s}）` : ""}`,
  ].filter(Boolean).join(" → ");
  const conds = [];
  const unknown = [];
  const want = (value, text, label) => (value ? conds.push(text) : unknown.push(label));
  const y = builtYear(f.builtYm);
  const age = y ? `築${y - 10}〜${y + 10}年` : null;
  if (kind === "マンション") {
    const a = range(f.exclusiveArea, "㎡");
    want(a, `専有${a}`, "専有面積");
    want(age, age, "築年");
  } else if (kind === "戸建") {
    const l = range(f.landArea, "㎡");
    const bd = range(f.buildingArea, "㎡");
    want(l, `土地${l}`, "土地面積");
    want(bd, `建物${bd}`, "建物面積");
    want(age, age, "築年");
  } else {
    const l = range(f.landArea, "㎡");
    want(l, `地積${l}`, "土地面積");
    const z = safeName(zoning);
    conds.push(z ? `用途地域が同じ（${z}）` : "用途地域が同じ");
  }
  const lines = [
    `成約：${where}`,
    `　${[...conds, "過去2年（足りなければ3年）", "10〜15件"].join("・")}`,
    "売出：同じ条件で、いま売り出し中のものを5件ほど（無ければ無しで）",
  ];
  if (unknown.length) lines.push(`※${unknown.join("・")}は資料で確かめられず（幅は山口さんにお任せ）`);
  return lines.map((l) => cut(l, LINE_MAX));
}

module.exports = { caseProposal, areaItem };
```

- [ ] **Step 4: 通ることを確かめる**

Run: `LINE_SECRETARY_ENV_FILE=/nonexistent/line-secretary-test.env node --test test/satei-proposal.test.js`
Expected: PASS（6件）

- [ ] **Step 5: コミット**

```bash
git add src/satei/proposal.js test/satei-proposal.test.js
git commit -m "feat: 段2dの事例の取り方の案を、査定スキルの事例の既定から作る関数を足す

同一マンション→町名→小学校区、面積±10㎡・築±10年・2年（最大3年）・10〜15件。グループに出る行なので号室・番地の形は入れない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task M3: 1件の準備（prep.js）と地域の調べの見出し

**Files:**
- Modify: `src/satei/area.js`（`composeResult` と `runArea` に `label` を足す）
- Create: `src/satei/prep.js`
- Test: `test/satei-prep.test.js`（新）、`test/satei-area.test.js`（見出しのテストを1件足す）

**Interfaces:**
- Consumes: M1 の `portal.prepResult`、M2 の `caseProposal`・`areaItem`、2c の `area.runArea`・`area.driveStore`、`drive.readCaseFolder`、`lingering.guardSpawn`・`lingering.write`
- Produces: `runPrep(claimed, d)` → `{ outcome: "proposed" | "failed" | "claim-invalid" | "report-failed" | "lingering" }`

- [ ] **Step 1: 見出しのテストを足す（area.js）**

`test/satei-area.test.js` の末尾に：

```js
test("composeResult：label を渡せば見出しはその名前（準備の段は G 番号）。無ければ今までどおり J 番号", () => {
  const { composeResult } = require("../src/satei/area.js");
  const base = { no: 7, town: "大阪市北区天満二丁目", lat: 34.7, lon: 135.5, nowMs: Date.UTC(2026, 10, 26), body: "- 小学校区：天満小学校" };
  assert.match(composeResult(base), /^# 地域の調べ（J7）/);
  assert.match(composeResult({ ...base, label: "G7" }), /^# 地域の調べ（G7）/);
});
```

（`assert` と `test` はこのファイルの先頭で読み込み済み。無ければ `const test = require("node:test"); const assert = require("node:assert/strict");` を使う。）

- [ ] **Step 2: 準備のテストを書く**

`test/satei-prep.test.js`：

```js
// test/satei-prep.test.js
// 段2d：1件の準備（フォルダ → 地域の調べ（on のときだけ）→ 案 → 結果）。drive・area・portal・spawn は偽物
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runPrep } = require("../src/satei/prep.js");

const TID = "0123456789abcdef";
const RUN = "11111111-2222-4333-8444-555555555555";
const claimed = (over = {}) => ({
  tid: TID, no: 7, runId: RUN, leaseUntil: new Date(Date.now() + 20 * 60000).toISOString(), attempt: 1,
  dealId: "a".repeat(32), folderId: "folder_ABC-123", kind: "マンション", place: "大阪市北区天満2丁目3-4", building: "パークハウス天満",
  facts: { builtYm: "2005-03", exclusiveArea: 65.3, landArea: null, buildingArea: null }, ...over,
});

function mk({ area = false, areaRes = null, folderOk = true, report = { ok: true, status: 200 } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "satei-prep-"));
  const sent = [];
  const logs = [];
  const areaCalls = [];
  const d = {
    config: { SATEI: { areaResearch: area, areaTimeoutMin: 10, reinfolibKey: "", casesDir: path.join(dir, "cases"), leaseGuardMs: 30000, driveRequestTimeoutMs: 1000 }, paths: { state: path.join(dir, "state") } },
    stateDir: path.join(dir, "state"),
    now: () => Date.now(),
    log: { write: (lv, m) => logs.push(`${lv} ${m}`) },
    portal: { prepResult: async (tid, body) => { sent.push({ tid, body }); return report; } },
    drive: { readCaseFolder: async () => (folderOk ? { ok: true, bukkenId: "bukken1" } : { ok: false }) },
    lingering: { guardSpawn: () => async () => ({}), write: () => undefined },
    area: {
      driveStore: () => ({ find: async () => null, save: async () => ({ id: "x" }) }),
      runArea: async (args) => { areaCalls.push(args); return areaRes; },
    },
  };
  return { d, dir, sent, logs, areaCalls };
}

test("地域の調べ off：フォルダを確かめて案を返す（proposed・areaDone false）。地域の調べは呼ばない", async () => {
  const x = mk();
  const r = await runPrep(claimed(), x.d);
  assert.equal(r.outcome, "proposed");
  assert.equal(x.areaCalls.length, 0);
  assert.equal(x.sent[0].tid, TID);
  assert.equal(x.sent[0].body.runId, RUN);
  assert.equal(x.sent[0].body.outcome, "proposed");
  assert.equal(x.sent[0].body.areaDone, false);
  assert.equal(x.sent[0].body.lines[0], "成約：同じマンション（パークハウス天満）→ 同じ町名 → 同じ小学校区");
  assert.ok(x.logs.includes("info satei-prep #G7 proposed"));
});

test("地域の調べ on：所在だけを材料に渡し（資料は読まない）、学区を案に入れる。見出しは G7", async () => {
  const x = mk({ area: true, areaRes: { status: "done", text: "- 小学校区：天満小学校（出典）\n- 用途地域：商業地域（出典）", lines: [] } });
  const r = await runPrep(claimed(), x.d);
  assert.equal(r.outcome, "proposed");
  assert.deepEqual(x.areaCalls[0].materials, { 所在: "大阪市北区天満2丁目3-4" });
  assert.deepEqual(x.areaCalls[0].entries, []);
  assert.equal(x.areaCalls[0].label, "G7");
  assert.equal(x.areaCalls[0].kind, "マンション");
  assert.equal(x.sent[0].body.areaDone, true);
  assert.match(x.sent[0].body.lines[0], /同じ小学校区（天満小学校）$/);
});

test("地域の調べが skipped でも案は出す（学区なし・areaDone false）", async () => {
  const x = mk({ area: true, areaRes: { status: "skipped", reason: "geocode", lines: [] } });
  assert.equal((await runPrep(claimed(), x.d)).outcome, "proposed");
  assert.equal(x.sent[0].body.areaDone, false);
});

test("所在が無ければ地域の調べを呼ばない", async () => {
  const x = mk({ area: true, areaRes: { status: "done", text: "" } });
  await runPrep(claimed({ place: null }), x.d);
  assert.equal(x.areaCalls.length, 0);
});

test("フォルダが無い・ゴミ箱 → failed（folder）", async () => {
  const x = mk({ folderOk: false });
  assert.equal((await runPrep(claimed(), x.d)).outcome, "failed");
  assert.deepEqual(x.sent[0].body, { runId: RUN, outcome: "failed", failReason: "folder" });
});

test("子が残った（lingering）→ 印を書いて failed（internal）。作業場所は残す", async () => {
  const x = mk({ area: true, areaRes: { status: "failed", reason: "lingering", pgid: 123 } });
  const wrote = [];
  x.d.lingering.write = (dir, v) => wrote.push(v);
  const r = await runPrep(claimed(), x.d);
  assert.equal(r.outcome, "lingering");
  assert.equal(wrote.length, 1);
  assert.deepEqual(x.sent[0].body, { runId: RUN, outcome: "failed", failReason: "internal" });
  assert.ok(fs.existsSync(path.join(x.d.config.SATEI.casesDir, `P${TID}`, RUN)));
});

test("予約の形が違えば何も送らない（claim-invalid）", async () => {
  for (const over of [{ tid: "x" }, { runId: "x" }, { kind: "ビル" }, { no: "7" }]) {
    const x = mk();
    assert.equal((await runPrep(claimed(over), x.d)).outcome, "claim-invalid", JSON.stringify(over));
    assert.equal(x.sent.length, 0);
  }
});

test("結果を送れなければ report-failed（期限が切れれば portal が取り直させる）。作業場所は消す", async () => {
  const x = mk({ report: { ok: false, status: 0, code: "NETWORK" } });
  assert.equal((await runPrep(claimed(), x.d)).outcome, "report-failed");
  assert.ok(x.logs.some((l) => l === "warn satei-prep #G7 proposed report-NETWORK"));
  assert.equal(fs.existsSync(path.join(x.d.config.SATEI.casesDir, `P${TID}`, RUN)), false);
});
```

- [ ] **Step 3: 落ちることを確かめる**

Run: `LINE_SECRETARY_ENV_FILE=/nonexistent/line-secretary-test.env node --test test/satei-prep.test.js test/satei-area.test.js`
Expected: FAIL（`prep.js` が無い・見出しが J7 のまま）

- [ ] **Step 4: area.js に label を足す**

`src/satei/area.js` の `composeResult` を：

```js
function composeResult({ no, label = null, town, lat, lon, nowMs, body }) {
  return [
    `# 地域の調べ（${label || `J${no}`}）`,
```

（2行目以降はそのまま。）`runArea` の引数の分割代入に `label = null,` を足し（`no,` の後ろ）、`runArea` の中で `composeResult({` を呼んでいるところに `label,` を足す。ほかは変えない（job.js は label を渡さないので見出しは今のまま）。

- [ ] **Step 5: prep.js を書く**

`src/satei/prep.js`：

```js
// src/satei/prep.js
// 段2d：依頼箱の「準備」1件（aisecretary の計画 2026-11-26-group-satei-2d・受け渡しの約束）。
// フォルダの確認 → 地域の調べ（SATEI_AREA_RESEARCH=1 かつ所在があるときだけ。2c の runArea を所在だけで呼ぶ。資料は読まない）
// → 事例の取り方の案（proposal.js）→ 結果（POST /api/jobs/satei/prep/{tid}/result）。
// 地域の調べの結果は案件フォルダの 01_物件資料/地域調査/調査結果.md に残り、あとの下書きで同じ町丁目なら使い回される（2c）。
// 延長（heartbeat）はしない（予約は20分。地域の調べは10分まで）。結果を送れなければ、期限切れで portal が1回だけ取り直させる。
// 作業場所 cases/satei/P<tid>/<runId>/ は終わりに消す（子が残ったときだけ残す。Ruling lingering と同じ）。
// ログは `satei-prep #G7 proposed` の形（受付番号・符号だけ。所在・建物名は出さない）
const fs = require("fs");
const path = require("path");
const defaultConfig = require("../config.js");
const { caseProposal, areaItem } = require("./proposal.js");

const TID_RE = /^[0-9a-f]{16}$/;
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ["マンション", "戸建", "土地"];

async function runPrep(claimed, d) {
  const cfg = d.config || defaultConfig;
  const S = cfg.SATEI;
  const log = (level, msg) => { try { d.log.write(level, msg); } catch { /* 記録できないことは記録できない */ } };
  const c = claimed || {};
  if (!TID_RE.test(c.tid || "") || !RUN_ID_RE.test(c.runId || "") || !Number.isInteger(c.no) || !KINDS.includes(c.kind) || typeof c.folderId !== "string") {
    log("error", "satei-prep claim-invalid");
    return { outcome: "claim-invalid" };
  }
  const tag = `#G${c.no}`;
  const stateDir = d.stateDir || cfg.paths.state;
  const runDir = path.join(d.casesDir || S.casesDir, `P${c.tid}`, c.runId);
  const leaseUntil = Date.parse(c.leaseUntil);
  const ctl = new AbortController();
  // 予約の30秒前で自分で止める（job.js と同じ考え方）
  const stopAt = Number.isFinite(leaseUntil) ? leaseUntil - (S.leaseGuardMs || 30000) : d.now() + 10 * 60000;
  const timer = setTimeout(() => ctl.abort(), Math.max(1000, stopAt - d.now()));
  if (typeof timer.unref === "function") timer.unref();
  const dopt = () => ({ signal: ctl.signal, timeoutMs: Math.max(1, Math.min(S.driveRequestTimeoutMs || 120000, stopAt - d.now())) });
  let lingering = false;

  const send = async (body) => {
    const r = await d.portal.prepResult(c.tid, { runId: c.runId, ...body }, { config: cfg });
    log(r && r.ok ? "info" : "warn", `satei-prep ${tag} ${body.outcome}${r && r.ok ? "" : ` report-${(r && r.code) || "unknown"}`}`);
    return r && r.ok;
  };
  const fail = async (failReason) => ((await send({ outcome: "failed", failReason })) ? { outcome: "failed" } : { outcome: "report-failed" });

  try {
    fs.mkdirSync(runDir, { recursive: true });
    let folder;
    try {
      folder = await d.drive.readCaseFolder(c.folderId, dopt());
    } catch {
      log("warn", `satei-prep ${tag} drive-error read`);
      return await fail("internal");
    }
    if (!folder || !folder.ok) return await fail("folder");

    let areaText = null;
    let areaDone = false;
    if (S.areaResearch === true && typeof c.place === "string" && c.place.trim()) {
      const areaMod = d.area || require("./area.js");
      const lmod = d.lingering || require("./lingering.js");
      const spawn = lmod.guardSpawn({
        stateDir, no: c.no, now: d.now, spawn: d.spawn || require("../review/runner.js").defaultSpawn, mod: lmod, sweepDir: runDir,
      });
      let res;
      try {
        res = await areaMod.runArea({
          runDir, no: c.no, label: `G${c.no}`, materials: { 所在: c.place }, kind: c.kind, entries: [],
          timeoutMs: (S.areaTimeoutMin || 10) * 60000, signal: ctl.signal, spawn,
          fetchImpl: d.fetchImpl || fetch, key: S.reinfolibKey || "", now: d.now, log: (level, msg) => log(level, `${msg} ${tag}`),
          store: areaMod.driveStore({ drive: d.drive, folder, dopt, dir: path.join(runDir, "tmp") }),
        });
      } catch {
        log("warn", `satei-prep ${tag} area error`);
        res = null;
      }
      if (res && res.status === "failed" && res.reason === "lingering") {
        lingering = true;
        try {
          lmod.write(stateDir, { phase: "lingering", pgid: Number.isInteger(res.pgid) ? res.pgid : null, no: c.no, at: new Date(d.now()).toISOString() });
        } catch {
          log("error", `satei lingering-write-failed ${tag}`);
        }
        log("error", `satei lingering ${tag}`);
        await fail("internal");
        return { outcome: "lingering" };
      }
      if (res && res.status === "done") {
        areaText = res.text;
        areaDone = true;
      } else {
        log("info", `satei-prep ${tag} area ${(res && res.reason) || "invalid"}`);
      }
    }

    const lines = caseProposal({
      kind: c.kind, facts: c.facts, building: c.building,
      school: areaItem(areaText, "小学校区"), zoning: areaItem(areaText, "用途地域"),
    });
    return (await send({ outcome: "proposed", lines, areaDone })) ? { outcome: "proposed" } : { outcome: "report-failed" };
  } catch {
    log("warn", `satei-prep ${tag} unexpected`);
    try {
      return await fail("internal");
    } catch {
      return { outcome: "report-failed" };
    }
  } finally {
    clearTimeout(timer);
    if (!lingering) {
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {
        log("warn", `satei-prep ${tag} cleanup-failed`);
      }
    }
  }
}

module.exports = { runPrep };
```

- [ ] **Step 6: 通ることを確かめる**

Run: `LINE_SECRETARY_ENV_FILE=/nonexistent/line-secretary-test.env node --test test/satei-prep.test.js test/satei-area.test.js test/satei-area-wiring.test.js`
Expected: PASS（area の既存のテストも通る）

- [ ] **Step 7: コミット**

```bash
git add src/satei/area.js src/satei/prep.js test/satei-prep.test.js test/satei-area.test.js
git commit -m "feat: 段2dの準備1件（フォルダ確認・地域の調べ・案・結果）を足す

地域の調べは所在だけで 2c の runArea を呼ぶ（資料は読まない）。調査結果の見出しは受付番号（G7）にできるようにした。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task M4: 見回りに準備を足す（on のときだけ）・運用の文書

**Files:**
- Modify: `src/satei/tick.js`（`MODULES` に `prep`、④ の claim の前に準備）
- Modify: `docs/運用.md`（査定係の節に1節）
- Test: `test/satei-prep-tick.test.js`（新）

**Interfaces:**
- Consumes: M1 の `portal.prepClaim`・`config.SATEI.prep`、M3 の `prep.runPrep`
- Produces: `run()` の戻り値に `prep`（`"idle" | "claim-failed" | "proposed" | …`）。準備をした回は下書きの claim をしない（1回に重い仕事は1件）。

- [ ] **Step 1: 失敗するテストを書く**

既存の `test/satei-tick*.test.js`（無ければ `test/satei-job.test.js` の tick の偽物の作り方）に合わせて、`test/satei-prep-tick.test.js`：

```js
// test/satei-prep-tick.test.js
// 段2d：見回り（tick.js）の準備。SATEI_PREP off なら準備の口を1回も呼ばない（今の作りのまま）
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { run } = require("../src/satei/tick.js");

function mk({ prep = false, prepClaim = { ok: true, status: 204, body: null } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "satei-prep-tick-"));
  const calls = [];
  const cfg = {
    SATEI: {
      enabled: true, prep, deliveryFolderId: "f".repeat(20), aisecretaryBaseUrl: "https://a.example.test", refreshToken: "r",
      claudeVersion: "2.1.3", sofficeVersion: "26.2.4.2", obiGate: "2026-11-12", lockTtlMin: 90, casesDir: path.join(dir, "cases"),
    },
    JOBS: { portalBaseUrl: "https://p.example.test", apiToken: "a".repeat(32) },
    paths: { state: path.join(dir, "state") },
  };
  const d = {
    config: cfg,
    stateDir: path.join(dir, "state"),
    log: { write: () => undefined },
    acquireLock: () => true,
    proc: { on: () => undefined, removeListener: () => undefined, exit: () => undefined },
    lingering: { check: () => "none" },
    runstate: { resendPending: async () => "none", readRun: () => null },
    save: { processSaves: async () => ({}) },
    notify: { processNotices: async () => ({}) },
    portal: {
      prepClaim: async () => { calls.push("prepClaim"); return prepClaim; },
      claim: async () => { calls.push("claim"); return { ok: true, status: 204, body: null }; },
    },
    prep: { runPrep: async () => { calls.push("runPrep"); return { outcome: "proposed" }; } },
    job: { runClaimed: async () => ({ outcome: "made" }) },
    drive: {}, materials: {}, make: {}, check: {},
  };
  return { d, calls };
}

test("SATEI_PREP off：準備の口を呼ばない（下書きの claim だけ）", async () => {
  const x = mk();
  const out = await run(x.d);
  assert.deepEqual(x.calls, ["claim"]);
  assert.equal(out.prep, undefined);
});

test("on・準備が無い（204）：そのまま下書きの claim へ", async () => {
  const x = mk({ prep: true });
  const out = await run(x.d);
  assert.deepEqual(x.calls, ["prepClaim", "claim"]);
  assert.equal(out.prep, "idle");
});

test("on・準備を取れた：runPrep をして、この回は下書きの claim をしない", async () => {
  const x = mk({ prep: true, prepClaim: { ok: true, status: 200, body: { tid: "0123456789abcdef" } } });
  const out = await run(x.d);
  assert.deepEqual(x.calls, ["prepClaim", "runPrep"]);
  assert.equal(out.prep, "proposed");
  assert.equal(out.made, "prep");
});

test("on・準備の口が失敗：ログだけで下書きの claim へ進む", async () => {
  const x = mk({ prep: true, prepClaim: { ok: false, status: 0, code: "NETWORK" } });
  const out = await run(x.d);
  assert.deepEqual(x.calls, ["prepClaim", "claim"]);
  assert.equal(out.prep, "claim-failed");
});
```

（偽物の `lingering.check` の戻り値・`sateiReady` に要る欄は、既存の tick のテストの作りに合わせて直す。`sateiReady` が `ready: true` になる欄をそろえること。）

- [ ] **Step 2: 落ちることを確かめる**

Run: `LINE_SECRETARY_ENV_FILE=/nonexistent/line-secretary-test.env node --test test/satei-prep-tick.test.js`
Expected: FAIL（on でも `prepClaim` が呼ばれない）

- [ ] **Step 3: tick.js に足す**

`MODULES` に `prep: () => require("./prep.js"),` を足す。

`run()` の中、`if (out.pending === "kept" || out.pending === "working") { … return out; }` の後ろ、`try { const cr = await d.portal.claim(…` の前に：

```js
    // 段2d の準備（SATEI_PREP=1 のときだけ。off のときは口を呼ばない＝今の作りのまま）。
    // 取れたらその1件だけをして、この回は下書きの claim をしない（1回に重い仕事は1件）。口の失敗はログだけで下書きへ進む
    if (cfg.SATEI.prep === true) {
      try {
        const pr = await d.portal.prepClaim({ config: cfg });
        if (pr.ok && pr.status === 204) {
          out.prep = "idle";
        } else if (!pr.ok) {
          log("warn", `satei-tick prep-claim-failed ${pr.code}`);
          out.prep = "claim-failed";
        } else {
          inJob = true;
          try {
            out.prep = (await d.prep.runPrep(pr.body, d)).outcome;
          } finally {
            inJob = false;
          }
          out.made = "prep";
          return out;
        }
      } catch {
        log("error", "satei-tick prep-crashed");
        out.prep = "crashed";
      }
    }
```

`const out = { pending: null, saves: null, notices: null, swept: null, made: null };` はそのまま（`prep` は on のときだけ付く＝off の戻り値は今と同じ）。

- [ ] **Step 4: 通ることを確かめる**

Run: `LINE_SECRETARY_ENV_FILE=/nonexistent/line-secretary-test.env node --test test/satei-prep-tick.test.js && npm test`
Expected: PASS（全部）

- [ ] **Step 5: 運用の文書を足す**

`docs/運用.md` の査定係の節に：

```markdown
### 準備（段2d・事例の取り方の案）

- スイッチ `SATEI_PREP=1`（Mac の env。既定 off）。portal の `SATEI_PREP` を先に入れてから入れる（止めるのは逆）。
- 見回り（120秒おき）が、下書きの claim の前に portal の `POST /api/jobs/satei/prep/claim` を1回呼ぶ。取れたらその1件だけ：フォルダの確認 → 地域の調べ（`SATEI_AREA_RESEARCH=1` かつ所在があるときだけ）→ 案の行 → `result`。その回は下書きを取らない。
- 作業場所は `cases/satei/P<tid>/<runId>/`（終わりに消す。子が残ったときだけ残る）。ログは `satei-prep #G7 proposed`・`satei-tick prep-claim-failed <code>`。
- 結果を送れなかった（`report-…`）ときは、20分の期限が切れたあと portal が1回だけ取り直させる。2回目も切れたら portal が失敗にし、aisecretary が下村さんに「案を作れませんでした」と知らせる。
```

- [ ] **Step 6: コミット**

```bash
git add src/satei/tick.js test/satei-prep-tick.test.js docs/運用.md
git commit -m "feat: 査定係の見回りに段2dの準備を足す（SATEI_PREP=1 のときだけ）

準備を取れた回はその1件だけをして、下書きの claim はしない。off のときは口を呼ばない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

# aisecretary

作業場所：`/Users/shimo/AI開発/apps/aisecretary/.worktrees/group-satei-stage2`（枝 `feat/group-satei-stage2`）。

### Task A1: 受付票の新しい状態・鍵・山口さんの ID・［いいよ］［直す］の data

**Files:**
- Modify: `src/lib/group-satei-data.ts`
- Test: `tests/group-satei-prep-data.test.ts`（新）、`package.json`

**Interfaces:**
- Produces:
  - `GsState` に `"gathering" | "proposing" | "waiting-cases"`。
  - `type GsPrepKind = "マンション" | "戸建" | "土地"`、`interface GsPrep { kind; rev; lines; fixes; sentRev; tries; groupPushes; deadline?; requestedAt?; reminded?; lateNotified? }`、`GsTicket.prep?: GsPrep`・`GsTicket.prepAt?: number`。
  - `gsCaseStaffId(env)` → `string | null`、`groupSateiPrepOn(env)` → `boolean`。
  - 定数 `GS_FIX_MAX = 2`・`GS_PROPOSE_TRIES = 2`・`GS_GROUP_PUSH_MAX = 2`・`GS_LATE_MS`・`GS_FIX_TTL`・`GS_CASES_TTL`・`GS_STAGE2_SET`。鍵 `gsWaitKey(groupId)`・`gsCasesKey(tid)`・`gsOkKey(tid)`・`gsRemindKey(tid)`・`gsFixKey(userId)`。
  - `GsAction` に `{ op: "gy" | "gf"; tid; ver; rev }`、`encodeGsYes(tid, ver, rev)`・`encodeGsFix(tid, ver, rev)`。

- [ ] **Step 1: 失敗するテストを書く**

`tests/group-satei-prep-data.test.ts`：

```ts
/** 段2d：受付票の新しい状態・山口さんの ID・［いいよ］［直す］の data（group-satei-data.ts。純粋） */
import assert from "node:assert/strict";
import {
  asTicket, encodeGsFix, encodeGsYes, groupSateiPrepOn, gsCaseStaffId, parseGsData, ticketIdOf, type GsTicket,
} from "../src/lib/group-satei-data";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const STAFF = "U" + "d".repeat(32);
const ON = { GROUP_SATEI: "1", GROUP_SATEI_STAGE2: "1", GROUP_SATEI_CASE_STAFF_ID: STAFF };
const tid = ticketIdOf("m1");
const base: GsTicket = { no: 7, ver: 1, groupId: "C" + "a".repeat(32), requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], read: null, state: "asking" };

t("山口さんの ID：U＋32桁の16進だけ。前後の空白は落とす", () => {
  assert.equal(gsCaseStaffId({ GROUP_SATEI_CASE_STAFF_ID: ` ${STAFF} ` }), STAFF);
  for (const v of [undefined, "", "U123", "u" + "d".repeat(32), STAFF + "x"]) assert.equal(gsCaseStaffId({ GROUP_SATEI_CASE_STAFF_ID: v }), null, String(v));
});
t("2d が動くのは STAGE2 と山口さんの ID がそろったときだけ", () => {
  assert.equal(groupSateiPrepOn(ON), true);
  assert.equal(groupSateiPrepOn({ ...ON, GROUP_SATEI_STAGE2: "0" }), false);
  assert.equal(groupSateiPrepOn({ ...ON, GROUP_SATEI: "0" }), false);
  assert.equal(groupSateiPrepOn({ ...ON, GROUP_SATEI_CASE_STAFF_ID: "" }), false);
});
t("data：gy・gf は版（rev 1〜9）つき", () => {
  assert.equal(encodeGsYes(tid, 2, 1), `v1|gy|${tid}|2|1`);
  assert.equal(encodeGsFix(tid, 2, 3), `v1|gf|${tid}|2|3`);
  assert.deepEqual(parseGsData(encodeGsYes(tid, 2, 1)), { op: "gy", tid, ver: 2, rev: 1 });
  assert.deepEqual(parseGsData(encodeGsFix(tid, 2, 3)), { op: "gf", tid, ver: 2, rev: 3 });
  for (const bad of [`v1|gy|${tid}|2`, `v1|gy|${tid}|2|0`, `v1|gy|${tid}|2|10`, `v1|gf|${tid}|2|x`, `v1|gy|${tid}|2|1|x`]) assert.equal(parseGsData(bad), null, bad);
});
t("受付票：新しい3つの状態を読む。prep の形が違えば読まない", () => {
  for (const state of ["gathering", "proposing", "waiting-cases"] as const) assert.equal(asTicket({ ...base, state })?.state, state);
  const prep = { kind: "マンション", rev: 1, lines: ["成約：…"], fixes: 0, sentRev: 1, tries: 1, groupPushes: 0 };
  assert.deepEqual(asTicket({ ...base, state: "proposing", prep })?.prep, prep);
  assert.equal(asTicket({ ...base, state: "proposing", prep: { ...prep, lines: [1] } }), null);
  assert.equal(asTicket({ ...base, state: "proposing", prep: { ...prep, kind: "ビル" } }), null);
  assert.equal(asTicket({ ...base, state: "waiting" }), null);
});
console.log(`${n} passed`);
```

`package.json` の `test` の最後に ` && tsx tests/group-satei-prep-data.test.ts` を足す。

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx tsx tests/group-satei-prep-data.test.ts`
Expected: FAIL（`gsCaseStaffId` が無い）

- [ ] **Step 3: 書く**

`src/lib/group-satei-data.ts`：

`groupSateiStage2On` の後ろに：

```ts
/** 段2d：山口さん（事例を取る係）の LINE userId（env GROUP_SATEI_CASE_STAFF_ID。1人）。形が違えば null（＝2d は動かない） */
const LINE_USER_RE = /^U[0-9a-f]{32}$/;
export function gsCaseStaffId(env: GsEnv = process.env): string | null {
  const v = (env.GROUP_SATEI_CASE_STAFF_ID ?? "").trim();
  return LINE_USER_RE.test(v) ? v : null;
}
/** 段2d が動くか（計画 2026-11-26-group-satei-2d の D6）。off なら 2a のまま */
export const groupSateiPrepOn = (env: GsEnv = process.env) => groupSateiStage2On(env) && gsCaseStaffId(env) !== null;

/** 段2d の決まり（設計 6・10・14、計画 D8〜D16） */
export const GS_FIX_MAX = 2;
export const GS_PROPOSE_TRIES = 2;
export const GS_GROUP_PUSH_MAX = 2;
export const GS_LATE_MS = 30 * 60 * 1000;
export const GS_FIX_TTL = 30 * 60;
export const GS_CASES_TTL = 14 * 24 * 60 * 60;
/** 見回りが見る受付票（gathering・proposing・waiting-cases） */
export const GS_STAGE2_SET = "gsatei:s2";
/** そのグループで事例を待っている受付票 */
export const gsWaitKey = (groupId: string) => `gsatei:wait:${groupId}`;
/** 受付票ごとの、依頼のあとに貼られた PDF の messageId（リマインドを出すかの判定だけに使う。取り出しは 2e） */
export const gsCasesKey = (tid: string) => `gsatei:cases:${tid}`;
/** ［いいよ］は受付票ごとに最初の1回だけ */
export const gsOkKey = (tid: string) => `gsatei:ok:${tid}`;
/** リマインドは受付票ごとに1回だけ */
export const gsRemindKey = (tid: string) => `gsatei:rem:${tid}`;
/** ［直す］のあとの次の1通（30分） */
export const gsFixKey = (userId: string) => `gsatei:fix:${userId}`;

export type GsPrepKind = "マンション" | "戸建" | "土地";
export const GS_PREP_KINDS: readonly GsPrepKind[] = ["マンション", "戸建", "土地"];
export interface GsPrep {
  kind: GsPrepKind;
  /** 今の案の版（1＝Mac の最初の案。［直す］で +1。0＝まだ届いていない） */
  rev: number;
  lines: string[];
  /** ［直す］で作り直した回数（GS_FIX_MAX まで） */
  fixes: number;
  /** 下村さんへ送れた版 */
  sentRev: number;
  /** 最初の案の push を試した回数（GS_PROPOSE_TRIES まで） */
  tries: number;
  /** グループへの push の数（依頼・リマインド。GS_GROUP_PUSH_MAX まで） */
  groupPushes: number;
  /** 事例の期日（ミリ秒。［いいよ］で決める） */
  deadline?: number;
  /** グループに依頼した時刻（これより後の PDF だけを事例の控えに数える） */
  requestedAt?: number;
  reminded?: boolean;
  /** 30分の遅れの知らせを出した */
  lateNotified?: boolean;
}
```

`GsState` と `STATES` を：

```ts
export type GsState = "asking" | "started" | "manual" | "dismissed" | "gathering" | "proposing" | "waiting-cases";
```

```ts
const STATES: readonly GsState[] = ["asking", "started", "manual", "dismissed", "gathering", "proposing", "waiting-cases"];
```

`GsTicket` の最後（`requestKind?: GsReqKind;` の後ろ）に：

```ts
  /** 段2d：portal の準備を頼んだ時刻（ミリ秒。遅れの知らせに使う） */
  prepAt?: number;
  /** 段2d：事例の取り方の案と、グループへの依頼の控え */
  prep?: GsPrep;
```

`asTicket` の `if (r.requestKind !== undefined …` の後ろに：

```ts
  if (r.prep !== undefined && !isGsPrep(r.prep)) return null;
```

`asTicket` の前に：

```ts
const isCount = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 99;
function isGsPrep(v: unknown): v is GsPrep {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    GS_PREP_KINDS.includes(p.kind as GsPrepKind) &&
    isCount(p.rev) && isCount(p.fixes) && isCount(p.sentRev) && isCount(p.tries) && isCount(p.groupPushes) &&
    Array.isArray(p.lines) && p.lines.every((s) => typeof s === "string") &&
    (p.deadline === undefined || typeof p.deadline === "number") &&
    (p.requestedAt === undefined || typeof p.requestedAt === "number")
  );
}
```

`GsAction` に足す：

```ts
  | { op: "gy"; tid: string; ver: number; rev: number }
  | { op: "gf"; tid: string; ver: number; rev: number };
```

（`| { op: "gk"; … }` の行末の `;` を外して続ける。）`encodeGsNone` の後ろに：

```ts
/** 段2d：事例の取り方の案の［いいよ］［直す］（rev＝案の版） */
export const encodeGsYes = (tid: string, ver: number, rev: number) => `v1|gy|${tid}|${ver}|${rev}`;
export const encodeGsFix = (tid: string, ver: number, rev: number) => `v1|gf|${tid}|${ver}|${rev}`;
const REV_RE = /^[1-9]$/;
```

`parseGsData` の `if (p[1] === "gk") { … }` の後ろに：

```ts
  if (p[1] === "gy" || p[1] === "gf") {
    return p.length === 5 && REV_RE.test(p[4]) ? { op: p[1], tid, ver, rev: Number(p[4]) } : null;
  }
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx tsx tests/group-satei-prep-data.test.ts && npx tsx tests/group-satei-data.test.ts && npx tsc --noEmit -p .`
Expected: PASS・`tsc` は何も出さない（`decide()` の型で `gy`／`gf` が漏れていれば、ここで型の誤りが出る。出たら A5 で振り分けるまで `decide()` の先頭に `if (a.op === "gy" || a.op === "gf") return { text: MSG_GS_PAUSED, code: "paused", settled: true };` を置いておく）

- [ ] **Step 5: コミット**

```bash
git add src/lib/group-satei-data.ts tests/group-satei-prep-data.test.ts package.json src/lib/group-satei-actions.ts
git commit -m "feat: 段2dの受付票の状態（案づくり・相談・事例待ち）と、山口さんの ID・［いいよ］［直す］の data を足す

2d が動くのは GROUP_SATEI_STAGE2=1 で GROUP_SATEI_CASE_STAFF_ID がそろったときだけ。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A2: 文・カード・検査（純粋）

**Files:**
- Create: `src/lib/group-satei-case.ts`
- Test: `tests/group-satei-case.test.ts`（新）、`package.json`

**Interfaces:**
- Consumes: A1 の `encodeGsYes`・`encodeGsFix`・`receiptOf`・`GsRead`・`GsPrepKind`、`gsDeadlineLabel`、`task-card.ts` の `FlexMessage`・`ALT_TEXT_MAX`・`FLEX_LABEL_MAX`・`POSTBACK_TEXT_MAX`・`pressedText`、`group-satei-read.ts` の `GsCreateReq`・`GS_READ_MODEL`
- Produces:
  - `gsSafeText(s: string): boolean`、`gsCleanLines(v: unknown): string[] | null`
  - `gsTownOf(address: string | null): string | null`、`gsBuildingOf(read: GsRead | null): string | null`、`gsPublicPlace(read: GsRead | null, kind: GsPrepKind): string | null`
  - `gsProposalCard(o: { tid: string; ver: number; no: number; rev: number; place: string | null; lines: string[]; previewDeadline: number }): FlexMessage`
  - `gsCaseRequestMessages(o: { staffId: string; no: number; place: string | null; lines: string[]; deadline: number }): unknown[] | null`（検査に通らなければ null）、`gsCaseRequestPlain(o)`（同じ中身の文字だけ。手で頼むとき用）
  - `gsReminderMessages(staffId: string, no: number): unknown[]`
  - `gsFixRequest(lines: string[], text: string, kind: GsPrepKind): GsCreateReq`、`gsParseFix(out: { content: Array<{ type: string; text?: string }> }): string[] | null`
  - 文：`msgGsPrepStarted`・`msgGsPrepUnknown`・`msgGsPrepRejected`・`msgGsPrepStopped`・`msgGsPrepFailed`・`msgGsPrepLate`・`msgGsCaseRequested`・`msgGsCaseSendFailed`・`msgGsFixAsk`・`msgGsFixLimit`・`msgGsFixDone`・`msgGsFixFailed`・`msgGsRemindMe`・`msgGsAlreadyRequested`・`MSG_GS_PROPOSAL_STALE`

- [ ] **Step 1: 失敗するテストを書く**

`tests/group-satei-case.test.ts`：

```ts
/** 段2d：文・カード・検査（group-satei-case.ts。純粋） */
import assert from "node:assert/strict";
import {
  gsBuildingOf, gsCaseRequestMessages, gsCleanLines, gsFixRequest, gsParseFix, gsProposalCard, gsPublicPlace, gsReminderMessages,
  gsSafeText, gsTownOf, msgGsCaseRequested,
} from "../src/lib/group-satei-case";
import { ticketIdOf, type GsRead } from "../src/lib/group-satei-data";
import { cardActions } from "../src/lib/task-card";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const STAFF = "U" + "d".repeat(32);
const tid = ticketIdOf("m1");
const read = (o: Partial<GsRead> = {}): GsRead => ({ address: "大阪市北区天満2丁目3-4", propertyName: "パークハウス天満 1203号室", kind: "マンション", basis: "本文", confidence: 0.9, ...o });
const LINES = ["成約：同じマンション（パークハウス天満）→ 同じ町名 → 同じ小学校区", "　専有55.3〜75.3㎡・築1995〜2015年・過去2年（足りなければ3年）・10〜15件", "売出：同じ条件で、いま売り出し中のものを5件ほど（無ければ無しで）"];
const D = Date.UTC(2026, 10, 26, 9); // JST 11/26（木）18:00

t("検査：号室・番地・番＋数字・数字-数字・9桁以上・様は通さない。ふつうの条件の行は通す", () => {
  for (const s of LINES) assert.equal(gsSafeText(s), true, s);
  for (const s of ["1203号室", "3番地", "3番4", "2-3-4", "１２３４５６７８９０", "山田様", "100013456789"]) assert.equal(gsSafeText(s), false, s);
});
t("行の整え：空白の行を捨て、6行・80字まで。1つでも検査に通らなければ null", () => {
  assert.deepEqual(gsCleanLines([" a ", "", "b"]), ["a", "b"]);
  assert.equal(gsCleanLines([]), null);
  assert.equal(gsCleanLines(["a", 1]), null);
  assert.equal(gsCleanLines(["1203号室を見る"]), null);
  assert.equal(gsCleanLines(new Array(7).fill("a"))!.length, 6);
  assert.equal(Array.from(gsCleanLines(["あ".repeat(90)])![0]).length, 80);
});
t("町名：丁目まで。丁目が無ければ最初の数字の前まで", () => {
  assert.equal(gsTownOf("大阪市北区天満2丁目3-4"), "大阪市北区天満2丁目");
  assert.equal(gsTownOf("大阪市北区天満二丁目3番4号"), "大阪市北区天満二丁目");
  assert.equal(gsTownOf("豊中市新千里東町１－２－３"), "豊中市新千里東町");
  assert.equal(gsTownOf("西宮市甲子園町123番4"), "西宮市甲子園町");
  assert.equal(gsTownOf(null), null);
  assert.equal(gsTownOf("123"), null);
});
t("建物名：号室を落とす（facts.roomNo と末尾の数字＋号室）", () => {
  assert.equal(gsBuildingOf(read()), "パークハウス天満");
  assert.equal(gsBuildingOf(read({ propertyName: "ザ・タワー大阪 3005", facts: { roomNo: "3005", exclusiveArea: null, landArea: null, buildingArea: null, builtYm: null, layout: null, floor: null, totalUnits: null, structure: null } })), "ザ・タワー大阪");
  assert.equal(gsBuildingOf(read({ propertyName: null })), null);
});
t("物件の言い方：マンションは町名・建物名、戸建・土地は町名だけ", () => {
  assert.equal(gsPublicPlace(read(), "マンション"), "大阪市北区天満2丁目・パークハウス天満");
  assert.equal(gsPublicPlace(read(), "戸建"), "大阪市北区天満2丁目");
  assert.equal(gsPublicPlace(read({ address: null, propertyName: null }), "土地"), null);
});
t("相談のカード：［いいよ］［直す］の data に版、押した表示は【受付 G7】", () => {
  const card = gsProposalCard({ tid, ver: 1, no: 7, rev: 2, place: "大阪市北区天満2丁目・パークハウス天満", lines: LINES, previewDeadline: D });
  const acts = cardActions(card);
  assert.deepEqual(acts.map((a) => a.data), [`v1|gy|${tid}|1|2`, `v1|gf|${tid}|1|2`]);
  const json = JSON.stringify(card);
  assert.ok(json.includes("山口さんに頼んでいいですか"));
  assert.ok(json.includes("11/26（木）18時"));
  assert.ok(json.includes("【受付 G7】"));
});
t("グループの依頼：textV2 のメンション＋ボタンなしのカード。名前・号室・番地は入らない", () => {
  const m = gsCaseRequestMessages({ staffId: STAFF, no: 7, place: "大阪市北区天満2丁目・パークハウス天満", lines: LINES, deadline: D })!;
  assert.equal(m.length, 2);
  const v2 = m[0] as { type: string; text: string; substitution: Record<string, { type: string; mentionee: { type: string; userId: string } }> };
  assert.equal(v2.type, "textV2");
  assert.ok(v2.text.startsWith("{staff} "));
  assert.deepEqual(v2.substitution.staff, { type: "mention", mentionee: { type: "user", userId: STAFF } });
  const json = JSON.stringify(m[1]);
  assert.equal(json.includes("\"button\""), false);
  assert.ok(json.includes("期日：11/26（木）18時"));
  assert.ok(json.includes("このトークに PDF を貼ってください"));
  assert.equal(gsCaseRequestMessages({ staffId: STAFF, no: 7, place: "天満2-3", lines: LINES, deadline: D }), null);
});
t("リマインド：textV2 1つ「受付 G7 の事例はいかがでしょうか」", () => {
  const m = gsReminderMessages(STAFF, 7) as Array<{ type: string; text: string }>;
  assert.equal(m.length, 1);
  assert.equal(m[0].text, "{staff} 受付 G7 の事例はいかがでしょうか");
});
t("作り直しの指示：今の行と直しの文を渡し、答えは JSON の lines。検査に通らない答えは null", () => {
  const req = gsFixRequest(LINES, "築年は±5年で", "マンション");
  assert.ok(JSON.stringify(req.messages).includes("築年は±5年で"));
  assert.deepEqual(gsParseFix({ content: [{ type: "text", text: '{"lines":["成約：同じマンション","　築2000〜2010年"]}' }] }), ["成約：同じマンション", "　築2000〜2010年"]);
  assert.equal(gsParseFix({ content: [{ type: "text", text: '{"lines":["1203号室"]}' }] }), null);
  assert.equal(gsParseFix({ content: [{ type: "text", text: "わかりません" }] }), null);
});
t("依頼の返事：期日と、2e までのつなぎの一言", () => {
  const s = msgGsCaseRequested(7, "11/26（木）18時");
  assert.ok(s.includes("山口さんに頼みました（受付 G7・期日 11/26（木）18時）"));
  assert.ok(s.includes("02 に入れて［査定書を作る］"));
});
console.log(`${n} passed`);
```

`package.json` の `test` の最後に ` && tsx tests/group-satei-case.test.ts` を足す。

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx tsx tests/group-satei-case.test.ts`
Expected: FAIL（`group-satei-case` が無い）

- [ ] **Step 3: 書く**

`src/lib/group-satei-case.ts`：

```ts
/**
 * 段2d（計画 docs/superpowers/plans/2026-11-26-group-satei-2d.md）：事例の取り方の相談のカード・グループへの依頼の文・リマインド・
 * 作り直しの指示文・返事の文と、送る前の検査。純粋（通信しない）。
 * グループに出す文には、お客様の名前・REINS の物件番号・号室・番地を入れない（設計 6.2）。gsSafeText に通らないものは出さない（D14）。
 * 案件名（Notion）は使わない（お客様の名前が入りうる。D13）。
 */
import { encodeGsFix, encodeGsYes, receiptOf, type GsPrepKind, type GsRead } from "./group-satei-data";
import { gsDeadlineLabel } from "./group-satei-deadline";
import { GS_READ_MODEL, type GsCreateReq } from "./group-satei-read";
import { ALT_TEXT_MAX, FLEX_LABEL_MAX, POSTBACK_TEXT_MAX, pressedText, type FlexMessage } from "./task-card";

const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");
export const GS_LINES_MAX = 6;
export const GS_LINE_LEN = 80;
const PLACE_MAX = 40;
const BUILDING_MAX = 30;

const NG_RE = /[0-9]+\s*号室|[0-9]+\s*番地|[0-9]+番[0-9]|[0-9]+-[0-9]+|[0-9]{9,}|様/u;
/** 送ってよい文か（全角の数字・ハイフンも NFKC でそろえてから見る） */
export function gsSafeText(s: string): boolean {
  return !NG_RE.test(s.normalize("NFKC").replace(/[‐‑‒–—―ー−]/g, (c) => (c === "ー" ? c : "-")));
}

/** 案の行をそろえる。形が違う・1行も無い・1つでも検査に通らなければ null */
export function gsCleanLines(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return null;
  const lines = (v as string[]).map((x) => x.trim()).filter((x) => x !== "").slice(0, GS_LINES_MAX).map((x) => cut(x, GS_LINE_LEN));
  if (lines.length === 0 || !lines.every(gsSafeText)) return null;
  return lines;
}

/** 所在を町名まで：「丁目」があればそこまで、無ければ最初の数字の前まで（番地・号を落とす） */
export function gsTownOf(address: string | null): string | null {
  if (!address) return null;
  const s = address.normalize("NFKC").replace(/\s+/g, "");
  const chome = /^(.*?丁目)/u.exec(s);
  if (chome) return cut(chome[1], PLACE_MAX);
  const i = s.search(/[0-9]/);
  const head = (i >= 0 ? s.slice(0, i) : s).replace(/[-‐－ーの]+$/u, "");
  return Array.from(head).length >= 2 ? cut(head, PLACE_MAX) : null;
}

/** 物件名から号室を落とした建物名（読み取りの物件名は「マンション名と号室」。R8） */
export function gsBuildingOf(read: GsRead | null): string | null {
  const name = read?.propertyName?.normalize("NFKC").trim();
  if (!name) return null;
  let s = name;
  const room = read?.facts?.roomNo?.normalize("NFKC").trim();
  if (room) s = s.split(room).join("");
  s = s.replace(/\s*[0-9]+\s*(号室|号|室)?\s*$/u, "").trim();
  return s && gsSafeText(s) ? cut(s, BUILDING_MAX) : null;
}

/** グループのカードの「物件：」。マンションは町名・建物名、戸建・土地は町名だけ。どちらも無ければ null */
export function gsPublicPlace(read: GsRead | null, kind: GsPrepKind): string | null {
  const town = gsTownOf(read?.address ?? null);
  const building = kind === "マンション" ? gsBuildingOf(read) : null;
  const s = [town, building].filter(Boolean).join("・");
  return s && gsSafeText(s) ? s : null;
}

const text = (t: string, o: Record<string, unknown> = {}) => ({ type: "text", text: t, size: "sm", color: "#333333", wrap: true, ...o });
const button = (label: string, data: string, subject: string, primary = false) => ({
  type: "button",
  style: primary ? "primary" : "secondary",
  height: "sm",
  action: { type: "postback", label: cut(label, FLEX_LABEL_MAX), data, displayText: cut(pressedText(label, subject), POSTBACK_TEXT_MAX) },
});

/** 下村さんへの相談のカード（設計 6.1）。期日は「今押したら」の見込み（押した時刻で決め直す） */
export function gsProposalCard(o: { tid: string; ver: number; no: number; rev: number; place: string | null; lines: string[]; previewDeadline: number }): FlexMessage {
  const subj = `受付 ${receiptOf(o.no)}`;
  return {
    type: "flex",
    altText: cut(`事例の取り方の相談（${subj}）`, ALT_TEXT_MAX),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          text(`事例の取り方の相談（${subj}）`, { weight: "bold", size: "md" }),
          text(`${o.place ?? "この物件"}の REINS の事例を、次の条件で山口さんに頼んでいいですか？`),
          ...o.lines.map((l) => text(l, { color: "#555555" })),
          text(`期日：今押すと ${gsDeadlineLabel(o.previewDeadline)}（17時を過ぎたら次の営業日の18時）`, { color: "#555555" }),
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [button("いいよ", encodeGsYes(o.tid, o.ver, o.rev), subj, true), button("直す", encodeGsFix(o.tid, o.ver, o.rev), subj)],
      },
    },
  };
}

const mention = (staffId: string) => ({ staff: { type: "mention", mentionee: { type: "user", userId: staffId } } });

/** グループへの依頼（D9）：textV2 のメンション＋ボタンなしのカード。検査に通らなければ null（送らない） */
export function gsCaseRequestMessages(o: { staffId: string; no: number; place: string | null; lines: string[]; deadline: number }): unknown[] | null {
  const subj = `受付 ${receiptOf(o.no)}`;
  const head = `査定の事例をお願いします（${subj}）`;
  const body = [`物件：${o.place ?? "（カードの条件で）"}`, ...o.lines, `期日：${gsDeadlineLabel(o.deadline)}`, "取れたら、このトークに PDF を貼ってください"];
  if (![head, ...body].every(gsSafeText)) return null;
  return [
    { type: "textV2", text: `{staff} ${head}`, substitution: mention(o.staffId) },
    {
      type: "flex",
      altText: cut(head, ALT_TEXT_MAX),
      contents: {
        type: "bubble",
        body: { type: "box", layout: "vertical", spacing: "sm", contents: [text(head, { weight: "bold", size: "md" }), ...body.map((b) => text(b))] },
      },
    },
  ];
}

/** 手で頼むときに下村さんへ渡す文面（同じ中身の文字だけ） */
export function gsCaseRequestPlain(o: { no: number; place: string | null; lines: string[]; deadline: number }): string {
  return [`査定の事例をお願いします（受付 ${receiptOf(o.no)}）`, `物件：${o.place ?? "（町名を入れてください）"}`, ...o.lines, `期日：${gsDeadlineLabel(o.deadline)}`].join("\n");
}

/** リマインド（設計 6.2）：グループに1回だけ */
export function gsReminderMessages(staffId: string, no: number): unknown[] {
  return [{ type: "textV2", text: `{staff} 受付 ${receiptOf(no)} の事例はいかがでしょうか`, substitution: mention(staffId) }];
}

const FIX_SYSTEM = [
  "あなたは不動産会社の査定の手伝いです。REINS の事例の取り方の案（行の配列）を、担当者の直しの言葉に合わせて書き直します。",
  '答えは JSON だけ：{"lines":["…","…"]}。行は6行まで、1行80字まで。書き方は今の行にそろえる（「成約：」「売出：」で始める行と、「　」で始める条件の行）。',
  "直しの言葉に無いことは変えない。号室・番地・人の名前・REINS の物件番号は書かない。分からないことを作らない。",
].join("\n");

/** ［直す］の作り直し（D3）。Claude 1回 */
export function gsFixRequest(lines: string[], fixText: string, kind: GsPrepKind): GsCreateReq {
  return {
    model: GS_READ_MODEL,
    max_tokens: 800,
    system: FIX_SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text: `種別：${kind}\n今の行：\n${JSON.stringify(lines)}\n直しの言葉：\n${fixText}` }] }],
  };
}

/** 作り直しの答えを読む。JSON の lines が検査に通るときだけ */
export function gsParseFix(out: { content: Array<{ type: string; text?: string }> }): string[] | null {
  const raw = out.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("");
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  try {
    return gsCleanLines((JSON.parse(m[0]) as { lines?: unknown }).lines);
  } catch {
    return null;
  }
}

const R = (no: number) => `受付 ${receiptOf(no)}`;
export const msgGsPrepStarted = (no: number) => `査定で進めます。事例の取り方の案を作って、数分でお送りします（${R(no)}）`;
export const msgGsPrepUnknown = (no: number) =>
  `事例の案づくりを頼めたか確かめられませんでした。30分たっても案が届かなければ、山口さんへは手で頼んでください（${R(no)}）`;
export const msgGsPrepRejected = (no: number) => `事例の案づくりを受け付けられませんでした。山口さんへは手で頼んでください（${R(no)}）`;
export const msgGsPrepStopped = (no: number) => `いま受付を止めています。少し待ってから、もう一度案件を選んでください（${R(no)}）`;
export const msgGsPrepFailed = (no: number) => `事例の取り方の案を作れませんでした。山口さんへは手で頼んでください（${R(no)}）`;
export const msgGsPrepLate = (no: number) =>
  `事例の取り方の案がまだできていません（${R(no)}）。Mac の査定係が止まっているかもしれません。山口さんへは手で頼んでも大丈夫です`;
export const msgGsCaseRequested = (no: number, label: string) =>
  `山口さんに頼みました（${R(no)}・期日 ${label}）。PDF が貼られたら、案件フォルダの 02 に入れて［査定書を作る］を押してください（自動の保存は次の段）`;
export const msgGsCaseSendFailed = (no: number, unknown: boolean, plain: string) =>
  `${unknown ? "山口さんへの依頼を送れたか確かめられませんでした。グループを見て、届いていなければ" : "山口さんへの依頼を送れませんでした。"}手で頼んでください（${R(no)}）\n\n${plain}`;
export const msgGsFixAsk = (no: number, left: number) =>
  `直すところを1通で送ってください（喋ったままで大丈夫です）。30分以内・あと${left}回まで（${R(no)}）`;
export const msgGsFixLimit = (no: number) => `直すのは2回までです。山口さんへは手で頼んでください（${R(no)}）`;
export const msgGsFixDone = (no: number, fixes: number) => `直しました（${fixes}回目／2回まで）。これでよければ［いいよ］を押してください（${R(no)}）`;
export const msgGsFixFailed = (no: number) => `うまく作り直せませんでした。［直す］をもう一度押すか、山口さんへは手で頼んでください（${R(no)}）`;
export const msgGsRemindMe = (no: number, label: string) =>
  `${R(no)} の事例がまだ届いていないので、グループで山口さんに1回だけ声をかけました（期日 ${label}）`;
export const msgGsAlreadyRequested = (no: number) => `山口さんへはもう頼んであります（${R(no)}）`;
export const MSG_GS_PROPOSAL_STALE = "新しい案が届いています。そちらから選んでください";
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx tsx tests/group-satei-case.test.ts && npx tsc --noEmit -p .`
Expected: PASS（10件）・何も出ない

- [ ] **Step 5: コミット**

```bash
git add src/lib/group-satei-case.ts tests/group-satei-case.test.ts package.json
git commit -m "feat: 段2dの相談のカード・グループへの依頼とリマインドの文・送る前の検査を足す

グループの文は町名と建物名だけ（号室・番地・名前・REINS の番号は検査で止める）。メンションは textV2、条件はボタンなしのカード。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A3: portal の準備の口（aisecretary 側）

**Files:**
- Modify: `src/lib/satei-portal.ts`（`postJson`・`classify` に `export`、`getJson` を足す）
- Create: `src/lib/group-satei-prep-portal.ts`
- Test: `tests/group-satei-prep-portal.test.ts`（新）、`package.json`

**Interfaces:**
- Consumes: `SateiPortalOpts`・`SateiCall`
- Produces: 型 `SateiPrepIntakeReq`・`SateiPrepNotice`・`SateiPrepDecideReq`、`sateiPrepIntake(req, opts)` → `SateiCall<{ created: boolean; status: string }>`、`sateiPrepNotices(opts)` → `SateiCall<SateiPrepNotice[]>`、`sateiPrepDecide(tid, req, opts)` → `SateiCall<{ status: string }>`、`interface GsPrepPortal { intake; notices; decide }`

- [ ] **Step 1: 失敗するテストを書く**

`tests/group-satei-prep-portal.test.ts`：

```ts
/** 段2d：portal の準備の口（group-satei-prep-portal.ts。fetch は偽物） */
import assert from "node:assert/strict";
import { sateiPrepDecide, sateiPrepIntake, sateiPrepNotices, type SateiPrepIntakeReq } from "../src/lib/group-satei-prep-portal";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

function fake(status: number, body: unknown, calls: Array<{ url: string; init: RequestInit }>): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { status, ok: status < 300, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}
const opts = (status: number, body: unknown, calls: Array<{ url: string; init: RequestInit }>) => ({ fetchImpl: fake(status, body, calls), baseUrl: "https://p.example.test", token: "k", timeoutMs: 1000 });
const REQ: SateiPrepIntakeReq = {
  tid: "0123456789abcdef", no: 7, dealId: "a".repeat(32), folderId: "folder_ABC-123", kind: "マンション", place: "大阪市北区天満2丁目3-4",
  building: "パークハウス天満", facts: { builtYm: "2005-03", exclusiveArea: 65.3, landArea: null, buildingArea: null }, requestedBy: "U" + "b".repeat(32),
};

(async () => {
  await t("受付：POST /api/jobs/satei/prep に約束の欄だけ。201 は ok", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const r = await sateiPrepIntake({ ...REQ, extra: "x" } as SateiPrepIntakeReq, opts(201, { created: true, prep: { tid: REQ.tid, status: "受付" } }, calls));
    assert.equal(calls[0].url, "https://p.example.test/api/jobs/satei/prep");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), REQ);
    assert.equal((calls[0].init.headers as Record<string, string>)["x-job-token"], "k");
    assert.deepEqual(r, { kind: "ok", value: { created: true, status: "受付" } });
  });
  await t("受付：503 PREP_DISABLED・INTAKE_STOPPED は rejected（code つき）。ほかの 503 は unknown", async () => {
    assert.deepEqual(await sateiPrepIntake(REQ, opts(503, { code: "PREP_DISABLED" }, [])), { kind: "rejected", status: 503, code: "PREP_DISABLED" });
    assert.deepEqual(await sateiPrepIntake(REQ, opts(503, { code: "INTAKE_STOPPED" }, [])), { kind: "rejected", status: 503, code: "INTAKE_STOPPED" });
    assert.deepEqual(await sateiPrepIntake(REQ, opts(503, {}, [])), { kind: "unknown", reason: "http-503" });
  });
  await t("一覧：GET。形の違う行は捨てる", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const good = { tid: REQ.tid, no: 7, status: "相談中", lines: ["a"], areaDone: true, failReason: "" };
    const r = await sateiPrepNotices(opts(200, { preps: [good, { tid: "x" }, { ...good, status: "受付" }] }, calls));
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].url, "https://p.example.test/api/jobs/satei/prep/notices");
    assert.deepEqual(r, { kind: "ok", value: [good] });
  });
  await t("決定：tid の口へ。409 は rejected", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const r = await sateiPrepDecide(REQ.tid, { decision: "manual", rev: 1 }, opts(409, { code: "PREP_CLOSED" }, calls));
    assert.equal(calls[0].url, `https://p.example.test/api/jobs/satei/prep/${REQ.tid}/decide`);
    assert.deepEqual(r, { kind: "rejected", status: 409, code: "PREP_CLOSED" });
  });
  console.log(`${n} passed`);
})();
```

（503 は今の `classify` では `unknown`（5xx）になる。PREP_DISABLED・INTAKE_STOPPED を見分けるため、Step 3 で受付だけその2つの code を `rejected` に読み替える。）

`package.json` の `test` の最後に ` && tsx tests/group-satei-prep-portal.test.ts` を足す。

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx tsx tests/group-satei-prep-portal.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 書く**

`src/lib/satei-portal.ts`：`type Raw` を `export type Raw`、`async function postJson` を `export async function postJson`、`function classify` を `export function classify` にする。`postJson` の後ろに：

```ts
/** GET（本文なし）。結果の分け方は postJson と同じ */
export async function getJson(path: string, opts: SateiPortalOpts): Promise<Raw> {
  let res: Response;
  try {
    res = await opts.fetchImpl(`${opts.baseUrl}${path}`, {
      method: "GET",
      headers: { "x-job-token": opts.token },
      signal: AbortSignal.timeout(opts.timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    return { kind: "unknown", reason: name === "TimeoutError" ? "timeout" : "network" };
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // 中身が読めない（body は {} のまま）
  }
  return { kind: "http", status: res.status, body };
}
```

`src/lib/group-satei-prep-portal.ts`：

```ts
/**
 * 段2d：portal（reins-report）の「準備」の依頼箱を呼ぶ（計画 2026-11-26-group-satei-2d の受け渡しの約束）。鍵は x-job-token。
 * 結果は satei-portal.ts と同じ3つ（ok／rejected／unknown）。受付の 503 PREP_DISABLED・INTAKE_STOPPED だけは rejected に読み替える
 * （呼び手が 2a の道へ戻す・止めていると返すため）。例外は投げない。ログは出さない。
 */
import { classify, getJson, postJson, type SateiCall, type SateiPortalOpts } from "./satei-portal";
import type { GsPrepKind } from "./group-satei-data";

export interface SateiPrepIntakeReq {
  tid: string;
  no: number;
  dealId: string;
  folderId: string;
  kind: GsPrepKind;
  place: string | null;
  building: string | null;
  facts: { builtYm: string | null; exclusiveArea: number | null; landArea: number | null; buildingArea: number | null };
  requestedBy: string;
}
export interface SateiPrepNotice {
  tid: string;
  no: number;
  status: "相談中" | "失敗";
  lines: string[];
  areaDone: boolean;
  failReason: string;
}
export type SateiPrepDecideReq = { decision: "ok"; rev: number; lines: string[]; deadline: number } | { decision: "manual"; rev: number };

export interface GsPrepPortal {
  intake(req: SateiPrepIntakeReq): Promise<SateiCall<{ created: boolean; status: string }>>;
  notices(): Promise<SateiCall<SateiPrepNotice[]>>;
  decide(tid: string, req: SateiPrepDecideReq): Promise<SateiCall<{ status: string }>>;
}

const TID_RE = /^[0-9a-f]{16}$/;
const STOP_CODES = new Set(["PREP_DISABLED", "INTAKE_STOPPED"]);

export async function sateiPrepIntake(req: SateiPrepIntakeReq, opts: SateiPortalOpts): Promise<SateiCall<{ created: boolean; status: string }>> {
  const payload: SateiPrepIntakeReq = {
    tid: req.tid, no: req.no, dealId: req.dealId, folderId: req.folderId, kind: req.kind, place: req.place, building: req.building,
    facts: { builtYm: req.facts.builtYm, exclusiveArea: req.facts.exclusiveArea, landArea: req.facts.landArea, buildingArea: req.facts.buildingArea },
    requestedBy: req.requestedBy,
  };
  const raw = await postJson("/api/jobs/satei/prep", payload, opts);
  if (raw.kind === "http" && raw.status === 503 && typeof raw.body.code === "string" && STOP_CODES.has(raw.body.code)) {
    return { kind: "rejected", status: 503, code: raw.body.code };
  }
  return classify(raw, (b) => {
    const prep = b.prep as { status?: unknown } | undefined;
    return typeof b.created === "boolean" && prep && typeof prep.status === "string" ? { created: b.created, status: prep.status } : null;
  });
}

function asNotice(v: unknown): SateiPrepNotice | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.tid !== "string" || !TID_RE.test(r.tid) || typeof r.no !== "number" || !Number.isInteger(r.no)) return null;
  if (r.status !== "相談中" && r.status !== "失敗") return null;
  if (!Array.isArray(r.lines) || !r.lines.every((s) => typeof s === "string")) return null;
  return { tid: r.tid, no: r.no, status: r.status, lines: r.lines as string[], areaDone: r.areaDone === true, failReason: typeof r.failReason === "string" ? r.failReason : "" };
}

export async function sateiPrepNotices(opts: SateiPortalOpts): Promise<SateiCall<SateiPrepNotice[]>> {
  return classify(await getJson("/api/jobs/satei/prep/notices", opts), (b) =>
    Array.isArray(b.preps) ? b.preps.map(asNotice).filter((x): x is SateiPrepNotice => x !== null) : null,
  );
}

export async function sateiPrepDecide(tid: string, req: SateiPrepDecideReq, opts: SateiPortalOpts): Promise<SateiCall<{ status: string }>> {
  return classify(await postJson(`/api/jobs/satei/prep/${tid}/decide`, req, opts), (b) => (typeof b.status === "string" ? { status: b.status } : null));
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `npx tsx tests/group-satei-prep-portal.test.ts && npx tsx tests/satei-portal.test.ts && npx tsc --noEmit -p .`
Expected: PASS（既存の satei-portal のテストも変わらない）

- [ ] **Step 5: コミット**

```bash
git add src/lib/satei-portal.ts src/lib/group-satei-prep-portal.ts tests/group-satei-prep-portal.test.ts package.json
git commit -m "feat: 段2dで portal の準備の口（受付・一覧・決定）を呼ぶ部品を足す

受付の 503 PREP_DISABLED・INTAKE_STOPPED は断りとして読み、呼び手が 2a の道へ戻せるようにした。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A4: 案件を決めたら準備へ（gs のあと）

**Files:**
- Create: `src/lib/group-satei-propose.ts`（`startGsPrep` と保存の部品）
- Modify: `src/lib/group-satei-actions.ts`（`GsActionDeps` に任意の口、`Outcome` を `export interface GsOutcome` に、`pick()` に分岐）
- Modify: `src/lib/group-satei-wire.ts`（`groupSateiActionDeps` に `prep`・`push`・`now`）
- Test: `tests/group-satei-prep-actions.test.ts`（新）、`package.json`

**Interfaces:**
- Consumes: A1〜A3、`SateiDeal`・`normNotionId`、`MSG_GS_NO_FOLDER`・`msgGsAlready`（card.ts）、`MSG_SATEI_DEAL_NOT_FOUND`（satei-text.ts）
- Produces:
  - `GsActionDeps` に `prep?: GsPrepPortal | null`・`push?(to: string, messages: unknown[], key: string): Promise<number | null>`・`now?(): number`
  - `export interface GsOutcome { text: string; code: string; settled: boolean; card?: FlexMessage }`
  - `startGsPrep(a: { tid: string; dealId: string }, tk: GsTicket, deal: SateiDeal, kind: GsPrepKind, userId: string, deps: GsActionDeps, kv): Promise<GsOutcome | null>`（null＝PREP_DISABLED で 2a の道へ）
  - `saveGsTicket(kv, tid, tk)`（`group-satei-propose.ts`。asking 以外なら開いている集合から外す）

- [ ] **Step 1: 失敗するテストを書く**

`tests/group-satei-prep-actions.test.ts`（偽物の作りは `tests/group-satei-kind-actions.test.ts` と同じ）：

```ts
/** 段2d：案件を決めたら portal の準備へ（group-satei-actions.ts → group-satei-propose.ts。KV・portal・LINE は差し替え） */
import assert from "node:assert/strict";
import { handleGroupSateiPostback, type GsActionDeps } from "../src/lib/group-satei-actions";
import { asTicket, GS_STAGE2_SET, gsDecKey, gsTicketKey, parseGsData, ticketIdOf, type GsTicket } from "../src/lib/group-satei-data";
import type { SateiPrepIntakeReq } from "../src/lib/group-satei-prep-portal";
import type { SateiDeal } from "../src/lib/satei-deal";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const G = "C" + "a".repeat(32);
const DB = "9999abcd0123456789ab0123456789ab";
const DEAL = "0123abcd0123456789ab0123456789ab";
const tid = ticketIdOf("m1");
const base: GsTicket = {
  no: 7, ver: 1, groupId: G, requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], state: "asking",
  read: { address: "大阪市北区天満2丁目3-4", propertyName: "パークハウス天満 1203号室", kind: "マンション", basis: "本文", confidence: 0.9,
    facts: { roomNo: "1203", exclusiveArea: 65.3, landArea: null, buildingArea: null, builtYm: "2005-03", layout: null, floor: null, totalUnits: null, structure: null } },
};
const ON = { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, GROUP_SATEI_STAGE2: "1", GROUP_SATEI_CASE_STAFF_ID: STAFF };
const deal: SateiDeal = { id: DEAL, name: "山田様 売却", dealNo: 12, folderId: "folder_abcdefghij", propertyIds: ["p"], gone: false, parentDbId: DB };

function mk(o: { env?: Record<string, string>; kind?: string; intake?: unknown; folderId?: string | null } = {}) {
  const m = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  m.set(gsTicketKey(tid), base);
  const replies: Array<{ text: string; card?: unknown }> = [];
  const preps: SateiPrepIntakeReq[] = [];
  const intakes: unknown[] = [];
  const logs: string[] = [];
  const deps: GsActionDeps = {
    env: o.env ?? ON,
    kv: {
      get: async (k) => m.get(k) ?? null,
      set: async (k, v) => { m.set(k, v); },
      setNx: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
      incr: async () => 1, expire: async () => undefined,
      sadd: async (k, v) => { (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(v); },
      lpushTrim: async () => undefined, lrange: async () => [],
      del: async (k) => { m.delete(k); }, srem: async (k, v) => { sets.get(k)?.delete(v); },
    },
    dealsDbId: DB,
    readDeal: async () => ({ deal: { ...deal, folderId: o.folderId === undefined ? deal.folderId : o.folderId }, kind: o.kind ?? "マンション" }),
    intake: async (req) => { intakes.push(req); return { kind: "ok", value: { created: true, no: 12, status: "受付" } }; },
    loadDeals: async () => [{ id: DEAL, name: "x", phase: "査定" }],
    reserve: async () => ({ proceed: true }),
    complete: async () => undefined,
    reply: async (_t, text, card) => { replies.push({ text, card }); },
    log: (l) => logs.push(l),
    prep: {
      intake: async (req) => { preps.push(req); return (o.intake as never) ?? { kind: "ok", value: { created: true, status: "受付" } }; },
      notices: async () => ({ kind: "ok", value: [] }),
      decide: async () => ({ kind: "ok", value: { status: "手作業" } }),
    },
    push: async () => 200,
    now: () => 1_000,
  };
  return { deps, m, sets, replies, preps, intakes, logs };
}
const pick = (x: ReturnType<typeof mk>) =>
  handleGroupSateiPostback(parseGsData(`v1|gs|${tid}|1|${DEAL}`)!, { replyToken: "r", webhookEventId: "e1", source: { userId: SHIMO } }, x.deps);
const ticket = (x: ReturnType<typeof mk>) => asTicket(x.m.get(gsTicketKey(tid)))!;

(async () => {
  await t("マンション：今の受付は呼ばず、portal の準備へ。受付票は gathering・見回りの集合に入る", async () => {
    const x = mk();
    await pick(x);
    assert.equal(x.intakes.length, 0);
    assert.deepEqual(x.preps[0], {
      tid, no: 7, dealId: DEAL, folderId: "folder_abcdefghij", kind: "マンション", place: "大阪市北区天満2丁目3-4", building: "パークハウス天満",
      facts: { builtYm: "2005-03", exclusiveArea: 65.3, landArea: null, buildingArea: null }, requestedBy: SHIMO,
    });
    assert.equal(JSON.stringify(x.preps[0]).includes("山田"), false, "案件名を portal に渡さない");
    assert.equal(ticket(x).state, "gathering");
    assert.equal(ticket(x).requestKind, "satei");
    assert.equal(ticket(x).prepAt, 1_000);
    assert.deepEqual(ticket(x).prep, { kind: "マンション", rev: 0, lines: [], fixes: 0, sentRev: 0, tries: 0, groupPushes: 0 });
    assert.equal(x.m.get(gsDecKey(tid)), `prep:${DEAL}`);
    assert.ok(x.sets.get(GS_STAGE2_SET)?.has(tid));
    assert.equal(x.replies[0].text, "査定で進めます。事例の取り方の案を作って、数分でお送りします（受付 G7）");
    assert.ok(x.logs.includes("[group-satei] gs prep sent G7"));
  });
  await t("戸建・土地も準備へ（建物名は渡さない）", async () => {
    for (const kind of ["戸建", "土地"]) {
      const x = mk({ kind });
      await pick(x);
      assert.equal(x.preps[0].kind, kind);
      assert.equal(x.preps[0].building, null);
      assert.equal(ticket(x).state, "gathering");
    }
  });
  await t("山口さんの ID が無ければ 2a のまま（マンションは今の受付）", async () => {
    const x = mk({ env: { ...ON, GROUP_SATEI_CASE_STAFF_ID: "" } });
    await pick(x);
    assert.equal(x.preps.length, 0);
    assert.equal(x.intakes.length, 1);
  });
  await t("portal が PREP_DISABLED：印を外して 2a の道へ（マンションは今の受付）", async () => {
    const x = mk({ intake: { kind: "rejected", status: 503, code: "PREP_DISABLED" } });
    await pick(x);
    assert.equal(x.intakes.length, 1);
    assert.equal(ticket(x).state, "started");
  });
  await t("受付停止：印を外して「止めています」", async () => {
    const x = mk({ intake: { kind: "rejected", status: 503, code: "INTAKE_STOPPED" } });
    await pick(x);
    assert.equal(x.m.has(gsDecKey(tid)), false);
    assert.equal(ticket(x).state, "asking");
    assert.equal(x.replies[0].text, "いま受付を止めています。少し待ってから、もう一度案件を選んでください（受付 G7）");
  });
  await t("結果不明：gathering のまま（届いていれば見回りが案を拾う）。30分の知らせを案内", async () => {
    const x = mk({ intake: { kind: "unknown", reason: "timeout" } });
    await pick(x);
    assert.equal(ticket(x).state, "gathering");
    assert.ok(x.replies[0].text.startsWith("事例の案づくりを頼めたか確かめられませんでした"));
  });
  await t("ほかの断り：印を外して手で頼む案内", async () => {
    const x = mk({ intake: { kind: "rejected", status: 400, code: "INVALID_REQUEST" } });
    await pick(x);
    assert.equal(x.m.has(gsDecKey(tid)), false);
    assert.ok(x.replies[0].text.startsWith("事例の案づくりを受け付けられませんでした"));
  });
  await t("フォルダが無い：準備へ進まない", async () => {
    const x = mk({ folderId: null });
    await pick(x);
    assert.equal(x.preps.length, 0);
    assert.ok(x.replies[0].text.length > 0);
  });
  console.log(`${n} passed`);
})();
```

`package.json` の `test` の最後に ` && tsx tests/group-satei-prep-actions.test.ts` を足す。

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx tsx tests/group-satei-prep-actions.test.ts`
Expected: FAIL（`prep` が `GsActionDeps` に無い・今の受付が呼ばれる）

- [ ] **Step 3: actions.ts を変える**

`src/lib/group-satei-actions.ts`：

1) `interface Outcome { … }` を次に置き換え、`Outcome` を使っているところはそのまま（型の別名）：

```ts
export interface GsOutcome {
  text: string;
  code: string;
  settled: boolean;
  card?: FlexMessage;
}
type Outcome = GsOutcome;
```

2) `GsActionDeps` の `log(line: string): void;` の後ろに：

```ts
  /** 段2d：portal の準備の依頼箱（無ければ 2d は動かない＝2a のまま） */
  prep?: GsPrepPortal | null;
  /** 段2d：retry key つきの push（HTTP の状態番号。結果不明は null）。key は uuidv5 にする前の名前 */
  push?(to: string, messages: unknown[], key: string): Promise<number | null>;
  now?(): number;
```

import に `import type { GsPrepPortal } from "./group-satei-prep-portal";`・`import { startGsPrep } from "./group-satei-propose";`・`groupSateiPrepOn`・`type GsPrepKind`（group-satei-data から）を足す。

3) `pick()` の中、`const env = deps.env ?? process.env;` の直後（`if (kind === SATEI_KIND && !sateiActive(env))` の前）に：

```ts
  // 段2d：案件が決まったら portal の準備へ（マンション・戸建・土地）。PREP_DISABLED なら下の 2a の道へ（計画 D6）
  if (groupSateiPrepOn(env) && deps.prep && (kind === "マンション" || kind === "戸建" || kind === "土地")) {
    const o = await startGsPrep(a, tk, got.deal, kind as GsPrepKind, userId, deps, kv);
    if (o) return { ...o, text: o.text + warn };
  }
```

- [ ] **Step 4: propose.ts を書く（準備の開始）**

`src/lib/group-satei-propose.ts`：

```ts
/**
 * 段2d（計画 docs/superpowers/plans/2026-11-26-group-satei-2d.md）：準備の開始・［いいよ］［直す］・直しの1通・見回り・事例の PDF の控え。
 * portal・LINE・Claude は deps で受ける（本物は group-satei-wire.ts）。例外は投げない。ログは符号と受付番号だけ。
 */
import {
  GS_STAGE2_SET, GS_TICKET_TTL, gsDecKey, gsOpenKey, gsTicketKey, receiptOf,
  type GsPrepKind, type GsTicket,
} from "./group-satei-data";
import type { GsActionDeps, GsOutcome } from "./group-satei-actions";
import type { GsKv } from "./group-satei-open";
import { MSG_GS_NO_FOLDER, msgGsAlready } from "./group-satei-card";
import { gsBuildingOf, msgGsPrepRejected, msgGsPrepStarted, msgGsPrepStopped, msgGsPrepUnknown } from "./group-satei-case";
import { normNotionId, type SateiDeal } from "./satei-deal";
import { MSG_SATEI_DEAL_NOT_FOUND } from "./satei-text";

type Kv = GsKv & { del(key: string): Promise<void>; srem(key: string, member: string): Promise<void> };

/** 受付票を書く。asking 以外は開いている集合から外す（あとから届いた資料を足さない） */
export async function saveGsTicket(kv: Kv, tid: string, tk: GsTicket): Promise<void> {
  await kv.set(gsTicketKey(tid), tk, GS_TICKET_TTL);
  if (tk.state !== "asking" && !tk.provisional) await kv.srem(gsOpenKey(tk.groupId), tid);
}

async function quiet(f: () => Promise<unknown>, deps: { log(l: string): void }, code: string): Promise<void> {
  try {
    await f();
  } catch {
    deps.log(`[group-satei] ${code}`);
  }
}

/** 案件が決まった受付票の準備を portal に頼む。null＝portal が止めている（PREP_DISABLED）ので 2a の道へ */
export async function startGsPrep(
  a: { tid: string; dealId: string },
  tk: GsTicket,
  deal: SateiDeal,
  kind: GsPrepKind,
  userId: string,
  deps: GsActionDeps,
  kv: Kv,
): Promise<GsOutcome | null> {
  const no = tk.no;
  if (!deps.prep) return null;
  if (!deps.dealsDbId || deal.gone || deal.parentDbId !== normNotionId(deps.dealsDbId)) return { text: MSG_SATEI_DEAL_NOT_FOUND, code: "not-found", settled: true };
  if (!deal.folderId) return { text: MSG_GS_NO_FOLDER, code: "no-folder", settled: true };
  if (!(await kv.setNx(gsDecKey(a.tid), `prep:${a.dealId}`, GS_TICKET_TTL))) return { text: msgGsAlready(no), code: "already", settled: true };
  const f = tk.read?.facts;
  let r;
  try {
    r = await deps.prep.intake({
      tid: a.tid, no, dealId: a.dealId, folderId: deal.folderId, kind,
      place: tk.read?.address ?? null,
      building: kind === "マンション" ? gsBuildingOf(tk.read) : null,
      facts: { builtYm: f?.builtYm ?? null, exclusiveArea: f?.exclusiveArea ?? null, landArea: f?.landArea ?? null, buildingArea: f?.buildingArea ?? null },
      requestedBy: userId,
    });
  } catch {
    r = { kind: "unknown" as const, reason: "exception" };
  }
  if (r.kind === "rejected" && (r.code === "PREP_DISABLED" || r.code === "INTAKE_STOPPED")) {
    await quiet(() => kv.del(gsDecKey(a.tid)), deps, "gs prep dec-clear-failed");
    if (r.code === "PREP_DISABLED") return null;
    return { text: msgGsPrepStopped(no), code: `prep stopped ${receiptOf(no)}`, settled: true };
  }
  if (r.kind === "rejected") {
    await quiet(() => kv.del(gsDecKey(a.tid)), deps, "gs prep dec-clear-failed");
    return { text: msgGsPrepRejected(no), code: `prep rejected ${receiptOf(no)}`, settled: true };
  }
  // ok と結果不明は同じ受付票にする（結果不明でも portal に届いていれば、見回りが案を拾う。届いていなければ30分の知らせ）
  const now = (deps.now ?? Date.now)();
  const next: GsTicket = {
    ...tk, state: "gathering", provisional: false, dealId: a.dealId, requestKind: "satei", prepAt: now,
    prep: { kind, rev: 0, lines: [], fixes: 0, sentRev: 0, tries: 0, groupPushes: 0 },
  };
  await quiet(() => saveGsTicket(kv, a.tid, next), deps, "gs save-failed");
  await quiet(() => kv.sadd(GS_STAGE2_SET, a.tid), deps, "gs s2-add-failed");
  return r.kind === "ok"
    ? { text: msgGsPrepStarted(no), code: `prep sent ${receiptOf(no)}`, settled: true }
    : { text: msgGsPrepUnknown(no), code: `prep unknown ${receiptOf(no)}`, settled: true };
}
```

（ログは `handleGroupSateiPostback` が `[group-satei] gs <code>` の形で出す＝`[group-satei] gs prep sent G7`。）

- [ ] **Step 5: wire に本物の口を足す**

`src/lib/group-satei-wire.ts` の `groupSateiActionDeps()` の戻り値に：

```ts
    prep: gsPrepPortalReal(),
    push: (to, messages, key) => pushMessagesWithRetryKey(to, messages, uuidv5(key, GS_RETRY_NAMESPACE)),
    now: () => Date.now(),
```

同じファイルに：

```ts
import { sateiPrepDecide, sateiPrepIntake, sateiPrepNotices, type GsPrepPortal } from "./group-satei-prep-portal";
import { SATEI_PORTAL_TIMEOUT_MS, sateiPortalConfig } from "./satei-portal";

/** portal の準備の口（PORTAL_BASE_URL と JOB_API_TOKEN があるときだけ） */
export function gsPrepPortalReal(): GsPrepPortal | null {
  const c = sateiPortalConfig();
  if (!c) return null;
  const opts = { fetchImpl: fetch, baseUrl: c.baseUrl, token: c.token, timeoutMs: SATEI_PORTAL_TIMEOUT_MS };
  return {
    intake: (req) => sateiPrepIntake(req, opts),
    notices: () => sateiPrepNotices(opts),
    decide: (tid, req) => sateiPrepDecide(tid, req, opts),
  };
}
```

- [ ] **Step 6: 通ることを確かめる**

Run: `npx tsx tests/group-satei-prep-actions.test.ts && npx tsx tests/group-satei-actions.test.ts && npx tsx tests/group-satei-kind-actions.test.ts && npx tsc --noEmit -p .`
Expected: PASS（段1・2a の既存のテストは `GROUP_SATEI_CASE_STAFF_ID` が無いので今のまま）

- [ ] **Step 7: コミット**

```bash
git add src/lib/group-satei-actions.ts src/lib/group-satei-propose.ts src/lib/group-satei-wire.ts tests/group-satei-prep-actions.test.ts package.json
git commit -m "feat: 段2dで案件を決めたら、portal に事例の取り方の案づくりを頼む

マンション・戸建・土地とも。portal が止めていれば 2a の道へ戻す。案件名は portal に渡さない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A5: ［いいよ］［直す］と、直しの1通

**Files:**
- Modify: `src/lib/group-satei-propose.ts`（`answerGsProposal`・`handleGsFixText`・型 `GsFixDeps`）
- Modify: `src/lib/group-satei-actions.ts`（`handleGroupSateiPostback` のスイッチの確かめと `decide()` の振り分け）
- Modify: `src/lib/group-satei-wire.ts`（`groupSateiFixDeps`）
- Modify: `src/app/api/webhook/route.ts`（差し戻し理由の後ろで直しの1通を受ける）
- Test: `tests/group-satei-propose.test.ts`（新）、`package.json`

**Interfaces:**
- Consumes: A1〜A4、`gsCaseDeadline`・`gsDeadlineLabel`、`isSateiUser`
- Produces:
  - `answerGsProposal(a: Extract<GsAction, { op: "gy" | "gf" }>, tk, userId, deps: GsActionDeps, kv): Promise<GsOutcome>`
  - `interface GsFixDeps { env?; kv: (Kv & { delIfToken(key: string, token: string): Promise<boolean> }) | null; revise(lines: string[], text: string, kind: GsPrepKind): Promise<string[] | null>; reply(token: string, text: string, card?: FlexMessage): Promise<unknown>; now?(): number; log(l: string): void }`
  - `handleGsFixText(m: { userId?: string; groupId?: string; text: string; replyToken: string }, deps: GsFixDeps): Promise<boolean>`
  - wire：`groupSateiFixDeps(): GsFixDeps`

- [ ] **Step 1: 失敗するテストを書く**

`tests/group-satei-propose.test.ts`：

```ts
/** 段2d：［いいよ］［直す］と直しの1通（group-satei-propose.ts。KV・portal・LINE・Claude は差し替え） */
import assert from "node:assert/strict";
import { handleGroupSateiPostback, type GsActionDeps } from "../src/lib/group-satei-actions";
import {
  asTicket, GS_STAGE2_SET, gsFixKey, gsOkKey, gsTicketKey, gsWaitKey, parseGsData, ticketIdOf, type GsTicket,
} from "../src/lib/group-satei-data";
import { handleGsFixText, type GsFixDeps } from "../src/lib/group-satei-propose";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const G = "C" + "a".repeat(32);
const tid = ticketIdOf("m1");
const NOW = Date.UTC(2026, 10, 26, 1); // JST 11/26（木）10:00 → 期日は当日 18:00
const LINES = ["成約：同じマンション（パークハウス天満）→ 同じ町名 → 同じ小学校区", "売出：同じ条件で、いま売り出し中のものを5件ほど（無ければ無しで）"];
const base: GsTicket = {
  no: 7, ver: 1, groupId: G, requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], state: "proposing", dealId: "d",
  read: { address: "大阪市北区天満2丁目3-4", propertyName: "パークハウス天満 1203号室", kind: "マンション", basis: "本文", confidence: 0.9 },
  prep: { kind: "マンション", rev: 1, lines: LINES, fixes: 0, sentRev: 1, tries: 1, groupPushes: 0 },
};
const ON = { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, GROUP_SATEI_STAGE2: "1", GROUP_SATEI_CASE_STAFF_ID: STAFF };

function mk(o: { ticket?: Partial<GsTicket>; push?: number | null; env?: Record<string, string> } = {}) {
  const m = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  m.set(gsTicketKey(tid), { ...base, ...(o.ticket ?? {}) });
  sets.set(GS_STAGE2_SET, new Set([tid]));
  const replies: Array<{ text: string; card?: unknown }> = [];
  const pushes: Array<{ to: string; messages: unknown[]; key: string }> = [];
  const decides: unknown[] = [];
  const logs: string[] = [];
  const kv = {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: unknown) => { m.set(k, v); },
    setNx: async (k: string, v: unknown) => (m.has(k) ? false : (m.set(k, v), true)),
    incr: async () => 1, expire: async () => undefined,
    sadd: async (k: string, v: string) => { (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(v); },
    lpushTrim: async () => undefined, lrange: async () => [],
    del: async (k: string) => { m.delete(k); }, srem: async (k: string, v: string) => { sets.get(k)?.delete(v); },
    delIfToken: async (k: string, token: string) => {
      const v = m.get(k) as { token?: string } | undefined;
      if (v?.token !== token) return false;
      m.delete(k);
      return true;
    },
  };
  const deps: GsActionDeps = {
    env: o.env ?? ON, kv, dealsDbId: "x", readDeal: async () => null,
    intake: async () => ({ kind: "unknown", reason: "x" }), loadDeals: async () => [],
    reserve: async () => ({ proceed: true }), complete: async () => undefined,
    reply: async (_t, text, card) => { replies.push({ text, card }); },
    log: (l) => logs.push(l),
    prep: { intake: async () => ({ kind: "unknown", reason: "x" }), notices: async () => ({ kind: "ok", value: [] }), decide: async (id, req) => { decides.push({ id, req }); return { kind: "ok", value: { status: "x" } }; } },
    push: async (to, messages, key) => { pushes.push({ to, messages, key }); return o.push === undefined ? 200 : o.push; },
    now: () => NOW,
  };
  return { deps, kv, m, sets, replies, pushes, decides, logs };
}
const press = (x: ReturnType<typeof mk>, data: string, eventId = "e1") =>
  handleGroupSateiPostback(parseGsData(data)!, { replyToken: "r", webhookEventId: eventId, source: { userId: SHIMO } }, x.deps);
const ticket = (x: ReturnType<typeof mk>) => asTicket(x.m.get(gsTicketKey(tid)))!;
const fixDeps = (x: ReturnType<typeof mk>, revise: GsFixDeps["revise"]): GsFixDeps => ({
  env: ON, kv: x.kv, revise, reply: async (_t, text, card) => { x.replies.push({ text, card }); }, now: () => NOW, log: (l) => x.logs.push(l),
});

(async () => {
  await t("［いいよ］：依頼が来たグループへ1回 push（retry key case:<tid>）。事例待ち・期日・portal に ok", async () => {
    const x = mk();
    await press(x, `v1|gy|${tid}|1|1`);
    assert.equal(x.pushes.length, 1);
    assert.equal(x.pushes[0].to, G);
    assert.equal(x.pushes[0].key, `case:${tid}`);
    assert.equal((x.pushes[0].messages[0] as { type: string }).type, "textV2");
    const tk = ticket(x);
    assert.equal(tk.state, "waiting-cases");
    assert.equal(tk.prep!.deadline, Date.UTC(2026, 10, 26, 9));
    assert.equal(tk.prep!.requestedAt, NOW);
    assert.equal(tk.prep!.groupPushes, 1);
    assert.ok(x.sets.get(gsWaitKey(G))?.has(tid));
    assert.deepEqual(x.decides[0], { id: tid, req: { decision: "ok", rev: 1, lines: LINES, deadline: Date.UTC(2026, 10, 26, 9) } });
    assert.ok(x.replies[0].text.startsWith("山口さんに頼みました（受付 G7・期日 11/26（木）18時）"));
    assert.ok(x.logs.includes("[group-satei] gy case-request posted G7"));
  });
  await t("［いいよ］の2度目（別のイベント）は送らない", async () => {
    const x = mk();
    await press(x, `v1|gy|${tid}|1|1`, "e1");
    await press(x, `v1|gy|${tid}|1|1`, "e2");
    assert.equal(x.pushes.length, 1);
    assert.equal(x.replies[1].text, "山口さんへはもう頼んであります（受付 G7）");
  });
  await t("古い版の［いいよ］は「新しい案が届いています」", async () => {
    const x = mk({ ticket: { prep: { ...base.prep!, rev: 2 } } });
    await press(x, `v1|gy|${tid}|1|1`);
    assert.equal(x.pushes.length, 0);
    assert.equal(x.replies[0].text, "新しい案が届いています。そちらから選んでください");
  });
  await t("グループへの push が断られた：手作業・手で頼む案内と文面・portal に manual", async () => {
    const x = mk({ push: 400 });
    await press(x, `v1|gy|${tid}|1|1`);
    assert.equal(ticket(x).state, "manual");
    assert.ok(x.replies[0].text.startsWith("山口さんへの依頼を送れませんでした。手で頼んでください（受付 G7）"));
    assert.ok(x.replies[0].text.includes("期日：11/26（木）18時"));
    assert.deepEqual(x.decides[0], { id: tid, req: { decision: "manual", rev: 1 } });
    assert.equal(x.sets.get(GS_STAGE2_SET)?.has(tid), false);
  });
  await t("グループへの push の結果不明：「確かめられませんでした」", async () => {
    const x = mk({ push: null });
    await press(x, `v1|gy|${tid}|1|1`);
    assert.ok(x.replies[0].text.startsWith("山口さんへの依頼を送れたか確かめられませんでした"));
  });
  await t("［直す］：30分の印・「1通で送ってください」。2回直したあとの3回目は手で頼む案内", async () => {
    const x = mk();
    await press(x, `v1|gf|${tid}|1|1`);
    assert.equal((x.m.get(gsFixKey(SHIMO)) as { tid: string; rev: number }).tid, tid);
    assert.ok(x.replies[0].text.startsWith("直すところを1通で送ってください（喋ったままで大丈夫です）。30分以内・あと2回まで"));
    const y = mk({ ticket: { prep: { ...base.prep!, fixes: 2, rev: 3 } } });
    await press(y, `v1|gf|${tid}|1|3`);
    assert.equal(y.replies[0].text, "直すのは2回までです。山口さんへは手で頼んでください（受付 G7）");
    assert.equal(ticket(y).state, "manual");
    assert.deepEqual(y.decides[0], { id: tid, req: { decision: "manual", rev: 3 } });
  });
  await t("直しの1通：Claude の答えで版を上げ、返事でカードを出し直す（push しない）", async () => {
    const x = mk();
    await press(x, `v1|gf|${tid}|1|1`);
    const got = await handleGsFixText({ userId: SHIMO, text: "築年は±5年で", replyToken: "r2" }, fixDeps(x, async (lines, text) => (text.includes("±5年") ? [lines[0], "　築2000〜2010年"] : null)));
    assert.equal(got, true);
    const tk = ticket(x);
    assert.deepEqual(tk.prep!.lines, [LINES[0], "　築2000〜2010年"]);
    assert.deepEqual([tk.prep!.rev, tk.prep!.fixes, tk.prep!.sentRev], [2, 1, 2]);
    assert.equal(x.replies[1].text, "直しました（1回目／2回まで）。これでよければ［いいよ］を押してください（受付 G7）");
    assert.ok(JSON.stringify(x.replies[1].card).includes(`v1|gy|${tid}|1|2`));
    assert.equal(x.m.has(gsFixKey(SHIMO)), false);
    assert.equal(x.pushes.length, 0);
  });
  await t("直しの1通：作り直せなければ回数に数えず「うまく作り直せませんでした」", async () => {
    const x = mk();
    await press(x, `v1|gf|${tid}|1|1`);
    await handleGsFixText({ userId: SHIMO, text: "うーん", replyToken: "r2" }, fixDeps(x, async () => null));
    assert.equal(ticket(x).prep!.fixes, 0);
    assert.ok(x.replies[1].text.startsWith("うまく作り直せませんでした"));
  });
  await t("直しの1通：印が無い・グループ・下村さん以外・off は受けない（false）", async () => {
    const x = mk();
    const d = fixDeps(x, async () => ["x"]);
    assert.equal(await handleGsFixText({ userId: SHIMO, text: "a", replyToken: "r" }, d), false);
    await press(x, `v1|gf|${tid}|1|1`);
    assert.equal(await handleGsFixText({ userId: SHIMO, groupId: G, text: "a", replyToken: "r" }, d), false);
    assert.equal(await handleGsFixText({ userId: "U" + "e".repeat(32), text: "a", replyToken: "r" }, d), false);
    assert.equal(await handleGsFixText({ userId: SHIMO, text: "a", replyToken: "r" }, { ...d, env: { ...ON, GROUP_SATEI_CASE_STAFF_ID: "" } }), false);
  });
  await t("2d が off（山口さんの ID が無い）なら gy・gf は「止めています」", async () => {
    const x = mk({ env: { ...ON, GROUP_SATEI_CASE_STAFF_ID: "" } });
    await press(x, `v1|gy|${tid}|1|1`);
    assert.equal(x.replies[0].text, "いまは止めています");
    assert.equal(x.pushes.length, 0);
  });
  console.log(`${n} passed`);
})();
```

`package.json` の `test` の最後に ` && tsx tests/group-satei-propose.test.ts` を足す。

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx tsx tests/group-satei-propose.test.ts`
Expected: FAIL（`handleGsFixText` が無い）

- [ ] **Step 3: actions.ts の振り分け**

`handleGroupSateiPostback` の `if (action.op === "gk" && !groupSateiStage2On(env)) { … }` の後ろに：

```ts
  // 段2d のボタン（gy・gf）は 2d が off（山口さんの ID が無い・STAGE2 off）なら何もしない
  if ((action.op === "gy" || action.op === "gf") && !groupSateiPrepOn(env)) {
    deps.log(`[group-satei] ${action.op} paused prep`);
    return say(MSG_GS_PAUSED, "paused");
  }
```

`decide()` の先頭（`const dec = await kv.get(gsDecKey(a.tid));` の前）に：

```ts
  // 段2d：案件はもう決まっている（印は prep:）。［いいよ］［直す］は印を見ずに、受付票の状態と版で決める
  if (a.op === "gy" || a.op === "gf") return answerGsProposal(a, tk, userId, deps, kv);
```

import に `answerGsProposal` を足す（A1 の Step 4 で仮に置いた `gy`／`gf` の行があれば消す）。

- [ ] **Step 4: propose.ts に［いいよ］［直す］と直しの1通を書く**

`src/lib/group-satei-propose.ts` の import を広げ（`GS_FIX_MAX`・`GS_FIX_TTL`・`GS_CASES_TTL`・`gsCaseStaffId`・`gsFixKey`・`gsOkKey`・`gsWaitKey`・`groupSateiPrepOn`・`asTicket`・`type GsAction`、`gsCaseDeadline`・`gsDeadlineLabel`、`gsCaseRequestMessages`・`gsCaseRequestPlain`・`gsProposalCard`・`gsPublicPlace`・`msgGsAlreadyRequested`・`msgGsCaseRequested`・`msgGsCaseSendFailed`・`msgGsFixAsk`・`msgGsFixDone`・`msgGsFixFailed`・`msgGsFixLimit`・`MSG_GS_PROPOSAL_STALE`、`MSG_GS_BUSY`、`isSateiUser`、`type FlexMessage`、`randomUUID` from `node:crypto`）、末尾に：

```ts
const sentOk = (status: number | null) => status !== null && ((status >= 200 && status < 300) || status === 409);

/** 手で頼むことにした受付票を閉じる（見回りの集合から外し、portal に manual を残す） */
async function closeManual(tid: string, tk: GsTicket, rev: number, deps: { prep?: GsActionDeps["prep"]; log(l: string): void }, kv: Kv): Promise<void> {
  await quiet(() => saveGsTicket(kv, tid, { ...tk, state: "manual" }), deps, "prep save-failed");
  await quiet(() => kv.srem(GS_STAGE2_SET, tid), deps, "prep s2-rem-failed");
  if (deps.prep) await quiet(() => deps.prep!.decide(tid, { decision: "manual", rev }), deps, "prep decide-failed");
}

/** ［いいよ］（gy）と［直す］（gf）。版（rev）が今の案と同じときだけ */
export async function answerGsProposal(
  a: Extract<GsAction, { op: "gy" | "gf" }>,
  tk: GsTicket,
  userId: string,
  deps: GsActionDeps,
  kv: Kv,
): Promise<GsOutcome> {
  const env = deps.env ?? process.env;
  const no = tk.no;
  const p = tk.prep;
  if (a.op === "gy" && tk.state === "waiting-cases") return { text: msgGsAlreadyRequested(no), code: "already", settled: true };
  if (tk.state !== "proposing" || !p) return { text: msgGsAlready(no), code: "closed", settled: true };
  if (a.rev !== p.rev) return { text: MSG_GS_PROPOSAL_STALE, code: "stale-rev", settled: true };

  if (a.op === "gf") {
    if (p.fixes >= GS_FIX_MAX) {
      await closeManual(a.tid, tk, p.rev, deps, kv);
      return { text: msgGsFixLimit(no), code: `fix-limit ${receiptOf(no)}`, settled: true };
    }
    await kv.set(gsFixKey(userId), { tid: a.tid, rev: p.rev, token: randomUUID() }, GS_FIX_TTL);
    return { text: msgGsFixAsk(no, GS_FIX_MAX - p.fixes), code: `asked ${receiptOf(no)}`, settled: true };
  }

  const staff = gsCaseStaffId(env);
  if (!staff || !deps.push) return { text: MSG_GS_BUSY, code: "config-missing", settled: false };
  const now = (deps.now ?? Date.now)();
  const deadline = gsCaseDeadline(now);
  const place = gsPublicPlace(tk.read, p.kind);
  const plain = gsCaseRequestPlain({ no, place, lines: p.lines, deadline });
  const messages = gsCaseRequestMessages({ staffId: staff, no, place, lines: p.lines, deadline });
  if (!(await kv.setNx(gsOkKey(a.tid), String(p.rev), GS_TICKET_TTL))) return { text: msgGsAlreadyRequested(no), code: "already", settled: true };
  if (!messages) {
    await closeManual(a.tid, tk, p.rev, deps, kv);
    return { text: msgGsCaseSendFailed(no, false, plain), code: `case-request unsafe ${receiptOf(no)}`, settled: true };
  }
  let status: number | null;
  try {
    status = await deps.push(tk.groupId, messages, `case:${a.tid}`);
  } catch {
    status = null;
  }
  if (!sentOk(status)) {
    await closeManual(a.tid, { ...tk, prep: { ...p, groupPushes: p.groupPushes + 1 } }, p.rev, deps, kv);
    return { text: msgGsCaseSendFailed(no, status === null, plain), code: `case-request failed ${receiptOf(no)}`, settled: true };
  }
  const next: GsTicket = { ...tk, state: "waiting-cases", prep: { ...p, deadline, requestedAt: now, groupPushes: p.groupPushes + 1 } };
  // 受付票の期限は waiting-cases からさらに7日（設計 10。書き直しで7日に付け直す）
  await quiet(() => saveGsTicket(kv, a.tid, next), deps, "prep save-failed");
  await quiet(async () => {
    await kv.sadd(gsWaitKey(tk.groupId), a.tid);
    await kv.expire(gsWaitKey(tk.groupId), GS_CASES_TTL);
  }, deps, "prep wait-add-failed");
  if (deps.prep) await quiet(() => deps.prep!.decide(a.tid, { decision: "ok", rev: p.rev, lines: p.lines, deadline }), deps, "prep decide-failed");
  return { text: msgGsCaseRequested(no, gsDeadlineLabel(deadline)), code: `case-request posted ${receiptOf(no)}`, settled: true };
}

export interface GsFixDeps {
  env?: Record<string, string | undefined>;
  kv: (Kv & { delIfToken(key: string, token: string): Promise<boolean> }) | null;
  revise(lines: string[], text: string, kind: GsPrepKind): Promise<string[] | null>;
  reply(token: string, text: string, card?: FlexMessage): Promise<unknown>;
  now?(): number;
  log(l: string): void;
}

const FIX_TEXT_MAX = 1000;

/**
 * 1対1の文字を［直す］の答えとして受けるか。true＝受けた（返事も済み）、false＝今の流れへ。
 * 受けるのは 2d が on・1対1・TASK_SATEI_USER_IDS の人・空でない文字・印（gsatei:fix:<userId>）があるときだけ。それ以外は KV も読まない…
 * ではなく、印を1回読む（差し戻し理由の受け方と同じ）。印は読んだらすぐ消す（作り直せなかったら［直す］を押し直してもらう）
 */
export async function handleGsFixText(m: { userId?: string; groupId?: string; text: string; replyToken: string }, deps: GsFixDeps): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (!groupSateiPrepOn(env) || m.groupId || !m.userId || !isSateiUser(m.userId, env) || !deps.kv) return false;
  const text = Array.from((m.text ?? "").trim()).slice(0, FIX_TEXT_MAX).join("");
  if (!text) return false;
  const kv = deps.kv;
  const key = gsFixKey(m.userId);
  let mark: { tid?: unknown; rev?: unknown; token?: unknown } | null;
  try {
    const v = await kv.get(key);
    mark = v && typeof v === "object" ? (v as { tid?: unknown; rev?: unknown; token?: unknown }) : null;
  } catch {
    deps.log("[group-satei] fix read-failed");
    return false;
  }
  if (!mark || typeof mark.tid !== "string" || typeof mark.rev !== "number" || typeof mark.token !== "string") return false;
  const tid = mark.tid;
  await quiet(() => kv.delIfToken(key, mark!.token as string), deps, "fix clear-failed");
  const say = async (s: string, card?: FlexMessage) => {
    try {
      await deps.reply(m.replyToken, s, card);
    } catch {
      deps.log("[group-satei] reply-failed fix");
    }
  };
  const tk = asTicket(await kv.get(gsTicketKey(tid)).catch(() => null));
  if (!tk || tk.state !== "proposing" || !tk.prep || tk.prep.rev !== mark.rev) {
    deps.log("[group-satei] fix stale");
    await say(MSG_GS_PROPOSAL_STALE);
    return true;
  }
  const p = tk.prep;
  let lines: string[] | null = null;
  try {
    lines = await deps.revise(p.lines, text, p.kind);
  } catch {
    lines = null;
  }
  if (!lines) {
    deps.log(`[group-satei] fix failed ${receiptOf(tk.no)}`);
    await say(msgGsFixFailed(tk.no));
    return true;
  }
  const next: GsTicket = { ...tk, prep: { ...p, rev: p.rev + 1, lines, fixes: p.fixes + 1, sentRev: p.rev + 1 } };
  // 書く直前に読み直し、まだ同じ版の proposing のときだけ（同時の［いいよ］を上書きしない）
  const fresh = asTicket(await kv.get(gsTicketKey(tid)).catch(() => null));
  if (!fresh || fresh.state !== "proposing" || fresh.prep?.rev !== p.rev) {
    await say(MSG_GS_PROPOSAL_STALE);
    return true;
  }
  await quiet(() => saveGsTicket(kv, tid, next), deps, "fix save-failed");
  const now = (deps.now ?? Date.now)();
  const card = gsProposalCard({ tid, ver: tk.ver, no: tk.no, rev: next.prep!.rev, place: gsPublicPlace(tk.read, p.kind), lines, previewDeadline: gsCaseDeadline(now) });
  deps.log(`[group-satei] fix revised ${receiptOf(tk.no)} r${next.prep!.rev}`);
  await say(msgGsFixDone(tk.no, next.prep!.fixes), card);
  return true;
}
```

（`handleGroupSateiPostback` が `[group-satei] gy <code>`・`gf <code>` を出す＝`[group-satei] gy case-request posted G7`・`[group-satei] gf asked G7`。）

- [ ] **Step 5: wire と webhook**

`src/lib/group-satei-wire.ts` に：

```ts
import { gsFixRequest, gsParseFix } from "./group-satei-case";
import { handleGsFixText, type GsFixDeps } from "./group-satei-propose";
import { sateiReasonKv } from "./satei-wire";
import { replyTextAndCard, sendLineMessage } from "./line";

const FIX_TIMEOUT_MS = 25_000;

/** ［直す］の次の1通（1対1）。KV は受付票の KV に、印を消す delIfToken（Upstash の EVAL）を足したもの */
export function groupSateiFixDeps(): GsFixDeps {
  const base = groupSateiKv();
  const mark = sateiReasonKv();
  return {
    kv: base && mark ? { ...base, delIfToken: mark.delIfToken } : null,
    revise: async (lines, text, kind) => gsParseFix(await within(create(gsFixRequest(lines, text, kind)), FIX_TIMEOUT_MS)),
    reply: (token, text, card) => (card ? replyTextAndCard(token, text, card) : sendLineMessage(token, text)),
    now: () => Date.now(),
    log,
  };
}
export { handleGsFixText };
```

（`create`・`within`・`log` は同じファイルにあるもの。`line.ts` の import が既にあれば足すだけにする。）

`src/app/api/webhook/route.ts`：差し戻し理由の `if (await handleSateiReasonText(…)) { markCommitted(); continue; }` の直後に：

```ts
    // 段2d：［直す］のあとの次の1通（1対1・下村さん・印 gsatei:fix:<userId> があるときだけ）。無ければ false で今の流れへ
    if (
      await handleGsFixText(
        { userId: source.userId, groupId: source.groupId, text: event.message.text, replyToken },
        groupSateiFixDeps(),
      )
    ) {
      markCommitted();
      continue;
    }
```

import に `import { groupSateiFixDeps, handleGsFixText } from "@/lib/group-satei-wire";` を足す。

- [ ] **Step 6: 通ることを確かめる**

Run: `npx tsx tests/group-satei-propose.test.ts && npx tsx tests/group-satei-prep-actions.test.ts && npx tsx tests/group-satei-webhook.test.ts && npx tsx tests/satei-webhook-order.test.ts && npx tsc --noEmit -p .`
Expected: PASS（webhook の順番のテストも変わらない。off のとき `handleGsFixText` は KV を読まない）

- [ ] **Step 7: コミット**

```bash
git add src/lib/group-satei-propose.ts src/lib/group-satei-actions.ts src/lib/group-satei-wire.ts src/app/api/webhook/route.ts tests/group-satei-propose.test.ts package.json
git commit -m "feat: 段2dの［いいよ］でグループに山口さんへの依頼を出し、［直す］で案を作り直す

［いいよ］は押した時刻で期日を決め、依頼が来たグループへ1回だけ push。［直す］は次の1通を Claude 1回で作り直し、2回まで。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A6: 見回り（案の配達・失敗・遅れ・リマインド）と事例の PDF の控え

**Files:**
- Modify: `src/lib/group-satei-propose.ts`（`sweepGsStage2`・`markGsCasePdf`・型 `GsSweepDeps`）
- Modify: `src/lib/group-satei-wire.ts`（`sweepGroupSateiStage2OnTick`、`recordGroupSateiMediaEvent` に PDF の控え）
- Modify: `src/app/api/obi/cloud-tick/route.ts`
- Test: `tests/group-satei-stage2-sweep.test.ts`（新）、`package.json`

**Interfaces:**
- Consumes: A1〜A5、`sateiNotifyTarget`（satei-data.ts）、`GsMedia`
- Produces:
  - `interface GsSweepDeps { env?; kv: (Kv & { smembers(key: string): Promise<unknown[]> }) | null; prep: GsPrepPortal | null; push(to: string, messages: unknown[], key: string): Promise<number | null>; now(): number; log(l: string): void }`
  - `sweepGsStage2(deps: GsSweepDeps): Promise<void>`
  - `markGsCasePdf(row: GsMedia, groupId: string, deps: { env?; kv: (Kv & { smembers(key: string): Promise<unknown[]> }) | null; log(l: string): void }): Promise<void>`
  - wire：`sweepGroupSateiStage2OnTick(): Promise<void>`

- [ ] **Step 1: 失敗するテストを書く**

`tests/group-satei-stage2-sweep.test.ts`：

```ts
/** 段2d：毎分の見回り（案の配達・失敗・遅れ・リマインド）と事例の PDF の控え（group-satei-propose.ts） */
import assert from "node:assert/strict";
import {
  asTicket, GS_STAGE2_SET, gsCasesKey, gsTicketKey, gsWaitKey, ticketIdOf, type GsTicket,
} from "../src/lib/group-satei-data";
import { markGsCasePdf, sweepGsStage2, type GsSweepDeps } from "../src/lib/group-satei-propose";
import type { SateiPrepNotice } from "../src/lib/group-satei-prep-portal";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const G = "C" + "a".repeat(32);
const tid = ticketIdOf("m1");
const NOW = Date.UTC(2026, 10, 26, 1);
const ON = { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, GROUP_SATEI_STAGE2: "1", GROUP_SATEI_CASE_STAFF_ID: STAFF };
const prep0 = { kind: "マンション" as const, rev: 0, lines: [], fixes: 0, sentRev: 0, tries: 0, groupPushes: 0 };
const base: GsTicket = {
  no: 7, ver: 1, groupId: G, requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], state: "gathering", prepAt: NOW - 60_000,
  read: { address: "大阪市北区天満2丁目3-4", propertyName: "パークハウス天満", kind: "マンション", basis: "本文", confidence: 0.9 }, prep: prep0,
};
const NOTICE: SateiPrepNotice = { tid, no: 7, status: "相談中", lines: ["成約：同じマンション", "売出：5件ほど"], areaDone: true, failReason: "" };

function mk(o: { ticket?: Partial<GsTicket>; notices?: SateiPrepNotice[]; push?: number | null; now?: number; s2?: string[] } = {}) {
  const m = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  m.set(gsTicketKey(tid), { ...base, ...(o.ticket ?? {}) });
  sets.set(GS_STAGE2_SET, new Set(o.s2 ?? [tid]));
  const pushes: Array<{ to: string; messages: unknown[]; key: string }> = [];
  const calls: string[] = [];
  const logs: string[] = [];
  const kv = {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: unknown) => { m.set(k, v); },
    setNx: async (k: string, v: unknown) => (m.has(k) ? false : (m.set(k, v), true)),
    incr: async () => 1, expire: async () => undefined,
    sadd: async (k: string, v: string) => { (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(v); },
    srem: async (k: string, v: string) => { sets.get(k)?.delete(v); },
    smembers: async (k: string) => [...(sets.get(k) ?? [])],
    lpushTrim: async () => undefined, lrange: async () => [],
    del: async (k: string) => { m.delete(k); },
  };
  const deps: GsSweepDeps = {
    env: ON, kv,
    prep: {
      intake: async () => ({ kind: "unknown", reason: "x" }),
      notices: async () => { calls.push("notices"); return { kind: "ok", value: o.notices ?? [NOTICE] }; },
      decide: async (id, req) => { calls.push(`decide ${req.decision}`); return { kind: "ok", value: { status: "x" } }; },
    },
    push: async (to, messages, key) => { pushes.push({ to, messages, key }); return o.push === undefined ? 200 : o.push; },
    now: () => o.now ?? NOW,
    log: (l) => logs.push(l),
  };
  return { deps, kv, m, sets, pushes, calls, logs };
}
const ticket = (x: ReturnType<typeof mk>) => asTicket(x.m.get(gsTicketKey(tid)))!;

(async () => {
  await t("集合が空なら portal も LINE も呼ばない", async () => {
    const x = mk({ s2: [] });
    await sweepGsStage2(x.deps);
    assert.deepEqual([x.calls, x.pushes.length], [[], 0]);
  });
  await t("案の配達：下村さんへカードを push（retry key prop:<tid>:1）。proposing・版1", async () => {
    const x = mk();
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes[0].to, SHIMO);
    assert.equal(x.pushes[0].key, `prop:${tid}:1`);
    assert.ok(JSON.stringify(x.pushes[0].messages).includes(`v1|gy|${tid}|1|1`));
    assert.equal(ticket(x).state, "proposing");
    assert.deepEqual([ticket(x).prep!.rev, ticket(x).prep!.sentRev, ticket(x).prep!.tries], [1, 1, 1]);
    assert.deepEqual(ticket(x).prep!.lines, NOTICE.lines);
    assert.ok(x.logs.includes("[group-satei] propose sent G7 r1"));
  });
  await t("案の push が結果不明：gathering のまま tries 1。次の回にもう1回だけ（2回で止める）", async () => {
    const x = mk({ push: null });
    await sweepGsStage2(x.deps);
    await sweepGsStage2(x.deps);
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes.length, 2);
    assert.equal(ticket(x).state, "gathering");
    assert.equal(ticket(x).prep!.tries, 2);
  });
  await t("検査に通らない案：失敗と同じく手で頼む案内（グループには出さない）", async () => {
    const x = mk({ notices: [{ ...NOTICE, lines: ["天満2-3-4 の事例"] }] });
    await sweepGsStage2(x.deps);
    assert.equal(ticket(x).state, "manual");
    assert.equal(x.pushes[0].key, `prepfail:${tid}`);
  });
  await t("失敗：下村さんへ「案を作れませんでした」・手作業・portal に manual・集合から外す", async () => {
    const x = mk({ notices: [{ ...NOTICE, status: "失敗", lines: [], failReason: "folder" }] });
    await sweepGsStage2(x.deps);
    assert.equal(ticket(x).state, "manual");
    assert.ok(x.calls.includes("decide manual"));
    assert.equal(x.sets.get(GS_STAGE2_SET)?.has(tid), false);
  });
  await t("遅れ：gathering のまま30分で1回だけ知らせる（late:<tid>）", async () => {
    const x = mk({ notices: [], ticket: { prepAt: NOW - 31 * 60_000 } });
    await sweepGsStage2(x.deps);
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes.length, 1);
    assert.equal(x.pushes[0].key, `late:${tid}`);
    assert.equal(ticket(x).prep!.lateNotified, true);
  });
  const waiting = (o: Partial<GsTicket["prep"]> = {}): Partial<GsTicket> => ({
    state: "waiting-cases", prep: { ...prep0, rev: 1, lines: ["x"], sentRev: 1, tries: 1, groupPushes: 1, deadline: NOW - 1, requestedAt: NOW - 3_600_000, ...o },
  });
  await t("リマインド：期日を過ぎ・PDF の控えが無い → グループに1回・下村さんに1行。2回目は出さない", async () => {
    const x = mk({ ticket: waiting() });
    await sweepGsStage2(x.deps);
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.pushes.map((p) => [p.to, p.key]), [[G, `remind:${tid}`], [SHIMO, `remind-me:${tid}`]]);
    assert.equal((x.pushes[0].messages[0] as { text: string }).text, "{staff} 受付 G7 の事例はいかがでしょうか");
    assert.equal(ticket(x).prep!.reminded, true);
    assert.equal(ticket(x).prep!.groupPushes, 2);
    assert.equal(x.sets.get(GS_STAGE2_SET)?.has(tid), false);
    assert.ok(x.logs.includes("[group-satei] remind sent G7"));
  });
  await t("リマインド：期日前は出さない／PDF の控えがあれば出さずに集合から外す／グループへ2回済みなら出さない", async () => {
    const a = mk({ ticket: waiting({ deadline: NOW + 1 }) });
    await sweepGsStage2(a.deps);
    assert.equal(a.pushes.length, 0);
    const b = mk({ ticket: waiting() });
    b.sets.set(gsCasesKey(tid), new Set(["pdf1"]));
    await sweepGsStage2(b.deps);
    assert.equal(b.pushes.length, 0);
    assert.equal(b.sets.get(GS_STAGE2_SET)?.has(tid), false);
    const c = mk({ ticket: waiting({ groupPushes: 2 }) });
    await sweepGsStage2(c.deps);
    assert.equal(c.pushes.length, 0);
  });
  await t("PDF の控え：そのグループの事例待ちの票に、依頼より後の PDF だけ足す（画像・前の PDF は数えない）", async () => {
    const x = mk({ ticket: waiting() });
    x.sets.set(gsWaitKey(G), new Set([tid]));
    const d = { env: ON, kv: x.kv, log: (l: string) => x.logs.push(l) };
    await markGsCasePdf({ messageId: "img1", kind: "image", senderId: STAFF, at: NOW }, G, d);
    await markGsCasePdf({ messageId: "old", kind: "pdf", senderId: STAFF, at: NOW - 7_200_000 }, G, d);
    await markGsCasePdf({ messageId: "pdf1", kind: "pdf", senderId: STAFF, at: NOW }, G, d);
    assert.deepEqual([...(x.sets.get(gsCasesKey(tid)) ?? [])], ["pdf1"]);
    assert.ok(x.logs.includes("[group-satei] cases marked G7 1"));
  });
  await t("2d が off なら見回りも控えも何もしない", async () => {
    const x = mk();
    await sweepGsStage2({ ...x.deps, env: { ...ON, GROUP_SATEI_CASE_STAFF_ID: "" } });
    assert.deepEqual([x.calls, x.pushes.length], [[], 0]);
  });
  console.log(`${n} passed`);
})();
```

`package.json` の `test` の最後に ` && tsx tests/group-satei-stage2-sweep.test.ts` を足す。

- [ ] **Step 2: 落ちることを確かめる**

Run: `npx tsx tests/group-satei-stage2-sweep.test.ts`
Expected: FAIL（`sweepGsStage2` が無い）

- [ ] **Step 3: 見回りと控えを書く**

`src/lib/group-satei-propose.ts` の import に `GS_GROUP_PUSH_MAX`・`GS_LATE_MS`・`GS_PROPOSE_TRIES`・`gsCasesKey`・`gsRemindKey`・`type GsMedia`、`gsCleanLines`・`gsReminderMessages`・`msgGsPrepFailed`・`msgGsPrepLate`・`msgGsRemindMe`、`sateiNotifyTarget`、`type GsPrepPortal`・`type SateiPrepNotice` を足し、末尾に：

```ts
type SweepKv = Kv & { smembers(key: string): Promise<unknown[]> };

export interface GsSweepDeps {
  env?: Record<string, string | undefined>;
  kv: SweepKv | null;
  prep: GsPrepPortal | null;
  push(to: string, messages: unknown[], key: string): Promise<number | null>;
  now(): number;
  log(l: string): void;
}

const textMsg = (text: string) => [{ type: "text", text }];

async function deliverProposal(tid: string, tk: GsTicket, nt: SateiPrepNotice, to: string, deps: GsSweepDeps, kv: SweepKv): Promise<void> {
  const p = tk.prep!;
  const lines = nt.status === "相談中" ? gsCleanLines(nt.lines) : null;
  if (!lines) {
    // 失敗・検査に通らない案：下村さんに1回だけ知らせて手作業（グループには何も出さない）
    const st = await deps.push(to, textMsg(msgGsPrepFailed(tk.no)), `prepfail:${tid}`).catch(() => null);
    deps.log(`[group-satei] prep failed ${receiptOf(tk.no)}${sentOk(st) ? "" : " push-failed"}`);
    await closeManual(tid, tk, 0, deps, kv);
    return;
  }
  if (p.tries >= GS_PROPOSE_TRIES) return;
  const card = gsProposalCard({ tid, ver: tk.ver, no: tk.no, rev: 1, place: gsPublicPlace(tk.read, p.kind), lines, previewDeadline: gsCaseDeadline(deps.now()) });
  const st = await deps.push(to, [card], `prop:${tid}:1`).catch(() => null);
  const fresh = asTicket(await kv.get(gsTicketKey(tid)));
  if (!fresh || fresh.state !== "gathering") return;
  const next: GsTicket = sentOk(st)
    ? { ...fresh, state: "proposing", prep: { ...p, rev: 1, lines, sentRev: 1, tries: p.tries + 1 } }
    : { ...fresh, prep: { ...p, tries: p.tries + 1 } };
  await saveGsTicket(kv, tid, next);
  deps.log(`[group-satei] propose ${sentOk(st) ? "sent" : "push-failed"} ${receiptOf(tk.no)} r1`);
}

async function remind(tid: string, tk: GsTicket, to: string | null, staff: string, deps: GsSweepDeps, kv: SweepKv): Promise<void> {
  const p = tk.prep!;
  if ((await kv.smembers(gsCasesKey(tid))).length > 0) {
    await kv.srem(GS_STAGE2_SET, tid);
    return;
  }
  if (!(await kv.setNx(gsRemindKey(tid), 1, GS_CASES_TTL))) return;
  const st = await deps.push(tk.groupId, gsReminderMessages(staff, tk.no), `remind:${tid}`).catch(() => null);
  await saveGsTicket(kv, tid, { ...tk, prep: { ...p, reminded: true, groupPushes: p.groupPushes + 1 } });
  if (to && p.deadline) await deps.push(to, textMsg(msgGsRemindMe(tk.no, gsDeadlineLabel(p.deadline))), `remind-me:${tid}`).catch(() => null);
  await kv.srem(GS_STAGE2_SET, tid);
  deps.log(`[group-satei] remind ${sentOk(st) ? "sent" : "push-failed"} ${receiptOf(tk.no)}`);
}

/**
 * 毎分の見回り（D10）：gsatei:s2 の受付票だけを見る。
 * gathering → portal の一覧から案（相談中）を下村さんへ／失敗なら手作業／30分で遅れの知らせ。
 * waiting-cases → 期日を過ぎて PDF の控えが無ければ1回だけリマインド。終わった票は集合から外す。例外は投げない
 */
export async function sweepGsStage2(deps: GsSweepDeps): Promise<void> {
  const env = deps.env ?? process.env;
  if (!groupSateiPrepOn(env) || !deps.kv) return;
  const kv = deps.kv;
  try {
    const tids = (await kv.smembers(GS_STAGE2_SET)).filter((x): x is string => typeof x === "string");
    if (tids.length === 0) return;
    const to = sateiNotifyTarget(env);
    const staff = gsCaseStaffId(env)!;
    const live: Array<{ tid: string; tk: GsTicket }> = [];
    for (const tid of tids) {
      const tk = asTicket(await kv.get(gsTicketKey(tid)));
      if (!tk || !tk.prep || !["gathering", "proposing", "waiting-cases"].includes(tk.state)) {
        await kv.srem(GS_STAGE2_SET, tid);
        continue;
      }
      live.push({ tid, tk });
    }
    const gathering = live.filter((x) => x.tk.state === "gathering");
    if (gathering.length > 0 && deps.prep && to) {
      const r = await deps.prep.notices().catch(() => null);
      const list = r && r.kind === "ok" ? r.value : [];
      if (!r || r.kind !== "ok") deps.log("[group-satei] propose list-failed");
      for (const { tid, tk } of gathering) {
        const nt = list.find((x) => x.tid === tid);
        if (nt) {
          await deliverProposal(tid, tk, nt, to, deps, kv);
          continue;
        }
        if (!tk.prep!.lateNotified && tk.prepAt && deps.now() - tk.prepAt >= GS_LATE_MS) {
          const st = await deps.push(to, textMsg(msgGsPrepLate(tk.no)), `late:${tid}`).catch(() => null);
          await saveGsTicket(kv, tid, { ...tk, prep: { ...tk.prep!, lateNotified: true } });
          deps.log(`[group-satei] prep late ${receiptOf(tk.no)}${sentOk(st) ? "" : " push-failed"}`);
        }
      }
    }
    for (const { tid, tk } of live) {
      if (tk.state !== "waiting-cases") continue;
      const p = tk.prep!;
      if (p.reminded || p.groupPushes >= GS_GROUP_PUSH_MAX) {
        await kv.srem(GS_STAGE2_SET, tid);
        continue;
      }
      if (p.deadline && deps.now() >= p.deadline) await remind(tid, tk, to, staff, deps, kv);
    }
  } catch {
    deps.log("[group-satei] s2-sweep skip:exception");
  }
}

/**
 * グループに PDF が貼られたら（段1の控えの道から呼ぶ）、そのグループの事例待ちの票に控える（D8）。
 * 依頼の時刻より後の PDF だけ。待ちの票が2件以上で区別がつかなければ全部に足す（催促しない側）。取り出し・保存は 2e
 */
export async function markGsCasePdf(row: GsMedia, groupId: string, deps: { env?: Record<string, string | undefined>; kv: SweepKv | null; log(l: string): void }): Promise<void> {
  const env = deps.env ?? process.env;
  if (row.kind !== "pdf" || !groupSateiPrepOn(env) || !deps.kv) return;
  const kv = deps.kv;
  try {
    const tids = (await kv.smembers(gsWaitKey(groupId))).filter((x): x is string => typeof x === "string");
    for (const tid of tids) {
      const tk = asTicket(await kv.get(gsTicketKey(tid)));
      if (!tk || tk.state !== "waiting-cases") {
        await kv.srem(gsWaitKey(groupId), tid);
        continue;
      }
      if (row.at < (tk.prep?.requestedAt ?? Number.POSITIVE_INFINITY)) continue;
      await kv.sadd(gsCasesKey(tid), row.messageId);
      await kv.expire(gsCasesKey(tid), GS_CASES_TTL);
      const count = (await kv.smembers(gsCasesKey(tid))).length;
      deps.log(`[group-satei] cases marked ${receiptOf(tk.no)} ${count}`);
    }
  } catch {
    deps.log("[group-satei] cases skip:exception");
  }
}
```

（`closeManual` は A5 で書いたもの。`deps` に `prep` があれば portal に manual を残す。）

- [ ] **Step 4: wire と見回りの入口**

`src/lib/group-satei-wire.ts` に：

```ts
import { markGsCasePdf, sweepGsStage2 } from "./group-satei-propose";
import { groupSateiPrepOn } from "./group-satei-data";

/** 毎分の見回り（/api/obi/cloud-tick）の段2d：案の配達・失敗・遅れ・リマインド。例外は投げない */
export async function sweepGroupSateiStage2OnTick(): Promise<void> {
  try {
    if (!groupSateiPrepOn()) return;
    await sweepGsStage2({
      kv: groupSateiKv(),
      prep: gsPrepPortalReal(),
      push: (to, messages, key) => pushMessagesWithRetryKey(to, messages, uuidv5(key, GS_RETRY_NAMESPACE)),
      now: () => Date.now(),
      log,
    });
  } catch {
    log("[group-satei] s2-sweep skip:tick-exception");
  }
}
```

`recordGroupSateiMediaEvent` の `await within(recordGroupSateiMedia(row, …), MEDIA_KV_TIMEOUT_MS);` の次の行に：

```ts
    // 段2d：事例待ちの票があれば、依頼のあとの PDF を控える（リマインドの判定だけ。2d が off なら何もしない）
    if (row.kind === "pdf" && groupSateiPrepOn()) {
      await within(markGsCasePdf(row, m.groupId as string, { kv: store, log }), MEDIA_KV_TIMEOUT_MS).catch(() => log("[group-satei] cases skip:timeout"));
    }
```

`src/app/api/obi/cloud-tick/route.ts`：import に `sweepGroupSateiStage2OnTick` を足し、`if (Date.now() - t0 < 30_000) await sweepGroupSateiOnTick();` の次の行に：

```ts
    // 段2d：事例の相談の案の配達・遅れの知らせ・山口さんへのリマインド（groupSateiPrepOn のときだけ。対象の票が無ければ KV を1回読むだけ）。
    // 前段で 40 秒を使っていたら、この回は飛ばす
    if (Date.now() - t0 < 40_000) await sweepGroupSateiStage2OnTick();
```

- [ ] **Step 5: 通ることを確かめる**

Run: `npx tsx tests/group-satei-stage2-sweep.test.ts && npx tsx tests/group-satei-reread.test.ts && npx tsx tests/obi-cloud-tick.test.ts && npx tsc --noEmit -p .`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add src/lib/group-satei-propose.ts src/lib/group-satei-wire.ts src/app/api/obi/cloud-tick/route.ts tests/group-satei-stage2-sweep.test.ts package.json
git commit -m "feat: 段2dの毎分の見回りで、案を下村さんへ届け、期日を過ぎたら山口さんに1回だけ催促する

案の push は2回まで、30分たっても案が無ければ知らせる。依頼のあとに貼られた PDF を受付票ごとに控え、あれば催促しない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task A7: 締め（CLAUDE.md・全体の確かめ・vault）

**Files:**
- Modify: `CLAUDE.md`（段2の節の最後）
- 進行ログ：`~/AI開発/tools/notebooklm-obsidian/vault/20_research/2026-08-08_AI秘書_集約と完了機能_進行ログ.md`

- [ ] **Step 1: CLAUDE.md に段2d の節を足す**

`CLAUDE.md` の「（段2b の前半・2026-11-26）…」の行の後ろに：

```markdown
（普通のグループの査定依頼・段2d・2026-11-26）`GROUP_SATEI_STAGE2=1` かつ `GROUP_SATEI_CASE_STAFF_ID`（山口さんの LINE userId。`U`＋32桁）のときだけ動く（`groupSateiPrepOn`）。どちらか無ければ 2a のまま。計画 `docs/superpowers/plans/2026-11-26-group-satei-2d.md`。
- 案件を選ぶ（gs）と、マンション・戸建・土地とも portal の準備（`POST /api/jobs/satei/prep`。portal の `SATEI_PREP`）へ。受付票は `gathering`。portal が `PREP_DISABLED` なら 2a の道（マンションは今の受付）。案件名は portal に渡さない。
- Mac の査定係（`SATEI_PREP=1`）が案の行を作って portal へ。毎分の見回り（cloud-tick の最後。`sweepGroupSateiStage2OnTick`）が portal の一覧から取り、下村さんへカード（［いいよ］`v1|gy|tid|ver|rev`・［直す］`v1|gf|…`）を push（retry key `prop:<tid>:1`。2回まで）。30分たっても案が無ければ1回だけ知らせる。
- ［直す］：印 `gsatei:fix:<userId>`（30分）→ 次の1対1の1通を Claude 1回で作り直し、返事でカードを出し直す（push しない）。2回まで。3回目は手で頼む案内。
- ［いいよ］：押した時刻で期日（`gsCaseDeadline`）→ 依頼が来たグループへ push 1回（textV2 のメンション＋ボタンなしのカード。retry key `case:<tid>`）→ `waiting-cases`（期限はそこから7日）。portal に `decide ok`。送れなければ手作業にして文面を下村さんへ。
- グループの文は町名（丁目まで）と建物名だけ。号室・番地・名前・REINS の番号は `gsSafeText` で止める。
- リマインド：期日を過ぎて、依頼のあとに貼られた PDF の控え（`gsatei:cases:<tid>`）が無ければ、グループに1回だけ「@山口さん 受付 G7 の事例はいかがでしょうか」と下村さんに1行。グループへは1件最大2回。
- PDF の取り出し・保存は 2e（まだ無い）。2d だけのあいだは、貼られた PDF を人が 02 に入れて［査定書を作る］を押す。
- ログは `[group-satei] gs prep sent G7`・`propose sent G7 r1`・`gy case-request posted G7`・`gf asked G7`・`fix revised G7 r2`・`remind sent G7`・`cases marked G7 1`（符号と受付番号だけ）。
- ファイル：`src/lib/group-satei-case.ts`（文・カード・検査）／`group-satei-propose.ts`（流れ）／`group-satei-prep-portal.ts`（portal の口）。
```

- [ ] **Step 2: 全体を確かめる**

Run:

```bash
for f in tests/group-satei-*.test.ts tests/satei-portal.test.ts tests/satei-webhook-order.test.ts tests/obi-cloud-tick.test.ts; do npx tsx "$f" > /dev/null || echo "FAIL $f"; done
npx tsc --noEmit -p .
```

Expected: `FAIL` の行が無い。`tsc` は何も出さない。

- [ ] **Step 3: コミット**

```bash
git add CLAUDE.md
git commit -m "docs: 段2d（事例の相談・山口さんへの依頼・リマインド）の動きを CLAUDE.md に書く

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: vault の進行ログに足す**

進行ログの一番上に「やったこと（2d の portal・Mac・aisecretary）・決まったこと（D1〜D18 の要点：案は aisecretary が取りに行く・グループへの依頼は aisecretary・portal は AppState の行・2b 後半は別）・残り（2b-2・2e・2f・本番の出し方）・次の一手（前提の確かめ：山口さんの userId・グループに入っているか・送信枠）」を足す。名前・ID は書かない（部屋番号の決まりと同じく、人は役割で書く）。

---

## 出す順番・止め方（承認後に別途。この計画では行わない）

1. portal：`feat/group-satei-2d` を origin/main に合わせて（5e94abc と重なりなし）レビュー → 下村さんの承認 → push・Railway の出し直し → `SATEI_PREP=1`。
2. Mac：`feature/satei-prep`（`feature/satei-area` の上）をレビュー → 承認 → 本体の checkout へ早送り（見張りが使っている場所なので、承認後の早送りだけ）→ Mac の env に `SATEI_PREP=1`。
3. aisecretary：`feat/group-satei-stage2`（2a・2b 前半・2d）をレビュー → 承認 → Vercel に `GROUP_SATEI_STAGE2=1`・`GROUP_SATEI_CASE_STAFF_ID` → 出し直し。
4. 本物の依頼で確かめる：グループの依頼 → 案件を選ぶ → 数分で案のカード → ［直す］1回 → ［いいよ］→ グループに山口さんあてのカード（メンションが効いているか・号室が出ていないか）→ 期日のあとリマインドが1回だけ。
- 止めるとき：aisecretary の `GROUP_SATEI_CASE_STAFF_ID` を外す（2a に戻る。出した［いいよ］［直す］は「止めています」）→ Mac の `SATEI_PREP` → portal の `SATEI_PREP`。

## 自己点検（設計との突き合わせ）

- 設計 §2 段7（相談［いいよ］［直す］）：A2（カード）・A5（押したとき・直しの1通）・A6（配達）。段8（山口さんへの依頼・期日にリマインド）：A5（依頼）・A6（リマインド）。
- §6.1：案の中身は M2（スキルの既定）、［直す］2回・3回目は手で：A5。§6.2：依頼が来たグループ・メンション・ボタンなし・名前／番号／号室／番地なし：A2・A5、`GROUP_SATEI_CASE_STAFF_ID`：A1、リマインド1回＋下村さんに1行・グループ最大2回：A6。
- §10 状態（gathering・proposing・waiting-cases、waiting-cases からさらに7日）：A1・A5。`asking-info`・`saving` は使う小段（2b-2・2e）で足す。
- §11 受け渡し：portal の `prep`（P1〜P3）、Mac の案（M1〜M4）、aisecretary（A3〜A6）。`/api/satei/propose`・`/api/satei/case-request` は D1・D2 で作らない。
- §12 スイッチと順番：Global Constraints・M1・M4・A1・P1・「出す順番」。§13 プライバシー・ログ：A2 の検査・D13・各タスクのログの形・portal に案件名を渡さない（A4 のテスト）。
- §14 失敗：公開データ（M3：skipped でも案を出す）・案の push（A6：2回まで）・グループへの依頼（A5：手で頼む案内＋文面）。事例の取り出し・保存は 2e。
- §16 決定 1・2・4：A5（依頼のグループ・期日）・D1（portal 経由）。§17 未確認：「前提」に書いた。
- R7（段1の控えは3時間・30件）：D8 の受付票ごとの集合（A6）で、PDF の有無をリマインドまで覚える。
