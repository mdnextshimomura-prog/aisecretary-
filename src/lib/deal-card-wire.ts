/**
 * 案件のカード（deal-card.ts）を本物の Notion・KV につなぐ。
 * - 案件：task-record-wire.ts の loadActiveDeals（CRM_NOTION_TOKEN／無ければ NOTION_API_KEY と CRM_DEALS_DB_ID。5分覚える）。
 *   CRM_案件 には書かない。
 * - タスク：LINEタスクを1クエリ（＋続きのページ）。欄の読み方は task-menu-wire.ts の toMenuTask と同じ＋`案件`（relation）。
 * - 印：KV の `dealnext:<groupId>:<userId>`（10分）。KV の設定が無ければ使わない。
 * ログは出さない（入口が操作名と件数だけ出す）。
 */
import { Client } from "@notionhq/client";
import { kv } from "@vercel/kv";
import { updateTaskProps } from "./notion";
import { MENU_OFFSET_MAX } from "./task-buttons";
import { loadActiveDeals, recordAfterCreate } from "./task-record-wire";
import { toMenuTask } from "./task-menu-wire";
import type { MenuTask } from "./task-menu";
import {
  applyDealPick,
  takeDealPick,
  type DealDeps,
  type DealKv,
  type DealPickDeps,
  type DealTask,
} from "./deal-card";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const PAGE_SIZE = 100;

const notDone = { property: "ステータス", select: { does_not_equal: "完了" } };
const sorts = [{ property: "期日", direction: "ascending" as const }];

/** Notion のページ → 案件のある未完了タスク */
export function toDealTask(page: Record<string, unknown>): DealTask {
  const props = (page.properties as Record<string, unknown>) ?? {};
  const rel =
    (props["案件"] as { relation?: Array<{ id?: string }> } | undefined)
      ?.relation ?? [];
  return {
    ...toMenuTask(page),
    dealIds: rel
      .map((r) => r.id)
      .filter((id): id is string => typeof id === "string"),
  };
}

async function queryAll(filter: Record<string, unknown>): Promise<DealTask[]> {
  const out: DealTask[] = [];
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
      out.push(toDealTask(p as unknown as Record<string, unknown>));
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor && out.length < MENU_OFFSET_MAX);
  return out;
}

const originFilter = (groupId: string | null): Record<string, unknown>[] =>
  groupId ? [{ property: "発生元", rich_text: { equals: groupId } }] : [];

/** KV（URL と TOKEN の両方があるときだけ） */
export function defaultDealKv(): DealKv | null {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN)
    return null;
  return {
    get: (key) => kv.get(key),
    set: async (key, value, ex) => {
      await kv.set(key, value, { ex });
    },
    del: async (key) => {
      await kv.del(key);
    },
  };
}

export function dealDeps(): DealDeps {
  return {
    loadDeals: loadActiveDeals,
    listDealTasks: (groupId) =>
      queryAll({
        and: [
          notDone,
          ...originFilter(groupId),
          { property: "案件", relation: { is_not_empty: true } },
        ],
      }),
    listTasksOfDeal: async (dealId, groupId): Promise<MenuTask[]> =>
      queryAll({
        and: [
          notDone,
          ...originFilter(groupId),
          { property: "案件", relation: { contains: dealId } },
        ],
      }),
    kv: defaultDealKv(),
  };
}

export function dealPickDeps(): DealPickDeps {
  return {
    kv: defaultDealKv(),
    update: updateTaskProps,
    log: (line) => console.log(line),
  };
}

type RecordOpts = Parameters<typeof recordAfterCreate>[1];

/**
 * タスクを作った直後に呼ぶ（recordAfterCreate の代わり。route.ts の @秘書 の依頼の登録だけ）。
 * その人の［タスクを足す］の印があれば、TASK_RECORD の自動の照合を飛ばし、`案件` を「確定」で書いて印を消す
 * （TASK_RECORD が off でも案件だけは書く）。印が無ければ recordAfterCreate と同じ。
 * TASK_MENU off なら KV を呼ばない（今と同じ）。例外は投げない。
 */
export async function recordAfterCreateWithPick(
  pageId: string,
  opts: Omit<RecordOpts, "dealPicked">,
  deps: DealPickDeps = dealPickDeps(),
  record: typeof recordAfterCreate = recordAfterCreate,
): Promise<void> {
  const g = opts.groupId ?? null;
  const u = opts.senderId ?? null;
  const pick = await takeDealPick(g, u, deps);
  await record(pageId, { ...opts, dealPicked: pick !== null });
  if (pick && g && u) await applyDealPick(pageId, pick, g, u, deps);
}
