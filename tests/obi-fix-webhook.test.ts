/**
 * Webhook の振り分けのうち「番号で直す」の枝（設計 2026-10-10 の E12）を、偽物の KV・LINE・portal・予約で確かめる。
 * 「今までの流れ」（メールの下書き・初動確認・タスク・番号での完了など）は rest に入ったかどうかで確かめる
 * （rest に入ったイベントは、route.ts の今までのループがそのまま扱う）。
 */
import {
  dispatchObiEvents,
  type ObiEventDeps,
  type ObiLineEvent,
} from "../src/lib/obi/webhook-event";
import { createMemoryObiStore, type ObiStore } from "../src/lib/obi/memo";
import { OBI_MESSAGES } from "../src/lib/obi/intake";
import { OBI_FIX_MESSAGES } from "../src/lib/obi/fix";
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
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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
const FIXED = {
  no: 12,
  fixId: 7,
  created: true,
  result: "queued",
  code: 2,
  page: 3,
  turn: "",
  round: 1,
  reason: "",
};
const NOTICE = "600000000000000150"; // Mac が出した完成の知らせ
const MSG = "600000000000000200";

// コンソールに出たものを控える（message.id・userId・groupId・本文・リンクが出ていないことを確かめる）
const logged: string[] = [];
for (const level of ["log", "error", "warn", "info"] as const) {
  const real = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(
      args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" "),
    );
    real(...args);
  };
}

interface World {
  clock: { t: number };
  startedAt: number;
  store: ObiStore;
  kv: string[]; // 「操作 かぎ 値」
  sent: Array<{ url: string; headers: string; body: string }>; // portal へ送ったもの（そのまま）
  resolve: (body: Record<string, unknown>) => Response;
  fix: () => Response;
  replies: Array<{ token: string; text: string; timeoutMs: number }>;
  pushes: Array<{ to: string; text: string; timeoutMs: number }>;
  replyImpl: () => ReplyOutcome;
  botMessageSeq: number;
  reserved: string[];
  completed: string[];
  released: string[];
  reserveAnswer: { proceed: boolean; inProgress?: boolean };
}

function world(): World {
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
    // 完成の知らせ（NOTICE）への引用と、#J12 だけを引ける portal
    resolve: (body) =>
      body.quotedMessageId === NOTICE || body.no === 12
        ? json(200, RESOLVED)
        : json(404, { code: "NOT_FOUND", message: "x" }),
    fix: () => json(201, FIXED),
    replies: [],
    pushes: [],
    replyImpl: () => ({
      kind: "sent",
      messageId: `70000000000000000${++w.botMessageSeq}`,
    }),
    botMessageSeq: 0,
    reserved: [],
    completed: [],
    released: [],
    reserveAnswer: { proceed: true },
  };
  return w;
}

function deps(w: World, envOver: ObiEnv = env): ObiEventDeps {
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const u = String(url);
    const headers: string[] = [];
    new Headers(init?.headers).forEach((v, k) => headers.push(`${k}: ${v}`));
    w.sent.push({
      url: u,
      headers: headers.join("\n"),
      body: String(init?.body),
    });
    if (u === "https://portal.example.test/api/jobs/fix/resolve")
      return w.resolve(JSON.parse(String(init?.body)));
    if (u === "https://portal.example.test/api/jobs/12/fix") return w.fix();
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
    now: () => w.clock.t,
    reply: async (token, text, timeoutMs) => {
      w.replies.push({ token, text, timeoutMs });
      return w.replyImpl();
    },
    push: async () => {
      throw new Error("訂正の返事は pushWithId を使う");
    },
    pushWithId: async (to, text, timeoutMs) => {
      w.pushes.push({ to, text, timeoutMs });
      return { ok: true, messageId: `70000000000000000${++w.botMessageSeq}` };
    },
  };
}

/** テキストのイベント。quoted を付けると引用リプライ、mention を付けると @MD NEXT秘書 つき */
const textEvent = (
  id: string,
  body: string,
  over: {
    groupId?: string;
    userId?: string | null;
    sourceType?: string;
    quoted?: string;
    mention?: boolean;
  } = {},
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
        ? {
            mention: {
              mentionees: [
                {
                  index: 0,
                  length: prefix.length - 1,
                  type: "user" as const,
                  userId: BOT,
                },
              ],
            },
          }
        : {}),
    },
  };
};
const urls = (w: World) =>
  w.sent.map((s) => s.url.replace("https://portal.example.test", "")).join();
const texts = (w: World) => w.replies.map((r) => r.text);
const RESOLVE = "/api/jobs/fix/resolve";
const FIX = "/api/jobs/12/fix";
const untouched = (w: World) =>
  w.sent.length === 0 &&
  w.kv.length === 0 &&
  w.replies.length === 0 &&
  w.pushes.length === 0 &&
  w.reserved.length === 0;

async function main() {
  // ── 訂正として扱わない：今までの流れへ（入力が変わらない） ──
  for (const [name, ev] of [
    ["番号だけ（引用も #J も無い）", textEvent(MSG, "2")],
    ["ページつきでも、引用も #J も無い", textEvent(MSG, "3ページ 2")],
    [
      "個別トーク（#J つき）",
      textEvent(MSG, "#J12 2", { sourceType: "user", groupId: undefined }),
    ],
    ["他のグループ（#J つき）", textEvent(MSG, "#J12 2", { groupId: G2 })],
    [
      "他のグループ（引用）",
      textEvent(MSG, "2", { groupId: G2, quoted: NOTICE }),
    ],
    [
      "形に合わない言葉（引用つき）",
      textEvent(MSG, "2番直して", { quoted: NOTICE }),
    ],
    ["既存の承認の形（#J12 OK）", textEvent(MSG, "#J12 OK")],
    ["6 以上", textEvent(MSG, "#J12 6")],
    ["1通に複数", textEvent(MSG, "#J12 3ページ 1 2")],
  ] as Array<[string, ObiLineEvent]>) {
    const w = world();
    const r = await dispatchObiEvents([ev], deps(w));
    ok(
      `今までの流れへ：${name}`,
      r.rest.length === 1 && r.rest[0] === ev && !r.needsRetry && untouched(w),
      JSON.stringify({ sent: w.sent.length, kv: w.kv }),
    );
  }
  for (const kind of ["reject", "review"]) {
    // 完成の知らせ以外の種類の知らせ（差し戻しの選択肢の設計 2026-10-11。いまの portal は返さない）への引用（約束の P1・P4）
    const w = world();
    w.resolve = () => json(200, { ...RESOLVED, kind, phase: "choose" });
    const ev = textEvent(MSG, "2", { quoted: NOTICE });
    const r = await dispatchObiEvents([ev], deps(w));
    ok(
      `引用先が完成の知らせではない（kind: ${kind}）：訂正として扱わず、今までの流れへそのまま渡す（返事も予約もしない・fix を呼ばない）`,
      r.rest.length === 1 &&
        r.rest[0] === ev &&
        !r.needsRetry &&
        w.replies.length === 0 &&
        w.reserved.length === 0 &&
        urls(w) === RESOLVE,
      JSON.stringify({ sent: w.sent.length, kv: w.kv }),
    );
  }
  for (const [name, text] of [
    ["タスクの確認への引用の「2」（番号での完了など）", "2"],
    ["メールの下書きへの引用の「0」", "0"],
    ["初動確認への引用の「3ページ 2」", "3ページ 2"],
  ]) {
    const w = world();
    const ev = textEvent(MSG, text, { quoted: "600000000000000099" }); // portal が知らない引用先
    const r = await dispatchObiEvents([ev], deps(w));
    ok(
      `引用先が帯替えの知らせでない（${name}）：今までの流れへそのまま渡す`,
      r.rest.length === 1 && r.rest[0] === ev && !r.needsRetry,
    );
    ok(
      `引用先が帯替えの知らせでない（${name}）：返事も予約もしない・fix を呼ばない`,
      w.replies.length === 0 && w.reserved.length === 0 && urls(w) === RESOLVE,
    );
    const w2 = world();
    const ev2 = textEvent(MSG, text, {
      quoted: "600000000000000099",
      userId: OTHER,
    });
    const r2 = await dispatchObiEvents([ev2], deps(w2));
    ok(
      `許可されていない人でも同じ（${name}）：断りを出さずに今までの流れへ`,
      r2.rest[0] === ev2 && w2.replies.length === 0 && w2.reserved.length === 0,
    );
  }

  // ── 訂正として扱う（今までの流れには渡さない） ──
  {
    const w = world();
    const r = await dispatchObiEvents(
      [textEvent(MSG, "#J12 3ページ 2")],
      deps(w),
    );
    ok(
      "#J つき：ここで扱い終える（今までの流れに渡さない）",
      r.rest.length === 0 && !r.needsRetry,
    );
    ok(
      "#J つき：resolve → fix を1回ずつ、返事は訂正の発言へ reply",
      urls(w) === `${RESOLVE},${FIX}` &&
        w.replies.length === 1 &&
        w.replies[0].token === `rt-${MSG}` &&
        w.replies[0].text.startsWith(
          "#J12 の直しを受け付けました（3ページ・他社の文字）",
        ),
      JSON.stringify(w.replies),
    );
    ok(
      "#J つき：予約を取り、済みにする",
      w.reserved.join() === MSG &&
        w.completed.join() === MSG &&
        w.released.length === 0,
    );
    ok("返事の時間の上限は4秒", w.replies[0].timeoutMs === 4000);
  }
  {
    const w = world();
    const r = await dispatchObiEvents(
      [textEvent(MSG, "＃Ｊ１２　３ページ　２", { mention: true })],
      deps(w),
    );
    ok(
      "メンションつき・全角でも読む",
      r.rest.length === 0 &&
        urls(w) === `${RESOLVE},${FIX}` &&
        JSON.parse(w.sent[1].body).page === 3,
    );
  }
  {
    const w = world();
    const r = await dispatchObiEvents(
      [textEvent(MSG, "3ページ 2", { quoted: NOTICE })],
      deps(w),
    );
    ok(
      "完成の知らせへの引用：訂正として扱う（resolve は1回だけ・fix を1回）",
      r.rest.length === 0 &&
        !r.needsRetry &&
        urls(w) === `${RESOLVE},${FIX}` &&
        w.completed.join() === MSG,
    );
    ok(
      "完成の知らせへの引用：引用先を確かめてから予約を取る",
      JSON.parse(w.sent[0].body).quotedMessageId === NOTICE &&
        w.reserved.join() === MSG,
    );
    const w0 = world();
    w0.fix = () =>
      json(201, { ...FIXED, result: "closed", code: 0, page: null, round: 0 });
    const r0 = await dispatchObiEvents(
      [textEvent(MSG, "0", { quoted: NOTICE })],
      deps(w0),
    );
    ok(
      "完成の知らせへの引用の「0」：完了にする",
      r0.rest.length === 0 &&
        texts(w0).join() === "ありがとうございます。#J12 を完了にしました",
    );
  }
  {
    // メールの下書きの途中・初動確認の途中でも、訂正と決まったら先に扱う（rest に入らない＝今までの流れは見ない）
    const w = world();
    const other = textEvent("600000000000000201", "送信");
    const fixEv = textEvent(MSG, "#J12 0");
    w.fix = () =>
      json(201, { ...FIXED, result: "closed", code: 0, page: null, round: 0 });
    const r = await dispatchObiEvents([other, fixEv], deps(w));
    ok(
      "訂正は今までの流れに渡さず、ほかの発言は元の順番のまま渡す",
      r.rest.length === 1 && r.rest[0] === other && w.completed.join() === MSG,
    );
  }

  // ── 訂正できる人 ──
  for (const [name, userId] of [
    ["許可リストにいない人", OTHER],
    ["userId が無いイベント", null],
  ] as Array<[string, string | null]>) {
    for (const text of ["#J12 3ページ 2", "#J12 0"]) {
      const w = world();
      const ev = textEvent(MSG, text, { userId });
      const r = await dispatchObiEvents([ev], deps(w));
      ok(
        `${name}の ${text}：断りを返し、portal を1回も呼ばない（その番号の依頼があるかも答えない）`,
        texts(w).join("|") === OBI_MESSAGES.fixForbidden &&
          w.sent.length === 0 &&
          r.rest.length === 0 &&
          !r.needsRetry,
        JSON.stringify(texts(w)),
      );
      ok(
        `${name}の ${text}：済みにする（今までの流れに渡さない）`,
        w.completed.join() === MSG && w.released.length === 0,
      );
      const again = await dispatchObiEvents([ev], deps(w));
      ok(
        `${name}の ${text}：再送では返さない`,
        w.replies.length === 1 && again.rest.length === 0,
      );
    }
    const w = world();
    const r = await dispatchObiEvents(
      [textEvent(MSG, "3ページ 2", { quoted: NOTICE, userId })],
      deps(w),
    );
    ok(
      `${name}の完成の知らせへの引用：resolve だけ呼び、fix は呼ばずに断る`,
      urls(w) === RESOLVE &&
        texts(w).join("|") === OBI_MESSAGES.fixForbidden &&
        r.rest.length === 0 &&
        w.completed.join() === MSG,
    );
  }
  {
    const w = world();
    const r = await dispatchObiEvents(
      [textEvent(MSG, "#J12 2", { userId: OTHER })],
      deps(w),
    );
    ok(
      "許可されていない人のページなし：聞き返さずに断る",
      texts(w).join("|") === OBI_MESSAGES.fixForbidden &&
        w.sent.length === 0 &&
        r.rest.length === 0,
    );
  }

  // ── 設定が足りない（fail closed） ──
  {
    const broken = { ...env, JOB_API_TOKEN: undefined };
    const w = world();
    const r = await dispatchObiEvents(
      [textEvent(MSG, "#J12 3ページ 2", { userId: OTHER })],
      deps(w, broken),
    );
    ok(
      "設定が足りない：#J つきの営業部の発言にだけ「止めています」（人の確認より先）",
      texts(w).join("|") === OBI_MESSAGES.stopped &&
        w.sent.length === 0 &&
        r.rest.length === 0 &&
        w.completed.join() === MSG,
    );
    await dispatchObiEvents(
      [textEvent(MSG, "#J12 3ページ 2")],
      deps(w, broken),
    );
    ok("設定が足りない：再送では返さない", w.replies.length === 1);
    const w2 = world();
    const ev = textEvent(MSG, "3ページ 2", { quoted: NOTICE });
    const r2 = await dispatchObiEvents([ev], deps(w2, broken));
    ok(
      "設定が足りない：引用の形は確かめようが無いので今までの流れへ",
      r2.rest[0] === ev && untouched(w2),
    );
    const w3 = world();
    const ev3 = textEvent(MSG, "#J12 3ページ 2", { groupId: G2 });
    const r3 = await dispatchObiEvents([ev3], deps(w3, broken));
    ok(
      "設定が足りない：他のグループには何も返さない",
      r3.rest[0] === ev3 && untouched(w3),
    );
    for (const noGroup of [
      { ...env, LINE_GROUP_ID: undefined },
      { ...env, LINE_GROUP_ID: "営業部" },
    ]) {
      const w4 = world();
      const ev4 = textEvent(MSG, "#J12 3ページ 2");
      const r4 = await dispatchObiEvents([ev4], deps(w4, noGroup));
      ok(
        "LINE_GROUP_ID が無い・形が違う：どのグループでも何もしない（今までの流れへ）",
        r4.rest[0] === ev4 && untouched(w4),
      );
    }
  }

  // ── 引用先を確かめられない・portal に届かない（LINE の Webhook の再送は本番で無効。Z3・AA1） ──
  for (const [name, answer] of [
    [
      "時間切れ",
      () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    ],
    [
      "つながらない",
      () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNREFUSED" },
        });
      },
    ],
    ["5xx", () => json(500, { code: "INTERNAL" })],
    ["形の違う 200", () => json(200, { no: 12 })],
  ] as Array<[string, () => Response]>) {
    const w = world();
    w.resolve = answer;
    const ev = textEvent(MSG, "3ページ 2", { quoted: NOTICE });
    const r1 = await dispatchObiEvents([ev], deps(w));
    ok(
      `引用先を確かめられない（${name}）：初回から今までの流れへ渡す（503 にしない・返事なし・予約なし）`,
      !r1.needsRetry &&
        r1.rest.length === 1 &&
        r1.rest[0] === ev &&
        w.replies.length === 0 &&
        w.pushes.length === 0 &&
        w.reserved.length === 0,
      `${r1.needsRetry},${r1.rest.length}`,
    );
    ok(
      `引用先を確かめられない（${name}）：KV に回数を置かない（読むのは聞き返しの控えだけ）・portal は1回`,
      w.kv.join() === `getText obi-fix-askmsg:${NOTICE}` && urls(w) === RESOLVE,
      w.kv.join(),
    );
    const r2 = await dispatchObiEvents([ev], deps(w));
    ok(
      `引用先を確かめられない（${name}）：同じ発言がもう一度届いても同じ扱い（数えていない）`,
      !r2.needsRetry && r2.rest[0] === ev && w.replies.length === 0,
    );
  }
  for (const [name, answer] of [
    [
      "時間切れ",
      () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    ],
    ["5xx", () => json(500, { code: "INTERNAL" })],
  ] as Array<[string, () => Response]>) {
    const w = world();
    w.resolve = answer;
    const ev = textEvent(MSG, "#J12 3ページ 2");
    const r1 = await dispatchObiEvents([ev], deps(w));
    ok(
      `#J つきで resolve が届かない（${name}）：今までの流れへ流さず「portal に届きません…」を返して済みにする（503 にしない）`,
      !r1.needsRetry &&
        r1.rest.length === 0 &&
        texts(w).join("|") === OBI_FIX_MESSAGES.unreachable &&
        urls(w) === RESOLVE &&
        w.completed.join() === MSG &&
        w.released.length === 0,
      JSON.stringify(texts(w)),
    );
    ok(
      `#J つきで resolve が届かない（${name}）：返事の印は発言ごと（NX・8日）`,
      w.kv.join() === `setNx obi-fix-replied:${MSG} 691200`,
      w.kv.join(),
    );
    w.reserveAnswer = { proceed: true };
    await dispatchObiEvents([ev], deps(w));
    ok(
      `#J つきで resolve が届かない（${name}）：同じ発言がもう一度届いても、返事は1回だけ`,
      w.replies.length === 1,
    );
  }

  // ── 503 にしない場面（LINE の Webhook の再送は本番で無効。AA1） ──
  {
    const w = world();
    w.fix = () => {
      throw new DOMException("timed out", "TimeoutError");
    };
    const ev = textEvent(MSG, "#J12 3ページ 2");
    const r1 = await dispatchObiEvents([ev], deps(w));
    ok(
      "fix の結果不明：「受付の結果を確かめられませんでした…」を1回返して済みにする（503 にしない・予約を外さない）",
      !r1.needsRetry &&
        r1.rest.length === 0 &&
        texts(w).join("|") === OBI_FIX_MESSAGES.unknown &&
        urls(w) === `${RESOLVE},${FIX}` &&
        w.completed.join() === MSG &&
        w.released.length === 0,
      JSON.stringify(texts(w)),
    );
    ok(
      "fix の結果不明：返事に「もう一度送ってください」と書かない（「送らないでください」と書く）",
      !texts(w).join("|").includes("もう一度送ってください") &&
        texts(w).join("|").includes("同じ番号をもう一度送らないでください"),
    );
    ok(
      "fix の結果不明：知らせの印は発言ごと（NX・8日）",
      w.kv.join() === `setNx obi-fix-pending-notified:${MSG} 691200`,
      w.kv.join(),
    );
    // 済みにした後に同じ発言がもう一度届いても（予約は「済み」と答える）、やり直さない
    w.reserveAnswer = { proceed: false };
    const before = w.sent.length;
    const r2 = await dispatchObiEvents([ev], deps(w));
    ok(
      "結果不明で済みにした発言がもう一度届いても、やり直さない（portal を呼ばない・返事もしない）",
      !r2.needsRetry &&
        r2.rest.length === 0 &&
        w.sent.length === before &&
        w.replies.length === 1 &&
        w.released.length === 0,
    );
  }
  for (const [name, fixImpl] of [
    ["5xx", () => json(500, { code: "INTERNAL" })],
    ["形の違う 200", () => json(200, { no: 12, result: "???" })],
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
    const r = await dispatchObiEvents(
      [textEvent(MSG, "#J12 3ページ 2")],
      deps(w),
    );
    ok(
      `fix の${name}も結果不明：同じ文を1回返して済みにする（503 にしない）`,
      !r.needsRetry &&
        texts(w).join("|") === OBI_FIX_MESSAGES.unknown &&
        w.completed.join() === MSG &&
        w.released.length === 0,
      JSON.stringify(texts(w)),
    );
  }
  // 送っていないことが確かな失敗（AB1）：結果不明にせず「届きません…もう一度送ってください」。#J つきでも引用の形でも同じ
  for (const [name, ev] of [
    ["#J つき", textEvent(MSG, "#J12 3ページ 2")],
    ["完成の知らせへの引用", textEvent(MSG, "3ページ 2", { quoted: NOTICE })],
  ] as Array<[string, ReturnType<typeof textEvent>]>) {
    const w = world();
    w.fix = () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      });
    };
    const r = await dispatchObiEvents([ev], deps(w));
    ok(
      `fix につながらない（${name}）：「portal に届きません…もう一度送ってください」を1回返して済みにする（結果不明にしない・503 にしない・今までの流れへ流さない）`,
      !r.needsRetry &&
        r.rest.length === 0 &&
        texts(w).join("|") === OBI_FIX_MESSAGES.unreachable &&
        w.kv.includes(`setNx obi-fix-replied:${MSG} 691200`) &&
        !w.kv.some((k) => k.includes("obi-fix-pending-notified")) &&
        w.completed.join() === MSG &&
        w.released.length === 0,
      JSON.stringify([texts(w), w.kv]),
    );
  }
  {
    const w = world();
    w.reserveAnswer = { proceed: false, inProgress: true };
    const r = await dispatchObiEvents(
      [textEvent(MSG, "#J12 3ページ 2")],
      deps(w),
    );
    ok(
      "同じ発言を別の処理が扱っている途中：何もしない（503 にしない。先の処理の予約を済みにも解放にもしない）",
      !r.needsRetry &&
        r.rest.length === 0 &&
        w.sent.length === 0 &&
        w.replies.length === 0 &&
        w.kv.length === 0 &&
        w.reserved.join() === MSG &&
        w.completed.length === 0 &&
        w.released.length === 0,
    );
    const w2 = world();
    w2.reserveAnswer = { proceed: false };
    const r2 = await dispatchObiEvents(
      [textEvent(MSG, "#J12 3ページ 2")],
      deps(w2),
    );
    ok(
      "処理済みのイベント：何もしない",
      !r2.needsRetry &&
        r2.rest.length === 0 &&
        w2.sent.length === 0 &&
        w2.replies.length === 0 &&
        w2.completed.length === 0 &&
        w2.released.length === 0,
    );
  }
  {
    // 同じ Webhook の先の処理で時間を使った（開始+7秒より後。遅い開始）：portal は呼ばない。503 にもしない（Z11・AA1）
    const w = world();
    w.startedAt = T - 7_001;
    const quotedEv = textEvent("600000000000000201", "3ページ 2", {
      quoted: NOTICE,
    });
    const r = await dispatchObiEvents(
      [textEvent(MSG, "#J12 3ページ 2"), quotedEv],
      deps(w),
    );
    ok(
      "遅い開始（引用の形）：portal も KV も呼ばず、予約せず今までの流れへ",
      !r.needsRetry && r.rest.length === 1 && r.rest[0] === quotedEv,
      `${r.needsRetry},${r.rest.length}`,
    );
    ok(
      "遅い開始（#J つき）：portal を呼ばず「portal に届きません…」を1回返して済みにする",
      w.sent.length === 0 &&
        texts(w).join("|") === OBI_FIX_MESSAGES.unreachable &&
        w.kv.join() === `setNx obi-fix-replied:${MSG} 691200` &&
        w.reserved.join() === MSG &&
        w.completed.join() === MSG,
      `${w.kv.join()} ${JSON.stringify(texts(w))}`,
    );
    const w1 = world();
    w1.startedAt = T - 7_001;
    const r1 = await dispatchObiEvents(
      [textEvent(MSG, "#J12 3ページ 2", { userId: OTHER })],
      deps(w1),
    );
    ok(
      "残り時間が足りなくても、許可されていない人には断りが先（portal は呼ばない）",
      !r1.needsRetry &&
        texts(w1).join("|") === OBI_MESSAGES.fixForbidden &&
        w1.sent.length === 0,
      JSON.stringify(texts(w1)),
    );
    const w2 = world();
    w2.startedAt = T - 7_001;
    const plain = textEvent(MSG, "2");
    const r2 = await dispatchObiEvents([plain], deps(w2));
    ok(
      "残り時間が足りなくても、訂正の形でないものは今までの流れへ",
      !r2.needsRetry && r2.rest[0] === plain,
    );
  }
  {
    // 途中で止まる場面（どれも 503 にしない。AA1）
    const w = world();
    w.replyImpl = () => {
      throw new Error("crash");
    };
    const r = await dispatchObiEvents(
      [textEvent(MSG, "#J12 3ページ 2")],
      deps(w),
    );
    ok(
      "fix がはっきり答えた後・返事の前に例外：受け付けは通っているので済みにする（予約を外さない）",
      !r.needsRetry &&
        w.completed.join() === MSG &&
        w.released.length === 0 &&
        urls(w) === `${RESOLVE},${FIX}`,
    );
    // fix を呼ぶ前の例外（#J つき）：聞き返しの reply で1回だけ例外。次の reply は通る
    const w2 = world();
    let calls = 0;
    w2.replyImpl = () => {
      if (calls++ === 0) throw new Error("crash");
      return { kind: "sent", messageId: "700000000000000009" };
    };
    const r2 = await dispatchObiEvents([textEvent(MSG, "#J12 2")], deps(w2));
    ok(
      "fix を呼ぶ前の例外（#J つき）：「portal に届きません…もう一度送ってください」を返して済みにする（503 にしない）",
      !r2.needsRetry &&
        r2.rest.length === 0 &&
        urls(w2) === RESOLVE &&
        texts(w2)[texts(w2).length - 1] === OBI_FIX_MESSAGES.unreachable &&
        w2.kv.includes(`setNx obi-fix-replied:${MSG} 691200`) &&
        w2.completed.join() === MSG &&
        w2.released.length === 0,
      `${w2.kv.join()} ${JSON.stringify(texts(w2))}`,
    );
    // fix を呼ぶ前の例外（引用の形）：予約を外して、今までの流れへ渡す
    const w4 = world();
    w4.replyImpl = () => {
      throw new Error("crash");
    };
    const quotedEv = textEvent(MSG, "2", { quoted: NOTICE });
    const r4 = await dispatchObiEvents([quotedEv], deps(w4));
    ok(
      "fix を呼ぶ前の例外（引用の形）：予約を外して今までの流れへ渡す（503 にしない・「届きません」は返さない）",
      !r4.needsRetry &&
        r4.rest.length === 1 &&
        r4.rest[0] === quotedEv &&
        urls(w4) === RESOLVE &&
        !texts(w4).includes(OBI_FIX_MESSAGES.unreachable) &&
        w4.released.join() === MSG &&
        w4.completed.length === 0,
      JSON.stringify(texts(w4)),
    );
    // fix を呼んだ後・はっきりした答えの前の例外（結果不明の知らせの reply で例外）
    const w5 = world();
    w5.fix = () => {
      throw new DOMException("timed out", "TimeoutError");
    };
    w5.replyImpl = () => {
      throw new Error("crash");
    };
    const r5 = await dispatchObiEvents(
      [textEvent(MSG, "#J12 3ページ 2")],
      deps(w5),
    );
    ok(
      "fix を呼んだ後の例外：結果不明と同じ扱いで済みにする（予約を外さない・「もう一度送ってください」と言わない）",
      !r5.needsRetry &&
        r5.rest.length === 0 &&
        urls(w5) === `${RESOLVE},${FIX}` &&
        !texts(w5).some((t) => t.includes("もう一度送ってください")) &&
        w5.kv.filter((k) => k.startsWith("setNx")).every((k) =>
          k.startsWith(`setNx obi-fix-pending-notified:${MSG} `),
        ) &&
        w5.completed.join() === MSG &&
        w5.released.length === 0,
      `${w5.kv.join()} ${JSON.stringify(texts(w5))}`,
    );
    const w3 = world();
    let n = 0;
    const d3 = deps(w3);
    d3.events.complete = async (id) => {
      if (n++ < 2) throw new Error("KV down");
      w3.completed.push(id);
    };
    const r3 = await dispatchObiEvents([textEvent(MSG, "#J12 3ページ 2")], d3);
    ok(
      "返事の後・「済み」の記録の失敗：3回まで試す",
      !r3.needsRetry && w3.completed.join() === MSG && n === 3,
    );
  }

  // ── ページの聞き返しと、その聞き返しへの引用 ──
  {
    const w = world();
    const r1 = await dispatchObiEvents([textEvent(MSG, "#J12 2")], deps(w));
    ok(
      "ページが無い：聞き返して済みにする（fix は呼ばない）",
      !r1.needsRetry &&
        r1.rest.length === 0 &&
        texts(w).join("|") === OBI_FIX_MESSAGES.askPage(12) &&
        urls(w) === RESOLVE &&
        w.completed.join() === MSG,
    );
    const askId = "700000000000000001"; // 上の reply が返した ID
    const r2 = await dispatchObiEvents(
      [textEvent("600000000000000201", "3ページ 2", { quoted: askId })],
      deps(w),
    );
    ok(
      "聞き返しへの引用：ページつきで fix を呼ぶ（引用先は KV で引き、resolve は番号で1回）",
      !r2.needsRetry &&
        r2.rest.length === 0 &&
        urls(w) === `${RESOLVE},${RESOLVE},${FIX}` &&
        JSON.parse(w.sent[1].body).no === 12 &&
        JSON.parse(w.sent[2].body).page === 3,
    );
    const before = w.sent.length;
    const r3 = await dispatchObiEvents(
      [
        textEvent("600000000000000202", "3ページ 2", {
          quoted: askId,
          userId: OTHER,
        }),
      ],
      deps(w),
    );
    ok(
      "聞き返しへの引用（許可されていない人）：portal を1回も呼ばずに断る",
      w.sent.length === before &&
        texts(w)[texts(w).length - 1] === OBI_MESSAGES.fixForbidden &&
        r3.rest.length === 0,
    );
    const r4 = await dispatchObiEvents(
      [textEvent("600000000000000203", "2", { quoted: NOTICE })],
      deps(w),
    );
    ok(
      "同じ依頼への2回目のページなし：返事をしない（済みにする）",
      w.replies.length === 3 &&
        !r4.needsRetry &&
        r4.rest.length === 0 &&
        w.completed.includes("600000000000000203"),
    );
  }

  // ── 個人の ID を外に出さない ──
  {
    logged.length = 0;
    const w = world();
    w.fix = () => {
      throw new DOMException("timed out", "TimeoutError");
    };
    await dispatchObiEvents(
      [
        textEvent(MSG, "#J12 3ページ 2"), // 許可された人：resolve＋fix（結果不明）
        textEvent("600000000000000201", "#J12 2", { quoted: NOTICE }), // 聞き返し
        textEvent("600000000000000202", "3ページ 2", {
          quoted: NOTICE,
          userId: OTHER,
        }), // 許可されていない人
        textEvent("600000000000000203", "#J12 0", { userId: OTHER }),
        textEvent("600000000000000204", "0", { quoted: "600000000000000099" }), // 今までの流れへ
      ],
      deps(w),
    );
    // 例外で止まる道・遅い開始・別の処理が扱っている途中・済み、のログも集める
    const wc = world();
    let crashes = 0;
    wc.replyImpl = () => {
      if (crashes++ === 0) throw new Error(`crash ${MSG} ${G}`);
      return { kind: "sent", messageId: "700000000000000009" };
    };
    await dispatchObiEvents([textEvent(MSG, "#J12 2")], deps(wc));
    const wl = world();
    wl.startedAt = T - 7_001;
    await dispatchObiEvents(
      [
        textEvent(MSG, "#J12 3ページ 2"),
        textEvent("600000000000000201", "3ページ 2", { quoted: NOTICE }),
      ],
      deps(wl),
    );
    for (const answer of [{ proceed: false, inProgress: true }, { proceed: false }]) {
      const wr = world();
      wr.reserveAnswer = answer;
      await dispatchObiEvents([textEvent(MSG, "#J12 3ページ 2")], deps(wr));
    }
    // ここまでに出たログだけを見る（この後の ok() の出力には、確かめ用にかぎを載せるため）
    const logs = [...logged];
    ok(
      "ログに message.id（訂正の発言・引用先・聞き返し）を出していない",
      logs.length >= 8 && !logs.some((l) => /\d{15,}/.test(l)),
      JSON.stringify(logs.filter((l) => /\d{15,}/.test(l))),
    );
    ok(
      "ログに groupId を出していない",
      !logs.some((l) => l.includes(G) || l.includes(G2)),
    );
    ok(
      "ログに出すのは段階と結果の code（受付番号 #J・番号・ページは出してよい）",
      logs.some((l) => l.includes("#J12") && l.includes("code=2") && l.includes("unknown:timeout")) &&
        logs.some((l) => l.includes("before-fix")) &&
        logs.some((l) => l.includes("in-progress")) &&
        logs.some((l) => l.includes("already-done")),
      JSON.stringify(logs),
    );
    const leaked = (s: string) => s.includes(SHIMO) || s.includes(OTHER);
    ok(
      "userId を portal に送っていない（URL・ヘッダ・本文）",
      w.sent.length >= 3 &&
        !w.sent.some(
          (s) => leaked(s.url) || leaked(s.headers) || leaked(s.body),
        ),
    );
    ok(
      "userId を KV に置いていない（かぎ・値）",
      w.kv.length >= 3 && !w.kv.some(leaked),
      JSON.stringify(w.kv),
    );
    ok(
      "userId をログ・返事に出していない",
      logs.length >= 3 &&
        !logs.some(leaked) &&
        !w.replies.some((r) => leaked(r.text)),
    );
    ok(
      "本文・リンク・例外の文をログに出していない",
      !logs.some(
        (l) => l.includes("3ページ 2") || l.includes("http") || l.includes("crash"),
      ),
    );
    ok(
      "訂正のかぎの期限は全部8日",
      w.kv
        .filter((k) => !k.startsWith("getText"))
        .every((k) => k.includes("obi-fix-") && k.endsWith(" 691200")),
      JSON.stringify(w.kv),
    );
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
