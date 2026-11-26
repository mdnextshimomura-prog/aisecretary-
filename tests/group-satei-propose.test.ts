/** 段2d：［いいよ］［直す］と直しの1通（group-satei-propose.ts。KV・portal・LINE・Claude は差し替え） */
import assert from "node:assert/strict";
import { handleGroupSateiPostback, type GsActionDeps } from "../src/lib/group-satei-actions";
import {
  asTicket, GS_STAGE2_SET, gsFixKey, gsOkKey, gsTicketKey, gsWaitKey, parseGsData, ticketIdOf, type GsTicket,
} from "../src/lib/group-satei-data";
import { handleGsFixText, type GsFixDeps } from "../src/lib/group-satei-propose";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const G = "C" + "a".repeat(32);
const tid = ticketIdOf("m1");
const NOW = Date.UTC(2026, 10, 26, 1); // JST 11/26（木）10:00 → 期日は当日 18:00
const LINES = ["成約：同じマンション（パークハウス天満）→ 同じ町名 → 同じ小学校区", "売出：同じ条件で、いま売り出し中のものを5件ほど（無ければ無しで）"];
const base: GsTicket = {
  no: 7, ver: 1, groupId: G, requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], state: "proposing", dealId: "d",
  read: { address: "大阪市北区天満2丁目3-4", propertyName: "パークハウス天満 1203号室", kind: "マンション", basis: "本文", confidence: 0.9 },
  prep: { kind: "マンション", rev: 1, lines: LINES, fixes: 0, sentRev: 1, tries: 1, groupPushes: 0 },
};
const ON = { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, GROUP_SATEI_STAGE2: "1", GROUP_SATEI_CASE_STAFF_ID: STAFF };

function mk(o: { ticket?: Partial<GsTicket>; push?: number | null; env?: Record<string, string> } = {}) {
  const m = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  m.set(gsTicketKey(tid), { ...base, ...(o.ticket ?? {}) });
  sets.set(GS_STAGE2_SET, new Set([tid]));
  const replies: Array<{ text: string; card?: unknown }> = [];
  const pushes: Array<{ to: string; messages: unknown[]; key: string }> = [];
  const decides: unknown[] = [];
  const logs: string[] = [];
  const kv = {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: unknown) => { m.set(k, v); },
    setNx: async (k: string, v: unknown) => (m.has(k) ? false : (m.set(k, v), true)),
    incr: async () => 1, expire: async () => undefined,
    sadd: async (k: string, v: string) => { (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(v); },
    lpushTrim: async () => undefined, lrange: async () => [],
    del: async (k: string) => { m.delete(k); }, srem: async (k: string, v: string) => { sets.get(k)?.delete(v); },
    delIfToken: async (k: string, token: string) => {
      const v = m.get(k) as { token?: string } | undefined;
      if (v?.token !== token) return false;
      m.delete(k);
      return true;
    },
  };
  const deps: GsActionDeps = {
    env: o.env ?? ON, kv, dealsDbId: "x", readDeal: async () => null,
    intake: async () => ({ kind: "unknown", reason: "x" }), loadDeals: async () => [],
    reserve: async () => ({ proceed: true }), complete: async () => undefined,
    reply: async (_t, text, card) => { replies.push({ text, card }); },
    log: (l) => logs.push(l),
    prep: { intake: async () => ({ kind: "unknown", reason: "x" }), notices: async () => ({ kind: "ok", value: [] }), decide: async (id, req) => { decides.push({ id, req }); return { kind: "ok", value: { status: "x" } }; } },
    push: async (to, messages, key) => { pushes.push({ to, messages, key }); return o.push === undefined ? 200 : o.push; },
    now: () => NOW,
  };
  return { deps, kv, m, sets, replies, pushes, decides, logs };
}
const press = (x: ReturnType<typeof mk>, data: string, eventId = "e1") =>
  handleGroupSateiPostback(parseGsData(data)!, { replyToken: "r", webhookEventId: eventId, source: { userId: SHIMO } }, x.deps);
const ticket = (x: ReturnType<typeof mk>) => asTicket(x.m.get(gsTicketKey(tid)))!;
const fixDeps = (x: ReturnType<typeof mk>, revise: GsFixDeps["revise"]): GsFixDeps => ({
  env: ON, kv: x.kv, revise, reply: async (_t, text, card) => { x.replies.push({ text, card }); }, now: () => NOW, log: (l) => x.logs.push(l),
});

(async () => {
  await t("［いいよ］：依頼が来たグループへ1回 push（retry key case:<tid>）。事例待ち・期日・portal に ok", async () => {
    const x = mk();
    await press(x, `v1|gy|${tid}|1|1`);
    assert.equal(x.pushes.length, 1);
    assert.equal(x.pushes[0].to, G);
    assert.equal(x.pushes[0].key, `case:${tid}`);
    assert.equal((x.pushes[0].messages[0] as { type: string }).type, "textV2");
    const tk = ticket(x);
    assert.equal(tk.state, "waiting-cases");
    assert.equal(tk.prep!.deadline, Date.UTC(2026, 10, 26, 9));
    assert.equal(tk.prep!.requestedAt, NOW);
    assert.equal(tk.prep!.groupPushes, 1);
    assert.ok(x.sets.get(gsWaitKey(G))?.has(tid));
    assert.deepEqual(x.decides[0], { id: tid, req: { decision: "ok", rev: 1, lines: LINES, deadline: Date.UTC(2026, 10, 26, 9) } });
    assert.ok(x.replies[0].text.startsWith("山口さんに頼みました（受付 G7・期日 11/26（木）18時）"));
    assert.ok(x.logs.includes("[group-satei] gy case-request posted G7"));
  });
  await t("［いいよ］の2度目（別のイベント）は送らない", async () => {
    const x = mk();
    await press(x, `v1|gy|${tid}|1|1`, "e1");
    await press(x, `v1|gy|${tid}|1|1`, "e2");
    assert.equal(x.pushes.length, 1);
    assert.equal(x.replies[1].text, "山口さんへはもう頼んであります（受付 G7）");
  });
  await t("古い版の［いいよ］は「新しい案が届いています」", async () => {
    const x = mk({ ticket: { prep: { ...base.prep!, rev: 2 } } });
    await press(x, `v1|gy|${tid}|1|1`);
    assert.equal(x.pushes.length, 0);
    assert.equal(x.replies[0].text, "新しい案が届いています。そちらから選んでください");
  });
  await t("グループへの push が断られた：手作業・手で頼む案内と文面・portal に manual", async () => {
    const x = mk({ push: 400 });
    await press(x, `v1|gy|${tid}|1|1`);
    assert.equal(ticket(x).state, "manual");
    assert.ok(x.replies[0].text.startsWith("山口さんへの依頼を送れませんでした。手で頼んでください（受付 G7）"));
    assert.ok(x.replies[0].text.includes("期日：11/26（木）18時"));
    assert.deepEqual(x.decides[0], { id: tid, req: { decision: "manual", rev: 1 } });
    assert.equal(x.sets.get(GS_STAGE2_SET)?.has(tid), false);
  });
  await t("グループへの push の結果不明：「確かめられませんでした」", async () => {
    const x = mk({ push: null });
    await press(x, `v1|gy|${tid}|1|1`);
    assert.ok(x.replies[0].text.startsWith("山口さんへの依頼を送れたか確かめられませんでした"));
  });
  await t("［直す］：30分の印・「1通で送ってください」。2回直したあとの3回目は手で頼む案内", async () => {
    const x = mk();
    await press(x, `v1|gf|${tid}|1|1`);
    assert.equal((x.m.get(gsFixKey(SHIMO)) as { tid: string; rev: number }).tid, tid);
    assert.ok(x.replies[0].text.startsWith("直すところを1通で送ってください（喋ったままで大丈夫です）。30分以内・あと2回まで"));
    const y = mk({ ticket: { prep: { ...base.prep!, fixes: 2, rev: 3 } } });
    await press(y, `v1|gf|${tid}|1|3`);
    assert.equal(y.replies[0].text, "直すのは2回までです。山口さんへは手で頼んでください（受付 G7）");
    assert.equal(ticket(y).state, "manual");
    assert.deepEqual(y.decides[0], { id: tid, req: { decision: "manual", rev: 3 } });
  });
  await t("直しの1通：Claude の答えで版を上げ、返事でカードを出し直す（push しない）", async () => {
    const x = mk();
    await press(x, `v1|gf|${tid}|1|1`);
    const got = await handleGsFixText({ userId: SHIMO, text: "築年は±5年で", replyToken: "r2" }, fixDeps(x, async (lines, text) => (text.includes("±5年") ? [lines[0], "　築2000〜2010年"] : null)));
    assert.equal(got, true);
    const tk = ticket(x);
    assert.deepEqual(tk.prep!.lines, [LINES[0], "　築2000〜2010年"]);
    assert.deepEqual([tk.prep!.rev, tk.prep!.fixes, tk.prep!.sentRev], [2, 1, 2]);
    assert.equal(x.replies[1].text, "直しました（1回目／2回まで）。これでよければ［いいよ］を押してください（受付 G7）");
    assert.ok(JSON.stringify(x.replies[1].card).includes(`v1|gy|${tid}|1|2`));
    assert.equal(x.m.has(gsFixKey(SHIMO)), false);
    assert.equal(x.pushes.length, 0);
  });
  await t("直しの1通：作り直せなければ回数に数えず「うまく作り直せませんでした」", async () => {
    const x = mk();
    await press(x, `v1|gf|${tid}|1|1`);
    await handleGsFixText({ userId: SHIMO, text: "うーん", replyToken: "r2" }, fixDeps(x, async () => null));
    assert.equal(ticket(x).prep!.fixes, 0);
    assert.ok(x.replies[1].text.startsWith("うまく作り直せませんでした"));
  });
  await t("直しの1通：印が無い・グループ・下村さん以外・off は受けない（false）", async () => {
    const x = mk();
    const d = fixDeps(x, async () => ["x"]);
    assert.equal(await handleGsFixText({ userId: SHIMO, text: "a", replyToken: "r" }, d), false);
    await press(x, `v1|gf|${tid}|1|1`);
    assert.equal(await handleGsFixText({ userId: SHIMO, groupId: G, text: "a", replyToken: "r" }, d), false);
    assert.equal(await handleGsFixText({ userId: "U" + "e".repeat(32), text: "a", replyToken: "r" }, d), false);
    assert.equal(await handleGsFixText({ userId: SHIMO, text: "a", replyToken: "r" }, { ...d, env: { ...ON, GROUP_SATEI_CASE_STAFF_ID: "" } }), false);
  });
  await t("2d が off（山口さんの ID が無い）なら gy・gf は「止めています」", async () => {
    const x = mk({ env: { ...ON, GROUP_SATEI_CASE_STAFF_ID: "" } });
    await press(x, `v1|gy|${tid}|1|1`);
    assert.equal(x.replies[0].text, "いまは止めています");
    assert.equal(x.pushes.length, 0);
  });
  console.log(`${n} passed`);
})();
