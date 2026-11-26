/**
 * 段2f（F1・点検 H1・M1・M2・M4）：画像のあとの名指し（photo-ask）が、グループ査定が実際に知らせを出すときだけ譲る。
 * 迷う道は譲らない（2通の側に倒す。0通を作らない）。deps はすべて差し替え（外へは出ない）。
 */
import { maybeAskPhotoMention, type PhotoAskDeps, type PhotoAskEvent, type PhotoAskMedia } from "../src/lib/photo-ask";
import { gsTicketsTakeImages } from "../src/lib/group-satei-open";
import { GS_REREAD_MAX, GS_TICKET_PUSH_TRIES, type GsMedia, type GsTicket } from "../src/lib/group-satei-data";
import { maybeOpenGroupSateiB } from "../src/lib/group-satei-wire";
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
const ELSE = "U" + "d".repeat(32);
const BOT = "U" + "f".repeat(32);
const GROUP = "C" + "a".repeat(32);
const OTHER = "C" + "e".repeat(32);
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const PHOTO = { PHOTO_MENTION_ASK: "1", PHOTO_MENTION_GROUP_IDS: `${GROUP},${OTHER}`, TASK_SATEI_USER_IDS: SHIMO, TASK_SATEI: "1" };
const BOTH = { ...PHOTO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: GROUP };
const IMG: PhotoAskMedia[] = [{ messageId: "img1", kind: "image", at: NOW - 2 * MIN }];

const ev = (over: Partial<PhotoAskEvent> = {}): PhotoAskEvent => ({
  messageId: "m1", groupId: GROUP, senderId: BOSS, mentionees: [{ type: "user", userId: SHIMO }], text: "", botUserId: BOT, timestamp: NOW, ...over,
});
// 依頼は画像の5分前（画像は依頼のあと＝あとの資料として足される幅）
const tk = (over: Partial<GsTicket> = {}): GsTicket => ({
  no: 7, ver: 1, groupId: GROUP, requesterId: BOSS, at: NOW - 7 * MIN, triggerMsgIds: ["t1"], mediaIds: [], read: null, state: "asking", pushed: true, ...over,
});

function mk(o: { env?: Record<string, string | undefined>; tickets?: unknown[] | "throw"; entry?: string | "never"; claim?: boolean[] | "throw"; startedAt?: number } = {}) {
  const r = { pushes: 0, reserved: 0, listed: 0, slept: 0, claims: 0, logs: [] as string[] };
  let clock = NOW;
  const claims = o.claim === "throw" ? "throw" : [...(o.claim ?? [])];
  const deps: PhotoAskDeps = {
    env: o.env ?? BOTH,
    listMedia: async () => IMG,
    reserve: async () => {
      r.reserved++;
      return true;
    },
    read: async () => ({ isTask: true, requestType: "査定書", confidence: 0.9, propertyName: "サウスオールシティ", propertyKey: normalizeProperty("サウスオールシティ") }),
    loadDeals: async () => [],
    push: async () => {
      r.pushes++;
      return true;
    },
    log: (l) => r.logs.push(l),
    listGsTickets: async () => {
      r.listed++;
      if (o.tickets === "throw") throw new Error("kv");
      return o.tickets ?? [];
    },
    gsClaimed: async () => {
      r.claims++;
      if (claims === "throw") throw new Error("kv");
      return claims.length ? claims.shift()! : false;
    },
    now: () => clock,
    sleep: async (ms) => {
      r.slept += ms;
      clock += ms;
    },
    startedAt: o.startedAt,
  };
  if (o.entry !== undefined) deps.gsEntry = o.entry === "never" ? new Promise<string>(() => undefined) : Promise.resolve(o.entry);
  return { r, deps };
}
const yielded = (m: ReturnType<typeof mk>) => m.r.pushes === 0 && m.r.reserved === 0 && m.r.logs.includes("[photo-ask] skip:group-satei");
const asked = (m: ReturnType<typeof mk>) => m.r.pushes === 1 && m.r.reserved === 1 && !m.r.logs.includes("[photo-ask] skip:group-satei");
const row = (o: Partial<GsMedia> = {}): GsMedia => ({ messageId: "img1", kind: "image", senderId: BOSS, at: NOW - 2 * MIN, ...o });

(async () => {
  // ── 純粋な判定（gsTicketsTakeImages） ──
  ok("送り主の asking の票に、あとの資料として足される画像は扱う", gsTicketsTakeImages([tk()], [row()], GROUP, BOTH));
  ok("もう束ねている画像は扱う", gsTicketsTakeImages([tk({ mediaIds: ["img1"], at: NOW - 60 * MIN })], [row()], GROUP, BOTH));
  ok("読んでいる最中の票（依頼の30分前〜1分後の本人の画像）は扱う", gsTicketsTakeImages([tk({ at: NOW - 1 * MIN })], [row()], GROUP, BOTH));
  // 開いている票が2件（ほかの人の票もある）と、本人の30分の幅だけ（lateMediaMatches と同じ）
  const another = tk({ requesterId: ELSE, triggerMsgIds: ["t2"], at: NOW - 50 * MIN });
  ok("依頼から30分を過ぎた画像は扱わない（H1 の1）", !gsTicketsTakeImages([tk({ at: NOW - 45 * MIN }), another], [row()], GROUP, BOTH));
  ok("開いている票が1件だけなら、2時間以内の画像は足される（attachLateMedia と同じ）", gsTicketsTakeImages([tk({ at: NOW - 45 * MIN })], [row()], GROUP, BOTH));
  for (const state of ["gathering", "proposing", "waiting-cases", "started", "manual", "dismissed"] as const) {
    ok(`${state} の票では扱わない（H1 の2）`, !gsTicketsTakeImages([tk({ state })], [row()], GROUP, BOTH));
  }
  ok("読み直しを使い切った票は扱わない（H1 の3）", !gsTicketsTakeImages([tk({ rereads: GS_REREAD_MAX })], [row()], GROUP, BOTH));
  ok("送り直しを諦めた（pushed でなく pushTries が上限）票は扱わない（M4）", !gsTicketsTakeImages([tk({ pushed: false, pushTries: GS_TICKET_PUSH_TRIES })], [row()], GROUP, BOTH));
  ok("まだ送り直し中の票は扱う", gsTicketsTakeImages([tk({ pushed: false, pushTries: 3 })], [row()], GROUP, BOTH));
  ok("別の人の票は扱わない", !gsTicketsTakeImages([tk({ requesterId: ELSE })], [row()], GROUP, BOTH));
  ok("別のグループの票は扱わない", !gsTicketsTakeImages([tk({ groupId: OTHER })], [row()], GROUP, BOTH));
  ok("1枚でも扱わない画像があれば扱わない", !gsTicketsTakeImages([tk()], [row(), row({ messageId: "old", at: NOW - 60 * MIN })], GROUP, BOTH));
  ok("形の違う票は数えない", !gsTicketsTakeImages([null, "x", { no: 1 }], [row()], GROUP, BOTH));
  ok("文字列の JSON の票も読む", gsTicketsTakeImages([JSON.stringify(tk())], [row()], GROUP, BOTH));
  ok("GROUP_SATEI off なら扱わない", !gsTicketsTakeImages([tk()], [row()], GROUP, PHOTO));

  // ── 同じ発言の入口 B の結果（M1） ──
  {
    const m = mk({ entry: "opened" });
    await maybeAskPhotoMention(ev({ text: "査定お願いします" }), m.deps);
    ok("入口 B が受付票を開いたら譲る（予約を取らない）", yielded(m) && m.r.listed === 0);
  }
  for (const o of ["not-satei", "failed", "duplicate", "skip"]) {
    const m = mk({ entry: o });
    await maybeAskPhotoMention(ev({ text: "査定お願いします" }), m.deps);
    ok(`入口 B が ${o} なら今どおり聞く（言葉だけで譲らない）`, asked(m));
  }
  {
    const m = mk({ entry: "never" });
    // 待つのは45秒まで（時計は差し替えていないので、上限の計算だけ確かめる：webhook の開始から190秒を過ぎていれば待たない）
    m.deps.startedAt = Date.now() - 300_000;
    m.deps.now = () => Date.now();
    await maybeAskPhotoMention(ev({ text: "査定" }), m.deps);
    ok("入口 B の結果が来ないまま webhook の残りが無ければ待たずに聞く", asked(m));
  }

  // ── 受付票（H1・M4） ──
  {
    const m = mk({ tickets: [tk()] });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("送り主の asking の票がこの画像を足すなら譲る", yielded(m) && m.r.listed === 1);
  }
  {
    const m = mk({ tickets: [tk({ at: NOW - 45 * MIN }), tk({ requesterId: ELSE, triggerMsgIds: ["t2"], at: NOW - 50 * MIN })] });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("依頼から45分たった画像なら譲らない（何も届かない道を作らない）", asked(m));
  }
  {
    const m = mk({ tickets: [tk({ state: "gathering" })] });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("gathering の票では譲らない", asked(m));
  }
  {
    const m = mk({ tickets: "throw" });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("受付票が読めなければ譲らない（符号のログだけ）", asked(m) && m.r.logs.includes("[photo-ask] gs-check-failed"));
  }

  // ── 開こうとしている印（M2） ──
  {
    const m = mk({ claim: [true, true, false], tickets: [tk()] });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("印があるあいだ待ち、消えたら票を見て譲る", yielded(m) && m.r.slept === 4_000 && m.r.claims === 3);
  }
  {
    const m = mk({ claim: Array(100).fill(true), tickets: [] });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("印が消えないまま45秒を過ぎたら、票が無ければ聞く", asked(m) && m.r.slept <= 45_000 && m.r.slept >= 40_000, String(m.r.slept));
  }
  {
    const m = mk({ claim: Array(100).fill(true), tickets: [], startedAt: NOW - 180_000 });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("webhook の開始から190秒を超えて待たない", asked(m) && m.r.slept <= 10_000, String(m.r.slept));
  }
  {
    const m = mk({ claim: "throw", tickets: [tk()] });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("印が読めなくても票で決める", yielded(m) && m.r.logs.includes("[photo-ask] gs-check-failed"));
  }

  // ── off・対象外は今のまま ──
  {
    const m = mk({ env: PHOTO, tickets: [tk()], entry: "opened", claim: [true] });
    await maybeAskPhotoMention(ev({ text: "査定" }), m.deps);
    ok("GROUP_SATEI off なら今のまま聞く（受付票も印も読まない）", asked(m) && m.r.listed === 0 && m.r.claims === 0);
  }
  {
    const m = mk({ tickets: [tk({ groupId: OTHER })], entry: "opened" });
    await maybeAskPhotoMention(ev({ groupId: OTHER, text: "査定" }), m.deps);
    ok("photo-ask だけのグループでは今のまま", asked(m) && m.r.listed === 0);
  }
  {
    const m = mk({ tickets: [tk()] });
    await maybeAskPhotoMention(ev({ text: "査定" }), m.deps);
    const j = m.r.logs.join("\n");
    ok("ログに ID・本文を出さない", !j.includes(BOSS) && !j.includes(GROUP) && !j.includes("査定") && !j.includes("img1"));
  }

  // ── 入口 B の結果の渡し方（off なら skip をすぐ・KV を読まない） ──
  {
    let got: string[] = [];
    await maybeOpenGroupSateiB({ messageId: "mx", groupId: GROUP, senderId: BOSS, at: NOW, text: "査定お願いします" }, "2026-11-26", NOW, (o) => got.push(o));
    ok("入口 B は off なら skip を1回だけ渡す", got.join() === "skip");
    got = [];
    await maybeOpenGroupSateiB({ messageId: "my", groupId: GROUP, senderId: BOSS, at: NOW, text: "明日の内見" }, "2026-11-26", NOW, (o) => got.push(o));
    ok("言葉の無い発言も skip を1回", got.join() === "skip");
  }

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
