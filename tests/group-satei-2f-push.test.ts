/** 段2f（F2）：段1の最初の知らせの送り直し（掃除 sweepGroupSatei）に上限を付ける */
import assert from "node:assert/strict";
import { sweepGroupSatei, type GsRereadKv } from "../src/lib/group-satei-open";
import {
  GS_PENDING_SET, GS_TICKET_PUSH_TRIES, asTicket, gsDecKey, gsTicketKey, ticketIdOf, type GsTicket,
} from "../src/lib/group-satei-data";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const G = "C" + "a".repeat(32);
const SHIMO = "U" + "b".repeat(32);
const BOSS = "U" + "c".repeat(32);
const ENV = { GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, TASK_SATEI_USER_IDS: SHIMO, TASK_SATEI: "1" };
const NOW = 1_800_000_000_000;
const TID = ticketIdOf("m1");
const base: GsTicket = {
  no: 7, ver: 1, groupId: G, requesterId: BOSS, at: NOW, triggerMsgIds: ["m1"], mediaIds: [], state: "asking", pushed: false,
  read: { address: "大阪市北区テスト1丁目2", propertyName: null, kind: "戸建", basis: "地図", confidence: 0.9 },
};

function mk(o: { ticket?: Partial<GsTicket>; fails?: number } = {}) {
  const m = new Map<string, unknown>();
  const set = (k: string) => ((m.get(k) as Set<string>) ?? new Set<string>());
  const kv: GsRereadKv = {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => { m.set(k, v); },
    setNx: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
    incr: async () => 1,
    expire: async () => undefined,
    sadd: async (k, v) => { const s = set(k); s.add(v); m.set(k, s); },
    srem: async (k, v) => { const s = set(k); s.delete(v); m.set(k, s); },
    del: async (k) => { m.delete(k); },
    smembers: async (k) => Array.from(set(k)),
    lpushTrim: async () => undefined,
    lrange: async () => [],
  };
  m.set(gsTicketKey(TID), { ...base, ...(o.ticket ?? {}) });
  m.set(GS_PENDING_SET, new Set([TID]));
  let clock = NOW + 4 * 60_000;
  let fails = o.fails ?? 0;
  const pushes: string[] = [];
  const logs: string[] = [];
  const deps = {
    env: ENV, kv,
    now: () => clock, today: () => "2026-11-26", ymd: () => "2026-11-26",
    read: async () => { throw new Error("掃除は AI を呼ばない"); },
    loadDeals: async () => [], kindOf: async () => null, requesterName: async () => null,
    push: async (_to: string, _m: unknown[], key: string) => { pushes.push(key); if (fails > 0) { fails--; return false; } return true; },
    log: (l: string) => logs.push(l),
  };
  return { deps, kv, m, pushes, logs, tick: () => { clock += 60_000; }, pending: () => (m.get(GS_PENDING_SET) as Set<string>).has(TID) };
}
const tk = (x: ReturnType<typeof mk>) => asTicket(x.m.get(gsTicketKey(TID)))!;

(async () => {
  await t("失敗が続くと10回で掃除の対象から外れる（11回目は送らない）。ログは符号と受付番号だけ", async () => {
    const x = mk({ fails: 99 });
    for (let i = 0; i < GS_TICKET_PUSH_TRIES + 3; i++) {
      await sweepGroupSatei(x.deps);
      x.tick();
    }
    assert.equal(x.pushes.length, GS_TICKET_PUSH_TRIES);
    assert.ok(x.pushes.every((k) => k === `${TID}:1`), "同じ版の retry key");
    assert.equal(tk(x).pushTries, GS_TICKET_PUSH_TRIES);
    assert.equal(tk(x).pushed, false);
    assert.equal(x.pending(), false);
    assert.equal(x.logs.filter((l) => l === "[group-satei] ticket G7 push gave-up").length, 1);
    assert.ok(x.logs.every((l) => !l.includes(TID) && !l.includes(BOSS)));
  });
  await t("途中で送れれば pushed になり、掃除から外れる", async () => {
    const x = mk({ fails: 3 });
    for (let i = 0; i < 6; i++) {
      await sweepGroupSatei(x.deps);
      x.tick();
    }
    assert.equal(x.pushes.length, 4);
    assert.equal(tk(x).pushed, true);
    assert.equal(tk(x).pushTries, 4);
    assert.equal(x.pending(), false);
    assert.ok(!x.logs.some((l) => /gave-up/.test(l)));
  });
  await t("前の版で数え終わった票（pushTries が上限）は送らずに外す", async () => {
    const x = mk({ ticket: { pushTries: GS_TICKET_PUSH_TRIES } });
    await sweepGroupSatei(x.deps);
    assert.equal(x.pushes.length, 0);
    assert.equal(x.pending(), false);
    assert.ok(x.logs.includes("[group-satei] ticket G7 push gave-up"));
  });
  await t("押されたあとの票は書かない・送らない（今の決まり）", async () => {
    const x = mk({ fails: 99 });
    x.m.set(gsDecKey(TID), "x");
    const before = JSON.stringify(x.m.get(gsTicketKey(TID)));
    await sweepGroupSatei(x.deps);
    assert.equal(x.pushes.length, 0);
    assert.equal(JSON.stringify(x.m.get(gsTicketKey(TID))), before);
    assert.equal(x.pending(), false);
  });
  await t("pushTries の形が違う票は読まない（受付票の検査）", async () => {
    assert.equal(asTicket({ ...base, pushTries: -1 }), null);
    assert.equal(asTicket({ ...base, pushTries: "3" }), null);
    assert.ok(asTicket({ ...base, pushTries: 3 }));
    assert.ok(asTicket(base), "pushTries の無い今の票はそのまま読む");
  });
  await t("off なら KV も読まない", async () => {
    const x = mk();
    let touched = false;
    const kv = new Proxy(x.kv, { get: (o, p) => { touched = true; return (o as never)[p]; } });
    await sweepGroupSatei({ ...x.deps, env: {}, kv });
    assert.equal(touched, false);
  });
  console.log(`group-satei-2f-push: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
