/** group-satei-open.ts（KV・AI・CRM・LINE は差し替え） */
import assert from "node:assert/strict";
import { openGroupSatei, recordGroupSateiMedia, type GsKv, type GsOpenDeps } from "../src/lib/group-satei-open";
import { asTicket, gsMediaKey, gsOpenKey, gsTicketKey, parseGsData, ticketIdOf, type GsRead } from "../src/lib/group-satei-data";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const G = "C" + "a".repeat(32);
const SHIMO = "U" + "b".repeat(32);
const BOSS = "U" + "c".repeat(32);
const ENV = { GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, TASK_SATEI_USER_IDS: SHIMO, TASK_SATEI: "1" };
const NOW = 1_800_000_000_000;
// 読んだ物件名と完全一致する名前にしておく（normalizeProperty の部分一致の規則にテストが左右されないため）
const D1 = { id: "0123abcd0123456789ab0123456789ab", name: "テスト町1丁目", phase: "査定" };

function fakeKv() {
  const m = new Map<string, unknown>();
  const kv: GsKv = {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => { m.set(k, v); },
    setNx: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
    incr: async (k) => { const v = Number(m.get(k) ?? 0) + 1; m.set(k, v); return v; },
    expire: async () => undefined,
    sadd: async (k, v) => { const s = (m.get(k) as Set<string>) ?? new Set(); s.add(v); m.set(k, s); },
    lpushTrim: async (k, v, max) => { const a = ((m.get(k) as unknown[]) ?? []); a.push(v); m.set(k, a.slice(-max)); },
    lrange: async (k) => ((m.get(k) as unknown[]) ?? []),
  };
  return { kv, m };
}
const READ: GsRead = { address: "大阪市北区テスト1丁目2", propertyName: "テスト町1丁目", kind: "戸建", basis: "登記", confidence: 0.9 };

function mk(o: { read?: GsRead | "throw"; deals?: "throw"; push?: boolean; reads?: number } = {}) {
  const { kv, m } = fakeKv();
  const logs: string[] = [];
  const pushes: Array<{ to: string; messages: unknown[]; key: string }> = [];
  const readCalls: string[][] = [];
  if (o.reads) m.set("gsatei:reads:2026-11-24", o.reads);
  const deps: GsOpenDeps = {
    env: ENV,
    kv,
    now: () => NOW,
    today: () => "2026-11-24",
    ymd: () => "2026-11-24",
    read: async (ids) => { readCalls.push(ids); if (o.read === "throw") throw new Error("x"); return o.read ?? READ; },
    loadDeals: async () => { if (o.deals === "throw") throw new Error("x"); return [D1]; },
    kindOf: async () => "戸建",
    requesterName: async () => "前田",
    push: async (to, messages, key) => { pushes.push({ to, messages, key }); return o.push ?? true; },
    log: (l) => logs.push(l),
  };
  return { deps, kv, m, logs, pushes, readCalls };
}
const ev = (over = {}) => ({ messageId: "m1", groupId: G, requesterId: BOSS, at: NOW, text: "査定お願いできますか", entry: "B" as const, ...over });

(async () => {
  await t("控え：30件で切る（グループの絞り込みは呼ぶ側の仕事）", async () => {
    const { kv, m } = mk();
    for (let i = 0; i < 35; i++) await recordGroupSateiMedia({ messageId: `i${i}`, kind: "image", senderId: BOSS, at: NOW }, G, kv, () => undefined);
    assert.equal((m.get(gsMediaKey(G)) as unknown[]).length, 30);
  });
  await t("開く：受付票・知らせ・カードを下村さんへ1回", async () => {
    const x = mk();
    await recordGroupSateiMedia({ messageId: "img1", kind: "image", senderId: BOSS, at: NOW - 60_000 }, G, x.kv, () => undefined);
    assert.equal(await openGroupSatei(ev(), x.deps), "opened");
    const tk = asTicket(x.m.get(gsTicketKey(ticketIdOf("m1"))))!;
    assert.equal(tk.state, "asking");
    assert.equal(tk.no, 1);
    assert.deepEqual(tk.mediaIds, ["img1"]);
    assert.equal(tk.read?.kind, "戸建");
    assert.deepEqual(x.readCalls, [["img1"]]);
    assert.equal(x.pushes.length, 1);
    assert.equal(x.pushes[0].to, SHIMO);
    assert.equal(x.pushes[0].messages.length, 2);
    const btn = (x.pushes[0].messages[1] as any).contents.footer.contents[0];
    assert.equal(parseGsData(btn.action.data)?.op, "gs");
    assert.match(btn.action.label, /で進める（手作業）$/);
    assert.ok(x.logs.some((l) => /^\[group-satei\] ticket G1 opened/.test(l)));
    const gn = (x.pushes[0].messages[1] as any).contents.footer.contents.find((b: any) => parseGsData(b.action.data)?.op === "gn");
    assert.match(gn.action.displayText, /受付 G/);
  });
  await t("同じ発言で二度開かない", async () => {
    const x = mk();
    await openGroupSatei(ev(), x.deps);
    assert.equal(await openGroupSatei(ev(), x.deps), "duplicate");
    assert.equal(x.pushes.length, 1);
  });
  await t("画像があって読めなくても黙らない（カードは一覧・案件なし・査定ではない）", async () => {
    const x = mk({ read: "throw" });
    await recordGroupSateiMedia({ messageId: "img1", kind: "image", senderId: BOSS, at: NOW - 60_000 }, G, x.kv, () => undefined);
    await openGroupSatei(ev(), x.deps);
    assert.match((x.pushes[0].messages[0] as any).text, /物件を読み取れませんでした/);
    assert.match((x.pushes[0].messages[0] as any).text, /読み直して/);
    assert.equal((x.pushes[0].messages[1] as any).contents.footer.contents.length, 3);
  });
  await t("1日20回の上限を超えたら読まない", async () => {
    const x = mk({ reads: 20 });
    await openGroupSatei(ev(), x.deps);
    assert.equal(x.readCalls.length, 0);
    assert.match((x.pushes[0].messages[0] as any).text, /本日の上限/);
  });
  await t("CRM が読めなくても知らせる", async () => {
    const x = mk({ deals: "throw" });
    await openGroupSatei(ev(), x.deps);
    assert.match(JSON.stringify(x.pushes[0].messages[1]), /CRM の案件を確かめられませんでした/);
  });
  await t("KV が無ければ何もしない", async () => {
    const x = mk();
    assert.equal(await openGroupSatei(ev(), { ...x.deps, kv: null }), "skip");
    assert.equal(x.pushes.length, 0);
  });
  await t("off なら何もしない（KV も読まない）", async () => {
    const x = mk();
    let touched = false;
    const kv = new Proxy(x.kv, { get: (o, p) => { touched = true; return (o as any)[p]; } });
    assert.equal(await openGroupSatei(ev(), { ...x.deps, env: {}, kv }), "skip");
    assert.equal(touched, false);
  });
  await t("AI の答えに名前があっても KV・ログ・カードに出ない", async () => {
    const x = mk({ read: { ...READ, address: null, propertyName: null } });
    await openGroupSatei(ev({ text: "坂本様の家の査定" }), x.deps);
    const all = JSON.stringify(Array.from(x.m.values()).map((v) => (v instanceof Set ? Array.from(v) : v))) + x.logs.join() + JSON.stringify(x.pushes);
    assert.ok(!all.includes("坂本"));
  });
  await t("同じ発言を同時に2回：受付票1枚・番号は詰める・知らせ1回", async () => {
    const x = mk();
    const r = await Promise.all([openGroupSatei(ev(), x.deps), openGroupSatei(ev(), x.deps)]);
    assert.deepEqual([...r].sort(), ["duplicate", "opened"]);
    assert.equal(x.pushes.length, 1);
    assert.equal(x.m.get("gsatei:seq"), 1);
    assert.equal(asTicket(x.m.get(gsTicketKey(ticketIdOf("m1"))))!.no, 1);
    await openGroupSatei(ev({ messageId: "m2" }), x.deps);
    assert.equal(asTicket(x.m.get(gsTicketKey(ticketIdOf("m2"))))!.no, 2);
  });
  await t("push が失敗：opened のまま・push-failed をログ・pushed は false", async () => {
    const x = mk({ push: false });
    assert.equal(await openGroupSatei(ev(), x.deps), "opened");
    assert.ok(x.logs.some((l) => /push-failed/.test(l)));
    assert.equal(asTicket(x.m.get(gsTicketKey(ticketIdOf("m1"))))!.pushed, false);
  });
  await t("push が通れば pushed は true", async () => {
    const x = mk();
    await openGroupSatei(ev(), x.deps);
    assert.equal(asTicket(x.m.get(gsTicketKey(ticketIdOf("m1"))))!.pushed, true);
  });
  await t("ログに tid・groupId・userId が出ない", async () => {
    const x = mk({ push: false });
    await openGroupSatei(ev(), x.deps);
    const all = x.logs.join("\n");
    for (const v of [ticketIdOf("m1"), G, BOSS, SHIMO, "m1"]) assert.ok(!all.includes(v), v);
  });
  await t("上限の数え方が KV で失敗したら上限の文にしない", async () => {
    const x = mk();
    const kv: GsKv = { ...x.kv, incr: async (k) => { if (k.startsWith("gsatei:reads:")) throw new Error("x"); return x.kv.incr(k); } };
    await openGroupSatei(ev(), { ...x.deps, kv });
    assert.doesNotMatch((x.pushes[0].messages[0] as any).text, /本日の上限/);
    assert.equal(x.readCalls.length, 0);
    assert.ok(x.logs.some((l) => /read cap-kv/.test(l)));
  });
  await t("開いた票の一覧に期限を付ける（expire が開票キーに呼ばれる）", async () => {
    const x = mk();
    const exp: string[] = [];
    const kv: GsKv = { ...x.kv, expire: async (k) => { exp.push(k); } };
    await openGroupSatei(ev(), { ...x.deps, kv });
    assert.ok(exp.includes(gsOpenKey(G)));
  });
  await t("期限の付与が失敗しても開く（ログは符号だけ）", async () => {
    const x = mk();
    const kv: GsKv = { ...x.kv, expire: async () => { throw new Error("x"); } };
    assert.equal(await openGroupSatei(ev(), { ...x.deps, kv }), "opened");
    assert.ok(x.logs.some((l) => /expire-failed/.test(l)));
  });
  console.log(`group-satei-open: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
