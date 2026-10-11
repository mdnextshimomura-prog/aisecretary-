/**
 * 差し戻しの対応の選択の中身（認可〜/reject〜返事 runObiReject）を、偽物の KV・portal・LINE で確かめる
 * （設計 2026-10-11 の E12・E14・「うまくいかないとき」）。
 */
import { runObiReject, OBI_REJECT_MESSAGES, type ObiRejectInput, type ObiRejectTarget } from "../src/lib/obi/reject";
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
    // runObiReject は resolve も fix も呼ばない（resolve は対象を決める段階で済んでいる）
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
