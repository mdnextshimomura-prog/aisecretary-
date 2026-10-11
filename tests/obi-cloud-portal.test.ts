/**
 * クラウド配達が使う portal の呼び出し（約束 2026-10-11-obi-cloud-contract.md の入口 1・1b・2・4・7）。
 * portal は偽物（約束の応答の形どおり）。
 */
import {
  createCloudPortal,
  type PortalCall,
} from "../src/lib/obi/cloud-portal";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name}`);
};

const BASE = "https://portal.example.test";
const TOKEN = "tok-portal-secret-value";
const G = "C" + "a".repeat(32);
const SHA = "1".repeat(64);
const CLAIM = "11111111-2222-4333-8444-555555555555";
const ISO = "2026-10-11T03:45:00.000Z";

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | null;
  hasBody: boolean;
  signal: boolean;
  cache: string;
}
let seen: Seen = {
  url: "",
  method: "",
  headers: new Headers(),
  body: null,
  hasBody: false,
  signal: false,
  cache: "",
};
let calls = 0;
const all: unknown[] = [];
const fakeFetch = (respond: () => Promise<Response>): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    seen = {
      url: String(url),
      method: init?.method ?? "",
      headers: new Headers(init?.headers),
      hasBody: init?.body != null,
      body: init?.body != null ? JSON.parse(String(init.body)) : null,
      signal: init?.signal instanceof AbortSignal,
      cache: String(init?.cache ?? ""),
    };
    return respond();
  }) as typeof fetch;
const json = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const portal = (respond: () => Promise<Response>) =>
  createCloudPortal({
    fetchImpl: fakeFetch(respond),
    baseUrl: BASE,
    token: TOKEN,
  });
const keys = () =>
  Object.keys(seen.body ?? {})
    .sort()
    .join();
const common = (method: string, path: string) =>
  seen.url === BASE + path &&
  seen.method === method &&
  seen.headers.get("x-job-token") === TOKEN &&
  seen.headers.get("x-job-client") === "aisecretary" &&
  seen.signal &&
  seen.cache === "no-store";
const jsonPost = () =>
  (seen.headers.get("content-type") ?? "") === "application/json" &&
  seen.hasBody;
const keep = <T>(r: PortalCall<T>): PortalCall<T> => {
  all.push(r);
  return r;
};
const T = 10_000;

async function main() {
  // ---- 一覧
  let l = keep(
    await portal(
      json(200, {
        jobs: [{ no: 3, status: "完成" }],
        peers: { mac: { noticeClaim: true, seenAt: ISO } },
      }),
    ).listJobs({ status: "完成" }, T),
  );
  ok(
    "一覧（完成）：URL・GET・鍵・名乗り・時間の上限",
    common("GET", "/api/jobs?status=%E5%AE%8C%E6%88%90"),
    seen.url,
  );
  ok(
    "一覧：GET に本文・content-type が無い",
    !seen.hasBody && seen.headers.get("content-type") === null,
  );
  ok(
    "一覧：行と peers",
    l.kind === "ok" &&
      l.value.jobs.length === 1 &&
      l.value.jobs[0].no === 3 &&
      l.value.macNoticeClaim === true,
  );
  await portal(json(200, { jobs: [] })).listJobs({ status: "差し戻し" }, T);
  ok(
    "一覧（差し戻し）：正しく符号化",
    common("GET", `/api/jobs?status=${encodeURIComponent("差し戻し")}`) &&
      !seen.url.includes("差"),
  );
  await portal(json(200, { jobs: [] })).listJobs({ recentFailed: true }, T);
  ok("一覧（失敗）：recentFailed=1", common("GET", "/api/jobs?recentFailed=1"));
  const peersCases: Array<[string, unknown, boolean | null]> = [
    ["false", { mac: { noticeClaim: false } }, false],
    ["null", { mac: { noticeClaim: null, seenAt: null } }, null],
    ["peers なし", undefined, null],
    ["mac なし", {}, null],
    ["文字列の true", { mac: { noticeClaim: "true" } }, null],
    ["peers が配列", [], null],
  ];
  for (const [label, peers, want] of peersCases) {
    l = keep(
      await portal(
        json(200, peers === undefined ? { jobs: [] } : { jobs: [], peers }),
      ).listJobs({ status: "差し戻し" }, T),
    );
    ok(
      `一覧：peers ${label} → ${want}`,
      l.kind === "ok" && l.value.macNoticeClaim === want,
    );
  }
  l = keep(
    await portal(
      json(200, {
        jobs: [
          null,
          { no: 0 },
          { no: "3" },
          { no: 1.5 },
          "x",
          [1],
          { no: 7, a: 1 },
        ],
      }),
    ).listJobs({ status: "完成" }, T),
  );
  ok(
    "一覧：形の違う行は捨てて残りを返す",
    l.kind === "ok" &&
      l.value.jobs.length === 1 &&
      l.value.jobs[0].no === 7 &&
      l.value.jobs[0].a === 1,
  );
  l = keep(
    await portal(json(200, { jobs: {} })).listJobs({ status: "完成" }, T),
  );
  ok(
    "一覧：jobs が配列でなければ invalid-body",
    l.kind === "unknown" && l.reason === "invalid-body",
  );

  // ---- 予約
  const CLAIM_OK = {
    no: 12,
    status: "納品中",
    claimId: CLAIM,
    leaseUntil: ISO,
    artifactName: "x.pdf",
    artifactSha256: SHA,
    replyKind: "line-group",
    replyGroupId: G,
    reviewPages: 2,
    outsideErased: 0,
    outsidePages: [],
    fix: null,
    via: "cloud",
  };
  let c = keep(await portal(json(200, CLAIM_OK)).claimDelivery(12, T));
  ok(
    "予約：URL・POST・鍵・名乗り・JSON",
    common("POST", "/api/jobs/12/delivery/claim") && jsonPost(),
  );
  ok("予約：本文は via だけ", keys() === "via" && seen.body?.via === "cloud");
  ok(
    "予約：成功の形",
    c.kind === "ok" &&
      c.value.claimId === CLAIM &&
      c.value.artifactSha256 === SHA &&
      c.value.leaseUntil === ISO &&
      c.value.via === "cloud" &&
      c.value.replyKind === "line-group" &&
      c.value.replyGroupId === G &&
      c.value.raw.reviewPages === 2,
  );
  for (const [label, over] of [
    ["claimId が UUID でない", { claimId: "abc" }],
    ["sha256 が63桁", { artifactSha256: "1".repeat(63) }],
    ["leaseUntil が無い", { leaseUntil: undefined }],
    ["leaseUntil が読めない", { leaseUntil: "いつか" }],
  ] as const) {
    c = keep(
      await portal(json(200, { ...CLAIM_OK, ...over })).claimDelivery(12, T),
    );
    ok(
      `予約：${label} → invalid-body`,
      c.kind === "unknown" && c.reason === "invalid-body",
    );
  }
  const { via: _v, replyKind: _k, replyGroupId: _g, ...old } = CLAIM_OK;
  (void _v, _k, _g);
  c = keep(await portal(json(200, old)).claimDelivery(12, T));
  ok(
    "予約：via・返し先が無い（古い portal）でも ok（呼ぶ側が見る）",
    c.kind === "ok" &&
      c.value.via === "" &&
      c.value.replyKind === "" &&
      c.value.replyGroupId === null,
  );
  for (const code of ["DELIVERY_IN_PROGRESS", "CLOUD_NOT_ALLOWED"]) {
    c = keep(
      await portal(json(409, { code, message: "だめ" })).claimDelivery(12, T),
    );
    ok(
      `予約：409 ${code} → rejected`,
      c.kind === "rejected" && c.status === 409 && c.code === code,
    );
  }

  // ---- LINE を呼ぶ直前の印（1b）
  let a = keep(
    await portal(
      json(200, { no: 12, attempted: true, leaseUntil: ISO }),
    ).attemptDelivery(12, CLAIM, T),
  );
  ok(
    "印：POST・URL（クエリなし・予約の番号なし）・鍵・名乗り",
    common("POST", "/api/jobs/12/delivery/attempt") &&
      !seen.url.includes("?") &&
      !seen.url.includes(CLAIM),
  );
  ok(
    "印：x-delivery-claim で渡す",
    seen.headers.get("x-delivery-claim") === CLAIM,
  );
  ok(
    "印：本文・content-type が無い",
    !seen.hasBody && seen.headers.get("content-type") === null,
  );
  ok(
    "印：200 → ok",
    a.kind === "ok" && a.value.attempted === true && a.value.leaseUntil === ISO,
  );
  const badAttempt: Array<[string, unknown]> = [
    ["attempted が文字列", { no: 12, attempted: "true", leaseUntil: ISO }],
    ["attempted が false", { no: 12, attempted: false, leaseUntil: ISO }],
    ["no が別の番号", { no: 13, attempted: true, leaseUntil: ISO }],
    ["leaseUntil が null", { no: 12, attempted: true, leaseUntil: null }],
    ["leaseUntil が読めない", { no: 12, attempted: true, leaseUntil: "x" }],
  ];
  for (const [label, body] of badAttempt) {
    a = keep(await portal(json(200, body)).attemptDelivery(12, CLAIM, T));
    ok(
      `印：${label} → invalid-body`,
      a.kind === "unknown" && a.reason === "invalid-body",
    );
  }
  for (const [status, code] of [
    [409, "CLAIM_MISMATCH"],
    [409, "WRITE_CONFLICT"],
    [404, "NOT_FOUND"],
    [400, "INVALID_REQUEST"],
    [403, "FORBIDDEN"],
    [401, "UNAUTHORIZED"],
  ] as const) {
    a = keep(
      await portal(json(status, { code, message: "x" })).attemptDelivery(
        12,
        CLAIM,
        T,
      ),
    );
    ok(
      `印：${status} ${code} → rejected`,
      a.kind === "rejected" && a.status === status && a.code === code,
    );
  }
  a = keep(
    await portal(json(500, { code: "INTERNAL" })).attemptDelivery(12, CLAIM, T),
  );
  ok("印：500 → unknown", a.kind === "unknown" && a.reason === "http-5xx");
  a = keep(
    await portal(async () => {
      throw new DOMException("timed out", "TimeoutError");
    }).attemptDelivery(12, CLAIM, T),
  );
  ok("印：時間切れ → unknown", a.kind === "unknown" && a.reason === "timeout");

  // ---- 結果
  let r = keep(
    await portal(
      json(200, { no: 12, status: "納品済み" }),
    ).reportDeliveryResult(12, { claimId: CLAIM, outcome: "delivered" }, T),
  );
  ok(
    "結果：URL・POST・JSON",
    common("POST", "/api/jobs/12/delivery/result") && jsonPost(),
  );
  ok(
    "結果（delivered）：3項目だけ（driveFileId・reason が無い）",
    keys() === "claimId,outcome,via" &&
      seen.body?.via === "cloud" &&
      seen.body?.outcome === "delivered" &&
      seen.body?.claimId === CLAIM,
  );
  ok("結果：status を返す", r.kind === "ok" && r.value.status === "納品済み");
  await portal(json(200, { no: 12, status: "完成" })).reportDeliveryResult(
    12,
    { claimId: CLAIM, outcome: "not_sent", reason: "push-rejected" },
    T,
  );
  ok(
    "結果（not_sent）：4項目",
    keys() === "claimId,outcome,reason,via" &&
      seen.body?.reason === "push-rejected" &&
      seen.body?.outcome === "not_sent",
  );
  await portal(
    json(200, { no: 12, status: "納品要確認" }),
  ).reportDeliveryResult(
    12,
    { claimId: CLAIM, outcome: "unknown", reason: "interrupted" },
    T,
  );
  ok(
    "結果（unknown）：4項目",
    keys() === "claimId,outcome,reason,via" &&
      seen.body?.reason === "interrupted" &&
      seen.body?.outcome === "unknown",
  );
  await portal(json(200, { no: 12, status: "完成" })).reportDeliveryResult(
    12,
    { claimId: CLAIM, outcome: "not_sent", legacy: true },
    T,
  );
  ok(
    "結果（古い portal へ返す）：2項目だけ（via・reason・legacy が無い）",
    keys() === "claimId,outcome" && seen.body?.outcome === "not_sent",
  );
  r = keep(
    await portal(json(200, { no: 12 })).reportDeliveryResult(
      12,
      { claimId: CLAIM, outcome: "delivered" },
      T,
    ),
  );
  ok(
    "結果：status が無い → invalid-body",
    r.kind === "unknown" && r.reason === "invalid-body",
  );
  r = keep(
    await portal(json(409, { code: "CLAIM_MISMATCH" })).reportDeliveryResult(
      12,
      { claimId: CLAIM, outcome: "delivered" },
      T,
    ),
  );
  ok(
    "結果：409 → rejected",
    r.kind === "rejected" && r.code === "CLAIM_MISMATCH",
  );

  // ---- 知らせの id の報告
  let m = keep(
    await portal(json(200, { no: 12, recorded: true })).reportDeliveryMessage(
      12,
      { groupId: G, artifactSha256: SHA, messageId: "600000000000000001" },
      T,
    ),
  );
  ok(
    "id（完成）：URL・POST・JSON",
    common("POST", "/api/jobs/12/delivery/message") && jsonPost(),
  );
  ok(
    "id（完成）：4項目（kind・choiceGen が無い）",
    keys() === "artifactSha256,dest,groupId,messageId" &&
      seen.body?.dest === "line-group" &&
      seen.body?.groupId === G &&
      seen.body?.artifactSha256 === SHA,
  );
  ok("id：recorded", m.kind === "ok" && m.value.recorded === true);
  await portal(json(200, { no: 4, recorded: true })).reportDeliveryMessage(
    4,
    {
      groupId: G,
      messageId: "600000000000000002",
      kind: "reject",
      choiceGen: 41,
    },
    T,
  );
  ok(
    "id（差し戻し）：5項目（artifactSha256 が無い）",
    keys() === "choiceGen,dest,groupId,kind,messageId" &&
      seen.body?.kind === "reject" &&
      seen.body?.choiceGen === 41,
  );
  await portal(json(200, { no: 4, recorded: true })).reportDeliveryMessage(
    4,
    {
      groupId: G,
      messageId: "600000000000000002",
      kind: "reject",
      choiceGen: 0,
    },
    T,
  );
  ok(
    "id（差し戻し）：世代 0 も項目ごと送る",
    keys() === "choiceGen,dest,groupId,kind,messageId" &&
      seen.body?.choiceGen === 0,
  );
  m = keep(
    await portal(json(200, { no: 4, recorded: "true" })).reportDeliveryMessage(
      4,
      { groupId: G, artifactSha256: SHA, messageId: "1" },
      T,
    ),
  );
  ok(
    "id：recorded が true でない → invalid-body",
    m.kind === "unknown" && m.reason === "invalid-body",
  );
  m = keep(
    await portal(json(409, { code: "CHOICE_STALE" })).reportDeliveryMessage(
      4,
      { groupId: G, messageId: "1", kind: "reject", choiceGen: 41 },
      T,
    ),
  );
  ok(
    "id：409 CHOICE_STALE → rejected",
    m.kind === "rejected" && m.code === "CHOICE_STALE",
  );

  // ---- 種まき
  let s = keep(
    await portal(
      json(200, { seeded: true, version: 1, created: 3 }),
    ).noticeSeed(T),
  );
  ok(
    "種まき：URL・POST・JSON・本文は version だけ",
    common("POST", "/api/jobs/notice/seed") &&
      jsonPost() &&
      keys() === "version" &&
      seen.body?.version === 1,
  );
  ok("種まき：seeded true", s.kind === "ok" && s.value.seeded === true);
  s = keep(
    await portal(json(200, { seeded: false, version: 1, at: ISO })).noticeSeed(
      T,
    ),
  );
  ok("種まき：seeded false", s.kind === "ok" && s.value.seeded === false);
  s = keep(await portal(json(200, { seeded: true, version: 2 })).noticeSeed(T));
  ok(
    "種まき：version 2 → invalid-body",
    s.kind === "unknown" && s.reason === "invalid-body",
  );
  s = keep(
    await portal(json(200, { seeded: "true", version: 1 })).noticeSeed(T),
  );
  ok(
    "種まき：seeded が真偽でない → invalid-body",
    s.kind === "unknown" && s.reason === "invalid-body",
  );

  // ---- 知らせの予約
  let n = keep(
    await portal(
      json(201, { claimed: true, claimId: CLAIM, tries: 1 }),
    ).noticeClaim(4, { kind: "reject", gen: "g41" }, G, T),
  );
  ok(
    "知らせの予約：URL・POST・JSON",
    common("POST", "/api/jobs/4/notice/claim") && jsonPost(),
  );
  ok(
    "知らせの予約：本文は5項目",
    keys() === "by,dest,gen,groupId,kind" &&
      seen.body?.by === "cloud" &&
      seen.body?.dest === "line-group" &&
      seen.body?.groupId === G &&
      seen.body?.kind === "reject" &&
      seen.body?.gen === "g41",
  );
  ok(
    "知らせの予約：201 claimed",
    n.kind === "ok" &&
      n.status === 201 &&
      n.value.claimed === true &&
      n.value.claimId === CLAIM,
  );
  n = keep(
    await portal(
      json(200, { claimed: true, claimId: CLAIM, tries: 2 }),
    ).noticeClaim(4, { kind: "reject", gen: "g41" }, G, T),
  );
  ok(
    "知らせの予約：200 claimed（取り直し）",
    n.kind === "ok" && n.value.claimed === true,
  );
  n = keep(
    await portal(
      json(200, { claimed: false, by: "mac", state: "sent" }),
    ).noticeClaim(4, { kind: "reject", gen: "g41" }, G, T),
  );
  ok(
    "知らせの予約：claimed false",
    n.kind === "ok" &&
      n.value.claimed === false &&
      Object.keys(n.value).join() === "claimed",
  );
  n = keep(
    await portal(json(201, { claimed: true, claimId: "x" })).noticeClaim(
      4,
      { kind: "reject", gen: "g41" },
      G,
      T,
    ),
  );
  ok(
    "知らせの予約：claimId が UUID でない → invalid-body",
    n.kind === "unknown" && n.reason === "invalid-body",
  );
  n = keep(
    await portal(json(200, { claimed: "no" })).noticeClaim(
      4,
      { kind: "reject", gen: "g41" },
      G,
      T,
    ),
  );
  ok(
    "知らせの予約：claimed が真偽でない → invalid-body",
    n.kind === "unknown" && n.reason === "invalid-body",
  );
  await portal(
    json(201, { claimed: true, claimId: CLAIM, tries: 1 }),
  ).noticeClaim(7, { kind: "failure", gen: "" }, G, T);
  ok(
    "知らせの予約：失敗の gen は空でも項目ごと送る",
    keys() === "by,dest,gen,groupId,kind" &&
      seen.body?.gen === "" &&
      seen.body?.kind === "failure",
  );
  for (const code of ["NOTICE_NOT_SEEDED", "NOTICE_STALE", "WRITE_CONFLICT"]) {
    n = keep(
      await portal(json(409, { code })).noticeClaim(
        4,
        { kind: "reject", gen: "g41" },
        G,
        T,
      ),
    );
    ok(`知らせの予約：409 ${code}`, n.kind === "rejected" && n.code === code);
  }

  // ---- 送信中の印・結果
  let at = keep(
    await portal(json(200, { no: 4, state: "attempting" })).noticeAttempt(
      4,
      { kind: "reject", gen: "g41" },
      CLAIM,
      T,
    ),
  );
  ok(
    "知らせの印：URL・本文は4項目",
    common("POST", "/api/jobs/4/notice/attempt") &&
      jsonPost() &&
      keys() === "claimId,dest,gen,kind" &&
      seen.body?.claimId === CLAIM,
  );
  ok("知らせの印：200", at.kind === "ok" && at.value.state === "attempting");
  at = keep(
    await portal(json(200, { no: 4, state: "prepared" })).noticeAttempt(
      4,
      { kind: "reject", gen: "g41" },
      CLAIM,
      T,
    ),
  );
  ok(
    "知らせの印：state が attempting でない → invalid-body",
    at.kind === "unknown" && at.reason === "invalid-body",
  );
  for (const code of [
    "NOTICE_STALE",
    "NOTICE_CLAIM_STALE",
    "NOTICE_SETTLED",
    "WRITE_CONFLICT",
  ]) {
    at = keep(
      await portal(json(409, { code })).noticeAttempt(
        4,
        { kind: "reject", gen: "g41" },
        CLAIM,
        T,
      ),
    );
    ok(`知らせの印：409 ${code}`, at.kind === "rejected" && at.code === code);
  }
  let nr = keep(
    await portal(
      json(200, { no: 4, state: "sent", retryable: false }),
    ).noticeResult(4, { kind: "failure", gen: "" }, CLAIM, "sent", T),
  );
  ok(
    "知らせの結果：URL・本文は5項目",
    common("POST", "/api/jobs/4/notice/result") &&
      jsonPost() &&
      keys() === "claimId,dest,gen,kind,state" &&
      seen.body?.state === "sent" &&
      seen.body?.gen === "",
  );
  ok("知らせの結果：200", nr.kind === "ok" && nr.value.state === "sent");
  for (const code of [
    "STATE_CONFLICT",
    "WRITE_CONFLICT",
    "NOTICE_CLAIM_STALE",
    "NOTICE_SETTLED",
  ]) {
    nr = keep(
      await portal(json(409, { code })).noticeResult(
        4,
        { kind: "reject", gen: "g41" },
        CLAIM,
        "unknown",
        T,
      ),
    );
    ok(`知らせの結果：409 ${code}`, nr.kind === "rejected" && nr.code === code);
  }

  // ---- 分け方
  let x = keep(
    await portal(json(401, { code: "UNAUTHORIZED", message: "x" })).listJobs(
      { status: "完成" },
      T,
    ),
  );
  ok(
    "分け方：401 → rejected・UNAUTHORIZED",
    x.kind === "rejected" && x.status === 401 && x.code === "UNAUTHORIZED",
  );
  x = keep(await portal(json(404, {})).listJobs({ status: "完成" }, T));
  ok(
    "分け方：code の無い 404 → HTTP_404",
    x.kind === "rejected" && x.code === "HTTP_404",
  );
  for (const code of [G, "not_found", "A".repeat(41), "", 12, "A B"]) {
    x = keep(await portal(json(409, { code })).listJobs({ status: "完成" }, T));
    ok(
      `分け方：code ${JSON.stringify(code).slice(0, 12)} はそのまま出さない`,
      x.kind === "rejected" && x.code === "HTTP_409",
    );
  }
  x = keep(
    await portal(
      async () => new Response("<html>not found</html>", { status: 404 }),
    ).listJobs({ status: "完成" }, T),
  );
  ok(
    "分け方：JSON でない 404 → HTTP_404",
    x.kind === "rejected" && x.code === "HTTP_404",
  );
  for (const status of [500, 502, 503]) {
    x = keep(
      await portal(json(status, { code: "INTERNAL" })).listJobs(
        { status: "完成" },
        T,
      ),
    );
    ok(
      `分け方：${status} → http-5xx`,
      x.kind === "unknown" && x.reason === "http-5xx",
    );
  }
  x = keep(
    await portal(async () => {
      throw new DOMException("timed out", "TimeoutError");
    }).listJobs({ status: "完成" }, T),
  );
  ok(
    "分け方：TimeoutError → timeout",
    x.kind === "unknown" && x.reason === "timeout",
  );
  x = keep(
    await portal(async () => {
      throw new DOMException("aborted", "AbortError");
    }).listJobs({ status: "完成" }, T),
  );
  ok(
    "分け方：AbortError → timeout",
    x.kind === "unknown" && x.reason === "timeout",
  );
  x = keep(
    await portal(async () => {
      throw Object.assign(new TypeError(`fetch failed ${BASE} ${TOKEN}`), {
        cause: { code: "ECONNRESET" },
      });
    }).listJobs({ status: "完成" }, T),
  );
  ok(
    "分け方：ECONNRESET → network",
    x.kind === "unknown" && x.reason === "network",
  );
  x = keep(
    await portal(
      async () => new Response("<html>ok</html>", { status: 200 }),
    ).listJobs({ status: "完成" }, T),
  );
  ok(
    "分け方：200 だが JSON でない → invalid-body",
    x.kind === "unknown" && x.reason === "invalid-body",
  );

  // ---- 時間が無い
  calls = 0;
  x = keep(
    await portal(json(200, { jobs: [] })).listJobs({ status: "完成" }, 999),
  );
  ok(
    "時間：999ms → fetch を呼ばない・no-time",
    x.kind === "unknown" && x.reason === "no-time" && calls === 0,
  );
  x = keep(
    await portal(json(200, { jobs: [] })).listJobs({ status: "完成" }, 0),
  );
  const y = keep(
    await portal(json(200, { jobs: [] })).listJobs(
      { status: "完成" },
      Number.NaN,
    ),
  );
  ok(
    "時間：0・NaN → fetch を呼ばない",
    x.kind === "unknown" && y.kind === "unknown" && calls === 0,
  );
  x = keep(
    await portal(json(200, { jobs: [] })).listJobs({ status: "完成" }, 1000),
  );
  ok("時間：1,000ms は呼ぶ", x.kind === "ok" && calls === 1);

  ok(
    "どの結果にも鍵が入らない",
    !JSON.stringify(all).includes(TOKEN) && all.length > 60,
  );

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
