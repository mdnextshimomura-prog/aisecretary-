/**
 * 受付の返事のボタン（task-buttons.ts）を、本物の Notion・名簿・LINE につなぐ。
 * route.ts からは handleTaskPostbackEvent を 1 回呼ぶだけ。
 *
 * ログに出すのは操作の名前と結果だけ（本文・題名・LINE の ID・pageId は出さない）。
 */
import { Client } from "@notionhq/client";
import { sendLineMessage } from "./line";
import { loadMembers } from "./members";
import { completeTask, updateTaskAssignee } from "./notion";
import {
  completeEvent,
  deletePendingTaskConfirm,
  getPendingTaskConfirm,
  reserveEvent,
  savePendingTaskConfirm,
} from "./email/session";
import { recordAssigneeChange } from "./task-record-wire";
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
  MSG_PAUSED,
  parseButtonData,
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
  /** 送ったメッセージの ID。送れなければ null */
  /** text を1通目、card があれば2通目に足して送る（sendLineMessage） */
  reply(replyToken: string, text: string, card?: FlexMessage): Promise<string | null>;
  log(line: string): void;
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
    reply: over.reply ?? sendLineMessage,
    log: over.log ?? ((line) => console.log(line)),
  };
  const op = parseButtonData(data)?.op ?? "invalid";

  const send = async (text: string, card: FlexMessage | undefined, code: string) => {
    let id: string | null = null;
    try {
      id = await io.reply(replyToken, text, card);
    } catch {
      io.log(`[task-buttons] reply-failed ${op} ${code} exception`);
      return;
    }
    if (id === null) io.log(`[task-buttons] reply-failed ${op} ${code}`);
  };

  if (!buttonsActive()) {
    await send(MSG_PAUSED, undefined, "paused");
    return;
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
    await send(r.text, r.card, code);
  } finally {
    // タスクを確認できなかったときは完了印を付けない（予約は付けたまま）
    if (key && !r?.retryable) {
      await io.complete(key).catch(() => io.log("[task-buttons] mark-failed"));
    }
  }
}
