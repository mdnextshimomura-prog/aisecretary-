/** 段2d の追加：山口さんの LINE が2つ。［いいよ］のとき、依頼のグループにいるほうを選ぶ（GROUP_SATEI_CASE_STAFF_ID はカンマ区切りで3つまで） */
import assert from "node:assert/strict";
import { handleGroupSateiPostback, type GsActionDeps } from "../src/lib/group-satei-actions";
import {
  asTicket, GS_STAGE2_SET, groupSateiPrepOn, gsCaseStaffId, gsCaseStaffIds, gsTicketKey, parseGsData, ticketIdOf, type GsTicket,
} from "../src/lib/group-satei-data";
import { gsGroupMemberStatus } from "../src/lib/group-satei-member";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const S1 = "U" + "d".repeat(32);
const S2 = "U" + "e".repeat(32);
const S3 = "U" + "f".repeat(32);
const G = "C" + "a".repeat(32);
const tid = ticketIdOf("m1");
const NOW = Date.UTC(2026, 10, 26, 1);
const LINES = ["成約：同じマンション → 同じ町名", "売出：5件ほど"];
const base: GsTicket = {
  no: 7, ver: 1, groupId: G, requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], state: "proposing", dealId: "d",
  read: { address: "大阪市北区天満2丁目3-4", propertyName: "パークハウス天満 1203号室", kind: "マンション", basis: "本文", confidence: 0.9 },
  prep: { kind: "マンション", rev: 1, lines: LINES, fixes: 0, sentRev: 1, tries: 1, groupPushes: 0 },
};
const env = (staff: string) => ({ TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, GROUP_SATEI_STAGE2: "1", GROUP_SATEI_CASE_STAFF_ID: staff });

type St = "in" | "out" | "unknown";
function mk(o: { staff: string; member?: Record<string, St>; ticket?: Partial<GsTicket> }) {
  const m = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  m.set(gsTicketKey(tid), { ...base, ...(o.ticket ?? {}) });
  sets.set(GS_STAGE2_SET, new Set([tid]));
  const replies: string[] = [];
  const pushes: Array<{ to: string; messages: unknown[]; key: string }> = [];
  const checks: string[] = [];
  const decides: unknown[] = [];
  const logs: string[] = [];
  const kv = {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: unknown) => { m.set(k, v); },
    setNx: async (k: string, v: unknown) => (m.has(k) ? false : (m.set(k, v), true)),
    incr: async () => 1, expire: async () => undefined,
    sadd: async (k: string, v: string) => { (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(v); },
    srem: async (k: string, v: string) => { sets.get(k)?.delete(v); },
    smembers: async (k: string) => Array.from(sets.get(k) ?? []),
    lpushTrim: async () => undefined, lrange: async () => [],
    del: async (k: string) => { m.delete(k); },
  };
  const deps: GsActionDeps = {
    env: env(o.staff), kv, dealsDbId: "x", readDeal: async () => null,
    intake: async () => ({ kind: "unknown", reason: "x" }), loadDeals: async () => [],
    reserve: async () => ({ proceed: true }), complete: async () => undefined,
    reply: async (_t, text) => { replies.push(text); },
    log: (l) => logs.push(l),
    prep: { intake: async () => ({ kind: "unknown", reason: "x" }), notices: async () => ({ kind: "ok", value: [] }), decide: async (id, req) => { decides.push({ id, req }); return { kind: "ok", value: { status: "x" } }; } },
    push: async (to, messages, key) => { pushes.push({ to, messages, key }); return 200; },
    groupMember: async (groupId, userId) => {
      assert.equal(groupId, G);
      checks.push(userId);
      return o.member?.[userId] ?? "out";
    },
    now: () => NOW,
  };
  return { deps, kv, m, sets, replies, pushes, checks, decides, logs };
}
const press = (x: ReturnType<typeof mk>) =>
  handleGroupSateiPostback(parseGsData(`v1|gy|${tid}|1|1`)!, { replyToken: "r", webhookEventId: "e1", source: { userId: SHIMO } }, x.deps);
const ticket = (x: ReturnType<typeof mk>) => asTicket(x.m.get(gsTicketKey(tid)))!;
const mentioned = (msg: unknown) => (msg as { substitution: { staff: { mentionee: { userId: string } } } }).substitution.staff.mentionee.userId;

(async () => {
  await t("env：カンマ区切りで3つまで・形の違うものは捨てる・1つも正しくなければ off", async () => {
    assert.deepEqual(gsCaseStaffIds({ GROUP_SATEI_CASE_STAFF_ID: S1 }), [S1]);
    assert.deepEqual(gsCaseStaffIds({ GROUP_SATEI_CASE_STAFF_ID: ` ${S1} , ${S2} ` }), [S1, S2]);
    assert.deepEqual(gsCaseStaffIds({ GROUP_SATEI_CASE_STAFF_ID: `U123,${S1},u${"d".repeat(32)},${S2}x,${S2}` }), [S1, S2]);
    assert.deepEqual(gsCaseStaffIds({ GROUP_SATEI_CASE_STAFF_ID: `${S1},${S1},${S2}` }), [S1, S2]);
    assert.deepEqual(gsCaseStaffIds({ GROUP_SATEI_CASE_STAFF_ID: `${S1},${S2},${S3},${"U" + "a".repeat(32)}` }), [S1, S2, S3]);
    assert.deepEqual(gsCaseStaffIds({ GROUP_SATEI_CASE_STAFF_ID: "U123,,x" }), []);
    assert.equal(gsCaseStaffId({ GROUP_SATEI_CASE_STAFF_ID: `bad,${S2},${S1}` }), S2);
    assert.equal(groupSateiPrepOn(env("U123,x")), false);
    assert.equal(groupSateiPrepOn(env(`x,${S1}`)), true);
  });
  await t("1つだけ：確かめずにそのまま使う（API を呼ばない）。prep に caseStaffId", async () => {
    const x = mk({ staff: S1 });
    await press(x);
    assert.deepEqual(x.checks, []);
    assert.equal(x.pushes.length, 1);
    assert.equal(mentioned(x.pushes[0].messages[0]), S1);
    assert.equal(ticket(x).state, "waiting-cases");
    assert.equal(ticket(x).prep!.caseStaffId, S1);
    assert.equal(x.logs.some((l) => l.includes("staff")), false);
  });
  await t("2つで2つ目が 200：2つ目でメンション・picked 2/2・userId はログに出さない", async () => {
    const x = mk({ staff: `${S1},${S2}`, member: { [S2]: "in" } });
    await press(x);
    assert.deepEqual(x.checks, [S1, S2]);
    assert.equal(mentioned(x.pushes[0].messages[0]), S2);
    assert.equal(ticket(x).prep!.caseStaffId, S2);
    assert.ok(x.logs.includes("[group-satei] gy staff picked G7 2/2"));
    assert.ok(x.logs.every((l) => !l.includes(S1) && !l.includes(S2)));
  });
  await t("2つで1つ目が 200：1つ目で止める（2つ目は確かめない）", async () => {
    const x = mk({ staff: `${S1},${S2}`, member: { [S1]: "in", [S2]: "in" } });
    await press(x);
    assert.deepEqual(x.checks, [S1]);
    assert.equal(mentioned(x.pushes[0].messages[0]), S1);
    assert.ok(x.logs.includes("[group-satei] gy staff picked G7 1/2"));
  });
  await t("全部 404：グループへ送らず手作業・「いないようです」＋案の文面・portal に manual", async () => {
    const x = mk({ staff: `${S1},${S2}` });
    await press(x);
    assert.equal(x.pushes.length, 0);
    assert.equal(ticket(x).state, "manual");
    assert.ok(x.replies[0].startsWith("山口さんがこの依頼のグループにいないようです。手で頼んでください（受付 G7）\n\n"));
    assert.ok(x.replies[0].includes("期日：11/26（木）18時"));
    assert.deepEqual(x.decides[0], { id: tid, req: { decision: "manual", rev: 1 } });
    assert.equal(x.sets.get(GS_STAGE2_SET)?.has(tid), false);
    assert.ok(x.logs.includes("[group-satei] gy staff none G7"));
  });
  await t("失敗まじりで 200 が無い：「確かめられませんでした」で手作業", async () => {
    const x = mk({ staff: `${S1},${S2},${S3}`, member: { [S2]: "unknown" } });
    await press(x);
    assert.deepEqual(x.checks, [S1, S2, S3]);
    assert.equal(x.pushes.length, 0);
    assert.equal(ticket(x).state, "manual");
    assert.ok(x.replies[0].startsWith("山口さんがグループにいるか確かめられませんでした。手で頼んでください（受付 G7）\n\n"));
    assert.ok(x.logs.includes("[group-satei] gy staff unknown G7"));
  });
  await t("失敗のあとに 200：200 の ID を使う", async () => {
    const x = mk({ staff: `${S1},${S2}`, member: { [S1]: "unknown", [S2]: "in" } });
    await press(x);
    assert.equal(mentioned(x.pushes[0].messages[0]), S2);
    assert.ok(x.logs.includes("[group-satei] gy staff picked G7 2/2"));
  });
  await t("確かめる口が無い（2つ以上）：確かめられない扱い", async () => {
    const x = mk({ staff: `${S1},${S2}` });
    delete x.deps.groupMember;
    await press(x);
    assert.equal(x.pushes.length, 0);
    assert.ok(x.replies[0].startsWith("山口さんがグループにいるか確かめられませんでした"));
  });

  const pressRemind = (x: ReturnType<typeof mk>) =>
    handleGroupSateiPostback(parseGsData(`v1|gr|${tid}|1`)!, { replyToken: "r", webhookEventId: "e2", source: { userId: SHIMO } }, x.deps);
  const waiting = (o: Partial<NonNullable<GsTicket["prep"]>> = {}): Partial<GsTicket> => ({
    state: "waiting-cases", prep: { ...base.prep!, groupPushes: 1, deadline: NOW - 1, requestedAt: NOW - 3_600_000, ...o },
  });
  await t("催促（［催促する］を押す）：受付票の caseStaffId でメンションする", async () => {
    const x = mk({ staff: `${S1},${S2}`, ticket: waiting({ caseStaffId: S2 }) });
    await pressRemind(x);
    assert.equal(x.pushes[0].key, `remind:${tid}`);
    assert.equal(mentioned(x.pushes[0].messages[0]), S2);
  });
  await t("催促（［催促する］を押す）：caseStaffId の無い古い票は env の最初の ID", async () => {
    const x = mk({ staff: `bad,${S1},${S2}`, ticket: waiting() });
    await pressRemind(x);
    assert.equal(mentioned(x.pushes[0].messages[0]), S1);
  });
  await t("受付票：caseStaffId の形が違えば票として読まない", async () => {
    assert.equal(asTicket({ ...base, prep: { ...base.prep!, caseStaffId: "U123" } }), null);
    assert.ok(asTicket({ ...base, prep: { ...base.prep!, caseStaffId: S1 } }));
  });

  await t("LINE の口：200＝in・404＝out・ほか・例外・時間切れ＝unknown（Bearer・パス）", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const f = (status: number | "throw") => (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (status === "throw") throw new Error("x");
      return new Response("{}", { status });
    }) as unknown as typeof fetch;
    assert.equal(await gsGroupMemberStatus(G, S1, { token: "tok", fetch: f(200) }), "in");
    assert.equal(seen[0].url, `https://api.line.me/v2/bot/group/${G}/member/${S1}`);
    assert.equal(seen[0].auth, "Bearer tok");
    assert.equal(await gsGroupMemberStatus(G, S1, { token: "tok", fetch: f(404) }), "out");
    assert.equal(await gsGroupMemberStatus(G, S1, { token: "tok", fetch: f(500) }), "unknown");
    assert.equal(await gsGroupMemberStatus(G, S1, { token: "tok", fetch: f(401) }), "unknown");
    assert.equal(await gsGroupMemberStatus(G, S1, { token: "tok", fetch: f("throw") }), "unknown");
    assert.equal(await gsGroupMemberStatus(G, S1, { token: "", fetch: f(200) }), "unknown");
    const slow = ((_u: string, init?: RequestInit) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("abort"))))) as unknown as typeof fetch;
    assert.equal(await gsGroupMemberStatus(G, S1, { token: "tok", fetch: slow, timeoutMs: 20 }), "unknown");
    assert.equal(await gsGroupMemberStatus("bad", S1, { token: "tok", fetch: f(200) }), "unknown");
  });
  console.log(`${n} passed`);
})();
