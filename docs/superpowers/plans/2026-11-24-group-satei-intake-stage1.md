# 普通のグループの査定依頼を拾う 1段目 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 対象グループ（業務指示）に来た査定の依頼を受付票にまとめ、資料を Claude で読み、下村さんの1対1に案件の候補カードを push し、タップで「マンションは査定の受付／戸建・土地・不明は手作業の知らせ」に分ける。スイッチ `GROUP_SATEI` を入れるまで今の動きは1バイトも変わらない。

**Architecture:** 判断の部分（`group-satei-*.ts`。deps を受け取るだけ）と本物へのつなぎ（`group-satei-wire.ts`）を分ける。webhook には3か所（画像・ファイルの控え／@AI秘書 あての判定のあと＝入口 A／メンションの無い発言＝入口 B）だけ足す。ボタンは `task-buttons-wire.ts` の振り分けに1つ足す。査定の受付そのもの（案件・物件の読み方、portal の intake）は今の `satei-wire.ts`・`satei-deal.ts` を使い回す。

**Tech Stack:** Next.js 14（App Router）・TypeScript・`@vercel/kv`（Upstash）・`@anthropic-ai/sdk`（claude-sonnet-4-6）・Notion SDK・LINE Messaging API。テストは `tsx tests/<名前>.test.ts`（通信は差し替え。外へ出ない）。

**Spec:** `docs/superpowers/specs/2026-11-24-group-satei-intake-design.md`（§13.1 の段1。§15 の決定済み事項を含む）

## Global Constraints

- スイッチ `GROUP_SATEI=1`（既定 off）かつ `GROUP_SATEI_GROUP_IDS`（カンマ区切り）に入ったグループだけ。off・対象外のあいだは KV も読まない（§5）。
- グループには何も返さない（replyToken を使わない。§2・§15-4）。下村さん（`TASK_SATEI_USER_IDS` の先頭）の1対1への push だけ。
- 画像・PDF を渡す先は Anthropic（Claude）だけ（§15-1）。
- KV・ログ・カードに、本文・ファイル名・お客様の名前・userId・groupId・案件名を入れない（§11.2）。KV に置けるのは ID・時刻・種別・所在・物件名だけ。
- ログは符号だけ：`[group-satei] ...`（§11.2）。
- 人のタップなしに査定を始めない。決めるのは受付票ごとに最初の1回だけ（§8.3）。例外は［案件がまだ無い］の仮の決定（7日以内に1回だけ選び直せる）。
- メンションの無い依頼（入口 B）から LINEタスク を作らない（§15-3）。
- 種別の正は CRM_物件 の `種別`。`judgeSateiDeal` を変えない（§8.4）。
- 既存の data `v1|sa|`・`v1|qa|` などの意味を変えない。新しい data は `v1|gs|`・`v1|gl|`・`v1|gm|`・`v1|gn|`（§8.3）。
- 1日の読み取りは20回まで（§11.1）。資料は1件の受付票につき最大8件（§7）。
- 本物の LINE・Notion・portal・Anthropic はテストで呼ばない。`npm test` は手元の worktree で走らせる（line-secretary 本体ではないので可）。
- push・deploy・本番の env 追加はしない（下村さんの承認後に別途）。

## この計画で決めたこと（Ruling。仕様に書いていない細部）

- R1 `ONLY_DEAL_IDS`（D 案）：env `DEAL_CARD_ONLY_IDS` が**未設定なら今の2件のまま**、`all` なら絞らない、それ以外はカンマ区切りの ID。仕様は「コードから外す」だが、出し直したときに env を入れ忘れると業務指示のグループに全案件が見えてしまうため、入れ忘れても今と同じになる側に倒す。— 間違っていた場合の費用：コードに2件が残る（後で消すだけ）。
- R2 段1では「束ねる資料」は受付票を作った**時点で控えにある分だけ**（優先1の「30分前〜1分後」と、優先2の「受付票の発言を引用した／発言が引用した」）。60分後までの後から来る資料・読み直し・カードの出し直しは段2（仕様 §13.1 のとおり）。
- R3 LINE の画像・ファイルのメッセージには `quotedMessageId` が無い（文字・スタンプだけ）。控えの `quoted` は入れられる形だけ用意し、段1では文字の入口の発言の引用先だけを使う。
- R4 カードの1行目は「LINE のグループで査定の依頼がありました」（グループ名は持たない。groupId を出さないため）。依頼者の名前は名簿（`resolveMember`）の正式氏名だけ。名簿に無ければ書かない。
- R5 ［一覧から選ぶ］のボタンは種別を読まず「この案件で進める」。結果はタップ後の返事で分かる（10件分の物件を読むと遅いため）。候補（最大5件）だけ種別を読んで言葉を変える。
- R6 portal の受付が「受け付けられない（rejected）」「理由待ち」のときは決定の印を外し、受付票は `asking` のまま（押し直せる）。結果不明は印を残し、押し直しでは portal を呼ばずに「確かめられませんでした」を返す。
- R7 入口 A の判定と受付票づくりは、@AI秘書 への返事（登録の返事）を送った**後**に行う（replyToken の期限を読み取りで食わないため）。

---

## ファイルの地図

| ファイル | 役割 |
|---|---|
| `src/lib/deal-card-only.ts`（変更） | R1：`dealCardOnlyIds(env)` を足す |
| `src/lib/deal-card-wire.ts`（変更） | `onlyDeals(deals, dealCardOnlyIds())` |
| `src/lib/group-satei-data.ts`（新） | スイッチ・定数・KV の鍵・受付票の型・受付番号・ボタンの data |
| `src/lib/group-satei-gate.ts`（新） | 入口 A・B の判定、控えの1行、束ねる資料の選び方 |
| `src/lib/group-satei-read.ts`（新） | 読み取りの指示文・答えの検査・名前らしい行の除去・Claude の呼び出し |
| `src/lib/group-satei-card.ts`（新） | 知らせの文・候補のカード・一覧のカード・返事の文 |
| `src/lib/group-satei-open.ts`（新） | 受付票を開く（予約→資料→読み取り→候補→push） |
| `src/lib/group-satei-actions.ts`（新） | ボタン（gs・gl・gm・gn）の処理と種別での分岐 |
| `src/lib/group-satei-wire.ts`（新） | 本物の KV・LINE・Claude・CRM・portal へのつなぎ |
| `src/lib/task-buttons-wire.ts`（変更） | postback の振り分けに gs・gl・gm・gn を足す |
| `src/app/api/webhook/route.ts`（変更） | 控え・入口 A・入口 B の3か所 |
| `tests/group-satei-*.test.ts`（新） | 各ファイルのテスト |
| `package.json`（変更） | `test` に新しいテストと `deal-card-only.test.ts` を足す |
| `CLAUDE.md`（変更） | 新しいスイッチ・env・ログの説明 |

---

### Task 1: 案件カードの絞り込みを設定値へ（R1）

**Files:**
- Modify: `src/lib/deal-card-only.ts`
- Modify: `src/lib/deal-card-wire.ts:86`
- Modify: `tests/deal-card-only.test.ts`
- Modify: `package.json`（`test` の末尾に `&& tsx tests/deal-card-only.test.ts`）

**Interfaces:**
- Produces: `dealCardOnlyIds(env?: Record<string, string | undefined>): readonly string[]`

- [ ] **Step 1: テストを足す**（`tests/deal-card-only.test.ts` の `console.log` の前に）

```ts
import { dealCardOnlyIds } from "../src/lib/deal-card-only";
t("env が無ければ今の2件", () => assert.deepEqual(dealCardOnlyIds({}), ONLY_DEAL_IDS));
t("env が空文字でも今の2件（入れ忘れで全件にしない）", () => assert.deepEqual(dealCardOnlyIds({ DEAL_CARD_ONLY_IDS: " " }), ONLY_DEAL_IDS));
t("all なら絞らない", () => assert.deepEqual(dealCardOnlyIds({ DEAL_CARD_ONLY_IDS: "all" }), []));
t("カンマ区切りの ID", () =>
  assert.deepEqual(dealCardOnlyIds({ DEAL_CARD_ONLY_IDS: "41afd849277881258cdae91077fec212, bbbbbbbb11112222333344444444ffff" }),
    ["41afd849277881258cdae91077fec212", "bbbbbbbb11112222333344444444ffff"]));
t("形の違う ID は捨てる（全部捨てたら今の2件）", () => assert.deepEqual(dealCardOnlyIds({ DEAL_CARD_ONLY_IDS: "xyz" }), ONLY_DEAL_IDS));
```
（import は先頭の import に `dealCardOnlyIds` を足す形でよい）

- [ ] **Step 2: 失敗を確かめる** — Run: `npx tsx tests/deal-card-only.test.ts` / Expected: `dealCardOnlyIds` が無くて失敗

- [ ] **Step 3: 実装**（`src/lib/deal-card-only.ts` の末尾に足す。冒頭のコメントに「2026-11-24 から env `DEAL_CARD_ONLY_IDS` で変えられる（未設定なら下の2件、`all` で全件）」を足す）

```ts
const PAGE_ID_LOOSE_RE = /^[0-9a-f]{32}$/;

/** env DEAL_CARD_ONLY_IDS。未設定・空・形の合う ID が1つも無い → 今の2件。"all" → 絞らない（[]） */
export function dealCardOnlyIds(env: Record<string, string | undefined> = process.env): readonly string[] {
  const raw = (env.DEAL_CARD_ONLY_IDS ?? "").trim();
  if (raw === "all") return [];
  const ids = raw.split(",").map((s) => norm(s.trim())).filter((s) => PAGE_ID_LOOSE_RE.test(s));
  return ids.length > 0 ? ids : ONLY_DEAL_IDS;
}
```
`src/lib/deal-card-wire.ts`：import を `import { dealCardOnlyIds, onlyDeals } from "./deal-card-only";` にし、86行目を `loadDeals: async () => onlyDeals(await loadActiveDeals(), dealCardOnlyIds()),` にする。

- [ ] **Step 4: 通ることを確かめる** — Run: `npx tsx tests/deal-card-only.test.ts && npx tsx tests/deal-card.test.ts` / Expected: 全部 ok
- [ ] **Step 5: Commit** — `git add src/lib/deal-card-only.ts src/lib/deal-card-wire.ts tests/deal-card-only.test.ts package.json && git commit -m "feat: 案件カードの試しの絞り込みを env DEAL_CARD_ONLY_IDS で変えられるようにする（未設定なら今の2件）"`（本文に理由1〜3行と Co-Authored-By）

---

### Task 2: スイッチ・受付票の型・ボタンの data（`group-satei-data.ts`）

**Files:**
- Create: `src/lib/group-satei-data.ts`
- Test: `tests/group-satei-data.test.ts`

**Interfaces:**
- Consumes: `parseAllowedUserIds`（`./webhook-source`）、`PAGE_ID_RE`（`./task-buttons`）
- Produces（後のタスクが使う名前。変えない）：
  - `groupSateiActive(env)`, `groupSateiGroupIds(env)`, `groupSateiOn(groupId, env): boolean`
  - 定数 `GS_TICKET_TTL=604800`, `GS_MEDIA_TTL=10800`, `GS_MEDIA_MAX=30`, `GS_MATERIALS_MAX=8`, `GS_READS_PER_DAY=20`, `GS_MIN=0.5`, `GS_SURE=0.7`, `GS_CANDIDATES_MAX=5`, `GS_PAGE=10`, `GS_RETRY_NAMESPACE`（uuid 文字列）
  - 鍵 `gsMediaKey(groupId)`, `gsTicketKey(tid)`, `GS_SEQ_KEY`, `gsOpenKey(groupId)`, `gsMsgKey(messageId)`, `gsDecKey(tid)`, `gsReadsKey(ymd)`
  - `ticketIdOf(messageId): string`（16字の16進）, `receiptOf(no): string`（`G7`）, `gsEventId(tid): string`（`gs`+tid）
  - 型 `GsKind = "マンション"|"戸建"|"土地"|"不明"`, `GsRead`, `GsMedia`, `GsState`, `GsTicket`, `asTicket(v): GsTicket|null`
  - `GsAction`, `encodeGsPick/encodeGsList/encodeGsManual/encodeGsNone`, `parseGsData(data): GsAction|null`

- [ ] **Step 1: テストを書く**

```ts
/** group-satei-data.ts（外へは出ない） */
import assert from "node:assert/strict";
import {
  asTicket, encodeGsList, encodeGsManual, encodeGsNone, encodeGsPick, groupSateiOn, gsEventId,
  parseGsData, receiptOf, ticketIdOf,
} from "../src/lib/group-satei-data";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const G = "C" + "a".repeat(32);
const DEAL = "0123abcd0123456789ab0123456789ab";

t("off なら対象外", () => assert.equal(groupSateiOn(G, { GROUP_SATEI_GROUP_IDS: G }), false));
t("on でもグループが無ければ対象外", () => assert.equal(groupSateiOn(G, { GROUP_SATEI: "1" }), false));
t("on かつ対象グループ", () => assert.equal(groupSateiOn(G, { GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: `x,${G}` }), true));
t("groupId が無ければ対象外", () => assert.equal(groupSateiOn(undefined, { GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G }), false));
t("受付票の ID は同じ発言なら同じ・16字の16進", () => {
  assert.equal(ticketIdOf("123"), ticketIdOf("123"));
  assert.notEqual(ticketIdOf("123"), ticketIdOf("124"));
  assert.match(ticketIdOf("123"), /^[0-9a-f]{16}$/);
});
t("portal の依頼 ID の形に収まる", () => assert.match(gsEventId(ticketIdOf("1")), /^[0-9A-Za-z]{10,64}$/));
t("受付番号", () => assert.equal(receiptOf(7), "G7"));
const tid = ticketIdOf("m1");
t("data の往復", () => {
  assert.deepEqual(parseGsData(encodeGsPick(tid, 2, DEAL)), { op: "gs", tid, ver: 2, dealId: DEAL });
  assert.deepEqual(parseGsData(encodeGsList(tid, 1, 10)), { op: "gl", tid, ver: 1, offset: 10 });
  assert.deepEqual(parseGsData(encodeGsManual(tid, 1)), { op: "gm", tid, ver: 1 });
  assert.deepEqual(parseGsData(encodeGsNone(tid, 1)), { op: "gn", tid, ver: 1 });
});
t("ほかのボタンの data は読まない", () => {
  for (const d of [`v1|sa|${DEAL}`, `v1|qa|abcdefghij|${DEAL}`, "v1|gs|XYZ|1|" + DEAL, `v1|gs|${tid}|0|${DEAL}`, `v1|gl|${tid}|1|501`, `v1|gm|${tid}`, "", "v1|gn|" + tid + "|1|x"])
    assert.equal(parseGsData(d), null, d);
});
t("受付票の検査（本文の欄は持たない）", () => {
  const ok = { no: 3, ver: 1, groupId: G, requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], read: null, state: "asking" };
  assert.equal(asTicket(ok)?.no, 3);
  assert.equal(asTicket(JSON.stringify(ok))?.state, "asking");
  assert.equal(asTicket({ ...ok, state: "x" }), null);
  assert.equal(asTicket(null), null);
});
console.log(`group-satei-data: ${n} ok`);
```

- [ ] **Step 2: 失敗を確かめる** — Run: `npx tsx tests/group-satei-data.test.ts` / Expected: モジュールが無くて失敗
- [ ] **Step 3: 実装**

```ts
/**
 * 普通のグループの査定依頼（2026-11-24 設計 docs/superpowers/specs/2026-11-24-group-satei-intake-design.md）：
 * スイッチ・定数・KV の鍵・受付票の型・ボタンの data。通信はしない。
 * - GROUP_SATEI=1 かつ GROUP_SATEI_GROUP_IDS に入ったグループだけ（既定 off）。
 * - 受付票に本文・ファイル名・お客様の名前は入れない（所在・物件名だけ）。
 */
import { createHash } from "node:crypto";
import { PAGE_ID_RE } from "./task-buttons";
import { parseAllowedUserIds } from "./webhook-source";

export type GsEnv = Record<string, string | undefined>;

export const groupSateiActive = (env: GsEnv = process.env) => env.GROUP_SATEI === "1";
export const groupSateiGroupIds = (env: GsEnv = process.env) => parseAllowedUserIds(env.GROUP_SATEI_GROUP_IDS);
export function groupSateiOn(groupId: string | undefined, env: GsEnv = process.env): boolean {
  return Boolean(groupId) && groupSateiActive(env) && groupSateiGroupIds(env).includes(groupId as string);
}

export const GS_TICKET_TTL = 7 * 24 * 60 * 60;
export const GS_MEDIA_TTL = 3 * 60 * 60;
export const GS_MEDIA_MAX = 30;
export const GS_MATERIALS_MAX = 8;
export const GS_READS_PER_DAY = 20;
export const GS_MIN = 0.5;
export const GS_SURE = 0.7;
export const GS_CANDIDATES_MAX = 5;
export const GS_PAGE = 10;
/** 本人の資料を束ねる幅（入口の発言の30分前〜1分後。後から来る分は段2） */
export const GS_BEFORE_MS = 30 * 60 * 1000;
export const GS_AFTER_MS = 60 * 1000;
// X-Line-Retry-Key の uuidv5 の名前空間（固定。変えると二重防止が効かなくなる）
export const GS_RETRY_NAMESPACE = "3f6a1c9e-8b2d-4e7f-a5c1-9d0e2b4f6a8c";

export const gsMediaKey = (groupId: string) => `gsatei:media:${groupId}`;
export const gsTicketKey = (tid: string) => `gsatei:t:${tid}`;
export const GS_SEQ_KEY = "gsatei:seq";
export const gsOpenKey = (groupId: string) => `gsatei:open:${groupId}`;
export const gsMsgKey = (messageId: string) => `gsatei:msg:${messageId}`;
export const gsDecKey = (tid: string) => `gsatei:dec:${tid}`;
export const gsReadsKey = (ymd: string) => `gsatei:reads:${ymd}`;

export const ticketIdOf = (messageId: string) => createHash("sha256").update(messageId).digest("hex").slice(0, 16);
export const receiptOf = (no: number) => `G${no}`;
export const gsEventId = (tid: string) => `gs${tid}`;

export type GsKind = "マンション" | "戸建" | "土地" | "不明";
export const GS_KINDS: readonly GsKind[] = ["マンション", "戸建", "土地", "不明"];
export type GsBasis = "本文" | "登記" | "地図" | "チラシ" | "その他";
export const GS_BASES: readonly GsBasis[] = ["本文", "登記", "地図", "チラシ", "その他"];

export interface GsRead {
  address: string | null;
  propertyName: string | null;
  kind: GsKind;
  basis: GsBasis;
  confidence: number;
}

/** グループ単位の控えの1行（ファイル名は持たない） */
export interface GsMedia {
  messageId: string;
  kind: "image" | "pdf" | "other";
  senderId: string;
  at: number;
  quoted?: string;
}

export type GsState = "asking" | "started" | "manual" | "dismissed";

export interface GsTicket {
  no: number;
  ver: number;
  groupId: string;
  requesterId: string;
  at: number;
  triggerMsgIds: string[];
  mediaIds: string[];
  read: GsRead | null;
  /** 読めなかった理由の符号（cap・read-failed・no-material 等）。読めたら無い */
  readFailed?: string;
  state: GsState;
  /** ［案件がまだ無い］の仮の決定（7日以内に1回だけ選び直せる） */
  provisional?: boolean;
  dealId?: string;
  jobNo?: number;
  /** portal の受付の結果が分からない */
  unknown?: boolean;
}

const STATES: readonly GsState[] = ["asking", "started", "manual", "dismissed"];

export function asTicket(raw: unknown): GsTicket | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const strs = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string");
  if (typeof r.no !== "number" || typeof r.ver !== "number" || typeof r.groupId !== "string") return null;
  if (typeof r.requesterId !== "string" || typeof r.at !== "number") return null;
  if (!strs(r.triggerMsgIds) || !strs(r.mediaIds) || !STATES.includes(r.state as GsState)) return null;
  return r as unknown as GsTicket;
}

export type GsAction =
  | { op: "gs"; tid: string; ver: number; dealId: string }
  | { op: "gl"; tid: string; ver: number; offset: number }
  | { op: "gm"; tid: string; ver: number }
  | { op: "gn"; tid: string; ver: number };

const TID_RE = /^[0-9a-f]{16}$/;
const VER_RE = /^[1-9][0-9]?$/;
const OFFSET_RE = /^(0|[1-9][0-9]{0,2})$/;
const OFFSET_MAX = 500;

export const encodeGsPick = (tid: string, ver: number, dealId: string) => `v1|gs|${tid}|${ver}|${dealId}`;
export const encodeGsList = (tid: string, ver: number, offset: number) => `v1|gl|${tid}|${ver}|${offset}`;
export const encodeGsManual = (tid: string, ver: number) => `v1|gm|${tid}|${ver}`;
export const encodeGsNone = (tid: string, ver: number) => `v1|gn|${tid}|${ver}`;

/** このカードのボタンの data を読む。形が違えば null（ほかのボタンは読まない） */
export function parseGsData(data: string): GsAction | null {
  if (!data || data.length > 300) return null;
  const p = data.split("|");
  if (p[0] !== "v1" || !TID_RE.test(p[2] ?? "") || !VER_RE.test(p[3] ?? "")) return null;
  const tid = p[2];
  const ver = Number(p[3]);
  if (p[1] === "gs") return p.length === 5 && PAGE_ID_RE.test(p[4]) ? { op: "gs", tid, ver, dealId: p[4] } : null;
  if (p[1] === "gl") {
    if (p.length !== 5 || !OFFSET_RE.test(p[4]) || Number(p[4]) > OFFSET_MAX) return null;
    return { op: "gl", tid, ver, offset: Number(p[4]) };
  }
  if (p[1] === "gm" && p.length === 4) return { op: "gm", tid, ver };
  if (p[1] === "gn" && p.length === 4) return { op: "gn", tid, ver };
  return null;
}
```
（`PAGE_ID_RE` が `0123abcd0123456789ab0123456789ab` の形を通すことは `satei-data.ts` の `sa` で確認済み）

- [ ] **Step 4: 通ることを確かめる** — Run: `npx tsx tests/group-satei-data.test.ts` / Expected: 全部 ok
- [ ] **Step 5: Commit** — `feat: グループの査定依頼の受付票とボタンの data の形を足す（既定 off）`

---

### Task 3: 入口の判定・控え・束ねる資料（`group-satei-gate.ts`）

**Files:**
- Create: `src/lib/group-satei-gate.ts`
- Test: `tests/group-satei-gate.test.ts`

**Interfaces:**
- Consumes: Task 2 の `groupSateiOn`・`GsMedia`・`GS_*`、`sateiNotifyTarget`（`./satei-data`）
- Produces:
  - `GS_WORDS: readonly string[]`（`["査定","価格を出して","いくらで売れ","売却価格","相場"]`）
  - `looksLikeSateiWords(text): boolean`
  - `gsEntryBGate(ev: {groupId?, senderId?, text}, env): {ok:true} | {ok:false; reason:"off"|"self"|"no-target"|"no-sender"|"words"}`
  - `gsEntryAOk(p: {groupId?, senderId?, isTask, requestType, confidence}, env): boolean`
  - `gsMediaRow(m: {messageId, groupId?, senderId?, type:"image"|"file", fileName?, at}): GsMedia | null`（対象外なら null）
  - `pickMaterials(media: GsMedia[], ev: {requesterId, at, triggerMsgIds: string[], quotedMessageId?}): string[]`

- [ ] **Step 1: テストを書く**

```ts
/** group-satei-gate.ts */
import assert from "node:assert/strict";
import { gsEntryAOk, gsEntryBGate, gsMediaRow, looksLikeSateiWords, pickMaterials } from "../src/lib/group-satei-gate";
import type { GsMedia } from "../src/lib/group-satei-data";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const G = "C" + "a".repeat(32);
const SHIMO = "U" + "b".repeat(32);
const BOSS = "U" + "c".repeat(32);
const YAMA = "U" + "d".repeat(32);
const ENV = { GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, TASK_SATEI_USER_IDS: SHIMO };
const NOW = 1_800_000_000_000;
const MIN = 60_000;

t("言葉の絞り込み", () => {
  for (const s of ["査定お願いできますか！", "いくらで売れるか見て", "売却価格を出して", "このあたりの相場は？", "価格を出してください"]) assert.ok(looksLikeSateiWords(s), s);
  for (const s of ["書類関連お願い致します！", "了解です", ""]) assert.ok(!looksLikeSateiWords(s), s);
});
t("入口 B：off・対象外・下村さん本人・言葉なし", () => {
  assert.deepEqual(gsEntryBGate({ groupId: G, senderId: BOSS, text: "査定お願い" }, {}), { ok: false, reason: "off" });
  assert.deepEqual(gsEntryBGate({ groupId: "C" + "e".repeat(32), senderId: BOSS, text: "査定お願い" }, ENV), { ok: false, reason: "off" });
  assert.deepEqual(gsEntryBGate({ groupId: G, senderId: SHIMO, text: "査定お願い" }, ENV), { ok: false, reason: "self" });
  assert.deepEqual(gsEntryBGate({ groupId: G, senderId: BOSS, text: "書類お願い" }, ENV), { ok: false, reason: "words" });
  assert.deepEqual(gsEntryBGate({ groupId: G, text: "査定お願い" }, ENV), { ok: false, reason: "no-sender" });
  assert.deepEqual(gsEntryBGate({ groupId: G, senderId: BOSS, text: "査定お願い" }, ENV), { ok: true });
});
t("入口 A：査定書・0.5以上・下村さん以外・対象グループ", () => {
  const p = { groupId: G, senderId: BOSS, isTask: true, requestType: "査定書", confidence: 0.6 };
  assert.ok(gsEntryAOk(p, ENV));
  assert.ok(!gsEntryAOk({ ...p, requestType: "その他" }, ENV));
  assert.ok(!gsEntryAOk({ ...p, confidence: 0.4 }, ENV));
  assert.ok(!gsEntryAOk({ ...p, isTask: false }, ENV));
  assert.ok(!gsEntryAOk({ ...p, senderId: SHIMO }, ENV));
  assert.ok(!gsEntryAOk(p, {}));
});
t("控えの1行：ファイル名を持たない・PDF かどうかだけ", () => {
  const r = gsMediaRow({ messageId: "f1", groupId: G, senderId: YAMA, type: "file", fileName: "坂本様_登記.pdf", at: NOW });
  assert.deepEqual(r, { messageId: "f1", kind: "pdf", senderId: YAMA, at: NOW });
  assert.ok(!JSON.stringify(r).includes("坂本"));
  assert.equal(gsMediaRow({ messageId: "f2", groupId: G, senderId: YAMA, type: "file", fileName: "x.xlsx", at: NOW })?.kind, "other");
  assert.equal(gsMediaRow({ messageId: "i1", groupId: G, senderId: BOSS, type: "image", at: NOW })?.kind, "image");
  assert.equal(gsMediaRow({ messageId: "i1", senderId: BOSS, type: "image", at: NOW }), null);
  assert.equal(gsMediaRow({ messageId: "i1", groupId: G, type: "image", at: NOW }), null);
});
t("束ねる資料：本人の30分前〜1分後・PDF と画像・other は読まない・8件まで・古い順", () => {
  const media: GsMedia[] = [
    { messageId: "old", kind: "image", senderId: BOSS, at: NOW - 31 * MIN },
    { messageId: "a", kind: "image", senderId: BOSS, at: NOW - 5 * MIN },
    { messageId: "x", kind: "other", senderId: BOSS, at: NOW - 4 * MIN },
    { messageId: "y", kind: "image", senderId: YAMA, at: NOW - 3 * MIN },
    { messageId: "b", kind: "pdf", senderId: BOSS, at: NOW + 30_000 },
    { messageId: "late", kind: "image", senderId: BOSS, at: NOW + 2 * MIN },
  ];
  assert.deepEqual(pickMaterials(media, { requesterId: BOSS, at: NOW, triggerMsgIds: ["m1"] }), ["a", "b"]);
  const many: GsMedia[] = Array.from({ length: 10 }, (_, i) => ({ messageId: `i${i}`, kind: "image", senderId: BOSS, at: NOW - (10 - i) * MIN }));
  assert.deepEqual(pickMaterials(many, { requesterId: BOSS, at: NOW, triggerMsgIds: ["m1"] }), ["i2", "i3", "i4", "i5", "i6", "i7", "i8", "i9"]);
});
t("束ねる資料：発言が引用した画像・発言を引用した資料は、別の人でも足す", () => {
  const media: GsMedia[] = [
    { messageId: "q", kind: "image", senderId: YAMA, at: NOW - 60 * MIN },
    { messageId: "r", kind: "pdf", senderId: YAMA, at: NOW - MIN, quoted: "m1" },
  ];
  assert.deepEqual(pickMaterials(media, { requesterId: BOSS, at: NOW, triggerMsgIds: ["m1"], quotedMessageId: "q" }), ["q", "r"]);
});
console.log(`group-satei-gate: ${n} ok`);
```

- [ ] **Step 2: 失敗を確かめる** — Run: `npx tsx tests/group-satei-gate.test.ts` / Expected: モジュールが無くて失敗
- [ ] **Step 3: 実装**

```ts
/**
 * 普通のグループの査定依頼：入口 A・B の判定、グループ単位の控えの1行、束ねる資料の選び方（段1）。通信はしない。
 * 束ねる資料（設計 7）：①依頼者本人の画像・PDF で入口の30分前〜1分後 ②入口の発言が引用した資料・入口の発言を引用した資料。
 * 引用の無い他人の資料（③）と、60分後までの後から来る資料は段2。
 */
import { GS_AFTER_MS, GS_BEFORE_MS, GS_MATERIALS_MAX, GS_MIN, groupSateiOn, type GsEnv, type GsMedia } from "./group-satei-data";
import { sateiNotifyTarget } from "./satei-data";

export const GS_WORDS: readonly string[] = ["査定", "価格を出して", "いくらで売れ", "売却価格", "相場"];

export function looksLikeSateiWords(text: string): boolean {
  const s = (text ?? "").replace(/[\s　]/g, "");
  return GS_WORDS.some((w) => s.includes(w));
}

export type GsSkip = "off" | "self" | "no-target" | "no-sender" | "words";

export function gsEntryBGate(
  ev: { groupId?: string; senderId?: string; text: string },
  env: GsEnv = process.env,
): { ok: true } | { ok: false; reason: GsSkip } {
  if (!groupSateiOn(ev.groupId, env)) return { ok: false, reason: "off" };
  const target = sateiNotifyTarget(env);
  if (!target) return { ok: false, reason: "no-target" };
  if (!ev.senderId) return { ok: false, reason: "no-sender" };
  if (ev.senderId === target) return { ok: false, reason: "self" };
  if (!looksLikeSateiWords(ev.text)) return { ok: false, reason: "words" };
  return { ok: true };
}

export function gsEntryAOk(
  p: { groupId?: string; senderId?: string; isTask: boolean; requestType: string; confidence: number },
  env: GsEnv = process.env,
): boolean {
  if (!groupSateiOn(p.groupId, env)) return false;
  const target = sateiNotifyTarget(env);
  if (!target || !p.senderId || p.senderId === target) return false;
  return p.isTask && p.requestType === "査定書" && p.confidence >= GS_MIN;
}

export function gsMediaRow(m: {
  messageId: string;
  groupId?: string;
  senderId?: string;
  type: "image" | "file";
  fileName?: string;
  at: number;
}): GsMedia | null {
  if (!m.groupId || !m.senderId || !m.messageId) return null;
  const kind = m.type === "image" ? "image" : /\.pdf$/i.test(m.fileName ?? "") ? "pdf" : "other";
  return { messageId: m.messageId, kind, senderId: m.senderId, at: m.at };
}

export function pickMaterials(
  media: GsMedia[],
  ev: { requesterId: string; at: number; triggerMsgIds: string[]; quotedMessageId?: string },
): string[] {
  const readable = media.filter((m) => m.kind === "image" || m.kind === "pdf");
  const picked = readable.filter(
    (m) =>
      (m.senderId === ev.requesterId && m.at >= ev.at - GS_BEFORE_MS && m.at <= ev.at + GS_AFTER_MS) ||
      (ev.quotedMessageId !== undefined && m.messageId === ev.quotedMessageId) ||
      (m.quoted !== undefined && ev.triggerMsgIds.includes(m.quoted)),
  );
  const uniq = picked.filter((m, i) => picked.findIndex((x) => x.messageId === m.messageId) === i);
  uniq.sort((a, b) => a.at - b.at);
  return uniq.slice(-GS_MATERIALS_MAX).map((m) => m.messageId);
}
```

- [ ] **Step 4: 通ることを確かめる** — Run: `npx tsx tests/group-satei-gate.test.ts` / Expected: 全部 ok
- [ ] **Step 5: Commit** — `feat: グループの査定依頼の入口の判定と束ねる資料の選び方を足す`

---

### Task 4: 資料の読み取り（`group-satei-read.ts`）

**Files:**
- Create: `src/lib/group-satei-read.ts`
- Test: `tests/group-satei-read.test.ts`

**Interfaces:**
- Consumes: `GsRead`・`GS_KINDS`・`GS_BASES`（Task 2）、`TaskAttachment`（`./claude`）
- Produces:
  - `GS_READ_PROMPT: string`
  - `scrubNames(s: string | null): string | null`（`様|邸|さん|氏|所有者|持分` を含めば null）
  - `parseGsReadText(text: string): GsRead`（形が違えば例外）
  - `readGsMaterials(attachments: TaskAttachment[], text: string, today: string, create: (req) => Promise<{content: Array<{type:string; text?:string}>}>): Promise<GsRead>`

- [ ] **Step 1: テストを書く**

```ts
/** group-satei-read.ts（AI は差し替え） */
import assert from "node:assert/strict";
import { GS_READ_PROMPT, parseGsReadText, readGsMaterials, scrubNames } from "../src/lib/group-satei-read";

let n = 0;
const t = async (name: string, f: () => void | Promise<void>) => { await f(); n++; console.log("ok", name); };

(async () => {
  await t("指示文に名前を出さない指示がある", () => assert.match(GS_READ_PROMPT, /名前/));
  await t("名前らしいものは捨てる", () => {
    assert.equal(scrubNames("坂本様邸"), null);
    assert.equal(scrubNames("所有者 山田"), null);
    assert.equal(scrubNames("大阪市旭区大宮1丁目3番27"), "大阪市旭区大宮1丁目3番27");
    assert.equal(scrubNames(""), null);
  });
  await t("答えの検査：正しい形", () => {
    const r = parseGsReadText('前置き {"所在":"大阪市北区1-2","物件名":null,"種別の見込み":"戸建","根拠":"登記","確信度":0.8} 後ろ');
    assert.deepEqual(r, { address: "大阪市北区1-2", propertyName: null, kind: "戸建", basis: "登記", confidence: 0.8 });
  });
  await t("答えの検査：知らない種別・根拠は 不明・その他 に寄せる／名前は捨てる", () => {
    const r = parseGsReadText('{"所在":"山田様方","物件名":"サウスオールシティ1203","種別の見込み":"ビル","根拠":"謎","確信度":0.3}');
    assert.deepEqual(r, { address: null, propertyName: "サウスオールシティ1203", kind: "不明", basis: "その他", confidence: 0.3 });
  });
  await t("答えの検査：確信度が無い・範囲外・JSON でない → 例外", () => {
    assert.throws(() => parseGsReadText('{"所在":"x","種別の見込み":"戸建","根拠":"登記"}'));
    assert.throws(() => parseGsReadText('{"所在":"x","種別の見込み":"戸建","根拠":"登記","確信度":2}'));
    assert.throws(() => parseGsReadText("読めません"));
  });
  await t("AI に渡す中身：添付と指示文と本文", async () => {
    let seen: any = null;
    const r = await readGsMaterials(
      [{ kind: "image", mediaType: "image/png", base64: "AAAA" }, { kind: "pdf", mediaType: "application/pdf", base64: "BBBB" }],
      "査定お願いできますか",
      "2026-11-24（月）",
      async (req) => {
        seen = req;
        return { content: [{ type: "text", text: '{"所在":"大阪市北区1-2","物件名":null,"種別の見込み":"土地","根拠":"地図","確信度":0.9}' }] };
      },
    );
    assert.equal(r.kind, "土地");
    assert.equal(seen.system, GS_READ_PROMPT);
    assert.equal(seen.messages[0].content[0].type, "image");
    assert.equal(seen.messages[0].content[1].type, "document");
    assert.match(seen.messages[0].content[2].text, /査定お願いできますか/);
  });
  console.log(`group-satei-read: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 失敗を確かめる** — Run: `npx tsx tests/group-satei-read.test.ts` / Expected: モジュールが無くて失敗
- [ ] **Step 3: 実装**

```ts
/**
 * 普通のグループの査定依頼：束ねた資料（画像・PDF）と本文から、所在・物件名・種別の見込みを読む（設計 8.1）。
 * 渡す先は Anthropic（Claude）だけ。人の名前は指示文で出させず、さらにコードで名前らしい値を捨てる。
 * AI の呼び出しは create を受け取る（本物は group-satei-wire.ts が Anthropic の client.messages.create を渡す）。
 */
import type { TaskAttachment } from "./claude";
import { GS_BASES, GS_KINDS, type GsBasis, type GsKind, type GsRead } from "./group-satei-data";

export const GS_READ_MODEL = "claude-sonnet-4-6";

export const GS_READ_PROMPT = `あなたは不動産会社の査定の受付係です。LINE のグループに届いた査定の依頼と、添付の資料（写真・登記・地図・チラシ）から、査定する物件を読み取ります。
次の JSON だけを返してください（説明文は要りません）。
{"所在": 住居表示か地番（例「大阪市旭区大宮1丁目3番27」）。分からなければ null,
 "物件名": マンション名と号室（例「サウスオールシティ1203」）。無ければ null,
 "種別の見込み": "マンション" | "戸建" | "土地" | "不明"（登記の「区分建物」はマンション、「居宅」は戸建、「宅地」だけなら土地）,
 "根拠": "本文" | "登記" | "地図" | "チラシ" | "その他",
 "確信度": 0〜1 の数}
所有者・売主・人の名前は、どの欄にも書かないでください。`;

const NAME_RE = /様|邸|さん|氏|所有者|持分/;

export function scrubNames(s: string | null | undefined): string | null {
  const v = typeof s === "string" ? s.trim() : "";
  if (!v || NAME_RE.test(v)) return null;
  return Array.from(v).slice(0, 80).join("");
}

export function parseGsReadText(text: string): GsRead {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no-json");
  const o = JSON.parse(m[0]) as Record<string, unknown>;
  const c = o["確信度"];
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) throw new Error("bad-confidence");
  const kind = GS_KINDS.includes(o["種別の見込み"] as GsKind) ? (o["種別の見込み"] as GsKind) : "不明";
  const basis = GS_BASES.includes(o["根拠"] as GsBasis) ? (o["根拠"] as GsBasis) : "その他";
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  return { address: scrubNames(str(o["所在"])), propertyName: scrubNames(str(o["物件名"])), kind, basis, confidence: c };
}

export interface GsCreateReq {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user"; content: Array<Record<string, unknown>> }>;
}
export type GsCreate = (req: GsCreateReq) => Promise<{ content: Array<{ type: string; text?: string }> }>;

export async function readGsMaterials(
  attachments: TaskAttachment[],
  text: string,
  today: string,
  create: GsCreate,
): Promise<GsRead> {
  const content: Array<Record<string, unknown>> = attachments.map((a) =>
    a.kind === "image"
      ? { type: "image", source: { type: "base64", media_type: a.mediaType, data: a.base64 } }
      : { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.base64 } },
  );
  content.push({
    type: "text",
    text: `今日（日本時間）: ${today}\n添付: ${attachments.length}件\n\nLINE の依頼の本文:\n${text || "（本文なし）"}`,
  });
  const res = await create({
    model: GS_READ_MODEL,
    max_tokens: 512,
    system: GS_READ_PROMPT,
    messages: [{ role: "user", content }],
  });
  const out = res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  return parseGsReadText(out);
}
```

- [ ] **Step 4: 通ることを確かめる** — Run: `npx tsx tests/group-satei-read.test.ts` / Expected: 全部 ok
- [ ] **Step 5: Commit** — `feat: グループの査定依頼の資料から所在・物件名・種別の見込みを読む指示文を足す`

---

### Task 5: 知らせの文とカード（`group-satei-card.ts`）

**Files:**
- Create: `src/lib/group-satei-card.ts`
- Test: `tests/group-satei-card.test.ts`

**Interfaces:**
- Consumes: Task 2 の型・`encodeGs*`・`receiptOf`・`GS_SURE`・`GS_PAGE`、`ALT_TEXT_MAX`・`FLEX_LABEL_MAX`・`POSTBACK_TEXT_MAX`・`FlexMessage`（`./task-card`）、`DealRef`（`./task-record`）
- Produces:
  - `gsNoticeText(o: {no, at, requesterName: string|null, read: GsRead|null, readFailed?: string, materials: {images, pdfs, others: number}}): string`
  - `gsCandidate = {deal: DealRef; kind: string|null}`
  - `gsCard(tid, ver, cands: gsCandidate[], dealsFailed: boolean): FlexMessage`
  - `gsListCard(tid, ver, no, deals: DealRef[], offset): FlexMessage | null`
  - `gsPickLabel(name, kind): string`
  - 返事の文：`MSG_GS_PAUSED`, `MSG_GS_FORBIDDEN`, `MSG_GS_EXPIRED`, `MSG_GS_STALE`, `MSG_GS_BUSY`, `MSG_GS_DEALS_FAILED`, `msgGsAlready(no)`, `msgGsManual(no, kind)`, `msgGsNoDeal(no)`, `msgGsDismissed(no)`, `msgGsKindMismatch(readKind)`, `MSG_GS_UNKNOWN`

- [ ] **Step 1: テストを書く**

```ts
/** group-satei-card.ts */
import assert from "node:assert/strict";
import { gsCard, gsListCard, gsNoticeText, gsPickLabel, msgGsManual } from "../src/lib/group-satei-card";
import { parseGsData, ticketIdOf } from "../src/lib/group-satei-data";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const tid = ticketIdOf("m1");
const AT = Date.UTC(2026, 10, 23, 2, 55); // JST 11/23 11:55
const D1 = { id: "0123abcd0123456789ab0123456789ab", name: "大宮1丁目 戸建", phase: "査定" };
const D2 = { id: "1123abcd0123456789ab0123456789ab", name: "サウスオールシティ｜1203", phase: "媒介" };

t("知らせの文（大宮の形・作り物）", () => {
  const s = gsNoticeText({ no: 7, at: AT, requesterName: "前田", read: { address: "大阪市北区テスト1丁目2", propertyName: null, kind: "戸建", basis: "登記", confidence: 0.9 }, materials: { images: 2, pdfs: 1, others: 0 } });
  assert.match(s, /査定の依頼がありました/);
  assert.match(s, /11\/23 11:55・前田さん（受付 G7）/);
  assert.match(s, /読み取った物件：大阪市北区テスト1丁目2/);
  assert.match(s, /種別の見込み：戸建（登記から）/);
  assert.match(s, /資料：画像2枚・PDF1件/);
});
t("確信度が低いと「かもしれません」", () => {
  const s = gsNoticeText({ no: 1, at: AT, requesterName: null, read: { address: null, propertyName: "X", kind: "不明", basis: "本文", confidence: 0.6 }, materials: { images: 0, pdfs: 0, others: 0 } });
  assert.match(s, /査定の依頼かもしれません/);
  assert.ok(!s.includes("さん（"));
});
t("読めなかったときも黙らない", () => {
  const s = gsNoticeText({ no: 2, at: AT, requesterName: null, read: null, readFailed: "cap", materials: { images: 1, pdfs: 0, others: 0 } });
  assert.match(s, /資料を読めませんでした（本日の上限）/);
});
t("ボタンの言葉で結果が分かる", () => {
  assert.match(gsPickLabel("サウスオールシティ", "マンション"), /で査定書を作る$/);
  assert.match(gsPickLabel("大宮", "戸建"), /で進める（手作業）$/);
  assert.match(gsPickLabel("大宮", null), /で進める$/);
  assert.ok(Array.from(gsPickLabel("あ".repeat(60), "マンション")).length <= 40);
});
t("カード：候補＋一覧＋案件がまだ無い＋査定ではない、data は読める", () => {
  const c = gsCard(tid, 1, [{ deal: D1, kind: "戸建" }, { deal: D2, kind: "マンション" }], false);
  const btns = (c.contents as any).footer.contents;
  assert.equal(btns.length, 5);
  const ops = btns.map((b: any) => parseGsData(b.action.data)?.op);
  assert.deepEqual(ops, ["gs", "gs", "gl", "gm", "gn"]);
});
t("候補が無ければ一覧・案件なし・査定ではない の3つ", () => {
  const c = gsCard(tid, 1, [], true);
  assert.equal((c.contents as any).footer.contents.length, 3);
  assert.match(JSON.stringify(c), /CRM の案件を確かめられませんでした/);
});
t("一覧のカード：10件＋次の10件", () => {
  const deals = Array.from({ length: 12 }, (_, i) => ({ id: `${String(i).padStart(2, "0")}23abcd0123456789ab0123456789ab`, name: `案件${String(i).padStart(2, "0")}` }));
  const c = gsListCard(tid, 1, 7, deals, 0)!;
  assert.equal((c.contents as any).contents.length, 11);
  assert.equal(gsListCard(tid, 1, 7, deals, 20), null);
});
t("手作業の返事", () => {
  assert.match(msgGsManual(7, "戸建"), /戸建のため自動作成はできません。手作業の査定に回します/);
  assert.match(msgGsManual(7, "土地"), /土地のため/);
  assert.match(msgGsManual(7, null), /物件の種別が分からないため/);
});
console.log(`group-satei-card: ${n} ok`);
```
注：「カード」のテストのボタンは、候補2件＋固定3つ＝5。

- [ ] **Step 2: 失敗を確かめる** — Run: `npx tsx tests/group-satei-card.test.ts` / Expected: モジュールが無くて失敗
- [ ] **Step 3: 実装**

```ts
/**
 * 普通のグループの査定依頼：下村さんへの知らせの文・候補のカード・一覧のカード・ボタンの返事（設計 8.3〜8.4）。
 * お客様の名前・本文は入れない。依頼者は名簿の正式氏名だけ（呼ぶ側が渡す）。
 */
import {
  encodeGsList, encodeGsManual, encodeGsNone, encodeGsPick, GS_PAGE, GS_SURE, receiptOf, type GsRead,
} from "./group-satei-data";
import type { DealRef } from "./task-record";
import { ALT_TEXT_MAX, FLEX_LABEL_MAX, POSTBACK_TEXT_MAX, type FlexMessage } from "./task-card";

const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");
const NAME_MAX = 60;

function jst(at: number): string {
  const d = new Date(at + 9 * 60 * 60 * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const FAILED_TEXT: Record<string, string> = {
  cap: "資料を読めませんでした（本日の上限）。LINE のグループで確かめてください。",
};

export function gsNoticeText(o: {
  no: number;
  at: number;
  requesterName: string | null;
  read: GsRead | null;
  readFailed?: string;
  materials: { images: number; pdfs: number; others: number };
}): string {
  const sure = o.read ? o.read.confidence >= GS_SURE : true;
  const lines = [`🏠 LINE のグループで査定の依頼${sure ? "がありました" : "かもしれません"}`];
  lines.push(`${jst(o.at)}${o.requesterName ? `・${cut(o.requesterName, 20)}さん` : ""}（受付 ${receiptOf(o.no)}）`);
  if (o.read) {
    const what = o.read.propertyName ?? o.read.address;
    lines.push(`読み取った物件：${what ? cut(what, NAME_MAX) : "分かりませんでした"}`);
    if (o.read.propertyName && o.read.address) lines.push(`所在：${cut(o.read.address, NAME_MAX)}`);
    lines.push(`種別の見込み：${o.read.kind}（${o.read.basis}から）`);
  } else {
    lines.push(FAILED_TEXT[o.readFailed ?? ""] ?? "資料を読めませんでした。LINE のグループで確かめてください。");
  }
  const m = o.materials;
  const parts = [m.images ? `画像${m.images}枚` : "", m.pdfs ? `PDF${m.pdfs}件` : ""].filter(Boolean);
  lines.push(`資料：${parts.length ? parts.join("・") : "なし（本文だけ）"}`);
  lines.push("どの案件か選んでください。");
  return lines.join("\n");
}

export function gsPickLabel(name: string, kind: string | null): string {
  const tail = kind === "マンション" ? "で査定書を作る" : kind === "戸建" || kind === "土地" ? "で進める（手作業）" : "で進める";
  const room = FLEX_LABEL_MAX - Array.from(tail).length;
  return `${cut(name, room)}${tail}`;
}

const button = (label: string, data: string, primary = false) => ({
  type: "button",
  style: primary ? "primary" : "secondary",
  height: "sm",
  action: { type: "postback", label: cut(label, FLEX_LABEL_MAX), data, displayText: cut(`（ボタン）${label}`, POSTBACK_TEXT_MAX) },
});
const small = (text: string, color = "#555555") => ({ type: "text", text, size: "sm", color, wrap: true });

export interface GsCandidate {
  deal: DealRef;
  kind: string | null;
}

export function gsCard(tid: string, ver: number, cands: GsCandidate[], dealsFailed: boolean): FlexMessage {
  const guide =
    cands.length > 0
      ? "どの案件ですか？"
      : dealsFailed
        ? "CRM の案件を確かめられませんでした。一覧から選んでください"
        : "名前の合う進行中の案件が見つかりませんでした。一覧から選んでください";
  return {
    type: "flex",
    altText: cut("査定の依頼：どの案件か選んでください", ALT_TEXT_MAX),
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "sm", contents: [small(guide, "#333333")] },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          ...cands.map((c) => button(gsPickLabel(c.deal.name, c.kind), encodeGsPick(tid, ver, c.deal.id), true)),
          button("一覧から選ぶ", encodeGsList(tid, ver, 0)),
          button("案件がまだ無い（手作業で査定）", encodeGsManual(tid, ver)),
          button("査定の依頼ではない", encodeGsNone(tid, ver)),
        ],
      },
    },
  };
}

export function gsListCard(tid: string, ver: number, no: number, deals: DealRef[], offset: number): FlexMessage | null {
  const sorted = [...deals].sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const page = sorted.slice(offset, offset + GS_PAGE);
  if (page.length === 0) return null;
  const bubbles: Array<Record<string, unknown>> = page.map((d) => ({
    type: "bubble",
    size: "kilo",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: `🏢 ${cut(d.name, NAME_MAX)}`, weight: "bold", size: "sm", wrap: true },
        ...(d.phase ? [small(`フェーズ：${cut(d.phase, 30)}`)] : []),
      ],
    },
    footer: { type: "box", layout: "vertical", contents: [button("この案件で進める", encodeGsPick(tid, ver, d.id), true)] },
  }));
  const rest = sorted.length - offset - page.length;
  if (rest > 0 && offset + GS_PAGE <= 500) {
    bubbles.push({
      type: "bubble",
      size: "kilo",
      body: { type: "box", layout: "vertical", contents: [small(`残り${rest}件`)] },
      footer: { type: "box", layout: "vertical", contents: [button("次の10件", encodeGsList(tid, ver, offset + GS_PAGE))] },
    });
  }
  return { type: "flex", altText: cut(`どの案件ですか（${receiptOf(no)}）`, ALT_TEXT_MAX), contents: { type: "carousel", contents: bubbles } };
}

export const MSG_GS_PAUSED = "いまは止めています";
export const MSG_GS_FORBIDDEN = "いまは下村さんだけが使えます";
export const MSG_GS_EXPIRED = "この査定の依頼は期限が切れています（7日）";
export const MSG_GS_STALE = "新しいカードが届いています。そちらから選んでください";
export const MSG_GS_BUSY = "いま操作を受け付けられません。少し待ってからもう一度押してください";
export const MSG_GS_DEALS_FAILED = "案件を読み取れませんでした。少し待ってからもう一度押してください";
export const MSG_GS_NOT_ACTIVE = "この案件は進行中の一覧にありません。［一覧から選ぶ］から選び直してください";
export const MSG_GS_UNKNOWN = "結果を確かめられませんでした。portal の依頼箱で確かめてください";
export const msgGsAlready = (no: number) => `選択済みです（受付 ${receiptOf(no)}）`;
export const msgGsManual = (no: number, kind: string | null) =>
  kind === "戸建" || kind === "土地"
    ? `${kind}のため自動作成はできません。手作業の査定に回します（受付 ${receiptOf(no)}）`
    : `物件の種別が分からないため自動では作れません。手作業の査定に回します（受付 ${receiptOf(no)}）。CRM_物件 の種別を入れると、次からは自動で判断します`;
export const msgGsNoDeal = (no: number) =>
  `手作業の査定に回します（受付 ${receiptOf(no)}）。CRM_案件 を作ったあとなら、このカードの［一覧から選ぶ］で選び直せます（7日間）`;
export const msgGsDismissed = (no: number) => `査定の依頼ではないとして閉じました（受付 ${receiptOf(no)}）`;
export const msgGsKindMismatch = (readKind: string) => `資料からは${readKind}に見えます。CRM_物件 の種別を確かめてください`;
export const MSG_GS_NO_FOLDER = "案件の Driveフォルダが未設定です。設定してから、もう一度押してください";
```

- [ ] **Step 4: 通ることを確かめる** — Run: `npx tsx tests/group-satei-card.test.ts` / Expected: 全部 ok
- [ ] **Step 5: Commit** — `feat: グループの査定依頼の知らせの文と案件のカードを足す`

---

### Task 6: 受付票を開く（`group-satei-open.ts`）

**Files:**
- Create: `src/lib/group-satei-open.ts`
- Test: `tests/group-satei-open.test.ts`

**Interfaces:**
- Consumes: Task 2〜5、`candidateDeals`（`./task-record`）、`normalizeProperty`（`./property`）、`sateiNotifyTarget`（`./satei-data`）
- Produces:
  - `GsOpenEvent = {messageId, groupId, requesterId, at, text, entry: "A"|"B", quotedMessageId?}`
  - `GsKv`（`get, set(key,val,ex), setNx(key,val,ex): boolean, incr(key): number, expire(key,ex), sadd(key,member), lpushTrim(key,val,max,ex), lrange(key): unknown[]`）
  - `GsOpenDeps = {env?, kv: GsKv|null, now(): number, today(): string, ymd(): string, read(mediaIds, text): Promise<GsRead>, loadDeals(): Promise<DealRef[]>, kindOf(dealId): Promise<string|null>, requesterName(userId): Promise<string|null>, push(to, messages, retryKey): Promise<boolean>, log(line)}`
  - `openGroupSatei(ev, deps): Promise<"opened"|"duplicate"|"skip">`（例外は投げない）
  - `recordGroupSateiMedia(row: GsMedia, groupId, kv: GsKv|null, log): Promise<void>`

- [ ] **Step 1: テストを書く**（作り物の KV を中に持つ）

```ts
/** group-satei-open.ts（KV・AI・CRM・LINE は差し替え） */
import assert from "node:assert/strict";
import { openGroupSatei, recordGroupSateiMedia, type GsKv, type GsOpenDeps } from "../src/lib/group-satei-open";
import { asTicket, gsMediaKey, gsTicketKey, parseGsData, ticketIdOf, type GsRead } from "../src/lib/group-satei-data";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const G = "C" + "a".repeat(32);
const SHIMO = "U" + "b".repeat(32);
const BOSS = "U" + "c".repeat(32);
const ENV = { GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, TASK_SATEI_USER_IDS: SHIMO, TASK_SATEI: "1" };
const NOW = 1_800_000_000_000;
// 読んだ物件名と完全一致する名前にしておく（normalizeProperty の部分一致の規則にテストが左右されないため）
const D1 = { id: "0123abcd0123456789ab0123456789ab", name: "テスト町1丁目", phase: "査定" };

function fakeKv() {
  const m = new Map<string, unknown>();
  const kv: GsKv = {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => { m.set(k, v); },
    setNx: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
    incr: async (k) => { const v = Number(m.get(k) ?? 0) + 1; m.set(k, v); return v; },
    expire: async () => undefined,
    sadd: async (k, v) => { const s = (m.get(k) as Set<string>) ?? new Set(); s.add(v); m.set(k, s); },
    lpushTrim: async (k, v, max) => { const a = ((m.get(k) as unknown[]) ?? []); a.push(v); m.set(k, a.slice(-max)); },
    lrange: async (k) => ((m.get(k) as unknown[]) ?? []),
  };
  return { kv, m };
}
const READ: GsRead = { address: "大阪市北区テスト1丁目2", propertyName: "テスト町1丁目", kind: "戸建", basis: "登記", confidence: 0.9 };

function mk(o: { read?: GsRead | "throw"; deals?: "throw"; push?: boolean; reads?: number } = {}) {
  const { kv, m } = fakeKv();
  const logs: string[] = [];
  const pushes: Array<{ to: string; messages: unknown[]; key: string }> = [];
  const readCalls: string[][] = [];
  if (o.reads) m.set("gsatei:reads:2026-11-24", o.reads);
  const deps: GsOpenDeps = {
    env: ENV,
    kv,
    now: () => NOW,
    today: () => "2026-11-24",
    ymd: () => "2026-11-24",
    read: async (ids) => { readCalls.push(ids); if (o.read === "throw") throw new Error("x"); return o.read ?? READ; },
    loadDeals: async () => { if (o.deals === "throw") throw new Error("x"); return [D1]; },
    kindOf: async () => "戸建",
    requesterName: async () => "前田",
    push: async (to, messages, key) => { pushes.push({ to, messages, key }); return o.push ?? true; },
    log: (l) => logs.push(l),
  };
  return { deps, kv, m, logs, pushes, readCalls };
}
const ev = (over = {}) => ({ messageId: "m1", groupId: G, requesterId: BOSS, at: NOW, text: "査定お願いできますか", entry: "B" as const, ...over });

(async () => {
  await t("控え：対象グループだけ・30件まで", async () => {
    const { kv, m } = mk();
    for (let i = 0; i < 35; i++) await recordGroupSateiMedia({ messageId: `i${i}`, kind: "image", senderId: BOSS, at: NOW }, G, kv, () => undefined);
    assert.equal((m.get(gsMediaKey(G)) as unknown[]).length, 30);
  });
  await t("開く：受付票・知らせ・カードを下村さんへ1回", async () => {
    const x = mk();
    await recordGroupSateiMedia({ messageId: "img1", kind: "image", senderId: BOSS, at: NOW - 60_000 }, G, x.kv, () => undefined);
    assert.equal(await openGroupSatei(ev(), x.deps), "opened");
    const tk = asTicket(x.m.get(gsTicketKey(ticketIdOf("m1"))))!;
    assert.equal(tk.state, "asking");
    assert.equal(tk.no, 1);
    assert.deepEqual(tk.mediaIds, ["img1"]);
    assert.equal(tk.read?.kind, "戸建");
    assert.deepEqual(x.readCalls, [["img1"]]);
    assert.equal(x.pushes.length, 1);
    assert.equal(x.pushes[0].to, SHIMO);
    assert.equal(x.pushes[0].messages.length, 2);
    const btn = (x.pushes[0].messages[1] as any).contents.footer.contents[0];
    assert.equal(parseGsData(btn.action.data)?.op, "gs");
    assert.match(btn.action.label, /で進める（手作業）$/);
    assert.ok(x.logs.some((l) => /^\[group-satei\] ticket G1 opened/.test(l)));
  });
  await t("同じ発言で二度開かない", async () => {
    const x = mk();
    await openGroupSatei(ev(), x.deps);
    assert.equal(await openGroupSatei(ev(), x.deps), "duplicate");
    assert.equal(x.pushes.length, 1);
  });
  await t("読めなくても黙らない（カードは一覧・案件なし・査定ではない）", async () => {
    const x = mk({ read: "throw" });
    await openGroupSatei(ev(), x.deps);
    assert.match((x.pushes[0].messages[0] as any).text, /資料を読めませんでした/);
    assert.equal((x.pushes[0].messages[1] as any).contents.footer.contents.length, 3);
  });
  await t("1日20回の上限を超えたら読まない", async () => {
    const x = mk({ reads: 20 });
    await openGroupSatei(ev(), x.deps);
    assert.equal(x.readCalls.length, 0);
    assert.match((x.pushes[0].messages[0] as any).text, /本日の上限/);
  });
  await t("CRM が読めなくても知らせる", async () => {
    const x = mk({ deals: "throw" });
    await openGroupSatei(ev(), x.deps);
    assert.match(JSON.stringify(x.pushes[0].messages[1]), /CRM の案件を確かめられませんでした/);
  });
  await t("KV が無ければ何もしない", async () => {
    const x = mk();
    assert.equal(await openGroupSatei(ev(), { ...x.deps, kv: null }), "skip");
    assert.equal(x.pushes.length, 0);
  });
  await t("off なら何もしない（KV も読まない）", async () => {
    const x = mk();
    let touched = false;
    const kv = new Proxy(x.kv, { get: (o, p) => { touched = true; return (o as any)[p]; } });
    assert.equal(await openGroupSatei(ev(), { ...x.deps, env: {}, kv }), "skip");
    assert.equal(touched, false);
  });
  await t("AI の答えに名前があっても KV・ログ・カードに出ない", async () => {
    const x = mk({ read: { ...READ, address: null, propertyName: null } });
    await openGroupSatei(ev({ text: "坂本様の家の査定" }), x.deps);
    const all = JSON.stringify([...x.m.values()].map((v) => (v instanceof Set ? [...v] : v))) + x.logs.join() + JSON.stringify(x.pushes);
    assert.ok(!all.includes("坂本"));
  });
  console.log(`group-satei-open: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 失敗を確かめる** — Run: `npx tsx tests/group-satei-open.test.ts` / Expected: モジュールが無くて失敗
- [ ] **Step 3: 実装**

```ts
/**
 * 普通のグループの査定依頼：受付票を開く（設計 6.2・7・8.1〜8.3。段1）。
 * 順番：スイッチ → KV → 受付票の予約（同じ発言では1回）→ 資料を束ねる → 1日の上限 → 読み取り → 候補 → 下村さんへ push。
 * 例外は投げない（ほかの流れを止めない）。本文・名前・ID はログに出さない。
 */
import { candidateDeals, type DealRef } from "./task-record";
import { normalizeProperty } from "./property";
import { sateiNotifyTarget } from "./satei-data";
import {
  GS_CANDIDATES_MAX, GS_MEDIA_MAX, GS_MEDIA_TTL, GS_READS_PER_DAY, GS_SEQ_KEY, GS_TICKET_TTL,
  groupSateiOn, gsMediaKey, gsMsgKey, gsOpenKey, gsReadsKey, gsTicketKey, receiptOf, ticketIdOf,
  type GsEnv, type GsMedia, type GsRead, type GsTicket,
} from "./group-satei-data";
import { pickMaterials } from "./group-satei-gate";
import { gsCard, gsNoticeText, type GsCandidate } from "./group-satei-card";

export interface GsKv {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ex: number): Promise<void>;
  setNx(key: string, value: unknown, ex: number): Promise<boolean>;
  incr(key: string): Promise<number>;
  expire(key: string, ex: number): Promise<void>;
  sadd(key: string, member: string): Promise<void>;
  /** 末尾に足し、max 件に切り、期限を付け直す */
  lpushTrim(key: string, value: unknown, max: number, ex: number): Promise<void>;
  lrange(key: string): Promise<unknown[]>;
}

export interface GsOpenEvent {
  messageId: string;
  groupId: string;
  requesterId: string;
  at: number;
  text: string;
  entry: "A" | "B";
  quotedMessageId?: string;
}

export interface GsOpenDeps {
  env?: GsEnv;
  kv: GsKv | null;
  now(): number;
  today(): string;
  ymd(): string;
  /** 画像・PDF を取り、Claude で読む。1件でも取れない・読めなければ例外 */
  read(mediaIds: string[], text: string): Promise<GsRead>;
  loadDeals(): Promise<DealRef[]>;
  /** 案件の物件の1件目の CRM_物件 の種別。読めなければ null */
  kindOf(dealId: string): Promise<string | null>;
  requesterName(userId: string): Promise<string | null>;
  push(to: string, messages: unknown[], retryKey: string): Promise<boolean>;
  log(line: string): void;
}

function asMedia(v: unknown): GsMedia | null {
  let x = v;
  if (typeof x === "string") {
    try {
      x = JSON.parse(x);
    } catch {
      return null;
    }
  }
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (typeof r.messageId !== "string" || typeof r.senderId !== "string" || typeof r.at !== "number") return null;
  if (r.kind !== "image" && r.kind !== "pdf" && r.kind !== "other") return null;
  return r as unknown as GsMedia;
}

export async function recordGroupSateiMedia(row: GsMedia, groupId: string, kv: GsKv | null, log: (l: string) => void): Promise<void> {
  if (!kv) return;
  try {
    await kv.lpushTrim(gsMediaKey(groupId), row, GS_MEDIA_MAX, GS_MEDIA_TTL);
  } catch {
    log("[group-satei] skip:media-kv");
  }
}

async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); })]);
  } finally {
    clearTimeout(t);
  }
}

export async function openGroupSatei(ev: GsOpenEvent, deps: GsOpenDeps): Promise<"opened" | "duplicate" | "skip"> {
  const env = deps.env ?? process.env;
  if (!groupSateiOn(ev.groupId, env)) return "skip";
  const target = sateiNotifyTarget(env);
  const kv = deps.kv;
  if (!target || !kv) {
    deps.log(`[group-satei] skip:${kv ? "no-target" : "kv"}`);
    return "skip";
  }
  const tid = ticketIdOf(ev.messageId);
  let ticket: GsTicket;
  try {
    if (await kv.get(gsTicketKey(tid))) {
      deps.log("[group-satei] skip:duplicate");
      return "duplicate";
    }
    const no = await kv.incr(GS_SEQ_KEY);
    ticket = { no, ver: 1, groupId: ev.groupId, requesterId: ev.requesterId, at: ev.at, triggerMsgIds: [ev.messageId], mediaIds: [], read: null, state: "asking" };
    if (!(await kv.setNx(gsTicketKey(tid), ticket, GS_TICKET_TTL))) {
      deps.log("[group-satei] skip:duplicate");
      return "duplicate";
    }
  } catch {
    deps.log("[group-satei] skip:kv");
    return "skip";
  }
  const receipt = receiptOf(ticket.no);
  let media: GsMedia[] = [];
  try {
    media = (await kv.lrange(gsMediaKey(ev.groupId))).map(asMedia).filter((m): m is GsMedia => m !== null);
  } catch {
    deps.log(`[group-satei] ticket ${receipt} media-kv-failed`);
  }
  ticket.mediaIds = pickMaterials(media, { requesterId: ev.requesterId, at: ev.at, triggerMsgIds: ticket.triggerMsgIds, quotedMessageId: ev.quotedMessageId });
  const kinds = ticket.mediaIds.map((id) => media.find((m) => m.messageId === id)?.kind);
  const materials = { images: kinds.filter((k) => k === "image").length, pdfs: kinds.filter((k) => k === "pdf").length, others: 0 };

  // 1日の上限（数えるのは読む前）
  let capped = false;
  try {
    const n = await kv.incr(gsReadsKey(deps.ymd()));
    await kv.expire(gsReadsKey(deps.ymd()), 2 * 24 * 60 * 60);
    capped = n > GS_READS_PER_DAY;
  } catch {
    capped = true;
  }
  if (capped) ticket.readFailed = "cap";
  else {
    try {
      ticket.read = await deps.read(ticket.mediaIds, ev.text);
    } catch {
      ticket.readFailed = "read-failed";
    }
  }

  let cands: GsCandidate[] = [];
  let dealsFailed = false;
  try {
    const deals = await within(deps.loadDeals(), 8_000);
    const keys = [ticket.read?.propertyName, ticket.read?.address].map((s) => normalizeProperty(s ?? "")).filter(Boolean);
    const hits: DealRef[] = [];
    for (const k of keys) for (const d of candidateDeals(k, deals, GS_CANDIDATES_MAX)) if (!hits.some((h) => h.id === d.id)) hits.push(d);
    const top = hits.slice(0, GS_CANDIDATES_MAX);
    const ks = await Promise.allSettled(top.map((d) => within(deps.kindOf(d.id), 8_000)));
    cands = top.map((deal, i) => ({ deal, kind: ks[i].status === "fulfilled" ? (ks[i] as PromiseFulfilledResult<string | null>).value : null }));
  } catch {
    dealsFailed = true;
  }

  try {
    await kv.set(gsTicketKey(tid), ticket, GS_TICKET_TTL);
    for (const id of [...ticket.triggerMsgIds, ...ticket.mediaIds]) await kv.set(gsMsgKey(id), tid, GS_TICKET_TTL);
    await kv.sadd(gsOpenKey(ev.groupId), tid);
  } catch {
    deps.log(`[group-satei] ticket ${receipt} save-failed`);
  }

  let name: string | null = null;
  try {
    name = await within(deps.requesterName(ev.requesterId), 3_000);
  } catch {
    name = null;
  }
  const text = gsNoticeText({ no: ticket.no, at: ev.at, requesterName: name, read: ticket.read, readFailed: ticket.readFailed, materials });
  const card = gsCard(tid, ticket.ver, cands, dealsFailed);
  let sent = false;
  try {
    sent = await deps.push(target, [{ type: "text", text }, card], `${tid}:${ticket.ver}`);
  } catch {
    sent = false;
  }
  deps.log(
    `[group-satei] ticket ${receipt} opened ${ev.entry} ${ticket.read ? "read ok" : `read ${ticket.readFailed}`} asked ${cands.length}${sent ? "" : " push-failed"}`,
  );
  return "opened";
}
```
注：`push` の `retryKey` は `${tid}:${ver}` を渡し、本物（Task 8）が `uuidv5(retryKey, GS_RETRY_NAMESPACE)` にする。

- [ ] **Step 4: 通ることを確かめる** — Run: `npx tsx tests/group-satei-open.test.ts` / Expected: 全部 ok
- [ ] **Step 5: Commit** — `feat: グループの査定依頼の受付票を開いて下村さんへ候補のカードを送る処理を足す`

---

### Task 7: ボタンの処理と種別での分岐（`group-satei-actions.ts`）

**Files:**
- Create: `src/lib/group-satei-actions.ts`
- Test: `tests/group-satei-actions.test.ts`

**Interfaces:**
- Consumes: Task 2・5・6、`judgeSateiDeal`・`SateiDeal`（`./satei-deal`）、`isSateiUser`・`sateiActive`（`./satei-data`）、`SateiCall`・`SateiIntakeOk`・`SateiIntakeReq`・`SATEI_CODE_AWAITING_REASON`（`./satei-portal`）、`msgSateiAccepted`・`msgSateiInProgress`・`MSG_SATEI_AWAITING_REASON`・`MSG_SATEI_FAILED`・`MSG_SATEI_DEAL_NOT_FOUND`（`./satei-text`）
- Produces:
  - `GsActionDeps = {env?, kv: GsKv & {del(key): Promise<void>; srem(key, member): Promise<void>} | null, dealsDbId: string|null, readDeal(dealId), intake(req), loadDeals(), reserve(key), complete(key), reply(token, text, card?), log(line)}`
  - `handleGroupSateiPostback(action: GsAction, ev: {replyToken, webhookEventId?, source: {userId?}}, deps): Promise<void>`

- [ ] **Step 1: テストを書く**

```ts
/** group-satei-actions.ts */
import assert from "node:assert/strict";
import { handleGroupSateiPostback, type GsActionDeps } from "../src/lib/group-satei-actions";
import { asTicket, gsDecKey, gsTicketKey, ticketIdOf, type GsAction, type GsTicket } from "../src/lib/group-satei-data";
import type { SateiDeal } from "../src/lib/satei-deal";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const OTHER = "U" + "c".repeat(32);
const G = "C" + "a".repeat(32);
const DB = "9999abcd0123456789ab0123456789ab";
const DEAL = "0123abcd0123456789ab0123456789ab";
const tid = ticketIdOf("m1");
const base: GsTicket = { no: 7, ver: 1, groupId: G, requesterId: OTHER, at: 1, triggerMsgIds: ["m1"], mediaIds: [], read: { address: "x", propertyName: null, kind: "戸建", basis: "登記", confidence: 0.9 }, state: "asking" };
const deal = (o: Partial<SateiDeal> = {}): SateiDeal => ({ id: DEAL, name: "テスト", dealNo: 12, folderId: "folder_abcdefghij", propertyIds: ["p"], gone: false, parentDbId: DB, ...o });

function mk(o: { kind?: string | null; folder?: boolean; intake?: any; ticket?: Partial<GsTicket> | null; userId?: string; env?: Record<string, string> } = {}) {
  const m = new Map<string, unknown>();
  if (o.ticket !== null) m.set(gsTicketKey(tid), { ...base, ...(o.ticket ?? {}) });
  const replies: Array<{ text: string; card?: unknown }> = [];
  const intakes: any[] = [];
  const logs: string[] = [];
  const done = new Set<string>();
  const deps: GsActionDeps = {
    env: o.env ?? { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G },
    kv: {
      get: async (k) => m.get(k) ?? null,
      set: async (k, v) => { m.set(k, v); },
      setNx: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
      incr: async () => 1, expire: async () => undefined, sadd: async () => undefined,
      lpushTrim: async () => undefined, lrange: async () => [],
      del: async (k) => { m.delete(k); }, srem: async () => undefined,
    },
    dealsDbId: DB,
    readDeal: async () => ({ deal: deal(o.folder === false ? { folderId: null } : {}), kind: o.kind === undefined ? "マンション" : o.kind }),
    intake: async (req) => { intakes.push(req); return o.intake ?? { kind: "ok", value: { created: true, no: 12 } }; },
    loadDeals: async () => [{ id: DEAL, name: "テスト", phase: "査定" }],
    reserve: async (k) => ({ proceed: !done.has(k) }),
    complete: async (k) => { done.add(k); },
    reply: async (_t, text, card) => { replies.push({ text, card }); },
    log: (l) => logs.push(l),
  };
  return { deps, m, replies, intakes, logs };
}
const press = (x: ReturnType<typeof mk>, a: GsAction, eventId = "e1", userId = SHIMO) =>
  handleGroupSateiPostback(a, { replyToken: "r", webhookEventId: eventId, source: { userId } }, x.deps);
const gs: GsAction = { op: "gs", tid, ver: 1, dealId: DEAL };

(async () => {
  await t("マンション・フォルダあり → portal の受付を1回・決まった依頼 ID", async () => {
    const x = mk();
    await press(x, gs);
    assert.equal(x.intakes.length, 1);
    assert.equal(x.intakes[0].eventId, `gs${tid}`);
    assert.match(x.replies[0].text, /受け付けました/);
    assert.equal(asTicket(x.m.get(gsTicketKey(tid)))?.state, "started");
  });
  await t("二度押し（別イベント）・LINE の再送（同じイベント）で2回目の受付は無い", async () => {
    const x = mk();
    await press(x, gs, "e1");
    await press(x, gs, "e1");
    await press(x, gs, "e2");
    assert.equal(x.intakes.length, 1);
    assert.match(x.replies[1].text, /選択済みです（受付 G7）/);
  });
  await t("古い版のカード", async () => {
    const x = mk({ ticket: { ver: 2 } });
    await press(x, gs);
    assert.equal(x.intakes.length, 0);
    assert.match(x.replies[0].text, /新しいカード/);
  });
  await t("戸建 → 手作業・受付は呼ばない", async () => {
    const x = mk({ kind: "戸建" });
    await press(x, gs);
    assert.equal(x.intakes.length, 0);
    assert.match(x.replies[0].text, /戸建のため自動作成はできません/);
    assert.equal(asTicket(x.m.get(gsTicketKey(tid)))?.state, "manual");
  });
  await t("種別が空 → 種別が分からない", async () => {
    const x = mk({ kind: null });
    await press(x, gs);
    assert.match(x.replies[0].text, /種別が分からないため/);
  });
  await t("CRM はマンション・資料は戸建 → 警告を1行足す", async () => {
    const x = mk();
    await press(x, gs);
    assert.match(x.replies[0].text, /資料からは戸建に見えます/);
  });
  await t("マンション・フォルダなし → 決めない（押し直せる）", async () => {
    const x = mk({ folder: false });
    await press(x, gs, "e1");
    assert.match(x.replies[0].text, /Driveフォルダが未設定/);
    assert.equal(x.m.has(gsDecKey(tid)), false);
    assert.equal(asTicket(x.m.get(gsTicketKey(tid)))?.state, "asking");
  });
  await t("受付の結果不明 → 印を残し、押し直しでは portal を呼ばない", async () => {
    const x = mk({ intake: { kind: "unknown", reason: "timeout" } });
    await press(x, gs, "e1");
    await press(x, gs, "e2");
    assert.equal(x.intakes.length, 1);
    assert.match(x.replies[1].text, /確かめられませんでした/);
  });
  await t("受け付けられない → 印を外して押し直せる", async () => {
    const x = mk({ intake: { kind: "rejected", status: 400, code: "X" } });
    await press(x, gs, "e1");
    assert.equal(x.m.has(gsDecKey(tid)), false);
    assert.equal(asTicket(x.m.get(gsTicketKey(tid)))?.state, "asking");
  });
  await t("案件がまだ無い → 仮の決定。あとで一覧から1回だけ選び直せる", async () => {
    const x = mk();
    await press(x, { op: "gm", tid, ver: 1 }, "e1");
    assert.match(x.replies[0].text, /選び直せます（7日間）/);
    assert.equal(asTicket(x.m.get(gsTicketKey(tid)))?.provisional, true);
    await press(x, gs, "e2");
    assert.equal(x.intakes.length, 1);
    await press(x, gs, "e3");
    assert.equal(x.intakes.length, 1);
  });
  await t("査定の依頼ではない → 閉じる。そのあと何を押しても選択済み", async () => {
    const x = mk();
    await press(x, { op: "gn", tid, ver: 1 }, "e1");
    assert.match(x.replies[0].text, /閉じました/);
    await press(x, gs, "e2");
    assert.equal(x.intakes.length, 0);
    assert.match(x.replies[1].text, /選択済み/);
  });
  await t("一覧：カルーセルを返す（決めない）", async () => {
    const x = mk();
    await press(x, { op: "gl", tid, ver: 1, offset: 0 });
    assert.ok(x.replies[0].card);
  });
  await t("押せるのは下村さんだけ・off なら止めています・受付票が無ければ期限切れ", async () => {
    let x = mk();
    await press(x, gs, "e1", OTHER);
    assert.match(x.replies[0].text, /下村さんだけ/);
    x = mk({ env: { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO } });
    await press(x, gs);
    assert.match(x.replies[0].text, /止めています/);
    x = mk({ ticket: null });
    await press(x, gs);
    assert.match(x.replies[0].text, /期限が切れています/);
  });
  await t("ログに案件名・userId を出さない", async () => {
    const x = mk();
    await press(x, gs);
    const l = x.logs.join("\n");
    assert.ok(!l.includes("テスト") && !l.includes(SHIMO));
    assert.ok(x.logs.some((s) => /^\[group-satei\] gs started G7 #J12/.test(s)));
  });
  console.log(`group-satei-actions: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 失敗を確かめる** — Run: `npx tsx tests/group-satei-actions.test.ts` / Expected: モジュールが無くて失敗
- [ ] **Step 3: 実装**

```ts
/**
 * 普通のグループの査定依頼：カードのボタン（gs・gl・gm・gn）の処理と、種別での分岐（設計 8.3〜8.4）。
 * 順番：GROUP_SATEI off →「止めています」／TASK_SATEI_USER_IDS に無い →「下村さんだけ」／受付票が無い →「期限切れ」
 * → 版違い →「新しいカード」→ gl は一覧だけ（決めない）→ pb:<webhookEventId> の予約 → 決める（受付票ごとに最初の1回。gsatei:dec）。
 * 例外は投げない。ログは符号・受付番号・J番号だけ。
 */
import {
  GS_TICKET_TTL, groupSateiActive, gsDecKey, gsEventId, gsOpenKey, gsTicketKey, receiptOf, asTicket,
  type GsAction, type GsEnv, type GsTicket,
} from "./group-satei-data";
import type { GsKv } from "./group-satei-open";
import {
  gsListCard, MSG_GS_BUSY, MSG_GS_DEALS_FAILED, MSG_GS_EXPIRED, MSG_GS_FORBIDDEN, MSG_GS_NO_FOLDER, MSG_GS_NOT_ACTIVE,
  MSG_GS_PAUSED, MSG_GS_STALE, MSG_GS_UNKNOWN, msgGsAlready, msgGsDismissed, msgGsKindMismatch, msgGsManual, msgGsNoDeal,
} from "./group-satei-card";
import { isSateiUser } from "./satei-data";
import { judgeSateiDeal, SATEI_KIND, type SateiDeal } from "./satei-deal";
import { SATEI_CODE_AWAITING_REASON, type SateiCall, type SateiIntakeOk, type SateiIntakeReq } from "./satei-portal";
import { MSG_SATEI_AWAITING_REASON, MSG_SATEI_DEAL_NOT_FOUND, MSG_SATEI_FAILED, msgSateiAccepted, msgSateiInProgress } from "./satei-text";
import type { DealRef } from "./task-record";
import type { FlexMessage } from "./task-card";

export interface GsActionDeps {
  env?: GsEnv;
  kv: (GsKv & { del(key: string): Promise<void>; srem(key: string, member: string): Promise<void> }) | null;
  dealsDbId: string | null;
  readDeal(dealId: string): Promise<{ deal: SateiDeal; kind: string | null } | null>;
  intake(req: SateiIntakeReq): Promise<SateiCall<SateiIntakeOk>>;
  loadDeals(): Promise<DealRef[]>;
  reserve(key: string): Promise<{ proceed: boolean }>;
  complete(key: string): Promise<void>;
  reply(replyToken: string, text: string, card?: FlexMessage): Promise<unknown>;
  log(line: string): void;
}

interface Outcome {
  text: string;
  code: string;
  settled: boolean;
}

type Kv = NonNullable<GsActionDeps["kv"]>;

async function save(kv: Kv, tid: string, tk: GsTicket): Promise<void> {
  await kv.set(gsTicketKey(tid), tk, GS_TICKET_TTL);
  if (tk.state !== "asking" && !tk.provisional) await kv.srem(gsOpenKey(tk.groupId), tid);
}

const MISMATCH_KINDS = ["マンション", "戸建", "土地"];

async function pick(a: Extract<GsAction, { op: "gs" }>, tk: GsTicket, userId: string, deps: GsActionDeps, kv: Kv): Promise<Outcome> {
  const no = tk.no;
  if (!deps.dealsDbId) return { text: MSG_SATEI_DEAL_NOT_FOUND, code: "config-missing", settled: true };
  // 一覧に出した案件だけ（進行中）
  let active: DealRef[];
  try {
    active = await deps.loadDeals();
  } catch {
    return { text: MSG_GS_DEALS_FAILED, code: "deals-failed", settled: false };
  }
  if (!active.some((d) => d.id.replace(/-/g, "").toLowerCase() === a.dealId)) return { text: MSG_GS_NOT_ACTIVE, code: "not-active", settled: true };
  let got: { deal: SateiDeal; kind: string | null } | null;
  try {
    got = await deps.readDeal(a.dealId);
  } catch {
    return { text: MSG_SATEI_DEAL_NOT_FOUND, code: "read-failed", settled: false };
  }
  if (!got || got.deal.gone) return { text: MSG_SATEI_DEAL_NOT_FOUND, code: "not-found", settled: true };
  const kind = got.kind;
  const warn =
    tk.read && MISMATCH_KINDS.includes(tk.read.kind) && kind && MISMATCH_KINDS.includes(kind) && tk.read.kind !== kind
      ? `\n${msgGsKindMismatch(tk.read.kind)}`
      : "";
  if (kind === SATEI_KIND) {
    const j = judgeSateiDeal(got.deal, kind, deps.dealsDbId);
    if (!j.ok) {
      return j.reason === "no-folder"
        ? { text: MSG_GS_NO_FOLDER + warn, code: "no-folder", settled: true }
        : { text: MSG_SATEI_DEAL_NOT_FOUND, code: j.reason, settled: true };
    }
    if (!(await kv.setNx(gsDecKey(a.tid), `gs:${a.dealId}`, GS_TICKET_TTL))) return { text: msgGsAlready(no), code: "already", settled: true };
    let r: SateiCall<SateiIntakeOk>;
    try {
      r = await deps.intake({ eventId: gsEventId(a.tid), dealId: j.deal.id, dealNo: j.deal.dealNo, folderId: j.deal.folderId, dealName: j.deal.name, requestedBy: userId });
    } catch {
      r = { kind: "unknown", reason: "exception" };
    }
    if (r.kind === "ok") {
      await save(kv, a.tid, { ...tk, state: "started", provisional: false, dealId: a.dealId, jobNo: r.value.no });
      const text = r.value.created ? msgSateiAccepted(r.value.no) : msgSateiInProgress(r.value.no);
      return { text: text + warn, code: `started ${receiptOf(no)} #J${r.value.no}`, settled: true };
    }
    if (r.kind === "unknown") {
      await save(kv, a.tid, { ...tk, state: "started", provisional: false, dealId: a.dealId, unknown: true });
      return { text: MSG_GS_UNKNOWN, code: "unknown", settled: true };
    }
    await kv.del(gsDecKey(a.tid));
    return r.code === SATEI_CODE_AWAITING_REASON
      ? { text: MSG_SATEI_AWAITING_REASON, code: "awaiting-reason", settled: true }
      : { text: MSG_SATEI_FAILED, code: "rejected", settled: true };
  }
  if (!(await kv.setNx(gsDecKey(a.tid), `gs:${a.dealId}`, GS_TICKET_TTL))) return { text: msgGsAlready(no), code: "already", settled: true };
  await save(kv, a.tid, { ...tk, state: "manual", provisional: false, dealId: a.dealId });
  return { text: msgGsManual(no, kind) + warn, code: `manual ${kind === "戸建" ? "house" : kind === "土地" ? "land" : "unknown-kind"}`, settled: true };
}

async function decide(a: Exclude<GsAction, { op: "gl" }>, tk: GsTicket, userId: string, deps: GsActionDeps, kv: Kv): Promise<Outcome> {
  const dec = await kv.get(gsDecKey(a.tid));
  if (dec) return tk.unknown ? { text: MSG_GS_UNKNOWN, code: "unknown-again", settled: true } : { text: msgGsAlready(tk.no), code: "already", settled: true };
  if (a.op === "gs") return pick(a, tk, userId, deps, kv);
  if (a.op === "gm") {
    await save(kv, a.tid, { ...tk, state: "manual", provisional: true });
    return { text: msgGsNoDeal(tk.no), code: "no-deal", settled: true };
  }
  if (!(await kv.setNx(gsDecKey(a.tid), "gn", GS_TICKET_TTL))) return { text: msgGsAlready(tk.no), code: "already", settled: true };
  await save(kv, a.tid, { ...tk, state: "dismissed", provisional: false });
  return { text: msgGsDismissed(tk.no), code: "dismissed", settled: true };
}

export async function handleGroupSateiPostback(
  action: GsAction,
  ev: { replyToken: string; webhookEventId?: string; source: { userId?: string } },
  deps: GsActionDeps,
): Promise<void> {
  const env = deps.env ?? process.env;
  const say = async (text: string, code: string, card?: FlexMessage) => {
    try {
      await deps.reply(ev.replyToken, text, card);
    } catch {
      deps.log(`[group-satei] reply-failed ${action.op} ${code}`);
    }
  };
  if (!groupSateiActive(env)) {
    deps.log(`[group-satei] ${action.op} paused`);
    return say(MSG_GS_PAUSED, "paused");
  }
  const userId = ev.source.userId;
  if (!userId || !isSateiUser(userId, env)) {
    deps.log(`[group-satei] ${action.op} forbidden`);
    return say(MSG_GS_FORBIDDEN, "forbidden");
  }
  const kv = deps.kv;
  if (!kv) {
    deps.log(`[group-satei] ${action.op} config-missing`);
    return say(MSG_GS_BUSY, "config-missing");
  }
  let tk: GsTicket | null;
  try {
    tk = asTicket(await kv.get(gsTicketKey(action.tid)));
  } catch {
    deps.log(`[group-satei] ${action.op} kv-failed`);
    return say(MSG_GS_BUSY, "kv-failed");
  }
  if (!tk) {
    deps.log(`[group-satei] ${action.op} expired`);
    return say(MSG_GS_EXPIRED, "expired");
  }
  if (tk.ver !== action.ver) {
    deps.log(`[group-satei] ${action.op} stale ${receiptOf(tk.no)}`);
    return say(MSG_GS_STALE, "stale");
  }
  if (action.op === "gl") {
    let deals: DealRef[];
    try {
      deals = await deps.loadDeals();
    } catch {
      deps.log("[group-satei] gl deals-failed");
      return say(MSG_GS_DEALS_FAILED, "deals-failed");
    }
    const card = gsListCard(action.tid, tk.ver, tk.no, deals, action.offset);
    deps.log(`[group-satei] gl shown ${receiptOf(tk.no)}`);
    return card ? say(`どの案件ですか（${receiptOf(tk.no)}）`, "shown", card) : say("これより後の案件はありません", "empty");
  }
  const eventId = ev.webhookEventId;
  if (!eventId) {
    deps.log(`[group-satei] ${action.op} no-event-id`);
    return say(MSG_GS_BUSY, "no-event-id");
  }
  const rkey = `pb:${eventId}`;
  let claim: { proceed: boolean };
  try {
    claim = await deps.reserve(rkey);
  } catch {
    deps.log(`[group-satei] ${action.op} reserve-failed`);
    return say(MSG_GS_BUSY, "busy");
  }
  if (!claim.proceed) {
    deps.log(`[group-satei] ${action.op} duplicate`);
    return;
  }
  let settled = false;
  try {
    let r: Outcome;
    try {
      r = await decide(action, tk, userId, deps, kv);
    } catch {
      r = { text: MSG_GS_BUSY, code: "kv-failed", settled: false };
    }
    settled = r.settled;
    deps.log(`[group-satei] ${action.op} ${r.code}`);
    await say(r.text, r.code);
  } finally {
    if (settled) await deps.complete(rkey).catch(() => deps.log(`[group-satei] mark-failed ${action.op}`));
  }
}
```
注1：`gm` のあとの `gs`（選び直し）は、`decide` で `dec` が無いので `pick` に進み、そこで `setNx` を取った1回だけ通る（テスト「選び直せる」）。
注2：テスト「二度押し」の `e1` の2回目は `reserve` で止まり返事をしない（`replies[1]` は `e2` の「選択済み」）。
注3：テストの「マンション・フォルダあり」の受付票の `read.kind` は戸建なので、返事に警告が1行足される（テスト「警告を1行足す」と同じ作り）。

- [ ] **Step 4: 通ることを確かめる** — Run: `npx tsx tests/group-satei-actions.test.ts` / Expected: 全部 ok
- [ ] **Step 5: Commit** — `feat: グループの査定依頼のカードのボタン（案件を選ぶ・一覧・案件なし・査定ではない）を足す`

---

### Task 8: 本物へのつなぎと webhook・ボタンの振り分け

**Files:**
- Create: `src/lib/group-satei-wire.ts`
- Modify: `src/lib/task-buttons-wire.ts`（`parseSateiAskData` の振り分けのすぐ後）
- Modify: `src/app/api/webhook/route.ts`（3か所）
- Test: `tests/group-satei-webhook.test.ts`（off のとき KV・AI に触れないこと、振り分けの順）
- Modify: `package.json`（`test` に `group-satei-data`・`-gate`・`-read`・`-card`・`-open`・`-actions`・`-webhook` を足す）
- Modify: `CLAUDE.md`（末尾に節を足す）

**Interfaces:**
- Consumes: Task 2〜7、`sateiActionDeps`（`./satei-wire`。`dealsDbId`・`readDeal`・`intake` を使う）、`makeSateiNotion`、`loadActiveDeals`、`readSateiDealReal`、`resolveMember`、`pushMessagesWithRetryKey`、`uuidv5`、`loadPhotoAskImages` 相当（画像・PDF を取る。下に書く）
- Produces:
  - `groupSateiKv(): (GsKv & {del; srem}) | null`
  - `groupSateiOpenDeps(today: string): GsOpenDeps`
  - `groupSateiActionDeps(): Omit<GsActionDeps, "reserve"|"complete"|"reply"|"log">`
  - `recordGroupSateiMediaEvent(m: {messageId, groupId?, senderId?, type, fileName?, at}): Promise<void>`
  - `maybeOpenGroupSateiA(p: {messageId, groupId?, senderId?, at, text, quotedMessageId?, isTask, requestType, confidence}, today): Promise<void>`
  - `maybeOpenGroupSateiB(p: {messageId, groupId?, senderId?, at, text, quotedMessageId?}, today): Promise<void>`

- [ ] **Step 1: テストを書く**（`tests/group-satei-webhook.test.ts`。route を通さず、wire の入口が off で何もしないこと・振り分けの data を確かめる）

```ts
/** group-satei-wire.ts の入口：off・対象外では KV にも AI にも触れない */
import assert from "node:assert/strict";
import { gsEntryAOk } from "../src/lib/group-satei-gate";
import { maybeOpenGroupSateiA, maybeOpenGroupSateiB, recordGroupSateiMediaEvent } from "../src/lib/group-satei-wire";
import { parseGsData } from "../src/lib/group-satei-data";
import { parseSateiAskData } from "../src/lib/satei-ask";
import { parseSateiData } from "../src/lib/satei-data";

let n = 0;
const t = async (name: string, f: () => Promise<void> | void) => { await f(); n++; console.log("ok", name); };
let calls = 0;
globalThis.fetch = (async () => { calls++; throw new Error("外へ出てはいけない"); }) as typeof fetch;
delete process.env.GROUP_SATEI;
process.env.KV_REST_API_URL = "https://example.invalid";
process.env.KV_REST_API_TOKEN = "x";
const G = "C" + "a".repeat(32);
const BOSS = "U" + "c".repeat(32);

(async () => {
  await t("off：控え・入口 A・B は通信しない", async () => {
    await recordGroupSateiMediaEvent({ messageId: "i1", groupId: G, senderId: BOSS, type: "image", at: 1 });
    await maybeOpenGroupSateiA({ messageId: "m1", groupId: G, senderId: BOSS, at: 1, text: "査定", isTask: true, requestType: "査定書", confidence: 0.9 }, "2026-11-24");
    await maybeOpenGroupSateiB({ messageId: "m2", groupId: G, senderId: BOSS, at: 1, text: "査定お願い" }, "2026-11-24");
    assert.equal(calls, 0);
  });
  await t("data は他の機能と取り合わない", () => {
    const d = "v1|gs|0123456789abcdef|1|0123abcd0123456789ab0123456789ab";
    assert.ok(parseGsData(d));
    assert.equal(parseSateiData(d), null);
    assert.equal(parseSateiAskData(d), null);
  });
  await t("入口 A は off なら false", () => assert.equal(gsEntryAOk({ groupId: G, senderId: BOSS, isTask: true, requestType: "査定書", confidence: 1 }, {}), false));
  console.log(`group-satei-webhook: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 失敗を確かめる** — Run: `npx tsx tests/group-satei-webhook.test.ts` / Expected: `group-satei-wire` が無くて失敗

- [ ] **Step 3: `src/lib/group-satei-wire.ts` を書く**

```ts
/**
 * 普通のグループの査定依頼（group-satei-*.ts）の本物へのつなぎ。
 * - KV：@vercel/kv（URL と TOKEN の両方があるときだけ）。
 * - 画像・PDF：LINE の content API から取る（ログを出さない）。Claude：Anthropic の SDK（claude.ts と同じモデル）。
 * - CRM：ログを抑えた Notion Client（makeSateiNotion）。案件の種別は readSateiDealReal。
 * - portal の受付は sateiActionDeps().intake（今の［査定書を作る］と同じ）。
 * 入口はどれも、スイッチが off・対象外なら KV にも AI にも触れずに戻る。例外は投げない。
 */
import Anthropic from "@anthropic-ai/sdk";
import { kv } from "@vercel/kv";
import type { TaskAttachment } from "./claude";
import { GS_MIN, GS_RETRY_NAMESPACE, groupSateiOn } from "./group-satei-data";
import { gsEntryAOk, gsEntryBGate, gsMediaRow } from "./group-satei-gate";
import { openGroupSatei, recordGroupSateiMedia, type GsKv, type GsOpenDeps } from "./group-satei-open";
import type { GsActionDeps } from "./group-satei-actions";
import { readGsMaterials, type GsCreate } from "./group-satei-read";
import { parseTaskFromMessage } from "./claude";
import { pushMessagesWithRetryKey } from "./line";
import { resolveMember } from "./members";
import { uuidv5 } from "./satei-notify";
import { makeSateiNotion, readSateiDealReal, sateiActionDeps } from "./satei-wire";
import { loadActiveDeals } from "./task-record-wire";

const log = (l: string) => console.log(l);
const crm = makeSateiNotion();
const CONTENT_TIMEOUT_MS = 8_000;
const READ_TIMEOUT_MS = 40_000;
const MAX_BYTES = 3.5 * 1024 * 1024;

export function groupSateiKv(): (GsKv & { del(k: string): Promise<void>; srem(k: string, m: string): Promise<void> }) | null {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return {
    get: (k) => kv.get(k),
    set: async (k, v, ex) => { await kv.set(k, v, { ex }); },
    setNx: async (k, v, ex) => (await kv.set(k, v, { nx: true, ex })) === "OK",
    incr: (k) => kv.incr(k),
    expire: async (k, ex) => { await kv.expire(k, ex); },
    sadd: async (k, m) => { await kv.sadd(k, m); },
    srem: async (k, m) => { await kv.srem(k, m); },
    del: async (k) => { await kv.del(k); },
    lpushTrim: async (k, v, max, ex) => {
      await kv.rpush(k, JSON.stringify(v));
      await kv.ltrim(k, -max, -1);
      await kv.expire(k, ex);
    },
    lrange: (k) => kv.lrange(k, 0, -1),
  };
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** 1件でも取れない・大きすぎる・時間切れなら例外（一部だけで読まない）。ログは出さない */
async function loadMaterials(ids: string[]): Promise<TaskAttachment[]> {
  const out: TaskAttachment[] = [];
  for (const id of ids) {
    const res = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(id)}/content`, {
      headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN ?? ""}` },
      signal: AbortSignal.timeout(CONTENT_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) throw new Error("content");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) throw new Error("size");
    const ct = res.headers.get("content-type") ?? "";
    out.push(
      /pdf/i.test(ct)
        ? { kind: "pdf", mediaType: "application/pdf", base64: buf.toString("base64") }
        : { kind: "image", mediaType: /png/i.test(ct) ? "image/png" : /webp/i.test(ct) ? "image/webp" : /gif/i.test(ct) ? "image/gif" : "image/jpeg", base64: buf.toString("base64") },
    );
  }
  return out;
}

let anthropic: Anthropic | null = null;
const create: GsCreate = (req) =>
  (anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })).messages.create(req as never) as never;

function ymdJst(ms: number): string {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function groupSateiOpenDeps(today: string): GsOpenDeps {
  return {
    kv: groupSateiKv(),
    now: () => Date.now(),
    today: () => today,
    ymd: () => ymdJst(Date.now()),
    read: async (ids, text) => within(readGsMaterials(await loadMaterials(ids), text, today, create), READ_TIMEOUT_MS),
    loadDeals: () => loadActiveDeals(crm),
    kindOf: async (dealId) => (await readSateiDealReal(dealId.replace(/-/g, "").toLowerCase(), crm))?.kind ?? null,
    requesterName: async (userId) => (await resolveMember(userId, null))?.name ?? null,
    push: async (to, messages, key) => {
      const status = await pushMessagesWithRetryKey(to, messages, uuidv5(key, GS_RETRY_NAMESPACE));
      return status !== null && ((status >= 200 && status < 300) || status === 409);
    },
    log,
  };
}

export function groupSateiActionDeps(): Omit<GsActionDeps, "reserve" | "complete" | "reply" | "log"> {
  const s = sateiActionDeps();
  return {
    kv: groupSateiKv(),
    dealsDbId: s.dealsDbId,
    readDeal: s.readDeal,
    intake: s.intake,
    loadDeals: async () => (await loadActiveDeals(crm)).map((d) => ({ ...d, id: d.id.replace(/-/g, "").toLowerCase() })),
  };
}

export async function recordGroupSateiMediaEvent(m: { messageId: string; groupId?: string; senderId?: string; type: "image" | "file"; fileName?: string; at: number }): Promise<void> {
  if (!groupSateiOn(m.groupId)) return;
  const row = gsMediaRow(m);
  if (row) await recordGroupSateiMedia(row, m.groupId as string, groupSateiKv(), log);
}

export async function maybeOpenGroupSateiA(
  p: { messageId: string; groupId?: string; senderId?: string; at: number; text: string; quotedMessageId?: string; isTask: boolean; requestType: string; confidence: number },
  today: string,
): Promise<void> {
  if (!gsEntryAOk(p)) return;
  try {
    await openGroupSatei(
      { messageId: p.messageId, groupId: p.groupId as string, requesterId: p.senderId as string, at: p.at, text: p.text, entry: "A", quotedMessageId: p.quotedMessageId },
      groupSateiOpenDeps(today),
    );
  } catch {
    log("[group-satei] skip:exception A");
  }
}

export async function maybeOpenGroupSateiB(
  p: { messageId: string; groupId?: string; senderId?: string; at: number; text: string; quotedMessageId?: string },
  today: string,
): Promise<void> {
  const g = gsEntryBGate(p);
  if (!g.ok) {
    if (g.reason !== "off" && g.reason !== "words") log(`[group-satei] skip:${g.reason}`);
    return;
  }
  try {
    const parsed = await within(parseTaskFromMessage(p.text, today), READ_TIMEOUT_MS);
    if (!parsed.isTask || parsed.requestType !== "査定書" || parsed.confidence < GS_MIN) {
      log("[group-satei] skip:not-satei");
      return;
    }
    await openGroupSatei(
      { messageId: p.messageId, groupId: p.groupId as string, requesterId: p.senderId as string, at: p.at, text: p.text, entry: "B", quotedMessageId: p.quotedMessageId },
      groupSateiOpenDeps(today),
    );
  } catch {
    log("[group-satei] skip:exception B");
  }
}
```
注：`kv.lrange` は JSON の文字列のまま返ることがあるが、`group-satei-open.ts` の `asMedia` が文字列も読む。`kv.rpush` で末尾に足し、`ltrim(-max,-1)` で新しい max 件を残す（`lpushTrim` の名前は「足して切る」の意味）。

- [ ] **Step 4: ボタンの振り分け**（`src/lib/task-buttons-wire.ts`、`const ask = parseSateiAskData(data); if (ask) {...return;}` の直後）

```ts
  // 普通のグループの査定依頼のカード（v1|gs|・gl|・gm|・gn|）。スイッチ・押せる人・二度押しは group-satei-actions.ts
  const gsa = parseGsData(data);
  if (gsa) {
    await handleGroupSateiPostback(
      gsa,
      { replyToken, webhookEventId: event.webhookEventId, source: event.source },
      {
        ...groupSateiActionDeps(),
        reserve: io.reserve,
        complete: io.complete,
        reply: (token, text, card) => io.reply(token, text, card),
        log: io.log,
      },
    );
    return;
  }
```
import を足す：`import { parseGsData } from "./group-satei-data";`、`import { handleGroupSateiPostback } from "./group-satei-actions";`、`import { groupSateiActionDeps } from "./group-satei-wire";`。
（`io.reply` が card を受けることは satei-ask の呼び出しと同じ）

- [ ] **Step 5: webhook の3か所**（`src/app/api/webhook/route.ts`）

(a) 画像・ファイル（803行目あたり）：`handleIncomingImage` の前に
```ts
      await recordGroupSateiMediaEvent({ messageId: event.message.id, groupId: source.groupId, senderId: source.userId, type: "image", at: event.timestamp ?? Date.now() });
```
`handleIncomingFile` の前に
```ts
      await recordGroupSateiMediaEvent({ messageId: event.message.id, groupId: source.groupId, senderId: source.userId, type: "file", fileName: event.message.fileName, at: event.timestamp ?? Date.now() });
```
（関数の中で off なら何もしない。例外は投げない）

(b) 入口 B（メンションの無い発言の枝、`await maybeAskPhotoMention(` の直前）：
```ts
      // 普通のグループの査定依頼（GROUP_SATEI=1 かつ対象グループのときだけ。グループには返さない）
      await maybeOpenGroupSateiB(
        { messageId: event.message.id, groupId: source.groupId, senderId: source.userId, at: event.timestamp ?? Date.now(), text, quotedMessageId: event.message.quotedMessageId },
        todayLabel(jstNow()),
      );
```

(c) 入口 A（R7。返事のあと）：
- 登録しない枝：`await finishUnregisteredIntake({...});` の直後・`continue;` の前に
```ts
      await maybeOpenGroupSateiA(
        { messageId: event.message.id, groupId: source.groupId, senderId: source.userId, at: event.timestamp ?? Date.now(), text, quotedMessageId: event.message.quotedMessageId, isTask: parsed.isTask, requestType: parsed.requestType, confidence: parsed.confidence },
        todayLabel(now),
      );
```
- 登録した枝：`try { // Notion に登録 ... } catch (err) { console.error("タスク登録エラー:", err); await sendLineMessage(...); }` の閉じかっこの直後（外側の `} catch (err) { // 例外で抜けた…` の前）に、上と同じ呼び出しを置く。
import：`import { maybeOpenGroupSateiA, maybeOpenGroupSateiB, recordGroupSateiMediaEvent } from "@/lib/group-satei-wire";`

注：(c) の登録した枝で、予約が取れず `continue` した場合（再送・二重）は呼ばれない。これは正しい（受付票も同じ発言で1回だけ）。

- [ ] **Step 6: 通ることを確かめる** — Run: `npx tsx tests/group-satei-webhook.test.ts && npm test && npx tsc --noEmit` / Expected: 全部 ok、型エラーなし。特に `tests/task-intake-webhook.test.ts`・`tests/satei-postback-wire.test.ts`・`tests/photo-ask*.test.ts` が今のまま通ること（off で今の動きが変わらない）。

- [ ] **Step 7: CLAUDE.md に節を足す**（末尾）

```md
（普通のグループの査定依頼・段1・2026-11-24）`GROUP_SATEI`（`1` のときだけ動く。既定 off）／`GROUP_SATEI_GROUP_IDS`（対象のグループ。カンマ区切り。空なら何もしない。まず業務指示だけ）。
on のとき、対象グループの画像・ファイルを `gsatei:media:<groupId>`（ID・種類・送り主・時刻だけ。ファイル名は持たない。30件・3時間）に控え、
@AI秘書 あてで査定書と判定された依頼（入口 A。返事のあと）と、メンションの無い「査定」「価格を出して」「いくらで売れ」「売却価格」「相場」を含む依頼（入口 B。AI で査定書・0.5以上のときだけ）で受付票 `gsatei:t:<id>`（7日）を作り、
本人の30分前〜1分後の画像・PDF と引用の資料を Claude で読み（1日20回まで）、下村さん（`TASK_SATEI_USER_IDS` の先頭）の1対1へ文字＋候補のカードを push する（月の送信枠を1通）。グループには何も返さない。入口 B から LINEタスク は作らない。
ボタン `v1|gs|`（案件を選ぶ）・`v1|gl|`（一覧）・`v1|gm|`（案件がまだ無い＝仮の決定。7日以内に1回だけ選び直せる）・`v1|gn|`（査定ではない）。押せるのは `TASK_SATEI_USER_IDS` の人だけ。決めるのは受付票ごとに最初の1回（`gsatei:dec:<id>`）。
種別は CRM_物件 の `種別` が正：マンション＋フォルダあり → portal の受付（依頼 ID は `gs<受付票の ID>`）、戸建・土地・不明 → 「手作業の査定に回します」。
ログは `[group-satei] ticket G7 opened A read ok asked 3`・`[group-satei] gs started G7 #J12`・`gs manual house` の形（符号だけ）。設計 `docs/superpowers/specs/2026-11-24-group-satei-intake-design.md`、計画 `docs/superpowers/plans/2026-11-24-group-satei-intake-stage1.md`。
案件カードの絞り込みは `DEAL_CARD_ONLY_IDS`（未設定なら今の2件、`all` で全件、カンマ区切りの ID）。on にする・env を足すのは下村さんの承認後（値を画面に出さない方法で入れる）。
```

- [ ] **Step 8: Commit** — `feat: グループの査定依頼を webhook とボタンにつなぐ（GROUP_SATEI=1 のときだけ動く）`

---

## 段1の終わり（この計画の外。下村さんの承認が要る）

1. 本番の今の設定の確認（段0：`TASK_SATEI`・`TASK_SATEI_USER_IDS`・`SECRETARY_ALLOWED_GROUP_IDS` に業務指示が入っているか）— **未確認**
2. deploy（下村さんの承認後）。`GROUP_SATEI` はまだ入れない → 今と同じ動き（`DEAL_CARD_ONLY_IDS` 未設定でも今の2件）
3. `GROUP_SATEI=1`・`GROUP_SATEI_GROUP_IDS=<業務指示>` を入れて、試験用の案件で1回通す（送信枠を数通使う）
4. 段2（入口 C・引用の無い他人の資料・読み直し）・段3（LINEタスク への書き戻し・朝の催促・7日で閉じる）は別の計画
