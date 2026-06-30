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
          date: { start: task.dueDate },
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
