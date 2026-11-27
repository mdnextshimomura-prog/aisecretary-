/**
 * 案件の自動登録（計画 2026-11-27 の A5-7・「途中で落ちたとき」）：毎分の見回り。
 * フォルダ → Notion に URL → 案のカード／書けないとき・作れなかったとき／落ちた票の続き／控えの送り直し。KV・Notion・portal・LINE は差し替え。
 */
import assert from "node:assert/strict";
import { autoHooks, type GsActionDeps } from "../src/lib/group-satei-actions";
import { sweepGsAuto, type GsAutoSweepDeps } from "../src/lib/group-satei-auto";
import type { GsAutoLinkResult } from "../src/lib/group-satei-auto-notion";
import { asTicket, GS_AUTO_SET, GS_STAGE2_SET, gsDecKey, gsOpenKey, gsTicketKey, ticketIdOf, type GsAuto, type GsTicket } from "../src/lib/group-satei-data";
import { GS_OUTBOX_SET, gsObKey, gsOutboxRetry } from "../src/lib/group-satei-outbox";
import { msgGsPrepFailed } from "../src/lib/group-satei-case";
import { sateiPrepNotices, type SateiPrepIntakeReq, type SateiPrepNotice } from "../src/lib/group-satei-prep-portal";
import { sweepGsStage2, type GsSweepDeps } from "../src/lib/group-satei-propose";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const G = "C" + "a".repeat(32);
const DB = "9999abcd0123456789ab0123456789ab";
const PROP = "aaaa0000aaaa0000aaaa0000aaaa0000";
const DEAL = "bbbb0000bbbb0000bbbb0000bbbb0000";
const FOLDER = "1AbC_dEf-GhIjKlMnOp";
const URL_ = `https://drive.google.com/drive/folders/${FOLDER}`;
const tid = ticketIdOf("m1");
const TID8 = tid.slice(0, 8);
const NOW = Date.UTC(2026, 10, 27, 1);
const MIN = 60_000;
const ON = {
  TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, GROUP_SATEI_STAGE2: "1", GROUP_SATEI_CASE_STAFF_ID: STAFF,
  CRM_DEALS_DB_ID: DB, CRM_PROPERTIES_DB_ID: "7777abcd0123456789ab0123456789ab", GROUP_SATEI_AUTO_DEAL: "1",
};
const OFF = { ...ON, GROUP_SATEI_AUTO_DEAL: "0" };
const facts = { roomNo: "1203", exclusiveArea: 65.3, landArea: null, buildingArea: null, builtYm: "2005-03", layout: null, floor: null, totalUnits: null, structure: null };
const read = { address: "大阪市北区天満2丁目3-4", propertyName: "パークハウス天満 1203", kind: "マンション" as const, basis: "本文" as const, confidence: 0.9, facts };
const AUTO: GsAuto = { step: "folder", at: NOW - MIN, tries: 1, propId: PROP, dealId: DEAL, dealNo: 231, linked: false };
const gathering: GsTicket = {
  no: 7, ver: 1, groupId: G, requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], state: "gathering", prepAt: NOW - MIN, dealId: DEAL, requestKind: "satei",
  read, prep: { kind: "マンション", rev: 0, lines: [], fixes: 0, sentRev: 0, tries: 0, groupPushes: 0 }, auto: AUTO,
};
const OKNT: SateiPrepNotice = { tid, no: 7, status: "相談中", lines: ["成約：同じマンション", "売出：5件ほど"], areaDone: true, failReason: "", newFolderId: FOLDER };

/** 文面（計画 A6。一字一句） */
const M4 = "案件 DEAL-0231 は登録しましたが、案件フォルダを作れませんでした（受付 G7）。フォルダを手で作り、CRM_案件 の Driveフォルダ に入れてください。山口さんへは手で頼んでください";
const M4_CONFIG = `${M4}（Mac の親フォルダの設定がありません）`;
const M5 = `案件 DEAL-0231 のフォルダは作りましたが、Notion に書けませんでした（受付 G7）。CRM_案件 の Driveフォルダ に次を入れてください：${URL_}`;
const M5_CONFLICT = `案件 DEAL-0231 のフォルダは作りましたが、Notion に書けませんでした（受付 G7）。CRM_案件 の Driveフォルダ に別のフォルダが入っています。新しく作ったフォルダは次です：${URL_}`;
const M6 = `案件 DEAL-0231 とフォルダは作ってあります。${msgGsPrepFailed(7)}`;
const M7 = "案件の自動登録が途中で止まりました（受付 G7）。カードの［一覧から選ぶ］で選ぶか、もう一度［査定］を押してください";
const M7_DEAL = "案件の自動登録が途中で止まりました（受付 G7）。CRM_案件 DEAL-0231 はできています。カードの［一覧から選ぶ］で選ぶか、もう一度［査定］を押してください";

function store(ticket: GsTicket) {
  const m = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  m.set(gsTicketKey(tid), ticket);
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
  return { m, sets, kv, ticket: () => asTicket(m.get(gsTicketKey(tid)))!, members: (k: string) => Array.from(sets.get(k) ?? []) };
}

/** 段2d の見回り（フォルダの URL を書く所） */
function mkS2(o: { ticket?: Partial<GsTicket>; nt?: SateiPrepNotice | null; link?: GsAutoLinkResult | "throw"; push?: number | null; env?: Record<string, string>; noLink?: boolean } = {}) {
  const s = store({ ...gathering, ...(o.ticket ?? {}) });
  s.sets.set(GS_STAGE2_SET, new Set([tid]));
  const pushes: Array<{ to: string; text?: string; key: string; card: boolean }> = [];
  const links: Array<[string, string, string]> = [];
  const calls: string[] = [];
  const logs: string[] = [];
  let now = NOW;
  const deps: GsSweepDeps = {
    env: o.env ?? ON, kv: s.kv,
    prep: {
      intake: async () => ({ kind: "unknown", reason: "x" }),
      notices: async () => ({ kind: "ok", value: o.nt === null ? [] : [o.nt ?? OKNT] }),
      decide: async (_id, req) => { calls.push(`decide ${req.decision}`); return { kind: "ok", value: { status: "x" } }; },
    },
    push: async (to, messages, key) => {
      const msg = messages[0] as { type: string; text?: string };
      pushes.push({ to, text: msg.text, key, card: msg.type === "flex" });
      return o.push === undefined ? 200 : o.push;
    },
    now: () => now,
    log: (l) => logs.push(l),
    autoLink: o.noLink ? null : async (dealId, folderId, mark) => {
      links.push([dealId, folderId, mark]);
      if (o.link === "throw") throw new Error("notion");
      return o.link ?? "linked";
    },
  };
  return { ...s, deps, pushes, links, calls, logs, tick: (ms = MIN) => { now += ms; } };
}

/** 落ちた票の続き */
function mkAuto(o: { auto: GsAuto; dec?: string | null; env?: Record<string, string>; now?: number; startedAt?: number; propFail?: boolean; dup?: boolean; intake?: unknown; push?: number | null; noNotion?: boolean }) {
  const s = store({ ...gathering, state: "asking", prep: undefined, prepAt: undefined, dealId: undefined, auto: o.auto });
  s.sets.set(GS_AUTO_SET, new Set([tid]));
  if (o.dec !== null) s.m.set(gsDecKey(tid), o.dec ?? `auto:${TID8}`);
  const order: string[] = [];
  const preps: SateiPrepIntakeReq[] = [];
  const pushes: Array<{ to: string; text: string; key: string }> = [];
  const logs: string[] = [];
  const replies: string[] = [];
  const autoDeal = o.noNotion ? null : {
    findOrCreateProperty: async () => { order.push("prop"); if (o.propFail) throw new Error("notion"); return { id: PROP }; },
    findOrCreateDeal: async () => { order.push("deal"); return o.dup ? { kind: "dup" as const } : { kind: "ok" as const, id: DEAL, dealNo: 231 }; },
    readDealNo: async () => 231,
    propTitle: async () => "パークハウス天満 1203",
    sleep: async () => undefined,
  };
  const ad: GsActionDeps = {
    env: o.env ?? ON, kv: s.kv, dealsDbId: DB,
    readDeal: async () => ({ deal: { id: DEAL, name: "査定｜顧客未定｜パークハウス天満 1203", dealNo: 231, folderId: null, propertyIds: [PROP], gone: false, parentDbId: DB }, kind: "マンション" }),
    intake: async () => { throw new Error("今の受付は呼ばない"); },
    loadDeals: async () => [],
    reserve: async () => ({ proceed: false }), complete: async () => undefined,
    reply: async (_t, text) => { replies.push(text); },
    log: (l) => logs.push(l),
    prep: {
      intake: async (req) => { order.push("portal"); preps.push(req); return (o.intake as never) ?? { kind: "ok", value: { created: true, status: "受付" } }; },
      notices: async () => ({ kind: "ok", value: [] }),
      decide: async () => ({ kind: "ok", value: { status: "x" } }),
    },
    now: () => o.now ?? NOW,
    autoDeal,
  };
  const deps = {
    env: o.env ?? ON, kv: s.kv, autoDeal, loadDeals: ad.loadDeals, readDeal: ad.readDeal,
    hooks: (id: string, userId: string) => autoHooks(id, userId, ad, s.kv),
    push: async (to: string, messages: unknown[], key: string) => { pushes.push({ to, text: (messages[0] as { text: string }).text, key }); return o.push === undefined ? 200 : o.push; },
    now: () => o.now ?? NOW,
    startedAt: o.startedAt,
    log: (l: string) => logs.push(l),
  } as unknown as GsAutoSweepDeps;
  return { ...s, deps, order, preps, pushes, logs, replies };
}
const STALE = NOW - 4 * MIN;

(async () => {
  await t("portal の一覧：newFolderId は ID のときだけ付く（null・形が違えば欄ごと無し＝今の行の形）", async () => {
    const row = { tid, no: 7, status: "相談中", lines: ["a"], areaDone: true, failReason: "" };
    const fetchImpl = (async () => ({ status: 200, ok: true, json: async () => ({ preps: [{ ...row, newFolderId: FOLDER }, { ...row, no: 8, newFolderId: null }, { ...row, no: 9, newFolderId: "a b" }, { ...row, no: 10, status: "失敗", failReason: "folder-create", newFolderId: FOLDER }] }) })) as unknown as typeof fetch;
    const r = await sateiPrepNotices({ fetchImpl, baseUrl: "https://p.example.test", token: "k", timeoutMs: 1000 });
    assert.deepEqual(r, { kind: "ok", value: [{ ...row, newFolderId: FOLDER }, { ...row, no: 8 }, { ...row, no: 9 }, { ...row, no: 10, status: "失敗", failReason: "folder-create", newFolderId: FOLDER }] });
  });

  await t("newFolderId つきの相談中 → Notion に URL と 作成済 → 案のカード（今の配達）", async () => {
    const x = mkS2();
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.links, [[DEAL, FOLDER, `票 ${TID8}`]]);
    assert.deepEqual(x.pushes.map((p) => [p.key, p.card]), [[`prop:${tid}:1`, true]]);
    const tk = x.ticket();
    assert.equal(tk.state, "proposing");
    assert.deepEqual(tk.auto, { ...AUTO, linked: true, step: "done", folderId: FOLDER });
    assert.ok(x.logs.includes("[group-satei] auto linked G7"));
    // 次の回は書かない
    await sweepGsStage2(x.deps);
    assert.equal(x.links.length, 1);
  });

  await t("同じ URL がもう入っている → 書かずに linked（案は出す）", async () => {
    const x = mkS2({ link: "same" });
    await sweepGsStage2(x.deps);
    assert.equal(x.ticket().auto?.linked, true);
    assert.equal(x.ticket().state, "proposing");
    assert.deepEqual(x.pushes.map((p) => p.key), [`prop:${tid}:1`]);
  });

  await t("Notion に書けない → その回は案を出さない → 5回目で M5（URL つき）→ 案を出す", async () => {
    const x = mkS2({ link: "throw" });
    for (let i = 1; i <= 4; i++) {
      await sweepGsStage2(x.deps);
      assert.equal(x.pushes.length, 0, `${i}回目は何も送らない`);
      assert.equal(x.ticket().state, "gathering");
      assert.equal(x.ticket().auto?.linkTries, i);
      assert.equal(x.ticket().auto?.linked, false);
      x.tick();
    }
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.pushes.map((p) => [p.key, p.text ?? "card"]), [[`auto-link:${tid}`, M5], [`prop:${tid}:1`, "card"]]);
    assert.equal(x.pushes[0].to, SHIMO);
    assert.equal(x.ticket().state, "proposing");
    assert.deepEqual([x.ticket().auto?.linked, x.ticket().auto?.linkNote, x.ticket().auto?.folderId], [true, "failed", FOLDER]);
    assert.equal(x.links.length, 5);
    assert.ok(x.logs.includes("[group-satei] auto link-failed G7"));
  });

  await t("Driveフォルダ に別の URL → 書かない・M5 の別の文・案は出す", async () => {
    const x = mkS2({ link: "conflict" });
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.pushes.map((p) => [p.key, p.text ?? "card"]), [[`auto-link:${tid}`, M5_CONFLICT], [`prop:${tid}:1`, "card"]]);
    assert.equal(x.ticket().auto?.linkNote, "conflict");
    assert.ok(x.logs.includes("[group-satei] auto link-conflict G7"));
  });

  await t("この流れで作った案件でない（備考に印が無い）→ 書かない・M5 で URL を知らせる", async () => {
    const x = mkS2({ link: "foreign" });
    await sweepGsStage2(x.deps);
    assert.equal(x.pushes[0].text, M5);
    assert.ok(x.logs.includes("[group-satei] auto link-failed G7 foreign"));
  });

  await t("失敗（folder-config・folder-create）でフォルダが無い → M4・手作業。Notion は呼ばない", async () => {
    for (const [reason, text, code] of [["folder-config", M4_CONFIG, "config"], ["folder-create", M4, "create"], ["internal", M4, "other"]]) {
      const x = mkS2({ nt: { tid, no: 7, status: "失敗", lines: [], areaDone: false, failReason: reason } });
      await sweepGsStage2(x.deps);
      assert.deepEqual(x.pushes.map((p) => [p.to, p.key, p.text]), [[SHIMO, `prepfail:${tid}`, text]]);
      assert.equal(x.links.length, 0);
      assert.equal(x.ticket().state, "manual");
      assert.deepEqual(x.calls, ["decide manual"]);
      assert.deepEqual(x.members(GS_STAGE2_SET), []);
      assert.ok(x.logs.includes(`[group-satei] auto folder-failed G7 ${code}`));
    }
  });

  await t("失敗だがフォルダはできている（newFolderId つき）→ URL を Notion に書いたうえで M6＋今の失敗の文", async () => {
    const x = mkS2({ nt: { tid, no: 7, status: "失敗", lines: [], areaDone: false, failReason: "folder-create", newFolderId: FOLDER } });
    await sweepGsStage2(x.deps);
    assert.deepEqual(x.links, [[DEAL, FOLDER, `票 ${TID8}`]]);
    assert.deepEqual(x.pushes.map((p) => [p.key, p.text]), [[`prepfail:${tid}`, M6]]);
    assert.equal(x.ticket().state, "manual");
    assert.equal(x.ticket().auto?.linked, true);
  });

  await t("auto の無い票は今と同じ（Notion を呼ばない・失敗の文も今のまま）", async () => {
    const x = mkS2({ ticket: { auto: undefined } });
    await sweepGsStage2(x.deps);
    assert.equal(x.links.length, 0);
    assert.equal(x.ticket().state, "proposing");
    const y = mkS2({ ticket: { auto: undefined }, nt: { tid, no: 7, status: "失敗", lines: [], areaDone: false, failReason: "folder" } });
    await sweepGsStage2(y.deps);
    assert.deepEqual(y.pushes.map((p) => p.text), [msgGsPrepFailed(7)]);
  });

  await t("スイッチ off・Notion の口が無い：auto のある票でも Notion を呼ばず、今の配達だけ", async () => {
    const x = mkS2({ env: OFF });
    await sweepGsStage2(x.deps);
    assert.equal(x.links.length, 0);
    assert.equal(x.ticket().state, "proposing");
    assert.equal(x.ticket().auto?.linked, false);
    const y = mkS2({ noLink: true });
    await sweepGsStage2(y.deps);
    assert.equal(y.ticket().state, "proposing");
  });

  await t("控え：M5 が送れなければ auto-link を積み、同じ retry key で文を作り直して送り直す", async () => {
    const x = mkS2({ link: "conflict", push: 500 });
    await sweepGsStage2(x.deps);
    assert.ok(x.members(GS_OUTBOX_SET).includes(`auto-link:${tid}`));
    const sent: Array<{ text: string; key: string }> = [];
    const e = x.m.get(gsObKey("auto-link", tid)) as { nextAt: number };
    await gsOutboxRetry({ kv: x.kv, to: SHIMO, push: async (_to, messages, key) => { sent.push({ text: (messages[0] as { text: string }).text, key }); return 200; }, now: () => e.nextAt + 1, startedAt: e.nextAt + 1, log: () => undefined });
    assert.deepEqual(sent, [{ text: M5_CONFLICT, key: `auto-link:${tid}` }]);
    assert.equal(x.members(GS_OUTBOX_SET).includes(`auto-link:${tid}`), false);
  });

  await t("落ちた票（step prop・3分）を続ける：物件 → 案件 → portal（newFolder）。返事・push はしない", async () => {
    const x = mkAuto({ auto: { step: "prop", at: STALE, tries: 1 } });
    await sweepGsAuto(x.deps);
    assert.deepEqual(x.order, ["prop", "deal", "portal"]);
    assert.deepEqual(x.preps[0].newFolder, { name: "DEAL-0231_売却_顧客未定_パークハウス天満 1203" });
    assert.equal(x.preps[0].requestedBy, SHIMO);
    const tk = x.ticket();
    assert.equal(tk.state, "gathering");
    assert.deepEqual([tk.auto?.step, tk.auto?.tries, tk.auto?.dealNo], ["folder", 2, 231]);
    assert.equal(x.m.get(gsDecKey(tid)), `prep:${DEAL}`);
    assert.deepEqual(x.members(GS_AUTO_SET), []);
    assert.deepEqual([x.pushes.length, x.replies.length], [0, 0]);
    assert.ok(x.logs.includes("[group-satei] auto resumed G7"));
  });

  await t("落ちた票（step deal・prep）は作れた分を作り直さない。足りない項目があっても聞かずに進める", async () => {
    const x = mkAuto({ auto: { step: "deal", at: STALE, tries: 1, propId: PROP } });
    await sweepGsAuto(x.deps);
    assert.deepEqual(x.order, ["deal", "portal"]);
    const y = mkAuto({ auto: { step: "prep", at: STALE, tries: 1, propId: PROP, dealId: DEAL, dealNo: 231 } });
    y.m.set(gsTicketKey(tid), { ...y.ticket(), read: { ...read, facts: { ...facts, exclusiveArea: null } } });
    await sweepGsAuto(y.deps);
    assert.deepEqual(y.order, ["portal"]);
    assert.equal(y.ticket().state, "gathering");
    // 印を prep: に書き換えたあと・受付票を書く前に落ちた票も続けられる
    const z = mkAuto({ auto: { step: "prep", at: STALE, tries: 1, propId: PROP, dealId: DEAL, dealNo: 231 }, dec: `prep:${DEAL}` });
    await sweepGsAuto(z.deps);
    assert.deepEqual(z.order, ["portal"]);
    assert.equal(z.ticket().state, "gathering");
  });

  await t("3分たっていない票・予算が足りないときは触らない", async () => {
    const x = mkAuto({ auto: { step: "prop", at: NOW - 2 * MIN, tries: 1 } });
    await sweepGsAuto(x.deps);
    assert.deepEqual([x.order.length, x.ticket().auto?.tries, x.members(GS_AUTO_SET).length], [0, 1, 1]);
    const y = mkAuto({ auto: { step: "prop", at: STALE, tries: 1 }, startedAt: NOW - 30_000 });
    await sweepGsAuto(y.deps);
    assert.deepEqual([y.order.length, y.ticket().auto?.tries], [0, 1]);
    assert.ok(y.logs.includes("[group-satei] auto sweep budget"));
  });

  await t("続きがその回もだめ → 印も集合もそのまま（次の回にもう一度）。3回でやめて M7・印が外れ asking に戻る", async () => {
    const x = mkAuto({ auto: { step: "prop", at: STALE, tries: 1 }, propFail: true });
    await sweepGsAuto(x.deps);
    assert.equal(x.ticket().auto?.tries, 2);
    assert.equal(x.m.get(gsDecKey(tid)), `auto:${TID8}`);
    assert.deepEqual(x.members(GS_AUTO_SET), [tid]);
    assert.equal(x.pushes.length, 0);
    // at が今になったので、すぐの回は待つ
    await sweepGsAuto(x.deps);
    assert.equal(x.ticket().auto?.tries, 2);
    const y = mkAuto({ auto: { step: "prop", at: STALE, tries: 3 }, propFail: true });
    y.m.set(gsTicketKey(tid), { ...y.ticket(), provisional: true });
    await sweepGsAuto(y.deps);
    assert.deepEqual(y.pushes, [{ to: SHIMO, text: M7, key: `auto-fail:${tid}` }]);
    const tk = y.ticket();
    assert.deepEqual([tk.state, tk.provisional, tk.auto?.step], ["asking", undefined, "gave-up"]);
    assert.equal(y.m.get(gsDecKey(tid)), undefined);
    assert.deepEqual(y.members(GS_AUTO_SET), []);
    assert.deepEqual(y.members(gsOpenKey(G)), [tid]);
    assert.equal(y.order.length, 0, "やめるときは Notion を呼ばない");
    assert.ok(y.logs.includes("[group-satei] auto gave-up G7"));
    const z = mkAuto({ auto: { step: "prep", at: STALE, tries: 3, propId: PROP, dealId: DEAL, dealNo: 231 } });
    await sweepGsAuto(z.deps);
    assert.equal(z.pushes[0].text, M7_DEAL);
  });

  await t("続きで portal に断られた・同じ物件の案件が見つかった → 続けられないので M7 で戻す（0通にしない）", async () => {
    const x = mkAuto({ auto: { step: "prep", at: STALE, tries: 1, propId: PROP, dealId: DEAL, dealNo: 231 }, intake: { kind: "rejected", status: 400, code: "INVALID_REQUEST" } });
    await sweepGsAuto(x.deps);
    assert.deepEqual(x.pushes.map((p) => [p.text, p.key]), [[M7_DEAL, `auto-fail:${tid}`]]);
    assert.equal(x.ticket().state, "asking");
    assert.equal(x.m.get(gsDecKey(tid)), undefined);
    const y = mkAuto({ auto: { step: "deal", at: STALE, tries: 1, propId: PROP }, dup: true });
    await sweepGsAuto(y.deps);
    assert.equal(y.pushes[0].text, M7);
    assert.equal(y.ticket().auto?.step, "gave-up");
  });

  await t("その場の失敗で印を外した票・もう進んだ票は、集合から外すだけ", async () => {
    const x = mkAuto({ auto: { step: "prop", at: STALE, tries: 1 }, dec: null });
    await sweepGsAuto(x.deps);
    assert.deepEqual([x.order.length, x.members(GS_AUTO_SET).length, x.pushes.length], [0, 0, 0]);
    const y = mkAuto({ auto: { step: "folder", at: STALE, tries: 1, propId: PROP, dealId: DEAL, dealNo: 231 } });
    await sweepGsAuto(y.deps);
    assert.deepEqual([y.order.length, y.members(GS_AUTO_SET).length], [0, 0]);
  });

  await t("off・Notion の口が無いときは何もしない（KV も読まない）", async () => {
    for (const o of [{ env: OFF }, { noNotion: true }]) {
      const x = mkAuto({ auto: { step: "prop", at: STALE, tries: 3 }, ...o });
      let reads = 0;
      const get = x.kv.get;
      x.kv.get = async (k: string) => { reads++; return get(k); };
      x.kv.smembers = async () => { reads++; return []; };
      await sweepGsAuto(x.deps);
      assert.deepEqual([reads, x.order.length, x.pushes.length, x.members(GS_AUTO_SET).length], [0, 0, 0, 1]);
    }
  });

  await t("控え：M7 が送れなければ auto-fail を積み、同じ retry key で送り直す。押し直して進んだあとは捨てる", async () => {
    const x = mkAuto({ auto: { step: "prep", at: STALE, tries: 3, propId: PROP, dealId: DEAL, dealNo: 231 }, push: null });
    await sweepGsAuto(x.deps);
    assert.ok(x.members(GS_OUTBOX_SET).includes(`auto-fail:${tid}`));
    const e = x.m.get(gsObKey("auto-fail", tid)) as { nextAt: number };
    const sent: Array<{ text: string; key: string }> = [];
    const retry = () => gsOutboxRetry({ kv: x.kv, to: SHIMO, push: async (_to, messages, key) => { sent.push({ text: (messages[0] as { text: string }).text, key }); return 200; }, now: () => e.nextAt + 1, startedAt: e.nextAt + 1, log: () => undefined });
    await retry();
    assert.deepEqual(sent, [{ text: M7_DEAL, key: `auto-fail:${tid}` }]);
    const y = mkAuto({ auto: { step: "prop", at: STALE, tries: 3 }, push: 500 });
    await sweepGsAuto(y.deps);
    y.m.set(gsTicketKey(tid), { ...y.ticket(), auto: { ...y.ticket().auto!, step: "prop" } });
    const e2 = y.m.get(gsObKey("auto-fail", tid)) as { nextAt: number };
    const sent2: unknown[] = [];
    await gsOutboxRetry({ kv: y.kv, to: SHIMO, push: async () => { sent2.push(1); return 200; }, now: () => e2.nextAt + 1, startedAt: e2.nextAt + 1, log: () => undefined });
    assert.deepEqual([sent2.length, y.members(GS_OUTBOX_SET).length], [0, 0]);
  });

  await t("ログに物件名・所在・フォルダ名・フォルダの ID・userId が出ない", async () => {
    const a = mkS2({ link: "conflict" });
    await sweepGsStage2(a.deps);
    const b = mkAuto({ auto: { step: "prop", at: STALE, tries: 1 } });
    await sweepGsAuto(b.deps);
    const c = mkAuto({ auto: { step: "prop", at: STALE, tries: 3 } });
    await sweepGsAuto(c.deps);
    const logs = [...a.logs, ...b.logs, ...c.logs].join("\n");
    for (const bad of ["パークハウス", "天満", "大阪市", "顧客未定", FOLDER, SHIMO, DEAL, PROP]) assert.equal(logs.includes(bad), false, bad);
  });

  console.log(`group-satei-auto-sweep: ${n} 件 OK`);
})().catch((e) => { console.error(e); process.exit(1); });
