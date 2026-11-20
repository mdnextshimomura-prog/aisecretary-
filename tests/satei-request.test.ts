/**
 * B2 査定書：機械から査定を頼む口（約束 agent-hub 2026-11-19-satei-request）。Notion・portal・LINE は差し替え。外部へ通信しない。
 */
import { handleSateiRequest, sateiRequestToken, type SateiRequestDeps } from "../src/lib/satei-request";
import { sateiNotifyToken, sateiRetryKey } from "../src/lib/satei-notify";
import { sateiMachineIntake, type SateiCall, type SateiIntakeOk, type SateiIntakeReq } from "../src/lib/satei-portal";
import type { SateiDeal } from "../src/lib/satei-deal";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};
globalThis.fetch = (async () => {
  throw new Error("このテストで外部へ通信してはいけない");
}) as typeof fetch;

const KEY = "k".repeat(40);
const TOKEN = sateiRequestToken(KEY);
const DB = "11112222333344445555666677778888";
const DEAL = "0123abcd0123456789ab0123456789ab";
const USER = "U" + "a".repeat(32);
const EV = "hub" + "0".repeat(40);
const GOOD: SateiDeal = {
  id: DEAL, name: "テスト案件", dealNo: 42, folderId: "1AbC_dEf-GhIjKlMnOp",
  propertyIds: ["p"], gone: false, parentDbId: DB,
};
const body = (o: Record<string, unknown> = {}) => JSON.stringify({ eventId: EV, dealId: DEAL, ...o });

function deps(over: Partial<SateiRequestDeps> = {}) {
  const logs: string[] = [];
  const intakes: SateiIntakeReq[] = [];
  const pushes: Array<{ to: string; messages: unknown[]; key: string }> = [];
  let t = 0;
  const d: SateiRequestDeps = {
    env: { JOB_API_TOKEN: KEY, TASK_SATEI: "1", TASK_SATEI_USER_IDS: USER },
    dealsDbId: DB,
    readDeal: async () => ({ deal: GOOD, kind: "マンション" }),
    intake: async (req): Promise<SateiCall<SateiIntakeOk>> => {
      intakes.push(req);
      return { kind: "ok", value: { created: true, no: 12, status: "受付" } };
    },
    push: async (to, messages, key) => {
      pushes.push({ to, messages, key });
      return 200;
    },
    now: () => (t += 100),
    log: (l) => logs.push(l),
    ...over,
  };
  return { d, logs, intakes, pushes };
}

async function main() {
  // 鍵
  {
    const { d } = deps();
    ok("鍵なしは 401", (await handleSateiRequest(null, body(), d)).status === 401);
    ok("知らせ用の鍵では通らない（401）", (await handleSateiRequest(sateiNotifyToken(KEY), body(), d)).status === 401);
    const short = deps({ env: { JOB_API_TOKEN: "short", TASK_SATEI: "1", TASK_SATEI_USER_IDS: USER } });
    ok("JOB_API_TOKEN が短ければ誰も通さない", (await handleSateiRequest(sateiRequestToken("short"), body(), short.d)).status === 401);
  }
  // 入力の形
  {
    const { d, intakes } = deps();
    for (const b of ["{", "[]", body({ requestedBy: USER }), body({ eventId: "x" }), body({ dealId: "0123abcd-0123-4567-89ab-0123456789ab" })]) {
      ok(`形が違えば 400：${b.slice(0, 30)}`, (await handleSateiRequest(TOKEN, b, d)).status === 400);
    }
    ok("形が違えば portal を呼ばない", intakes.length === 0);
  }
  // 通る
  {
    const { d, intakes, pushes, logs } = deps();
    const r = await handleSateiRequest(TOKEN, body(), d);
    ok("通れば ok・no・status・created", JSON.stringify(r.body) === JSON.stringify({ result: "ok", no: 12, status: "受付", created: true }));
    ok("portal へは Notion の値と TASK_SATEI_USER_IDS の先頭を渡す", intakes[0]?.requestedBy === USER && intakes[0]?.dealName === "テスト案件" && intakes[0]?.dealNo === 42 && intakes[0]?.eventId === EV);
    ok("LINE の1行を下村さんへ（retry key は no:auto-start:0）", pushes.length === 1 && pushes[0].to === USER && pushes[0].key === sateiRetryKey(12, "auto-start", 0)
      && JSON.stringify(pushes[0].messages) === JSON.stringify([{ type: "text", text: "自動で査定書の作成を始めました（#J12）" }]));
    ok("返事・ログに案件名・案件の ID を出さない", !JSON.stringify(r.body).includes("テスト") && !logs.join("\n").includes("テスト") && !logs.join("\n").includes(DEAL), logs.join("|"));
  }
  // 送り直し（created:false）は LINE を出さない
  {
    const { d, pushes } = deps({ intake: async () => ({ kind: "ok", value: { created: false, no: 12, status: "下準備中" } }) });
    const r = await handleSateiRequest(TOKEN, body(), d);
    ok("送り直しは created:false で同じ番号", r.body.created === false && r.body.no === 12 && pushes.length === 0);
  }
  // LINE が送れなくても受付は ok
  {
    const { d } = deps({ push: async () => { throw new Error("x"); } });
    ok("LINE が失敗しても ok", (await handleSateiRequest(TOKEN, body(), d)).body.result === "ok");
  }
  // 時間が残っていなければ LINE を送らない
  {
    let t = 0;
    const { d, pushes } = deps({ now: () => (t += 13000) });
    const r = await handleSateiRequest(TOKEN, body(), d);
    ok("残り3秒未満なら LINE を送らずに ok", r.body.result === "ok" && pushes.length === 0);
  }
  // スイッチ・設定
  {
    const off = deps({ env: { JOB_API_TOKEN: KEY, TASK_SATEI: "0", TASK_SATEI_USER_IDS: USER } });
    ok("TASK_SATEI が off なら rejected TASK_SATEI_OFF", JSON.stringify((await handleSateiRequest(TOKEN, body(), off.d)).body) === JSON.stringify({ result: "rejected", code: "TASK_SATEI_OFF" }));
    const noDb = deps({ dealsDbId: null });
    ok("CRM_DEALS_DB_ID が無ければ unknown", (await handleSateiRequest(TOKEN, body(), noDb.d)).body.result === "unknown");
  }
  // 案件の判定
  {
    const cases: Array<[string, SateiRequestDeps["readDeal"], string]> = [
      ["案件が無い", async () => null, "DEAL_NOT_FOUND"],
      ["消えた案件", async () => ({ deal: { ...GOOD, gone: true }, kind: "マンション" }), "DEAL_NOT_FOUND"],
      ["別の DB", async () => ({ deal: { ...GOOD, parentDbId: "f".repeat(32) }, kind: "マンション" }), "DEAL_NOT_FOUND"],
      ["戸建", async () => ({ deal: GOOD, kind: "戸建" }), "NOT_MANSION"],
      ["種別が分からない", async () => ({ deal: GOOD, kind: null }), "NOT_MANSION"],
      ["フォルダなし", async () => ({ deal: { ...GOOD, folderId: null }, kind: "マンション" }), "NO_FOLDER"],
    ];
    for (const [name, readDeal, code] of cases) {
      const { d, intakes } = deps({ readDeal });
      const r = await handleSateiRequest(TOKEN, body(), d);
      ok(`${name} → needs_confirm ${code}・portal を呼ばない`, r.body.result === "needs_confirm" && r.body.code === code && intakes.length === 0);
    }
    const thrown = deps({ readDeal: async () => { throw new Error("notion"); } });
    ok("Notion が読めなければ unknown", (await handleSateiRequest(TOKEN, body(), thrown.d)).body.result === "unknown");
  }
  // portal の断り
  {
    const map: Array<[string, string | null]> = [
      ["SATEI_AWAITING_REASON", "SATEI_AWAITING_REASON"],
      ["INTAKE_STOPPED", "INTAKE_STOPPED"],
      ["SATEI_HUMAN_ONLY", "HUMAN_ONLY"],
      ["SATEI_ALREADY_CLOSED", "ALREADY_CLOSED"],
      ["INTAKE_MISMATCH", "EVENT_MISMATCH"],
      ["BAD_REQUEST", null],
      ["CONFIG", null],
    ];
    for (const [portalCode, code] of map) {
      const { d } = deps({ intake: async () => ({ kind: "rejected", status: 409, code: portalCode }) });
      const r = await handleSateiRequest(TOKEN, body(), d);
      ok(`portal ${portalCode} → ${code ?? "unknown"}`, code ? r.body.result === "rejected" && r.body.code === code : JSON.stringify(r.body) === '{"result":"unknown"}');
    }
    const unk = deps({ intake: async () => ({ kind: "unknown", reason: "timeout" }) });
    ok("portal が時間切れなら unknown", (await handleSateiRequest(TOKEN, body(), unk.d)).body.result === "unknown");
  }
  // sateiMachineIntake：machine:true を送る・503 INTAKE_STOPPED は断り
  {
    const sent: unknown[] = [];
    const f = (status: number, json: unknown) =>
      (async (_u: unknown, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(json), { status });
      }) as typeof fetch;
    const opts = (fetchImpl: typeof fetch) => ({ fetchImpl, baseUrl: "https://portal.example", token: "t", timeoutMs: 1000 });
    const req = { eventId: EV, dealId: DEAL, dealNo: 42, folderId: GOOD.folderId!, dealName: "テスト案件", requestedBy: USER };
    const a = await sateiMachineIntake(req, opts(f(201, { created: true, job: { no: 3, status: "受付" } })));
    ok("machine:true を足して送る", (sent[0] as Record<string, unknown>).machine === true && a.kind === "ok");
    const b = await sateiMachineIntake(req, opts(f(503, { code: "INTAKE_STOPPED" })));
    ok("503 INTAKE_STOPPED は rejected", b.kind === "rejected" && b.code === "INTAKE_STOPPED");
    const c = await sateiMachineIntake(req, opts(f(503, { code: "X" })));
    ok("ほかの 503 は unknown", c.kind === "unknown");
    const e = await sateiMachineIntake(req, opts(f(409, { code: "SATEI_HUMAN_ONLY" })));
    ok("409 は符号つきの rejected", e.kind === "rejected" && e.code === "SATEI_HUMAN_ONLY");
  }
  if (fail) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nsatei-request: all passed");
}
main();
