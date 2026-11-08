/**
 * postback イベントの入口（handleTaskPostbackEvent）。LINE は偽物の fetch、Notion・名簿は差し替え。
 */
import { handleTaskPostbackEvent } from "../src/lib/task-buttons-wire";
import type { ButtonDeps } from "../src/lib/task-buttons";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};

const calls: Array<Record<string, unknown>> = [];
globalThis.fetch = (async (
  _url: string | URL | Request,
  init?: RequestInit,
) => {
  calls.push(JSON.parse(String(init?.body)));
  return new Response(JSON.stringify({ sentMessages: [{ id: "m1" }] }), {
    status: 200,
  });
}) as typeof fetch;

const PAGE = "1234abcd-1234-1234-1234-1234567890ab";
const U2 = `U${"2".padStart(32, "0")}`;
const writes: string[] = [];
const deps: ButtonDeps = {
  getTask: async () => ({
    id: PAGE,
    title: "重説",
    closed: false,
    assigneeId: U2,
    requesterId: null,
  }),
  members: async () => [],
  complete: async () => {
    writes.push("complete");
  },
  status: {
    update: async () => {
      writes.push("update");
    },
    defaultCheckDate: async () => "2026-11-12",
  },
  setAssignee: async () => {
    writes.push("assign");
  },
  today: () => "2026-11-09",
};
const ev = (data: string, id?: string) => ({
  type: "postback",
  replyToken: "rt",
  webhookEventId: id,
  source: { userId: U2 },
  postback: { data },
});

async function main() {
  delete process.env.TASK_BUTTONS;
  await handleTaskPostbackEvent(ev(`v1|done|${PAGE}`), deps);
  ok(
    "off なら何もしない（書かない・返さない）",
    calls.length === 0 && writes.length === 0,
  );

  process.env.TASK_BUTTONS = "1";
  await handleTaskPostbackEvent(ev("action=other"), deps);
  ok("v1| でない postback は扱わない", calls.length === 0);

  await handleTaskPostbackEvent(ev(`v1|wait|${PAGE}`, "E1"), deps);
  const msg = (calls[0]?.messages as Array<Record<string, unknown>>)?.[0];
  ok(
    "待ち：書いて、replyToken で返す",
    writes.join() === "update" && calls[0]?.replyToken === "rt",
  );
  ok("待ち：ボタンを付け直す", Boolean(msg?.quickReply));

  await handleTaskPostbackEvent(ev(`v1|wait|${PAGE}`, "E1"), deps);
  ok(
    "同じイベントの再送は二重に書かない",
    writes.length === 1 && calls.length === 1,
  );

  await handleTaskPostbackEvent(ev("v1|done|bad"), deps);
  const bad = (calls[1]?.messages as Array<Record<string, unknown>>)?.[0];
  ok(
    "形式不正は書かずに知らせる",
    writes.length === 1 && bad?.text === "⚠️ このボタンは使えません",
  );

  await handleTaskPostbackEvent(ev(`v1|done|${PAGE}`), {
    ...deps,
    complete: async () => {
      throw new Error("notion down");
    },
  });
  const err = (calls[2]?.messages as Array<Record<string, unknown>>)?.[0];
  ok(
    "書けなかったら知らせる（例外を投げない）",
    String(err?.text).startsWith("⚠️ 書き込めませんでした"),
  );

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
