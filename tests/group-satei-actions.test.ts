/** group-satei-actions.ts */
import assert from "node:assert/strict";
import { handleGroupSateiPostback, type GsActionDeps } from "../src/lib/group-satei-actions";
import { asTicket, gsDecKey, gsTicketKey, ticketIdOf, type GsAction, type GsTicket } from "../src/lib/group-satei-data";
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
const base: GsTicket = { no: 7, ver: 1, groupId: G, requesterId: OTHER, at: 1, triggerMsgIds: ["m1"], mediaIds: [], read: { address: "x", propertyName: null, kind: "戸建", basis: "登記", confidence: 0.9 }, state: "asking" };
const deal = (o: Partial<SateiDeal> = {}): SateiDeal => ({ id: DEAL, name: "テスト", dealNo: 12, folderId: "folder_abcdefghij", propertyIds: ["p"], gone: false, parentDbId: DB, ...o });

function mk(o: { kind?: string | null; folder?: boolean; intake?: any; ticket?: Partial<GsTicket> | null; userId?: string; env?: Record<string, string> } = {}) {
  const m = new Map<string, unknown>();
  if (o.ticket !== null) m.set(gsTicketKey(tid), { ...base, ...(o.ticket ?? {}) });
  const replies: Array<{ text: string; card?: unknown }> = [];
  const intakes: any[] = [];
  const logs: string[] = [];
  const done = new Set<string>();
  const deps: GsActionDeps = {
    env: o.env ?? { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G },
    kv: {
      get: async (k) => m.get(k) ?? null,
      set: async (k, v) => { m.set(k, v); },
      setNx: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
      incr: async () => 1, expire: async () => undefined, sadd: async () => undefined,
      lpushTrim: async () => undefined, lrange: async () => [],
      del: async (k) => { m.delete(k); }, srem: async () => undefined,
    },
    dealsDbId: DB,
    readDeal: async () => ({ deal: deal(o.folder === false ? { folderId: null } : {}), kind: o.kind === undefined ? "マンション" : o.kind }),
    intake: async (req) => { intakes.push(req); return o.intake ?? { kind: "ok", value: { created: true, no: 12 } }; },
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
const gs: GsAction = { op: "gs", tid, ver: 1, dealId: DEAL };

(async () => {
  await t("マンション・フォルダあり → portal の受付を1回・決まった依頼 ID", async () => {
    const x = mk();
    await press(x, gs);
    assert.equal(x.intakes.length, 1);
    assert.equal(x.intakes[0].eventId, `gs${tid}`);
    assert.match(x.replies[0].text, /受け付けました/);
    assert.equal(asTicket(x.m.get(gsTicketKey(tid)))?.state, "started");
  });
  await t("二度押し（別イベント）・LINE の再送（同じイベント）で2回目の受付は無い", async () => {
    const x = mk();
    await press(x, gs, "e1");
    await press(x, gs, "e1");
    await press(x, gs, "e2");
    assert.equal(x.intakes.length, 1);
    assert.match(x.replies[1].text, /選択済みです（受付 G7）/);
  });
  await t("古い版のカード", async () => {
    const x = mk({ ticket: { ver: 2 } });
    await press(x, gs);
    assert.equal(x.intakes.length, 0);
    assert.match(x.replies[0].text, /新しいカード/);
  });
  await t("戸建 → 手作業・受付は呼ばない", async () => {
    const x = mk({ kind: "戸建" });
    await press(x, gs);
    assert.equal(x.intakes.length, 0);
    assert.match(x.replies[0].text, /戸建のため自動作成はできません/);
    assert.equal(asTicket(x.m.get(gsTicketKey(tid)))?.state, "manual");
  });
  await t("種別が空 → 種別が分からない", async () => {
    const x = mk({ kind: null });
    await press(x, gs);
    assert.match(x.replies[0].text, /種別が分からないため/);
  });
  await t("CRM はマンション・資料は戸建 → 警告を1行足す", async () => {
    const x = mk();
    await press(x, gs);
    assert.match(x.replies[0].text, /資料からは戸建に見えます/);
  });
  await t("マンション・フォルダなし → 決めない（押し直せる）", async () => {
    const x = mk({ folder: false });
    await press(x, gs, "e1");
    assert.match(x.replies[0].text, /Driveフォルダが未設定/);
    assert.equal(x.m.has(gsDecKey(tid)), false);
    assert.equal(asTicket(x.m.get(gsTicketKey(tid)))?.state, "asking");
  });
  await t("受付の結果不明 → 印を残し、押し直しでは portal を呼ばない", async () => {
    const x = mk({ intake: { kind: "unknown", reason: "timeout" } });
    await press(x, gs, "e1");
    await press(x, gs, "e2");
    assert.equal(x.intakes.length, 1);
    assert.match(x.replies[1].text, /確かめられませんでした/);
  });
  await t("受け付けられない → 印を外して押し直せる", async () => {
    const x = mk({ intake: { kind: "rejected", status: 400, code: "X" } });
    await press(x, gs, "e1");
    assert.equal(x.m.has(gsDecKey(tid)), false);
    assert.equal(asTicket(x.m.get(gsTicketKey(tid)))?.state, "asking");
  });
  await t("案件がまだ無い → 仮の決定。あとで一覧から1回だけ選び直せる", async () => {
    const x = mk();
    await press(x, { op: "gm", tid, ver: 1 }, "e1");
    assert.match(x.replies[0].text, /選び直せます（7日間）/);
    assert.equal(asTicket(x.m.get(gsTicketKey(tid)))?.provisional, true);
    await press(x, gs, "e2");
    assert.equal(x.intakes.length, 1);
    await press(x, gs, "e3");
    assert.equal(x.intakes.length, 1);
  });
  await t("査定の依頼ではない → 閉じる。そのあと何を押しても選択済み", async () => {
    const x = mk();
    await press(x, { op: "gn", tid, ver: 1 }, "e1");
    assert.match(x.replies[0].text, /閉じました/);
    await press(x, gs, "e2");
    assert.equal(x.intakes.length, 0);
    assert.match(x.replies[1].text, /選択済み/);
  });
  await t("一覧：カルーセルを返す（決めない）", async () => {
    const x = mk();
    await press(x, { op: "gl", tid, ver: 1, offset: 0 });
    assert.ok(x.replies[0].card);
  });
  await t("押せるのは下村さんだけ・off なら止めています・受付票が無ければ期限切れ", async () => {
    let x = mk();
    await press(x, gs, "e1", OTHER);
    assert.match(x.replies[0].text, /下村さんだけ/);
    x = mk({ env: { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO } });
    await press(x, gs);
    assert.match(x.replies[0].text, /止めています/);
    x = mk({ ticket: null });
    await press(x, gs);
    assert.match(x.replies[0].text, /期限が切れています/);
  });
  await t("案件 ID がハイフン入り・大文字でも同じ案件として受け付ける", async () => {
    const x = mk();
    const hy = `${DEAL.slice(0, 8)}-${DEAL.slice(8, 12)}-${DEAL.slice(12, 16)}-${DEAL.slice(16, 20)}-${DEAL.slice(20)}`.toUpperCase();
    await press(x, { op: "gs", tid, ver: 1, dealId: hy });
    assert.equal(x.intakes.length, 1);
    assert.equal(asTicket(x.m.get(gsTicketKey(tid)))?.dealId, DEAL);
  });
  await t("ログに案件名・userId を出さない", async () => {
    const x = mk();
    await press(x, gs);
    const l = x.logs.join("\n");
    assert.ok(!l.includes("テスト") && !l.includes(SHIMO));
    assert.ok(x.logs.some((s) => /^\[group-satei\] gs started G7 #J12/.test(s)));
  });
  console.log(`group-satei-actions: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
