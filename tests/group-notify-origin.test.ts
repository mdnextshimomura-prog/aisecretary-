/**
 * 営業部グループあての3つの通知（期限前・朝のリマインド・棚卸し）に、LINE WORKS 発のタスクを
 * 載せないことを確かめる（2026-11-15）。
 *   - LINE WORKS 発は出ない／グループ発は出る／発生元が空の古い行は出る
 *   - 番号は載せたものだけに 1 から続きで振る（文字の一覧・カード・Notion の番号が同じ並び）
 *   - 載せなかった LINE WORKS 発に残っていた古い番号は消す（同じ番号の取り違えを防ぐ）
 *   - 番号での検索（「N済」・番号での待ち／延期／不要）は LINE WORKS 発を「見つからない」にする
 *   - グループでのボタン・引用は LINE WORKS 発を「見つからない」にする（1対1はそのまま）
 * 外への通信は全部横取りする：LINE（fetch）・Notion（Client.prototype.request）。KV は未設定。
 * 実際の外部 API には一切つながない。値はどれもテスト用。
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { Client } from "@notionhq/client";
import { hideLineWorksInGroup, isLineWorksOrigin, originOf, splitForGroup } from "../src/lib/task-origin";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name}`);
};
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `→ ${JSON.stringify(a)}`);

const G = "C" + "a".repeat(32);
process.env.LINE_CHANNEL_SECRET = "test-channel-secret";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-access-token";
process.env.LINE_GROUP_ID = G;
process.env.NOTION_API_KEY = "test-notion";
process.env.NOTION_DATABASE_ID = "test-db";
for (const k of [
  "KV_REST_API_URL", "KV_REST_API_TOKEN", "KV_URL", "NOTION_CLOSURES_DATABASE_ID", "CLOSURE_DATES",
  "TASK_FOLLOWUP", "TASK_BUTTONS", "TASK_REMIND_CARDS", "TASK_MENU",
]) delete process.env[k];

// ── LINE（fetch）：push の本文を控える。LINE 以外は 404 ──
const pushes: string[] = [];
const otherFetch: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("api.line.me")) {
    if (url.includes("/message/push")) pushes.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ sentMessages: [{ id: "m1" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  otherFetch.push(url);
  return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
const socketCalls: string[] = [];
const block = (label: string) =>
  ((..._a: unknown[]) => {
    socketCalls.push(label);
    throw new Error(`テストでは外へつながない: ${label}`);
  }) as never;
(http as { request: unknown }).request = block("http.request");
(https as { request: unknown }).request = block("https.request");
(net as { connect: unknown }).connect = block("net.connect");
(net as { createConnection: unknown }).createConnection = block("net.createConnection");
(tls as { connect: unknown }).connect = block("tls.connect");

// ── Notion：手元の行を返し、書き込みは手元の行に反映して控える ──
interface Row {
  id: string;
  title: string;
  due: string;
  origin: string | null;
  number: number | null;
  notified: boolean;
  created: string;
  /** メッセージID（引用での特定に使う）。無ければ空 */
  messageId?: string;
}
let rows: Row[] = [];
const numberWrites: Array<[string, number | null]> = [];
const notifiedWrites: string[] = [];
/** その他の書き込み（完了・状況など）の対象ページ */
const otherWrites: string[] = [];
/** この ID のページへの番号の書き込みは失敗させる */
const failNumberWriteFor = new Set<string>();
/** 問い合わせの絞り込み条件の控え（中身を確かめる） */
const queryFilters: string[] = [];
/**
 * Notion の側の絞り込みをまねる：条件に「発生元が LINE WORKS でない（空は通す）」が入っていれば、
 * LINE WORKS 発を返さない。入っていなければ全部返す。1回に返すのは pageSize 件まで（has_more つき）。
 */
let pageSize = 100;
const NOT_LW_FILTER = JSON.stringify({
  or: [
    { property: "発生元", rich_text: { is_empty: true } },
    { property: "発生元", rich_text: { does_not_equal: "LINE WORKS" } },
  ],
});
const listOf = (matched: Row[], body: string) => {
  const kept = body.includes(NOT_LW_FILTER) ? matched.filter((r) => r.origin !== "LINE WORKS") : matched;
  return { object: "list", results: kept.slice(0, pageSize).map(page), has_more: kept.length > pageSize, next_cursor: kept.length > pageSize ? "next" : null };
};
const page = (r: Row) => ({
  id: r.id,
  url: `https://example.invalid/${r.id}`,
  created_time: r.created,
  properties: {
    名前: { title: [{ plain_text: r.title }] },
    期日: { date: r.due ? { start: r.due } : null },
    緊急度: { select: { name: "今日中" } },
    担当者: { select: { name: "担当 太郎" } },
    担当者ID: { rich_text: [] },
    依頼者ID: { rich_text: [] },
    メッセージID: { rich_text: r.messageId ? [{ plain_text: r.messageId }] : [] },
    ステータス: { select: { name: "未着手" } },
    発生元: { rich_text: r.origin ? [{ plain_text: r.origin }] : [] },
    リマインド番号: { number: r.number },
    通知済み: { checkbox: r.notified },
  },
});
Client.prototype.request = (async (args: { path: string; method: string; body?: unknown }) => {
  const body = JSON.stringify(args.body ?? {});
  if (args.method === "patch" && args.path.startsWith("pages/")) {
    const id = args.path.slice("pages/".length);
    const props = ((args.body ?? {}) as { properties?: Record<string, unknown> }).properties ?? {};
    const row = rows.find((r) => r.id === id);
    if ("リマインド番号" in props && failNumberWriteFor.has(id))
      throw new Error(`テスト用の失敗 ${id}`);
    if (!("リマインド番号" in props) && !("通知済み" in props)) otherWrites.push(id);
    if ("リマインド番号" in props) {
      const n = (props["リマインド番号"] as { number: number | null }).number;
      numberWrites.push([id, n]);
      if (row) row.number = n;
    }
    if ("通知済み" in props) {
      notifiedWrites.push(id);
      if (row) row.notified = true;
    }
    return { id, properties: {} };
  }
  if (args.method === "get" && args.path.startsWith("pages/")) {
    const row = rows.find((r) => r.id === args.path.slice("pages/".length));
    if (!row) throw Object.assign(new Error("not found"), { code: "object_not_found" });
    return page(row);
  }
  if (args.method === "post" && args.path.endsWith("/query")) {
    queryFilters.push(body);
    const filter = (args.body as { filter?: { and?: Array<Record<string, unknown>>; property?: string; rich_text?: { contains?: string } } }).filter;
    // 番号での検索（findTaskByRemindNumber）：その番号の行だけ返す
    const byNumber = filter?.and?.find((c) => c.property === "リマインド番号" && (c.number as { equals?: number })?.equals !== undefined);
    if (byNumber) {
      const n = (byNumber.number as { equals: number }).equals;
      return listOf(rows.filter((r) => r.number === n), body);
    }
    // メッセージID での検索（findTaskByMessageId）
    if (filter?.property === "メッセージID") {
      const m = filter.rich_text?.contains ?? "";
      return { object: "list", results: rows.filter((r) => r.messageId === m).map(page), has_more: false, next_cursor: null };
    }
    // 番号の掃除（clearStaleRemindNumbers）の問い合わせは、番号が入っている行だけ返す
    if (body.includes("is_not_empty"))
      return { object: "list", results: rows.filter((r) => r.number !== null).map(page), has_more: false, next_cursor: null };
    // 期限前の通知（getDueSoonTasks）は 1 ページだけ読む。ほかの取得は今までどおり全部返す
    if (body.includes("通知済み")) return listOf(rows, body);
    return { object: "list", results: rows.map(page), has_more: false, next_cursor: null };
  }
  return { object: "list", results: [], has_more: false, next_cursor: null, properties: {} };
}) as typeof Client.prototype.request;

const origLog = console.log;
console.log = (...a: unknown[]) => {
  if (String(a[0] ?? "").startsWith("✅") || String(a[0] ?? "").startsWith("❌")) origLog(...a);
};
const errors: string[] = [];
console.error = (...a: unknown[]) => {
  errors.push(a.map(String).join(" "));
};

const reset = () => {
  pushes.length = 0;
  numberWrites.length = 0;
  notifiedWrites.length = 0;
  otherWrites.length = 0;
  errors.length = 0;
  failNumberWriteFor.clear();
  queryFilters.length = 0;
  pageSize = 100;
};
/** push の本文（JSON 文字列）をつないだもの */
const sentText = () => pushes.join("\n");
const numbers = () => Object.fromEntries(rows.map((r) => [r.id, r.number]));

(async () => {
  // ── 判定そのもの ──
  eq("判定：LINE WORKS だけが外れる", [
    isLineWorksOrigin("LINE WORKS"), isLineWorksOrigin(" LINE WORKS "), isLineWorksOrigin(G),
    isLineWorksOrigin(null), isLineWorksOrigin(""), isLineWorksOrigin("LINE"),
  ], [true, true, false, false, false, false]);
  eq("読み方：欄なし・空は null", [
    originOf({}), originOf({ 発生元: { rich_text: [] } }),
    originOf({ 発生元: { rich_text: [{ plain_text: "LINE " }, { plain_text: "WORKS" }] } }),
  ], [null, null, "LINE WORKS"]);
  {
    const s = splitForGroup([{ id: "a", origin: G }, { id: "b", origin: "LINE WORKS" }, { id: "c", origin: null }]);
    eq("分け方：順番を変えずに分ける", [s.shown.map((t) => t.id), s.hidden.map((t) => t.id)], [["a", "c"], ["b"]]);
  }

  const { runDueReminders } = await import("../src/lib/remind-due");
  const { sendDailyReminders } = await import("../src/lib/remind");
  const { sendClosureStocktake } = await import("../src/lib/report");
  const { jstDateStr } = await import("../src/lib/notion");
  const today = jstDateStr(0);
  const OLD = "2026-01-05T01:00:00.000Z";
  const mk = (id: string, title: string, origin: string | null, number: number | null = null): Row => ({
    id, title, due: today, origin, number, notified: false, created: OLD,
  });
  const fresh = (): Row[] => [
    mk("p-group-1", "グループ発その1", G),
    mk("p-lw", "本人のLW仕事", "LINE WORKS", 2),
    mk("p-old", "発生元なしの古い行", null),
    mk("p-group-2", "グループ発その2", G),
  ];

  // ── 1. 期限前の通知 ──
  {
    rows = fresh();
    reset();
    const r = await runDueReminders(Date.parse(`${today}T17:30:00+09:00`));
    eq("期限前：送るのは LINE WORKS 発を除いた3件", r, { checked: 3, sent: 3 });
    ok("期限前：LINE WORKS 発の題名は出ない", !sentText().includes("本人のLW仕事"));
    ok("期限前：グループ発は出る", sentText().includes("グループ発その1") && sentText().includes("グループ発その2"));
    ok("期限前：発生元が空の古い行は出る", sentText().includes("発生元なしの古い行"));
    eq("期限前：通知済みの印は送った3件だけ", notifiedWrites, ["p-group-1", "p-old", "p-group-2"]);
    eq("期限前：送り先はグループだけ", pushes.every((b) => JSON.parse(b).to === G), true);
  }
  {
    rows = [mk("p-lw", "本人のLW仕事", "LINE WORKS")];
    reset();
    const r = await runDueReminders(Date.parse(`${today}T17:30:00+09:00`));
    eq("期限前：LINE WORKS 発だけなら何も送らない・印も付けない", [r, pushes.length, notifiedWrites], [{ checked: 0, sent: 0 }, 0, []]);
  }

  {
    // 未通知の LINE WORKS 発が先頭の1ページを埋めていても、後ろのグループ発・発生元なしを取りこぼさない
    rows = [
      mk("p-lw-1", "本人のLW仕事1", "LINE WORKS"), mk("p-lw-2", "本人のLW仕事2", "LINE WORKS"),
      mk("p-group-1", "グループ発その1", G), mk("p-old", "発生元なしの古い行", null),
    ];
    reset();
    pageSize = 2;
    const r = await runDueReminders(Date.parse(`${today}T17:30:00+09:00`));
    eq("期限前：LINE WORKS 発が1ページを埋めても、グループ発と発生元なしに届く", [r, notifiedWrites], [{ checked: 2, sent: 2 }, ["p-group-1", "p-old"]]);
    ok("期限前：絞り込み条件に「発生元が空、または LINE WORKS でない」が入っている", queryFilters.length === 1 && queryFilters[0].includes(NOT_LW_FILTER));
  }

  // ── 2. 朝のリマインド（今までの知らせ方：TASK_FOLLOWUP なし） ──
  {
    rows = fresh();
    reset();
    await sendDailyReminders();
    const t = sentText();
    ok("朝：LINE WORKS 発の題名は出ない", !t.includes("本人のLW仕事"));
    ok("朝：グループ発は出る", t.includes("1. グループ発その1") && t.includes("3. グループ発その2"));
    ok("朝：発生元が空の古い行は出る（番号は詰めて 2）", t.includes("2. 発生元なしの古い行"));
    eq("朝：番号は載せた順に 1,2,3。LINE WORKS 発の古い番号は消える", numbers(), {
      "p-group-1": 1, "p-lw": null, "p-old": 2, "p-group-2": 3,
    });
    eq("朝：通数は文字の一覧の1通だけ（カードは off）", pushes.length, 1);
  }
  // ── 2b. 朝のリマインド（本番と同じ：新しい知らせ方＋カード） ──
  {
    process.env.TASK_FOLLOWUP = "1";
    process.env.TASK_BUTTONS = "1";
    process.env.TASK_REMIND_CARDS = "1";
    rows = fresh();
    reset();
    await sendDailyReminders();
    eq("朝＋カード：文字の一覧とカードの2通", pushes.length, 2);
    const [text, card] = pushes;
    ok("朝＋カード：どちらにも LINE WORKS 発は出ない", !text.includes("本人のLW仕事") && !card.includes("本人のLW仕事") && !card.includes("p-lw"));
    ok("朝＋カード：文字の一覧の番号", text.includes("1. グループ発その1") && text.includes("2. 発生元なしの古い行") && text.includes("3. グループ発その2"));
    ok("朝＋カード：カードの番号は文字の一覧と同じ", card.includes("1. グループ発その1") && card.includes("2. 発生元なしの古い行") && card.includes("3. グループ発その2"));
    const pos = ["p-group-1", "p-old", "p-group-2"].map((id) => card.indexOf(id));
    ok("朝＋カード：ボタンの宛先（ページ）は番号と同じ並び", pos.every((p) => p >= 0) && pos[0] < pos[1] && pos[1] < pos[2], JSON.stringify(pos));
    eq("朝＋カード：Notion の番号も同じ。LINE WORKS 発は番号なし", numbers(), {
      "p-group-1": 1, "p-lw": null, "p-old": 2, "p-group-2": 3,
    });
    for (const k of ["TASK_FOLLOWUP", "TASK_BUTTONS", "TASK_REMIND_CARDS"]) delete process.env[k];
  }
  {
    rows = [mk("p-lw", "本人のLW仕事", "LINE WORKS", 2)];
    reset();
    await sendDailyReminders();
    eq("朝：LINE WORKS 発だけなら何も送らないが、古い番号は消す", [pushes.length, numberWrites], [0, [["p-lw", null]]]);
  }
  {
    rows = fresh();
    reset();
    failNumberWriteFor.add("p-lw");
    await sendDailyReminders();
    ok("朝：番号を消せなくても送信は続ける", pushes.length === 1 && !sentText().includes("本人のLW仕事"));
    eq("朝：消せなかったことを1行だけ残す（番号・ID・題名なし）", errors, ["[remind] hidden-number-clear-failed 1/1"]);
    errors.length = 0;
  }

  // ── 3. 棚卸し ──
  {
    rows = fresh();
    reset();
    const dry = await sendClosureStocktake("テスト休業", "2026-01-01", true);
    ok("棚卸し（下見）：LINE WORKS 発は出ない・件数にも数えない", !(dry.preview ?? "").includes("本人のLW仕事") && (dry.preview ?? "").includes("未完了 3件"));
    eq("棚卸し（下見）：送らない・書かない", [dry.sent, pushes.length, numberWrites], [false, 0, []]);

    const r = await sendClosureStocktake("テスト休業", "2026-01-01");
    const t = sentText();
    eq("棚卸し：3件を送る", [r.sent, r.before + r.during], [true, 3]);
    ok("棚卸し：LINE WORKS 発の題名は出ない", !t.includes("本人のLW仕事"));
    ok("棚卸し：グループ発は出る", t.includes("グループ発その1") && t.includes("グループ発その2"));
    ok("棚卸し：発生元が空の古い行は出る", t.includes("発生元なしの古い行"));
    const nums = numbers();
    eq("棚卸し：番号は載せた3件に 1〜3、LINE WORKS 発の古い番号は消える", [
      [nums["p-group-1"], nums["p-old"], nums["p-group-2"]].slice().sort(), nums["p-lw"],
    ], [[1, 2, 3], null]);
    ok("棚卸し：本文の番号と Notion の番号が同じ", rows.filter((x) => x.number !== null).every((x) => t.includes(`${x.number}. ${x.title}`)));
  }
  {
    rows = [mk("p-lw", "本人のLW仕事", "LINE WORKS")];
    reset();
    const r = await sendClosureStocktake("テスト休業", "2026-01-01");
    eq("棚卸し：LINE WORKS 発だけなら送らない", [r.sent, pushes.length], [false, 0]);
  }
  {
    rows = [mk("p-lw", "本人のLW仕事", "LINE WORKS", 2)];
    reset();
    const dry = await sendClosureStocktake("テスト休業", "2026-01-01", true);
    eq("棚卸し（下見）：0件でも書かない", [dry.sent, numberWrites], [false, []]);
    const r = await sendClosureStocktake("テスト休業", "2026-01-01");
    eq("棚卸し：LINE WORKS 発だけなら送らないが、古い番号は消す", [r.sent, pushes.length, numberWrites], [false, 0, [["p-lw", null]]]);
  }
  {
    rows = fresh();
    reset();
    failNumberWriteFor.add("p-lw");
    const r = await sendClosureStocktake("テスト休業", "2026-01-01");
    ok("棚卸し：番号を消せなくても送信は続ける", r.sent && !sentText().includes("本人のLW仕事"));
    eq("棚卸し：消せなかったことを1行だけ残す（番号・ID・題名なし）", errors, ["[report] hidden-number-clear-failed 1/1"]);
    errors.length = 0;
  }

  // ── 4. 番号での検索（「N済」・番号での待ち／延期／不要が使う） ──
  {
    const { findTaskByRemindNumber } = await import("../src/lib/notion");
    const { statusDeps } = await import("../src/lib/task-status-wire");
    const { applyStatusCommand } = await import("../src/lib/task-status");
    // 古い番号 2 が LINE WORKS 発に残ったまま、グループ発にも 2 が振られている（LINE WORKS 発が先に返る並び）
    rows = [mk("p-lw", "本人のLW仕事", "LINE WORKS", 2), mk("p-group-1", "グループ発その1", G, 2), mk("p-old", "発生元なしの古い行", null, 3)];
    reset();
    for (const anyDue of [true, false]) {
      eq(`番号検索：同じ番号でも LINE WORKS 発を飛ばして本来のタスクに当たる（anyDue=${anyDue}）`, await findTaskByRemindNumber(2, { anyDue }), { id: "p-group-1", title: "グループ発その1" });
    }
    ok("番号検索：グループからは、絞り込み条件で LINE WORKS 発を外している", queryFilters.length === 2 && queryFilters.every((f) => f.includes(NOT_LW_FILTER)));
    {
      // 同じ番号の LINE WORKS 発が1ページを埋めていても、本来のタスクを取り逃さない
      pageSize = 1;
      eq("番号検索：LINE WORKS 発が1ページを埋めても本来のタスクに当たる", (await findTaskByRemindNumber(2, { anyDue: true }))?.id, "p-group-1");
      pageSize = 100;
    }
    // 1対1（inGroup: false）は今までどおり引ける
    queryFilters.length = 0;
    eq("番号検索（1対1）：同じ番号が重なっていたら、知らせに載っているほうを使う", (await findTaskByRemindNumber(2, { anyDue: true, inGroup: false }))?.id, "p-group-1");
    ok("番号検索（1対1）：絞り込み条件で LINE WORKS 発を外さない", queryFilters.length === 1 && !queryFilters[0].includes("発生元"));
    eq("番号検索：発生元が空の古い行は今までどおり引ける", await findTaskByRemindNumber(3, { anyDue: true }), { id: "p-old", title: "発生元なしの古い行" });
    rows = [mk("p-lw", "本人のLW仕事", "LINE WORKS", 2)];
    eq("番号検索：LINE WORKS 発だけなら見つからない", [await findTaskByRemindNumber(2, { anyDue: true }), await findTaskByRemindNumber(2)], [null, null]);
    eq("番号検索（1対1）：LINE WORKS 発だけでも今までどおり引ける", await findTaskByRemindNumber(2, { anyDue: true, inGroup: false }), { id: "p-lw", title: "本人のLW仕事" });
    {
      const one = await applyStatusCommand({ kind: "wait", note: "テスト", date: "2026-12-01", numbers: [2] } as Parameters<typeof applyStatusCommand>[0], statusDeps(false));
      eq("番号での待ち（1対1）：LINE WORKS 発にも今までどおり書ける", [one.changed, otherWrites], [1, ["p-lw"]]);
      otherWrites.length = 0;
    }
    const r = await applyStatusCommand({ kind: "drop", numbers: [2] } as Parameters<typeof applyStatusCommand>[0], statusDeps(true));
    ok("番号での不要：LINE WORKS 発には書かない・題名を返さない", r.changed === 0 && !r.text.includes("本人のLW仕事") && r.text.includes("2番は見つかりませんでした") && otherWrites.length === 0, JSON.stringify([r, otherWrites]));
  }

  // ── 5. 過去のカードのボタン・引用（グループでは見つからない扱い。1対1はそのまま） ──
  {
    const { buttonDeps, getButtonTask, findQuotedTaskReal } = await import("../src/lib/task-buttons-wire");
    const { handleTaskButton, MSG_UNCONFIRMED } = await import("../src/lib/task-buttons");
    eq("判定：グループでだけ LINE WORKS 発を隠す", [
      hideLineWorksInGroup({ origin: "LINE WORKS" }, G), hideLineWorksInGroup({ origin: "LINE WORKS" }, undefined),
      hideLineWorksInGroup({ origin: G }, G), hideLineWorksInGroup({ origin: null }, G), hideLineWorksInGroup(null, G),
    ], [null, { origin: "LINE WORKS" }, { origin: G }, { origin: null }, null]);
    const LW = "11111111-2222-3333-4444-555555555555"; // ボタンの data に載る形（ページ ID）
    rows = [
      { ...mk(LW, "本人のLW仕事", "LINE WORKS"), messageId: "msg-lw" },
      { ...mk("p-group-1", "グループ発その1", G), messageId: "msg-g" },
      { ...mk("p-old", "発生元なしの古い行", null), messageId: "msg-old" },
    ];
    reset();
    eq("ボタン：グループでは LINE WORKS 発は見つからない", await getButtonTask(LW, G), null);
    eq("ボタン：1対1では今までどおり読める", (await getButtonTask(LW))?.title, "本人のLW仕事");
    eq("ボタン：グループ発・発生元が空の行はグループで読める", [(await getButtonTask("p-group-1", G))?.title, (await getButtonTask("p-old", G))?.title], ["グループ発その1", "発生元なしの古い行"]);
    const pressed = await handleTaskButton(`v1|done|${LW}`, "U" + "b".repeat(32), buttonDeps(G));
    ok("ボタン：グループで押されても題名を返さず、書かない", pressed !== null && pressed.text === MSG_UNCONFIRMED && pressed.changed === false && otherWrites.length === 0, JSON.stringify([pressed, otherWrites]));

    eq("引用：グループでは LINE WORKS 発は見つからない", await findQuotedTaskReal("msg-lw", G), null);
    eq("引用：1対1では今までどおり", (await findQuotedTaskReal("msg-lw"))?.title, "本人のLW仕事");
    eq("引用：グループ発・発生元が空の行はグループで見つかる", [(await findQuotedTaskReal("msg-g", G))?.id, (await findQuotedTaskReal("msg-old", G))?.id], ["p-group-1", "p-old"]);
  }

  eq("外への通信なし（LINE 以外の fetch・生のソケット）", [otherFetch, socketCalls], [[], []]);
  eq("本体のエラーなし", errors, []);
  if (fail) {
    origLog(`\n${fail} 件失敗`);
    process.exit(1);
  }
  origLog("\nすべて成功");
})();
