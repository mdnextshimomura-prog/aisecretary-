/** GROUP_INBOX の仕分けカードを、グループを開かなくても分かるようにする（物件・案件・本文・直前のやりとり） */
import assert from "node:assert/strict";
import type { Candidate } from "../src/lib/task-candidate";

let n = 0;
const t = async (name: string, f: () => Promise<void> | void) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const OWNER = "U" + "b".repeat(32);
const REQ = "U" + "c".repeat(32);
const TO = "U" + "d".repeat(32);
const G1 = "C" + "a".repeat(32);
const G2 = "C" + "e".repeat(32);
const NOW = Date.UTC(2026, 10, 28, 1, 30); // JST 11/28(土) 10:30
const members = [
  { name: "依頼 太郎", userIds: [REQ], aliases: [], email: null, active: true, external: false, notionUserId: null },
  { name: "小笠原", userIds: [TO], aliases: [], email: null, active: true, external: false, notionUserId: null },
];
const cand = (id: string, o: Partial<Candidate> = {}): Candidate => ({
  id, text: "小笠原さん 天満ハイツ302の資料を先方に送っておいてください", title: "天満の資料を送る", assignee: "小笠原", assigneeUserId: TO,
  senderId: REQ, createdAt: NOW, groupId: G1, mentionedUserIds: [TO], ...o,
});
const env = (inbox: boolean) => {
  Object.assign(process.env, { TASK_MENU: "1", TASK_BUTTONS: "1", TASK_FOLLOWUP: "1", TASK_CANDIDATES: "1", LINE_GROUP_ID: G1, TASK_BUTTONS_ADMIN_IDS: OWNER });
  delete process.env.TASK_CANDIDATE_GROUP_IDS;
  if (inbox) process.env.GROUP_INBOX = "1"; else delete process.env.GROUP_INBOX;
};

/** カードの本文の行を「名前：値」の並びにして読む（見出し・区切りも含む） */
function rowsOf(bubble: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (!x || typeof x !== "object") return;
    const o = x as { type?: string; layout?: string; text?: string; contents?: unknown[] };
    if (o.type === "box" && o.layout === "baseline" && Array.isArray(o.contents)) {
      out.push(o.contents.map((c) => (c as { text?: string }).text ?? "").join("："));
      return;
    }
    if (o.type === "text" && typeof o.text === "string") out.push(o.text);
    if (o.type === "separator") out.push("---");
    for (const c of o.contents ?? []) walk(c);
  };
  walk(bubble.body);
  return out;
}

function mkKv() {
  const lists = new Map<string, unknown[]>();
  const ops: string[] = [];
  return {
    lists, ops,
    kv: {
      push: async (key: string, row: unknown, keep: number, _ttl: number) => { ops.push(`push ${key}`); lists.set(key, [...(lists.get(key) ?? []), row].slice(-keep)); },
      range: async (key: string) => { ops.push(`range ${key}`); return lists.get(key) ?? []; },
    },
  };
}

(async () => {
  const cc = await import("../src/lib/candidate-card");
  const cx = await import("../src/lib/group-inbox-context");
  const nameOf = cc.nameResolver(members as never);

  await t("カード（そろっているとき）：物件・案件・依頼者・担当・発言・本文（400字まで）・引用・直前のやりとり", () => {
    env(true);
    const b = cc.inboxBubble(cand("m1", { propertyName: "天満ハイツ302" }), nameOf, {
      deal: "売却｜山田様｜天満ハイツ302",
      context: {
        quoted: { m: "q1", u: TO, t: "先方の担当は佐々木さんです", at: NOW - 600_000 },
        before: [
          { m: "a1", u: REQ, t: "天満の件、進んでますか", at: NOW - 180_000 },
          { m: "a2", u: TO, t: "（画像）", at: NOW - 120_000 },
          { m: "a3", u: null, t: "図面です", at: NOW - 60_000 },
        ],
      },
    });
    assert.deepEqual(rowsOf(b), [
      "グループの依頼",
      "天満の資料を送る",
      "物件：天満ハイツ302",
      "案件：売却｜山田様｜天満ハイツ302",
      "依頼者：依頼 太郎",
      "担当：小笠原",
      "発言：11月28日(土) 10:30",
      "本文：小笠原さん 天満ハイツ302の資料を先方に送っておいてください",
      "---",
      "直前のやりとり",
      "引用｜小笠原：先方の担当は佐々木さんです",
      "依頼 太郎：天満の件、進んでますか",
      "小笠原：（画像）",
      "不明：図面です",
    ]);
    const j = JSON.stringify(b);
    for (const w of ["タスクにする", "登録しない", "v1|cr|m1", "v1|cx|m1"]) assert.ok(j.includes(w), w);
    assert.ok(!j.includes("v1|ch|"));
  });

  await t("カード（前の版の控え＝物件名なし・やりとりなし）：物件は「（発言からは分かりません）」。案件・やりとりの行は出さない", () => {
    env(true);
    const b = cc.inboxBubble(cand("m2", { mentionedUserIds: [], assignee: null, assigneeUserId: null }), nameOf);
    assert.deepEqual(rowsOf(b), [
      "グループの依頼",
      "天満の資料を送る",
      "物件：（発言からは分かりません）",
      "依頼者：依頼 太郎",
      "担当：未定",
      "発言：11月28日(土) 10:30",
      "本文：小笠原さん 天満ハイツ302の資料を先方に送っておいてください",
    ]);
  });

  await t("本文は400字まで（前は120字）。カードが大きすぎるときは、やりとり → 本文の順に削る", () => {
    env(true);
    const long = "あ".repeat(900);
    const rows = rowsOf(cc.inboxBubble(cand("m3", { text: long }), nameOf));
    assert.equal(rows.find((r) => r.startsWith("本文："))!.length, "本文：".length + 400);
    const ctx = { quoted: null, before: [{ m: "a1", u: REQ, t: "い".repeat(80), at: 1 }] };
    const full = cc.inboxCard(cand("m3", { text: long }), nameOf, { context: ctx });
    assert.ok(JSON.stringify(full).includes("直前のやりとり"));
    // 上限を小さくして確かめる：まず やりとり を外し、それでも大きければ本文を120字に
    const size = (c: unknown) => Buffer.byteLength(JSON.stringify((c as { contents: unknown }).contents), "utf8");
    const noCtx = cc.inboxCard(cand("m3", { text: long }), nameOf, { context: ctx }, size(full) - 1);
    assert.ok(!JSON.stringify(noCtx).includes("直前のやりとり"));
    assert.equal(rowsOf(noCtx.contents).find((r) => r.startsWith("本文："))!.length, "本文：".length + 400);
    const small = cc.inboxCard(cand("m3", { text: long }), nameOf, { context: ctx }, size(noCtx) - 1);
    assert.equal(rowsOf(small.contents).find((r) => r.startsWith("本文："))!.length, "本文：".length + 120);
  });

  await t("17時のまとめのカード：同じ形で、やりとりの行は無い（物件と本文は出る）", () => {
    env(true);
    const r = cc.inboxCarousel([cand("m1", { propertyName: "天満ハイツ302" }), cand("m2")], nameOf)!;
    const bubbles = (r.card.contents as { contents: Array<Record<string, unknown>> }).contents;
    assert.equal(r.shown, 2);
    assert.ok(rowsOf(bubbles[0]).includes("物件：天満ハイツ302"));
    assert.ok(rowsOf(bubbles[1]).includes("物件：（発言からは分かりません）"));
    for (const b of bubbles) assert.ok(!rowsOf(b).includes("直前のやりとり"));
  });

  await t("控え：対象グループの文字・画像・ファイルを1行ずつ（80字まで・直近8件）。off・対象外のグループは KV を触らない", async () => {
    const x = mkKv();
    env(false);
    await cx.recordInboxContext({ groupId: G1, messageId: "m0", senderId: REQ, kind: "text", text: "こんにちは", at: 1 }, x.kv);
    env(true);
    await cx.recordInboxContext({ groupId: G2, messageId: "m0", senderId: REQ, kind: "text", text: "別のグループ", at: 1 }, x.kv);
    await cx.recordInboxContext({ groupId: undefined, messageId: "m0", senderId: REQ, kind: "text", text: "1対1", at: 1 }, x.kv);
    assert.equal(x.ops.length, 0);
    await cx.recordInboxContext({ groupId: G1, messageId: "m1", senderId: REQ, kind: "text", text: `  天満の件\n${"あ".repeat(100)}`, at: 10 }, x.kv);
    await cx.recordInboxContext({ groupId: G1, messageId: "m2", senderId: TO, kind: "image", at: 20 }, x.kv);
    await cx.recordInboxContext({ groupId: G1, messageId: "m3", senderId: undefined, kind: "file", at: 30 }, x.kv);
    assert.deepEqual(x.lists.get(cx.ctxKey(G1)), [
      { m: "m1", u: REQ, t: `天満の件 ${"あ".repeat(74)}…`, at: 10 },
      { m: "m2", u: TO, t: "（画像）", at: 20 },
      { m: "m3", u: null, t: "（ファイル）", at: 30 },
    ]);
    for (let i = 0; i < 10; i++) await cx.recordInboxContext({ groupId: G1, messageId: `x${i}`, senderId: REQ, kind: "text", text: `t${i}`, at: 100 + i }, x.kv);
    assert.equal(x.lists.get(cx.ctxKey(G1))!.length, 8);
    // KV が落ちていても投げない
    await cx.recordInboxContext({ groupId: G1, messageId: "z", senderId: REQ, kind: "text", text: "x", at: 1 }, { push: async () => { throw new Error("kv"); }, range: async () => [] });
  });

  await t("読む：依頼の発言より前の3件（古い順）と、引用された発言。依頼そのもの・あとの発言は出さない。off なら読まない", async () => {
    env(true);
    const x = mkKv();
    const rows = ["a", "b", "c", "d", "REQ", "e"].map((m, i) => ({ m, u: REQ, t: `t-${m}`, at: i }));
    x.lists.set(cx.ctxKey(G1), rows);
    const r = await cx.loadInboxContext({ groupId: G1, messageId: "REQ", quotedMessageId: "a" }, x.kv);
    assert.deepEqual(r, { quoted: rows[0], before: [rows[1], rows[2], rows[3]] });
    // 引用が直前の3件の中にあれば、引用として先に出し、やりとりの側では重ねない
    const r2 = await cx.loadInboxContext({ groupId: G1, messageId: "REQ", quotedMessageId: "c" }, x.kv);
    assert.deepEqual(r2, { quoted: rows[2], before: [rows[1], rows[3]] });
    // 依頼の発言がまだ控えに無い（書き込みが遅れた）ときは、いまある最後の3件
    const r3 = await cx.loadInboxContext({ groupId: G1, messageId: "none", quotedMessageId: "zzz" }, x.kv);
    assert.deepEqual(r3, { quoted: null, before: [rows[3], rows[4], rows[5]] });
    assert.equal(await cx.loadInboxContext({ groupId: G2, messageId: "REQ" }, x.kv), null);
    assert.equal(await cx.loadInboxContext({ groupId: G1, messageId: "REQ" }, { push: async () => undefined, range: async () => { throw new Error("kv"); } }), null);
    env(false);
    const ops = x.ops.length;
    assert.equal(await cx.loadInboxContext({ groupId: G1, messageId: "REQ" }, x.kv), null);
    assert.equal(x.ops.length, ops);
  });

  await t("知らせ：案件（進行中の案件に1件だけ完全一致）とやりとりを付けて送る。どちらも遅い・失敗なら付けずに送る（知らせは止めない）", async () => {
    env(true);
    const never = new Promise<never>(() => undefined);
    const sent: string[][] = [];
    const push = async (_to: string, _text: string, card: { contents: Record<string, unknown> }) => { sent.push(rowsOf(card.contents)); return true; };
    const base = { push, members: async () => members as never, log: () => undefined };
    const c = cand("m1", { propertyName: "天満ハイツ302" });
    assert.equal(await cc.notifyInboxNew(c, { ...base, deal: async () => "売却｜山田様｜天満ハイツ302", context: async () => ({ quoted: null, before: [{ m: "a", u: REQ, t: "進んでますか", at: 1 }] }) }), "sent");
    assert.ok(sent[0].includes("案件：売却｜山田様｜天満ハイツ302") && sent[0].includes("依頼 太郎：進んでますか"));
    assert.equal(await cc.notifyInboxNew(c, { ...base, deal: () => never, context: () => never, extraTimeoutMs: 20 }), "sent");
    assert.equal(await cc.notifyInboxNew(c, { ...base, deal: async () => { throw new Error("crm"); }, context: async () => { throw new Error("kv"); } }), "sent");
    for (const rows of sent.slice(1)) {
      assert.ok(rows.includes("物件：天満ハイツ302"));
      assert.ok(!rows.some((r) => r.startsWith("案件：")) && !rows.includes("直前のやりとり"));
    }
  });

  await t("案件の照合：進行中の案件に、物件の鍵が完全一致するものが1件だけのときだけ名前を返す", () => {
    const deals = [{ id: "d1", name: "売却｜山田様｜天満ハイツ302" }, { id: "d2", name: "購入｜佐藤様｜豊中ハイム" }];
    assert.equal(cc.inboxDealName("天満ハイツ302", deals), "売却｜山田様｜天満ハイツ302");
    assert.equal(cc.inboxDealName("天満ハイツ", deals), null); // 部分一致は出さない
    assert.equal(cc.inboxDealName("天満ハイツ302", [...deals, { id: "d3", name: "賃貸｜天満ハイツ302" }]), null); // 2件
    assert.equal(cc.inboxDealName(null, deals), null);
  });

  await t("タスクのカード：物件名を渡したときだけ「物件」の行を足す（渡さなければ今までと同じ JSON）", async () => {
    env(true);
    const tb = await import("../src/lib/task-buttons");
    const parsed = { title: "天満の資料を送る", dueDate: "2026-12-01", dueTime: null, assignee: "小笠原" };
    const plain = tb.registeredCardFor("p".repeat(32), parsed)!;
    assert.deepEqual(tb.registeredCardFor("p".repeat(32), parsed, undefined), plain);
    assert.deepEqual(tb.registeredCardFor("p".repeat(32), parsed, { property: null }), plain);
    assert.ok(!rowsOf(plain.contents).some((r) => r.startsWith("物件：")));
    const rich = tb.registeredCardFor("p".repeat(32), parsed, { property: "天満ハイツ302" })!;
    assert.deepEqual(rowsOf(rich.contents).slice(0, 2), ["天満の資料を送る", "物件：天満ハイツ302"]);
    assert.deepEqual(rich.contents.footer, plain.contents.footer);
  });

  console.log(`\n${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
