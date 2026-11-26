/** 段2d：portal の準備の口（group-satei-prep-portal.ts。fetch は偽物） */
import assert from "node:assert/strict";
import { sateiPrepDecide, sateiPrepIntake, sateiPrepNotices, type SateiPrepIntakeReq } from "../src/lib/group-satei-prep-portal";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

function fake(status: number, body: unknown, calls: Array<{ url: string; init: RequestInit }>): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { status, ok: status < 300, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}
const opts = (status: number, body: unknown, calls: Array<{ url: string; init: RequestInit }>) => ({ fetchImpl: fake(status, body, calls), baseUrl: "https://p.example.test", token: "k", timeoutMs: 1000 });
const REQ: SateiPrepIntakeReq = {
  tid: "0123456789abcdef", no: 7, dealId: "a".repeat(32), folderId: "folder_ABC-123", kind: "マンション", place: "大阪市北区天満2丁目3-4",
  building: "パークハウス天満", facts: { builtYm: "2005-03", exclusiveArea: 65.3, landArea: null, buildingArea: null }, requestedBy: "U" + "b".repeat(32),
};

(async () => {
  await t("受付：POST /api/jobs/satei/prep に約束の欄だけ。201 は ok", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const r = await sateiPrepIntake({ ...REQ, extra: "x" } as SateiPrepIntakeReq, opts(201, { created: true, prep: { tid: REQ.tid, status: "受付" } }, calls));
    assert.equal(calls[0].url, "https://p.example.test/api/jobs/satei/prep");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), REQ);
    assert.equal((calls[0].init.headers as Record<string, string>)["x-job-token"], "k");
    assert.deepEqual(r, { kind: "ok", value: { created: true, status: "受付" } });
  });
  await t("受付：503 PREP_DISABLED・INTAKE_STOPPED は rejected（code つき）。ほかの 503 は unknown", async () => {
    assert.deepEqual(await sateiPrepIntake(REQ, opts(503, { code: "PREP_DISABLED" }, [])), { kind: "rejected", status: 503, code: "PREP_DISABLED" });
    assert.deepEqual(await sateiPrepIntake(REQ, opts(503, { code: "INTAKE_STOPPED" }, [])), { kind: "rejected", status: 503, code: "INTAKE_STOPPED" });
    assert.deepEqual(await sateiPrepIntake(REQ, opts(503, {}, [])), { kind: "unknown", reason: "http-503" });
  });
  await t("一覧：GET。形の違う行は捨てる", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const good = { tid: REQ.tid, no: 7, status: "相談中", lines: ["a"], areaDone: true, failReason: "" };
    const r = await sateiPrepNotices(opts(200, { preps: [good, { tid: "x" }, { ...good, status: "受付" }] }, calls));
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].url, "https://p.example.test/api/jobs/satei/prep/notices");
    assert.deepEqual(r, { kind: "ok", value: [good] });
  });
  await t("決定：tid の口へ。409 は rejected", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const r = await sateiPrepDecide(REQ.tid, { decision: "manual", rev: 1 }, opts(409, { code: "PREP_CLOSED" }, calls));
    assert.equal(calls[0].url, `https://p.example.test/api/jobs/satei/prep/${REQ.tid}/decide`);
    assert.deepEqual(r, { kind: "rejected", status: 409, code: "PREP_CLOSED" });
  });
  console.log(`${n} passed`);
})();
