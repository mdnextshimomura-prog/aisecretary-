/**
 * 普通のグループの査定依頼・入口 B を route.ts の POST を本物のまま呼んで確かめる（Task 8 fix round 1）。
 * GROUP_SATEI=1・対象グループで、手打ちの「@秘書 査定お願いします」（メンションの印なし）を送る。
 * AI（Anthropic）を遅くしても、手打ちの案内（MSG_INTAKE_TYPED_MENTION）の返事は入口 B の処理が終わる前に出て、
 * POST は入口 B の処理を待ち切ってから返すこと。
 * 外への通信は全部横取りする（LINE＝fetch、Anthropic＝Messages.prototype.create、Notion＝Client.prototype.request）。
 * KV は未設定（route のイベントの予約がメモリ経路になるため）。値はどれもテスト用。
 */
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@notionhq/client";
import { MSG_INTAKE_TYPED_MENTION } from "../src/lib/task-intake";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name}`);
};

const G = "C" + "a".repeat(32);
const STAFF = "U" + "b".repeat(32);
const BOSS = "U" + "c".repeat(32);
const BOT = "U" + "f".repeat(32);
const SECRET = "test-channel-secret";
process.env.LINE_CHANNEL_SECRET = SECRET;
process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-access-token";
process.env.LINE_GROUP_ID = G;
process.env.LINE_BOT_USER_ID = BOT;
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.NOTION_API_KEY = "test-notion";
process.env.NOTION_DATABASE_ID = "test-db";
process.env.GROUP_SATEI = "1";
process.env.GROUP_SATEI_GROUP_IDS = G;
process.env.TASK_SATEI_USER_IDS = BOSS;
for (const k of [
  "KV_REST_API_URL", "KV_REST_API_TOKEN", "KV_URL", "JOB_ALLOWED_USER_IDS", "PORTAL_BASE_URL", "JOB_API_TOKEN",
  "TASK_MENU", "TASK_BUTTONS", "TASK_FOLLOWUP", "TASK_CANDIDATES", "TASK_CANDIDATE_USER_IDS", "TASK_CANDIDATE_INSTANT",
  "TASK_RECORD", "TASK_SATEI", "SECRETARY_ALLOWED_GROUP_IDS", "TASK_CANDIDATE_GROUP_IDS", "PHOTO_MENTION_ASK",
]) delete process.env[k];

// 出来事の順番を控える
const order: string[] = [];

// ── LINE（fetch） ──
const lineReplies: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("api.line.me")) {
    if (url.includes("/message/reply")) {
      lineReplies.push(String(init?.body ?? ""));
      order.push("reply");
    }
    if (url.includes("/message/push")) order.push("push");
    return new Response(JSON.stringify({ sentMessages: [{ id: "m1" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  order.push("other-fetch");
  return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
const block = (label: string) =>
  ((..._a: unknown[]) => {
    order.push(label);
    throw new Error(`テストでは外へつながない: ${label}`);
  }) as never;
(http as { request: unknown }).request = block("http.request");
(https as { request: unknown }).request = block("https.request");
(net as { connect: unknown }).connect = block("net.connect");
(net as { createConnection: unknown }).createConnection = block("net.createConnection");
(tls as { connect: unknown }).connect = block("tls.connect");

// ── Anthropic：入口 B の判定を遅く（400ms）して、査定書と答える ──
const AI_DELAY_MS = 400;
let aiCalls = 0;
(Anthropic.Messages.prototype as unknown as { create: unknown }).create = async () => {
  aiCalls++;
  order.push("ai-start");
  await new Promise((r) => setTimeout(r, AI_DELAY_MS));
  order.push("ai-done");
  const text = JSON.stringify({
    isTask: true, confidence: 0.9, title: "査定", category: "売買", urgency: "今週中", requestType: "査定書",
    urgentHint: false, dueDate: null, dueTime: null, assignee: null, memo: null,
  });
  return { content: [{ type: "text", text }] };
};

// ── Notion：呼ばれたら控える（このテストでは呼ばれないはず） ──
Client.prototype.request = (async () => {
  order.push("notion");
  return { object: "list", results: [], has_more: false, next_cursor: null };
}) as typeof Client.prototype.request;

// ── ログ：[group-satei] の行を出来事として控え、ほかは静かにする ──
const gsLogs: string[] = [];
const origLog = console.log;
console.log = (...a: unknown[]) => {
  const l = a.map(String).join(" ");
  if (l.startsWith("[group-satei]")) {
    gsLogs.push(l);
    order.push("gs-log");
  } else if (l.startsWith("✅") || l.startsWith("❌")) origLog(...a);
};
console.error = () => undefined;

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

(async () => {
  const route = (await import("../src/app/api/webhook/route")) as unknown as { POST: (req: never) => Promise<Response> };
  const ev = {
    type: "message",
    timestamp: Date.now(),
    replyToken: "rt-1",
    source: { type: "group", groupId: G, userId: STAFF },
    message: { id: "9100000000001", type: "text", text: "@秘書 査定お願いします" },
  };
  const t0 = Date.now();
  const res = await post(route, [ev]);
  order.push("post-returned");
  const took = Date.now() - t0;

  ok("200", res.status === 200, String(res.status));
  ok(
    "手打ちの案内を1回返す",
    lineReplies.length === 1 && lineReplies[0].includes(JSON.stringify(MSG_INTAKE_TYPED_MENTION).slice(1, -1)),
    JSON.stringify(lineReplies),
  );
  ok("入口 B の AI 判定を1回呼んだ", aiCalls === 1, `ai=${aiCalls}`);
  const iReply = order.indexOf("reply");
  const iAiDone = order.indexOf("ai-done");
  ok("返事は入口 B の AI 判定が終わる前に出る", iReply >= 0 && iAiDone >= 0 && iReply < iAiDone, order.join(","));
  ok("POST は入口 B の処理（AI 判定とその後の受付票＝KV 未設定で skip:kv）を待ち切ってから返す",
    order.indexOf("post-returned") > iAiDone && order.lastIndexOf("gs-log") < order.indexOf("post-returned") && gsLogs.includes("[group-satei] skip:kv"),
    order.join(",") + " " + JSON.stringify(gsLogs));
  ok("POST の時間は AI の遅れ以上（待った）", took >= AI_DELAY_MS, `took=${took}`);
  ok("グループへ push しない・Notion・外への通信なし", !order.some((o) => ["push", "notion", "other-fetch", "http.request", "https.request", "net.connect", "net.createConnection", "tls.connect"].includes(o)), order.join(","));
  ok("ログに ID・本文を出さない", gsLogs.every((l) => ![G, STAFF, BOSS, "9100000000001", "査定お願い"].some((s) => l.includes(s))), JSON.stringify(gsLogs));

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
