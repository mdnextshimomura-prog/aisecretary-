/**
 * 受付の返事のボタン（task-buttons.ts）を、本物の Notion・名簿・LINE につなぐ。
 * route.ts からは handleTaskPostbackEvent を 1 回呼ぶだけ。
 *
 * ログに出すのは操作の名前と結果だけ（本文・題名・LINE の ID・pageId は出さない）。
 */
import { Client } from "@notionhq/client";
import { replyTextAndCard, sendLineMessage } from "./line";
import { loadMembers } from "./members";
import { completeTask, findTaskByMessageId, updateTaskAssignee } from "./notion";
import {
  defaultCardRefStore,
  findQuotedTask,
  saveCardRefs,
  type CardRefStore,
} from "./card-ref";
import {
  completeEvent,
  deletePendingTaskConfirm,
  getPendingTaskConfirm,
  reserveEvent,
  savePendingTaskConfirm,
} from "./email/session";
import { recordAssigneeChange } from "./task-record-wire";
import {
  handleMenuAction,
  menuActive,
  menuCard,
  MENU_TEXT,
  MSG_READ_FAILED,
  type MenuDeps,
} from "./task-menu";
import { menuDeps } from "./task-menu-wire";
import {
  dealListPage,
  handleDealAction,
  parseDealData,
  type DealDeps,
} from "./deal-card";
import { dealDeps } from "./deal-card-wire";
import { parseSateiData } from "./satei-data";
import { handleSateiPostback, type SateiActionDeps } from "./satei-actions";
import { sateiActionDeps } from "./satei-wire";
import type { ListPage } from "./task-menu";
import {
  candidateCardsActive,
  defaultCandidateActionDeps,
  handleCandidateAction,
  parseCandidateData,
  type CandidateActionDeps,
} from "./candidate-card";
import { statusDeps } from "./task-status-wire";
import { jstDateStr } from "./notion";
import {
  isClosedPage,
  readTaskState,
  readTaskStatusName,
  type TaskState,
} from "./task-closed";
import {
  buttonsActive,
  handleTaskButton,
  registeredCard,
  MSG_PAUSED,
  parseButtonData,
  parseMenuData,
  type MenuAction,
  type ButtonDeps,
  type ButtonTask,
  type FlexMessage,
} from "./task-buttons";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

function richText(props: Record<string, unknown>, key: string): string | null {
  const v = (
    (props[key] as { rich_text?: Array<{ plain_text: string }> } | undefined)
      ?.rich_text ?? []
  )
    .map((t) => t.plain_text)
    .join("")
    .trim();
  return v || null;
}

/** ボタンの対象のタスク。見つからなければ null。 */
export async function getButtonTask(
  pageId: string,
): Promise<ButtonTask | null> {
  let page: Record<string, unknown>;
  try {
    page = (await notion.pages.retrieve({
      page_id: pageId,
    })) as unknown as Record<string, unknown>;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "object_not_found" || code === "validation_error") return null;
    throw err;
  }
  const props = (page.properties as Record<string, unknown>) ?? {};
  const title =
    (props["名前"] as { title?: Array<{ plain_text: string }> } | undefined)
      ?.title?.[0]?.plain_text ?? "（無題）";
  return {
    id: String(page.id),
    title,
    closed: isClosedPage(page),
    assigneeId: richText(props, "担当者ID"),
    requesterId: richText(props, "依頼者ID"),
    // カードに出す期日・担当（同じ1回の読み込みから。無ければカードに「未定」）
    due:
      (props["期日"] as { date?: { start?: string } | null } | undefined)?.date
        ?.start ?? null,
    assignee:
      (props["担当者"] as { select?: { name?: string } | null } | undefined)
        ?.select?.name ?? null,
  };
}

/** 初動確認のセッション（KV）。route.ts の確認の流れと同じ関数で読み書きする。 */
/** 初動確認への回答の前に見る：そのタスクがもう処理済みか（route.ts の安全網） */
export function taskState(pageId: string): Promise<TaskState> {
  return readTaskState(
    pageId,
    async (id) =>
      (await notion.pages.retrieve({ page_id: id })) as unknown as Record<string, unknown>,
  );
}

/** 初動確認の回答で条件がそろったときに見る：そのタスクの今のステータス（route.ts の persist） */
export function taskStatusName(pageId: string): Promise<string | null> {
  return readTaskStatusName(
    pageId,
    async (id) =>
      (await notion.pages.retrieve({ page_id: id })) as unknown as Record<string, unknown>,
  );
}

export function sessionDeps(groupId: string | undefined): ButtonDeps["session"] {
  return {
    clear: async (pageId) => {
      const p = await getPendingTaskConfirm(groupId, null, pageId);
      if (p) await deletePendingTaskConfirm(groupId, pageId);
    },
    syncAssignee: async (pageId, name, userId) => {
      const p = await getPendingTaskConfirm(groupId, null, pageId);
      if (!p || p.pageId !== pageId) return;
      p.assignee = name;
      p.assigneeUserId = userId;
      await savePendingTaskConfirm(groupId, p);
    },
  };
}

export function buttonDeps(groupId?: string): ButtonDeps {
  const s = statusDeps();
  return {
    getTask: getButtonTask,
    members: loadMembers,
    complete: completeTask,
    status: { update: s.update, defaultCheckDate: s.defaultCheckDate },
    // 引用リプライでの担当変更（route.ts の ③(b)）と同じ書き方
    setAssignee: async (pageId, name, userId) => {
      await updateTaskAssignee(pageId, name, userId);
      await recordAssigneeChange(pageId, name, userId);
    },
    today: () => jstDateStr(0),
    session: sessionDeps(groupId),
  };
}

export interface SentIds {
  textId: string | null;
  cardId: string | null;
}

/** pageId からタスク（id・題名）。消された（アーカイブ・ゴミ箱）・見つからないなら null */
export async function readTaskRef(
  pageId: string,
): Promise<{ id: string; title: string } | null> {
  let page: Record<string, unknown>;
  try {
    page = (await notion.pages.retrieve({
      page_id: pageId,
    })) as unknown as Record<string, unknown>;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "object_not_found" || code === "validation_error") return null;
    throw err;
  }
  if (page.archived || page.in_trash) return null;
  const props = (page.properties as Record<string, unknown>) ?? {};
  const title =
    (props["名前"] as { title?: Array<{ plain_text: string }> } | undefined)
      ?.title?.[0]?.plain_text ?? "（無題）";
  return { id: String(page.id), title };
}

/**
 * 引用先のタスク（route.ts の確認への回答・引用での完了で使う）。まずメッセージID、無ければ
 * 付け直したカードの控え（cardref）。TASK_BUTTONS が off なら findTaskByMessageId と同じ。
 */
export function findQuotedTaskReal(
  messageId: string,
): Promise<{ id: string; title: string } | null> {
  return findQuotedTask(messageId, {
    findByMessageId: findTaskByMessageId,
    store: defaultCardRefStore(),
    readTask: readTaskRef,
    log: (line) => console.log(line),
  });
}

/**
 * 初動確認への回答の返事（route.ts の「(a) 提案をそのまま承認」「(b) 具体的な回答」）。
 * TASK_BUTTONS が on なら、文の返事を1通目のまま、そのタスクのカードを2通目に付ける（返事に毎回付ける）。
 * タスク名は確認の題名、担当は確認の担当、期日は確認に無いので「未定」（Notion の追加読み取りはしない）。
 * 送れた ID は cardref に控える（再掲と同じ。失敗はログだけ）。off なら sendLineMessage と同じ1通。
 * 送信の例外はそのまま投げる（呼び出し側の「⚠️ 反映に失敗」の扱いを変えない）。返すのは text の ID。
 */
export async function sendConfirmAnswerReply(
  replyToken: string,
  text: string,
  pending: { pageId: string; title: string; assignee?: string | null },
  over: Partial<Pick<PostbackIo, "reply" | "cardRefs" | "log">> = {},
): Promise<string | null> {
  const card = registeredCard({
    pageId: pending.pageId,
    title: pending.title,
    due: null,
    assignee: pending.assignee ?? null,
  });
  if (!card) {
    const got = await (over.reply ?? sendLineMessage)(replyToken, text);
    return got === null || typeof got === "string" ? got : got.textId;
  }
  const got = await (over.reply ?? replyTextAndCard)(replyToken, text, card);
  const ids: SentIds =
    got === null || typeof got === "string" ? { textId: got, cardId: null } : got;
  await saveCardRefs(
    [ids.textId, ids.cardId],
    pending.pageId,
    "cardRefs" in over ? (over.cardRefs ?? null) : defaultCardRefStore(),
    over.log ?? ((line) => console.log(line)),
  );
  return ids.textId;
}

export const MSG_BUSY =
  "いま操作を受け付けられません。少し待ってからもう一度押してください";

export interface PostbackEventLike {
  type: string;
  replyToken?: string;
  webhookEventId?: string;
  source: { userId?: string; groupId?: string };
  postback?: { data?: string };
}

/** 差し替えられる部品（テスト用）。省いたものは本物を使う。 */
export interface PostbackIo {
  deps: ButtonDeps;
  reserve(key: string): Promise<{ proceed: boolean }>;
  complete(key: string): Promise<void>;
  /**
   * text を1通目、card があれば2通目に足して送る（replyTextAndCard）。送ったメッセージの ID
   * （文字列なら text の ID だけ）。送れなければ null か両方 null
   */
  reply(
    replyToken: string,
    text: string,
    card?: FlexMessage,
  ): Promise<SentIds | string | null>;
  /** 付け直したカードの ID の控え（KV。設定が無ければ null＝書かない） */
  cardRefs: CardRefStore | null;
  log(line: string): void;
  /** メニュー・一覧の読み込み（TASK_MENU=1 のときだけ使う。省けば本物の Notion） */
  menu?: MenuDeps;
  /** 案件のボタン（B1 Task 3。TASK_MENU=1 のときだけ使う。省けば本物の Notion・KV） */
  deal?: DealDeps;
  /**
   * 候補のボタン（B1 Task 2。TASK_MENU=1 かつ TASK_CANDIDATES=1 のときだけ使う）。
   * register は route.ts が渡す（registerTaskFromText）。省いた部品は本物（KV・名簿）
   */
  candidates?: Partial<CandidateActionDeps>;
  /** 査定書のボタン（B2。v1|sa|・v1|so|・v1|sr|）。省いた部品は本物（satei-wire.ts） */
  satei?: Partial<SateiActionDeps>;
}

/**
 * postback イベント（ボタンが押された）を扱う。このボタンの data（v1|…）でなければ何もしない。
 * TASK_BUTTONS・TASK_FOLLOWUP のどちらかが off なら、書かずに「止めています」と返す。
 * 例外は投げない（返事で知らせる）。ログは操作名と結果の符号だけ。
 */
export async function handleTaskPostbackEvent(
  event: PostbackEventLike,
  over: Partial<PostbackIo> = {},
): Promise<void> {
  const data = event.postback?.data ?? "";
  if (!data.startsWith("v1|")) return;
  const replyToken = event.replyToken;
  if (!replyToken) return;
  const io: PostbackIo = {
    deps: over.deps ?? buttonDeps(event.source.groupId),
    reserve: over.reserve ?? reserveEvent,
    complete: over.complete ?? completeEvent,
    reply: over.reply ?? replyTextAndCard,
    cardRefs: "cardRefs" in over ? (over.cardRefs ?? null) : defaultCardRefStore(),
    log: over.log ?? ((line) => console.log(line)),
    menu: over.menu,
    deal: over.deal,
    candidates: over.candidates,
    satei: over.satei,
  };
  // B2 査定書のボタン（v1|sa|・v1|so|・v1|sr|）。TASK_BUTTONS・TASK_MENU とは別のスイッチ（TASK_SATEI）なので、
  // 「止めています」の判定より前に振り分ける。off・押せる人・二度押しの扱いは satei-actions.ts。
  // この3つの data は今まで出していないので、ほかのボタンの扱いは変わらない
  const satei = parseSateiData(data);
  if (satei) {
    await handleSateiPostback(
      satei,
      { replyToken, webhookEventId: event.webhookEventId, source: event.source },
      {
        ...sateiActionDeps(),
        reserve: io.reserve,
        complete: io.complete,
        reply: (token, text) => io.reply(token, text),
        log: io.log,
        ...io.satei,
      },
    );
    return;
  }
  const op = parseButtonData(data)?.op ?? "invalid";

  const send = async (
    text: string,
    card: FlexMessage | undefined,
    code: string,
  ): Promise<SentIds> => {
    let got: SentIds | string | null = null;
    try {
      got = await io.reply(replyToken, text, card);
    } catch {
      io.log(`[task-buttons] reply-failed ${op} ${code} exception`);
      return { textId: null, cardId: null };
    }
    const ids: SentIds =
      got === null || typeof got === "string"
        ? { textId: got, cardId: null }
        : got;
    if (ids.textId === null) io.log(`[task-buttons] reply-failed ${op} ${code}`);
    return ids;
  };

  if (!buttonsActive()) {
    await send(MSG_PAUSED, undefined, "paused");
    return;
  }

  // メニュー・一覧のボタン（TASK_MENU=1 のときだけ。off なら今までどおり下のタスクのボタンへ＝「使えません」）。
  // 読むだけなので予約・完了印は使わない。送り主の制限は route.ts で通ったあと
  if (menuActive()) {
    const action = parseMenuData(data);
    if (action) {
      await handleMenuPostback(
        action,
        event.source.userId,
        event.source.groupId,
        replyToken,
        io,
      );
      return;
    }
    // 案件のボタン（B1 Task 3。［タスクを見る］＝読むだけ、［タスクを足す］＝KV の印だけ）
    const deal = parseDealData(data);
    if (deal) {
      await replyListResult(
        deal.op,
        () =>
          handleDealAction(
            deal,
            event.source.userId,
            event.source.groupId,
            io.deal ?? dealDeps(),
          ),
        replyToken,
        io,
      );
      return;
    }
  }

  // 候補のボタン（TASK_MENU=1 かつ TASK_CANDIDATES=1 のときだけ。off なら下のタスクのボタンへ＝「使えません」）。
  // 二重押しは候補ごとの登録の予約（SET NX）で止める
  if (candidateCardsActive()) {
    const action = parseCandidateData(data);
    if (action) {
      const c = io.candidates ?? {};
      await handleCandidateAction(
        action,
        event.source.userId,
        event.source.groupId,
        replyToken,
        {
          ...defaultCandidateActionDeps({
            register: async () => "failed",
            reply: (t, text) => io.reply(t, text),
            log: io.log,
          }),
          ...c,
          ...(c.register
            ? {}
            : {
                // 登録の部品が渡されていない（入口の作り違い）。登録せず知らせる
                register: async (_c, t) => {
                  await io.reply(t, "⚠️ 候補を処理できませんでした。もう一度お試しください。");
                  return "failed" as const;
                },
              }),
        },
      );
      return;
    }
  }

  // 同じイベントの再送で二重に書かない。予約できない（KV の障害）なら書かない
  const key = event.webhookEventId ? `pb:${event.webhookEventId}` : null;
  if (key) {
    let claim: { proceed: boolean };
    try {
      claim = await io.reserve(key);
    } catch {
      io.log(`[task-buttons] reserve-failed ${op}`);
      await send(MSG_BUSY, undefined, "busy");
      return;
    }
    if (!claim.proceed) return;
  }
  let r;
  try {
    r = await handleTaskButton(data, event.source.userId, io.deps);
  } catch {
    // Notion に書けなかった（または読めなかった）。何も消さず、完了印も付けない。
    // 予約は外さない：本番は LINE の再送が無効なので外しても回復せず、「Notion には反映されたが
    // 応答が取れなかった」ときに古いイベントの再実行で上書きしうる。押し直しは新しいイベント ID で通る
    io.log(`[task-buttons] ${op} failed`);
    await send("⚠️ 書き込めませんでした。もう一度お試しください。", undefined, "error");
    return;
  }
  // ここからは Notion が書けている（または書く必要が無い）。返事が送れなくても完了印は付ける（再適用を防ぐ）
  try {
    if (!r) {
      io.log("[task-buttons] invalid-data");
      await send("⚠️ このボタンは使えません", undefined, "invalid");
      return;
    }
    for (const w of r.warnings ?? []) io.log(`[task-buttons] ${w}`);
    const code = r.retryable ? "unconfirmed" : r.changed ? "changed" : "no-change";
    io.log(`[task-buttons] ${op} ${code}`);
    const sent = await send(r.text, r.card, code);
    // 付け直したカード（と text）の ID を控える（単発の SET。確認への回答・引用での完了が引く）
    if (r.card && r.pageId) {
      await saveCardRefs([sent.textId, sent.cardId], r.pageId, io.cardRefs, io.log);
    }
  } finally {
    // タスクを確認できなかったときは完了印を付けない（予約は付けたまま）
    if (key && !r?.retryable) {
      await io.complete(key).catch(() => io.log("[task-buttons] mark-failed"));
    }
  }
}

/**
 * メニュー・一覧のボタンが押されたとき。返事は replyToken で（text が1通目、カード・カルーセルが2通目）。
 * 一覧に載せたタスクが1件だけのときに限り、送れた ID を cardref に控える（引用での完了・回答に結び付ける）。
 * 2件以上のカルーセルは1通に複数のタスクが載るので控えない（引用されてもどのタスクか決められないため）。
 * ログは操作名・件数・結果の符号だけ。例外は投げない。
 */
async function handleMenuPostback(
  action: MenuAction,
  actorId: string | undefined,
  groupId: string | undefined,
  replyToken: string,
  io: PostbackIo,
): Promise<void> {
  const deps = io.menu ?? menuDeps();
  await replyListResult(
    action.op,
    () => handleMenuAction(action, actorId, groupId, deps),
    replyToken,
    io,
  );
}

/**
 * 一覧（メニュー・案件）の返事の共通部分。読めなければ「タスクを読み込めませんでした」。
 * 載せたタスクが1件のときだけ cardref に控える。例外は投げない。
 */
async function replyListResult(
  op: string,
  run: () => Promise<ListPage>,
  replyToken: string,
  io: PostbackIo,
): Promise<void> {
  const action = { op };
  let r;
  try {
    r = await run();
  } catch {
    io.log(`[task-menu] ${action.op} read-failed`);
    try {
      await io.reply(replyToken, MSG_READ_FAILED);
    } catch {
      io.log(`[task-menu] reply-failed ${action.op}`);
    }
    return;
  }
  io.log(`[task-menu] ${action.op} shown ${r.shown ?? r.pageIds.length}`);
  let got: SentIds | string | null = null;
  try {
    got = await io.reply(replyToken, r.text, r.card);
  } catch {
    io.log(`[task-menu] reply-failed ${action.op}`);
    return;
  }
  const ids: SentIds =
    got === null || typeof got === "string" ? { textId: got, cardId: null } : got;
  if (ids.textId === null) io.log(`[task-menu] reply-failed ${action.op}`);
  if (r.card && r.pageIds.length === 1) {
    await saveCardRefs([ids.textId, ids.cardId], r.pageIds[0], io.cardRefs, io.log);
  }
}

/**
 * 「@秘書 メニュー」・「@秘書」だけの発言への返事（route.ts の入口）。TASK_MENU が off なら呼ばれない。
 * 送信の例外はそのまま投げる（route.ts の今の扱いに任せる）。
 */
export async function replyMenu(
  replyToken: string,
  over: Partial<Pick<PostbackIo, "reply" | "log">> = {},
): Promise<void> {
  await (over.reply ?? replyTextAndCard)(replyToken, MENU_TEXT, menuCard());
  (over.log ?? ((line) => console.log(line)))("[task-menu] menu shown 0");
}

/**
 * 「@秘書 案件」への返事（route.ts の入口。TASK_MENU が off なら呼ばれない）。メニューの［案件］と同じ。
 * 送信の例外はそのまま投げる。
 */
export async function replyDealList(
  replyToken: string,
  groupId: string | undefined,
  over: Partial<Pick<PostbackIo, "reply" | "log" | "deal">> = {},
): Promise<void> {
  const log = over.log ?? ((line: string) => console.log(line));
  let r: ListPage;
  try {
    r = await dealListPage(0, groupId, over.deal ?? dealDeps());
  } catch {
    log("[task-menu] ld read-failed");
    await (over.reply ?? replyTextAndCard)(replyToken, MSG_READ_FAILED);
    return;
  }
  log(`[task-menu] ld shown ${r.shown ?? 0}`);
  await (over.reply ?? replyTextAndCard)(replyToken, r.text, r.card);
}
