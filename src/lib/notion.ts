import { Client } from "@notionhq/client";
import type { ParsedTask } from "./claude";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATABASE_ID = process.env.NOTION_DATABASE_ID!;

export async function createNotionTask(
  task: ParsedTask,
  rawMessage: string
): Promise<string> {
  const response = await notion.pages.create({
    parent: { database_id: DATABASE_ID },
    properties: {
      名前: {
        title: [{ text: { content: task.title } }],
      },
      種別: {
        select: { name: task.category },
      },
      緊急度: {
        select: { name: task.urgency },
      },
      ...(task.dueDate && {
        期日: {
          date: {
            // 時刻の明示があれば日時で保存（期限前通知の基準になる）。
            // 無ければ日付のみ（通知側でデフォルト18:00とみなす）。
            start: task.dueTime
              ? `${task.dueDate}T${task.dueTime}:00+09:00`
              : task.dueDate,
          },
        },
      }),
      ...(task.assignee && {
        担当者: {
          select: { name: task.assignee },
        },
      }),
      ...(task.assigneeUserId && {
        担当者ID: {
          rich_text: [{ text: { content: task.assigneeUserId } }],
        },
      }),
      ステータス: {
        select: { name: "未着手" },
      },
      元メッセージ: {
        rich_text: [{ text: { content: rawMessage } }],
      },
    },
  });

  return response.id;
}

// JST（日本時間）基準の日付文字列 "YYYY-MM-DD" を返す。
// Vercel CronはUTCで動く（朝8時JST = 前日23時UTC）ため、UTCのままだと
// 日付が1日ずれてリマインド対象を取りこぼす。必ずJSTに直してから比較する。
export function jstDateStr(offsetDays = 0): string {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  jst.setUTCDate(jst.getUTCDate() + offsetDays);
  return jst.toISOString().split("T")[0];
}

// 期限前通知の対象タスク: 期日が今日（JST）で、未完了・未通知のもの。
// 通知するかどうかの時刻判定は呼び出し側（/api/remind-due）で行う。
export async function getDueSoonTasks(): Promise<
  Array<{
    id: string;
    title: string;
    dueStart: string; // Notionの期日そのまま（"YYYY-MM-DD" or ISO日時）
    createdTime: string;
    assignee: string | null;
    assigneeUserId: string | null;
  }>
> {
  const todayStr = jstDateStr(0);
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: "期日", date: { on_or_after: todayStr } },
        { property: "期日", date: { before: jstDateStr(1) } },
        { property: "ステータス", select: { does_not_equal: "完了" } },
        { property: "通知済み", checkbox: { equals: false } },
      ],
    },
  });

  return response.results.map((page) => {
    const p = page as unknown as {
      id: string;
      created_time: string;
      properties: Record<string, unknown>;
    };
    const props = p.properties;
    const titleProp = props["名前"] as
      | { title: Array<{ plain_text: string }> }
      | undefined;
    const dueProp = props["期日"] as { date: { start: string } } | undefined;
    const assigneeProp = props["担当者"] as
      | { select: { name: string } | null }
      | undefined;
    const assigneeIdProp = props["担当者ID"] as
      | { rich_text: Array<{ plain_text: string }> }
      | undefined;
    return {
      id: p.id,
      title: titleProp?.title[0]?.plain_text ?? "（無題）",
      dueStart: dueProp?.date?.start ?? "",
      createdTime: p.created_time,
      assignee: assigneeProp?.select?.name ?? null,
      assigneeUserId: assigneeIdProp?.rich_text[0]?.plain_text ?? null,
    };
  });
}

// 期限前通知を送ったタスクに印を付ける（二重通知防止）
export async function markNotified(pageId: string): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: { 通知済み: { checkbox: true } },
  });
}

// タスクに紐づくLINEメッセージID群を保存する。
// 元の依頼メッセージとBotの確認返信の両方を保存し、どちらへの
// 引用リプライでもタスクを特定できるようにする（カンマ区切り）。
export async function setTaskMessageIds(
  pageId: string,
  messageIds: string[]
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      メッセージID: {
        rich_text: [{ text: { content: messageIds.filter(Boolean).join(",") } }],
      },
    },
  });
}

// 引用リプライ先のメッセージIDからタスクを探す
export async function findTaskByMessageId(
  messageId: string
): Promise<{ id: string; title: string } | null> {
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: "メッセージID",
      rich_text: { contains: messageId },
    },
    page_size: 1,
  });
  const page = response.results[0];
  if (!page) return null;
  const props = (page as unknown as { properties: Record<string, unknown> })
    .properties;
  const titleProp = props["名前"] as
    | { title: Array<{ plain_text: string }> }
    | undefined;
  return {
    id: page.id,
    title: titleProp?.title[0]?.plain_text ?? "（無題）",
  };
}

// タスクの担当者を後から設定・変更する（リプライでのメンション用）
export async function updateTaskAssignee(
  pageId: string,
  name: string,
  userId: string | null
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      担当者: { select: { name } },
      担当者ID: {
        rich_text: userId ? [{ text: { content: userId } }] : [],
      },
    },
  });
}

export async function getUpcomingTasks(): Promise<
  Array<{
    id: string;
    title: string;
    dueDate: string;
    urgency: string;
    assignee: string | null;
    assigneeUserId: string | null;
    url: string;
  }>
> {
  const todayStr = jstDateStr(0);
  const tomorrowStr = jstDateStr(1);

  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        {
          property: "期日",
          date: { on_or_before: tomorrowStr },
        },
        {
          property: "ステータス",
          select: { does_not_equal: "完了" },
        },
        {
          property: "期日",
          date: { on_or_after: todayStr },
        },
      ],
    },
  });

  return response.results.map((page) => {
    const p = page as Record<string, unknown>;
    const props = (p.properties as Record<string, unknown>) ?? {};

    const titleProp = props["名前"] as
      | { title: Array<{ plain_text: string }> }
      | undefined;
    const dueProp = props["期日"] as { date: { start: string } } | undefined;
    const urgencyProp = props["緊急度"] as
      | { select: { name: string } }
      | undefined;
    // 担当者は select 型（旧コードは rich_text で読んでいて常にnullになっていた）
    const assigneeProp = props["担当者"] as
      | { select: { name: string } | null }
      | undefined;
    const assigneeIdProp = props["担当者ID"] as
      | { rich_text: Array<{ plain_text: string }> }
      | undefined;

    return {
      id: page.id,
      title: titleProp?.title[0]?.plain_text ?? "（無題）",
      dueDate: dueProp?.date?.start ?? "",
      urgency: urgencyProp?.select?.name ?? "",
      assignee: assigneeProp?.select?.name ?? null,
      assigneeUserId: assigneeIdProp?.rich_text[0]?.plain_text ?? null,
      url: (p.url as string) ?? "",
    };
  });
}
