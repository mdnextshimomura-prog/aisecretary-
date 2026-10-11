/**
 * 差し戻しの対応の選択の portal の呼び出し（POST /api/jobs/{no}/reject）と結果の分け方
 * （約束 2026-10-11-obi-reject-contract.md）。portal は偽物。
 */
import { postReject, type RejectRequest } from "../src/lib/obi/portal";

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
  timeoutMs: 8_000,
});
const keys = () => Object.keys(seenBody).sort().join();

const CHOOSE: RejectRequest = { messageId: "600000000000000200", groupId: G, action: "choose", choice: 1, expectGen: 40, expectSha256: "" };
const APPROVE: RejectRequest = { messageId: "600000000000000201", groupId: G, action: "approve", choice: 0, expectGen: 41, expectSha256: SHA };
const RECHOOSE: RejectRequest = { ...APPROVE, messageId: "600000000000000202", action: "rechoose" };
const QUEUED = { no: 4, created: true, result: "queued", choice: 1, round: 1, choiceGen: 41 };

async function main() {
  let r = await postReject(4, CHOOSE, opts(json(201, QUEUED)));
  ok("reject：201 は新しく受けた", r.kind === "accepted" && r.no === 4 && r.created && r.result === "queued" && r.choice === 1, JSON.stringify(r));
  ok("reject：宛先（受付番号つき）・POST・鍵・JSON", seenUrl === "https://portal.example.test/api/jobs/4/reject" && seenMethod === "POST" && seenHeaders.get("x-job-token") === "tok" && (seenHeaders.get("content-type") ?? "").includes("application/json"));
  ok("reject（choose）：送る項目は約束の6つだけ（expectSha256・発言者の項目は無い）", keys() === "action,choice,expectGen,groupId,messageId,source", keys());
  ok("reject（choose）：値", seenBody.messageId === CHOOSE.messageId && seenBody.source === "line-group" && seenBody.groupId === G && seenBody.action === "choose" && seenBody.choice === 1 && seenBody.expectGen === 40);

  r = await postReject(4, { ...CHOOSE, expectGen: 0 }, opts(json(201, QUEUED)));
  ok("reject：世代 0 も項目ごと送る（省かない）", seenBody.expectGen === 0 && keys() === "action,choice,expectGen,groupId,messageId,source");

  r = await postReject(4, APPROVE, opts(json(201, { no: 4, created: true, result: "approved", choice: 0, round: 1, choiceGen: 41 })));
  ok("reject（approve）：送る項目は約束の6つだけ（choice は無い）", keys() === "action,expectGen,expectSha256,groupId,messageId,source" && seenBody.action === "approve" && seenBody.expectGen === 41 && seenBody.expectSha256 === SHA, keys());
  ok("reject（approve）：approved", r.kind === "accepted" && r.result === "approved" && r.choice === 0, JSON.stringify(r));
  r = await postReject(4, RECHOOSE, opts(json(201, { no: 4, created: true, result: "reopened", choice: 0, round: 1, choiceGen: 42 })));
  ok("reject（rechoose）：choice は無く、expectSha256 を送る", keys() === "action,expectGen,expectSha256,groupId,messageId,source" && seenBody.action === "rechoose" && r.kind === "accepted" && r.result === "reopened", keys());

  for (const [result, choice] of [["human", 3], ["canceled", 4]] as Array<[string, number]>) {
    r = await postReject(4, { ...CHOOSE, choice }, opts(json(201, { ...QUEUED, result, choice, round: 0, choiceGen: 40 })));
    ok(`reject：result ${result}（choice ${choice}）`, r.kind === "accepted" && r.result === result && r.choice === choice, JSON.stringify(r));
  }
  r = await postReject(4, CHOOSE, opts(json(200, { ...QUEUED, created: false })));
  ok("reject：200 は同じ発言の2回目（最初の結果）", r.kind === "accepted" && !r.created && r.result === "queued", JSON.stringify(r));

  for (const [name, body] of [
    ["result が知らない値", { ...QUEUED, result: "done" }],
    ["no が数でない", { ...QUEUED, no: "4" }],
    ["choice が無い", { ...QUEUED, choice: undefined }],
    ["choice が 5", { ...QUEUED, choice: 5 }],
  ] as Array<[string, unknown]>) {
    r = await postReject(4, CHOOSE, opts(json(201, body)));
    ok(`reject：成功の番号でも中身が読めなければ不明（${name}）`, r.kind === "unknown", JSON.stringify(r));
  }
  r = await postReject(4, CHOOSE, opts(async () => new Response("<html>", { status: 201 })));
  ok("reject：成功の番号で JSON でなければ不明", r.kind === "unknown");

  r = await postReject(4, { ...CHOOSE, choice: 2 }, opts(json(409, { code: "CHOICE_NOT_OFFERED", message: "x", choices: [1, 3, 4] })));
  ok("reject：CHOICE_NOT_OFFERED は断り（今出している番号つき）", r.kind === "rejected" && r.code === "CHOICE_NOT_OFFERED" && r.choices?.join() === "1,3,4", JSON.stringify(r));
  r = await postReject(4, { ...CHOOSE, choice: 2 }, opts(json(409, { code: "CHOICE_NOT_OFFERED", message: "x", choices: [1, 9] })));
  ok("reject：choices の形が違えば、番号は付けない（断りのまま）", r.kind === "rejected" && r.code === "CHOICE_NOT_OFFERED" && r.choices === undefined, JSON.stringify(r));
  r = await postReject(4, APPROVE, opts(json(409, { code: "GATE_FAILED", message: "x", reason: "residue" })));
  ok("reject：GATE_FAILED は断り（理由の符号つき）", r.kind === "rejected" && r.code === "GATE_FAILED" && r.reason === "residue", JSON.stringify(r));
  r = await postReject(4, CHOOSE, opts(json(409, { code: "OBI_BUSY", message: "x", busyJobNo: 11 })));
  ok("reject：OBI_BUSY は断り（処理中の番号つき）", r.kind === "rejected" && r.code === "OBI_BUSY" && r.busyJobNo === 11);
  for (const [status, code] of [[409, "CHOICE_STALE"], [409, "CHOICE_UNAVAILABLE"], [409, "CHOICE_MISMATCH"], [404, "NOT_FOUND"], [400, "INVALID_REQUEST"], [401, "UNAUTHORIZED"]] as Array<[number, string]>) {
    r = await postReject(4, CHOOSE, opts(json(status, { code, message: "x" })));
    ok(`reject：${code}（${status}）は断り`, r.kind === "rejected" && r.code === code && r.httpStatus === status, JSON.stringify(r));
  }
  r = await postReject(4, CHOOSE, opts(json(503, { code: "CHOICE_DISABLED", message: "x" })));
  ok("reject：503 CHOICE_DISABLED は断り（結果不明にしない。T3・U2）", r.kind === "rejected" && r.code === "CHOICE_DISABLED" && r.httpStatus === 503, JSON.stringify(r));
  r = await postReject(4, CHOOSE, opts(json(503, { code: "INTAKE_STOPPED", message: "x" })));
  ok("reject：503 INTAKE_STOPPED は断り", r.kind === "rejected" && r.code === "INTAKE_STOPPED");
  r = await postReject(4, CHOOSE, opts(json(503, { code: "FIX_DISABLED" })));
  ok("reject：それ以外の 503 は不明", r.kind === "unknown");
  r = await postReject(4, CHOOSE, opts(json(500, { code: "INTERNAL" })));
  ok("reject：500 は不明", r.kind === "unknown");
  r = await postReject(4, CHOOSE, opts(async () => { throw new DOMException("timed out", "TimeoutError"); }));
  ok("reject：時間切れは不明", r.kind === "unknown");
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
    r = await postReject(4, CHOOSE, opts(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code } }); }));
    ok(`reject：${code}（送る前の失敗が確か）は unreachable`, r.kind === "unreachable");
  }
  r = await postReject(4, CHOOSE, opts(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); }));
  ok("reject：途中で切れたのは不明（unreachable にしない）", r.kind === "unknown");

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
