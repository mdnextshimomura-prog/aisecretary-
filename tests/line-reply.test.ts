/**
 * reply の結果を「送れた・はっきり失敗・不明」に分ける（設計 14）。LINE は偽物の fetch に差し替える。
 */
import {
  replyLineMessageDetailed,
  deliverReply,
  pushLineMessage,
  sendLineMessage,
  type ReplyOutcome,
} from "../src/lib/line";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
let respond: () => Promise<Response> = async () => new Response("{}", { status: 200 });
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
  return respond();
}) as typeof fetch;

const json = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function main() {
  // ── reply の3つの結果 ──
  respond = json(200, { sentMessages: [{ id: "m1" }] });
  let r = await replyLineMessageDetailed("rt", "こんにちは");
  ok("200 は送れた（送ったメッセージの ID つき）", r.kind === "sent" && r.messageId === "m1", JSON.stringify(r));
  ok("reply の宛先と本文", calls[0].url.endsWith("/v2/bot/message/reply") && calls[0].body?.replyToken === "rt");

  respond = json(400, { message: "Invalid reply token" });
  r = await replyLineMessageDetailed("rt", "x");
  ok("400 ははっきり失敗", r.kind === "rejected" && r.status === 400, JSON.stringify(r));

  respond = json(500, {});
  r = await replyLineMessageDetailed("rt", "x");
  ok("500 は不明", r.kind === "unknown");

  respond = async () => {
    throw new TypeError("fetch failed");
  };
  r = await replyLineMessageDetailed("rt", "x");
  ok("通信の失敗は不明（例外を投げない）", r.kind === "unknown");

  respond = async () => {
    throw new DOMException("timed out", "TimeoutError");
  };
  r = await replyLineMessageDetailed("rt", "x");
  ok("時間切れは不明", r.kind === "unknown");

  // ── reply → push の送り直し ──
  const pushes: string[] = [];
  const io = (outcome: ReplyOutcome, pushOk = true) => ({
    reply: async () => outcome,
    push: async (t: string) => {
      pushes.push(t);
      return pushOk;
    },
  });
  ok("送れたら push しない", (await deliverReply("a", io({ kind: "sent", messageId: null }))) === "replied" && pushes.length === 0);
  ok("はっきり失敗なら push で送り直す", (await deliverReply("b", io({ kind: "rejected", status: 400 }))) === "pushed" && pushes.join() === "b");
  ok("push も失敗したら push-failed", (await deliverReply("c", io({ kind: "rejected", status: 400 }, false))) === "push-failed");
  pushes.length = 0;
  ok("不明なら送り直さない", (await deliverReply("d", io({ kind: "unknown" }))) === "unknown" && pushes.length === 0);

  // ── 本物の reply/push の組み合わせ（帯替えの受付で webhook がつなぐ形） ──
  calls.length = 0;
  let n = 0;
  respond = async () => (n++ === 0 ? json(400, {})() : json(200, {})());
  const d = await deliverReply("受付しました", {
    reply: (t) => replyLineMessageDetailed("rt", t),
    push: (t) => pushLineMessage("Cgroup", t).catch(() => false),
  });
  ok("reply 400 → push で同じ本文をグループへ", d === "pushed" && calls[1].url.endsWith("/v2/bot/message/push") && calls[1].body?.to === "Cgroup", JSON.stringify(calls.map((c) => c.url)));

  // ── 既存の sendLineMessage は今の動きのまま ──
  respond = json(400, {});
  ok("sendLineMessage は 400 で null を返す（今どおり）", (await sendLineMessage("rt", "x")) === null);

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
