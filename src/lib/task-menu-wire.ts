/**
 * メニュー・一覧（task-menu.ts）を本物の Notion・名簿につなぐ。
 * 読むだけ（Notion にも KV にも書かない。一覧のカードの ID の控え cardref は入口が書く）。
 * 欄の読み方は notion.ts の listTasks / getUpcomingTasks に合わせる（名前・期日・担当者・担当者ID・次に確認する日・ステータス）。
 * 問い合わせは一覧1つにつき1回（＋続きのページ）。ログには何も出さない（入口が操作名と件数だけ出す）。
 */
import { Client } from "@notionhq/client";
import { loadMembers } from "./members";
import { jstDateStr } from "./notion";
import { addDaysStr } from "./task-status-command";
import type { MenuDeps, MenuTask } from "./task-menu";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const PAGE_SIZE = 100;
const MAX_TASKS = 500;
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/;

const notDone = { property: "ステータス", select: { does_not_equal: "完了" } };
const sorts = [{ property: "期日", direction: "ascending" as const }];

/** Notion のページ → 一覧のタスク（欄の読み方は notion.ts と同じ） */
export function toMenuTask(page: Record<string, unknown>): MenuTask {
  const props = (page.properties as Record<string, unknown>) ?? {};
  const date = (key: string) =>
    (props[key] as { date?: { start?: string } | null } | undefined)?.date
      ?.start ?? null;
  return {
    id: String(page.id),
    title:
      (props["名前"] as { title?: Array<{ plain_text: string }> } | undefined)
        ?.title?.[0]?.plain_text ?? "（無題）",
    due: date("期日"),
    assignee:
      (props["担当者"] as { select?: { name?: string } | null } | undefined)
        ?.select?.name ?? null,
    nextCheck: date("次に確認する日"),
    closed:
      Boolean(page.archived || page.in_trash) ||
      (props["ステータス"] as { select?: { name?: string } | null } | undefined)
        ?.select?.name === "完了",
  };
}

async function queryAll(filter: Record<string, unknown>): Promise<MenuTask[]> {
  const out: MenuTask[] = [];
  let cursor: string | undefined = undefined;
  do {
    const res = await notion.databases.query({
      database_id: process.env.NOTION_DATABASE_ID!,
      page_size: PAGE_SIZE,
      start_cursor: cursor,
      sorts,
      filter: filter as Parameters<typeof notion.databases.query>[0]["filter"],
    });
    for (const p of res.results)
      out.push(toMenuTask(p as unknown as Record<string, unknown>));
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor && out.length < MAX_TASKS);
  return out;
}

export function menuDeps(): MenuDeps {
  return {
    // 期日は「明日以前」で広めに取り（日時つきの期日の取りこぼしを避ける）、今日以前かは手元で見る
    listToday: (today) =>
      queryAll({
        and: [
          notDone,
          {
            or: [
              {
                property: "期日",
                date: { on_or_before: addDaysStr(today, 1) },
              },
              { property: "次に確認する日", date: { on_or_before: today } },
            ],
          },
        ],
      }),
    listMine: (ids) =>
      queryAll({
        and: [
          notDone,
          {
            or: ids.map((id) => ({
              property: "担当者ID",
              rich_text: { equals: id },
            })),
          },
        ],
      }),
    aliasIds: async (userId) => {
      const members = await loadMembers().catch(() => []);
      const me = members.find((m) => m.userIds.includes(userId));
      const ids = (me?.userIds ?? []).filter((id) => LINE_USER_ID_RE.test(id));
      return ids.includes(userId) ? ids : [userId, ...ids];
    },
    today: () => jstDateStr(0),
  };
}
