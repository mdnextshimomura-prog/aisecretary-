/**
 * @秘書 の受付の理由のログと返事を、route.ts の POST を本物のまま呼んで確かめる（2026-11-13）。
 * 外への通信は全部横取りする：LINE（fetch）・Anthropic（Messages.prototype.create）・Notion（Client.prototype.request）。
 * KV は未設定（メモリ経路）。実際の外部 API には一切つながない。値はどれもテスト用。
 */
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@notionhq/client";
import { MSG_INTAKE_NOT_REGISTERED, MSG_INTAKE_TYPED_MENTION } from "../src/lib/task-intake";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name}`);
};

const G = "C" + "a".repeat(32);
const SENDER = "U" + "b".repeat(32);
const BOT = "U" + "f".repeat(32);
const SECRET = "test-channel-secret";
process.env.LINE_CHANNEL_SECRET = SECRET;
process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-access-token";
process.env.LINE_GROUP_ID = G;
process.env.LINE_BOT_USER_ID = BOT;
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.NOTION_API_KEY = "test-notion";
process.env.NOTION_DATABASE_ID = "test-db";
// 候補：スイッチ on・試行の対象者あり（会社グループ）。カード類は off（返事は今までどおり無し）
process.env.TASK_CANDIDATES = "1";
process.env.TASK_CANDIDATE_USER_IDS = SENDER;
for (const k of [
  "KV_REST_API_URL", "KV_REST_API_TOKEN", "KV_URL", "JOB_ALLOWED_USER_IDS", "PORTAL_BASE_URL", "JOB_API_TOKEN",
  "TASK_MENU", "TASK_BUTTONS", "TASK_FOLLOWUP", "TASK_CANDIDATE_INSTANT", "TASK_RECORD", "TASK_SATEI",
  "SECRETARY_ALLOWED_GROUP_IDS", "TASK_CANDIDATE_GROUP_IDS", "TASK_CONFIDENCE_THRESHOLD",
]) delete process.env[k];

// ── LINE（fetch）：返信の本文を控える ──
const lineReplies: string[] = [];
const otherFetch: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("api.line.me")) {
    if (url.includes("/message/reply")) lineReplies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ sentMessages: [{ id: "m1" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  otherFetch.push(url);
  return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
const socketCalls: string[] = [];
const block = (label: string) =>
  ((..._a: unknown[]) => {
    socketCalls.push(label);
    throw new Error(`テストでは外へつながない: ${label}`);
  }) as never;
(http as { request: unknown }).request = block("http.request");
(https as { request: unknown }).request = block("https.request");
(net as { connect: unknown }).connect = block("net.connect");
(net as { createConnection: unknown }).createConnection = block("net.createConnection");
(tls as { connect: unknown }).connect = block("tls.connect");

// ── Anthropic：意図判定は task、タスク解析は場面ごとの答え、それ以外（初動確認など）は空の JSON ──
let parseAnswer: Record<string, unknown> = {};
let parseCalls = 0;
(Anthropic.Messages.prototype as unknown as { create: unknown }).create = async (body: {
  max_tokens?: number;
  messages?: { content: unknown }[];
}) => {
  const content = JSON.stringify(body.messages ?? []);
  let text = "{}";
  if (body.max_tokens === 128) text = JSON.stringify({ intent: "task", confidence: 0.9, ambiguous: false });
  else if (content.includes("今日の日時")) {
    parseCalls++;
    text = JSON.stringify(parseAnswer);
  }
  return { content: [{ type: "text", text }] };
};

// ── Notion：作成は page id を返し、照会は 0 件 ──
let notionCreates = 0;
Client.prototype.request = (async (args: { path: string; method: string }) => {
  if (args.method === "post" && args.path === "pages") {
    notionCreates++;
    return { id: "page-test-1", properties: {} };
  }
  return { id: "page-test-1", object: "list", results: [], has_more: false, next_cursor: null, properties: {} };
}) as typeof Client.prototype.request;

// ── ログ：[task-intake] の行だけ控える ──
const intakeLogs: string[] = [];
const origLog = console.log;
console.log = (...a: unknown[]) => {
  const l = a.map(String).join(" ");
  if (l.startsWith("[task-intake]")) intakeLogs.push(l);
  else if (!l.startsWith("✅")) return; // 本体のログは静かにする
  origLog(...a);
};
const origErr = console.error;
const errors: string[] = [];
console.error = (...a: unknown[]) => {
  errors.push(a.map(String).join(" "));
};

function task(isTask: boolean, confidence: number) {
  return {
    isTask, confidence, title: "見積の作成", category: "売買", urgency: "今週中", requestType: "その他",
    urgentHint: false, dueDate: null, dueTime: null, assignee: null, memo: null,
  };
}

let seq = 0;
function textEvent(text: string, mention?: { index: number; length: number; userId: string }[], id?: string) {
  seq++;
  return {
    type: "message",
    timestamp: Date.now(),
    replyToken: `rt-${seq}`,
    source: { type: "group", groupId: G, userId: SENDER },
    message: {
      id: id ?? `${9000000000 + seq}`,
      type: "text",
      text,
      ...(mention ? { mention: { mentionees: mention.map((m) => ({ type: "user", ...m })) } } : {}),
    },
  };
}
const botMention = (text: string) => textEvent(text, [{ index: 0, length: 5, userId: BOT }]);

async function post(route: { POST: (req: never) => Promise<Response> }, events: unknown[]) {
  const body = JSON.stringify({ events });
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64");
  const { NextRequest } = await import("next/server");
  return route.POST(
    new NextRequest("https://example.test/api/webhook", {
      method: "POST",
      headers: { "x-line-signature": sig, "content-type": "application/json" },
      body,
    }) as never
  );
}
const reset = () => {
  lineReplies.length = 0;
  intakeLogs.length = 0;
  parseCalls = 0;
  notionCreates = 0;
};
const repliesWith = (msg: string) => lineReplies.filter((b) => b.includes(JSON.stringify(msg).slice(1, -1))).length;

(async () => {
  const route = (await import("../src/app/api/webhook/route")) as unknown as { POST: (req: never) => Promise<Response> };
  const store = await import("../src/lib/task-candidate-store");

  // 1) メンションの無いふつうの会話 → 返事なし・mention-none
  reset();
  {
    const res = await post(route, [textEvent("今日は暑いですね")]);
    ok("ふつうの会話：200", res.status === 200);
    ok("ふつうの会話：LINE へ返事をしない", lineReplies.length === 0, JSON.stringify(lineReplies));
    ok("ふつうの会話：mention-none のログ1行", JSON.stringify(intakeLogs) === JSON.stringify(["[task-intake] mention-none"]), JSON.stringify(intakeLogs));
  }

  // 2) @AI秘書 を認識できた・タスクでない → 受け付けなかった返事を1回
  reset();
  parseAnswer = task(false, 0.9);
  {
    const res = await post(route, [botMention("@AI秘書 今日は暑いですね")]);
    ok("タスクでない：200", res.status === 200);
    ok("タスクでない：AI の解析を通った", parseCalls === 1, `parse=${parseCalls}`);
    ok("タスクでない：受け付けなかった返事を1回", lineReplies.length === 1 && repliesWith(MSG_INTAKE_NOT_REGISTERED) === 1, JSON.stringify(lineReplies));
    ok("タスクでない：not-task のログ1行", JSON.stringify(intakeLogs) === JSON.stringify(["[task-intake] not-task"]), JSON.stringify(intakeLogs));
    ok("タスクでない：Notion に作らない", notionCreates === 0);
  }

  // 3) 確信度 0.3 → low-conf・返事1回
  reset();
  parseAnswer = task(true, 0.3);
  {
    await post(route, [botMention("@AI秘書 あれどうなった")]);
    ok("確信度 0.3：low-conf・受け付けなかった返事を1回", JSON.stringify(intakeLogs) === JSON.stringify(["[task-intake] low-conf"]) && repliesWith(MSG_INTAKE_NOT_REGISTERED) === 1 && lineReplies.length === 1, JSON.stringify(intakeLogs));
  }

  // 4) 手打ちの「@秘書」（メンションの印なし） → 一覧から選ぶ案内を1回・AI は呼ばない
  reset();
  {
    await post(route, [textEvent("@秘書 明日までに見積を作ってください")]);
    ok("手打ち：案内を1回返す", lineReplies.length === 1 && repliesWith(MSG_INTAKE_TYPED_MENTION) === 1, JSON.stringify(lineReplies));
    ok("手打ち：typed-mention のログ1行", JSON.stringify(intakeLogs) === JSON.stringify(["[task-intake] typed-mention"]), JSON.stringify(intakeLogs));
  }
  // 4b) 説明文の引用の中の「@秘書」 → 返事なし
  reset();
  {
    await post(route, [textEvent("依頼は「@秘書」と入力してから書いてください")]);
    ok("引用の中の @秘書：返事をしない・mention-none", lineReplies.length === 0 && JSON.stringify(intakeLogs) === JSON.stringify(["[task-intake] mention-none"]), JSON.stringify(intakeLogs));
  }

  // 5) 確信度 0.6 で候補に新しく控える → candidate-saved・返事なし（カード off のあいだは今までどおり）
  reset();
  store._resetMemoryForTest();
  parseAnswer = task(true, 0.6);
  {
    await post(route, [botMention("@AI秘書 来週あたり売主さんに連絡")]);
    ok("候補に控えた：candidate-saved・返事なし", JSON.stringify(intakeLogs) === JSON.stringify(["[task-intake] candidate-saved"]) && lineReplies.length === 0, JSON.stringify(intakeLogs) + JSON.stringify(lineReplies));
  }

  // 6) 再処理で、同じ発言の候補がもう控えてある → candidate-exists・返事なし
  reset();
  store._resetMemoryForTest();
  {
    const id = "8800000000001";
    await store.addCandidate({ id, text: "来週あたり売主さんに連絡", title: "t", assignee: null, assigneeUserId: null, senderId: SENDER, createdAt: Date.now() });
    const ev = botMention("@AI秘書 来週あたり売主さんに連絡");
    ev.message.id = id;
    await post(route, [ev]);
    ok("既に候補あり：candidate-exists のログ1行", JSON.stringify(intakeLogs) === JSON.stringify(["[task-intake] candidate-exists"]), JSON.stringify(intakeLogs));
    ok("既に候補あり：受け付けなかった返事をしない", lineReplies.length === 0, JSON.stringify(lineReplies));
  }

  // 7) 候補の対象外（試行の対象者なし） → candidate-skip・返事1回
  reset();
  store._resetMemoryForTest();
  process.env.TASK_CANDIDATE_USER_IDS = "";
  {
    await post(route, [botMention("@AI秘書 来週あたり売主さんに連絡")]);
    ok("候補の対象外：candidate-skip・受け付けなかった返事を1回", JSON.stringify(intakeLogs) === JSON.stringify(["[task-intake] candidate-skip"]) && repliesWith(MSG_INTAKE_NOT_REGISTERED) === 1 && lineReplies.length === 1, JSON.stringify(intakeLogs));
  }
  process.env.TASK_CANDIDATE_USER_IDS = SENDER;

  // 8) 登録できた → registered・受け付けなかった返事は出さない
  reset();
  parseAnswer = task(true, 0.95);
  {
    const res = await post(route, [botMention("@AI秘書 明日までに見積を作ってください")]);
    ok("登録：200", res.status === 200);
    ok("登録：Notion に作った", notionCreates === 1, `creates=${notionCreates}`);
    ok("登録：registered のログ1行", JSON.stringify(intakeLogs) === JSON.stringify(["[task-intake] registered"]), JSON.stringify(intakeLogs));
    ok("登録：受け付けなかった返事は出さない", repliesWith(MSG_INTAKE_NOT_REGISTERED) === 0 && lineReplies.length === 1, JSON.stringify(lineReplies).slice(0, 300));
  }

  ok("外へのソケットは1回も開かない", socketCalls.length === 0, JSON.stringify(socketCalls));
  ok("ログに本文・userId・groupId を出さない", intakeLogs.every((l) => !l.includes(SENDER) && !l.includes(G)));

  console.error = origErr;
  if (fail) console.error(errors.slice(0, 20).join("\n"));
  console.log = origLog;
  console.log(fail === 0 ? "\nすべて成功" : `\n${fail} 件失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error = origErr;
  console.error(e);
  process.exit(1);
});
