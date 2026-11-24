/**
 * group-satei-wire.ts の入口と postback の振り分け：
 * - off・対象外のグループでは、控え・入口 A・入口 B のどれも KV にも AI にも Notion にも触れない（通信 0 回）
 * - on でも KV が落ちていれば例外を投げずに戻り、ログは [group-satei] の符号だけ（ID・本文を出さない）
 * - gs/gl/gm/gn の data は他の機能と取り合わず、postback の入口から group-satei-actions に回る
 */
import assert from "node:assert/strict";
import { Client } from "@notionhq/client";
import { gsEntryAOk } from "../src/lib/group-satei-gate";
import { maybeOpenGroupSateiA, maybeOpenGroupSateiB, recordGroupSateiMediaEvent } from "../src/lib/group-satei-wire";
import { parseGsData } from "../src/lib/group-satei-data";
import { MSG_GS_FORBIDDEN, MSG_GS_PAUSED } from "../src/lib/group-satei-card";
import { parseSateiAskData } from "../src/lib/satei-ask";
import { parseSateiData } from "../src/lib/satei-data";
import { parseButtonData, parseMenuData } from "../src/lib/task-buttons";
import { handleTaskPostbackEvent, type PostbackEventLike } from "../src/lib/task-buttons-wire";
import type { ButtonDeps } from "../src/lib/task-buttons";

let n = 0;
const t = async (name: string, f: () => Promise<void> | void) => {
  await f();
  n++;
  console.log("ok", name);
};
let calls = 0;
globalThis.fetch = (async () => {
  calls++;
  throw new Error("外へ出てはいけない");
}) as typeof fetch;
Client.prototype.request = (async () => {
  calls++;
  throw new Error("Notion へ出てはいけない");
}) as typeof Client.prototype.request;
delete process.env.GROUP_SATEI;
delete process.env.GROUP_SATEI_GROUP_IDS;
process.env.KV_REST_API_URL = "https://example.invalid";
process.env.KV_REST_API_TOKEN = "x";
const G = "C" + "a".repeat(32);
const OTHER_G = "C" + "e".repeat(32);
const BOSS = "U" + "c".repeat(32);
const STAFF = "U" + "d".repeat(32);
const TODAY = "2026-11-24 10:00";

const logs: string[] = [];
const orig = { log: console.log, error: console.error, warn: console.warn };
const capture = () => {
  logs.length = 0;
  const push = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.log = push;
  console.error = push;
  console.warn = push;
};
const release = () => Object.assign(console, orig);

async function allThree(groupId: string) {
  await recordGroupSateiMediaEvent({ messageId: "i1", groupId, senderId: STAFF, type: "image", at: 1 });
  await recordGroupSateiMediaEvent({ messageId: "f1", groupId, senderId: STAFF, type: "file", fileName: "登記.pdf", at: 1 });
  await maybeOpenGroupSateiA(
    { messageId: "m1", groupId, senderId: STAFF, at: 1, text: "査定", isTask: true, requestType: "査定書", confidence: 0.9 },
    TODAY,
  );
  await maybeOpenGroupSateiB({ messageId: "m2", groupId, senderId: STAFF, at: 1, text: "査定お願いします" }, TODAY);
}

(async () => {
  process.env.TASK_SATEI_USER_IDS = BOSS;

  await t("off：控え・入口 A・B は通信しない（KV・AI・Notion 0 回）・ログも出さない", async () => {
    calls = 0;
    capture();
    await allThree(G);
    release();
    assert.equal(calls, 0);
    assert.deepEqual(logs, []);
  });

  await t("GROUP_SATEI=1 でも対象のグループの一覧が空なら通信しない", async () => {
    process.env.GROUP_SATEI = "1";
    calls = 0;
    capture();
    await allThree(G);
    release();
    assert.equal(calls, 0);
    assert.deepEqual(logs, []);
  });

  await t("on でも対象外のグループは通信しない", async () => {
    process.env.GROUP_SATEI_GROUP_IDS = G;
    calls = 0;
    capture();
    await allThree(OTHER_G);
    release();
    assert.equal(calls, 0);
    assert.deepEqual(logs, []);
  });

  await t("on・対象：査定の言葉の無い発言（入口 B）・査定でない判定（入口 A）は通信しない", async () => {
    calls = 0;
    capture();
    await maybeOpenGroupSateiB({ messageId: "m3", groupId: G, senderId: STAFF, at: 1, text: "明日の内見よろしく" }, TODAY);
    await maybeOpenGroupSateiA(
      { messageId: "m4", groupId: G, senderId: STAFF, at: 1, text: "書類", isTask: true, requestType: "書類作成", confidence: 0.9 },
      TODAY,
    );
    // 下村さん本人の発言は拾わない（ログも出さない＝言葉の無い発言と同じ）
    await maybeOpenGroupSateiB({ messageId: "m5", groupId: G, senderId: BOSS, at: 1, text: "了解です" }, TODAY);
    release();
    assert.equal(calls, 0);
    assert.deepEqual(logs, []);
  });

  await t("on・対象で KV が落ちていても例外を投げない・ログは符号だけ", async () => {
    calls = 0;
    capture();
    await recordGroupSateiMediaEvent({ messageId: "i9", groupId: G, senderId: STAFF, type: "image", at: 1 });
    await maybeOpenGroupSateiA(
      { messageId: "m9", groupId: G, senderId: STAFF, at: 1, text: "物件Aの査定", isTask: true, requestType: "査定書", confidence: 0.9 },
      TODAY,
    );
    release();
    assert.ok(calls > 0, "KV へ行こうとはした");
    assert.ok(logs.length > 0);
    for (const l of logs) {
      assert.ok(l.startsWith("[group-satei] "), l);
      for (const secret of [G, STAFF, BOSS, "i9", "m9", "物件A"]) assert.ok(!l.includes(secret), l);
    }
  });

  await t("data は他の機能と取り合わない", () => {
    for (const d of [
      "v1|gs|0123456789abcdef|1|0123abcd0123456789ab0123456789ab",
      "v1|gl|0123456789abcdef|1|10",
      "v1|gm|0123456789abcdef|1",
      "v1|gn|0123456789abcdef|1",
    ]) {
      assert.ok(parseGsData(d), d);
      assert.equal(parseSateiData(d), null);
      assert.equal(parseSateiAskData(d), null);
      assert.equal(parseButtonData(d), null);
      assert.equal(parseMenuData(d), null);
    }
  });

  await t("入口 A は off なら false", () =>
    assert.equal(gsEntryAOk({ groupId: G, senderId: STAFF, isTask: true, requestType: "査定書", confidence: 1 }, {}), false),
  );

  // postback の振り分け：gs の data は group-satei-actions に回る（タスクのボタンの「止めています」より前）
  const replies: string[] = [];
  const ev = (data: string, userId = BOSS): PostbackEventLike => ({
    type: "postback",
    replyToken: "rt",
    webhookEventId: "ev1",
    source: { userId, groupId: undefined },
    postback: { data },
  });
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
  };
  delete process.env.TASK_BUTTONS;
  delete process.env.TASK_FOLLOWUP;

  await t("postback：GROUP_SATEI off なら「いまは止めています」・通信しない", async () => {
    delete process.env.GROUP_SATEI;
    replies.length = 0;
    calls = 0;
    await handleTaskPostbackEvent(ev("v1|gn|0123456789abcdef|1"), over);
    assert.deepEqual(replies, [MSG_GS_PAUSED]);
    assert.equal(calls, 0);
  });

  await t("postback：on で押せない人なら「下村さんだけ」・通信しない", async () => {
    process.env.GROUP_SATEI = "1";
    replies.length = 0;
    calls = 0;
    await handleTaskPostbackEvent(ev("v1|gm|0123456789abcdef|1", STAFF), over);
    assert.deepEqual(replies, [MSG_GS_FORBIDDEN]);
    assert.equal(calls, 0);
  });

  console.log(`group-satei-webhook: ${n} ok`);
})().catch((e) => {
  Object.assign(console, orig);
  console.error(e);
  process.exit(1);
});
