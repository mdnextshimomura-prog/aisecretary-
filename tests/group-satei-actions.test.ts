/** group-satei-actions.ts */
import assert from "node:assert/strict";
import { handleGroupSateiPostback, type GsActionDeps } from "../src/lib/group-satei-actions";
import { asTicket, gsDecKey, gsTicketKey, ticketIdOf, type GsAction, type GsTicket } from "../src/lib/group-satei-data";
import type { SateiDeal } from "../src/lib/satei-deal";
import { SATEI_CODE_AWAITING_REASON } from "../src/lib/satei-portal";
import { MSG_GS_LIST_END } from "../src/lib/group-satei-card";

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

function mk(o: { kind?: string | null; folder?: boolean; intake?: any; ticket?: Partial<GsTicket> | null; userId?: string; env?: Record<string, string>; kv?: Partial<NonNullable<GsActionDeps["kv"]>>; intakeThrows?: boolean; deals?: Array<{ id: string; name: string }> } = {}) {
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
      ...(o.kv ?? {}),
    },
    dealsDbId: DB,
    readDeal: async () => ({ deal: deal(o.folder === false ? { folderId: null } : {}), kind: o.kind === undefined ? "マンション" : o.kind }),
    intake: async (req) => { intakes.push(req); if (o.intakeThrows) throw new Error("x"); return o.intake ?? { kind: "ok", value: { created: true, no: 12 } }; },
    loadDeals: async () => o.deals ?? [{ id: DEAL, name: "テスト", phase: "査定" }],
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
  await t("TASK_SATEI=0 → portal を呼ばず・印を取らず・手作業の文（manual satei-off）", async () => {
    const x = mk({ env: { TASK_SATEI: "0", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G } });
    await press(x, gs);
    assert.equal(x.intakes.length, 0);
    assert.equal(x.m.has(gsDecKey(tid)), false);
    assert.match(x.replies[0].text, /手作業の査定に回します/);
    assert.doesNotMatch(x.replies[0].text, /種別が分からない/);
    assert.ok(x.logs.some((l) => /gs manual satei-off$/.test(l)));
  });
  await t("理由待ち → 印を外し、受付票は asking のまま", async () => {
    const x = mk({ intake: { kind: "rejected", status: 409, code: SATEI_CODE_AWAITING_REASON } });
    await press(x, gs);
    assert.match(x.replies[0].text, /理由/);
    assert.equal(x.m.has(gsDecKey(tid)), false);
    assert.equal(asTicket(x.m.get(gsTicketKey(tid)))?.state, "asking");
  });
  await t("intake が例外 → 結果不明。印の値は unknown:、押し直しでは portal を呼ばない", async () => {
    const x = mk({ intakeThrows: true });
    await press(x, gs, "e1");
    assert.match(x.replies[0].text, /確かめられませんでした/);
    assert.equal(x.m.get(gsDecKey(tid)), `unknown:${DEAL}`);
    await press(x, gs, "e2");
    assert.equal(x.intakes.length, 1);
    assert.match(x.replies[1].text, /確かめられませんでした/);
  });
  await t("結果不明の判定は印の値で（受付票の保存に失敗しても）", async () => {
    const x = mk({ intake: { kind: "unknown", reason: "timeout" } });
    x.deps.kv!.set = async (k, v) => { if (k === gsTicketKey(tid)) throw new Error("kv"); x.m.set(k, v); };
    await press(x, gs, "e1");
    assert.match(x.replies[0].text, /確かめられませんでした/);
    assert.ok(x.logs.some((l) => /save-failed/.test(l)));
    await press(x, gs, "e2");
    assert.equal(x.intakes.length, 1);
    assert.match(x.replies[1].text, /確かめられませんでした/);
  });
  await t("受付できたあと受付票の保存に失敗 → ログだけ・返事は受け付けました", async () => {
    const x = mk({ kv: {} });
    x.deps.kv!.set = async () => { throw new Error("kv"); };
    await press(x, gs);
    assert.match(x.replies[0].text, /受け付けました/);
    assert.ok(x.logs.some((l) => /save-failed/.test(l)));
  });
  await t("rejected で印を外すのに失敗 → ログだけ・返事は受け付けられませんでした", async () => {
    const x = mk({ intake: { kind: "rejected", status: 400, code: "X" }, kv: { del: async () => { throw new Error("kv"); } } });
    await press(x, gs);
    assert.match(x.replies[0].text, /受け付けられませんでした/);
    assert.ok(x.logs.some((l) => /save-failed/.test(l)));
  });
  await t("gm → gn：仮の決定のあと閉じられる", async () => {
    const x = mk();
    await press(x, { op: "gm", tid, ver: 1 }, "e1");
    await press(x, { op: "gn", tid, ver: 1 }, "e2");
    assert.match(x.replies[1].text, /閉じました/);
    const tk = asTicket(x.m.get(gsTicketKey(tid)));
    assert.equal(tk?.state, "dismissed");
    assert.equal(tk?.provisional, false);
  });
  await t("gm を連打しても保存し直さない（7日を延ばさない）", async () => {
    let sets = 0;
    const x = mk();
    const orig = x.deps.kv!.set;
    x.deps.kv!.set = async (k, v, ex) => { sets++; return orig(k, v, ex); };
    await press(x, { op: "gm", tid, ver: 1 }, "e1");
    await press(x, { op: "gm", tid, ver: 1 }, "e2");
    assert.equal(sets, 1);
    assert.match(x.replies[1].text, /選び直せます（7日間）/);
  });
  await t("gm の保存の直前に印が付いていたら保存せず選択済み", async () => {
    let decReads = 0;
    const x = mk();
    x.deps.kv!.get = async (k) => {
      if (k === gsDecKey(tid)) return ++decReads >= 2 ? `gs:${DEAL}` : null;
      return x.m.get(k) ?? null;
    };
    await press(x, { op: "gm", tid, ver: 1 });
    assert.match(x.replies[0].text, /選択済みです（受付 G7）/);
    assert.equal(asTicket(x.m.get(gsTicketKey(tid)))?.provisional, undefined);
  });
  await t("decide が例外 → 予約を完了にしない（同じイベントの再送で処理し直せる）", async () => {
    const x = mk();
    let fail = true;
    x.deps.kv!.get = async (k) => {
      if (k === gsDecKey(tid) && fail) throw new Error("kv");
      return x.m.get(k) ?? null;
    };
    await press(x, gs, "e1");
    assert.match(x.replies[0].text, /いま操作を受け付けられません/);
    fail = false;
    await press(x, gs, "e1");
    assert.equal(x.intakes.length, 1);
  });
  await t("受付票のグループが対象から外れた → 止めています（予約しない）", async () => {
    const x = mk({ env: { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: "C" + "d".repeat(32) } });
    let reserved = 0;
    x.deps.reserve = async () => { reserved++; return { proceed: true }; };
    await press(x, gs);
    assert.equal(x.intakes.length, 0);
    assert.equal(reserved, 0);
    assert.match(x.replies[0].text, /止めています/);
  });
  await t("一覧の先が無い → 定数の文", async () => {
    const x = mk();
    await press(x, { op: "gl", tid, ver: 1, offset: 10 });
    assert.equal(x.replies[0].text, MSG_GS_LIST_END);
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
