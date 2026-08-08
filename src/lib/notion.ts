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

// タスクを取り消す（Notionページをアーカイブ＝一覧から消す）
export async function archiveTask(pageId: string): Promise<void> {
  await notion.pages.update({ page_id: pageId, archived: true });
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

// タスクを完了にする。取り消し（archiveTask＝ページごと削除）と違い、
// 記録を残したまま一覧から外れる。LINEからの「完了」報告で呼ばれる。
export async function completeTask(pageId: string): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      ステータス: { select: { name: "完了" } },
    },
  });
}

// リマインドに載せた順番（1始まり）を書き込む。
// これがあることで「3済」のような番号指定で完了にできる。毎回のリマインドで振り直す。
export async function setRemindNumber(
  pageId: string,
  num: number
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: { リマインド番号: { number: num } },
  });
}

// リマインド番号からタスクを引く。
// 「未完了」かつ「期日が明日まで」＝リマインドに載る範囲に限定しているため、
// 過去に振られた古い番号を誤って拾うことがない（範囲内のタスクは毎回振り直されるため）。
export async function findTaskByRemindNumber(
  num: number
): Promise<{ id: string; title: string } | null> {
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    page_size: 1,
    filter: {
      and: [
        { property: "リマインド番号", number: { equals: num } },
        { property: "ステータス", select: { does_not_equal: "完了" } },
        { property: "期日", date: { on_or_before: jstDateStr(1) } },
      ],
    },
  });

  const page = response.results[0];
  if (!page) return null;
  const props =
    ((page as Record<string, unknown>).properties as Record<string, unknown>) ??
    {};
  const titleProp = props["名前"] as
    | { title: Array<{ plain_text: string }> }
    | undefined;
  return { id: page.id, title: titleProp?.title[0]?.plain_text ?? "（無題）" };
}

// 未完了で残っているタスクの件数（完了報告への返信で「残りN件」を出すのに使う）
export async function countRemainingTasks(): Promise<number> {
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: "期日", date: { on_or_before: jstDateStr(1) } },
        { property: "ステータス", select: { does_not_equal: "完了" } },
      ],
    },
  });
  return response.results.length;
}

// リマインド対象のタスク。
// 「期日が明日まで」かつ「未完了」。下限を設けていないのは意図的で、
// 期限を過ぎたタスクも拾うため（以前は on_or_after: 今日 で絞っていたため、
// 期限切れが二度と通知されず静かに埋もれていた）。
// 期日の古い順に返すので、呼び出し側で 期限超過／本日／明日 に振り分ける。
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
  const tomorrowStr = jstDateStr(1);

  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    sorts: [{ property: "期日", direction: "ascending" }],
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
