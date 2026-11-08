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
import { completeEvent, reserveEvent } from "./email/session";
import { recordAssigneeChange } from "./task-record-wire";
import { statusDeps } from "./task-status-wire";
import { jstDateStr } from "./notion";
import {
  buttonsEnabled,
  handleTaskButton,
  parseButtonData,
  type ButtonDeps,
  type ButtonTask,
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
  const status =
    (props["ステータス"] as { select?: { name: string } | null } | undefined)
      ?.select?.name ?? null;
  return {
    id: String(page.id),
    title,
    closed:
      Boolean(page.archived) || Boolean(page.in_trash) || status === "完了",
    assigneeId: richText(props, "担当者ID"),
    requesterId: richText(props, "依頼者ID"),
  };
}

export function buttonDeps(): ButtonDeps {
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
  };
}

export interface PostbackEventLike {
  type: string;
  replyToken?: string;
  webhookEventId?: string;
  source: { userId?: string };
  postback?: { data?: string };
}

/**
 * postback イベント（ボタンが押された）を扱う。スイッチが off、またはこのボタンの data
 * （v1|…）でなければ何もしない。例外は投げない（返事で知らせる）。
 */
export async function handleTaskPostbackEvent(
  event: PostbackEventLike,
  deps: ButtonDeps = buttonDeps(),
): Promise<void> {
  if (!buttonsEnabled()) return;
  const data = event.postback?.data ?? "";
  if (!data.startsWith("v1|")) return;
  const replyToken = event.replyToken;
  if (!replyToken) return;
  const op = parseButtonData(data)?.op ?? "invalid";

  // 同じイベントの再送で二重に書かない（KV が使えないときは、そのまま進める）
  const key = event.webhookEventId ? `pb:${event.webhookEventId}` : null;
  if (key) {
    const claim = await reserveEvent(key).catch(() => ({ proceed: true }));
    if (!claim.proceed) return;
  }
  try {
    const r = await handleTaskButton(data, event.source.userId, deps);
    if (!r) {
      console.warn("[task-buttons] data の形式が違う");
      await sendLineMessage(replyToken, "⚠️ このボタンは使えません");
      return;
    }
    console.log(`[task-buttons] ${op} ${r.changed ? "changed" : "no-change"}`);
    await sendLineMessage(replyToken, r.text, r.quickReply);
  } catch {
    console.error(`[task-buttons] ${op} failed`);
    await sendLineMessage(
      replyToken,
      "⚠️ 書き込めませんでした。もう一度お試しください。",
    ).catch(() => undefined);
  } finally {
    if (key) await completeEvent(key).catch(() => undefined);
  }
}
