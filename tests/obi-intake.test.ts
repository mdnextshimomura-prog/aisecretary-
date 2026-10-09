/**
 * グループからの帯替えの受付の全体（設計 9〜15・14の2）。LINE・KV・portal は偽物。
 *
 * 途中で止まる場面は「依存の関数が例外を投げる」で表し、同じ控え（KV）のまま
 * もう一度呼ぶ（＝LINE の再送）ことで、返事が二重にならないことを確かめる。
 */
import { createHash } from "node:crypto";
import { runObiIntake, OBI_MESSAGES, type ObiIntakeDeps, type ObiIntakeInput } from "../src/lib/obi/intake";
import { createMemoryObiStore, recordObiPdf, type MemoryObiStore } from "../src/lib/obi/memo";
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
const U = "U" + "b".repeat(32);
const T = 1_760_000_000_000;
const REQ_ID = "600000000000000100";
const config: ObiConfig = {
  groupId: G,
  allowedUserIds: [U],
  portalBaseUrl: "https://portal.example.test",
  jobApiToken: "tok",
};
const enc = (s: string) => new TextEncoder().encode(s);
const pdf = (s: string) => enc(`%PDF-1.7\n${s}`);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ab = (u8: Uint8Array) => {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * AbortSignal.timeout(ms) の ms を覚えておく（portal の1回の時間の上限・push の時間の上限を確かめるため）。
 * 偽の時計の上で「時間切れまで待った」を表すのに使う。
 */
const timeoutOf = new WeakMap<AbortSignal, number>();
const origTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms: number) => {
  const s = origTimeout(ms);
  timeoutOf.set(s, ms);
  return s;
};

type PortalAnswer = Response | "timeout" | "refused" | ((form: FormData) => Promise<Response>);

interface World {
  store: MemoryObiStore;
  clock: { t: number };
  line: Record<string, Uint8Array | number>;
  lineDelayMs: number; // 1件取り出すごとに進める時間
  portal: PortalAnswer[]; // 呼ばれるたびに先頭から使う（最後の1つは使い回す）
  portalDelayMs: number;
  /** true なら portal は1回の時間の上限（AbortSignal.timeout）で時間切れになる（偽の時計もその分だけ進む） */
  portalHonorsTimeout: boolean;
  portalCalls: Array<{ at: number; ms: number | undefined }>;
  portalForms: FormData[];
  replyTimeouts: number[];
  pushTimeouts: number[];
  replies: string[];
  pushes: string[];
  replyMode: "sent" | "rejected" | "unknown" | "crash" | "crash-after-send";
  pushMode: "ok" | "fail" | "crash-after-send";
  committed: number;
}

function world(): World {
  const clock = { t: T + 1000 };
  return {
    store: createMemoryObiStore(() => clock.t),
    clock,
    line: {},
    lineDelayMs: 0,
    portal: [],
    portalDelayMs: 0,
    portalHonorsTimeout: false,
    portalCalls: [],
    portalForms: [],
    replyTimeouts: [],
    pushTimeouts: [],
    replies: [],
    pushes: [],
    replyMode: "sent",
    pushMode: "ok",
    committed: 0,
  };
}

/** portal の受付の成功応答（送られた PDF から一覧を作る） */
const accept = (no: number, status = 201) => async (form: FormData) => {
  const inputs = [];
  for (const f of form.getAll("files") as File[]) {
    const b = new Uint8Array(await f.arrayBuffer());
    inputs.push({ name: f.name, sha256: sha(b), size: b.byteLength });
  }
  return json(status, { no, status: "下準備中", created: status === 201, inputs });
};

function deps(w: World): ObiIntakeDeps {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const m = u.match(/message\/(\d+)\/content$/);
    if (m) {
      w.clock.t += w.lineDelayMs;
      const b = w.line[m[1]];
      if (b === undefined || typeof b === "number") return new Response("x", { status: typeof b === "number" ? b : 404 });
      return new Response(ab(b), { status: 200 });
    }
    if (u === "https://portal.example.test/api/jobs/intake") {
      w.portalForms.push(init?.body as FormData);
      const ms = init?.signal ? timeoutOf.get(init.signal) : undefined;
      w.portalCalls.push({ at: w.clock.t, ms });
      if (w.portalHonorsTimeout && ms !== undefined && w.portalDelayMs >= ms) {
        w.clock.t += ms;
        throw new DOMException("timed out", "TimeoutError");
      }
      w.clock.t += w.portalDelayMs;
      const a = w.portal.length > 1 ? w.portal.shift()! : w.portal[0];
      if (a === "timeout") throw new DOMException("timed out", "TimeoutError");
      if (a === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      if (typeof a === "function") return a(init?.body as FormData);
      return a.clone();
    }
    throw new Error(`想定外の宛先: ${u}`);
  }) as typeof fetch;
  return {
    store: w.store,
    fetchImpl,
    lineToken: "line-token",
    now: () => w.clock.t,
    reply: async (text: string, timeoutMs: number): Promise<ReplyOutcome> => {
      w.replyTimeouts.push(timeoutMs);
      if (w.replyMode === "crash") throw new Error("crash");
      w.replies.push(text);
      if (w.replyMode === "crash-after-send") throw new Error("crash");
      if (w.replyMode === "rejected") return { kind: "rejected", status: 400 };
      if (w.replyMode === "unknown") return { kind: "unknown" };
      return { kind: "sent", messageId: "bot-1" };
    },
    push: async (to: string, text: string, timeoutMs: number) => {
      w.pushTimeouts.push(timeoutMs);
      w.pushes.push(`${to}|${text}`);
      if (w.pushMode === "crash-after-send") throw new Error("crash");
      return w.pushMode === "ok";
    },
    onCommitted: () => {
      w.committed++;
    },
  };
}

const input = (over: Partial<ObiIntakeInput> = {}): ObiIntakeInput => ({
  requestMessageId: REQ_ID,
  requestTimestamp: T,
  groupId: G,
  requestText: "帯替え 架空邸",
  property: "架空邸",
  startedAt: T + 1000,
  config,
  ...over,
});

/** 控えに PDF を足し、LINE の偽物に中身を置く */
async function seed(w: World, items: Array<{ id: string; name: string; ago: number; body?: Uint8Array | number; size?: number }>) {
  for (const it of items) {
    await recordObiPdf(w.store, G, { messageId: it.id, fileName: it.name, size: it.size ?? 100, timestamp: T - it.ago, userId: U });
    w.line[it.id] = it.body ?? pdf(it.name);
  }
}
const run = (w: World, over: Partial<ObiIntakeInput> = {}) => runObiIntake(input(over), deps(w));

async function main() {
  // ── 正常：3件（うち1件は同じ中身）→ 2件を出た順に送り、受付の返事を1回 ──
  {
    const w = world();
    await seed(w, [
      { id: "600000000000000003", name: "b.pdf", ago: 60_000 },
      { id: "600000000000000002", name: "a.pdf", ago: 120_000 },
      { id: "600000000000000004", name: "a-copy.pdf", ago: 30_000, body: pdf("a.pdf") },
      { id: "600000000000000200", name: "later.pdf", ago: -5_000 }, // 依頼より後：使わない
    ]);
    w.portal = [accept(12)];
    const r = await run(w);
    ok("受付できた（済みにする・再送しない）", r.outcome === "accepted" && !r.retry && w.committed === 1, JSON.stringify(r));
    const files = (w.portalForms[0].getAll("files") as File[]).map((f) => f.name);
    ok("同じ中身は先に出たものだけ・出た順に送る", files.join() === "a.pdf,b.pdf", files.join());
    ok("portal に依頼の項目を渡す", w.portalForms[0].get("lineMessageId") === REQ_ID && w.portalForms[0].get("replyGroupId") === G && w.portalForms[0].get("property") === "架空邸");
    ok("assigneeName は portal に送らない", w.portalForms[0].get("assigneeName") === null);
    ok("受付の返事", w.replies.join("\n") === "#J12 受付しました（物件：架空邸／PDF：a.pdf ほか1件）。完成したらここにリンクを出します", w.replies.join("\n"));
  }

  // ── 物件名が無い依頼は最初の PDF の名前を物件名に ──
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "図面A.pdf", ago: 60_000 }]);
    w.portal = [accept(13)];
    await run(w, { property: "" });
    ok("物件名が空なら最初の PDF の名前", w.portalForms[0].get("property") === "図面A" && w.replies[0].includes("物件：図面A／PDF：図面A.pdf）"), w.replies[0]);
  }

  // ── portal に送る依頼文は UTF-16 の1000ユニットまで（絵文字を割らない） ──
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(15)];
    await run(w, { requestText: "a".repeat(999) + "😀" });
    const rt = String(w.portalForms[0].get("requestText"));
    ok("依頼文は1000ユニット以内に切って送る（絵文字は割らない）", rt === "a".repeat(999), String(rt.length));
  }

  // ── 返事に入れる名前は整える（改行を除き40文字まで） ──
  {
    const w = world();
    const longName = "長".repeat(30) + "\n" + "名".repeat(30) + ".pdf";
    await seed(w, [{ id: "600000000000000002", name: longName, ago: 60_000 }]);
    w.portal = [accept(14)];
    await run(w);
    const m = w.replies[0].match(/PDF：(.*)）。/);
    ok("返事のファイル名は改行なし・40文字まで", !!m && !m[1].includes("\n") && Array.from(m[1]).length === 40, w.replies[0]);
  }

  // ── 断る場面（portal を呼ばない） ──
  {
    const w = world();
    const r = await run(w);
    ok("PDF が無い", r.outcome === "refused" && w.replies[0] === OBI_MESSAGES.noPdf && w.portalForms.length === 0);
  }
  {
    const w = world();
    await seed(w, Array.from({ length: 21 }, (_, i) => ({ id: `60000000000000${String(i + 1).padStart(4, "0")}`, name: `${i}.pdf`, ago: 60_000 })));
    const r = await run(w);
    ok("21件以上は1件も使わずに断る", r.outcome === "refused" && w.replies[0] === OBI_MESSAGES.tooMany(21) && w.portalForms.length === 0);
  }
  {
    const w = world();
    await seed(w, [
      { id: "600000000000000002", name: "a.pdf", ago: 60_000, size: 20_000_000 },
      { id: "600000000000000003", name: "b.pdf", ago: 50_000, size: 5_000_001 },
    ]);
    const r = await run(w);
    ok("控えの大きさの合計が上限を超えたら断る", r.outcome === "refused" && w.replies[0] === OBI_MESSAGES.tooLarge);
  }
  {
    const w = world();
    await seed(w, [
      { id: "600000000000000002", name: "a.pdf", ago: 60_000 },
      { id: "600000000000000003", name: "b.pdf", ago: 50_000, body: 410 },
    ]);
    const r = await run(w);
    ok("1件でも取り出せなければ全体をやめる", r.outcome === "refused" && w.replies[0] === OBI_MESSAGES.fetchFailed("b.pdf") && w.portalForms.length === 0, w.replies[0]);
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000, body: enc("<html>") }]);
    await run(w);
    ok("PDF でなければやめる", w.replies[0] === OBI_MESSAGES.notPdf("a.pdf"));
  }
  {
    const w = world();
    const r = await run(w, { requestMessageId: "abc" });
    ok("依頼の id の形が違えば断る", r.outcome === "refused" && w.replies[0] === OBI_MESSAGES.rejected("INVALID_REQUEST"));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(40)];
    const r = await run(w, { requestTimestamp: undefined });
    ok("依頼の時刻が無ければ受付けない（今の時刻で代わりにしない）", r.outcome === "refused" && !r.retry && w.replies[0] === OBI_MESSAGES.noTimestamp && w.portalForms.length === 0 && w.committed === 0, w.replies.join("|"));
    const r2 = await run(w, { requestTimestamp: Number.NaN });
    ok("依頼の時刻が数でなくても受付けない", r2.outcome === "refused" && w.replies[1] === OBI_MESSAGES.noTimestamp && w.portalForms.length === 0);
  }

  // ── 時間の配分 ──
  {
    const w = world();
    await seed(w, [
      { id: "600000000000000002", name: "a.pdf", ago: 60_000 },
      { id: "600000000000000003", name: "b.pdf", ago: 50_000 },
    ]);
    w.lineDelayMs = 46_000; // 1件目で取り出しの締め切り（開始+45秒）を過ぎる
    const r = await run(w);
    ok("LINE の取得の時間切れは失敗（portal を呼ばない）", r.outcome === "refused" && w.replies[0] === OBI_MESSAGES.fetchFailed("b.pdf") && w.portalForms.length === 0, w.replies[0]);
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.lineDelayMs = 52_000; // 取り出しが長引き、portal に使える時間が5秒未満
    const r = await run(w);
    ok("portal に使える時間が無ければ送らずに断る", r.outcome === "refused" && w.replies[0] === OBI_MESSAGES.timeUp && w.portalForms.length === 0, w.replies[0]);
  }

  // ── portal の断り ──
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [json(409, { code: "OBI_BUSY", message: "busy", busyJobNo: 11 })];
    const r = await run(w);
    ok("前の帯替えを処理中（番号つき）", r.outcome === "refused" && !r.retry && w.committed === 0 && w.replies[0] === "前の帯替え（#J11）を処理中です。終わってからもう一度送ってください", w.replies[0]);
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [json(409, { code: "OBI_BUSY", message: "busy" })];
    await run(w);
    ok("番号が無ければ番号なしで", w.replies[0] === "前の帯替えを処理中です。終わってからもう一度送ってください");
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [json(503, { code: "INTAKE_STOPPED", message: "x" })];
    await run(w);
    ok("受付停止中", w.replies[0] === OBI_MESSAGES.stopped);
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [json(409, { code: "INTAKE_MISMATCH", message: "x" }), json(409, { code: "INTAKE_MISMATCH", message: "x" })];
    const r = await run(w);
    ok("portal の INTAKE_MISMATCH は「確かめられませんでした」（はっきりした断り＝済みにする・受付の返事は出さない）", r.outcome === "refused" && !r.retry && w.committed === 0 && w.replies[0] === OBI_MESSAGES.unconfirmed, w.replies[0]);
    w.clock.t = T + 70_000;
    const r2 = await run(w, { startedAt: w.clock.t });
    ok("同じ lineMessageId の INTAKE_MISMATCH を2回処理しても通知は1通（NX）", r2.outcome === "refused" && !r2.retry && w.committed === 0 && w.replies.length === 1 && w.pushes.length === 0, w.replies.join("|"));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    await w.store.setNx(`obi-unconfirmed-notified:${REQ_ID}`, 86400); // 既に送り済み
    w.portal = [json(409, { code: "INTAKE_MISMATCH", message: "x" })];
    const r = await run(w);
    ok("INTAKE_MISMATCH：NX が既にあれば送らない（済みにする・onCommitted は呼ばない）", r.outcome === "refused" && !r.retry && w.committed === 0 && w.replies.length === 0 && w.pushes.length === 0, JSON.stringify(r));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [json(409, { code: "INTAKE_MISMATCH", message: "x" })];
    const d = deps(w);
    d.store = {
      ...w.store,
      setNx: async () => {
        throw new Error("KV down");
      },
    };
    const r = await runObiIntake(input(), d);
    ok("INTAKE_MISMATCH：NX が例外なら送らない（二重を避ける）が、済みの扱い（refused・retry:false）は変えない", r.outcome === "refused" && !r.retry && w.committed === 0 && w.replies.length === 0 && w.pushes.length === 0, JSON.stringify(r));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [json(400, { code: "INVALID_REQUEST", message: "x" })];
    await run(w);
    ok("それ以外の断りは code を書く", w.replies[0] === OBI_MESSAGES.rejected("INVALID_REQUEST"));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = ["refused"];
    const r = await run(w);
    ok("portal につながらない（送る前の失敗が確か）", r.outcome === "refused" && !r.retry && w.replies[0] === OBI_MESSAGES.unreachable);
  }

  // ── 結果不明 → 締め切りの中でもう一度 ──
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = ["timeout", accept(15, 200)];
    const r = await run(w);
    ok("1回目が不明でも、2回目で分かればふつうに続ける", r.outcome === "accepted" && w.portalForms.length === 2 && w.replies[0].startsWith("#J15 受付しました"), w.replies.join("|"));
    ok("2回目も同じ lineMessageId・同じ PDF", w.portalForms[1].get("lineMessageId") === REQ_ID && (w.portalForms[1].getAll("files") as File[]).length === 1);
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = ["timeout", "refused"];
    const r = await run(w);
    ok("不明の後の「つながらない」は不明のまま（受付できなかったと言わない）", r.outcome === "pending" && r.retry && w.replies[0] === OBI_MESSAGES.pending, w.replies.join("|"));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [json(502, {})];
    w.portalDelayMs = 20_000; // 1回で20秒かかる → 2回目の後も残りは15秒あるが、3回目は呼ばない
    const r = await run(w);
    ok("結果不明：済みにせず再送を待つ・確かめ中の返事", r.outcome === "pending" && r.retry && w.committed === 0 && w.replies.join() === OBI_MESSAGES.pending);
    ok("portal は1回の Webhook で最大2回（最初＋呼び直し1回）", w.portalForms.length === 2, String(w.portalForms.length));

    // LINE の再送（同じ控え）：まだ不明 → 確かめ中の返事は二度と出さない
    w.clock.t = T + 70_000;
    const r2 = await run(w, { startedAt: w.clock.t });
    ok("再送でも不明なら、確かめ中の返事は出さない", r2.retry && w.replies.length === 1);

    // さらに再送：portal が同じ依頼を照合して 200 → 受付の返事を1回
    w.portal = [accept(16, 200)];
    w.portalDelayMs = 0;
    w.clock.t = T + 140_000;
    const r3 = await run(w, { startedAt: w.clock.t });
    ok("再送で結果が分かったらふつうに続ける", r3.outcome === "accepted" && !r3.retry && w.committed === 1 && w.replies[1].startsWith("#J16 受付しました"), w.replies.join("|"));
  }

  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = ["timeout", "timeout", accept(18)];
    const r = await run(w);
    ok("2回とも不明なら3回目は呼ばない（締め切りに余裕があっても）", r.outcome === "pending" && w.portalForms.length === 2, String(w.portalForms.length));
  }

  // ── 受付番号は返ったが一覧が合わない：済みにしない ──
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [json(201, { no: 17, inputs: [{ name: "a.pdf", sha256: "0".repeat(64), size: 1 }] })];
    const r = await run(w);
    ok("一覧が合わない：済みにせず（onCommitted を呼ばず）再送を待つ", r.outcome === "unconfirmed" && r.retry && w.committed === 0, JSON.stringify(r));
    ok("一覧が合わない：「確かめられませんでした」だけを返す（受付の返事は出さない）", w.replies.join("|") === OBI_MESSAGES.unconfirmed && !w.replies.some((t) => t.includes("受付しました")), w.replies.join("|"));
    w.clock.t = T + 70_000;
    const r2 = await run(w, { startedAt: w.clock.t });
    ok("一覧が合わない：再送でも返事は二度と出さない", r2.outcome === "unconfirmed" && w.replies.length === 1 && w.committed === 0);
  }
  {
    const w = world();
    await seed(w, [
      { id: "600000000000000002", name: "a.pdf", ago: 60_000 },
      { id: "600000000000000003", name: "b.pdf", ago: 50_000 },
    ]);
    w.portal = [
      async (form: FormData) => {
        const res = await accept(19)(form);
        const body = (await res.json()) as { inputs: unknown[] };
        return json(201, { no: 19, inputs: [body.inputs[0]] }); // 1件足りない
      },
    ];
    const r = await run(w);
    ok("一覧の件数が足りない：済みにしない", r.outcome === "unconfirmed" && w.committed === 0);
  }
  {
    const w = world();
    await seed(w, [
      { id: "600000000000000002", name: "a.pdf", ago: 60_000 },
      { id: "600000000000000003", name: "b.pdf", ago: 50_000 },
    ]);
    w.portal = [
      async (form: FormData) => {
        const res = await accept(22)(form);
        const body = (await res.json()) as { inputs: unknown[] };
        return json(200, { no: 22, inputs: [...body.inputs].reverse() }); // 初回の保存順で返った
      },
    ];
    const r = await run(w);
    ok("一覧の順番が違っても、sha256 の集合と件数が同じなら受付", r.outcome === "accepted" && w.committed === 1 && w.replies[0].startsWith("#J22 受付しました"));
  }

  // ── 受付の確定の後に、返事の印（NX）が KV の障害で置けない ──
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(23)];
    const d = deps(w);
    d.store = {
      ...w.store,
      setNx: async () => {
        throw new Error("KV down");
      },
    };
    const r = await runObiIntake(input(), d);
    ok("印が置けない：受付は済み・再送させない・返事も push も出さない", r.outcome === "accepted" && !r.retry && w.committed === 1 && w.replies.length === 0 && w.pushes.length === 0, JSON.stringify(r));
  }

  // ── 返事の送り方（reply → はっきり失敗のときだけ push） ──
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(20)];
    w.replyMode = "rejected";
    await run(w);
    ok("reply が 400 → push でグループへ送り直す", w.pushes.length === 1 && w.pushes[0].startsWith(`${G}|#J20 受付しました`), w.pushes.join("|"));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(21)];
    w.replyMode = "unknown";
    await run(w);
    ok("reply の結果が不明なら push しない（二重を避ける）", w.replies.length === 1 && w.pushes.length === 0);
  }

  // ── 途中で止まる場面（落ちた後に LINE が再送してくる） ──
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(30)];
    w.replyMode = "crash"; // NX を置いた直後、送る前に落ちる
    let crashed = false;
    await run(w).catch(() => (crashed = true));
    ok("NX の直後に落ちた：受付は確定済み", crashed && w.committed === 1);
    w.replyMode = "sent";
    w.portal = [accept(30, 200)];
    const r = await run(w);
    ok("NX の直後に落ちた：再送でも受付の返事は出さない（1通落ちるのは受け入れる・二重にしない）", r.outcome === "accepted" && w.replies.length === 0 && w.pushes.length === 0);
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(31)];
    w.replyMode = "crash-after-send"; // reply を送っている途中で落ちる
    await run(w).catch(() => undefined);
    w.replyMode = "sent";
    w.portal = [accept(31, 200)];
    await run(w);
    ok("reply の途中で落ちた：再送で二重に送らない", w.replies.length === 1 && w.pushes.length === 0, String(w.replies.length));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(32)];
    w.replyMode = "rejected";
    w.pushMode = "crash-after-send"; // reply 400 → push の途中で落ちる
    await run(w).catch(() => undefined);
    w.replyMode = "sent";
    w.pushMode = "ok";
    w.portal = [accept(32, 200)];
    await run(w);
    ok("reply 400 → push の途中で落ちた：再送で二重に送らない", w.replies.length === 1 && w.pushes.length === 1);
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = ["timeout"];
    w.portalDelayMs = 30_000;
    w.replyMode = "crash"; // 確かめ中の NX の直後に落ちる
    let crashed = false;
    await run(w).catch(() => (crashed = true));
    ok("確かめ中の NX の直後に落ちた：受付は確定していない", crashed && w.committed === 0);
    w.replyMode = "sent";
    w.portalDelayMs = 0;
    w.portal = [accept(33, 200)];
    w.clock.t = T + 100_000;
    const r = await run(w, { startedAt: w.clock.t });
    ok("その後の再送で受付が分かれば受付の返事は出す", r.outcome === "accepted" && w.replies.length === 1 && w.replies[0].startsWith("#J33"));
  }

  // ── 結果不明の後の断りは、はっきりした断りとして扱わない（自分の依頼が通っているかもしれない） ──
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = ["timeout", json(409, { code: "OBI_BUSY", message: "busy", busyJobNo: 11 })];
    const r = await run(w);
    ok("不明の後の OBI_BUSY は不明のまま（処理中の返事は出さない）", r.outcome === "pending" && r.retry && w.committed === 0 && w.replies.join("|") === OBI_MESSAGES.pending && !w.replies.some((t) => t.includes("処理中です")), w.replies.join("|"));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = ["timeout", json(503, { code: "INTAKE_STOPPED", message: "x" })];
    const r = await run(w);
    ok("不明の後の INTAKE_STOPPED は不明のまま", r.outcome === "pending" && r.retry && w.replies.join("|") === OBI_MESSAGES.pending, w.replies.join("|"));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = ["timeout", json(400, { code: "INVALID_REQUEST", message: "x" })];
    const r = await run(w);
    ok("不明の後のそれ以外の断りも不明のまま", r.outcome === "pending" && r.retry && w.replies.join("|") === OBI_MESSAGES.pending, w.replies.join("|"));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = ["timeout", json(409, { code: "INTAKE_MISMATCH", message: "x" })];
    const r = await run(w);
    ok("不明の後の INTAKE_MISMATCH は「確かめられませんでした」を1回・済みにする", r.outcome === "refused" && !r.retry && w.committed === 0 && w.replies.join("|") === OBI_MESSAGES.unconfirmed, w.replies.join("|"));
    w.portal = ["timeout", json(409, { code: "INTAKE_MISMATCH", message: "x" })];
    w.clock.t = T + 70_000;
    await run(w, { startedAt: w.clock.t });
    ok("不明の後の INTAKE_MISMATCH：再送でも通知は1通", w.replies.length === 1, w.replies.join("|"));
  }

  // ── portal の段階は開始から45秒で終える（maxDuration 60 の中に返事の時間を残す） ──
  for (const lineDelayMs of [0, 10_000, 17_000]) {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(50)];
    w.lineDelayMs = lineDelayMs;
    w.portalDelayMs = 600_000; // portal が返ってこない
    w.portalHonorsTimeout = true;
    const start = T + 1000;
    const r = await run(w);
    const ends = w.portalCalls.map((c) => c.at + (c.ms ?? Infinity));
    ok(`portal の段階は開始+45秒までに終わる（取り出し${lineDelayMs / 1000}秒）`, r.outcome === "pending" && w.portalCalls.length >= 1 && ends.every((e) => e <= start + 45_000) && w.clock.t <= start + 45_000, JSON.stringify(w.portalCalls.map((c) => [c.at - start, c.ms])));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(51)];
    w.lineDelayMs = 21_000; // 1回目は 21→41秒、残りは4秒
    w.portalDelayMs = 600_000;
    w.portalHonorsTimeout = true;
    const r = await run(w);
    ok("残りが5秒未満なら2回目は呼ばず、結果不明として再送を待つ", r.outcome === "pending" && r.retry && w.portalForms.length === 1 && w.replies.join("|") === OBI_MESSAGES.pending, `${w.portalForms.length} ${w.replies.join("|")}`);
  }

  // ── 返事の段階にも時間の上限を付ける ──
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(52)];
    w.replyMode = "rejected";
    await run(w);
    ok("reply と push は時間の上限つきで呼ぶ（5秒）", w.replyTimeouts.join() === "5000" && w.pushTimeouts.join() === "5000", `${w.replyTimeouts} ${w.pushTimeouts}`);
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [accept(53)];
    const d = deps(w);
    d.kvTimeoutMs = 20;
    d.store = { ...w.store, setNx: () => new Promise<boolean>(() => undefined) }; // KV が返ってこない
    const r = await runObiIntake(input(), d);
    ok("受付の返事の印（NX）が返ってこない：上限で打ち切り、返事は出さず再送もさせない", r.outcome === "accepted" && !r.retry && w.committed === 1 && w.replies.length === 0, JSON.stringify(r));
  }
  {
    const w = world();
    await seed(w, [{ id: "600000000000000002", name: "a.pdf", ago: 60_000 }]);
    w.portal = [json(502, {})];
    const d = deps(w);
    d.kvTimeoutMs = 20;
    d.store = { ...w.store, setNx: () => new Promise<boolean>(() => undefined) };
    let threw = false;
    await runObiIntake(input(), d).catch(() => (threw = true));
    ok("確かめ中の返事の印（NX）が返ってこない：上限で打ち切り、例外にして再送を待つ（返事は出さない）", threw && w.replies.length === 0 && w.committed === 0);
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
