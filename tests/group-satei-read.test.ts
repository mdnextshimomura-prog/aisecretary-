/** group-satei-read.ts（AI は差し替え） */
import assert from "node:assert/strict";
import { GS_MATERIALS_TOTAL_MAX_BYTES, capByTotalBytes, GS_READ_PROMPT, parseGsReadText, readGsMaterials, scrubNames } from "../src/lib/group-satei-read";

let n = 0;
const t = async (name: string, f: () => void | Promise<void>) => { await f(); n++; console.log("ok", name); };

(async () => {
  await t("指示文に名前を出さない指示がある", () => assert.match(GS_READ_PROMPT, /名前/));
  await t("名前らしいものは捨てる", () => {
    assert.equal(scrubNames("坂本様邸"), null);
    assert.equal(scrubNames("所有者 山田"), null);
    assert.equal(scrubNames("大阪市旭区大宮1丁目3番27"), "大阪市旭区大宮1丁目3番27");
    assert.equal(scrubNames(""), null);
  });
  await t("名前らしいものは捨てる（殿・御中・名義・売主・買主・オーナー・夫妻・相続人）", () => {
    for (const v of ["大阪市北区1-2 売主山田", "サウス御中", "山田殿", "山田名義", "買主田中", "オーナー宅", "山田夫妻", "相続人の家"]) assert.equal(scrubNames(v), null, v);
    assert.equal(scrubNames("大阪市北区天神橋1丁目2番3"), "大阪市北区天神橋1丁目2番3");
  });
  await t("答えの検査：所在も物件名も無く種別も不明なら読めなかった扱い（例外）", () => {
    assert.throws(() => parseGsReadText('{"所在":"山田様方","物件名":null,"種別の見込み":"不明","根拠":"本文","確信度":0.9}'));
    assert.doesNotThrow(() => parseGsReadText('{"所在":null,"物件名":null,"種別の見込み":"土地","根拠":"本文","確信度":0.9}'));
  });
  await t("答えの検査：正しい形", () => {
    const r = parseGsReadText('前置き {"所在":"大阪市北区1-2","物件名":null,"種別の見込み":"戸建","根拠":"登記","確信度":0.8} 後ろ');
    assert.deepEqual(r, { address: "大阪市北区1-2", propertyName: null, kind: "戸建", basis: "登記", confidence: 0.8 });
  });
  await t("答えの検査：知らない種別・根拠は 不明・その他 に寄せる／名前は捨てる", () => {
    const r = parseGsReadText('{"所在":"山田様方","物件名":"サウスオールシティ1203","種別の見込み":"ビル","根拠":"謎","確信度":0.3}');
    assert.deepEqual(r, { address: null, propertyName: "サウスオールシティ1203", kind: "不明", basis: "その他", confidence: 0.3 });
  });
  await t("答えの検査：確信度が無い・範囲外・JSON でない → 例外", () => {
    assert.throws(() => parseGsReadText('{"所在":"x","種別の見込み":"戸建","根拠":"登記"}'));
    assert.throws(() => parseGsReadText('{"所在":"x","種別の見込み":"戸建","根拠":"登記","確信度":2}'));
    assert.throws(() => parseGsReadText("読めません"));
  });
  await t("AI に渡す中身：添付と指示文と本文", async () => {
    let seen: any = null;
    const r = await readGsMaterials(
      [{ kind: "image", mediaType: "image/png", base64: "AAAA" }, { kind: "pdf", mediaType: "application/pdf", base64: "BBBB" }],
      "査定お願いできますか",
      "2026-11-24（月）",
      async (req) => {
        seen = req;
        return { content: [{ type: "text", text: '{"所在":"大阪市北区1-2","物件名":null,"種別の見込み":"土地","根拠":"地図","確信度":0.9}' }] };
      },
    );
    assert.equal(r.kind, "土地");
    assert.equal(seen.system, GS_READ_PROMPT);
    assert.equal(seen.messages[0].content[0].type, "image");
    assert.equal(seen.messages[0].content[1].type, "document");
    assert.match(seen.messages[0].content[2].text, /査定お願いできますか/);
  });
  await t("AI に渡す添付は先頭8件まで", async () => {
    let seen: any = null;
    const att = Array.from({ length: 10 }, () => ({ kind: "image" as const, mediaType: "image/png", base64: "AAAA" }));
    await readGsMaterials(att, "x", "d", async (req) => {
      seen = req;
      return { content: [{ type: "text", text: '{"所在":"大阪市北区1-2","物件名":null,"種別の見込み":"土地","根拠":"地図","確信度":0.9}' }] };
    });
    assert.equal(seen.messages[0].content.length, 9);
  });
  await t("合計サイズの上限：古いものから外し、新しいものを残す", () => {
    const MB = 1024 * 1024;
    const items = [{ id: "a", b: 8 * MB }, { id: "b", b: 8 * MB }, { id: "c", b: 8 * MB }];
    assert.deepEqual(capByTotalBytes(items, (x) => x.b, 20 * MB).map((x) => x.id), ["b", "c"]);
    assert.deepEqual(capByTotalBytes(items.slice(0, 2), (x) => x.b, 20 * MB).map((x) => x.id), ["a", "b"]);
    assert.deepEqual(capByTotalBytes([{ id: "z", b: 30 * MB }], (x) => x.b, 20 * MB), []);
    assert.equal(GS_MATERIALS_TOTAL_MAX_BYTES, 20 * MB);
  });
  console.log(`group-satei-read: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
