/**
 * 段2f（F1）：画像のあとの名指し（photo-ask）が、グループ査定の受け持つ依頼で譲る（下村さんへ2通にしない）。
 * deps はすべて差し替え（外へは出ない）。
 */
import { maybeAskPhotoMention, type PhotoAskDeps, type PhotoAskEvent, type PhotoAskMedia } from "../src/lib/photo-ask";
import { gsClaimsMessage, gsHasActiveTicket, GS_YIELD_MS } from "../src/lib/group-satei-gate";
import type { GsTicket } from "../src/lib/group-satei-data";
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
const tk = (over: Partial<GsTicket> = {}): GsTicket => ({
  no: 7, ver: 1, groupId: GROUP, requesterId: BOSS, at: NOW - 10 * MIN, triggerMsgIds: ["t1"], mediaIds: [], read: null, state: "asking", ...over,
});

function mk(o: { env?: Record<string, string | undefined>; tickets?: unknown[] | "throw"; noList?: boolean } = {}) {
  const r = { pushes: 0, reserved: 0, listed: 0, media: 0, logs: [] as string[] };
  const deps: PhotoAskDeps = {
    env: o.env ?? BOTH,
    listMedia: async () => {
      r.media++;
      return IMG;
    },
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
  };
  if (!o.noList) {
    deps.listGsTickets = async () => {
      r.listed++;
      if (o.tickets === "throw") throw new Error("kv");
      return o.tickets ?? [];
    };
  }
  return { r, deps };
}
const yielded = (m: ReturnType<typeof mk>) => m.r.pushes === 0 && m.r.reserved === 0 && m.r.media === 0 && m.r.logs.includes("[photo-ask] skip:group-satei");
const asked = (m: ReturnType<typeof mk>) => m.r.pushes === 1 && m.r.reserved === 1 && !m.r.logs.includes("[photo-ask] skip:group-satei");

(async () => {
  // ── 純粋な判定 ──
  ok("言葉（査定）を含む発言はグループ査定が受け持つ", gsClaimsMessage({ groupId: GROUP, senderId: BOSS, text: "査定お願いします", botMentioned: false }, BOTH));
  ok("@AI秘書 あて（入口 A）も受け持つ", gsClaimsMessage({ groupId: GROUP, senderId: BOSS, text: "", botMentioned: true }, BOTH));
  ok("言葉の無い発言は受け持たない", !gsClaimsMessage({ groupId: GROUP, senderId: BOSS, text: "これお願いします", botMentioned: false }, BOTH));
  ok("GROUP_SATEI off なら受け持たない", !gsClaimsMessage({ groupId: GROUP, senderId: BOSS, text: "査定", botMentioned: true }, PHOTO));
  ok("対象外のグループは受け持たない", !gsClaimsMessage({ groupId: OTHER, senderId: BOSS, text: "査定", botMentioned: false }, BOTH));
  ok("下村さん本人の発言は受け持たない", !gsClaimsMessage({ groupId: GROUP, senderId: SHIMO, text: "査定", botMentioned: true }, BOTH));
  const at = { groupId: GROUP, senderId: BOSS, at: NOW };
  ok("動いている票（asking・2時間以内）がある", gsHasActiveTicket([tk()], at, BOTH));
  ok("ちょうど2時間前の票も数える", gsHasActiveTicket([tk({ at: NOW - GS_YIELD_MS })], at, BOTH));
  ok("2時間より前の票は数えない", !gsHasActiveTicket([tk({ at: NOW - GS_YIELD_MS - 1 })], at, BOTH));
  ok("形の違う票・null は数えない", !gsHasActiveTicket([null, "x", { no: 1 }], at, BOTH));
  ok("文字列の JSON の票も読む", gsHasActiveTicket([JSON.stringify(tk())], at, BOTH));

  // ── 譲る3つの場合 ──
  {
    const m = mk();
    await maybeAskPhotoMention(ev({ text: "査定お願いします" }), m.deps);
    ok("(a) 入口 B の言葉を通る名指しは譲る（予約を取らない・画像も見ない・受付票も読まない）", yielded(m) && m.r.listed === 0);
  }
  {
    const m = mk({ tickets: [tk()] });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("(b) 送り主に asking の票があれば譲る", yielded(m) && m.r.listed === 1);
  }
  for (const state of ["gathering", "proposing", "waiting-cases"] as const) {
    const m = mk({ tickets: [tk({ state })] });
    await maybeAskPhotoMention(ev(), m.deps);
    ok(`(b) ${state} の票でも譲る`, yielded(m));
  }

  // ── 譲らない場合 ──
  {
    const m = mk({ env: { ...BOTH, GROUP_SATEI_GROUP_IDS: OTHER.replace("e", "9") }, tickets: [tk()] });
    await maybeAskPhotoMention(ev({ text: "査定" }), m.deps);
    ok("グループがグループ査定の対象外なら譲らない（受付票も読まない）", asked(m) && m.r.listed === 0);
  }
  {
    const m = mk({ env: PHOTO, tickets: [tk()] });
    await maybeAskPhotoMention(ev({ text: "査定" }), m.deps);
    ok("GROUP_SATEI off なら今のまま聞く（受付票も読まない）", asked(m) && m.r.listed === 0);
  }
  {
    const m = mk({ tickets: [tk({ at: NOW - GS_YIELD_MS - MIN })] });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("受付票が古い（2時間より前）なら譲らない", asked(m));
  }
  {
    const m = mk({ tickets: [tk({ requesterId: ELSE })] });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("別の人の票なら譲らない", asked(m));
  }
  {
    const m = mk({ tickets: [tk({ groupId: OTHER })] });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("別のグループの票なら譲らない", asked(m));
  }
  for (const state of ["started", "manual", "dismissed"] as const) {
    const m = mk({ tickets: [tk({ state })] });
    await maybeAskPhotoMention(ev(), m.deps);
    ok(`閉じた票（${state}）なら譲らない`, asked(m));
  }
  {
    const m = mk({ tickets: "throw" });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("受付票が読めなければ譲らない（符号のログだけ）", asked(m) && m.r.logs.includes("[photo-ask] gs-check-failed"));
  }
  {
    const m = mk({ noList: true });
    await maybeAskPhotoMention(ev(), m.deps);
    ok("受付票を読む口が無ければ言葉だけで決める", asked(m));
  }
  {
    // 対象外のグループ（photo-ask だけが対象）で GROUP_SATEI on でも、今のまま
    const m = mk({ tickets: [tk({ groupId: OTHER })] });
    await maybeAskPhotoMention(ev({ groupId: OTHER, text: "査定" }), m.deps);
    ok("photo-ask だけのグループでは今のまま", asked(m) && m.r.listed === 0);
  }
  {
    const m = mk({ tickets: [tk()] });
    await maybeAskPhotoMention(ev({ text: "査定" }), m.deps);
    const j = m.r.logs.join("\n");
    ok("ログに ID・本文を出さない", !j.includes(BOSS) && !j.includes(GROUP) && !j.includes("査定") && !j.includes("m1"));
  }

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
