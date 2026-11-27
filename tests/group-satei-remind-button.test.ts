/** 催促はボタンで（2026-11-27）：下村さんの1対1の［催促する］（v1|gr|）を押したときだけ、依頼のグループで山口さんにメンションして声をかける */
import assert from "node:assert/strict";
import { handleGroupSateiPostback, type GsActionDeps } from "../src/lib/group-satei-actions";
import {
  asTicket, encodeGsRemind, GS_STAGE2_SET, gsCaseItemsKey, gsCasesKey, gsRemindKey, gsTicketKey, parseGsData, ticketIdOf, type GsTicket,
} from "../src/lib/group-satei-data";
import { gsRemindAskCard } from "../src/lib/group-satei-case";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const OTHER = "U" + "9".repeat(32);
const STAFF = "U" + "d".repeat(32);
const G = "C" + "a".repeat(32);
const tid = ticketIdOf("m1");
const NOW = Date.UTC(2026, 10, 27, 10);
const ON = { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, GROUP_SATEI_STAGE2: "1", GROUP_SATEI_CASE_STAFF_ID: STAFF };
const base: GsTicket = {
  no: 7, ver: 1, groupId: G, requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], state: "waiting-cases", dealId: "d",
  read: { address: "大阪市北区天満2丁目3-4", propertyName: "パークハウス天満", kind: "マンション", basis: "本文", confidence: 0.9 },
  prep: { kind: "マンション", rev: 1, lines: ["x"], fixes: 0, sentRev: 1, tries: 1, groupPushes: 1, deadline: NOW - 1, requestedAt: NOW - 3_600_000, caseStaffId: STAFF, remindAsked: true },
};

function mk(o: { ticket?: Partial<GsTicket>; push?: Array<number | null>; env?: Record<string, string>; items?: unknown[] } = {}) {
  const m = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  m.set(gsTicketKey(tid), { ...base, ...(o.ticket ?? {}) });
  sets.set(GS_STAGE2_SET, new Set([tid]));
  const replies: string[] = [];
  const pushes: Array<{ to: string; messages: unknown[]; key: string }> = [];
  const logs: string[] = [];
  const results = [...(o.push ?? [])];
  const kv = {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: unknown) => { m.set(k, v); },
    setNx: async (k: string, v: unknown) => (m.has(k) ? false : (m.set(k, v), true)),
    incr: async () => 1, expire: async () => undefined,
    sadd: async (k: string, v: string) => { (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(v); },
    srem: async (k: string, v: string) => { sets.get(k)?.delete(v); },
    smembers: async (k: string) => Array.from(sets.get(k) ?? []),
    lpushTrim: async () => undefined,
    lrange: async (k: string) => (k === gsCaseItemsKey(tid) ? (o.items ?? []) : []),
    del: async (k: string) => { m.delete(k); },
  };
  const deps: GsActionDeps = {
    env: o.env ?? ON, kv, dealsDbId: "x", readDeal: async () => null,
    intake: async () => ({ kind: "unknown", reason: "x" }), loadDeals: async () => [],
    reserve: async () => ({ proceed: true }), complete: async () => undefined,
    reply: async (_t, text) => { replies.push(text); },
    log: (l) => logs.push(l),
    push: async (to, messages, key) => { pushes.push({ to, messages, key }); return results.length > 0 ? results.shift()! : 200; },
    now: () => NOW,
  };
  return { deps, m, sets, replies, pushes, logs };
}
let ev = 0;
const press = (x: ReturnType<typeof mk>, userId = SHIMO, ver = 1) =>
  handleGroupSateiPostback(parseGsData(encodeGsRemind(tid, ver))!, { replyToken: "r", webhookEventId: `e${++ev}`, source: { userId } }, x.deps);
const ticket = (x: ReturnType<typeof mk>) => asTicket(x.m.get(gsTicketKey(tid)))!;
const mentioned = (msg: unknown) => (msg as { substitution: { staff: { mentionee: { userId: string } } } }).substitution.staff.mentionee.userId;

(async () => {
  await t("data：v1|gr|<tid>|<ver> を読む。形が違えば読まない", async () => {
    assert.deepEqual(parseGsData(`v1|gr|${tid}|1`), { op: "gr", tid, ver: 1 });
    assert.equal(parseGsData(`v1|gr|${tid}|1|x`), null);
    assert.equal(parseGsData(`v1|gr|zz|1`), null);
  });
  await t("カード：［催促する］のボタンだけ。期日の文字つき・グループ向けの文ではない", async () => {
    const c = JSON.stringify(gsRemindAskCard({ tid, ver: 1, no: 7, deadlineLabel: "11/27(金) 18時" }));
    assert.ok(c.includes(`v1|gr|${tid}|1`));
    assert.ok(c.includes("催促する"));
    assert.ok(c.includes("事例がまだ届いていません（受付 G7）"));
    assert.ok(c.includes("11/27(金) 18時"));
  });
  await t("押す：グループへ1回、山口さんにメンション（retry key remind:<tid>）。下村さんへは返事で「声をかけました」", async () => {
    const x = mk();
    await press(x);
    assert.deepEqual(x.pushes.map((p) => [p.to, p.key]), [[G, `remind:${tid}`]]);
    assert.equal((x.pushes[0].messages[0] as { text: string }).text, "{staff} 受付 G7 の事例はいかがでしょうか");
    assert.equal(mentioned(x.pushes[0].messages[0]), STAFF);
    assert.deepEqual(x.replies, ["グループで山口さんに声をかけました（受付 G7）"]);
    assert.equal(ticket(x).prep!.reminded, true);
    assert.equal(ticket(x).prep!.groupPushes, 2);
    assert.equal(ticket(x).prep!.remindNote, "sent");
    assert.equal(x.sets.get(GS_STAGE2_SET)?.has(tid), false);
    assert.ok(x.logs.some((l) => l.includes("remind sent G7")), x.logs.join("|"));
  });
  await t("二度押し：2回目はグループへ送らず「もう送ってあります」", async () => {
    const x = mk();
    await press(x);
    await press(x);
    assert.equal(x.pushes.length, 1);
    assert.equal(x.replies[1], "催促はもう送ってあります（受付 G7）");
  });
  await t("もう PDF が届いている（受付票に結びついた PDF・控え）：送らない", async () => {
    const a = mk({ items: [JSON.stringify({ m: "p1", at: NOW })] });
    await press(a);
    assert.equal(a.pushes.length, 0);
    assert.equal(a.replies[0], "もう事例の PDF が届いています。催促はしません（受付 G7）");
    const b = mk();
    b.sets.set(gsCasesKey(tid), new Set(["p1"]));
    await press(b);
    assert.equal(b.pushes.length, 0);
    const c = mk({ ticket: { prep: { ...base.prep!, casesHanded: 1 } } });
    await press(c);
    assert.equal(c.pushes.length, 0);
  });
  await t("事例待ちでない票（手作業・完了）：送らない", async () => {
    const x = mk({ ticket: { state: "manual" } });
    await press(x);
    assert.equal(x.pushes.length, 0);
    assert.equal(x.replies[0], "この受付はもう事例待ちではありません（受付 G7）");
  });
  await t("グループへ2回送り済み：送らない", async () => {
    const x = mk({ ticket: { prep: { ...base.prep!, groupPushes: 2 } } });
    await press(x);
    assert.equal(x.pushes.length, 0);
  });
  await t("はっきり失敗：予約を外して「もう一度押してください」。押し直せば送れる", async () => {
    const x = mk({ push: [500] });
    await press(x);
    assert.equal(x.replies[0], "送れませんでした。少し待ってから、もう一度［催促する］を押してください（受付 G7）");
    assert.equal(x.m.has(gsRemindKey(tid)), false);
    assert.equal(ticket(x).prep!.reminded, undefined);
    assert.equal(ticket(x).prep!.remindFails, 1);
    await press(x);
    assert.equal(x.pushes.length, 2);
    assert.equal(x.replies[1], "グループで山口さんに声をかけました（受付 G7）");
  });
  await t("3回はっきり失敗：あきらめて「手で声をかけてください」", async () => {
    const x = mk({ push: [400, 400, 400] });
    await press(x);
    await press(x);
    await press(x);
    assert.equal(x.pushes.length, 3);
    assert.equal(x.replies[2], "何度か送れませんでした。グループで手で声をかけてください（受付 G7）");
    assert.equal(ticket(x).prep!.reminded, true);
    await press(x);
    assert.equal(x.pushes.length, 3);
  });
  await t("結果不明：予約を残し「確かめられませんでした」。押し直しても重ねない", async () => {
    const x = mk({ push: [null] });
    await press(x);
    assert.match(x.replies[0], /確かめられませんでした/);
    assert.equal(ticket(x).prep!.remindNote, "unknown");
    await press(x);
    assert.equal(x.pushes.length, 1);
  });
  await t("押せるのは下村さんだけ・古い版・2d off は送らない", async () => {
    const a = mk();
    await press(a, OTHER);
    assert.equal(a.pushes.length, 0);
    const b = mk({ ticket: { ver: 2 } });
    await press(b);
    assert.equal(b.pushes.length, 0);
    const c = mk({ env: { ...ON, GROUP_SATEI_CASE_STAFF_ID: "" } });
    await press(c);
    assert.equal(c.pushes.length, 0);
  });
  await t("caseStaffId の無い古い票は env の最初の ID でメンション", async () => {
    const x = mk({ ticket: { prep: { ...base.prep!, caseStaffId: undefined } } });
    await press(x);
    assert.equal(mentioned(x.pushes[0].messages[0]), STAFF);
  });
  await t("受付票の検査：remindAsked・remindAskFails の形が違えば読まない", async () => {
    assert.ok(asTicket({ ...base, prep: { ...base.prep!, remindAskFails: 2 } }));
    assert.equal(asTicket({ ...base, prep: { ...base.prep!, remindAsked: "yes" } }), null);
    assert.equal(asTicket({ ...base, prep: { ...base.prep!, remindAskFails: -1 } }), null);
  });
  console.log(`${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
