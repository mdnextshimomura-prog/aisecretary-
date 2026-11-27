/**
 * 案件の自動登録（計画 2026-11-27 の A4〜A7）：［査定］・［案件がまだ無い］からの流れ。KV・Notion・portal・LINE は差し替え。
 * off のときに今と変わらないことは tests/group-satei-auto-off.test.ts（sha256 で固定）。
 */
import assert from "node:assert/strict";
import { handleGroupSateiPostback, type GsActionDeps } from "../src/lib/group-satei-actions";
import type { GsAutoDealInput, GsAutoPropertyInput } from "../src/lib/group-satei-auto-notion";
import { asTicket, GS_AUTO_SET, GS_STAGE2_SET, gsDecKey, gsInfoKey, gsTicketKey, parseGsData, ticketIdOf, type GsTicket } from "../src/lib/group-satei-data";
import { handleGsInfoText } from "../src/lib/group-satei-info";
import { gsSateiNextCard, msgGsAlready, msgGsKindSatei, msgGsNoDeal } from "../src/lib/group-satei-card";
import { msgGsPrepStarted, msgGsPrepStopped, msgGsPrepUnknown } from "../src/lib/group-satei-case";
import { sateiPrepIntake, type SateiPrepIntakeReq } from "../src/lib/group-satei-prep-portal";
import type { SateiDeal } from "../src/lib/satei-deal";
import type { DealRef } from "../src/lib/task-record";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const G = "C" + "a".repeat(32);
const DB = "9999abcd0123456789ab0123456789ab";
const PROPS_DB = "7777abcd0123456789ab0123456789ab";
const OLD = "0123abcd0123456789ab0123456789ab";
const NEW_PROP = "aaaa0000aaaa0000aaaa0000aaaa0000";
const NEW_DEAL = "bbbb0000bbbb0000bbbb0000bbbb0000";
const tid = ticketIdOf("m1");
const TID8 = tid.slice(0, 8);
const NOW = Date.UTC(2026, 10, 27, 1);
const facts = { roomNo: "1203", exclusiveArea: 65.3, landArea: null, buildingArea: null, builtYm: "2005-03", layout: null, floor: null, totalUnits: null, structure: null };
const base: GsTicket = {
  no: 7, ver: 1, groupId: G, requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], state: "asking",
  read: { address: "大阪市北区天満2丁目3-4", propertyName: "パークハウス天満 1203", kind: "マンション", basis: "本文", confidence: 0.9, facts },
};
const ON = {
  TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, GROUP_SATEI_STAGE2: "1", GROUP_SATEI_CASE_STAFF_ID: STAFF,
  CRM_DEALS_DB_ID: DB, CRM_PROPERTIES_DB_ID: PROPS_DB, GROUP_SATEI_AUTO_DEAL: "1",
};
const oldDeal: SateiDeal = { id: OLD, name: "売却｜山田｜パークハウス天満", dealNo: 12, folderId: "folder_abcdefghij", propertyIds: ["p"], gone: false, parentDbId: DB };

/** 文面（計画 A6。一字一句） */
const M1 = "進行中の案件「売却｜山田｜パークハウス天満」に合ったので、この案件で進めます（受付 G7）";
const M2 = "案件 DEAL-0231 として登録しました（受付 G7）。フォルダを作って、事例の取り方の案を数分でお送りします。顧客と案件ソースは、あとで Notion に入れてください";
const M3 = "合いそうな案件が複数あるので、選んでください（受付 G7）";
const M3_DUP = "同じ物件の進行中の案件が見つかりました。一覧から選んでください（受付 G7）";
const M7 = "案件の自動登録が途中で止まりました（受付 G7）。カードの［一覧から選ぶ］で選ぶか、もう一度［査定］を押してください";
const M7_DEAL = "案件の自動登録が途中で止まりました（受付 G7）。CRM_案件 DEAL-0231 はできています。カードの［一覧から選ぶ］で選ぶか、もう一度［査定］を押してください";
const M8 = "案件を登録できませんでした（受付 G7）。少し待ってから、もう一度［査定］を押してください";
const M8_INTAKE = "案件 DEAL-0231 は登録しましたが、事例の案づくりを受け付けられませんでした（受付 G7）。山口さんへは手で頼んでください";
const HEAD = "案件 DEAL-0231 として登録しました。";
const REMARK = `グループ査定 受付 G7 から自動登録（票 ${TID8}）`;
const FOLDER_NAME = "DEAL-0231_売却_顧客未定_パークハウス天満 1203";

interface Opt {
  env?: Record<string, string>;
  ticket?: Partial<GsTicket>;
  deals?: DealRef[];
  intake?: unknown;
  propFail?: number;
  dealFail?: number;
  dup?: boolean;
  dealNo?: number | null;
  readNo?: number | null;
  noAuto?: boolean;
}
function mk(o: Opt = {}) {
  const m = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  m.set(gsTicketKey(tid), { ...base, ...(o.ticket ?? {}) });
  const replies: Array<{ text: string; card?: unknown }> = [];
  const preps: SateiPrepIntakeReq[] = [];
  const intakes: unknown[] = [];
  const logs: string[] = [];
  const order: string[] = [];
  const props: GsAutoPropertyInput[] = [];
  const deals: GsAutoDealInput[] = [];
  let propFail = o.propFail ?? 0;
  let dealFail = o.dealFail ?? 0;
  let ev = 0;
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
      if (v && v.token === token) { m.delete(k); return true; }
      return false;
    },
  };
  const deps: GsActionDeps = {
    env: o.env ?? ON,
    kv,
    dealsDbId: DB,
    readDeal: async (id) => {
      order.push(`readDeal ${id === NEW_DEAL ? "new" : "old"}`);
      return id === NEW_DEAL
        ? { deal: { id: NEW_DEAL, name: "査定｜顧客未定｜パークハウス天満 1203", dealNo: 231, folderId: null, propertyIds: [NEW_PROP], gone: false, parentDbId: DB }, kind: "マンション" }
        : { deal: oldDeal, kind: "マンション" };
    },
    intake: async (req) => { intakes.push(req); return { kind: "ok", value: { created: true, no: 12, status: "受付" } }; },
    loadDeals: async () => { order.push("loadDeals"); return o.deals ?? [{ id: "x1", name: "売却｜鈴木｜グランドメゾン梅田 501", phase: "【売】査定" }]; },
    reserve: async () => ({ proceed: true }),
    complete: async () => undefined,
    reply: async (_t, text, card) => { replies.push({ text, card }); },
    log: (l) => logs.push(l),
    prep: {
      intake: async (req) => { order.push("portal"); preps.push(req); return (o.intake as never) ?? { kind: "ok", value: { created: true, status: "受付" } }; },
      notices: async () => ({ kind: "ok", value: [] }),
      decide: async () => ({ kind: "ok", value: { status: "手作業" } }),
    },
    push: async () => 200,
    now: () => NOW,
    autoDeal: o.noAuto ? null : {
      findOrCreateProperty: async (p) => {
        order.push("prop");
        if (propFail > 0) { propFail--; throw new Error("notion"); }
        props.push(p);
        return { id: NEW_PROP };
      },
      findOrCreateDeal: async (p) => {
        order.push("deal");
        if (dealFail > 0) { dealFail--; throw new Error("notion"); }
        if (o.dup) return { kind: "dup" };
        deals.push(p);
        return { kind: "ok", id: NEW_DEAL, dealNo: o.dealNo === undefined ? 231 : o.dealNo };
      },
      readDealNo: async () => { order.push("readDealNo"); return o.readNo === undefined ? null : o.readNo; },
      propTitle: async () => { order.push("propTitle"); return "パークハウス天満 1203"; },
      sleep: async () => { order.push("sleep"); },
    },
  };
  const press = (data: string) =>
    handleGroupSateiPostback(parseGsData(data)!, { replyToken: "r", webhookEventId: `e${++ev}`, source: { userId: SHIMO } }, deps);
  return {
    deps, kv, m, sets, replies, preps, intakes, logs, order, props, deals,
    satei: () => press(`v1|gk|${tid}|1|satei`),
    gm: () => press(`v1|gm|${tid}|1`),
    press,
    ticket: () => asTicket(m.get(gsTicketKey(tid)))!,
    dec: () => m.get(gsDecKey(tid)),
    q: () => Array.from(sets.get(GS_AUTO_SET) ?? []),
    last: () => replies[replies.length - 1],
  };
}
const EXACT: DealRef[] = [{ id: OLD, name: "売却｜山田｜パークハウス天満", phase: "【売】査定" }];

(async () => {
  await t("on でも Notion の口が無ければ今の返事（自動登録しない）", async () => {
    const x = mk({ noAuto: true });
    await x.satei();
    assert.equal(x.last().text, msgGsKindSatei(7));
    assert.deepEqual(x.last().card, gsSateiNextCard(tid, 1, 7));
    assert.deepEqual(x.order, []);
    assert.equal(x.dec(), undefined);
  });

  await t("one：ぴったり合う案件が1件 → Notion に書かず準備へ。返事は M1＋今の文。portal への JSON は今の形（folderId）", async () => {
    const x = mk({ deals: EXACT });
    await x.satei();
    assert.equal(x.last().text, `${M1}\n${msgGsPrepStarted(7)}`);
    assert.deepEqual([x.props.length, x.deals.length, x.order.filter((s) => s === "prop" || s === "deal" || s === "propTitle").length], [0, 0, 0]);
    assert.deepEqual(x.preps[0], {
      tid, no: 7, dealId: OLD, folderId: "folder_abcdefghij", kind: "マンション", place: "大阪市北区天満2丁目3-4", building: "パークハウス天満",
      facts: { builtYm: "2005-03", exclusiveArea: 65.3, landArea: null, buildingArea: null }, requestedBy: SHIMO,
    });
    assert.equal(JSON.stringify(x.preps[0]).includes("newFolder"), false);
    assert.equal(x.ticket().state, "gathering");
    assert.equal(x.ticket().auto, undefined, "既存の案件では auto を書かない");
    assert.equal(x.dec(), `prep:${OLD}`);
    assert.ok(x.logs.includes("[group-satei] auto matched G7"));
  });

  await t("none：物件 → 案件 → portal の順。portal へ newFolder。返事は M2。受付票は gathering・auto.step は folder", async () => {
    const x = mk();
    await x.satei();
    assert.deepEqual(x.order, ["loadDeals", "prop", "deal", "readDeal new", "propTitle", "portal"]);
    assert.deepEqual(x.props[0], {
      title: "パークハウス天満 1203", kind: "マンション", address: "大阪市北区天満2丁目3-4", landArea: null, buildingArea: null, remark: REMARK, mark: `票 ${TID8}`,
    });
    assert.deepEqual(x.deals[0], {
      name: "査定｜顧客未定｜パークハウス天満 1203", propTitle: "パークハウス天満 1203", propertyId: NEW_PROP, remark: REMARK, mark: `票 ${TID8}`,
    });
    assert.deepEqual(x.preps[0], {
      tid, no: 7, dealId: NEW_DEAL, kind: "マンション", place: "大阪市北区天満2丁目3-4", building: "パークハウス天満",
      facts: { builtYm: "2005-03", exclusiveArea: 65.3, landArea: null, buildingArea: null }, requestedBy: SHIMO,
      newFolder: { name: FOLDER_NAME },
    });
    assert.equal("folderId" in x.preps[0], false, "folderId と newFolder はどちらか一方だけ");
    assert.deepEqual(x.replies, [{ text: M2, card: undefined }]);
    const tk = x.ticket();
    assert.equal(tk.state, "gathering");
    assert.equal(tk.dealId, NEW_DEAL);
    assert.deepEqual(tk.auto, { propId: NEW_PROP, dealId: NEW_DEAL, dealNo: 231, step: "folder", at: NOW, tries: 1, linked: false });
    assert.equal(x.dec(), `prep:${NEW_DEAL}`);
    assert.deepEqual(x.q(), [], "終わったら途中の集合から外す");
    assert.deepEqual(Array.from(x.sets.get(GS_STAGE2_SET) ?? []), [tid]);
    assert.equal(x.intakes.length, 0);
    assert.ok(x.logs.includes("[group-satei] auto registered G7 D231"));
  });

  await t("portal の口：newFolder の本文は計画 B1 の欄だけ（folderId を入れない）", async () => {
    const x = mk();
    await x.satei();
    const bodies: string[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return { status: 201, ok: true, json: async () => ({ created: true, prep: { status: "受付" } }) } as Response;
    }) as unknown as typeof fetch;
    await sateiPrepIntake({ ...x.preps[0], extra: 1 } as never, { fetchImpl, baseUrl: "https://p.example.test", token: "k", timeoutMs: 1000 });
    assert.equal(
      bodies[0],
      JSON.stringify({
        tid, no: 7, dealId: NEW_DEAL, kind: "マンション", place: "大阪市北区天満2丁目3-4", building: "パークハウス天満",
        facts: { builtYm: "2005-03", exclusiveArea: 65.3, landArea: null, buildingArea: null }, requestedBy: SHIMO, newFolder: { name: FOLDER_NAME },
      }),
    );
  });

  await t("ask：部分一致だけ・完全一致が2件・【買】の案件 → 今のカード＋M3。Notion も portal も呼ばない", async () => {
    for (const [deals, reason] of [
      [[{ id: "p1", name: "相談｜田中｜パークハウス天満 1203 駐車場", phase: "【売】査定" }], "partial"],
      [[...EXACT, { id: "p2", name: "購入｜田中｜パークハウス天満", phase: "【売】媒介" }], "exact2"],
      [[{ id: OLD, name: "購入｜山田｜パークハウス天満", phase: "【買】内見" }], "buy"],
    ] as Array<[DealRef[], string]>) {
      const x = mk({ deals });
      await x.satei();
      assert.equal(x.last().text, `${M3}\n${msgGsKindSatei(7)}`, reason);
      assert.deepEqual(x.last().card, gsSateiNextCard(tid, 1, 7));
      assert.deepEqual(x.order, ["loadDeals"]);
      assert.equal(x.dec(), undefined, "印を取らない（このあと一覧から選べる）");
      assert.equal(x.ticket().auto, undefined);
      assert.ok(x.logs.includes(`[group-satei] auto card G7 ${reason}`));
    }
  });

  await t("読み取りが無い・種別が不明・案件を読めない → 今の返事のまま（M3 も付けない）", async () => {
    for (const o of [{ ticket: { read: null } }, { ticket: { read: { ...base.read!, kind: "不明" as const } } }, { ticket: { read: { ...base.read!, propertyName: null, address: null } } }]) {
      const x = mk(o);
      await x.satei();
      assert.equal(x.last().text, msgGsKindSatei(7));
      assert.equal(x.props.length, 0);
    }
    const y = mk();
    y.deps.loadDeals = async () => { throw new Error("x"); };
    await y.satei();
    assert.equal(y.last().text, msgGsKindSatei(7));
    assert.equal(y.props.length, 0);
  });

  await t("2b-2：足りない項目があると M2＋聞く文。答えのあと newFolder で準備へ", async () => {
    const x = mk({ ticket: { read: { ...base.read!, facts: { ...facts, exclusiveArea: null } } } });
    await x.satei();
    const first = x.last();
    assert.ok(first.text.startsWith(`${M2}\n【受付 G7】資料から読めなかった項目があります`), first.text);
    assert.ok(first.card, "［このまま進める］のカード");
    assert.equal(x.preps.length, 0, "聞いているあいだは準備へ進まない");
    assert.equal(x.ticket().state, "asking-info");
    assert.equal(x.dec(), `info:${NEW_DEAL}`);
    assert.equal(x.ticket().auto?.step, "prep");
    assert.deepEqual(x.q(), []);
    assert.ok(x.m.get(gsInfoKey(SHIMO)));
    // 答え（1対1の次の1通）
    const said: string[] = [];
    const took = await handleGsInfoText(
      { userId: SHIMO, text: "専有面積は70.5㎡です", replyToken: "r2" },
      { ...x.deps, kv: x.kv, answer: async () => JSON.stringify({ 専有面積: 70.5, exclusiveArea: 70.5 }), reply: async (_t, s) => { said.push(s); } },
    );
    assert.equal(took, true);
    assert.equal(x.preps.length, 1, said.join("|") + x.logs.join("|"));
    assert.deepEqual(x.preps[0].newFolder, { name: FOLDER_NAME });
    assert.equal(x.preps[0].facts.exclusiveArea, 70.5);
    assert.equal(x.ticket().state, "gathering");
    assert.equal(x.ticket().auto?.step, "folder");
    assert.equal(x.dec(), `prep:${NEW_DEAL}`);
  });

  await t("2b-2：［このまま進める］でも newFolder で準備へ", async () => {
    const x = mk({ ticket: { read: { ...base.read!, facts: { ...facts, builtYm: null } } } });
    await x.satei();
    const tok = x.ticket().info!.token.slice(0, 8);
    await x.press(`v1|gi|${tid}|1|${tok}`);
    assert.deepEqual(x.preps[0].newFolder, { name: FOLDER_NAME });
    assert.equal(x.ticket().state, "gathering");
  });

  await t("二度押し：2回目は選択済み（Notion は1回）", async () => {
    const x = mk();
    await x.satei();
    await x.satei();
    assert.equal(x.last().text, msgGsAlready(7));
    assert.deepEqual([x.props.length, x.deals.length, x.preps.length], [1, 1, 1]);
  });

  await t("fresh-dup：作る直前に同じ物件の進行中の案件 → 作らずにカード（M3 の別の文）。印が外れ auto が消える", async () => {
    const x = mk({ dup: true });
    await x.satei();
    assert.equal(x.last().text, `${M3_DUP}\n${msgGsKindSatei(7)}`);
    assert.deepEqual(x.last().card, gsSateiNextCard(tid, 1, 7));
    assert.equal(x.deals.length, 0);
    assert.equal(x.preps.length, 0);
    assert.equal(x.dec(), undefined);
    assert.equal(x.ticket().auto, undefined);
    assert.equal(x.ticket().state, "asking");
    assert.deepEqual(x.q(), []);
    assert.ok(x.logs.includes("[group-satei] auto card G7 fresh-dup"));
  });

  await t("物件を作れない → M8・印が外れる。押し直しは続きから（物件は作り直さない）", async () => {
    const x = mk({ propFail: 1 });
    await x.satei();
    assert.equal(x.last().text, M8);
    assert.equal(x.dec(), undefined);
    assert.equal(x.ticket().state, "asking");
    assert.deepEqual(x.ticket().auto, { step: "prop", at: NOW, tries: 1 });
    assert.deepEqual(x.q(), []);
    assert.ok(x.logs.includes("[group-satei] auto failed G7 notion-prop"));
    // 案件で失敗 → 物件の ID は残る
    const y = mk({ dealFail: 1 });
    await y.satei();
    assert.equal(y.last().text, M8);
    assert.equal(y.ticket().auto?.propId, NEW_PROP);
    assert.equal(y.ticket().auto?.step, "deal");
    await y.satei();
    assert.equal(y.last().text, M2);
    assert.equal(y.order.filter((s) => s === "prop").length, 1, "物件は1回だけ");
    assert.equal(y.ticket().auto?.tries, 2);
    assert.equal(y.ticket().state, "gathering");
  });

  await t("3回続けて失敗 → 3回目は M7（案件ができていれば番号つき）。次に押せば1回目から数え直す", async () => {
    const x = mk({ propFail: 3 });
    await x.satei();
    await x.satei();
    assert.equal(x.last().text, M8);
    await x.satei();
    assert.equal(x.last().text, M7);
    assert.equal(x.ticket().auto?.step, "gave-up");
    assert.equal(x.dec(), undefined);
    assert.ok(x.logs.includes("[group-satei] auto gave-up G7"));
    await x.satei();
    assert.equal(x.last().text, M2);
    assert.equal(x.ticket().auto?.tries, 1);
    const y = mk({ ticket: { auto: { step: "prep", at: 1, tries: 2, propId: NEW_PROP, dealId: NEW_DEAL, dealNo: 231 } } });
    y.deps.readDeal = async () => { throw new Error("notion"); };
    await y.satei();
    assert.equal(y.last().text, M7_DEAL);
  });

  await t("番号が読めない → 1秒待って読み直しを1回 → 読めれば進む・だめなら M8（案件の ID は残る）", async () => {
    const x = mk({ dealNo: null, readNo: 231 });
    await x.satei();
    assert.deepEqual(x.order.slice(1, 5), ["prop", "deal", "sleep", "readDealNo"]);
    assert.equal(x.last().text, M2);
    const y = mk({ dealNo: null, readNo: null });
    await y.satei();
    assert.equal(y.order.filter((s) => s === "readDealNo").length, 1);
    assert.equal(y.last().text, M8);
    assert.equal(y.ticket().auto?.dealId, NEW_DEAL);
    assert.equal(y.ticket().auto?.dealNo, undefined);
    assert.equal(y.preps.length, 0);
    assert.ok(y.logs.includes("[group-satei] auto failed G7 id"));
  });

  await t("portal が受けない（400・409）→ M8 の2つ目。印が外れる。案件は残る", async () => {
    const x = mk({ intake: { kind: "rejected", status: 400, code: "INVALID_REQUEST" } });
    await x.satei();
    assert.equal(x.last().text, M8_INTAKE);
    assert.equal(x.dec(), undefined);
    assert.equal(x.ticket().state, "asking");
    assert.equal(x.ticket().auto?.dealNo, 231);
    assert.deepEqual(x.q(), []);
    assert.ok(x.logs.includes("[group-satei] auto failed G7 intake"));
  });

  await t("PREP_DISABLED でも 2a の道（今の受付）へ行かない。止めている・結果不明は今の文の頭に登録の1行", async () => {
    for (const code of ["PREP_DISABLED", "INTAKE_STOPPED"]) {
      const x = mk({ intake: { kind: "rejected", status: 503, code } });
      await x.satei();
      assert.equal(x.last().text, `${HEAD}${msgGsPrepStopped(7)}`, code);
      assert.equal(x.intakes.length, 0, "今の査定書の受付を呼ばない");
      assert.equal(x.dec(), undefined);
    }
    const y = mk({ intake: { kind: "unknown", reason: "timeout" } });
    await y.satei();
    assert.equal(y.last().text, `${HEAD}${msgGsPrepUnknown(7)}`);
    assert.equal(y.ticket().state, "gathering");
    assert.equal(y.ticket().auto?.step, "folder");
  });

  await t("止まったあとの押し直し：自分で登録した案件に合えば、その案件のまま newFolder で進む（増やさない）", async () => {
    const x = mk({ intake: { kind: "rejected", status: 503, code: "INTAKE_STOPPED" } });
    await x.satei();
    x.deps.prep!.intake = async (req) => { x.preps.push(req); return { kind: "ok", value: { created: true, status: "受付" } }; };
    x.deps.loadDeals = async () => [{ id: NEW_DEAL, name: "査定｜顧客未定｜パークハウス天満 1203", phase: "【売】査定" }];
    await x.satei();
    assert.ok(x.last().text.endsWith(msgGsPrepStarted(7)), x.last().text);
    assert.deepEqual(x.preps[x.preps.length - 1].newFolder, { name: FOLDER_NAME });
    assert.equal(x.deals.length, 1, "案件は1件のまま");
    assert.equal(x.ticket().state, "gathering");
  });

  await t("gm（査定の票）：押したら登録へ（照合は飛ばす。裁定 R1）", async () => {
    const x = mk({ ticket: { requestKind: "satei" }, deals: [{ id: "p1", name: "相談｜田中｜パークハウス天満 1203 駐車場", phase: "【売】査定" }] });
    await x.gm();
    assert.equal(x.last().text, M2);
    assert.equal(x.order.includes("loadDeals"), false, "照合しない");
    assert.equal(x.ticket().state, "gathering");
    assert.equal(x.ticket().provisional, false);
    // 作る直前に同じ物件の案件が見つかれば一覧へ
    const y = mk({ ticket: { requestKind: "satei" }, dup: true });
    await y.gm();
    assert.equal(y.last().text, `${M3_DUP}\n${msgGsKindSatei(7)}`);
    assert.equal(y.ticket().state, "asking");
  });

  await t("gm：査定でない票・読み取りの無い票は今のまま（仮の決定）", async () => {
    const x = mk();
    await x.gm();
    assert.equal(x.last().text, msgGsNoDeal(7));
    assert.equal(x.ticket().state, "manual");
    assert.equal(x.ticket().provisional, true);
    assert.equal(x.props.length, 0);
    const y = mk({ ticket: { requestKind: "satei", read: null } });
    await y.gm();
    assert.equal(y.last().text, msgGsNoDeal(7));
    assert.equal(y.props.length, 0);
  });

  await t("フォルダの無い、よその案件を一覧から選んだときは今の「未設定です」のまま（newFolder にしない）", async () => {
    const x = mk();
    x.deps.loadDeals = async () => [{ id: OLD, name: "x", phase: "【売】査定" }];
    x.deps.readDeal = async () => ({ deal: { ...oldDeal, folderId: null }, kind: "マンション" });
    await x.press(`v1|gs|${tid}|1|${OLD}`);
    assert.equal(x.last().text, "案件の Driveフォルダが未設定です。設定してから、もう一度押してください");
    assert.equal(x.preps.length, 0);
  });

  await t("ログ・KV に物件名・所在・フォルダ名・案件名・userId が出ない", async () => {
    for (const o of [{}, { deals: EXACT }, { dup: true }, { propFail: 1 }, { intake: { kind: "rejected", status: 400, code: "X" } }, { ticket: { read: { ...base.read!, facts: { ...facts, exclusiveArea: null } } } }] as Opt[]) {
      const x = mk(o);
      await x.satei();
      const logs = x.logs.join("\n");
      for (const bad of ["パークハウス", "天満", "大阪市", "DEAL-0231_", "顧客未定", "山田", SHIMO, NEW_DEAL, NEW_PROP]) assert.equal(logs.includes(bad), false, `log ${bad}`);
      // KV：受付票の read（今までどおり所在・物件名を持つ）のほかに、名前・フォルダ名を足していない
      const tk = x.ticket();
      const rest = JSON.stringify([Array.from(x.m.entries()).filter(([k]) => k !== gsTicketKey(tid)), { ...tk, read: null }]);
      for (const bad of ["パークハウス", "大阪市", "DEAL-0231_", "顧客未定", "山田"]) assert.equal(rest.includes(bad), false, `kv ${bad}`);
    }
  });

  console.log(`group-satei-auto-actions: ${n} 件 OK`);
})().catch((e) => { console.error(e); process.exit(1); });
