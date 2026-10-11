/**
 * Webhook の振り分けのうち、差し戻しの「対応を番号で選ぶ」の枝（設計 2026-10-11 の E12・E14）を、
 * 偽物の KV・LINE・portal・予約で確かめる。
 * 「今までの流れ」（メールの下書き・初動確認・タスク・番号での完了など）は rest に入ったかどうかで確かめる。
 */
import { dispatchObiEvents, type ObiEventDeps, type ObiLineEvent } from "../src/lib/obi/webhook-event";
import { createMemoryObiStore, type ObiStore } from "../src/lib/obi/memo";
import { OBI_MESSAGES } from "../src/lib/obi/intake";
import { OBI_FIX_MESSAGES } from "../src/lib/obi/fix";
import { OBI_REJECT_MESSAGES } from "../src/lib/obi/reject";
import type { ObiEnv } from "../src/lib/obi/config";
import type { ReplyOutcome } from "../src/lib/line";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

const G = "C" + "a".repeat(32);
const G2 = "C" + "e".repeat(32);
const SHIMO = "U" + "b".repeat(32);
const OTHER = "U" + "c".repeat(32);
const BOT = "U" + "f".repeat(32);
const SHA = "1".repeat(64);
const T = 1_760_000_000_000;
const env: ObiEnv = {
  LINE_GROUP_ID: G,
  JOB_ALLOWED_USER_IDS: SHIMO,
  PORTAL_BASE_URL: "https://portal.example.test",
  JOB_API_TOKEN: "tok",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const REJECT_NOTICE = "600000000000000150"; // Mac が出した選択肢つきの知らせ（#J4・世代 40）
const REVIEW_NOTICE = "600000000000000160"; // Mac が出した確認の知らせ（#J4・世代 41）
const DONE_NOTICE = "600000000000000170"; // Mac が出した完成の知らせ（#J12）
const TASK_NOTICE = "600000000000000099"; // 帯替えと関係のない発言（タスクの確認など）
const MSG = "600000000000000200";

// resolve の答え（約束の形）。#J4 の状態は w.phase で切り替える
const base = { no: 4, current: true, pageCount: 4, fixable: "unavailable", closable: "unavailable", rejectRound: 0 };
const CHOOSING = { ...base, artifactSha256: "", phase: "choose", choiceGen: 40, choices: [1, 3, 4] };
const REVIEWING = { ...base, artifactSha256: SHA, phase: "review", choiceGen: 41, choices: [], rejectRound: 1 };
const FIXING = { ...base, artifactSha256: SHA, phase: "fix", choiceGen: 41, choices: [], fixable: "ok", closable: "ok" };
const COMPLETION = { no: 12, artifactSha256: SHA, current: true, pageCount: 5, fixable: "ok", closable: "ok", kind: "completion", phase: "fix", rejectRound: 0, choiceGen: 0, messageGen: 0, choices: [] };

// コンソールに出たものを控える（message.id・userId・groupId・本文・リンクが出ていないことを確かめる）
const logged: string[] = [];
for (const level of ["log", "error", "warn", "info"] as const) {
  const real = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    real(...args);
  };
}

interface World {
  clock: { t: number };
  startedAt: number;
  store: ObiStore;
  kv: string[]; // 「操作 かぎ 値」
  sent: Array<{ url: string; headers: string; body: string }>; // portal へ送ったもの（そのまま）
  /** #J4 のいまの状態 */
  phase: "choose" | "review" | "fix";
  resolve: (body: Record<string, unknown>) => Response;
  reject: (body: Record<string, unknown>) => Response;
  fix: () => Response;
  replies: Array<{ token: string; text: string; timeoutMs: number }>;
  pushes: Array<{ to: string; text: string; timeoutMs: number }>;
  replyImpl: () => ReplyOutcome;
  reserved: string[];
  completed: string[];
  released: string[];
  reserveAnswer: { proceed: boolean; inProgress?: boolean };
  /** now() が、この回数目の呼び出しで1回だけ例外を投げる（0 なら投げない） */
  nowThrowsAt: number;
  nowCalls: number;
}

function world(phase: World["phase"] = "choose"): World {
  const clock = { t: T };
  const memory = createMemoryObiStore(() => clock.t);
  const kv: string[] = [];
  const store: ObiStore = {
    ...memory,
    setNx: async (key, ttl) => {
      kv.push(`setNx ${key} ${ttl}`);
      return memory.setNx(key, ttl);
    },
    putText: async (key, value, ttl) => {
      kv.push(`putText ${key} ${value} ${ttl}`);
      return memory.putText(key, value, ttl);
    },
    getText: async (key) => {
      kv.push(`getText ${key}`);
      return memory.getText(key);
    },
  };
  const w: World = {
    clock,
    startedAt: T,
    store,
    kv,
    sent: [],
    phase,
    resolve: (body) => {
      const now = w.phase === "choose" ? CHOOSING : w.phase === "review" ? REVIEWING : FIXING;
      if (body.no === 4) return json(200, { ...now, kind: "", messageGen: null });
      if (body.quotedMessageId === REJECT_NOTICE) return json(200, { ...now, artifactSha256: "", kind: "reject", messageGen: 40 });
      if (body.quotedMessageId === REVIEW_NOTICE) return json(200, { ...now, artifactSha256: SHA, kind: "review", messageGen: 41 });
      if (body.quotedMessageId === DONE_NOTICE || body.no === 12) return json(200, COMPLETION);
      return json(404, { code: "NOT_FOUND", message: "x" });
    },
    // 約束どおりに答える portal：choose の 1・2 は queued、3 は human、4 は canceled。approve は approved、rechoose は reopened
    reject: (body) => {
      const result =
        body.action === "approve" ? "approved" : body.action === "rechoose" ? "reopened" : body.choice === 3 ? "human" : body.choice === 4 ? "canceled" : "queued";
      return json(201, { no: 4, created: true, result, choice: body.action === "choose" ? body.choice : 0, round: 1, choiceGen: 41 });
    },
    fix: () => json(409, { code: "FIX_UNAVAILABLE", message: "x" }),
    replies: [],
    pushes: [],
    replyImpl: () => ({ kind: "sent", messageId: "700000000000000001" }),
    reserved: [],
    completed: [],
    released: [],
    reserveAnswer: { proceed: true },
    nowThrowsAt: 0,
    nowCalls: 0,
  };
  return w;
}

function deps(w: World, envOver: ObiEnv = env): ObiEventDeps {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers: string[] = [];
    new Headers(init?.headers).forEach((v, k) => headers.push(`${k}: ${v}`));
    w.sent.push({ url: u, headers: headers.join("\n"), body: String(init?.body) });
    const body = JSON.parse(String(init?.body));
    if (u === "https://portal.example.test/api/jobs/fix/resolve") return w.resolve(body);
    if (u === "https://portal.example.test/api/jobs/4/reject") return w.reject(body);
    if (/^https:\/\/portal\.example\.test\/api\/jobs\/\d+\/fix$/.test(u)) return w.fix();
    throw new Error(`想定外の宛先: ${u}`);
  }) as typeof fetch;
  return {
    env: envOver,
    botUserId: BOT,
    startedAt: w.startedAt,
    store: w.store,
    events: {
      reserve: async (id) => {
        w.reserved.push(id);
        return w.reserveAnswer;
      },
      complete: async (id) => {
        w.completed.push(id);
      },
      release: async (id) => {
        w.released.push(id);
      },
    },
    fetchImpl,
    lineToken: "line-token",
    now: () => {
      w.nowCalls++;
      if (w.nowThrowsAt === w.nowCalls) throw new Error(`crash ${MSG}`);
      return w.clock.t;
    },
    reply: async (token, text, timeoutMs) => {
      w.replies.push({ token, text, timeoutMs });
      return w.replyImpl();
    },
    push: async () => {
      throw new Error("選択の返事は pushWithId を使う");
    },
    pushWithId: async (to, text, timeoutMs) => {
      w.pushes.push({ to, text, timeoutMs });
      return { ok: true, messageId: "700000000000000002" };
    },
  };
}

/** テキストのイベント。quoted を付けると引用リプライ、mention を付けると @MD NEXT秘書 つき */
const textEvent = (
  id: string,
  body: string,
  over: { groupId?: string; userId?: string | null; sourceType?: string; quoted?: string; mention?: boolean } = {},
): ObiLineEvent => {
  const prefix = "@MD NEXT秘書 ";
  return {
    type: "message",
    replyToken: `rt-${id}`,
    timestamp: T,
    source: {
      type: over.sourceType ?? "group",
      groupId: over.groupId ?? G,
      ...(over.userId === null ? {} : { userId: over.userId ?? SHIMO }),
    },
    message: {
      id,
      type: "text",
      text: over.mention ? prefix + body : body,
      ...(over.quoted ? { quotedMessageId: over.quoted } : {}),
      ...(over.mention
        ? { mention: { mentionees: [{ index: 0, length: prefix.length - 1, type: "user" as const, userId: BOT }] } }
        : {}),
    },
  };
};
const urls = (w: World) => w.sent.map((s) => s.url.replace("https://portal.example.test", "")).join();
const texts = (w: World) => w.replies.map((r) => r.text);
const RESOLVE = "/api/jobs/fix/resolve";
const REJECT = "/api/jobs/4/reject";
const rejectBody = (w: World) => JSON.parse(w.sent.find((s) => s.url.endsWith("/reject"))?.body ?? "{}") as Record<string, unknown>;
const untouched = (w: World) =>
  w.sent.length === 0 && w.kv.length === 0 && w.replies.length === 0 && w.pushes.length === 0 && w.reserved.length === 0;
/** 返事も予約もしていない（portal の resolve は呼んでよい） */
const silent = (w: World) => w.replies.length === 0 && w.pushes.length === 0 && w.reserved.length === 0 && !w.kv.some((k) => !k.startsWith("getText"));

async function main() {
  // ══ 横取りしない①：portal も KV も呼ばずに、今までの流れへ ══
  for (const [name, ev] of [
    ["引用も #J も無い「OK」", textEvent(MSG, "OK")],
    ["引用も #J も無い「9」", textEvent(MSG, "9")],
    ["引用も #J も無い「オーケー」", textEvent(MSG, "オーケー")],
    ["引用つきでも全体が合わない「OKです」", textEvent(MSG, "OKです", { quoted: REVIEW_NOTICE })],
    ["引用つきでも全体が合わない「了解」", textEvent(MSG, "了解", { quoted: REVIEW_NOTICE })],
    ["引用つきでも全体が合わない「OK ありがとう」", textEvent(MSG, "OK ありがとう", { quoted: REVIEW_NOTICE })],
    ["引用つきでも全体が合わない「99」", textEvent(MSG, "99", { quoted: REVIEW_NOTICE })],
    ["個別トークの「#J4 OK」", textEvent(MSG, "#J4 OK", { sourceType: "user", groupId: undefined })],
    ["他のグループの引用つきの「OK」", textEvent(MSG, "OK", { groupId: G2, quoted: REVIEW_NOTICE })],
    ["他のグループの「#J4 9」", textEvent(MSG, "#J4 9", { groupId: G2 })],
    ["既存の差し戻しの形（#J4 直す）", textEvent(MSG, "#J4 直す")],
  ] as Array<[string, ObiLineEvent]>) {
    const w = world("review");
    const r = await dispatchObiEvents([ev], deps(w));
    ok(`今までの流れへ（何も呼ばない）：${name}`, r.rest.length === 1 && r.rest[0] === ev && !r.needsRetry && untouched(w), JSON.stringify({ sent: w.sent.length, kv: w.kv }));
  }

  // ══ 横取りしない②：引用先を portal に聞き、帯替えの知らせでなければ、返事も予約もせず今までの流れへ ══
  for (const text of ["OK", "ok", "オーケー", "9"]) {
    for (const userId of [SHIMO, OTHER]) {
      const w = world("review");
      const ev = textEvent(MSG, text, { quoted: TASK_NOTICE, userId });
      const r = await dispatchObiEvents([ev], deps(w));
      ok(
        `帯替えの知らせでないものへの引用の「${text}」（${userId === SHIMO ? "許可された人" : "許可されていない人"}）：今までの流れへ・返事なし・断りなし`,
        r.rest.length === 1 && r.rest[0] === ev && !r.needsRetry && silent(w),
      );
      ok(`引用の「${text}」：呼ぶのは resolve 1回だけ（KV は呼ばない）`, urls(w) === RESOLVE && w.kv.length === 0, JSON.stringify({ urls: urls(w), kv: w.kv }));
    }
  }
  for (const [name, quoted, phase] of [
    ["完成の知らせへの引用の「OK」", DONE_NOTICE, "fix"],
    ["選択肢の知らせへの引用の「OK」", REJECT_NOTICE, "choose"],
    ["選択肢の知らせへの引用の「9」", REJECT_NOTICE, "choose"],
  ] as Array<[string, string, World["phase"]]>) {
    const w = world(phase);
    const ev = textEvent(MSG, name.includes("「9」") ? "9" : "OK", { quoted });
    const r = await dispatchObiEvents([ev], deps(w));
    ok(`${name}：扱わない（今までの流れへ・返事なし）`, r.rest[0] === ev && silent(w) && urls(w) === RESOLVE);
  }
  for (const text of ["0", "5", "3ページ 2"]) {
    const w = world("choose");
    const ev = textEvent(MSG, text, { quoted: REJECT_NOTICE });
    const r = await dispatchObiEvents([ev], deps(w));
    ok(`選択肢の知らせへの引用の「${text}」：選択でも訂正でもない（今までの流れへ・返事なし）`, r.rest[0] === ev && silent(w) && urls(w) === RESOLVE);
  }
  for (const [name, setup] of [
    ["「番号で直す」が止まっている（FIX_DISABLED。いまの本番）", (w: World) => { w.resolve = () => json(503, { code: "FIX_DISABLED" }); }],
    ["portal が 500", (w: World) => { w.resolve = () => json(500, { code: "INTERNAL" }); }],
    ["portal につながらない", (w: World) => { w.resolve = () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }; }],
    ["項目の無い portal（R1a より前）", (w: World) => { w.resolve = () => json(200, { no: 4, artifactSha256: SHA, current: true, pageCount: 4, fixable: "ok", closable: "ok" }); }],
  ] as Array<[string, (w: World) => void]>) {
    for (const [text, quoted] of [["OK", REVIEW_NOTICE], ["9", REVIEW_NOTICE], ["#J4 OK", undefined], ["#J4 9", undefined]] as Array<[string, string | undefined]>) {
      const w = world("review");
      setup(w);
      // 項目の無い portal（R1a より前）には /reject の入口が無い（404。code なし）
      w.reject = () => new Response("Not Found", { status: 404 });
      const ev = textEvent(MSG, text, { quoted });
      const r = await dispatchObiEvents([ev], deps(w));
      // 引けたが確認待ちでない「#J4 9」（phase は項目なし＝fix・完成品あり）だけは、/reject に確かめて、その断りを返す（V7）。
      // R1a より前の portal は 404 で断る（出す順番は portal が先なので、portal を前の版に戻したときだけ起きる）
      const stays = name.startsWith("項目の無い") && text === "#J4 9";
      ok(
        `${name} の「${text}」：${stays ? "/reject に確かめ、断り（HTTP_404）を1回返す" : "今までの流れへ・返事なし（/reject を呼ばない）"}（503 にしない）`,
        !r.needsRetry &&
          (stays
            ? urls(w) === `${RESOLVE},${REJECT}` && texts(w).join("|") === OBI_REJECT_MESSAGES.rejected("HTTP_404") && r.rest.length === 0
            : urls(w) === RESOLVE && r.rest[0] === ev && silent(w)),
        JSON.stringify({ texts: texts(w), urls: urls(w) }),
      );
    }
  }
  {
    // 既存の「#J12 OK」（確認待ちでない依頼）：グループでは今までどおり、今までの流れへ
    const w = world("fix");
    const ev = textEvent(MSG, "#J4 OK");
    const r = await dispatchObiEvents([ev], deps(w));
    ok("確認待ちでない依頼への「#J4 OK」：今までどおり、今までの流れへ（返事なし。resolve を1回だけ）", r.rest[0] === ev && silent(w) && urls(w) === RESOLVE);
    const w2 = world("review");
    const ev2 = textEvent(MSG, "#J99 OK");
    const r2 = await dispatchObiEvents([ev2], deps(w2));
    ok("無い番号への「#J99 OK」：今までの流れへ（返事なし）", r2.rest[0] === ev2 && silent(w2) && urls(w2) === RESOLVE);
  }

  // ══ 選択肢の知らせへの引用の番号（1〜4） ══
  for (const [text, choice, expected] of [
    ["1", 1, OBI_REJECT_MESSAGES.queuedBandOnly(4)],
    ["3", 3, OBI_REJECT_MESSAGES.human(4)],
    ["4", 4, OBI_REJECT_MESSAGES.canceled(4)],
    ["３番", 3, OBI_REJECT_MESSAGES.human(4)],
  ] as Array<[string, number, string]>) {
    const w = world("choose");
    const r = await dispatchObiEvents([textEvent(MSG, text, { quoted: REJECT_NOTICE })], deps(w));
    ok(
      `選択肢の知らせへの引用の「${text}」：選択として扱い終える（今までの流れに渡さない・503 にしない）`,
      r.rest.length === 0 && !r.needsRetry && w.reserved.join() === MSG && w.completed.join() === MSG && w.released.length === 0,
    );
    ok(`選択肢の知らせへの引用の「${text}」：何をするかを言葉で返す（発言への reply）`, texts(w).join("|") === expected && w.replies[0].token === `rt-${MSG}`, JSON.stringify(texts(w)));
    const b = rejectBody(w);
    ok(
      `選択肢の知らせへの引用の「${text}」：resolve 1回＋reject 1回。本文は約束どおり（世代は引用先の知らせのもの）`,
      urls(w) === `${RESOLVE},${REJECT}` &&
        JSON.stringify(b) === JSON.stringify({ messageId: MSG, source: "line-group", groupId: G, action: "choose", expectGen: 40, choice }),
      JSON.stringify(b),
    );
  }
  {
    const w = world("choose");
    w.reject = () => json(409, { code: "CHOICE_NOT_OFFERED", message: "x", choices: [1, 3, 4] });
    await dispatchObiEvents([textEvent(MSG, "2", { quoted: REJECT_NOTICE })], deps(w));
    ok("出していない番号（2）：「#J4 で選べるのは 1・3・4 です」（番号は portal の断りから）", texts(w).join("|") === "#J4 で選べるのは 1・3・4 です" && w.completed.join() === MSG, JSON.stringify(texts(w)));
  }
  {
    const w = world("choose");
    const r = await dispatchObiEvents([textEvent(MSG, "1", { quoted: REJECT_NOTICE, mention: true })], deps(w));
    ok("メンションつきでも読む", r.rest.length === 0 && texts(w).join("|") === OBI_REJECT_MESSAGES.queuedBandOnly(4));
  }
  {
    // 許可されていない人：断りを1回。/reject は呼ばない（resolve は対象を決めるために呼んである。何も書き換えない）
    const w = world("choose");
    const r = await dispatchObiEvents([textEvent(MSG, "1", { quoted: REJECT_NOTICE, userId: OTHER })], deps(w));
    ok(
      "許可されていない人の選択：「対応の選択は、帯替えを依頼できる方からお願いします」。/reject は呼ばない",
      r.rest.length === 0 && !r.needsRetry && texts(w).join("|") === OBI_REJECT_MESSAGES.forbidden && urls(w) === RESOLVE && w.completed.join() === MSG,
      JSON.stringify(texts(w)),
    );
    ok("断りの印は message.id ごと（NX・8日）", w.kv.some((k) => k === `setNx obi-fix-forbidden:${MSG} 691200`), JSON.stringify(w.kv));
    const w2 = world("choose");
    await dispatchObiEvents([textEvent(MSG, "1", { quoted: REJECT_NOTICE, userId: null })], deps(w2));
    ok("userId の無いイベント：許可されていない人と同じ", texts(w2).join("|") === OBI_REJECT_MESSAGES.forbidden && urls(w2) === RESOLVE);
  }
  {
    // 古い知らせへの返信（選び直しの後など）：portal が CHOICE_STALE
    const w = world("choose");
    w.reject = () => json(409, { code: "CHOICE_STALE", message: "x" });
    await dispatchObiEvents([textEvent(MSG, "1", { quoted: REJECT_NOTICE })], deps(w));
    ok("古い知らせへの返信：「その知らせは古くなっています。新しい知らせに返信してください」", texts(w).join("|") === OBI_REJECT_MESSAGES.stale);
  }

  // ══ 確認の知らせへの引用（OK・0・9・番号） ══
  for (const [text, action, expected] of [
    ["OK", "approve", OBI_REJECT_MESSAGES.approved(4)],
    ["ok", "approve", OBI_REJECT_MESSAGES.approved(4)],
    ["オーケー", "approve", OBI_REJECT_MESSAGES.approved(4)],
    ["0", "approve", OBI_REJECT_MESSAGES.approved(4)],
    ["9", "rechoose", OBI_REJECT_MESSAGES.reopened(4)],
  ] as Array<[string, string, string]>) {
    const w = world("review");
    const r = await dispatchObiEvents([textEvent(MSG, text, { quoted: REVIEW_NOTICE })], deps(w));
    ok(`確認の知らせへの引用の「${text}」：${action} として扱い終える`, r.rest.length === 0 && !r.needsRetry && w.completed.join() === MSG && texts(w).join("|") === expected, JSON.stringify(texts(w)));
    const b = rejectBody(w);
    ok(
      `確認の知らせへの引用の「${text}」：本文は約束どおり（世代・成果物は引用先の知らせのもの。choice は付けない）`,
      urls(w) === `${RESOLVE},${REJECT}` &&
        JSON.stringify(b) === JSON.stringify({ messageId: MSG, source: "line-group", groupId: G, action, expectGen: 41, expectSha256: SHA }),
      JSON.stringify(b),
    );
  }
  {
    const w = world("review");
    w.reject = () => json(409, { code: "GATE_FAILED", message: "x", reason: "residue" });
    await dispatchObiEvents([textEvent(MSG, "OK", { quoted: REVIEW_NOTICE })], deps(w));
    ok("OK が関門を通らない：「#J4 は LINE では完成にできません。担当が確認します」", texts(w).join("|") === OBI_REJECT_MESSAGES.gateFailed(4));
  }
  {
    const w = world("review");
    const r = await dispatchObiEvents([textEvent(MSG, "OK", { quoted: REVIEW_NOTICE, userId: OTHER })], deps(w));
    ok("許可されていない人の「OK」（確認の知らせへの引用）：断りを1回。/reject は呼ばない", r.rest.length === 0 && texts(w).join("|") === OBI_REJECT_MESSAGES.forbidden && urls(w) === RESOLVE);
  }
  {
    // 確認の知らせへの番号（1〜5）は「番号で直す」へ回り、その文をそのまま返す（T1）。/reject は呼ばない
    const w = world("review");
    await dispatchObiEvents([textEvent(MSG, "2", { quoted: REVIEW_NOTICE })], deps(w));
    ok("確認の知らせへの引用の「2」：「#J4 は番号では直せません。担当に声をかけてください」", texts(w).join("|") === OBI_FIX_MESSAGES.unavailable(4) && urls(w) === RESOLVE, JSON.stringify(texts(w)));
    const w2 = world("review");
    await dispatchObiEvents([textEvent(MSG, "3ページ 2", { quoted: REVIEW_NOTICE })], deps(w2));
    ok("確認の知らせへの引用の「3ページ 2」：fix の FIX_UNAVAILABLE の文をそのまま", texts(w2).join("|") === OBI_FIX_MESSAGES.unavailable(4) && urls(w2) === `${RESOLVE},/api/jobs/4/fix`, JSON.stringify(texts(w2)));
  }

  // ══ #J つき ══
  {
    // 「#J4 1」：依頼が選択待ち（phase: choose）なら選択。世代は今のもの
    const w = world("choose");
    const r = await dispatchObiEvents([textEvent(MSG, "#J4 1")], deps(w));
    const b = rejectBody(w);
    ok(
      "選択待ちの「#J4 1」：認可 → resolve → reject → 返事（世代は今のもの）",
      r.rest.length === 0 && !r.needsRetry && urls(w) === `${RESOLVE},${REJECT}` && texts(w).join("|") === OBI_REJECT_MESSAGES.queuedBandOnly(4) &&
        JSON.stringify(b) === JSON.stringify({ messageId: MSG, source: "line-group", groupId: G, action: "choose", expectGen: 40, choice: 1 }) &&
        w.completed.join() === MSG,
      JSON.stringify({ b, texts: texts(w) }),
    );
    const w2 = world("choose");
    await dispatchObiEvents([textEvent(MSG, "#J4 1", { userId: OTHER })], deps(w2));
    ok("許可されていない人の「#J4 1」：portal を1回も呼ばない（断りは「番号で直す」と同じ文。選択かどうかは resolve まで分からない）", w2.sent.length === 0 && texts(w2).join("|") === OBI_MESSAGES.fixForbidden);
    const w3 = world("fix");
    w3.fix = () => json(201, { no: 4, fixId: 7, created: true, result: "human", code: 4, page: null, turn: "", round: 0, reason: "" });
    await dispatchObiEvents([textEvent(MSG, "#J4 4")], deps(w3));
    ok("選択待ちでない依頼への「#J4 4」：今までどおり「番号で直す」（順番の訂正。/reject は呼ばない）", urls(w3) === `${RESOLVE},/api/jobs/4/fix` && texts(w3).join("|") === OBI_FIX_MESSAGES.human(4, 4, null), JSON.stringify(texts(w3)));
    const w4 = world("review");
    await dispatchObiEvents([textEvent(MSG, "#J4 2")], deps(w4));
    ok("確認待ちの「#J4 2」：「番号では直せません」（T1。/reject は呼ばない）", urls(w4) === RESOLVE && texts(w4).join("|") === OBI_FIX_MESSAGES.unavailable(4), JSON.stringify(texts(w4)));
  }
  for (const [text, action, expected] of [
    ["#J4 OK", "approve", OBI_REJECT_MESSAGES.approved(4)],
    ["＃Ｊ４　ＯＫ", "approve", OBI_REJECT_MESSAGES.approved(4)],
    ["#J4 9", "rechoose", OBI_REJECT_MESSAGES.reopened(4)],
  ] as Array<[string, string, string]>) {
    const w = world("review");
    const r = await dispatchObiEvents([textEvent(MSG, text)], deps(w));
    const b = rejectBody(w);
    ok(
      `確認待ちの「${text}」：${action}（世代・成果物は今のもの）`,
      r.rest.length === 0 && !r.needsRetry && urls(w) === `${RESOLVE},${REJECT}` && texts(w).join("|") === expected && w.completed.join() === MSG &&
        JSON.stringify(b) === JSON.stringify({ messageId: MSG, source: "line-group", groupId: G, action, expectGen: 41, expectSha256: SHA }),
      JSON.stringify({ b, texts: texts(w) }),
    );
  }
  {
    const w = world("review");
    const r = await dispatchObiEvents([textEvent(MSG, "#J4 OK", { userId: OTHER })], deps(w));
    ok("許可されていない人の確認待ちの「#J4 OK」：断りを1回。/reject は呼ばない", r.rest.length === 0 && texts(w).join("|") === OBI_REJECT_MESSAGES.forbidden && urls(w) === RESOLVE);
    {
      // 選択待ち（choose）の「#J4 9」：portal には渡さず、断りの文だけ
      const w2 = world("choose");
      const r2 = await dispatchObiEvents([textEvent(MSG, "#J4 9")], deps(w2));
      ok("確認待ちでない（choose）「#J4 9」：「#J4 はいまその操作ができない状態です」。/reject は呼ばない", r2.rest.length === 0 && texts(w2).join("|") === OBI_REJECT_MESSAGES.unavailable(4) && urls(w2) === RESOLVE && w2.completed.join() === MSG);
    }
    // 確認待ちでない（fix・完成品あり）の「#J4 9」：/reject（rechoose）に渡して、portal の断りで文を分ける（V7）。
    //   「番号で直す」が on・選択肢のスイッチが off（phase は常に fix）→ 503 CHOICE_DISABLED →「いま受付を止めています…」
    //   スイッチは on で、その依頼が確認待ちでないだけ → 409 CHOICE_UNAVAILABLE →「#J4 はいまその操作ができない状態です」
    for (const [name, status, code, expected] of [
      ["選択肢のスイッチが off（CHOICE_DISABLED）", 503, "CHOICE_DISABLED", OBI_REJECT_MESSAGES.disabled],
      ["スイッチは on・確認待ちでない（CHOICE_UNAVAILABLE）", 409, "CHOICE_UNAVAILABLE", OBI_REJECT_MESSAGES.unavailable(4)],
    ] as Array<[string, number, string, string]>) {
      const w2 = world("fix");
      w2.reject = () => json(status, { code, message: "x" });
      const r2 = await dispatchObiEvents([textEvent(MSG, "#J4 9")], deps(w2));
      const b = rejectBody(w2);
      ok(
        `確認待ちでない（fix）「#J4 9」・${name}：/reject に1回確かめて、その文を1回返す（503 にしない・やり直さない）`,
        r2.rest.length === 0 && !r2.needsRetry && urls(w2) === `${RESOLVE},${REJECT}` && texts(w2).join("|") === expected && w2.completed.join() === MSG &&
          JSON.stringify(b) === JSON.stringify({ messageId: MSG, source: "line-group", groupId: G, action: "rechoose", expectGen: 41, expectSha256: SHA }),
        JSON.stringify({ b, texts: texts(w2), urls: urls(w2) }),
      );
    }
    ok(
      "文：受付を止めている（設計 E14・裁定 U2・V7）",
      OBI_REJECT_MESSAGES.disabled === "いま受付を止めています。portal の依頼ボックスを確認してください",
    );
    {
      // 完成品が無い（sha256 が空）fix の「#J4 9」：/reject の本文を作れないので、portal には渡さず、断りの文だけ
      const w2 = world("fix");
      w2.resolve = () => json(200, { ...FIXING, artifactSha256: "", fixable: "unavailable", closable: "unavailable", kind: "", messageGen: null });
      const r2 = await dispatchObiEvents([textEvent(MSG, "#J4 9")], deps(w2));
      ok("確認待ちでない（fix）・完成品が無い「#J4 9」：「#J4 はいまその操作ができない状態です」。/reject は呼ばない", r2.rest.length === 0 && texts(w2).join("|") === OBI_REJECT_MESSAGES.unavailable(4) && urls(w2) === RESOLVE);
    }
    for (const phase of ["choose", "fix"] as const) {
      const w3 = world(phase);
      await dispatchObiEvents([textEvent(MSG, "#J4 9", { userId: OTHER })], deps(w3));
      ok(`許可されていない人の「#J4 9」（${phase}）：断り。/reject は呼ばない`, texts(w3).join("|") === OBI_REJECT_MESSAGES.forbidden && urls(w3) === RESOLVE);
    }
  }

  // ══ 受付を止めている・結果不明・届かない：どれも 503 にしない ══
  for (const [name, setup, expected] of [
    ["スイッチ off（CHOICE_DISABLED）", (w: World) => { w.reject = () => json(503, { code: "CHOICE_DISABLED", message: "x" }); }, OBI_REJECT_MESSAGES.disabled],
    ["/reject が 500（結果不明）", (w: World) => { w.reject = () => json(500, { code: "INTERNAL" }); }, OBI_REJECT_MESSAGES.unknown],
    ["/reject が時間切れ（結果不明）", (w: World) => { w.reject = () => { throw new DOMException("timed out", "TimeoutError"); }; }, OBI_REJECT_MESSAGES.unknown],
    ["/reject につながらない（送っていないことが確か）", (w: World) => { w.reject = () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }; }, OBI_REJECT_MESSAGES.unreachable],
  ] as Array<[string, (w: World) => void, string]>) {
    const w = world("choose");
    setup(w);
    const r = await dispatchObiEvents([textEvent(MSG, "1", { quoted: REJECT_NOTICE })], deps(w));
    ok(
      `${name}：決まった文を1回返して済みにする（503 にしない・やり直さない・/reject は1回だけ）`,
      !r.needsRetry && r.rest.length === 0 && texts(w).join("|") === expected && urls(w) === `${RESOLVE},${REJECT}` && w.completed.join() === MSG && w.released.length === 0,
      JSON.stringify(texts(w)),
    );
  }

  // ══ 遅い開始（同じ Webhook に先の処理があった。開始+7秒より後） ══
  for (const [text, quoted] of [["OK", REVIEW_NOTICE], ["9", REVIEW_NOTICE], ["#J4 OK", undefined], ["#J4 9", undefined]] as Array<[string, string | undefined]>) {
    const w = world("review");
    w.clock.t = T + 7_001;
    const ev = textEvent(MSG, text, { quoted });
    const r = await dispatchObiEvents([ev], deps(w));
    ok(`遅い開始の「${text}」：portal を呼ばず、今までの流れへ（返事なし）`, r.rest[0] === ev && !r.needsRetry && untouched(w));
  }
  {
    const w = world("choose");
    w.clock.t = T + 7_001;
    const r = await dispatchObiEvents([textEvent(MSG, "#J4 1")], deps(w));
    ok("遅い開始の「#J4 1」：今までどおり「…portal に届きません…」（portal を呼ばない）", r.rest.length === 0 && w.sent.length === 0 && texts(w).join("|") === OBI_FIX_MESSAGES.unreachable);
  }

  // ══ 設定が足りない ══
  for (const [text, quoted] of [["OK", REVIEW_NOTICE], ["#J4 OK", undefined], ["#J4 9", undefined]] as Array<[string, string | undefined]>) {
    const w = world("review");
    const ev = textEvent(MSG, text, { quoted });
    const r = await dispatchObiEvents([ev], deps(w, { ...env, JOB_API_TOKEN: undefined }));
    ok(`設定が足りないときの「${text}」：今までの流れへ（返事なし・何も呼ばない）`, r.rest[0] === ev && untouched(w));
    const w2 = world("review");
    const r2 = await dispatchObiEvents([ev], deps(w2, { ...env, LINE_GROUP_ID: undefined }));
    ok(`LINE_GROUP_ID が無いときの「${text}」：今までの流れへ`, r2.rest[0] === ev && untouched(w2));
  }

  // ══ 予約 ══
  for (const answer of [{ proceed: false }, { proceed: false, inProgress: true }]) {
    const w = world("review");
    w.reserveAnswer = answer;
    const r = await dispatchObiEvents([textEvent(MSG, "OK", { quoted: REVIEW_NOTICE })], deps(w));
    ok(
      `同じ発言が${answer.inProgress ? "処理中" : "済み"}：何もしない（/reject を呼ばない・503 にしない・予約を済みにも解放にもしない）`,
      r.rest.length === 0 && !r.needsRetry && urls(w) === RESOLVE && w.replies.length === 0 && w.completed.length === 0 && w.released.length === 0,
    );
  }

  // ══ 例外で止まったとき ══
  {
    // /reject を呼ぶ前の例外（#J つき）：何も変わっていないので「…portal に届きません…」を返して済みにする
    //   now() の呼び出し：①遅い開始の判定 ②resolve の時間 ③/reject の時間（ここで投げる）
    const w = world("review");
    w.nowThrowsAt = 3;
    const r = await dispatchObiEvents([textEvent(MSG, "#J4 OK")], deps(w));
    ok(
      "/reject を呼ぶ前の例外（#J4 OK）：「対応を受け付けられませんでした（portal に届きません）…」を返して済み",
      r.rest.length === 0 && !r.needsRetry && texts(w).join("|") === OBI_REJECT_MESSAGES.unreachable && urls(w) === RESOLVE && w.completed.join() === MSG && w.released.length === 0,
      JSON.stringify({ texts: texts(w), calls: w.nowCalls }),
    );
  }
  {
    // /reject を呼ぶ前の例外（引用の形）：予約を外して、今までの流れへ渡す
    const w = world("review");
    w.nowThrowsAt = 3;
    const ev = textEvent(MSG, "OK", { quoted: REVIEW_NOTICE });
    const r = await dispatchObiEvents([ev], deps(w));
    ok(
      "/reject を呼ぶ前の例外（引用の「OK」）：予約を外して今までの流れへ（返事なし）",
      r.rest[0] === ev && !r.needsRetry && w.replies.length === 0 && w.released.join() === MSG && w.completed.length === 0 && urls(w) === RESOLVE,
      JSON.stringify({ texts: texts(w), calls: w.nowCalls }),
    );
  }
  {
    // 「#J4 1」（訂正の枝から選択へ渡った後）の例外：選択の文で返す
    //   now()：①遅い開始 ②resolve の時間 ③/reject の時間（ここで投げる）
    const w = world("choose");
    w.nowThrowsAt = 3;
    const r = await dispatchObiEvents([textEvent(MSG, "#J4 1")], deps(w));
    ok(
      "/reject を呼ぶ前の例外（#J4 1）：選択の「…portal に届きません…」を返して済み",
      r.rest.length === 0 && texts(w).join("|") === OBI_REJECT_MESSAGES.unreachable && w.completed.join() === MSG,
      JSON.stringify({ texts: texts(w), calls: w.nowCalls }),
    );
  }
  {
    // /reject がはっきり答えた後の例外（返事が投げた）：済みにする（やり直さない・503 にしない）
    const w = world("choose");
    w.replyImpl = () => {
      throw new Error(`crash ${MSG}`);
    };
    const r = await dispatchObiEvents([textEvent(MSG, "1", { quoted: REJECT_NOTICE })], deps(w));
    ok("/reject が答えた後の例外：済みにする（予約を外さない・503 にしない）", r.rest.length === 0 && !r.needsRetry && w.completed.join() === MSG && w.released.length === 0 && urls(w) === `${RESOLVE},${REJECT}`);
  }

  // ══ 個人の ID・発言の ID を外に出さない ══
  {
    const w = world("choose");
    const from = logged.length;
    await dispatchObiEvents([textEvent(MSG, "1", { quoted: REJECT_NOTICE })], deps(w));
    const w2 = world("review");
    await dispatchObiEvents([textEvent("600000000000000201", "OK", { quoted: REVIEW_NOTICE, userId: OTHER })], deps(w2));
    const w3 = world("review");
    await dispatchObiEvents([textEvent("600000000000000202", "#J4 9")], deps(w3));
    const logs = logged.slice(from).filter((l) => !l.startsWith("✅") && !l.startsWith("❌"));
    const leaked = (s: string) => s.includes(SHIMO) || s.includes(OTHER);
    const all = [w, w2, w3];
    ok(
      "userId を portal に送っていない（URL・ヘッダ・本文）",
      all.every((x) => x.sent.length >= 1 && !x.sent.some((s) => leaked(s.url) || leaked(s.headers) || leaked(s.body))),
    );
    ok("userId を KV に置いていない（かぎ・値）", all.every((x) => !x.kv.some(leaked)));
    ok("userId を返事に出していない", all.every((x) => !x.replies.some((r) => leaked(r.text))));
    ok(
      "ログに userId・groupId・message.id（発言・引用先）・sha256 を出していない",
      logs.length >= 3 &&
        !logs.some((l) => leaked(l) || l.includes(G) || l.includes(MSG) || l.includes("600000000000000201") || l.includes(REJECT_NOTICE) || l.includes(REVIEW_NOTICE) || l.includes(SHA)),
      JSON.stringify(logs),
    );
    ok(
      "返事に message.id・groupId・sha256 を出していない",
      all.every((x) => !x.replies.some((r) => r.text.includes(MSG) || r.text.includes(G) || r.text.includes(SHA))),
    );
    ok(
      "選択のかぎは全部「番号で直す」と同じ置き場・期限8日（新しいかぎを作っていない）",
      all.every((x) => x.kv.filter((k) => !k.startsWith("getText")).every((k) => k.includes("obi-fix-") && k.endsWith(" 691200"))),
      JSON.stringify(all.map((x) => x.kv)),
    );
    ok("portal の鍵はヘッダ x-job-token だけ", all.every((x) => x.sent.every((s) => s.headers.includes("x-job-token: tok") && !s.url.includes("tok"))));
  }

  // ══ 既存の機能は変えていない ══
  {
    // 完成の知らせへの引用の「0」は、今までどおり「番号で直す」の締め（/reject ではない）
    const w = world("fix");
    w.fix = () => json(201, { no: 12, fixId: 7, created: true, result: "closed", code: 0, page: null, turn: "", round: 0, reason: "" });
    await dispatchObiEvents([textEvent(MSG, "0", { quoted: DONE_NOTICE })], deps(w));
    ok("完成の知らせへの引用の「0」：今までどおり「完了にしました」（fix。/reject は呼ばない）", urls(w) === `${RESOLVE},/api/jobs/12/fix` && texts(w).join("|") === OBI_FIX_MESSAGES.closed(12), JSON.stringify(texts(w)));
    // 帯替えの依頼・タスクの発言は、この枝を通らない
    const w2 = world("review");
    const ev = textEvent(MSG, "OK、明日の内見の件お願いします");
    const r = await dispatchObiEvents([ev], deps(w2));
    ok("ふつうの文（OK で始まる）：今までの流れへ（何も呼ばない）", r.rest[0] === ev && untouched(w2));
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
