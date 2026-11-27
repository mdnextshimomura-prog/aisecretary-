/** 案件の自動登録（計画 2026-11-27 の A1〜A3）：スイッチ・「ぴったり合う」の判定・名前の作り方・受付票の auto 欄。通信しない */
import assert from "node:assert/strict";
import { gsAutoMark, gsAutoMatch, gsAutoNoteMark, gsDealFolderName, gsDealLabel, gsDealName, gsPropTitle } from "../src/lib/group-satei-auto";
import { asTicket, groupSateiAutoDealOn, gsPropsDbId, type GsRead, type GsTicket } from "../src/lib/group-satei-data";
import type { DealRef } from "../src/lib/task-record";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const facts = { roomNo: "1203", exclusiveArea: 65.3, landArea: null, buildingArea: null, builtYm: "2005-03", layout: null, floor: null, totalUnits: null, structure: null };
const READ: GsRead = { address: "大阪市北区天満2丁目3-4", propertyName: "パークハウス天満 1203", kind: "マンション", basis: "本文", confidence: 0.9, facts };
const d = (id: string, name: string, phase: string | null = "【売】査定"): DealRef => ({ id, name, phase });

t("exact 1件 → one", () => {
  const r = gsAutoMatch(READ, [d("a", "査定｜顧客未定｜パークハウス天満 1203"), d("b", "相談｜田中｜ぜんぜん別のマンション")]);
  assert.deepEqual(r, { kind: "one", deal: d("a", "査定｜顧客未定｜パークハウス天満 1203") });
});
t("exact 1件＋partial → one（部分一致があっても進める）", () => {
  const r = gsAutoMatch(READ, [d("a", "査定｜山田｜パークハウス天満 1203"), d("b", "相談｜田中｜パークハウス天満 1203 駐車場")]);
  assert.equal(r.kind, "one");
  assert.equal(r.kind === "one" && r.deal.id, "a");
});
t("exact 2件 → ask exact2", () => {
  assert.deepEqual(gsAutoMatch(READ, [d("a", "査定｜山田｜パークハウス天満 1203"), d("b", "購入｜田中｜パークハウス天満1203")]), { kind: "ask", reason: "exact2" });
});
t("partial だけ → ask partial（裁定 R2：部分一致だけはカード）", () => {
  assert.deepEqual(gsAutoMatch(READ, [d("b", "相談｜田中｜パークハウス天満 1203 駐車場")]), { kind: "ask", reason: "partial" });
  // 所在の鍵での部分一致も同じ
  assert.deepEqual(gsAutoMatch({ ...READ, propertyName: null }, [d("c", "売却｜佐藤｜大阪市北区天満2丁目3-4の土地")]), { kind: "ask", reason: "partial" });
});
t("exact 1件が【買】 → ask buy（買いの案件に売却の査定を結びつけない）", () => {
  assert.deepEqual(gsAutoMatch(READ, [d("a", "購入｜山田｜パークハウス天満 1203", "【買】内見")]), { kind: "ask", reason: "buy" });
});
t("当たらない → none", () => {
  assert.deepEqual(gsAutoMatch(READ, [d("x", "売却｜鈴木｜グランドメゾン梅田 501"), d("y", "相談｜高橋")]), { kind: "none" });
  assert.deepEqual(gsAutoMatch(READ, []), { kind: "none" });
});
t("鍵が無い・種別が不明・読み取りが無い → ask", () => {
  assert.deepEqual(gsAutoMatch({ ...READ, propertyName: null, address: null }, [d("a", "x")]), { kind: "ask", reason: "no-key" });
  assert.deepEqual(gsAutoMatch({ ...READ, kind: "不明" }, []), { kind: "ask", reason: "kind" });
  assert.deepEqual(gsAutoMatch(null, []), { kind: "ask", reason: "no-read" });
});
t("建物名だけの案件名に、号室つきの読み取りが exact", () => {
  const r = gsAutoMatch({ ...READ, propertyName: "パークハウス天満 1203号室" }, [d("a", "売却｜山田様｜パークハウス天満")]);
  assert.equal(r.kind, "one");
});
t("所在の完全一致も exact", () => {
  assert.equal(gsAutoMatch({ ...READ, propertyName: null, kind: "戸建" }, [d("a", "売却｜山田｜大阪市北区天満２丁目３－４")]).kind, "one");
});

t("物件名：マンション・戸建・土地・所在だけ・60字", () => {
  assert.equal(gsPropTitle(READ), "パークハウス天満 1203");
  assert.equal(gsPropTitle({ ...READ, propertyName: null }), "大阪市北区天満2丁目3-4 マンション");
  assert.equal(gsPropTitle({ ...READ, kind: "戸建", propertyName: null, address: "豊中市永楽荘4丁目12-3" }), "豊中市永楽荘4丁目12-3 戸建");
  assert.equal(gsPropTitle({ ...READ, kind: "土地", propertyName: null, address: "豊中市永楽荘4丁目12-3" }), "豊中市永楽荘4丁目12-3 土地");
  assert.equal(gsPropTitle({ ...READ, kind: "戸建", propertyName: "永楽荘の家" }), "永楽荘の家");
  // NFKC・改行は空白に・空白の連続は1つに・前後を落とす
  assert.equal(gsPropTitle({ ...READ, propertyName: "  ﾊﾟｰｸﾊｳｽ天満　\n１２０３  " }), "パークハウス天満 1203");
  assert.equal(Array.from(gsPropTitle({ ...READ, propertyName: "あ".repeat(80) })!).length, 60);
  assert.equal(gsPropTitle({ ...READ, propertyName: " ", address: "" }), null);
  assert.equal(gsPropTitle({ ...READ, kind: "不明" }), null);
  assert.equal(gsPropTitle(null), null);
});
t("案件名：査定｜顧客未定｜<物件名>。100字で切る。同じ物件の次の依頼は exact に当たる", () => {
  assert.equal(gsDealName("パークハウス天満 1203"), "査定｜顧客未定｜パークハウス天満 1203");
  assert.equal(Array.from(gsDealName("あ".repeat(200))).length, 100);
  assert.equal(gsAutoMatch(READ, [d("a", gsDealName(gsPropTitle(READ)!))]).kind, "one");
});
t("フォルダ名：例のとおり・禁止文字・80字・顧客未定に様が付かない", () => {
  assert.equal(gsDealFolderName(231, "パークハウス天満 1203"), "DEAL-0231_売却_顧客未定_パークハウス天満 1203");
  assert.equal(gsDealFolderName(12345, "x"), "DEAL-12345_売却_顧客未定_x");
  assert.equal(gsDealFolderName(7, 'A/B\\C:D*E?F"G<H>I|J'), "DEAL-0007_売却_顧客未定_A_B_C_D_E_F_G_H_I_J");
  assert.equal(gsDealFolderName(7, "天満//__ハイツ"), "DEAL-0007_売却_顧客未定_天満_ハイツ");
  const long = gsDealFolderName(231, "あ".repeat(70))!;
  assert.equal(Array.from(long).length, 80);
  assert.equal(long.includes("様"), false);
  // 切ったあとの末尾の空白は落とす（portal は前後の空白を断る）
  const sp = gsDealFolderName(231, "あ".repeat(62 - 1) + " い")!;
  assert.equal(sp, sp.trim());
  // portal の検査と同じ形でなければ作らない
  for (const name of [long, sp]) assert.match(name, /^DEAL-[0-9]{4,6}_売却_顧客未定_.+$/);
  assert.equal(gsDealFolderName(231, " "), null);
  assert.equal(gsDealFolderName(231, "///"), null);
  assert.equal(gsDealFolderName(0, "x"), null);
  assert.equal(gsDealFolderName(1_000_000, "x"), null);
  assert.equal(gsDealFolderName(1.5, "x"), null);
  assert.equal(gsDealLabel(231), "DEAL-0231");
});
t("印：auto:<tid の頭8字>・票 <tid の頭8字>", () => {
  assert.equal(gsAutoMark("0123456789abcdef"), "auto:01234567");
  assert.equal(gsAutoNoteMark("0123456789abcdef"), "票 01234567");
});

const U = "U" + "d".repeat(32);
const ENV = {
  GROUP_SATEI: "1", GROUP_SATEI_STAGE2: "1", GROUP_SATEI_CASE_STAFF_ID: U, GROUP_SATEI_AUTO_DEAL: "1",
  CRM_PROPERTIES_DB_ID: "7777abcd-0123-4567-89ab-0123456789AB", CRM_DEALS_DB_ID: "9999abcd0123456789ab0123456789ab",
};
t("スイッチ：4つの条件のどれが欠けても off", () => {
  assert.equal(groupSateiAutoDealOn(ENV), true);
  assert.equal(gsPropsDbId(ENV), "7777abcd0123456789ab0123456789ab");
  assert.equal(groupSateiAutoDealOn({}), false);
  for (const k of Object.keys(ENV) as Array<keyof typeof ENV>) {
    const e: Record<string, string> = { ...ENV };
    delete e[k];
    assert.equal(groupSateiAutoDealOn(e), false, k);
  }
  assert.equal(groupSateiAutoDealOn({ ...ENV, GROUP_SATEI_AUTO_DEAL: "true" }), false);
  assert.equal(groupSateiAutoDealOn({ ...ENV, CRM_PROPERTIES_DB_ID: "7777abcd" }), false);
  assert.equal(groupSateiAutoDealOn({ ...ENV, CRM_DEALS_DB_ID: " " }), false);
});

const TK: GsTicket = { no: 7, ver: 1, groupId: "C1", requesterId: "U1", at: 1, triggerMsgIds: ["m"], mediaIds: [], read: READ, state: "asking" };
const ID = "0123abcd0123456789ab0123456789ab";
t("受付票：auto の無い票は今のまま読める。正しい auto は読める", () => {
  assert.deepEqual(asTicket(TK), TK);
  const auto = { step: "folder", at: 5, tries: 1, propId: ID, dealId: ID, dealNo: 231, linked: false, linkTries: 2, folderId: "folder_abcdefghij", linkNote: "failed" };
  assert.deepEqual(asTicket(JSON.stringify({ ...TK, auto }))?.auto, auto);
  assert.deepEqual(asTicket({ ...TK, auto: { step: "prop", at: 5, tries: 1 } })?.auto, { step: "prop", at: 5, tries: 1 });
});
t("受付票：auto の形が違う票は読まない", () => {
  const bad: unknown[] = [
    "x", { step: "other", at: 1, tries: 1 }, { step: "prop", tries: 1 }, { step: "prop", at: 1, tries: -1 }, { step: "prop", at: 1, tries: 1, dealId: "DEAL" },
    { step: "prop", at: 1, tries: 1, propId: ID.toUpperCase() }, { step: "prop", at: 1, tries: 1, dealNo: 0 }, { step: "prop", at: 1, tries: 1, dealNo: "231" },
    { step: "prop", at: 1, tries: 1, linked: "yes" }, { step: "prop", at: 1, tries: 1, folderId: "a b" }, { step: "prop", at: 1, tries: 1, linkNote: "x" },
  ];
  for (const auto of bad) assert.equal(asTicket({ ...TK, auto }), null, JSON.stringify(auto));
});

console.log(`group-satei-auto: ${n} 件 OK`);
