/**
 * 個人 LINE へ先に送るまとめ（STAFF_DIGEST_DM）の「担当の 1対1 の返事の細い口」を、route.ts の POST を本物のまま呼んで確かめる。
 *   ・控え（staffdigest:dmuser:<userId>）のある担当の 1対1：番号の返事だけ処理し、ほかは案内1回・あとは黙る。
 *     タスクの登録（AI）・メニュー・メール・査定など、ほかの機能へは落ちない
 *   ・控えの無い人・スイッチ off：今までどおり「送り主の制限で読み飛ばし」（off は KV も呼ばない）
 *   ・許可リストの人（下村さん）：細い口を使わない（今までの流れ）
 * 外への通信は全部横取りする（LINE・KV＝fetch、Anthropic＝Messages.prototype.create、Notion＝Client.prototype.request）。値はどれもテスト用。
 */
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@notionhq/client";

let fail = 0;
const origLog = console.log;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    origLog(`❌ ${name} ${d}`);
  } else origLog(`✅ ${name}`);
};

const G = "C" + "a".repeat(32);
const BOSS = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const OUTSIDER = "U" + "c".repeat(32);
const BOT = "U" + "f".repeat(32);
const PAGE_A = "11111111-1111-1111-1111-111111111111";
const PAGE_B = "22222222-2222-2222-2222-222222222222";
const PAGE_X = "99999999-9999-9999-9999-999999999999";
const SECRET = "test-channel-secret";
const KV_URL = "https://kv.example.test";
process.env.LINE_CHANNEL_SECRET = SECRET;
process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-access-token";
process.env.LINE_GROUP_ID = G;
process.env.LINE_BOT_USER_ID = BOT;
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.NOTION_API_KEY = "test-notion";
process.env.NOTION_DATABASE_ID = "test-db";
process.env.TASK_BUTTONS_ADMIN_IDS = BOSS;
process.env.TASK_FOLLOWUP = "1";
process.env.STAFF_DIGEST = "1";
process.env.STAFF_DIGEST_DM = "1";
process.env.KV_REST_API_URL = KV_URL;
process.env.KV_REST_API_TOKEN = "kv-token";
for (const k of [
  "KV_URL", "JOB_ALLOWED_USER_IDS", "PORTAL_BASE_URL", "JOB_API_TOKEN", "SECRETARY_ALLOWED_USER_IDS", "SECRETARY_ALLOWED_GROUP_IDS",
  "TASK_MENU", "TASK_BUTTONS", "TASK_CANDIDATES", "TASK_CANDIDATE_USER_IDS", "TASK_CANDIDATE_INSTANT", "TASK_CANDIDATE_GROUP_IDS",
  "TASK_RECORD", "TASK_SATEI", "TASK_SATEI_USER_IDS", "PHOTO_MENTION_ASK", "GROUP_SATEI", "GROUP_INBOX", "DEAL_LOG", "NOTION_MEMBERS_DATABASE_ID",
]) delete process.env[k];

// ── KV（Upstash の REST をまねる。get / set(nx) / del だけ本物らしく、ほかは 1 を返す） ──
const store = new Map<string, string>();
const kvCmds: string[] = [];
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
function kvExec(cmd: unknown[]): unknown {
  const [op, ...a] = cmd.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
  const name = op.toLowerCase();
  kvCmds.push(`${name} ${a[0] ?? ""}`);
  if (name === "get") return store.has(a[0]) ? b64(store.get(a[0]) as string) : null;
  if (name === "set") {
    if (a.slice(2).some((x) => x.toLowerCase() === "nx") && store.has(a[0])) return null;
    store.set(a[0], a[1]);
    return b64("OK");
  }
  if (name === "del") return store.delete(a[0]) ? 1 : 0;
  if (name === "smembers" || name === "lrange") return [];
  return 1;
}

// ── LINE・KV（fetch） ──
const lineReplies: string[] = [];
const linePushes: string[] = [];
const otherFetch: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.startsWith(KV_URL)) {
    const body = JSON.parse(String(init?.body ?? "[]")) as unknown[];
    if (url.endsWith("/pipeline") || url.endsWith("/multi-exec")) return json((body as unknown[][]).map((c) => ({ result: kvExec(c) })));
    return json({ result: kvExec(body) });
  }
  if (url.includes("api.line.me/v2/bot/message/reply")) {
    lineReplies.push(String(init?.body ?? ""));
    return json({ sentMessages: [{ id: "m1" }] });
  }
  if (url.includes("api.line.me/v2/bot/message/push")) {
    linePushes.push(String(init?.body ?? ""));
    return json({ sentMessages: [{ id: "m2" }] });
  }
  otherFetch.push(url.split("?")[0]);
  return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
const blocked: string[] = [];
const block = (label: string) =>
  ((..._a: unknown[]) => {
    blocked.push(label);
    throw new Error(`テストでは外へつながない: ${label}`);
  }) as never;
(http as { request: unknown }).request = block("http.request");
(https as { request: unknown }).request = block("https.request");
(net as { connect: unknown }).connect = block("net.connect");
(net as { createConnection: unknown }).createConnection = block("net.createConnection");
(tls as { connect: unknown }).connect = block("tls.connect");

// ── Anthropic：呼ばれたら数える（細い口からは1回も呼ばれないはず） ──
let aiCalls = 0;
(Anthropic.Messages.prototype as unknown as { create: unknown }).create = async () => {
  aiCalls++;
  return { content: [{ type: "text", text: JSON.stringify({ isTask: false, confidence: 0 }) }] };
};

// ── Notion：番号 → ページ（リマインド番号の問い合わせ）と、ページの更新・本文の追加を控える ──
const byNumber: Record<number, { id: string; title: string }> = {
  1: { id: PAGE_A, title: "天満の資料を送る" },
  // 2番は、いまは別のタスクに振り直されている（控えのタスクとは別のページ）
  2: { id: PAGE_X, title: "別のタスク" },
};
const notionCalls: string[] = [];
Client.prototype.request = (async (args: { path: string; method: string; body?: Record<string, unknown> }) => {
  const filter = JSON.stringify(args.body?.filter ?? {});
  if (args.method === "post" && args.path.endsWith("/query") && filter.includes("リマインド番号")) {
    const num = Number(/"equals":(\d+)/.exec(filter)?.[1] ?? 0);
    notionCalls.push(`query-number ${num}`);
    const hit = byNumber[num];
    const results = hit ? [{ object: "page", id: hit.id, properties: { 名前: { title: [{ plain_text: hit.title }] } } }] : [];
    return { object: "list", results, has_more: false, next_cursor: null };
  }
  if (args.method === "patch" && args.path.startsWith("pages/")) {
    notionCalls.push(`update ${args.path.slice("pages/".length)}`);
    return { object: "page", id: args.path.slice("pages/".length), properties: {} };
  }
  if (args.method === "patch" && args.path.startsWith("blocks/")) {
    notionCalls.push(`append ${args.path.split("/")[1]}`);
    return { object: "list", results: [] };
  }
  notionCalls.push(`other ${args.method} ${args.path}`);
  return { object: "list", results: [], has_more: false, next_cursor: null };
}) as unknown as typeof Client.prototype.request;

// ── ログ ──
const logs: string[] = [];
console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
console.error = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
console.warn = () => undefined;

async function post(route: { POST: (req: never) => Promise<Response> }, events: unknown[]) {
  const body = JSON.stringify({ events });
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64");
  const { NextRequest } = await import("next/server");
  return route.POST(
    new NextRequest("https://example.test/api/webhook", {
      method: "POST",
      headers: { "x-line-signature": sig, "content-type": "application/json" },
      body,
    }) as never,
  );
}
let seq = 9200000000000;
const msg = (userId: string, message: Record<string, unknown>) => ({
  type: "message",
  timestamp: Date.now(),
  replyToken: `rt-${++seq}`,
  source: { type: "user", userId },
  message: { id: String(seq), ...message },
});
const text = (userId: string, t: string) => msg(userId, { type: "text", text: t });
const reset = () => {
  lineReplies.length = 0; linePushes.length = 0; otherFetch.length = 0; notionCalls.length = 0; kvCmds.length = 0; logs.length = 0; blocked.length = 0; aiCalls = 0;
};
const replyTexts = () => lineReplies.map((b) => (JSON.parse(b) as { messages: Array<{ text?: string }> }).messages.map((m) => m.text ?? "(card)").join("|"));
const NOTICE = "このトークでは、進捗の確認への返事だけ受け付けています。番号をつけて返信してください（例：「1済」）";
const quiet = () => aiCalls === 0 && linePushes.length === 0 && otherFetch.length === 0 && blocked.length === 0;

(async () => {
  const { dmUserKey, dmNoticeKey } = await import("../src/lib/staff-digest-dm");
  const route = (await import("../src/app/api/webhook/route")) as unknown as { POST: (req: never) => Promise<Response> };
  const plant = (userId: string) =>
    store.set(dmUserKey(userId), JSON.stringify({ date: "2026-11-28", slot: "am", nums: [1, 2], taskIds: [PAGE_A, PAGE_B], at: Date.now() }));
  plant(STAFF);

  // 1) 番号の返事：グループの返事と同じ処理（完了）。返事は文字1通
  reset();
  let res = await post(route, [text(STAFF, "1済")]);
  ok("「1済」：200", res.status === 200, String(res.status));
  ok("「1済」：その人あての1番を完了にする（Notion は番号の問い合わせ＋更新だけ）", JSON.stringify(notionCalls) === JSON.stringify(["query-number 1", `update ${PAGE_A}`]), JSON.stringify(notionCalls));
  ok("「1済」：返事は文字1通（完了の文）", replyTexts().length === 1 && replyTexts()[0].startsWith("☑️ 完了にしました（1件）\n1. 天満の資料を送る"), JSON.stringify(replyTexts()));
  ok("「1済」：返事の印（staffdigest:answered）を付ける", kvCmds.some((c) => c.startsWith("eval")), JSON.stringify(kvCmds));
  ok("「1済」：AI・push・ほかの通信なし", quiet(), `${aiCalls} ${JSON.stringify(otherFetch)} ${JSON.stringify(blocked)}`);
  ok("「1済」：送り主の制限のログは出ない・ログに ID・本文なし", !logs.some((l) => l.includes("送り主の制限")) && !logs.some((l) => l.includes(STAFF) || l.includes("天満")), JSON.stringify(logs));

  // 2) 番号が振り直されていたら（同じ番号の別のタスク）、当てない
  reset();
  res = await post(route, [text(STAFF, "2済")]);
  ok("「2済」（2番はいま別のタスク）：完了にしない・見つかりませんでしたと返す", notionCalls.length === 1 && notionCalls[0] === "query-number 2" && replyTexts()[0]?.includes("2番は見つかりませんでした"), JSON.stringify([notionCalls, replyTexts()]));

  // 3) その人あてでない番号
  reset();
  res = await post(route, [text(STAFF, "7済")]);
  ok("「7済」（その人あてでない番号）：Notion を呼ばず「その番号は…」", notionCalls.length === 0 && JSON.stringify(replyTexts()) === JSON.stringify(["その番号は、あなたあての確認にはありません"]), JSON.stringify([notionCalls, replyTexts()]));

  // 4) ほかの機能へは落ちない：依頼・メニュー・#新規・送信・画像。案内は1時間に1回だけ
  reset();
  res = await post(route, [
    text(STAFF, "メニュー"),
    text(STAFF, "#新規 山田太郎 090-0000-0000"),
    text(STAFF, "送信"),
    text(STAFF, "了解です"),
    msg(STAFF, { type: "image" }),
    msg(STAFF, { type: "file", fileName: "登記.pdf" }),
  ]);
  ok("ほかの機能の言葉・画像・ファイル：200", res.status === 200, String(res.status));
  ok("案内は1回だけ（あとは黙る）", JSON.stringify(replyTexts()) === JSON.stringify([NOTICE]), JSON.stringify(replyTexts()));
  ok("Notion・AI・push・ほかの通信（画像の取得など）なし", notionCalls.length === 0 && quiet(), JSON.stringify([notionCalls, aiCalls, otherFetch, blocked]));
  ok("案内の印は1時間", store.has(dmNoticeKey(STAFF)));
  reset();
  res = await post(route, [text(STAFF, "明日までに天満の資料を作ってください")]);
  ok("番号の無い依頼の文（2件あて）：タスクの登録へ行かず、番号を聞き返すだけ", aiCalls === 0 && notionCalls.length === 0 && replyTexts()[0]?.startsWith("どの番号の件か分かりませんでした"), JSON.stringify([aiCalls, notionCalls, replyTexts()]));

  // 5) 同じイベントが届き直しても2回処理しない
  reset();
  const again = text(STAFF, "1 送りました");
  await post(route, [again]);
  await post(route, [again]);
  ok("届き直し：進捗は1回だけ書く", notionCalls.filter((c) => c.startsWith("append")).length === 1 && lineReplies.length === 1, JSON.stringify([notionCalls, replyTexts()]));

  // 6) 控えの無い人：今までどおり読み飛ばし（KV は控えを1回読むだけ）
  reset();
  res = await post(route, [text(OUTSIDER, "1済")]);
  ok("控えの無い人：返事なし・Notion なし・読み飛ばしのログ", lineReplies.length === 0 && notionCalls.length === 0 && quiet() && logs.includes("送り主の制限で読み飛ばし: user user-not-allowed"), JSON.stringify([replyTexts(), logs]));
  ok("控えの無い人：KV は控えの読み出し1回だけ", JSON.stringify(kvCmds) === JSON.stringify([`get ${dmUserKey(OUTSIDER)}`]), JSON.stringify(kvCmds));

  // 7) 許可リストの人（下村さん）：控えがあっても細い口を使わない
  plant(BOSS);
  reset();
  res = await post(route, [text(BOSS, "7済")]);
  ok("許可リストの人：細い口を通らない（控えを読まない・「その番号は…」「このトークでは…」を返さない）",
    !kvCmds.includes(`get ${dmUserKey(BOSS)}`) && !replyTexts().some((r) => r.includes("あなたあての確認") || r === NOTICE) && !logs.some((l) => l.startsWith("[staff-digest] dm reply")),
    JSON.stringify([kvCmds, replyTexts(), logs]));

  // 8) スイッチ off：今までどおり（KV も呼ばない）
  delete process.env.STAFF_DIGEST_DM;
  reset();
  res = await post(route, [text(STAFF, "1済"), msg(STAFF, { type: "image" })]);
  ok("off：返事なし・KV なし・Notion なし・ログは今までの2行だけ",
    lineReplies.length === 0 && kvCmds.length === 0 && notionCalls.length === 0 && quiet() &&
      JSON.stringify(logs) === JSON.stringify(["送り主の制限で読み飛ばし: user user-not-allowed", "送り主の制限で読み飛ばし: user user-not-allowed"]),
    JSON.stringify([kvCmds, logs]));

  if (fail) {
    origLog(`\n${fail}件失敗`);
    process.exit(1);
  }
  origLog("\nすべて成功");
  process.exit(0);
})().catch((e) => {
  origLog(e);
  process.exit(1);
});
