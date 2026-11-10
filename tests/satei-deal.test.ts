/**
 * B2 査定書：CRM_案件・CRM_物件 のページの読み方と、作れるかの判定（satei-deal.ts）。
 */
import {
  folderIdFromUrl,
  judgeSateiDeal,
  normNotionId,
  readPropertyKind,
  readSateiDealPage,
  SATEI_KIND,
  type SateiDeal,
} from "../src/lib/satei-deal";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};

globalThis.fetch = (async () => {
  throw new Error("このテストで外部へ通信してはいけない");
}) as typeof fetch;

const DB = "11111111-2222-3333-4444-555555555555";
const FOLDER = "1AbC_dEf-GhIjKlMnOp";
const P1 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const P2 = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
const page = (over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) => ({
  id: "0123ABCD-0123-4567-89ab-0123456789ab",
  archived: false,
  in_trash: false,
  parent: { type: "database_id", database_id: DB },
  properties: {
    案件名: { type: "title", title: [{ plain_text: "テスト" }, { plain_text: "マンション101" }] },
    ID: { type: "unique_id", unique_id: { prefix: "DEAL", number: 42 } },
    Driveフォルダ: { type: "url", url: `https://drive.google.com/drive/folders/${FOLDER}` },
    物件: { type: "relation", relation: [{ id: P1 }, { id: P2 }] },
    ...props,
  },
  ...over,
});

// ── Drive のフォルダ ID ──
ok("folders の URL", folderIdFromUrl(`https://drive.google.com/drive/folders/${FOLDER}`) === FOLDER);
ok("u/0 つき", folderIdFromUrl(`https://drive.google.com/drive/u/0/folders/${FOLDER}`) === FOLDER);
ok("?usp=sharing つき", folderIdFromUrl(`https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`) === FOLDER);
ok("末尾の / つき", folderIdFromUrl(`https://drive.google.com/drive/folders/${FOLDER}/`) === FOLDER);
ok("前後の空白は削る", folderIdFromUrl(`  https://drive.google.com/drive/folders/${FOLDER} `) === FOLDER);
for (const bad of [
  `http://drive.google.com/drive/folders/${FOLDER}`,
  `https://example.com/drive/folders/${FOLDER}`,
  `https://drive.google.com/file/d/${FOLDER}/view`,
  "https://drive.google.com/drive/folders/short",
  "",
  null,
  undefined,
  42,
]) {
  ok(`フォルダの URL でないものは null: ${String(bad).slice(0, 30)}`, folderIdFromUrl(bad) === null);
}

// ── 案件ページ ──
const d = readSateiDealPage(page());
ok("ID はハイフンなし小文字", d.id === "0123abcd0123456789ab0123456789ab");
ok("案件名はつなげる", d.name === "テストマンション101");
ok("案件番号", d.dealNo === 42);
ok("フォルダ ID", d.folderId === FOLDER);
ok("物件は relation の順", JSON.stringify(d.propertyIds) === JSON.stringify([P1, P2]));
ok("消えていない", d.gone === false);
ok("親の DB", d.parentDbId === normNotionId(DB));
ok("normNotionId", normNotionId("AB-cd") === "abcd");
ok("番号が無ければ null", readSateiDealPage(page({}, { ID: { type: "unique_id", unique_id: { number: null } } })).dealNo === null);
ok("フォルダ欄が空なら null", readSateiDealPage(page({}, { Driveフォルダ: { type: "url", url: null } })).folderId === null);
ok("物件が空なら []", readSateiDealPage(page({}, { 物件: { type: "relation", relation: [] } })).propertyIds.length === 0);
ok("アーカイブは gone", readSateiDealPage(page({ archived: true })).gone === true);
ok("ゴミ箱は gone", readSateiDealPage(page({ in_trash: true })).gone === true);
ok("親が DB でなければ null", readSateiDealPage(page({ parent: { type: "page_id", page_id: DB } })).parentDbId === null);
ok("欄が無くても落ちない", readSateiDealPage({ id: "x" }).name === "");

// ── 物件の種別 ──
ok("種別を読む", readPropertyKind({ properties: { 種別: { type: "select", select: { name: "マンション" } } } }) === "マンション");
ok("種別が空なら null", readPropertyKind({ properties: { 種別: { type: "select", select: null } } }) === null);
ok("種別の欄が無ければ null", readPropertyKind({ properties: {} }) === null);

// ── 判定 ──
const good: SateiDeal = d;
const j = judgeSateiDeal(good, SATEI_KIND, DB);
ok(
  "マンション＋フォルダあり → 作れる",
  j.ok === true &&
    JSON.stringify(j.deal) ===
      JSON.stringify({ id: good.id, name: good.name, dealNo: 42, folderId: FOLDER }),
);
ok("ページが無い → not-found", JSON.stringify(judgeSateiDeal(null, SATEI_KIND, DB)) === JSON.stringify({ ok: false, reason: "not-found" }));
ok(
  "消えている → not-found",
  JSON.stringify(judgeSateiDeal({ ...good, gone: true }, SATEI_KIND, DB)) ===
    JSON.stringify({ ok: false, reason: "not-found" }),
);
ok(
  "ほかの DB のページ → not-found",
  JSON.stringify(judgeSateiDeal(good, SATEI_KIND, "99999999-2222-3333-4444-555555555555")) ===
    JSON.stringify({ ok: false, reason: "not-found" }),
);
ok("戸建 → not-mansion", JSON.stringify(judgeSateiDeal(good, "戸建", DB)) === JSON.stringify({ ok: false, reason: "not-mansion" }));
ok("種別が分からない → not-mansion", JSON.stringify(judgeSateiDeal(good, null, DB)) === JSON.stringify({ ok: false, reason: "not-mansion" }));
ok(
  "フォルダ未設定 → no-folder",
  JSON.stringify(judgeSateiDeal({ ...good, folderId: null }, SATEI_KIND, DB)) ===
    JSON.stringify({ ok: false, reason: "no-folder" }),
);
ok(
  "種別の判定がフォルダより先",
  JSON.stringify(judgeSateiDeal({ ...good, folderId: null }, "土地", DB)) ===
    JSON.stringify({ ok: false, reason: "not-mansion" }),
);

if (fail > 0) {
  console.log(`\n${fail} 件失敗`);
  process.exit(1);
}
console.log("\nすべて成功");
