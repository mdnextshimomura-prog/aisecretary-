/** 引用された PDF も読む（2026-11-28：PDF を引用した「@下村」が「画像を読めませんでした」になった件） */
import assert from "node:assert/strict";
import { maybeAskPhotoMention, pickPhotoAskImages, MSG_PHOTO_ASK_UNREAD, type PhotoAskDeps, type PhotoAskEvent, type PhotoAskMedia, type PhotoAskRead } from "../src/lib/photo-ask";

process.env.LINE_CHANNEL_ACCESS_TOKEN = "t";
let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };

const GROUP = "C" + "a".repeat(32);
const SHIMO = "U" + "b".repeat(32);
const BOSS = "U" + "c".repeat(32);
const BOT = "U" + "d".repeat(32);
const NOW = Date.UTC(2026, 10, 28, 8);
// グループ全体の控え（gsatei:media）を使うので、グループ査定も on の対象グループにしておく
const ENV = { PHOTO_MENTION_ASK: "1", PHOTO_MENTION_GROUP_IDS: GROUP, TASK_SATEI_USER_IDS: SHIMO, TASK_SATEI: "1", GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: GROUP };
const ev = (o: Partial<PhotoAskEvent> = {}): PhotoAskEvent => ({ messageId: "m1", groupId: GROUP, senderId: BOSS, mentionees: [{ type: "user", userId: SHIMO }], text: "", botUserId: BOT, timestamp: NOW, ...o });
const READ: PhotoAskRead = { isTask: true, requestType: "査定書", confidence: 0.9, propertyName: "天満ハイツ302", propertyKey: null };

function mk(o: { media?: PhotoAskMedia[]; group?: PhotoAskMedia[] | "throw" } = {}) {
  const reads: string[][] = [];
  const pushes: string[] = [];
  const logs: string[] = [];
  const deps: PhotoAskDeps = {
    env: ENV,
    listMedia: async () => o.media ?? [],
    reserve: async () => true,
    read: async (ids) => { reads.push(ids); return READ; },
    loadDeals: async () => [],
    push: async (_to, text) => { pushes.push(text); return true; },
    log: (l) => logs.push(l),
    ...(o.group ? { listGroupMedia: async () => { if (o.group === "throw") throw new Error("x"); return o.group as PhotoAskMedia[]; } } : {}),
  };
  return { deps, reads, pushes, logs };
}

(async () => {
  const media: PhotoAskMedia[] = [{ messageId: "img", kind: "image", at: NOW - 60_000 }, { messageId: "pdf", kind: "file", at: NOW - 120_000 }];
  await t("選び方：引用された PDF（ファイル）は読む対象になる", async () => {
    assert.deepEqual(pickPhotoAskImages(media, { timestamp: NOW, quotedMessageId: "pdf" }), { ids: ["pdf"], quoted: true });
  });
  await t("選び方：引用が無いときは今までどおり画像だけ", async () => {
    assert.deepEqual(pickPhotoAskImages(media, { timestamp: NOW }), { ids: ["img"], quoted: false });
  });
  await t("送り主が貼った PDF を引用した名指し：読んで知らせる（「読めませんでした」にならない）", async () => {
    const x = mk({ media });
    await maybeAskPhotoMention(ev({ quotedMessageId: "pdf" }), x.deps);
    assert.deepEqual(x.reads, [["pdf"]]);
    assert.equal(x.pushes.length, 1);
    assert.notEqual(x.pushes[0], MSG_PHOTO_ASK_UNREAD);
  });
  await t("ほかの人が貼った資料を引用した名指し：グループ全体の控えから探して読む", async () => {
    const x = mk({ media: [], group: [{ messageId: "other-pdf", kind: "file", at: NOW - 600_000 }] });
    await maybeAskPhotoMention(ev({ quotedMessageId: "other-pdf" }), x.deps);
    assert.deepEqual(x.reads, [["other-pdf"]]);
    assert.notEqual(x.pushes[0], MSG_PHOTO_ASK_UNREAD);
  });
  await t("どの控えにも無い・グループの控えが読めない：今までどおり読まずに知らせる。文は「資料（画像・PDF）」", async () => {
    for (const group of [[{ messageId: "zzz", kind: "file" }] as PhotoAskMedia[], "throw" as const]) {
      const x = mk({ media: [], group });
      await maybeAskPhotoMention(ev({ quotedMessageId: "gone" }), x.deps);
      assert.equal(x.reads.length, 0);
      assert.deepEqual(x.pushes, [MSG_PHOTO_ASK_UNREAD]);
      assert.ok(x.logs.includes("[photo-ask] unread quoted-missing"));
    }
    assert.ok(MSG_PHOTO_ASK_UNREAD.includes("資料（画像・PDF）を読めませんでした"));
  });
  await t("取り出し：中身の頭が %PDF なら PDF、画像は画像、それ以外のファイルは読めなかった扱い", async () => {
    const { loadPhotoAskImages } = await import("../src/lib/photo-ask-wire");
    const f = (body: Uint8Array, ct: string) => (async () => new Response(body as unknown as BodyInit, { headers: { "content-type": ct } })) as unknown as typeof fetch;
    const pdf = await loadPhotoAskImages(["a"], f(new TextEncoder().encode("%PDF-1.7 xxxx"), "application/octet-stream"));
    assert.deepEqual([pdf[0].kind, pdf[0].mediaType], ["pdf", "application/pdf"]);
    const img = await loadPhotoAskImages(["a"], f(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg"));
    assert.deepEqual([img[0].kind, img[0].mediaType], ["image", "image/jpeg"]);
    await assert.rejects(loadPhotoAskImages(["a"], f(new TextEncoder().encode("PK\u0003\u0004 excel"), "application/octet-stream")));
  });
  await t("取り出し：大きすぎるファイルは、content-length で読まずにやめる・無ければ読みながら上限で止める（丸ごと読まない）", async () => {
    const { loadPhotoAskImages } = await import("../src/lib/photo-ask-wire");
    const CHUNK = new Uint8Array(1024 * 1024).fill(0x25);
    const big = (declared: string | null) => {
      const st = { pulled: 0, cancelled: false };
      const body = new ReadableStream<Uint8Array>({
        pull(c) { st.pulled++; if (st.pulled > 50) c.close(); else c.enqueue(CHUNK); },
        cancel() { st.cancelled = true; },
      }, { highWaterMark: 0 });
      const f = (async () => new Response(body, { headers: { "content-type": "application/pdf", ...(declared ? { "content-length": declared } : {}) } })) as unknown as typeof fetch;
      return { st, f };
    };
    // content-length が上限より大きい：1回も読まない
    const a = big(String(50 * 1024 * 1024));
    await assert.rejects(loadPhotoAskImages(["a"], a.f), /size/);
    assert.equal(a.st.pulled, 0);
    assert.ok(a.st.cancelled);
    // content-length が無い：3.5MB を超えたところで止める（50MB を読み切らない）
    const b = big(null);
    await assert.rejects(loadPhotoAskImages(["a"], b.f), /size/);
    assert.ok(b.st.pulled <= 5, String(b.st.pulled));
    assert.ok(b.st.cancelled);
    // 空の本文は読めなかった扱い
    const empty = (async () => new Response(new Uint8Array(0) as unknown as BodyInit, { headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
    await assert.rejects(loadPhotoAskImages(["a"], empty), /size/);
  });
  await t("グループ全体の控えを読むのは、グループ査定が on の対象グループだけ（off のグループでは KV を読まない）", async () => {
    let asked = 0;
    const x = mk({ media: [], group: [{ messageId: "other-pdf", kind: "file", at: NOW - 600_000 }] });
    const inner = x.deps.listGroupMedia!;
    x.deps.listGroupMedia = async (g) => { asked++; return inner(g); };
    x.deps.env = { PHOTO_MENTION_ASK: "1", PHOTO_MENTION_GROUP_IDS: GROUP, TASK_SATEI_USER_IDS: SHIMO, TASK_SATEI: "1" };
    await maybeAskPhotoMention(ev({ quotedMessageId: "other-pdf" }), x.deps);
    assert.equal(asked, 0);
    assert.deepEqual(x.pushes, [MSG_PHOTO_ASK_UNREAD]);
    x.deps.env = { ...x.deps.env, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: "C" + "e".repeat(32) };
    await maybeAskPhotoMention(ev({ quotedMessageId: "other-pdf", messageId: "m2" }), x.deps);
    assert.equal(asked, 0);
  });
  console.log(`${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
