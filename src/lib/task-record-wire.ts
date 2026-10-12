/**
 * 記録の書き足し（task-record.ts）を、本物の Notion・名簿・CRM の案件につなぐ。
 */
import { Client } from "@notionhq/client";
import { resolveMember } from "./members";
import { appendTaskNote, updateTaskProps } from "./notion";
import {
  assigneeUserProps,
  enrichTask,
  recordEnabled,
  type DealRef,
  type RecordDeps,
} from "./task-record";

// CRM は別の連携（トークン）で読む。無ければ本体の連携で読む（workload.ts と同じ持ち方）
const crmNotion = new Client({
  auth: process.env.CRM_NOTION_TOKEN ?? process.env.NOTION_API_KEY,
});

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; deals: DealRef[] } | null = null;

/** 進行中（完了・失注以外）の案件の ID と名前。5 分だけ覚えておく。 */
export async function loadActiveDeals(): Promise<DealRef[]> {
  const dbId = process.env.CRM_DEALS_DB_ID;
  if (!dbId) throw new Error("CRM_DEALS_DB_ID 未設定");
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.deals;

  const deals: DealRef[] = [];
  let cursor: string | undefined;
  do {
    const res = await crmNotion.databases.query({
      database_id: dbId,
      start_cursor: cursor,
      page_size: 100,
      filter: {
        and: [
          { property: "フェーズ", select: { does_not_equal: "完了" } },
          { property: "フェーズ", select: { does_not_equal: "失注" } },
        ],
      },
    });
    for (const page of res.results) {
      const props =
        ((page as Record<string, unknown>).properties as Record<string, unknown>) ??
        {};
      const name = (
        (props["案件名"] as { title: Array<{ plain_text: string }> } | undefined)
          ?.title ?? []
      )
        .map((t) => t.plain_text)
        .join("");
      if (name) deals.push({ id: page.id, name });
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);

  cache = { at: Date.now(), deals };
  return deals;
}

function deps(): RecordDeps {
  return {
    loadDeals: loadActiveDeals,
    update: updateTaskProps,
    note: (pageId, line) => appendTaskNote(pageId, [line]),
    // 段の名前だけ出す（本文・LINE の ID・案件名は出さない）
    warn: (stage) => console.warn(`[task-record] 書けなかった段: ${stage}`),
  };
}

/**
 * タスクを作った直後に呼ぶ。スイッチが off なら何もしない。例外は投げない
 * （ここで落ちても、タスクの登録と返信は止めない）。
 */
export async function recordAfterCreate(
  pageId: string,
  opts: {
    senderId: string | null | undefined;
    groupId: string | null | undefined;
    assignee: string | null | undefined;
    assigneeUserId: string | null | undefined;
    propertyKey: string | null | undefined;
  }
): Promise<void> {
  if (!recordEnabled()) return;
  try {
    const requester = opts.senderId
      ? await resolveMember(opts.senderId, null)
      : null;
    const assignee =
      opts.assignee || opts.assigneeUserId
        ? await resolveMember(opts.assigneeUserId, opts.assignee)
        : null;
    await enrichTask(
      pageId,
      {
        requester: requester?.name ?? null,
        requesterId: opts.senderId ?? null,
        groupId: opts.groupId ?? null,
        assigneeNotionUserId: assignee?.notionUserId ?? null,
        propertyKey: opts.propertyKey ?? null,
      },
      deps()
    );
  } catch (err) {
    console.warn("[task-record] 記録の書き足しに失敗（登録は済み）:", err);
  }
}

/** 担当者を後から替えたときに、Notion ユーザーの欄も合わせる。失敗しても止めない。 */
export async function recordAssigneeChange(
  pageId: string,
  assignee: string | null,
  assigneeUserId: string | null
): Promise<void> {
  if (!recordEnabled()) return;
  try {
    const m = await resolveMember(assigneeUserId, assignee);
    await updateTaskProps(pageId, assigneeUserProps(m?.notionUserId ?? null));
  } catch {
    console.warn("[task-record] 書けなかった段: assignee-change");
  }
}
