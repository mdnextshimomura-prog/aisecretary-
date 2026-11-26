/** 段2d：案件を決めたら portal の準備へ（group-satei-actions.ts → group-satei-propose.ts。KV・portal・LINE は差し替え） */
import assert from "node:assert/strict";
import { handleGroupSateiPostback, type GsActionDeps } from "../src/lib/group-satei-actions";
import { asTicket, GS_STAGE2_SET, gsDecKey, gsTicketKey, parseGsData, ticketIdOf, type GsTicket } from "../src/lib/group-satei-data";
import type { SateiPrepIntakeReq } from "../src/lib/group-satei-prep-portal";
import type { SateiDeal } from "../src/lib/satei-deal";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const G = "C" + "a".repeat(32);
const DB = "9999abcd0123456789ab0123456789ab";
const DEAL = "0123abcd0123456789ab0123456789ab";
const tid = ticketIdOf("m1");
const base: GsTicket = {
  no: 7, ver: 1, groupId: G, requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], state: "asking",
  read: { address: "大阪市北区天満2丁目3-4", propertyName: "パークハウス天満 1203号室", kind: "マンション", basis: "本文", confidence: 0.9,
    facts: { roomNo: "1203", exclusiveArea: 65.3, landArea: null, buildingArea: null, builtYm: "2005-03", layout: null, floor: null, totalUnits: null, structure: null } },
};
const ON = { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, GROUP_SATEI_STAGE2: "1", GROUP_SATEI_CASE_STAFF_ID: STAFF };
const deal: SateiDeal = { id: DEAL, name: "山田様 売却", dealNo: 12, folderId: "folder_abcdefghij", propertyIds: ["p"], gone: false, parentDbId: DB };

function mk(o: { env?: Record<string, string>; kind?: string; intake?: unknown; folderId?: string | null } = {}) {
  const m = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  m.set(gsTicketKey(tid), base);
  const replies: Array<{ text: string; card?: unknown }> = [];
  const preps: SateiPrepIntakeReq[] = [];
  const intakes: unknown[] = [];
  const logs: string[] = [];
  const deps: GsActionDeps = {
    env: o.env ?? ON,
    kv: {
      get: async (k) => m.get(k) ?? null,
      set: async (k, v) => { m.set(k, v); },
      setNx: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
      incr: async () => 1, expire: async () => undefined,
      sadd: async (k, v) => { (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(v); },
      lpushTrim: async () => undefined, lrange: async () => [],
      del: async (k) => { m.delete(k); }, srem: async (k, v) => { sets.get(k)?.delete(v); },
    },
    dealsDbId: DB,
    readDeal: async () => ({ deal: { ...deal, folderId: o.folderId === undefined ? deal.folderId : o.folderId }, kind: o.kind ?? "マンション" }),
    intake: async (req) => { intakes.push(req); return { kind: "ok", value: { created: true, no: 12, status: "受付" } }; },
    loadDeals: async () => [{ id: DEAL, name: "x", phase: "査定" }],
    reserve: async () => ({ proceed: true }),
    complete: async () => undefined,
    reply: async (_t, text, card) => { replies.push({ text, card }); },
    log: (l) => logs.push(l),
    prep: {
      intake: async (req) => { preps.push(req); return (o.intake as never) ?? { kind: "ok", value: { created: true, status: "受付" } }; },
      notices: async () => ({ kind: "ok", value: [] }),
      decide: async () => ({ kind: "ok", value: { status: "手作業" } }),
    },
    push: async () => 200,
    now: () => 1_000,
  };
  return { deps, m, sets, replies, preps, intakes, logs };
}
const pick = (x: ReturnType<typeof mk>) =>
  handleGroupSateiPostback(parseGsData(`v1|gs|${tid}|1|${DEAL}`)!, { replyToken: "r", webhookEventId: "e1", source: { userId: SHIMO } }, x.deps);
const ticket = (x: ReturnType<typeof mk>) => asTicket(x.m.get(gsTicketKey(tid)))!;

(async () => {
  await t("マンション：今の受付は呼ばず、portal の準備へ。受付票は gathering・見回りの集合に入る", async () => {
    const x = mk();
    await pick(x);
    assert.equal(x.intakes.length, 0);
    assert.deepEqual(x.preps[0], {
      tid, no: 7, dealId: DEAL, folderId: "folder_abcdefghij", kind: "マンション", place: "大阪市北区天満2丁目3-4", building: "パークハウス天満",
      facts: { builtYm: "2005-03", exclusiveArea: 65.3, landArea: null, buildingArea: null }, requestedBy: SHIMO,
    });
    assert.equal(JSON.stringify(x.preps[0]).includes("山田"), false, "案件名を portal に渡さない");
    assert.equal(ticket(x).state, "gathering");
    assert.equal(ticket(x).requestKind, "satei");
    assert.equal(ticket(x).prepAt, 1_000);
    assert.deepEqual(ticket(x).prep, { kind: "マンション", rev: 0, lines: [], fixes: 0, sentRev: 0, tries: 0, groupPushes: 0 });
    assert.equal(x.m.get(gsDecKey(tid)), `prep:${DEAL}`);
    assert.ok(x.sets.get(GS_STAGE2_SET)?.has(tid));
    assert.equal(x.replies[0].text, "査定で進めます。事例の取り方の案を作って、数分でお送りします（受付 G7）");
    assert.ok(x.logs.includes("[group-satei] gs prep sent G7"));
  });
  await t("戸建・土地も準備へ（建物名は渡さない）", async () => {
    for (const kind of ["戸建", "土地"]) {
      const x = mk({ kind });
      await pick(x);
      assert.equal(x.preps[0].kind, kind);
      assert.equal(x.preps[0].building, null);
      assert.equal(ticket(x).state, "gathering");
    }
  });
  await t("山口さんの ID が無ければ 2a のまま（マンションは今の受付）", async () => {
    const x = mk({ env: { ...ON, GROUP_SATEI_CASE_STAFF_ID: "" } });
    await pick(x);
    assert.equal(x.preps.length, 0);
    assert.equal(x.intakes.length, 1);
  });
  await t("portal が PREP_DISABLED：印を外して 2a の道へ（マンションは今の受付）", async () => {
    const x = mk({ intake: { kind: "rejected", status: 503, code: "PREP_DISABLED" } });
    await pick(x);
    assert.equal(x.intakes.length, 1);
    assert.equal(ticket(x).state, "started");
  });
  await t("受付停止：印を外して「止めています」", async () => {
    const x = mk({ intake: { kind: "rejected", status: 503, code: "INTAKE_STOPPED" } });
    await pick(x);
    assert.equal(x.m.has(gsDecKey(tid)), false);
    assert.equal(ticket(x).state, "asking");
    assert.equal(x.replies[0].text, "いま受付を止めています。少し待ってから、もう一度案件を選んでください（受付 G7）");
  });
  await t("結果不明：gathering のまま（届いていれば見回りが案を拾う）。30分の知らせを案内", async () => {
    const x = mk({ intake: { kind: "unknown", reason: "timeout" } });
    await pick(x);
    assert.equal(ticket(x).state, "gathering");
    assert.ok(x.replies[0].text.startsWith("事例の案づくりを頼めたか確かめられませんでした"));
  });
  await t("ほかの断り：印を外して手で頼む案内", async () => {
    const x = mk({ intake: { kind: "rejected", status: 400, code: "INVALID_REQUEST" } });
    await pick(x);
    assert.equal(x.m.has(gsDecKey(tid)), false);
    assert.ok(x.replies[0].text.startsWith("事例の案づくりを受け付けられませんでした"));
  });
  await t("フォルダが無い：準備へ進まない", async () => {
    const x = mk({ folderId: null });
    await pick(x);
    assert.equal(x.preps.length, 0);
    assert.ok(x.replies[0].text.length > 0);
  });
  console.log(`${n} passed`);
})();
