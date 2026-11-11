/**
 * B2 査定書：postback の入口（handleTaskPostbackEvent）の振り分け。satei の data だけを satei に回し、
 * ほかのボタンの扱いは今と同じであることを確かめる。外部へ通信したら失敗。
 */
import { Client } from "@notionhq/client";
import { handleTaskPostbackEvent, type PostbackEventLike } from "../src/lib/task-buttons-wire";
import { MSG_PAUSED, type ButtonDeps } from "../src/lib/task-buttons";
import type { SateiActionDeps } from "../src/lib/satei-actions";
import type { SateiDeal } from "../src/lib/satei-deal";
import { MSG_SATEI_PAUSED, msgSateiAccepted } from "../src/lib/satei-text";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};
let outside = 0;
globalThis.fetch = (async () => {
  outside++;
  throw new Error("このテストで外部へ通信してはいけない");
}) as typeof fetch;
Client.prototype.request = (async () => {
  outside++;
  throw new Error("このテストで Notion へ通信してはいけない");
}) as typeof Client.prototype.request;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const SHIMO = "U" + "b".repeat(32);
const DB = "11112222333344445555666677778888";
const DEAL = "0123abcd0123456789ab0123456789ab";
const PAGE = "0123abcd-0123-4567-89ab-0123456789ab";
const GOOD: SateiDeal = { id: DEAL, name: "テスト案件", dealNo: 42, folderId: "1AbC_dEf-GhIjKlMnOp", propertyIds: ["p"], gone: false, parentDbId: DB };

const replies: string[] = [];
const intakes: number[] = [];
const ev = (data: string): PostbackEventLike => ({
  type: "postback",
  replyToken: "rt",
  webhookEventId: `ev-${Math.random()}`,
  source: { userId: SHIMO, groupId: "C" + "a".repeat(32) },
  postback: { data },
});
const satei: Partial<SateiActionDeps> = {
  dealsDbId: DB,
  readDeal: async () => ({ deal: GOOD, kind: "マンション" }),
  intake: async () => {
    intakes.push(1);
    return { kind: "ok", value: { created: true, no: 5, status: "受付" } };
  },
  decide: async () => ({ kind: "ok", value: { status: "完成" } }),
  kv: null,
};
const over = {
  deps: {} as ButtonDeps,
  reply: async (_t: string, text: string) => {
    replies.push(text);
    return { textId: "m1", cardId: null };
  },
  reserve: async () => ({ proceed: true }),
  complete: async () => undefined,
  cardRefs: null,
  log: () => undefined,
  satei,
};
const reset = () => {
  replies.length = 0;
  intakes.length = 0;
};

(async () => {
  // タスクのボタン・メニューは off のまま
  delete process.env.TASK_BUTTONS;
  delete process.env.TASK_FOLLOWUP;
  delete process.env.TASK_MENU;
  process.env.TASK_SATEI_USER_IDS = SHIMO;

  delete process.env.TASK_SATEI;
  reset();
  await handleTaskPostbackEvent(ev(`v1|sa|${PAGE}`), over);
  ok("TASK_SATEI off：古い［査定書を作る］は「いまは止めています」", replies[0] === MSG_SATEI_PAUSED && intakes.length === 0);
  reset();
  await handleTaskPostbackEvent(ev("v1|lt|0"), over);
  ok("TASK_SATEI off：メニューのボタンは今と同じ（止めています）", replies[0] === MSG_PAUSED);

  process.env.TASK_SATEI = "1";
  reset();
  await handleTaskPostbackEvent(ev(`v1|sa|${PAGE}`), over);
  ok("TASK_SATEI=1：TASK_BUTTONS が off でも satei は動く", replies[0] === msgSateiAccepted(5) && intakes.length === 1);
  reset();
  await handleTaskPostbackEvent(ev(`v1|done|${PAGE}`), over);
  ok("TASK_SATEI=1：タスクのボタンは今と同じ（止めています）", replies[0] === MSG_PAUSED && intakes.length === 0);
  reset();
  await handleTaskPostbackEvent(ev("v1|lt|0"), over);
  ok("TASK_SATEI=1：メニューのボタンは今と同じ（止めています）", replies[0] === MSG_PAUSED);
  reset();
  await handleTaskPostbackEvent(ev("x|sa|y"), over);
  ok("v1| で始まらない data は何もしない", replies.length === 0);

  ok("外部への通信は0回", outside === 0, String(outside));
  delete process.env.TASK_SATEI;
  delete process.env.TASK_SATEI_USER_IDS;

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
