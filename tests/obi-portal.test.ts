/**
 * portal の受付（POST /api/jobs/intake）の呼び出しと結果の分け方（設計 12・13・14の2・15）。portal は偽物。
 */
import { postIntake, inputsMatch, type IntakeRequest } from "../src/lib/obi/portal";
import type { FetchedPdf } from "../src/lib/obi/fetch-pdfs";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

const G = "C" + "a".repeat(32);
const req: IntakeRequest = {
  lineMessageId: "600000000000000100",
  property: "架空邸",
  requestText: "帯替え 架空邸",
  requestedBy: "LINEグループ（営業部）",
  replyGroupId: G,
  files: [
    { fileName: "a.pdf", bytes: new TextEncoder().encode("%PDF-a") },
    { fileName: "b.pdf", bytes: new TextEncoder().encode("%PDF-b") },
  ],
};

let seenUrl = "";
let seenToken = "";
let seenForm: FormData | null = null;
const fakeFetch = (respond: () => Promise<Response>): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenToken = new Headers(init?.headers).get("x-job-token") ?? "";
    seenForm = init?.body as FormData;
    return respond();
  }) as typeof fetch;
const json = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const call = (respond: () => Promise<Response>) =>
  postIntake(req, { fetchImpl: fakeFetch(respond), baseUrl: "https://portal.example.test", token: "tok", timeoutMs: 20_000 });
const inputs = [
  { name: "a.pdf", sha256: "1".repeat(64), size: 6 },
  { name: "b.pdf", sha256: "2".repeat(64), size: 6 },
];

async function main() {
  let r = await call(json(201, { no: 12, status: "下準備中", created: true, inputs }));
  ok("201 は受付（新規）", r.kind === "accepted" && r.no === 12 && r.created && r.inputs.length === 2, JSON.stringify(r));
  ok("宛先と鍵", seenUrl === "https://portal.example.test/api/jobs/intake" && seenToken === "tok");
  const f = seenForm as unknown as FormData;
  ok("本文の項目（workflow・lineMessageId・property・replyKind・replyGroupId）",
    f.get("workflow") === "obi" && f.get("lineMessageId") === req.lineMessageId && f.get("property") === "架空邸" &&
    f.get("replyKind") === "line-group" && f.get("replyGroupId") === G && f.get("requestText") === "帯替え 架空邸");
  ok("assigneeName は送らない（約束：intake は受け付けない）", f.get("assigneeName") === null);
  const keys = Array.from(new Set(Array.from(f.keys()))).sort().join();
  ok("送る項目は約束の項目だけ", keys === "files,lineMessageId,property,replyGroupId,replyKind,requestText,requestedBy,workflow", keys);
  const files = f.getAll("files") as File[];
  ok("PDF を出た順に名前つきで送る", files.length === 2 && files[0].name === "a.pdf" && files[1].name === "b.pdf" && files[0].type === "application/pdf");

  r = await call(json(200, { no: 12, status: "下準備中", created: false, inputs }));
  ok("200 は同じ依頼の照合一致（受付済み）", r.kind === "accepted" && !r.created);

  r = await call(json(201, { no: "12", inputs }));
  ok("成功の番号なのに中身が読めなければ不明", r.kind === "unknown");
  r = await call(async () => new Response("<html>", { status: 200 }));
  ok("成功の番号で JSON でなければ不明", r.kind === "unknown");

  r = await call(json(409, { code: "OBI_BUSY", message: "busy", busyJobNo: 11 }));
  ok("OBI_BUSY は断り（処理中の番号つき）", r.kind === "rejected" && r.code === "OBI_BUSY" && r.busyJobNo === 11, JSON.stringify(r));
  r = await call(json(409, { code: "INTAKE_MISMATCH", message: "x" }));
  ok("INTAKE_MISMATCH は断り", r.kind === "rejected" && r.code === "INTAKE_MISMATCH" && r.busyJobNo === undefined);
  r = await call(json(503, { code: "INTAKE_STOPPED", message: "x" }));
  ok("503 INTAKE_STOPPED は断り（不明にしない）", r.kind === "rejected" && r.code === "INTAKE_STOPPED");
  r = await call(json(503, { code: "OTHER" }));
  ok("それ以外の 503 は不明", r.kind === "unknown");
  r = await call(json(500, { code: "INTERNAL" }));
  ok("500 は不明", r.kind === "unknown");
  r = await call(async () => new Response("bad", { status: 400 }));
  ok("JSON でない 400 は HTTP_400 で断り", r.kind === "rejected" && r.code === "HTTP_400");

  r = await call(async () => {
    throw new DOMException("timed out", "TimeoutError");
  });
  ok("時間切れは不明", r.kind === "unknown");
  r = await call(async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  });
  ok("接続を拒まれた（送る前の失敗が確か）は unreachable", r.kind === "unreachable");
  r = await call(async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  });
  ok("名前が引けないのも unreachable", r.kind === "unreachable");
  r = await call(async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  });
  ok("途中で切れたのは不明", r.kind === "unknown");

  const sent = [
    { sha256: "1".repeat(64), size: 6 },
    { sha256: "2".repeat(64), size: 6 },
  ] as FetchedPdf[];
  ok("一覧の一致：同じ順・同じ sha256・同じ大きさ", inputsMatch(sent, inputs));
  ok("一覧の一致：順番が違っても集合が同じなら一致（portal は初回の順で返す）", inputsMatch(sent, [inputs[1], inputs[0]]));
  ok("一覧の不一致：sha256 が違う", !inputsMatch(sent, [inputs[0], { ...inputs[1], sha256: "3".repeat(64) }]));
  ok("一覧の不一致：同じ sha256 が2つ", !inputsMatch(sent, [inputs[0], inputs[0]]));
  ok("一覧の不一致：大きさ違い", !inputsMatch(sent, [inputs[0], { ...inputs[1], size: 7 }]));
  ok("一覧の不一致：件数違い", !inputsMatch(sent, [inputs[0]]));

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
