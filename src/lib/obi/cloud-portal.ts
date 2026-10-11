/**
 * クラウド配達（毎分の見回り）が使う portal の呼び出し
 * （約束 2026-10-11-obi-cloud-contract.md の「K1 が作る・変える入口」1・1b・2・4・7 と、
 *   差し戻しの選択肢の約束の delivery/message）。
 * - どの呼び出しにも x-job-token と x-job-client: aisecretary を付ける（名乗りは見回りの呼び出しにだけ。
 *   既存の Webhook 側の portal.ts は変えない・ここから読み込まない）
 * - 例外は投げない。結果は ok／rejected（4xx＝答えは届いた）／unknown（分からない）の3つに分ける
 * - 成功の番号なのに形が違えば「分からない」に倒す
 * - 鍵・例外の文・応答の本文そのものは、戻り値に入れない（入れるのは検査した項目と、形の合う code だけ）
 */

export interface CloudPortalOpts {
  fetchImpl: typeof fetch;
  baseUrl: string; // 末尾の / なし
  token: string;
}

/** どの呼び出しも、この3つに分ける。例外は投げない */
export type PortalCall<T> =
  | { kind: "ok"; status: number; value: T }
  | { kind: "rejected"; status: number; code: string } // 4xx。code は ^[A-Z0-9_]{1,40}$ に合うものだけ。合わなければ HTTP_<status>
  | {
      kind: "unknown";
      reason: "timeout" | "network" | "http-5xx" | "invalid-body" | "no-time";
    };

/** 一覧の行。検査するのは no だけ（正の整数）。ほかの項目は、使う所で形を見る */
export type CloudJobRow = Record<string, unknown> & { no: number };
export interface JobList {
  jobs: CloudJobRow[];
  /** 応答の peers.mac.noticeClaim。peers が無い・形が違えば null（＝出さない側） */
  macNoticeClaim: boolean | null;
}
export interface ClaimedDelivery {
  claimId: string; // UUID の形を検査済み
  artifactSha256: string; // 64桁を検査済み
  leaseUntil: string; // Date.parse できることを検査済み
  via: string; // "cloud" のはず。違えば呼ぶ側が予約を返す
  replyKind: string;
  replyGroupId: string | null;
  /** reviewPages・outsideErased・outsidePages・fix を読むための、応答そのもの */
  raw: Record<string, unknown>;
}
export type NoticeKind = "reject" | "failure";
export interface NoticeKey {
  kind: NoticeKind;
  gen: string;
} // dest はいつも "line-group"

export type DeliveryMessageBody =
  | { groupId: string; artifactSha256: string; messageId: string } // 完成（kind・choiceGen は付けない）
  | { groupId: string; messageId: string; kind: "reject"; choiceGen: number }; // 選択肢つきの差し戻し（artifactSha256 は付けない）

export type DeliveryResultBody =
  | { claimId: string; outcome: "delivered" }
  | {
      claimId: string;
      outcome: "not_sent";
      reason: "push-rejected" | "target" | "config";
    }
  | {
      claimId: string;
      outcome: "unknown";
      reason: "push-unknown" | "interrupted";
    }
  | { claimId: string; outcome: "not_sent"; legacy: true }; // 応答の via が "cloud" でなかった予約を返すときだけ（via・reason を付けない）

export type NoticeClaimed =
  { claimed: true; claimId: string } | { claimed: false };

export interface CloudPortal {
  listJobs(
    q: { status: "完成" | "差し戻し" } | { recentFailed: true },
    timeoutMs: number,
  ): Promise<PortalCall<JobList>>;
  claimDelivery(
    no: number,
    timeoutMs: number,
  ): Promise<PortalCall<ClaimedDelivery>>;
  /** 約束の 1b（原子的な「送信中の印」）。新しい配達でも再開でも、LINE を呼ぶ直前に必ず通す。200 のときだけ push してよい */
  attemptDelivery(
    no: number,
    claimId: string,
    timeoutMs: number,
  ): Promise<PortalCall<{ attempted: true; leaseUntil: string }>>;
  reportDeliveryMessage(
    no: number,
    body: DeliveryMessageBody,
    timeoutMs: number,
  ): Promise<PortalCall<{ recorded: true }>>;
  reportDeliveryResult(
    no: number,
    body: DeliveryResultBody,
    timeoutMs: number,
  ): Promise<PortalCall<{ status: string }>>;
  noticeSeed(timeoutMs: number): Promise<PortalCall<{ seeded: boolean }>>;
  noticeClaim(
    no: number,
    key: NoticeKey,
    groupId: string,
    timeoutMs: number,
  ): Promise<PortalCall<NoticeClaimed>>;
  noticeAttempt(
    no: number,
    key: NoticeKey,
    claimId: string,
    timeoutMs: number,
  ): Promise<PortalCall<{ state: "attempting" }>>;
  noticeResult(
    no: number,
    key: NoticeKey,
    claimId: string,
    state: "sent" | "unknown" | "failed",
    timeoutMs: number,
  ): Promise<PortalCall<{ state: string }>>;
}

export const CLOUD_CLIENT_NAME = "aisecretary";
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
const CODE_RE = /^[A-Z0-9_]{1,40}$/;
/** これより短い上限では呼ばない（呼んでも答えを待てない） */
const MIN_CALL_MS = 1_000;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isIsoLike = (v: unknown): v is string =>
  typeof v === "string" && v !== "" && !Number.isNaN(Date.parse(v));
const isPosInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

function parseJobList(b: unknown): JobList | null {
  if (!isObj(b) || !Array.isArray(b.jobs)) return null;
  // 物でない要素・no が正の整数でない要素は捨てる
  const jobs = b.jobs.filter(
    (j): j is CloudJobRow => isObj(j) && isPosInt(j.no),
  );
  const mac =
    isObj(b.peers) && isObj(b.peers.mac) ? b.peers.mac.noticeClaim : null;
  return {
    jobs,
    macNoticeClaim: mac === true ? true : mac === false ? false : null,
  };
}

function parseClaim(b: unknown): ClaimedDelivery | null {
  if (!isObj(b)) return null;
  if (typeof b.claimId !== "string" || !UUID_RE.test(b.claimId)) return null;
  if (typeof b.artifactSha256 !== "string" || !SHA256_RE.test(b.artifactSha256))
    return null;
  if (!isIsoLike(b.leaseUntil)) return null;
  return {
    claimId: b.claimId,
    artifactSha256: b.artifactSha256,
    leaseUntil: b.leaseUntil,
    via: typeof b.via === "string" ? b.via : "",
    replyKind: typeof b.replyKind === "string" ? b.replyKind : "",
    replyGroupId: typeof b.replyGroupId === "string" ? b.replyGroupId : null,
    raw: b,
  };
}

export function createCloudPortal(opts: CloudPortalOpts): CloudPortal {
  const call = async <T>(
    method: "GET" | "POST",
    path: string,
    payload: Record<string, unknown> | null,
    timeoutMs: number,
    parse: (body: unknown) => T | null,
    extraHeaders: Record<string, string> = {},
  ): Promise<PortalCall<T>> => {
    if (!(timeoutMs >= MIN_CALL_MS))
      return { kind: "unknown", reason: "no-time" };
    const headers: Record<string, string> = {
      "x-job-token": opts.token,
      "x-job-client": CLOUD_CLIENT_NAME,
      ...extraHeaders,
    };
    const init: RequestInit = {
      method,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (payload !== null) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(payload);
    }
    let res: Response;
    try {
      res = await opts.fetchImpl(`${opts.baseUrl}${path}`, init);
    } catch (err) {
      // 例外の文は残さない（中に URL が入りうる）。名前で分けるだけ
      const name = (err as { name?: unknown } | null)?.name;
      return {
        kind: "unknown",
        reason:
          name === "TimeoutError" || name === "AbortError"
            ? "timeout"
            : "network",
      };
    }
    const status = res.status;
    let body: unknown = undefined;
    let readFailed = false;
    try {
      body = JSON.parse(await res.text());
    } catch (err) {
      readFailed = true;
      const name = (err as { name?: unknown } | null)?.name;
      // 本文を読んでいる途中の時間切れは、番号によらず「分からない」
      if (name === "TimeoutError" || name === "AbortError")
        return { kind: "unknown", reason: "timeout" };
    }
    if (status >= 200 && status < 300) {
      if (readFailed) return { kind: "unknown", reason: "invalid-body" };
      const value = parse(body);
      return value === null
        ? { kind: "unknown", reason: "invalid-body" }
        : { kind: "ok", status, value };
    }
    if (status >= 400 && status < 500) {
      const code =
        isObj(body) && typeof body.code === "string" && CODE_RE.test(body.code)
          ? body.code
          : `HTTP_${status}`;
      return { kind: "rejected", status, code };
    }
    return { kind: "unknown", reason: "http-5xx" };
  };

  const noticeBase = (key: NoticeKey) => ({
    kind: key.kind,
    gen: key.gen,
    dest: "line-group",
  });

  return {
    listJobs: (q, timeoutMs) =>
      call(
        "GET",
        "status" in q
          ? `/api/jobs?status=${encodeURIComponent(q.status)}`
          : "/api/jobs?recentFailed=1",
        null,
        timeoutMs,
        parseJobList,
      ),

    claimDelivery: (no, timeoutMs) =>
      call(
        "POST",
        `/api/jobs/${no}/delivery/claim`,
        { via: "cloud" },
        timeoutMs,
        parseClaim,
      ),

    attemptDelivery: (no, claimId, timeoutMs) =>
      call(
        "POST",
        `/api/jobs/${no}/delivery/attempt`,
        null, // 本文なし。予約の番号はヘッダで渡す（URL・クエリに書かない）
        timeoutMs,
        (b) =>
          isObj(b) &&
          b.no === no &&
          b.attempted === true &&
          isIsoLike(b.leaseUntil)
            ? { attempted: true as const, leaseUntil: b.leaseUntil }
            : null,
        { "x-delivery-claim": claimId },
      ),

    reportDeliveryMessage: (no, body, timeoutMs) =>
      call(
        "POST",
        `/api/jobs/${no}/delivery/message`,
        "kind" in body
          ? {
              dest: "line-group",
              groupId: body.groupId,
              messageId: body.messageId,
              kind: "reject",
              choiceGen: body.choiceGen,
            }
          : {
              dest: "line-group",
              groupId: body.groupId,
              artifactSha256: body.artifactSha256,
              messageId: body.messageId,
            },
        timeoutMs,
        (b) =>
          isObj(b) && b.recorded === true ? { recorded: true as const } : null,
      ),

    reportDeliveryResult: (no, body, timeoutMs) => {
      let payload: Record<string, unknown>;
      if ("legacy" in body)
        payload = { claimId: body.claimId, outcome: "not_sent" };
      else if (body.outcome === "delivered")
        payload = { claimId: body.claimId, outcome: "delivered", via: "cloud" };
      else
        payload = {
          claimId: body.claimId,
          outcome: body.outcome,
          via: "cloud",
          reason: body.reason,
        };
      return call(
        "POST",
        `/api/jobs/${no}/delivery/result`,
        payload,
        timeoutMs,
        (b) =>
          isObj(b) && typeof b.status === "string"
            ? { status: b.status }
            : null,
      );
    },

    noticeSeed: (timeoutMs) =>
      call("POST", "/api/jobs/notice/seed", { version: 1 }, timeoutMs, (b) =>
        isObj(b) && typeof b.seeded === "boolean" && b.version === 1
          ? { seeded: b.seeded }
          : null,
      ),

    noticeClaim: (no, key, groupId, timeoutMs) =>
      call<NoticeClaimed>(
        "POST",
        `/api/jobs/${no}/notice/claim`,
        { ...noticeBase(key), groupId, by: "cloud" },
        timeoutMs,
        (b) => {
          if (!isObj(b)) return null;
          if (b.claimed === true) {
            return typeof b.claimId === "string" && UUID_RE.test(b.claimId)
              ? { claimed: true, claimId: b.claimId }
              : null;
          }
          return b.claimed === false ? { claimed: false } : null;
        },
      ),

    noticeAttempt: (no, key, claimId, timeoutMs) =>
      call(
        "POST",
        `/api/jobs/${no}/notice/attempt`,
        { ...noticeBase(key), claimId },
        timeoutMs,
        (b) =>
          isObj(b) && b.state === "attempting"
            ? { state: "attempting" as const }
            : null,
      ),

    noticeResult: (no, key, claimId, state, timeoutMs) =>
      call(
        "POST",
        `/api/jobs/${no}/notice/result`,
        { ...noticeBase(key), claimId, state },
        timeoutMs,
        (b) =>
          isObj(b) && typeof b.state === "string" ? { state: b.state } : null,
      ),
  };
}
