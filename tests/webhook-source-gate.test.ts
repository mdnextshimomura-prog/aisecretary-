/**
 * Webhook の送り主の制限（2026-11-08）。
 *
 * 1) 判定そのもの（checkSecretarySource）を表で確かめる。
 * 2) route.ts の POST を本物のまま呼び、外への通信（LINE 返信・Notion・Gmail・Anthropic・KV）を
 *    すべて横取りして数える。
 *    - 他グループ・許可外の 1対1・room からのイベント → 外への通信が 1 回も起きず 200
 *    - 会社グループ・許可済みの 1対1 → 今までどおり処理され、LINE への返信が呼ばれる
 *    （「#新規」だけの発言は CRM の書式案内を返すだけなので、Notion を書かずに返信まで行く）
 *
 * KV は未設定（メモリ経路）で回す。実際の外部 API には一切つながない。
 */
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { checkSecretarySource, parseAllowedUserIds } from "../src/lib/webhook-source";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

const G = "C" + "a".repeat(32);
const G_OTHER = "C" + "e".repeat(32);
const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const OUTSIDER = "U" + "c".repeat(32);

// ---- 1) 判定 ----
const env = { LINE_GROUP_ID: G, SECRETARY_ALLOWED_USER_IDS: ` ${SHIMO} , ,${STAFF}` };
ok("許可リストは空白・空要素を捨てて読む", JSON.stringify(parseAllowedUserIds(env.SECRETARY_ALLOWED_USER_IDS)) === JSON.stringify([SHIMO, STAFF]));
ok("会社グループは通す", checkSecretarySource({ type: "group", groupId: G, userId: OUTSIDER }, env).ok);
ok("別グループは拒否", !checkSecretarySource({ type: "group", groupId: G_OTHER, userId: SHIMO }, env).ok);
ok("グループ ID なしのグループは拒否", !checkSecretarySource({ type: "group", userId: SHIMO }, env).ok);
ok("type は user でも groupId が会社グループなら拒否（種類で判定）", !checkSecretarySource({ type: "user", groupId: G, userId: OUTSIDER }, env).ok);
ok("許可済みの 1対1 は通す", checkSecretarySource({ type: "user", userId: SHIMO }, env).ok);
ok("許可済み 2 人目の 1対1 も通す", checkSecretarySource({ type: "user", userId: STAFF }, env).ok);
ok("許可外の 1対1 は拒否", !checkSecretarySource({ type: "user", userId: OUTSIDER }, env).ok);
ok("userId なしの 1対1 は拒否", !checkSecretarySource({ type: "user" }, env).ok);
ok("room は拒否", !checkSecretarySource({ type: "room", userId: SHIMO }, env).ok);
ok("種類不明は拒否", !checkSecretarySource({ userId: SHIMO }, env).ok);
ok("source なしは拒否", !checkSecretarySource(undefined, env).ok);
const noUsers = { LINE_GROUP_ID: G };
const r1 = checkSecretarySource({ type: "user", userId: SHIMO }, noUsers);
ok("許可リスト未設定なら 1対1 はすべて拒否", !r1.ok && r1.reason === "user-not-configured");
ok("許可リストが空文字でも拒否", !checkSecretarySource({ type: "user", userId: SHIMO }, { LINE_GROUP_ID: G, SECRETARY_ALLOWED_USER_IDS: " , " }).ok);
const r2 = checkSecretarySource({ type: "group", groupId: G }, { SECRETARY_ALLOWED_USER_IDS: SHIMO });
ok("LINE_GROUP_ID 未設定ならグループは拒否", !r2.ok && r2.reason === "group-not-configured");
ok("LINE_GROUP_ID が空文字でもグループは拒否", !checkSecretarySource({ type: "group", groupId: "" }, { LINE_GROUP_ID: "" }).ok);

// ---- 2) route.ts を通しで ----
const SECRET = "test-channel-secret";
process.env.LINE_CHANNEL_SECRET = SECRET;
process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-access-token";
process.env.LINE_GROUP_ID = G;
process.env.SECRETARY_ALLOWED_USER_IDS = SHIMO;
process.env.LINE_BOT_USER_ID = "U" + "f".repeat(32);
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "KV_URL", "JOB_ALLOWED_USER_IDS", "PORTAL_BASE_URL", "JOB_API_TOKEN"]) {
  delete process.env[k];
}

// 外への通信をすべて横取りする（呼ばれたら記録して失敗させる）
const fetchCalls: string[] = [];
const socketCalls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  fetchCalls.push(url);
  return new Response(JSON.stringify({ sentMessages: [{ id: "m1" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;
const block = (label: string) =>
  ((..._args: unknown[]) => {
    socketCalls.push(label);
    throw new Error(`テストでは外へつながない: ${label}`);
  }) as never;
(http as { request: unknown }).request = block("http.request");
(https as { request: unknown }).request = block("https.request");
(net as { connect: unknown }).connect = block("net.connect");
(net as { createConnection: unknown }).createConnection = block("net.createConnection");
(tls as { connect: unknown }).connect = block("tls.connect");

let seq = 0;
function textEvent(source: Record<string, string>, text: string) {
  seq++;
  return {
    type: "message",
    timestamp: Date.now(),
    replyToken: `rt-${seq}`,
    source,
    message: { id: `msg-${seq}-${Date.now()}`, type: "text", text },
  };
}

async function post(route: { POST: (req: never) => Promise<Response> }, events: unknown[]) {
  const body = JSON.stringify({ events });
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("https://example.test/api/webhook", {
    method: "POST",
    headers: { "x-line-signature": sig, "content-type": "application/json" },
    body,
  });
  return route.POST(req as never);
}

const reset = () => {
  fetchCalls.length = 0;
  socketCalls.length = 0;
};
const lineReplies = () => fetchCalls.filter((u) => u.includes("api.line.me")).length;

(async () => {
  const route = (await import("../src/app/api/webhook/route")) as unknown as {
    POST: (req: never) => Promise<Response>;
  };

  // 署名が違えば 401（今までどおり）
  {
    const { NextRequest } = await import("next/server");
    const res = await route.POST(
      new NextRequest("https://example.test/api/webhook", {
        method: "POST",
        headers: { "x-line-signature": "bad" },
        body: JSON.stringify({ events: [] }),
      }) as never
    );
    ok("署名違いは 401", res.status === 401);
  }

  const rejected: Array<[string, Record<string, string>]> = [
    ["別グループ", { type: "group", groupId: G_OTHER, userId: SHIMO }],
    ["許可外の 1対1", { type: "user", userId: OUTSIDER }],
    ["room", { type: "room", roomId: "R" + "1".repeat(32), userId: SHIMO }],
  ];
  const texts = ["#新規", "1済", "メール送って 山田さんに 明日伺います"];
  for (const [label, src] of rejected) {
    for (const t of texts) {
      reset();
      const res = await post(route, [textEvent(src, t)]);
      ok(
        `${label}「${t}」→ 200・外への通信なし（LINE 返信・Notion・Gmail・AI・KV のどれも呼ばれない）`,
        res.status === 200 && fetchCalls.length === 0 && socketCalls.length === 0,
        `status=${res.status} fetch=${fetchCalls.length} socket=${socketCalls.length}`
      );
    }
  }

  // 許可された送り主は今までどおり処理される（#新規 の書式案内が LINE に返る）
  reset();
  {
    const res = await post(route, [textEvent({ type: "group", groupId: G, userId: OUTSIDER }, "#新規")]);
    ok("会社グループの「#新規」は処理され LINE に返信する", lineReplies() === 1 && res.status === 200, `status=${res.status} fetch=${JSON.stringify(fetchCalls)}`);
  }
  reset();
  {
    const res = await post(route, [textEvent({ type: "user", userId: SHIMO }, "#新規")]);
    ok("許可済みの 1対1 の「#新規」は処理され LINE に返信する", lineReplies() === 1 && res.status === 200, `status=${res.status} fetch=${JSON.stringify(fetchCalls)}`);
  }

  // 混ざったバッチ：許可された分だけ処理される
  reset();
  {
    const res = await post(route, [
      textEvent({ type: "group", groupId: G_OTHER, userId: SHIMO }, "#新規"),
      textEvent({ type: "user", userId: SHIMO }, "#新規"),
      textEvent({ type: "user", userId: OUTSIDER }, "#新規"),
    ]);
    ok("混ざったバッチでは許可された 1 件だけ返信する", lineReplies() === 1 && res.status === 200, `status=${res.status} fetch=${fetchCalls.length}`);
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
