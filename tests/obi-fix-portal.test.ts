/**
 * 「番号で直す」の portal の呼び出し（POST /api/jobs/fix/resolve・POST /api/jobs/{no}/fix）と
 * 結果の分け方（約束 2026-10-11-obi-fix-contract.md）。portal は偽物。
 */
import { postFix, postFixResolve, type FixRequest } from "../src/lib/obi/portal";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

const G = "C" + "a".repeat(32);
const SHA = "1".repeat(64);
let seenUrl = "";
let seenHeaders = new Headers();
let seenBody: Record<string, unknown> = {};
let seenMethod = "";
const fakeFetch = (respond: () => Promise<Response>): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenMethod = init?.method ?? "";
    seenHeaders = new Headers(init?.headers);
    seenBody = JSON.parse(String(init?.body));
    return respond();
  }) as typeof fetch;
const json = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const opts = (respond: () => Promise<Response>) => ({
  fetchImpl: fakeFetch(respond),
  baseUrl: "https://portal.example.test",
  token: "tok",
  timeoutMs: 6_000,
});
const keys = () => Object.keys(seenBody).sort().join();

const RESOLVED = {
  no: 12, artifactSha256: SHA, current: true, pageCount: 5,
  fixable: "ok", closable: "ok", fixState: "", fixRound: 0,
};
const FIX_REQ: FixRequest = { messageId: "600000000000000200", groupId: G, code: 2, page: 3, turn: "", expectSha256: SHA };
const FIXED = { no: 12, fixId: 7, created: true, result: "queued", code: 2, page: 3, turn: "", round: 1, reason: "" };
async function main() {
  // ── resolve ──
  {
    let r = await postFixResolve({ groupId: G, quotedMessageId: "600000000000000150" }, opts(json(200, RESOLVED)));
    ok("resolve：200 は引けた", r.kind === "accepted" && r.resolved.no === 12 && r.resolved.artifactSha256 === SHA && r.resolved.current && r.resolved.pageCount === 5 && r.resolved.fixable === "ok" && r.resolved.closable === "ok", JSON.stringify(r));
    ok("resolve：宛先・POST・鍵・JSON", seenUrl === "https://portal.example.test/api/jobs/fix/resolve" && seenMethod === "POST" && seenHeaders.get("x-job-token") === "tok" && (seenHeaders.get("content-type") ?? "").includes("application/json"));
    ok("resolve（引用）：送る項目は groupId・quotedMessageId・source だけ", keys() === "groupId,quotedMessageId,source" && seenBody.source === "line-group" && seenBody.groupId === G && seenBody.quotedMessageId === "600000000000000150", JSON.stringify(seenBody));

    r = await postFixResolve({ groupId: G, no: 12 }, opts(json(200, { ...RESOLVED, current: false, fixable: "not-ready", closable: "closed", pageCount: 0 })));
    ok("resolve（番号）：送る項目は groupId・no・source だけ", keys() === "groupId,no,source" && seenBody.no === 12, JSON.stringify(seenBody));
    ok("resolve：見込みの2つ・current・pageCount をそのまま返す", r.kind === "accepted" && !r.resolved.current && r.resolved.fixable === "not-ready" && r.resolved.closable === "closed" && r.resolved.pageCount === 0);

    // 知らせの種類 kind・待っている返事の種類 phase（約束の P1・P4）。無い portal は ""・"fix" とみなす
    ok("resolve：kind・phase が無ければ \"\"・\"fix\"", r.kind === "accepted" && r.resolved.kind === "" && r.resolved.phase === "fix", JSON.stringify(r));
    r = await postFixResolve({ groupId: G, quotedMessageId: "600000000000000150" }, opts(json(200, { ...RESOLVED, kind: "completion", phase: "fix" })));
    ok("resolve：kind・phase をそのまま返す（completion・fix）", r.kind === "accepted" && r.resolved.kind === "completion" && r.resolved.phase === "fix", JSON.stringify(r));
    r = await postFixResolve({ groupId: G, quotedMessageId: "600000000000000150" }, opts(json(200, { ...RESOLVED, kind: "review", phase: "review", choiceGen: 3, choices: [1, 3, 4] })));
    ok("resolve：知らない種類・知らない項目が付いていても、読める（決めるのは呼ぶ側）", r.kind === "accepted" && r.resolved.kind === "review" && r.resolved.phase === "review", JSON.stringify(r));
    r = await postFixResolve({ groupId: G, no: 12 }, opts(json(200, { ...RESOLVED, kind: 1 })));
    ok("resolve：kind が文字列でなければ不明（形の違う応答）", r.kind === "unknown");
    r = await postFixResolve({ groupId: G, no: 12 }, opts(json(200, { ...RESOLVED, phase: null })));
    ok("resolve：phase が文字列でなければ不明（形の違う応答）", r.kind === "unknown");

    for (const [name, body] of [
      ["no が数でない", { ...RESOLVED, no: "12" }],
      ["sha256 の形が違う", { ...RESOLVED, artifactSha256: "abc" }],
      ["current が真偽でない", { ...RESOLVED, current: "true" }],
      ["pageCount が負", { ...RESOLVED, pageCount: -1 }],
      ["fixable が知らない値", { ...RESOLVED, fixable: "maybe" }],
      ["closable が無い（古い portal）", { ...RESOLVED, closable: undefined }],
    ] as Array<[string, unknown]>) {
      r = await postFixResolve({ groupId: G, no: 12 }, opts(json(200, body)));
      ok(`resolve：200 でも中身が読めなければ不明（${name}）`, r.kind === "unknown", JSON.stringify(r));
    }
    r = await postFixResolve({ groupId: G, no: 12 }, opts(async () => new Response("<html>", { status: 200 })));
    ok("resolve：200 で JSON でなければ不明", r.kind === "unknown");

    r = await postFixResolve({ groupId: G, no: 12 }, opts(json(404, { code: "NOT_FOUND", message: "x" })));
    ok("resolve：NOT_FOUND は断り", r.kind === "rejected" && r.code === "NOT_FOUND" && r.httpStatus === 404, JSON.stringify(r));
    r = await postFixResolve({ groupId: G, no: 12 }, opts(json(503, { code: "FIX_DISABLED", message: "x" })));
    ok("resolve：503 FIX_DISABLED は断り（不明にしない）", r.kind === "rejected" && r.code === "FIX_DISABLED");
    r = await postFixResolve({ groupId: G, no: 12 }, opts(json(503, { code: "OTHER" })));
    ok("resolve：それ以外の 503 は不明", r.kind === "unknown");
    r = await postFixResolve({ groupId: G, no: 12 }, opts(json(500, { code: "INTERNAL" })));
    ok("resolve：500 は不明", r.kind === "unknown");
    r = await postFixResolve({ groupId: G, no: 12 }, opts(async () => new Response("bad", { status: 400 })));
    ok("resolve：JSON でない 400 は HTTP_400 で断り", r.kind === "rejected" && r.code === "HTTP_400");
    r = await postFixResolve({ groupId: G, no: 12 }, opts(async () => { throw new DOMException("timed out", "TimeoutError"); }));
    ok("resolve：時間切れは不明", r.kind === "unknown");
    r = await postFixResolve({ groupId: G, no: 12 }, opts(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }));
    ok("resolve：接続を拒まれたら unreachable", r.kind === "unreachable");
  }

  // ── fix ──
  {
    let r = await postFix(12, FIX_REQ, opts(json(201, FIXED)));
    ok("fix：201 は新しく受けた", r.kind === "accepted" && r.no === 12 && r.created && r.result === "queued" && r.reason === "", JSON.stringify(r));
    ok("fix：宛先（受付番号つき）・POST・鍵", seenUrl === "https://portal.example.test/api/jobs/12/fix" && seenMethod === "POST" && seenHeaders.get("x-job-token") === "tok");
    ok("fix：送る項目は約束の7つだけ（発言者の項目は無い）", keys() === "code,expectSha256,groupId,messageId,page,source,turn", keys());
    ok("fix：値", seenBody.messageId === FIX_REQ.messageId && seenBody.source === "line-group" && seenBody.groupId === G && seenBody.code === 2 && seenBody.page === 3 && seenBody.turn === "" && seenBody.expectSha256 === SHA);

    r = await postFix(12, { ...FIX_REQ, code: 0, page: null }, opts(json(201, { ...FIXED, result: "closed", code: 0, page: null, round: 0 })));
    ok("fix：ページが無ければ項目ごと省く", keys() === "code,expectSha256,groupId,messageId,source,turn" && r.kind === "accepted" && r.result === "closed", keys());
    r = await postFix(12, { ...FIX_REQ, code: 3, turn: "right" }, opts(json(201, { ...FIXED, code: 3, turn: "right" })));
    ok("fix：向きを送る", seenBody.turn === "right" && seenBody.code === 3);

    r = await postFix(12, FIX_REQ, opts(json(200, { ...FIXED, created: false, result: "human", reason: "repeat" })));
    ok("fix：200 は同じ発言の2回目（最初の結果）", r.kind === "accepted" && !r.created && r.result === "human" && r.reason === "repeat", JSON.stringify(r));
    r = await postFix(12, FIX_REQ, opts(json(201, { ...FIXED, result: "done" })));
    ok("fix：成功の番号でも result が知らない値なら不明", r.kind === "unknown");
    r = await postFix(12, FIX_REQ, opts(async () => new Response("<html>", { status: 201 })));
    ok("fix：成功の番号で JSON でなければ不明", r.kind === "unknown");

    r = await postFix(12, FIX_REQ, opts(json(400, { code: "FIX_BAD_PAGE", message: "x", pageCount: 5 })));
    ok("fix：FIX_BAD_PAGE は断り（全部のページ数つき）", r.kind === "rejected" && r.code === "FIX_BAD_PAGE" && r.pageCount === 5 && r.busyJobNo === undefined, JSON.stringify(r));
    r = await postFix(12, FIX_REQ, opts(json(409, { code: "OBI_BUSY", message: "x", busyJobNo: 11 })));
    ok("fix：OBI_BUSY は断り（処理中の番号つき）", r.kind === "rejected" && r.code === "OBI_BUSY" && r.busyJobNo === 11);
    for (const [status, code] of [[409, "FIX_STALE"], [409, "FIX_NOT_READY"], [409, "FIX_CLOSED"], [410, "FIX_EXPIRED"], [409, "FIX_UNAVAILABLE"], [409, "FIX_MISMATCH"], [404, "NOT_FOUND"], [400, "INVALID_REQUEST"], [401, "UNAUTHORIZED"]] as Array<[number, string]>) {
      r = await postFix(12, FIX_REQ, opts(json(status, { code, message: "x" })));
      ok(`fix：${code}（${status}）は断り`, r.kind === "rejected" && r.code === code && r.httpStatus === status, JSON.stringify(r));
    }
    r = await postFix(12, FIX_REQ, opts(json(503, { code: "FIX_DISABLED", message: "x" })));
    ok("fix：503 FIX_DISABLED は断り", r.kind === "rejected" && r.code === "FIX_DISABLED");
    r = await postFix(12, FIX_REQ, opts(json(503, { code: "INTAKE_STOPPED", message: "x" })));
    ok("fix：503 INTAKE_STOPPED は断り", r.kind === "rejected" && r.code === "INTAKE_STOPPED");
    r = await postFix(12, FIX_REQ, opts(json(503, { code: "OTHER" })));
    ok("fix：それ以外の 503 は不明", r.kind === "unknown");
    r = await postFix(12, FIX_REQ, opts(json(500, { code: "INTERNAL" })));
    ok("fix：500 は不明", r.kind === "unknown");
    r = await postFix(12, FIX_REQ, opts(async () => { throw new DOMException("timed out", "TimeoutError"); }));
    ok("fix：時間切れは不明", r.kind === "unknown");
    // 送る前の失敗が確かな3つ（UNREACHABLE_CODES）だけが unreachable。runObiFix は、これを結果不明にしない（AB1）
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
      r = await postFix(12, FIX_REQ, opts(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code } }); }));
      ok(`fix：${code}（送る前の失敗が確か）は unreachable`, r.kind === "unreachable");
    }
    r = await postFix(12, FIX_REQ, opts(async () => { throw new TypeError("fetch failed"); }));
    ok("fix：理由の分からない通信の失敗は不明（unreachable にしない）", r.kind === "unknown");
    r = await postFix(12, FIX_REQ, opts(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); }));
    ok("fix：途中で切れたのは不明", r.kind === "unknown");
  }
  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
