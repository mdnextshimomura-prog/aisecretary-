/** 段2a：「何の依頼？」のボタン（gk）の処理（group-satei-actions.ts。KV・portal・LINE は差し替え） */
import assert from "node:assert/strict";
import { handleGroupSateiPostback, type GsActionDeps } from "../src/lib/group-satei-actions";
import { asTicket, gsDecKey, gsTicketKey, parseGsData, ticketIdOf, type GsAction, type GsTicket } from "../src/lib/group-satei-data";
import type { SateiDeal } from "../src/lib/satei-deal";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const OTHER = "U" + "c".repeat(32);
const G = "C" + "a".repeat(32);
const DB = "9999abcd0123456789ab0123456789ab";
const DEAL = "0123abcd0123456789ab0123456789ab";
const tid = ticketIdOf("m1");
const base: GsTicket = { no: 7, ver: 1, groupId: G, requesterId: OTHER, at: 1, triggerMsgIds: ["m1"], mediaIds: [], read: null, state: "asking" };
const ON = { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, GROUP_SATEI_STAGE2: "1" };
const OFF = { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G };
const deal: SateiDeal = { id: DEAL, name: "テスト", dealNo: 12, folderId: "folder_abcdefghij", propertyIds: ["p"], gone: false, parentDbId: DB };

function mk(o: { env?: Record<string, string>; ticket?: Partial<GsTicket> } = {}) {
  const m = new Map<string, unknown>();
  m.set(gsTicketKey(tid), { ...base, ...(o.ticket ?? {}) });
  const replies: Array<{ text: string; card?: unknown }> = [];
  const intakes: unknown[] = [];
  const logs: string[] = [];
  const done = new Set<string>();
  const deps: GsActionDeps = {
    env: o.env ?? ON,
    kv: {
      get: async (k) => m.get(k) ?? null,
      set: async (k, v) => { m.set(k, v); },
      setNx: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
      incr: async () => 1, expire: async () => undefined, sadd: async () => undefined,
      lpushTrim: async () => undefined, lrange: async () => [],
      del: async (k) => { m.delete(k); }, srem: async () => undefined,
    },
    dealsDbId: DB,
    readDeal: async () => ({ deal, kind: "マンション" }),
    intake: async (req) => { intakes.push(req); return { kind: "ok", value: { created: true, no: 12, status: "受付" } }; },
    loadDeals: async () => [{ id: DEAL, name: "テスト", phase: "査定" }],
    reserve: async (k) => ({ proceed: !done.has(k) }),
    complete: async (k) => { done.add(k); },
    reply: async (_t, text, card) => { replies.push({ text, card }); },
    log: (l) => logs.push(l),
  };
  return { deps, m, replies, intakes, logs };
}
const press = (x: ReturnType<typeof mk>, a: GsAction, eventId = "e1", userId = SHIMO) =>
  handleGroupSateiPostback(a, { replyToken: "r", webhookEventId: eventId, source: { userId } }, x.deps);
const gk = (code: string, ver = 1): GsAction => parseGsData(`v1|gk|${tid}|${ver}|${code}`)!;
const ticket = (x: ReturnType<typeof mk>) => asTicket(x.m.get(gsTicketKey(tid)))!;

(async () => {
  await t("data：gk は8つの符号だけ読む", async () => {
    assert.deepEqual(parseGsData(`v1|gk|${tid}|1|doc`), { op: "gk", tid, ver: 1, code: "doc" });
    assert.equal(parseGsData(`v1|gk|${tid}|1|xxx`), null);
    assert.equal(parseGsData(`v1|gk|${tid}|1`), null);
    assert.equal(parseGsData(`v1|gk|${tid}|1|doc|x`), null);
  });
  await t("STAGE2 off：止めています・何も書かない", async () => {
    const x = mk({ env: OFF });
    await press(x, gk("doc"));
    assert.equal(x.replies[0].text, "いまは止めています");
    assert.equal(x.m.has(gsDecKey(tid)), false);
    assert.equal(ticket(x).requestKind, undefined);
    assert.ok(x.logs.includes("[group-satei] gk paused stage2"));
  });
  await t("［資料を送る］：記録だけ（印 gk:doc・受付票は manual・返事）", async () => {
    const x = mk();
    await press(x, gk("doc"));
    assert.equal(x.m.get(gsDecKey(tid)), "gk:doc");
    assert.equal(ticket(x).state, "manual");
    assert.equal(ticket(x).requestKind, "doc");
    assert.equal(x.replies[0].text, "資料を送るとして控えました。中身は手作業でお願いします（受付 G7）");
    assert.equal(x.replies[0].card, undefined);
    assert.ok(x.logs.includes("[group-satei] gk kind doc G7"));
    assert.equal(x.intakes.length, 0);
  });
  await t("2回目（別のボタン・別のイベント）は選択済み", async () => {
    const x = mk();
    await press(x, gk("doc"), "e1");
    await press(x, gk("money"), "e2");
    assert.match(x.replies[1].text, /選択済みです（受付 G7）/);
    assert.equal(ticket(x).requestKind, "doc");
  });
  await t("LINE の再送（同じイベント）には返事をしない", async () => {
    const x = mk();
    await press(x, gk("doc"), "e1");
    await press(x, gk("doc"), "e1");
    assert.equal(x.replies.length, 1);
  });
  await t("［査定］：印は取らない・requestKind=satei・案件を選ぶカード、そのあと案件を選べる", async () => {
    const x = mk();
    await press(x, gk("satei"), "e1");
    assert.equal(x.m.has(gsDecKey(tid)), false);
    assert.equal(ticket(x).state, "asking");
    assert.equal(ticket(x).requestKind, "satei");
    assert.equal(x.replies[0].text, "査定で進めます。どの案件か選んでください（受付 G7）");
    assert.ok(JSON.stringify(x.replies[0].card).includes(`v1|gl|${tid}|1|0`));
    await press(x, { op: "gs", tid, ver: 1, dealId: DEAL }, "e2");
    assert.equal(x.intakes.length, 1);
    assert.equal(ticket(x).state, "started");
    assert.equal(ticket(x).requestKind, "satei");
  });
  await t("案件を選んだあとの gk は選択済み", async () => {
    const x = mk();
    await press(x, { op: "gs", tid, ver: 1, dealId: DEAL }, "e1");
    await press(x, gk("doc"), "e2");
    assert.match(x.replies[1].text, /選択済みです/);
    assert.equal(ticket(x).state, "started");
  });
  await t("押せるのは下村さんだけ・古い版は新しいカードへ", async () => {
    const a = mk();
    await press(a, gk("doc"), "e1", OTHER);
    assert.equal(a.replies[0].text, "いまは下村さんだけが使えます");
    const b = mk({ ticket: { ver: 2 } });
    await press(b, gk("doc"));
    assert.match(b.replies[0].text, /新しいカード/);
    assert.equal(b.m.has(gsDecKey(tid)), false);
  });
  await t("案件の選択：STAGE2 on なら requestKind=satei、off なら書かない（段1の票のまま）", async () => {
    const on = mk();
    await press(on, { op: "gs", tid, ver: 1, dealId: DEAL });
    assert.equal(ticket(on).requestKind, "satei");
    const off = mk({ env: OFF });
    await press(off, { op: "gs", tid, ver: 1, dealId: DEAL });
    assert.equal(ticket(off).state, "started");
    assert.equal(ticket(off).requestKind, undefined);
  });
  console.log(`group-satei-kind-actions: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
