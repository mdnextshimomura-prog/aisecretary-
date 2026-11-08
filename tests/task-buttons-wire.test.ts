/**
 * postback イベントの入口（handleTaskPostbackEvent）と、初動確認セッションのつなぎ（sessionDeps）。
 * LINE の返事・KV の予約は差し替え、Notion・名簿も差し替える。セッションは KV 未設定のメモリで動かす。
 */
import {
  handleTaskPostbackEvent,
  sessionDeps,
  MSG_BUSY,
  type PostbackIo,
} from "../src/lib/task-buttons-wire";
import { MSG_PAUSED, type ButtonDeps } from "../src/lib/task-buttons";
import {
  getPendingTaskConfirm,
  savePendingTaskConfirm,
} from "../src/lib/email/session";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};

const PAGE = "1234abcd-1234-1234-1234-1234567890ab";
const U2 = `U${"2".padStart(32, "0")}`;
const U4 = `U${"4".padStart(32, "0")}`;

let writes: string[] = [];
let replies: Array<{ text: string; quickReply?: unknown }> = [];
let logs: string[] = [];
let completed: string[] = [];

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
  session: {
    clear: async () => {
      writes.push("session-clear");
    },
    syncAssignee: async () => {
      writes.push("session-assign");
    },
  },
};

const claims = new Set<string>();
function io(over: Partial<PostbackIo> = {}): Partial<PostbackIo> {
  return {
    deps,
    reserve: async (key) => {
      if (claims.has(key)) return { proceed: false };
      claims.add(key);
      return { proceed: true };
    },
    complete: async (key) => {
      completed.push(key);
    },
    reply: async (_rt, text, quickReply) => {
      replies.push({ text, quickReply });
      return "m1";
    },
    log: (line) => logs.push(line),
    ...over,
  };
}
const ev = (data: string, id?: string) => ({
  type: "postback",
  replyToken: "rt",
  webhookEventId: id,
  source: { userId: U2, groupId: "G1" },
  postback: { data },
});
const reset = () => {
  writes = [];
  replies = [];
  logs = [];
  completed = [];
};

async function main() {
  // ── スイッチ ──
  delete process.env.TASK_BUTTONS;
  process.env.TASK_FOLLOWUP = "1";
  await handleTaskPostbackEvent(ev("action=other"), io());
  ok("v1| でない postback は扱わない", replies.length === 0);
  await handleTaskPostbackEvent(ev(`v1|done|${PAGE}`, "E0"), io());
  ok(
    "TASK_BUTTONS が off なら書かずに止めている旨を返す",
    writes.length === 0 && replies[0]?.text === MSG_PAUSED,
    JSON.stringify(replies),
  );
  ok(
    "文面",
    MSG_PAUSED === "いまボタン操作は止めています。文字で操作してください",
  );
  reset();
  process.env.TASK_BUTTONS = "1";
  delete process.env.TASK_FOLLOWUP;
  await handleTaskPostbackEvent(ev(`v1|wait|${PAGE}`, "E00"), io());
  ok(
    "TASK_FOLLOWUP が off でも書かずに止めている旨を返す",
    writes.length === 0 && replies[0]?.text === MSG_PAUSED,
  );
  process.env.TASK_FOLLOWUP = "1";

  // ── ふつうに押す ──
  reset();
  await handleTaskPostbackEvent(ev(`v1|wait|${PAGE}`, "E1"), io());
  ok("待ち：書いて返す", writes.join() === "update" && replies.length === 1);
  ok("待ち：ボタンを付け直す", Boolean(replies[0]?.quickReply));
  ok("完了印を付ける", completed.join() === "pb:E1");

  reset();
  await handleTaskPostbackEvent(ev(`v1|wait|${PAGE}`, "E1"), io());
  ok(
    "同じイベントの再送は二重に書かない",
    writes.length === 0 && replies.length === 0,
  );

  reset();
  await handleTaskPostbackEvent(ev("v1|done|bad", "E2"), io());
  ok(
    "形式不正は書かずに知らせる",
    writes.length === 0 && replies[0]?.text === "⚠️ このボタンは使えません",
  );

  reset();
  await handleTaskPostbackEvent(
    ev(`v1|done|${PAGE}`, "E3"),
    io({
      deps: {
        ...deps,
        complete: async () => {
          throw new Error("notion down");
        },
      },
    }),
  );
  ok(
    "書けなかったら知らせる（例外を投げない）",
    String(replies[0]?.text).startsWith("⚠️ 書き込めませんでした"),
  );

  // ── 返事の失敗（5） ──
  reset();
  await handleTaskPostbackEvent(
    ev(`v1|wait|${PAGE}`, "E4"),
    io({
      reply: async () => null,
    }),
  );
  ok(
    "返事が送れなければ reply-failed をログに出す",
    logs.some((l) => l.startsWith("[task-buttons] reply-failed wait")),
    logs.join(" / "),
  );
  ok(
    "ログに本文・ID を出さない",
    !logs.some((l) => l.includes(U2) || l.includes(PAGE) || l.includes("重説")),
  );
  ok(
    "Notion は書けているので完了印は付ける",
    writes.join() === "update" && completed.join() === "pb:E4",
  );
  reset();
  await handleTaskPostbackEvent(
    ev(`v1|wait|${PAGE}`, "E5"),
    io({
      reply: async () => {
        throw new Error("network");
      },
    }),
  );
  ok(
    "返事が例外でも reply-failed を出し、投げない",
    logs.some((l) => l.startsWith("[task-buttons] reply-failed wait")),
    logs.join(" / "),
  );
  ok("例外でも完了印は付ける", completed.join() === "pb:E5");

  // ── KV の障害（6） ──
  reset();
  await handleTaskPostbackEvent(
    ev(`v1|done|${PAGE}`, "E6"),
    io({
      reserve: async () => {
        throw new Error("kv down");
      },
    }),
  );
  ok("予約が例外なら書かない", writes.length === 0);
  ok(
    "予約が例外なら待ってと返す",
    replies[0]?.text === MSG_BUSY,
    replies[0]?.text,
  );
  ok(
    "文面",
    MSG_BUSY ===
      "いま操作を受け付けられません。少し待ってからもう一度押してください",
  );
  reset();
  await handleTaskPostbackEvent(
    ev(`v1|wait|${PAGE}`, "E7"),
    io({
      complete: async () => {
        throw new Error("kv down");
      },
    }),
  );
  ok(
    "完了印の失敗は mark-failed を種別だけ出す",
    logs.includes("[task-buttons] mark-failed"),
    logs.join(" / "),
  );
  ok("完了印が失敗しても返事は出る", replies.length === 1);

  // ── 初動確認のセッション（1） ──
  const base = {
    pageId: PAGE,
    title: "重説",
    requestType: "その他",
    createdByUserId: U2,
    fields: [],
    awaitingKeys: ["x"],
    proposalKeys: [],
    settled: {},
    assignee: "田中 一郎",
    assigneeUserId: U2,
    createdAt: Date.now(),
  };
  await savePendingTaskConfirm("G1", { ...base });
  const s = sessionDeps("G1");
  await s.syncAssignee(PAGE, "鈴木 次郎", U4);
  const after = await getPendingTaskConfirm("G1", null, PAGE);
  ok(
    "担当変更：残っている確認セッションの担当を合わせる",
    after?.assignee === "鈴木 次郎" && after?.assigneeUserId === U4,
    JSON.stringify(after),
  );
  await s.clear(PAGE);
  ok(
    "済・不要：確認セッションを消す",
    (await getPendingTaskConfirm("G1", null, PAGE)) === null,
  );
  await s.clear(PAGE);
  await s.syncAssignee(PAGE, "鈴木 次郎", U4);
  ok(
    "セッションが無ければ何もしない（作らない）",
    (await getPendingTaskConfirm("G1", null, PAGE)) === null,
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
