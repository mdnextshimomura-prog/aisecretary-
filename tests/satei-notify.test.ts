/**
 * B2 査定書：通知の受け口（合言葉・uuidv5・retry key・入力の検査・push の結果）と line.ts の retry key つき push。
 */
import { createHmac } from "node:crypto";
import {
  handleSateiNotify,
  parseNotifyInput,
  pushResultOf,
  sateiNotifyAuthorized,
  sateiNotifyToken,
  sateiRetryKey,
  SATEI_RETRY_NAMESPACE,
  uuidv5,
  type SateiNotifyDeps,
} from "../src/lib/satei-notify";
import { pushMessagesWithRetryKey } from "../src/lib/line";

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

const KEY = "k".repeat(40);
const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const TOKEN = createHmac("sha256", Buffer.from(KEY, "utf8")).update("satei-notify", "utf8").digest("hex");

// ── 合言葉 ──
ok("合言葉＝HMAC-SHA256(JOB_API_TOKEN, satei-notify) の hex", sateiNotifyToken(KEY) === TOKEN);
ok("正しい合言葉は通す", sateiNotifyAuthorized(TOKEN, KEY));
ok("鍵違いは断る", !sateiNotifyAuthorized("0".repeat(64), KEY));
ok("長さ違いは断る", !sateiNotifyAuthorized(TOKEN.slice(1), KEY));
ok("ヘッダ無しは断る", !sateiNotifyAuthorized(null, KEY));
ok("JOB_API_TOKEN が無いと誰も通さない", !sateiNotifyAuthorized(TOKEN, undefined));
ok("JOB_API_TOKEN が32字未満なら誰も通さない", !sateiNotifyAuthorized(sateiNotifyToken("short"), "short"));

// ── uuidv5・retry key ──
ok("uuidv5 は公開の例と同じ", uuidv5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8") === "886313e1-3b8a-5372-9b90-0c9aee199e5d");
ok("名前空間は固定値", SATEI_RETRY_NAMESPACE === "3f0c6a1e-8d2b-4c5e-9a71-b2d4e6f80a13");
ok("retry key は no:kind:generation の uuidv5", sateiRetryKey(123, "draft", 1) === "6a59ac01-411c-518b-86eb-27eb8c85f188");
ok("同じ入力なら同じ値", sateiRetryKey(123, "draft", 1) === sateiRetryKey(123, "draft", 1));
ok("世代が違えば別の値", sateiRetryKey(123, "draft", 2) === "d711292f-b1cf-5375-9b71-c53ad7e23e89");
ok("種類が違えば別の値", sateiRetryKey(123, "saved", 1) !== sateiRetryKey(123, "draft", 1));
ok(
  "UUID の形（版5・変種10）",
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sateiRetryKey(1, "failed", 0)),
);

// ── push の結果 ──
ok("200 → sent", pushResultOf(200) === "sent");
ok("409（同じキーで受付済み）→ sent", pushResultOf(409) === "sent");
ok("400 → unknown", pushResultOf(400) === "unknown");
ok("500 → unknown", pushResultOf(500) === "unknown");
ok("例外（null）→ unknown", pushResultOf(null) === "unknown");

// ── 入力の検査 ──
const SHA = "c".repeat(64);
const DRAFT = {
  no: 12,
  kind: "draft",
  generation: 3,
  dealName: "テスト",
  driveFileId: "1FileId_abcdefghij",
  verdict: "要修正",
  findings: ["a", "b", "c", "d"],
  artifactSha256: SHA,
};
const p1 = parseNotifyInput(DRAFT);
ok("draft を読む", p1 !== null && p1.no === 12 && p1.kind === "draft" && p1.generation === 3 && p1.findings.length === 3);
ok("findings は JSON 配列の文字列でも読む", parseNotifyInput({ ...DRAFT, findings: JSON.stringify(["x"]) })?.findings[0] === "x");
ok("missing は JSON 配列の文字列でも読む", parseNotifyInput({ no: 1, kind: "failed", generation: 1, dealName: "a", failReason: "materials", missing: '["謄本"]' })?.missing[0] === "謄本");
ok("draft で sha が無い → null", parseNotifyInput({ ...DRAFT, artifactSha256: undefined }) === null);
ok("draft で Drive ID が無い → null", parseNotifyInput({ ...DRAFT, driveFileId: "" }) === null);
ok("draft で generation 0 → null", parseNotifyInput({ ...DRAFT, generation: 0 }) === null);
ok("知らない kind → null", parseNotifyInput({ ...DRAFT, kind: "other" }) === null);
ok("知らない判定 → null", parseNotifyInput({ ...DRAFT, verdict: "まあまあ" }) === null);
ok("知らない failReason → null", parseNotifyInput({ no: 1, kind: "failed", generation: 1, dealName: "a", failReason: "x" }) === null);
ok("no が0 → null", parseNotifyInput({ ...DRAFT, no: 0 }) === null);
ok("配列 → null", parseNotifyInput([DRAFT]) === null);

// ── 受け口 ──
const env = { JOB_API_TOKEN: KEY, TASK_SATEI: "1", TASK_SATEI_USER_IDS: `${SHIMO},${STAFF}` };
function mk(status: number | null | "throw", e: Record<string, string | undefined> = env) {
  const pushes: Array<{ to: string; messages: unknown[]; key: string }> = [];
  const logs: string[] = [];
  const deps: SateiNotifyDeps = {
    env: e,
    push: async (to, messages, key) => {
      pushes.push({ to, messages, key });
      if (status === "throw") throw new Error("boom");
      return status;
    },
    log: (l) => logs.push(l),
  };
  return { pushes, logs, deps };
}
const RAW = JSON.stringify(DRAFT);

(async () => {
  let m = mk(200);
  let r = await handleSateiNotify("0".repeat(64), RAW, m.deps);
  ok("鍵違い → 401・送らない", r.status === 401 && m.pushes.length === 0);
  r = await handleSateiNotify(null, RAW, m.deps);
  ok("ヘッダ無し → 401", r.status === 401 && m.pushes.length === 0);
  m = mk(200, { ...env, TASK_SATEI: "" });
  r = await handleSateiNotify("bad", RAW, m.deps);
  ok("off でも鍵違いは 401", r.status === 401);

  m = mk(200);
  r = await handleSateiNotify(TOKEN, RAW, m.deps);
  ok("200 → sent", r.status === 200 && r.body.result === "sent");
  ok("通知先は TASK_SATEI_USER_IDS の先頭", m.pushes[0]?.to === SHIMO);
  ok("retry key は依頼・種類・世代から", m.pushes[0]?.key === sateiRetryKey(12, "draft", 3));
  ok("draft はカード1通", m.pushes[0]?.messages.length === 1 && (m.pushes[0]?.messages[0] as { type: string }).type === "flex");
  ok("ログは J番号・kind・結果だけ", m.logs.includes("[satei] notify #J12 draft sent") && !m.logs.join("").includes("テスト") && !m.logs.join("").includes(SHIMO));

  m = mk(409);
  r = await handleSateiNotify(TOKEN, RAW, m.deps);
  ok("409 → sent（二重に届けない）", r.status === 200 && r.body.result === "sent");
  m = mk(500);
  r = await handleSateiNotify(TOKEN, RAW, m.deps);
  ok("500 → unknown", r.body.result === "unknown");
  m = mk(null);
  r = await handleSateiNotify(TOKEN, RAW, m.deps);
  ok("時間切れ（null）→ unknown", r.body.result === "unknown");
  m = mk("throw");
  r = await handleSateiNotify(TOKEN, RAW, m.deps);
  ok("例外 → unknown", r.status === 200 && r.body.result === "unknown");

  m = mk(200);
  await handleSateiNotify(TOKEN, RAW, m.deps);
  await handleSateiNotify(TOKEN, RAW, m.deps);
  ok("送り直しても同じ retry key", m.pushes.length === 2 && m.pushes[0].key === m.pushes[1].key);

  m = mk(200, { ...env, TASK_SATEI: "" });
  r = await handleSateiNotify(TOKEN, RAW, m.deps);
  ok("off → 送らず deferred（契約 6-12）", r.status === 200 && r.body.result === "deferred" && m.pushes.length === 0);
  m = mk(200, { ...env, TASK_SATEI_USER_IDS: "" });
  r = await handleSateiNotify(TOKEN, RAW, m.deps);
  ok("通知先が無い → 送らず deferred", r.body.result === "deferred" && m.pushes.length === 0);
  m = mk(200);
  r = await handleSateiNotify(TOKEN, "{not json", m.deps);
  ok("JSON でない → 400", r.status === 400 && m.pushes.length === 0);
  r = await handleSateiNotify(TOKEN, JSON.stringify({ ...DRAFT, kind: "x" }), m.deps);
  ok("形が違う → 400", r.status === 400 && m.pushes.length === 0);
  m = mk(200);
  r = await handleSateiNotify(TOKEN, JSON.stringify({ no: 7, kind: "saved", generation: 2, dealName: "テスト" }), m.deps);
  ok("saved は文字1通", r.body.result === "sent" && (m.pushes[0]?.messages[0] as { type: string }).type === "text");

  // ── line.ts の retry key つき push ──
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (st: number): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: st });
    }) as typeof fetch;
  const st = await pushMessagesWithRetryKey(SHIMO, [{ type: "text", text: "x" }], "key-1", 1000, f(409));
  const h = calls[0]?.init.headers as Record<string, string>;
  ok("push の口", calls[0]?.url === "https://api.line.me/v2/bot/message/push");
  ok("X-Line-Retry-Key を付ける", h["X-Line-Retry-Key"] === "key-1");
  ok("本文は to と messages", calls[0]?.init.body === JSON.stringify({ to: SHIMO, messages: [{ type: "text", text: "x" }] }));
  ok("状態番号を返す（409）", st === 409);
  const st2 = await pushMessagesWithRetryKey(SHIMO, [], "k", 1000, (async () => {
    throw new Error("x");
  }) as typeof fetch);
  ok("例外 → null（投げない）", st2 === null);

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
