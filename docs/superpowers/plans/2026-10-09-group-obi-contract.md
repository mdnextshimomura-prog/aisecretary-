# グループからの帯替え：4つの計画の受け渡しの約束

設計書：`docs/superpowers/specs/2026-10-09-group-obi-intake-design.md`（この約束と食い違えば設計書が正）

計画は4本。実行の順番は P1 → P2 → P3 → P4（P2 は P1 の API、P3 は P1 の claim、P4 は P3 のトークンを使う）。
各計画は自分のリポジトリだけを変え、ほかの計画の中身はこの約束の形だけを頼りにする。

| 計画 | リポジトリ | ファイル |
|---|---|---|
| P1 portal | `apps/reins-report` | `2026-10-09-group-obi-p1-portal.md` |
| P2 MD NEXT秘書 | `apps/aisecretary` | `2026-10-09-group-obi-p2-aisecretary.md` |
| P3 Mac の LINE秘書（納品） | `apps/line-secretary`（`src/`） | `2026-10-09-group-obi-p3-deliver.md` |
| P4 閲覧ページ | `apps/line-secretary/delivery` | `2026-10-09-group-obi-p4-viewer.md` |

## 共通の値
- LINE の ID の形：userId `^U[0-9a-f]{32}$`、groupId `^C[0-9a-f]{32}$`
- `replyKind`：`'secretary' | 'line-group'`。`'secretary'` のとき `replyGroupId` は null。`'line-group'` のとき `replyGroupId` は groupId の形必須。ほかの組み合わせは拒否
- 合計の上限：25,000,000 バイト（10進）。件数の上限：20

## P1 が作り、P2 が使う：`POST {PORTAL_BASE_URL}/api/jobs/intake`
- ヘッダ：`x-job-token: <JOB_API_TOKEN>`（既存の鍵）
- 本文：`multipart/form-data`
  - `workflow`＝`obi`（必須・これだけ）
  - `lineMessageId`（必須・依頼の LINE メッセージ id。1〜64文字の数字）
  - `property`（必須・物件名、1〜100文字）
  - `requestText`（任意・〜1000文字）、`requestedBy`（任意・〜60文字）、`assigneeName`（任意）
  - `replyKind`（必須）、`replyGroupId`（`line-group` のとき必須）
  - `files`（1〜20個、出た順。各 PDF。ファイル名つき）
- 成功：201（新しく作った）／200（同じ `lineMessageId` の既存を照合して一致）
  ```json
  { "no": 12, "status": "下準備中", "created": true,
    "inputs": [ { "name": "a.pdf", "sha256": "<64桁16進>", "size": 123456 } ] }
  ```
  `inputs` は送られた順
- 失敗：`{ "code": string, "message": string, "busyJobNo"?: number }`
  | code | HTTP | 意味 |
  |---|---|---|
  | `UNAUTHORIZED` | 401 | 鍵が無い・違う |
  | `INVALID_REQUEST` | 400 | 項目の形が違う・`%PDF-` でない・件数が0か21以上 |
  | `INPUT_TOO_LARGE` | 413 | 1件40MiB超・合計25,000,000バイト超・本文が大きすぎる |
  | `INTAKE_DUPLICATE` | 400 | 同じ sha256 の PDF が2つ以上 |
  | `INTAKE_MISMATCH` | 409 | 同じ `lineMessageId` の既存 Job と中身（workflow・PDF の sha256 の集合と件数・replyKind・replyGroupId・property）が違う |
  | `OBI_BUSY` | 409 | 帯替えが取り込み中。`busyJobNo` に処理中の番号 |
  | `INTAKE_STOPPED` | 503 | 受付停止中 |
  | `INTERNAL` | 500 | それ以外 |
- 既存の `POST /api/jobs` の `OBI_BUSY` 応答にも `busyJobNo` を足す（ほかは変えない）

## P1 が作り、P3 が使う：納品の予約（claim）の応答
`POST /api/jobs/{no}/delivery/claim` の応答に2項目を足す（既存の項目は変えない）：
```json
{ "...既存": "...", "replyKind": "secretary", "replyGroupId": null }
```
今までの Job（項目の追加前に作られたもの）は `replyKind: 'secretary'`、`replyGroupId: null`

## P3 が作り、P4 が使う：配布トークンの印
- 既存の配布トークン（`line-secretary/src/dtoken.js` の `issue`。Ed25519 で JSON 全体に署名）の payload に、グループあてのときだけ2項目を足す：
  - `aud: "line-group"`
  - `g: "<groupId>"`（`^C[0-9a-f]{32}$`）
- 秘書室あて（今まで）のトークンには `aud`・`g` を付けない
- P4 の閲覧ページは：`aud` が無い → 今どおり名簿を見る／`aud === 'line-group'` かつ `g === 閲覧ページの LINE_GROUP_ID` → 名簿を省く（在籍は必ず見る）／それ以外（`aud` の値が違う・`g` が無い・形が違う・値が違う）→ 拒否
- `issue` の引数は `{ shelfId, driveFileId, sha256, ttlSec, now, aud?, g? }`。`aud` と `g` は両方そろえて渡すか、両方渡さないか

## P2 と P3 の間（直接のやり取りはない）
- P2 は portal に `replyKind: 'line-group'`・`replyGroupId: <営業部の groupId>` を付けて受付ける
- P3 は claim の応答の `replyKind`・`replyGroupId` を見て、グループにも送る
- 営業部の groupId：aisecretary では環境変数 `LINE_GROUP_ID`、line-secretary では `tools/line-send/宛先.json` の「営業部」の ID（`src/lineapp.js` が読む）。閲覧ページでは環境変数 `LINE_GROUP_ID`。3つとも同じ値（値は画面に出さない）
