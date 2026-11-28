/** グループにカードを出さない（2026-11-28）：GROUP_NO_CARDS=1 のあいだ、グループあての送信からカードだけ外す。1対1・off は今までどおり */
import assert from "node:assert/strict";

process.env.LINE_CHANNEL_ACCESS_TOKEN = "t";
let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };

const G = "C" + "a".repeat(32);
const R = "R" + "a".repeat(32);
const U = "U" + "b".repeat(32);
const CARD = { type: "flex" as const, altText: "x", contents: { type: "bubble" } };
const sent: Array<{ url: string; body: { to?: string; replyToken?: string; messages: Array<{ type: string }> } }> = [];
globalThis.fetch = (async (url: string, init: { body: string }) => {
  sent.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ sentMessages: JSON.parse(init.body).messages.map((_: unknown, i: number) => ({ id: `m${i}` })) }), { status: 200 });
}) as unknown as typeof fetch;
const types = () => sent.map((s) => s.body.messages.map((m) => m.type).join("+"));
const reset = (on: boolean) => { sent.length = 0; if (on) process.env.GROUP_NO_CARDS = "1"; else delete process.env.GROUP_NO_CARDS; };

(async () => {
  const L = await import("../src/lib/line");
  const card = CARD as unknown as Parameters<typeof L.pushCard>[1];
  const { gsCaseRequestMessages } = await import("../src/lib/group-satei-case");
  const { instantCandidateActive } = await import("../src/lib/candidate-card");

  await t("off：グループあても1対1あても、カードつきのまま（足す前と同じ）", async () => {
    reset(false);
    L.noteReplyTarget("rg", "group");
    await L.replyTextAndCard("rg", "a", card);
    await L.pushTextAndCard(G, "a", card);
    await L.pushCard(G, card);
    await L.pushMessagesWithRetryKey(G, [{ type: "text", text: "a" }, CARD], "k");
    assert.deepEqual(types(), ["text+flex", "text+flex", "flex", "text+flex"]);
  });
  await t("on・reply：グループ・複数人トークからの発言への返事はカードを外す。文字はそのまま・cardId は null", async () => {
    reset(true);
    L.noteReplyTarget("rg1", "group");
    L.noteReplyTarget("rr1", "room");
    const r = await L.replyTextAndCard("rg1", "受け付けました", card);
    await L.replyTextAndCard("rr1", "a", card);
    assert.deepEqual(types(), ["text", "text"]);
    assert.deepEqual(r, { textId: "m0", cardId: null });
    assert.equal((sent[0].body.messages[0] as unknown as { text: string }).text, "受け付けました");
  });
  await t("on・reply：1対1・控えの無い replyToken はカードつきのまま", async () => {
    reset(true);
    L.noteReplyTarget("ru1", "user");
    await L.replyTextAndCard("ru1", "a", card);
    await L.replyTextAndCard("unknown-token", "a", card);
    L.noteReplyTarget(undefined, "group");
    assert.deepEqual(types(), ["text+flex", "text+flex"]);
  });
  await t("on・push：グループあてはカードを外す（文字＋カード→文字だけ／カードだけ→送らず true）", async () => {
    reset(true);
    assert.equal(await L.pushTextAndCard(G, "一覧", card), true);
    assert.equal(await L.pushCard(G, card), true);
    assert.equal(await L.pushCard(R, card), true);
    assert.deepEqual(types(), ["text"]);
  });
  await t("on・push：1対1あてはカードつきのまま", async () => {
    reset(true);
    await L.pushTextAndCard(U, "a", card);
    await L.pushCard(U, card);
    await L.pushMessagesWithRetryKey(U, [CARD], "k");
    assert.deepEqual(types(), ["text+flex", "flex", "flex"]);
  });
  await t("on・retry key つきの push：グループあてはカードを外す。カードだけなら送らず 200", async () => {
    reset(true);
    assert.equal(await L.pushMessagesWithRetryKey(G, [{ type: "textV2", text: "a" }, CARD], "k"), 200);
    assert.equal(await L.pushMessagesWithRetryKey(G, [CARD], "k"), 200);
    assert.deepEqual(await L.pushMessagesWithRetryKeyIds(G, [CARD], "k"), { status: 200, ids: [] });
    const r = await L.pushMessagesWithRetryKeyIds(G, [{ type: "text", text: "a" }, CARD], "k");
    assert.deepEqual(r, { status: 200, ids: ["m0"] });
    assert.deepEqual(types(), ["textV2", "text"]);
  });
  await t("山口さんへの依頼：plain なら同じ中身を文字2通で（メンション＋本文）。カードは無い", async () => {
    const o = { staffId: U, no: 7, place: "大阪市北区天満2丁目・パークハウス天満", lines: ["成約：同じマンション"], deadline: Date.UTC(2026, 10, 30, 9) };
    const a = gsCaseRequestMessages(o)! as Array<{ type: string }>;
    const b = gsCaseRequestMessages({ ...o, plain: true })! as Array<{ type: string; text: string }>;
    assert.deepEqual(a.map((m) => m.type), ["textV2", "flex"]);
    assert.deepEqual(b.map((m) => m.type), ["textV2", "text"]);
    assert.deepEqual(b[0], a[0]);
    assert.ok(b[1].text.startsWith("物件：大阪市北区天満2丁目・パークハウス天満\n成約：同じマンション\n期日："));
    assert.ok(b[1].text.endsWith("取れたら、このトークに PDF を貼ってください"));
  });
  await t("その場で聞くカード：on のあいだは出さない（黙って控える）", async () => {
    Object.assign(process.env, { TASK_FOLLOWUP: "1", TASK_BUTTONS: "1", TASK_MENU: "1", TASK_CANDIDATES: "1", TASK_CANDIDATE_INSTANT: "1" });
    reset(false);
    assert.equal(instantCandidateActive(), true);
    reset(true);
    assert.equal(instantCandidateActive(), false);
  });
  console.log(`${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
