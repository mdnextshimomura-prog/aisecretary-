# グループからの帯替え P1：portal の受付口 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** portal（`apps/reins-report`）に、MD NEXT秘書が LINE のグループで頼まれた帯替えを1回の呼び出しで受け付ける `POST /api/jobs/intake` を作り、Job に返し先（`replyKind`・`replyGroupId`）を持たせて納品の予約（claim）で返し、`OBI_BUSY` に `busyJobNo` を足す。

**Architecture:** 依頼の作成と全部の入力（PDF）の確定を1つの DB トランザクションにまとめる（`jobs.ts` の `createIntakeJob`）。PDF の検査と入力の確定は既存の `addInputs` から共通の部品（`checkInputFiles`・`commitInputsTx`）に切り出し、`/inputs` は今の動きのまま使う。受付が置くファイルは名前の頭 `intake-` で区別し、毎分の見回り（`prep-tick`）で「1時間たって参照の無いもの」だけを消す。

**Tech Stack:** Next.js 15 App Router（route handler）・Prisma 5（SQLite 開発／Postgres 本番、`db push` 運用）・vitest 4（実 Prisma を `prisma/test.db` に向けて直列実行）・TypeScript。

**Spec:** `apps/aisecretary/docs/superpowers/specs/2026-10-09-group-obi-intake-design.md`（決めたこと 10・12・15・16 と「影響する所 › portal」）。受け渡しの形：`apps/aisecretary/docs/superpowers/plans/2026-10-09-group-obi-contract.md`（食い違えば設計書が正）。

**実装の場所：** `/Users/shimo/AI開発/apps/reins-report/.claude/worktrees/group-obi-portal`（ブランチ `feat/group-obi-intake`、`origin/main`＝`5c76617` から作る）。以下のパスはすべてこの worktree の中の相対パス。

## Global Constraints

- 合計の上限：**25,000,000 バイト（10進）**。件数：**1〜20**。1件：40MiB（既存の `INPUT_LIMITS.eachBytes`）
- 本文の読み取りの上限：**25,000,000 + 1,048,576 バイト**（既存の約101MiB の上限 `MAX_INPUT_BODY_BYTES` は使わない）
- groupId の形：`^C[0-9a-f]{32}$`。`replyKind` は `'secretary'`（`replyGroupId` は null）と `'line-group'`（`replyGroupId` は groupId の形必須）の2通りだけ。検査は `src/lib/job-reply.ts` の `parseReplyTarget` の1か所
- 外向きのエラー（`{ code, message, busyJobNo? }`）：`UNAUTHORIZED` 401／`INVALID_REQUEST` 400（項目の形・`%PDF-` でない・件数0か21以上）／`INPUT_TOO_LARGE` 413／`INTAKE_DUPLICATE` 400／`INTAKE_MISMATCH` 409／`OBI_BUSY` 409＋`busyJobNo`／`INTAKE_STOPPED` 503／`INTERNAL` 500
- 成功：201（新しく作った）／200（同じ `lineMessageId` の照合が一致）で `{ no, status, created, inputs: [{ name, sha256, size }] }`（`inputs` は送られた順）
- 既存の `POST /api/jobs`・`POST /api/jobs/{no}/inputs` の動きは変えない（`POST /api/jobs` の `OBI_BUSY` 応答に `busyJobNo` を足すことだけ）
- 照合（`INTAKE_MISMATCH` の判定）：workflow・PDF の件数と sha256 の集合・`replyKind`・`replyGroupId`・物件名がすべて一致したときだけ既存の結果を返す
- `JobEvent` を作るのは `src/lib/jobs.ts` の `recordEvent` だけ（`test/jobs.test.ts` がソースを検索して確かめている）。受付の確定は `jobs.ts` の中に書く
- モデルの変更は `prisma/schema.prisma` だけ（`schema.prod.prisma` は生成物）。この repo はマイグレーションではなく `db push` 運用。**開発用 `dev.db` への `db push`（`npm run setup` など）はしない**（テストは `test/global-setup.ts` が `prisma/test.db` に push する）。本番の列の追加は `start:web` の `db push` で起きるので、push・Railway への反映は下村さんの承認の後（この計画には含めない）
- テストは `prisma/test.db` を共有する。**vitest を同時に2つ起動しない**（`vitest.config.ts` の `fileParallelism: false`）
- 環境変数の追加はない（鍵は既存の `JOB_API_TOKEN`）。`.env*` は開かない・書かない
- 帯替えの既存の判定ロジック（自動検出・学習・下準備の中身）は変えない
- コメント・メッセージは日本語。コミットは `type: 日本語` と本文1〜3行、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。push はしない

---

## ファイルの地図

| ファイル | 役割 | 変更 |
|---|---|---|
| `prisma/schema.prisma` | Job に `replyKind`・`replyGroupId` | 変更（Task 1） |
| `src/lib/job-reply.ts` | 返し先の形の検査（1か所）と、保存済みの値の読み方 | 新規（Task 1） |
| `src/app/api/jobs/[no]/delivery/claim/route.ts` | claim の応答に返し先を足す | 変更（Task 1） |
| `src/lib/jobs.ts` | `JobError.busyJobNo`、取り込み中の確認の共通化、入力の検査・確定の共通部品、`createIntakeJob`、`sweepIntakeOrphans` | 変更（Task 2〜5） |
| `src/lib/job-http.ts` | `busyJobNo` を本文に出す、新しいエラーの種類、本文上限の文言を引数に、`MAX_INTAKE_BODY_BYTES` | 変更（Task 2・3・4・6） |
| `src/lib/storage.ts` | 名前の頭つきの保存、頭で引く一覧 | 変更（Task 4・5） |
| `src/app/api/jobs/prep-tick/route.ts` | 見回りのたびに受付の残りファイルを掃除 | 変更（Task 5） |
| `src/app/api/jobs/intake/route.ts` | `POST /api/jobs/intake` | 新規（Task 6） |
| `test/job-reply.test.ts` | 返し先の検査 | 新規（Task 1） |
| `test/job-api.test.ts` | claim の応答の返し先 | 追記（Task 1） |
| `test/job-api-obi.test.ts` | `POST /api/jobs` の `busyJobNo`、prep-tick の掃除 | 追記（Task 2・5） |
| `test/job-inputs-check.test.ts` | `checkInputFiles`（`/inputs` と `/intake` の決まり） | 新規（Task 3） |
| `test/job-intake.test.ts` | `createIntakeJob` の確定の順番・照合・同時・失敗、`sweepIntakeOrphans` | 新規（Task 4・5） |
| `test/job-api-intake.test.ts` | `POST /api/jobs/intake` の HTTP の形 | 新規（Task 6） |
| `progress.md` | この計画で決めたこと（設計書の曖昧な所の判断） | 追記（Task 7） |

---

### Task 1: Job の返し先（replyKind・replyGroupId）と claim の応答

**Files:**
- Modify: `prisma/schema.prisma:489-493`（`ackAt` の行の後、`inputs JobInput[]` の前に2列）
- Create: `src/lib/job-reply.ts`
- Modify: `src/app/api/jobs/[no]/delivery/claim/route.ts:1-5`（import）、`:27-36`（応答）
- Test: `test/job-reply.test.ts`（新規）、`test/job-api.test.ts`（511行目の後に describe を追記）

**Interfaces:**
- Consumes: なし
- Produces:
  - Prisma `Job.replyKind: string`（既定 `'secretary'`）、`Job.replyGroupId: string | null`
  - `src/lib/job-reply.ts`：`export type ReplyTarget = { kind: 'secretary'; groupId: null } | { kind: 'line-group'; groupId: string }`、`export function parseReplyTarget(kind: unknown, groupId: unknown): ReplyTarget | null`、`export function replyTargetOf(job: { replyKind: string; replyGroupId: string | null }): ReplyTarget`
  - claim の応答に `replyKind: 'secretary' | 'line-group'`、`replyGroupId: string | null`

- [ ] **Step 1: 作業用の worktree を作り、依存を入れる（依存の追加ではなく、lock どおりの導入）**

```bash
cd /Users/shimo/AI開発/apps/reins-report
git fetch origin
git worktree add .claude/worktrees/group-obi-portal -b feat/group-obi-intake origin/main
cd .claude/worktrees/group-obi-portal
npm ci
npx prisma generate
```

Expected: `npm ci` と `prisma generate` が成功（`Generated Prisma Client`）。`.env*` は作らない・開かない。

- [ ] **Step 2: 返し先の検査のテストを書く（失敗する）**

`test/job-reply.test.ts`：

```ts
// 完成リンクの返し先（設計書 決めたこと 16）。組み合わせを決めるのは parseReplyTarget の1か所だけ。
import { describe, it, expect } from 'vitest';
import { parseReplyTarget, replyTargetOf } from '@/lib/job-reply';

const G = 'C' + '0123456789abcdef'.repeat(2);

describe('parseReplyTarget', () => {
  it('secretary＋空、line-group＋正しい groupId の2通りだけを通す', () => {
    expect(parseReplyTarget('secretary', undefined)).toEqual({ kind: 'secretary', groupId: null });
    expect(parseReplyTarget('secretary', null)).toEqual({ kind: 'secretary', groupId: null });
    expect(parseReplyTarget('secretary', '')).toEqual({ kind: 'secretary', groupId: null });
    expect(parseReplyTarget('line-group', G)).toEqual({ kind: 'line-group', groupId: G });
  });

  it('それ以外の組み合わせ・形の違う値は null', () => {
    const cases: [unknown, unknown][] = [
      ['secretary', G],
      ['line-group', undefined],
      ['line-group', null],
      ['line-group', ''],
      ['line-group', G.toUpperCase()],
      ['line-group', 'U' + G.slice(1)],
      ['line-group', G + '0'],
      ['line-group', G.slice(0, -1)],
      ['line-group', ` ${G}`],
      ['line-group', 123],
      ['LINE-GROUP', G],
      ['group', G],
      ['', null],
      [undefined, undefined],
      [null, null],
    ];
    for (const [kind, groupId] of cases) expect(parseReplyTarget(kind, groupId)).toBeNull();
  });
});

describe('replyTargetOf', () => {
  it('保存済みの値をそのまま読む', () => {
    expect(replyTargetOf({ replyKind: 'secretary', replyGroupId: null })).toEqual({ kind: 'secretary', groupId: null });
    expect(replyTargetOf({ replyKind: 'line-group', replyGroupId: G })).toEqual({ kind: 'line-group', groupId: G });
  });

  it('組み合わせが崩れていたら秘書室あてに倒す（グループへ誤って送らない）', () => {
    expect(replyTargetOf({ replyKind: 'line-group', replyGroupId: null })).toEqual({ kind: 'secretary', groupId: null });
    expect(replyTargetOf({ replyKind: 'line-group', replyGroupId: 'C123' })).toEqual({ kind: 'secretary', groupId: null });
    expect(replyTargetOf({ replyKind: 'other', replyGroupId: null })).toEqual({ kind: 'secretary', groupId: null });
  });
});
```

- [ ] **Step 3: 失敗を確かめる**

Run: `npx vitest run test/job-reply.test.ts`
Expected: FAIL（`Failed to resolve import "@/lib/job-reply"`）

- [ ] **Step 4: 検査を実装する**

`src/lib/job-reply.ts`：

```ts
// 完成リンクの返し先（設計書 2026-10-09 決めたこと 16）。
// 'secretary'：秘書室（既定・今まで）／'line-group'：LINE のグループ（groupId を持つ）。
// 組み合わせを決めるのはこのファイルだけ（受付の入口と納品の予約の応答の両方がここを通す）。

export const REPLY_KINDS = ['secretary', 'line-group'] as const;

export type ReplyTarget = { kind: 'secretary'; groupId: null } | { kind: 'line-group'; groupId: string };

// LINE の groupId の形（閲覧ページの在籍確認と同じ）
const GROUP_ID = /^C[0-9a-f]{32}$/;

/**
 * 返し先の形を確かめる。secretary＋空（undefined・null・''）、line-group＋正しい groupId の2通りだけを通し、
 * それ以外は null（呼ぶ側が 400 にする）
 */
export function parseReplyTarget(kind: unknown, groupId: unknown): ReplyTarget | null {
  const g = groupId === undefined || groupId === null || groupId === '' ? null : groupId;
  if (kind === 'secretary') return g === null ? { kind: 'secretary', groupId: null } : null;
  if (kind === 'line-group') return typeof g === 'string' && GROUP_ID.test(g) ? { kind: 'line-group', groupId: g } : null;
  return null;
}

/** 保存済みの依頼の返し先。万一組み合わせが崩れていたら秘書室あて（今までどおり）に倒す */
export function replyTargetOf(job: { replyKind: string; replyGroupId: string | null }): ReplyTarget {
  return parseReplyTarget(job.replyKind, job.replyGroupId) ?? { kind: 'secretary', groupId: null };
}
```

- [ ] **Step 5: 検査のテストが通るのを確かめる**

Run: `npx vitest run test/job-reply.test.ts`
Expected: PASS（4件）

- [ ] **Step 6: claim の応答のテストを追記する（失敗する）**

`test/job-api.test.ts` の末尾（511行目の `});` の後）に追記：

```ts

describe('納品の予約（claim）の応答の返し先（replyKind・replyGroupId）', () => {
  const G = 'C' + '0123456789abcdef'.repeat(2);
  const claimOf = async (no: number) => (await api.claim.POST(json(`/api/jobs/${no}/delivery/claim`, 'POST'), params(no))).json();

  it('今までの依頼（POST /api/jobs）は secretary と null。既定の値で作られる', async () => {
    const no = await completedJob('reply-legacy');
    expect(await prisma.job.findUnique({ where: { no } })).toMatchObject({ replyKind: 'secretary', replyGroupId: null });
    expect(await claimOf(no)).toMatchObject({ no, status: '納品中', replyKind: 'secretary', replyGroupId: null });
  });

  it('グループあての依頼は line-group と groupId を返す（既存の項目は変えない）', async () => {
    const no = await completedJob('reply-group');
    await prisma.job.update({ where: { no }, data: { replyKind: 'line-group', replyGroupId: G } });
    const c = await claimOf(no);
    expect(c).toMatchObject({ no, status: '納品中', artifactName: 'a.pdf', replyKind: 'line-group', replyGroupId: G });
    expect(c.claimId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof c.reviewPages).toBe('number');
  });

  it('保存された組み合わせが崩れていたら、秘書室あて（secretary・null）で返す', async () => {
    const no = await completedJob('reply-broken');
    await prisma.job.update({ where: { no }, data: { replyKind: 'line-group', replyGroupId: null } });
    expect(await claimOf(no)).toMatchObject({ replyKind: 'secretary', replyGroupId: null });
  });
});
```

- [ ] **Step 7: 失敗を確かめる**

Run: `npx vitest run test/job-api.test.ts`
Expected: FAIL（新しい3件。`Unknown argument \`replyKind\`` または `replyKind` が応答に無い）。既存の件は PASS のまま

- [ ] **Step 8: スキーマに2列を足し、Prisma Client を作り直す**

`prisma/schema.prisma` の `ackAt           DateTime?`（492行目）の直後、`inputs          JobInput[]` の前に挿入：

```prisma
  // 完成リンクの返し先（組み合わせは src/lib/job-reply.ts の parseReplyTarget だけが決める）。
  // secretary：秘書室（既定・今まで）／line-group：LINE のグループ（replyGroupId に groupId）
  replyKind       String    @default("secretary")
  replyGroupId    String?
```

Run: `npx prisma generate`
Expected: `Generated Prisma Client`（`dev.db` には push しない）

- [ ] **Step 9: claim の応答に返し先を足す**

`src/app/api/jobs/[no]/delivery/claim/route.ts` の import に1行足す（5行目の `countReviewPages` の import の後）：

```ts
import { replyTargetOf } from '@/lib/job-reply';
```

27〜36行目（`const { job, claimId } = await claimDelivery(...)` から `});` まで）を次に置き換える：

```ts
    const { job, claimId } = await claimDelivery(parseNo((await ctx.params).no));
    // 返し先は一覧ではなくここ（納品のときの正本の値）で返す。崩れた値は秘書室あてに倒す
    const reply = replyTargetOf(job);
    return NextResponse.json({
      no: job.no,
      status: job.status,
      claimId,
      artifactName: job.artifactName,
      artifactSha256: job.artifactSha256,
      leaseUntil: job.deliveryLeaseUntil,
      reviewPages: reviewPages(job),
      replyKind: reply.kind,
      replyGroupId: reply.groupId,
    });
```

- [ ] **Step 10: 通るのを確かめる**

Run: `npx vitest run test/job-reply.test.ts test/job-api.test.ts`
Expected: PASS（全件）

Run: `npx tsc --noEmit`
Expected: エラー0

- [ ] **Step 11: コミット**

```bash
git add prisma/schema.prisma src/lib/job-reply.ts "src/app/api/jobs/[no]/delivery/claim/route.ts" test/job-reply.test.ts test/job-api.test.ts
git commit -m "$(cat <<'EOF'
feat: 依頼に完成リンクの返し先を持たせ、納品の予約の応答で返す

グループからの帯替えで、完成リンクをグループにも返すため。組み合わせは job-reply.ts の1か所で決め、
今までの依頼は secretary・null のまま。崩れた値は秘書室あてに倒す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: OBI_BUSY に処理中の番号 busyJobNo を足す

**Files:**
- Modify: `src/lib/jobs.ts:26-33`（`JobError`）、`:156-210`（取り込み中の確認を `findObiBusy`・`obiBusyError` に分け、`createObiJob` から使う）
- Modify: `src/lib/job-http.ts:24-33`（`jobErrorResponse`）
- Test: `test/job-api-obi.test.ts:667`（`describe('POST /api/jobs：帯替えの取り込みは同時に1件だけ（OBI_BUSY）'` の最後の `it` の後に追記）

**Interfaces:**
- Consumes: なし
- Produces:
  - `JobError.busyJobNo?: number`、コンストラクタ `new JobError(code, message, { reason?, busyJobNo? })`
  - `jobs.ts` 内（非公開）：`findObiBusy(tx: Prisma.TransactionClient): Promise<{ no: number } | null>`、`obiBusyError(no: number): JobError`
  - 外向き：`OBI_BUSY` の本文に `busyJobNo: number`

- [ ] **Step 1: テストを追記する（失敗する）**

`test/job-api-obi.test.ts` の「同時2本の登録は1本だけ成功し、もう1本は OBI_BUSY」の `it(...)` の閉じ（667行目 `  });`）の直後、describe の閉じ（668行目 `});`）の前に追記：

```ts

  it('OBI_BUSY の本文に処理中の依頼番号 busyJobNo を足す（code・message は今のまま）', async () => {
    const first = (await register('busyno-1')).body.no as number;
    const { res, body } = await register('busyno-2');
    expect(res.status).toBe(409);
    expect(body).toEqual({
      code: 'OBI_BUSY',
      message: `帯替えの依頼 #J${first} を取り込み中です。終わってから送ってください`,
      busyJobNo: first,
    });
  });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run test/job-api-obi.test.ts -t "busyJobNo"`
Expected: FAIL（`busyJobNo` が本文に無い）

- [ ] **Step 3: JobError に busyJobNo を足す**

`src/lib/jobs.ts:26-33` を置き換える：

```ts
export class JobError extends Error {
  /** 関門の拒否（code 'gate'）のときだけ入る機械可読の理由（job-gate の GateReason） */
  public reason?: string;
  /** 帯替えの取り込み中（code 'obi_busy'）のときだけ入る、処理中の依頼番号 */
  public busyJobNo?: number;
  constructor(public code: JobErrorCode, message: string, opts: { reason?: string; busyJobNo?: number } = {}) {
    super(message);
    if (opts.reason !== undefined) this.reason = opts.reason;
    if (opts.busyJobNo !== undefined) this.busyJobNo = opts.busyJobNo;
  }
}
```

- [ ] **Step 4: 取り込み中の確認を共通にし、createObiJob から使う**

`src/lib/jobs.ts` の `ensureLockRow`（162行目）の直前に足す：

```ts
// 取り込み中の帯替え（いちばん古いもの）。確認と作成を直列にするため、確定のトランザクションの中で呼ぶ
async function findObiBusy(tx: Prisma.TransactionClient): Promise<{ no: number } | null> {
  return tx.job.findFirst({
    where: { workflow: 'obi', status: { in: [...OBI_INTAKE_BUSY] } },
    orderBy: { no: 'asc' },
    select: { no: true },
  });
}

// 取り込み中で断るときのエラー。送り手が「前の帯替え（#J11）」と書けるように番号を持たせる
function obiBusyError(no: number): JobError {
  return new JobError('obi_busy', `帯替えの依頼 #J${no} を取り込み中です。終わってから送ってください`, { busyJobNo: no });
}
```

`createObiJob` のトランザクションの中（190〜197行目）を置き換える：

```ts
        const busy = await findObiBusy(tx);
        if (busy) throw obiBusyError(busy.no);
```

- [ ] **Step 5: 本文に busyJobNo を出す**

`src/lib/job-http.ts:24-33` を置き換える：

```ts
export function jobErrorResponse(e: unknown): NextResponse {
  if (e instanceof JobError) {
    const o = OUTWARD[e.code];
    // 関門の拒否には機械可読の理由（residue / needs_review / untested / line_not_allowed）、
    // 帯替えの取り込み中には処理中の依頼番号（busyJobNo）を足す。code / message は変えない
    const body: Record<string, unknown> = { code: o.code, message: e.message };
    if (e.reason !== undefined) body.reason = e.reason;
    if (e.busyJobNo !== undefined) body.busyJobNo = e.busyJobNo;
    return NextResponse.json(body, { status: o.status });
  }
  console.error('job api error:', e);
  return NextResponse.json({ code: 'INTERNAL', message: '処理に失敗しました' }, { status: 500 });
}
```

- [ ] **Step 6: 通るのを確かめる（既存の動きも）**

Run: `npx vitest run test/job-api-obi.test.ts test/job-api.test.ts test/jobs.test.ts`
Expected: PASS（全件。既存の OBI_BUSY・関門の reason の件もそのまま）

- [ ] **Step 7: コミット**

```bash
git add src/lib/jobs.ts src/lib/job-http.ts test/job-api-obi.test.ts
git commit -m "$(cat <<'EOF'
feat: 帯替えの取り込み中（OBI_BUSY）の応答に処理中の番号 busyJobNo を足す

グループへの返事に「前の帯替え（#J11）」と書けるようにするため。取り込み中の確認は
findObiBusy・obiBusyError に分け、受付の入口からも同じものを使う。code・message は変えない。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 入力の検査と確定を共通の部品に分ける（/inputs の動きは変えない）

**Files:**
- Modify: `src/lib/jobs.ts:12-24`（`JobErrorCode` に `'intake_duplicate'`）、`:526`（`InputManifest` の後に検査の部品）、`:535-536`（`BatchLost` の後に確定の部品）、`:543-642`（`addInputs` を部品で書き直す）
- Modify: `src/lib/job-http.ts:9-22`（`OUTWARD` に `intake_duplicate`）
- Test: `test/job-inputs-check.test.ts`（新規）。回帰：`test/job-api-obi.test.ts`・`test/obi-prep.test.ts`・`test/jobs.test.ts`

**Interfaces:**
- Consumes: Task 2 の `JobError`
- Produces（`src/lib/jobs.ts` から export）：
  - `type CheckedInput = { name: string; data: Buffer; sha256: string }`
  - `type InputRule = { files: number; eachBytes: number; totalBytes: number; totalText: string; tooMany: 'too_large' | 'invalid'; duplicates: 'merge' | 'reject' }`
  - `const ADD_INPUTS_RULE: InputRule`（`/inputs` の今の決まり）
  - `const INTAKE_LIMITS = { files: 20, eachBytes: 41943040, totalBytes: 25_000_000 }`、`const INTAKE_TOTAL_TEXT: string`、`const INTAKE_RULE: InputRule`
  - `function checkInputFiles(files: { name: string; data: Buffer }[], rule: InputRule): CheckedInput[]`
  - 非公開：`commitInputsTx(tx: Prisma.TransactionClient, job: Job, batch: string, inputs: CheckedInput[], keys: string[], by: string): Promise<Job>`（CAS に負けたら `BatchLost`）
  - `JobErrorCode` に `'intake_duplicate'`（外向き `INTAKE_DUPLICATE` 400）

- [ ] **Step 1: 検査の部品のテストを書く（失敗する）**

`test/job-inputs-check.test.ts`：

```ts
// 入力（PDF）の検査の共通部品（設計書 2026-10-09 決めたこと 12 の 1）。
// /inputs（秘書室）は今の動き（同じ中身は黙って1つにまとめる・21件は 413）のまま、
// /intake（グループ）は同じ中身を断り（まとめるのは送り手）、件数の超過は 400・合計は 25,000,000 バイトまで。
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('@/lib/db', () => {
  const { PrismaClient } = require('@prisma/client');
  return {
    prisma: new PrismaClient({ datasources: { db: { url: `file:${process.cwd()}/prisma/test.db` } } }),
  };
});

import { ADD_INPUTS_RULE, checkInputFiles, EACH_LIMIT_TEXT, INTAKE_LIMITS, INTAKE_RULE, INTAKE_TOTAL_TEXT, JobError } from '@/lib/jobs';

const pdf = (tag: string) => Buffer.from(`%PDF-1.4\n${tag}\n`, 'latin1');
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
// 先頭が %PDF- の、指定の大きさのバッファ（末尾の1バイトで中身を変える）
const sized = (n: number, tag: number) => {
  const b = Buffer.alloc(n);
  b.write('%PDF-1.4\n', 0, 'latin1');
  b[n - 1] = tag;
  return b;
};

function errorOf(fn: () => unknown): JobError {
  try {
    fn();
  } catch (e) {
    if (e instanceof JobError) return e;
    throw e;
  }
  throw new Error('投げられませんでした');
}

describe('checkInputFiles', () => {
  it('/inputs の決まり：同じ中身は先のものを残して黙って1つにまとめ、名前は保存用に整える', () => {
    const a = pdf('a');
    const b = pdf('b');
    const out = checkInputFiles(
      [
        { name: 'a/1.pdf', data: a },
        { name: 'b.pdf', data: b },
        { name: 'a2.pdf', data: Buffer.from(a) },
        { name: '', data: pdf('c') },
      ],
      ADD_INPUTS_RULE,
    );
    expect(out.map((o) => [o.name, o.sha256])).toEqual([
      ['a1.pdf', sha(a)],
      ['b.pdf', sha(b)],
      ['input.pdf', sha(pdf('c'))],
    ]);
  });

  it('/intake の決まり：同じ中身が2つあれば intake_duplicate で断る（まとめない）', () => {
    const a = pdf('a');
    const e = errorOf(() => checkInputFiles([{ name: 'a.pdf', data: a }, { name: 'a-copy.pdf', data: Buffer.from(a) }], INTAKE_RULE));
    expect(e.code).toBe('intake_duplicate');
    const ok = checkInputFiles([{ name: 'a.pdf', data: a }, { name: 'b.pdf', data: pdf('b') }], INTAKE_RULE);
    expect(ok.map((o) => o.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('件数：0件はどちらも invalid、21件は /inputs が too_large・/intake が invalid、20件は通る', () => {
    expect(errorOf(() => checkInputFiles([], ADD_INPUTS_RULE)).code).toBe('invalid');
    expect(errorOf(() => checkInputFiles([], INTAKE_RULE)).code).toBe('invalid');
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `${i}.pdf`, data: pdf(`n${i}`) }));
    expect(errorOf(() => checkInputFiles(many(21), ADD_INPUTS_RULE)).code).toBe('too_large');
    expect(errorOf(() => checkInputFiles(many(21), INTAKE_RULE)).code).toBe('invalid');
    expect(checkInputFiles(many(20), INTAKE_RULE)).toHaveLength(20);
  });

  it('合計：/intake は 25,000,000 バイトちょうどまで通し、1バイト超えたら too_large（文言に上限）', () => {
    expect(INTAKE_LIMITS.totalBytes).toBe(25_000_000);
    const exact = [{ name: 'a.pdf', data: sized(12_500_000, 1) }, { name: 'b.pdf', data: sized(12_500_000, 2) }];
    expect(checkInputFiles(exact, INTAKE_RULE)).toHaveLength(2);
    const over = [{ name: 'a.pdf', data: sized(12_500_001, 1) }, { name: 'b.pdf', data: sized(12_500_000, 2) }];
    const e = errorOf(() => checkInputFiles(over, INTAKE_RULE));
    expect(e.code).toBe('too_large');
    expect(e.message).toBe(INTAKE_TOTAL_TEXT);
    // /inputs は今のまま（100MB まで）なので同じものを通す
    expect(checkInputFiles(over, ADD_INPUTS_RULE)).toHaveLength(2);
  });

  it('1件 40MiB 超は too_large（EACH_LIMIT_TEXT）。合計の確認より先', () => {
    const big = [{ name: 'big.pdf', data: sized(40 * 1024 * 1024 + 1, 1) }];
    for (const rule of [ADD_INPUTS_RULE, INTAKE_RULE]) {
      const e = errorOf(() => checkInputFiles(big, rule));
      expect(e.code).toBe('too_large');
      expect(e.message).toBe(EACH_LIMIT_TEXT);
    }
  });

  it('%PDF- で始まらない・空のファイルは invalid', () => {
    for (const rule of [ADD_INPUTS_RULE, INTAKE_RULE]) {
      expect(errorOf(() => checkInputFiles([{ name: 'x.pdf', data: Buffer.from('not a pdf') }], rule)).code).toBe('invalid');
      expect(errorOf(() => checkInputFiles([{ name: 'x.pdf', data: Buffer.alloc(0) }], rule)).code).toBe('invalid');
    }
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run test/job-inputs-check.test.ts`
Expected: FAIL（`checkInputFiles` などが export されていない）

- [ ] **Step 3: エラーの種類を足す**

`src/lib/jobs.ts:12-24` の `JobErrorCode` の最後を次にする：

```ts
  | 'too_large'
  | 'obi_busy'
  // グループからの受付（POST /api/jobs/intake）で、同じ中身の PDF が2つ以上
  | 'intake_duplicate';
```

`src/lib/job-http.ts` の `OUTWARD`（21行目 `obi_busy` の行の後）に足す：

```ts
  intake_duplicate: { code: 'INTAKE_DUPLICATE', status: 400 },
```

- [ ] **Step 4: 検査の部品を足す**

`src/lib/jobs.ts:526`（`export type InputManifest = ...` の行）の直後に足す：

```ts

/** 検査を通った入力（名前は保存用に整えたもの） */
export type CheckedInput = { name: string; data: Buffer; sha256: string };

/** 入力の検査の決まり。/inputs（秘書室）と /intake（グループ）で、上限と「同じ中身」の扱いだけが違う */
export type InputRule = {
  files: number;
  eachBytes: number;
  totalBytes: number;
  // 合計の超過の文言（数字は totalBytes と合わせる）
  totalText: string;
  // 件数の超過の種類（/inputs は今どおり 413、/intake は受け渡しの約束で 400）
  tooMany: 'too_large' | 'invalid';
  // 同じ中身：merge は黙って1つにまとめる（/inputs の今の動き）、reject は intake_duplicate で断る（まとめるのは送り手）
  duplicates: 'merge' | 'reject';
};

/** /inputs（秘書室）の今の決まり */
export const ADD_INPUTS_RULE: InputRule = {
  ...INPUT_LIMITS,
  totalText: 'PDFは合計100MBまでです',
  tooMany: 'too_large',
  duplicates: 'merge',
};

/** グループからの受付（/intake）の上限。合計は10進の 25,000,000 バイト（MD NEXT秘書と同じ値） */
export const INTAKE_LIMITS = { files: 20, eachBytes: INPUT_LIMITS.eachBytes, totalBytes: 25_000_000 } as const;
export const INTAKE_TOTAL_TEXT = 'PDFは合計25,000,000バイト（25MB）までです';
export const INTAKE_RULE: InputRule = {
  ...INTAKE_LIMITS,
  totalText: INTAKE_TOTAL_TEXT,
  tooMany: 'invalid',
  duplicates: 'reject',
};

// 保存用の名前（パスに使えない文字を落とし、120文字まで。空なら input.pdf）
function safeInputName(name: unknown): string {
  return String(name ?? '').replace(/[\/\\:*?"<>|]/g, '').slice(0, 120) || 'input.pdf';
}

/**
 * 入力（PDF）の検査。件数 → 1件の大きさ → 合計 → %PDF- の順に見て、sha256 を出す（出た順のまま）。
 * 同じ中身は決まり（rule.duplicates）どおりにまとめるか断る。/inputs と /intake の共通の部品
 */
export function checkInputFiles(files: { name: string; data: Buffer }[], rule: InputRule): CheckedInput[] {
  if (!Array.isArray(files) || files.length === 0) throw new JobError('invalid', 'PDFがありません');
  if (files.length > rule.files) {
    throw new JobError(rule.tooMany, `PDFは1回に${rule.files}件までです（${files.length}件）`);
  }
  let total = 0;
  for (const f of files) {
    if (f.data.length > rule.eachBytes) throw new JobError('too_large', EACH_LIMIT_TEXT);
    total += f.data.length;
  }
  if (total > rule.totalBytes) throw new JobError('too_large', rule.totalText);
  for (const f of files) {
    if (f.data.length === 0 || f.data.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new JobError('invalid', 'PDFファイルではないものが含まれています');
    }
  }
  // 同じ中身は1回だけ（JobInput の一意制約と同じ）
  const seen = new Set<string>();
  const out: CheckedInput[] = [];
  for (const f of files) {
    const sha256 = crypto.createHash('sha256').update(f.data).digest('hex');
    if (seen.has(sha256)) {
      if (rule.duplicates === 'reject') throw new JobError('intake_duplicate', '同じ中身のPDFが2つ以上あります');
      continue;
    }
    seen.add(sha256);
    out.push({ name: safeInputName(f.name), data: f.data, sha256 });
  }
  return out;
}
```

- [ ] **Step 5: 確定の部品を足す**

`src/lib/jobs.ts` の `class BatchLost extends Error {}`（536行目）の直後に足す：

```ts

/**
 * 入力の確定（下準備中への遷移・全部の JobInput の作成・出来事の記録）。/inputs と /intake の共通の部品。
 * 必ず確定のトランザクション（tx）の中で呼ぶ。keys[i] は inputs[i] を保存したファイルの fileKey。
 * CAS：まだ入力を受け取っていない（inputBatchId が空）・入力を受けられる状態のときだけ。同時の2本は片方だけが勝つ（負けたら BatchLost）
 */
async function commitInputsTx(
  tx: Prisma.TransactionClient,
  job: Job,
  batch: string,
  inputs: CheckedInput[],
  keys: string[],
  by: string,
): Promise<Job> {
  const res = await tx.job.updateMany({
    where: { id: job.id, inputBatchId: '', status: { in: [...INPUT_READY] } },
    data: {
      inputBatchId: batch,
      status: '下準備中',
      statusChangedAt: new Date(),
      prepRunId: '',
      prepLeaseUntil: null,
      prepHeartbeatAt: null,
      prepAttempts: 0,
      prepNote: '',
    },
  });
  if (res.count !== 1) throw new BatchLost();
  for (let i = 0; i < inputs.length; i++) {
    await tx.jobInput.create({
      data: {
        jobId: job.id,
        batchId: batch,
        fileKey: keys[i],
        name: inputs[i].name,
        sha256: inputs[i].sha256,
        size: inputs[i].data.length,
      },
    });
  }
  const u = (await tx.job.findUnique({ where: { id: job.id } }))!;
  await recordEvent(u, '下準備中', by, { elapsedSec: (u.statusChangedAt.getTime() - job.statusChangedAt.getTime()) / 1000 }, tx);
  return u;
}
```

- [ ] **Step 6: addInputs を部品で書き直す（動きは同じ）**

`src/lib/jobs.ts` の `addInputs`（543〜642行目）全体を次に置き換える：

```ts
export async function addInputs(
  no: number,
  batchId: string,
  files: { name: string; data: Buffer }[],
  by: string,
): Promise<{ job: Job; manifest: InputManifest }> {
  const batch = String(batchId ?? '').trim();
  if (!batch || batch.length > 200) throw new JobError('invalid', '受け渡しの番号（batchId）がありません');
  const job = await getJob(no);
  if (!job) throw new JobError('not_found', `#J${no} が見つかりません`);
  if (job.workflow !== 'obi') throw new JobError('invalid', `#J${no} は帯替えの依頼ではありません`);

  const settled = async (current: Job) => {
    if (current.inputBatchId === batch) return { job: current, manifest: await manifestOf(current.id) };
    if (current.inputBatchId) throw new JobError('bad_transition', `#J${no} は別の入力をすでに受け取っています`);
    return null;
  };
  const same = await settled(job);
  if (same) return same;
  if (!INPUT_READY.includes(job.status)) {
    throw new JobError('bad_transition', `#J${no} は「${job.status}」なので入力を受け取れません`);
  }

  // 件数・大きさ・%PDF- の検査と、同じ中身を1つにまとめる（/inputs の今の決まり）
  const unique = checkInputFiles(files, ADD_INPUTS_RULE);

  const saved: string[] = [];
  try {
    for (const f of unique) saved.push(await saveFile(f.data, f.name));
    const updated = await prisma.$transaction((tx) => commitInputsTx(tx, job, batch, unique, saved, by));
    // 確定した。ここから先で失敗しても、DB の JobInput が指すファイルは消さない
    saved.length = 0;
    return { job: updated, manifest: await manifestOf(job.id) };
  } catch (e) {
    for (const k of saved) await deleteFile(k).catch(() => {}); // 確定しなかった分は残さない
    // 負けた側（または確定に失敗した側）は読み直して、勝った側と同じ結果を返す
    const current = await getJob(no);
    if (current) {
      const r = await settled(current);
      if (r) return r;
    }
    if (e instanceof BatchLost) {
      throw new JobError('bad_transition', `#J${no} は別の操作で状態が変わりました`);
    }
    throw e;
  }
}
```

- [ ] **Step 7: 通るのを確かめる（/inputs の動きが変わっていないことも）**

Run: `npx vitest run test/job-inputs-check.test.ts test/job-api-obi.test.ts test/obi-prep.test.ts test/jobs.test.ts`
Expected: PASS（全件。既存の `/inputs` の 413・同じ batchId・下準備の件はそのまま）

Run: `npx tsc --noEmit`
Expected: エラー0

- [ ] **Step 8: コミット**

```bash
git add src/lib/jobs.ts src/lib/job-http.ts test/job-inputs-check.test.ts
git commit -m "$(cat <<'EOF'
refactor: 帯替えの入力の検査と確定を共通の部品に分ける

グループからの受付でも同じ検査と確定を使うため。決まり（InputRule）で上限と同じ中身の扱いだけを変え、
/inputs は今の決まり（同じ中身はまとめる・21件は413・合計100MB）のまま。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 受付の確定（createIntakeJob）と照合

**Files:**
- Modify: `src/lib/storage.ts:15-21`（`saveFile` に名前の頭）、`INTAKE_PREFIX` を足す
- Modify: `src/lib/jobs.ts:3-10`（import）、`:12-24`（`JobErrorCode` に `'intake_mismatch'`）、`addInputs` の後（Task 3 で書き直した関数の閉じの後）に受付の節を足す
- Modify: `src/lib/job-http.ts`（`OUTWARD` に `intake_mismatch`）
- Test: `test/job-intake.test.ts`（新規）

**Interfaces:**
- Consumes: Task 1 の `parseReplyTarget`・`ReplyTarget`・Job の2列、Task 2 の `findObiBusy`・`obiBusyError`、Task 3 の `checkInputFiles`・`INTAKE_RULE`・`CheckedInput`・`commitInputsTx`
- Produces:
  - `src/lib/storage.ts`：`export const INTAKE_PREFIX = 'intake-'`、`saveFile(buffer: Buffer, originalName: string, opts?: { prefix?: string }): Promise<string>`
  - `src/lib/jobs.ts`：
    - `type IntakeRequest = { workflow?: string; lineMessageId?: string; property?: string; requestText?: string; requestedBy?: string; assigneeName?: string; replyKind?: string; replyGroupId?: string; files: { name: string; data: Buffer }[] }`
    - `type IntakeInput = { name: string; sha256: string; size: number }`
    - `type IntakeResult = { job: Job; created: boolean; inputs: IntakeInput[] }`
    - `async function createIntakeJob(input: IntakeRequest): Promise<IntakeResult>`
  - `JobErrorCode` に `'intake_mismatch'`（外向き `INTAKE_MISMATCH` 409）

- [ ] **Step 1: 確定の順番のテストを書く（失敗する）**

`test/job-intake.test.ts`：

```ts
// グループからの帯替えの受付（createIntakeJob）の確定の順番（設計書 2026-10-09 決めたこと 12）。
//
// ここで守りたいこと：
//   ・1回の呼び出しで、依頼の作成と全部の入力の確定が1つのトランザクション（DB が失敗したら依頼もファイルも残らない）
//   ・同じ lineMessageId の再送・同時の2本は、照合して同じ結果（ファイルは増えない）。中身が違えば intake_mismatch
//   ・受付停止・取り込み中（busyJobNo つき）・同じ中身の PDF は、依頼もファイルも残さない
//   ・置くファイルは受付専用の名前の頭（intake-）
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';

vi.mock('@/lib/db', () => {
  const { PrismaClient } = require('@prisma/client');
  return {
    prisma: new PrismaClient({ datasources: { db: { url: `file:${process.cwd()}/prisma/test.db` } } }),
  };
});

import { prisma } from '@/lib/db';
import type { IntakeRequest, IntakeResult } from '@/lib/jobs';

// storage.ts は読み込んだときに置き場を決めるので、jobs.ts は置き場を決めてから読み込む
const storageDir = mkdtempSync(path.join(tmpdir(), 'jobintake-'));
process.env.DOCUMENT_STORAGE_DIR = storageDir;

let jobs: typeof import('@/lib/jobs');
beforeAll(async () => {
  jobs = await import('@/lib/jobs');
});

const G = 'C' + '0123456789abcdef'.repeat(2);
const pdf = (tag: string) => Buffer.from(`%PDF-1.4\n${tag}\n%%EOF\n`, 'latin1');
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const files = async () => (await readdir(storageDir)).sort();

function request(over: Partial<IntakeRequest> = {}): IntakeRequest {
  return {
    workflow: 'obi',
    lineMessageId: '700000000001',
    property: 'テスト物件',
    requestText: '帯替え テスト物件',
    requestedBy: 'テスト',
    replyKind: 'line-group',
    replyGroupId: G,
    files: [
      { name: 'a.pdf', data: pdf('a') },
      { name: 'b.pdf', data: pdf('b') },
    ],
    ...over,
  };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof jobs.JobError ? e.code : `other:${e instanceof Error ? e.message : String(e)}`;
  }
}

async function clearAll() {
  for (const f of await readdir(storageDir)) await rm(path.join(storageDir, f), { force: true });
  await prisma.jobEvent.deleteMany();
  await prisma.jobInput.deleteMany();
  await prisma.job.deleteMany();
  await prisma.appState.deleteMany({ where: { key: { in: ['jobs.intake.stopped', 'jobs.obi.intake'] } } });
}

beforeEach(clearAll);

describe('createIntakeJob', () => {
  it('依頼と全部の入力を1回で確定し、下準備中にする。返し先・出来事・受付専用の名前の頭', async () => {
    const r = await jobs.createIntakeJob(request());
    expect(r.created).toBe(true);
    expect(r.job).toMatchObject({
      workflow: 'obi',
      status: '下準備中',
      property: 'テスト物件',
      requestText: '帯替え テスト物件',
      requestedBy: 'テスト',
      replyKind: 'line-group',
      replyGroupId: G,
      inputBatchId: 'intake-700000000001',
      assigneeId: null,
    });
    expect(r.inputs).toEqual([
      { name: 'a.pdf', sha256: sha(pdf('a')), size: pdf('a').length },
      { name: 'b.pdf', sha256: sha(pdf('b')), size: pdf('b').length },
    ]);
    const rows = await prisma.jobInput.findMany({ where: { jobId: r.job.id }, orderBy: { id: 'asc' } });
    expect(rows.every((x) => x.fileKey.startsWith('intake-'))).toBe(true);
    expect(await files()).toEqual(rows.map((x) => x.fileKey).sort());
    const ev = await prisma.jobEvent.findMany({ where: { jobId: r.job.id }, orderBy: { id: 'asc' } });
    expect(ev.map((e) => [e.type, e.actor])).toEqual([
      ['受付', 'aisecretary'],
      ['下準備中', 'aisecretary'],
    ]);
  });

  it('秘書室あて（secretary）は replyGroupId を null で持つ', async () => {
    const r = await jobs.createIntakeJob(request({ replyKind: 'secretary', replyGroupId: undefined }));
    expect(r.job).toMatchObject({ replyKind: 'secretary', replyGroupId: null });
  });

  it('確定の後の再送（応答が届かなかった場合）は照合して同じ結果。ファイルは増えず、停止中・取り込み中でも返す', async () => {
    const a = await jobs.createIntakeJob(request());
    const before = await files();
    await jobs.setIntakeStopped(true);
    // 並びが違っても、集合が同じなら同じ依頼
    const b = await jobs.createIntakeJob(request({ files: [...request().files].reverse() }));
    expect(b.created).toBe(false);
    expect(b.job.no).toBe(a.job.no);
    expect(b.inputs).toEqual(a.inputs);
    expect(await files()).toEqual(before);
  });

  it('同じ lineMessageId で中身が違えば intake_mismatch（物件名・返し先・PDF の集合と件数）。ファイルは増えない', async () => {
    await jobs.createIntakeJob(request());
    const before = await files();
    const variants: Partial<IntakeRequest>[] = [
      { property: '別の物件' },
      { replyKind: 'secretary', replyGroupId: undefined },
      { replyGroupId: 'C' + 'f'.repeat(32) },
      { files: [{ name: 'a.pdf', data: pdf('a') }] },
      { files: [{ name: 'a.pdf', data: pdf('a') }, { name: 'c.pdf', data: pdf('c') }] },
      { files: [{ name: 'a.pdf', data: pdf('a') }, { name: 'b.pdf', data: pdf('b') }, { name: 'c.pdf', data: pdf('c') }] },
    ];
    for (const over of variants) expect(await codeOf(jobs.createIntakeJob(request(over)))).toBe('intake_mismatch');
    expect(await files()).toEqual(before);
  });

  it('秘書室の流れ（POST /api/jobs）で作った同じ lineMessageId の依頼とも照合し、違えば intake_mismatch', async () => {
    await jobs.createJob({ workflow: 'obi', lineMessageId: '700000000001' });
    expect(await codeOf(jobs.createIntakeJob(request()))).toBe('intake_mismatch');
    expect(await files()).toEqual([]);
  });

  it('項目の形が違えば invalid で、依頼もファイルも残さない', async () => {
    const cases: Partial<IntakeRequest>[] = [
      { workflow: undefined },
      { workflow: 'satei' },
      { lineMessageId: '' },
      { lineMessageId: 'abc' },
      { lineMessageId: '1'.repeat(65) },
      { property: '' },
      { property: '   ' },
      { property: 'あ'.repeat(101) },
      { requestText: 'あ'.repeat(1001) },
      { requestedBy: 'あ'.repeat(61) },
      { assigneeName: 'あ'.repeat(61) },
      { replyKind: undefined },
      { replyKind: 'group' },
      { replyKind: 'secretary' }, // groupId があるのに secretary
      { replyGroupId: undefined },
      { replyGroupId: 'C123' },
      { files: [] },
    ];
    for (const over of cases) expect(await codeOf(jobs.createIntakeJob(request(over)))).toBe('invalid');
    expect(await prisma.job.count()).toBe(0);
    expect(await files()).toEqual([]);
  });

  it('同じ中身の PDF が2つあれば intake_duplicate で、依頼もファイルも残さない', async () => {
    const dup = request({ files: [{ name: 'a.pdf', data: pdf('a') }, { name: 'a2.pdf', data: pdf('a') }] });
    expect(await codeOf(jobs.createIntakeJob(dup))).toBe('intake_duplicate');
    expect(await prisma.job.count()).toBe(0);
    expect(await files()).toEqual([]);
  });

  it('受付停止中は stopped で、依頼もファイルも残さない', async () => {
    await jobs.setIntakeStopped(true);
    expect(await codeOf(jobs.createIntakeJob(request()))).toBe('stopped');
    expect(await prisma.job.count()).toBe(0);
    expect(await files()).toEqual([]);
  });

  it('取り込み中の帯替えがあれば obi_busy と busyJobNo。依頼もファイルも残さない', async () => {
    const first = await jobs.createJob({ workflow: 'obi', lineMessageId: 'old-1' });
    let err: unknown;
    try {
      await jobs.createIntakeJob(request());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(jobs.JobError);
    expect((err as InstanceType<typeof jobs.JobError>).code).toBe('obi_busy');
    expect((err as InstanceType<typeof jobs.JobError>).busyJobNo).toBe(first.job.no);
    expect(await prisma.job.count()).toBe(1);
    expect(await files()).toEqual([]);
  });

  it('確定のトランザクションが失敗したら、依頼もこの呼び出しのファイルも残らない', async () => {
    const realTransaction = prisma.$transaction.bind(prisma) as (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => Promise<unknown>;
    const spy = vi.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      realTransaction(async (tx) => {
        vi.spyOn(tx.jobInput, 'create').mockRejectedValueOnce(new Error('入力の記録の失敗（テスト）'));
        return fn(tx);
      })) as never);
    try {
      await expect(jobs.createIntakeJob(request())).rejects.toThrow('入力の記録の失敗（テスト）');
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.job.count()).toBe(0);
    expect(await prisma.jobInput.count()).toBe(0);
    expect(await prisma.jobEvent.count()).toBe(0);
    expect(await files()).toEqual([]);
  });

  it('同じ依頼が同時に2本届いても、作るのは1件。もう1本は照合して同じ番号を返し、ファイルは1組だけ残る', async () => {
    for (let round = 0; round < 3; round++) {
      await clearAll();
      const id = `70000000010${round}`;
      const [a, b] = await Promise.all([
        jobs.createIntakeJob(request({ lineMessageId: id })),
        jobs.createIntakeJob(request({ lineMessageId: id })),
      ]);
      expect([a.created, b.created].sort()).toEqual([false, true]);
      expect(a.job.no).toBe(b.job.no);
      expect(a.inputs).toEqual(b.inputs);
      expect(await prisma.job.count()).toBe(1);
      expect(await prisma.jobInput.count()).toBe(2);
      expect((await files()).length).toBe(2);
    }
  });

  it('別の依頼が同時に2本届いたら、1本だけ通り、もう1本は obi_busy（busyJobNo は通った方）', async () => {
    const results = await Promise.allSettled([
      jobs.createIntakeJob(request({ lineMessageId: '700000000201' })),
      jobs.createIntakeJob(request({ lineMessageId: '700000000202' })),
    ]);
    const ok = results.filter((r): r is PromiseFulfilledResult<IntakeResult> => r.status === 'fulfilled');
    const ng = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(ng).toHaveLength(1);
    expect(ng[0].reason.code).toBe('obi_busy');
    expect(ng[0].reason.busyJobNo).toBe(ok[0].value.job.no);
    expect((await files()).length).toBe(2);
  });
});
```

（`utimes` は Task 5 で使う。ここで import しておく）

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run test/job-intake.test.ts`
Expected: FAIL（`jobs.createIntakeJob is not a function`）

- [ ] **Step 3: 保存に名前の頭を足す**

`src/lib/storage.ts:15-21` を置き換える：

```ts
// 帯替えの受付（POST /api/jobs/intake）が置くファイルの名前の頭。受付の残りの掃除はこの頭のファイルだけを見る
// （ほかの用途の名前は16進32桁で始まるので重ならない）。readFile・deleteFile は名前（basename）で引くので、置き場は同じにする
export const INTAKE_PREFIX = 'intake-';

export async function saveFile(buffer: Buffer, originalName: string, opts: { prefix?: string } = {}): Promise<string> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  const ext = path.extname(originalName) || '.pdf';
  const key = (opts.prefix ?? '') + crypto.randomBytes(16).toString('hex') + ext;
  await fs.writeFile(path.join(STORAGE_DIR, key), buffer);
  return key;
}
```

- [ ] **Step 4: エラーの種類を足す**

`src/lib/jobs.ts` の `JobErrorCode` の最後（Task 3 で足した `'intake_duplicate'`）を次にする：

```ts
  // グループからの受付（POST /api/jobs/intake）で、同じ中身の PDF が2つ以上
  | 'intake_duplicate'
  // グループからの受付で、同じ lineMessageId の依頼と中身が違う
  | 'intake_mismatch';
```

`src/lib/job-http.ts` の `OUTWARD`（`intake_duplicate` の行の後）に足す：

```ts
  intake_mismatch: { code: 'INTAKE_MISMATCH', status: 409 },
```

- [ ] **Step 5: import を足す**

`src/lib/jobs.ts:9` を置き換え、その後に1行足す：

```ts
import { saveFile, readFile, deleteFile, INTAKE_PREFIX } from './storage';
import { parseReplyTarget, type ReplyTarget } from './job-reply';
```

- [ ] **Step 6: 受付の確定と照合を足す**

`src/lib/jobs.ts` の `addInputs`（Task 3 で書き直したもの）の閉じ `}` の直後、`claimPrep` の説明コメントの前に足す：

```ts

// ---------- グループからの帯替えの受付（POST /api/jobs/intake。設計書 2026-10-09 決めたこと 12） ----------

/** 受付の出来事の actor（MD NEXT秘書。Discord には出さない） */
const INTAKE_ACTOR = 'aisecretary';

export type IntakeRequest = {
  workflow?: string;
  lineMessageId?: string;
  property?: string;
  requestText?: string;
  requestedBy?: string;
  assigneeName?: string;
  replyKind?: string;
  replyGroupId?: string;
  files: { name: string; data: Buffer }[];
};

export type IntakeInput = { name: string; sha256: string; size: number };
export type IntakeResult = { job: Job; created: boolean; inputs: IntakeInput[] };

type IntakeFields = {
  workflow: 'obi';
  lineMessageId: string;
  property: string;
  requestText: string;
  requestedBy: string;
  assigneeName: string;
  reply: ReplyTarget;
};

// 項目の形（受け渡しの約束のとおり）。合わなければ 400 INVALID_REQUEST。長すぎるものは切らずに断る
function parseIntakeFields(input: IntakeRequest): IntakeFields {
  const bad = (what: string) => new JobError('invalid', `${what} の形が正しくありません`);
  if (input.workflow !== 'obi') throw bad('workflow');
  const lineMessageId = String(input.lineMessageId ?? '');
  if (!/^\d{1,64}$/.test(lineMessageId)) throw bad('lineMessageId');
  const property = String(input.property ?? '').trim();
  if (property.length < 1 || property.length > 100) throw bad('property');
  const optional = (v: string | undefined, max: number, what: string) => {
    const s = String(v ?? '').trim();
    if (s.length > max) throw bad(what);
    return s;
  };
  const reply = parseReplyTarget(input.replyKind, input.replyGroupId);
  if (!reply) throw bad('replyKind・replyGroupId');
  return {
    workflow: 'obi',
    lineMessageId,
    property,
    requestText: optional(input.requestText, 1000, 'requestText'),
    requestedBy: optional(input.requestedBy, 60, 'requestedBy'),
    assigneeName: optional(input.assigneeName, 60, 'assigneeName'),
    reply,
  };
}

// 依頼に付いた入力（受け取った順＝JobInput の id 順）
async function intakeInputsOf(jobId: string): Promise<IntakeInput[]> {
  const rows = await prisma.jobInput.findMany({ where: { jobId }, orderBy: { id: 'asc' } });
  return rows.map((r) => ({ name: r.name, sha256: r.sha256, size: r.size }));
}

// 照合：同じ lineMessageId の依頼の workflow・PDF の件数と sha256 の集合・返し先・物件名が、
// 今回の呼び出しと全部同じときだけ、その依頼の結果を返す。1つでも違えば intake_mismatch
async function reconcileIntake(job: Job, f: IntakeFields, shas: string[]): Promise<IntakeResult> {
  const inputs = await intakeInputsOf(job.id);
  const have = new Set(inputs.map((i) => i.sha256));
  const same =
    job.workflow === f.workflow &&
    job.property === f.property &&
    job.replyKind === f.reply.kind &&
    (job.replyGroupId ?? null) === f.reply.groupId &&
    inputs.length === shas.length &&
    have.size === shas.length &&
    shas.every((s) => have.has(s));
  if (!same) throw new JobError('intake_mismatch', `同じLINEメッセージの依頼 #J${job.no} と中身が違います`);
  return { job, created: false, inputs };
}

/** 確定のトランザクションで、同じ lineMessageId の依頼が先に確定していた */
class IntakeRace extends Error {}

/**
 * 確定（1つのトランザクション）：帯替えの列に並ぶ（OBI のロックの行）→ 同じ依頼が先に確定していないか → 受付停止 →
 * 取り込み中の帯替え → 依頼の作成（受付）→ 全部の入力の確定（下準備中）。
 * 同じ依頼の確認を停止・取り込み中より先にするのは、確定の後に応答が届かなかった再送へ、停止中・取り込み中でも同じ結果を返すため
 */
async function commitIntake(data: Prisma.JobCreateInput, inputs: CheckedInput[], keys: string[], batch: string): Promise<Job> {
  await ensureLockRow(OBI_INTAKE_LOCK_KEY);
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.appState.update({ where: { key: OBI_INTAKE_LOCK_KEY }, data: { value: data.lineMessageId } });
        const dup = await tx.job.findUnique({ where: { lineMessageId: data.lineMessageId }, select: { no: true } });
        if (dup) throw new IntakeRace();
        const stopped = await tx.appState.findUnique({ where: { key: INTAKE_STOPPED_KEY } });
        if (stopped?.value === '1') throw new JobError('stopped', '現在受付を止めています');
        const busy = await findObiBusy(tx);
        if (busy) throw obiBusyError(busy.no);
        const created = await tx.job.create({ data });
        await recordEvent(created, '受付', INTAKE_ACTOR, {}, tx);
        return commitInputsTx(tx, created, batch, inputs, keys, INTAKE_ACTOR);
      });
    } catch (e) {
      if (attempt < 20 && isWriteConflict(e)) {
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 80));
        continue;
      }
      throw e;
    }
  }
}

/**
 * グループからの帯替えの受付を1回で行う（設計書 12 の 1〜7）。
 * 1. 項目の形と全部の PDF を検査し sha256 を出す（同じ中身は断る）
 * 2. 同じ lineMessageId の依頼がもうあれば照合して返す（ファイルは保存しない）
 * 3. PDF を受付専用の名前の頭で置く → 4. 1つのトランザクションで確定 → 5. 確定しなければこの呼び出しのファイルだけ消す
 * 7. 同じ依頼が同時に届いて先に確定していたら、読み直して照合に合流する
 * 下準備の起動（9）は呼ぶ側（route）が、新しく作ったときだけ行う
 */
export async function createIntakeJob(input: IntakeRequest): Promise<IntakeResult> {
  const f = parseIntakeFields(input);
  const checked = checkInputFiles(input.files, INTAKE_RULE);
  const shas = checked.map((c) => c.sha256);

  const existing = await prisma.job.findUnique({ where: { lineMessageId: f.lineMessageId } });
  if (existing) return reconcileIntake(existing, f, shas);

  const assignee = f.assigneeName ? await resolveAssignee(f.assigneeName) : null;
  if (f.assigneeName && !assignee) {
    throw new JobError('assignee_not_found', `担当「${f.assigneeName.slice(0, 30)}」が見つかりません。表示名を確認してください`);
  }
  const data: Prisma.JobCreateInput = {
    workflow: f.workflow,
    lineMessageId: f.lineMessageId,
    property: f.property,
    requestText: f.requestText,
    requestedBy: f.requestedBy,
    assigneeId: assignee?.id ?? null,
    assigneeName: assignee?.displayName ?? '',
    replyKind: f.reply.kind,
    replyGroupId: f.reply.groupId,
  };

  const keys: string[] = [];
  try {
    for (const c of checked) keys.push(await saveFile(c.data, c.name, { prefix: INTAKE_PREFIX }));
    const job = await commitIntake(data, checked, keys, `intake-${f.lineMessageId}`);
    // 確定した。ここから先で失敗しても、JobInput が指すファイルは消さない
    keys.length = 0;
    return { job, created: true, inputs: await intakeInputsOf(job.id) };
  } catch (e) {
    for (const k of keys) await deleteFile(k).catch(() => {}); // この呼び出しが置いた分だけ消す
    // 同じ依頼が先に確定していた（同時の2本・一意制約・取り込み中で負けた）ときは、読み直して照合に合流する
    if (e instanceof IntakeRace || isUniqueConstraintError(e, 'lineMessageId') || (e instanceof JobError && e.code === 'obi_busy')) {
      const race = await prisma.job.findUnique({ where: { lineMessageId: f.lineMessageId } });
      if (race) return reconcileIntake(race, f, shas);
    }
    if (e instanceof IntakeRace) throw new JobError('bad_transition', '同じ依頼の確定と重なりました。もう一度送ってください');
    throw e;
  }
}
```

- [ ] **Step 7: 通るのを確かめる**

Run: `npx vitest run test/job-intake.test.ts test/jobs.test.ts`
Expected: PASS（全件。`jobs.test.ts` の「JobEvent を作るのは jobs.ts の recordEvent の1か所だけ」も PASS）

Run: `npx tsc --noEmit`
Expected: エラー0

- [ ] **Step 8: コミット**

```bash
git add src/lib/storage.ts src/lib/jobs.ts src/lib/job-http.ts test/job-intake.test.ts
git commit -m "$(cat <<'EOF'
feat: グループからの帯替えの受付を1つのトランザクションで確定する（createIntakeJob）

途中で切れても依頼と入力が半端に残らないようにするため。同じ lineMessageId の再送・同時の2本は照合して同じ結果を返し、
中身が違えば INTAKE_MISMATCH。受付が置くファイルは名前の頭 intake- で区別し、確定しなければこの呼び出しの分だけ消す。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 受付の残りファイルの掃除（1時間・参照なし）を毎分の見回りに入れる

**Files:**
- Modify: `src/lib/storage.ts`（末尾に `listFiles`）
- Modify: `src/lib/jobs.ts`（import に `listFiles`、受付の節の最後に `sweepIntakeOrphans`）
- Modify: `src/app/api/jobs/prep-tick/route.ts:1-14`
- Test: `test/job-intake.test.ts`（末尾に describe を追記）、`test/job-api-obi.test.ts:15`（import に `utimes`）と `:366`（prep-tick の describe の最後に `it` を追記）

**掃除の置き場の判断：** 定期の処理は2つある。`GET /api/jobs` の `sweepJobs`（Mac の LINE秘書の巡回で動く。Mac が止まると動かない）と、`prep-tick`（Railway の worker が毎分 `x-cron-secret` で叩く。`worker.mjs:185`）。受付は Mac が止まっていても進む流れなので、Mac に依らない `prep-tick` に入れる。`sweepJobs` の戻り値の形は変えない。

**Interfaces:**
- Consumes: Task 4 の `INTAKE_PREFIX`・`saveFile(…, { prefix })`・`createIntakeJob`
- Produces:
  - `src/lib/storage.ts`：`listFiles(prefix: string): Promise<{ key: string; mtimeMs: number }[]>`（空の prefix は投げる）
  - `src/lib/jobs.ts`：`INTAKE_ORPHAN_MS = 3600000`、`sweepIntakeOrphans(now?: Date): Promise<number>`（消した件数）

- [ ] **Step 1: 掃除のテストを追記する（失敗する）**

`test/job-intake.test.ts` の末尾に追記：

```ts

describe('sweepIntakeOrphans', () => {
  it('受付専用の頭で1時間より古く、どの入力からも参照されないファイルだけ消す', async () => {
    const { saveFile, INTAKE_PREFIX } = await import('@/lib/storage');
    const r = await jobs.createIntakeJob(request());
    const used = (await prisma.jobInput.findMany({ where: { jobId: r.job.id } })).map((i) => i.fileKey);
    const orphan = await saveFile(pdf('o'), 'o.pdf', { prefix: INTAKE_PREFIX });
    const fresh = await saveFile(pdf('f'), 'f.pdf', { prefix: INTAKE_PREFIX });
    const other = await saveFile(pdf('x'), 'x.pdf');
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    for (const k of [...used, orphan, other]) await utimes(path.join(storageDir, k), old, old);
    expect(await jobs.sweepIntakeOrphans()).toBe(1);
    expect(await files()).toEqual([...used, fresh, other].sort());
  });

  it('1時間ちょうどまでは消さない（受付の1回は60秒以内に終わる）', async () => {
    const { saveFile, INTAKE_PREFIX } = await import('@/lib/storage');
    const k = await saveFile(pdf('o'), 'o.pdf', { prefix: INTAKE_PREFIX });
    const now = new Date();
    const edge = new Date(now.getTime() - jobs.INTAKE_ORPHAN_MS);
    await utimes(path.join(storageDir, k), edge, edge);
    expect(await jobs.sweepIntakeOrphans(now)).toBe(0);
    expect(await jobs.sweepIntakeOrphans(new Date(now.getTime() + 1000))).toBe(1);
    expect(await files()).toEqual([]);
  });

  it('listFiles は空の頭を受け付けない（置き場全体を消す道を作らない）', async () => {
    const { listFiles } = await import('@/lib/storage');
    await expect(listFiles('')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run test/job-intake.test.ts -t "sweepIntakeOrphans|listFiles|1時間ちょうど"`
Expected: FAIL（`jobs.sweepIntakeOrphans is not a function`・`listFiles` が無い）

- [ ] **Step 3: 頭で引く一覧を足す**

`src/lib/storage.ts` の末尾に足す：

```ts

/**
 * 名前が prefix で始まるファイルの一覧（名前と更新時刻）。置き場がまだ無ければ空。
 * prefix は空にできない（置き場全体を消す道を作らない）
 */
export async function listFiles(prefix: string): Promise<{ key: string; mtimeMs: number }[]> {
  if (!prefix) throw new Error('prefix が空です');
  let names: string[];
  try {
    names = await fs.readdir(STORAGE_DIR);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: { key: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      const st = await fs.stat(path.join(STORAGE_DIR, name));
      if (st.isFile()) out.push({ key: name, mtimeMs: st.mtimeMs });
    } catch {
      // 見ている間に消えたものは数えない
    }
  }
  return out;
}
```

- [ ] **Step 4: 掃除を足す**

`src/lib/jobs.ts` の storage の import（Task 4 で変えた行）を置き換える：

```ts
import { saveFile, readFile, deleteFile, listFiles, INTAKE_PREFIX } from './storage';
```

`src/lib/jobs.ts` の `createIntakeJob` の閉じ `}` の直後に足す：

```ts

/** 受付の途中で止まって残ったファイルを消すまでの時間（受付の1回は60秒以内に終わる） */
export const INTAKE_ORPHAN_MS = 60 * 60 * 1000;

/**
 * 受付専用の名前の頭のファイルのうち、1時間より古く、どの JobInput からも参照されていないものを消す（設計書 12 の 8。
 * 置いた後・確定の前に止まった場合の残り）。ほかの用途のファイルは見ない。毎分の見回り（prep-tick）から呼ぶ。
 * 1件の削除の失敗で残りを止めない（次回また試す）。消した件数を返す
 */
export async function sweepIntakeOrphans(now: Date = new Date()): Promise<number> {
  const old = (await listFiles(INTAKE_PREFIX)).filter((f) => f.mtimeMs < now.getTime() - INTAKE_ORPHAN_MS);
  if (old.length === 0) return 0;
  const used = await prisma.jobInput.findMany({
    where: { fileKey: { in: old.map((f) => f.key) } },
    select: { fileKey: true },
  });
  const keep = new Set(used.map((u) => u.fileKey));
  let removed = 0;
  for (const f of old) {
    if (keep.has(f.key)) continue;
    try {
      await deleteFile(f.key);
      removed++;
    } catch (e) {
      console.error('受付の残りファイルの削除に失敗しました', e instanceof Error ? e.name : 'unknown');
    }
  }
  return removed;
}
```

- [ ] **Step 5: lib の掃除が通るのを確かめる**

Run: `npx vitest run test/job-intake.test.ts`
Expected: PASS（全件）

- [ ] **Step 6: 見回りの掃除のテストを追記する（失敗する）**

`test/job-api-obi.test.ts:15` を置き換える：

```ts
import { readdir, rm, utimes } from 'node:fs/promises';
```

`describe('POST /api/jobs/prep-tick', ...)` の最後の `it`（「cron の合言葉か鍵で、下準備（最大1件）を起動して…」）の閉じ（365行目 `  });`）の直後、describe の閉じの前に追記：

```ts

  it('見回りのたびに、受付（intake）の途中で残った1時間より古いファイルを消す（新しいもの・ほかの用途は残す）', async () => {
    const { saveFile, INTAKE_PREFIX } = await import('@/lib/storage');
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    const orphan = await saveFile(Buffer.from('%PDF-1.4\no\n'), 'o.pdf', { prefix: INTAKE_PREFIX });
    const fresh = await saveFile(Buffer.from('%PDF-1.4\nf\n'), 'f.pdf', { prefix: INTAKE_PREFIX });
    const other = await saveFile(Buffer.from('%PDF-1.4\nx\n'), 'x.pdf');
    await utimes(path.join(storageDir, orphan), old, old);
    await utimes(path.join(storageDir, other), old, old);
    const r = await api.tick.POST(new NextRequest(url('/api/jobs/prep-tick'), { method: 'POST', headers: { 'x-cron-secret': CRON } }));
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ started: true });
    expect((await readdir(storageDir)).sort()).toEqual([fresh, other].sort());
  });
```

- [ ] **Step 7: 失敗を確かめる**

Run: `npx vitest run test/job-api-obi.test.ts -t "受付（intake）の途中で残った"`
Expected: FAIL（`orphan` のファイルが残っている）

- [ ] **Step 8: prep-tick に掃除を入れる**

`src/app/api/jobs/prep-tick/route.ts` 全体を置き換える：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { isJobApiRequest } from '@/lib/job-auth';
import { isCronRequest, kickPrep, unauthorized } from '@/lib/job-http';
import { sweepIntakeOrphans } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

// POST /api/jobs/prep-tick — 下準備の見回り。worker が毎分 x-cron-secret（SUUMO_CRON_SECRET）で叩く。鍵でも可。
// 下準備中で lease が空いた依頼を1件取って最後まで進める処理を起動し、終わりを待たずに 202 を返す
// （1プロセスの中では同時に1件だけ。重なった起動は何もしない）。
// あわせて、グループからの受付（/api/jobs/intake）の途中で止まって残ったファイル（1時間・参照なし）を消す。
// Mac の巡回（GET /api/jobs）に頼らず、worker の毎分で動かすためここに置く。失敗しても見回りは止めない
export async function POST(request: NextRequest) {
  if (!isCronRequest(request) && !isJobApiRequest(request)) return unauthorized();
  try {
    await sweepIntakeOrphans();
  } catch (e) {
    console.error(`受付の残りファイルの掃除に失敗しました（${e instanceof Error ? e.name : 'unknown'}）`);
  }
  kickPrep();
  return NextResponse.json({ started: true }, { status: 202 });
}
```

- [ ] **Step 9: 通るのを確かめる**

Run: `npx vitest run test/job-api-obi.test.ts test/job-intake.test.ts`
Expected: PASS（全件。既存の prep-tick の 401・202 の件もそのまま）

Run: `npx tsc --noEmit`
Expected: エラー0

- [ ] **Step 10: コミット**

```bash
git add src/lib/storage.ts src/lib/jobs.ts "src/app/api/jobs/prep-tick/route.ts" test/job-intake.test.ts test/job-api-obi.test.ts
git commit -m "$(cat <<'EOF'
feat: 受付の途中で止まって残ったファイルを毎分の見回りで消す

置いた後・確定の前に止まった受付のファイルが残り続けないようにするため。名前の頭 intake- で1時間より古く、
どの入力からも参照されないものだけを消す。Mac の巡回に依らない worker の prep-tick に入れる。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: POST /api/jobs/intake（入口）

**Files:**
- Modify: `src/lib/job-http.ts:1-6`（import）、`:85-124`（`MAX_INTAKE_BODY_BYTES`、`readLimitedForm` に文言の引数）
- Create: `src/app/api/jobs/intake/route.ts`
- Test: `test/job-api-intake.test.ts`（新規）

**Interfaces:**
- Consumes: Task 3 の `INTAKE_LIMITS`・`INTAKE_TOTAL_TEXT`・`EACH_LIMIT_TEXT`、Task 4 の `createIntakeJob`・`IntakeResult`、既存の `kickPrep`・`isJobApiRequest`・`jobErrorResponse`
- Produces:
  - `src/lib/job-http.ts`：`export const MAX_INTAKE_BODY_BYTES = 26_048_576`（= 25,000,000 + 1MiB）、`readLimitedForm(request: Request, max?: number, tooLargeText?: string): Promise<FormData>`（既定は今と同じ）
  - `POST /api/jobs/intake`（受け渡しの約束の形）

- [ ] **Step 1: HTTP の形のテストを書く（失敗する）**

`test/job-api-intake.test.ts`：

```ts
// グループからの帯替えの受付（POST /api/jobs/intake）の HTTP の形
// （設計書 2026-10-09 決めたこと 10・12・15・16、受け渡しの約束 P1 → P2）。
//
// ここで守りたいこと：
//   ・鍵だけ。成功は 201（新規）／200（同じ lineMessageId の照合が一致）で { no, status, created, inputs }
//   ・項目の形・件数（0件・21件）・%PDF- でないものは 400 INVALID_REQUEST、同じ中身は 400 INTAKE_DUPLICATE、照合の不一致は 409 INTAKE_MISMATCH
//   ・合計 25,000,000 バイト超・本文の上限超は 413 INPUT_TOO_LARGE（本文の上限は読む前にも見る）
//   ・受付停止は 503、取り込み中は 409 OBI_BUSY＋busyJobNo（秘書室の POST /api/jobs も同じ）
//   ・新しく作ったときだけ下準備を起動する。claim の応答に返し先が出る
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

vi.mock('@/lib/db', () => {
  const { PrismaClient } = require('@prisma/client');
  return {
    prisma: new PrismaClient({ datasources: { db: { url: `file:${process.cwd()}/prisma/test.db` } } }),
  };
});

vi.mock('@/lib/session', () => ({
  requireStaff: async () => ({ error: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }) }),
  requireManager: async () => ({ error: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }) }),
}));

// 下準備の本体は重いので差し替える（中身は obi-prep.test.ts が見ている）
vi.mock('@/lib/obi-prep', () => ({
  runPrepOnce: vi.fn(async () => ({ ran: false, reason: 'idle' })),
  makeCompareImage: vi.fn(async () => Buffer.from('\x89PNG-compare')),
}));

import { prisma } from '@/lib/db';

const TOKEN = 't'.repeat(40);
const G = 'C' + '0123456789abcdef'.repeat(2);
const url = (p: string) => `https://example.test${p}`;
const asBlobPart = (bytes: Uint8Array): BlobPart => new Uint8Array(bytes).buffer as ArrayBuffer;
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const pdfBytes = (tag: string) => new Uint8Array(Buffer.from(`%PDF-1.4\n${tag}\n%%EOF\n`, 'latin1'));

const storageDir = mkdtempSync(path.join(tmpdir(), 'jobapiintake-'));
process.env.DOCUMENT_STORAGE_DIR = storageDir;

type Fields = Record<string, string | undefined>;
type Part = { name: string; data: Uint8Array };

const BASE: Fields = {
  workflow: 'obi',
  lineMessageId: '600000000000000001',
  property: 'テスト物件',
  requestText: '帯替え テスト物件',
  requestedBy: 'テスト',
  replyKind: 'line-group',
  replyGroupId: G,
};

const twoPdfs = (): Part[] => [
  { name: 'a.pdf', data: pdfBytes('a') },
  { name: 'b.pdf', data: pdfBytes('b') },
];

function intakeRequest(fields: Fields, files: Part[], token: string | null = TOKEN): NextRequest {
  const form = new FormData();
  for (const [k, v] of Object.entries({ ...BASE, ...fields })) if (v !== undefined) form.append(k, v);
  for (const f of files) form.append('files', new File([asBlobPart(f.data)], f.name, { type: 'application/pdf' }));
  return new NextRequest(url('/api/jobs/intake'), {
    method: 'POST',
    body: form,
    headers: token === null ? {} : { 'x-job-token': token },
  });
}

let api: {
  intake: typeof import('@/app/api/jobs/intake/route');
  jobs: typeof import('@/app/api/jobs/route');
  claim: typeof import('@/app/api/jobs/[no]/delivery/claim/route');
};
let http: typeof import('@/lib/job-http');

async function send(fields: Fields, files: Part[], token: string | null = TOKEN) {
  const res = await api.intake.POST(intakeRequest(fields, files, token));
  return { res, body: await res.json() };
}

beforeEach(async () => {
  process.env.JOB_API_TOKEN = TOKEN;
  for (const f of await readdir(storageDir)) await rm(path.join(storageDir, f), { force: true });
  vi.resetModules();
  api = {
    intake: await import('@/app/api/jobs/intake/route'),
    jobs: await import('@/app/api/jobs/route'),
    claim: await import('@/app/api/jobs/[no]/delivery/claim/route'),
  };
  http = await import('@/lib/job-http');
  const prep = await import('@/lib/obi-prep');
  vi.mocked(prep.runPrepOnce).mockClear();
  await prisma.jobEvent.deleteMany();
  await prisma.jobInput.deleteMany();
  await prisma.job.deleteMany();
  await prisma.appState.deleteMany({ where: { key: { in: ['jobs.intake.stopped', 'jobs.obi.intake'] } } });
});

afterEach(async () => {
  await http.lastPrepKick();
});

describe('POST /api/jobs/intake', () => {
  it('鍵が無い・違うと 401 UNAUTHORIZED。何も作らない', async () => {
    for (const token of [null, 'x'.repeat(40)]) {
      const { res, body } = await send({}, twoPdfs(), token);
      expect(res.status).toBe(401);
      expect(body.code).toBe('UNAUTHORIZED');
    }
    expect(await prisma.job.count()).toBe(0);
    expect(await readdir(storageDir)).toEqual([]);
  });

  it('201 { no, status: 下準備中, created: true, inputs（送った順） }。確定の後に下準備を1回起こす', async () => {
    const [a, b] = twoPdfs();
    const { res, body } = await send({}, [a, b]);
    expect(res.status).toBe(201);
    expect(body).toEqual({
      no: expect.any(Number),
      status: '下準備中',
      created: true,
      inputs: [
        { name: 'a.pdf', sha256: sha(a.data), size: a.data.length },
        { name: 'b.pdf', sha256: sha(b.data), size: b.data.length },
      ],
    });
    expect(await prisma.job.findUnique({ where: { no: body.no } })).toMatchObject({
      workflow: 'obi',
      property: 'テスト物件',
      requestedBy: 'テスト',
      replyKind: 'line-group',
      replyGroupId: G,
    });
    expect((await readdir(storageDir)).every((k) => k.startsWith('intake-'))).toBe(true);
    await http.lastPrepKick();
    const { runPrepOnce } = await import('@/lib/obi-prep');
    expect(runPrepOnce).toHaveBeenCalledTimes(1);
  });

  it('同じ lineMessageId の再送は 200 で同じ結果（created: false）。ファイルは増えず、下準備も起こさない', async () => {
    const first = await send({}, twoPdfs());
    await http.lastPrepKick();
    const before = (await readdir(storageDir)).sort();
    const { runPrepOnce } = await import('@/lib/obi-prep');
    vi.mocked(runPrepOnce).mockClear();
    const again = await send({}, twoPdfs());
    expect(again.res.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, created: false });
    expect((await readdir(storageDir)).sort()).toEqual(before);
    await http.lastPrepKick();
    expect(runPrepOnce).not.toHaveBeenCalled();
  });

  it('秘書室あて（replyKind=secretary、replyGroupId なし）も受け付ける', async () => {
    const { res, body } = await send({ replyKind: 'secretary', replyGroupId: undefined }, twoPdfs());
    expect(res.status).toBe(201);
    expect(await prisma.job.findUnique({ where: { no: body.no } })).toMatchObject({ replyKind: 'secretary', replyGroupId: null });
  });

  it('項目の形・件数（0件・21件）・%PDF- でないものは 400 INVALID_REQUEST で何も残さない', async () => {
    const ok = twoPdfs();
    const cases: [Fields, Part[]][] = [
      [{ workflow: undefined }, ok],
      [{ workflow: 'satei' }, ok],
      [{ lineMessageId: 'abc' }, ok],
      [{ lineMessageId: undefined }, ok],
      [{ property: '' }, ok],
      [{ property: 'あ'.repeat(101) }, ok],
      [{ replyKind: undefined }, ok],
      [{ replyKind: 'secretary' }, ok], // groupId があるのに secretary
      [{ replyGroupId: undefined }, ok],
      [{ replyGroupId: 'C123' }, ok],
      [{}, []],
      [{}, Array.from({ length: 21 }, (_, i) => ({ name: `${i}.pdf`, data: pdfBytes(`n${i}`) }))],
      [{}, [{ name: 'x.pdf', data: new Uint8Array(Buffer.from('not a pdf')) }]],
    ];
    for (const [fields, files] of cases) {
      const { res, body } = await send(fields, files);
      expect(res.status).toBe(400);
      expect(body.code).toBe('INVALID_REQUEST');
    }
    expect(await prisma.job.count()).toBe(0);
    expect(await readdir(storageDir)).toEqual([]);
  });

  it('同じ中身の PDF が2つあれば 400 INTAKE_DUPLICATE（黙ってまとめない）。何も残さない', async () => {
    const a = pdfBytes('a');
    const { res, body } = await send({}, [{ name: 'a.pdf', data: a }, { name: 'a2.pdf', data: a }]);
    expect(res.status).toBe(400);
    expect(body.code).toBe('INTAKE_DUPLICATE');
    expect(await prisma.job.count()).toBe(0);
    expect(await readdir(storageDir)).toEqual([]);
  });

  it('同じ lineMessageId で中身が違えば 409 INTAKE_MISMATCH。ファイルは増えない', async () => {
    await send({}, twoPdfs());
    const before = (await readdir(storageDir)).sort();
    const { res, body } = await send({ property: '別の物件' }, twoPdfs());
    expect(res.status).toBe(409);
    expect(body.code).toBe('INTAKE_MISMATCH');
    expect((await readdir(storageDir)).sort()).toEqual(before);
  });

  it('合計 25,000,000 バイトちょうどは通り、1バイト超えたら 413 INPUT_TOO_LARGE', async () => {
    const big = (n: number, tag: number) => {
      const b = new Uint8Array(n);
      b.set(Buffer.from('%PDF-1.4\n', 'latin1'));
      b[n - 1] = tag;
      return b;
    };
    const over = await send({ lineMessageId: '600000000000000009' }, [
      { name: 'a.pdf', data: big(12_500_001, 1) },
      { name: 'b.pdf', data: big(12_500_000, 2) },
    ]);
    expect(over.res.status).toBe(413);
    expect(over.body.code).toBe('INPUT_TOO_LARGE');
    expect(await prisma.job.count()).toBe(0);
    expect(await readdir(storageDir)).toEqual([]);
    const exact = await send({}, [
      { name: 'a.pdf', data: big(12_500_000, 1) },
      { name: 'b.pdf', data: big(12_500_000, 2) },
    ]);
    expect(exact.res.status).toBe(201);
  });

  it('本文の上限（合計の上限＋区切りの分）を Content-Length が超えていれば、読まずに 413', async () => {
    expect(http.MAX_INTAKE_BODY_BYTES).toBe(25_000_000 + 1024 * 1024);
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
          throw new Error('読んではいけない');
        },
      },
      { highWaterMark: 0 },
    );
    const req = new NextRequest(url('/api/jobs/intake'), {
      method: 'POST',
      body,
      headers: {
        'x-job-token': TOKEN,
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': String(http.MAX_INTAKE_BODY_BYTES + 1),
      },
      duplex: 'half',
    });
    const res = await api.intake.POST(req);
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('INPUT_TOO_LARGE');
    expect(pulled).toBe(false);
  });

  it('Content-Length が無くても、読みながら本文の上限を超えたら 413（既存の約101MiB までは読まない）', async () => {
    const chunk = new Uint8Array(4 * 1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent > 120 * 1024 * 1024) return c.close();
        sent += chunk.length;
        c.enqueue(chunk);
      },
    });
    const req = new NextRequest(url('/api/jobs/intake'), {
      method: 'POST',
      body,
      headers: { 'x-job-token': TOKEN, 'content-type': 'multipart/form-data; boundary=x' },
      duplex: 'half',
    });
    const res = await api.intake.POST(req);
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(40 * 1024 * 1024);
  });

  it('受付停止中は 503 INTAKE_STOPPED で何も残さない', async () => {
    await prisma.appState.create({ data: { key: 'jobs.intake.stopped', value: '1' } });
    const { res, body } = await send({}, twoPdfs());
    expect(res.status).toBe(503);
    expect(body.code).toBe('INTAKE_STOPPED');
    expect(await prisma.job.count()).toBe(0);
    expect(await readdir(storageDir)).toEqual([]);
  });

  it('取り込み中の帯替えがあれば 409 OBI_BUSY と busyJobNo（秘書室の POST /api/jobs も同じ）', async () => {
    const first = await send({}, twoPdfs());
    const { res, body } = await send({ lineMessageId: '600000000000000002' }, [{ name: 'c.pdf', data: pdfBytes('c') }]);
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ code: 'OBI_BUSY', busyJobNo: first.body.no });
    expect(body.message).toContain(`#J${first.body.no}`);
    const legacy = await api.jobs.POST(
      new NextRequest(url('/api/jobs'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-job-token': TOKEN },
        body: JSON.stringify({ workflow: 'obi', lineMessageId: 'legacy-1' }),
      }),
    );
    expect(legacy.status).toBe(409);
    expect(await legacy.json()).toMatchObject({ code: 'OBI_BUSY', busyJobNo: first.body.no });
  });

  it('受け付けた依頼を納品の予約にすると、返し先（line-group・groupId）が返る', async () => {
    const { body } = await send({}, twoPdfs());
    await http.lastPrepKick();
    const { saveFile } = await import('@/lib/storage');
    const artifactKey = await saveFile(Buffer.from('%PDF-1.4\nbook\n'), 'book.pdf');
    await prisma.job.update({ where: { no: body.no }, data: { status: '完成', artifactKey, artifactName: 'book.pdf' } });
    const res = await api.claim.POST(
      new NextRequest(url(`/api/jobs/${body.no}/delivery/claim`), { method: 'POST', headers: { 'x-job-token': TOKEN } }),
      { params: Promise.resolve({ no: String(body.no) }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ no: body.no, status: '納品中', replyKind: 'line-group', replyGroupId: G });
  });
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run test/job-api-intake.test.ts`
Expected: FAIL（`Failed to resolve import "@/app/api/jobs/intake/route"`）

- [ ] **Step 3: 本文の上限の文言を引数にし、受付の本文の上限を足す**

`src/lib/job-http.ts:6` を置き換える：

```ts
import { INPUT_LIMITS, INTAKE_LIMITS } from './jobs';
```

`src/lib/job-http.ts:85-96`（`MAX_INPUT_BODY_BYTES` から `readLimitedForm` の Content-Length の確認まで）を置き換える：

```ts
// 入力（multipart）の本文の上限。ファイルの合計上限に区切りの分を少し足す
export const MAX_INPUT_BODY_BYTES = INPUT_LIMITS.totalBytes + 1024 * 1024;
// グループからの受付（/api/jobs/intake）の本文の上限。合計 25,000,000 バイト＋区切りの分（/inputs の上限は使わない）
export const MAX_INTAKE_BODY_BYTES = INTAKE_LIMITS.totalBytes + 1024 * 1024;

/**
 * multipart の本文を上限つきで読む。Content-Length があれば読む前に断り、
 * 無い（または偽の）ときも読みながら数えて、上限を超えた時点で読むのをやめる（巨大な本文を貯めない）。
 * 超えたときの文言は呼ぶ側の上限に合わせる（既定は /inputs の合計100MB）
 */
export async function readLimitedForm(
  request: Request,
  max = MAX_INPUT_BODY_BYTES,
  tooLargeText = 'PDFは合計100MBまでです',
): Promise<FormData> {
  const tooLarge = () => new JobError('too_large', tooLargeText);
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
```

（元の88行目 `const tooLarge = () => new JobError('too_large', 'PDFは合計100MBまでです');` は関数の中に移したので消す。97行目以降 `const type = ...` から関数の終わりまでは変えない）

- [ ] **Step 4: 入口を作る**

`src/app/api/jobs/intake/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createIntakeJob, EACH_LIMIT_TEXT, INTAKE_LIMITS, INTAKE_TOTAL_TEXT, JobError } from '@/lib/jobs';
import { isJobApiRequest } from '@/lib/job-auth';
import { jobErrorResponse, kickPrep, MAX_INTAKE_BODY_BYTES, readLimitedForm, unauthorized } from '@/lib/job-http';

export const dynamic = 'force-dynamic';

// POST /api/jobs/intake — MD NEXT秘書（aisecretary）が、LINE のグループで頼まれた帯替えを1回で受け付ける。鍵が必須。
// multipart：workflow=obi・lineMessageId・property・requestText・requestedBy・assigneeName・replyKind・replyGroupId・
// files（1〜20件、出た順）。依頼の作成と PDF の確定は1つのトランザクション（途中で切れても半端に残らない）。
// 同じ lineMessageId の再送は照合して 200 で同じ結果、中身が違えば 409 INTAKE_MISMATCH。
// 本文は合計の上限（25,000,000 バイト）＋区切りの分までしか読まない（/inputs の約101MiB の上限は使わない）
export async function POST(request: NextRequest) {
  if (!isJobApiRequest(request)) return unauthorized();
  try {
    const form = await readLimitedForm(request, MAX_INTAKE_BODY_BYTES, INTAKE_TOTAL_TEXT);
    const entries = form.getAll('files');
    if (entries.some((f) => !(f instanceof File))) throw new JobError('invalid', 'files にファイル以外が含まれています');
    const files = entries as File[];
    // 件数・1件の大きさは中身を読む前に断る（合計は readLimitedForm と createIntakeJob が見ている）
    if (files.length > INTAKE_LIMITS.files) {
      throw new JobError('invalid', `PDFは1回に${INTAKE_LIMITS.files}件までです（${files.length}件）`);
    }
    if (files.some((f) => f.size > INTAKE_LIMITS.eachBytes)) throw new JobError('too_large', EACH_LIMIT_TEXT);
    const field = (k: string) => {
      const v = form.get(k);
      return typeof v === 'string' ? v : undefined;
    };
    const r = await createIntakeJob({
      workflow: field('workflow'),
      lineMessageId: field('lineMessageId'),
      property: field('property'),
      requestText: field('requestText'),
      requestedBy: field('requestedBy'),
      assigneeName: field('assigneeName'),
      replyKind: field('replyKind'),
      replyGroupId: field('replyGroupId'),
      files: await Promise.all(files.map(async (f) => ({ name: f.name, data: Buffer.from(await f.arrayBuffer()) }))),
    });
    // 確定したら下準備をすぐ起こす（応答は待たせない。起こせなくても毎分の見回り prep-tick が拾う）。照合で返すときは起こさない
    if (r.created) kickPrep();
    return NextResponse.json(
      { no: r.job.no, status: r.job.status, created: r.created, inputs: r.inputs },
      { status: r.created ? 201 : 200 },
    );
  } catch (e) {
    return jobErrorResponse(e);
  }
}
```

- [ ] **Step 5: 通るのを確かめる（/inputs の上限の動きも）**

Run: `npx vitest run test/job-api-intake.test.ts test/job-api-obi.test.ts`
Expected: PASS（全件。既存の `/inputs` の「PDFは合計100MB」「Content-Length の 413」もそのまま）

Run: `npx tsc --noEmit`
Expected: エラー0

- [ ] **Step 6: コミット**

```bash
git add src/lib/job-http.ts "src/app/api/jobs/intake/route.ts" test/job-api-intake.test.ts
git commit -m "$(cat <<'EOF'
feat: グループからの帯替えを受け付ける POST /api/jobs/intake を足す

MD NEXT秘書が依頼の項目と PDF を1回で送れるようにするため。本文は合計 25,000,000 バイト＋区切りの分までしか読まず、
新しく作ったときだけ下準備を起こす。形とエラーは受け渡しの約束（P1 → P2）のとおり。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 全体の確認と判断の記録

**Files:**
- Modify: `progress.md`（末尾に節を追記）

**Interfaces:**
- Consumes: Task 1〜6 のすべて
- Produces: なし（全件の確認と記録）

- [ ] **Step 1: 全部のテストを1回で回す（ほかの vitest を同時に起動しない）**

Run: `npx vitest run`
Expected: PASS（全件。失敗があれば出力ごと報告し、直すまで次へ進まない）

- [ ] **Step 2: 型を確かめる**

Run: `npx tsc --noEmit`
Expected: エラー0

- [ ] **Step 3: 既存の入口の形が変わっていないことを差分で確かめる**

Run: `git diff origin/main -- "src/app/api/jobs/route.ts" "src/app/api/jobs/[no]/inputs/route.ts"`
Expected: 差分なし（`POST /api/jobs` の `busyJobNo` は `jobs.ts`・`job-http.ts` の側で足している）

- [ ] **Step 4: 判断の記録を progress.md に足す**

`progress.md` の末尾に追記：

```markdown

## 2026-10-09 グループからの帯替えの受付口（POST /api/jobs/intake）で決めたこと

設計書：`apps/aisecretary/docs/superpowers/specs/2026-10-09-group-obi-intake-design.md`／計画：同 `plans/2026-10-09-group-obi-p1-portal.md`

- 受付専用の置き場は「サブフォルダ」ではなく「名前の頭 `intake-`」にした。`readFile`・`deleteFile` が名前（basename）で引くため、同じ置き場に置かないと読めない。ほかの用途の名前は16進32桁で始まるので重ならない
- 残りファイルの掃除（1時間・参照なし）は `prep-tick`（worker が毎分）に入れた。`GET /api/jobs` の `sweepJobs` は Mac の巡回に依るため、Mac が止まると動かない
- 確定のトランザクションの中の順番は「OBI のロック → 同じ lineMessageId → 受付停止 → 取り込み中 → 作成」。同じ依頼の確認を先にするのは、確定の後の再送へ停止中・取り込み中でも同じ結果を返すため（`createJob` の「二重登録の防止は停止判定より先」と同じ考え）
- 件数0・21件以上は受け渡しの約束どおり 400 INVALID_REQUEST（/inputs は今どおり 413）
- 項目が長すぎるときは切らずに 400 で断る（`createJob` は切り詰めるが、照合の対象の物件名がずれないように）
- `assigneeName` で担当が見つからないときは既存どおり 422 ASSIGNEE_NOT_FOUND（約束の表には無いが、MD NEXT秘書は送らない）
- 応答の `inputs[].name` は保存用に整えた名前。送り手は sha256 で照合する
- Job の2列（`replyKind`・`replyGroupId`）は `schema.prisma` だけを変え、本番は `start:web` の `db push` で入る。push・デプロイは下村さんの承認の後
```

- [ ] **Step 5: コミット**

```bash
git add progress.md
git commit -m "$(cat <<'EOF'
docs: グループからの帯替えの受付口で決めたことを記録する

設計書で幅のあった所（置き場の分け方・掃除の場所・確定の順番・エラーの種類）の判断を後から追えるようにするため。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: 報告（push・デプロイはしない）**

ブランチ `feat/group-obi-intake` のコミット一覧（`git log --oneline origin/main..HEAD`）と、Step 1・2 の結果（件数・エラー0）をそのまま報告する。本番への反映（push・Railway のデプロイで `db push` が2列を足す）は、下村さんの承認を待つと明記する。

---

## Self-Review

**1. 設計書の項目ごとの対応**

| 設計書 | 対応するタスク |
|---|---|
| 10（portal の新しい入口でも合計 25,000,000 バイトを確かめる） | Task 3（`INTAKE_RULE`）・Task 6（本文の上限・413 のテスト） |
| 12 の 0（本文の読み取りで上限。既存の約101MiB は使わない） | Task 6（`MAX_INTAKE_BODY_BYTES`・`readLimitedForm` の Content-Length／読みながらの2テスト） |
| 12 の 1（件数・大きさ・`%PDF-`・sha256、同じ sha256 は `INTAKE_DUPLICATE`、共通の部品、/inputs は今のまま） | Task 3（`checkInputFiles`・`ADD_INPUTS_RULE`・回帰テスト）・Task 4/6（`INTAKE_DUPLICATE`） |
| 12 の 2（同じ lineMessageId は照合して返す・保存しない） | Task 4（`createIntakeJob` の手順2・再送のテスト）・Task 6（200 のテスト） |
| 12 の 3（受付専用の置き場・この呼び出し専用の名前） | Task 4（`INTAKE_PREFIX`・`saveFile` の prefix） |
| 12 の 4（1つのトランザクション：OBI ロック・受付停止・重複・作成・全部の JobInput、遷移は inputs と同じ） | Task 4（`commitIntake`）・Task 3（`commitInputsTx`） |
| 12 の 5（失敗したらこの呼び出しのファイルだけ消す） | Task 4（catch・DB 失敗のテスト） |
| 12 の 6（確定後に応答が届かない → 同じ呼び出しで結果を返す） | Task 4（再送のテスト）・Task 6（200 のテスト） |
| 12 の 7（重複で失敗 → ファイルを消して読み直し、照合に合流） | Task 4（`IntakeRace`・P2002・同時2本のテスト） |
| 12 の 8（受付専用で参照の無いファイルを1時間で掃除。ほかの置き場は見ない） | Task 5（`sweepIntakeOrphans`・`listFiles`・prep-tick） |
| 12 の 9（確定したら `kickPrep()`。起こせなくても prep-tick） | Task 6（`created` のときだけ・テスト） |
| 12 の照合（workflow・件数と sha256 の集合・replyKind・replyGroupId・物件名） | Task 4（`reconcileIntake`・mismatch のテスト） |
| 12 の「`受付` の掃除は足さない」 | 足していない（`sweepJobs` は変えない） |
| 15（`OBI_BUSY` に `busyJobNo`、両方の入口） | Task 2（`POST /api/jobs`）・Task 4/6（intake） |
| 16（`replyKind`・`replyGroupId`、1か所の検査、受付で検査、claim で返す） | Task 1（schema・`job-reply.ts`・claim）・Task 4（`parseIntakeFields` が `parseReplyTarget` を使う） |
| 影響する所 › portal「既存の `POST /api/jobs`・`/inputs` は変えない」 | Task 3・6 の回帰テスト、Task 7 Step 3 の差分確認 |
| 確かめ方 › portal（成功・冪等・重複を断る・DB 失敗で残らない・掃除・合計の上限・受付停止・同時1件と busyJobNo・claim） | Task 1・2・4・5・6 のテスト |

Codex の残りの指摘（a）〜（d）（KV の詳細の削除、NX の期限、Webhook の `eventRetry`、Drive の 206）は aisecretary・閲覧ページ側の話で、portal には当てはまらない（P2・P4 の計画で扱う）。

**2. プレースホルダの確認：** 「TBD」「あとで」「同様に」は無い。コードの手順はすべて全文。置き換えの範囲は行番号と前後の行で示した。

**3. 型と名前のそろい方：** `parseReplyTarget`・`replyTargetOf`・`ReplyTarget`（Task 1）を Task 4・claim で同じ名前で使う。`checkInputFiles`・`InputRule`・`ADD_INPUTS_RULE`・`INTAKE_RULE`・`INTAKE_LIMITS`・`INTAKE_TOTAL_TEXT`・`CheckedInput`・`commitInputsTx`（Task 3）を Task 4・6 で使う。`findObiBusy`・`obiBusyError`（Task 2）を Task 4 で使う。`INTAKE_PREFIX`・`saveFile(…, { prefix })`（Task 4）と `listFiles`（Task 5）を Task 5 で使う。`createIntakeJob`・`IntakeRequest`・`IntakeResult`（Task 4）を Task 6 で使う。`MAX_INTAKE_BODY_BYTES`（Task 6）をテストで使う。`JobErrorCode` の `'intake_duplicate'`（Task 3）と `'intake_mismatch'`（Task 4）は、どちらも `OUTWARD` に同じタスクで足している（`Record<JobError['code'], …>` なので足し忘れは型エラーになる）。
