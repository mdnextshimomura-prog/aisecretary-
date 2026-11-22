/**
 * 画像のあとの「@下村」だけの名指し（photo-ask.ts）。deps はすべて差し替え（外へは出ない）。
 */
import {
  maybeAskPhotoMention,
  MSG_PHOTO_ASK_UNREAD,
  photoAskGate,
  pickPhotoAskImages,
  type PhotoAskDeps,
  type PhotoAskEvent,
  type PhotoAskMedia,
  type PhotoAskRead,
} from "../src/lib/photo-ask";
import type { DealRef } from "../src/lib/task-record";
import { normalizeProperty } from "../src/lib/property";

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

const SHIMO = "U" + "b".repeat(32);
const BOSS = "U" + "c".repeat(32);
const BOT = "U" + "f".repeat(32);
const GROUP = "C" + "a".repeat(32);
const OTHER = "C" + "e".repeat(32);
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const DEAL: DealRef = { id: "0123abcd0123456789ab0123456789ab", name: "サウスオールシティ｜1203", phase: "査定" };
const ENV = { PHOTO_MENTION_ASK: "1", PHOTO_MENTION_GROUP_IDS: GROUP, TASK_SATEI_USER_IDS: SHIMO, TASK_SATEI: "1" };
const IMG: PhotoAskMedia[] = [{ messageId: "img1", kind: "image", at: NOW - 2 * MIN }];

const ev = (over: Partial<PhotoAskEvent> = {}): PhotoAskEvent => ({
  messageId: "m1",
  groupId: GROUP,
  senderId: BOSS,
  mentionees: [{ type: "user", userId: SHIMO }],
  text: "",
  botUserId: BOT,
  timestamp: NOW,
  ...over,
});
const SATEI: PhotoAskRead = {
  isTask: true, requestType: "査定書", confidence: 0.9, propertyName: "サウスオールシティ1203", propertyKey: normalizeProperty("サウスオールシティ"),
};

function mk(o: {
  env?: Record<string, string | undefined>;
  media?: PhotoAskMedia[];
  reserve?: boolean;
  read?: PhotoAskRead | "throw" | Record<string, unknown>;
  deals?: DealRef[] | "throw";
  push?: boolean;
} = {}) {
  const r = {
    reads: [] as string[][],
    pushes: [] as Array<{ to: string; text: string; card?: unknown; key: string }>,
    logs: [] as string[],
    reserved: [] as string[],
  };
  const deps: PhotoAskDeps = {
    env: o.env ?? ENV,
    listMedia: async () => o.media ?? IMG,
    reserve: async (k) => {
      r.reserved.push(k);
      return o.reserve !== false;
    },
    read: async (ids) => {
      r.reads.push(ids);
      if (o.read === "throw") throw new Error("ai");
      return (o.read ?? SATEI) as PhotoAskRead;
    },
    loadDeals: async () => {
      if (o.deals === "throw") throw new Error("crm");
      return o.deals ?? [DEAL];
    },
    push: async (to, text, card, key) => {
      r.pushes.push({ to, text, card, key });
      return o.push !== false;
    },
    log: (l) => r.logs.push(l),
  };
  return { r, deps };
}
const quiet = (logs: string[]) => {
  const j = logs.join("\n");
  return !j.includes(SHIMO) && !j.includes(BOSS) && !j.includes(GROUP) && !j.includes("サウスオール") && !j.includes("img1") && !j.includes("m1");
};
const reason = (x: ReturnType<typeof photoAskGate>) => (x.ok ? "ok" : x.reason);

(async () => {
  // ── 入口の条件 ──
  ok("通る：グループ・@下村の userId・本文なし", photoAskGate(ev(), ENV).ok === true);
  ok("off なら通さない", reason(photoAskGate(ev(), { ...ENV, PHOTO_MENTION_ASK: undefined })) === "off");
  ok("グループが一覧に無ければ通さない", reason(photoAskGate(ev({ groupId: OTHER }), ENV)) === "group");
  ok("1対1は通さない", reason(photoAskGate(ev({ groupId: undefined }), ENV)) === "group");
  ok("一覧が空なら通さない", reason(photoAskGate(ev(), { ...ENV, PHOTO_MENTION_GROUP_IDS: "" })) === "group");
  ok("宛先（TASK_SATEI_USER_IDS）が無ければ通さない", reason(photoAskGate(ev(), { ...ENV, TASK_SATEI_USER_IDS: "" })) === "no-target");
  ok("別の人への名指しは通さない", reason(photoAskGate(ev({ mentionees: [{ type: "user", userId: BOSS }] }), ENV)) === "not-mentioned");
  ok("@All は名指しに数えない", reason(photoAskGate(ev({ mentionees: [{ type: "all" }] }), ENV)) === "not-mentioned");
  ok(
    "AI秘書も名指しされていれば通さない（いつものタスク受付へ）",
    reason(photoAskGate(ev({ mentionees: [{ type: "user", userId: SHIMO }, { type: "user", userId: BOT }] }), ENV)) === "bot-mentioned",
  );
  ok("下村さん本人の発言は通さない", reason(photoAskGate(ev({ senderId: SHIMO }), ENV)) === "self");
  ok("短い一言（20字以内）は通る", photoAskGate(ev({ text: "これお願いします" }), ENV).ok === true);
  ok("21字以上は通さない", reason(photoAskGate(ev({ text: "あ".repeat(21) }), ENV)) === "long-text");

  // ── 画像の選び方 ──
  const media: PhotoAskMedia[] = [
    { messageId: "old", kind: "image", at: NOW - 31 * MIN },
    { messageId: "pdf", kind: "file", at: NOW - 3 * MIN },
    { messageId: "a", kind: "image", at: NOW - 10 * MIN },
    { messageId: "b", kind: "image", at: NOW - 5 * MIN },
    { messageId: "c", kind: "image", at: NOW - 4 * MIN },
    { messageId: "d", kind: "image", at: NOW - 1 * MIN },
  ];
  ok("30分より前・ファイルは使わず、新しい方から3枚", JSON.stringify(pickPhotoAskImages(media, { timestamp: NOW })) === JSON.stringify({ ids: ["b", "c", "d"], quoted: false }));
  ok("時刻の無い古い控えは使う", pickPhotoAskImages([{ messageId: "x", kind: "image" }], { timestamp: NOW }).ids.join() === "x");
  ok("引用リプライは引用された画像だけ", JSON.stringify(pickPhotoAskImages(media, { timestamp: NOW, quotedMessageId: "a" })) === JSON.stringify({ ids: ["a"], quoted: true }));
  ok("引用先が控えに無ければ空（別の画像で代わりにしない）", JSON.stringify(pickPhotoAskImages(media, { timestamp: NOW, quotedMessageId: "zzz" })) === JSON.stringify({ ids: [], quoted: true }));

  // ── 聞く ──
  {
    const m = mk();
    const asked = await maybeAskPhotoMention(ev(), m.deps);
    const p = m.r.pushes[0];
    ok("査定の依頼なら下村さんへ push（文字＋［査定書を作る］のカード）", asked && m.r.pushes.length === 1 && p.to === SHIMO && Boolean(p.card));
    ok("文に物件名・「見えます」・「自動では始めません」", p.text.includes("「サウスオールシティ1203」の査定の依頼に見えます") && p.text.includes("自動では始めません"));
    ok("カードのボタンは既存の v1|sa|<案件>・画像の物件名も並べる", JSON.stringify(p.card).includes(`v1|sa|${DEAL.id}`) && JSON.stringify(p.card).includes("画像の物件"));
    ok("予約の鍵は画像の組・push にも同じ鍵", m.r.reserved[0] === "img:img1" && p.key === "img:img1");
    ok("ログは符号だけ", m.r.logs.join() === "[photo-ask] asked card" && quiet(m.r.logs));
  }
  {
    const m = mk({ read: { ...SATEI, confidence: 0.6 } });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("確信度が低ければ「かもしれません」（断定しない）", m.r.pushes[0].text.includes("査定の依頼かもしれません"));
  }
  {
    const m = mk({ read: { ...SATEI, confidence: 0.4 } });
    ok("確信度 0.5 未満は聞かない", !(await maybeAskPhotoMention(ev(), m.deps)) && m.r.pushes.length === 0);
  }
  {
    const m = mk({ env: { ...ENV, TASK_SATEI: undefined } });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("TASK_SATEI が off ならカードなし・案件カードからの案内", m.r.pushes.length === 1 && !m.r.pushes[0].card && m.r.pushes[0].text.includes("案件カードの［査定書を作る］"));
  }
  {
    const m = mk({ deals: [] });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("案件が見つからなければカードなし・見つからない旨", !m.r.pushes[0].card && m.r.pushes[0].text.includes("見つかりませんでした"));
  }
  {
    const m = mk({ deals: "throw" });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("CRM が読めなくても知らせは送る（カードだけ省く）", m.r.pushes.length === 1 && !m.r.pushes[0].card && m.r.logs.includes("[photo-ask] deals-failed"));
  }
  {
    const m = mk({ deals: [{ id: "a".repeat(32), name: "サウスオールシティ東" }, { id: "b".repeat(32), name: "サウスオールシティ西" }] });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("1件に絞れなければカードなし・近い案件の名前", !m.r.pushes[0].card && m.r.pushes[0].text.includes("1件に絞れませんでした"));
  }
  for (const [label, read] of [
    ["タスクでない", { ...SATEI, isTask: false }],
    ["査定でない", { ...SATEI, requestType: "物件資料" }],
  ] as Array<[string, PhotoAskRead]>) {
    const m = mk({ read });
    const asked = await maybeAskPhotoMention(ev(), m.deps);
    ok(`${label}なら聞かない`, !asked && m.r.pushes.length === 0 && m.r.logs.includes("[photo-ask] not-satei"));
  }
  {
    const m = mk({ read: "throw" });
    const asked = await maybeAskPhotoMention(ev(), m.deps);
    ok("読めなければ黙らず「画像を読めませんでした」を送る", asked && m.r.pushes[0].text === MSG_PHOTO_ASK_UNREAD && m.r.logs.includes("[photo-ask] unread read-failed"));
  }
  {
    const m = mk({ read: { isTask: "yes", requestType: 3 } });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("読んだ結果の形が違えば読めなかった扱い", m.r.pushes[0]?.text === MSG_PHOTO_ASK_UNREAD);
  }
  {
    const m = mk();
    await maybeAskPhotoMention(ev({ quotedMessageId: "elsewhere" }), m.deps);
    ok(
      "引用先が控えに無ければ読まずに知らせる（鍵は発言の ID）",
      m.r.reads.length === 0 && m.r.pushes[0]?.text === MSG_PHOTO_ASK_UNREAD && m.r.reserved[0] === "msg:m1" && m.r.logs.includes("[photo-ask] unread quoted-missing"),
    );
  }
  {
    const m = mk({ media: [...IMG, { messageId: "img2", kind: "image", at: NOW - MIN }] });
    await maybeAskPhotoMention(ev({ quotedMessageId: "img1" }), m.deps);
    ok("引用リプライなら引用された画像だけを読む", JSON.stringify(m.r.reads[0]) === JSON.stringify(["img1"]));
  }
  {
    const m = mk({ media: [] });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("画像の控えが無ければ AI を呼ばず・予約もしない", m.r.reads.length === 0 && m.r.reserved.length === 0 && m.r.logs.includes("[photo-ask] skip:no-image"));
  }
  {
    const m = mk({ reserve: false });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("同じ画像の組の二度目は聞かない（予約が取れない）", m.r.reads.length === 0 && m.r.pushes.length === 0 && m.r.logs.includes("[photo-ask] skip:duplicate"));
  }
  {
    const m = mk({ push: false });
    const asked = await maybeAskPhotoMention(ev(), m.deps);
    ok("push が断られたらログ", !asked && m.r.logs.includes("[photo-ask] push-failed asked card"));
  }
  {
    const m = mk();
    await maybeAskPhotoMention(ev({ mentionees: [{ type: "user", userId: BOSS }] }), m.deps);
    ok("ふつうの名指し（下村さん以外）はログも出さず何もしない", m.r.logs.length === 0 && m.r.reserved.length === 0);
  }
  {
    const m = mk({ env: { ...ENV, PHOTO_MENTION_ASK: undefined } });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("off は何も呼ばない", m.r.logs.length === 0 && m.r.reserved.length === 0 && m.r.reads.length === 0);
  }

  // ── 境界・形の確かめ（Codex 実装レビュー） ──
  for (const [c, want] of [[0.5, "かもしれません"], [0.7, "に見えます"], [0.69, "かもしれません"]] as Array<[number, string]>) {
    const m = mk({ read: { ...SATEI, confidence: c } });
    await maybeAskPhotoMention(ev(), m.deps);
    ok(`確信度 ${c} は「${want}」`, m.r.pushes[0]?.text.includes(want) === true);
  }
  for (const bad of [undefined, "0.9", NaN, 2, -0.1]) {
    const m = mk({ read: { ...SATEI, confidence: bad } as unknown as Record<string, unknown> });
    await maybeAskPhotoMention(ev(), m.deps);
    ok(`確信度が形違い（${String(bad)}）なら読めなかった扱い`, m.r.pushes[0]?.text === MSG_PHOTO_ASK_UNREAD);
  }
  ok("30分ちょうど前の画像は使う", pickPhotoAskImages([{ messageId: "e", kind: "image", at: NOW - 30 * MIN }], { timestamp: NOW }).ids.join() === "e");
  ok("30分より1ミリ秒前は使わない", pickPhotoAskImages([{ messageId: "e", kind: "image", at: NOW - 30 * MIN - 1 }], { timestamp: NOW }).ids.length === 0);
  ok("発言の1分後までは使う・それより後は使わない",
    pickPhotoAskImages([{ messageId: "e", kind: "image", at: NOW + MIN }], { timestamp: NOW }).ids.length === 1 &&
      pickPhotoAskImages([{ messageId: "e", kind: "image", at: NOW + MIN + 1 }], { timestamp: NOW }).ids.length === 0);
  {
    const m = mk({ deals: "throw" });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("CRM が読めないときは「確かめられませんでした」（0件と分ける）", m.r.pushes[0].text.includes("CRM の案件を確かめられませんでした"));
  }

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
