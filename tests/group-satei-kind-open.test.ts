/** 段2a：知らせのカードに「何の依頼？」が出るのは GROUP_SATEI_STAGE2 on のときだけ（group-satei-open.ts） */
import assert from "node:assert/strict";
import { openGroupSatei, recordGroupSateiMedia, type GsKv, type GsOpenDeps } from "../src/lib/group-satei-open";
import { type GsRead } from "../src/lib/group-satei-data";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const G = "C" + "a".repeat(32);
const SHIMO = "U" + "b".repeat(32);
const BOSS = "U" + "c".repeat(32);
const BASE_ENV = { GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, TASK_SATEI_USER_IDS: SHIMO, TASK_SATEI: "1" };
const NOW = 1_800_000_000_000;
const D1 = { id: "0123abcd0123456789ab0123456789ab", name: "テスト町1丁目", phase: "査定" };
const READ: GsRead = { address: "大阪市北区テスト1丁目2", propertyName: "テスト町1丁目", kind: "戸建", basis: "登記", confidence: 0.9 };

function mk(env: Record<string, string>) {
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
  const pushes: Array<{ messages: unknown[] }> = [];
  const deps: GsOpenDeps = {
    env, kv, now: () => NOW, today: () => "2026-11-24", ymd: () => "2026-11-24",
    read: async () => READ,
    loadDeals: async () => [D1],
    kindOf: async () => "戸建",
    requesterName: async () => "前田",
    push: async (_to, messages) => { pushes.push({ messages }); return true; },
    log: () => undefined,
  };
  return { deps, kv, pushes };
}
const ev = { messageId: "m1", groupId: G, requesterId: BOSS, at: NOW, text: "査定お願いできますか", entry: "B" as const };
async function openWith(env: Record<string, string>) {
  const x = mk(env);
  await recordGroupSateiMedia({ messageId: "img1", kind: "image", senderId: BOSS, at: NOW - 60_000 }, G, x.kv, () => undefined);
  assert.equal(await openGroupSatei(ev, x.deps), "opened");
  assert.equal(x.pushes.length, 1);
  return x.pushes[0].messages[1] as any;
}

(async () => {
  await t("STAGE2 off：カードは段1のまま（gk が無い・本文は案内1行）", async () => {
    const card = await openWith(BASE_ENV);
    assert.ok(!JSON.stringify(card).includes("v1|gk|"));
    assert.equal(card.contents.body.contents.length, 1);
  });
  await t("STAGE2 on：上の段に8つ、先頭は［査定］", async () => {
    const card = await openWith({ ...BASE_ENV, GROUP_SATEI_STAGE2: "1" });
    const s = JSON.stringify(card);
    assert.equal((s.match(/v1\|gk\|/g) ?? []).length, 8);
    assert.ok(s.indexOf("|satei\"") < s.indexOf("|doc\""));
    assert.equal(card.contents.footer.contents[0].action.data.split("|")[1], "gs");
  });
  console.log(`group-satei-kind-open: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
