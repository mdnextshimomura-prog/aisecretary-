/**
 * B1 ボタンの入口（2026-11-08）：メニューのカードと、未完了タスクの一覧（カルーセル）。
 * スイッチは TASK_MENU（"1" かつ TASK_BUTTONS=1 かつ TASK_FOLLOWUP=1 のときだけ動く。既定 off。
 * off なら入口（route.ts）も postback も今と同じ）。
 *
 * - 入口：グループで「@秘書 メニュー」、または「@秘書」だけの発言（直前の資料が無いとき。
 *   資料つきの「@秘書」だけは今までどおりタスクの受付）。→ メニューのカード。
 * - メニューのボタン：［今日・期限切れ］［自分の未完了］［候補］［案件］。候補・案件は Task 2・3 で中身を作る
 *   （今は「準備中です」）。
 * - 一覧はタスク1件＝今のタスクカード（task-buttons.ts の taskCard）1枚。最大10枚＋［次の10件］。
 *   続きの目印はオフセット（data に Notion の start_cursor は入れない。押されたら引き直す）。
 *   一覧のカードのボタンは今のボタン処理（handleTaskButton）にそのままつながる。
 * - 押せる人：送り主の制限（webhook-source）を通ったグループの人なら誰でも（見るだけ）。
 *   タスクのボタンを押したあとの権限は今のまま（担当・依頼者・特権者）。
 * Notion は deps で受け取る（本物へのつなぎは task-menu-wire.ts）。
 * ログに出すのは操作名・件数・結果の符号だけ（題名・userId は出さない）。
 */
import {
  buttonsActive,
  encodeMenuData,
  MENU_PAGE_SIZE,
  taskCard,
  type MenuAction,
} from "./task-buttons";
import {
  ALT_TEXT_MAX,
  FLEX_LABEL_MAX,
  POSTBACK_TEXT_MAX,
  type FlexMessage,
} from "./task-card";

export function menuActive(): boolean {
  return process.env.TASK_MENU === "1" && buttonsActive();
}

/** カルーセルの JSON の上限（公式は 50KB、bubble は 30KB。下村さんの指定で 30KB 未満に収める） */
export const FLEX_JSON_MAX = 30_000;

export const MENU_TEXT = "📋 メニューです。見たいものを押してください";
export const MSG_TODAY_EMPTY = "今日・期限切れのタスクはありません";
export const MSG_MINE_EMPTY = "あなたが担当のタスクは見つかりませんでした";
export const MSG_PREPARING = "準備中です";
export const MSG_READ_FAILED =
  "⚠️ タスクを読み込めませんでした。少し時間をおいてもう一度お試しください。";

/** メニューのボタン（並び順もこのまま出す） */
export const MENU_BUTTONS: Array<{
  label: string;
  op: MenuAction["op"];
  displayText: string;
}> = [
  {
    label: "今日・期限切れ",
    op: "lt",
    displayText: "（ボタン）今日・期限切れ",
  },
  { label: "自分の未完了", op: "lm", displayText: "（ボタン）自分の未完了" },
  { label: "候補", op: "lc", displayText: "（ボタン）候補" },
  { label: "案件", op: "ld", displayText: "（ボタン）案件" },
];

const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");

/** 「@秘書 メニュー」の本文（メンションを除いたもの）か */
export function isMenuWord(text: string): boolean {
  const t = (text ?? "").normalize("NFKC").replace(/[\s　]/g, "");
  return t === "メニュー" || t.toLowerCase() === "menu";
}

/** route.ts の入口①：グループの「@秘書 メニュー」でメニューを返すか（off なら false＝今の流れのまま） */
export function menuWordEntry(o: {
  isGroup: boolean;
  mentionsBot: boolean;
  text: string;
}): boolean {
  return menuActive() && o.isGroup && o.mentionsBot && isMenuWord(o.text);
}

/**
 * route.ts の入口②：「@秘書」だけで直前の資料も無いとき、聞き返し（「どの案件について…」）の代わりに
 * メニューを返すか（off なら false＝今までどおり聞き返し。資料つきは受付のまま）
 */
export function bareMentionMenu(o: {
  isGroup: boolean;
  text: string;
  attachments: number;
}): boolean {
  return menuActive() && o.isGroup && !o.text && o.attachments === 0;
}

function button(
  label: string,
  data: string,
  displayText: string,
  primary = false,
) {
  return {
    type: "button",
    style: primary ? "primary" : "secondary",
    height: "sm",
    action: {
      type: "postback",
      label: cut(label, FLEX_LABEL_MAX),
      data,
      displayText: cut(displayText, POSTBACK_TEXT_MAX),
    },
  };
}

export function menuCard(): FlexMessage {
  return {
    type: "flex",
    altText: "【メニュー】今日・期限切れ／自分の未完了／候補／案件",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "メニュー", weight: "bold", size: "md" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: MENU_BUTTONS.map((b, i) =>
          button(b.label, encodeMenuData(b.op, 0), b.displayText, i === 0),
        ),
      },
    },
  };
}

/** 一覧に出すタスク。期日・次に確認する日は Notion の date.start の形 */
export interface MenuTask {
  id: string;
  title: string;
  due: string | null;
  assignee: string | null;
  nextCheck: string | null;
  /** 発生元（登録したグループの ID）。空なら null */
  origin?: string | null;
  /** ステータスが完了なら true（問い合わせで外すが、念のため手元でも外す） */
  closed?: boolean;
}

const day = (d: string | null | undefined) => (d ? d.slice(0, 10) : null);

/**
 * 今日・期限切れ：未完了で、期日（JST の日付）が今日以前か、次に確認する日が今日以前。
 * 次に確認する日が今日より先（待ち）のものは、期限切れでも出さない（朝のリマインド remind-select.ts と同じ考え方）。
 */
export function selectToday(tasks: MenuTask[], todayJst: string): MenuTask[] {
  return sortByDue(
    tasks.filter((t) => {
      if (t.closed) return false;
      const due = day(t.due);
      const check = day(t.nextCheck);
      if (check !== null && check > todayJst) return false;
      return (
        (due !== null && due <= todayJst) ||
        (check !== null && check <= todayJst)
      );
    }),
  );
}

/** 期日の早い順（期日の無いものは後ろ。同じなら元の順） */
export function sortByDue(tasks: MenuTask[]): MenuTask[] {
  return tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const da = a.t.due ?? "";
      const db = b.t.due ?? "";
      if (da && db && da !== db) return da < db ? -1 : 1;
      if (!da !== !db) return da ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.t);
}

function nextBubble(op: "lt" | "lm", nextOffset: number, rest: number) {
  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: "続きがあります", weight: "bold", size: "md" },
        {
          type: "text",
          text: `残り${rest}件`,
          size: "sm",
          color: "#888888",
          margin: "md",
        },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      contents: [
        button(
          "次の10件",
          encodeMenuData(op, nextOffset),
          "（ボタン）次の10件",
          true,
        ),
      ],
    },
  };
}

export interface ListPage {
  text: string;
  card?: FlexMessage;
  /** カルーセルに載せたタスクの ID（載せた順） */
  pageIds: string[];
}

const LIST_NAME: Record<"lt" | "lm", string> = {
  lt: "今日・期限切れのタスク",
  lm: "あなたが担当の未完了タスク",
};

/**
 * 一覧の1ページ（offset から最大10件）をカルーセルにする。11件目以降があれば最後に［次の10件］。
 * JSON が 30KB 以上になるなら、後ろのタスクを減らして［次の10件］で続きに回す。
 */
export function buildListPage(
  op: "lt" | "lm",
  tasks: MenuTask[],
  offset: number,
  emptyText: string,
): ListPage {
  const total = tasks.length;
  if (total === 0) return { text: emptyText, pageIds: [] };
  if (offset >= total) {
    return { text: `続きのタスクはありません（全${total}件）`, pageIds: [] };
  }
  let count = Math.min(MENU_PAGE_SIZE, total - offset);
  for (;;) {
    const shown = tasks.slice(offset, offset + count);
    const bubbles: unknown[] = shown.map(
      (t) =>
        taskCard({
          pageId: t.id,
          title: t.title,
          due: t.due,
          assignee: t.assignee,
        }).contents,
    );
    const end = offset + count;
    if (end < total) bubbles.push(nextBubble(op, end, total - end));
    const card: FlexMessage = {
      type: "flex",
      altText: cut(
        `【${LIST_NAME[op]}】${total}件（${offset + 1}〜${end}件目）`,
        ALT_TEXT_MAX,
      ),
      contents: { type: "carousel", contents: bubbles },
    };
    if (
      Buffer.byteLength(JSON.stringify(card.contents), "utf8") <
        FLEX_JSON_MAX ||
      count === 1
    ) {
      return {
        text: `📋 ${LIST_NAME[op]}（${total}件中 ${offset + 1}〜${end}件目）`,
        card,
        pageIds: shown.map((t) => t.id),
      };
    }
    count--;
  }
}

export interface MenuDeps {
  /** 今日・期限切れの候補（未完了。groupId があれば発生元がそのグループのものだけ。手元で selectToday をかけ直す） */
  listToday(todayJst: string, groupId: string | null): Promise<MenuTask[]>;
  /** 担当者ID がどれかの userId の未完了タスク（groupId があれば発生元がそのグループのものだけ） */
  listMine(userIds: string[], groupId: string | null): Promise<MenuTask[]>;
  /** 名簿で同じ人の別アカウントも含めた userId（分からなければ本人だけ） */
  aliasIds(userId: string): Promise<string[]>;
  today(): string;
}

/** メニューのボタン（postback）が押されたとき。Notion を読めなければ例外のまま返す。 */
/**
 * groupId：押したグループ（1対1なら undefined＝全体）。グループから押したときは、発生元がそのグループの
 * タスクだけを出す（発生元が空の古いタスクは出ない。安全優先）。問い合わせで絞り、手元でも絞り直す。
 */
export async function handleMenuAction(
  action: MenuAction,
  actorId: string | undefined,
  groupId: string | undefined,
  deps: MenuDeps,
): Promise<ListPage> {
  const g = groupId ?? null;
  const inGroup = (t: MenuTask) => !g || t.origin === g;
  switch (action.op) {
    case "menu":
      return { text: MENU_TEXT, card: menuCard(), pageIds: [] };
    case "lc":
    case "ld":
      return { text: MSG_PREPARING, pageIds: [] };
    case "lt": {
      const today = deps.today();
      const tasks = selectToday(
        (await deps.listToday(today, g)).filter(inGroup),
        today,
      );
      return buildListPage("lt", tasks, action.offset, MSG_TODAY_EMPTY);
    }
    case "lm": {
      if (!actorId) return { text: MSG_MINE_EMPTY, pageIds: [] };
      const ids = await deps.aliasIds(actorId).catch(() => [actorId]);
      const set = new Set(ids.length > 0 ? ids : [actorId]);
      const tasks = sortByDue(
        (await deps.listMine(Array.from(set), g)).filter(
          (t) => !t.closed && inGroup(t),
        ),
      );
      return buildListPage("lm", tasks, action.offset, MSG_MINE_EMPTY);
    }
  }
}
