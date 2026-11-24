/** 普通のグループの査定依頼：あとから届いた資料で読み直す（11/25。社長の依頼が「資料を読めませんでした」になった件） */
import assert from "node:assert/strict";
import {
  attachLateMedia, openGroupSatei, recordGroupSateiMedia, runRereadWorker, sweepGroupSatei,
  type GsRereadKv, type GsWorkerDeps,
} from "../src/lib/group-satei-open";
import { lateMediaMatches } from "../src/lib/group-satei-gate";
import {
  GS_PENDING_SET, asTicket, gsDecKey, gsLateKey, gsRereadAtKey, gsRereadLockKey, gsTicketKey, ticketIdOf, type GsMedia, type GsRead,
} from "../src/lib/group-satei-data";
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
  const readAt: number[] = [];
  let clock = NOW;
  let onRead: (call: number) => unknown = () => undefined;
  let onPush: () => void = () => undefined;
  let onSleep: () => unknown = () => undefined;
  let pushFails = 0;
  const deps: GsWorkerDeps & { kv: GsRereadKv } = {
    env: ENV,
    kv,
    now: () => clock,
    today: () => "2026-11-25",
    ymd: () => "2026-11-25",
    read: async (ids) => {
      readCalls.push(ids);
      readAt.push(clock);
      await onRead(readCalls.length);
      const r = reads.length > 1 ? reads.shift()! : reads[0];
      if (r === "throw") throw new Error("unreadable");
      return r;
    },
    loadDeals: async () => [],
    kindOf: async () => null,
    requesterName: async () => "前田",
    push: async (_to, messages, key) => { pushes.push({ messages, key }); onPush(); if (pushFails > 0) { pushFails--; return false; } return true; },
    log: (l) => logs.push(l),
    sleep: async (ms) => { clock += ms; await onSleep(); },
  };
  return {
    deps, kv, m, logs, pushes, readCalls, readAt,
    clock: () => clock,
    onRead: (f: (call: number) => unknown) => { onRead = f; },
    onPush: (f: () => void) => { onPush = f; },
    onSleep: (f: () => unknown) => { onSleep = f; },
    advance: (ms: number) => { clock += ms; },
    failPush: (k: number) => { pushFails = k; },
  };
}
const TID = ticketIdOf("m1");
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
  await t("資料が無く本文でも読めない：知らせを待つ（push しない・読み直す時刻を置く）", async () => {
    const x = mk(["throw"]);
    assert.equal(await openGroupSatei(ev(), x.deps), "opened");
    assert.equal(x.pushes.length, 0);
    const k = tk(x.m);
    assert.equal(k.deferred, true);
    assert.equal(k.readFailed, "no-material");
    assert.equal(x.m.get(gsRereadAtKey(TID)), NOW + 90_000);
    assert.ok(x.logs.some((l) => /ticket G1 opened B deferred/.test(l)));
  });
  await t("本文だけで読めた：その場で知らせる（待たない）・係は何もしない", async () => {
    const x = mk([READ]);
    await openGroupSatei(ev(), x.deps);
    assert.equal(x.pushes.length, 1);
    await runRereadWorker(TID, x.deps);
    assert.equal(x.pushes.length, 1);
    assert.equal(x.clock(), NOW, "待たない");
  });

  // ── 社長の型：文字 → 画像2枚 → 1分静か → 読んで1回知らせる ──
  await t("社長の型：文字 → 画像2枚 → 静かになってから読んで1回知らせる", async () => {
    const x = mk(["throw", READ]);
    await openGroupSatei(ev(), x.deps);
    for (const id of ["i1", "i2"]) {
      const row = img(id);
      await recordGroupSateiMedia(row, G, x.kv, () => undefined);
      assert.equal(await attachLateMedia(row, G, x.deps), TID);
    }
    assert.deepEqual(Array.from(x.m.get(gsLateKey(TID)) as Set<string>).sort(), ["image:i1", "image:i2"]);
    assert.deepEqual(tk(x.m).mediaIds, [], "受付票そのものは係が読むまで書き換えない");
    await runRereadWorker(TID, x.deps);
    assert.equal(x.pushes.length, 1);
    assert.ok(x.readAt.at(-1)! >= NOW + 60_000, "最後の資料から1分たってから読む");
    assert.deepEqual(x.readCalls.at(-1), ["i1", "i2"]);
    assert.match(text0(x.pushes[0]), /大阪市北区テスト1丁目2/);
    assert.match(text0(x.pushes[0]), /画像2枚/);
    const k = tk(x.m);
    assert.equal(k.deferred, false);
    assert.equal(k.ver, 1, "最初の知らせなので版は1のまま");
    assert.equal(k.pushed, true);
    await runRereadWorker(TID, x.deps);
    assert.equal(x.pushes.length, 1, "二度は知らせない");
  });
  await t("待っても資料が来ない：90秒後に「まだ届いていません」で知らせる（AI は呼び直さない）", async () => {
    const x = mk(["throw"]);
    await openGroupSatei(ev(), x.deps);
    await runRereadWorker(TID, x.deps);
    assert.equal(x.pushes.length, 1);
    assert.ok(x.clock() >= NOW + 90_000);
    assert.match(text0(x.pushes[0]), /まだ届いていません/);
    assert.match(text0(x.pushes[0]), /読み直して/);
    assert.equal(x.readCalls.length, 1);
  });
  await t("開いて読んでいるあいだに本人の画像が貼られた：取りこぼさず、読んでから1回知らせる（レビュー1）", async () => {
    const x = mk([READ, READ]);
    x.onRead((call) => {
      if (call === 1) return recordGroupSateiMedia(img("i9", { at: NOW + 3_000 }), G, x.kv, () => undefined);
    });
    await openGroupSatei(ev(), x.deps);
    assert.equal(x.pushes.length, 0, "読むあいだに資料が増えたので、まだ知らせない");
    await runRereadWorker(TID, x.deps);
    assert.equal(x.pushes.length, 1);
    assert.deepEqual(x.readCalls.at(-1), ["i9"]);
  });

  // ── 知らせたあとに資料が増えた：版を上げて出し直す（2回まで）──
  await t("知らせたあとに画像：読み直して版を上げて出し直す", async () => {
    const x = mk([READ]);
    await recordGroupSateiMedia(img("i0", { at: NOW - 60_000 }), G, x.kv, () => undefined);
    await openGroupSatei(ev(), x.deps);
    assert.equal(x.pushes.length, 1);
    await attachLateMedia(img("i1"), G, x.deps);
    await runRereadWorker(TID, x.deps);
    assert.equal(x.pushes.length, 2);
    assert.match(text0(x.pushes[1]), /読み直しました/);
    const k = tk(x.m);
    assert.equal(k.ver, 2);
    assert.equal(k.rereads, 1);
    assert.deepEqual(k.mediaIds, ["i0", "i1"]);
    assert.equal(x.pushes[1].key, `${TID}:2`);
  });
  await t("読み直しは2回まで（3回目の資料は足さない）", async () => {
    const x = mk([READ]);
    await openGroupSatei(ev(), x.deps);
    for (const id of ["i1", "i2", "i3"]) {
      await attachLateMedia(img(id), G, x.deps);
      await runRereadWorker(TID, x.deps);
    }
    assert.equal(x.pushes.length, 3);
    assert.equal(tk(x.m).rereads, 2);
    assert.ok(x.logs.some((l) => /late-media over/.test(l)));
  });
  await t("読むあいだに届いた画像：置き去りにせず、もう1周読む（レビュー3）", async () => {
    const x = mk([READ]);
    await openGroupSatei(ev(), x.deps);
    await attachLateMedia(img("i1"), G, x.deps);
    x.onRead((call) => {
      if (call === 2) return attachLateMedia(img("i2", { at: NOW + 30_000 }), G, x.deps).then(() => undefined);
    });
    await runRereadWorker(TID, x.deps);
    assert.equal(x.pushes.length, 3);
    assert.deepEqual(tk(x.m).mediaIds, ["i1", "i2"]);
    assert.equal((x.m.get(gsLateKey(TID)) as Set<string>).size, 0);
  });
  await t("読むあいだにボタンが押された：押した結果を上書きしない・知らせない（レビュー2）", async () => {
    const x = mk([READ]);
    await openGroupSatei(ev(), x.deps);
    await attachLateMedia(img("i1"), G, x.deps);
    x.onRead(async (call) => {
      if (call === 2) {
        x.m.set(gsDecKey(TID), "x");
        x.m.set(gsTicketKey(TID), { ...tk(x.m), state: "started" });
      }
    });
    await runRereadWorker(TID, x.deps);
    assert.equal(x.pushes.length, 1);
    assert.equal(tk(x.m).state, "started");
    assert.ok(x.logs.some((l) => /reread stale/.test(l)));
  });
  await t("知らせの送信中にボタンが押された：pushed の印で asking に戻さない（レビュー2）", async () => {
    const x = mk([READ]);
    await openGroupSatei(ev(), x.deps);
    await attachLateMedia(img("i1"), G, x.deps);
    x.onPush(() => {
      x.m.set(gsDecKey(TID), "x");
      x.m.set(gsTicketKey(TID), { ...tk(x.m), state: "manual" });
    });
    await runRereadWorker(TID, x.deps);
    assert.equal(tk(x.m).state, "manual");
  });
  await t("ボタンを押したあと（asking でない）は足さない", async () => {
    const x = mk([READ]);
    await openGroupSatei(ev(), x.deps);
    x.m.set(gsTicketKey(TID), { ...tk(x.m), state: "manual" });
    assert.equal(await attachLateMedia(img("i1"), G, x.deps), null);
    assert.equal(x.m.get(gsLateKey(TID)), undefined);
    assert.equal(tk(x.m).state, "manual");
  });
  await t("ほかの呼び出しが係をしている：待って、時間内に終わらなければ黙って戻る（例外なし）", async () => {
    const x = mk(["throw"]);
    await openGroupSatei(ev(), x.deps);
    x.m.set(gsRereadLockKey(TID), 1);
    await runRereadWorker(TID, x.deps);
    assert.equal(x.pushes.length, 0);
    assert.ok(x.clock() - NOW <= 250_000);
  });
  await t("係は 250 秒の内側で終わる（資料が貼られ続けても）", async () => {
    const x = mk([READ]);
    await openGroupSatei(ev(), x.deps);
    await attachLateMedia(img("i1"), G, x.deps);
    x.onSleep(() => attachLateMedia(img(`k${x.clock()}`, { at: x.clock() }), G, x.deps).then(() => undefined));
    await runRereadWorker(TID, x.deps);
    assert.ok(x.clock() - NOW <= 250_000, `${x.clock() - NOW}`);
  });
  await t("off なら足さない・係も何もしない（KV を読まない）", async () => {
    const x = mk([READ]);
    let touched = false;
    const kv = new Proxy(x.kv, { get: (o, p) => { touched = true; return (o as never)[p]; } });
    assert.equal(await attachLateMedia(img("i1"), G, { ...x.deps, env: {}, kv }), null);
    await runRereadWorker(TID, { ...x.deps, env: {}, kv });
    assert.equal(touched, false);
  });
  await t("ログは符号だけ（物件名・住所を出さない）", async () => {
    const x = mk(["throw", READ]);
    await openGroupSatei(ev(), x.deps);
    await attachLateMedia(img("i1"), G, x.deps);
    await runRereadWorker(TID, x.deps);
    assert.ok(x.logs.some((l) => /^\[group-satei\] ticket G1 reread read ok first/.test(l)));
    assert.ok(!x.logs.join().includes("テスト"));
  });

  // ── 再レビュー（11/25）──
  await t("残り時間は関数の開始から数える：開始から200秒たっていたら1周を始めない（再レビュー1）", async () => {
    const x = mk(["throw"]);
    await openGroupSatei(ev(), x.deps);
    await runRereadWorker(TID, { ...x.deps, startedAt: NOW - 200_000 });
    assert.equal(x.pushes.length, 0);
    assert.ok(x.logs.some((l) => /reread out-of-time/.test(l)));
  });
  await t("ほかの係の印が空かなければ、20秒で諦める（応答を長く止めない・再レビュー3）", async () => {
    const x = mk(["throw"]);
    await openGroupSatei(ev(), x.deps);
    x.m.set(gsRereadLockKey(TID), 1);
    await runRereadWorker(TID, x.deps);
    assert.ok(x.clock() - NOW <= 20_000, `${x.clock() - NOW}`);
  });
  await t("掃除：係が止まって知らせの出ていない票を、3分後に読み直さずに知らせる（再レビュー2）", async () => {
    const x = mk(["throw"]);
    await openGroupSatei(ev(), x.deps);
    await attachLateMedia(img("i1"), G, x.deps);
    await sweepGroupSatei(x.deps);
    assert.equal(x.pushes.length, 0, "3分たつまでは触らない");
    x.advance(4 * 60_000);
    await sweepGroupSatei(x.deps);
    assert.equal(x.pushes.length, 1);
    assert.equal(x.readCalls.length, 1, "掃除は AI を呼ばない");
    assert.match(text0(x.pushes[0]), /途中で止まりました/);
    assert.match(text0(x.pushes[0]), /画像1枚/);
    assert.equal(tk(x.m).pushed, true);
    assert.ok(!(x.m.get(GS_PENDING_SET) as Set<string>).has(TID));
    await sweepGroupSatei(x.deps);
    assert.equal(x.pushes.length, 1, "二度は送らない");
  });
  await t("掃除：push が失敗した票は、同じ版の retry key で送り直す", async () => {
    const x = mk([READ]);
    x.failPush(1);
    await openGroupSatei(ev(), x.deps);
    assert.equal(tk(x.m).pushed, false);
    x.advance(4 * 60_000);
    await sweepGroupSatei(x.deps);
    assert.equal(x.pushes.length, 2);
    assert.equal(x.pushes[1].key, `${TID}:1`);
    assert.match(text0(x.pushes[1]), /大阪市北区テスト1丁目2/);
  });
  await t("掃除：押された票・係が印を持つ票には触らない", async () => {
    const x = mk(["throw"]);
    await openGroupSatei(ev(), x.deps);
    x.advance(4 * 60_000);
    x.m.set(gsRereadLockKey(TID), 1);
    await sweepGroupSatei(x.deps);
    assert.equal(x.pushes.length, 0);
    x.m.delete(gsRereadLockKey(TID));
    x.m.set(gsDecKey(TID), "x");
    await sweepGroupSatei(x.deps);
    assert.equal(x.pushes.length, 0);
  });
  await t("掃除：off なら KV も読まない", async () => {
    const x = mk([READ]);
    let touched = false;
    const kv = new Proxy(x.kv, { get: (o, p) => { touched = true; return (o as never)[p]; } });
    await sweepGroupSatei({ ...x.deps, env: {}, kv });
    assert.equal(touched, false);
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
