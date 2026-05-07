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
      タイトル: {
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
          rich_text: [{ text: { content: task.assignee } }],
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

export async function getUpcomingTasks(): Promise<
  Array<{
    id: string;
    title: string;
    dueDate: string;
    urgency: string;
    assignee: string | null;
    url: string;
  }>
> {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const todayStr = today.toISOString().split("T")[0];
  const tomorrowStr = tomorrow.toISOString().split("T")[0];

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

    const titleProp = props["タイトル"] as
      | { title: Array<{ plain_text: string }> }
      | undefined;
    const dueProp = props["期日"] as { date: { start: string } } | undefined;
    const urgencyProp = props["緊急度"] as
      | { select: { name: string } }
      | undefined;
    const assigneeProp = props["担当者"] as
      | { rich_text: Array<{ plain_text: string }> }
      | undefined;

    return {
      id: page.id,
      title: titleProp?.title[0]?.plain_text ?? "（無題）",
      dueDate: dueProp?.date?.start ?? "",
      urgency: urgencyProp?.select?.name ?? "",
      assignee: assigneeProp?.rich_text[0]?.plain_text ?? null,
      url: (p.url as string) ?? "",
    };
  });
}
