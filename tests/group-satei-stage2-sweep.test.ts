/** 段2d：毎分の見回り（案の配達・失敗・遅れ・リマインド）と事例の PDF の控え（group-satei-propose.ts） */
import assert from "node:assert/strict";
import {
  asTicket, GS_STAGE2_SET, gsCasesKey, gsTicketKey, gsWaitKey, ticketIdOf, type GsTicket,
} from "../src/lib/group-satei-data";
import { markGsCasePdf, sweepGsStage2, type GsSweepDeps } from "../src/lib/group-satei-propose";
import type { SateiPrepNotice } from "../src/lib/group-satei-prep-portal";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const G = "C" + "a".repeat(32);
const tid = ticketIdOf("m1");
const NOW = Date.UTC(2026, 10, 26, 1);
const ON = { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, GROUP_SATEI_STAGE2: "1", GROUP_SATEI_CASE_STAFF_ID: STAFF };
const prep0 = { kind: "マンション" as const, rev: 0, lines: [], fixes: 0, sentRev: 0, tries: 0, groupPushes: 0 };
const base: GsTicket = {
  no: 7, ver: 1, groupId: G, requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], state: "gathering", prepAt: NOW - 60_000,
  read: { address: "大阪市北区天満2丁目3-4", propertyName: "パークハウス天満", kind: "マンション", basis: "本文", confidence: 0.9 }, prep: prep0,
};
const NOTICE: SateiPrepNotice = { tid, no: 7, status: "相談中", lines: ["成約：同じマンション", "売出：5件ほど"], areaDone: true, failReason: "" };

function mk(o: { ticket?: Partial<GsTicket>; notices?: SateiPrepNotice[]; push?: number | null; now?: number; s2?: string[] } = {}) {
  const m = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  m.set(gsTicketKey(tid), { ...base, ...(o.ticket ?? {}) });
  sets.set(GS_STAGE2_SET, new Set(o.s2 ?? [tid]));
  const pushes: Array<{ to: string; messages: unknown[]; key: string }> = [];
  const calls: string[] = [];
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
  const deps: GsSweepDeps = {
    env: ON, kv,
    prep: {
      intake: async () => ({ kind: "unknown", reason: "x" }),
      notices: async () => { calls.push("notices"); return { kind: "ok", value: o.notices ?? [NOTICE] }; },
      decide: async (id, req) => { calls.push(`decide ${req.decision}`); return { kind: "ok", value: { status: "x" } }; },
    },
    push: async (to, messages, key) => { pushes.push({ to, messages, key }); return o.push === undefined ? 200 : o.push; },
    now: () => o.now ?? NOW,
    log: (l) => logs.push(l),
  };
  return { deps, kv, m, sets, pushes, calls, logs };
}
const ticket = (x: ReturnType<typeof mk>) => asTicket(x.m.get(gsTicketKey(tid)))!;

(async () => {
  await t("集合が空なら portal も LINE も呼ばない", async () => {
    const x = mk({ s2: [] });
    await sweepGsStage2(x.deps);
    assert.deepEqual([x.calls, x.pushes.length], [[], 0]);
  });
  await t("案の配達：下村さんへカードを push（retry key prop:<tid>:1）。proposing・版1", async () => {
    const x = mk();
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes[0].to, SHIMO);
    assert.equal(x.pushes[0].key, `prop:${tid}:1`);
    assert.ok(JSON.stringify(x.pushes[0].messages).includes(`v1|gy|${tid}|1|1`));
    assert.equal(ticket(x).state, "proposing");
    assert.deepEqual([ticket(x).prep!.rev, ticket(x).prep!.sentRev, ticket(x).prep!.tries], [1, 1, 1]);
    assert.deepEqual(ticket(x).prep!.lines, NOTICE.lines);
    assert.ok(x.logs.includes("[group-satei] propose sent G7 r1"));
  });
  await t("案の push が結果不明：gathering のまま tries 1。次の回にもう1回だけ（2回で止める）", async () => {
    const x = mk({ push: null });
    await sweepGsStage2(x.deps);
    await sweepGsStage2(x.deps);
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes.length, 3);
    assert.equal(ticket(x).prep!.tries, 2);
    // 2回とも届かなければ、下村さんへ1回だけ「作れませんでした・手で」と知らせ、手作業にして見回りから外す
    assert.equal(x.pushes[2].key, `prepfail:${tid}`);
    assert.equal(ticket(x).state, "manual");
    assert.ok(x.calls.includes("decide manual"));
    assert.equal(x.sets.get(GS_STAGE2_SET)?.has(tid), false);
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes.length, 3);
  });
  await t("案の push を2回試し済みの票（前の版で gathering のまま残った票）も、知らせて手作業にする", async () => {
    const x = mk({ ticket: { prep: { ...prep0, tries: 2 } } });
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.pushes.map((p) => p.key), [`prepfail:${tid}`]);
    assert.equal(ticket(x).state, "manual");
  });
  await t("検査に通らない案：失敗と同じく手で頼む案内（グループには出さない）", async () => {
    const x = mk({ notices: [{ ...NOTICE, lines: ["天満2-3-4 の事例"] }] });
    await sweepGsStage2(x.deps);
    assert.equal(ticket(x).state, "manual");
    assert.equal(x.pushes[0].key, `prepfail:${tid}`);
  });
  await t("失敗：下村さんへ「案を作れませんでした」・手作業・portal に manual・集合から外す", async () => {
    const x = mk({ notices: [{ ...NOTICE, status: "失敗", lines: [], failReason: "folder" }] });
    await sweepGsStage2(x.deps);
    assert.equal(ticket(x).state, "manual");
    assert.ok(x.calls.includes("decide manual"));
    assert.equal(x.sets.get(GS_STAGE2_SET)?.has(tid), false);
  });
  await t("遅れ：gathering のまま30分で1回だけ知らせる（late:<tid>）", async () => {
    const x = mk({ notices: [], ticket: { prepAt: NOW - 31 * 60_000 } });
    await sweepGsStage2(x.deps);
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes.length, 1);
    assert.equal(x.pushes[0].key, `late:${tid}`);
    assert.equal(ticket(x).prep!.lateNotified, true);
  });
  const waiting = (o: Partial<GsTicket["prep"]> = {}): Partial<GsTicket> => ({
    state: "waiting-cases", prep: { ...prep0, rev: 1, lines: ["x"], sentRev: 1, tries: 1, groupPushes: 1, deadline: NOW - 1, requestedAt: NOW - 3_600_000, ...o },
  });
  await t("催促はボタンで：期日を過ぎ・PDF の控えが無い → 下村さんへ［催促する］のカードを1回だけ。グループへは送らない", async () => {
    const x = mk({ ticket: waiting() });
    await sweepGsStage2(x.deps);
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.pushes.map((p) => [p.to, p.key]), [[SHIMO, `remind-ask:${tid}`]]);
    const card = JSON.stringify(x.pushes[0].messages);
    assert.ok(card.includes(`v1|gr|${tid}|1`), card);
    assert.ok(card.includes("催促する"));
    assert.equal(ticket(x).prep!.remindAsked, true);
    assert.equal(ticket(x).prep!.reminded, undefined);
    assert.equal(ticket(x).prep!.groupPushes, 1);
    // 押されるか PDF が来るまで見回りの集合に残す
    assert.equal(x.sets.get(GS_STAGE2_SET)?.has(tid), true);
    assert.ok(x.logs.includes("[group-satei] remind-ask sent G7"));
  });
  await t("催促はボタンで：期日前は出さない／PDF の控えがあれば出さずに集合から外す／グループへ2回済みなら出さない", async () => {
    const a = mk({ ticket: waiting({ deadline: NOW + 1 }) });
    await sweepGsStage2(a.deps);
    assert.equal(a.pushes.length, 0);
    const b = mk({ ticket: waiting() });
    b.sets.set(gsCasesKey(tid), new Set(["pdf1"]));
    await sweepGsStage2(b.deps);
    assert.equal(b.pushes.length, 0);
    assert.equal(b.sets.get(GS_STAGE2_SET)?.has(tid), false);
    const c = mk({ ticket: waiting({ groupPushes: 2 }) });
    await sweepGsStage2(c.deps);
    assert.equal(c.pushes.length, 0);
  });
  await t("PDF の控え：そのグループの事例待ちの票に、依頼より後の PDF だけ足す（画像・前の PDF は数えない）", async () => {
    const x = mk({ ticket: waiting() });
    x.sets.set(gsWaitKey(G), new Set([tid]));
    const d = { env: ON, kv: x.kv, log: (l: string) => x.logs.push(l) };
    await markGsCasePdf({ messageId: "img1", kind: "image", senderId: STAFF, at: NOW }, G, d);
    await markGsCasePdf({ messageId: "old", kind: "pdf", senderId: STAFF, at: NOW - 7_200_000 }, G, d);
    await markGsCasePdf({ messageId: "pdf1", kind: "pdf", senderId: STAFF, at: NOW }, G, d);
    assert.deepEqual(Array.from(x.sets.get(gsCasesKey(tid)) ?? []), ["pdf1"]);
    assert.ok(x.logs.includes("[group-satei] cases marked G7 1"));
  });
  await t("2d が off なら見回りも控えも何もしない", async () => {
    const x = mk();
    await sweepGsStage2({ ...x.deps, env: { ...ON, GROUP_SATEI_CASE_STAFF_ID: "" } });
    assert.deepEqual([x.calls, x.pushes.length], [[], 0]);
  });
  await t("［催促する］のカードの push がはっきり失敗：次の回にもう一度。3回であきらめる（グループへは送らない）", async () => {
    const x = mk({ ticket: waiting(), push: 500 });
    for (let i = 0; i < 4; i++) await sweepGsStage2(x.deps);
    assert.deepEqual(x.pushes.map((p) => [p.to, p.key]), [[SHIMO, `remind-ask:${tid}`], [SHIMO, `remind-ask:${tid}`], [SHIMO, `remind-ask:${tid}`]]);
    assert.equal(ticket(x).prep!.remindAskFails, 3);
    assert.equal(ticket(x).prep!.remindAsked, true);
    assert.ok(x.logs.includes("[group-satei] remind-ask push-failed G7 gave-up"));
  });
  await t("［催促する］のカードの push の結果不明：出したことにして2回目は出さない", async () => {
    const x = mk({ ticket: waiting(), push: null });
    await sweepGsStage2(x.deps);
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.pushes.map((p) => p.key), [`remind-ask:${tid}`]);
    assert.equal(ticket(x).prep!.remindAsked, true);
    assert.ok(x.logs.includes("[group-satei] remind-ask unknown G7"));
  });
  await t("時間の予算：見回りの開始から38秒を過ぎたら新しい票に手を付けない（ログは符号だけ）", async () => {
    const x = mk({ ticket: waiting() });
    await sweepGsStage2({ ...x.deps, startedAt: NOW - 39_000 });
    assert.equal(x.pushes.length, 0);
    assert.ok(x.logs.includes("[group-satei] s2-sweep budget"));
    const y = mk();
    await sweepGsStage2({ ...y.deps, startedAt: NOW - 39_000 });
    assert.equal(y.pushes.length, 0);
    const z = mk({ ticket: waiting() });
    await sweepGsStage2({ ...z.deps, startedAt: NOW - 10_000 });
    assert.equal(z.pushes.length, 1);
  });
  await t("下村さんの宛先が無い：gathering の票は飛ばすが、その回に1度だけ符号でログを出す", async () => {
    const tid2 = ticketIdOf("m2");
    const x = mk({ s2: [tid, tid2] });
    x.m.set(gsTicketKey(tid2), { ...base, triggerMsgIds: ["m2"] });
    await sweepGsStage2({ ...x.deps, env: { ...ON, TASK_SATEI_USER_IDS: "", TASK_SATEI_NOTIFY_TO: "" } });
    assert.equal(x.pushes.length, 0);
    assert.deepEqual(x.logs.filter((l) => l.includes("no-target")), ["[group-satei] propose skip:no-target"]);
    assert.equal(ticket(x).state, "gathering");
  });
  console.log(`${n} passed`);
})();
