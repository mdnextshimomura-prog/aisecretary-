/**
 * クラウド配達のテスト用の偽物（portal・KV・LINE・時計）。
 * portal の偽物は、約束 2026-10-11-obi-cloud-contract.md の入口 1・1b・2・4・7 の決まりを写した「状態を持つ偽物」。
 * 値はどれもテスト用（本物の ID・鍵ではない）。
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import type {
  CloudCompletionConfig,
  CloudCompletionResult,
  CloudSharedConfig,
} from "../../src/lib/obi/cloud-config";
import type {
  ClaimedDelivery,
  CloudJobRow,
  CloudPortal,
  DeliveryMessageBody,
  DeliveryResultBody,
  JobList,
  NoticeClaimed,
  NoticeKey,
  PortalCall,
} from "../../src/lib/obi/cloud-portal";
import {
  createKvCloudStore,
  type CloudKvClient,
  type CloudStore,
} from "../../src/lib/obi/cloud-store";
import {
  CloudHalt,
  newTickCtx,
  type CloudCheckpoint,
  type CloudDeps,
  type TickCtx,
} from "../../src/lib/obi/cloud-tick";

export const GROUP = "C" + "a1b2c3d4".repeat(4);
export const OTHER_GROUP = "C" + "f".repeat(32);
export const PORTAL_TOKEN = "portal-token-not-a-real-secret-0001";
export const LIFF_ID = "1234567890-AbCdEfGh";
export const KID = "cloud-0000-00";
/** 整える前の物件名（URL と見えない文字入り）と、整えた後 */
export const RAW_PROPERTY = `グランメゾン${String.fromCharCode(0x200b)}北浜 https://evil.example.com/x 302`;
export const CLEAN_PROPERTY = "グランメゾン北浜 302";
export const sha = (seed: string): string =>
  createHash("sha256").update(seed).digest("hex");

// テスト専用の鍵（種の文から組み立てる。PEM の秘密鍵はリポジトリに置かない）
const seed = createHash("sha256")
  .update("obi-cloud fakes test key (not a secret)")
  .digest();
export const TEST_KEY: KeyObject = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]),
  format: "der",
  type: "pkcs8",
});
export const TEST_PUBLIC_PEM = createPublicKey(TEST_KEY).export({
  type: "spki",
  format: "pem",
}) as string;
export const TEST_PRIVATE_PEM = TEST_KEY.export({
  type: "pkcs8",
  format: "pem",
}) as string;

export const SHARED: CloudSharedConfig = {
  groupId: GROUP,
  portalBaseUrl: "https://portal.example.test",
  jobApiToken: PORTAL_TOKEN,
};
export const COMPLETION: CloudCompletionConfig = {
  signingKey: TEST_KEY,
  kid: KID,
  liffId: LIFF_ID,
};
export const COMPLETION_OK: CloudCompletionResult = {
  ok: true,
  config: COMPLETION,
};

/** 1本の記録（portal・KV・LINE の呼び出しを、起きた順に並べる） */
export type Journal = string[];

// ---------------------------------------------------------------- 時計
export interface FakeClock {
  now: () => number;
  advance: (ms: number) => void;
}
export function fakeClock(
  start: number = Date.parse("2026-10-11T03:00:00.000Z"),
): FakeClock {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

// ---------------------------------------------------------------- KV
export type StoreOp = keyof CloudStore;
export interface FakeStore extends CloudStore {
  /** その操作を、次の times 回だけ例外にする（times を省けばずっと） */
  failOn(op: StoreOp, times?: number): void;
  clearFails(): void;
  /** acquireLock がいつも true＝錠が効かない場面 */
  brokenLock(): void;
  /** 形の違う控えなどを直接置く（目次にも足す） */
  putRaw(no: number, value: unknown): void;
  /** 控えの無い番号を目次にだけ置く */
  orphanIndex(no: number): void;
  orphanNoticeIndex(member: string): void;
  /** 期限の切れていない全部の鍵と値・目次 */
  dump(): { keys: Record<string, unknown>; sets: Record<string, string[]> };
  /** 控えを読む（無ければ null） */
  rawJob(no: number): Record<string, unknown> | null;
  lockHeld(): boolean;
}

export function fakeStore(clock: FakeClock, journal: Journal = []): FakeStore {
  const data = new Map<string, { value: string; exp: number }>();
  const sets = new Map<string, Set<string>>();
  const live = (key: string) => {
    const e = data.get(key);
    if (!e) return null;
    if (e.exp <= clock.now()) {
      data.delete(key);
      return null;
    }
    return e;
  };
  const client: CloudKvClient = {
    async set(key, value, opts) {
      if (opts.nx && live(key)) return null;
      data.set(key, { value, exp: clock.now() + opts.ex * 1000 });
      return "OK";
    },
    async get(key) {
      const e = live(key);
      // @vercel/kv と同じく、JSON の文字列は物に戻して返す
      if (!e) return null;
      try {
        return JSON.parse(e.value);
      } catch {
        return e.value;
      }
    },
    async del(key) {
      return data.delete(key) ? 1 : 0;
    },
    async sadd(key, member) {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key)!.add(member);
      return 1;
    },
    async srem(key, member) {
      return sets.get(key)?.delete(member) ? 1 : 0;
    },
    async smembers(key) {
      return Array.from(sets.get(key) ?? []);
    },
  };
  const real = createKvCloudStore(client);
  const fails = new Map<string, number>();
  let broken = false;
  const guard = (op: StoreOp) => {
    const left = fails.get(op);
    if (left === undefined || left <= 0) return;
    fails.set(op, left - 1);
    throw Object.assign(new Error("fake store failure"), {
      name: "FakeStoreError",
    });
  };
  const wrap =
    <A extends unknown[], R>(
      op: StoreOp,
      f: (...a: A) => Promise<R>,
      note?: (...a: A) => string,
    ) =>
    async (...a: A): Promise<R> => {
      journal.push(`store:${op}${note ? `:${note(...a)}` : ""}`);
      guard(op);
      return f(...a);
    };
  return {
    acquireLock: wrap("acquireLock", async () =>
      broken ? true : real.acquireLock(),
    ),
    releaseLock: wrap("releaseLock", () => real.releaseLock()),
    listJobNos: wrap("listJobNos", (limit) => real.listJobNos(limit)),
    getJob: wrap(
      "getJob",
      (no) => real.getJob(no),
      (no) => String(no),
    ),
    putJob: wrap(
      "putJob",
      (no, memo) => real.putJob(no, memo),
      (no, memo) => `${no}:${memo.stage}`,
    ),
    delJob: wrap(
      "delJob",
      (no) => real.delJob(no),
      (no) => String(no),
    ),
    unindexJob: wrap(
      "unindexJob",
      (no) => real.unindexJob(no),
      (no) => String(no),
    ),
    getRetry: wrap(
      "getRetry",
      (no, s) => real.getRetry(no, s),
      (no) => String(no),
    ),
    bumpRetry: wrap(
      "bumpRetry",
      (no, s, iso) => real.bumpRetry(no, s, iso),
      (no) => String(no),
    ),
    clearRetry: wrap(
      "clearRetry",
      (no, s) => real.clearRetry(no, s),
      (no) => String(no),
    ),
    listNoticeMsgs: wrap("listNoticeMsgs", (limit) =>
      real.listNoticeMsgs(limit),
    ),
    getNoticeMsg: wrap(
      "getNoticeMsg",
      (no, g) => real.getNoticeMsg(no, g),
      (no, g) => `${no}:${g}`,
    ),
    putNoticeMsg: wrap(
      "putNoticeMsg",
      (no, g, v) => real.putNoticeMsg(no, g, v),
      (no, g) => `${no}:${g}`,
    ),
    delNoticeMsg: wrap(
      "delNoticeMsg",
      (no, g) => real.delNoticeMsg(no, g),
      (no, g) => `${no}:${g}`,
    ),
    unindexNoticeMsg: wrap(
      "unindexNoticeMsg",
      (no, g) => real.unindexNoticeMsg(no, g),
      (no, g) => `${no}:${g}`,
    ),
    failOn: (op, times = Number.MAX_SAFE_INTEGER) => void fails.set(op, times),
    clearFails: () => fails.clear(),
    brokenLock: () => void (broken = true),
    putRaw(no, value) {
      if (!sets.has("obi-cloud:jobs")) sets.set("obi-cloud:jobs", new Set());
      sets.get("obi-cloud:jobs")!.add(String(no));
      data.set(`obi-cloud:job:${no}`, {
        value: JSON.stringify(value),
        exp: clock.now() + 3_600_000,
      });
    },
    orphanIndex(no) {
      if (!sets.has("obi-cloud:jobs")) sets.set("obi-cloud:jobs", new Set());
      sets.get("obi-cloud:jobs")!.add(String(no));
    },
    orphanNoticeIndex(member) {
      if (!sets.has("obi-cloud:notice-msgs"))
        sets.set("obi-cloud:notice-msgs", new Set());
      sets.get("obi-cloud:notice-msgs")!.add(member);
    },
    dump() {
      const keys: Record<string, unknown> = {};
      for (const key of Array.from(data.keys())) {
        const e = live(key);
        if (e) keys[key] = JSON.parse(e.value);
      }
      const out: Record<string, string[]> = {};
      for (const [k, v] of Array.from(sets.entries()))
        out[k] = Array.from(v).sort();
      return { keys, sets: out };
    },
    rawJob(no) {
      const e = live(`obi-cloud:job:${no}`);
      return e ? (JSON.parse(e.value) as Record<string, unknown>) : null;
    },
    lockHeld: () => live("obi-cloud:lock") !== null,
  };
}

// ---------------------------------------------------------------- LINE
export type PushResult = {
  ok: boolean;
  messageId: string | null;
  rejected?: boolean;
};
export interface FakeLine {
  push: (text: string) => Promise<PushResult>;
  texts: string[];
  /** push の応答に入れた message.id の一覧 */
  ids: string[];
  /** 次の push の結果を並べる（"throw" は投げる） */
  next(
    ...results: Array<PushResult | "throw" | "rejected" | "unknown" | "no-id">
  ): void;
}
export function fakeLine(journal: Journal = []): FakeLine {
  const queue: Array<PushResult | "throw"> = [];
  const texts: string[] = [];
  const ids: string[] = [];
  let seq = 0;
  return {
    texts,
    ids,
    async push(text) {
      texts.push(text);
      journal.push("line:push");
      const r = queue.shift();
      if (r === "throw") throw new Error("push exploded");
      if (r) return r;
      seq += 1;
      const id = `60000000000000${String(seq).padStart(4, "0")}`;
      ids.push(id);
      return { ok: true, messageId: id };
    },
    next(...results) {
      for (const r of results) {
        if (r === "rejected")
          queue.push({ ok: false, messageId: null, rejected: true });
        else if (r === "unknown") queue.push({ ok: false, messageId: null });
        else if (r === "no-id") queue.push({ ok: true, messageId: null });
        else queue.push(r);
      }
    },
  };
}

// ---------------------------------------------------------------- portal
const LEASE_MS = 45 * 60_000;
const REVIEW_MS = 10 * 60_000;

export interface FakeJobInput {
  no: number;
  status: string;
  workflow?: string;
  replyKind?: string;
  replyGroupId?: string | null;
  property?: string;
  artifactSha256?: string | null;
  reviewPages?: unknown;
  outsideErased?: unknown;
  outsidePages?: unknown;
  fix?: unknown;
  /** 差し戻しの行の項目（rejectState・choiceGen・choices・rejectRound・rejectKind・rejectReason など） */
  row?: Record<string, unknown>;
  /** グループあての知らせの鍵（状態が合うあいだだけ groupNotice に出る） */
  notice?: { kind: "reject" | "failure"; gen: string } | null;
}
interface FakeJob extends Required<
  Pick<FakeJobInput, "no" | "status" | "workflow" | "replyKind">
> {
  replyGroupId: string | null;
  property: string;
  artifactSha256: string | null;
  claimExtras: Record<string, unknown>;
  row: Record<string, unknown>;
  notice: { kind: "reject" | "failure"; gen: string } | null;
  claim: {
    claimId: string;
    via: string;
    leaseUntil: number;
    attemptAt: number | null;
  } | null;
  settled: { claimId: string; outcome: string } | null;
}
export interface NoticeRow {
  by: string;
  state: "prepared" | "attempting" | "sent" | "unknown" | "failed" | "stale";
  claimId: string;
  tries: number;
  claimedAt: number;
  attemptAt: number | null;
}
export type PortalOp = keyof CloudPortal;
type Canned = (PortalCall<never> | { kind: "throw" }) & { applied?: boolean };

export interface FakePortal extends CloudPortal {
  add(job: FakeJobInput): void;
  job(no: number): FakeJob;
  setStatus(
    no: number,
    status: string,
    notice?: { kind: "reject" | "failure"; gen: string } | null,
  ): void;
  /** 人が（納品要確認を通って）完成へ戻して、Mac が取り直した場面 */
  takeOver(no: number): void;
  /** 人が完成へ戻しただけの場面 */
  returnToDone(no: number): void;
  /** 一覧の peers.mac.noticeClaim（which を省けば全部の一覧） */
  setPeers(v: boolean | null | "absent", which?: "reject" | "failure"): void;
  withoutGroupNotice(): void;
  setSeeded(v: boolean): void;
  /** 予約の応答の via を "" にする（古い portal） */
  legacyClaim(): void;
  /** 次の1回だけ、その答えを返す。applied: true なら、portal の側は受けた上で、その答えを返す */
  failNext(op: PortalOp, canned: Canned): void;
  /** 呼ばれるたびに動かす（時間の予算の試験で、時計を進める） */
  onCall: ((op: PortalOp, no: number | null) => void) | null;
  calls: Array<{ op: PortalOp; no: number | null; args: unknown }>;
  callsOf(
    op: PortalOp,
  ): Array<{ op: PortalOp; no: number | null; args: unknown }>;
  /** 依頼の状態の遷移の記録 */
  events: string[];
  noticeRow(no: number, kind: string, gen: string): NoticeRow | null;
  /** その行に手を入れる（taken の形の試験用） */
  putNoticeRow(
    no: number,
    kind: string,
    gen: string,
    row: Partial<NoticeRow> & { state: NoticeRow["state"] },
  ): void;
  /** 出した予約の番号の全部（完成・知らせ）。「ログに出ない」の確かめ用 */
  issuedClaimIds: string[];
}

export function fakePortal(
  clock: FakeClock,
  journal: Journal = [],
): FakePortal {
  const jobs = new Map<number, FakeJob>();
  const notices = new Map<string, NoticeRow>();
  const canned = new Map<string, Canned[]>();
  const peers: Record<string, boolean | null> = {
    reject: true,
    failure: true,
    done: true,
  };
  const calls: FakePortal["calls"] = [];
  const events: string[] = [];
  const issuedClaimIds: string[] = [];
  let seeded = true;
  let groupNoticeField = true;
  let legacy = false;

  const nkey = (no: number, kind: string, gen: string) =>
    `${no}|${kind}|${gen}`;
  const newClaimId = () => {
    const id = randomUUID();
    issuedClaimIds.push(id);
    return id;
  };
  const move = (j: FakeJob, to: string, by: string) => {
    events.push(`${j.no}:${j.status}->${to}:${by}`);
    j.status = to;
  };
  const rejected = (status: number, code: string): PortalCall<never> => ({
    kind: "rejected",
    status,
    code,
  });
  const okOf = <T>(value: T, status = 200): PortalCall<T> => ({
    kind: "ok",
    status,
    value,
  });
  /** 納品の予約の期限切れ（portal の掃除）。attempt の入口では走らせない */
  const sweepLease = (j: FakeJob) => {
    if (j.status === "納品中" && j.claim && j.claim.leaseUntil <= clock.now())
      move(j, "納品要確認", "lease");
  };
  const currentNotice = (j: FakeJob) => {
    if (!j.notice) return null;
    if (j.notice.kind === "reject" && j.status === "差し戻し") return j.notice;
    if (j.notice.kind === "failure" && j.status === "失敗") return j.notice;
    return null;
  };
  const retryable = (r: NoticeRow) => {
    if (r.state === "prepared")
      return clock.now() - r.claimedAt >= REVIEW_MS && r.tries < 3;
    if (r.state === "failed") return r.tries < 3;
    return r.state === "stale";
  };
  /** 10分の見直し */
  const review = (only?: number) => {
    for (const [key, r] of Array.from(notices.entries())) {
      if (only !== undefined && !key.startsWith(`${only}|`)) continue;
      if (
        r.state === "attempting" &&
        clock.now() - (r.attemptAt ?? r.claimedAt) >= REVIEW_MS
      )
        r.state = "unknown";
      else if (
        r.state === "prepared" &&
        clock.now() - r.claimedAt >= REVIEW_MS &&
        r.tries >= 3
      )
        r.state = "failed";
    }
  };

  /** 呼び出しの共通の前処理。canned があれば、その答え（applied なら run を先に動かす） */
  const enter = async <T>(
    op: PortalOp,
    no: number | null,
    args: unknown,
    timeoutMs: number,
    run: () => PortalCall<T>,
  ): Promise<PortalCall<T>> => {
    if (!(timeoutMs >= 1000)) return { kind: "unknown", reason: "no-time" };
    calls.push({
      op,
      no,
      args: args === undefined ? null : JSON.parse(JSON.stringify(args)),
    });
    self.onCall?.(op, no);
    const c = canned.get(op)?.shift();
    let result: PortalCall<T>;
    if (c) {
      if (c.applied) run();
      if (c.kind === "throw") {
        journal.push(`portal:${op}${no === null ? "" : `:${no}`}:throw`);
        throw Object.assign(new Error("fake portal exploded"), {
          name: "FakePortalError",
        });
      }
      const { applied: _a, ...rest } = c;
      void _a;
      result = rest as PortalCall<T>;
    } else {
      result = run();
    }
    journal.push(
      `portal:${op}${no === null ? "" : `:${no}`}:${result.kind === "ok" ? "ok" : result.kind === "rejected" ? result.code : result.reason}`,
    );
    // 本物と同じく、答えは次の順番で返る
    await Promise.resolve();
    return result;
  };

  const self: FakePortal = {
    onCall: null,
    calls,
    events,
    issuedClaimIds,
    callsOf: (op) => calls.filter((c) => c.op === op),
    add(j) {
      jobs.set(j.no, {
        no: j.no,
        status: j.status,
        workflow: j.workflow ?? "obi",
        replyKind: j.replyKind ?? "line-group",
        replyGroupId: j.replyGroupId === undefined ? GROUP : j.replyGroupId,
        property: j.property ?? "",
        artifactSha256:
          j.artifactSha256 === undefined
            ? sha(`artifact-${j.no}`)
            : j.artifactSha256,
        claimExtras: {
          reviewPages: j.reviewPages ?? 0,
          outsideErased: j.outsideErased ?? 0,
          outsidePages: j.outsidePages ?? [],
          fix: j.fix ?? null,
        },
        row: j.row ?? {},
        notice: j.notice ?? null,
        claim: null,
        settled: null,
      });
    },
    job(no) {
      const j = jobs.get(no);
      if (!j) throw new Error(`fake portal: no job ${no}`);
      return j;
    },
    setStatus(no, status, notice) {
      const j = self.job(no);
      move(j, status, "test");
      if (notice !== undefined) j.notice = notice;
    },
    takeOver(no) {
      const j = self.job(no);
      if (
        j.status === "納品中" &&
        j.claim &&
        j.claim.attemptAt !== null &&
        j.claim.leaseUntil > clock.now()
      ) {
        throw new Error(
          "attempt の通った期限内の納品中は、人の操作で完成へ戻せない（約束 1b）",
        );
      }
      j.claim = {
        claimId: newClaimId(),
        via: "",
        leaseUntil: clock.now() + LEASE_MS,
        attemptAt: null,
      };
      j.settled = null;
      j.status = "納品中"; // 場面を作るだけ（events には残さない＝この後に増えないことを確かめるため）
    },
    returnToDone(no) {
      const j = self.job(no);
      if (
        j.status === "納品中" &&
        j.claim &&
        j.claim.attemptAt !== null &&
        j.claim.leaseUntil > clock.now()
      ) {
        throw new Error(
          "attempt の通った期限内の納品中は、人の操作で完成へ戻せない（約束 1b）",
        );
      }
      j.claim = null;
      j.settled = null;
      j.status = "完成";
    },
    setPeers(v, which) {
      const value = v === "absent" ? null : v;
      if (which) peers[which] = value;
      else for (const k of Object.keys(peers)) peers[k] = value;
    },
    withoutGroupNotice: () => void (groupNoticeField = false),
    setSeeded: (v) => void (seeded = v),
    legacyClaim: () => void (legacy = true),
    failNext(op, c) {
      if (!canned.has(op)) canned.set(op, []);
      canned.get(op)!.push(c);
    },
    noticeRow: (no, kind, gen) => notices.get(nkey(no, kind, gen)) ?? null,
    putNoticeRow(no, kind, gen, row) {
      notices.set(nkey(no, kind, gen), {
        by: "mac",
        claimId: "",
        tries: 1,
        claimedAt: clock.now(),
        attemptAt: null,
        ...row,
      });
    },

    listJobs: (q, timeoutMs) =>
      enter<JobList>("listJobs", null, q, timeoutMs, () => {
        for (const j of Array.from(jobs.values())) sweepLease(j);
        review();
        const want = "status" in q ? q.status : "失敗";
        const which =
          "status" in q
            ? q.status === "差し戻し"
              ? "reject"
              : "done"
            : "failure";
        const rows: CloudJobRow[] = [];
        for (const j of Array.from(jobs.values()).sort((a, b) => a.no - b.no)) {
          if (j.status !== want) continue;
          const row: CloudJobRow = {
            no: j.no,
            status: j.status,
            workflow: j.workflow,
            replyKind: j.replyKind,
            replyGroupId: j.replyGroupId,
            property: j.property,
            deliveryVia: "",
            ...j.row,
          };
          if (j.artifactSha256 !== null) row.artifactSha256 = j.artifactSha256;
          if (groupNoticeField) {
            const n = currentNotice(j);
            if (!n) row.groupNotice = null;
            else {
              const r = notices.get(nkey(j.no, n.kind, n.gen));
              row.groupNotice = {
                kind: n.kind,
                gen: n.gen,
                taken: r
                  ? { by: r.by, state: r.state, retryable: retryable(r) }
                  : null,
              };
            }
          }
          rows.push(row);
        }
        return okOf({ jobs: rows, macNoticeClaim: peers[which] });
      }),

    claimDelivery: (no, timeoutMs) =>
      enter<ClaimedDelivery>("claimDelivery", no, undefined, timeoutMs, () => {
        const j = jobs.get(no);
        if (!j) return rejected(404, "NOT_FOUND");
        sweepLease(j);
        if (j.status !== "完成" || j.artifactSha256 === null)
          return rejected(409, "DELIVERY_IN_PROGRESS");
        const via = legacy ? "" : "cloud";
        j.claim = {
          claimId: newClaimId(),
          via,
          leaseUntil: clock.now() + LEASE_MS,
          attemptAt: null,
        };
        j.settled = null;
        move(j, "納品中", "claim");
        const leaseUntil = new Date(j.claim.leaseUntil).toISOString();
        const raw: Record<string, unknown> = {
          no,
          status: j.status,
          claimId: j.claim.claimId,
          leaseUntil,
          artifactName: "x.pdf",
          artifactSha256: j.artifactSha256,
          replyKind: j.replyKind,
          replyGroupId: j.replyGroupId,
          ...j.claimExtras,
          // 応答に物件名があっても、見回りは使わない（一覧の行の値を整えて使う）
          property: "予約の応答の物件名（使わない）",
          via,
        };
        return okOf({
          claimId: j.claim.claimId,
          artifactSha256: j.artifactSha256,
          leaseUntil,
          via,
          replyKind: j.replyKind,
          replyGroupId: j.replyGroupId,
          raw,
        });
      }),

    attemptDelivery: (no, claimId, timeoutMs) =>
      enter<{ attempted: true; leaseUntil: string }>(
        "attemptDelivery",
        no,
        { claimId },
        timeoutMs,
        () => {
          const j = jobs.get(no);
          if (!j) return rejected(404, "NOT_FOUND");
          const c = j.claim;
          if (
            j.status !== "納品中" ||
            !c ||
            c.claimId !== claimId ||
            c.via !== "cloud" ||
            c.leaseUntil <= clock.now()
          ) {
            return rejected(409, "CLAIM_MISMATCH");
          }
          if (c.attemptAt === null) c.attemptAt = clock.now();
          return okOf({
            attempted: true as const,
            leaseUntil: new Date(c.leaseUntil).toISOString(),
          });
        },
      ),

    reportDeliveryMessage: (no, body: DeliveryMessageBody, timeoutMs) =>
      enter<{ recorded: true }>(
        "reportDeliveryMessage",
        no,
        body,
        timeoutMs,
        () => {
          const j = jobs.get(no);
          if (
            !j ||
            j.replyKind !== "line-group" ||
            j.replyGroupId !== body.groupId
          )
            return rejected(404, "NOT_FOUND");
          if ("kind" in body) {
            if (
              j.status !== "差し戻し" ||
              j.row.rejectState !== "offered" ||
              j.row.choiceGen !== body.choiceGen
            ) {
              return rejected(409, "CHOICE_STALE");
            }
          }
          return okOf({ recorded: true as const });
        },
      ),

    reportDeliveryResult: (no, body: DeliveryResultBody, timeoutMs) =>
      enter<{ status: string }>(
        "reportDeliveryResult",
        no,
        body,
        timeoutMs,
        () => {
          const j = jobs.get(no);
          if (!j) return rejected(404, "NOT_FOUND");
          sweepLease(j);
          if (j.settled && j.settled.claimId === body.claimId) {
            // 同じ予約の同じ結果の再送は成功
            return j.settled.outcome === body.outcome
              ? okOf({ status: j.status })
              : rejected(409, "STATE_CONFLICT");
          }
          if (!j.claim || j.claim.claimId !== body.claimId)
            return rejected(409, "CLAIM_MISMATCH");
          if (j.status !== "納品中" && j.status !== "納品要確認")
            return rejected(409, "STATE_CONFLICT");
          if (
            !("legacy" in body) &&
            j.claim.via !== "cloud" &&
            body.outcome === "delivered"
          ) {
            return rejected(400, "INVALID_REQUEST"); // クラウドの予約でないのに driveFileId なし
          }
          j.settled = { claimId: body.claimId, outcome: body.outcome };
          if (body.outcome === "delivered") move(j, "納品済み", "result");
          else if (body.outcome === "not_sent") {
            j.claim = null;
            move(j, "完成", "result");
          } else move(j, "納品要確認", "result");
          return okOf({ status: j.status });
        },
      ),

    noticeSeed: (timeoutMs) =>
      enter<{ seeded: boolean }>(
        "noticeSeed",
        null,
        { version: 1 },
        timeoutMs,
        () => {
          if (seeded) return okOf({ seeded: false });
          for (const j of Array.from(jobs.values())) {
            const n = currentNotice(j);
            if (!n || notices.has(nkey(j.no, n.kind, n.gen))) continue;
            notices.set(nkey(j.no, n.kind, n.gen), {
              by: "seed",
              state: "sent",
              claimId: "",
              tries: 0,
              claimedAt: clock.now(),
              attemptAt: null,
            });
          }
          seeded = true;
          return okOf({ seeded: true });
        },
      ),

    noticeClaim: (no, key: NoticeKey, groupId, timeoutMs) =>
      enter<NoticeClaimed>(
        "noticeClaim",
        no,
        { ...key, groupId },
        timeoutMs,
        () => {
          const j = jobs.get(no);
          if (!j || j.replyKind !== "line-group" || j.replyGroupId !== groupId)
            return rejected(404, "NOT_FOUND");
          if (!seeded) return rejected(409, "NOTICE_NOT_SEEDED");
          review(no);
          const n = currentNotice(j);
          if (!n || n.kind !== key.kind || n.gen !== key.gen)
            return rejected(409, "NOTICE_STALE");
          const k = nkey(no, key.kind, key.gen);
          const r = notices.get(k);
          if (!r) {
            const claimId = newClaimId();
            notices.set(k, {
              by: "cloud",
              state: "prepared",
              claimId,
              tries: 1,
              claimedAt: clock.now(),
              attemptAt: null,
            });
            return okOf({ claimed: true as const, claimId }, 201);
          }
          if (retryable(r)) {
            r.state = "prepared";
            r.claimId = newClaimId();
            r.tries += 1;
            r.by = "cloud";
            r.claimedAt = clock.now();
            r.attemptAt = null;
            return okOf({ claimed: true as const, claimId: r.claimId });
          }
          return okOf({ claimed: false as const });
        },
      ),

    noticeAttempt: (no, key, claimId, timeoutMs) =>
      enter<{ state: "attempting" }>(
        "noticeAttempt",
        no,
        { ...key },
        timeoutMs,
        () => {
          const r = notices.get(nkey(no, key.kind, key.gen));
          if (!r) return rejected(404, "NOT_FOUND");
          review(no);
          if (r.claimId !== claimId) return rejected(409, "NOTICE_CLAIM_STALE");
          if (r.state === "attempting")
            return okOf({ state: "attempting" as const });
          if (r.state === "stale") return rejected(409, "NOTICE_STALE");
          if (r.state !== "prepared") return rejected(409, "NOTICE_SETTLED");
          const j = jobs.get(no);
          const n = j ? currentNotice(j) : null;
          if (!n || n.kind !== key.kind || n.gen !== key.gen) {
            r.state = "stale";
            return rejected(409, "NOTICE_STALE");
          }
          r.state = "attempting";
          r.attemptAt = clock.now();
          return okOf({ state: "attempting" as const });
        },
      ),

    noticeResult: (no, key, claimId, state, timeoutMs) =>
      enter<{ state: string }>(
        "noticeResult",
        no,
        { ...key, state },
        timeoutMs,
        () => {
          const r = notices.get(nkey(no, key.kind, key.gen));
          if (!r) return rejected(404, "NOT_FOUND");
          review(no);
          if (r.claimId !== claimId) return rejected(409, "NOTICE_CLAIM_STALE");
          if (r.state !== "prepared" && r.state !== "attempting") {
            return r.state === state
              ? okOf({ state: r.state })
              : rejected(409, "NOTICE_SETTLED");
          }
          if (r.state === "prepared" && state !== "failed")
            return rejected(409, "STATE_CONFLICT");
          r.state = state;
          return okOf({ state });
        },
      ),
  };
  return self;
}

// ---------------------------------------------------------------- 差し込み口と部品
export interface FakeWorld {
  clock: FakeClock;
  journal: Journal;
  portal: FakePortal;
  store: FakeStore;
  line: FakeLine;
  logs: string[];
  deps: CloudDeps;
  /** その差し込み口で止める（null で外す） */
  haltAt(point: CloudCheckpoint | null): void;
  /** 見回り1回ぶんの ctx（開始＝今） */
  ctx(over?: {
    completion?: CloudCompletionConfig | null;
    fixGuide?: boolean;
  }): TickCtx;
}

export function makeDeps(parts: {
  clock: FakeClock;
  portal: CloudPortal;
  store: CloudStore;
  line: FakeLine;
  halt?: CloudCheckpoint | null;
  logs?: string[];
}): CloudDeps & { logs: string[]; halt: { at: CloudCheckpoint | null } } {
  const logs = parts.logs ?? [];
  const halt = { at: parts.halt ?? null };
  let jti = 0;
  return {
    logs,
    halt,
    now: parts.clock.now,
    portal: parts.portal,
    store: parts.store,
    push: parts.line.push,
    // 実物の log（cloud-entry.ts）と同じ形にそろえる
    log: (line) => void logs.push(`cloud-tick ${line}`),
    checkpoint: (point) => {
      if (halt.at === point) throw new CloudHalt(point);
    },
    randomJti: () => (++jti).toString(16).padStart(16, "0"),
    seedMemo: { confirmed: false },
  };
}

export function fakeWorld(): FakeWorld {
  const clock = fakeClock();
  const journal: Journal = [];
  const portal = fakePortal(clock, journal);
  const store = fakeStore(clock, journal);
  const line = fakeLine(journal);
  const deps = makeDeps({ clock, portal, store, line });
  return {
    clock,
    journal,
    portal,
    store,
    line,
    logs: deps.logs,
    deps,
    haltAt: (point) => void (deps.halt.at = point),
    ctx: (over = {}) =>
      newTickCtx({
        deps,
        shared: SHARED,
        completion:
          over.completion === null
            ? { ok: false, problems: ["OBI_CLOUD_SIGNING_KEY"] }
            : { ok: true, config: over.completion ?? COMPLETION },
        fixGuide: over.fixGuide ?? false,
        startedAt: clock.now(),
      }),
  };
}

/** CloudHalt で止まることを確かめる（止まった差し込み口の名前。止まらなければ null） */
export async function haltedAt(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    if (e instanceof CloudHalt) return e.point;
    throw e;
  }
}

/** push した本文からリンクのトークンを取り出す */
export const tokenOf = (text: string): string => {
  const m = /https:\/\/liff\.line\.me\/[^?\s]+\?t=(\S+)/.exec(text);
  return m ? m[1] : "";
};
/** リンクのトークンの所を除いた本文（同じ文かどうかの比べ用） */
export const withoutToken = (text: string): string =>
  text.replace(/\?t=\S+/, "?t=<TOKEN>");
