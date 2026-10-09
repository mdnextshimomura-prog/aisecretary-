# グループからの帯替え P3：Mac の LINE秘書の納品（宛先ごとの状態・グループへの完成リンク） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** portal の claim 応答の `replyKind`・`replyGroupId` を見て、帯替えの完成リンクを営業部のグループ → 秘書室の順に届け、宛先ごとの状態を「受付番号＋完成品の sha256＋宛先」で台帳に残して、二重送信をしないようにする。

**Architecture:** 納品台帳（`src/jobs/ledger.js`）に宛先ごとの状態 `dests` を足し、予約（claim）をやり直しても引き継ぐ。`src/jobs/deliver.js` の `synced` の段で、秘書室のリンクを先に作り、グループへ（`src/lineapp.js` の `pushText`・`expectId` の照合つき）→ 秘書室へ（今の `send`）の順に送る。グループあてのリンクは `src/dtoken.js` の `issue` に `aud: "line-group"`・`g` を入れて作る。portal への結果は今どおり秘書室の送信で決める。

**Tech Stack:** Node.js（CommonJS）、`node:test`・`node:assert/strict`（`npm test` = `node --test test/*.test.js delivery/test/*.test.js`）。新しい依存は足さない。

**Spec:** `apps/aisecretary/docs/superpowers/specs/2026-10-09-group-obi-intake-design.md`（決めたこと 17・18、流れ 4）／受け渡しの約束：`apps/aisecretary/docs/superpowers/plans/2026-10-09-group-obi-contract.md`

**作業場所（実装時）:**
- 対象リポジトリ：`/Users/shimo/AI開発/apps/line-secretary`
- 本番の作業ツリー（`/Users/shimo/AI開発/apps/line-secretary`、ブランチ `feature/v1`）は launchd（`com.shimo.line-secretary.poll` が60秒ごとに `src/poll.js` を起動）が直接読んでいる。**ここでは一切編集しない**
- 既存の `.worktrees/line-job`（`feature/line-job`、78a0a92）は `feature/v1` に取り込み済みの古い枝（`feature/v1` が docs の3コミット先にある）なので使わない
- 新しい worktree：`/Users/shimo/AI開発/apps/line-secretary/.worktrees/group-obi-deliver`（ブランチ `feature/group-obi-deliver`、`feature/v1` から作る。作り方は Task 1 の Step 0）
- 以降のコマンドはすべてこの worktree の中で実行する

## Global Constraints

- 宛先は2つ：グループ（`replyKind==='line-group'` のとき）と秘書室（いつも）（設計書 17）
- 宛先ごとに `未着手 → 送信中 → 送信済み／はっきり失敗／結果不明` を台帳に残す。送る前に「送信中」を保存し、途中で止まって再開したときに「送信中」のままなら「結果不明」にして送り直さない（17）
- 宛先の状態の記録は、portal の完成品の保管期間（7日）を過ぎたら、既存の台帳の整理と一緒に消す（17）
- 宛先の状態は「受付番号＋完成品の sha256＋宛先」で残し、納品の予約（claim）をやり直しても引き継ぐ。**同じ完成品（同じ sha256）について、送信済み（sent）・結果不明（unknown）の宛先には、グループにも秘書室にも二度と送らない。** 人が portal で「もう一度納品」しても同じで、秘書室へ再送しない（既に分かっている結果を portal に報告し直すだけ。unknown は unknown のまま）。完成品が作り直されて sha256 が変わったときだけ、新しく送る（17）。「はっきり失敗（failed）」の宛先だけは、予約をやり直したときにもう一度試す
- 送る順番：グループ → 秘書室。グループへは `replyKind === 'line-group'` で、`replyGroupId` が `宛先.json` の「営業部」の ID と完全一致したときだけ送る（line-group なのに一致しなければ送らず「はっきり失敗」）（17）
- `replyKind` が `secretary` でも `line-group` でもない値（不明な値）のときは、グループの状態を一切作らず、グループには送らない。秘書室の控えの文に「返事先が不明のためグループには送っていません」と書く
- 実装の順番は P1 → P3 → P4 → P2（契約書どおり）。P4 の作業ブランチはこの計画のブランチ `feature/group-obi-deliver` から作るので、Task 1 の互換ベクトル `test/fixtures/dtoken-vector-group.json` は P4 から使える。**P4 がこのブランチから分かれた後は、このブランチを rebase・書き換えしない**。本番に出す順番は P1 → P4 → P3 → P2（Task 6）
- portal への納品結果は今どおり秘書室の送信で決める（秘書室が送信済み＝delivered）。秘書室の控えの文には、グループへの状態を書く：「グループにも送りました」／「グループに送れませんでした」／「グループへの送信結果が分かりません（確かめてください）」（17）。返事先が不明な値のときは「返事先が不明のためグループには送っていません」
- グループの文（流れ 4）：「#J12 帯替えが完成しました（物件名）＋リンク＋要確認のページ数」
- 配布トークンの印（18・約束）：グループあてのときだけ payload に `aud: "line-group"` と `g: "<groupId>"`（`^C[0-9a-f]{32}$`）。秘書室あてには付けない。`issue` の引数は `{ shelfId, driveFileId, sha256, ttlSec, now, aud?, g? }`。`aud` と `g` は両方そろえて渡すか、両方渡さないか
- claim 応答（約束）：`replyKind`（`'secretary' | 'line-group'`）・`replyGroupId`（`line-group` のときだけ groupId）。項目の無い今までの Job・portal は `secretary` 扱い
- LINE の groupId の形：`^C[0-9a-f]{32}$`
- 「送れたか分からない」送信は送り直さない（`isDefinitelyNotSent`＝応答のある 4xx だけが「はっきり失敗」）
- ログには依頼番号・code・段階名だけを出す（物件名・リンク・本文・groupId は出さない）（`src/jobs/deliver.js:7` の約束）
- 環境変数の追加なし（営業部の ID は既存の `config.DOC_REPLY.toId` と `tools/line-send/宛先.json` を使う）。`.env`・`宛先.json`・トークンの値は開かない・表示しない
- `src/jobs/parse.js` は変えない。共通の依頼テスト用データ（`job-command-cases.json`）は P2 の持ち物だが、P3 は P2 より先に実装するので、**P2 の計画に書いてある JSON をそのまま取り出して** line-secretary の `test/fixtures/` に置き、`parse.js` が全件同じ結果を出すことをテストで固定する（Task 5）。違いが出たら `parse.js` も表も直さず、止めて報告する
- テストのコマンドに `| tail` などのパイプを付けない（終了コードが消える）。付けるなら先頭に `set -o pipefail;`
- コミット：`type(scope): 日本語`（このリポジトリの書き方。例 `feat(jobs): …`）で、最後の行に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 本番への取り込み（`feature/v1` への `git merge --ff-only`）は、P4 が本番に出て確かめられた後、下村さんの承認後（Task 6）。`git push` は別に確認を取る

---

## ファイルの地図

| ファイル | 役割 | この計画で |
|---|---|---|
| `src/dtoken.js` | 配布トークンの発行・検証（Ed25519） | `issue` に `aud`・`g` を足す（Task 1） |
| `test/dtoken.test.js` | 同上のテスト | 印のテストと、グループあての互換ベクトルの固定（Task 1） |
| `test/fixtures/dtoken-vector-group.json` | グループあてトークンの互換ベクトル（テストが初回に作る。公開鍵だけ・秘密鍵は入れない） | 新規（Task 1）。P4（閲覧ページ）が検証に使える |
| `src/jobs/ledger.js` | 納品台帳 `state/job-deliveries.json` | `dests`（宛先ごとの状態）と `destKey`・`getDest`・`setDest`、7日の prune（Task 2） |
| `test/jobs-ledger.test.js` | 同上のテスト | `dests` のテスト（Task 2） |
| `src/jobs/deliver.js` | 納品の巡回 | claim の返事先の記録、グループへの送信、秘書室の宛先状態、控えの文（Task 3・4） |
| `test/jobs-deliver.test.js` | 同上のテスト | 偽物に lineapp・`DOC_REPLY`・claim の返事先を足し、グループの各場面・途中で止まる場面のテスト、再納品でも送り直さないテスト（Task 3・4。既存3件を更新） |
| `test/fixtures/job-command-cases.json` | 依頼文の読み取りの共通表（P2 の計画の JSON から生成。aisecretary と同じ中身） | 新規（Task 5） |
| `test/jobs-parse-shared.test.js` | `parse.js` が共通表の全件で同じ結果を出すテスト | 新規（Task 5） |

`src/poll.js` は変えない（`deliver.run` は `opts.lineapp` が無ければ `require("../lineapp.js")` を使い、`config` は今も `d.jobsConfig`＝`src/config.js` 全体を渡しているので `DOC_REPLY` が届く。`src/poll.js:409-413`）。

---

### Task 1: 配布トークンにグループあての印（`aud`・`g`）を入れる

**Files:**
- Modify: `src/dtoken.js:6-13`（定数）、`src/dtoken.js:52-67`（`issue`）
- Test: `test/dtoken.test.js`（末尾に追記）
- Create（テストが生成）: `test/fixtures/dtoken-vector-group.json`

**Interfaces:**
- Consumes: なし
- Produces: `dtoken.issue({ shelfId, driveFileId, sha256, ttlSec, now, aud?, g? }, { privateKeyPem, kid }) → { d, jti, exp }`。`aud`・`g` を渡したときだけ payload に `aud: "line-group"`・`g` が入る（`null`/`undefined` は渡さないのと同じ）。片方だけ・値や形が違えば `Error`（メッセージに「aud の形」または「g の形」を含む）。印の無いトークンの payload のキーは今までどおり `v, kid, jti, s, f, h, i, e` の順。`dtoken.verify` は変えない（payload の `aud`・`g` はそのまま返る）

- [ ] **Step 0: worktree を作る（初回だけ。本番の作業ツリーは編集しない）**

```bash
git -C /Users/shimo/AI開発/apps/line-secretary status --short   # 何も出ないこと（本番ツリーが綺麗）
git -C /Users/shimo/AI開発/apps/line-secretary worktree add .worktrees/group-obi-deliver -b feature/group-obi-deliver feature/v1
cd /Users/shimo/AI開発/apps/line-secretary/.worktrees/group-obi-deliver
npm ci
npm test
```

Expected: `npm test` が `fail 0` で終わる（着手前の基準）。`npm ci` がネットワークの都合で使えなければ止めて下村さんに聞く（本番ツリーの `node_modules` を symlink しない）。

- [ ] **Step 1: 失敗するテストを書く**（`test/dtoken.test.js` の末尾に追記）

```js
// ---- グループあての印（設計書 18）----
// 架空の groupId（営業部の本物の ID ではない）
const GID = "C" + "0123456789abcdef".repeat(2);

test("issue: グループあての印（aud・g）は署名の内側に入り、verify で読める（書き換えると署名が合わない）", () => {
  const { d } = dtoken.issue({ ...BODY, now: NOW, aud: "line-group", g: GID }, KEYS);
  const r = dtoken.verify(d, { ...PUB, now: NOW + 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.payload.aud, "line-group");
  assert.equal(r.payload.g, GID);
  const [body, sig] = d.split(".");
  const swapped = Buffer.from(body, "base64url").toString("utf8").replace(GID, "C" + "f".repeat(32));
  const d2 = Buffer.from(swapped, "utf8").toString("base64url") + "." + sig;
  assert.equal(dtoken.verify(d2, { ...PUB, now: NOW }).reason, "bad-signature");
});

test("issue: 印を渡さなければ aud・g は入らない（null も渡さないのと同じ。今までの秘書室あてと同じ形）", () => {
  const keysOf = (d) => Object.keys(JSON.parse(Buffer.from(d.split(".")[0], "base64url").toString("utf8")));
  const plain = dtoken.issue({ ...BODY, now: NOW }, KEYS);
  assert.deepEqual(keysOf(plain.d), ["v", "kid", "jti", "s", "f", "h", "i", "e"]);
  const nulls = dtoken.issue({ ...BODY, now: NOW, aud: null, g: null }, KEYS);
  assert.deepEqual(keysOf(nulls.d), ["v", "kid", "jti", "s", "f", "h", "i", "e"]);
});

test("issue: aud・g の片方だけ・aud の値が違う・g の形が違うときは投げる", () => {
  assert.throws(() => dtoken.issue({ ...BODY, now: NOW, aud: "line-group" }, KEYS), /g の形/);
  assert.throws(() => dtoken.issue({ ...BODY, now: NOW, g: GID }, KEYS), /aud の形/);
  assert.throws(() => dtoken.issue({ ...BODY, now: NOW, aud: "secretary", g: GID }, KEYS), /aud の形/);
  for (const bad of ["C" + "A".repeat(32), "U" + "0".repeat(32), "C" + "0".repeat(31), "C" + "0".repeat(33), "", 12]) {
    assert.throws(() => dtoken.issue({ ...BODY, now: NOW, aud: "line-group", g: bad }, KEYS), /g の形/, String(bad));
  }
});

// 閲覧ページ（delivery/lib/dtoken.js・P4）が同じ規約で aud・g を読めることを確かめるための共通データ。
// 無ければ作って固定し、あればそれで検証する（作り直すときはファイルを消す）。秘密鍵は書き出さない
test("互換テスト用のベクトル（グループあて）を固定する", () => {
  const p = path.join(__dirname, "fixtures", "dtoken-vector-group.json");
  if (!fs.existsSync(p)) {
    const kp = dtoken.generateKeyPair();
    const now = Date.UTC(2026, 9, 9, 0, 0, 0);
    const { d, jti } = dtoken.issue({ ...BODY, now, aud: "line-group", g: GID }, { privateKeyPem: kp.privateKeyPem, kid: "kvec" });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ publicKeyPem: kp.publicKeyPem, kid: "kvec", now, d, jti, aud: "line-group", g: GID, body: BODY }, null, 2));
  }
  const v = JSON.parse(fs.readFileSync(p, "utf8"));
  const r = dtoken.verify(v.d, { publicKeys: { [v.kid]: v.publicKeyPem }, now: v.now + 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.payload.jti, v.jti);
  assert.equal(r.payload.aud, v.aud);
  assert.equal(r.payload.g, v.g);
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/dtoken.test.js`
Expected: FAIL。「グループあての印は署名の内側に入り…」で `r.payload.aud` が `undefined`、「片方だけ…」で `Missing expected exception`。互換ベクトルのテストも `aud` が `undefined` で落ちる。**この時点で `test/fixtures/dtoken-vector-group.json` が印なしのまま作られてしまうので、Step 3 の前に消す：** `rm test/fixtures/dtoken-vector-group.json`

- [ ] **Step 3: 実装する**

`src/dtoken.js:6-13` の定数の並びの最後（`const nonEmpty = …` の次の行）に足す：

```js
// グループあての印（設計書 18）の g の形。LINE の groupId と同じ
const GROUP_ID_RE = /^C[0-9a-f]{32}$/;
```

`src/dtoken.js:52-67` の `issue` を丸ごと置き換える：

```js
function issue({ shelfId, driveFileId, sha256, ttlSec = DEFAULT_TTL_SEC, now = Date.now(), aud, g }, { privateKeyPem, kid }) {
  if (!nonEmpty(privateKeyPem)) throw new Error("privateKeyPem がありません");
  if (!nonEmpty(kid)) throw new Error("kid がありません");
  if (!nonEmpty(shelfId)) throw new Error("shelfId がありません");
  if (!nonEmpty(driveFileId)) throw new Error("driveFileId がありません");
  if (!isHex(sha256, 64)) throw new Error("sha256 の形が違います");
  const ttl = Number(ttlSec);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("ttlSec の形が違います");
  // 受け側（Vercel）は MAX_TTL_SEC を超えるトークンを通さない。出してから開けないリンクになるより、
  // DELIVERY_TTL_SEC の設定ミスとしてここで止める（docreply は issue-failed として秘書室に出す）
  if (ttl > MAX_TTL_SEC) throw new Error(`ttlSec が長すぎます（上限 ${MAX_TTL_SEC} 秒）`);
  // グループあての印（設計書 18）。aud と g は両方そろえて渡すか、両方渡さないか（null は渡さないのと同じ）。
  // 印の無いトークン（秘書室あて・今まで）は、閲覧ページが名簿も見る
  const marked = aud != null || g != null;
  if (marked && aud !== "line-group") throw new Error("aud の形が違います");
  if (marked && !(typeof g === "string" && GROUP_ID_RE.test(g))) throw new Error("g の形が違います");
  const i = Math.floor(now / 1000);
  const e = i + Math.floor(ttl);
  const jti = crypto.randomBytes(8).toString("hex");
  const payload = { v: 1, kid, jti, s: shelfId, f: driveFileId, h: sha256, i, e };
  if (marked) {
    payload.aud = aud;
    payload.g = g;
  }
  const body = b64u(JSON.stringify(payload));
  return { d: `${body}.${_signRaw(TOKEN_PREFIX, body, privateKeyPem)}`, jti, exp: e };
}
```

（`aud` が `"line-group"` でも `g` が無ければ「g の形」、`g` だけなら「aud の形」で投げる。既存の `test/fixtures/dtoken-vector.json` は印なしなので形は変わらない。）

- [ ] **Step 4: 通ることを確かめる**

Run: `node --test test/dtoken.test.js && node --test delivery/test/dtoken.test.js`
Expected: どちらも `fail 0`。`test/fixtures/dtoken-vector-group.json` が作られ、中に `"aud": "line-group"` と `"g": "C0123456789abcdef0123456789abcdef"` がある（`grep -c '"aud": "line-group"' test/fixtures/dtoken-vector-group.json` → `1`）。秘密鍵が入っていないこと：`grep -c PRIVATE test/fixtures/dtoken-vector-group.json` → `0`

- [ ] **Step 5: コミット**

```bash
git add src/dtoken.js test/dtoken.test.js test/fixtures/dtoken-vector-group.json
git commit -m "$(cat <<'EOF'
feat(delivery): グループあての配布トークンに aud・g の印を入れられるようにする

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 納品台帳に宛先ごとの状態（`dests`）を足す

**Files:**
- Modify: `src/jobs/ledger.js:9-17`（定数・`empty`）、`src/jobs/ledger.js:49-52` の後（形の検査）、`src/jobs/ledger.js:63-95`（`load`）、`src/jobs/ledger.js:99-118`（`save`）、`src/jobs/ledger.js:141-180`（`prune`・exports）
- Test: `test/jobs-ledger.test.js`（末尾に追記）

**Interfaces:**
- Consumes: なし
- Produces（`require("./ledger.js")` から）：
  - `DEST_STATES = ["sending", "sent", "failed", "unknown"]`
  - `destKey(no, sha256, dest) → "<no>:<sha256>:<dest>"`
  - `getDest(state, no, sha256, dest) → "sending" | "sent" | "failed" | "unknown" | null`（null＝未着手）
  - `setDest(state, no, sha256, dest, value, nowMs) → void`（`dest` は `"group" | "secretary"`。形が違えば投げる。保存は呼び出し側）
  - `load()` の戻り値と `empty()` に `dests: {}`。`save()` は `dests` も書く。`prune()` は `dests` の `at` が7日より古いものも消す

- [ ] **Step 1: 失敗するテストを書く**（`test/jobs-ledger.test.js` の末尾に追記）

```js
// ---- 宛先ごとの状態（グループからの帯替え 設計書 17）----
const SHA = "a".repeat(64);

test("ledger(dests): 既定は空。setDest/getDest で読み書きでき、保存・読み直しで残る", () => {
  const file = tmpFile();
  const s = ledger.load(file);
  assert.deepEqual(s.dests, {});
  assert.equal(ledger.getDest(s, 12, SHA, "group"), null);
  ledger.setDest(s, 12, SHA, "group", "sending", T0);
  ledger.setDest(s, 12, SHA, "secretary", "sent", T0);
  ledger.save(file, s);
  const again = ledger.load(file);
  assert.equal(again.broken, false);
  assert.equal(ledger.getDest(again, 12, SHA, "group"), "sending");
  assert.equal(ledger.getDest(again, 12, SHA, "secretary"), "sent");
  assert.equal(ledger.getDest(again, 12, "b".repeat(64), "group"), null, "完成品（sha256）が違えば別の宛先");
  assert.deepEqual(again.dests[ledger.destKey(12, SHA, "group")], { state: "sending", at: new Date(T0).toISOString() });
});

test("ledger(dests): 宛先・状態・no・sha256 の形が違えば setDest は投げ、何も書かない", () => {
  const s = ledger.load(tmpFile());
  assert.throws(() => ledger.setDest(s, 12, SHA, "dm", "sent", T0), /宛先/);
  assert.throws(() => ledger.setDest(s, 12, SHA, "group", "done", T0), /状態/);
  assert.throws(() => ledger.setDest(s, 0, SHA, "group", "sent", T0), /sha256/);
  assert.throws(() => ledger.setDest(s, 12, "zz", "group", "sent", T0), /sha256/);
  assert.throws(() => ledger.setDest(s, 12, null, "group", "sent", T0), /sha256/);
  assert.deepEqual(s.dests, {});
});

test("ledger(dests): 形が違えば broken", () => {
  const at = new Date(T0).toISOString();
  const bad = [
    [],
    { [`12:${SHA}:group`]: { state: "flying", at } },
    { [`12:${SHA}:dm`]: { state: "sent", at } },
    { [`12:zz:group`]: { state: "sent", at } },
    { [`12:${SHA}:group`]: { state: "sent" } },
    { [`12:${SHA}:group`]: "sent" },
  ];
  for (const dests of bad) {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ active: {}, history: [], notified: {}, dests }));
    assert.equal(ledger.load(file).broken, true, JSON.stringify(dests));
  }
});

test("ledger(dests): dests を持たない古い台帳もそのまま読める", () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ active: {}, history: [], notified: {} }));
  const s = ledger.load(file);
  assert.equal(s.broken, false);
  assert.deepEqual(s.dests, {});
});

test("ledger(dests): prune は7日より古い宛先の状態を消し、新しいものは残す（history の30日とは別）", () => {
  const s = ledger.load(tmpFile());
  s.dests[`1:${SHA}:group`] = { state: "sent", at: new Date(T0 - 8 * DAY).toISOString() };
  s.dests[`2:${SHA}:group`] = { state: "unknown", at: new Date(T0 - 6 * DAY).toISOString() };
  s.history.push({ ...entry(1, "c1"), doneAt: new Date(T0 - 8 * DAY).toISOString() });
  assert.equal(ledger.prune(s, T0), true);
  assert.deepEqual(Object.keys(s.dests), [`2:${SHA}:group`]);
  assert.equal(s.history.length, 1, "history は30日まで残す");
  assert.equal(ledger.prune(s, T0), false, "消すものが無ければ false");
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/jobs-ledger.test.js`
Expected: FAIL。`s.dests` が `undefined`、`ledger.getDest is not a function`、`dests` の形が違う台帳が broken にならない。

- [ ] **Step 3: 実装する**

`src/jobs/ledger.js:9-10` の `const KEEP_MS = 30 * 86400000;` の次に足す：

```js
// 納品の宛先ごとの状態（グループからの帯替え 設計書 17）。鍵は「受付番号:完成品の sha256:宛先」、値は { state, at }。
// 無い＝未着手。予約（claim）をやり直しても残し、送信済み・結果不明の宛先には二度と送らない（deliver.js が判断）。
// portal の完成品の保管期間（7日）を過ぎたら prune で消す
const DESTS = ["group", "secretary"];
const DEST_STATES = ["sending", "sent", "failed", "unknown"];
const DEST_KEEP_MS = 7 * 86400000;
const DEST_KEY_RE = /^\d+:[0-9a-f]{64}:(group|secretary)$/;
```

`src/jobs/ledger.js:12-17` の `empty` を置き換える：

```js
function empty() {
  return {
    active: {}, history: [], notified: {}, alerts: {}, retries: {}, notifyTries: {},
    inbox: null, archiving: null, uploading: null, inputWait: {}, dests: {}, broken: false,
  };
}
```

`src/jobs/ledger.js:49-52`（`looksLikeInputWait`）の直後に足す：

```js
// 宛先ごとの状態 { "<no>:<sha256>:<宛先>": { state, at } }
function looksLikeDests(x) {
  return isPlainObject(x) && Object.entries(x).every(([k, v]) => DEST_KEY_RE.test(k)
    && isPlainObject(v) && DEST_STATES.includes(v.state) && typeof v.at === "string");
}
```

`src/jobs/ledger.js:80-91`（`load` の中の `const inbox = …` から `return { … };` まで）を置き換える：

```js
    const inbox = d.inbox === undefined ? null : d.inbox;
    const archiving = d.archiving === undefined ? null : d.archiving;
    const uploading = d.uploading === undefined ? null : d.uploading;
    const inputWait = d.inputWait === undefined ? {} : d.inputWait;
    const dests = d.dests === undefined ? {} : d.dests;
    if (!looksLikeInbox(inbox) || !looksLikeArchiving(archiving) || !looksLikeUploading(uploading) || !looksLikeInputWait(inputWait)
      || !looksLikeDests(dests)) {
      return { ...empty(), broken: true };
    }
    return {
      active: d.active, history: d.history, notified: d.notified,
      alerts: d.alerts || {}, retries: d.retries || {}, notifyTries: d.notifyTries || {},
      inbox, archiving, uploading, inputWait, dests, broken: false,
    };
```

`src/jobs/ledger.js:99-118` の `save` を置き換える：

```js
function save(file, state) {
  if (!state || state.broken) throw new Error("job ledger is broken");
  const { active, history, notified, alerts, retries } = state;
  const notifyTries = state.notifyTries || {};
  const inbox = state.inbox || null;
  const archiving = state.archiving || null;
  const uploading = state.uploading || null;
  const inputWait = state.inputWait || {};
  const dests = state.dests || {};
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({
      active, history, notified, alerts, retries, notifyTries, inbox, archiving, uploading, inputWait, dests,
    }, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 消せなくても元の失敗を返す */ }
    throw err;
  }
}
```

`src/jobs/ledger.js:135-139`（`finish`）の直後に足す：

```js
function destKey(no, sha256, dest) {
  return `${no}:${sha256}:${dest}`;
}

// 宛先の状態（"sending" | "sent" | "failed" | "unknown"）。未着手なら null
function getDest(state, no, sha256, dest) {
  const d = state.dests && state.dests[destKey(no, sha256, dest)];
  return d ? d.state : null;
}

// 宛先の状態を書き換える（保存は呼び出し側）。宛先・状態・no・sha256 の形が違えば投げる
function setDest(state, no, sha256, dest, value, nowMs) {
  if (!DESTS.includes(dest)) throw new Error(`宛先 ${dest} は使えません`);
  if (!DEST_STATES.includes(value)) throw new Error(`状態 ${value} は使えません`);
  if (!Number.isInteger(no) || no <= 0 || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("no・sha256 の形が違います");
  }
  if (!state.dests) state.dests = {};
  state.dests[destKey(no, sha256, dest)] = { state: value, at: new Date(nowMs).toISOString() };
}
```

`src/jobs/ledger.js:141` のコメントを `// history・notified・retries・notifyTries・inputWait の30日より古いもの、dests の7日より古いものを消す。消したら true` に替え、`prune` の `return changed;`（`src/jobs/ledger.js:177`）の直前に足す：

```js
  if (!state.dests) state.dests = {};
  const destCutoff = nowMs - DEST_KEEP_MS;
  for (const [k, d] of Object.entries(state.dests)) {
    const t = d ? Date.parse(d.at) : NaN;
    if (!d || (Number.isFinite(t) && t < destCutoff)) {
      delete state.dests[k];
      changed = true;
    }
  }
```

`src/jobs/ledger.js:180` の exports を置き換える：

```js
module.exports = {
  STAGES, DEST_STATES, keyOf, load, save, put, list, finish, prune, hasActiveNo, destKey, getDest, setDest,
};
```

- [ ] **Step 4: 通ることを確かめる**

Run: `node --test test/jobs-ledger.test.js test/jobs-deliver.test.js test/jobs-inputs.test.js test/jobs-notify.test.js test/jobs-intake.test.js`
Expected: すべて `fail 0`（台帳を load→save する既存の呼び出し元が `dests` を落とさないこと込み）

- [ ] **Step 5: コミット**

```bash
git add src/jobs/ledger.js test/jobs-ledger.test.js
git commit -m "$(cat <<'EOF'
feat(jobs): 納品台帳に宛先ごとの状態を残し、7日で整理する

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 完成リンクをグループにも送る（グループの宛先状態・控えの文）

**Files:**
- Modify: `src/jobs/deliver.js:1-7`（冒頭の説明）、`src/jobs/deliver.js:27`（定数の後）、`src/jobs/deliver.js:104-111`（`deliveryText`）、`src/jobs/deliver.js:117-126`（`run` の依存）、`src/jobs/deliver.js:224` の前（`sendGroup` を足す）、`src/jobs/deliver.js:301-349`（`synced`）、`src/jobs/deliver.js:437-447`（claim から台帳の行を作る所）、`src/jobs/deliver.js:473`（exports）
- Test: `test/jobs-deliver.test.js:29-31`（定数）、`:75-79`（偽の claim の応答）、`:108-163`（`setup`）、末尾に追記

**Interfaces:**
- Consumes: Task 1 の `dtoken.issue({ …, aud: "line-group", g })`。Task 2 の `ledger.getDest(state, no, sha256, "group")`・`ledger.setDest(state, no, sha256, "group", value, nowMs)`。`src/lineapp.js:47` の `pushText({ alias, text, expectId })`（送る相手が `expectId` と違えば `status: 400`・`code: "destination-mismatch"` で投げる。HTTP の失敗は `err.status`）。`config.DOC_REPLY.toAlias`（`"営業部"`）・`config.DOC_REPLY.toId`（`src/config.js:86-87`）。P1 の claim 応答の `replyKind`・`replyGroupId`
- Produces: `deliver.run(opts)` が `opts.lineapp`（既定 `require("../lineapp.js")`）を受け取る。台帳の active の行に `replyKind`（文字列。項目なしは `"secretary"`）・`replyGroupId`（文字列か null）。`deliveryText(entry, link, ttlSec, groupState?)`（`groupState` が `"sent" | "failed" | "unknown" | "noreply"` のとき最後の行に状態を足す。`noreply`＝返事先が不明な値）。`groupText(entry, link, ttlSec)`。ログに新しく `group-sent`・`group-failed`・`group-unknown`・`group-mismatch`・`reply-unknown`・`group-issue-failed`・`group-sending-interrupted`

- [ ] **Step 1: テストの偽物を広げる**（既存のテストの結果は変えない）

`test/jobs-deliver.test.js:31`（`const sha = …`）の次の行に足す：

```js
// 架空の営業部の groupId（本物の ID ではない）
const GID = "C" + "0123456789abcdef".repeat(2);
```

`test/jobs-deliver.test.js:75-79` の偽の claim の応答の `return { … }` を置き換える：

```js
      return { ok: true, status: 200, code: null, body: {
        no, status: "納品中", claimId: j.claimId, artifactName: j.artifactName,
        artifactSha256: j.artifactSha256, leaseUntil: j.leaseUntil,
        ...(j.reviewPages !== undefined ? { reviewPages: j.reviewPages } : {}),
        // 返事先（P1 の約束）。add で与えたテストだけ返す。与えないのは項目の追加前の portal
        ...(j.replyKind !== undefined ? { replyKind: j.replyKind, replyGroupId: j.replyGroupId === undefined ? null : j.replyGroupId } : {}),
      } };
```

`test/jobs-deliver.test.js:108-163` の `setup` を丸ごと置き換える：

```js
function setup(name, { synced = true } = {}) {
  const stateDir = tmpDir(`${name}-state`);
  const deliveryDir = tmpDir(`${name}-drive`);
  const clock = { t: T0 };
  const portal = fakePortal(clock);
  const sent = [];
  const sendFail = [];
  const drive = { synced, calls: 0 };
  const stop = { value: false, seq: null, calls: 0 };
  const issued = [];
  const logLines = [];
  // グループへの送信（lineapp.pushText）の偽物。lineDest.id は 宛先.json の「営業部」の ID の代わり。
  // events は送ろうとした順（"group" / "secretary"）
  const pushed = [];
  const pushFail = [];
  const pushStat = { calls: 0 };
  const lineDest = { id: GID };
  const events = [];
  const cfg = {
    paths: { state: stateDir },
    JOBS: {
      enabled: true, portalBaseUrl: "https://portal.example", apiToken: "t".repeat(32), roomChannelId: "ch-room",
      deliveryDir, syncWaitMin: 15, stepBudgetMs: 90000,
    },
    DELIVERY: { liffId: "LIFF-ID", kid: "k1", privateKeyPem: "PEM", ttlSec: 86400 },
    DOC_REPLY: { toAlias: "営業部", toId: GID },
  };
  const opts = () => ({
    stateDir,
    ledger: s.ledgerImpl,
    config: cfg,
    portal,
    now: () => clock.t,
    drivefile: { localItemId: (p) => { drive.calls += 1; return drive.synced ? `drive-${path.basename(p).length}` : null; } },
    dtoken: {
      issue: (payload, keys) => {
        issued.push({ payload, keys });
        return { d: `TOKEN${issued.length}`, jti: "j".repeat(16), exp: 0 };
      },
    },
    delivery: {
      isStopped: () => {
        stop.calls += 1;
        // seq を与えたテストは呼ばれた順に値を返す（送信直前だけ止まった、を作るため）
        if (stop.seq) return stop.seq.length ? stop.seq.shift() : stop.value;
        return stop.value;
      },
    },
    send: async (text) => {
      events.push("secretary");
      if (sendFail.length) {
        const status = sendFail.shift();
        throw Object.assign(new Error("send failed"), status == null ? {} : { status });
      }
      sent.push(text);
    },
    lineapp: {
      pushText: async ({ alias, text, expectId }) => {
        pushStat.calls += 1;
        events.push("group");
        // 本物と同じく、送る相手（宛先.json の「営業部」）が expectId と違えば 400 の destination-mismatch
        if (expectId && expectId !== lineDest.id) {
          throw Object.assign(new Error("mismatch"), { status: 400, code: "destination-mismatch" });
        }
        if (pushFail.length) {
          const status = pushFail.shift();
          throw Object.assign(new Error("push failed"), status == null ? {} : { status });
        }
        pushed.push({ alias, text, expectId });
        return { ok: true };
      },
    },
    log: { write: (level, msg) => logLines.push(`${level} ${msg}`) },
  });
  const ledgerFile = path.join(stateDir, "job-deliveries.json");
  const s = {
    stateDir, deliveryDir, clock, portal, sent, sendFail, drive, stop, issued, logLines, cfg, ledgerFile,
    pushed, pushFail, pushStat, lineDest, events,
    ledgerImpl: undefined,
    run: (extra = {}) => deliver.run({ ...opts(), ...extra }),
    ledger: () => ledger.load(ledgerFile),
  };
  return s;
}
```

Run: `node --test test/jobs-deliver.test.js`
Expected: `fail 0`（偽物を広げただけで既存の結果は変わらない）

- [ ] **Step 2: 失敗するテストを書く**（`test/jobs-deliver.test.js` の末尾に追記）

```js
// ---- グループからの帯替え：宛先ごとの状態（設計書 17・18）----
const GROUP = { replyKind: "line-group", replyGroupId: GID };
const LINE_SENT = "グループにも送りました";
const LINE_FAILED = "グループに送れませんでした";
const LINE_UNKNOWN = "グループへの送信結果が分かりません（確かめてください）";
const LINE_NOREPLY = "返事先が不明のためグループには送っていません";
const lastLine = (text) => text.split("\n").at(-1);
const destOf = (s, no, dest) => ledger.getDest(s.ledger(), no, s.portal.jobs.get(no).artifactSha256, dest);

test("deliver(group): グループ → 秘書室の順に送る。グループには aud・g 付きのリンク、秘書室の控えに「グループにも送りました」", async () => {
  const s = setup("group-ok");
  s.portal.add(12, { ...GROUP, reviewPages: 2 });
  await s.run();
  assert.deepEqual(s.events, ["group", "secretary"]);
  assert.equal(s.pushed.length, 1);
  assert.equal(s.pushed[0].alias, "営業部");
  assert.equal(s.pushed[0].expectId, GID);
  assert.equal(s.pushed[0].text,
    "#J12 帯替えが完成しました（架空邸）\n⚠ 要確認 2ページ（使う前に中身を確認してください）\nhttps://liff.line.me/LIFF-ID?t=TOKEN2\n（このグループの方が開けます・24時間有効）");
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0],
    "#J12 できました（帯替え｜架空邸）\n⚠ 要確認 2ページ（転送する前に中身を確認してください）\nhttps://liff.line.me/LIFF-ID?t=TOKEN1\n（名簿にいる在籍者だけ開けます・24時間有効）\n" + LINE_SENT);
  // 秘書室のリンクは印なし（先に作る）、グループのリンクは aud・g 付き
  const driveFileId = `drive-${"J12_帯_12.pdf".length}`;
  const sha256 = s.portal.jobs.get(12).artifactSha256;
  assert.deepEqual(s.issued[0].payload, { shelfId: "job-12", driveFileId, sha256, ttlSec: 86400, now: T0 });
  assert.deepEqual(s.issued[1].payload, { shelfId: "job-12", driveFileId, sha256, ttlSec: 86400, now: T0, aud: "line-group", g: GID });
  assert.equal(s.portal.calls.reportResult[0].outcome, "delivered");
  assert.equal(destOf(s, 12, "group"), "sent");
  const l = s.ledger();
  assert.equal(l.history[0].replyKind, "line-group");
  assert.equal(l.history[0].replyGroupId, GID);
  // ログに物件名・リンク・groupId を出さない
  assert.equal(s.logLines.some((x) => x.includes("架空邸") || x.includes("liff") || x.includes(GID)), false);
  assert.ok(s.logLines.includes("info job-deliver #J12 group-sent"));
});

test("deliver(group): グループと秘書室の結果の組み合わせ（portal への結果は秘書室の送信で決まり、控えの文はグループの状態）", async () => {
  const groups = [
    { name: "ok", push: [], group: "sent", pushed: 1, line: LINE_SENT },
    { name: "400", push: [400], group: "failed", pushed: 0, line: LINE_FAILED },
    { name: "500", push: [500], group: "unknown", pushed: 0, line: LINE_UNKNOWN },
    { name: "net", push: [null], group: "unknown", pushed: 0, line: LINE_UNKNOWN },
  ];
  const secretaries = [
    { name: "ok", fail: [], outcome: "delivered" },
    { name: "404", fail: [404], outcome: "not_sent" },
    { name: "500", fail: [500], outcome: "unknown" },
  ];
  for (const g of groups) {
    for (const sec of secretaries) {
      const label = `group=${g.name} secretary=${sec.name}`;
      const s = setup(`group-matrix-${g.name}-${sec.name}`);
      s.portal.add(12, GROUP);
      s.pushFail.push(...g.push);
      s.sendFail.push(...sec.fail);
      await s.run();
      assert.deepEqual(s.events, ["group", "secretary"], label);
      assert.equal(s.pushed.length, g.pushed, label);
      assert.equal(destOf(s, 12, "group"), g.group, label);
      assert.equal(s.portal.calls.reportResult.length, 1, label);
      assert.equal(s.portal.calls.reportResult[0].outcome, sec.outcome, label);
      if (sec.outcome === "delivered") assert.equal(lastLine(s.sent[0]), g.line, label);
      else assert.equal(s.sent.length, 0, label);
    }
  }
});

test("deliver(group): line-group なのに replyGroupId が営業部の ID と違う・形が違う・無いなら、グループには送らず「はっきり失敗」", async () => {
  const cases = [
    { replyKind: "line-group", replyGroupId: "C" + "f".repeat(32) },
    { replyKind: "line-group", replyGroupId: "C" + "0123456789ABCDEF".repeat(2) },
    { replyKind: "line-group", replyGroupId: null },
  ];
  for (const [i, extra] of cases.entries()) {
    const label = JSON.stringify(extra);
    const s = setup(`group-mismatch-${i}`);
    s.portal.add(12, extra);
    await s.run();
    assert.equal(s.pushStat.calls, 0, label);
    assert.equal(s.issued.length, 1, `グループのリンクは作らない ${label}`);
    assert.equal(destOf(s, 12, "group"), "failed", label);
    assert.equal(lastLine(s.sent[0]), LINE_FAILED, label);
    assert.equal(s.portal.calls.reportResult[0].outcome, "delivered", label);
  }
});

test("deliver(group): replyKind が不明な値なら、グループの状態を一切作らず送らず、秘書室の控えに「返事先が不明」と書く", async () => {
  const cases = [
    { replyKind: "something", replyGroupId: GID },
    { replyKind: "something", replyGroupId: null },
    { replyKind: 5, replyGroupId: GID },
  ];
  for (const [i, extra] of cases.entries()) {
    const label = JSON.stringify(extra);
    const s = setup(`group-reply-unknown-${i}`);
    s.portal.add(12, extra);
    await s.run();
    assert.equal(s.pushStat.calls, 0, label);
    assert.equal(s.issued.length, 1, `グループのリンクは作らない ${label}`);
    assert.equal(destOf(s, 12, "group"), null, label);
    assert.deepEqual(Object.keys(s.ledger().dests).filter((k) => k.endsWith(":group")), [], `グループの状態を作らない ${label}`);
    assert.equal(lastLine(s.sent[0]), LINE_NOREPLY, label);
    assert.equal(s.portal.calls.reportResult[0].outcome, "delivered", label);
    assert.ok(s.logLines.includes("warn job-deliver #J12 reply-unknown"), label);
  }
});

test("deliver(group): 宛先.json の「営業部」が入れ替わっていたら（expectId 不一致）送らず「はっきり失敗」", async () => {
  const s = setup("group-dest-swapped");
  s.lineDest.id = "C" + "e".repeat(32);
  s.portal.add(12, GROUP);
  await s.run();
  assert.equal(s.pushed.length, 0);
  assert.equal(destOf(s, 12, "group"), "failed");
  assert.equal(lastLine(s.sent[0]), LINE_FAILED);
  assert.ok(s.logLines.includes("warn job-deliver #J12 group-failed destination"));
});

test("deliver(group): replyKind が secretary・項目なし（今までの portal）なら秘書室だけ（控えの文も今までどおり）", async () => {
  for (const [i, extra] of [{ replyKind: "secretary", replyGroupId: null }, {}].entries()) {
    const s = setup(`group-none-${i}`);
    s.portal.add(12, extra);
    await s.run();
    assert.equal(s.pushStat.calls, 0);
    assert.equal(s.issued.length, 1);
    assert.equal(s.sent[0], "#J12 できました（帯替え｜架空邸）\nhttps://liff.line.me/LIFF-ID?t=TOKEN1\n（名簿にいる在籍者だけ開けます・24時間有効）");
    assert.equal(destOf(s, 12, "group"), null);
    assert.equal(s.ledger().history[0].replyKind, "secretary");
  }
});

test("deliver(group): 「資料を止めて」の間はグループにも送らない（台帳は synced のまま）", async () => {
  const s = setup("group-stopped");
  s.portal.add(12, GROUP);
  seed(s, 12, "synced", { driveFileId: "drive-1", ...GROUP });
  s.stop.value = true;
  await s.run();
  assert.equal(s.pushStat.calls, 0);
  assert.equal(s.sent.length, 0);
  assert.equal(Object.values(s.ledger().active)[0].stage, "synced");
  assert.equal(destOf(s, 12, "group"), null);
});

test("deliver(group): グループへ送った直後・台帳に書く前に落ちた → 次の回はグループに送り直さず「結果が分かりません」で秘書室へ", async () => {
  const s = setup("group-crash-after-push");
  s.portal.add(12, GROUP);
  const sha256 = s.portal.jobs.get(12).artifactSha256;
  // グループの「送信済み」を書く保存だけ失敗させる（送った後・書く前に落ちたのと同じ台帳が残る）
  s.ledgerImpl = failingLedger((state) => ledger.getDest(state, 12, sha256, "group") === "sent");
  const out = await s.run();
  assert.equal(out.halted, "ledger");
  assert.equal(s.pushStat.calls, 1);
  assert.equal(s.sent.length, 0);
  const disk = s.ledger();
  assert.equal(ledger.getDest(disk, 12, sha256, "group"), "sending");
  assert.equal(Object.values(disk.active)[0].stage, "synced");
  s.ledgerImpl = undefined;
  await s.run();
  assert.equal(s.pushStat.calls, 1, "グループには送り直さない");
  assert.equal(s.sent.length, 1);
  assert.equal(lastLine(s.sent[0]), LINE_UNKNOWN);
  assert.equal(destOf(s, 12, "group"), "unknown");
  assert.equal(s.portal.calls.reportResult[0].outcome, "delivered");
  assert.ok(s.logLines.includes("warn job-deliver #J12 group-sending-interrupted"));
});

test("deliver(group): 「送信中」を書けなければグループに送らない", async () => {
  const s = setup("group-write-fail-sending");
  s.portal.add(12, GROUP);
  const sha256 = s.portal.jobs.get(12).artifactSha256;
  s.ledgerImpl = failingLedger((state) => ledger.getDest(state, 12, sha256, "group") === "sending");
  const out = await s.run();
  assert.equal(out.halted, "ledger");
  assert.equal(s.pushStat.calls, 0);
  assert.equal(s.sent.length, 0);
  assert.equal(ledger.getDest(s.ledger(), 12, sha256, "group"), null);
});

test("deliver(group): 秘書室がはっきり失敗して予約をやり直したとき、グループは失敗だった件だけ送り直す（送信済み・結果不明は送らない）", async () => {
  const cases = [
    { name: "sent", push: [], calls: 1, line: LINE_SENT },
    { name: "unknown", push: [500], calls: 1, line: LINE_UNKNOWN },
    { name: "failed", push: [400], calls: 2, line: LINE_SENT },
  ];
  for (const c of cases) {
    const s = setup(`group-reclaim-${c.name}`);
    s.portal.add(12, GROUP);
    s.pushFail.push(...c.push);
    s.sendFail.push(404);
    await s.run();
    assert.equal(s.portal.jobs.get(12).status, "完成", c.name);
    s.clock.t += 61 * MIN;
    await s.run();
    assert.equal(s.portal.calls.claim.length, 2, c.name);
    assert.equal(s.pushStat.calls, c.calls, c.name);
    assert.equal(s.sent.length, 1, c.name);
    assert.equal(lastLine(s.sent[0]), c.line, c.name);
    assert.equal(s.portal.jobs.get(12).status, "納品済み", c.name);
  }
});

test("deliver(group): 完成品が作り直されて sha256 が変わったら、グループに新しく送る", async () => {
  const s = setup("group-new-sha");
  const j = s.portal.add(12, GROUP);
  s.sendFail.push(404);
  await s.run();
  assert.equal(s.pushed.length, 1);
  j.pdf = Buffer.from("%PDF-remade");
  j.artifactSha256 = sha(j.pdf);
  s.clock.t += MIN;
  await s.run();
  assert.equal(s.pushed.length, 2);
  assert.equal(lastLine(s.sent[0]), LINE_SENT);
  assert.equal(s.portal.jobs.get(12).status, "納品済み");
});

test("groupText: 物件名は消毒して（改行・URL を取る）60字まで、要確認が無ければその行は出さない", () => {
  const text = deliver.groupText({ no: 7, workflow: "obi", property: "架空\n邸 https://evil.example", reviewPages: 0 }, "LINK", 3600);
  // 裸のドメインの扱いは sanitizeField（src/room.js）に任せ、ここでは形だけを見る
  assert.match(text, /^#J7 帯替えが完成しました（架空 邸[^\n]*）\nLINK\n（このグループの方が開けます・1時間有効）$/);
  assert.doesNotMatch(text, /https?:\/\//);
  assert.doesNotMatch(text, /要確認/);
  assert.equal(deliver.groupText({ no: 8, workflow: "obi", property: null, reviewPages: 1 }, "LINK", 86400),
    "#J8 帯替えが完成しました\n⚠ 要確認 1ページ（使う前に中身を確認してください）\nLINK\n（このグループの方が開けます・24時間有効）");
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `node --test --test-name-pattern="group" test/jobs-deliver.test.js`
Expected: FAIL。`s.events` が `["secretary"]`、`s.pushed.length` が 0、`deliver.groupText is not a function` など。（「replyKind が secretary・項目なし」の件は `history[0].replyKind` が `undefined` で落ちる）

- [ ] **Step 4: 実装する**

`src/jobs/deliver.js:1-7` の冒頭の説明を置き換える：

```js
// src/jobs/deliver.js
// portal で「完成」になった依頼を Mac が納品する巡回（poll のフック2）。
//   claim（予約）→ 完成品の取得と照合 → Drive の同期フォルダへ保存 → Drive の ID を待つ
//   → 配布リンクを発行して（グループからの依頼なら営業部のグループへ →）秘書室へ送る
//   → 結果（delivered / unknown / not_sent）を portal へ報告（結果は秘書室への送信で決める）
// 段階は納品台帳（ledger.js）に残し、途中で落ちても次の巡回で続きから進む。
// 宛先ごとの状態（グループ・秘書室）は「受付番号＋完成品の sha256＋宛先」で台帳に残し、予約をやり直しても引き継ぐ。
// 送れたか分からない送信は送り直さず unknown を報告する。portal への GET と報告は再試行してよい。
// 注意：ログには依頼番号・code・段階名だけを出す（物件名・リンク・本文・送信者名・groupId は出さない）
```

`src/jobs/deliver.js:27`（`const WORKFLOW_LABELS = …`）の次に足す：

```js
// グループからの帯替え（設計書 17）。営業部の groupId の形
const GROUP_ID_RE = /^C[0-9a-f]{32}$/;
// 秘書室の控えの文の最後に書く、グループへの状態
const GROUP_STATUS_LINES = {
  sent: "グループにも送りました",
  failed: "グループに送れませんでした",
  unknown: "グループへの送信結果が分かりません（確かめてください）",
  // replyKind が不明な値のとき（グループの状態は作らない）
  noreply: "返事先が不明のためグループには送っていません",
};
```

`src/jobs/deliver.js:104-111` の `deliveryText` を置き換え、続けて3つの関数を足す：

```js
function deliveryText(entry, link, ttlSec, groupState) {
  const hours = Math.max(1, Math.round((ttlSec || 86400) / 3600));
  const label = WORKFLOW_LABELS[entry.workflow] || entry.workflow || "";
  const property = entry.property ? sanitizeField(entry.property, 60) : "";
  const head = property ? `${label}｜${property}` : label;
  const review = entry.reviewPages > 0 ? `\n⚠ 要確認 ${entry.reviewPages}ページ（転送する前に中身を確認してください）` : "";
  const group = groupState && GROUP_STATUS_LINES[groupState] ? `\n${GROUP_STATUS_LINES[groupState]}` : "";
  return `#J${entry.no} できました（${head}）${review}\n${link}\n（名簿にいる在籍者だけ開けます・${hours}時間有効）${group}`;
}

// グループへの完成の知らせ（設計書 流れ 4）。グループの一員なら名簿の登録なしで開ける（設計書 5・18）
function groupText(entry, link, ttlSec) {
  const hours = Math.max(1, Math.round((ttlSec || 86400) / 3600));
  const label = WORKFLOW_LABELS[entry.workflow] || entry.workflow || "";
  const property = entry.property ? sanitizeField(entry.property, 60) : "";
  const head = `#J${entry.no} ${label}が完成しました${property ? `（${property}）` : ""}`;
  const review = entry.reviewPages > 0 ? `\n⚠ 要確認 ${entry.reviewPages}ページ（使う前に中身を確認してください）` : "";
  return `${head}${review}\n${link}\n（このグループの方が開けます・${hours}時間有効）`;
}

// claim の応答の返事先を台帳の行の形にする。項目が無い（今までの portal・Job）は秘書室だけ。
// 中身の検査（line-group＋営業部の groupId）はグループへ送る直前に行い、line-group なのに合わなければ「はっきり失敗」にする。line-group でも secretary でもない値は replyUnknown で別に扱う
function replyFields(b) {
  let replyKind = "secretary";
  if (b.replyKind != null) replyKind = typeof b.replyKind === "string" ? b.replyKind.slice(0, 40) : "invalid";
  const replyGroupId = typeof b.replyGroupId === "string" ? b.replyGroupId.slice(0, 64) : null;
  return { replyKind, replyGroupId };
}

// グループにも送る件か。line-group のときだけ。replyKind の無い今までの台帳の行・secretary・不明な値は送らない
function wantsGroup(entry) {
  return entry.replyKind === "line-group";
}

// replyKind が secretary でも line-group でもない不明な値か（無い今までの台帳の行は secretary 扱いなので false）。
// このときはグループの状態を作らず、秘書室の控えにだけ書く
function replyUnknown(entry) {
  return entry.replyKind != null && entry.replyKind !== "secretary" && entry.replyKind !== "line-group";
}
```

`src/jobs/deliver.js:125`（`const log = opts.log || …`）の次の行に足す：

```js
  const lineapp = opts.lineapp || require("../lineapp.js");
```

`src/jobs/deliver.js:224`（`function toReporting`）の直前に足す：

```js
  // グループへの1通（設計書 17）。宛先の状態は「受付番号＋完成品の sha256＋宛先」で台帳に残す。
  // 送信済み・結果不明なら二度と送らない（はっきり失敗だけは、予約をやり直したときにもう一度試す）。
  // 送る前に sending を保存し、書けなければ送らない。前回 sending のまま止まっていたら結果不明にする。
  // 営業部の ID（config の固定値）と完全一致したときだけ送り、送る直前に 宛先.json の「営業部」とも照合する（expectId）。
  // 戻り値："ok"（状態が決まった・送らない件）| "halt"（台帳に書けない）
  async function sendGroup(entry, dv) {
    if (!wantsGroup(entry)) return "ok";
    const no = entry.no;
    const setGroup = (value) => {
      ledger.setDest(state, no, entry.sha256, "group", value, now());
      return persist() ? "ok" : "halt";
    };
    const cur = ledger.getDest(state, no, entry.sha256, "group");
    if (cur === "sent" || cur === "unknown") return "ok";
    if (cur === "sending") {
      // 前回、グループへ送っている途中で止まった。届いたか分からないので送り直さない
      safeLog("warn", `job-deliver #J${no} group-sending-interrupted`);
      return setGroup("unknown");
    }
    const toId = cfg.DOC_REPLY && cfg.DOC_REPLY.toId;
    if (entry.replyKind !== "line-group" || typeof entry.replyGroupId !== "string"
      || !GROUP_ID_RE.test(entry.replyGroupId) || entry.replyGroupId !== toId) {
      safeLog("warn", `job-deliver #J${no} group-mismatch`);
      return setGroup("failed");
    }
    let issued;
    try {
      issued = dtoken.issue(
        {
          shelfId: `job-${no}`, driveFileId: entry.driveFileId, sha256: entry.sha256, ttlSec: dv.ttlSec, now: now(),
          aud: "line-group", g: entry.replyGroupId,
        },
        { privateKeyPem: dv.privateKeyPem, kid: dv.kid }
      );
    } catch {
      safeLog("error", `job-deliver #J${no} group-issue-failed`);
      return setGroup("failed");
    }
    const text = groupText(entry, `https://liff.line.me/${dv.liffId}?t=${issued.d}`, dv.ttlSec);
    if (setGroup("sending") === "halt") return "halt";
    let result = "sent";
    try {
      await lineapp.pushText({ alias: cfg.DOC_REPLY.toAlias, text, expectId: entry.replyGroupId });
    } catch (err) {
      // 応答のある 4xx（宛先.json の入れ替わりも 400）だけが「はっきり失敗」。それ以外は結果不明
      result = isDefinitelyNotSent(err) ? "failed" : "unknown";
      const why = err && err.code === "destination-mismatch" ? " destination" : "";
      safeLog("warn", `job-deliver #J${no} group-${result}${why}`);
    }
    if (result === "sent") safeLog("info", `job-deliver #J${no} group-sent`);
    return setGroup(result);
  }
```

`src/jobs/deliver.js:301-349`（`case "synced": { … }`）を丸ごと置き換える：

```js
        case "synced": {
          // 期限が近ければ、止まっていても not_sent で返す（予約を抱えたまま期限切れにしない）
          const leaseUntil = Date.parse(entry.leaseUntil);
          if (!Number.isFinite(leaseUntil) || leaseUntil - now() < LEASE_MARGIN_MS) {
            safeLog("warn", `job-deliver #J${no} lease-short`);
            if (!toReporting(entry, "not_sent", "lease")) return "halt";
            break;
          }
          // 送信の直前にも「資料を止めて」を確かめる。止まっていたら送らずに次の巡回を待つ（他の件は進める）。
          // グループへの送信もここより後なので、止まっている間はグループにも出さない
          if (delivery.isStopped()) {
            out.stopped = true;
            return "wait";
          }
          const dv = cfg.DELIVERY;
          let issued;
          try {
            issued = dtoken.issue(
              { shelfId: `job-${no}`, driveFileId: entry.driveFileId, sha256: entry.sha256, ttlSec: dv.ttlSec, now: now() },
              { privateKeyPem: dv.privateKeyPem, kid: dv.kid }
            );
          } catch {
            // 設定の問題。この件は送らずに返し、他の件は進める。知らせは1日1回。
            // 秘書室のリンクを先に作るので、作れない件はグループにも出さない
            safeLog("error", `job-deliver #J${no} issue-failed`);
            if (!toReporting(entry, "not_sent", "config")) return "halt";
            await alertDaily("configDay", CONFIG_NOTICE);
            break;
          }
          // グループ → 秘書室の順に送る（設計書 17）。グループの結果は秘書室の控えの文に書き、
          // portal への結果は今どおり秘書室の送信で決める
          if (await sendGroup(entry, dv) === "halt") return "halt";
          let groupState = null;
          if (wantsGroup(entry)) groupState = ledger.getDest(state, no, entry.sha256, "group");
          else if (replyUnknown(entry)) {
            safeLog("warn", `job-deliver #J${no} reply-unknown`);
            groupState = "noreply";
          }
          const text = deliveryText(entry, `https://liff.line.me/${dv.liffId}?t=${issued.d}`, dv.ttlSec, groupState);
          // 送る前に台帳を sending にする。書けなければ送らない（落ちたら次回は unknown として扱う）
          entry.stage = "sending";
          entry.updatedAt = new Date(now()).toISOString();
          if (!persist()) return "halt";
          try {
            await send(text);
          } catch (err) {
            const outcome = isDefinitelyNotSent(err) ? "not_sent" : "unknown";
            safeLog("warn", `job-deliver #J${no} send-${outcome}`);
            // 秘書室への送信が落ちている最中かもしれない。poll はこの回の notify（納品要確認の知らせ）を
            // 呼ばず、次の回に回す（同じ回に送って失敗し、知らせが出ないまま終わるのを避ける）
            if (outcome === "unknown") out.sendUnknown = true;
            if (!toReporting(entry, outcome, "send")) return "halt";
            break;
          }
          entry.stage = "sent";
          entry.updatedAt = new Date(now()).toISOString();
          safeLog("info", `job-deliver #J${no} sent`);
          if (!persist()) return "halt";
          break;
        }
```

`src/jobs/deliver.js:437-447`（claim の応答から台帳の行を作る所）を置き換える：

```js
        const entry = {
          no: job.no, claimId: b.claimId, leaseUntil: b.leaseUntil || null,
          sha256: b.artifactSha256 || null,
          artifactName: b.artifactName || job.artifactName || null,
          workflow: job.workflow || null, property: job.property || null,
          // 要確認のページ数（自動納品のとき、転送の前に見てもらうため知らせに添える）
          reviewPages: Number.isSafeInteger(b.reviewPages) && b.reviewPages > 0 ? b.reviewPages : 0,
          // 返事先（設計書 16・17）。一覧ではなく claim の応答（納品のときの正本）を使う
          ...replyFields(b),
          stage: "claimed", pendingOutcome: null, reason: null,
          localPath: null, driveFileId: null, savedAt: null,
          updatedAt: new Date(now()).toISOString(), reportTries: 0,
        };
```

`src/jobs/deliver.js:473` の exports を置き換える：

```js
module.exports = { run, safeFileName, targetPath, deliveryText, groupText };
```

- [ ] **Step 5: 通ることを確かめる**

Run: `node --test test/jobs-deliver.test.js`
Expected: `fail 0`（既存のテストも全部通る。秘書室だけの件の文・`issued[0].payload` は今までどおり）

- [ ] **Step 6: コミット**

```bash
git add src/jobs/deliver.js test/jobs-deliver.test.js
git commit -m "$(cat <<'EOF'
feat(jobs): グループからの帯替えは完成リンクを営業部のグループにも送り、秘書室の控えに結果を書く

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 秘書室の宛先状態を残し、同じ完成品には（人の再納品でも）送り直さない

**Files:**
- Modify: `src/jobs/deliver.js` の `case "synced"`（Task 3 で置き換えたもの）と `case "sending"`（`src/jobs/deliver.js:350-355` 付近）
- Test: `test/jobs-deliver.test.js`（末尾に追記。既存の3件を更新：`:217-238`・`:669-685`・`:847-871`）

**Interfaces:**
- Consumes: Task 2 の `ledger.getDest` / `ledger.setDest(state, no, sha256, "secretary", value, nowMs)`。Task 3 の `sendGroup`・`deliveryText(entry, link, ttlSec, groupState)`
- Produces: 台帳の `dests` に秘書室の状態（送る前 `sending`、送れた `sent`、4xx `failed`、それ以外の失敗と「sending のまま再開」 `unknown`）。**同じ sha256 の完成品を予約し直したとき、秘書室が `sent` なら送らずに delivered を報告し、`unknown`（または `sending`）なら送らずに unknown を報告し直す**（人が portal で「もう一度納品」しても同じ）。`failed` だけは送り直す。sha256 が変わったときは新しく送る。ログに `secretary-already-sent`・`secretary-already-unknown`

設計書 17 の「同じ完成品について、送信済み・結果不明の宛先には二度と送らない」を、グループにも秘書室にも例外なく当てはめる（controller の判断）。秘書室への送信が結果不明になった件は portal が「納品要確認」にする。人が「もう一度納品」して「完成」に戻っても、完成品が同じ（sha256 が同じ）なら秘書室へは送り直さず、既に分かっている結果（unknown）を portal に報告し直す（unknown のまま）。本当に送り直したいときは完成品を作り直す（sha256 が変わる）。このため既存の3件のテスト（人の再納品で送り直す前提だったもの）をこの Task で更新する。

- [ ] **Step 1: 既存の3件のテストを更新し、失敗するテストを書く**

(a) `test/jobs-deliver.test.js:217-238` の「送信 500 は unknown を報告して送り直さない → …」のテストを丸ごと次に置き換える：

```js
test("deliver: 送信 500 は unknown を報告して送り直さない → 人が完成に戻しても同じ完成品には送らず、新しい claimId で unknown を報告し直す", async () => {
  const s = setup("unknown-redo");
  s.portal.add(12);
  s.sendFail.push(500);
  await s.run();
  assert.equal(s.sent.length, 0);
  assert.equal(s.portal.calls.reportResult[0].outcome, "unknown");
  assert.equal(s.portal.jobs.get(12).status, "納品要確認");
  const firstClaim = s.portal.calls.reportResult[0].claimId;
  await s.run();
  assert.equal(s.portal.calls.claim.length, 1, "納品要確認は完成一覧に出ないので予約しない");
  assert.equal(s.sent.length, 0, "送り直さない");
  // 人が portal で「もう一度納品」→ 完成に戻る。完成品（sha256）が同じで秘書室は結果不明のままなので、送り直さない
  s.portal.jobs.get(12).status = "完成";
  s.clock.t += MIN;
  await s.run();
  assert.equal(s.sent.length, 0, "結果不明の宛先には二度と送らない");
  const last = s.portal.calls.reportResult.at(-1);
  assert.equal(last.outcome, "unknown", "unknown のまま報告し直す");
  assert.notEqual(last.claimId, firstClaim);
  assert.equal(s.portal.jobs.get(12).status, "納品要確認");
  assert.equal(s.ledger().history.length, 2);
  assert.ok(s.logLines.includes("warn job-deliver #J12 secretary-already-unknown"));
});
```

(b) `test/jobs-deliver.test.js:669-685` の「unknown の後（人が「もう一度納品」）は待たずに予約し直せる…」のテストを丸ごと次に置き換える：

```js
test("deliver: unknown の後（人が「もう一度納品」）は待たずに予約し直せる（not_sent の数も数え直す。送り直さず unknown を報告し直す）", async () => {
  const s = setup("unknown-no-cooldown");
  s.portal.add(12);
  s.sendFail.push(404);
  await s.run();
  s.clock.t += 61 * MIN;
  s.sendFail.push(500);
  await s.run();
  assert.equal(s.portal.jobs.get(12).status, "納品要確認");
  assert.deepEqual(s.ledger().retries, {});
  s.portal.jobs.get(12).status = "完成";
  s.clock.t += MIN;
  await s.run();
  assert.equal(s.portal.calls.claim.length, 3, "待たずに予約し直せる");
  assert.equal(s.sent.length, 0, "結果不明の宛先には二度と送らない");
  assert.equal(s.portal.calls.reportResult.at(-1).outcome, "unknown");
  assert.equal(s.portal.jobs.get(12).status, "納品要確認");
});
```

(c) `test/jobs-deliver.test.js:847-871` の H2 のテストの中の、`s.clock.t += MIN;` の次にある `s.sendFail.push(500);`（2回目の送信失敗の準備）の1行を消す。再納品は送信せずに unknown を報告し直すので、準備が要らない。残りは変えない（`claim.length === 2`・`notified` の印が消える・`納品要確認` に戻る・もう一度お知らせが出る、は新しい動きでも成り立つ）：

```js
  // 人が portal で「もう一度納品」→ 完成に戻る → 予約した保存で「知らせた」の印を消す
  s.portal.jobs.get(12).status = "完成";
  s.clock.t += MIN;
  await s.run();
```

(d) 末尾に新しいテストを追記：

```js
test("deliver(group): 秘書室へ送った直後・台帳に書く前に落ちた → 次の回は unknown を報告し、どちらにも送り直さない。人の再納品でも送らない", async () => {
  const s = setup("secretary-crash-after-send");
  s.portal.add(12, GROUP);
  const sha256 = s.portal.jobs.get(12).artifactSha256;
  // 秘書室の「送信済み」（段 sent）を書く保存だけ失敗させる
  s.ledgerImpl = failingLedger((state) => Object.values(state.active).some((e) => e.stage === "sent"));
  const out = await s.run();
  assert.equal(out.halted, "ledger");
  assert.equal(s.pushStat.calls, 1);
  assert.equal(s.sent.length, 1);
  const disk = s.ledger();
  assert.equal(Object.values(disk.active)[0].stage, "sending");
  assert.equal(ledger.getDest(disk, 12, sha256, "secretary"), "sending");
  assert.equal(ledger.getDest(disk, 12, sha256, "group"), "sent");
  s.ledgerImpl = undefined;
  await s.run();
  assert.equal(s.portal.calls.reportResult[0].outcome, "unknown");
  assert.equal(destOf(s, 12, "secretary"), "unknown");
  assert.equal(s.pushStat.calls, 1);
  assert.equal(s.sent.length, 1);
  // 人が portal で「もう一度納品」→ 完成に戻る。同じ完成品なので、秘書室にもグループにも送らず unknown を報告し直す
  s.portal.jobs.get(12).status = "完成";
  s.clock.t += MIN;
  await s.run();
  assert.equal(s.pushStat.calls, 1);
  assert.equal(s.sent.length, 1);
  assert.equal(s.portal.calls.reportResult.at(-1).outcome, "unknown");
  assert.equal(destOf(s, 12, "secretary"), "unknown");
  assert.equal(destOf(s, 12, "group"), "sent");
  assert.equal(s.portal.jobs.get(12).status, "納品要確認");
});

test("deliver(group): 秘書室が結果不明の完成品は、グループが送信済みでも、再納品で両方とも送らない", async () => {
  const s = setup("secretary-unknown-no-resend");
  s.portal.add(12, GROUP);
  s.sendFail.push(500);
  await s.run();
  assert.equal(s.pushStat.calls, 1);
  assert.equal(destOf(s, 12, "secretary"), "unknown");
  s.portal.jobs.get(12).status = "完成";
  s.clock.t += MIN;
  await s.run();
  assert.equal(s.pushStat.calls, 1);
  assert.equal(s.sent.length, 0);
  assert.equal(s.portal.calls.reportResult.at(-1).outcome, "unknown");
  assert.equal(s.portal.jobs.get(12).status, "納品要確認");
});

test("deliver(group): 秘書室が結果不明でも、完成品が作り直されて sha256 が変わったら、グループにも秘書室にも新しく送る", async () => {
  const s = setup("secretary-unknown-new-sha");
  const j = s.portal.add(12, GROUP);
  s.sendFail.push(500);
  await s.run();
  assert.equal(s.sent.length, 0);
  j.pdf = Buffer.from("%PDF-remade");
  j.artifactSha256 = sha(j.pdf);
  j.status = "完成";
  s.clock.t += MIN;
  await s.run();
  assert.equal(s.pushStat.calls, 2);
  assert.equal(s.sent.length, 1);
  assert.equal(lastLine(s.sent[0]), LINE_SENT);
  assert.equal(s.portal.calls.reportResult.at(-1).outcome, "delivered");
  assert.equal(s.portal.jobs.get(12).status, "納品済み");
});

test("deliver: 秘書室への送信の結果ごとに宛先の状態が残る（送信済み・はっきり失敗・結果不明）", async () => {
  for (const c of [{ fail: [], state: "sent" }, { fail: [404], state: "failed" }, { fail: [500], state: "unknown" }]) {
    const s = setup(`secretary-dest-${c.state}`);
    s.portal.add(12);
    s.sendFail.push(...c.fail);
    await s.run();
    assert.equal(destOf(s, 12, "secretary"), c.state, c.state);
    assert.equal(destOf(s, 12, "group"), null, "秘書室だけの件はグループの状態を作らない");
  }
});

test("deliver: 秘書室がはっきり失敗（4xx）した完成品は、予約し直したときにもう一度送る", async () => {
  const s = setup("secretary-failed-retry");
  s.portal.add(12);
  s.sendFail.push(404);
  await s.run();
  assert.equal(destOf(s, 12, "secretary"), "failed");
  s.clock.t += 61 * MIN;
  await s.run();
  assert.equal(s.sent.length, 1);
  assert.equal(destOf(s, 12, "secretary"), "sent");
  assert.equal(s.portal.jobs.get(12).status, "納品済み");
});

test("deliver: 落ちて再起動 — sending からは送らず、秘書室の宛先を unknown にする", async () => {
  const s = setup("resume-sending-dest");
  s.portal.add(12);
  seed(s, 12, "sending", { driveFileId: "drive-1" });
  await s.run();
  assert.equal(s.sent.length, 0);
  assert.equal(destOf(s, 12, "secretary"), "unknown");
});

test("deliver: 秘書室へ送信済みの完成品を予約し直したら、送り直さずに delivered を報告する", async () => {
  const s = setup("secretary-already-sent");
  s.portal.add(12);
  s.portal.fail.reportResult.push("CLAIM_MISMATCH");
  await s.run();
  assert.equal(s.sent.length, 1);
  assert.equal(destOf(s, 12, "secretary"), "sent");
  // 予約の期限切れなどで portal が完成に戻した
  const j = s.portal.jobs.get(12);
  j.status = "完成";
  j.claimId = null;
  s.clock.t += MIN;
  await s.run();
  assert.equal(s.portal.calls.claim.length, 2);
  assert.equal(s.sent.length, 1, "秘書室に送り直さない");
  assert.equal(s.portal.calls.reportResult.at(-1).outcome, "delivered");
  assert.equal(j.status, "納品済み");
  assert.ok(s.logLines.includes("info job-deliver #J12 secretary-already-sent"));
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/jobs-deliver.test.js`
Expected: FAIL。(a)(b)(d) の「再納品でも送らない」系は `s.sent.length` が 1 になる、秘書室の宛先の状態が `null`、「送信済みの完成品を予約し直したら」で `s.sent.length` が 2、など。

- [ ] **Step 3: 実装する**

Task 3 で置き換えた `case "synced": {` の直後（`// 期限が近ければ…` の前）に足す：

```js
          // 秘書室の宛先がもう決まっている完成品（同じ sha256）には、グループにも秘書室にも送り直さない（設計書 17）。
          // 既に分かっている結果を portal に報告し直すだけ。人が portal で「もう一度納品」して完成に戻しても同じ
          // （unknown は unknown のまま）。送り直したいときは完成品を作り直す（sha256 が変わる）
          const secretaryState = ledger.getDest(state, no, entry.sha256, "secretary");
          if (secretaryState === "sent") {
            safeLog("info", `job-deliver #J${no} secretary-already-sent`);
            entry.stage = "sent";
            entry.updatedAt = new Date(now()).toISOString();
            if (!persist()) return "halt";
            break;
          }
          if (secretaryState === "unknown" || secretaryState === "sending") {
            safeLog("warn", `job-deliver #J${no} secretary-already-unknown`);
            if (secretaryState === "sending") ledger.setDest(state, no, entry.sha256, "secretary", "unknown", now());
            if (!toReporting(entry, "unknown", "send")) return "halt";
            break;
          }
```

同じ `case "synced"` の、秘書室へ送る所（`// 送る前に台帳を sending にする。…` から `case` の終わりの `break;` まで）を置き換える：

```js
          // 送る前に台帳を sending にする（段と秘書室の宛先を同じ保存で）。書けなければ送らない
          // （落ちたら次回は unknown として扱う）
          entry.stage = "sending";
          entry.updatedAt = new Date(now()).toISOString();
          ledger.setDest(state, no, entry.sha256, "secretary", "sending", now());
          if (!persist()) return "halt";
          try {
            await send(text);
          } catch (err) {
            const outcome = isDefinitelyNotSent(err) ? "not_sent" : "unknown";
            safeLog("warn", `job-deliver #J${no} send-${outcome}`);
            // 秘書室への送信が落ちている最中かもしれない。poll はこの回の notify（納品要確認の知らせ）を
            // 呼ばず、次の回に回す（同じ回に送って失敗し、知らせが出ないまま終わるのを避ける）
            if (outcome === "unknown") out.sendUnknown = true;
            ledger.setDest(state, no, entry.sha256, "secretary", outcome === "not_sent" ? "failed" : "unknown", now());
            if (!toReporting(entry, outcome, "send")) return "halt";
            break;
          }
          entry.stage = "sent";
          entry.updatedAt = new Date(now()).toISOString();
          ledger.setDest(state, no, entry.sha256, "secretary", "sent", now());
          safeLog("info", `job-deliver #J${no} sent`);
          if (!persist()) return "halt";
          break;
        }
```

`case "sending": { … }`（`src/jobs/deliver.js:350-355` 付近）を置き換える：

```js
        case "sending": {
          // 前回の送信中に落ちた。届いたかどうか分からないので送り直さない（秘書室の宛先も結果不明にする）
          safeLog("warn", `job-deliver #J${no} sending-interrupted`);
          ledger.setDest(state, no, entry.sha256, "secretary", "unknown", now());
          if (!toReporting(entry, "unknown", "send")) return "halt";
          break;
        }
```

- [ ] **Step 4: 通ることを確かめる**

Run: `node --test test/jobs-deliver.test.js test/jobs-ledger.test.js`
Expected: `fail 0`（既存の「sending を書けなかったら送らず…」「done への移動を書けなかったら…」も通る）。ほかの既存のテストが「同じ sha256 の完成品を再納品して送り直す」前提で落ちたら、テストを弱めずに止めて報告する（この Task で更新したのは上の(a)(b)(c)の3件だけのはず）

- [ ] **Step 5: コミット**

```bash
git add src/jobs/deliver.js test/jobs-deliver.test.js
git commit -m "$(cat <<'COMMIT'
feat(jobs): 秘書室への送信も宛先ごとに残し、同じ完成品には再納品でも送り直さない

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
)"
```

---

### Task 5: 共通の依頼テスト表を写して、`parse.js` が全件同じ結果を出すことを固定する

**Files:**
- Create: `test/fixtures/job-command-cases.json`（P2 の計画から取り出す）
- Create: `test/jobs-parse-shared.test.js`
- 変えない：`src/jobs/parse.js`、`test/jobs-parse.test.js`

**Interfaces:**
- Consumes: P2 の計画（`/Users/shimo/AI開発/apps/aisecretary/.worktrees/group-obi/docs/superpowers/plans/2026-10-09-group-obi-p2-aisecretary.md`）の Task 1 Step 1 にある `tests/fixtures/job-command-cases.json` の JSON 全文（`{ "about": …, "cases": [{ "input", "expected" }] }`、2026-10-09 時点で35件）。既存の `src/jobs/parse.js` の `parseJobCommand`
- Produces: line-secretary の `test/fixtures/job-command-cases.json`（P2 が aisecretary に作る同名のファイルと同じ中身）と、全件の照合テスト

**注意（実装の順番）：** 実装の順番は P1 → P3 → P4 → P2 なので、P3 を実装する時点では aisecretary の `tests/fixtures/job-command-cases.json` はまだ存在しない（P2 が作る）。そのため、**P3 の実装者は P2 の計画の JSON コードブロック（全文が書いてある）から表を生成する**。aisecretary のファイルを探したり、手で写したりしない。後で P2 を実装するとき、P2 の実装者は自分のファイルとこのファイルの中身が同じか（`diff`）を確かめる。

- [ ] **Step 1: 失敗するテストを書く**（`test/jobs-parse-shared.test.js`）

```js
// test/jobs-parse-shared.test.js
// 依頼文の読み取り（src/jobs/parse.js）が、aisecretary（src/lib/obi/parse.ts）と共通の表で全件同じ結果になることを固定する。
// 表：test/fixtures/job-command-cases.json（aisecretary の tests/fixtures/ と同じ中身。片方だけ直さない）。
// 食い違ったら parse.js も表も直さず、止めて報告する
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseJobCommand } = require("../src/jobs/parse.js");

const table = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "job-command-cases.json"), "utf8"));

test("共通の依頼テスト表が読める（30件以上・形が正しい）", () => {
  assert.ok(Array.isArray(table.cases));
  assert.ok(table.cases.length >= 30, `件数=${table.cases.length}`);
  for (const c of table.cases) {
    assert.equal(typeof c.input, "string");
    assert.ok(Object.prototype.hasOwnProperty.call(c, "expected"));
  }
});

for (const c of table.cases) {
  test(`共通表: parseJobCommand(${JSON.stringify(c.input)})`, () => {
    assert.deepStrictEqual(parseJobCommand(c.input), c.expected);
  });
}
```

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/jobs-parse-shared.test.js`
Expected: FAIL（表のファイルがまだ無いので `ENOENT: no such file or directory … test/fixtures/job-command-cases.json`）

- [ ] **Step 3: 表を P2 の計画から生成する**

```bash
node -e '
const fs = require("fs");
const plan = "/Users/shimo/AI開発/apps/aisecretary/.worktrees/group-obi/docs/superpowers/plans/2026-10-09-group-obi-p2-aisecretary.md";
const t = fs.readFileSync(plan, "utf8");
const i = t.indexOf("`tests/fixtures/job-command-cases.json`:");
if (i < 0) throw new Error("P2 の計画に表の見出しが見つかりません");
const m = /```json\n([\s\S]*?)\n```/.exec(t.slice(i));
if (!m) throw new Error("P2 の計画に JSON の塊が見つかりません");
const data = JSON.parse(m[1]);
if (!Array.isArray(data.cases) || data.cases.length < 30) throw new Error("表の形が違います");
fs.mkdirSync("test/fixtures", { recursive: true });
fs.writeFileSync("test/fixtures/job-command-cases.json", m[1] + "\n");
console.log("cases=" + data.cases.length);
'
```

Expected: `cases=35`（P2 の計画の表の件数。P2 の計画がその後直されていて件数が違っても、30件以上なら進めてよい）

- [ ] **Step 4: 通ることを確かめる**

Run: `node --test test/jobs-parse-shared.test.js test/jobs-parse.test.js`
Expected: `fail 0`（共通表の全件で `parseJobCommand` が同じ結果。**1件でも違ったら、`src/jobs/parse.js` も表も変えずに、ここで止めて、どの入力で何が違ったかを報告する**）

- [ ] **Step 5: コミット**

```bash
git add test/fixtures/job-command-cases.json test/jobs-parse-shared.test.js
git commit -m "$(cat <<'COMMIT'
test(jobs): 依頼文の読み取りを aisecretary と共通の表で全件固定する

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
COMMIT
)"
```

---

### Task 6: 全体のテストと、本番への取り込みの手順

**Files:**
- なし（確認と取り込みだけ。コードは変えない）

**Interfaces:**
- Consumes: Task 1〜5 のコミット（ブランチ `feature/group-obi-deliver`）。P4 の本番確認（Vercel の閲覧ページ）
- Produces: 本番の作業ツリー（`feature/v1`）への fast-forward の取り込み（P4 が本番に出て確かめられた後、下村さんの承認後）

テストのコマンドに `| tail` などのパイプを付けない（終了コードが消えて、失敗が成功に見える）。出力を絞りたいときは先頭に `set -o pipefail;` を付ける。

- [ ] **Step 1: 全体のテスト**

Run: `npm test`
Expected: `fail 0`（`test/*.test.js` と `delivery/test/*.test.js` の全部）。`git status --short` が空（テストが作るのは `tmp/` の下だけで、`test/fixtures/dtoken-vector-group.json` と `test/fixtures/job-command-cases.json` はコミット済み）

- [ ] **Step 2: 差分の確認**

```bash
git log --oneline feature/v1..feature/group-obi-deliver
git diff --stat feature/v1..feature/group-obi-deliver
```

Expected: Task 1〜5 の5コミット。変わるのは `src/dtoken.js`・`src/jobs/ledger.js`・`src/jobs/deliver.js`・`test/dtoken.test.js`・`test/jobs-ledger.test.js`・`test/jobs-deliver.test.js`・`test/jobs-parse-shared.test.js`・`test/fixtures/dtoken-vector-group.json`・`test/fixtures/job-command-cases.json` だけ（`src/jobs/parse.js`・`src/poll.js`・`launchd/`・`.env`・`delivery/` は変わらない）

- [ ] **Step 3: 取り込みの順番を確かめてから、下村さんに承認を求める（ここで止まる）**

実装の順番は P1 → P3 → P4 → P2（P4 の作業ブランチはこのブランチから作る）。**本番に出す順番は P1 → P4 → P3 → P2**。この計画の取り込み（Mac の本番ツリー）は、P4 が本番に出て確かめられた後に行う：
1. P1（portal の claim に `replyKind`・`replyGroupId`）が Railway の本番に出ていること。出ていなくてもこの変更は壊れない（項目なし＝秘書室だけ）が、グループには送られない
2. P4（閲覧ページの `aud`・`g` の検査）が Vercel の本番に出て、確かめられていること（グループあてのトークンで開ける・印のない秘書室あてトークンは今までどおり名簿を見る・値が違えば拒否）。**P3 より先に出すのは、P3 を取り込むとグループに `aud: "line-group"` 付きのリンクが出るため、閲覧ページが先にそれを読めないと開けないから**
3. この計画（P3）を `feature/v1` に fast-forward で取り込む（下の Step 4）
4. 最後に P2（aisecretary の帯替えの受付）を有効にする（グループからの依頼が実際に始まる）

注意：P4 のブランチはこのブランチを土台にしているので、P4 のブランチを先に `feature/v1` へ入れると P3 のコミットも一緒に入り、Mac が先に新しいコードで動き出してしまう。P4 の本番確認は Vercel のデプロイ（ブランチのまま）で行い、`feature/v1` への取り込みはこの Step 4 の後にする。

下村さんに伝えること：上の順番、P4 の本番確認の結果、Step 1・2 の結果、取り込むと次の60秒ごとの巡回から新しいコードになること、戻すときの注意（下の Step 5）。**承認が出るまで Step 4 に進まない。**

- [ ] **Step 4: 取り込み（下村さんの承認後。下村さんが自分で行うか、承認を得て実行）**

```bash
# 本番の作業ツリーが綺麗で feature/v1 にいること
git -C /Users/shimo/AI開発/apps/line-secretary status --short
git -C /Users/shimo/AI開発/apps/line-secretary branch --show-current   # → feature/v1
# feature/v1 がこの枝の作成後に進んでいたら止めて下村さんに聞く（rebase しない。P4 がこの枝を土台にしているため、
# 書き換えると P4 側も載せ直しになる）
git -C /Users/shimo/AI開発/apps/line-secretary merge-base --is-ancestor feature/v1 feature/group-obi-deliver && echo "ff 可能" || echo "止める"
# fast-forward だけで取り込む（merge コミットを作らない。できなければ止める）
git -C /Users/shimo/AI開発/apps/line-secretary merge --ff-only feature/group-obi-deliver
```

- launchd の設定・パスは変えない（`com.shimo.line-secretary.poll` は `StartInterval 60` で毎回新しい node を起動するので、`launchctl unload/load` は要らない。`launchd/*.plist` のパスは凍結）
- `git push` はこの手順に含めない（する場合は別に下村さんの確認を取る）

- [ ] **Step 5: 取り込み後の確認と、戻すときの注意**

```bash
# 次の巡回の後、台帳が壊れていないこと（中身は表示しない）
node -e 'const l=require("/Users/shimo/AI開発/apps/line-secretary/src/jobs/ledger.js");const s=l.load("/Users/shimo/AI開発/apps/line-secretary/state/job-deliveries.json");console.log("broken="+s.broken+" dests="+Object.keys(s.dests).length)'
# その日のログに job-deliver の異常（ledger-broken・ledger-write-failed）が出ていないこと（物件名などは出ない約束）
grep -E "job-deliver (ledger-broken|ledger-write-failed)" /Users/shimo/AI開発/apps/line-secretary/state/log/$(TZ=Asia/Tokyo date +%F).log || echo "異常なし"
```

Expected: `broken=false`、`異常なし`。

戻すとき（`git -C … reset` などは下村さんの判断で）：前のコードは台帳の `dests` を読まずに保存で落とすので、戻した後にやり直しの予約が起きると、グループにも秘書室にも再送されうる。グループからの依頼（P2）を止めてから戻す。

---

## 対象外・後で行うこと

- 本番のグループでの実地の確認は、4計画がそろった後に設計書「確かめ方」の「実地」で行う（この計画のタスクには入れない）
- P2 の実装のとき、P2 の実装者は aisecretary の `tests/fixtures/job-command-cases.json` を作った後、この計画の Task 5 で置いた line-secretary の `test/fixtures/job-command-cases.json` と中身が同じか（`diff`）を確かめる（P3 はそのファイルを P2 の計画の JSON から生成している）

## Self-Review

**1. 設計書の項目ごとの対応**
- 17 宛先は2つ（グループは `line-group` のとき・秘書室はいつも）→ Task 3 `wantsGroup`・`sendGroup`、Task 4
- 17 `未着手 → 送信中 → 送信済み／はっきり失敗／結果不明` を台帳に・送る前に「送信中」を保存・再開時「送信中」→「結果不明」で送り直さない → Task 2（`dests`・`DEST_STATES`）、Task 3（グループ：`setGroup("sending")`、`group-sending-interrupted`、テスト「グループへ送った直後・台帳に書く前に落ちた」「送信中を書けなければ送らない」）、Task 4（秘書室：`sending` と同じ保存、`case "sending"`、テスト「秘書室へ送った直後・台帳に書く前に落ちた」）
- 17 7日で既存の台帳の整理と一緒に消す → Task 2 `prune` の `DEST_KEEP_MS`（`finish()` の `ledger.prune` で毎回呼ばれる）
- 17 「受付番号＋sha256＋宛先」で残し claim をやり直しても引き継ぐ・送信済み／結果不明には（グループにも秘書室にも）二度と送らない・秘書室がはっきり失敗して再納品でもグループに再送しない・sha256 が変わったら新しく送る → Task 2 `destKey`、Task 3 テスト「予約をやり直したとき…」「sha256 が変わったら」、Task 4 の `secretary-already-sent`・`secretary-already-unknown`（人の再納品でも送り直さない）と各テスト、既存3件の更新
- 17 順番 グループ → 秘書室・`宛先.json` の「営業部」と完全一致のときだけ・不一致は「はっきり失敗」→ Task 3（`config.DOC_REPLY.toId` と完全一致、さらに `pushText` の `expectId` で 宛先.json と照合、`events` のテスト、「宛先.json が入れ替わっていたら」のテスト）
- 17 portal の結果は秘書室の送信で決める・控えの文にグループの状態 → Task 3 `deliveryText` の `groupState`、組み合わせのテスト
- 18（発行側）`aud: 'line-group'`・`g` を署名の内側に・秘書室あてには付けない・両方そろえるか両方なし → Task 1、Task 3 の `issued[1].payload`
- 流れ 4 グループの文（#J・完成・物件名・リンク・要確認） → Task 3 `groupText`
- 16（受け手側）claim の応答の `replyKind`・`replyGroupId` を正本として使う・項目なしは secretary → Task 3 `replyFields`、「今までの portal」のテスト
- 確かめ方「LINE秘書」：組み合わせ（グループ 成功／失敗／不明 × 秘書室 成功／失敗）→ Task 3 の組み合わせのテスト（秘書室の不明も含む）／再開時の「送信中」→ 不明 → Task 3・4／秘書室の失敗で予約をやり直してもグループに再送しない → Task 3／営業部の ID と一致しないと送らない → Task 3／トークンの `aud`・`g` → Task 1
- 確かめ方「途中で止まる場面」：グループへの送信直後 → Task 3、秘書室への送信直後 → Task 4

**2. 判断したこと（設計書があいまいだった所）**
- 秘書室の「結果不明」：設計書 17 の「結果不明の宛先には二度と送らない」を、グループにも秘書室にも例外なく当てはめる（controller の判断）。人が portal で「もう一度納品」しても、同じ sha256 なら秘書室へ送り直さず、unknown のまま報告し直す。このため、人の再納品で送り直す前提だった既存の3件のテスト（`:217-238`・`:669-685`・`:847-871`）を Task 4 で更新する。送り直したいときは完成品を作り直す（sha256 が変わる）。秘書室の「送信済み」も予約し直しても送らず delivered を報告し直す。「はっきり失敗」の宛先だけが再試行の対象
- 秘書室がもう `sent`／`unknown` の件では、グループにも新しくは送らない（秘書室の確認を先に行う。グループは秘書室より先に送るので、普通はグループの状態も残っている）
- グループの「はっきり失敗」は、予約をやり直したときにもう一度試す（設計書が禁じるのは送信済み・結果不明だけ）
- 営業部の ID の照合は二重にする：`config.DOC_REPLY.toId`（コードに固定）との完全一致と、送る直前の `pushText` の `expectId`（`宛先.json` の「営業部」）。どちらかが違えば「はっきり失敗」
- `pushText` が HTTP の前に status なしで投げる失敗（トークンが無いなど）は「結果不明」として扱う（送っていない可能性が高いが、`lineapp.js` を変えずに安全側に倒す）
- 秘書室のリンクを先に発行し、発行できない件はグループにも出さない（グループだけにリンクが出て秘書室は not_sent、を避ける）
- `replyKind` が `secretary`・`line-group` 以外の値なら、グループの状態は作らず送らない。秘書室の控えに「返事先が不明のためグループには送っていません」と書いて人に知らせる（`wantsGroup` は `line-group` のときだけ）
- 共通の依頼テスト表は、P2 より先に P3 を実装するため、P2 の計画の JSON コードブロックから生成する（Task 5）。違いが出たら `parse.js` も表も直さず止めて報告する
- グループあての互換ベクトル `test/fixtures/dtoken-vector-group.json` を P3 で固定し、P4（このブランチから分岐する）が閲覧ページ側の検査のテストに使えるようにする
- 本番に出す順番は P1 → P4 → P3 → P2。P3 の fast-forward は P4 が Vercel に出て確かめられた後、下村さんの承認後（Task 6）

**3. 抜け・置き換え忘れの点検**
- 「TBD」「後で」「Task N と同じ」は無い。コードの段はすべて完全なコード
- 名前の一致：`ledger.getDest` / `ledger.setDest(state, no, sha256, dest, value, nowMs)` / `ledger.destKey` / `ledger.DEST_STATES`（Task 2）を Task 3・4 で同じ名前・同じ引数順で使う。`deliveryText(entry, link, ttlSec, groupState)`・`groupText(entry, link, ttlSec)`・`replyFields(b)`・`wantsGroup(entry)`・`replyUnknown(entry)`・`sendGroup(entry, dv)` は Task 3 で定義し Task 4 で同じ名前を使う。テストの `GID`・`GROUP`・`LINE_SENT`・`LINE_FAILED`・`LINE_UNKNOWN`・`LINE_NOREPLY`・`lastLine`・`destOf`・`s.pushStat`・`s.pushed`・`s.pushFail`・`s.lineDest`・`s.events` は Task 3 で定義し Task 4 で使う。`failingLedger`・`seed` は既存（`test/jobs-deliver.test.js:280-295`・`:687-692`）
- 宛先の名前は `"group"` と `"secretary"` だけ（`ledger.js` の `DESTS` と `DEST_KEY_RE`）
