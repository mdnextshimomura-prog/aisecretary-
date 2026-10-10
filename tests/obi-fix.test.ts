/**
 * 「番号で直す」の中身（対象の特定 locateObiFix・認可〜返事 runObiFix）を、偽物の KV・portal・LINE で確かめる
 * （設計 2026-10-10 の E11・E12・「文」・「うまくいかないとき」）。
 */
import {
  locateObiFix,
  runObiFix,
  replyObiFixStopped,
  OBI_FIX_MESSAGES,
  type FixTarget,
  type ObiFixDeps,
  type ObiFixInput,
  type ObiFixStageHooks,
} from "../src/lib/obi/fix";
import { parseFixBody } from "../src/lib/obi/fix-parse";
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
const QUOTED = "600000000000000150";
const config: ObiConfig = {
  groupId: G,
  allowedUserIds: ["U" + "b".repeat(32)],
  portalBaseUrl: "https://portal.example.test",
  jobApiToken: "tok",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const timeoutError = () => new DOMException("timed out", "TimeoutError");

// portal の呼び出しに付けた時間の上限（AbortSignal.timeout の引数）を控える
const signalTimeouts: number[] = [];
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms: number) => {
  signalTimeouts.push(ms);
  return realTimeout(ms);
};

const RESOLVED = {
  no: 12,
  artifactSha256: SHA,
  current: true,
  pageCount: 5,
  fixable: "ok",
  closable: "ok",
  fixState: "",
  fixRound: 0,
};
const fixed = (over: Record<string, unknown> = {}) =>
  json(201, {
    no: 12,
    fixId: 7,
    created: true,
    result: "queued",
    code: 2,
    page: 3,
    turn: "",
    round: 1,
    reason: "",
    ...over,
  });

interface World {
  clock: { t: number };
  startedAt: number;
  store: ObiStore;
  kv: Array<[string, string, (string | number)?]>; // [操作, かぎ, 値や期限]
  portal: Array<{ path: string; body: Record<string, unknown> }>;
  resolve: () => Response;
  fix: () => Response;
  resolveTakesMs: number;
  fixTakesMs: number;
  replies: Array<{ text: string; timeoutMs: number }>;
  pushes: Array<{ to: string; text: string; timeoutMs: number }>;
  replyOutcome: ReplyOutcome;
  pushOutcome: { ok: boolean; messageId: string | null };
  replyTakesMs: number;
  pushTakesMs: number;
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
  };
  return {
    clock,
    startedAt: T,
    store,
    kv,
    portal: [],
    resolve: () => json(200, RESOLVED),
    fix: () => fixed(),
    resolveTakesMs: 0,
    fixTakesMs: 0,
    replies: [],
    pushes: [],
    replyOutcome: { kind: "sent", messageId: "700000000000000001" },
    pushOutcome: { ok: true, messageId: "700000000000000002" },
    replyTakesMs: 0,
    pushTakesMs: 0,
    fixCalled: 0,
    committed: 0,
  };
}

function deps(w: World): ObiFixDeps & ObiFixStageHooks {
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const u = String(url);
    const path = u.replace("https://portal.example.test", "");
    if (path === u) throw new Error(`想定外の宛先: ${u}`);
    if (new Headers(init?.headers).get("x-job-token") !== "tok")
      throw new Error("鍵が無い");
    w.portal.push({ path, body: JSON.parse(String(init?.body)) });
    // 呼び出しに付いた時間の上限（直前の AbortSignal.timeout）より長くかかるなら、上限で時間切れにする
    const cap = signalTimeouts[signalTimeouts.length - 1] ?? Infinity;
    const slow = (takesMs: number) => {
      w.clock.t += Math.min(takesMs, cap);
      if (takesMs > cap) throw timeoutError();
    };
    if (path === "/api/jobs/fix/resolve") {
      slow(w.resolveTakesMs);
      return w.resolve();
    }
    if (/^\/api\/jobs\/\d+\/fix$/.test(path)) {
      slow(w.fixTakesMs);
      return w.fix();
    }
    throw new Error(`想定外の宛先: ${u}`);
  }) as typeof fetch;
  return {
    store: w.store,
    fetchImpl,
    now: () => w.clock.t,
    reply: async (text, timeoutMs) => {
      w.replies.push({ text, timeoutMs });
      w.clock.t += Math.min(w.replyTakesMs, timeoutMs);
      return w.replyTakesMs > timeoutMs ? { kind: "unknown" } : w.replyOutcome;
    },
    push: async (to, text, timeoutMs) => {
      w.pushes.push({ to, text, timeoutMs });
      w.clock.t += Math.min(w.pushTakesMs, timeoutMs);
      return w.pushTakesMs > timeoutMs
        ? { ok: false, messageId: null }
        : w.pushOutcome;
    },
    onFixCalled: () => {
      w.fixCalled++;
    },
    onCommitted: () => {
      w.committed++;
    },
  };
}

const input = (
  w: World,
  text: string,
  over: Partial<ObiFixInput> = {},
): ObiFixInput => ({
  messageId: MSG,
  body: parseFixBody(text)!,
  quotedMessageId: null,
  allowed: true,
  startedAt: w.startedAt,
  config,
  ...over,
});
type Target = Extract<FixTarget, { kind: "target" }>;
const byNumber: Target = {
  kind: "target",
  via: "number",
  no: 12,
  resolved: null,
};
const texts = (w: World) => w.replies.map((r) => r.text);
const paths = (w: World) => w.portal.map((p) => p.path).join();
const RESOLVE = "/api/jobs/fix/resolve";
const FIX = "/api/jobs/12/fix";

async function main() {
  // ══ 対象の特定（locateObiFix） ══
  {
    const w = world();
    const t = await locateObiFix(
      input(w, "#J12 2", { allowed: false }),
      deps(w),
    );
    ok(
      "#J つき：その番号が対象（portal も KV も呼ばない）",
      t.kind === "target" &&
        t.via === "number" &&
        t.no === 12 &&
        t.resolved === null &&
        w.portal.length === 0 &&
        w.kv.length === 0,
      JSON.stringify(t),
    );
  }
  {
    const w = world();
    const t = await locateObiFix(input(w, "3ページ 2"), deps(w));
    ok(
      "#J なし・引用なし：訂正として扱わない（何も呼ばない）",
      t.kind === "rest" && w.portal.length === 0 && w.kv.length === 0,
    );
    const t2 = await locateObiFix(
      input(w, "3ページ 2", { quotedMessageId: "abc" }),
      deps(w),
    );
    ok(
      "引用先の ID が数字でない：訂正として扱わない",
      t2.kind === "rest" && w.portal.length === 0,
    );
  }
  {
    const w = world();
    signalTimeouts.length = 0;
    const t = await locateObiFix(
      input(w, "3ページ 2", { quotedMessageId: QUOTED, allowed: false }),
      deps(w),
    );
    ok(
      "完成の知らせへの引用：portal の resolve で引けたら対象（認可はまだ見ない）",
      t.kind === "target" &&
        t.via === "notice" &&
        t.no === 12 &&
        t.resolved?.artifactSha256 === SHA,
      JSON.stringify(t),
    );
    ok(
      "引用の resolve：先に聞き返しの控えを見てから、portal を1回",
      JSON.stringify(w.kv) ===
        JSON.stringify([["getText", `obi-fix-askmsg:${QUOTED}`]]) &&
        paths(w) === RESOLVE,
    );
    ok(
      "引用の resolve の本文：source・groupId・quotedMessageId だけ",
      JSON.stringify(w.portal[0].body) ===
        JSON.stringify({
          source: "line-group",
          groupId: G,
          quotedMessageId: QUOTED,
        }),
      JSON.stringify(w.portal[0].body),
    );
    ok(
      "resolve の時間の上限は6秒",
      signalTimeouts.join() === "6000",
      signalTimeouts.join(),
    );
  }
  // 引用先の知らせの種類（約束の P1・P4）：完成の知らせ（"completion"・項目なし）だけが「番号で直す」
  for (const kind of ["completion", undefined]) {
    const w = world();
    w.resolve = () =>
      json(200, { ...RESOLVED, ...(kind ? { kind, phase: "fix" } : {}) });
    const t = await locateObiFix(
      input(w, "3ページ 2", { quotedMessageId: QUOTED }),
      deps(w),
    );
    ok(
      `引用先の種類が ${kind ?? "項目なし"}：完成の知らせとして扱う`,
      t.kind === "target" && t.via === "notice" && t.no === 12,
      JSON.stringify(t),
    );
  }
  for (const kind of ["reject", "review", "something-new"]) {
    const w = world();
    w.resolve = () => json(200, { ...RESOLVED, kind, phase: "choose" });
    const t = await locateObiFix(
      input(w, "2", { quotedMessageId: QUOTED }),
      deps(w),
    );
    ok(
      `引用先の種類が ${kind}（完成の知らせではない）：訂正として扱わない（返事をせず今までの流れへ）`,
      t.kind === "rest" &&
        t.reason === "notice-kind" &&
        w.replies.length === 0 &&
        w.pushes.length === 0 &&
        paths(w) === RESOLVE &&
        !w.kv.some((k) => k[0] !== "getText"),
      JSON.stringify(t),
    );
  }
  {
    const w = world();
    await w.store.putText(`obi-fix-askmsg:${QUOTED}`, "J34", TTL);
    w.kv.length = 0;
    const t = await locateObiFix(
      input(w, "3ページ 2", { quotedMessageId: QUOTED }),
      deps(w),
    );
    ok(
      "聞き返しへの引用：KV の控えから受付番号（portal は呼ばない）",
      t.kind === "target" &&
        t.via === "ask" &&
        t.no === 34 &&
        t.resolved === null &&
        w.portal.length === 0,
      JSON.stringify(t),
    );
  }
  {
    const w = world();
    w.resolve = () => json(404, { code: "NOT_FOUND", message: "x" });
    const t = await locateObiFix(
      input(w, "2", { quotedMessageId: QUOTED }),
      deps(w),
    );
    ok(
      "引用先が帯替えの知らせでない（NOT_FOUND）：訂正として扱わない・返事なし",
      t.kind === "rest" && t.reason === "NOT_FOUND" && w.replies.length === 0,
    );
    w.resolve = () => json(503, { code: "FIX_DISABLED", message: "x" });
    const t2 = await locateObiFix(
      input(w, "2", { quotedMessageId: QUOTED }),
      deps(w),
    );
    ok(
      "引用の resolve が NOT_FOUND 以外のはっきりした断り（FIX_DISABLED）：訂正として扱わない（返事なし。Z11）",
      t2.kind === "rest" && t2.reason === "FIX_DISABLED" && w.replies.length === 0,
    );
  }
  for (const [name, answer] of [
    [
      "時間切れ",
      () => {
        throw timeoutError();
      },
    ],
    ["5xx", () => json(500, { code: "INTERNAL" })],
    [
      "つながらない",
      () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNREFUSED" },
        });
      },
    ],
    ["200 だが中身が読めない", () => json(200, { no: 12 })],
  ] as Array<[string, () => Response]>) {
    const w = world();
    w.resolve = answer;
    const i = input(w, "2", { quotedMessageId: QUOTED });
    const t1 = await locateObiFix(i, deps(w));
    ok(
      `引用先を確かめられない（${name}）：初回から今までの流れへ渡す（返事をしない。Z3）`,
      t1.kind === "rest" &&
        t1.reason === "resolve-unknown" &&
        w.replies.length === 0 &&
        w.pushes.length === 0,
      JSON.stringify(t1),
    );
    ok(
      `引用先を確かめられない（${name}）：KV に何も置かない（回数を数えない）・portal は1回だけ（呼び直さない）`,
      JSON.stringify(w.kv) ===
        JSON.stringify([["getText", `obi-fix-askmsg:${QUOTED}`]]) &&
        w.portal.length === 1,
      JSON.stringify(w.kv),
    );
  }
  {
    const w = world();
    w.store = {
      ...w.store,
      getText: async () => {
        throw new Error("KV down");
      },
    };
    const t = await locateObiFix(
      input(w, "2", { quotedMessageId: QUOTED }),
      deps(w),
    );
    ok(
      "聞き返しの控えを読めない：resolve が不明のときと同じ（portal は呼ばず、今までの流れへ）",
      t.kind === "rest" &&
        t.reason === "resolve-unknown" &&
        w.portal.length === 0 &&
        w.replies.length === 0,
    );
  }
  {
    const w = world();
    w.store = {
      ...w.store,
      getText: () => new Promise<string | null>(() => undefined),
    };
    const t = await locateObiFix(input(w, "2", { quotedMessageId: QUOTED }), {
      ...deps(w),
      kvTimeoutMs: 20,
    });
    ok(
      "聞き返しの控えが返ってこない：上限で打ち切って今までの流れへ",
      t.kind === "rest" && w.portal.length === 0,
    );
  }
  {
    const w = world();
    await replyObiFixStopped(
      { messageId: MSG, groupId: G, startedAt: w.startedAt },
      deps(w),
    );
    await replyObiFixStopped(
      { messageId: MSG, groupId: G, startedAt: w.startedAt },
      deps(w),
    );
    ok(
      "設定が足りないときの返事：「止めています」を1通につき1回（portal は呼ばない）",
      texts(w).join("|") === OBI_MESSAGES.stopped &&
        w.portal.length === 0 &&
        JSON.stringify(w.kv[0]) ===
          JSON.stringify(["setNx", `obi-fix-replied:${MSG}`, TTL]),
    );
  }

  // ══ 認可 → resolve → fix → 返事（runObiFix） ══
  // ── 認可 ──
  for (const text of ["#J12 3ページ 2", "#J12 0"]) {
    const w = world();
    const r = await runObiFix(
      input(w, text, { allowed: false }),
      byNumber,
      deps(w),
    );
    ok(
      `許可されていない人（${text}）：portal を1回も呼ばずに断る`,
      r.outcome === "forbidden" &&
        w.portal.length === 0 &&
        texts(w).join("|") === OBI_MESSAGES.fixForbidden,
      JSON.stringify(texts(w)),
    );
    ok(
      `許可されていない人（${text}）：断りの印は message.id ごと・8日`,
      JSON.stringify(w.kv) ===
        JSON.stringify([["setNx", `obi-fix-forbidden:${MSG}`, TTL]]),
      JSON.stringify(w.kv),
    );
    await runObiFix(input(w, text, { allowed: false }), byNumber, deps(w));
    ok(
      `許可されていない人（${text}）：同じ発言の再送では返さない`,
      w.replies.length === 1 && w.committed === 0,
    );
    await runObiFix(
      input(w, text, { allowed: false, messageId: "600000000000000201" }),
      byNumber,
      deps(w),
    );
    ok(
      `許可されていない人（${text}）：別の発言にはもう一度返す`,
      w.replies.length === 2,
    );
  }
  ok(
    "断りの文に個人名を入れない",
    !OBI_MESSAGES.fixForbidden.includes("下村") &&
      OBI_MESSAGES.fixForbidden ===
        "直しの依頼は、帯替えを依頼できる方からお願いします",
  );
  ok(
    "既存の帯替えの依頼の断りは変えていない",
    OBI_MESSAGES.forbidden === "帯替えの依頼は下村さんからお願いします",
  );
  {
    const w = world();
    const notice: Target = {
      kind: "target",
      via: "notice",
      no: 12,
      resolved: {
        no: 12,
        artifactSha256: SHA,
        current: true,
        pageCount: 5,
        fixable: "ok",
        closable: "ok",
        kind: "completion",
        phase: "fix",
      },
    };
    const r = await runObiFix(
      input(w, "3ページ 2", { allowed: false, quotedMessageId: QUOTED }),
      notice,
      deps(w),
    );
    ok(
      "許可されていない人（完成の知らせへの引用）：fix は呼ばずに断る",
      r.outcome === "forbidden" &&
        w.portal.length === 0 &&
        texts(w).join() === OBI_MESSAGES.fixForbidden,
    );
  }

  // ── 受け付けた結果 → 文 ──
  const M = OBI_FIX_MESSAGES;
  const accepted: Array<[string, Record<string, unknown>, string]> = [
    [
      "#J12 0",
      { result: "closed", code: 0, page: null, round: 0 },
      "ありがとうございます。#J12 を完了にしました",
    ],
    [
      "#J12 3ページ 1",
      { code: 1 },
      "#J12 の直しを受け付けました（3ページ・帯の位置）。直せたら、ここに新しいリンクを出します",
    ],
    [
      "#J12 3ページ 2",
      {},
      "#J12 の直しを受け付けました（3ページ・他社の文字）。直せたら、ここに新しいリンクを出します",
    ],
    [
      "#J12 4ページ 3",
      { code: 3, page: 4 },
      "#J12 の直しを受け付けました（4ページ・向き）。逆さ（180度）として直します。右に90度なら「4ページ 3右」、左に90度なら「4ページ 3左」と返信してください",
    ],
    [
      "#J12 3ページ 3右",
      { code: 3, turn: "right" },
      "#J12 の直しを受け付けました（3ページ・向き）。直せたら、ここに新しいリンクを出します",
    ],
    [
      "#J12 3ページ 3左",
      { code: 3, turn: "left" },
      "#J12 の直しを受け付けました（3ページ・向き）。直せたら、ここに新しいリンクを出します",
    ],
    [
      "#J12 3ページ 4",
      { result: "human", reason: "manual-code", code: 4, round: 0 },
      "#J12 担当が確認します（3ページ・順番）",
    ],
    [
      "#J12 4",
      { result: "human", reason: "manual-code", code: 4, page: null, round: 0 },
      "#J12 担当が確認します（順番）",
    ],
    [
      "#J12 5",
      { result: "human", reason: "manual-code", code: 5, page: null, round: 0 },
      "#J12 担当が確認します（その他）",
    ],
    [
      "#J12 3ページ 2",
      { result: "human", reason: "limit" },
      "#J12 は自動の直しが3回になりました。担当が確認します",
    ],
    [
      "#J12 3ページ 1",
      { result: "human", reason: "repeat", code: 1 },
      "#J12 の3ページは帯の位置を一度直しています。担当が確認します",
    ],
    [
      "#J12 3ページ 1",
      { result: "human", reason: "already-standard", code: 1 },
      "#J12 の3ページの帯は、すでに標準の位置にあります。担当が確認します",
    ],
    [
      "#J12 3ページ 2",
      { result: "human", reason: "not-auto" },
      "#J12 担当が確認します（3ページ・他社の文字）",
    ],
    [
      "#J12 3ページ 2",
      { result: "human", reason: "no-room" },
      "#J12 担当が確認します（3ページ・他社の文字）",
    ],
    [
      "#J12 3ページ 2",
      { result: "human", reason: "human-pending" },
      "#J12 担当が確認します（3ページ・他社の文字）",
    ],
    [
      "#J12 3ページ 2",
      { result: "human", reason: "知らない理由" },
      "#J12 担当が確認します（3ページ・他社の文字）",
    ],
  ];
  for (const [text, over, want] of accepted) {
    const w = world();
    w.fix = () => fixed(over);
    const r = await runObiFix(input(w, text), byNumber, deps(w));
    ok(
      `受け付けた（${text}／${over.reason ?? over.result ?? "queued"}）：文`,
      texts(w).join("|") === want &&
        r.outcome === (over.result ?? "queued") &&
        w.committed === 1,
      JSON.stringify(texts(w)),
    );
  }
  ok(
    "その場の返事に「直しました」は無い",
    !Object.values(M).some((v) =>
      (typeof v === "string" ? v : "").includes("直しました"),
    ),
  );
  {
    const w = world();
    const r = await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      "#J つき：resolve（番号）→ fix の順に1回ずつ",
      paths(w) === `${RESOLVE},${FIX}` && r.outcome === "queued",
    );
    ok(
      "resolve（番号）の本文：source・groupId・no だけ",
      JSON.stringify(w.portal[0].body) ===
        JSON.stringify({ source: "line-group", groupId: G, no: 12 }),
      JSON.stringify(w.portal[0].body),
    );
    ok(
      "fix の本文：約束の7項目（expectSha256 は resolve の値・冪等のかぎは訂正の発言の ID）",
      JSON.stringify(w.portal[1].body) ===
        JSON.stringify({
          messageId: MSG,
          source: "line-group",
          groupId: G,
          code: 2,
          turn: "",
          expectSha256: SHA,
          page: 3,
        }),
      JSON.stringify(w.portal[1].body),
    );
    ok(
      "返事の印は message.id ごと・8日。reply は訂正の発言へ",
      JSON.stringify(w.kv) ===
        JSON.stringify([["setNx", `obi-fix-replied:${MSG}`, TTL]]) &&
        w.replies.length === 1 &&
        w.pushes.length === 0,
      JSON.stringify(w.kv),
    );
  }
  {
    const w = world();
    const notice: Target = {
      kind: "target",
      via: "notice",
      no: 12,
      resolved: {
        no: 12,
        artifactSha256: "9".repeat(64),
        current: false,
        pageCount: 5,
        fixable: "not-ready",
        closable: "ok",
        kind: "completion",
        phase: "fix",
      },
    };
    const r = await runObiFix(
      input(w, "3ページ 2", { quotedMessageId: QUOTED }),
      notice,
      deps(w),
    );
    ok(
      "完成の知らせへの引用：resolve は呼び直さず、fix を1回（expectSha256 はその知らせの完成品）",
      paths(w) === FIX &&
        w.portal[0].body.expectSha256 === "9".repeat(64) &&
        r.outcome === "queued",
    );
    ok(
      "ページまで揃った訂正は、見込み（fixable・current）に関わらず fix の答えで返事を決める",
      texts(w)[0].startsWith("#J12 の直しを受け付けました"),
    );
  }
  {
    const w = world();
    await runObiFix(input(w, "#J12 0"), byNumber, deps(w));
    ok(
      "0：ページを付けずに送る",
      JSON.stringify(w.portal[1].body) ===
        JSON.stringify({
          messageId: MSG,
          source: "line-group",
          groupId: G,
          code: 0,
          turn: "",
          expectSha256: SHA,
        }),
      JSON.stringify(w.portal[1].body),
    );
  }

  // ── resolve の失敗（#J つき・聞き返しへの引用） ──
  const resolveFails: Array<[string, () => Response, string]> = [
    [
      "NOT_FOUND",
      () => json(404, { code: "NOT_FOUND", message: "x" }),
      "#J12 は見つかりません。番号を確かめてもう一度送ってください",
    ],
    [
      "FIX_DISABLED",
      () => json(503, { code: "FIX_DISABLED", message: "x" }),
      "いま帯替えの受付を止めています",
    ],
    [
      "UNAUTHORIZED",
      () => json(401, { code: "UNAUTHORIZED", message: "x" }),
      "訂正を受け付けられませんでした（UNAUTHORIZED）。担当に声をかけてください",
    ],
    [
      "時間切れ",
      () => {
        throw timeoutError();
      },
      "訂正を受け付けられませんでした（portal に届きません）。少し待ってからもう一度送ってください",
    ],
    [
      "5xx",
      () => json(500, { code: "INTERNAL" }),
      "訂正を受け付けられませんでした（portal に届きません）。少し待ってからもう一度送ってください",
    ],
    [
      "つながらない",
      () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ENOTFOUND" },
        });
      },
      "訂正を受け付けられませんでした（portal に届きません）。少し待ってからもう一度送ってください",
    ],
  ];
  for (const [name, answer, want] of resolveFails) {
    const w = world();
    w.resolve = answer;
    const r = await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      `#J つきで resolve が${name}：fix は呼ばず、文を返して済みにする`,
      paths(w) === RESOLVE &&
        texts(w).join("|") === want &&
        r.outcome === "refused" &&
        w.committed === 0,
      JSON.stringify(texts(w)),
    );
  }

  // ── fix の断り → 文 ──
  const rejections: Array<[number, Record<string, unknown>, string]> = [
    [503, { code: "FIX_DISABLED" }, "いま帯替えの受付を止めています"],
    [503, { code: "INTAKE_STOPPED" }, "いま帯替えの受付を止めています"],
    [
      404,
      { code: "NOT_FOUND" },
      "#J12 は見つかりません。番号を確かめてもう一度送ってください",
    ],
    [
      400,
      { code: "FIX_BAD_PAGE", pageCount: 5 },
      "#J12 に3ページはありません（全部で5ページです）。ページを確かめてもう一度送ってください",
    ],
    [
      400,
      { code: "FIX_BAD_PAGE" },
      "#J12 に3ページはありません。ページを確かめてもう一度送ってください",
    ],
    [
      409,
      { code: "FIX_STALE" },
      "#J12 には新しい完成の知らせがあります。いちばん新しい知らせに返信してください",
    ],
    [
      409,
      { code: "FIX_NOT_READY" },
      "#J12 はいま処理中です。少し待ってからもう一度送ってください",
    ],
    [
      409,
      { code: "FIX_CLOSED" },
      "#J12 は完了にしてあります。直すときは、もう一度依頼してください",
    ],
    [
      410,
      { code: "FIX_EXPIRED" },
      "期限（7日）を過ぎたので直せません。もう一度依頼してください",
    ],
    [
      409,
      { code: "FIX_UNAVAILABLE" },
      "#J12 は番号では直せません。担当に声をかけてください",
    ],
    [
      409,
      { code: "OBI_BUSY", busyJobNo: 11 },
      "前の帯替え（#J11）を処理中です。終わってからもう一度送ってください",
    ],
    [
      409,
      { code: "FIX_MISMATCH" },
      "訂正を受け付けられませんでした（FIX_MISMATCH）。担当に声をかけてください",
    ],
    [
      400,
      { code: "INVALID_REQUEST" },
      "訂正を受け付けられませんでした（INVALID_REQUEST）。担当に声をかけてください",
    ],
    [
      400,
      { code: "改行\nつき" },
      "訂正を受け付けられませんでした（改行 つき）。担当に声をかけてください",
    ],
  ];
  for (const [status, body, want] of rejections) {
    const w = world();
    w.fix = () => json(status, { message: "x", ...body });
    const r = await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      `fix が ${JSON.stringify(body.code)} で断った：文`,
      texts(w).join("|") === want &&
        r.outcome === "refused" &&
        w.committed === 1,
      JSON.stringify(texts(w)),
    );
  }
  {
    const w = world();
    w.fix = () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      });
    };
    const r = await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      "fix につながらない（ECONNREFUSED）：送っていないのが確かなので結果不明にせず「届きません…もう一度送ってください」（AB1）",
      texts(w).join("|") === M.unreachable &&
        r.outcome === "refused" &&
        w.fixCalled === 1 &&
        w.committed === 1 &&
        paths(w) === `${RESOLVE},${FIX}`,
      JSON.stringify(texts(w)),
    );
    ok(
      "fix につながらない：印は返事の印（結果不明の印は置かない）",
      JSON.stringify(w.kv) ===
        JSON.stringify([["setNx", `obi-fix-replied:${MSG}`, TTL]]),
      JSON.stringify(w.kv),
    );
    const r2 = await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      "fix につながらない：同じ発言をもう一度扱っても「届きません」は1通につき1回だけ",
      r2.outcome === "refused" && w.replies.length === 1,
    );
  }
  for (const code of ["ENOTFOUND", "EAI_AGAIN"]) {
    const w = world();
    w.fix = () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code } });
    };
    const r = await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      `fix の ${code} も送る前の失敗が確か：「届きません…もう一度送ってください」（結果不明にしない）`,
      texts(w).join("|") === M.unreachable &&
        r.outcome === "refused" &&
        w.committed === 1,
      JSON.stringify(texts(w)),
    );
  }

  // ── 結果不明（fix を呼んだ後、はっきりした答えが無い。AA1）──
  {
    const w = world();
    w.fix = () => {
      throw timeoutError();
    };
    const r1 = await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      "fix の結果不明：「受付の結果を確かめられませんでした…」を1回返す（やり直しを求めない）",
      r1.outcome === "unknown" &&
        texts(w).join("|") === M.unknown &&
        w.fixCalled === 1 &&
        w.committed === 0,
      JSON.stringify(texts(w)),
    );
    ok(
      "結果不明の文：「もう一度送ってください」とは書かず、「送らないでください」と確かめる先を書く",
      !M.unknown.includes("もう一度送ってください") &&
        M.unknown.includes("同じ番号をもう一度送らないでください") &&
        M.unknown.includes("届く知らせか portal の依頼ボックス"),
    );
    ok(
      "結果不明の印は message.id ごと・8日",
      JSON.stringify(w.kv) ===
        JSON.stringify([["setNx", `obi-fix-pending-notified:${MSG}`, TTL]]),
      JSON.stringify(w.kv),
    );
    ok(
      "結果不明：同じ Webhook の中では呼び直さない（resolve 1回＋fix 1回）",
      paths(w) === `${RESOLVE},${FIX}`,
    );
    const r2 = await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      "同じ発言をもう一度扱っても、結果不明の知らせは1通につき1回だけ",
      r2.outcome === "unknown" && w.replies.length === 1,
    );
  }
  for (const [name, fixImpl] of [
    ["5xx", () => json(500, { code: "INTERNAL" })],
    ["形の違う 200", () => json(200, { no: 12, result: "???" })],
    [
      "理由の分からない通信の失敗",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
    [
      "応答の途中の切断（ECONNRESET）",
      () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNRESET" },
        });
      },
    ],
  ] as Array<[string, () => Response]>) {
    const w = world();
    w.fix = fixImpl;
    const r = await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      `fix の${name}も結果不明：同じ文を1回・呼ぶのは resolve 1回＋fix 1回`,
      r.outcome === "unknown" &&
        texts(w).join("|") === M.unknown &&
        paths(w) === `${RESOLVE},${FIX}` &&
        w.committed === 0,
      JSON.stringify(texts(w)),
    );
  }
  {
    // fix を呼ぶ前に終わるもの（断り・resolve の失敗）は、onFixCalled を呼ばない
    const w = world();
    w.resolve = () => {
      throw timeoutError();
    };
    await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    await runObiFix(
      input(w, "#J12 0", { allowed: false, messageId: "600000000000000201" }),
      byNumber,
      deps(w),
    );
    ok(
      "fix を呼ぶ前に終わるものは onFixCalled を呼ばない（resolve の失敗・断り）",
      w.fixCalled === 0 && texts(w)[0] === M.unreachable,
      JSON.stringify(texts(w)),
    );
  }

  // ── 返事は1通につき1回 ──
  {
    const w = world();
    await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    const r = await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      "同じ発言をもう一度扱っても、返事は1回だけ",
      w.replies.length === 1 && r.outcome === "queued",
    );
  }
  {
    const w = world();
    w.store = {
      ...w.store,
      setNx: async () => {
        throw new Error("KV down");
      },
    };
    const r = await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      "返事の印を置けない：返事をしない（受付は通っているので済みにする）",
      w.replies.length === 0 &&
        w.pushes.length === 0 &&
        r.outcome === "queued" &&
        w.committed === 1,
    );
    const r2 = await runObiFix(
      input(w, "#J12 0", { allowed: false }),
      byNumber,
      deps(w),
    );
    ok(
      "断りの印を置けない：返事をしない",
      w.replies.length === 0 && r2.outcome === "forbidden",
    );
  }
  {
    const w = world();
    w.replyOutcome = { kind: "rejected", status: 400 };
    await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      "reply がはっきり断られたときだけ、同じ文を push でグループへ",
      w.pushes.length === 1 &&
        w.pushes[0].to === G &&
        w.pushes[0].text === w.replies[0].text,
    );
    const w2 = world();
    w2.replyOutcome = { kind: "unknown" };
    await runObiFix(input(w2, "#J12 3ページ 2"), byNumber, deps(w2));
    ok(
      "reply の結果不明は送り直さない",
      w2.replies.length === 1 && w2.pushes.length === 0,
    );
  }

  // ── 各段階の時間の上限・返事の印の時間 ──
  {
    const w = world();
    signalTimeouts.length = 0;
    w.replyOutcome = { kind: "rejected", status: 400 };
    await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      "各段階の上限：resolve 6秒・fix 8秒・reply 4秒・push 4秒",
      signalTimeouts.join() === "6000,8000" &&
        w.replies[0].timeoutMs === 4000 &&
        w.pushes[0].timeoutMs === 4000,
      `${signalTimeouts.join()} ${w.replies[0].timeoutMs} ${w.pushes[0].timeoutMs}`,
    );
  }
  {
    const w = world();
    w.store = {
      ...w.store,
      setNx: () => new Promise<boolean>(() => undefined),
    };
    const r = await runObiFix(input(w, "#J12 3ページ 2"), byNumber, {
      ...deps(w),
      kvTimeoutMs: 20,
    });
    ok(
      "返事の印が返ってこない：上限で打ち切り、返事をしない",
      w.replies.length === 0 && r.outcome === "queued",
    );
  }
  {
    // 返事より前の段階の終わり（開始+17秒）を過ぎていたら、印を待たない＝返事をしない
    const w = world();
    w.startedAt = T - 17_000;
    const r = await runObiFix(
      input(w, "#J12 0", { allowed: false }),
      byNumber,
      deps(w),
    );
    ok(
      "開始+17秒を過ぎたら、印を置かずに終わる（返事をしない）",
      w.replies.length === 0 && w.kv.length === 0 && r.outcome === "forbidden",
    );
  }
  // ══ 時間の予算 ══
  {
    // 開始から6秒たって始まり、resolve に6秒かかった：fix は 17秒−12秒−返事の印の1秒＝4秒
    const w = world();
    signalTimeouts.length = 0;
    w.startedAt = T - 6_000;
    w.resolveTakesMs = 6_000;
    await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      "fix の時間は min(8秒, 開始+17秒−今−返事の印の1秒)",
      signalTimeouts.join() === "6000,4000",
      signalTimeouts.join(),
    );
  }
  {
    // 残りが2秒に満たない：fix を呼ばない
    const w = world();
    w.startedAt = T - 9_000;
    w.resolveTakesMs = 5_500;
    const r = await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      "残りが2秒に満たなければ fix を呼ばず、「届きません」を返して済みにする",
      paths(w) === RESOLVE &&
        texts(w).join("|") === M.unreachable &&
        r.outcome === "refused" &&
        w.committed === 0,
      JSON.stringify(texts(w)),
    );
  }
  {
    // 引用の resolve も、開始+17秒を越えない
    const w = world();
    signalTimeouts.length = 0;
    w.startedAt = T - 12_000;
    await locateObiFix(
      input(w, "3ページ 2", { quotedMessageId: QUOTED }),
      deps(w),
    );
    ok(
      "引用の resolve の時間は min(6秒, 開始+17秒−今)",
      signalTimeouts.join() === "5000",
      signalTimeouts.join(),
    );
  }
  {
    // どの段階も上限いっぱいかかっても、開始から25秒以内に終わる
    const w = world();
    w.resolveTakesMs = 6_000;
    w.fixTakesMs = 8_000;
    w.replyTakesMs = 4_000;
    w.pushTakesMs = 4_000;
    w.replyOutcome = { kind: "rejected", status: 400 };
    const r = await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      "遅い portal・遅い LINE でも、開始から25秒以内に終わる",
      w.clock.t - w.startedAt <= 25_000 &&
        r.outcome === "queued" &&
        w.pushes.length === 1,
      String(w.clock.t - w.startedAt),
    );
  }
  {
    // 開始+7秒から始まり、resolve に6秒、fix が返ってこない：fix は3秒で切り、返事まで25秒以内に終える
    const w = world();
    signalTimeouts.length = 0;
    w.startedAt = T - 7_000;
    w.resolveTakesMs = 6_000;
    w.fixTakesMs = 60_000;
    w.replyTakesMs = 4_000;
    w.pushTakesMs = 4_000;
    w.replyOutcome = { kind: "rejected", status: 400 };
    const r = await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      "遅く始まり fix が返ってこなくても、開始から25秒以内に「確かめられませんでした」まで終える",
      w.clock.t - w.startedAt <= 25_000 &&
        signalTimeouts.join() === "6000,3000" &&
        r.outcome === "unknown" &&
        w.replies.length === 1 &&
        w.replies[0].text === M.unknown &&
        w.pushes.length === 1,
      `${w.clock.t - w.startedAt} ${signalTimeouts.join()} ${r.outcome}`,
    );
  }
  {
    // portal が返ってこなくても、同じ Webhook の中では呼び直さない
    const w = world();
    w.resolveTakesMs = 60_000;
    const r = await runObiFix(input(w, "#J12 3ページ 2"), byNumber, deps(w));
    ok(
      "resolve が時間切れ：呼ぶのは resolve の1回だけ（fix も呼び直しも無い）",
      paths(w) === RESOLVE && r.outcome === "refused",
    );
    const w2 = world();
    w2.fixTakesMs = 60_000;
    const r2 = await runObiFix(input(w2, "#J12 3ページ 2"), byNumber, deps(w2));
    ok(
      "fix が時間切れ：呼ぶのは resolve 1回＋fix 1回だけ",
      paths(w2) === `${RESOLVE},${FIX}` && r2.outcome === "unknown",
    );
  }
  {
    // 遅く始まった #J つきの訂正（webhook-event.ts が late を立てる）：認可の後、portal を呼ばずに「届きません」
    const w = world();
    w.startedAt = T - 7_001;
    const late = { late: true };
    const r = await runObiFix(
      input(w, "#J12 3ページ 2", late),
      byNumber,
      deps(w),
    );
    ok(
      "遅く始まった #J つきの訂正：portal を呼ばず「届きません」を返す（fix は呼んでいないので、送り直してよい）",
      w.portal.length === 0 &&
        texts(w).join("|") === M.unreachable &&
        r.outcome === "refused" &&
        w.committed === 0 &&
        JSON.stringify(w.kv) ===
          JSON.stringify([["setNx", `obi-fix-replied:${MSG}`, TTL]]),
      JSON.stringify(texts(w)),
    );
    await runObiFix(input(w, "#J12 3ページ 2", late), byNumber, deps(w));
    ok(
      "遅く始まった訂正：同じ発言がもう一度届いても、返事は1通につき1回",
      w.replies.length === 1 && w.portal.length === 0,
    );
    const w2 = world();
    w2.startedAt = T - 7_001;
    const r2 = await runObiFix(
      input(w2, "#J12 3ページ 2", { late: true, allowed: false }),
      byNumber,
      deps(w2),
    );
    ok(
      "遅く始まった訂正でも、許可されていない人には断りが先（portal は呼ばない）",
      r2.outcome === "forbidden" &&
        texts(w2).join("|") === OBI_MESSAGES.fixForbidden &&
        w2.portal.length === 0,
    );
  }
  // ══ ページの聞き返し・聞き返しへの引用・ページの範囲 ══
  for (const text of ["#J12 1", "#J12 2", "#J12 3", "#J12 3右"]) {
    const w = world();
    const r = await runObiFix(input(w, text), byNumber, deps(w));
    ok(
      `ページが無い（${text}）：resolve までで終え、聞き返す（fix は呼ばない）`,
      r.outcome === "asked" &&
        paths(w) === RESOLVE &&
        texts(w).join("|") ===
          "何ページ目ですか？ 例：3ページ 2（#J12。この知らせに返信してください）" &&
        w.committed === 0,
      JSON.stringify(texts(w)),
    );
    ok(
      `ページが無い（${text}）：聞き返しは依頼ごとの印・出した聞き返しの ID → 受付番号を控える（どちらも8日）`,
      JSON.stringify(w.kv) ===
        JSON.stringify([
          ["setNx", "obi-fix-ask:12", TTL],
          ["putText", "obi-fix-askmsg:700000000000000001", `J12|${TTL}`],
        ]),
      JSON.stringify(w.kv),
    );
  }
  {
    const w = world();
    await runObiFix(input(w, "#J12 2"), byNumber, deps(w));
    const r = await runObiFix(
      input(w, "#J12 1", { messageId: "600000000000000201" }),
      byNumber,
      deps(w),
    );
    ok(
      "聞き返しは依頼ごとに1回：2回目からは返事をしない",
      r.outcome === "ask-suppressed" && w.replies.length === 1,
    );
    const other: Target = {
      kind: "target",
      via: "number",
      no: 13,
      resolved: null,
    };
    w.resolve = () => json(200, { ...RESOLVED, no: 13 });
    const r2 = await runObiFix(
      input(w, "#J13 2", { messageId: "600000000000000202" }),
      other,
      deps(w),
    );
    ok(
      "別の依頼には聞き返す",
      r2.outcome === "asked" &&
        w.replies.length === 2 &&
        texts(w)[1].includes("#J13"),
    );
  }
  {
    const w = world();
    w.replyOutcome = { kind: "rejected", status: 400 };
    await runObiFix(input(w, "#J12 2"), byNumber, deps(w));
    ok(
      "聞き返しが push に回ったら、push の ID を控える",
      w.pushes.length === 1 &&
        (await w.store.getText("obi-fix-askmsg:700000000000000002")) === "J12",
    );
  }
  {
    const w = world();
    w.replyOutcome = { kind: "unknown" };
    const r = await runObiFix(input(w, "#J12 2"), byNumber, deps(w));
    ok(
      "聞き返しの ID が取れない：控えない（#J つきの返事なら通る）",
      r.outcome === "asked" && !w.kv.some((k) => k[0] === "putText"),
    );
    const w2 = world();
    w2.store = {
      ...w2.store,
      putText: async () => {
        throw new Error("KV down");
      },
    };
    const r2 = await runObiFix(input(w2, "#J12 2"), byNumber, deps(w2));
    ok(
      "聞き返しの控えを置けない：聞き返しは出たまま、済みにする",
      r2.outcome === "asked" && w2.replies.length === 1,
    );
  }
  {
    // 聞き返す前に、resolve の見込みで断るもの（聞いても直せない）
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { current: false },
        "#J12 には新しい完成の知らせがあります。いちばん新しい知らせに返信してください",
      ],
      [
        { fixable: "closed" },
        "#J12 は完了にしてあります。直すときは、もう一度依頼してください",
      ],
      [
        { fixable: "expired" },
        "期限（7日）を過ぎたので直せません。もう一度依頼してください",
      ],
      [
        { fixable: "not-ready" },
        "#J12 はいま処理中です。少し待ってからもう一度送ってください",
      ],
      [
        { fixable: "unavailable" },
        "#J12 は番号では直せません。担当に声をかけてください",
      ],
    ];
    for (const [over, want] of cases) {
      const w = world();
      w.resolve = () => json(200, { ...RESOLVED, ...over });
      const r = await runObiFix(input(w, "#J12 2"), byNumber, deps(w));
      ok(
        `ページが無く、見込みが ${JSON.stringify(over)}：聞き返さずにその文`,
        texts(w).join("|") === want &&
          r.outcome === "refused" &&
          paths(w) === RESOLVE &&
          !w.kv.some((k) => k[1] === "obi-fix-ask:12"),
        JSON.stringify(texts(w)),
      );
    }
    const w = world();
    w.resolve = () => json(200, { ...RESOLVED, closable: "unavailable" });
    const r = await runObiFix(input(w, "#J12 2"), byNumber, deps(w));
    ok(
      "1〜3 の聞き返しは fixable を見る（closable は見ない）",
      r.outcome === "asked",
    );
  }
  for (const text of ["#J12 4", "#J12 5", "#J12 0"]) {
    const w = world();
    w.fix = () =>
      fixed({
        result: text.endsWith("0") ? "closed" : "human",
        reason: text.endsWith("0") ? "" : "manual-code",
      });
    await runObiFix(input(w, text), byNumber, deps(w));
    ok(
      `ページが要らない番号（${text}）は聞き返さずに fix へ`,
      paths(w) === `${RESOLVE},${FIX}` && !("page" in w.portal[1].body),
    );
  }
  {
    // 聞き返しへの引用の返事：KV で対象 → 認可 → resolve（番号）→ fix
    const w = world();
    await runObiFix(input(w, "#J12 2"), byNumber, deps(w));
    w.portal.length = 0;
    const reply = input(w, "3ページ 2", {
      messageId: "600000000000000201",
      quotedMessageId: "700000000000000001",
    });
    const t = await locateObiFix(reply, deps(w));
    ok(
      "聞き返しへの引用：対象は聞き返した依頼",
      t.kind === "target" &&
        t.via === "ask" &&
        t.no === 12 &&
        w.portal.length === 0,
    );
    const r = await runObiFix(reply, t as Target, deps(w));
    ok(
      "聞き返しへの引用：resolve（番号）→ fix。ページつきで送る",
      r.outcome === "queued" &&
        paths(w) === `${RESOLVE},${FIX}` &&
        w.portal[0].body.no === 12 &&
        w.portal[1].body.page === 3 &&
        w.portal[1].body.messageId === "600000000000000201",
    );
    const denied = input(w, "3ページ 2", {
      messageId: "600000000000000202",
      quotedMessageId: "700000000000000001",
      allowed: false,
    });
    w.portal.length = 0;
    const t2 = await locateObiFix(denied, deps(w));
    const r2 = await runObiFix(denied, t2 as Target, deps(w));
    ok(
      "聞き返しへの引用（許可されていない人）：portal を1回も呼ばずに断る",
      r2.outcome === "forbidden" &&
        w.portal.length === 0 &&
        texts(w)[texts(w).length - 1] === OBI_MESSAGES.fixForbidden,
    );
  }
  for (const [text, page, count, want] of [
    [
      "#J12 0ページ 2",
      0,
      5,
      "#J12 に0ページはありません（全部で5ページです）。ページを確かめてもう一度送ってください",
    ],
    [
      "#J12 121ページ 2",
      121,
      5,
      "#J12 に121ページはありません（全部で5ページです）。ページを確かめてもう一度送ってください",
    ],
    [
      "#J12 999ページ 4",
      999,
      0,
      "#J12 に999ページはありません。ページを確かめてもう一度送ってください",
    ],
  ] as Array<[string, number, number, string]>) {
    const w = world();
    w.resolve = () => json(200, { ...RESOLVED, pageCount: count });
    const r = await runObiFix(input(w, text), byNumber, deps(w));
    ok(
      `portal が受けないページ（${page}）：fix を呼ばずに「ありません」`,
      texts(w).join("|") === want &&
        paths(w) === RESOLVE &&
        r.outcome === "refused" &&
        w.committed === 0,
      JSON.stringify(texts(w)),
    );
  }
  {
    const w = world();
    await runObiFix(input(w, "#J12 120ページ 2"), byNumber, deps(w));
    ok(
      "120ページまでは fix に送る（あるかどうかは portal が決める）",
      paths(w) === `${RESOLVE},${FIX}` && w.portal[1].body.page === 120,
    );
  }
  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
