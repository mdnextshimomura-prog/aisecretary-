/**
 * 案件の自動登録（計画 2026-11-27 の A4）：Notion への読み書き（group-satei-auto-notion.ts）。Client は偽物。
 * 固定すること：書くのは新しく作るページと、その案件の Driveフォルダ・フォルダ状態 だけ／印で探してから作る（やり直しで増えない）／既存のページは書き換えない。
 */
import assert from "node:assert/strict";
import { gsAutoNotion, type GsAutoNotionClient } from "../src/lib/group-satei-auto-notion";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const PROPS = "7777abcd0123456789ab0123456789ab";
const DEALS = "9999abcd0123456789ab0123456789ab";
const MARK = "票 ab12cd34";
const REMARK = `グループ査定 受付 G7 から自動登録（${MARK}）`;
const rich = (s: string) => ({ rich_text: [{ plain_text: s }] });
const title = (s: string) => ({ title: [{ plain_text: s }] });
const propPage = (id: string, name: string, remark = "") => ({ id, parent: { type: "database_id", database_id: PROPS }, properties: { 物件名: title(name), 備考: rich(remark) } });
const dealPage = (id: string, o: { remark?: string; no?: number | null; url?: string | null; db?: string; archived?: boolean } = {}) => ({
  id, archived: o.archived ?? false, parent: { type: "database_id", database_id: o.db ?? DEALS },
  properties: { 案件名: title("査定｜顧客未定｜パークハウス天満 1203"), ID: { unique_id: { number: o.no === undefined ? 231 : o.no } }, Driveフォルダ: { url: o.url ?? null }, 物件: { relation: [] }, 備考: rich(o.remark ?? REMARK) },
});

/** filter を見て答えを返す偽の Client。呼び出しを全部控える */
function mk(answer: (dbId: string, filter: unknown) => unknown[], pages: Record<string, unknown> = {}) {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  const client: GsAutoNotionClient = {
    databases: { query: async (args) => { calls.push({ op: "query", args }); return { results: answer(String(args.database_id), args.filter) }; } },
    pages: {
      create: async (args) => { calls.push({ op: "create", args }); return { id: "cccc0000-cccc-0000-cccc-0000cccc0000", parent: args.parent, properties: { ID: { unique_id: { number: 231 } } } }; },
      retrieve: async (args) => { calls.push({ op: "retrieve", args }); const p = pages[args.page_id]; if (!p) throw new Error("not found"); return p; },
      update: async (args) => { calls.push({ op: "update", args }); return {}; },
    },
  };
  const writes = () => calls.filter((c) => c.op === "create" || c.op === "update");
  return { api: gsAutoNotion(client, { propsDbId: PROPS, dealsDbId: DEALS }), calls, writes };
}
const P_IN = { title: "パークハウス天満 1203", kind: "マンション" as const, address: "大阪市北区天満2丁目3-4", landArea: null, buildingArea: null, remark: REMARK, mark: MARK };
const D_IN = { name: "査定｜顧客未定｜パークハウス天満 1203", propTitle: "パークハウス天満 1203", propertyId: "aaaa0000aaaa0000aaaa0000aaaa0000", remark: REMARK, mark: MARK };
const FOLDER = "1AbC_dEf-GhIjKlMnOp";

(async () => {
  await t("物件：無ければ作る。欄はデータ辞書どおり（物件名・種別・所在地・備考。ステータスは入れない）", async () => {
    const x = mk(() => []);
    const r = await x.api.findOrCreateProperty(P_IN);
    assert.equal(r.id, "cccc0000cccc0000cccc0000cccc0000");
    assert.deepEqual(x.calls.map((c) => c.op), ["query", "query", "create"]);
    assert.deepEqual(x.calls[0].args.filter, { property: "備考", rich_text: { contains: MARK } });
    assert.deepEqual(x.calls[1].args.filter, { property: "物件名", title: { equals: "パークハウス天満 1203" } });
    assert.deepEqual(x.calls[2].args, {
      parent: { database_id: PROPS },
      properties: {
        物件名: { title: [{ text: { content: "パークハウス天満 1203" } }] },
        種別: { select: { name: "マンション" } },
        所在地: { rich_text: [{ text: { content: "大阪市北区天満2丁目3-4" } }] },
        備考: { rich_text: [{ text: { content: REMARK } }] },
      },
    });
  });
  await t("物件：戸建は土地面積㎡・建物面積㎡も（あれば）。所在が無ければ所在地を入れない", async () => {
    const x = mk(() => []);
    await x.api.findOrCreateProperty({ ...P_IN, kind: "戸建", address: null, landArea: 120.5, buildingArea: 98 });
    const props = (x.calls[2].args.properties ?? {}) as Record<string, unknown>;
    assert.deepEqual(Object.keys(props), ["物件名", "種別", "土地面積㎡", "建物面積㎡", "備考"]);
    assert.deepEqual(props["土地面積㎡"], { number: 120.5 });
    assert.deepEqual(props["建物面積㎡"], { number: 98 });
  });
  await t("物件：票の印のあるページ・同じ物件名のページがあれば作らない（そのページは書き換えない）", async () => {
    const x = mk((_db, f) => (JSON.stringify(f).includes("備考") ? [propPage("dddd0000-dddd-0000-dddd-0000dddd0000", "前に作った", REMARK)] : []));
    assert.equal((await x.api.findOrCreateProperty(P_IN)).id, "dddd0000dddd0000dddd0000dddd0000");
    assert.deepEqual(x.writes(), []);
    const y = mk((_db, f) => (JSON.stringify(f).includes("物件名") ? [propPage("eeee0000eeee0000eeee0000eeee0000", "パークハウス天満 1203")] : []));
    assert.equal((await y.api.findOrCreateProperty(P_IN)).id, "eeee0000eeee0000eeee0000eeee0000");
    assert.deepEqual(y.writes(), []);
    // 消したページ・印や名前が実は違うページは使わない
    const z = mk((_db, f) => (JSON.stringify(f).includes("備考") ? [{ ...propPage("x", "y", REMARK), archived: true }, propPage("x2", "y", "別の票 99999999")] : [propPage("x3", "パークハウス天満 1203 別棟")]));
    await z.api.findOrCreateProperty(P_IN);
    assert.equal(z.writes().length, 1);
  });

  await t("案件：無ければ作る。フェーズ【売】査定・売買仲介・仲介・売却・担当（仮）下村・物件 relation・備考。顧客・案件ソース・主担当・フォルダ状態は入れない", async () => {
    const x = mk(() => []);
    const r = await x.api.findOrCreateDeal(D_IN);
    assert.deepEqual(r, { kind: "ok", id: "cccc0000cccc0000cccc0000cccc0000", dealNo: 231 });
    assert.deepEqual(x.calls[0].args.filter, { property: "備考", rich_text: { contains: MARK } });
    assert.deepEqual(x.calls[1].args.filter, {
      and: [
        { property: "案件名", title: { contains: "パークハウス天満 1203" } },
        { property: "フェーズ", select: { does_not_equal: "完了" } },
        { property: "フェーズ", select: { does_not_equal: "失注" } },
      ],
    });
    assert.deepEqual(x.calls[2].args, {
      parent: { database_id: DEALS },
      properties: {
        案件名: { title: [{ text: { content: "査定｜顧客未定｜パークハウス天満 1203" } }] },
        フェーズ: { select: { name: "【売】査定" } },
        案件種別: { select: { name: "売買仲介" } },
        取引区分: { select: { name: "仲介" } },
        取引の立場: { select: { name: "売却" } },
        "担当（仮）": { select: { name: "下村" } },
        物件: { relation: [{ id: D_IN.propertyId }] },
        備考: { rich_text: [{ text: { content: REMARK } }] },
      },
    });
  });
  await t("案件：票の印のある案件があればそれを使う（やり直しで増やさない）", async () => {
    const x = mk((_db, f) => (JSON.stringify(f).includes("備考") ? [dealPage("ffff0000-ffff-0000-ffff-0000ffff0000")] : []));
    assert.deepEqual(await x.api.findOrCreateDeal(D_IN), { kind: "ok", id: "ffff0000ffff0000ffff0000ffff0000", dealNo: 231 });
    assert.deepEqual(x.calls.map((c) => c.op), ["query"]);
  });
  await t("案件：同じ物件名を含む進行中の案件があれば作らない（dup）", async () => {
    const x = mk((_db, f) => (JSON.stringify(f).includes("案件名") ? [dealPage("1111000011110000111100001111aaaa", { remark: "人が作った" })] : []));
    assert.deepEqual(await x.api.findOrCreateDeal(D_IN), { kind: "dup" });
    assert.deepEqual(x.writes(), []);
  });
  await t("案件番号：作った答えに番号が無ければ null。読み直しは pages.retrieve", async () => {
    const x = mk(() => [], { d1: dealPage("d1", { no: 232 }), d2: dealPage("d2", { no: null }) });
    assert.equal(await x.api.readDealNo("d1"), 232);
    assert.equal(await x.api.readDealNo("d2"), null);
    assert.deepEqual(x.writes(), []);
  });
  await t("物件名を読む（フォルダ名のもと）。消えていれば null", async () => {
    const x = mk(() => [], { p1: propPage("p1", " パークハウス天満 1203 "), p2: { ...propPage("p2", "x"), in_trash: true } });
    assert.equal(await x.api.propTitle("p1"), "パークハウス天満 1203");
    assert.equal(await x.api.propTitle("p2"), null);
  });

  await t("フォルダのあと：Driveフォルダ が空なら URL と フォルダ状態（作成済）だけを書く", async () => {
    const x = mk(() => [], { d1: dealPage("d1") });
    assert.equal(await x.api.linkDealFolder("d1", FOLDER, MARK), "linked");
    assert.deepEqual(x.writes(), [{
      op: "update",
      args: { page_id: "d1", properties: { Driveフォルダ: { url: `https://drive.google.com/drive/folders/${FOLDER}` }, フォルダ状態: { select: { name: "作成済" } } } },
    }]);
  });
  await t("フォルダのあと：同じ URL が入っていれば書かない（same）。別の URL なら書かない（conflict）", async () => {
    const x = mk(() => [], {
      d1: dealPage("d1", { url: `https://drive.google.com/drive/folders/${FOLDER}` }),
      d2: dealPage("d2", { url: "https://drive.google.com/drive/folders/1ZZZZZZZZZZZZZZZZ" }),
      d3: dealPage("d3", { url: "https://example.test/x" }),
    });
    assert.equal(await x.api.linkDealFolder("d1", FOLDER, MARK), "same");
    assert.equal(await x.api.linkDealFolder("d2", FOLDER, MARK), "conflict");
    assert.equal(await x.api.linkDealFolder("d3", FOLDER, MARK), "conflict");
    assert.deepEqual(x.writes(), []);
  });
  await t("フォルダのあと：この流れで作った案件でなければ書かない（備考に票の印が無い・別の DB・消えている）", async () => {
    const x = mk(() => [], { d1: dealPage("d1", { remark: "人が作った案件" }), d2: dealPage("d2", { db: PROPS }), d3: dealPage("d3", { archived: true }) });
    for (const id of ["d1", "d2", "d3"]) assert.equal(await x.api.linkDealFolder(id, FOLDER, MARK), "foreign", id);
    assert.deepEqual(x.writes(), []);
  });
  await t("読めない・書けないときは例外のまま（呼ぶ側が次の回にやり直す）", async () => {
    const x = mk(() => { throw new Error("notion down"); });
    await assert.rejects(() => x.api.findOrCreateProperty(P_IN));
    await assert.rejects(() => x.api.findOrCreateDeal(D_IN));
    await assert.rejects(() => x.api.linkDealFolder("none", FOLDER, MARK));
    assert.deepEqual(x.writes(), []);
  });

  console.log(`group-satei-auto-notion: ${n} 件 OK`);
})().catch((e) => { console.error(e); process.exit(1); });
