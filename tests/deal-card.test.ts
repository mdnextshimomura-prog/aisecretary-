/**
 * B1 Task 3：案件をカードで見る（deal-card.ts・postback の振り分け・次の登録への反映）。
 * Notion・LINE・KV は差し替え。外部へ通信したら失敗にする。
 */
import {
  applyDealPick,
  buildDealPage,
  dealListPage,
  dealNextKey,
  dealWordEntry,
  DEAL_NEXT_TTL,
  encodeDealData,
  handleDealAction,
  isDealWord,
  MSG_DEAL_ADD,
  MSG_DEAL_ADD_GROUP_ONLY,
  MSG_DEAL_NOT_FOUND,
  MSG_DEAL_READ_FAILED,
  MSG_DEAL_TASKS_EMPTY,
  MSG_DEALS_EMPTY,
  parseDealData,
  pickedDealProps,
  summarizeDeals,
  takeDealPick,
  type DealDeps,
  type DealKv,
  type DealTask,
} from "../src/lib/deal-card";
import { recordAfterCreateWithPick } from "../src/lib/deal-card-wire";
import {
  FLEX_JSON_MAX,
  handleMenuAction,
  MSG_PREPARING,
  MSG_READ_FAILED,
  type MenuDeps,
  type MenuTask,
} from "../src/lib/task-menu";
import {
  parseButtonData,
  parseMenuData,
  type ButtonDeps,
} from "../src/lib/task-buttons";
import { cardActions, type FlexMessage } from "../src/lib/task-card";
import {
  handleTaskPostbackEvent,
  replyDealList,
} from "../src/lib/task-buttons-wire";
import { enrichTask, type DealRef } from "../src/lib/task-record";
import type { CardRefStore } from "../src/lib/card-ref";
import { Client } from "@notionhq/client";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};

let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("このテストで外部へ通信してはいけない");
}) as typeof fetch;
let notionCalls = 0;
Client.prototype.request = (async () => {
  notionCalls++;
  throw new Error("このテストで Notion へ通信してはいけない");
}) as typeof Client.prototype.request;
// KV の本物（@vercel/kv）にも行かせない：URL・TOKEN を消しておく（defaultDealKv が null になる）
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const U1 = `U${"1".padStart(32, "0")}`;
const U2 = `U${"2".padStart(32, "0")}`;
const did = (n: number) =>
  `${String(n).padStart(8, "0")}-aaaa-bbbb-cccc-1234567890ab`;
const tid = (n: number) =>
  `${String(n).padStart(8, "0")}-1234-1234-1234-1234567890ab`;
const deal = (
  n: number,
  name: string,
  phase: string | null = "交渉",
): DealRef => ({
  id: did(n),
  name,
  phase,
});
const dtask = (
  n: number,
  dealN: number[],
  over: Partial<DealTask> = {},
): DealTask => ({
  id: tid(n),
  title: `タスク${n}`,
  due: null,
  assignee: "杉山",
  nextCheck: null,
  origin: "Cg",
  dealIds: dealN.map(did),
  ...over,
});

const setEnv = (on: boolean) => {
  process.env.TASK_MENU = on ? "1" : "";
  process.env.TASK_BUTTONS = on ? "1" : "";
  process.env.TASK_FOLLOWUP = on ? "1" : "";
};

/** 呼ばれた回数を数える KV */
function fakeKv(init: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(init));
  const calls: string[] = [];
  const sets: Array<{ key: string; value: unknown; ex: number }> = [];
  const kv: DealKv = {
    get: async (k) => {
      calls.push(`get ${k}`);
      return data.get(k) ?? null;
    },
    set: async (k, v, ex) => {
      calls.push(`set ${k}`);
      sets.push({ key: k, value: v, ex });
      data.set(k, v);
    },
    del: async (k) => {
      calls.push(`del ${k}`);
      data.delete(k);
    },
  };
  return { kv, data, calls, sets };
}

const carousel = (card?: FlexMessage) =>
  (card?.contents as {
    type?: string;
    contents?: Array<Record<string, unknown>>;
  }) ?? {};
const bubbleText = (b: Record<string, unknown>) => JSON.stringify(b);

(async () => {
  // ── 言葉と入口 ──
  ok(
    "「案件」",
    isDealWord("案件") && isDealWord(" 案件　") && isDealWord("案件一覧"),
  );
  ok(
    "ほかの言葉は違う",
    !isDealWord("案件を見せて") && !isDealWord("") && !isDealWord("メニュー"),
  );
  setEnv(false);
  ok(
    "off：「@秘書 案件」は入口にしない",
    !dealWordEntry({ isGroup: true, mentionsBot: true, text: "案件" }),
  );
  setEnv(true);
  ok(
    "on：グループの「@秘書 案件」",
    dealWordEntry({ isGroup: true, mentionsBot: true, text: "案件" }),
  );
  ok(
    "メンションが無ければ入口にしない",
    !dealWordEntry({ isGroup: true, mentionsBot: false, text: "案件" }),
  );
  ok(
    "1対1は入口にしない",
    !dealWordEntry({ isGroup: false, mentionsBot: true, text: "案件" }),
  );

  // ── data の形 ──
  ok("encode dt", encodeDealData("dt", did(1)) === `v1|dt|${did(1)}`);
  ok(
    "encode dt＋オフセット",
    encodeDealData("dt", did(1), 10) === `v1|dt|${did(1)}|10`,
  );
  ok("encode da", encodeDealData("da", did(1)) === `v1|da|${did(1)}`);
  ok(
    "parse dt",
    JSON.stringify(parseDealData(`v1|dt|${did(1)}`)) ===
      JSON.stringify({ op: "dt", dealId: did(1), offset: 0 }),
  );
  ok(
    "parse dt 10",
    parseDealData(`v1|dt|${did(1)}|10`)?.op === "dt" &&
      (parseDealData(`v1|dt|${did(1)}|10`) as { offset: number }).offset === 10,
  );
  ok("parse da", parseDealData(`v1|da|${did(1)}`)?.op === "da");
  ok("da にオフセットは付けない", parseDealData(`v1|da|${did(1)}|10`) === null);
  ok(
    "ページ ID でなければ読まない",
    parseDealData("v1|dt|abc") === null && parseDealData("v1|da|1") === null,
  );
  ok(
    "オフセットの上限・形",
    parseDealData(`v1|dt|${did(1)}|510`) === null &&
      parseDealData(`v1|dt|${did(1)}|010`) === null,
  );
  ok("知らない操作は読まない", parseDealData(`v1|dx|${did(1)}`) === null);
  ok(
    "タスクのボタン・メニューの data とは重ならない",
    parseButtonData(`v1|dt|${did(1)}`) === null &&
      parseMenuData(`v1|da|${did(1)}`) === null &&
      parseDealData(`v1|done|${tid(1)}`) === null &&
      parseDealData("v1|ld|0") === null,
  );
  ok("data は300字以内", encodeDealData("dt", did(1), 500).length <= 300);

  // ── 並び順・数え方 ──
  const deals = [
    deal(1, "C物件"),
    deal(2, "A物件"),
    deal(3, "B物件"),
    deal(4, "D物件"),
    deal(5, "E物件"),
  ];
  const tasks = [
    dtask(1, [1], { due: "2026-11-20" }),
    dtask(2, [1], { due: "2026-11-12" }),
    dtask(3, [3], { due: "2026-11-15T10:00:00.000+09:00" }),
    dtask(4, [4]), // 期日の無いタスクだけ
    dtask(5, [2], { due: "2026-11-01", origin: "Cother" }), // 別グループ：数えない
    dtask(6, [1], { due: "2026-11-02", closed: true }), // 完了：数えない
    dtask(7, [3], { due: "2026-11-30" }),
  ];
  const s = summarizeDeals(deals, tasks, "Cg");
  ok(
    "並び：近い期日の早い順 → 期日の無いタスクだけの案件 → タスクの無い案件（名前順）",
    s.map((d) => d.name).join(",") === "C物件,B物件,D物件,A物件,E物件",
    s.map((d) => d.name).join(","),
  );
  const c = s.find((d) => d.name === "C物件")!;
  ok("残りタスク数（完了は数えない）", c.count === 2, String(c.count));
  ok(
    "近い期日（いちばん早いもの）",
    c.nearestDue === "2026-11-12",
    String(c.nearestDue),
  );
  const a = s.find((d) => d.name === "A物件")!;
  ok("別グループのタスクは数えない", a.count === 0 && a.nearestDue === null);
  ok(
    "期日の無いタスクも数に入る",
    s.find((d) => d.name === "D物件")!.count === 1,
  );
  const all = summarizeDeals(deals, tasks, null);
  ok(
    "1対1（groupId なし）は全体で数える",
    all.find((d) => d.name === "A物件")!.count === 1 && all[0].name === "A物件",
  );
  ok(
    "ID のハイフンの有無は同じ案件として数える",
    summarizeDeals(
      [deal(9, "X")],
      [dtask(1, [], { dealIds: [did(9).replace(/-/g, "")] })],
      "Cg",
    )[0].count === 1,
  );

  // ── カード ──
  const page = buildDealPage(s, 0);
  const car = carousel(page.card);
  ok(
    "カルーセル：案件5枚",
    car.type === "carousel" && car.contents?.length === 5,
  );
  const first = car.contents![0];
  const ft = bubbleText(first);
  ok(
    "カード：案件名・フェーズ・近い期日・残りタスク",
    ft.includes("C物件") &&
      ft.includes("交渉") &&
      ft.includes("近い期日") &&
      ft.includes("残りタスク") &&
      ft.includes("2件"),
  );
  const acts = cardActions({ type: "flex", altText: "", contents: first });
  ok(
    "ボタン［タスクを見る］［タスクを足す］",
    acts.length === 2 &&
      acts[0].label === "タスクを見る" &&
      acts[0].data === `v1|dt|${did(1)}` &&
      acts[1].label === "タスクを足す" &&
      acts[1].data === `v1|da|${did(1)}`,
    JSON.stringify(acts),
  );
  ok(
    "タスクの無い案件は「なし」「0件」",
    bubbleText(car.contents![4]).includes("なし") &&
      bubbleText(car.contents![4]).includes("0件"),
  );
  ok(
    "フェーズが空なら「未設定」",
    bubbleText(
      buildDealPage(summarizeDeals([deal(1, "X", null)], [], null), 0).card!
        .contents as unknown as Record<string, unknown>,
    ).includes("未設定"),
  );

  // 10件＋次の10件
  const many = Array.from({ length: 23 }, (_, i) =>
    deal(100 + i, `物件${String(i).padStart(2, "0")}`),
  );
  const sm = summarizeDeals(many, [], "Cg");
  const p0 = buildDealPage(sm, 0);
  const c0 = carousel(p0.card).contents!;
  ok("11件以上：10枚＋［次の10件］", c0.length === 11);
  const next = cardActions({ type: "flex", altText: "", contents: c0[10] });
  ok(
    "［次の10件］の data は v1|ld|10",
    next[0]?.data === "v1|ld|10",
    next[0]?.data,
  );
  const p2 = buildDealPage(sm, 20);
  ok(
    "最後のページは残りだけ・次は無し",
    carousel(p2.card).contents!.length === 3,
  );
  ok(
    "0件",
    buildDealPage([], 0).text === MSG_DEALS_EMPTY && !buildDealPage([], 0).card,
  );
  // JSON サイズ：長い名前でも 30KB 未満
  const big = summarizeDeals(
    Array.from({ length: 10 }, (_, i) =>
      deal(200 + i, "長".repeat(500) + i, "フ".repeat(300)),
    ),
    [],
    null,
  );
  const pb = buildDealPage(big, 0);
  ok(
    "JSON は 30KB 未満",
    Buffer.byteLength(JSON.stringify(pb.card!.contents), "utf8") <
      FLEX_JSON_MAX,
  );
  ok("altText は400字以内", pb.card!.altText.length <= 400);

  // ── 一覧（読めないとき）──
  const listDeps = (
    o: { dealsFail?: boolean; tasksFail?: boolean; deals?: DealRef[] } = {},
  ) => {
    const seen: Array<string | null> = [];
    return {
      seen,
      deps: {
        loadDeals: async () => {
          if (o.dealsFail) throw new Error("CRM_DEALS_DB_ID 未設定");
          return o.deals ?? deals;
        },
        listDealTasks: async (g: string | null) => {
          seen.push(g);
          if (o.tasksFail) throw new Error("x");
          return tasks;
        },
      },
    };
  };
  const ld1 = listDeps();
  const lp = await dealListPage(0, "Cg", ld1.deps);
  ok("一覧：タスクの問い合わせにグループを渡す", ld1.seen[0] === "Cg");
  ok("一覧：カルーセル", carousel(lp.card).contents?.length === 5);
  const lpf = await dealListPage(0, "Cg", listDeps({ dealsFail: true }).deps);
  ok(
    "案件を読めない → 「案件を読み取れませんでした」",
    lpf.text === MSG_DEAL_READ_FAILED && !lpf.card,
  );
  ok(
    "進行中の案件が0件",
    (await dealListPage(0, "Cg", listDeps({ deals: [] }).deps)).text ===
      MSG_DEALS_EMPTY,
  );
  let threw = false;
  await dealListPage(0, "Cg", listDeps({ tasksFail: true }).deps).catch(
    () => (threw = true),
  );
  ok("タスクを読めない → 例外（入口が「読み込めませんでした」）", threw);

  // ── メニューの［案件］──
  const baseMenu: MenuDeps = {
    listToday: async () => [],
    listMine: async () => [],
    aliasIds: async (u) => [u],
    today: () => "2026-11-09",
  };
  ok(
    "deals が無ければ準備中のまま",
    (await handleMenuAction({ op: "ld", offset: 0 }, U1, "Cg", baseMenu))
      .text === MSG_PREPARING,
  );
  let dealsArgs: unknown[] = [];
  const withDeals: MenuDeps = {
    ...baseMenu,
    deals: async (offset, g) => {
      dealsArgs = [offset, g];
      return buildDealPage(s, offset);
    },
  };
  const mr = await handleMenuAction(
    { op: "ld", offset: 10 },
    U1,
    "Cg",
    withDeals,
  );
  ok(
    "［案件］はグループとオフセットを渡す",
    dealsArgs[0] === 10 && dealsArgs[1] === "Cg" && mr.pageIds.length === 0,
  );

  // ── ［タスクを見る］──
  const mk = (
    o: { kv?: DealKv | null; ofDeal?: MenuTask[]; dealsFail?: boolean } = {},
  ) => {
    const asked: Array<[string, string | null]> = [];
    const d: DealDeps = {
      loadDeals: async () => {
        if (o.dealsFail) throw new Error("x");
        return deals;
      },
      listDealTasks: async () => tasks,
      listTasksOfDeal: async (id, g) => {
        asked.push([id, g]);
        return o.ofDeal ?? [];
      },
      kv: o.kv === undefined ? fakeKv().kv : o.kv,
    };
    return { d, asked };
  };
  const t1 = mk({
    ofDeal: [
      dtask(1, [1], { due: "2026-11-20" }),
      dtask(2, [1], { due: "2026-11-12" }),
      dtask(5, [1], { due: "2026-11-01", origin: "Cother" }),
      dtask(6, [1], { closed: true }),
    ],
  });
  const vr = await handleDealAction(
    { op: "dt", dealId: did(1), offset: 0 },
    U1,
    "Cg",
    t1.d,
  );
  ok(
    "タスクを見る：案件 ID とグループで問い合わせる",
    t1.asked[0][0] === did(1) && t1.asked[0][1] === "Cg",
  );
  ok(
    "タスクを見る：期日の早い順・別グループと完了は出さない",
    vr.pageIds.join(",") === [tid(2), tid(1)].join(","),
    vr.pageIds.join(","),
  );
  ok(
    "タスクを見る：今のタスクカード（済のボタン）",
    cardActions({
      type: "flex",
      altText: "",
      contents: carousel(vr.card).contents![0],
    })[0].data === `v1|done|${tid(2)}`,
  );
  const empty = await handleDealAction(
    { op: "dt", dealId: did(1), offset: 0 },
    U1,
    "Cg",
    mk().d,
  );
  ok("タスクを見る：0件", empty.text === MSG_DEAL_TASKS_EMPTY && !empty.card);
  const manyT = mk({
    ofDeal: Array.from({ length: 12 }, (_, i) => dtask(i + 1, [1])),
  });
  const vm = await handleDealAction(
    { op: "dt", dealId: did(1), offset: 0 },
    U1,
    "Cg",
    manyT.d,
  );
  const vmc = carousel(vm.card).contents!;
  ok(
    "タスクを見る：10枚＋［次の10件］は v1|dt|案件ID|10",
    vmc.length === 11 &&
      cardActions({ type: "flex", altText: "", contents: vmc[10] })[0].data ===
        `v1|dt|${did(1)}|10`,
  );

  // ── ［タスクを足す］──
  const k1 = fakeKv();
  const ar = await handleDealAction(
    { op: "da", dealId: did(1) },
    U1,
    "Cg",
    mk({ kv: k1.kv }).d,
  );
  ok("タスクを足す：文言", ar.text === MSG_DEAL_ADD);
  ok(
    "タスクを足す：印は dealnext:<groupId>:<userId>・10分",
    k1.sets.length === 1 &&
      k1.sets[0].key === `dealnext:Cg:${U1}` &&
      k1.sets[0].ex === DEAL_NEXT_TTL &&
      DEAL_NEXT_TTL === 600 &&
      (k1.sets[0].value as { dealId: string }).dealId === did(1),
    JSON.stringify(k1.sets),
  );
  const k2 = fakeKv();
  ok(
    "タスクを足す：進行中に無い案件は印を付けない",
    (
      await handleDealAction(
        { op: "da", dealId: did(99) },
        U1,
        "Cg",
        mk({ kv: k2.kv }).d,
      )
    ).text === MSG_DEAL_NOT_FOUND && k2.sets.length === 0,
  );
  ok(
    "タスクを足す：1対1では使えない",
    (
      await handleDealAction(
        { op: "da", dealId: did(1) },
        U1,
        undefined,
        mk({ kv: k2.kv }).d,
      )
    ).text === MSG_DEAL_ADD_GROUP_ONLY && k2.sets.length === 0,
  );
  ok(
    "タスクを足す：案件を読めない",
    (
      await handleDealAction(
        { op: "da", dealId: did(1) },
        U1,
        "Cg",
        mk({ kv: k2.kv, dealsFail: true }).d,
      )
    ).text === MSG_DEAL_READ_FAILED && k2.sets.length === 0,
  );
  ok(
    "タスクを足す：KV が無ければ受け付けない",
    (
      await handleDealAction(
        { op: "da", dealId: did(1) },
        U1,
        "Cg",
        mk({ kv: null }).d,
      )
    ).text.startsWith("⚠️"),
  );

  // ── 次の登録への反映 ──
  const logs: string[] = [];
  const log = (l: string) => logs.push(l);
  setEnv(false);
  const koff = fakeKv({ [dealNextKey("Cg", U1)]: { dealId: did(1) } });
  ok(
    "off：印を読まない（KV を呼ばない）",
    (await takeDealPick("Cg", U1, { kv: koff.kv, log })) === null &&
      koff.calls.length === 0,
  );
  setEnv(true);
  const kon = fakeKv({ [dealNextKey("Cg", U1)]: { dealId: did(1) } });
  ok(
    "on：印を読む",
    (await takeDealPick("Cg", U1, { kv: kon.kv, log })) === did(1),
  );
  ok(
    "ほかの人の印は使わない",
    (await takeDealPick("Cg", U2, { kv: kon.kv, log })) === null,
  );
  ok(
    "ほかのグループの印は使わない",
    (await takeDealPick("Cother", U1, { kv: kon.kv, log })) === null,
  );
  ok(
    "1対1は使わない",
    (await takeDealPick(undefined, U1, { kv: kon.kv, log })) === null,
  );
  ok(
    "期限切れ（KV から消えた）は使わない",
    (await takeDealPick("Cg", U1, { kv: fakeKv().kv, log })) === null,
  );
  ok(
    "形の違う印は使わない",
    (await takeDealPick("Cg", U1, {
      kv: fakeKv({ [dealNextKey("Cg", U1)]: { dealId: "x" } }).kv,
      log,
    })) === null,
  );

  const updates: Array<[string, Record<string, unknown>]> = [];
  const update = async (p: string, props: Record<string, unknown>) => {
    updates.push([p, props]);
  };
  const wrote = await applyDealPick(tid(1), did(1), "Cg", U1, {
    kv: kon.kv,
    update,
    log,
  });
  ok(
    "反映：案件と「確定」を書く",
    wrote &&
      JSON.stringify(updates[0]) ===
        JSON.stringify([tid(1), pickedDealProps(did(1))]),
  );
  ok(
    "反映：「確定」・relation",
    JSON.stringify(pickedDealProps(did(1))) ===
      JSON.stringify({
        案件の状態: { select: { name: "確定" } },
        案件: { relation: [{ id: did(1) }] },
      }),
  );
  ok("反映：印を消す", !kon.data.has(dealNextKey("Cg", U1)));
  const kfail = fakeKv({ [dealNextKey("Cg", U1)]: { dealId: did(1) } });
  const wf = await applyDealPick(tid(1), did(1), "Cg", U1, {
    kv: kfail.kv,
    update: async () => {
      throw new Error("no access");
    },
    log,
  });
  ok(
    "書けなくても印は消す（登録は成功している）",
    !wf && !kfail.data.has(dealNextKey("Cg", U1)),
  );
  ok(
    "ログに ID を出さない",
    logs.every(
      (l) => !l.includes(U1) && !l.includes(did(1)) && !l.includes(tid(1)),
    ),
    logs.join(" / "),
  );

  // recordAfterCreateWithPick：印があれば照合を飛ばす・TASK_RECORD off でも案件を書く
  const recCalls: Array<Record<string, unknown>> = [];
  const rec = async (_p: string, o: Record<string, unknown>) => {
    recCalls.push(o);
  };
  const base = {
    senderId: U1,
    groupId: "Cg",
    assignee: null,
    assigneeUserId: null,
    propertyKey: "key",
  };
  process.env.TASK_RECORD = "";
  updates.length = 0;
  const kr = fakeKv({ [dealNextKey("Cg", U1)]: { dealId: did(3) } });
  await recordAfterCreateWithPick(
    tid(9),
    base,
    { kv: kr.kv, update, log },
    rec as never,
  );
  ok("印あり：記録には dealPicked を渡す", recCalls[0]?.dealPicked === true);
  ok(
    "印あり：TASK_RECORD off でも案件を書く",
    updates.length === 1 &&
      JSON.stringify(updates[0][1]) === JSON.stringify(pickedDealProps(did(3))),
  );
  ok("印あり：登録後に印を消す", !kr.data.has(dealNextKey("Cg", U1)));
  updates.length = 0;
  await recordAfterCreateWithPick(
    tid(9),
    base,
    { kv: kr.kv, update, log },
    rec as never,
  );
  ok(
    "印なし（消えた後）：今までどおり（dealPicked=false・案件は書かない）",
    recCalls[1]?.dealPicked === false && updates.length === 0,
  );
  setEnv(false);
  const kr2 = fakeKv({ [dealNextKey("Cg", U1)]: { dealId: did(3) } });
  await recordAfterCreateWithPick(
    tid(9),
    base,
    { kv: kr2.kv, update, log },
    rec as never,
  );
  ok(
    "off：KV を呼ばず・案件を書かない",
    kr2.calls.length === 0 &&
      updates.length === 0 &&
      recCalls[2]?.dealPicked === false,
  );
  setEnv(true);

  // enrichTask：dealPicked なら照合しない
  let loaded = 0;
  const eUpdates: Array<Record<string, unknown>> = [];
  const er = await enrichTask(
    tid(1),
    {
      requester: "A",
      requesterId: U1,
      groupId: "Cg",
      assigneeNotionUserId: null,
      propertyKey: "key",
      dealPicked: true,
    },
    {
      loadDeals: async () => {
        loaded++;
        return deals;
      },
      update: async (_p, props) => {
        eUpdates.push(props);
      },
      note: async () => undefined,
      warn: () => undefined,
    },
  );
  ok(
    "記録：人が選んだ案件があれば照合しない",
    loaded === 0 &&
      er.deal === "picked" &&
      eUpdates.every((u) => !("案件" in u) && !("案件の状態" in u)),
  );
  ok("記録：発生元などはいつもどおり書く", er.origin === true);

  // ── postback の振り分け ──
  const noTask: ButtonDeps = {
    getTask: async () => {
      throw new Error("タスクを読んではいけない");
    },
    members: async () => [],
    complete: async () => undefined,
    status: {
      update: async () => undefined,
      defaultCheckDate: async () => "2026-11-09",
    },
    setAssignee: async () => undefined,
    today: () => "2026-11-09",
    session: {
      clear: async () => undefined,
      syncAssignee: async () => undefined,
    },
  };
  let replies: Array<{ text: string; card?: FlexMessage }> = [];
  let plogs: string[] = [];
  let refs: Array<[string, string]> = [];
  let reserved = 0;
  const store: CardRefStore = {
    set: async (k, v) => {
      refs.push([k, v]);
    },
    get: async () => null,
  };
  const io = (deal: DealDeps) => ({
    deps: noTask,
    deal,
    menu: baseMenu,
    reserve: async () => {
      reserved++;
      return { proceed: true };
    },
    complete: async () => undefined,
    reply: async (_t: string, text: string, card?: FlexMessage) => {
      replies.push({ text, card });
      return { textId: "T1", cardId: card ? "C1" : null };
    },
    cardRefs: store,
    log: (l: string) => plogs.push(l),
  });
  const ev = (data: string, groupId: string | undefined = "Cg") => ({
    type: "postback",
    replyToken: "rt",
    webhookEventId: "e1",
    source: { userId: U1, groupId },
    postback: { data },
  });
  const reset = () => {
    replies = [];
    plogs = [];
    refs = [];
    reserved = 0;
  };

  setEnv(true);
  reset();
  await handleTaskPostbackEvent(ev(`v1|dt|${did(1)}`), io(t1.d));
  ok(
    "postback：タスクを見る → カルーセル1回・予約なし",
    replies.length === 1 &&
      carousel(replies[0].card).type === "carousel" &&
      reserved === 0,
  );
  ok("postback：2件以上は cardref に控えない", refs.length === 0);
  ok(
    "postback：ログは操作名と件数だけ",
    plogs.join("|") === "[task-menu] dt shown 2",
    plogs.join("|"),
  );
  reset();
  const one = mk({ ofDeal: [dtask(1, [1])] });
  await handleTaskPostbackEvent(ev(`v1|dt|${did(1)}`), io(one.d));
  ok(
    "postback：1件だけなら cardref に控える",
    refs.length === 2 && refs.every(([, v]) => v === tid(1)),
  );
  reset();
  const kp = fakeKv();
  await handleTaskPostbackEvent(ev(`v1|da|${did(1)}`), io(mk({ kv: kp.kv }).d));
  ok(
    "postback：タスクを足す → 文言・印",
    replies[0]?.text === MSG_DEAL_ADD &&
      !replies[0].card &&
      kp.sets.length === 1 &&
      reserved === 0,
  );
  ok(
    "postback：ログに ID を出さない",
    plogs.every((l) => !l.includes(U1) && !l.includes(did(1))),
    plogs.join("|"),
  );
  reset();
  await handleTaskPostbackEvent(
    ev(`v1|dt|${did(1)}`),
    io({
      ...t1.d,
      listTasksOfDeal: async () => {
        throw new Error("x");
      },
    }),
  );
  ok(
    "postback：タスクを読めない → 読み込めませんでした",
    replies[0]?.text === MSG_READ_FAILED,
  );

  // off：案件の data は今までどおりタスクのボタンへ（「使えません」）、案件の部品は呼ばない
  setEnv(false);
  process.env.TASK_BUTTONS = "1";
  process.env.TASK_FOLLOWUP = "1";
  reset();
  let touched = 0;
  const spy: DealDeps = {
    loadDeals: async () => {
      touched++;
      return deals;
    },
    listDealTasks: async () => {
      touched++;
      return [];
    },
    listTasksOfDeal: async () => {
      touched++;
      return [];
    },
    kv: {
      get: async () => {
        touched++;
        return null;
      },
      set: async () => {
        touched++;
      },
      del: async () => {
        touched++;
      },
    },
  };
  await handleTaskPostbackEvent(ev(`v1|da|${did(1)}`), io(spy));
  ok("off：案件の部品を呼ばない", touched === 0);
  ok(
    "off：今までどおり「このボタンは使えません」",
    replies[0]?.text === "⚠️ このボタンは使えません",
    replies[0]?.text,
  );

  // 「@秘書 案件」への返事
  setEnv(true);
  reset();
  await replyDealList("rt", "Cg", {
    reply: async (_t: string, text: string, card?: FlexMessage) => {
      replies.push({ text, card });
      return { textId: "T1", cardId: null };
    },
    log: (l) => plogs.push(l),
    deal: mk().d,
  });
  ok(
    "「@秘書 案件」：案件のカルーセル",
    carousel(replies[0]?.card).contents?.length === 5 &&
      plogs[0] === "[task-menu] ld shown 5",
    plogs.join("|"),
  );
  reset();
  await replyDealList("rt", "Cg", {
    reply: async (_t: string, text: string, card?: FlexMessage) => {
      replies.push({ text, card });
      return { textId: "T1", cardId: null };
    },
    log: (l) => plogs.push(l),
    deal: mk({ dealsFail: true }).d,
  });
  ok(
    "「@秘書 案件」：読めない → 案件を読み取れませんでした",
    replies[0]?.text === MSG_DEAL_READ_FAILED,
  );

  ok(
    "外部への通信は0回",
    fetchCalls === 0 && notionCalls === 0,
    `${fetchCalls}/${notionCalls}`,
  );

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
