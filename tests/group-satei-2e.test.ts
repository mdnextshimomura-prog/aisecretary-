/** 段2e：事例の PDF の結びつけ・取り出しの口・portal へ渡す・結果の知らせ（KV・portal・LINE・fetch は差し替え） */
import assert from "node:assert/strict";
import {
  asTicket, GS_STAGE2_SET, gsAmbigKey, gsCaseItemsKey, gsCasesKey, gsTicketKey, gsWaitKey, ticketIdOf, type GsTicket,
} from "../src/lib/group-satei-data";
import { markGsCasePdf, sweepGsStage2, type GsSweepDeps } from "../src/lib/group-satei-propose";
import { handleGroupSateiPostback, type GsActionDeps } from "../src/lib/group-satei-actions";
import { gsMediaToken, handleGsMedia, type GsMediaDeps } from "../src/lib/group-satei-media";
import { sateiPrepCases, sateiPrepCasesAck, sateiPrepNotices, type SateiPrepNotice } from "../src/lib/group-satei-prep-portal";
import type { SateiDeal } from "../src/lib/satei-deal";
import type { SateiIntakeReq } from "../src/lib/satei-portal";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const G = "C" + "a".repeat(32);
const DB = "9999abcd0123456789ab0123456789ab";
const DEAL = "0123abcd0123456789ab0123456789ab";
const JOB = "k".repeat(40);
const tid = ticketIdOf("m1");
const tid2 = ticketIdOf("m2");
const NOW = Date.UTC(2026, 10, 26, 1);
const ON = { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, GROUP_SATEI_STAGE2: "1", GROUP_SATEI_CASE_STAFF_ID: STAFF, JOB_API_TOKEN: JOB };
const OFF = { ...ON, GROUP_SATEI_CASE_STAFF_ID: "" };
const prepW = { kind: "マンション" as const, rev: 1, lines: ["x"], fixes: 0, sentRev: 1, tries: 1, groupPushes: 1, deadline: NOW + 3_600_000, requestedAt: NOW - 3_600_000 };
const waiting: GsTicket = {
  no: 7, ver: 1, groupId: G, requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], state: "waiting-cases", dealId: DEAL, requestKind: "satei",
  read: { address: "大阪市北区天満2丁目3-4", propertyName: "パークハウス天満", kind: "マンション", basis: "本文", confidence: 0.9 }, prep: prepW,
};
const deal: SateiDeal = { id: DEAL, name: "山田様 売却", dealNo: 12, folderId: "folder_abcdefghij", propertyIds: ["p"], gone: false, parentDbId: DB };
const SAVED: SateiPrepNotice = { tid, no: 7, status: "事例保存済み", lines: [], areaDone: false, failReason: "", cases: { contract: 2, listing: 1, failed: 0 }, casesFailReason: "" };

type Item = { m: string; at: number };
function mk(o: { ticket?: Partial<GsTicket>; prep?: Partial<GsTicket["prep"]>; notices?: SateiPrepNotice[]; push?: Array<number | null>; items?: Item[]; cases?: unknown; intake?: unknown; env?: Record<string, string>; kind?: string } = {}) {
  const m = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  const lists = new Map<string, string[]>();
  m.set(gsTicketKey(tid), { ...waiting, ...(o.ticket ?? {}), prep: { ...prepW, ...(o.prep ?? {}) } });
  sets.set(GS_STAGE2_SET, new Set([tid]));
  sets.set(gsWaitKey(G), new Set([tid]));
  if (o.items) lists.set(gsCaseItemsKey(tid), o.items.map((x) => JSON.stringify(x)));
  const pushes: Array<{ to: string; messages: unknown[]; key: string }> = [];
  const calls: string[] = [];
  const intakes: SateiIntakeReq[] = [];
  const logs: string[] = [];
  const pushSeq = [...(o.push ?? [])];
  const kv = {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: unknown) => { m.set(k, v); },
    setNx: async (k: string, v: unknown) => (m.has(k) ? false : (m.set(k, v), true)),
    incr: async () => 1, expire: async () => undefined,
    sadd: async (k: string, v: string) => { (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(v); },
    srem: async (k: string, v: string) => { sets.get(k)?.delete(v); },
    smembers: async (k: string) => Array.from(sets.get(k) ?? []),
    lpushTrim: async () => undefined,
    // 本物（Upstash）は JSON の文字列を読み出しで戻す。ここでは文字列のまま返す
    lrange: async (k: string) => [...(lists.get(k) ?? [])],
    rpushCap: async (k: string, v: unknown, max: number) => { const a = lists.get(k) ?? []; a.push(JSON.stringify(v)); lists.set(k, a.slice(0, max)); },
    del: async (k: string) => { m.delete(k); },
  };
  const deps: GsSweepDeps = {
    env: o.env ?? ON, kv,
    prep: {
      intake: async () => ({ kind: "unknown", reason: "x" }),
      notices: async () => { calls.push("notices"); return { kind: "ok", value: o.notices ?? [] }; },
      decide: async (_id, req) => { calls.push(`decide ${req.decision}`); return { kind: "ok", value: { status: "x" } }; },
      cases: async (id, req) => { calls.push(`cases ${id === tid ? "tid" : id} ${req.count}`); return (o.cases as never) ?? { kind: "ok", value: { status: "事例あり" } }; },
      casesAck: async (id) => { calls.push(`ack ${id === tid ? "tid" : id}`); return { kind: "ok", value: { status: "完了" } }; },
    },
    push: async (to, messages, key) => { pushes.push({ to, messages, key }); const s = pushSeq.length ? pushSeq.shift()! : 200; return s; },
    now: () => NOW,
    satei: {
      dealsDbId: DB,
      readDeal: async () => ({ deal, kind: o.kind ?? "マンション" }),
      intake: async (req) => { intakes.push(req); return (o.intake as never) ?? { kind: "ok", value: { created: true, no: 12, status: "受付" } }; },
    },
    log: (l) => logs.push(l),
  };
  return { deps, kv, m, sets, lists, pushes, calls, intakes, logs };
}
const ticket = (x: ReturnType<typeof mk>, id = tid) => asTicket(x.m.get(gsTicketKey(id)))!;
const items = (x: ReturnType<typeof mk>, id = tid) => (x.lists.get(gsCaseItemsKey(id)) ?? []).map((s) => JSON.parse(s) as Item);
const pdf = (id: string, at = NOW, quoted?: string) => ({ messageId: id, kind: "pdf" as const, senderId: STAFF, at, ...(quoted ? { quoted } : {}) });
const text0 = (p: { messages: unknown[] }) => (p.messages[0] as { text: string }).text;

(async () => {
  // ─── 結びつけ（markGsCasePdf） ───
  await t("待ちの票が1件：依頼より後の PDF を結びついた順に caseitems へ（同じ messageId は足さない）。見回りの集合に戻す", async () => {
    const x = mk();
    x.sets.get(GS_STAGE2_SET)!.delete(tid);
    const d = { env: ON, kv: x.kv, push: x.deps.push, log: (l: string) => x.logs.push(l) };
    await markGsCasePdf(pdf("p1"), G, d);
    await markGsCasePdf(pdf("p2", NOW + 5), G, d);
    await markGsCasePdf(pdf("p1"), G, d);
    await markGsCasePdf(pdf("old", NOW - 7_200_000), G, d);
    assert.deepEqual(items(x).map((i) => i.m), ["p1", "p2"]);
    assert.equal(x.sets.get(GS_STAGE2_SET)!.has(tid), true);
    assert.ok(x.logs.includes("[group-satei] cases linked G7 2"));
    // 2d の控え（リマインドの判定）も今までどおり
    assert.deepEqual(Array.from(x.sets.get(gsCasesKey(tid))!), ["p1", "p2"]);
    assert.equal(x.pushes.length, 0);
    assert.ok(x.logs.every((l) => !l.includes("p1") && !l.includes(STAFF)));
  });
  await t("待ちの票が2件で引用でも決まらない：caseitems に足さず、下村さんへ1回だけ（retry key ambig:<id>）", async () => {
    const x = mk();
    x.m.set(gsTicketKey(tid2), { ...waiting, no: 8, triggerMsgIds: ["m2"] });
    x.sets.get(gsWaitKey(G))!.add(tid2);
    const d = { env: ON, kv: x.kv, push: x.deps.push, log: (l: string) => x.logs.push(l) };
    await markGsCasePdf(pdf("p1"), G, d);
    await markGsCasePdf(pdf("p1"), G, d);
    // PDF が続いても、同じグループ・同じ日・同じ候補の組なら1回にまとめる
    await markGsCasePdf(pdf("p2", NOW + 60_000), G, d);
    await markGsCasePdf(pdf("p3", NOW + 120_000), G, d);
    assert.deepEqual([items(x).length, items(x, tid2).length], [0, 0]);
    const set = [tid, tid2].sort().join(",");
    assert.deepEqual(x.pushes.map((p) => [p.to, p.key, text0(p)]), [[SHIMO, `ambig:${G}:2026-11-26:${set}`, "どの受付のものか決められません（受付 G7・G8）。02 に入れてください"]]);
    assert.equal(x.m.has(gsAmbigKey(G, "2026-11-26", [tid2, tid])), true);
    // ログ・KV の鍵に messageId を増やさない
    assert.ok(Array.from(x.m.keys()).every((k) => !/p[123]/.test(k)));
    assert.ok(x.logs.includes("[group-satei] cases ambig 2"));
    assert.ok(x.logs.every((l) => !/p[123]/.test(l)));
  });
  await t("待ちの票が2件でも、依頼カードの messageId（cardMsgId）を引用した PDF はその票だけに", async () => {
    const x = mk({ prep: { cardMsgId: "card7" } });
    x.m.set(gsTicketKey(tid2), { ...waiting, no: 8, triggerMsgIds: ["m2"], prep: { ...prepW, cardMsgId: "card8" } });
    x.sets.get(gsWaitKey(G))!.add(tid2);
    await markGsCasePdf(pdf("p1", NOW, "card8"), G, { env: ON, kv: x.kv, push: x.deps.push, log: () => undefined });
    assert.deepEqual([items(x).length, items(x, tid2).map((i) => i.m)], [0, ["p1"]]);
    assert.equal(x.pushes.length, 0);
  });
  await t("off（groupSateiPrepOn が偽）なら何も読まない・書かない", async () => {
    const x = mk();
    let touched = 0;
    const kv = new Proxy(x.kv, { get: (tg, p) => { touched++; return (tg as Record<string | symbol, unknown>)[p]; } });
    await markGsCasePdf(pdf("p1"), G, { env: OFF, kv, push: x.deps.push, log: () => undefined });
    assert.deepEqual([touched, x.pushes.length], [0, 0]);
  });

  // ─── portal へ渡す（見回り） ───
  await t("最後の PDF から2分たつまでは渡さない。たったら cases {count:n} を1回だけ・casesHanded を残す", async () => {
    const a = mk({ items: [{ m: "p1", at: NOW - 60_000 }] });
    await sweepGsStage2(a.deps);
    assert.deepEqual(a.calls, []);
    const x = mk({ items: [{ m: "p1", at: NOW - 200_000 }, { m: "p2", at: NOW - 130_000 }] });
    await sweepGsStage2(x.deps);
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.calls.filter((c) => c.startsWith("cases")), ["cases tid 2"]);
    assert.deepEqual([ticket(x).prep!.casesHanded, ticket(x).prep!.casesHandedAt, ticket(x).state], [2, NOW, "waiting-cases"]);
    assert.ok(x.logs.includes("[group-satei] cases handed G7 2"));
  });
  await t("結びついた PDF がある票は、期日を過ぎても催促しない", async () => {
    const x = mk({ prep: { deadline: NOW - 1 }, items: [{ m: "p1", at: NOW - 60_000 }] });
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes.length, 0);
    assert.equal(x.sets.get(GS_STAGE2_SET)!.has(tid), true);
  });
  await t("PREP_CLOSED はログだけ（渡せていたことにして結果を待つ）。結果不明は次の回にもう一度", async () => {
    const x = mk({ items: [{ m: "p1", at: NOW - 200_000 }], cases: { kind: "rejected", status: 409, code: "PREP_CLOSED" } });
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes.length, 0);
    assert.equal(ticket(x).prep!.casesHanded, 1);
    assert.ok(x.logs.includes("[group-satei] cases closed G7"));
    const u = mk({ items: [{ m: "p1", at: NOW - 200_000 }], cases: { kind: "unknown", reason: "timeout" } });
    await sweepGsStage2(u.deps);
    await sweepGsStage2(u.deps);
    assert.equal(u.calls.filter((c) => c.startsWith("cases")).length, 2);
    assert.equal(ticket(u).prep!.casesHanded, undefined);
  });
  await t("ほかに断られた（PREP_STALE）：手作業にして下村さんへ「取り出せませんでした」", async () => {
    const x = mk({ items: [{ m: "p1", at: NOW - 200_000 }], cases: { kind: "rejected", status: 409, code: "PREP_STALE" } });
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.pushes.map((p) => [p.to, p.key, text0(p)]), [[SHIMO, `cases:${tid}`, "事例の PDF を取り出せませんでした。案件フォルダの 02 に入れてください（受付 G7）"]]);
    assert.equal(ticket(x).state, "manual");
    assert.equal(x.sets.get(GS_STAGE2_SET)!.has(tid), false);
  });

  // ─── 結果の知らせ ───
  const handedPrep = { casesHanded: 3, casesHandedAt: NOW - 600_000 };
  const three = [{ m: "p1", at: 1 }, { m: "p2", at: 2 }, { m: "p3", at: 3 }];
  await t("保存済み・マンション：段1と同じ受付（eventId gs<tid>・requestedBy は下村さん）→ started・#J・ack・見回りから外す", async () => {
    const x = mk({ prep: handedPrep, items: three, notices: [SAVED] });
    await sweepGsStage2(x.deps);
    assert.equal(x.intakes.length, 1);
    assert.deepEqual(x.intakes[0], { eventId: `gs${tid}`, dealId: DEAL, dealNo: 12, folderId: "folder_abcdefghij", dealName: "山田様 売却", requestedBy: SHIMO });
    assert.deepEqual(x.pushes.map((p) => [p.to, p.key, text0(p)]), [[SHIMO, `cases:${tid}`, "事例を保存しました（成約 2件・売出 1件）。下書きを作ります（受付 G7・#J12）"]]);
    assert.deepEqual([ticket(x).state, ticket(x).jobNo, ticket(x).prep!.casesDone], ["started", 12, true]);
    assert.ok(x.calls.includes("ack tid"));
    assert.equal(x.sets.get(GS_STAGE2_SET)!.has(tid), false);
    assert.equal(x.sets.get(gsWaitKey(G))!.has(tid), false);
    assert.ok(x.logs.includes("[group-satei] cases saved G7 2/1/0"));
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes.length, 1);
    // グループには何も送らない
    assert.ok(x.pushes.every((p) => p.to !== G));
  });
  await t("保存済み・マンション：TASK_SATEI off／受付に断られた → 手作業の案内（［査定書を作る］）", async () => {
    const msg = "事例を保存しました（成約 2件・売出 1件）。下書きを始められませんでした。案件カードの［査定書を作る］を押してください（受付 G7）";
    const a = mk({ prep: handedPrep, items: three, notices: [SAVED], env: { ...ON, TASK_SATEI: "" } });
    await sweepGsStage2(a.deps);
    assert.deepEqual([a.intakes.length, text0(a.pushes[0]), ticket(a).state], [0, msg, "manual"]);
    const b = mk({ prep: handedPrep, items: three, notices: [SAVED], intake: { kind: "rejected", status: 409, code: "X" } });
    await sweepGsStage2(b.deps);
    assert.deepEqual([b.intakes.length, text0(b.pushes[0]), ticket(b).state], [1, msg, "manual"]);
  });
  await t("保存済み・マンション：受付の結果不明は次の回にもう1回（同じ eventId・casesDraftTries）。2回目も不明なら「確かめられませんでした」", async () => {
    const x = mk({ prep: handedPrep, items: three, notices: [SAVED], intake: { kind: "unknown", reason: "timeout" } });
    await sweepGsStage2(x.deps);
    assert.deepEqual([x.pushes.length, ticket(x).prep!.casesDraftTries, ticket(x).prep!.casesPushTries], [0, 1, undefined]);
    await sweepGsStage2(x.deps);
    assert.equal(x.intakes.length, 2);
    assert.equal(
      text0(x.pushes[0]),
      "事例を保存しました（成約 2件・売出 1件）。下書きを始められたか確かめられませんでした。しばらくして #J の知らせが来なければ、案件カードの［査定書を作る］を押してください（受付 G7）",
    );
    assert.equal(ticket(x).state, "manual");
  });
  await t("保存済み・マンション：受付の不明で1回使っても、push は2回まで試す（受付と push は別に数える）", async () => {
    const x = mk({ prep: handedPrep, items: three, notices: [SAVED], push: [500, 200] });
    const seq: unknown[] = [{ kind: "unknown", reason: "timeout" }, { kind: "ok", value: { created: true, no: 12, status: "受付" } }, { kind: "ok", value: { created: false, no: 12, status: "受付" } }];
    x.deps.satei!.intake = async (req) => { x.intakes.push(req); return seq.shift() as never; };
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes.length, 0);
    await sweepGsStage2(x.deps);
    assert.deepEqual([x.pushes.length, ticket(x).state, ticket(x).prep!.casesPushTries], [1, "waiting-cases", 1]);
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes.length, 2);
    assert.deepEqual([ticket(x).state, ticket(x).jobNo, ticket(x).prep!.casesDone], ["started", 12, true]);
    assert.ok(x.intakes.every((r) => r.eventId === `gs${tid}`));
  });
  await t("保存済み・戸建／土地：下書きは自動で作れない案内（受付は呼ばない）", async () => {
    const x = mk({ prep: { ...handedPrep, kind: "戸建" }, items: three, notices: [SAVED] });
    await sweepGsStage2(x.deps);
    assert.equal(x.intakes.length, 0);
    assert.equal(text0(x.pushes[0]), "事例を保存しました（成約 2件・売出 1件）。戸建の下書きは自動で作れません。資料は 01・02 にそろえました（受付 G7）");
    assert.equal(ticket(x).state, "manual");
    const y = mk({ prep: { ...handedPrep, kind: "土地" }, items: three, notices: [SAVED] });
    await sweepGsStage2(y.deps);
    assert.ok(text0(y.pushes[0]).includes("土地の下書きは自動で作れません"));
  });
  await t("取り出せなかった分・あとから貼られた分（E4）の行を足す", async () => {
    const x = mk({ prep: { ...handedPrep, kind: "土地" }, items: [...three, { m: "p4", at: 4 }, { m: "p5", at: 5 }], notices: [{ ...SAVED, cases: { contract: 1, listing: 1, failed: 1 } }] });
    await sweepGsStage2(x.deps);
    assert.equal(
      text0(x.pushes[0]),
      "事例を保存しました（成約 1件・売出 1件）。土地の下書きは自動で作れません。資料は 01・02 にそろえました（受付 G7）\n取り出せなかった PDF が 1件あります。02 に入れてください\n保存していない PDF が 2件あります。02 に入れてください",
    );
  });
  await t("事例失敗：手作業・「取り出せませんでした」・ack", async () => {
    const x = mk({ prep: handedPrep, items: three, notices: [{ ...SAVED, status: "事例失敗", cases: null, casesFailReason: "fetch" }] });
    await sweepGsStage2(x.deps);
    assert.equal(text0(x.pushes[0]), "事例の PDF を取り出せませんでした。案件フォルダの 02 に入れてください（受付 G7）");
    assert.equal(ticket(x).state, "manual");
    assert.ok(x.calls.includes("ack tid"));
    assert.ok(x.logs.includes("[group-satei] cases failed G7 fetch"));
  });
  await t("保存していない PDF の数は portal の casesCount から（PREP_CLOSED で casesHanded が多めでも）", async () => {
    const x = mk({ prep: { ...handedPrep, kind: "土地" }, items: three, notices: [{ ...SAVED, casesCount: 2, cases: { contract: 2, listing: 0, failed: 0 } }] });
    await sweepGsStage2(x.deps);
    assert.equal(text0(x.pushes[0]), "事例を保存しました（成約 2件・売出 0件）。土地の下書きは自動で作れません。資料は 01・02 にそろえました（受付 G7）\n保存していない PDF が 1件あります。02 に入れてください");
    const f = mk({ prep: handedPrep, items: three, notices: [{ ...SAVED, status: "事例失敗", cases: null, casesFailReason: "fetch", casesCount: 1 }] });
    await sweepGsStage2(f.deps);
    assert.equal(text0(f.pushes[0]), "事例の PDF を取り出せませんでした。案件フォルダの 02 に入れてください（受付 G7）\n保存していない PDF が 2件あります。02 に入れてください");
    // casesCount が null なら casesHanded を使う
    const n2 = mk({ prep: { ...handedPrep, casesHanded: 2 }, items: three, notices: [{ ...SAVED, status: "事例失敗", cases: null, casesFailReason: "fetch", casesCount: null }] });
    await sweepGsStage2(n2.deps);
    assert.ok(text0(n2.pushes[0]).endsWith("保存していない PDF が 1件あります。02 に入れてください"));
  });
  const SLOW = "事例の PDF の保存がまだ終わっていません。Mac の様子を見るか、案件フォルダの 02 に入れてください（受付 G7）";
  await t("渡してから30分たっても結果が無ければ、下村さんへ1回だけ（cases-late:<tid>）。票は閉じない。あとで結果が来れば今の道で閉じる", async () => {
    const early = mk({ prep: { casesHanded: 3, casesHandedAt: NOW - 29 * 60_000 }, items: three, notices: [] });
    await sweepGsStage2(early.deps);
    assert.equal(early.pushes.length, 0);
    const x = mk({ prep: { casesHanded: 3, casesHandedAt: NOW - 31 * 60_000 }, items: three, notices: [] });
    await sweepGsStage2(x.deps);
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.pushes.map((p) => [p.to, p.key, text0(p)]), [[SHIMO, `cases-late:${tid}`, SLOW]]);
    assert.deepEqual([ticket(x).state, ticket(x).prep!.casesLateNotified], ["waiting-cases", true]);
    assert.equal(x.sets.get(GS_STAGE2_SET)!.has(tid), true);
    assert.ok(x.logs.includes("[group-satei] cases late G7"));
    // 一覧が取れないあいだも知らせる
    const lf = mk({ prep: { casesHanded: 3, casesHandedAt: NOW - 31 * 60_000 }, items: three });
    lf.deps.prep!.notices = async () => ({ kind: "unknown", reason: "timeout" });
    await sweepGsStage2(lf.deps);
    assert.deepEqual(lf.pushes.map((p) => p.key), [`cases-late:${tid}`]);
    // 結果が来たら今の知らせで閉じる
    const y = mk({ prep: { casesHanded: 3, casesHandedAt: NOW - 31 * 60_000, casesLateNotified: true }, items: three, notices: [SAVED] });
    await sweepGsStage2(y.deps);
    assert.deepEqual([y.pushes.map((p) => p.key), ticket(y).state], [[`cases:${tid}`], "started"]);
  });
  await t("渡す前の結果不明（hand-unknown）が続く票も、最後の PDF から30分で同じ知らせに乗る", async () => {
    const x = mk({ items: [{ m: "p1", at: NOW - 40 * 60_000 }, { m: "p2", at: NOW - 31 * 60_000 }], cases: { kind: "unknown", reason: "timeout" } });
    await sweepGsStage2(x.deps);
    await sweepGsStage2(x.deps);
    assert.equal(x.calls.filter((c) => c.startsWith("cases")).length, 2);
    assert.deepEqual(x.pushes.map((p) => [p.key, text0(p)]), [[`cases-late:${tid}`, SLOW]]);
    assert.equal(ticket(x).prep!.casesHanded, undefined);
    // 30分たつ前は知らせない
    const y = mk({ items: [{ m: "p1", at: NOW - 29 * 60_000 }], cases: { kind: "unknown", reason: "timeout" } });
    await sweepGsStage2(y.deps);
    assert.equal(y.pushes.length, 0);
  });
  await t("結果の知らせ（finishCases）は、見回りの残りが30秒以上あるときだけ・1回の見回りで1件だけ", async () => {
    const late = mk({ prep: handedPrep, items: three, notices: [SAVED] });
    late.deps.startedAt = NOW - 21_000;
    await sweepGsStage2(late.deps);
    assert.deepEqual([late.pushes.length, late.intakes.length, ticket(late).state], [0, 0, "waiting-cases"]);
    const ok = mk({ prep: handedPrep, items: three, notices: [SAVED] });
    ok.deps.startedAt = NOW - 20_000;
    await sweepGsStage2(ok.deps);
    assert.equal(ok.pushes.length, 1);
    // 2件そろっていても1件だけ
    const two = mk({ prep: handedPrep, items: three, notices: [SAVED, { ...SAVED, tid: tid2, no: 8 }] });
    two.m.set(gsTicketKey(tid2), { ...waiting, no: 8, triggerMsgIds: ["m2"], prep: { ...prepW, ...handedPrep } });
    two.lists.set(gsCaseItemsKey(tid2), three.map((v) => JSON.stringify(v)));
    two.sets.get(GS_STAGE2_SET)!.add(tid2);
    await sweepGsStage2(two.deps);
    assert.equal(two.pushes.filter((p) => p.key.startsWith("cases:")).length, 1);
    await sweepGsStage2(two.deps);
    assert.equal(two.pushes.filter((p) => p.key.startsWith("cases:")).length, 2);
  });
  await t("知らせの push は2回まで（同じ retry key）。2回だめなら諦めて閉じる（ログは符号だけ）", async () => {
    const x = mk({ prep: handedPrep, items: three, notices: [SAVED], push: [500, null, 200] });
    await sweepGsStage2(x.deps);
    assert.equal(ticket(x).state, "waiting-cases");
    await sweepGsStage2(x.deps);
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.pushes.map((p) => p.key), [`cases:${tid}`, `cases:${tid}`]);
    assert.deepEqual([ticket(x).state, ticket(x).prep!.casesDone], ["started", true]);
    assert.ok(x.logs.includes("[group-satei] cases push-failed G7 gave-up"));
  });
  await t("一覧は1回の見回りで1回だけ（案の配達と結果で共有）", async () => {
    const x = mk({ prep: handedPrep, items: three, notices: [SAVED] });
    const g = ticketIdOf("m3");
    x.m.set(gsTicketKey(g), { ...waiting, state: "gathering", triggerMsgIds: ["m3"], prepAt: NOW, prep: { ...prepW, rev: 0, sentRev: 0, tries: 0, groupPushes: 0 } });
    x.sets.get(GS_STAGE2_SET)!.add(g);
    await sweepGsStage2(x.deps);
    assert.equal(x.calls.filter((c) => c === "notices").length, 1);
  });
  await t("off なら見回りは何もしない", async () => {
    const x = mk({ prep: handedPrep, items: three, notices: [SAVED], env: OFF });
    await sweepGsStage2(x.deps);
    assert.deepEqual([x.calls, x.pushes.length], [[], 0]);
  });

  // ─── ［いいよ］の依頼カードの messageId（E3） ───
  await t("［いいよ］：push の応答の messageId（最後の1通＝カード）を prep.cardMsgId に残す", async () => {
    const m = new Map<string, unknown>();
    m.set(gsTicketKey(tid), { ...waiting, state: "proposing", prep: { ...prepW, deadline: undefined, requestedAt: undefined, groupPushes: 0 } });
    const sentTo: string[] = [];
    const deps: GsActionDeps = {
      env: ON,
      kv: {
        get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, setNx: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
        incr: async () => 1, expire: async () => undefined, sadd: async () => undefined, srem: async () => undefined, del: async (k) => { m.delete(k); },
        lpushTrim: async () => undefined, lrange: async () => [],
      },
      dealsDbId: DB, readDeal: async () => null, intake: async () => ({ kind: "unknown", reason: "x" }), loadDeals: async () => [],
      reserve: async () => ({ proceed: true }), complete: async () => undefined, reply: async () => undefined, log: () => undefined,
      push: async () => 200,
      pushIds: async (to) => { sentTo.push(to); return { status: 200, ids: ["txt1", "card1"] }; },
      now: () => NOW,
    };
    await handleGroupSateiPostback({ op: "gy", tid, ver: 1, rev: 1 }, { replyToken: "r", webhookEventId: "e1", source: { userId: SHIMO } }, deps);
    const tk = asTicket(m.get(gsTicketKey(tid)))!;
    assert.deepEqual([tk.state, tk.prep!.cardMsgId, sentTo], ["waiting-cases", "card1", [G]]);
  });

  // ─── 取り出しの口（/api/satei/media） ───
  const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(100, 1)]);
  function mdeps(o: { res?: () => Response | Promise<Response>; ticket?: Partial<GsTicket> | null; items?: Item[]; env?: Record<string, string> } = {}) {
    const fetched: string[] = [];
    const logs: string[] = [];
    const deps: GsMediaDeps = {
      env: o.env ?? ON,
      kv: {
        get: async (k) => (k === gsTicketKey(tid) && o.ticket !== null ? { ...waiting, ...(o.ticket ?? {}) } : null),
        lrange: async (k) => (k === gsCaseItemsKey(tid) ? (o.items ?? [{ m: "p1", at: 1 }, { m: "p2", at: 2 }]).map((x) => JSON.stringify(x)) : []),
      },
      fetchContent: async (id) => { fetched.push(id); return o.res ? o.res() : new Response(PDF, { status: 200 }); },
      log: (l) => logs.push(l),
    };
    return { deps, fetched, logs };
  }
  const H = gsMediaToken(JOB);
  const body = (index: number, id = tid) => JSON.stringify({ tid: id, index });
  await t("口：合言葉が違う・JOB_API_TOKEN が32字未満なら 401（LINE を呼ばない）", async () => {
    const x = mdeps();
    assert.equal((await handleGsMedia("x", body(1), x.deps)).status, 401);
    assert.equal((await handleGsMedia(null, body(1), x.deps)).status, 401);
    const short = "s".repeat(31);
    assert.equal((await handleGsMedia(gsMediaToken(short), body(1), { ...x.deps, env: { ...ON, JOB_API_TOKEN: short } })).status, 401);
    assert.equal(x.fetched.length, 0);
  });
  await t("口：off は 503 OFF／形が違えば 400／受付票が無い・待ちでない・index 番目が無い → 404", async () => {
    assert.deepEqual(await handleGsMedia(H, body(1), mdeps({ env: OFF }).deps), { status: 503, code: "OFF" });
    assert.equal((await handleGsMedia(H, body(0), mdeps().deps)).status, 400);
    assert.equal((await handleGsMedia(H, body(11), mdeps().deps)).status, 400);
    assert.equal((await handleGsMedia(H, "{", mdeps().deps)).status, 400);
    assert.deepEqual(await handleGsMedia(H, body(1), mdeps({ ticket: null }).deps), { status: 404, code: "NOT_FOUND" });
    assert.deepEqual(await handleGsMedia(H, body(1), mdeps({ ticket: { state: "started" } }).deps), { status: 404, code: "NOT_FOUND" });
    assert.deepEqual(await handleGsMedia(H, body(3), mdeps().deps), { status: 404, code: "NOT_FOUND" });
  });
  await t("口：index 番目（結びついた順）の PDF のバイトを返す", async () => {
    const x = mdeps();
    const r = await handleGsMedia(H, body(2), x.deps);
    assert.equal(r.status, 200);
    assert.ok("pdf" in r && r.pdf.equals(PDF));
    assert.deepEqual(x.fetched, ["p2"]);
    assert.ok(x.logs.includes("[group-satei] media G7 2 ok"));
    assert.ok(x.logs.every((l) => !l.includes("p2")));
  });
  await t("口：LINE の 404/410 → 410 GONE、500 → 502、例外（時間切れ）→ 502、%PDF でない → 415", async () => {
    assert.deepEqual(await handleGsMedia(H, body(1), mdeps({ res: () => new Response("", { status: 404 }) }).deps), { status: 410, code: "GONE" });
    assert.deepEqual(await handleGsMedia(H, body(1), mdeps({ res: () => new Response("", { status: 410 }) }).deps), { status: 410, code: "GONE" });
    assert.deepEqual(await handleGsMedia(H, body(1), mdeps({ res: () => new Response("", { status: 500 }) }).deps), { status: 502, code: "UPSTREAM" });
    assert.deepEqual(await handleGsMedia(H, body(1), mdeps({ res: () => { throw new Error("TimeoutError"); } }).deps), { status: 502, code: "UPSTREAM" });
    assert.deepEqual(await handleGsMedia(H, body(1), mdeps({ res: () => new Response(Buffer.from("PK\x03\x04zip"), { status: 200 }) }).deps), { status: 415, code: "NOT_PDF" });
  });
  await t("口：4MB を超えたら読むのを止めて 413（残りを読まない）", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    chunk.set(Buffer.from("%PDF"));
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { pulled++; if (pulled > 50) c.close(); else c.enqueue(chunk); },
    }, { highWaterMark: 0 });
    const r = await handleGsMedia(H, body(1), mdeps({ res: () => new Response(stream, { status: 200 }) }).deps);
    assert.deepEqual(r, { status: 413, code: "TOO_LARGE" });
    assert.ok(pulled <= 6, String(pulled));
    // ちょうど 4MB は通る
    const exact = Buffer.alloc(4 * 1024 * 1024);
    exact.write("%PDF");
    assert.equal((await handleGsMedia(H, body(1), mdeps({ res: () => new Response(exact, { status: 200 }) }).deps)).status, 200);
  });

  await t("口：KV の読みは3秒まで（返らなければ 502 UPSTREAM。LINE を呼ばない）", async () => {
    const x = mdeps();
    const never = new Promise<never>(() => undefined);
    const r = await handleGsMedia(H, body(1), { ...x.deps, kv: { get: () => never, lrange: () => never }, kvTimeoutMs: 30 });
    assert.deepEqual([r, x.fetched.length], [{ status: 502, code: "UPSTREAM" }, 0]);
    const y = mdeps();
    const r2 = await handleGsMedia(H, body(1), { ...y.deps, kv: { get: y.deps.kv!.get, lrange: () => never }, kvTimeoutMs: 30 });
    assert.deepEqual(r2, { status: 502, code: "UPSTREAM" });
  });
  await t("口の route：合言葉を確かめてから本文を読む（違えば本文を読まずに 401）", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../src/app/api/satei/media/route");
    const saved = process.env.JOB_API_TOKEN;
    process.env.JOB_API_TOKEN = JOB;
    try {
      let read = 0;
      const req = new NextRequest("https://a.example.test/api/satei/media", { method: "POST", headers: { "x-satei-token": "wrong" }, body: body(1) });
      const orig = req.text.bind(req);
      req.text = async () => { read++; return orig(); };
      const r = await POST(req);
      assert.deepEqual([r.status, read], [401, 0]);
    } finally {
      if (saved === undefined) delete process.env.JOB_API_TOKEN; else process.env.JOB_API_TOKEN = saved;
    }
  });

  // ─── portal の口 ───
  function fake(status: number, resBody: unknown, calls: Array<{ url: string; init: RequestInit }>): typeof fetch {
    return (async (url: string, init: RequestInit) => { calls.push({ url, init }); return { status, ok: status < 300, json: async () => resBody } as Response; }) as unknown as typeof fetch;
  }
  const opts = (status: number, b: unknown, calls: Array<{ url: string; init: RequestInit }>) => ({ fetchImpl: fake(status, b, calls), baseUrl: "https://p.example.test", token: "k", timeoutMs: 1000 });
  await t("portal：cases {count}・cases-ack {} の口。409 は rejected（code つき）", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    assert.deepEqual(await sateiPrepCases(tid, { count: 3 }, opts(200, { status: "事例あり" }, calls)), { kind: "ok", value: { status: "事例あり" } });
    assert.equal(calls[0].url, `https://p.example.test/api/jobs/satei/prep/${tid}/cases`);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { count: 3 });
    assert.deepEqual(await sateiPrepCases(tid, { count: 3 }, opts(409, { code: "PREP_CLOSED" }, [])), { kind: "rejected", status: 409, code: "PREP_CLOSED" });
    const c2: Array<{ url: string; init: RequestInit }> = [];
    assert.deepEqual(await sateiPrepCasesAck(tid, opts(200, { status: "完了" }, c2)), { kind: "ok", value: { status: "完了" } });
    assert.equal(c2[0].url, `https://p.example.test/api/jobs/satei/prep/${tid}/cases-ack`);
    assert.deepEqual(JSON.parse(String(c2[0].init.body)), {});
  });
  await t("portal：一覧は事例保存済み・事例失敗の行も読む（cases の形が違う保存済みは捨てる）。相談中の行は段2d と同じ形", async () => {
    const good = { tid, no: 7, status: "相談中", lines: ["a"], areaDone: true, failReason: "", cases: null, casesFailReason: "" };
    const saved = { tid, no: 7, status: "事例保存済み", lines: [], areaDone: false, failReason: "", cases: { contract: 2, listing: 1, failed: 0 }, casesFailReason: "", casesCount: 3 };
    const failed = { ...saved, status: "事例失敗", cases: null, casesFailReason: "timeout", casesCount: null };
    const oldRow = { ...failed, casesCount: undefined };
    const badCount = { ...failed, casesCount: 11 };
    const r = await sateiPrepNotices(opts(200, { preps: [good, saved, failed, { ...saved, cases: { contract: -1, listing: 0, failed: 0 } }, oldRow, badCount] }, []));
    assert.deepEqual(r, {
      kind: "ok",
      value: [{ tid, no: 7, status: "相談中", lines: ["a"], areaDone: true, failReason: "" }, saved, failed, { ...failed }, { ...failed }],
    });
  });
  console.log(`${n} passed`);
})();
