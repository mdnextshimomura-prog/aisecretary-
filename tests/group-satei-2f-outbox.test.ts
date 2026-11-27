/** 段2f（F3・F4・F5）：下村さんあての知らせの控え（outbox）と、見回りの送り直し（同じ retry key） */
import assert from "node:assert/strict";
import {
  asTicket, GS_STAGE2_SET, gsAmbigKey, gsTicketKey, gsWaitKey, ticketIdOf, type GsTicket,
} from "../src/lib/group-satei-data";
import { markGsCasePdf, sweepGsStage2, type GsSweepDeps } from "../src/lib/group-satei-propose";
import { GS_OB_TRIES, GS_OUTBOX_SET, gsCasesNoteText, gsObKey, gsOutboxAdd } from "../src/lib/group-satei-outbox";
import type { SateiPrepNotice } from "../src/lib/group-satei-prep-portal";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const G = "C" + "a".repeat(32);
const tid = ticketIdOf("m1");
const tid2 = ticketIdOf("m2");
const NOW = Date.UTC(2026, 10, 26, 1);
const MIN = 60_000;
const ON = { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, GROUP_SATEI_STAGE2: "1", GROUP_SATEI_CASE_STAFF_ID: STAFF };
const OFF = { ...ON, GROUP_SATEI_CASE_STAFF_ID: "" };
const prep0 = { kind: "マンション" as const, rev: 0, lines: [], fixes: 0, sentRev: 0, tries: 0, groupPushes: 0 };
const base: GsTicket = {
  no: 7, ver: 1, groupId: G, requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], state: "gathering", prepAt: NOW - 31 * MIN,
  read: { address: "大阪市北区天満2丁目3-4", propertyName: "パークハウス天満", kind: "マンション", basis: "本文", confidence: 0.9 }, prep: prep0,
};
const LATE = "事例の取り方の案がまだできていません（受付 G7）。Mac の査定係が止まっているかもしれません。山口さんへは手で頼んでも大丈夫です";

function mk(o: { ticket?: Partial<GsTicket>; notices?: SateiPrepNotice[]; push?: Array<number | null>; env?: Record<string, string> } = {}) {
  const m = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  m.set(gsTicketKey(tid), { ...base, ...(o.ticket ?? {}) });
  sets.set(GS_STAGE2_SET, new Set([tid]));
  const pushes: Array<{ to: string; text: string; key: string }> = [];
  const logs: string[] = [];
  const seq = [...(o.push ?? [])];
  let clock = NOW;
  const kv = {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: unknown) => { m.set(k, v); },
    setNx: async (k: string, v: unknown) => (m.has(k) ? false : (m.set(k, v), true)),
    incr: async () => 1, expire: async () => undefined,
    sadd: async (k: string, v: string) => { (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(v); },
    srem: async (k: string, v: string) => { sets.get(k)?.delete(v); },
    smembers: async (k: string) => Array.from(sets.get(k) ?? []),
    lpushTrim: async () => undefined, lrange: async (_k: string): Promise<unknown[]> => [],
    rpushCap: async () => undefined,
    del: async (k: string) => { m.delete(k); },
  };
  const deps: GsSweepDeps = {
    env: o.env ?? ON, kv,
    prep: {
      intake: async () => ({ kind: "unknown", reason: "x" }),
      notices: async () => ({ kind: "ok", value: o.notices ?? [] }),
      decide: async () => ({ kind: "ok", value: { status: "x" } }),
    },
    push: async (to, messages, key) => {
      pushes.push({ to, text: (messages[0] as { text: string }).text, key });
      return seq.length ? seq.shift()! : 200;
    },
    now: () => clock,
    log: (l) => logs.push(l),
  };
  return {
    deps, kv, m, sets, pushes, logs,
    at: (ms: number) => { clock = NOW + ms; deps.startedAt = undefined; },
    queued: (member: string) => sets.get(GS_OUTBOX_SET)?.has(member) === true,
  };
}
const ticket = (x: ReturnType<typeof mk>, id = tid) => asTicket(x.m.get(gsTicketKey(id)))!;
const noText = (logs: string[]) => logs.every((l) => !l.includes("事例") && !l.includes(tid) && !l.includes(SHIMO) && !l.includes("天満"));

(async () => {
  await t("積む→2分後の見回りで同じ retry key・同じ文で送る→控えから消える（prop-late）", async () => {
    const x = mk({ push: [500] });
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.pushes.map((p) => [p.key, p.text]), [[`late:${tid}`, LATE]]);
    assert.equal(x.queued(`prop-late:${tid}`), true);
    // 控えには文を入れない（数と時刻だけ）
    assert.deepEqual(x.m.get(gsObKey("prop-late", tid)), { tries: 0, nextAt: NOW + 2 * MIN, firstAt: NOW });
    x.at(MIN);
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes.length, 1, "nextAt の前は送らない");
    x.at(2 * MIN);
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.pushes.map((p) => [p.to, p.key, p.text]), [[SHIMO, `late:${tid}`, LATE], [SHIMO, `late:${tid}`, LATE]]);
    assert.equal(x.queued(`prop-late:${tid}`), false);
    assert.equal(x.m.has(gsObKey("prop-late", tid)), false);
    assert.ok(x.logs.includes("[group-satei] outbox prop-late G7 sent"));
    assert.ok(noText(x.logs));
  });
  await t("5回だめなら諦める（2・6・12・20・30分）。ログは種類と受付番号だけ", async () => {
    const x = mk({ push: Array(20).fill(500) });
    await sweepGsStage2(x.deps);
    const times: number[] = [];
    for (let m = 1; m <= 40; m++) {
      const before = x.pushes.length;
      x.at(m * MIN);
      await sweepGsStage2(x.deps);
      if (x.pushes.length > before) times.push(m);
    }
    assert.deepEqual(times, [2, 6, 12, 20, 30]);
    assert.equal(x.pushes.length, 1 + GS_OB_TRIES);
    assert.ok(x.pushes.every((p) => p.key === `late:${tid}`));
    assert.equal(x.queued(`prop-late:${tid}`), false);
    assert.ok(x.logs.includes("[group-satei] outbox prop-late G7 gave-up"));
    assert.ok(noText(x.logs));
  });
  await t("最初の失敗から2時間を過ぎたら送らずに消す", async () => {
    const x = mk({ ticket: { state: "gathering" } });
    await gsOutboxAdd(x.kv, "prop-late", tid, NOW, () => undefined);
    x.m.set(gsObKey("prop-late", tid), { tries: 1, nextAt: NOW + 3 * 60 * MIN, firstAt: NOW });
    x.sets.get(GS_STAGE2_SET)!.clear();
    x.at(2 * 60 * MIN);
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes.length, 0);
    assert.equal(x.queued(`prop-late:${tid}`), false);
    assert.ok(x.logs.includes("[group-satei] outbox prop-late gave-up"));
  });
  await t("受付票が消えた・もう要らない（案が届いて proposing）なら送らずに消す", async () => {
    const x = mk();
    x.sets.get(GS_STAGE2_SET)!.clear();
    await gsOutboxAdd(x.kv, "prop-late", tid, NOW, () => undefined);
    x.m.set(gsTicketKey(tid), { ...base, state: "proposing" });
    x.at(2 * MIN);
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes.length, 0);
    assert.equal(x.queued(`prop-late:${tid}`), false);
    assert.ok(x.logs.includes("[group-satei] outbox prop-late dropped"));
    const y = mk();
    y.sets.get(GS_STAGE2_SET)!.clear();
    await gsOutboxAdd(y.kv, "cases", tid, NOW, () => undefined);
    y.m.delete(gsTicketKey(tid));
    y.at(2 * MIN);
    await sweepGsStage2(y.deps);
    assert.deepEqual([y.pushes.length, y.queued(`cases:${tid}`)], [0, false]);
  });
  await t("予算の残りが15秒より少なければ触らない（次の回に送る）", async () => {
    const x = mk();
    x.sets.get(GS_STAGE2_SET)!.clear();
    await gsOutboxAdd(x.kv, "prop-late", tid, NOW, () => undefined);
    x.at(2 * MIN);
    x.deps.startedAt = NOW + 2 * MIN - 36_000;
    await sweepGsStage2(x.deps);
    assert.deepEqual([x.pushes.length, x.queued(`prop-late:${tid}`)], [0, true]);
    x.deps.startedAt = NOW + 2 * MIN - 35_000;
    await sweepGsStage2(x.deps);
    assert.deepEqual([x.pushes.length, x.queued(`prop-late:${tid}`)], [1, false]);
  });
  await t("1回の見回りで1件だけ", async () => {
    const x = mk();
    x.sets.get(GS_STAGE2_SET)!.clear();
    x.m.set(gsTicketKey(tid2), { ...base, no: 8, triggerMsgIds: ["m2"] });
    await gsOutboxAdd(x.kv, "prop-late", tid, NOW, () => undefined);
    await gsOutboxAdd(x.kv, "prop-late", tid2, NOW, () => undefined);
    x.at(2 * MIN);
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes.length, 1);
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes.length, 2);
  });
  await t("off（groupSateiPrepOn が偽）なら控えも読まない", async () => {
    const x = mk({ env: OFF });
    await gsOutboxAdd(x.kv, "prop-late", tid, NOW, () => undefined);
    let touched = 0;
    const kv = new Proxy(x.kv, { get: (o, p) => { touched++; return (o as Record<string | symbol, unknown>)[p]; } });
    x.at(2 * MIN);
    await sweepGsStage2({ ...x.deps, kv });
    assert.deepEqual([touched, x.pushes.length], [0, 0]);
  });
  await t("送れたら積まない（今の印は今どおり）", async () => {
    const x = mk();
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes.length, 1);
    assert.equal(ticket(x).prep!.lateNotified, true);
    assert.equal(x.sets.get(GS_OUTBOX_SET)?.size ?? 0, 0);
  });

  // ── 種類ごとの作り直し ──
  const waiting = (o: Partial<GsTicket["prep"]> = {}): Partial<GsTicket> => ({
    state: "waiting-cases", prep: { ...prep0, rev: 1, lines: ["x"], sentRev: 1, tries: 1, groupPushes: 1, deadline: NOW - 1, requestedAt: NOW - 3_600_000, ...o },
  });
  const three = [{ m: "p1", at: 1 }, { m: "p2", at: 2 }];
  await t("保存の遅れ（cases-late）：送り直す。結果が来て閉じたあとは送らない", async () => {
    const x = mk({ ticket: waiting({ casesHanded: 2, casesHandedAt: NOW - 31 * MIN }), push: [500] });
    x.kv.lrange = async () => three.map((v) => JSON.stringify(v));
    await sweepGsStage2(x.deps);
    assert.equal(x.queued(`cases-late:${tid}`), true);
    x.at(2 * MIN);
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.pushes.map((p) => p.key), [`cases-late:${tid}`, `cases-late:${tid}`]);
    const y = mk({ ticket: waiting({ casesHanded: 2, casesHandedAt: NOW - 31 * MIN }), push: [500] });
    y.kv.lrange = async () => three.map((v) => JSON.stringify(v));
    await sweepGsStage2(y.deps);
    y.m.set(gsTicketKey(tid), { ...base, ...waiting({ casesDone: true }) , state: "started" });
    y.at(2 * MIN);
    await sweepGsStage2(y.deps);
    assert.equal(y.pushes.length, 1);
    assert.equal(y.queued(`cases-late:${tid}`), false);
  });
  await t("どの受付か決められない（ambig）：同じ鍵の残りの retry key・同じ文で送り直す", async () => {
    const x = mk({ ticket: waiting(), push: [500] });
    x.sets.get(GS_STAGE2_SET)!.clear();
    x.m.set(gsTicketKey(tid2), { ...base, ...waiting(), no: 8, triggerMsgIds: ["m2"] });
    x.sets.set(gsWaitKey(G), new Set([tid, tid2]));
    await markGsCasePdf({ messageId: "p1", kind: "pdf", senderId: STAFF, at: NOW }, G, { env: ON, kv: x.kv, push: x.deps.push, now: x.deps.now, log: (l) => x.logs.push(l) });
    const rest = gsAmbigKey(G, "2026-11-26", [tid, tid2]).slice("gsatei:ambig:".length);
    assert.equal(x.queued(`ambig:${rest}`), true);
    x.at(2 * MIN);
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.pushes.map((p) => [p.key, p.text]), [
      [`ambig:${rest}`, "どの受付のものか決められません（受付 G7・G8）。02 に入れてください"],
      [`ambig:${rest}`, "どの受付のものか決められません（受付 G7・G8）。02 に入れてください"],
    ]);
    assert.equal(x.queued(`ambig:${rest}`), false);
    assert.ok(x.logs.includes("[group-satei] outbox ambig G7,G8 sent"));
    assert.ok(x.logs.every((l) => !l.includes("p1") && !l.includes(G)));
  });
  await t("L1：もう要らない知らせは作り直さず消す（催促の1行は結果が来たら、遅れは案の配達を試したら、ambig は候補が閉じたら）", async () => {
    // 催促はボタンで（2026-11-27）になってから remind-note は積まれないが、前の版で積まれた分は今の決まりで片付ける
    const x = mk({ ticket: waiting({ remindAsked: true }) });
    await gsOutboxAdd(x.kv, "remind-note", tid, NOW, () => undefined);
    x.m.set(gsTicketKey(tid), { ...base, ...waiting({ casesDone: true, remindNote: "sent" }), state: "started" });
    x.at(2 * MIN);
    await sweepGsStage2(x.deps);
    assert.deepEqual([x.pushes.length, x.queued(`remind-note:${tid}`)], [0, false]);
    // prop-late：案の配達を試した（tries>0）なら「案がまだできていません」は送らない
    const y = mk();
    y.sets.get(GS_STAGE2_SET)!.clear();
    await gsOutboxAdd(y.kv, "prop-late", tid, NOW, () => undefined);
    y.m.set(gsTicketKey(tid), { ...base, prep: { ...prep0, tries: 1 } });
    y.at(2 * MIN);
    await sweepGsStage2(y.deps);
    assert.deepEqual([y.pushes.length, y.queued(`prop-late:${tid}`)], [0, false]);
    // ambig：候補の票が1件でも waiting-cases でなくなったら送らない
    const z = mk({ ticket: waiting(), push: [500] });
    z.sets.get(GS_STAGE2_SET)!.clear();
    z.m.set(gsTicketKey(tid2), { ...base, ...waiting(), no: 8, triggerMsgIds: ["m2"] });
    z.sets.set(gsWaitKey(G), new Set([tid, tid2]));
    await markGsCasePdf({ messageId: "p1", kind: "pdf", senderId: STAFF, at: NOW }, G, { env: ON, kv: z.kv, push: z.deps.push, now: z.deps.now, log: () => undefined });
    z.m.set(gsTicketKey(tid2), { ...base, ...waiting(), no: 8, triggerMsgIds: ["m2"], state: "manual" });
    z.at(2 * MIN);
    await sweepGsStage2(z.deps);
    assert.equal(z.pushes.length, 1);
    assert.equal(z.sets.get(GS_OUTBOX_SET)!.size, 0);
  });
  await t("L2：控えに積めなければ閉じない（次の見回りで finishCases をやり直す・同じ retry key）", async () => {
    const SAVED: SateiPrepNotice = { tid, no: 7, status: "事例保存済み", lines: [], areaDone: false, failReason: "", cases: { contract: 2, listing: 1, failed: 0 }, casesFailReason: "" };
    const x = mk({ ticket: waiting({ casesHanded: 2, casesHandedAt: NOW, kind: "土地" }), notices: [SAVED], push: [500, 200] });
    x.kv.lrange = async () => [JSON.stringify({ m: "p1", at: 1 }), JSON.stringify({ m: "p2", at: 2 })];
    const sadd = x.kv.sadd;
    x.kv.sadd = async (k: string, v: string) => { if (k === GS_OUTBOX_SET) throw new Error("kv"); return sadd(k, v); };
    await sweepGsStage2(x.deps);
    assert.deepEqual([x.pushes.length, ticket(x).state, ticket(x).prep!.casesDone, ticket(x).prep!.casesPushTries], [1, "waiting-cases", undefined, 1]);
    assert.equal(x.sets.get(GS_STAGE2_SET)!.has(tid), true);
    x.kv.sadd = sadd;
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.pushes.map((p) => p.key), [`cases:${tid}`, `cases:${tid}`]);
    assert.equal(x.pushes[1].text, x.pushes[0].text);
    assert.deepEqual([ticket(x).state, ticket(x).prep!.casesDone], ["manual", true]);
  });
  await t("L2：portal に断られた知らせ（handCases）も、積めなければ閉じずにやり直す", async () => {
    const x = mk({ ticket: waiting(), push: [500, 500] });
    x.kv.lrange = async () => [JSON.stringify({ m: "p1", at: NOW - 3 * MIN })];
    x.deps.prep!.cases = async () => ({ kind: "rejected", status: 409, code: "PREP_STALE" });
    const sadd = x.kv.sadd;
    x.kv.sadd = async (k: string, v: string) => { if (k === GS_OUTBOX_SET) throw new Error("kv"); return sadd(k, v); };
    await sweepGsStage2(x.deps);
    assert.deepEqual([x.pushes.length, ticket(x).state, ticket(x).prep!.casesHanded, ticket(x).prep!.casesPushTries], [1, "waiting-cases", undefined, 1]);
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.pushes.map((p) => p.key), [`cases:${tid}`, `cases:${tid}`]);
    // 2回目も積めなければ、そこで閉じる（毎分送り続けない）
    assert.deepEqual([ticket(x).state, ticket(x).prep!.casesDone], ["manual", true]);
  });
  await t("L3：控えのループの中でも残り時間を確かめる（期限前の要素を読むあいだに予算が尽きたら送らない）", async () => {
    const x = mk();
    x.sets.get(GS_STAGE2_SET)!.clear();
    x.m.set(gsTicketKey(tid2), { ...base, no: 8, triggerMsgIds: ["m2"] });
    await gsOutboxAdd(x.kv, "prop-late", tid, NOW + 10 * MIN, () => undefined);
    await gsOutboxAdd(x.kv, "prop-late", tid2, NOW, () => undefined);
    x.at(2 * MIN);
    x.deps.startedAt = NOW + 2 * MIN;
    let clock = NOW + 2 * MIN;
    x.deps.now = () => clock;
    const get = x.kv.get;
    // 1件目（期限前）を読むたびに時計を36秒進める
    x.kv.get = async (k: string) => { if (k === gsObKey("prop-late", tid)) clock += 36_000; return get(k); };
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes.length, 0);
    assert.equal(x.queued(`prop-late:${tid2}`), true);
  });
  await t("結果の知らせの文の作り直し（gsCasesNoteText）は finishCases と同じ", async () => {
    const c = { contract: 2, listing: 1 };
    assert.equal(gsCasesNoteText(7, { ...c, failed: 0, unsaved: 0, draft: "started", jobNo: 12 }), "事例を保存しました（成約 2件・売出 1件）。下書きを作ります（受付 G7・#J12）");
    assert.equal(
      gsCasesNoteText(7, { ...c, failed: 1, unsaved: 2, draft: "land" }),
      "事例を保存しました（成約 2件・売出 1件）。土地の下書きは自動で作れません。資料は 01・02 にそろえました（受付 G7）\n取り出せなかった PDF が 1件あります。02 に入れてください\n保存していない PDF が 2件あります。02 に入れてください",
    );
    assert.equal(gsCasesNoteText(7, { contract: 0, listing: 0, failed: 0, unsaved: 2, draft: "failed" }), "事例の PDF を取り出せませんでした。案件フォルダの 02 に入れてください（受付 G7）\n保存していない PDF が 2件あります。02 に入れてください");
    assert.match(gsCasesNoteText(7, { ...c, failed: 0, unsaved: 0, draft: "manual" }), /下書きを始められませんでした/);
    assert.match(gsCasesNoteText(7, { ...c, failed: 0, unsaved: 0, draft: "unknown" }), /確かめられませんでした/);
    assert.match(gsCasesNoteText(7, { ...c, failed: 0, unsaved: 0, draft: "house" }), /戸建の下書き/);
  });
  await t("受付票の検査：casesNote・remindNote の形が違えば読まない", async () => {
    const tk = { ...base, ...waiting() } as GsTicket;
    assert.ok(asTicket({ ...tk, prep: { ...tk.prep!, casesNote: { contract: 1, listing: 0, failed: 0, unsaved: 0, draft: "started", jobNo: 3 }, remindNote: "sent" } }));
    assert.equal(asTicket({ ...tk, prep: { ...tk.prep!, casesNote: { contract: 1, listing: 0, failed: 0, unsaved: 0, draft: "x" } } }), null);
    assert.equal(asTicket({ ...tk, prep: { ...tk.prep!, casesNote: { contract: "1", listing: 0, failed: 0, unsaved: 0, draft: "manual" } } }), null);
    assert.equal(asTicket({ ...tk, prep: { ...tk.prep!, remindNote: "ok" } }), null);
  });
  await t("形の違う控えは消す（作り直さない）", async () => {
    const x = mk();
    x.sets.get(GS_STAGE2_SET)!.clear();
    x.sets.set(GS_OUTBOX_SET, new Set(["nope:" + tid, "cases:xyz", "ambig:" + G]));
    x.at(2 * MIN);
    await sweepGsStage2(x.deps);
    assert.deepEqual([x.pushes.length, x.sets.get(GS_OUTBOX_SET)!.size], [0, 0]);
  });
  console.log(`group-satei-2f-outbox: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
