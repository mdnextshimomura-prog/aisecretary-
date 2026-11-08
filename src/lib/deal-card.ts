/**
 * B1 Task 3（2026-11-08）：案件をカードで見る。スイッチは TASK_MENU（menuActive。off なら入口も postback も今と同じ）。
 *
 * - 入口：メニューの［案件］（`v1|ld|オフセット`）と「@秘書 案件」。
 *   進行中（フェーズ ≠ 完了・失注）の CRM_案件 を1件1枚、最大10枚＋［次の10件］。
 *   並びは「いちばん近い未完了タスクの期日」の早い順 → タスクはあるが期日が無い案件（名前順）→ タスクの無い案件（名前順）。
 * - カード：案件名・フェーズ・近い期日・残りタスク数。ボタン［タスクを見る］（`v1|dt|案件ID[|オフセット]`）
 *   ［タスクを足す］（`v1|da|案件ID`）。案件 ID は Notion のページ ID（PAGE_ID_RE で確かめる）。
 * - 残りタスク数・近い期日は、一覧（task-menu.ts）と同じく押したグループの `発生元` で絞って数える
 *   （別グループのタスクの件数を見せない）。案件そのもの（名前・フェーズ）は社内の CRM なので絞らない。
 * - ［タスクを足す］：KV に `dealnext:<groupId>:<userId>` = 案件 ID（10分）。その人の次の @秘書 の依頼の
 *   登録が成功したら、`案件` を入れて `案件の状態` を「確定」にする（印は GETDEL で取ると同時に消す。applyDealPick）。
 *   TASK_RECORD の自動の照合より優先（照合は飛ばす）。TASK_RECORD が off でも案件だけは書く。
 * - CRM_案件 の欄には書かない（読むだけ）。読めなければ「案件を読み取れませんでした」。
 * Notion・KV は deps で受け取る（本物は deal-card-wire.ts）。ログは操作名・件数・符号だけ（案件名・userId は出さない）。
 */
import {
  menuActive,
  buildListPage,
  FLEX_JSON_MAX,
  nextBubble,
  sortByDue,
  type ListPage,
  type MenuTask,
} from "./task-menu";
import { MENU_OFFSET_MAX, MENU_PAGE_SIZE, PAGE_ID_RE } from "./task-buttons";
import {
  ALT_TEXT_MAX,
  FLEX_LABEL_MAX,
  formatDue,
  POSTBACK_TEXT_MAX,
  type FlexMessage,
} from "./task-card";
import type { DealRef } from "./task-record";

export const MSG_DEALS_EMPTY = "進行中の案件はありません";
export const MSG_DEAL_READ_FAILED = "案件を読み取れませんでした";
export const MSG_DEAL_TASKS_EMPTY = "この案件の未完了タスクはありません";
export const MSG_DEAL_ADD =
  "このあと「@秘書 内容」と送ると、この案件のタスクとして登録します（10分間）";
export const MSG_DEAL_NOT_FOUND =
  "この案件は見つかりませんでした（完了・失注になったか、消えています）";
export const MSG_DEAL_ADD_GROUP_ONLY =
  "［タスクを足す］はグループの中で使えます";
export const MSG_DEAL_ADD_FAILED =
  "⚠️ 受け付けられませんでした。少し時間をおいてもう一度お試しください。";

/** ［タスクを足す］の印の期限（秒） */
export const DEAL_NEXT_TTL = 10 * 60;
const DEAL_NAME_MAX = 60;

const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");
const normId = (id: string) => id.replace(/-/g, "").toLowerCase();

/** 「@秘書 案件」の本文（メンションを除いたもの）か */
export function isDealWord(text: string): boolean {
  const t = (text ?? "").normalize("NFKC").replace(/[\s　]/g, "");
  return t === "案件" || t === "案件一覧";
}

/** route.ts の入口：グループの「@秘書 案件」で案件のカードを返すか（off なら false＝今の流れのまま） */
export function dealWordEntry(o: {
  isGroup: boolean;
  mentionsBot: boolean;
  text: string;
}): boolean {
  return menuActive() && o.isGroup && o.mentionsBot && isDealWord(o.text);
}

// ── data（`v1|操作|ID[|オフセット]`）──
export type DealAction =
  { op: "dt"; dealId: string; offset: number } | { op: "da"; dealId: string };

export function encodeDealData(
  op: "dt" | "da",
  dealId: string,
  offset?: number,
): string {
  return [
    "v1",
    op,
    dealId,
    ...(op === "dt" && offset ? [String(offset)] : []),
  ].join("|");
}

/** 案件のボタンの data を読む。形が違えば null（メニュー・タスクのボタンは別の読み方） */
export function parseDealData(data: string): DealAction | null {
  if (!data || data.length > 300) return null;
  const parts = data.split("|");
  if (parts[0] !== "v1" || parts.length < 3 || parts.length > 4) return null;
  const [, op, dealId, extra] = parts;
  if (!PAGE_ID_RE.test(dealId)) return null;
  if (op === "da") return extra === undefined ? { op, dealId } : null;
  if (op !== "dt") return null;
  if (extra === undefined) return { op, dealId, offset: 0 };
  if (!/^(0|[1-9][0-9]{0,2})$/.test(extra)) return null;
  const offset = Number(extra);
  if (offset > MENU_OFFSET_MAX) return null;
  return { op, dealId, offset };
}

// ── 並び・数え方 ──
/** 案件のある未完了タスク（数えるための形） */
export interface DealTask extends MenuTask {
  /** タスクの `案件`（relation）のページ ID */
  dealIds: string[];
}

export interface DealSummary {
  id: string;
  name: string;
  phase: string | null;
  /** 残りタスク数（押したグループの発生元で絞ったもの） */
  count: number;
  /** いちばん近い未完了タスクの期日（Notion の date.start の形）。無ければ null */
  nearestDue: string | null;
}

/**
 * 案件ごとに、残りタスク数といちばん近い期日を数えて並べる。
 * groupId があれば、発生元がそのグループのタスクだけを数える（手元でも絞り直す）。
 */
export function summarizeDeals(
  deals: DealRef[],
  tasks: DealTask[],
  groupId: string | null,
): DealSummary[] {
  const by = new Map<string, { count: number; due: string | null }>();
  for (const t of tasks) {
    if (t.closed) continue;
    if (groupId && t.origin !== groupId) continue;
    for (const d of Array.from(new Set(t.dealIds.map(normId)))) {
      const cur = by.get(d) ?? { count: 0, due: null };
      cur.count++;
      if (t.due && (cur.due === null || t.due < cur.due)) cur.due = t.due;
      by.set(d, cur);
    }
  }
  const list = deals.map((d) => {
    const s = by.get(normId(d.id));
    return {
      id: d.id,
      name: d.name,
      phase: d.phase ?? null,
      count: s?.count ?? 0,
      nearestDue: s?.due ?? null,
    };
  });
  const rank = (s: DealSummary) => (s.nearestDue ? 0 : s.count > 0 ? 1 : 2);
  return list.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0 && a.nearestDue !== b.nearestDue)
      return (a.nearestDue as string) < (b.nearestDue as string) ? -1 : 1;
    return a.name.localeCompare(b.name, "ja");
  });
}

// ── カード ──
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

const row = (label: string, value: string) => ({
  type: "box",
  layout: "baseline",
  spacing: "sm",
  contents: [
    { type: "text", text: label, size: "sm", color: "#888888", flex: 3 },
    { type: "text", text: value, size: "sm", wrap: true, flex: 5 },
  ],
});

export function dealBubble(d: DealSummary) {
  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "text",
          text: cut(d.name || "（無題）", DEAL_NAME_MAX),
          weight: "bold",
          size: "md",
          wrap: true,
        },
        row("フェーズ", d.phase ?? "未設定"),
        row("近い期日", formatDue(d.nearestDue) ?? "なし"),
        row("残りタスク", `${d.count}件`),
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        button(
          "タスクを見る",
          encodeDealData("dt", d.id),
          "（ボタン）この案件のタスクを見る",
          true,
        ),
        button(
          "タスクを足す",
          encodeDealData("da", d.id),
          "（ボタン）この案件にタスクを足す",
        ),
      ],
    },
  };
}

/** 案件の一覧の1ページ（offset から最大10件）。11件目以降があれば［次の10件］（`v1|ld|オフセット`）。 */
export function buildDealPage(deals: DealSummary[], offset: number): ListPage {
  const total = deals.length;
  if (total === 0) return { text: MSG_DEALS_EMPTY, pageIds: [], shown: 0 };
  if (offset >= total) {
    return {
      text: `続きの案件はありません（全${total}件）`,
      pageIds: [],
      shown: 0,
    };
  }
  let count = Math.min(MENU_PAGE_SIZE, total - offset);
  for (;;) {
    const shown = deals.slice(offset, offset + count);
    const end = offset + count;
    const bubbles: unknown[] = shown.map(dealBubble);
    if (end < total) bubbles.push(nextBubble("ld", end, total - end));
    const card: FlexMessage = {
      type: "flex",
      altText: cut(
        `【進行中の案件】${total}件（${offset + 1}〜${end}件目）`,
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
        text: `📁 進行中の案件（${total}件中 ${offset + 1}〜${end}件目）`,
        card,
        pageIds: [],
        shown: shown.length,
      };
    }
    count--;
  }
}

// ── 読み込み・印（deps）──
export interface DealKv {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ex: number): Promise<void>;
  del(key: string): Promise<void>;
  /** 読むのと消すのを1回で（Redis の GETDEL。並行した2件の登録の片方だけが印を取れる） */
  getdel(key: string): Promise<unknown>;
}

export interface DealDeps {
  /** 進行中（完了・失注以外）の案件。読めなければ例外 */
  loadDeals(): Promise<DealRef[]>;
  /** 案件のある未完了タスク（groupId があれば発生元がそのグループのものだけ） */
  listDealTasks(groupId: string | null): Promise<DealTask[]>;
  /** その案件の未完了タスク（groupId があれば発生元がそのグループのものだけ） */
  listTasksOfDeal(dealId: string, groupId: string | null): Promise<MenuTask[]>;
  /** KV（設定が無ければ null） */
  kv: DealKv | null;
}

export const dealNextKey = (groupId: string, userId: string) =>
  `dealnext:${groupId}:${userId}`;

/** ［案件］の一覧（メニュー・「@秘書 案件」・［次の10件］）。案件を読めなければ「案件を読み取れませんでした」 */
export async function dealListPage(
  offset: number,
  groupId: string | undefined,
  deps: Pick<DealDeps, "loadDeals" | "listDealTasks">,
): Promise<ListPage> {
  let deals: DealRef[];
  try {
    deals = await deps.loadDeals();
  } catch {
    return { text: MSG_DEAL_READ_FAILED, pageIds: [], shown: 0 };
  }
  if (deals.length === 0)
    return { text: MSG_DEALS_EMPTY, pageIds: [], shown: 0 };
  // タスクを読めないときは例外のまま（入口が「タスクを読み込めませんでした」を返す）
  const g = groupId ?? null;
  const tasks = await deps.listDealTasks(g);
  return buildDealPage(summarizeDeals(deals, tasks, g), offset);
}

/** ［タスクを見る］［タスクを足す］が押されたとき */
export async function handleDealAction(
  action: DealAction,
  actorId: string | undefined,
  groupId: string | undefined,
  deps: DealDeps,
): Promise<ListPage> {
  const g = groupId ?? null;
  if (action.op === "dt") {
    const tasks = sortByDue(
      (await deps.listTasksOfDeal(action.dealId, g)).filter(
        (t) => !t.closed && (!g || t.origin === g),
      ),
    );
    return buildListPage("lt", tasks, action.offset, MSG_DEAL_TASKS_EMPTY, {
      name: "この案件の未完了タスク",
      nextData: (o) => encodeDealData("dt", action.dealId, o),
    });
  }
  // da：グループの中だけ（印の鍵がグループと人の組なので）
  if (!g || !actorId)
    return { text: MSG_DEAL_ADD_GROUP_ONLY, pageIds: [], shown: 0 };
  let deals: DealRef[];
  try {
    deals = await deps.loadDeals();
  } catch {
    return { text: MSG_DEAL_READ_FAILED, pageIds: [], shown: 0 };
  }
  // 進行中の案件だけに付ける（完了・失注になった案件・知らない ID には付けない）
  const deal = deals.find((d) => normId(d.id) === normId(action.dealId));
  if (!deal) return { text: MSG_DEAL_NOT_FOUND, pageIds: [], shown: 0 };
  if (!deps.kv) return { text: MSG_DEAL_ADD_FAILED, pageIds: [], shown: 0 };
  try {
    await deps.kv.set(
      dealNextKey(g, actorId),
      { dealId: deal.id },
      DEAL_NEXT_TTL,
    );
  } catch {
    return { text: MSG_DEAL_ADD_FAILED, pageIds: [], shown: 0 };
  }
  return { text: MSG_DEAL_ADD, pageIds: [], shown: 1 };
}

// ── 次の @秘書 の依頼の登録への反映 ──
export interface DealPickDeps {
  kv: DealKv | null;
  /** LINEタスクのページの欄を書く（notion.ts の updateTaskProps） */
  update(pageId: string, props: Record<string, unknown>): Promise<void>;
  /** 出してよいのは符号だけ */
  log(line: string): void;
}

/**
 * 登録の前に、その人の［タスクを足す］の印を取る（GETDEL＝読むのと同時に消す。同じ人の2件の依頼が別々の webhook で
 * 並行しても、印を取れるのは片方だけ）。取ったあと書き込みに失敗すると印は失われる（ログ write-failed。それでよい）。
 * TASK_MENU off・1対1・KV 未設定・読めないときは null（off のあいだは KV を1回も呼ばない）。
 */
export async function takeDealPick(
  groupId: string | null | undefined,
  userId: string | null | undefined,
  deps: Pick<DealPickDeps, "kv" | "log">,
): Promise<string | null> {
  if (!menuActive() || !groupId || !userId || !deps.kv) return null;
  try {
    const v = (await deps.kv.getdel(dealNextKey(groupId, userId))) as
      { dealId?: unknown } | null | undefined;
    const id = v && typeof v === "object" ? v.dealId : null;
    return typeof id === "string" && PAGE_ID_RE.test(id) ? id : null;
  } catch {
    deps.log("[deal-card] pick read-failed");
    return null;
  }
}

/** 人が選んだ案件の欄（`案件` と「確定」） */
export function pickedDealProps(dealId: string): Record<string, unknown> {
  return {
    案件の状態: { select: { name: "確定" } },
    案件: { relation: [{ id: dealId }] },
  };
}

/**
 * 登録が成功したあとに呼ぶ：`案件` を入れて「確定」にする（印は takeDealPick で取った時点で消えている）。
 * 例外は投げない。
 */
export async function applyDealPick(
  pageId: string,
  dealId: string,
  groupId: string,
  userId: string,
  deps: DealPickDeps,
): Promise<boolean> {
  let wrote = false;
  try {
    await deps.update(pageId, pickedDealProps(dealId));
    wrote = true;
  } catch {
    deps.log("[deal-card] pick write-failed");
  }
  deps.log(`[deal-card] pick ${wrote ? "applied" : "not-applied"}`);
  return wrote;
}
