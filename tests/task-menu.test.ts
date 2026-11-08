/**
 * B1 メニューと未完了タスクのカード（task-menu.ts・postback の振り分け）。
 * Notion・LINE・KV は差し替え。外部へ通信したら失敗にする。
 */
import {
  buildListPage,
  FLEX_JSON_MAX,
  handleMenuAction,
  isMenuWord,
  menuActive,
  menuCard,
  MENU_TEXT,
  MSG_MINE_EMPTY,
  MSG_PREPARING,
  MSG_READ_FAILED,
  MSG_TODAY_EMPTY,
  selectToday,
  type MenuDeps,
  type MenuTask,
} from "../src/lib/task-menu";
import {
  encodeMenuData,
  MSG_PAUSED,
  parseButtonData,
  parseMenuData,
  type ButtonDeps,
} from "../src/lib/task-buttons";
import { cardActions, type FlexMessage } from "../src/lib/task-card";
import {
  handleTaskPostbackEvent,
  replyMenu,
} from "../src/lib/task-buttons-wire";
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
// Notion の SDK は globalThis.fetch ではなく node-fetch を使うので、SDK の入口も塞ぐ
let notionCalls = 0;
Client.prototype.request = (async () => {
  notionCalls++;
  throw new Error("このテストで Notion へ通信してはいけない");
}) as typeof Client.prototype.request;

const TODAY = "2026-11-09";
const U1 = `U${"1".padStart(32, "0")}`;
const U9 = `U${"9".padStart(32, "0")}`;
const pid = (n: number) =>
  `${String(n).padStart(8, "0")}-1234-1234-1234-1234567890ab`;
const task = (n: number, over: Partial<MenuTask> = {}): MenuTask => ({
  id: pid(n),
  title: `タスク${n}`,
  due: null,
  assignee: "杉山",
  nextCheck: null,
  ...over,
});

const setEnv = (on: {
  menu?: boolean;
  buttons?: boolean;
  followup?: boolean;
}) => {
  process.env.TASK_MENU = on.menu ? "1" : "";
  process.env.TASK_BUTTONS = on.buttons ? "1" : "";
  process.env.TASK_FOLLOWUP = on.followup ? "1" : "";
};
const allOn = () => setEnv({ menu: true, buttons: true, followup: true });

const carousel = (card?: FlexMessage) =>
  (card?.contents as {
    type?: string;
    contents?: Array<Record<string, unknown>>;
  }) ?? {};
const bubbleActions = (b: Record<string, unknown>) =>
  cardActions({ type: "flex", altText: "", contents: b });

(async () => {
  // ── スイッチ ──
  setEnv({});
  ok("off：既定は動かない", !menuActive());
  setEnv({ menu: true });
  ok("TASK_MENU だけでは動かない", !menuActive());
  setEnv({ menu: true, buttons: true });
  ok("TASK_FOLLOWUP が off なら動かない", !menuActive());
  setEnv({ buttons: true, followup: true });
  ok("TASK_MENU が off なら動かない", !menuActive());
  allOn();
  ok("3つとも on で動く", menuActive());

  // ── メニューの言葉 ──
  ok("「メニュー」", isMenuWord("メニュー"));
  ok("前後の空白", isMenuWord("  メニュー　"));
  ok("半角カナ", isMenuWord("ﾒﾆｭｰ"));
  ok("menu", isMenuWord("MENU"));
  ok(
    "ほかの言葉は違う",
    !isMenuWord("メニューを見せて") && !isMenuWord("") && !isMenuWord("候補"),
  );

  // ── data の形 ──
  ok("encode", encodeMenuData("lt", 10) === "v1|lt|10");
  ok(
    "parse lt 0",
    JSON.stringify(parseMenuData("v1|lt|0")) === '{"op":"lt","offset":0}',
  );
  ok("parse lm 20", parseMenuData("v1|lm|20")?.offset === 20);
  ok("10 の倍数でないオフセットは読まない", parseMenuData("v1|lt|5") === null);
  ok("先頭 0 は読まない", parseMenuData("v1|lt|010") === null);
  ok("上限より大きいオフセットは読まない", parseMenuData("v1|lt|510") === null);
  ok("知らない操作は読まない", parseMenuData("v1|lx|0") === null);
  ok(
    "タスクの data はメニューと読まない",
    parseMenuData(`v1|done|${pid(1)}`) === null,
  );
  ok("メニューの data はタスクと読まない", parseButtonData("v1|lt|0") === null);
  ok("追加つきは読まない", parseMenuData("v1|lt|0|x") === null);

  // ── メニューのカード ──
  const m = menuCard();
  const acts = cardActions(m);
  ok(
    "ボタンの順と文言",
    JSON.stringify(acts.map((a) => a.label)) ===
      JSON.stringify(["今日・期限切れ", "自分の未完了", "候補", "案件"]),
    JSON.stringify(acts.map((a) => a.label)),
  );
  ok(
    "ボタンの data",
    JSON.stringify(acts.map((a) => a.data)) ===
      JSON.stringify(["v1|lt|0", "v1|lm|0", "v1|lc|0", "v1|ld|0"]),
  );
  ok(
    "表示の文に番号・@ が無い",
    acts.every(
      (a) =>
        !/[0-9０-９@＠]/.test(a.displayText) &&
        a.displayText.startsWith("（ボタン）"),
    ),
  );
  ok("altText は 400 字以内", Array.from(m.altText).length <= 400);

  // ── 今日・期限切れの抽出（境界） ──
  const pool: MenuTask[] = [
    task(1, { due: "2026-11-10" }), // 明日 → 出ない
    task(2, { due: TODAY }), // 今日 → 出る
    task(3, { due: "2026-11-08" }), // 昨日 → 出る
    task(4, { due: "2026-11-20", nextCheck: TODAY }), // 確認日が今日 → 出る
    task(5, { due: "2026-11-20", nextCheck: "2026-11-10" }), // 確認日が明日 → 出ない
    task(6, { due: "2026-11-09T17:00:00+09:00" }), // 今日の日時 → 出る
    task(7, { due: "2026-11-01", closed: true }), // 完了 → 出ない
    task(8, { due: null, nextCheck: "2026-11-01" }), // 期日なし・確認日が過去 → 出る（後ろ）
    task(9, { due: "2026-11-05" }), // 期限切れ → 出る
  ];
  const sel = selectToday(pool, TODAY).map((t) => t.title);
  ok(
    "今日・昨日・確認日・日時つき（期日の早い順・期日なしは後ろ）",
    JSON.stringify(sel) ===
      JSON.stringify([
        "タスク9",
        "タスク3",
        "タスク2",
        "タスク6",
        "タスク4",
        "タスク8",
      ]),
    JSON.stringify(sel),
  );

  // ── 一覧の deps ──
  let calls: string[] = [];
  const mk = (tasks: MenuTask[], mine: MenuTask[] = []): MenuDeps => ({
    listToday: async (d) => {
      calls.push(`today:${d}`);
      return tasks;
    },
    listMine: async (ids) => {
      calls.push(`mine:${ids.length}`);
      return mine.filter((t) => ids.includes(t.assignee ?? ""));
    },
    aliasIds: async (u) => (u === U1 ? [U1, U9] : [u]),
    today: () => TODAY,
  });

  // 0件
  let r = await handleMenuAction({ op: "lt", offset: 0 }, U1, mk([]));
  ok("0件：文だけ", r.text === MSG_TODAY_EMPTY && !r.card);

  // 10件＋次の10件
  const many = Array.from({ length: 25 }, (_, i) =>
    task(i + 1, { due: `2026-11-${String((i % 9) + 1).padStart(2, "0")}` }),
  );
  calls = [];
  r = await handleMenuAction({ op: "lt", offset: 0 }, U1, mk(many));
  let c = carousel(r.card);
  ok("カルーセル", c.type === "carousel");
  ok(
    "10件＋［次の10件］で11枚",
    c.contents?.length === 11,
    String(c.contents?.length),
  );
  ok("載せたタスクは10件", r.pageIds.length === 10);
  const last = c.contents![10];
  const nextAct = bubbleActions(last)[0];
  ok(
    "最後のカードは［次の10件］",
    nextAct?.label === "次の10件" && nextAct.data === "v1|lt|10",
  );
  ok(
    "見出しの文",
    r.text === "📋 今日・期限切れのタスク（25件中 1〜10件目）",
    r.text,
  );
  const firstActs = bubbleActions(c.contents![0]);
  ok(
    "各タスクは今のタスクカード（5つのボタン・ID つき）",
    firstActs.length === 5 && firstActs[0].data === `v1|done|${r.pageIds[0]}`,
  );
  ok("期日の早い順", r.pageIds[0] === pid(1) && r.pageIds[1] === pid(10));
  ok("Notion は1回", calls.filter((x) => x.startsWith("today")).length === 1);

  r = await handleMenuAction({ op: "lt", offset: 20 }, U1, mk(many));
  c = carousel(r.card);
  ok(
    "最後のページは5件で［次の10件］なし",
    c.contents?.length === 5 && r.pageIds.length === 5,
  );
  r = await handleMenuAction({ op: "lt", offset: 30 }, U1, mk(many));
  ok("続きが無い", r.text === "続きのタスクはありません（全25件）" && !r.card);
  const exact10 = many.slice(0, 10);
  r = await handleMenuAction({ op: "lt", offset: 0 }, U1, mk(exact10));
  ok(
    "ちょうど10件なら［次の10件］なし",
    carousel(r.card).contents?.length === 10,
  );

  // JSON の大きさ（長い題名・長い担当名でも 30KB 未満）
  const big = Array.from({ length: 30 }, (_, i) =>
    task(i + 1, {
      title: "長".repeat(200),
      assignee: "名".repeat(100),
      due: TODAY,
    }),
  );
  const page = buildListPage("lt", big, 0, MSG_TODAY_EMPTY);
  const bytes = Buffer.byteLength(JSON.stringify(page.card!.contents), "utf8");
  ok("JSON は 30KB 未満", bytes < FLEX_JSON_MAX, String(bytes));
  ok("altText は 400 字以内", Array.from(page.card!.altText).length <= 400);
  ok(
    "ボタンのラベルは 40 字以内",
    (carousel(page.card).contents ?? []).every((b) =>
      bubbleActions(b).every((a) => Array.from(a.label).length <= 40),
    ),
  );

  // 自分の未完了
  calls = [];
  const mine = [
    task(1, { assignee: U1, due: "2026-11-12" }),
    task(2, { assignee: U9, due: "2026-11-10" }),
    task(3, { assignee: "Uother", due: "2026-11-01" }),
    task(4, { assignee: U1, due: null }),
  ];
  r = await handleMenuAction({ op: "lm", offset: 0 }, U1, mk([], mine));
  ok(
    "自分（名簿の別アカウントも）の分だけ・期日の早い順",
    JSON.stringify(r.pageIds) === JSON.stringify([pid(2), pid(1), pid(4)]),
    JSON.stringify(r.pageIds),
  );
  ok(
    "見出しの文",
    r.text.startsWith("📋 あなたが担当の未完了タスク（3件中"),
    r.text,
  );
  ok("Notion は1回", calls.filter((x) => x.startsWith("mine")).length === 1);
  r = await handleMenuAction({ op: "lm", offset: 0 }, "Unobody", mk([], mine));
  ok("担当が無い人", r.text === MSG_MINE_EMPTY && !r.card);
  r = await handleMenuAction({ op: "lm", offset: 0 }, undefined, mk([], mine));
  ok("userId が無い", r.text === MSG_MINE_EMPTY);

  // 候補・案件は準備中
  r = await handleMenuAction({ op: "lc", offset: 0 }, U1, mk([]));
  ok("候補は準備中", r.text === MSG_PREPARING && !r.card);
  r = await handleMenuAction({ op: "ld", offset: 0 }, U1, mk([]));
  ok("案件は準備中", r.text === MSG_PREPARING);
  r = await handleMenuAction({ op: "menu", offset: 0 }, U1, mk([]));
  ok("メニュー", r.text === MENU_TEXT && cardActions(r.card!).length === 4);

  // ── postback の振り分け（handleTaskPostbackEvent） ──
  const noTask: ButtonDeps = {
    getTask: async () => {
      throw new Error("タスクを読んではいけない");
    },
    members: async () => [],
    complete: async () => undefined,
    status: {
      update: async () => undefined,
      defaultCheckDate: async () => TODAY,
    },
    setAssignee: async () => undefined,
    today: () => TODAY,
    session: {
      clear: async () => undefined,
      syncAssignee: async () => undefined,
    },
  };
  let replies: Array<{ text: string; card?: FlexMessage }> = [];
  let logs: string[] = [];
  let refs: Array<[string, string]> = [];
  let reserved = 0;
  const store: CardRefStore = {
    set: async (k, v) => {
      refs.push([k, v]);
    },
    get: async () => null,
  };
  const io = (menu: MenuDeps) => ({
    deps: noTask,
    menu,
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
    log: (l: string) => logs.push(l),
  });
  const ev = (data: string) => ({
    type: "postback",
    replyToken: "rt",
    webhookEventId: "e1",
    source: { userId: U1, groupId: "Cg" },
    postback: { data },
  });
  const reset = () => {
    replies = [];
    logs = [];
    refs = [];
    reserved = 0;
  };

  allOn();
  reset();
  await handleTaskPostbackEvent(ev("v1|lt|0"), io(mk(many)));
  ok(
    "一覧：返事は1回・カルーセルつき",
    replies.length === 1 && carousel(replies[0].card).type === "carousel",
  );
  ok("一覧：予約は使わない（読むだけ）", reserved === 0);
  ok("一覧：2件以上は cardref を控えない", refs.length === 0);
  ok(
    "ログは操作名と件数だけ",
    logs.join() === "[task-menu] lt shown 10",
    logs.join(),
  );

  reset();
  await handleTaskPostbackEvent(
    ev("v1|lt|0"),
    io(mk([task(1, { due: TODAY })])),
  );
  ok(
    "一覧：1件だけなら text とカードの ID を cardref に控える",
    JSON.stringify(refs) ===
      JSON.stringify([
        ["cardref:T1", pid(1)],
        ["cardref:C1", pid(1)],
      ]),
    JSON.stringify(refs),
  );

  reset();
  await handleTaskPostbackEvent(
    ev("v1|lt|0"),
    io({
      ...mk([]),
      listToday: async () => {
        throw new Error("notion down");
      },
    }),
  );
  ok(
    "読めない：失敗の返事",
    replies.length === 1 && replies[0].text === MSG_READ_FAILED,
  );
  ok(
    "読めない：ログは符号だけ",
    logs.join() === "[task-menu] lt read-failed",
    logs.join(),
  );

  reset();
  await handleTaskPostbackEvent(ev("v1|lc|0"), io(mk([])));
  ok("候補ボタン：準備中", replies[0]?.text === MSG_PREPARING);

  // off：今と同じ（TASK_MENU だけ off ならタスクのボタンとして読み、「使えません」）
  setEnv({ buttons: true, followup: true });
  reset();
  await handleTaskPostbackEvent(ev("v1|lt|0"), io(mk(many)));
  ok(
    "TASK_MENU off：今と同じ「使えません」",
    replies.length === 1 &&
      replies[0].text === "⚠️ このボタンは使えません" &&
      !replies[0].card,
    JSON.stringify(replies),
  );
  ok(
    "TASK_MENU off：一覧は読まない",
    !logs.some((l) => l.includes("task-menu")),
  );
  setEnv({ menu: true });
  reset();
  await handleTaskPostbackEvent(ev("v1|lt|0"), io(mk(many)));
  ok(
    "ボタンが off：今と同じ「止めています」",
    replies.length === 1 && replies[0].text === MSG_PAUSED,
  );

  // メニューの返事（route.ts の入口）
  allOn();
  reset();
  await replyMenu("rt", {
    reply: async (_t, text, card) => {
      replies.push({ text, card });
      return "T1";
    },
    log: (l) => logs.push(l),
  });
  ok(
    "メニューの返事：文＋カード",
    replies[0]?.text === MENU_TEXT &&
      cardActions(replies[0].card!).length === 4,
  );

  ok("外部への通信は0回", fetchCalls === 0 && notionCalls === 0, `${fetchCalls}/${notionCalls}`);

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
