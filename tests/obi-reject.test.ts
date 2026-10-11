/**
 * 差し戻しの対応の選択の中身（認可〜/reject〜返事 runObiReject）を、偽物の KV・portal・LINE で確かめる
 * （設計 2026-10-11 の E12・E14・「うまくいかないとき」）。
 */
import {
  locateObiChoiceWord,
  runObiReject,
  replyObiRejectInterrupted,
  OBI_REJECT_MESSAGES,
  type ObiChoiceWordInput,
  type ObiRejectInput,
  type ObiRejectTarget,
} from "../src/lib/obi/reject";
import { parseChoiceWord } from "../src/lib/obi/reject-parse";
import type { ObiFixDeps, ObiFixStageHooks } from "../src/lib/obi/fix";
import type { ChoicePlan } from "../src/lib/obi/reject-plan";
import { OBI_FIX_MESSAGES } from "../src/lib/obi/fix";
import { OBI_MESSAGES } from "../src/lib/obi/intake";
import { createMemoryObiStore, type ObiStore } from "../src/lib/obi/memo";
import type { ObiConfig } from "../src/lib/obi/config";
import type { ReplyOutcome } from "../src/lib/line";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

const G = "C" + "a".repeat(32);
const SHA = "1".repeat(64);
const T = 1_760_000_000_000;
const TTL = 8 * 24 * 60 * 60;
const MSG = "600000000000000200";
const config: ObiConfig = {
  groupId: G,
  allowedUserIds: ["U" + "b".repeat(32)],
  portalBaseUrl: "https://portal.example.test",
  jobApiToken: "tok",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const timeoutError = () => new DOMException("timed out", "TimeoutError");

// portal の呼び出しに付けた時間の上限（AbortSignal.timeout の引数）を控える
const signalTimeouts: number[] = [];
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms: number) => {
  signalTimeouts.push(ms);
  return realTimeout(ms);
};

// コンソールに出たものを控える（message.id・groupId が出ていないことを確かめる）
const logged: string[] = [];
for (const level of ["log", "error"] as const) {
  const real = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    real(...args);
  };
}

const accepted = (over: Record<string, unknown> = {}) =>
  json(201, { no: 4, created: true, result: "queued", choice: 1, round: 1, choiceGen: 41, ...over });

interface World {
  clock: { t: number };
  startedAt: number;
  store: ObiStore;
  kv: Array<[string, string, (string | number)?]>; // [操作, かぎ, 期限]
  portal: Array<{ path: string; body: Record<string, unknown> }>;
  resolve: () => Response;
  resolveTakesMs: number;
  reject: () => Response;
  rejectTakesMs: number;
  replies: Array<{ text: string; timeoutMs: number }>;
  pushes: Array<{ to: string; text: string; timeoutMs: number }>;
  replyOutcome: ReplyOutcome;
  pushOutcome: { ok: boolean; messageId: string | null; rejected?: boolean };
  fixCalled: number;
  committed: number;
}

function world(): World {
  const clock = { t: T };
  const memory = createMemoryObiStore(() => clock.t);
  const kv: World["kv"] = [];
  const store: ObiStore = {
    ...memory,
    setNx: async (key, ttl) => {
      kv.push(["setNx", key, ttl]);
      return memory.setNx(key, ttl);
    },
    putText: async (key, value, ttl) => {
      kv.push(["putText", key, `${value}|${ttl}`]);
      return memory.putText(key, value, ttl);
    },
    getText: async (key) => {
      kv.push(["getText", key]);
      return memory.getText(key);
    },
    del: async (key) => {
      kv.push(["del", key]);
      return memory.del(key);
    },
  };
  return {
    clock,
    startedAt: T,
    store,
    kv,
    portal: [],
    resolve: () => json(404, { code: "NOT_FOUND", message: "x" }),
    resolveTakesMs: 0,
    reject: () => accepted(),
    rejectTakesMs: 0,
    replies: [],
    pushes: [],
    replyOutcome: { kind: "sent", messageId: "700000000000000001" },
    pushOutcome: { ok: true, messageId: "700000000000000002" },
    fixCalled: 0,
    committed: 0,
  };
}

function deps(w: World): ObiFixDeps & ObiFixStageHooks {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const path = u.replace("https://portal.example.test", "");
    if (path === u) throw new Error(`想定外の宛先: ${u}`);
    if (new Headers(init?.headers).get("x-job-token") !== "tok") throw new Error("鍵が無い");
    w.portal.push({ path, body: JSON.parse(String(init?.body)) });
    // 呼び出しに付いた時間の上限（直前の AbortSignal.timeout）より長くかかるなら、上限で時間切れにする
    const cap = signalTimeouts[signalTimeouts.length - 1] ?? Infinity;
    if (/^\/api\/jobs\/\d+\/reject$/.test(path)) {
      w.clock.t += Math.min(w.rejectTakesMs, cap);
      if (w.rejectTakesMs > cap) throw timeoutError();
      return w.reject();
    }
    // resolve を呼ぶのは対象を決める段階（locateObiChoiceWord）だけ。runObiReject は resolve も fix も呼ばない
    if (path === "/api/jobs/fix/resolve") {
      w.clock.t += Math.min(w.resolveTakesMs, cap);
      if (w.resolveTakesMs > cap) throw timeoutError();
      return w.resolve();
    }
    throw new Error(`想定外の宛先: ${u}`);
  }) as typeof fetch;
  return {
    store: w.store,
    fetchImpl,
    now: () => w.clock.t,
    reply: async (text, timeoutMs) => {
      w.replies.push({ text, timeoutMs });
      return w.replyOutcome;
    },
    push: async (to, text, timeoutMs) => {
      w.pushes.push({ to, text, timeoutMs });
      return w.pushOutcome;
    },
    onFixCalled: () => {
      w.fixCalled++;
    },
    onCommitted: () => {
      w.committed++;
    },
  };
}

const input = (w: World, over: Partial<ObiRejectInput> = {}): ObiRejectInput => ({
  messageId: MSG,
  allowed: true,
  startedAt: w.startedAt,
  config,
  ...over,
});
const choose = (choice: 1 | 2 | 3 | 4, expectGen = 40): ChoicePlan => ({ action: "choose", choice, expectGen, expectSha256: "" });
const APPROVE: ChoicePlan = { action: "approve", choice: 0, expectGen: 41, expectSha256: SHA };
const RECHOOSE: ChoicePlan = { action: "rechoose", choice: 0, expectGen: 41, expectSha256: SHA };
const target = (plan: ChoicePlan | null): ObiRejectTarget => ({ no: 4, plan });
const QUOTED = "600000000000000150";
const wordInput = (w: World, text: string, over: Partial<ObiChoiceWordInput> = {}): ObiChoiceWordInput => ({
  word: parseChoiceWord(text)!,
  quotedMessageId: null,
  startedAt: w.startedAt,
  config,
  ...over,
});
// resolve の答え（約束の形）。確認の知らせ（#J4。世代 41）と、それへの引用
const BASE = { no: 4, artifactSha256: SHA, current: true, pageCount: 4, fixable: "unavailable", closable: "unavailable", rejectRound: 1, choiceGen: 41, choices: [] };
const REVIEW_BY_QUOTE = { ...BASE, kind: "review", phase: "review", messageGen: 41 };
const REVIEW_BY_NO = { ...BASE, kind: "", phase: "review", messageGen: null };
const RESOLVE = "/api/jobs/fix/resolve";
const silent = (w: World) => w.replies.length === 0 && w.pushes.length === 0 && w.kv.length === 0;
const texts = (w: World) => w.replies.map((r) => r.text);
const paths = (w: World) => w.portal.map((p) => p.path).join();
const REJECT = "/api/jobs/4/reject";

async function main() {
  // ══ 文（設計 E14 の表。そのまま） ══
  ok(
    "文：受け付けた（1・2・3・4・OK・9）",
    OBI_REJECT_MESSAGES.queuedBandOnly(4) === "#J4 帯だけ替えて仕上げます。できたら、ここに確認用のリンクを出します" &&
      OBI_REJECT_MESSAGES.queuedAi(4) === "#J4 AI に読ませて仕上げます。できたら、ここに確認用のリンクを出します" &&
      OBI_REJECT_MESSAGES.human(4) === "#J4 担当が確認します" &&
      OBI_REJECT_MESSAGES.canceled(4) === "#J4 を取り消しました" &&
      OBI_REJECT_MESSAGES.approved(4) === "#J4 を完成にしました。納品の準備ができしだい、ここにリンクを送ります" &&
      OBI_REJECT_MESSAGES.reopened(4) === "#J4 対応を選び直せます。次の知らせに番号で返信してください",
  );
  ok(
    "文：許可されていない人・いまできない状態",
    OBI_REJECT_MESSAGES.forbidden === "対応の選択は、帯替えを依頼できる方からお願いします" &&
      OBI_REJECT_MESSAGES.unavailable(4) === "#J4 はいまその操作ができない状態です",
  );

  // ══ 言葉の返事の対象の特定（locateObiChoiceWord）：扱うのは、portal が確認の知らせ・確認待ちと答えたときだけ ══
  for (const [text, action] of [["OK", "approve"], ["オーケー", "approve"], ["9", "rechoose"]] as Array<[string, string]>) {
    const w = world();
    w.resolve = () => json(200, REVIEW_BY_QUOTE);
    signalTimeouts.length = 0;
    const t = await locateObiChoiceWord(wordInput(w, text, { quotedMessageId: QUOTED }), deps(w));
    ok(
      `確認の知らせへの引用の「${text}」：${action}（世代・成果物は引用先の知らせのもの）`,
      t.kind === "choice" && t.via === "notice" && t.no === 4 && JSON.stringify(t.plan) === JSON.stringify({ action, choice: 0, expectGen: 41, expectSha256: SHA }),
      JSON.stringify(t),
    );
    ok(
      `引用の「${text}」：portal は resolve を1回（引用先の id で・上限6秒）。KV は呼ばない・返事はしない`,
      paths(w) === RESOLVE && w.portal[0].body.quotedMessageId === QUOTED && w.portal[0].body.no === undefined && signalTimeouts.join() === "6000" && silent(w),
      JSON.stringify(w.portal),
    );
  }
  for (const [name, body] of [
    ["完成の知らせ（completion）", { ...BASE, kind: "completion", phase: "fix", fixable: "ok", closable: "ok", messageGen: 0 }],
    ["選択肢の知らせ（reject）", { ...BASE, artifactSha256: "", kind: "reject", phase: "choose", messageGen: 41, choices: [1, 3, 4] }],
    ["種類の項目が無い（古い portal）", { no: 4, artifactSha256: SHA, current: true, pageCount: 4, fixable: "ok", closable: "ok" }],
    ["知らない種類", { ...BASE, kind: "something-new", phase: "review", messageGen: 41 }],
    ["確認の知らせだが世代が無い", { ...BASE, kind: "review", phase: "review" }],
    ["確認の知らせだが成果物の sha256 が空", { ...REVIEW_BY_QUOTE, artifactSha256: "" }],
  ] as Array<[string, Record<string, unknown>]>) {
    for (const text of ["OK", "9"]) {
      const w = world();
      w.resolve = () => json(200, body);
      const t = await locateObiChoiceWord(wordInput(w, text, { quotedMessageId: QUOTED }), deps(w));
      ok(`引用先が ${name} の「${text}」：扱わない（返事をせず今までの流れへ）`, t.kind === "rest" && silent(w), JSON.stringify(t));
    }
  }
  for (const [name, setup] of [
    ["帯替えの知らせでない（NOT_FOUND）", (w: World) => { w.resolve = () => json(404, { code: "NOT_FOUND" }); }],
    ["「番号で直す」が止まっている（FIX_DISABLED）", (w: World) => { w.resolve = () => json(503, { code: "FIX_DISABLED" }); }],
    ["500", (w: World) => { w.resolve = () => json(500, { code: "INTERNAL" }); }],
    ["時間切れ", (w: World) => { w.resolveTakesMs = 7_000; }],
    ["つながらない", (w: World) => { w.resolve = () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }; }],
    ["形の違う 200", (w: World) => { w.resolve = () => json(200, { ...REVIEW_BY_QUOTE, choiceGen: "41" }); }],
  ] as Array<[string, (w: World) => void]>) {
    for (const [text, quoted] of [["OK", QUOTED], ["9", QUOTED], ["#J4 OK", null], ["#J4 9", null]] as Array<[string, string | null]>) {
      const w = world();
      setup(w);
      const t = await locateObiChoiceWord(wordInput(w, text, { quotedMessageId: quoted }), deps(w));
      ok(`引けない・確かめられない（${name}）の「${text}」：返事も印もなしで今までの流れへ`, t.kind === "rest" && silent(w) && paths(w) === RESOLVE, JSON.stringify(t));
    }
  }
  {
    const w = world();
    const t = await locateObiChoiceWord(wordInput(w, "OK"), deps(w));
    const t2 = await locateObiChoiceWord(wordInput(w, "OK", { quotedMessageId: "abc" }), deps(w));
    ok("#J も引用も無い「OK」・引用先の id が数字でない：扱わない（portal を呼ばない）", t.kind === "rest" && t2.kind === "rest" && w.portal.length === 0 && silent(w));
    const t3 = await locateObiChoiceWord(wordInput(w, "#J0 OK"), deps(w));
    ok("「#J0 OK」：扱わない（portal を呼ばない）", t3.kind === "rest" && w.portal.length === 0);
  }
  {
    // 残り時間が無い（開始+17秒より後）：resolve を呼ばずに今までの流れへ
    const w = world();
    w.clock.t = T + 17_000;
    const t = await locateObiChoiceWord(wordInput(w, "OK", { quotedMessageId: QUOTED }), deps(w));
    ok("残り時間が無い：resolve を呼ばず今までの流れへ", t.kind === "rest" && w.portal.length === 0 && silent(w));
    const w2 = world();
    w2.clock.t = T + 15_000;
    w2.resolve = () => json(200, REVIEW_BY_QUOTE);
    signalTimeouts.length = 0;
    await locateObiChoiceWord(wordInput(w2, "OK", { quotedMessageId: QUOTED }), deps(w2));
    ok("resolve の時間の上限は、開始+17秒までの残り（2秒）", signalTimeouts.join() === "2000", signalTimeouts.join());
  }
  // #J つき（「#J4 OK」「#J4 9」）：今の依頼が確認待ち（phase: review）のときだけ
  for (const [text, action] of [["#J4 OK", "approve"], ["#J4 完成", "approve"], ["#J4 9", "rechoose"]] as Array<[string, string]>) {
    const w = world();
    w.resolve = () => json(200, REVIEW_BY_NO);
    const t = await locateObiChoiceWord(wordInput(w, text), deps(w));
    ok(
      `確認待ちの「${text}」：${action}（世代・成果物は今のもの）`,
      t.kind === "choice" && t.via === "number" && t.no === 4 && JSON.stringify(t.plan) === JSON.stringify({ action, choice: 0, expectGen: 41, expectSha256: SHA }),
      JSON.stringify(t),
    );
    ok(`「${text}」：resolve は受付番号で1回。KV は呼ばない・返事はしない`, paths(w) === RESOLVE && w.portal[0].body.no === 4 && w.portal[0].body.quotedMessageId === undefined && silent(w));
  }
  {
    // 引用つきの「#J4 OK」：#J が先（引用先は見ない）
    const w = world();
    w.resolve = () => json(200, REVIEW_BY_NO);
    const t = await locateObiChoiceWord(wordInput(w, "#J4 OK", { quotedMessageId: QUOTED }), deps(w));
    ok("引用つきの「#J4 OK」：#J の番号で引く", t.kind === "choice" && t.via === "number" && w.portal[0].body.no === 4 && w.portal[0].body.quotedMessageId === undefined);
  }
  for (const phase of ["fix", "choose"]) {
    const w = world();
    w.resolve = () => json(200, { ...REVIEW_BY_NO, phase });
    const t = await locateObiChoiceWord(wordInput(w, "#J4 OK"), deps(w));
    ok(`確認待ちでない（phase: ${phase}）の「#J4 OK」：扱わない（今までどおり、今までの流れへ。返事なし）`, t.kind === "rest" && t.reason === "ok-not-review" && silent(w), JSON.stringify(t));
    const w2 = world();
    w2.resolve = () => json(200, { ...REVIEW_BY_NO, phase });
    const t2 = await locateObiChoiceWord(wordInput(w2, "#J4 9"), deps(w2));
    // 「#J4 9」：phase が fix で完成品があれば、/reject（rechoose）に渡して portal に断らせる（V7）。選択待ち（choose）は断りの文だけ
    const expectPlan = phase === "fix" ? JSON.stringify({ action: "rechoose", choice: 0, expectGen: 41, expectSha256: SHA }) : "null";
    ok(
      `確認待ちでない（phase: ${phase}）の「#J4 9」：${phase === "fix" ? "portal に確かめる対象（rechoose。世代・成果物は今のもの）" : "断りの文だけ返す対象（plan が null）"}`,
      t2.kind === "choice" && t2.via === "number" && t2.no === 4 && JSON.stringify(t2.plan) === expectPlan && paths(w2) === RESOLVE && silent(w2),
      JSON.stringify(t2),
    );
  }
  {
    // 完成品が無い依頼（sha256 が空）の「#J4 9」：/reject の本文を作れないので、断りの文だけ返す対象
    const w = world();
    w.resolve = () => json(200, { ...REVIEW_BY_NO, phase: "fix", artifactSha256: "" });
    const t = await locateObiChoiceWord(wordInput(w, "#J4 9"), deps(w));
    ok("確認待ちでない（phase: fix）・完成品が無い「#J4 9」：断りの文だけ返す対象（plan が null）", t.kind === "choice" && t.via === "number" && t.plan === null && silent(w), JSON.stringify(t));
  }
  {
    const w = world();
    w.resolve = () => json(200, { no: 4, artifactSha256: SHA, current: true, pageCount: 4, fixable: "ok", closable: "ok" });
    const t = await locateObiChoiceWord(wordInput(w, "#J4 OK"), deps(w));
    ok("項目の無い portal（R1a より前）の「#J4 OK」：今までどおり、今までの流れへ", t.kind === "rest" && silent(w), JSON.stringify(t));
    const w2 = world();
    w2.resolve = () => json(200, { ...REVIEW_BY_NO, no: 5 });
    const t2 = await locateObiChoiceWord(wordInput(w2, "#J4 OK"), deps(w2));
    ok("頼んだ番号と違う依頼が返った：扱わない", t2.kind === "rest" && silent(w2), JSON.stringify(t2));
  }

  // ══ 認可 ══
  {
    const w = world();
    const r = await runObiReject(input(w, { allowed: false }), target(choose(1)), deps(w));
    ok(
      "許可されていない人：断りを1回。portal は呼ばない",
      r.outcome === "forbidden" && texts(w).join("|") === OBI_REJECT_MESSAGES.forbidden && w.portal.length === 0 && w.fixCalled === 0,
      JSON.stringify(texts(w)),
    );
    ok(
      "許可されていない人：印は message.id ごと（NX・8日）",
      w.kv.length === 1 && w.kv[0].join() === `setNx,obi-fix-forbidden:${MSG},${TTL}`,
      JSON.stringify(w.kv),
    );
    const again = await runObiReject(input(w, { allowed: false }), target(choose(1)), deps(w));
    ok("許可されていない人：同じ発言がもう一度来ても、断りは1回だけ", again.outcome === "forbidden" && w.replies.length === 1 && w.portal.length === 0);
  }
  for (const [name, plan] of [["OK", APPROVE], ["9", RECHOOSE], ["できない状態の 9", null]] as Array<[string, ChoicePlan | null]>) {
    const w = world();
    const r = await runObiReject(input(w, { allowed: false }), target(plan), deps(w));
    ok(`許可されていない人の ${name}：同じ断り。portal は呼ばない`, r.outcome === "forbidden" && texts(w).join("|") === OBI_REJECT_MESSAGES.forbidden && w.portal.length === 0);
  }

  // ══ 「#J4 9」で確認待ちでない（plan が null） ══
  {
    const w = world();
    const r = await runObiReject(input(w), target(null), deps(w));
    ok(
      "plan が無い：「いまその操作ができない状態です」を1回。portal は呼ばない",
      r.outcome === "refused" && texts(w).join("|") === OBI_REJECT_MESSAGES.unavailable(4) && w.portal.length === 0 && w.fixCalled === 0 && w.committed === 0,
      JSON.stringify(texts(w)),
    );
  }

  // ══ 受け付けた ══
  for (const [name, plan, body, text, outcome] of [
    ["1（帯だけ）", choose(1), { result: "queued", choice: 1 }, OBI_REJECT_MESSAGES.queuedBandOnly(4), "queued"],
    ["2（AI）", choose(2), { result: "queued", choice: 2 }, OBI_REJECT_MESSAGES.queuedAi(4), "queued"],
    ["3（担当）", choose(3), { result: "human", choice: 3, round: 0, choiceGen: 40 }, OBI_REJECT_MESSAGES.human(4), "human"],
    ["4（取り消す）", choose(4), { result: "canceled", choice: 4, round: 0, choiceGen: 40 }, OBI_REJECT_MESSAGES.canceled(4), "canceled"],
    ["OK", APPROVE, { result: "approved", choice: 0 }, OBI_REJECT_MESSAGES.approved(4), "approved"],
    ["9", RECHOOSE, { result: "reopened", choice: 0, choiceGen: 42 }, OBI_REJECT_MESSAGES.reopened(4), "reopened"],
  ] as Array<[string, ChoicePlan, Record<string, unknown>, string, string]>) {
    const w = world();
    w.reject = () => accepted(body);
    const r = await runObiReject(input(w), target(plan), deps(w));
    ok(`${name}：何をするかを言葉で返す`, r.outcome === outcome && texts(w).join("|") === text && w.pushes.length === 0, JSON.stringify(texts(w)));
    ok(`${name}：portal は /reject を1回だけ（resolve・fix は呼ばない）`, paths(w) === REJECT && w.fixCalled === 1 && w.committed === 1, paths(w));
  }
  {
    const w = world();
    await runObiReject(input(w), target(choose(1, 40)), deps(w));
    const b = w.portal[0].body;
    ok(
      "choose：本文は約束の6項目（messageId＝発言の id・expectGen＝plan の世代。expectSha256・発言者の項目は無い）",
      Object.keys(b).sort().join() === "action,choice,expectGen,groupId,messageId,source" &&
        b.messageId === MSG && b.source === "line-group" && b.groupId === G && b.action === "choose" && b.choice === 1 && b.expectGen === 40,
      JSON.stringify(b),
    );
    ok("返事の印は message.id ごと（NX・8日）", w.kv.length === 1 && w.kv[0].join() === `setNx,obi-fix-replied:${MSG},${TTL}`, JSON.stringify(w.kv));
  }
  {
    const w = world();
    w.reject = () => accepted({ result: "approved", choice: 0 });
    await runObiReject(input(w), target(APPROVE), deps(w));
    const b = w.portal[0].body;
    ok(
      "approve：本文は約束の6項目（expectGen・expectSha256 は plan のもの。choice は無い）",
      Object.keys(b).sort().join() === "action,expectGen,expectSha256,groupId,messageId,source" && b.action === "approve" && b.expectGen === 41 && b.expectSha256 === SHA,
      JSON.stringify(b),
    );
  }
  {
    // 同じ返信の再送（created: false）：1通目と同じ文。返事の印が残っていれば、もう一度は返さない
    const w = world();
    w.reject = () => json(200, { no: 4, created: false, result: "queued", choice: 1, round: 1, choiceGen: 41 });
    const r = await runObiReject(input(w), target(choose(1)), deps(w));
    ok("同じ返信の再送（200・created: false）：1通目と同じ文", r.outcome === "queued" && texts(w).join("|") === OBI_REJECT_MESSAGES.queuedBandOnly(4));
    const again = await runObiReject(input(w), target(choose(1)), deps(w));
    ok("同じ発言をもう一度扱っても、返事は1回だけ（印が残っている）", again.outcome === "queued" && w.replies.length === 1 && w.portal.length === 2);
  }
  {
    // reply をはっきり断られた（期限切れなど）：push に回す。宛先は営業部のグループ
    const w = world();
    w.replyOutcome = { kind: "rejected", status: 400 };
    await runObiReject(input(w), target(choose(1)), deps(w));
    ok(
      "reply を断られたら push（営業部のグループへ・同じ文）",
      w.pushes.length === 1 && w.pushes[0].to === G && w.pushes[0].text === OBI_REJECT_MESSAGES.queuedBandOnly(4),
      JSON.stringify(w.pushes),
    );
  }
  {
    // reply の結果が分からない：送り直さない（二重の返事を避ける）
    const w = world();
    w.replyOutcome = { kind: "unknown" };
    const r = await runObiReject(input(w), target(choose(1)), deps(w));
    ok("reply の結果が分からない：push に回さない。受付は済んでいる", r.outcome === "queued" && w.pushes.length === 0 && w.committed === 1);
  }
  {
    // 返事の印を置けない（KV の障害）：返事は出さない。受付は済んでいる（例外は投げない）
    const w = world();
    w.store.setNx = async () => {
      throw new Error(`boom obi-fix-replied:${MSG}`);
    };
    const r = await runObiReject(input(w), target(choose(1)), deps(w));
    ok("返事の印を置けない：返事は出さない（例外にしない）", r.outcome === "queued" && w.replies.length === 0 && w.pushes.length === 0 && w.committed === 1);
  }

  // ══ portal がはっきり断った（設計 E14 の表） ══
  ok(
    "文：断り（古い知らせ・受付を止めている・出していない番号・OK が通らない）",
    OBI_REJECT_MESSAGES.stale === "その知らせは古くなっています。新しい知らせに返信してください" &&
      OBI_REJECT_MESSAGES.disabled === "いま受付を止めています。portal の依頼ボックスを確認してください" &&
      OBI_REJECT_MESSAGES.notOffered(4, [1, 3, 4]) === "#J4 で選べるのは 1・3・4 です" &&
      OBI_REJECT_MESSAGES.gateFailed(4) === "#J4 は LINE では完成にできません。担当が確認します",
  );
  for (const [name, plan, status, body, text] of [
    ["CHOICE_DISABLED（スイッチ off・切った後の再送。U2）", choose(1), 503, { code: "CHOICE_DISABLED" }, OBI_REJECT_MESSAGES.disabled],
    ["CHOICE_STALE", choose(1), 409, { code: "CHOICE_STALE" }, OBI_REJECT_MESSAGES.stale],
    ["CHOICE_UNAVAILABLE", APPROVE, 409, { code: "CHOICE_UNAVAILABLE" }, OBI_REJECT_MESSAGES.unavailable(4)],
    // 確認待ちでない「#J4 9」を portal に確かめたとき（V7）：受付を止めていれば固定の文、そうでなければ「いまその操作ができない状態です」
    ["CHOICE_DISABLED（「9」。選択肢のスイッチが off）", RECHOOSE, 503, { code: "CHOICE_DISABLED" }, OBI_REJECT_MESSAGES.disabled],
    ["CHOICE_UNAVAILABLE（「9」。確認待ちでない）", RECHOOSE, 409, { code: "CHOICE_UNAVAILABLE" }, OBI_REJECT_MESSAGES.unavailable(4)],
    ["CHOICE_NOT_OFFERED", choose(2), 409, { code: "CHOICE_NOT_OFFERED", choices: [1, 3, 4] }, "#J4 で選べるのは 1・3・4 です"],
    ["CHOICE_NOT_OFFERED（番号が1つ）", choose(2), 409, { code: "CHOICE_NOT_OFFERED", choices: [3] }, "#J4 で選べるのは 3 です"],
    ["CHOICE_NOT_OFFERED（番号が付いていない）", choose(2), 409, { code: "CHOICE_NOT_OFFERED" }, OBI_REJECT_MESSAGES.unavailable(4)],
    ["CHOICE_NOT_OFFERED（番号が空）", choose(2), 409, { code: "CHOICE_NOT_OFFERED", choices: [] }, OBI_REJECT_MESSAGES.unavailable(4)],
    ["GATE_FAILED（residue）", APPROVE, 409, { code: "GATE_FAILED", reason: "residue" }, OBI_REJECT_MESSAGES.gateFailed(4)],
    ["GATE_FAILED（needs_review）", APPROVE, 409, { code: "GATE_FAILED", reason: "needs_review" }, OBI_REJECT_MESSAGES.gateFailed(4)],
    ["GATE_FAILED（理由なし）", APPROVE, 409, { code: "GATE_FAILED" }, OBI_REJECT_MESSAGES.gateFailed(4)],
    ["OBI_BUSY（番号つき）", choose(1), 409, { code: "OBI_BUSY", busyJobNo: 11 }, OBI_MESSAGES.busy(11)],
    ["OBI_BUSY（番号なし）", choose(1), 409, { code: "OBI_BUSY" }, OBI_MESSAGES.busy()],
    ["INTAKE_STOPPED", choose(1), 503, { code: "INTAKE_STOPPED" }, OBI_MESSAGES.stopped],
    ["NOT_FOUND", choose(1), 404, { code: "NOT_FOUND" }, OBI_FIX_MESSAGES.notFound(4)],
    ["CHOICE_MISMATCH", choose(1), 409, { code: "CHOICE_MISMATCH" }, OBI_REJECT_MESSAGES.rejected("CHOICE_MISMATCH")],
    ["INVALID_REQUEST", choose(1), 400, { code: "INVALID_REQUEST" }, OBI_REJECT_MESSAGES.rejected("INVALID_REQUEST")],
    ["UNAUTHORIZED", choose(1), 401, { code: "UNAUTHORIZED" }, OBI_REJECT_MESSAGES.rejected("UNAUTHORIZED")],
  ] as Array<[string, ChoicePlan, number, Record<string, unknown>, string]>) {
    const w = world();
    w.reject = () => json(status, { message: "x", ...body });
    const r = await runObiReject(input(w), target(plan), deps(w));
    ok(`断り ${name}：決まった文を1回`, r.outcome === "refused" && texts(w).join("|") === text, JSON.stringify(texts(w)));
    ok(`断り ${name}：/reject は1回だけ・はっきりした答えなので済み（結果不明にしない）`, paths(w) === REJECT && w.committed === 1 && !w.kv.some((k) => k[1].startsWith("obi-fix-pending-notified:")));
  }
  {
    // code は portal の本文から来る：返事にもログにも、整えてから出す（改行・見えない文字を除く）
    const w = world();
    w.reject = () => json(409, { code: "BAD\nCODE\u200b" + "X".repeat(80) });
    await runObiReject(input(w), target(choose(1)), deps(w));
    ok("知らない code：改行を除き、長さを切った形で返す", texts(w).length === 1 && !texts(w)[0].includes("\n") && texts(w)[0].length < 90, JSON.stringify(texts(w)));
  }
  {
    const w = world();
    w.reject = () => json(409, { code: "GATE_FAILED", reason: "residue" });
    const from = logged.length;
    await runObiReject(input(w), target(APPROVE), deps(w));
    ok("GATE_FAILED：理由の符号はログにだけ出る（文には出さない）", logged.slice(from).some((l) => l.includes("GATE_FAILED:residue")) && !texts(w)[0].includes("residue"), JSON.stringify(logged.slice(from)));
  }

  // ══ 時間の予算（「番号で直す」と同じ：開始+17秒までに /reject と返事の印。/reject は最大8秒・最小2秒） ══
  ok(
    "文：届かない・結果不明（「もう一度送ってください」と書くのは、送っていないことが確かなときだけ）",
    OBI_REJECT_MESSAGES.unreachable === "対応を受け付けられませんでした（portal に届きません）。少し待ってからもう一度送ってください" &&
      OBI_REJECT_MESSAGES.unknown ===
        "受付の結果を確かめられませんでした。届く知らせか portal の依頼ボックスで確かめてください。同じ返信をもう一度送らないでください" &&
      !OBI_REJECT_MESSAGES.unknown.includes("もう一度送ってください"),
  );
  for (const [elapsed, expected] of [[0, 8000], [6_000, 8000], [10_000, 6000], [14_000, 2000]] as Array<[number, number]>) {
    const w = world();
    w.clock.t = T + elapsed;
    signalTimeouts.length = 0;
    await runObiReject(input(w), target(choose(1)), deps(w));
    ok(`開始から${elapsed}ms：/reject の時間の上限は${expected}ms`, signalTimeouts.join() === String(expected) && paths(w) === REJECT, signalTimeouts.join());
  }
  {
    const w = world();
    w.clock.t = T + 14_001; // 残り 1999ms（2秒に満たない）
    const r = await runObiReject(input(w), target(choose(1)), deps(w));
    ok(
      "残りが2秒に満たない：/reject を呼ばず「…portal に届きません。少し待ってからもう一度送ってください」",
      r.outcome === "refused" && w.portal.length === 0 && w.fixCalled === 0 && texts(w).join("|") === OBI_REJECT_MESSAGES.unreachable,
      JSON.stringify(texts(w)),
    );
  }
  {
    const w = world();
    await runObiReject(input(w), target(choose(1)), deps(w));
    ok("reply の時間の上限は4秒", w.replies[0].timeoutMs === 4000);
    const w2 = world();
    w2.replyOutcome = { kind: "rejected", status: 400 };
    await runObiReject(input(w2), target(choose(1)), deps(w2));
    ok("push の時間の上限は4秒", w2.pushes[0].timeoutMs === 4000);
  }

  // ══ 結果不明（/reject を呼んだ後、はっきりした答えが無い） ══
  for (const [name, setup] of [
    ["時間切れ", (w: World) => { w.rejectTakesMs = 9_000; }],
    ["500", (w: World) => { w.reject = () => json(500, { code: "INTERNAL" }); }],
    ["知らない 503", (w: World) => { w.reject = () => json(503, { code: "OTHER" }); }],
    ["成功の番号で JSON でない", (w: World) => { w.reject = () => new Response("<html>", { status: 201 }); }],
    ["成功の番号で result が知らない値", (w: World) => { w.reject = () => accepted({ result: "done" }); }],
    ["途中で切れた（ECONNRESET）", (w: World) => { w.reject = () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); }; }],
    ["送った番号と違う番号の答え", (w: World) => { w.reject = () => accepted({ choice: 2 }); }],
    ["選択（1）なのに approved の答え", (w: World) => { w.reject = () => accepted({ result: "approved" }); }],
    ["選択（1）なのに human の答え", (w: World) => { w.reject = () => accepted({ result: "human" }); }],
    ["違う受付番号の答え", (w: World) => { w.reject = () => accepted({ no: 5 }); }],
  ] as Array<[string, (w: World) => void]>) {
    const w = world();
    setup(w);
    const r = await runObiReject(input(w), target(choose(1)), deps(w));
    ok(
      `結果不明（${name}）：「受付の結果を確かめられませんでした…」を1回。受け付けたとも断ったとも言わない`,
      r.outcome === "unknown" && texts(w).join("|") === OBI_REJECT_MESSAGES.unknown && w.fixCalled === 1 && w.committed === 0,
      JSON.stringify(texts(w)),
    );
    ok(
      `結果不明（${name}）：印は obi-fix-pending-notified（NX・8日）。/reject は呼び直さない`,
      w.kv.length === 1 && w.kv[0].join() === `setNx,obi-fix-pending-notified:${MSG},${TTL}` && paths(w) === REJECT,
      JSON.stringify(w.kv),
    );
    const again = await runObiReject(input(w), target(choose(1)), deps(w));
    ok(`結果不明（${name}）：同じ発言をもう一度扱っても、知らせは1回だけ`, again.outcome === "unknown" && w.replies.length === 1);
  }
  for (const [plan, body] of [
    [APPROVE, { result: "queued", choice: 0 }],
    [RECHOOSE, { result: "approved", choice: 0 }],
    [choose(3), { result: "queued", choice: 3 }],
    [choose(4), { result: "human", choice: 4 }],
  ] as Array<[ChoicePlan, Record<string, unknown>]>) {
    const w = world();
    w.reject = () => accepted(body);
    const r = await runObiReject(input(w), target(plan), deps(w));
    ok(`送った中身（${plan.action} ${plan.choice}）と合わない答え（${body.result}）：結果不明`, r.outcome === "unknown" && texts(w).join("|") === OBI_REJECT_MESSAGES.unknown);
  }

  // ══ 送っていないことが確か（つなぐ前の失敗）：結果不明にしない ══
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
    const w = world();
    w.reject = () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code } });
    };
    const r = await runObiReject(input(w), target(APPROVE), deps(w));
    ok(
      `${code}：「…portal に届きません。少し待ってからもう一度送ってください」（結果不明の文にしない）`,
      r.outcome === "refused" && texts(w).join("|") === OBI_REJECT_MESSAGES.unreachable && w.committed === 1 &&
        w.kv.length === 1 && w.kv[0][1] === `obi-fix-replied:${MSG}`,
      JSON.stringify(texts(w)),
    );
  }

  // ══ 例外で止まったときの返事（呼ぶのは webhook-event.ts） ══
  {
    const w = world();
    await replyObiRejectInterrupted(input(w), "before-call", deps(w));
    ok(
      "例外（/reject を呼ぶ前）：「…portal に届きません…」を1回（obi-fix-replied）",
      texts(w).join("|") === OBI_REJECT_MESSAGES.unreachable && w.kv[0].join() === `setNx,obi-fix-replied:${MSG},${TTL}`,
    );
    const w2 = world();
    await replyObiRejectInterrupted(input(w2), "called", deps(w2));
    ok(
      "例外（/reject を呼んだ後）：結果不明と同じ文を1回（obi-fix-pending-notified）",
      texts(w2).join("|") === OBI_REJECT_MESSAGES.unknown && w2.kv[0].join() === `setNx,obi-fix-pending-notified:${MSG},${TTL}`,
    );
    const w3 = world();
    const d3 = deps(w3);
    d3.reply = async () => {
      throw new Error(`crash ${MSG}`);
    };
    let threw = false;
    try {
      await replyObiRejectInterrupted(input(w3), "called", d3);
    } catch {
      threw = true;
    }
    ok("例外の後の返事が出せなくても、外へ投げない", !threw);
  }

  // ══ ログ ══
  // テスト自身の ✅・❌ の行は除く（確かめたいのは、作りの側が出したログ）
  const logs = logged.filter((l) => !l.startsWith("✅") && !l.startsWith("❌"));
  ok(
    "ログに message.id・groupId・sha256 を出していない",
    logs.length > 0 && !logs.some((l) => l.includes(MSG) || l.includes(G) || l.includes(SHA)),
    JSON.stringify(logs.filter((l) => l.includes(MSG) || l.includes(G) || l.includes(SHA))),
  );
  ok("ログに受付番号・action・番号・結果が出ている", logs.some((l) => l.includes("帯替えの対応の選択:") && l.includes("#J4") && l.includes("action=choose") && l.includes("choice=1") && l.includes("queued")));

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
