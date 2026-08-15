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
      // 物件名は原文の表記のまま、キーは表記ゆれを吸収した照合用。
      // 2つ持つのは、ルールを変えたときにキーだけ作り直せるようにするため。
      ...(task.propertyName && {
        物件名: { rich_text: [{ text: { content: task.propertyName } }] },
      }),
      ...(task.propertyKey && {
        物件キー: { rich_text: [{ text: { content: task.propertyKey } }] },
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

// ── ダッシュボード（/dashboard）用 ──────────────────────────────
// 画面はもともとSQLiteを見ていたが、永続化はNotionに一本化済みで
// SQLiteには何も書かれていない（Vercelでは書けない）ため常に空だった。
// Notionを直接読むように差し替える。

export interface DashboardTask {
  id: string;
  title: string;
  category: string;
  urgency: string;
  dueDate: string | null;
  assignee: string | null;
  // 担当者のLINE userId。@メンションで指定された時だけ入る。
  // 表示名は本人がいつでも変えられるので、人の同定はこちらを軸にする。
  assigneeUserId: string | null;
  propertyName: string | null;
  propertyKey: string | null;
  status: string;
  rawMessage: string;
  createdAt: string;
  url: string;
}

// タスクを新しい順に返す。Notionは1回100件までしか返さないので続きも辿る。
// （1ページで打ち切ると「未着手が100件」のように件数を誤認する）
// 上限は暴走防止。ここに達したら台帳が溜まりすぎているサイン。
const NOTION_PAGE_SIZE = 100;
const MAX_TASKS = 500;

export async function listTasks(): Promise<DashboardTask[]> {
  const results: unknown[] = [];
  let cursor: string | undefined = undefined;

  do {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      page_size: NOTION_PAGE_SIZE,
      start_cursor: cursor,
      sorts: [{ timestamp: "created_time", direction: "descending" }],
    });
    results.push(...response.results);
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor && results.length < MAX_TASKS);

  return results.map((page) => {
    const p = page as unknown as {
      id: string;
      url?: string;
      created_time: string;
      properties: Record<string, unknown>;
    };
    const props = p.properties ?? {};
    const title = props["名前"] as
      | { title: Array<{ plain_text: string }> }
      | undefined;
    const sel = (key: string) =>
      (props[key] as { select: { name: string } | null } | undefined)?.select
        ?.name ?? null;
    const rich = (key: string) =>
      ((props[key] as { rich_text: Array<{ plain_text: string }> } | undefined)
        ?.rich_text ?? [])
        .map((t) => t.plain_text)
        .join("");

    return {
      id: p.id,
      title: title?.title[0]?.plain_text ?? "（無題）",
      category: sel("種別") ?? "",
      urgency: sel("緊急度") ?? "",
      dueDate:
        (props["期日"] as { date: { start: string } | null } | undefined)?.date
          ?.start ?? null,
      assignee: sel("担当者"),
      assigneeUserId: rich("担当者ID") || null,
      propertyName: rich("物件名") || null,
      propertyKey: rich("物件キー") || null,
      status: sel("ステータス") ?? "未着手",
      rawMessage: rich("元メッセージ"),
      createdAt: p.created_time,
      url: p.url ?? "",
    };
  });
}

// 未完了タスクを全件返す（棚卸しレポート用）。
// getUpcomingTasks は「期日が明日まで」で絞るため、休業明けの棚卸しには使えない
// （休業中に登録された分は期日が先になっていて拾えない）。
export async function getUpcomingTasksAll(): Promise<
  Array<{
    id: string;
    title: string;
    dueDate: string;
    assignee: string | null;
    assigneeUserId: string | null;
    propertyName: string | null;
    createdTime: string;
  }>
> {
  const results: unknown[] = [];
  let cursor: string | undefined = undefined;
  do {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      page_size: NOTION_PAGE_SIZE,
      start_cursor: cursor,
      sorts: [{ property: "期日", direction: "ascending" }],
      filter: { property: "ステータス", select: { does_not_equal: "完了" } },
    });
    results.push(...response.results);
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor && results.length < MAX_TASKS);

  return results.map((page) => {
    const p = page as Record<string, unknown>;
    const props = (p.properties as Record<string, unknown>) ?? {};
    const rich = (key: string) =>
      ((props[key] as { rich_text: Array<{ plain_text: string }> } | undefined)
        ?.rich_text ?? [])
        .map((t) => t.plain_text)
        .join("");
    return {
      id: p.id as string,
      title:
        (props["名前"] as { title: Array<{ plain_text: string }> } | undefined)
          ?.title[0]?.plain_text ?? "（無題）",
      dueDate:
        (props["期日"] as { date: { start: string } | null } | undefined)?.date
          ?.start ?? "",
      assignee:
        (props["担当者"] as { select: { name: string } | null } | undefined)
          ?.select?.name ?? null,
      assigneeUserId: rich("担当者ID") || null,
      propertyName: rich("物件名") || null,
      createdTime: p.created_time as string,
    };
  });
}

// 物件名を後から埋める（既存タスクの遡り補完に使う）
export async function setTaskProperty(
  pageId: string,
  name: string,
  key: string
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      物件名: { rich_text: [{ text: { content: name } }] },
      物件キー: { rich_text: [{ text: { content: key } }] },
    },
  });
}

// ダッシュボードからのステータス変更。完了以外（未着手/進行中）にも戻せるよう
// completeTask とは別にしている。
export async function setTaskStatus(
  pageId: string,
  status: string
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: { ステータス: { select: { name: status } } },
  });
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
