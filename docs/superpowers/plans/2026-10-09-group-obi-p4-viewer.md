# グループあてリンクの閲覧・大きい PDF の分割受け渡し（P4 閲覧ページ）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 閲覧ページ（`apps/line-secretary/delivery`、Vercel `mdnext-doc-delivery`）で、①グループあての配布トークン（`aud: 'line-group'`・`g`）なら名簿の確認を省いて在籍だけで開けるようにし、②4,000,000 バイトを超え 50MiB までの PDF を「分けて渡す」（`viewId` と部分の取得、閲覧側で sha256 照合してから表示）ようにし、③大きい PDF には保存用の券を出さないようにする。

**Architecture:** 検証は今の 2 段（`lib/dtoken.js` が形と署名、`lib/gate.js` が本人確認・名簿・在籍・失効・監査）のまま、`dtoken.audienceOf()` で宛先の印を一か所で読み、gate が「名簿を見るか」を決める。分割は `/api/open` の中で行い、案内（`viewId`）を出すときに監査を 1 件だけ予約・確定し、部分の取得は毎回 gate を通したうえで（回数と監査の予約は省き、閲覧ごとの別枠の速さの上限と総数の上限をかける）Drive から範囲で取って 206・`Content-Range` を確かめてから返す。閲覧側は純粋な関数の `public/parts.mjs` で部分をつなぎ、`crypto.subtle` で全体の sha256 を配布トークンの `h` と照合してから描く。

**Tech Stack:** Node.js 20+（CommonJS、Vercel Functions）、`node:test` + `node:assert/strict`、`@upstash/redis`（テストは `test/fakes.js` の `memoryRedis`）、`googleapis`（Drive v3。テストは `fakeDrive`）、ブラウザ側は ES Modules（LIFF・pdf.js）。

**Spec:** `docs/superpowers/specs/2026-10-09-group-obi-intake-design.md`（aisecretary リポジトリ）の「決めたこと」18・19 と「影響する所 › 閲覧ページ」「確かめ方 › 閲覧ページ」。受け渡しの形は `docs/superpowers/plans/2026-10-09-group-obi-contract.md` の「P3 が作り、P4 が使う：配布トークンの印」。

**作業場所（実装時）：** `apps/line-secretary` の新しい worktree `/Users/shimo/AI開発/apps/line-secretary/.worktrees/group-obi-viewer`（ブランチ `feature/group-obi-viewer`）。**ブランチは P3 のブランチ `feature/group-obi-deliver` から作る**（`feature/v1` からではない）。P3 の Task 1 のコミット（`test/fixtures/dtoken-vector-group.json` を含む）が入っているのが前提で、無ければ止めて報告する。**launchd が動かしている本体の作業ツリー `/Users/shimo/AI開発/apps/line-secretary` のファイルは一切編集しない**（`git worktree add` によるメタ情報の追加だけ）。P3（同じリポジトリの `src/`）とは別の worktree で進め、P4 が変えるのは `delivery/` だけ（P3 のコミットは土台として含むが、P4 のコミットは `delivery/` の外を変えない）。本番へは `delivery/` だけを Vercel に出すので、P3 のコミットが一緒に出ることはない。

## Global Constraints

- LINE の ID の形：userId `^U[0-9a-f]{32}$`、groupId `^C[0-9a-f]{32}$`
- 配布トークンの印：`aud: "line-group"` と `g: "<groupId>"`。`aud` が無い → 今どおり名簿を見る／`aud === 'line-group'` かつ `g === 閲覧ページの LINE_GROUP_ID` → 名簿を省く（**在籍は必ず見る**）／それ以外（`aud` の値が違う・`g` が無い・形が違う・値が違う）→ 拒否
- 全体を返すのは PDF が **4,000,000 バイト以下**（固定値 `parts.WHOLE_MAX`。`deps.maxBytes`・`MAX_PDF_BYTES` 環境変数はこの判断・券の判断・`/api/dl` の上限のどれにも使わない）のとき（今どおり）。それより大きければ「分けて渡す」の案内。Drive の大きさ（メタ）が小さいと言っていても、実際の中身が 4,000,000 を超えた（またはメタに大きさが無く超えた）ときは、413 にせず中身の実際の長さで同じ案内を返す
- 部分の大きさ：**3,500,000 バイト**。分けて渡す上限：**50MiB（52,428,800 バイト）**。部分の数の上限は 15
- `viewId`：KV に **10 分**（600 秒）。トークンの `jti`・LINE の userId・ファイル（driveFileId・sha256）・部分の数に結び付ける
- 1 つの部分は 1 つの `viewId` の中で **合計 3 回まで**。これとは別に速さの上限 **1 分あたり「部分の数×2」回**
- 部分の取得では毎回、トークン（期限切れなら拒否）・ログイン（IDトークン）・名簿（必要なとき）・**グループ在籍（キャッシュしない）**・失効を確かめる。`viewId` の無い部分の取得は拒否。`Cache-Control: no-store`
- 監査は 1 回の閲覧＝1 件（案内を出すとき）。部分の取得は成功も拒否（名簿に無い・在籍なし・期限切れ・失効・viewId 不正など）も、監査を 1 件も書かない（`decide` の `audit: false`）
- 閲覧側は全体の sha256 をトークンの `h` と照合してから表示。合わなければ表示しない。部分の取得に失敗したら、その部分だけ 3 回まで取り直す
- 保存（`mode: "ticket"`）は全体が 4,000,000 バイト（固定値）以下と分かったときだけ。**券を出す前に** Drive の大きさを確かめ、大きいときは券を出さず、画面に「大きいためこの画面でご覧ください」。大きさが読めない（size が無い）ときも券を出さない（`retry`）
- Drive の範囲取得は 206 と `Content-Range`（start・end・全体の長さ）を確かめてから使う（Codex 残件 d）
- 本文・トークン・鍵・viewId はログに出さない（今の方針どおり。console には理由コードと ref だけ）
- 新しい環境変数は足さない（`LINE_GROUP_ID` は既存のもの）。本番の環境変数の値は画面に出さない
- 本番反映（P4 のブランチの worktree で `cd delivery && vercel deploy --prod`）は **下村さんの承認の後**。この計画のタスクには含めない。全体の順番は P1 → P4 → P3 → P2
- テストのコマンドに `| tail` などのパイプは付けない（終了コードが隠れて失敗を見逃すため）
- コミットは `type(delivery): 日本語`、最後の行に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

---

## ファイルの地図

| ファイル | 役割 | 変更 |
|---|---|---|
| `delivery/lib/dtoken.js` | 配布トークンの検証。`audienceOf()` で宛先の印を読む | 変更 |
| `delivery/lib/gate.js` | 渡してよいかの判定。印に応じて名簿を省く。部分の取得用に「回数・監査の予約を省く」指定 | 変更 |
| `delivery/lib/drive.js` | Drive。`statPdf`（大きさだけ）・`fetchRange`（範囲で取り 206/Content-Range を確かめる）・`createDrive().range` | 変更 |
| `delivery/lib/parts.js` | 分割の定数と計算（部分の数・範囲・閲覧の記録の形） | 新規 |
| `delivery/lib/kv.js` | `viewPut`・`viewGet`・`viewPartHit` | 変更 |
| `delivery/lib/errors.js` | `slow`（429）・`reopen`（410）を足す | 変更 |
| `delivery/api/open.js` | 券の前の大きさ確認・分けて渡す案内（メタが小さくても中身が大きければ案内）・部分の取得 | 変更 |
| `delivery/api/dl.js` | 保存の受け取り。上限を `deps.maxBytes` から固定の `parts.WHOLE_MAX` に変える | 変更 |
| `delivery/public/parts.mjs` | 閲覧側：部分をつなぐ・取り直し・sha256 照合（純粋な関数） | 新規 |
| `delivery/public/app.js` | 案内を受けたら `parts.mjs` で組み立てて描く。保存の「大きい」案内 | 変更 |
| `delivery/test/signtoken.js` | テスト用：任意の項目（aud・g など）で配布トークンを署名 | 新規 |
| `delivery/test/fakes.js` | `fakeDrive` に `range` を足す | 変更 |
| `delivery/test/dtoken.test.js` | 印の読み方・`bad-aud` | 変更 |
| `delivery/test/gate-aud.test.js` | 印の有無・値違いでの名簿・拒否、回数/監査を省く指定 | 新規 |
| `delivery/test/drive.test.js` | `statPdf`・`fetchRange` | 変更 |
| `delivery/test/parts.test.js` | `lib/parts.js` | 新規 |
| `delivery/test/kv.test.js`・`errors.test.js` | 新しい KV 関数・コード | 変更 |
| `delivery/test/open.test.js` | 券の前の大きさ確認・50MiB 超 | 変更 |
| `delivery/test/dl.test.js` | 上限が固定であること（`maxBytes` に依らない）。券を直接置いて大きい中身を試す | 変更 |
| `delivery/test/open-parts.test.js` | 案内と部分の取得 | 新規 |
| `delivery/test/parts-client.test.js` | 閲覧側の組み立て（サーバの `handle` とつないだ通し試験を含む） | 新規 |
| `delivery/test/app.test.js` | `app.js` の配線の確認 | 新規 |

`delivery/api/dl.js` は **上限だけ** 変える（`deps.maxBytes` → 固定の `parts.WHOLE_MAX`）。券を出すかどうかは `api/open.js` の `mode: "ticket"` で決まり、`dl.js` は実際のバイト数で 4,000,000 を超えれば `too-large` を返す二重の守りとして残る。`MAX_PDF_BYTES` 環境変数は `open.js`・`dl.js` のどちらの判断にも使わなくなる（`lib/deps.js` の `maxBytes` は残るが参照されない。今回は触らない）。

## 判断したこと（設計書で決め切っていなかった点）

1. 全体を返す境目・券を出す境目・`/api/dl` のバイト上限は、すべて設計書の固定値 **4,000,000 バイト**（`parts.WHOLE_MAX`）で、`deps.maxBytes`（`MAX_PDF_BYTES` 環境変数）は使わない。Vercel の `MAX_PDF_BYTES` がどんな値でも境目は動かない（大きい値でも 4,000,000 を超えるものは全体で返さず、券も出さず、`/api/dl` も返さない。小さい値でも 4,000,000 以下は今どおり全体で返す）。`MAX_PDF_BYTES` は不使用になる（Vercel に入っていても無害）
1a. Drive のメタが小さい（または大きさが無い）のに実際の中身が 4,000,000 を超えたときは、413 にせず、取れた中身の実際の長さ（`fetchPdf` が `too-large` と一緒に返す `size`）を大きさとして、メタが大きいときと同じ「分けて渡す」案内を返す（50MiB を超えれば `too-large`）。以後の部分の取得は `fetchRange` が Content-Range の全体の長さを案内の大きさと照合するので、案内の後にファイルが変わっても `size-changed` で止まる。追加の仕組みは持たない（案内の判断に使うのは実際に取れた長さだけ）
2. 速さの上限を超えたときは新しいコード `slow`（429）。閲覧側は待って取り直し、**3 回の回数に数えない**（サーバ側も、速さの判定は総数のカウントより前に行うので総数に数えない）。総数の上限を超えたときは新しいコード `reopen`（410、「もう一度開いてください」）
3. 部分の取得では gate の IP・トークン・人ごとの回数（30/60/20 回/分）を使わず、閲覧ごとの別枠（部分の数×2/分）に置き換える（`viewId` は認証済みの人にだけ出す 192 ビットの乱数で、KV に無ければ gate より前で拒否するため）。監査の予約も省き、拒否の記録（`denied`）も一切書かない（`decide(…, { rate: false, reserve: false, audit: false })`）。拒否の理由はログ（console）にだけ残る
4. `aud`・`g` の形の違いは `dtoken.verify` が `bad-aud`（gate では `bad-token` と同じ一様な拒否）。形は正しいが `g` が閲覧ページのグループと違うものは gate の回数の確認の後で `bad-audience`（★ALERT）の一様な拒否
5. 券の前の大きさ確認で Drive の大きさが読めないとき（size が無い）は **券を出さず** 503 `retry`（監査は `denied`・`ticket-no-size`）。大きさの分からないものに券を出すと、分けて渡す対象の資料に保存の道ができてしまうため。全体を返す経路で size が無いときは今どおり実際のバイト数で確かめる
6. 分けて渡した資料では保存ボタンを出さず、ページ数の横に「大きい資料のため保存はできません。この画面でご覧ください」と出す。サーバ側も券を出さない（二重）
7. テストのトークンは `test/signtoken.js` で作る（Mac 側 `src/dtoken.js` の `_signRaw` を使う）。印の有無・値違い・形違いを自由に作れるようにするため。これとは別に、P3 が固定した互換ベクトル `test/fixtures/dtoken-vector-group.json`（P3 の本物の `issue` が作ったグループあてトークン）を閲覧ページの `verify`・`audienceOf` で読む試験を **必須** で置く（skip しない。P4 のブランチは P3 のブランチから作るので、ファイルは必ずある。無ければ試験は失敗し、P3 が入っていないことに気づける）
8. 本番反映の順番：**P4 を先に反映してから**、P3（Mac 側が `aud` 付きのトークンを出す）を本番で動かす。逆だと古い閲覧ページは `aud` を無視して名簿を見るので、名簿に無いグループの人が開けない（危険側ではないが、設計 5 が満たせない）

---

### Task 1: 配布トークンの宛先の印を読む（`dtoken.audienceOf` と `verify` の `bad-aud`）

**Files:**
- Create: `delivery/test/signtoken.js`
- Modify: `delivery/lib/dtoken.js:5-10`（定数）、`:36-49`（`verify`）、`:82`（exports）
- Test: `delivery/test/dtoken.test.js`

**Interfaces:**
- Consumes: Mac 側 `src/dtoken.js` の `generateKeyPair()`・`_signRaw(prefix, body, privateKeyPem)`・`TOKEN_PREFIX`（既存）
- Produces:
  - `dtoken.audienceOf(payload) → { kind: "roster" } | { kind: "line-group", g: string } | { kind: "bad" }`
  - `dtoken.verify(d, opts)` は、印の形が違えば `{ ok: false, reason: "bad-aud" }`（期限の判定より先）
  - `dtoken.AUD_LINE_GROUP === "line-group"`
  - テスト用 `require("./signtoken.js")`：`keyPair() → { privateKeyPem, publicKeyPem }`、`signToken(fields, { privateKeyPem, kid? }) → string`、`issueWith({ shelfId?, driveFileId?, sha256, now, ttlSec?, extra? }, kp, kid?) → { d, jti }`（kid の既定は `"k1"`）

- [ ] **Step 0: worktree を作り、今のテストが通ることを確かめる**

```bash
cd /Users/shimo/AI開発/apps/line-secretary
git worktree add .worktrees/group-obi-viewer -b feature/group-obi-viewer feature/group-obi-deliver
cd .worktrees/group-obi-viewer
test -f test/fixtures/dtoken-vector-group.json && echo FIXTURE-OK
cd delivery
npm test
```
Expected: `FIXTURE-OK` が出る（出なければ P3 の Task 1 が入っていない。ここで止めて報告し、先へ進まない）。`npm test` は `ℹ fail 0`。以下のコマンドはすべて `/Users/shimo/AI開発/apps/line-secretary/.worktrees/group-obi-viewer/delivery` で実行する。

- [ ] **Step 1: テスト用の署名の部品を作る**

`delivery/test/signtoken.js`:

```js
// テスト用：任意の項目で配布トークンを署名する（Mac 側 src/dtoken.js の署名の部品をそのまま使う）。
// グループあての印（aud・g）は P3（Mac 側 issue）で足されるが、閲覧ページのテストはそれを待たずに、
// 印の有無・値違い・形違いを自由に作れるようにここで作る。*.test.js ではないので単体では走らない
const crypto = require("crypto");
const dtokenMac = require("../../src/dtoken.js");

function keyPair() {
  return dtokenMac.generateKeyPair();
}

function signToken(fields, { privateKeyPem, kid = "k1" }) {
  const body = Buffer.from(JSON.stringify({ v: 1, kid, ...fields }), "utf8").toString("base64url");
  return `${body}.${dtokenMac._signRaw(dtokenMac.TOKEN_PREFIX, body, privateKeyPem)}`;
}

// Mac 側 issue と同じ項目（jti・s・f・h・i・e）に extra（aud・g など）を足して署名する
function issueWith({ shelfId = "s1", driveFileId = "F1", sha256, now, ttlSec = 86400, extra = {} }, kp, kid = "k1") {
  const i = Math.floor(now / 1000);
  const jti = crypto.randomBytes(8).toString("hex");
  const d = signToken({ jti, s: shelfId, f: driveFileId, h: sha256, i, e: i + ttlSec, ...extra }, { privateKeyPem: kp.privateKeyPem, kid });
  return { d, jti };
}

module.exports = { keyPair, signToken, issueWith };
```

- [ ] **Step 2: 失敗するテストを書く**

`delivery/test/dtoken.test.js` の末尾に足す:

```js
const { keyPair, issueWith } = require("./signtoken.js");

const G = "C" + "1".repeat(32);

test("audienceOf: 印なし → roster。aud=line-group と正しい形の g → line-group。それ以外 → bad", () => {
  assert.deepEqual(dtoken.audienceOf({ jti: "x" }), { kind: "roster" });
  assert.deepEqual(dtoken.audienceOf({ aud: "line-group", g: G }), { kind: "line-group", g: G });
  const bad = [
    { aud: "line-group" },
    { g: G },
    { aud: "secretary", g: G },
    { aud: "line-group", g: "C123" },
    { aud: "line-group", g: "U" + "1".repeat(32) },
    { aud: "line-group", g: "C" + "A".repeat(32) },
    { aud: null },
    { aud: "line-group", g: null },
    { aud: "line-group", g: G + "\n" },
  ];
  for (const p of bad) assert.equal(dtoken.audienceOf(p).kind, "bad", JSON.stringify(p));
  assert.equal(dtoken.audienceOf(null).kind, "bad");
});

test("verify: 印が正しければ通り、payload に aud・g が残る。印の形が違えば bad-aud（期限切れより先に言う）", () => {
  const kp = keyPair();
  const keys = { k1: kp.publicKeyPem };
  const now = Date.UTC(2026, 9, 9, 3, 0, 0);
  const good = issueWith({ sha256: "a".repeat(64), now, extra: { aud: "line-group", g: G } }, kp);
  const r = dtoken.verify(good.d, { publicKeys: keys, now });
  assert.equal(r.ok, true);
  assert.equal(r.payload.aud, "line-group");
  assert.equal(r.payload.g, G);
  for (const extra of [{ aud: "line-group" }, { g: G }, { aud: "x", g: G }, { aud: "line-group", g: "Cxyz" }]) {
    const t = issueWith({ sha256: "a".repeat(64), now, extra }, kp);
    assert.equal(dtoken.verify(t.d, { publicKeys: keys, now }).reason, "bad-aud", JSON.stringify(extra));
    assert.equal(dtoken.verify(t.d, { publicKeys: keys, now: now + 90000 * 1000 }).reason, "bad-aud", "期限切れでも形の違いを先に言う");
  }
  // 印なし（今までのトークン）は今どおり通る
  const plain = issueWith({ sha256: "a".repeat(64), now }, kp);
  assert.equal(dtoken.verify(plain.d, { publicKeys: keys, now }).ok, true);
});

test("互換（必須）：P3 が固定したグループあてトークンのベクトルを、閲覧ページが line-group と読む", () => {
  const fsx = require("fs");
  const pathx = require("path");
  // P3 の test/fixtures（line-secretary の直下）。P4 のブランチは feature/group-obi-deliver から作るので必ずある。skip しない
  const p = pathx.join(__dirname, "..", "..", "test", "fixtures", "dtoken-vector-group.json");
  assert.ok(fsx.existsSync(p), `P3 の互換ベクトルが無い（P4 のブランチは feature/group-obi-deliver から作る）: ${p}`);
  const raw = fsx.readFileSync(p, "utf8");
  assert.doesNotMatch(raw, /PRIVATE/, "秘密鍵が入っていてはいけない");
  const v = JSON.parse(raw);
  assert.equal(v.aud, "line-group");
  const r = dtoken.verify(v.d, { publicKeys: { [v.kid]: v.publicKeyPem }, now: v.now + 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.payload.jti, v.jti);
  assert.equal(r.payload.aud, "line-group");
  assert.equal(r.payload.g, v.g);
  assert.deepEqual(dtoken.audienceOf(r.payload), { kind: "line-group", g: v.g });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `node --test test/dtoken.test.js`
Expected: FAIL（`dtoken.audienceOf is not a function`、`bad-aud` の比較で `undefined !== 'bad-aud'` など）。互換の試験は必須（ベクトルが無ければ失敗する。skip はしない）。

- [ ] **Step 4: 実装する**

`delivery/lib/dtoken.js` の定数（5〜10 行）の後に足す:

```js
const AUD_LINE_GROUP = "line-group";
const GROUP_ID = /^C[0-9a-f]{32}$/;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// 宛先の印（設計 18）。aud も g も無い → 今までのトークン（名簿を見る）。
// aud が "line-group" で g が groupId の形 → グループあて（g が閲覧ページのグループと一致するかは gate が見る）。
// 片方だけ・値が違う・形が違う → bad（拒否）
function audienceOf(p) {
  if (!p || typeof p !== "object") return { kind: "bad" };
  if (!has(p, "aud") && !has(p, "g")) return { kind: "roster" };
  if (p.aud === AUD_LINE_GROUP && typeof p.g === "string" && GROUP_ID.test(p.g)) return { kind: "line-group", g: p.g };
  return { kind: "bad" };
}
```

`verify`（36〜49 行）の項目の検査の直後（`return { ok: false, reason: "bad-fields" };` の閉じ括弧の次の行）に足す:

```js
  // 印の形の違いは、期限の判定より先に言う（期限切れの読み直し peek の側でも gate が同じ関数で見る）
  if (audienceOf(p).kind === "bad") return { ok: false, reason: "bad-aud" };
```

exports（82 行）を次に置き換える:

```js
module.exports = { verify, verifyAdmin, peek, parsePublicKeys, audienceOf, TOKEN_PREFIX, ADMIN_PREFIX, MAX_TTL_SEC, AUD_LINE_GROUP };
```

ファイル先頭の説明（1〜2 行）の後に 1 行足す:

```js
// グループあての印（aud・g）は 2026-10-09 の設計 18。印の無いトークンは今までどおり
```

- [ ] **Step 5: 通ることを確かめる**

Run: `node --test test/dtoken.test.js && npm test`
Expected: dtoken の全件 PASS（互換の試験も PASS。skipped は 0）。全体も `ℹ fail 0`。

- [ ] **Step 6: Commit**

```bash
git add delivery/lib/dtoken.js delivery/test/dtoken.test.js delivery/test/signtoken.js
git commit -m "$(cat <<'EOF'
feat(delivery): 配布トークンのグループあての印（aud・g）を読み、形の違うものは通さない

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: gate がグループあての印で名簿を省き、値の違う印を拒否する。部分の取得用の指定

**Files:**
- Modify: `delivery/lib/gate.js:10-98`（`decide`）
- Test: `delivery/test/gate-aud.test.js`（新規）

**Interfaces:**
- Consumes: Task 1 の `dtoken.audienceOf`、`test/signtoken.js` の `keyPair`・`issueWith`
- Produces:
  - `decide({ d, idToken, ip }, deps, opts?)`。`opts.rate === false` で IP・トークン・人ごとの回数を数えない。`opts.reserve === false` で監査の予約をしない（`auditId: null`）。`opts.audit === false` で **拒否の記録（`denyWith`・`authedWith` の `auditWrite`）も書かない**（部分の取得用。1 閲覧 1 件を守る）。既定は今どおり
  - allow のとき `{ allow: true, payload, userId, auditId, ref, audience: "roster" | "line-group" }`
  - 拒否の理由（log.reason）に `bad-audience`（★alert）を足す
  - 監査の予約の行に、グループあてのときだけ `aud: "line-group"`

- [ ] **Step 1: 失敗するテストを書く**

`delivery/test/gate-aud.test.js`:

```js
// グループあての印（aud・g）での判定（設計 18）と、部分の取得用の指定（回数・監査の予約を省く。設計 19）
const test = require("node:test");
const assert = require("node:assert/strict");
const { decide } = require("../lib/gate.js");
const { createKv } = require("../lib/kv.js");
const { memoryRedis, fakeFetch } = require("./fakes.js");
const { keyPair, issueWith } = require("./signtoken.js");

const U = "U" + "c".repeat(32);
const GROUP = "C" + "1".repeat(32);
const OTHER = "C" + "2".repeat(32);
const NOW = Date.UTC(2026, 9, 9, 3, 0, 0);
const TOK = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.sig";
const SHA = "b".repeat(64);
const kp = keyPair();
const DENIED = { status: 403, body: { ok: false, code: "denied" } };

function setup({ extra = {}, roster = [], member = { status: 200, body: { userId: U, displayName: "架空" } }, tokenNow = NOW } = {}) {
  const redis = memoryRedis();
  const kv = createKv(redis);
  const { d, jti } = issueWith({ sha256: SHA, now: tokenNow, extra }, kp);
  const f = fakeFetch([
    { match: "/oauth2/v2.1/verify", status: 200, body: { iss: "https://access.line.me", sub: U, aud: "2011726489", exp: Math.floor(NOW / 1000) + 3000, iat: Math.floor(NOW / 1000) - 60 } },
    { match: "/member/", ...member },
  ]);
  const deps = { publicKeys: { k1: kp.publicKeyPem }, channelId: "2011726489", groupId: GROUP, botToken: "tok", kv, fetchImpl: f, now: NOW };
  return { deps, kv, redis, f, d, jti, ready: (async () => { for (const u of roster) await kv.rosterAdd(u, "x"); })() };
}
const lineGroup = (g = GROUP) => ({ aud: "line-group", g });
const memberCalls = (s) => s.f.calls.filter((c) => c.url.includes("/member/")).length;

test("印なし（今までのトークン）は今どおり名簿を見る：名簿に無ければ denied（在籍は聞かない）", async () => {
  const s = setup({ roster: [] }); await s.ready;
  const r = await decide({ d: s.d, idToken: TOK, ip: "1.2.3.4" }, s.deps);
  assert.deepEqual(r.response, DENIED);
  assert.equal(r.log.reason, "not-in-roster");
  assert.equal(memberCalls(s), 0);
});

test("グループあて（g が一致）は名簿に無くても、在籍していれば allow。監査の予約に aud が残る", async () => {
  const s = setup({ extra: lineGroup(), roster: [] }); await s.ready;
  const r = await decide({ d: s.d, idToken: TOK, ip: "1.2.3.4" }, s.deps);
  assert.equal(r.allow, true);
  assert.equal(r.audience, "line-group");
  assert.equal(r.userId, U);
  assert.equal(memberCalls(s), 1, "在籍は必ず聞く");
  const list = await s.kv.auditList(5);
  assert.equal(list[0].result, "reserved");
  assert.equal(list[0].aud, "line-group");
});

test("グループあてでも、在籍していなければ denied（not-member）", async () => {
  const s = setup({ extra: lineGroup(), roster: [U], member: { status: 404, body: {} } }); await s.ready;
  const r = await decide({ d: s.d, idToken: TOK, ip: "1.2.3.4" }, s.deps);
  assert.deepEqual(r.response, DENIED);
  assert.equal(r.log.reason, "not-member");
});

test("g が閲覧ページのグループと違えば、名簿に居ても denied（bad-audience・ALERT）。LINE には聞かない", async () => {
  const s = setup({ extra: lineGroup(OTHER), roster: [U] }); await s.ready;
  const r = await decide({ d: s.d, idToken: TOK, ip: "1.2.3.4" }, s.deps);
  assert.deepEqual(r.response, DENIED);
  assert.equal(r.log.reason, "bad-audience");
  assert.equal(r.log.alert, true);
  assert.equal(s.f.calls.length, 0);
});

test("印の形が違う（aud の値違い・g 無し・g だけ・g の形違い）は名簿に居ても denied（bad-token）", async () => {
  for (const extra of [{ aud: "secretary", g: GROUP }, { aud: "line-group" }, { g: GROUP }, { aud: "line-group", g: "C123" }]) {
    const s = setup({ extra, roster: [U] }); await s.ready;
    const r = await decide({ d: s.d, idToken: TOK, ip: "1.2.3.4" }, s.deps);
    assert.deepEqual(r.response, DENIED, JSON.stringify(extra));
    assert.equal(r.log.reason, "bad-token", JSON.stringify(extra));
    assert.equal(s.f.calls.length, 0);
  }
});

test("期限切れのグループあて：g が一致して在籍なら expired（410）。g が違えば denied", async () => {
  const old = NOW - 90000 * 1000;
  const s = setup({ extra: lineGroup(), roster: [], tokenNow: old }); await s.ready;
  const r = await decide({ d: s.d, idToken: TOK, ip: "1.2.3.4" }, s.deps);
  assert.equal(r.response.status, 410);
  assert.equal(r.response.body.code, "expired");
  const w = setup({ extra: lineGroup(OTHER), roster: [U], tokenNow: old }); await w.ready;
  const r2 = await decide({ d: w.d, idToken: TOK, ip: "1.2.3.4" }, w.deps);
  assert.deepEqual(r2.response, DENIED);
  assert.equal(r2.log.reason, "bad-audience");
});

test("部分の取得用（rate:false・reserve:false）：回数を数えず、監査の予約もしない。在籍と失効は見る", async () => {
  const s = setup({ roster: [U] }); await s.ready;
  const r = await decide({ d: s.d, idToken: TOK, ip: "1.2.3.4" }, s.deps, { rate: false, reserve: false });
  assert.equal(r.allow, true);
  assert.equal(r.auditId, null);
  assert.equal((await s.kv.auditList(5)).length, 0);
  assert.equal([...s.redis._store.keys()].filter((k) => k.startsWith("rl:ip:") || k.startsWith("rl:jti:") || k.startsWith("rl:user:")).length, 0);
  assert.equal(memberCalls(s), 1);
  await s.kv.revokeJti(s.jti);
  const r2 = await decide({ d: s.d, idToken: TOK, ip: "1.2.3.4" }, s.deps, { rate: false, reserve: false });
  assert.equal(r2.response.status, 409);
  assert.equal(r2.response.body.code, "replaced");
});

test("部分の取得用（audit:false）：どの拒否の経路でも監査を 1 件も書かない。既定（指定なし）は今どおり書く", async () => {
  const opts = { rate: false, reserve: false, audit: false };
  const cases = [
    ["not-member", setup({ roster: [U], member: { status: 404, body: {} } })],
    ["bad-audience", setup({ extra: lineGroup(OTHER), roster: [U] })],
    ["not-in-roster", setup({ roster: [] })],
    ["expired", setup({ roster: [U], tokenNow: NOW - 90000 * 1000 })],
  ];
  for (const [reason, s] of cases) {
    await s.ready;
    const r = await decide({ d: s.d, idToken: TOK, ip: "1.2.3.4" }, s.deps, opts);
    assert.equal(r.allow, false, reason);
    assert.equal(r.log.reason, reason);
    assert.equal((await s.kv.auditList(5)).length, 0, `${reason}: 部分の取得では拒否も監査に書かない`);
  }
  const rv = setup({ roster: [U] }); await rv.ready;
  await rv.kv.revokeJti(rv.jti);
  const r2 = await decide({ d: rv.d, idToken: TOK, ip: "1.2.3.4" }, rv.deps, opts);
  assert.equal(r2.log.reason, "revoked");
  assert.equal((await rv.kv.auditList(5)).length, 0);
  // 対照：指定なしなら同じ拒否が 1 件書かれる
  const d0 = setup({ roster: [U], member: { status: 404, body: {} } }); await d0.ready;
  await decide({ d: d0.d, idToken: TOK, ip: "1.2.3.4" }, d0.deps);
  assert.equal((await d0.kv.auditList(5)).length, 1);
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/gate-aud.test.js`
Expected: FAIL（グループあてが `not-in-roster` で拒否される、`r.audience` が undefined、`bad-audience` が無い、`auditId` が null でない、`audit:false` でも拒否の監査が 1 件書かれる など）

- [ ] **Step 3: 実装する**

`delivery/lib/gate.js` の `decide`（10〜98 行）を次に置き換える（ファイル先頭の require と `DEFAULT_LIMITS`・exports はそのまま）:

```js
// opts.rate === false：IP・トークン・人ごとの回数を数えない（部分の取得。閲覧ごとの別枠で数える。設計 19）
// opts.reserve === false：監査の予約をしない（部分の取得。監査は案内のときの 1 件だけ）
// opts.audit === false：拒否の記録も書かない（部分の取得。名簿に無い・在籍なし・期限切れ・失効などの拒否でも監査は増やさない）
async function decide({ d, idToken, ip }, deps, opts = {}) {
  const { publicKeys, channelId, groupId, botToken, kv, fetchImpl = fetch, now = Date.now() } = deps;
  const limits = { ...DEFAULT_LIMITS, ...(deps.limits || {}) };
  const useRate = opts.rate !== false;
  const reserve = opts.reserve !== false;
  const writeAudit = opts.audit !== false;
  const at = new Date(now).toISOString();
  const ref = errors.newRef();
  // 拒否の記録はIPごとに絞る：本人確認すら通らない拒否(bad-token・rate-limited)は
  // 誰でも大量に起こせるので監査に残さない。それ以外の拒否も、同じIPから1時間に5件までしか残さない
  // （未認証の攻撃者が監査インデックスを溢れさせたりKVを無制限に太らせたりできないようにする）
  const shouldAudit = async (reason) => {
    if (!writeAudit) return false;
    if (reason === "bad-token" || reason === "rate-limited") return false;
    // このカウンタ自体が read できない(KV障害)ときは、記録を諦めて応答は普通に返す。
    // auditWrite が best-effort なのと同じで、その手前のゲートも best-effort でなければならない
    try {
      return await kv.rateHit("auditdeny", ip || "-", 5, 3600);
    } catch {
      return false;
    }
  };
  const denyWith = async (reason, extra = {}) => {
    if (await shouldAudit(reason)) await kv.auditWrite({ at, result: "denied", reason, ref, ...extra });
    return { allow: false, response: errors.deny(), log: { reason, ...extra } };
  };
  const authedWith = async (code, reason, extra = {}) => {
    if (await shouldAudit(reason)) await kv.auditWrite({ at, result: "denied", reason, ref, ...extra });
    return { allow: false, response: errors.authed(code, ref), log: { reason, ...extra } };
  };

  // ① 配布トークン(ローカルで検証。期限切れだけは後で言う)
  const tv = dtoken.verify(d, { publicKeys, now });
  let expired = false;
  if (!tv.ok) {
    if (tv.reason !== "expired") return denyWith("bad-token");
    expired = true;
  }
  // 期限切れでも中身(jti・資料)は要るので、署名だけ確かめた payload を読む
  const payload = tv.ok ? tv.payload : dtoken.peek(d, publicKeys);
  if (!payload) return denyWith("bad-token");
  // 期限切れの読み直し(peek)は項目の形を見ないので、宛先の印の形はここでも確かめる
  const aud = dtoken.audienceOf(payload);
  if (aud.kind === "bad") return denyWith("bad-token");

  // ② 回数(IP・トークン)
  if (useRate) {
    if (!(await kv.rateHit("ip", ip || "-", limits.ip, limits.windowSec))) return denyWith("rate-limited");
    if (!(await kv.rateHit("jti", payload.jti, limits.jti, limits.windowSec))) return denyWith("rate-limited");
  }

  // ②' 宛先の印(設計 18)。グループあては、この閲覧ページのグループ(LINE_GROUP_ID)と完全一致したときだけ。
  // 署名は正しいのに宛先が違う＝発行側の誤りか持ち出しなので ALERT
  if (aud.kind === "line-group" && aud.g !== groupId) return denyWith("bad-audience", { alert: true });

  // ③ IDトークン
  const idv = await verifyIdToken(idToken, { channelId, fetchImpl, now });
  if (!idv.ok) return denyWith("bad-idtoken");
  const userId = idv.userId;
  if (useRate && !(await kv.rateHit("user", userId, limits.user, limits.windowSec))) return denyWith("rate-limited", { userId });

  // ④ 名簿(グループあての印があるときだけ省く。在籍は ⑤ で必ず見る)
  if (aud.kind === "roster" && !(await kv.inRoster(userId))) return denyWith("not-in-roster", { userId });

  // ⑤ 在籍(キャッシュしない。失敗しても名簿だけで通さない)
  const m = await membership.check(userId, { groupId, botToken, fetchImpl });
  if (m.status === "not-member") return denyWith("not-member", { userId });
  if (m.status === "retry") return authedWith("retry", "membership-retry", { userId });
  if (m.status !== "member") return denyWith("membership-error", { userId, alert: true, detail: m.detail });

  // ⑥ 失効台帳(読めなければ渡さない)
  let stopped, epoch, revJti, shelfAt, revUser;
  try {
    [stopped, epoch, revJti, shelfAt, revUser] = await Promise.all([
      kv.isStopped(), kv.epoch(), kv.isRevokedJti(payload.jti), kv.shelfRevokedAt(payload.s), kv.isRevokedUser(userId),
    ]);
  } catch {
    return authedWith("retry", "audit-error", { userId });
  }
  // 台帳の値が壊れていたら(数値になっていない)、読めなかったのと同じ扱いにする。開けたままにしない
  if (!Number.isFinite(epoch) || (shelfAt != null && !Number.isFinite(shelfAt))) {
    return authedWith("retry", "audit-error", { userId });
  }
  // revoke.user で止めた人は「もう渡さない相手」なので、名簿に無い人と同じ一様な拒否にする。
  // 停止中・差し替えといった事情も伝えない（理由はログと監査にだけ revoked で残す）
  if (revUser) return denyWith("revoked", { userId });
  if (stopped) return authedWith("stopped", "stopped", { userId });
  if (epoch >= payload.i || revJti || (shelfAt != null && shelfAt >= payload.i)) {
    return authedWith("replaced", "revoked", { userId });
  }
  if (expired) return authedWith("expired", "expired", { userId });

  if (!reserve) return { allow: true, payload, userId, auditId: null, ref, audience: aud.kind };

  // ⑦ 監査の予約(書けなければ渡さない)
  let auditId;
  try {
    auditId = await kv.auditReserve({ at, userId, shelfId: payload.s, jti: payload.jti, ref, ...(aud.kind === "line-group" ? { aud: "line-group" } : {}) });
  } catch {
    // 予約が書けなくても、拒否の記録は best-effort で残す(refを追跡可能にする)
    return authedWith("retry", "audit-error", { userId });
  }
  return { allow: true, payload, userId, auditId, ref, audience: aud.kind };
}
```

ファイル先頭の 1 行目の説明の後に足す:

```js
// 名簿(④)は、グループあての印(aud・g がこの閲覧ページのグループと一致)のときだけ省く(2026-10-09 設計 18)
```

- [ ] **Step 4: 通ることを確かめる**

Run: `node --test test/gate-aud.test.js test/gate.test.js && npm test`
Expected: 両方 PASS（既存の gate.test.js は変更なしで通る）。全体 `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add delivery/lib/gate.js delivery/test/gate-aud.test.js
git commit -m "$(cat <<'EOF'
feat(delivery): グループあての印が一致すれば名簿を省き在籍だけで通す。違う印は拒否する。部分の取得用に拒否の監査も省ける

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Drive の大きさだけ取る・範囲で取って 206/Content-Range を確かめる

**Files:**
- Modify: `delivery/lib/drive.js:1-4`（説明）、`:9-18`（`createDrive` に `range`）、`:27-49`（`fetchPdf` を `statPdf` に分ける・`fetchRange`・exports）
- Modify: `delivery/test/fakes.js:48-62`（`fakeDrive` に `range`）
- Test: `delivery/test/drive.test.js`

**Interfaces:**
- Produces:
  - `statPdf(fileId, { drive }) → { ok: true, size: number | null, name: string } | { ok: false, reason: "not-found" | "trashed" | "drive-error" }`（size が読めなければ null）
  - `fetchPdf(fileId, { drive, maxBytes, stat? })`：`stat` を渡せば meta を読み直さない。戻り値は今どおり。ただし `too-large` のときは取れた大きさ `size` も付ける（`{ ok: false, reason: "too-large", size }`。メタで分かったときはメタの値、中身を取ったあとは実際の長さ）
  - `fetchRange(fileId, { drive, start, end, total }) → { ok: true, bytes: Buffer } | { ok: false, reason: "not-found" | "drive-error" | "range-mismatch" | "size-changed" }`
  - Drive の包み（本物・偽物とも）：`drive.range(fileId, start, end) → { status: number, contentRange: string, bytes: Buffer }`

- [ ] **Step 1: 失敗するテストを書く**

`delivery/test/fakes.js` の `fakeDrive`（48〜62 行）を次に置き換える:

```js
// Drive の偽物：fileId → { bytes, name, trashed } を返す。range は本物と同じく 206 と Content-Range を返す
function fakeDrive(files) {
  const notFound = () => { const e = new Error("File not found"); e.code = 404; return e; };
  return {
    async meta(fileId) {
      const f = files[fileId];
      if (!f) throw notFound();
      return { id: fileId, name: f.name || "x.pdf", size: String(f.bytes.length), trashed: !!f.trashed, mimeType: "application/pdf" };
    },
    async bytes(fileId) {
      const f = files[fileId];
      if (!f) throw notFound();
      return Buffer.from(f.bytes);
    },
    async range(fileId, start, end) {
      const f = files[fileId];
      if (!f) { const e = new Error("File not found"); e.status = 404; throw e; }
      const b = Buffer.from(f.bytes);
      const last = Math.min(end, b.length - 1);
      return { status: 206, contentRange: `bytes ${start}-${last}/${b.length}`, bytes: b.subarray(start, last + 1) };
    },
  };
}
```

`delivery/test/drive.test.js` の 3 行目を `const { fetchPdf, statPdf, fetchRange } = require("../lib/drive.js");` に置き換え、末尾に足す:

```js
test("statPdf: 大きさと名前だけ読む（中身は取らない）。読めない大きさは null", async () => {
  let bytesCalls = 0;
  const drive = fakeDrive({ F1: { bytes: PDF, name: "謄本.pdf" } });
  const orig = drive.bytes;
  drive.bytes = async (...a) => { bytesCalls += 1; return orig(...a); };
  assert.deepEqual(await statPdf("F1", { drive }), { ok: true, size: PDF.length, name: "謄本.pdf" });
  assert.equal(bytesCalls, 0);
  const noSize = { meta: async () => ({ name: "x.pdf", trashed: false }) };
  assert.deepEqual(await statPdf("F1", { drive: noSize }), { ok: true, size: null, name: "x.pdf" });
  assert.equal((await statPdf("F1", { drive: fakeDrive({ F1: { bytes: PDF, trashed: true } }) })).reason, "trashed");
  assert.equal((await statPdf("NOPE", { drive: fakeDrive({}) })).reason, "not-found");
  assert.equal((await statPdf("F1", { drive: { meta: async () => { throw new Error("ECONNRESET"); } } })).reason, "drive-error");
});

test("fetchPdf: stat を渡せば meta を読み直さない", async () => {
  let metaCalls = 0;
  const drive = fakeDrive({ F1: { bytes: PDF, name: "謄本.pdf" } });
  const orig = drive.meta;
  drive.meta = async (...a) => { metaCalls += 1; return orig(...a); };
  const st = await statPdf("F1", { drive });
  const r = await fetchPdf("F1", { drive, maxBytes: 1000, stat: st });
  assert.equal(r.ok, true);
  assert.equal(metaCalls, 1);
  const big = await fetchPdf("F1", { drive, maxBytes: 5, stat: st });
  assert.equal(big.reason, "too-large");
  assert.equal(big.size, PDF.length, "too-large には取れた大きさを付ける（メタ由来）");
});

test("fetchPdf: メタが小さい／無いのに中身が上限を超えたら too-large と実際の長さを返す", async () => {
  const body = Buffer.alloc(4000001);
  const liar = { meta: async () => ({ name: "x.pdf", size: "10", trashed: false }), bytes: async () => body };
  const r1 = await fetchPdf("F1", { drive: liar, maxBytes: 4000000 });
  assert.deepEqual([r1.ok, r1.reason, r1.size], [false, "too-large", 4000001]);
  const noSize = { meta: async () => ({ name: "x.pdf", trashed: false }), bytes: async () => body };
  const r2 = await fetchPdf("F1", { drive: noSize, maxBytes: 4000000 });
  assert.deepEqual([r2.ok, r2.reason, r2.size], [false, "too-large", 4000001]);
});

test("fetchRange: 206 と Content-Range（start・end・全体）と長さが合えば、その範囲だけ返す", async () => {
  const BIG = Buffer.from("0123456789abcdefghij");
  const drive = fakeDrive({ F1: { bytes: BIG } });
  const r = await fetchRange("F1", { drive, start: 5, end: 9, total: 20 });
  assert.equal(r.ok, true);
  assert.equal(r.bytes.toString(), "56789");
});

test("fetchRange: 範囲を守らない応答は使わない。全体の長さが違えば size-changed", async () => {
  const body = Buffer.from("56789");
  const make = (status, contentRange, bytes = body) => ({ range: async () => ({ status, contentRange, bytes }) });
  const base = { start: 5, end: 9, total: 20 };
  assert.equal((await fetchRange("F1", { drive: make(200, "bytes 5-9/20"), ...base })).reason, "range-mismatch", "200（範囲を無視）");
  assert.equal((await fetchRange("F1", { drive: make(206, ""), ...base })).reason, "range-mismatch", "Content-Range 無し");
  assert.equal((await fetchRange("F1", { drive: make(206, "bytes 0-4/20"), ...base })).reason, "range-mismatch", "start 違い");
  assert.equal((await fetchRange("F1", { drive: make(206, "bytes 5-8/20"), ...base })).reason, "range-mismatch", "end 違い");
  assert.equal((await fetchRange("F1", { drive: make(206, "bytes 5-9/*"), ...base })).reason, "range-mismatch", "全体が * ");
  assert.equal((await fetchRange("F1", { drive: make(206, "bytes 5-9/21"), ...base })).reason, "size-changed");
  assert.equal((await fetchRange("F1", { drive: make(206, "bytes 5-9/20", Buffer.from("567")), ...base })).reason, "range-mismatch", "長さ違い");
  assert.equal((await fetchRange("NOPE", { drive: fakeDrive({}), ...base })).reason, "not-found");
  assert.equal((await fetchRange("F1", { drive: { range: async () => { throw new Error("ECONNRESET"); } }, ...base })).reason, "drive-error");
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/drive.test.js`
Expected: FAIL（`statPdf is not a function`、`fetchRange is not a function`）

- [ ] **Step 3: 実装する**

`delivery/lib/drive.js` を次に置き換える:

```js
// 非公開の Drive から PDF を取る。
// 読む主体は配信専用のサービスアカウント（2026-09-24 本人決定）。proposer が資料のフォルダだけを
// このアカウントに「閲覧者」で共有するので、読める範囲はそのフォルダに限られ、トークンの期限切れも無い。
// 全体を返すのは上限（maxBytes）以下のときだけ（Vercel Functions の本文上限 4.5MB のため）。
// それより大きいものは範囲を指定して部分ずつ取る（2026-10-09 設計 19）。範囲の応答は 206 と Content-Range を確かめてから使う
function createDrive({ credentials }) {
  const { google } = require("googleapis");
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
  const drive = google.drive({ version: "v3", auth });
  return {
    async meta(fileId) {
      const r = await drive.files.get({ fileId, fields: "id,name,size,trashed,mimeType", supportsAllDrives: true });
      return r.data;
    },
    async bytes(fileId) {
      const r = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
      return Buffer.from(r.data);
    },
    async range(fileId, start, end) {
      const r = await drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer", headers: { Range: `bytes=${start}-${end}` } },
      );
      // gaxios の版によって headers は Headers（get がある）か、ただのオブジェクト
      const h = r.headers || {};
      const cr = typeof h.get === "function" ? h.get("content-range") : h["content-range"];
      return { status: r.status, contentRange: typeof cr === "string" ? cr : "", bytes: Buffer.from(r.data) };
    },
  };
}

function isNotFound(e) {
  // meta() は google-auth-library のエラーで code に文字列/数値が入るが、
  // bytes()・range() は responseType:"arraybuffer" のため code が付かず status にだけ 404 が入る
  return e && (e.code === 404 || e.status === 404);
}

// 大きさと名前だけ読む（中身は取らない）。大きさが読めなければ size は null（全体の取得で実際の長さを見る）
async function statPdf(fileId, { drive }) {
  let meta;
  try {
    meta = await drive.meta(fileId);
  } catch (e) {
    return { ok: false, reason: isNotFound(e) ? "not-found" : "drive-error" };
  }
  if (!meta) return { ok: false, reason: "not-found" };
  if (meta.trashed) return { ok: false, reason: "trashed" };
  const n = Number(meta.size);
  const size = meta.size != null && meta.size !== "" && Number.isSafeInteger(n) && n >= 0 ? n : null;
  return { ok: true, size, name: meta.name || "document.pdf" };
}

async function fetchPdf(fileId, { drive, maxBytes, stat }) {
  const st = stat || (await statPdf(fileId, { drive }));
  if (!st.ok) return st;
  if (st.size != null && st.size > maxBytes) return { ok: false, reason: "too-large", size: st.size };
  let bytes;
  try {
    bytes = await drive.bytes(fileId);
  } catch (e) {
    return { ok: false, reason: isNotFound(e) ? "not-found" : "drive-error" };
  }
  // メタの size は信じない。実際に返ってきた長さで判断する
  if (!bytes) return { ok: false, reason: "drive-error" };
  // 取れた中身が上限を超えていれば、その実際の長さを返す（呼び出し側が「分けて渡す」案内に使う）
  if (bytes.length > maxBytes) return { ok: false, reason: "too-large", size: bytes.length };
  return { ok: true, bytes, name: st.name };
}

const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/;

// start〜end（両端を含む）を取る。206・Content-Range の start/end/全体・実際の長さが全部合ったときだけ使う。
// 全体の長さが閲覧の記録（total）と違えば、案内を出した後にファイルが変わった（size-changed）
async function fetchRange(fileId, { drive, start, end, total }) {
  let r;
  try {
    r = await drive.range(fileId, start, end);
  } catch (e) {
    return { ok: false, reason: isNotFound(e) ? "not-found" : "drive-error" };
  }
  if (!r || r.status !== 206) return { ok: false, reason: "range-mismatch" };
  const m = CONTENT_RANGE.exec(String(r.contentRange || "").trim());
  if (!m) return { ok: false, reason: "range-mismatch" };
  if (Number(m[3]) !== total) return { ok: false, reason: "size-changed" };
  if (Number(m[1]) !== start || Number(m[2]) !== end) return { ok: false, reason: "range-mismatch" };
  if (!r.bytes || r.bytes.length !== end - start + 1) return { ok: false, reason: "range-mismatch" };
  return { ok: true, bytes: r.bytes };
}

module.exports = { createDrive, fetchPdf, statPdf, fetchRange };
```

- [ ] **Step 4: 通ることを確かめる**

Run: `node --test test/drive.test.js && npm test`
Expected: drive の全件 PASS（既存の 2 件も変更なしで通る）。全体 `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add delivery/lib/drive.js delivery/test/drive.test.js delivery/test/fakes.js
git commit -m "$(cat <<'EOF'
feat(delivery): Drive の大きさだけ読む statPdf と、206・Content-Range を確かめる範囲取得 fetchRange

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 分割の定数と計算・閲覧の記録（KV）・新しい応答コード

**Files:**
- Create: `delivery/lib/parts.js`
- Modify: `delivery/lib/kv.js:2-9`（キーの一覧の説明）、`:89`（`ticketTake` の後に 3 関数を足す）
- Modify: `delivery/lib/errors.js:4`（`AUTHED`）
- Test: `delivery/test/parts.test.js`（新規）、`delivery/test/kv.test.js`、`delivery/test/errors.test.js`

**Interfaces:**
- Produces:
  - `parts.WHOLE_MAX = 4000000`（全体を返す境目・券を出す境目。設計書の固定値。`deps.maxBytes` とは無関係）、`parts.PART_SIZE = 3500000`、`parts.MAX_BYTES = 52428800`、`parts.MAX_PARTS = 15`、`parts.VIEW_TTL_SEC = 600`、`parts.FETCH_MAX = 3`、`parts.RATE_PER_PART = 2`
  - `parts.plan(size) → { parts: number, partSize: 3500000 }`（size は 1〜MAX_BYTES の整数。違えば投げる）
  - `parts.rangeOf(view, part) → { start, end }`（end は含む）
  - `parts.validView(v) → boolean`（閲覧の記録の形。検査するのは `jti`・`userId`・`f`（driveFileId）・`h`（sha256）・`size`・`parts`・`partSize`・`ref`。記録には `s`・`i` も入れるが（Task 5）、`validView` も部分の取得の照合（Task 6）も見ない）
  - `kv.viewPut(viewId, rec, ttlSec)`、`kv.viewGet(viewId) → object | null`、`kv.viewPartHit(viewId, part, limit, ttlSec) → boolean`
  - `errors.authed("slow", ref)` → 429、`errors.authed("reopen", ref)` → 410

- [ ] **Step 1: 失敗するテストを書く**

`delivery/test/parts.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const parts = require("../lib/parts.js");

test("定数：全体の境目 4,000,000（固定）・部分 3,500,000 バイト・上限 50MiB・部分は最大 15・閲覧 10 分・1 部分 3 回・速さは部分の数×2", () => {
  assert.equal(parts.WHOLE_MAX, 4000000);
  assert.equal(parts.PART_SIZE, 3500000);
  assert.equal(parts.MAX_BYTES, 50 * 1024 * 1024);
  assert.equal(parts.MAX_PARTS, 15);
  assert.equal(parts.VIEW_TTL_SEC, 600);
  assert.equal(parts.FETCH_MAX, 3);
  assert.equal(parts.RATE_PER_PART, 2);
});

test("plan: 部分の数は大きさ÷3,500,000 の切り上げ。範囲外は投げる", () => {
  assert.deepEqual(parts.plan(4000001), { parts: 2, partSize: 3500000 });
  assert.deepEqual(parts.plan(7000000), { parts: 2, partSize: 3500000 });
  assert.deepEqual(parts.plan(7000001), { parts: 3, partSize: 3500000 });
  assert.deepEqual(parts.plan(parts.MAX_BYTES), { parts: 15, partSize: 3500000 });
  for (const bad of [0, -1, 1.5, parts.MAX_BYTES + 1, NaN, "100"]) assert.throws(() => parts.plan(bad), /size/);
});

test("rangeOf: 0 から数え、最後の部分は全体の終わりまで（end は含む）", () => {
  const view = { size: 7200009, partSize: 3500000, parts: 3 };
  assert.deepEqual(parts.rangeOf(view, 0), { start: 0, end: 3499999 });
  assert.deepEqual(parts.rangeOf(view, 1), { start: 3500000, end: 6999999 });
  assert.deepEqual(parts.rangeOf(view, 2), { start: 7000000, end: 7200008 });
});

test("validView: 閲覧の記録の形を確かめる（壊れていれば使わない）", () => {
  const ok = { jti: "0123456789abcdef", userId: "U" + "c".repeat(32), s: "s1", f: "F1", h: "a".repeat(64), i: 1, size: 7200009, parts: 3, partSize: 3500000, ref: "abcd1234" };
  assert.equal(parts.validView(ok), true);
  for (const patch of [{ jti: "x" }, { userId: "x" }, { f: "" }, { h: "A".repeat(64) }, { size: 0 }, { size: parts.MAX_BYTES + 1 }, { parts: 2 }, { partSize: 1000 }, { ref: 1 }]) {
    assert.equal(parts.validView({ ...ok, ...patch }), false, JSON.stringify(patch));
  }
  // s・i は記録するが検査しない（無くても通る）
  const { s: _s, i: _i, ...noSI } = ok;
  assert.equal(parts.validView(noSI), true);
  assert.equal(parts.validView(null), false);
});
```

`delivery/test/errors.test.js` の `assert.throws(...)` の行の前に足す:

```js
  assert.equal(errors.authed("slow", "x").status, 429);
  assert.equal(errors.authed("reopen", "x").status, 410);
  assert.deepEqual(errors.authed("reopen", "x").body, { ok: false, code: "reopen", ref: "x" });
```

`delivery/test/kv.test.js` の末尾に足す:

```js
test("viewPut/viewGet：閲覧の記録を JSON で置いて読む。無ければ null。TTL が付く", async () => {
  const redis = memoryRedis();
  const kv = createKv(redis);
  const rec = { jti: "0123456789abcdef", userId: U, f: "F1", h: "a".repeat(64), size: 10, parts: 1, partSize: 3500000, ref: "r" };
  await kv.viewPut("v".repeat(32), rec, 600);
  assert.deepEqual(await kv.viewGet("v".repeat(32)), rec);
  assert.equal(await kv.viewGet("w".repeat(32)), null);
  const e = redis._store.get(`view:${"v".repeat(32)}`);
  assert.ok(e.exp > Date.now() + 590 * 1000 && e.exp <= Date.now() + 600 * 1000);
  // @upstash/redis が JSON を読み戻してオブジェクトで返す場合も受ける
  redis.get = async () => rec;
  assert.deepEqual(await kv.viewGet("v".repeat(32)), rec);
});

test("viewPartHit：部分ごとに limit 回までは true、超えると false。部分が違えば別に数える", async () => {
  const redis = memoryRedis();
  const kv = createKv(redis);
  const id = "v".repeat(32);
  assert.equal(await kv.viewPartHit(id, 0, 3, 600), true);
  assert.equal(await kv.viewPartHit(id, 0, 3, 600), true);
  assert.equal(await kv.viewPartHit(id, 0, 3, 600), true);
  assert.equal(await kv.viewPartHit(id, 0, 3, 600), false);
  assert.equal(await kv.viewPartHit(id, 1, 3, 600), true);
  assert.ok(redis._store.get(`view:${id}:p:0`).exp > Date.now());
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/parts.test.js test/errors.test.js test/kv.test.js`
Expected: FAIL（`Cannot find module '../lib/parts.js'`、`unknown code: slow`、`kv.viewPut is not a function`）

- [ ] **Step 3: 実装する**

`delivery/lib/parts.js`:

```js
// 大きい PDF を「分けて渡す」ための定数と計算（2026-10-09 設計 19）。
// 全体を返すのは 4,000,000 バイト（WHOLE_MAX・固定値。deps.maxBytes ではない）以下だけ。それを超え 50MiB までは、
// 3,500,000 バイトずつの部分に分け、閲覧の番号（viewId・KV に 10 分）に結び付けて 1 部分ずつ渡す
const WHOLE_MAX = 4000000; // 全体を返す・保存の券を出す境目（設計書の固定値。MAX_PDF_BYTES には依らない）
const PART_SIZE = 3500000;
const MAX_BYTES = 50 * 1024 * 1024; // portal の完成品の上限に合わせる（MiB）
const MAX_PARTS = Math.ceil(MAX_BYTES / PART_SIZE); // 15
const VIEW_TTL_SEC = 600;
const FETCH_MAX = 3; // 1 つの部分は 1 つの viewId の中で合計 3 回まで（総数の上限）
const RATE_PER_PART = 2; // 速さの上限：1 分あたり「部分の数×2」回（総数とは別枠）

function plan(size) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES) throw new Error(`size が範囲外です: ${size}`);
  return { parts: Math.ceil(size / PART_SIZE), partSize: PART_SIZE };
}

function rangeOf(view, part) {
  const start = part * view.partSize;
  const end = Math.min(view.size, start + view.partSize) - 1;
  return { start, end };
}

function validView(v) {
  return !!v && typeof v === "object" &&
    typeof v.jti === "string" && /^[0-9a-f]{16}$/.test(v.jti) &&
    typeof v.userId === "string" && /^U[0-9a-f]{32}$/.test(v.userId) &&
    typeof v.f === "string" && v.f.length > 0 && v.f.length <= 200 &&
    typeof v.h === "string" && /^[0-9a-f]{64}$/.test(v.h) &&
    Number.isSafeInteger(v.size) && v.size > 0 && v.size <= MAX_BYTES &&
    v.partSize === PART_SIZE &&
    Number.isInteger(v.parts) && v.parts === Math.ceil(v.size / PART_SIZE) &&
    typeof v.ref === "string";
}

module.exports = { WHOLE_MAX, PART_SIZE, MAX_BYTES, MAX_PARTS, VIEW_TTL_SEC, FETCH_MAX, RATE_PER_PART, plan, rangeOf, validView };
```

`delivery/lib/errors.js` の 4 行目を置き換える:

```js
// slow：分けて渡すときの速さの上限（少し待てば取れる）。reopen：1 つの閲覧の取り直しの上限（開き直してもらう）
const AUTHED = { expired: 410, retry: 503, replaced: 409, "too-large": 413, stopped: 423, slow: 429, reopen: 410 };
```

`delivery/lib/kv.js` のキーの一覧（8 行目 `dl:<key>` の行）の後に足す:

```js
//   view:<viewId>（大きい PDF を分けて渡す閲覧の記録・10 分）/ view:<viewId>:p:<n>（部分ごとの取得回数）
//   rl:part:<viewId>:<window>（部分の取得の速さの上限）
```

`ticketTake`（76〜89 行）の閉じ括弧 `},` の次の行に足す:

```js

    // 大きい PDF を分けて渡す閲覧の記録（設計 19）。JSON で置き、TTL で消える
    async viewPut(viewId, rec, ttlSec) { await redis.set(`view:${viewId}`, JSON.stringify(rec), { ex: ttlSec }); },
    async viewGet(viewId) {
      const v = await redis.get(`view:${viewId}`);
      if (v == null) return null;
      // @upstash/redis は JSON 文字列を自動で読み戻すことがあるので、両方を受ける
      if (typeof v === "object") return v;
      try { return JSON.parse(v); } catch { return null; }
    },
    // 1 つの部分の取得回数（総数の上限）。limit 回までは true。カウンタは閲覧と同じ長さで消える
    async viewPartHit(viewId, part, limit, ttlSec) {
      const k = `view:${viewId}:p:${part}`;
      const n = await redis.incr(k);
      if (n === 1) await redis.expire(k, ttlSec);
      return n <= limit;
    },
```

（`withPrefix` の `KEYED` には `get`・`set`・`incr`・`expire` が既にあるので変えない）

- [ ] **Step 4: 通ることを確かめる**

Run: `node --test test/parts.test.js test/errors.test.js test/kv.test.js && npm test`
Expected: PASS。全体 `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add delivery/lib/parts.js delivery/lib/kv.js delivery/lib/errors.js delivery/test/parts.test.js delivery/test/kv.test.js delivery/test/errors.test.js
git commit -m "$(cat <<'EOF'
feat(delivery): 大きい PDF を分けて渡すための定数・閲覧の記録（KV）・応答コード slow/reopen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `/api/open` が券の前に大きさを確かめ、4,000,000 バイト超は「分けて渡す」案内を返す

**Files:**
- Modify: `delivery/api/open.js:1-9`（説明・require）、`:45-122`（`handle`）、`:124-127`（exports）
- Modify: `delivery/test/open.test.js:81-95`（大きすぎる）、`:141-165`（券）
- Modify: `delivery/api/dl.js:47`・`:78`（上限を固定の `parts.WHOLE_MAX` にする）、`delivery/test/dl.test.js`（大きい券の試験の置き換えと、上限が固定であることの試験）
- Test: `delivery/test/open-parts.test.js`（新規）

**Interfaces:**
- Consumes: Task 2 `decide`、Task 3 `statPdf`・`fetchPdf(…, { stat })`（`too-large` の `size`）、Task 4 `parts.WHOLE_MAX`・`parts.plan`・`parts.MAX_BYTES`・`parts.VIEW_TTL_SEC`・`kv.viewPut`
- Produces:
  - 案内の応答（200・JSON）：`{ ok: true, mode: "parts", viewId: string(32, base64url), size: number, parts: number, partSize: 3500000, name: string }`
  - 閲覧の記録（`kv.viewPut` の rec）：`{ jti, userId, s, f, h, i, size, parts, partSize, ref }`
  - 監査：案内を出すと `auditConfirm(auditId, { result: "parts-issued", bytes: size, parts })`
  - 境目はすべて固定値 `parts.WHOLE_MAX`（4,000,000）。`open.js` も `dl.js` も `deps.maxBytes`（`MAX_PDF_BYTES`）を一切使わない
  - メタが小さい（または size が無い）のに中身が 4,000,000 を超えたとき：`fetchPdf` が返す `too-large` の `size`（取れた中身の実際の長さ）で同じ案内を返す（413 にしない）。50MiB を超えれば `too-large`
  - `dl.js`：`fetchPdf(rec.f, { drive, maxBytes: parts.WHOLE_MAX })`
  - 券（`mode: "ticket"`）：Drive の大きさが `WHOLE_MAX` を超えれば券を出さず 413 `too-large`（監査は `denied`・`too-large-ticket`）／大きさが読めない（size が null）ときも券を出さず 503 `retry`（監査は `denied`・`ticket-no-size`）
  - `module.exports.displayName(name) → string`（制御文字を除き 200 文字まで）

- [ ] **Step 1: 失敗するテストを書く**

`delivery/test/open-parts.test.js`（この Task では案内まで。部分の取得のテストは Task 6 で同じファイルに足す）:

```js
// 大きい PDF を分けて渡す（設計 19）。案内（viewId）と部分の取得
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { handle } = require("../api/open.js");
const { createKv } = require("../lib/kv.js");
const { memoryRedis, fakeFetch, fakeDrive } = require("./fakes.js");
const { keyPair, issueWith } = require("./signtoken.js");

const U = "U" + "c".repeat(32);
const U2 = "U" + "e".repeat(32);
const GROUP = "C" + "1".repeat(32);
const NOW = Date.UTC(2026, 9, 9, 3, 0, 0);
const TOK = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.sig";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const pdfOf = (n) => { const b = Buffer.alloc(n, 0x20); b.write("%PDF-1.4\n", 0); crypto.randomFillSync(b, 9); return b; };
const BIG = pdfOf(7200009); // 3,500,000・3,500,000・200,009 の 3 部分
const kp = keyPair();

function fakeRes() {
  return { statusCode: 200, headers: {}, body: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    json(b) { this.body = b; this.headers["content-type"] = "application/json"; return this; },
    send(b) { this.body = b; return this; },
    end() { return this; },
  };
}

function fetchFor(userId, { member, now = NOW } = {}) {
  return fakeFetch([
    { match: "/verify", status: 200, body: { iss: "https://access.line.me", sub: userId, aud: "2011726489", exp: Math.floor(now / 1000) + 3000, iat: Math.floor(now / 1000) - 10 } },
    { match: "/member/", ...(member || { status: 200, body: { userId, displayName: "架空" } }) },
  ]);
}

function setup({ bytes = BIG, roster = [U], extra = {}, name = "上野東_図面.pdf" } = {}) {
  const redis = memoryRedis();
  const kv = createKv(redis);
  const { d, jti } = issueWith({ sha256: sha(bytes), now: NOW, extra }, kp);
  const deps = {
    publicKeys: { k1: kp.publicKeyPem }, channelId: "2011726489", groupId: GROUP, botToken: "tok", kv,
    drive: fakeDrive({ F1: { bytes, name } }), maxBytes: 4000000, now: NOW,
    fetchImpl: fetchFor(U),
  };
  const req = (body) => ({ method: "POST", headers: { "x-forwarded-for": "1.2.3.4" }, body });
  return { deps, kv, redis, d, jti, bytes, req, ready: (async () => { for (const u of roster) await kv.rosterAdd(u, "x"); })() };
}

async function call(s, body, deps = s.deps) {
  const res = fakeRes();
  await handle(s.req(body), res, deps);
  return res;
}

test("open: 4,000,000 バイトちょうどは今どおり全体を返し、1 バイトでも超えれば分けて渡す案内を返す", async () => {
  const small = setup({ bytes: pdfOf(4000000) }); await small.ready;
  const r1 = await call(small, { d: small.d, idToken: TOK });
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.headers["content-type"], "application/pdf");
  assert.equal(r1.body.length, 4000000);

  const over = setup({ bytes: pdfOf(4000001) }); await over.ready;
  const r2 = await call(over, { d: over.d, idToken: TOK });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.headers["content-type"], "application/json");
  assert.equal(r2.body.mode, "parts");
  assert.equal(r2.body.parts, 2);
});

test("open: 境目は固定の 4,000,000。deps.maxBytes（MAX_PDF_BYTES）が大きくても小さくても動かない", async () => {
  // MAX_PDF_BYTES を大きく入れていても、4,000,001 は全体で返さず分けて渡す
  const big = setup({ bytes: pdfOf(4000001) }); await big.ready;
  big.deps.maxBytes = 10000000;
  const r1 = await call(big, { d: big.d, idToken: TOK });
  assert.equal(r1.headers["content-type"], "application/json");
  assert.equal(r1.body.mode, "parts");
  assert.equal(r1.body.parts, 2);
  // 大きく入れていても、4,000,001 には保存の券を出さない
  const t1 = await call(big, { d: big.d, idToken: TOK, mode: "ticket" });
  assert.equal(t1.statusCode, 413);
  assert.equal(t1.body.code, "too-large");
  // 小さく入れていても、4,000,000 以下（2MB）は今どおり全体で返す（MAX_PDF_BYTES はもう使わない）
  const small = setup({ bytes: pdfOf(2000000) }); await small.ready;
  small.deps.maxBytes = 1000000;
  const r3 = await call(small, { d: small.d, idToken: TOK });
  assert.equal(r3.statusCode, 200);
  assert.equal(r3.headers["content-type"], "application/pdf");
  assert.equal(r3.body.length, 2000000);
  // 保存の券も、小さい maxBytes に左右されず出る
  const t3 = await call(small, { d: small.d, idToken: TOK, mode: "ticket" });
  assert.equal(t3.statusCode, 200);
  assert.match(t3.body.url, /^\/api\/dl\?k=/);
});

test("open: メタが小さい／大きさが無いのに中身が 4,000,000 を超えれば、413 にせず実際の長さで分けて渡す案内。そのまま部分も取れる", async () => {
  const body = pdfOf(4000001);
  for (const maxBytes of [10000000, 1000000]) {
    for (const metaPatch of [{ size: "10" }, {}]) {
      const s = setup({ bytes: body }); await s.ready;
      s.deps.maxBytes = maxBytes;
      const real = fakeDrive({ F1: { bytes: body, name: "x.pdf" } });
      s.deps.drive = { ...real, meta: async () => ({ id: "F1", name: "x.pdf", trashed: false, ...metaPatch }) };
      const r = await call(s, { d: s.d, idToken: TOK });
      const label = JSON.stringify({ maxBytes, metaPatch });
      assert.equal(r.statusCode, 200, label);
      assert.equal(r.body.mode, "parts", label);
      assert.equal(r.body.size, 4000001, label);
      assert.equal(r.body.parts, 2, label);
      const view = await s.kv.viewGet(r.body.viewId);
      assert.equal(view.size, 4000001);
      // 続けて部分を取り、つないだ sha256 がトークンの値と一致する（部分の取得は Task 6 の経路）
      const got = [];
      for (let i = 0; i < 2; i += 1) {
        const pr = await call(s, { d: s.d, idToken: TOK, viewId: r.body.viewId, part: i });
        assert.equal(pr.statusCode, 200, `${label} part ${i}`);
        got.push(pr.body);
      }
      assert.equal(sha(Buffer.concat(got)), sha(body));
      const list = await s.kv.auditList(5);
      assert.equal(list.length, 1, "案内の 1 件だけ");
      assert.equal(list[0].result, "parts-issued");
    }
  }
  // 実際の長さが 50MiB を超えていれば too-large（案内は出さない）
  const huge = setup({ bytes: pdfOf(1000) }); await huge.ready;
  huge.deps.drive = { meta: async () => ({ id: "F1", name: "x.pdf", size: "10", trashed: false }), bytes: async () => Buffer.alloc(50 * 1024 * 1024 + 1) };
  const r2 = await call(huge, { d: huge.d, idToken: TOK });
  assert.equal(r2.statusCode, 413);
  assert.equal(r2.body.code, "too-large");
});

test("open 案内: viewId・全体の大きさ・部分の数・部分の大きさ・ファイル名を返し、中身は取らない。監査は parts-issued の 1 件", async () => {
  const s = setup(); await s.ready;
  let bytesCalls = 0;
  const orig = s.deps.drive.bytes;
  s.deps.drive.bytes = async (...a) => { bytesCalls += 1; return orig(...a); };
  const ttls = [];
  const put = s.kv.viewPut;
  s.kv.viewPut = async (id, rec, ttl) => { ttls.push(ttl); return put(id, rec, ttl); };
  const res = await call(s, { d: s.d, idToken: TOK });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.body.ok, true);
  assert.equal(res.body.mode, "parts");
  assert.match(res.body.viewId, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(res.body.size, BIG.length);
  assert.equal(res.body.parts, 3);
  assert.equal(res.body.partSize, 3500000);
  assert.equal(res.body.name, "上野東_図面.pdf");
  assert.equal(bytesCalls, 0, "案内だけで中身は取らない");
  assert.deepEqual(ttls, [600]);
  const list = await s.kv.auditList(5);
  assert.equal(list.length, 1);
  assert.equal(list[0].result, "parts-issued");
  assert.equal(String(list[0].parts), "3");
  assert.equal(String(list[0].bytes), String(BIG.length));
  const view = await s.kv.viewGet(res.body.viewId);
  assert.equal(view.jti, s.jti);
  assert.equal(view.userId, U);
  assert.equal(view.f, "F1");
  assert.equal(view.h, sha(BIG));
  assert.equal(view.size, BIG.length);
  assert.equal(view.parts, 3);
  assert.equal(view.partSize, 3500000);
  assert.match(view.ref, /^[0-9a-f]{8}$/);
});

test("open 案内: ファイル名の改行・制御文字は除く", async () => {
  const s = setup({ name: "図面\r\n\u0007A.pdf" }); await s.ready;
  const res = await call(s, { d: s.d, idToken: TOK });
  assert.equal(res.body.name, "図面A.pdf");
});

test("open 案内: 50MiB ちょうどは 15 部分で渡し、1 バイトでも超えれば too-large（中身は取らない）", async () => {
  const s = setup(); await s.ready;
  let bytesCalls = 0;
  const lying = (size) => ({ meta: async () => ({ id: "F1", name: "x.pdf", size: String(size), trashed: false }), bytes: async () => { bytesCalls += 1; return BIG; } });
  s.deps.drive = lying(50 * 1024 * 1024);
  const r1 = await call(s, { d: s.d, idToken: TOK });
  assert.equal(r1.body.mode, "parts");
  assert.equal(r1.body.parts, 15);
  s.deps.drive = lying(50 * 1024 * 1024 + 1);
  const r2 = await call(s, { d: s.d, idToken: TOK });
  assert.equal(r2.statusCode, 413);
  assert.equal(r2.body.code, "too-large");
  assert.equal(bytesCalls, 0);
});

test("open 案内: 閲覧の記録が書けなければ 503 retry（案内は出さない）", async () => {
  const s = setup(); await s.ready;
  s.kv.viewPut = async () => { throw new Error("kv down"); };
  const res = await call(s, { d: s.d, idToken: TOK });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "retry");
  const list = await s.kv.auditList(5);
  assert.equal(list[0].result, "denied");
  assert.equal(list[0].reason, "view-error");
});

test("open 案内: グループあてのトークン（g が一致）なら、名簿に無くても案内が出る", async () => {
  const s = setup({ roster: [], extra: { aud: "line-group", g: GROUP } }); await s.ready;
  const res = await call(s, { d: s.d, idToken: TOK });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mode, "parts");
});

module.exports = { setup, call, fetchFor, fakeRes, pdfOf, sha, BIG, U, U2, GROUP, NOW, TOK, kp };
```

`delivery/test/open.test.js` の 81〜95 行（`test("open: 大きすぎる → too-large。Drive の障害 → retry", …)`）を次に置き換える:

```js
test("open: 50MiB を超える → too-large（分けても渡さない）。Drive の障害 → retry", async () => {
  const big = setup(); await big.ready;
  let bytesCalls = 0;
  big.deps.drive = { meta: async () => ({ id: "F1", name: "x.pdf", size: String(50 * 1024 * 1024 + 1), trashed: false }), bytes: async () => { bytesCalls += 1; return PDF; } };
  const r1 = fakeRes();
  await handle(big.req({ d: big.d, idToken: TOK }), r1, big.deps);
  assert.equal(r1.statusCode, 413);
  assert.equal(r1.body.code, "too-large");
  assert.match(r1.body.ref, /^[0-9a-f]{8}$/);
  assert.equal(bytesCalls, 0);

  const down = setup(); await down.ready;
  down.deps.drive = { meta: async () => { throw new Error("ECONNRESET"); }, bytes: async () => PDF };
  const r2 = fakeRes();
  await handle(down.req({ d: down.d, idToken: TOK }), r2, down.deps);
  assert.equal(r2.statusCode, 503);
  assert.equal(r2.body.code, "retry");
});

test("open: メタの大きさは小さくても、実際の中身が 4,000,000 を超えれば 413 にせず分けて渡す案内（実際の長さで）", async () => {
  const s = setup(); await s.ready;
  s.deps.drive = { meta: async () => ({ id: "F1", name: "x.pdf", size: "10", trashed: false }), bytes: async () => Buffer.alloc(4000001) };
  const res = fakeRes();
  await handle(s.req({ d: s.d, idToken: TOK }), res, s.deps);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mode, "parts");
  assert.equal(res.body.size, 4000001);
});
```

`delivery/test/open.test.js` の 141〜165 行（券を出す試験の 1 本目）を次に置き換える:

```js
// 保存用の受け取り券（mode: "ticket"）。判定は同じ gate。通れば Drive の大きさだけ確かめて券を出す（中身は取らない）
test("open ticket: 通れば /api/dl?k=<32字> を返し、KV に 60 秒の券が入る。監査は ticket-issued", async () => {
  const s = setup(); await s.ready;
  let metaCalls = 0;
  let bytesCalls = 0;
  s.deps.drive = {
    meta: async () => { metaCalls += 1; return { id: "F1", name: "x.pdf", size: String(PDF.length), trashed: false }; },
    bytes: async () => { bytesCalls += 1; return PDF; },
  };
  const res = fakeRes();
  await handle(s.req({ d: s.d, idToken: TOK, mode: "ticket" }), res, s.deps);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.body.ok, true);
  const m = /^\/api\/dl\?k=([A-Za-z0-9_-]{32})$/.exec(res.body.url);
  assert.ok(m, res.body.url);
  assert.equal(metaCalls, 1, "券を出す前に Drive の大きさだけ確かめる");
  assert.equal(bytesCalls, 0, "中身は取らない");
  const list = await s.kv.auditList(5);
  assert.equal(list[0].result, "ticket-issued");
  const rec = await s.kv.ticketTake(m[1]);
  assert.equal(rec.s, "s1");
  assert.equal(rec.f, "F1");
  assert.equal(rec.h, SHA);
  assert.equal(rec.jti, s.jti);
  assert.equal(rec.userId, U);
  assert.equal(typeof rec.i, "number");
  assert.equal(rec.auditId, list[0].id);
  assert.match(rec.ref, /^[0-9a-f]{8}$/);
});

test("open ticket: Drive の大きさが 4,000,000 を超えれば券を出さず 413 too-large。監査は too-large-ticket（maxBytes が大きくても同じ）", async () => {
  const s = setup(); await s.ready;
  s.deps.maxBytes = 10000000;
  let puts = 0;
  s.kv.ticketPut = async () => { puts += 1; };
  s.deps.drive = { meta: async () => ({ id: "F1", name: "x.pdf", size: "4000001", trashed: false }), bytes: async () => PDF };
  const res = fakeRes();
  await handle(s.req({ d: s.d, idToken: TOK, mode: "ticket" }), res, s.deps);
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.code, "too-large");
  assert.equal(puts, 0);
  const list = await s.kv.auditList(5);
  assert.equal(list[0].result, "denied");
  assert.equal(list[0].reason, "too-large-ticket");
});

test("open ticket: Drive の大きさが無い（size 欠落）なら券を出さず 503 retry。監査は ticket-no-size。maxBytes が大きくても同じ", async () => {
  const s = setup(); await s.ready;
  s.deps.maxBytes = 10000000;
  let puts = 0;
  s.kv.ticketPut = async () => { puts += 1; };
  for (const meta of [{ id: "F1", name: "x.pdf", trashed: false }, { id: "F1", name: "x.pdf", size: "", trashed: false }, { id: "F1", name: "x.pdf", size: "abc", trashed: false }]) {
    s.deps.drive = { meta: async () => meta, bytes: async () => PDF };
    const res = fakeRes();
    await handle(s.req({ d: s.d, idToken: TOK, mode: "ticket" }), res, s.deps);
    assert.equal(res.statusCode, 503, JSON.stringify(meta));
    assert.equal(res.body.code, "retry");
  }
  assert.equal(puts, 0);
  const list = await s.kv.auditList(5);
  assert.equal(list[0].result, "denied");
  assert.equal(list[0].reason, "ticket-no-size");
});

test("open ticket: Drive の大きさが読めない（障害）なら券を出さず 503 retry。消えていれば 409 replaced", async () => {
  const s = setup(); await s.ready;
  let puts = 0;
  s.kv.ticketPut = async () => { puts += 1; };
  s.deps.drive = { meta: async () => { throw new Error("ECONNRESET"); }, bytes: async () => PDF };
  const r1 = fakeRes();
  await handle(s.req({ d: s.d, idToken: TOK, mode: "ticket" }), r1, s.deps);
  assert.equal(r1.statusCode, 503);
  s.deps.drive = fakeDrive({});
  const r2 = fakeRes();
  await handle(s.req({ d: s.d, idToken: TOK, mode: "ticket" }), r2, s.deps);
  assert.equal(r2.statusCode, 409);
  assert.equal(r2.body.code, "replaced");
  assert.equal(puts, 0);
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/open-parts.test.js test/open.test.js`
Expected: FAIL（4,000,001 バイトで `too-large` が返り `mode` が無い、メタが小さい嘘の試験で 413 になる、券の試験で `metaCalls` が 0、`too-large-ticket` が無い、`dl` が `deps.maxBytes` を見て 10,000,000 の設定で 4,000,001 を返す など）

- [ ] **Step 3: 実装する**

`delivery/api/open.js` の 1〜9 行を次に置き換える:

```js
// POST /api/open  本文: { d: 配布トークン, idToken: LIFF の IDトークン, mode?: "ticket" }
// mode: "ticket" のときは PDF を返さず、同じ判定を通った人にだけ保存用の受け取り券（60 秒・1 回限り）を出す。
// 券は /api/dl?k=... で Safari から受け取る（設計書 §9 の例外）。券を出す前に Drive の大きさを確かめ、
// 4,000,000 バイト（parts.WHOLE_MAX・固定値。maxBytes ではない）を超えるもの、大きさが分からないものには出さない（2026-10-09 設計 19）
// 判定（gate）→ Drive の大きさ → 4,000,000 以下（固定値）なら全体を取り sha256 照合 → PDF を inline で返す。
// それを超え 50MiB までなら、全体は返さず「分けて渡す」案内（viewId）を返す。監査は予約 → 確定（1 回の閲覧＝1 件）。
// 本文・トークン・鍵・viewId はログに出さない。console には理由コードと ref だけ
const crypto = require("crypto");
const { decide } = require("../lib/gate.js");
const { fetchPdf, statPdf } = require("../lib/drive.js");
const parts = require("../lib/parts.js");
const errors = require("../lib/errors.js");
```

`contentDisposition`（32〜38 行）の後に足す:

```js
// 案内で返すファイル名。改行・制御文字を除き、200 文字まで
function displayName(name) {
  return String(name || "document.pdf").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
}
```

`handle`（45〜122 行）を次に置き換える:

```js
async function handle(req, res, deps) {
  if (req.method !== "POST") return reply(res, errors.deny());
  const body = parseBody(req);
  if (!body) return reply(res, errors.deny());
  const ip = clientIp(req);

  let g;
  try {
    g = await decide({ d: body.d, idToken: body.idToken, ip }, deps);
  } catch (e) {
    // decide が例外を投げるのは KV 障害など、本人確認より手前の異常。
    // 本文・トークンは絶対にログへ出さない（e.message だけ）。ref も付けない一律 403
    console.log(`open error ${e && e.message}`);
    return reply(res, errors.deny());
  }
  if (!g.allow) {
    console.log(`open denied reason=${g.log.reason}${g.log.alert ? " ALERT" : ""} ref=${g.response.body.ref || "-"}`);
    return reply(res, g.response);
  }

  const { kv, drive } = deps;
  // 全体を返す・券を出す境目・全体の取得の上限は、すべて設計書の固定値 parts.WHOLE_MAX（deps.maxBytes・MAX_PDF_BYTES は使わない）
  const fail = async (code, reason, alert) => {
    // 先にログを出す。auditConfirm が落ちても、理由と ALERT の合図はここで必ず残る
    console.log(`open ${reason}${alert ? " ALERT" : ""} ref=${g.ref}`);
    try {
      await kv.auditConfirm(g.auditId, { result: "denied", reason, alert: !!alert });
    } catch {
      // 予約行は reserved のまま残るが、応答は必ず返す。KV障害を未処理の500にしない
      console.log(`open audit-confirm failed ref=${g.ref}`);
    }
    return reply(res, errors.authed(code, g.ref));
  };
  const failDrive = (reason) => {
    if (reason === "too-large") return fail("too-large", "too-large", false);
    if (reason === "trashed" || reason === "not-found") return fail("replaced", "drive-error", true);
    return fail("retry", "drive-error", false);
  };

  // Drive の大きさ（中身は取らない）。券を出すか・全体か・分けるかをここで決める
  const st = await statPdf(g.payload.f, { drive });
  if (!st.ok) return failDrive(st.reason);

  if (body.mode === "ticket") {
    // 保存は全体が 4,000,000 バイト（WHOLE_MAX）以下と分かったときだけ。大きいものは券を出さない（分けての保存は次の段）。
    // 大きさが読めない（size が無い）ときも券を出さない（分けて渡す対象に保存の道を作らないため。開き直してもらう）
    if (st.size == null) return fail("retry", "ticket-no-size", false);
    if (st.size > parts.WHOLE_MAX) return fail("too-large", "too-large-ticket", false);
    // 券の鍵は 24 バイトの乱数（base64url で 32 字）。鍵そのものはログに出さない
    const key = crypto.randomBytes(24).toString("base64url");
    const p = g.payload;
    try {
      await kv.ticketPut(key, { s: p.s, f: p.f, h: p.h, i: p.i, jti: p.jti, userId: g.userId, ref: g.ref, auditId: g.auditId }, TICKET_TTL_SEC);
    } catch {
      return fail("retry", "ticket-error", false);
    }
    try {
      await kv.auditConfirm(g.auditId, { result: "ticket-issued" });
    } catch {
      console.log(`open ticket-issued but audit-confirm failed ref=${g.ref}`);
    }
    console.log(`open ticket-issued ref=${g.ref}`);
    return reply(res, { status: 200, body: { ok: true, url: `/api/dl?k=${key}` } });
  }

  // 分けて渡す案内（設計 19）。閲覧の番号を KV に 10 分置き、トークンの jti・この人・ファイル・部分の数に結び付ける。
  // 監査はこの 1 件だけ（部分の取得では書かない）。size は Drive のメタの値、またはメタが当てにならないときは取れた中身の実際の長さ
  const issueParts = async (size, name) => {
    if (size > parts.MAX_BYTES) return fail("too-large", "too-large", false);
    const plan = parts.plan(size);
    const viewId = crypto.randomBytes(24).toString("base64url");
    const p = g.payload;
    try {
      await kv.viewPut(viewId, {
        jti: p.jti, userId: g.userId, s: p.s, f: p.f, h: p.h, i: p.i,
        size, parts: plan.parts, partSize: plan.partSize, ref: g.ref,
      }, parts.VIEW_TTL_SEC);
    } catch {
      return fail("retry", "view-error", false);
    }
    try {
      await kv.auditConfirm(g.auditId, { result: "parts-issued", bytes: size, parts: plan.parts });
    } catch {
      console.log(`open parts-issued but audit-confirm failed ref=${g.ref}`);
    }
    console.log(`open parts-issued ref=${g.ref} bytes=${size} parts=${plan.parts}`);
    return reply(res, { status: 200, body: {
      ok: true, mode: "parts", viewId, size, parts: plan.parts, partSize: plan.partSize, name: displayName(name),
    } });
  };

  if (st.size != null && st.size > parts.WHOLE_MAX) return issueParts(st.size, st.name);

  const got = await fetchPdf(g.payload.f, { drive, maxBytes: parts.WHOLE_MAX, stat: st });
  if (!got.ok) {
    // メタが小さい（または大きさが無い）のに中身が 4,000,000 を超えた：413 にせず、取れた実際の長さで案内に合流する
    if (got.reason === "too-large" && Number.isSafeInteger(got.size)) return issueParts(got.size, st.name);
    return failDrive(got.reason);
  }
  // 返すバイト列そのものの sha256 が、配布トークン（＝棚で承認した実体）と一致するまで一切返さない
  const sha = crypto.createHash("sha256").update(got.bytes).digest("hex");
  if (sha !== g.payload.h) return fail("replaced", "hash-mismatch", true);

  // ヘッダーの組み立て（名前の加工で失敗しうる）を、監査を allowed に確定する前に済ませる。
  // 後で失敗すると「確定した(allowed)のに何も返さない」行が残ってしまう
  const disposition = contentDisposition(got.name);

  try {
    await kv.auditConfirm(g.auditId, { result: "allowed", bytes: got.bytes.length });
  } catch {
    // 予約は書けている（渡す前の記録は残る）。確定が書けなかったことだけログに
    console.log(`open allowed but audit-confirm failed ref=${g.ref}`);
  }
  console.log(`open allowed ref=${g.ref} bytes=${got.bytes.length}`);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", disposition);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(200).send(got.bytes);
}
```

exports（124〜127 行）の最後に 1 行足す:

```js
module.exports.displayName = displayName;
```

`delivery/api/dl.js`：4 行目の require の並びに 1 行足し、47 行目と 78 行目を置き換える（`deps.maxBytes` はもう読まない）:

```js
const parts = require("../lib/parts.js");
```

```js
  const { kv, drive, now = Date.now() } = deps;
```

```js
  // 上限は設計書の固定値（deps.maxBytes・MAX_PDF_BYTES は使わない）。open.js の全体を返す境目と同じ値
  const got = await fetchPdf(rec.f, { drive, maxBytes: parts.WHOLE_MAX });
```

`delivery/test/dl.test.js`：`const get = …` の行の前に券を直接置く部品を足す（`open` は 4,000,000 超に券を出さないので、大きい中身の試験は券を自分で置く）:

```js
// 券を直接置く（open を通さない）。dl 単体の上限の試験用。鍵は 32 字
async function putTicket(s, key) {
  await s.kv.ticketPut(key, { s: "s1", f: "F1", h: SHA, i: Math.floor(NOW / 1000), jti: s.jti, userId: U, ref: "r1r1r1r1", auditId: null }, 60);
  return key;
}
```

`delivery/test/dl.test.js` の `test("dl: Drive の障害は retry、大きすぎは too-large", …)` を次に置き換える:

```js
test("dl: Drive の障害は retry、大きすぎは too-large", async () => {
  const s = await issued();
  s.deps.drive = { meta: async () => { throw new Error("ECONNRESET"); }, bytes: async () => PDF };
  const r1 = fakeRes();
  await handle(get(s.k), r1, s.deps);
  assert.equal(r1.statusCode, 503);
  assert.equal(r1.body.code, "retry");
  const big = await issued();
  const k2 = await putTicket(big, "b".repeat(32));
  big.deps.drive = fakeDrive({ F1: { bytes: Buffer.alloc(5000000) } });
  const r2 = fakeRes();
  await handle(get(k2), r2, big.deps);
  assert.equal(r2.statusCode, 413);
});

test("dl: 上限は固定の 4,000,000。deps.maxBytes（MAX_PDF_BYTES）が大きくても 4,000,001 は返さず、小さくても 4,000,000 以下は返す", async () => {
  const over = await issued();
  over.deps.maxBytes = 10000000;
  const k1 = await putTicket(over, "c".repeat(32));
  over.deps.drive = { meta: async () => ({ id: "F1", name: "x.pdf", size: "10", trashed: false }), bytes: async () => Buffer.alloc(4000001) };
  const r1 = fakeRes();
  await handle(get(k1), r1, over.deps);
  assert.equal(r1.statusCode, 413);
  assert.equal(r1.body.code, "too-large");
  // 小さい maxBytes でも、4,000,000 以下の中身は返す（sha256 が合えば）
  const under = await issued();
  under.deps.maxBytes = 1000000;
  const body = Buffer.alloc(2000000, 0x20);
  body.write("%PDF-1.4\n", 0);
  const k2 = "d".repeat(32);
  await under.kv.ticketPut(k2, { s: "s1", f: "F1", h: crypto.createHash("sha256").update(body).digest("hex"), i: Math.floor(NOW / 1000), jti: under.jti, userId: U, ref: "r1r1r1r1", auditId: null }, 60);
  under.deps.drive = fakeDrive({ F1: { bytes: body } });
  const r2 = fakeRes();
  await handle(get(k2), r2, under.deps);
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.body.length, 2000000);
});
```

- [ ] **Step 4: 通ることを確かめる**

Run: `node --test test/open-parts.test.js test/open.test.js test/dl.test.js && npm test`
Expected: PASS（`dl.test.js` の券は本物の `open.handle` で作る小さい PDF のものと、大きい中身の試験用に直接置いたものがある）。全体 `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add delivery/api/open.js delivery/api/dl.js delivery/test/open.test.js delivery/test/open-parts.test.js delivery/test/dl.test.js
git commit -m "$(cat <<'EOF'
feat(delivery): 4MB を超える PDF は分けて渡す案内（viewId）を返し、保存の券は大きさを確かめてから出す。全体・券・dl の上限は固定値

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `/api/open` の部分の取得（毎回の確認・結び付き・総数と速さの上限・範囲取得）

**Files:**
- Modify: `delivery/api/open.js`（require に `fetchRange`、`VIEW_ID_RE` と `handlePart` を足す、`handle` の `const ip = clientIp(req);` の直後に振り分けを 1 行）
- Test: `delivery/test/open-parts.test.js`（末尾に足す）

**Interfaces:**
- Consumes: Task 2 `decide(…, deps, { rate: false, reserve: false, audit: false })`、Task 3 `fetchRange`、Task 4 `parts.*`・`kv.viewGet`・`kv.viewPartHit`・`kv.rateHit`・`errors.authed("slow"|"reopen")`、Task 5 の閲覧の記録
- Produces:
  - 要求：`POST /api/open` 本文 `{ d, idToken, viewId, part }`（`part` は 0 から部分の数未満の整数）
  - 成功：200、`Content-Type: application/octet-stream`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、本文はその範囲のバイト列
  - 失敗：`viewId` 無し・形違い・番号違い・KV に無い・結び付きが違う → 403 `denied`／速さの上限 → 429 `slow`／総数の上限 → 410 `reopen`／Drive の範囲違い・障害 → 503 `retry`／全体の大きさが変わった・消えた → 409 `replaced`／gate の拒否はそのまま（期限切れ 410 `expired`、失効 409 `replaced`、在籍なし 403 など）

- [ ] **Step 1: 失敗するテストを書く**

`delivery/test/open-parts.test.js` の `module.exports = …` の行の **前** に足す:

```js
async function openView(s, deps = s.deps) {
  const r = await call(s, { d: s.d, idToken: TOK }, deps);
  assert.equal(r.body.mode, "parts");
  return r.body.viewId;
}
const isPart = (r) => r.statusCode === 200 && r.headers["content-type"] === "application/octet-stream";
const memberCalls = (deps) => deps.fetchImpl.calls.filter((c) => c.url.includes("/member/")).length;
const DENIED = [403, { ok: false, code: "denied" }];

test("部分：順に取ってつなぐとトークンの sha256 と一致する。no-store。監査は 1 閲覧 1 件のまま。在籍は部分ごとに聞き直す", async () => {
  const s = setup(); await s.ready;
  const viewId = await openView(s);
  const got = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await call(s, { d: s.d, idToken: TOK, viewId, part: i });
    assert.ok(isPart(r), `part ${i}: ${r.statusCode} ${JSON.stringify(r.body && r.body.code)}`);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    got.push(r.body);
  }
  assert.deepEqual(got.map((b) => b.length), [3500000, 3500000, 200009]);
  assert.equal(sha(Buffer.concat(got)), sha(BIG));
  const list = await s.kv.auditList(10);
  assert.equal(list.length, 1, "部分ごとには監査を書かない");
  assert.equal(list[0].result, "parts-issued");
  assert.equal(memberCalls(s.deps), 1 + 3, "案内 1 回 + 部分 3 回");
});

test("部分：Drive には範囲を指定して取る（0 から、最後は全体の終わりまで）", async () => {
  const s = setup(); await s.ready;
  const seen = [];
  const orig = s.deps.drive.range;
  s.deps.drive.range = async (f, a, b) => { seen.push([f, a, b]); return orig(f, a, b); };
  const viewId = await openView(s);
  for (let i = 0; i < 3; i += 1) await call(s, { d: s.d, idToken: TOK, viewId, part: i });
  assert.deepEqual(seen, [["F1", 0, 3499999], ["F1", 3500000, 6999999], ["F1", 7000000, 7200008]]);
});

test("部分：viewId の無い取得・形の違う viewId・番号の範囲外や数でないものは 403 denied（Drive に触らない）", async () => {
  const s = setup(); await s.ready;
  let rangeCalls = 0;
  const orig = s.deps.drive.range;
  s.deps.drive.range = async (...a) => { rangeCalls += 1; return orig(...a); };
  const viewId = await openView(s);
  const bad = [
    { part: 0 },
    { viewId },
    { viewId: "short", part: 0 },
    { viewId: "v".repeat(32), part: 0 }, // KV に無い
    { viewId, part: 3 },
    { viewId, part: -1 },
    { viewId, part: 1.5 },
    { viewId, part: "0" },
    { viewId, part: 15 },
  ];
  for (const extra of bad) {
    const r = await call(s, { d: s.d, idToken: TOK, ...extra });
    assert.deepEqual([r.statusCode, r.body], DENIED, JSON.stringify({ ...extra, viewId: extra.viewId && extra.viewId.length }));
  }
  assert.equal(rangeCalls, 0);
});

test("部分：他人の viewId・別のトークンでの取得は 403 denied", async () => {
  const s = setup({ roster: [U, U2] }); await s.ready;
  const viewId = await openView(s);
  const asU2 = { ...s.deps, fetchImpl: fetchFor(U2) };
  const r1 = await call(s, { d: s.d, idToken: TOK, viewId, part: 0 }, asU2);
  assert.deepEqual([r1.statusCode, r1.body], DENIED);
  const other = issueWith({ sha256: sha(BIG), now: NOW }, kp);
  const r2 = await call(s, { d: other.d, idToken: TOK, viewId, part: 0 });
  assert.deepEqual([r2.statusCode, r2.body], DENIED);
});

test("部分：閲覧が KV から消えた（10 分過ぎ）なら 403 denied", async () => {
  const s = setup(); await s.ready;
  const viewId = await openView(s);
  await s.redis.del(`view:${viewId}`);
  const r = await call(s, { d: s.d, idToken: TOK, viewId, part: 0 });
  assert.deepEqual([r.statusCode, r.body], DENIED);
});

test("部分：トークンが期限切れなら 410 expired。失効したら 409 replaced。在籍していなければ 403 denied", async () => {
  const s = setup(); await s.ready;
  const viewId = await openView(s);
  const late = NOW + 90000 * 1000;
  const r1 = await call(s, { d: s.d, idToken: TOK, viewId, part: 0 }, { ...s.deps, now: late, fetchImpl: fetchFor(U, { now: late }) });
  assert.equal(r1.statusCode, 410);
  assert.equal(r1.body.code, "expired");
  const notMember = { ...s.deps, fetchImpl: fetchFor(U, { member: { status: 404, body: {} } }) };
  const r2 = await call(s, { d: s.d, idToken: TOK, viewId, part: 0 }, notMember);
  assert.deepEqual([r2.statusCode, r2.body], DENIED);
  await s.kv.revokeJti(s.jti);
  const r3 = await call(s, { d: s.d, idToken: TOK, viewId, part: 0 });
  assert.equal(r3.statusCode, 409);
  assert.equal(r3.body.code, "replaced");
});

test("部分：取得が拒否された（在籍なし・期限切れ・失効・他人・viewId 不正）閲覧でも、監査は案内の 1 件のまま", async () => {
  const s = setup({ roster: [U, U2] }); await s.ready;
  const viewId = await openView(s);
  assert.ok(isPart(await call(s, { d: s.d, idToken: TOK, viewId, part: 0 })));
  const notMember = { ...s.deps, fetchImpl: fetchFor(U, { member: { status: 404, body: {} } }) };
  assert.equal((await call(s, { d: s.d, idToken: TOK, viewId, part: 1 }, notMember)).statusCode, 403);
  const late = NOW + 90000 * 1000;
  assert.equal((await call(s, { d: s.d, idToken: TOK, viewId, part: 1 }, { ...s.deps, now: late, fetchImpl: fetchFor(U, { now: late }) })).statusCode, 410);
  assert.equal((await call(s, { d: s.d, idToken: TOK, viewId, part: 1 }, { ...s.deps, fetchImpl: fetchFor(U2) })).statusCode, 403);
  assert.equal((await call(s, { d: s.d, idToken: TOK, viewId: "short", part: 1 })).statusCode, 403);
  await s.kv.revokeJti(s.jti);
  assert.equal((await call(s, { d: s.d, idToken: TOK, viewId, part: 1 })).statusCode, 409);
  const list = await s.kv.auditList(20);
  assert.equal(list.length, 1, "部分の取得では、拒否も含めて監査を書かない");
  assert.equal(list[0].result, "parts-issued");
});

test("部分：1 つの部分は合計 3 回まで。4 回目は 410 reopen。ほかの部分は取れる", async () => {
  const s = setup(); await s.ready;
  const viewId = await openView(s);
  for (let i = 0; i < 3; i += 1) assert.ok(isPart(await call(s, { d: s.d, idToken: TOK, viewId, part: 0 })));
  const r = await call(s, { d: s.d, idToken: TOK, viewId, part: 0 });
  assert.equal(r.statusCode, 410);
  assert.equal(r.body.code, "reopen");
  assert.match(r.body.ref, /^[0-9a-f]{8}$/);
  assert.ok(isPart(await call(s, { d: s.d, idToken: TOK, viewId, part: 1 })));
});

test("部分：速さの上限（1 分あたり部分の数×2 回）を超えたら 429 slow。総数には数えない", async () => {
  const s = setup(); await s.ready; // 3 部分 → 1 分 6 回まで
  const viewId = await openView(s);
  for (const part of [0, 0, 0, 1, 1, 1]) assert.ok(isPart(await call(s, { d: s.d, idToken: TOK, viewId, part })));
  const r = await call(s, { d: s.d, idToken: TOK, viewId, part: 2 });
  assert.equal(r.statusCode, 429);
  assert.equal(r.body.code, "slow");
  assert.equal(await s.redis.get(`view:${viewId}:p:2`), null, "速さで断った分は総数に数えない");
});

test("部分：Drive が範囲を守らなければ 503 retry。全体の大きさが変わっていれば 409 replaced", async () => {
  const s = setup(); await s.ready;
  const viewId = await openView(s);
  s.deps.drive.range = async () => ({ status: 200, contentRange: "", bytes: BIG });
  const r1 = await call(s, { d: s.d, idToken: TOK, viewId, part: 0 });
  assert.equal(r1.statusCode, 503);
  assert.equal(r1.body.code, "retry");
  s.deps.drive.range = async () => ({ status: 206, contentRange: "bytes 0-3499998/7200009", bytes: BIG.subarray(0, 3499999) });
  const r2 = await call(s, { d: s.d, idToken: TOK, viewId, part: 0 });
  assert.equal(r2.statusCode, 503);
  s.deps.drive.range = async () => ({ status: 206, contentRange: "bytes 3500000-6999999/9999999", bytes: BIG.subarray(3500000, 7000000) });
  const r3 = await call(s, { d: s.d, idToken: TOK, viewId, part: 1 });
  assert.equal(r3.statusCode, 409);
  assert.equal(r3.body.code, "replaced");
});

test("途中で止まる：2 番目の部分で Drive が 2 回落ちても、3 回目で取れて、つないだ sha256 は一致する", async () => {
  const s = setup(); await s.ready;
  const viewId = await openView(s);
  let fails = 0;
  const orig = s.deps.drive.range;
  s.deps.drive.range = async (f, a, b) => {
    if (a === 3500000 && fails < 2) { fails += 1; throw new Error("ECONNRESET"); }
    return orig(f, a, b);
  };
  const got = [];
  for (let i = 0; i < 3; i += 1) {
    for (;;) {
      const r = await call(s, { d: s.d, idToken: TOK, viewId, part: i });
      if (isPart(r)) { got.push(r.body); break; }
      assert.equal(r.body.code, "retry");
    }
  }
  assert.equal(fails, 2);
  assert.equal(sha(Buffer.concat(got)), sha(BIG));
});

test("部分：グループあてのトークン（g が一致）なら、名簿に無くても部分を取れる（在籍は毎回聞く）", async () => {
  const s = setup({ roster: [], extra: { aud: "line-group", g: GROUP } }); await s.ready;
  const viewId = await openView(s);
  const got = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await call(s, { d: s.d, idToken: TOK, viewId, part: i });
    assert.ok(isPart(r));
    got.push(r.body);
  }
  assert.equal(sha(Buffer.concat(got)), sha(BIG));
  assert.equal(memberCalls(s.deps), 4);
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/open-parts.test.js`
Expected: FAIL（部分の要求も gate → 全体の案内に進み、`content-type` が `application/json` になるなど）

- [ ] **Step 3: 実装する**

`delivery/api/open.js` の require の行を置き換える:

```js
const { fetchPdf, statPdf, fetchRange } = require("../lib/drive.js");
```

`const TICKET_TTL_SEC = 60;` の次の行に足す:

```js
const VIEW_ID_RE = /^[A-Za-z0-9_-]{32}$/;
```

`handle` の `const ip = clientIp(req);` の直後に 1 行足す:

```js
  // viewId か part があれば部分の取得（設計 19）。どちらか片方だけでも、全体の取得としては扱わない
  if (body.viewId !== undefined || body.part !== undefined) return handlePart(body, ip, res, deps);
```

`handle` 関数の閉じ括弧の後（`module.exports = …` の前）に足す:

```js
// 部分の取得（設計 19）。本文: { d, idToken, viewId, part }
// 順番：viewId の形と番号 → KV の閲覧の記録 → 速さの上限（この閲覧だけの別枠・1 分あたり部分の数×2）
// → gate（トークン・ログイン・名簿（必要なとき）・在籍・失効。IP/トークン/人の回数・監査の予約・拒否の監査の記録はすべて省く）
// → 結び付き（同じトークン・同じ人・同じファイル）→ 総数の上限（1 部分 3 回）→ Drive から範囲で取る
// （206・Content-Range を確かめる）→ その範囲だけ返す。監査は案内のときの 1 件だけで、ここでは成功も拒否も書かない
async function handlePart(body, ip, res, deps) {
  const { kv, drive } = deps;
  const { viewId, part } = body;
  if (typeof viewId !== "string" || !VIEW_ID_RE.test(viewId) || !Number.isInteger(part) || part < 0 || part >= parts.MAX_PARTS) {
    console.log("open part denied reason=bad-part");
    return reply(res, errors.deny());
  }
  let view;
  try {
    view = await kv.viewGet(viewId);
  } catch (e) {
    console.log(`open part error ${e && e.message}`);
    return reply(res, errors.deny());
  }
  if (!parts.validView(view) || part >= view.parts) {
    console.log("open part denied reason=no-view");
    return reply(res, errors.deny());
  }
  const ref = view.ref;

  // 速さの上限は総数より先に見る（速さで断った分は総数に数えない。閲覧側は待って取り直す）
  let fast;
  try {
    fast = await kv.rateHit("part", viewId, view.parts * parts.RATE_PER_PART, 60);
  } catch {
    return reply(res, errors.authed("retry", ref));
  }
  if (!fast) {
    console.log(`open part slow ref=${ref}`);
    return reply(res, errors.authed("slow", ref));
  }

  let g;
  try {
    g = await decide({ d: body.d, idToken: body.idToken, ip }, deps, { rate: false, reserve: false, audit: false });
  } catch (e) {
    console.log(`open part error ${e && e.message}`);
    return reply(res, errors.deny());
  }
  if (!g.allow) {
    console.log(`open part denied reason=${g.log.reason}${g.log.alert ? " ALERT" : ""} ref=${ref}`);
    return reply(res, g.response);
  }
  const p = g.payload;
  if (p.jti !== view.jti || g.userId !== view.userId || p.f !== view.f || p.h !== view.h) {
    console.log(`open part denied reason=view-mismatch ALERT ref=${ref}`);
    return reply(res, errors.deny());
  }

  let within;
  try {
    within = await kv.viewPartHit(viewId, part, parts.FETCH_MAX, parts.VIEW_TTL_SEC);
  } catch {
    return reply(res, errors.authed("retry", ref));
  }
  if (!within) {
    console.log(`open part denied reason=part-cap ref=${ref} part=${part}`);
    return reply(res, errors.authed("reopen", ref));
  }

  const { start, end } = parts.rangeOf(view, part);
  const got = await fetchRange(view.f, { drive, start, end, total: view.size });
  if (!got.ok) {
    if (got.reason === "size-changed" || got.reason === "not-found") {
      console.log(`open part ${got.reason} ALERT ref=${ref} part=${part}`);
      return reply(res, errors.authed("replaced", ref));
    }
    console.log(`open part ${got.reason} ref=${ref} part=${part}`);
    return reply(res, errors.authed("retry", ref));
  }
  console.log(`open part ref=${ref} part=${part}/${view.parts} bytes=${got.bytes.length}`);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(200).send(got.bytes);
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `node --test test/open-parts.test.js test/open.test.js && npm test`
Expected: PASS。全体 `ℹ fail 0`（速さの上限の試験は 1 分の窓の境目をまたぐと揺れうる。既存の gate の回数の試験と同じ前提。落ちたらもう一度流して確かめる）

- [ ] **Step 5: Commit**

```bash
git add delivery/api/open.js delivery/test/open-parts.test.js
git commit -m "$(cat <<'EOF'
feat(delivery): 部分の取得。毎回トークン・ログイン・在籍・失効と viewId の結び付きを確かめ、範囲だけ返す

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 閲覧側の組み立て（`public/parts.mjs`：取り直し・sha256 照合）

**Files:**
- Create: `delivery/public/parts.mjs`
- Test: `delivery/test/parts-client.test.js`（新規）

**Interfaces:**
- Consumes: Task 5・6 の案内と部分の応答（通し試験で `api/open.js` の `handle` を直接呼ぶ）、`test/open-parts.test.js` の `module.exports`（`setup`・`call` など）
- Produces（ES Module、`/parts.mjs`）:
  - `PART_TRIES = 3`、`SLOW_WAITS_MAX = 12`、`SLOW_WAIT_MS = 5000`
  - `validInfo(info) → boolean`
  - `partLength(info, i) → number`
  - `tokenSha256(d) → string | null`（配布トークンの `h`。署名は見ない。サーバが同じトークンで照合済み）
  - `sha256Hex(bytes, subtle?) → Promise<string>`
  - `fetchAllParts(info, { fetchPart, sleep?, onProgress? }) → Promise<Uint8Array>`
  - `assembleAndVerify({ info, d, fetchPart, sleep?, onProgress?, subtle? }) → Promise<Uint8Array>`（失敗は `Error` に `code`（`"hash"`・`"retry"`・`"slow"`・`"denied"` ほか）と `ref`）
  - `fetchPart(i)` の約束：`{ ok: true, bytes: ArrayBuffer | Uint8Array } | { ok: false, code: string, ref?: string }`（投げてもよい＝通信の失敗）

- [ ] **Step 1: 失敗するテストを書く**

`delivery/test/parts-client.test.js`:

```js
// 閲覧側の組み立て（public/parts.mjs）。ブラウザに依存しない純粋な関数なので node で試す（crypto.subtle は node にもある）
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");
const { pathToFileURL } = require("url");
const { keyPair, issueWith } = require("./signtoken.js");

const load = () => import(pathToFileURL(path.join(__dirname, "..", "public", "parts.mjs")).href);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const kp = keyPair();
const NOW = Date.UTC(2026, 9, 9, 3, 0, 0);
const DATA = Buffer.from("%PDF-1.4\nabcdefghijklmnop"); // 25 バイト → 部分 10 バイトで 3 部分
const info = (bytes = DATA, partSize = 10) => ({ ok: true, mode: "parts", viewId: "v".repeat(32), size: bytes.length, parts: Math.ceil(bytes.length / partSize), partSize, name: "x.pdf" });
const tokenFor = (bytes) => issueWith({ sha256: sha(bytes), now: NOW }, kp).d;

// 部分 i に対し、script[i] の応答を順に返し、尽きたら本物の範囲を返す
function server(bytes, partSize, script = {}) {
  const calls = [];
  const fetchPart = async (i) => {
    calls.push(i);
    const queue = script[i] || [];
    const next = queue.shift();
    if (next === "throw") throw new Error("network");
    if (next) return next;
    return { ok: true, bytes: new Uint8Array(bytes.subarray(i * partSize, Math.min(bytes.length, (i + 1) * partSize))) };
  };
  return { fetchPart, calls };
}
const recorder = () => { const waits = []; const sleep = async (ms) => { waits.push(ms); }; return { waits, sleep }; };

test("validInfo: 案内の形を確かめる", async () => {
  const { validInfo } = await load();
  assert.equal(validInfo(info()), true);
  for (const patch of [{ ok: false }, { mode: "full" }, { viewId: "x" }, { size: 0 }, { size: 50 * 1024 * 1024 + 1, parts: 16 }, { parts: 2 }, { partSize: 0 }, { parts: 16, size: 160, partSize: 10 }]) {
    assert.equal(validInfo({ ...info(), ...patch }), false, JSON.stringify(patch));
  }
  assert.equal(validInfo(null), false);
});

test("tokenSha256: 配布トークンの h を読む。壊れていれば null", async () => {
  const { tokenSha256 } = await load();
  assert.equal(tokenSha256(tokenFor(DATA)), sha(DATA));
  assert.equal(tokenSha256("x"), null);
  assert.equal(tokenSha256(""), null);
  assert.equal(tokenSha256(null), null);
});

test("assembleAndVerify: 部分を順につなぎ、sha256 が合えば全体を返す。進み具合を知らせる", async () => {
  const { assembleAndVerify } = await load();
  const srv = server(DATA, 10);
  const progress = [];
  const out = await assembleAndVerify({ info: info(), d: tokenFor(DATA), fetchPart: srv.fetchPart, sleep: async () => {}, onProgress: (n, all) => progress.push([n, all]) });
  assert.equal(Buffer.compare(Buffer.from(out), DATA), 0);
  assert.deepEqual(srv.calls, [0, 1, 2]);
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
});

test("取り直し：1 つの部分が 2 回失敗しても 3 回目で取れれば続ける（待ちは 1 秒・2 秒）", async () => {
  const { assembleAndVerify } = await load();
  const srv = server(DATA, 10, { 1: [{ ok: false, code: "retry", ref: "r1" }, "throw"] });
  const rec = recorder();
  const out = await assembleAndVerify({ info: info(), d: tokenFor(DATA), fetchPart: srv.fetchPart, sleep: rec.sleep });
  assert.equal(Buffer.compare(Buffer.from(out), DATA), 0);
  assert.deepEqual(srv.calls, [0, 1, 1, 1, 2]);
  assert.deepEqual(rec.waits, [1000, 2000]);
});

test("取り直し：3 回とも失敗したら、その先の部分は取らずに失敗する（code・ref 付き）", async () => {
  const { assembleAndVerify } = await load();
  const fail = { ok: false, code: "retry", ref: "abcd1234" };
  const srv = server(DATA, 10, { 1: [fail, fail, fail] });
  await assert.rejects(
    assembleAndVerify({ info: info(), d: tokenFor(DATA), fetchPart: srv.fetchPart, sleep: async () => {} }),
    (e) => e.code === "retry" && e.ref === "abcd1234",
  );
  assert.deepEqual(srv.calls, [0, 1, 1, 1]);
});

test("取り直さない拒否（denied・expired・replaced・stopped・reopen）はすぐやめる", async () => {
  const { assembleAndVerify } = await load();
  for (const code of ["denied", "expired", "replaced", "stopped", "reopen"]) {
    const srv = server(DATA, 10, { 0: [{ ok: false, code, ref: "r" }] });
    await assert.rejects(assembleAndVerify({ info: info(), d: tokenFor(DATA), fetchPart: srv.fetchPart, sleep: async () => {} }), (e) => e.code === code);
    assert.deepEqual(srv.calls, [0], code);
  }
});

test("速さの上限（slow）は 5 秒待って取り直し、3 回の回数に数えない。待ちすぎたらやめる", async () => {
  const { assembleAndVerify, SLOW_WAITS_MAX } = await load();
  const slow = { ok: false, code: "slow" };
  const retry = { ok: false, code: "retry" };
  const srv = server(DATA, 10, { 0: [slow, slow, retry, retry] });
  const rec = recorder();
  const out = await assembleAndVerify({ info: info(), d: tokenFor(DATA), fetchPart: srv.fetchPart, sleep: rec.sleep });
  assert.equal(Buffer.compare(Buffer.from(out), DATA), 0);
  assert.deepEqual(srv.calls.filter((i) => i === 0).length, 5, "slow 2 回 + 失敗 2 回 + 成功 1 回");
  assert.deepEqual(rec.waits, [5000, 5000, 1000, 2000]);

  const many = server(DATA, 10, { 0: Array(SLOW_WAITS_MAX + 1).fill(slow) });
  await assert.rejects(assembleAndVerify({ info: info(), d: tokenFor(DATA), fetchPart: many.fetchPart, sleep: async () => {} }), (e) => e.code === "slow");
});

test("長さの違う部分は失敗として数える", async () => {
  const { assembleAndVerify } = await load();
  const short = { ok: true, bytes: new Uint8Array(3) };
  const srv = server(DATA, 10, { 2: [short] });
  const out = await assembleAndVerify({ info: info(), d: tokenFor(DATA), fetchPart: srv.fetchPart, sleep: async () => {} });
  assert.equal(Buffer.compare(Buffer.from(out), DATA), 0);
  assert.deepEqual(srv.calls, [0, 1, 2, 2]);
});

test("つないだ sha256 がトークンと違えば返さない（code: hash）。トークンが読めなくても返さない", async () => {
  const { assembleAndVerify } = await load();
  const swapped = Buffer.from(DATA);
  swapped[20] ^= 0xff;
  const srv = server(swapped, 10);
  await assert.rejects(assembleAndVerify({ info: info(), d: tokenFor(DATA), fetchPart: srv.fetchPart, sleep: async () => {} }), (e) => e.code === "hash");
  const ok = server(DATA, 10);
  await assert.rejects(assembleAndVerify({ info: info(), d: "broken", fetchPart: ok.fetchPart, sleep: async () => {} }), (e) => e.code === "hash");
  assert.deepEqual(ok.calls, [], "トークンが読めなければ部分を取りに行かない");
});

test("通し：本物の /api/open の案内と部分の取得をつなぎ、閲覧側で組み立てて sha256 が合う", async () => {
  const { assembleAndVerify, validInfo } = await load();
  const { setup, call, TOK, BIG } = require("./open-parts.test.js");
  const s = setup(); await s.ready;
  const first = await call(s, { d: s.d, idToken: TOK });
  assert.equal(validInfo(first.body), true);
  const fetchPart = async (i) => {
    const r = await call(s, { d: s.d, idToken: TOK, viewId: first.body.viewId, part: i });
    if (r.statusCode === 200 && r.headers["content-type"] === "application/octet-stream") return { ok: true, bytes: new Uint8Array(r.body) };
    return { ok: false, code: r.body.code, ref: r.body.ref };
  };
  const out = await assembleAndVerify({ info: first.body, d: s.d, fetchPart, sleep: async () => {} });
  assert.equal(sha(Buffer.from(out)), sha(BIG));
});
```

（`open-parts.test.js` を `require` すると、その中の試験もこのプロセスで登録されて走る。`node --test test/*.test.js` では同じ試験が 2 回流れるが、どちらも独立した `setup` で動くので結果は変わらない）

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/parts-client.test.js`
Expected: FAIL（`Cannot find module …/public/parts.mjs`）

- [ ] **Step 3: 実装する**

`delivery/public/parts.mjs`:

```js
// delivery/public/parts.mjs
// 大きい資料を「分けて渡す」ときの、閲覧側の組み立て（2026-10-09 設計 19）。
// ブラウザにも node のテストにも依存しない純粋な関数（通信は fetchPart、待ちは sleep として外から渡す）。
// 部分を 0 から順に取り、1 つの部分は 3 回まで取り直す（サーバ側の総数の上限も 3 回）。
// 速さの上限（slow）で断られた分は、サーバも数えないのでこちらも数えない（待って取り直す）。
// つないだ全体の sha256 を配布トークンの h と照合し、合わなければ返さない（描かせない）。
export const PART_TRIES = 3;
export const SLOW_WAITS_MAX = 12;
export const SLOW_WAIT_MS = 5000;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PARTS = 15;
// 取り直しても変わらない拒否。すぐやめて理由を出す
const FATAL = new Set(["denied", "expired", "replaced", "stopped", "reopen", "too-large"]);

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function failure(code, ref) {
  const e = new Error(code);
  e.code = code;
  if (ref) e.ref = ref;
  return e;
}

export function validInfo(info) {
  if (!info || info.ok !== true || info.mode !== "parts") return false;
  if (typeof info.viewId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(info.viewId)) return false;
  const { size, partSize, parts } = info;
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES) return false;
  if (!Number.isSafeInteger(partSize) || partSize <= 0) return false;
  return Number.isInteger(parts) && parts >= 1 && parts <= MAX_PARTS && parts === Math.ceil(size / partSize);
}

export function partLength(info, i) {
  const start = i * info.partSize;
  return Math.min(info.size, start + info.partSize) - start;
}

// 配布トークン（base64url(JSON).署名）の h を読む。署名はここでは見ない（サーバが同じトークンで照合済み）
export function tokenSha256(d) {
  try {
    const body = String(d || "").split(".")[0];
    if (!body) return null;
    const b64 = body.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "===".slice((b64.length + 3) % 4);
    const bin = atob(padded);
    const u8 = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const p = JSON.parse(new TextDecoder().decode(u8));
    return p && typeof p.h === "string" && /^[0-9a-f]{64}$/.test(p.h) ? p.h : null;
  } catch {
    return null;
  }
}

export async function sha256Hex(bytes, subtle = globalThis.crypto.subtle) {
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fetchAllParts(info, { fetchPart, sleep = defaultSleep, onProgress = () => {} }) {
  const out = new Uint8Array(info.size);
  for (let i = 0; i < info.parts; i += 1) {
    const want = partLength(info, i);
    let tries = 0;
    let slowWaits = 0;
    let last = { code: "retry" };
    for (;;) {
      if (tries >= PART_TRIES) throw failure(last.code || "retry", last.ref);
      let r;
      try {
        r = await fetchPart(i);
      } catch {
        r = { ok: false, code: "retry" };
      }
      if (r && r.ok) {
        const u8 = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes || new ArrayBuffer(0));
        if (u8.byteLength === want) {
          out.set(u8, i * info.partSize);
          break;
        }
        r = { ok: false, code: "retry" };
      }
      const code = (r && r.code) || "retry";
      if (code === "slow") {
        slowWaits += 1;
        if (slowWaits > SLOW_WAITS_MAX) throw failure("slow", r.ref);
        await sleep(SLOW_WAIT_MS);
        continue;
      }
      if (FATAL.has(code)) throw failure(code, r.ref);
      tries += 1;
      last = { code, ref: r.ref };
      if (tries < PART_TRIES) await sleep(1000 * tries);
    }
    onProgress(i + 1, info.parts);
  }
  return out;
}

export async function assembleAndVerify({ info, d, fetchPart, sleep = defaultSleep, onProgress = () => {}, subtle }) {
  if (!validInfo(info)) throw failure("hash");
  const want = tokenSha256(d);
  if (!want) throw failure("hash");
  const bytes = await fetchAllParts(info, { fetchPart, sleep, onProgress });
  const got = await sha256Hex(bytes, subtle || globalThis.crypto.subtle);
  if (got !== want) throw failure("hash");
  return bytes;
}
```

- [ ] **Step 4: 通ることを確かめる**

Run: `node --test test/parts-client.test.js && npm test`
Expected: PASS。全体 `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add delivery/public/parts.mjs delivery/test/parts-client.test.js
git commit -m "$(cat <<'EOF'
feat(delivery): 閲覧側で部分をつなぎ、3 回まで取り直し、全体の sha256 を照合してから渡す

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `app.js` の配線（分けて渡す資料の表示・保存の「大きい」案内）

**Files:**
- Modify: `delivery/public/app.js:1-149`（全体を置き換え）
- Test: `delivery/test/app.test.js`（新規）

**Interfaces:**
- Consumes: Task 7 `assembleAndVerify`・`validInfo`（`/parts.mjs`）、既存の `token.mjs`、Task 5 の案内、Task 6 の部分の応答、`errors` のコード `slow`・`reopen`、Task 5 の券の `too-large`
- Produces: 画面の動き。テストは偽物の DOM・LIFF・fetch・pdf.js の上で `app.js` 自体を node で実行し、①大きい資料は保存ボタンが出ない ②sha256 の照合に通るまで描かない（pdf.js に渡さない）③照合に通らなければ「もう一度開いてください」を出す、を確かめる。実際の描画と LIFF の実物は本番反映の節の実機の確認で見る

- [ ] **Step 1: 失敗するテストを書く**

`delivery/test/app.test.js`:

```js
// app.js を、偽物の DOM・LIFF・fetch・pdf.js の上で node のまま実行して、画面の動きを確かめる。
// app.js は ES Module（import 3 行・LIFF の liff・document などのグローバル）なので、import の 3 行だけを取り除き、
// 本物の parts.mjs・token.mjs（sha256 の照合も本物）と偽物を引数として渡した async 関数として動かす。
// pdf.js・LIFF・実際の描画は偽物なので、そこは反映前の実機の確認（本番反映の節）で見る
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { keyPair, issueWith } = require("./signtoken.js");

const SRC = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const pub = (f) => import(pathToFileURL(path.join(__dirname, "..", "public", f)).href);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const kp = keyPair();
const NOW = Date.UTC(2026, 9, 9, 3, 0, 0);
const DATA = Buffer.from("%PDF-1.4\nabcdefghijklmnop"); // 25 バイト → 部分 10 バイトで 3 部分
const tokenFor = (bytes) => issueWith({ sha256: sha(bytes), now: NOW }, kp).d;
const VIEW_ID = "v".repeat(32);
const INFO = { ok: true, mode: "parts", viewId: VIEW_ID, size: DATA.length, parts: 3, partSize: 10, name: "x.pdf" };

// app.js 本体を、import を除いた async 関数に変える。最後の即時実行の async を返り値にして、終わりを待てるようにする
function compile() {
  const noImports = SRC.replace(/^import .*$/gm, "");
  assert.notEqual(noImports, SRC, "import の行が見つからない");
  const m = noImports.match(/^\(async \(\) => \{$/gm);
  assert.equal(m && m.length, 1, "最後の即時実行の async が 1 つだけあるはず");
  const body = noImports.replace(/^\(async \(\) => \{$/m, "const __done = (async () => {") + "\nreturn __done;";
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction("pdfjs", "loginRedirectUri", "readParam", "readToken", "assembleAndVerify", "validInfo",
    "document", "window", "location", "history", "liff", "fetch", body);
}

function fakeDom() {
  const make = (tag) => ({
    tag, children: [], style: {}, hidden: tag === "save", disabled: false, className: "", textContent: "",
    getContext: () => ({}), appendChild(c) { this.children.push(c); return c; }, replaceChildren() { this.children = []; },
  });
  // index.html にある 3 つの要素。保存ボタンは最初は隠れている（hidden 属性つき）
  const els = { status: make("status"), save: make("save"), pages: make("pages") };
  return { els, document: { getElementById: (id) => els[id], createElement: (tag) => make(tag) } };
}

// server(req) → { status, type, body }。fetch の記録は calls（本文を JSON にして残す。トークン本体は比べるだけ）
async function run({ d, server, inClient = false }) {
  const parts = await pub("parts.mjs");
  const token = await pub("token.mjs");
  const dom = fakeDom();
  const events = []; // 順番の記録：part-0, part-1, ..., getDocument
  const calls = [];
  let rendered = null;
  const pdfjs = {
    GlobalWorkerOptions: {},
    getDocument: ({ data }) => {
      events.push("getDocument");
      rendered = Buffer.from(data);
      return { promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({ getViewport: () => ({ width: 100, height: 100 }), render: () => ({ promise: Promise.resolve() }), cleanup() {} }),
        cleanup: async () => {}, destroy: async () => {},
      }) };
    },
  };
  const fetchImpl = async (url, init) => {
    const req = JSON.parse(init.body);
    calls.push({ url, req });
    if (req.part !== undefined) events.push(`part-${req.part}`);
    const r = await server(req);
    const headers = { "content-type": r.type };
    const payload = r.type === "application/json" ? JSON.stringify(r.body) : r.body;
    return new Response(payload, { status: r.status, headers });
  };
  const liff = {
    init: async () => {}, isLoggedIn: () => true, getIDToken: () => "idtoken", isInClient: () => inClient,
    login() {}, openWindow() {},
  };
  const location = { search: `?t=${d}`, pathname: "/", origin: "https://viewer.test" };
  const fn = compile();
  await fn(pdfjs, token.loginRedirectUri, token.readParam, token.readToken, parts.assembleAndVerify, parts.validInfo,
    dom.document, { innerWidth: 400, devicePixelRatio: 1 }, location, { replaceState() {} }, liff, fetchImpl);
  return { dom, events, calls, rendered: () => rendered, status: () => dom.els.status.textContent, saveHidden: () => dom.els.save.hidden, pages: () => dom.els.pages.children.length };
}

// 分けて渡す側の偽サーバ：案内 → 部分。bytes を変えれば中身のすり替えを作れる
function partsServer(bytes, info = INFO) {
  return async (req) => {
    if (req.mode === "ticket") return { status: 500, type: "application/json", body: { ok: false, code: "retry" } };
    if (req.viewId === undefined) return { status: 200, type: "application/json", body: info };
    const start = req.part * info.partSize;
    return { status: 200, type: "application/octet-stream", body: bytes.subarray(start, Math.min(bytes.length, start + info.partSize)) };
  };
}

test("app: 大きい資料は部分を全部取ってから描き、保存ボタンを出さず、保存の券も求めない", async () => {
  const d = tokenFor(DATA);
  const r = await run({ d, server: partsServer(DATA) });
  assert.deepEqual(r.events, ["part-0", "part-1", "part-2", "getDocument"], "sha256 の照合に通ってから描く");
  assert.equal(Buffer.compare(r.rendered(), DATA), 0);
  assert.equal(r.saveHidden(), true, "大きい資料には保存ボタンを出さない");
  assert.match(r.status(), /1 ページ/);
  assert.match(r.status(), /保存はできません/);
  assert.equal(r.calls.some((c) => c.req.mode === "ticket"), false);
  assert.equal(r.calls[0].req.viewId, undefined, "最初は案内を求める");
  assert.deepEqual(r.calls.slice(1).map((c) => [c.req.viewId, c.req.part]), [[VIEW_ID, 0], [VIEW_ID, 1], [VIEW_ID, 2]]);
});

test("app: つないだ sha256 がトークンと違えば描かず、「もう一度開いてください」を出す", async () => {
  const d = tokenFor(DATA);
  const swapped = Buffer.from(DATA);
  swapped[20] ^= 0xff; // 長さは同じで中身だけ違う
  const r = await run({ d, server: partsServer(swapped) });
  assert.equal(r.events.includes("getDocument"), false, "照合に通らなければ pdf.js に渡さない");
  assert.equal(r.rendered(), null);
  assert.equal(r.pages(), 0);
  assert.match(r.status(), /確かめられませんでした/);
  assert.match(r.status(), /もう一度開いてください/);
  assert.equal(r.saveHidden(), true);
});

test("app: 部分の取得が拒否されたら描かず、その理由の案内を出す（取り直さない拒否）", async () => {
  const d = tokenFor(DATA);
  const server = async (req) => {
    if (req.viewId === undefined) return { status: 200, type: "application/json", body: INFO };
    return { status: 410, type: "application/json", body: { ok: false, code: "reopen", ref: "abcd1234" } };
  };
  const r = await run({ d, server });
  assert.equal(r.events.includes("getDocument"), false);
  assert.match(r.status(), /うまく取り出せませんでした/);
  assert.equal(r.calls.filter((c) => c.req.part !== undefined).length, 1, "reopen は取り直さない");
});

test("app: 4MB 以下の PDF は今どおり全体で描き、保存ボタンを出す。保存で「大きい」と言われたら「この画面でご覧ください」", async () => {
  const d = tokenFor(DATA);
  const server = async (req) => {
    if (req.mode === "ticket") return { status: 413, type: "application/json", body: { ok: false, code: "too-large", ref: "r1r1r1r1" } };
    return { status: 200, type: "application/pdf", body: DATA };
  };
  const r = await run({ d, server });
  assert.deepEqual(r.events, ["getDocument"]);
  assert.equal(r.saveHidden(), false, "小さい資料には保存ボタンが出る");
  assert.equal(r.calls.length, 1);
  await r.dom.els.save.onclick();
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1].req.mode, "ticket");
  assert.match(r.status(), /大きいためこの画面でご覧ください/);
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/app.test.js`
Expected: FAIL（今の `app.js` は分けて渡す案内を扱わないので、「大きい資料は部分を全部取ってから描き…」などが落ちる。`compile()` が import の行を見つけられない場合も落ちる）

- [ ] **Step 3: 実装する**

`delivery/public/app.js` を次に置き換える:

```js
// delivery/public/app.js
// LIFF で開かれ、?t= の配布トークンと IDトークンを /api/open に POST し、返った PDF を描く。
// トークンは URL のクエリ（または LIFF が包んだ liff.state）からしか読まず、ここ以外へは送らない。
// 読んだらアドレスバーから消す（画面共有・スクショ・履歴に残さない）。
// 保存は、同じ判定を通して 60 秒・1 回限りの受け取り券をもらい、Safari（外のブラウザ）で開く
// （LINE の中の画面では共有メニューもダウンロードも動かないため。設計書 §9 の例外）。
// 4,000,000 バイトを超える資料は /api/open が「分けて渡す」案内（viewId）を返すので、部分を順に取り、
// つないだ全体の sha256 を配布トークンの h と照合してから描く（2026-10-09 設計 19。合わなければ描かない）。
// 分けて渡した資料は保存しない（サーバも券を出さない）。
import * as pdfjs from "/vendor/pdf.min.mjs";
import { loginRedirectUri, readParam, readToken } from "/token.mjs";
import { assembleAndVerify, validInfo } from "/parts.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";

const LIFF_ID = "2011726489-DyQUBu2U";
const MESSAGES = {
  denied: "開けません。名簿に登録されているか、LINE のログインが古くないかを確認してください。",
  expired: "期限が切れています。もう一度頼んでください。",
  retry: "いま開けません。数分後にもう一度お試しください。",
  replaced: "この資料は差し替わりました。もう一度頼んでください。",
  "too-large": "この資料は大きすぎてここでは開けません。秘書室（下村）へ連絡してください。",
  stopped: "いま止めています。秘書室（下村）へ連絡してください。",
  reopen: "うまく取り出せませんでした。トークのリンクからもう一度開いてください。",
  slow: "混み合っています。少し待ってから、トークのリンクからもう一度開いてください。",
  hash: "資料を確かめられませんでした。トークのリンクからもう一度開いてください。",
};
// 保存ボタンのときだけ言い方を変えるもの
const SAVE_MESSAGES = {
  "too-large": "大きいためこの画面でご覧ください。",
};
const BIG_NOTE = "（大きい資料のため保存はできません。この画面でご覧ください）";

const status = document.getElementById("status");
const say = (text, ref, err) => {
  status.className = err ? "err" : "";
  status.textContent = text;
  if (ref) { const s = document.createElement("div"); s.className = "ref"; s.textContent = `照会番号: ${ref}`; status.appendChild(s); }
};

async function render(buf, note = "") {
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const pages = document.getElementById("pages");
  const width = Math.min(window.innerWidth, 1000) - 16;
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const scale = width / page.getViewport({ scale: 1 }).width;
    const vp = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width; canvas.height = vp.height;
    canvas.style.width = `${width}px`;
    pages.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    page.cleanup();
  }
  await pdf.cleanup();
  await pdf.destroy();
  say(`${pdf.numPages} ページ${note}`);
}

// 読み取った配布トークン。保存ボタンで券をもらうときにもう一度使う（URL からは消してあるので、ここに持つ）
let docToken = null;

const SAVE_HINT = 'Safari で開きます。共有ボタン（□↑）から「"ファイル"に保存」を選んでください。';

// 保存ボタン。押したときだけ受け取り券をもらい、外のブラウザで開く
function showSaveButton() {
  const btn = document.getElementById("save");
  btn.hidden = false;
  btn.onclick = async () => {
    btn.disabled = true;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const idToken = liff.getIDToken();
      if (!idToken || !docToken) { say("LINE のログイン情報が取れませんでした。LINE を開き直してください。", null, true); return; }
      let body = {};
      try {
        const res = await fetch("/api/open", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ d: docToken, idToken, mode: "ticket" }),
          signal: ctl.signal,
        });
        try { body = await res.json(); } catch { body = {}; }
      } finally {
        clearTimeout(timer);
      }
      if (body && body.ok === true && typeof body.url === "string" && body.url.startsWith("/api/dl?k=")) {
        if (liff.isInClient()) {
          liff.openWindow({ url: location.origin + body.url, external: true });
          say(SAVE_HINT);
        } else {
          // すでに外のブラウザにいるなら、そのまま開く
          location.href = location.origin + body.url;
        }
        return;
      }
      const code = body && body.code;
      say(SAVE_MESSAGES[code] || MESSAGES[code] || "保存できませんでした。", body && body.ref, true);
    } catch {
      say("保存できませんでした。LINE を開き直してもう一度お試しください。", null, true);
    } finally {
      btn.disabled = false;
    }
  };
}

// 部分を 1 つ取る（30 秒で打ち切り）。IDトークンは毎回いまのものを使う（部分ごとにサーバがログインを確かめる）
async function fetchPart(t, viewId, part) {
  const idToken = liff.getIDToken();
  if (!idToken) return { ok: false, code: "denied" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch("/api/open", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ d: t, idToken, viewId, part }),
      signal: ctl.signal,
    });
    if (res.status === 200 && res.headers.get("content-type") === "application/octet-stream") {
      return { ok: true, bytes: await res.arrayBuffer() };
    }
    let b = {};
    try { b = await res.json(); } catch { b = {}; }
    return { ok: false, code: (b && b.code) || "retry", ref: b && b.ref };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  try {
    // t は liff.init の前に読む（init がログインの戻り URL を書き換えることがあるため）
    const early = readToken(location.search);
    const loginAttempted = readParam(location.search, "login") === "1";
    // 自動ログイン（withLoginOnExternalBrowser）は使わない。戻り先を SDK に任せると、パソコンで
    // ログインから戻ったときに t が落ちる・別タブに戻ることがあるので、戻り先に t を自分で載せる
    await liff.init({ liffId: LIFF_ID });
    if (!liff.isLoggedIn()) {
      if (!early) { say("このページは、トークに出たリンクからだけ開けます。", null, true); return; }
      if (loginAttempted) {
        say("LINE にログインできませんでした。ブラウザで LINE にログインしてから、トークのリンクを開き直してください。", null, true);
        return;
      }
      liff.login({ redirectUri: loginRedirectUri(location.origin, early) });
      return;
    }
    const t = early;
    if (!t) { say("このページは、トークに出たリンクからだけ開けます。", null, true); return; }
    docToken = t;
    // ログイン済みを確かめてから消す（liff.login() はこの URL に戻ってくるので、その前に消すと t を失う）
    try { history.replaceState(null, "", location.pathname); } catch { /* 消せなくても開く処理は続ける */ }
    const idToken = liff.getIDToken();
    if (!idToken) { say("LINE のログイン情報が取れませんでした。LINE を開き直してください。", null, true); return; }
    say("資料を取り出しています…");
    // 30 秒の打ち切りは、応答の到着だけでなく本文（PDF・JSON）を読み終えるまでにかける
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    let pdfBuf = null;
    let body = {};
    try {
      const res = await fetch("/api/open", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ d: t, idToken }),
        signal: ctl.signal,
      });
      if (res.headers.get("content-type") === "application/pdf") {
        pdfBuf = await res.arrayBuffer();
      } else {
        try { body = await res.json(); } catch { body = {}; }
        if (ctl.signal.aborted) throw new Error("timeout");
      }
    } finally {
      clearTimeout(timer);
    }
    if (pdfBuf) {
      await render(pdfBuf);
      showSaveButton();
      return;
    }
    if (body && body.ok === true && body.mode === "parts") {
      // 分けて渡す（設計 19）。全部つないで sha256 が合ったときだけ描く。保存ボタンは出さない
      if (!validInfo(body)) { say(MESSAGES.hash, null, true); return; }
      let bytes;
      try {
        bytes = await assembleAndVerify({
          info: body,
          d: t,
          fetchPart: (i) => fetchPart(t, body.viewId, i),
          onProgress: (n, all) => say(`資料を取り出しています…（${n}/${all}）`),
        });
      } catch (e) {
        document.getElementById("pages").replaceChildren();
        say(MESSAGES[e && e.code] || "開けませんでした。トークのリンクからもう一度開いてください。", e && e.ref, true);
        return;
      }
      await render(bytes, BIG_NOTE);
      return;
    }
    say(MESSAGES[body.code] || "開けません。", body.ref, true);
  } catch (e) {
    document.getElementById("pages").replaceChildren();
    say("開けませんでした。LINE を開き直してもう一度お試しください。", null, true);
  }
})();
```

- [ ] **Step 4: 通ることと、構文を確かめる**

Run:
```bash
node --test test/app.test.js
cp public/app.js "${TMPDIR:-/tmp}/app-check.mjs" && node --check "${TMPDIR:-/tmp}/app-check.mjs" && echo SYNTAX-OK
cp public/parts.mjs "${TMPDIR:-/tmp}/parts-check.mjs" && node --check "${TMPDIR:-/tmp}/parts-check.mjs" && echo SYNTAX-OK
npm test
```
Expected: app.test.js PASS、`SYNTAX-OK` が 2 回、全体 `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add delivery/public/app.js delivery/test/app.test.js
git commit -m "$(cat <<'EOF'
feat(delivery): 大きい資料は部分を取ってつなぎ、照合してから表示する。保存は「この画面でご覧ください」

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## 本番反映（この計画のタスクの外。下村さんの承認の後）

**全体の本番の順番：P1（Railway）→ P4（この計画・Vercel 閲覧ページ）→ P3（Mac の本番ツリーへ fast-forward）→ P2（Vercel。最後に環境変数を入れて受付を有効にする）。** 各段は前の段の確認が済んでから。P4 より先に P3 を動かさない（古い閲覧ページは `aud` を無視して名簿を見るため、グループのリンクが開けない）。P3 と P4 は互いに確認が要るので、次の 3 段階に分けて確かめる（途中の段階で止まったら次へ進まない）。

### 反映前の点検（P4 の deploy の前。必須・下村さんと一緒に）

1. **関数の実行時間**：`delivery/vercel.json` の `maxDuration: 30`（秒）が現在の Vercel のプランで許される上限内か、プランの画面で確かめる。3.5MB の部分 1 つが 30 秒に収まるか、実機（LINE アプリ内の LIFF、モバイル回線）で測る（段階 b で 15 部分＝50MiB の資料を 1 つ測る。1 部分あたりの所要の目安を記録する）。足りなければ deploy せずに止めて報告する（プランの変更・課金はしない）
2. **LINE_GROUP_ID の一致**（値は画面にもログにも出さない）：閲覧ページ（Vercel `mdnext-doc-delivery`）の `LINE_GROUP_ID` が、P3（Mac 側 `aud: "line-group"` の `g` を作る営業部のグループ ID）と P2（受付）が使う **営業部** のグループ ID と同じであることを、下村さん本人が、各環境で同じ方法により値そのものを表示せずに値の完全な SHA-256 を計算し、完全なフィンガープリント同士を比べて確かめる（値・フィンガープリントとも、貼る・読み上げるのは避け、一致したかどうかだけ記録する。末尾の一部の文字での比較はしない）。食い違いは段階 c で `bad-audience`（ALERT）となって現れるが、反映前に潰す
3. `npm test` が `ℹ fail 0`（段階 a）

### 段階 a：P4 の deploy の前（自動テスト）

- `cd /Users/shimo/AI開発/apps/line-secretary/.worktrees/group-obi-viewer/delivery && npm test`：`ℹ fail 0`、skipped は 0
- **必須**：P3 の互換ベクトル `test/fixtures/dtoken-vector-group.json` を閲覧ページの `verify`・`audienceOf` が `line-group` と読む試験（Task 1 の「互換（必須）」）が PASS している。落ちる・ファイルが無いときは deploy しない（P3 が入っていない）
- 上限が固定であること（`maxBytes` を変えても境目が動かない）、メタが小さくても中身が大きければ案内になること、部分の取得で拒否されても監査が 1 件のままであること、の試験が PASS している

### 段階 b：P4 の deploy の後、P3 の deploy の前（今までの形のリンクで実機）

P3 が動く前なので、`aud` の無い **秘書室あてと同じ形の今までのリンク**（手元にある、または今の本番の仕組みでテスト用の図面に発行したもの。実在のお客様の資料は使わない）で確かめる。

1. 今までの秘書室あてのリンクが、名簿の確認つきで今までどおり開く（開かなければ `vercel rollback` で前の反映に戻す）
2. 4,000,000 バイト以下の図面：全体で開き、保存ボタンが出て保存できる
3. 4,000,000 バイトを超える図面（目安 7MB）：「取り出しています…（n/m）」の後に表示され、保存ボタンが出ない（「大きいためこの画面でご覧ください」）
4. 50MiB に近い図面で 1 部分あたりの所要時間を測り、反映前の点検 1 の判断（30 秒）を確定する

### 段階 c：P3 の deploy の後、P2 を有効にする前（グループあての試験リンク）

- P3 を Mac の本番ツリーに反映した後、**P2 の環境変数はまだ入れない**（受付は無効のまま）。管理者側の手順で **試験用の案件**（テスト用の図面）に、営業部グループあて（`aud: "line-group"`・`g` = 営業部）の配布リンクを 1 本だけ発行する
- その試験リンクを、**営業部グループに在籍していて、名簿には載っていない社員**の端末で開く：開けること（名簿を省き在籍だけで通る）。さらに ①グループに在籍していない人は開けない（一様な拒否）②4,000,000 超の図面でも開く、を確かめる
- 開けない場合：`bad-audience`（ALERT）なら LINE_GROUP_ID の食い違い、`not-member` なら在籍の確認の失敗を疑い、P2 には進まない。試験リンクは確認後に管理者側の失効（revoke）で止める
- 確認が取れてから、P2 の計画の手順で環境変数を入れて受付を有効にする

### 共通

- 承認を取ってから、**P4 の worktree**（ブランチ `feature/group-obi-viewer`）の `delivery` で反映する：`cd /Users/shimo/AI開発/apps/line-secretary/.worktrees/group-obi-viewer/delivery && vercel deploy --prod`。worktree には `.vercel/`（gitignore）が無いので、先に `vercel link --project mdnext-doc-delivery` でつなぐか、本体の `delivery/.vercel/project.json` を写す（中身はプロジェクトの番号だけで秘密は無い）。反映するのは `delivery/` の中身だけで、P3 の `src/` は Vercel に出ない
- 環境変数は足さない（`LINE_GROUP_ID` は既存）。`MAX_PDF_BYTES` は閲覧ページの判断にもう使われない（Vercel に入っていても結果に影響しない）
- pdf.js と LIFF の実物はテストでは偽物なので、描画そのものは段階 b・c の実機で見る
- 順番の最後は P2（それぞれの計画の手順に従う）

---

## 自己点検

**1. 設計書の項目ごとの対応**

| 設計 | 内容 | タスク |
|---|---|---|
| 18 | 配布トークンの `aud: 'line-group'`・`g` を検査（形） | Task 1（`audienceOf`・`verify` の `bad-aud`） |
| 18 | `aud === 'line-group'` かつ `g === LINE_GROUP_ID` のときだけ名簿を省く・在籍は必ず | Task 2（④の条件、⑤は常に） |
| 18 | `aud` 無しは今どおり名簿 | Task 2（既存 gate.test.js がそのまま通る＋gate-aud の 1 本目） |
| 18 | `aud` の値違い・`g` 違いは拒否 | Task 1・2（`bad-token`・`bad-audience`。期限切れの peek の経路も） |
| 19 | 上限 50MiB | Task 4（`MAX_BYTES`）、Task 5（超えたら too-large）、Task 7（`validInfo`） |
| 19 | 4,000,000 以下は今どおり全体、超えたら案内（全体の大きさ・部分の数・部分の大きさ 3,500,000・ファイル名・viewId）。境目は固定値で `MAX_PDF_BYTES` に依らない | Task 4（`WHOLE_MAX`）、Task 5 |
| 19 | 案内の前に今どおりの確認を通し、監査を 1 件。部分の取得は拒否も含め監査を書かない | Task 2（`audit: false`）、Task 5（gate＋`parts-issued`）、Task 6（部分では書かない・拒否でも 1 件のまま） |
| 19 | メタが小さい／大きさ無しでも、中身が 4,000,000 超なら実際の長さで案内に合流（413 にしない） | Task 3（`fetchPdf` の `too-large` に `size`）、Task 5（`issueParts`） |
| 19 | `/api/dl` の上限も固定の 4,000,000（`maxBytes` に依らない） | Task 5（`dl.js`・`dl.test.js`） |
| 19 | `viewId` を KV に 10 分、jti・userId・driveFileId（`f`）・sha256（`h`）・部分の数（`parts`）に結び付け（`s`・`i` は記録のみで照合しない） | Task 4（`viewPut`・`validView`）、Task 5（記録）、Task 6（照合） |
| 19 | 部分ごとにトークン（期限切れ拒否）・ログイン・在籍（キャッシュしない）・結び付き・失効を確かめ、範囲だけ返す。viewId 無しは拒否。no-store | Task 6 |
| 19 | 1 部分は合計 3 回まで（総数）、別に 1 分あたり部分の数×2（速さ） | Task 4（定数・`viewPartHit`）、Task 6（`reopen`・`slow`） |
| 19 | Drive から範囲で取る（206・Content-Range の確認＝Codex 残件 d） | Task 3（`fetchRange`）、Task 6 |
| 19 | 閲覧側：順につなぎ、全体の sha256 をトークンの値と照合してから表示。合わなければ「もう一度開いてください」。1 部分 3 回まで取り直し | Task 7（`parts.mjs`）、Task 8（`app.js`） |
| 19 | 保存は 4,000,000 以下と分かったときだけ。券の前に Drive の大きさを確かめ、大きければ券を出さず「大きいためこの画面でご覧ください」。大きさが読めなければ券を出さず `retry` | Task 5（`too-large-ticket`・`ticket-no-size`）、Task 8（`SAVE_MESSAGES`・保存ボタンを出さない・実行する試験） |
| 確かめ方 | 印の有無と値違いでの名簿・拒否 | Task 2 |
| 確かめ方 | viewId の無い・他人の・期限切れの部分の取得を拒否、部分の範囲・番号の検査、監査が 1 閲覧 1 件、つないだ sha256 の照合・合わないと表示しない、大きいときは券を出さない | Task 5・6・7 |
| 確かめ方 | 途中で止まる場面：部分の取得の途中 | Task 6（Drive が 2 回落ちても 3 回目で取れる）、Task 7（3 回失敗でその先を取らず失敗・描かない） |
| Codex 残件 a〜c | aisecretary 側（P2）の話。閲覧ページには当たらない | — |

**2. 置き換え漏れの点検**：「TBD」「後で」「適切に」「Task N と同様」は無い。コードの手順はすべて全文か、差し込む位置（行番号・直前の行）つきの全文。

**3. 名前と形のそろい**：
- `decide(…, deps, { rate, reserve })` の戻り値 `audience`・`auditId: null` は Task 2 で定義、Task 6 で使用
- `statPdf`・`fetchPdf(…, { stat })`・`fetchRange(…, { start, end, total })`・`drive.range(fileId, start, end) → { status, contentRange, bytes }` は Task 3 で定義、Task 5・6 と `fakeDrive` で同じ形
- `parts.WHOLE_MAX`・`plan`・`rangeOf`・`validView`・`MAX_BYTES`・`MAX_PARTS`・`VIEW_TTL_SEC`・`FETCH_MAX`・`RATE_PER_PART` は Task 4 で定義、Task 5・6 で使用
- `kv.viewPut`・`viewGet`・`viewPartHit` は Task 4、Task 5・6 で使用。閲覧の記録の項目 `{ jti, userId, s, f, h, i, size, parts, partSize, ref }` は Task 5 の `viewPut` が書く。`validView`（Task 4）と Task 6 の照合が見るのは `jti`・`userId`・`f`・`h`・`size`・`parts`・`partSize`・`ref` だけで、一致している
- 案内の応答 `{ ok, mode: "parts", viewId, size, parts, partSize, name }` は Task 5 と Task 7 の `validInfo` で一致
- 応答コード `slow`（429）・`reopen`（410）は Task 4、Task 6・7・8 で同じ綴り
- テスト用 `issueWith`・`keyPair` は Task 1、Task 2・5・6・7 で同じ引数
