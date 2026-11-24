/** 普通のグループの査定依頼：あとから届いた資料で読み直す（11/25。社長の依頼が「資料を読めませんでした」になった件） */
import assert from "node:assert/strict";
import {
  attachLateMedia, openGroupSatei, recordGroupSateiMedia, runGroupSateiRereads,
  type GsOpenDeps, type GsRereadKv,
} from "../src/lib/group-satei-open";
import { lateMediaMatches } from "../src/lib/group-satei-gate";
import { GS_REREAD_SET, asTicket, gsLateKey, gsTicketKey, ticketIdOf, type GsMedia, type GsRead } from "../src/lib/group-satei-data";
import { loadGroupSateiMaterials } from "../src/lib/group-satei-wire";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };

const G = "C" + "a".repeat(32);
const SHIMO = "U" + "b".repeat(32);
const BOSS = "U" + "c".repeat(32);
const YAMA = "U" + "d".repeat(32);
const ENV = { GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, TASK_SATEI_USER_IDS: SHIMO, TASK_SATEI: "1" };
const NOW = 1_800_000_000_000;
const READ: GsRead = { address: "大阪市北区テスト1丁目2", propertyName: null, kind: "戸建", basis: "地図", confidence: 0.9 };

function fakeKv() {
  const m = new Map<string, unknown>();
  const set = (k: string) => ((m.get(k) as Set<string>) ?? new Set<string>());
  const kv: GsRereadKv = {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => { m.set(k, v); },
    setNx: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
    incr: async (k) => { const v = Number(m.get(k) ?? 0) + 1; m.set(k, v); return v; },
    expire: async () => undefined,
    sadd: async (k, v) => { const s = set(k); s.add(v); m.set(k, s); },
    srem: async (k, v) => { const s = set(k); s.delete(v); m.set(k, s); },
    del: async (k) => { m.delete(k); },
    smembers: async (k) => Array.from(set(k)),
    lpushTrim: async (k, v, max) => { const a = ((m.get(k) as unknown[]) ?? []); a.push(v); m.set(k, a.slice(-max)); },
    lrange: async (k) => ((m.get(k) as unknown[]) ?? []),
  };
  return { kv, m };
}

function mk(reads: Array<GsRead | "throw"> = [READ]) {
  const { kv, m } = fakeKv();
  const logs: string[] = [];
  const pushes: Array<{ messages: unknown[]; key: string }> = [];
  const readCalls: string[][] = [];
  let clock = NOW;
  const deps: GsOpenDeps & { kv: GsRereadKv } = {
    env: ENV,
    kv,
    now: () => clock,
    today: () => "2026-11-25",
    ymd: () => "2026-11-25",
    read: async (ids) => {
      readCalls.push(ids);
      const r = reads.length > 1 ? reads.shift()! : reads[0];
      if (r === "throw") throw new Error("unreadable");
      return r;
    },
    loadDeals: async () => [],
    kindOf: async () => null,
    requesterName: async () => "前田",
    push: async (_to, messages, key) => { pushes.push({ messages, key }); return true; },
    log: (l) => logs.push(l),
  };
  return { deps, kv, m, logs, pushes, readCalls, tick: (ms: number) => { clock += ms; } };
}
const ev = (over = {}) => ({ messageId: "m1", groupId: G, requesterId: BOSS, at: NOW, text: "査定お願いできますか！", entry: "B" as const, ...over });
const img = (id: string, o: Partial<GsMedia> = {}): GsMedia => ({ messageId: id, kind: "image", senderId: BOSS, at: NOW + 20_000, ...o });
const tk = (m: Map<string, unknown>, id = "m1") => asTicket(m.get(gsTicketKey(ticketIdOf(id))))!;
const text0 = (p: { messages: unknown[] }) => (p.messages[0] as { text: string }).text;

(async () => {
  // ── どの資料を足すか ──
  const T = { requesterId: BOSS, at: NOW, triggerMsgIds: ["m1"], mediaIds: [] as string[] };
  await t("足す：本人の画像（30分以内）", async () => {
    assert.equal(lateMediaMatches(T, img("i1"), 2, SHIMO), true);
  });
  await t("足さない：本人でも30分を過ぎたもの（ほかに開いている票がある）", async () => {
    assert.equal(lateMediaMatches(T, img("i1", { at: NOW + 31 * 60_000 }), 2, SHIMO), false);
  });
  await t("足す：別の人でも、依頼を引用したもの", async () => {
    assert.equal(lateMediaMatches(T, img("i1", { senderId: YAMA, quoted: "m1" }), 2, SHIMO), true);
  });
  await t("足す：別の人でも、開いている票が1件だけで2時間以内", async () => {
    assert.equal(lateMediaMatches(T, img("i1", { senderId: YAMA, at: NOW + 90 * 60_000 }), 1, SHIMO), true);
  });
  await t("足さない：別の人で、開いている票が2件", async () => {
    assert.equal(lateMediaMatches(T, img("i1", { senderId: YAMA }), 2, SHIMO), false);
  });
  await t("足さない：下村さん本人が貼ったもの（引用なし）", async () => {
    assert.equal(lateMediaMatches(T, img("i1", { senderId: SHIMO }), 1, SHIMO), false);
  });
  await t("足さない：依頼より前のもの・画像とPDF以外・もう入っているもの", async () => {
    assert.equal(lateMediaMatches(T, img("i1", { at: NOW - 1 }), 1, SHIMO), false);
    assert.equal(lateMediaMatches(T, img("i1", { kind: "other" }), 1, SHIMO), false);
    assert.equal(lateMediaMatches({ ...T, mediaIds: ["i1"] }, img("i1"), 1, SHIMO), false);
  });

  // ── 文字だけで読めない依頼は、すぐ知らせずに資料を待つ ──
  await t("資料が無く本文でも読めない：知らせを待つ（push しない・読み直しの予約）", async () => {
    const x = mk(["throw"]);
    assert.equal(await openGroupSatei(ev(), x.deps), "opened");
    assert.equal(x.pushes.length, 0);
    const k = tk(x.m);
    assert.equal(k.deferred, true);
    assert.equal(k.readFailed, "no-material");
    assert.ok((x.m.get(GS_REREAD_SET) as Set<string>).has(ticketIdOf("m1")));
    assert.ok(x.logs.some((l) => /ticket G1 opened B deferred/.test(l)));
  });
  await t("本文だけで読めた：その場で知らせる（待たない）", async () => {
    const x = mk([READ]);
    await openGroupSatei(ev(), x.deps);
    assert.equal(x.pushes.length, 1);
    assert.equal(tk(x.m).deferred, undefined);
  });

  // ── あとから画像 → 静かになってから1回読んで、1回だけ知らせる ──
  await t("社長の型：文字 → 画像2枚 → 1分静か → 読んで1回知らせる", async () => {
    const x = mk(["throw", READ]);
    await openGroupSatei(ev(), x.deps);
    for (const id of ["i1", "i2"]) {
      const row = img(id);
      await recordGroupSateiMedia(row, G, x.kv, () => undefined);
      await attachLateMedia(row, G, x.deps);
    }
    assert.deepEqual(Array.from(x.m.get(gsLateKey(ticketIdOf("m1"))) as Set<string>).sort(), ["image:i1", "image:i2"]);
    assert.deepEqual(tk(x.m).mediaIds, [], "受付票そのものは見回りまで書き換えない");
    x.tick(30_000);
    await runGroupSateiRereads(x.deps);
    assert.equal(x.pushes.length, 0, "静かになる前は読まない");
    x.tick(60_000);
    await runGroupSateiRereads(x.deps);
    assert.equal(x.pushes.length, 1);
    assert.deepEqual(x.readCalls.at(-1), ["i1", "i2"]);
    assert.match(text0(x.pushes[0]), /大阪市北区テスト1丁目2/);
    assert.match(text0(x.pushes[0]), /画像2枚/);
    const k = tk(x.m);
    assert.equal(k.deferred, false);
    assert.equal(k.ver, 1, "最初の知らせなので版は1のまま");
    assert.equal(k.rereads ?? 0, 0);
    assert.ok(!(x.m.get(GS_REREAD_SET) as Set<string>).has(ticketIdOf("m1")));
    await runGroupSateiRereads(x.deps);
    assert.equal(x.pushes.length, 1, "二度は知らせない");
  });
  await t("待っても資料が来ない：90秒後に「まだ届いていません」で知らせる", async () => {
    const x = mk(["throw"]);
    await openGroupSatei(ev(), x.deps);
    x.tick(91_000);
    await runGroupSateiRereads(x.deps);
    assert.equal(x.pushes.length, 1);
    assert.match(text0(x.pushes[0]), /まだ届いていません/);
    assert.match(text0(x.pushes[0]), /読み直して/);
    assert.equal(x.readCalls.length, 1, "資料が無いので2回目は AI を呼ばない");
  });

  // ── 知らせたあとに資料が増えた：版を上げて出し直す（2回まで）──
  await t("知らせたあとに画像：読み直して版を上げて出し直す", async () => {
    const x = mk([READ]);
    await recordGroupSateiMedia(img("i0", { at: NOW - 60_000 }), G, x.kv, () => undefined);
    await openGroupSatei(ev(), x.deps);
    assert.equal(x.pushes.length, 1);
    const row = img("i1");
    await recordGroupSateiMedia(row, G, x.kv, () => undefined);
    await attachLateMedia(row, G, x.deps);
    x.tick(61_000);
    await runGroupSateiRereads(x.deps);
    assert.equal(x.pushes.length, 2);
    assert.match(text0(x.pushes[1]), /読み直しました/);
    const k = tk(x.m);
    assert.equal(k.ver, 2);
    assert.equal(k.rereads, 1);
    assert.equal(x.pushes[1].key, `${ticketIdOf("m1")}:2`);
  });
  await t("読み直しは2回まで（3回目の資料は足すだけ）", async () => {
    const x = mk([READ]);
    await openGroupSatei(ev(), x.deps);
    for (const id of ["i1", "i2", "i3"]) {
      const row = img(id);
      await attachLateMedia(row, G, x.deps);
      x.tick(61_000);
      await runGroupSateiRereads(x.deps);
    }
    assert.equal(x.pushes.length, 3);
    assert.equal(tk(x.m).rereads, 2);
  });
  await t("ボタンを押したあと（asking でない）は足さない", async () => {
    const x = mk([READ]);
    await openGroupSatei(ev(), x.deps);
    const k = tk(x.m);
    await x.kv.set(gsTicketKey(ticketIdOf("m1")), { ...k, state: "manual" }, 1);
    await attachLateMedia(img("i1"), G, x.deps);
    assert.equal(x.m.get(gsLateKey(ticketIdOf("m1"))), undefined);
    assert.equal(tk(x.m).state, "manual", "押したあとの状態を書き戻さない");
  });
  await t("off なら足さない・見回りも何もしない（KV を読まない）", async () => {
    const x = mk([READ]);
    let touched = false;
    const kv = new Proxy(x.kv, { get: (o, p) => { touched = true; return (o as never)[p]; } });
    await attachLateMedia(img("i1"), G, { ...x.deps, env: {}, kv });
    await runGroupSateiRereads({ ...x.deps, env: {}, kv });
    assert.equal(touched, false);
  });
  await t("読み直しの知らせに名前が混ざらない・ログは符号だけ", async () => {
    const x = mk(["throw", READ]);
    await openGroupSatei(ev(), x.deps);
    await attachLateMedia(img("i1"), G, x.deps);
    x.tick(61_000);
    await runGroupSateiRereads(x.deps);
    assert.ok(x.logs.some((l) => /^\[group-satei\] ticket G1 reread read ok/.test(l)));
    assert.ok(!x.logs.join().includes("テスト"));
  });

  // ── 1枚取れなくても、取れた分で読む ──
  await t("資料の取り出し：1件失敗しても残りで読む", async () => {
    const f = (async (url: string) =>
      /bad/.test(url)
        ? new Response("", { status: 404 })
        : new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
    const out = await loadGroupSateiMaterials(["ok1", "bad", "ok2"], f);
    assert.equal(out.length, 2);
  });
  await t("資料の取り出し：全部失敗なら例外", async () => {
    const f = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await assert.rejects(loadGroupSateiMaterials(["bad1", "bad2"], f));
  });

  console.log(`group-satei-reread: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
