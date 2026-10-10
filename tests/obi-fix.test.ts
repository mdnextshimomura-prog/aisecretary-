/**
 * 「番号で直す」の中身（対象の特定 locateObiFix・認可〜返事 runObiFix）を、偽物の KV・portal・LINE で確かめる
 * （設計 2026-10-10 の E11・E12・「文」・「うまくいかないとき」）。
 */
import {
  locateObiFix,
  replyObiFixStopped,
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

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
