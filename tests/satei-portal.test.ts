/**
 * B2 査定書：reins-report の intake・decide・reason（契約 第2節）を呼ぶ部分。fetch は差し替え。
 */
import {
  sateiDecide,
  sateiIntake,
  sateiPortalConfig,
  sateiReason,
  SATEI_CODE_AWAITING_REASON,
  type SateiIntakeReq,
  type SateiPortalOpts,
} from "../src/lib/satei-portal";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};
globalThis.fetch = (async () => {
  throw new Error("このテストで本物の fetch を使ってはいけない");
}) as typeof fetch;

type Call = { url: string; init: RequestInit };
function fakeFetch(
  status: number,
  body: unknown,
  calls: Call[],
  err?: Error,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (err) throw err;
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      {
        status,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
}
const opts = (f: typeof fetch): SateiPortalOpts => ({
  fetchImpl: f,
  baseUrl: "https://portal.example.test",
  token: "tok",
  timeoutMs: 1000,
});
const SHIMO = "U" + "b".repeat(32);
const SHA = "c".repeat(64);
const REQ: SateiIntakeReq = {
  eventId: "01HEVENTID",
  dealId: "0123abcd0123456789ab0123456789ab",
  dealNo: 42,
  folderId: "1AbC_dEf-GhIjKlMnOp",
  dealName: "テスト",
  requestedBy: SHIMO,
};
const headerOf = (c: Call, k: string) =>
  (c.init.headers as Record<string, string>)[k];

(async () => {
  // ── intake ──
  let c: Call[] = [];
  const r1 = await sateiIntake(
    REQ,
    opts(fakeFetch(201, { created: true, job: { no: 5, status: "受付" } }, c)),
  );
  ok(
    "intake の口",
    c[0]?.url === "https://portal.example.test/api/jobs/satei/intake" &&
      c[0]?.init.method === "POST",
  );
  ok("鍵は x-job-token", headerOf(c[0], "x-job-token") === "tok");
  ok("本文は JSON", headerOf(c[0], "content-type") === "application/json");
  ok("本文は契約の6項目", c[0]?.init.body === JSON.stringify(REQ));
  ok(
    "201 created → 新規",
    r1.kind === "ok" &&
      r1.value.created === true &&
      r1.value.no === 5 &&
      r1.value.status === "受付",
  );
  c = [];
  const r2 = await sateiIntake(
    REQ,
    opts(
      fakeFetch(200, { created: false, job: { no: 4, status: "下準備中" } }, c),
    ),
  );
  ok(
    "created=false → 作っていない（既にある）",
    r2.kind === "ok" && r2.value.created === false && r2.value.no === 4,
  );
  const r3 = await sateiIntake(
    REQ,
    opts(fakeFetch(409, { code: SATEI_CODE_AWAITING_REASON }, [])),
  );
  ok(
    "差し戻しの理由待ち → 断り（code そのまま）",
    r3.kind === "rejected" &&
      r3.status === 409 &&
      r3.code === "SATEI_AWAITING_REASON",
  );
  const r4 = await sateiIntake(REQ, opts(fakeFetch(400, "not json", [])));
  ok(
    "4xx で中身が読めない → HTTP_400",
    r4.kind === "rejected" && r4.code === "HTTP_400",
  );
  const r5 = await sateiIntake(REQ, opts(fakeFetch(500, {}, [])));
  ok("5xx → 分からない", r5.kind === "unknown");
  const r6 = await sateiIntake(
    REQ,
    opts(fakeFetch(0, {}, [], new Error("boom"))),
  );
  ok("通信の例外 → 分からない", r6.kind === "unknown");
  const r7 = await sateiIntake(REQ, opts(fakeFetch(200, {}, [])));
  ok("成功なのに中身が読めない → 分からない", r7.kind === "unknown");
  const r8 = await sateiIntake(
    REQ,
    opts(fakeFetch(201, { created: true, job: { no: 0, status: "受付" } }, [])),
  );
  ok("番号が正の整数でない → 分からない", r8.kind === "unknown");

  // ── decide ──
  c = [];
  const d1 = await sateiDecide(
    12,
    { decision: "ok", by: SHIMO, artifactSha256: SHA, generation: 3 },
    opts(fakeFetch(200, { status: "完成" }, c)),
  );
  ok(
    "decide の口",
    c[0]?.url === "https://portal.example.test/api/jobs/12/satei/decide",
  );
  ok(
    "decide に sha・generation を渡す",
    c[0]?.init.body ===
      JSON.stringify({
        decision: "ok",
        by: SHIMO,
        artifactSha256: SHA,
        generation: 3,
      }),
  );
  ok("decide 200 → ok", d1.kind === "ok" && d1.value.status === "完成");
  const d2 = await sateiDecide(
    12,
    { decision: "reject", by: SHIMO, artifactSha256: SHA, generation: 3 },
    opts(fakeFetch(409, { code: "SATEI_MISMATCH" }, [])),
  );
  ok(
    "decide 409 → SATEI_MISMATCH の断り",
    d2.kind === "rejected" && d2.status === 409 && d2.code === "SATEI_MISMATCH",
  );

  // ── reason ──
  c = [];
  const s1 = await sateiReason(
    12,
    "事例が古い",
    opts(fakeFetch(200, { ok: true }, c)),
  );
  ok(
    "reason の口",
    c[0]?.url === "https://portal.example.test/api/jobs/12/satei/reason",
  );
  ok(
    "reason の本文",
    c[0]?.init.body === JSON.stringify({ text: "事例が古い" }),
  );
  ok("reason 200 → ok", s1.kind === "ok");
  const s2 = await sateiReason(
    12,
    "x",
    opts(fakeFetch(409, { code: "SATEI_STALE" }, [])),
  );
  ok("reason 409 → 断り", s2.kind === "rejected");

  // ── 設定 ──
  const cfg = sateiPortalConfig({
    PORTAL_BASE_URL: "https://p.example.test/",
    JOB_API_TOKEN: "t",
  });
  ok(
    "末尾の / を落とす",
    cfg?.baseUrl === "https://p.example.test" && cfg?.token === "t",
  );
  ok(
    "鍵が無い → null",
    sateiPortalConfig({ PORTAL_BASE_URL: "https://p.example.test" }) === null,
  );
  ok(
    "鍵に空白 → null",
    sateiPortalConfig({
      PORTAL_BASE_URL: "https://p.example.test",
      JOB_API_TOKEN: "t t",
    }) === null,
  );
  ok(
    "http（localhost 以外）→ null",
    sateiPortalConfig({
      PORTAL_BASE_URL: "http://p.example.test",
      JOB_API_TOKEN: "t",
    }) === null,
  );

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
