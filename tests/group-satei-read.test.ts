/** group-satei-read.ts（AI は差し替え） */
import assert from "node:assert/strict";
import { GS_READ_PROMPT, parseGsReadText, readGsMaterials, scrubNames } from "../src/lib/group-satei-read";

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
  console.log(`group-satei-read: ${n} ok`);
})().catch((e) => { console.error(e); process.exit(1); });
