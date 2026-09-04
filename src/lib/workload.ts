import { Client } from "@notionhq/client";
import { normalizeName } from "./members";

const mainNotion = new Client({ auth: process.env.NOTION_API_KEY });
const crmNotion = new Client({
  auth: process.env.CRM_NOTION_TOKEN ?? process.env.NOTION_API_KEY,
});

const HASHIMOTO = "橋本 由人";
const ARIYOSHI = "有吉 勇弥";
const TARGETS = [HASHIMOTO, ARIYOSHI] as const;

export interface SalesWorkload {
  scores: Record<(typeof TARGETS)[number], number>;
  lastAssignee: (typeof TARGETS)[number] | null;
  sources: string[];
}

interface WorkItem {
  assignee: string | null;
  weight: number;
  createdTime: string;
  source: string;
}

const CACHE_TTL_MS = 2 * 60 * 1000;
let cache: { at: number; value: SalesWorkload } | null = null;

function selectName(
  props: Record<string, unknown>,
  key: string
): string | null {
  return (
    (props[key] as { select?: { name?: string } | null } | undefined)?.select
      ?.name ?? null
  );
}

function statusName(
  props: Record<string, unknown>,
  key: string
): string | null {
  return (
    (props[key] as { status?: { name?: string } | null } | undefined)?.status
      ?.name ?? null
  );
}

export function officialAssignee(
  name: string | null
): (typeof TARGETS)[number] | null {
  const normalized = normalizeName(name ?? "");
  // 案件ボードには「有吉」、名簿には「有吉 勇弥」のような差がある。
  // 1文字一致は誤爆しやすいので、2文字以上の完全一致・前方一致だけを許す。
  if (normalized.length < 2) return null;
  const matches = (official: string) => {
    const candidate = normalizeName(official);
    return candidate === normalized || candidate.startsWith(normalized);
  };
  if (matches(HASHIMOTO)) return HASHIMOTO;
  if (matches(ARIYOSHI)) return ARIYOSHI;
  return null;
}

async function queryAll(
  client: Client,
  databaseId: string,
  filter: Record<string, unknown>,
  source: string,
  assigneeProperty: string,
  weightFor: (props: Record<string, unknown>) => number
): Promise<WorkItem[]> {
  if (!databaseId) return [];
  const items: WorkItem[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.databases.query({
      database_id: databaseId,
      page_size: 100,
      start_cursor: cursor,
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      filter: filter as never,
    });
    for (const raw of response.results) {
      const page = raw as unknown as {
        created_time: string;
        properties: Record<string, unknown>;
      };
      items.push({
        assignee: selectName(page.properties, assigneeProperty),
        weight: weightFor(page.properties),
        createdTime: page.created_time,
        source,
      });
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor && items.length < 500);
  return items;
}

async function lineTaskItems(): Promise<WorkItem[]> {
  return queryAll(
    mainNotion,
    process.env.NOTION_DATABASE_ID ?? "",
    {
      and: [
        { property: "ステータス", select: { does_not_equal: "完了" } },
        {
          or: [
            { property: "種別", select: { equals: "売買" } },
            { property: "種別", select: { equals: "買取再販" } },
          ],
        },
      ],
    },
    "LINEタスク",
    "担当者",
    (props) => (selectName(props, "緊急度") === "今日中" ? 0.5 : 0.25)
  );
}

async function salesProgressItems(): Promise<WorkItem[]> {
  return queryAll(
    mainNotion,
    process.env.NOTION_SALES_PROGRESS_DATABASE_ID ?? "",
    { property: "ステータス", status: { does_not_equal: "完了" } },
    "売買案件進捗",
    "担当者（固定）",
    (props) => {
      const status = statusName(props, "ステータス");
      return status === "契約予定" || status === "引渡待" ? 1.5 : 1;
    }
  );
}

async function salesListingItems(): Promise<WorkItem[]> {
  return queryAll(
    mainNotion,
    process.env.NOTION_SALES_LISTING_DATABASE_ID ?? "",
    {
      and: [
        { property: "ステータス", status: { does_not_equal: "決済" } },
        { property: "ステータス", status: { does_not_equal: "completed" } },
      ],
    },
    "売却案件",
    "担当",
    () => 1
  );
}

async function crmDealItems(): Promise<WorkItem[]> {
  return queryAll(
    crmNotion,
    process.env.CRM_DEALS_DB_ID ?? "",
    {
      and: [
        { property: "フェーズ", select: { does_not_equal: "完了" } },
        { property: "フェーズ", select: { does_not_equal: "失注" } },
        {
          or: [
            { property: "案件種別", select: { equals: "売買仲介" } },
            { property: "案件種別", select: { equals: "買取" } },
            { property: "案件種別", select: { equals: "買取再販" } },
            { property: "取引の立場", select: { equals: "購入" } },
            { property: "取引の立場", select: { equals: "売却" } },
            { property: "取引の立場", select: { equals: "買取再販" } },
          ],
        },
      ],
    },
    "CRM案件",
    "担当（仮）",
    (props) => {
      const phase = selectName(props, "フェーズ");
      return phase === "契約" || phase === "決済・引渡" ? 1.5 : 1;
    }
  );
}

/**
 * 同じ案件が複数ボードに載って二重計上されないよう、案件ボードは1つだけ採用する。
 * 優先順位は CRM案件 → 売買案件進捗 → 売却案件。
 */
async function primaryCaseItems(): Promise<WorkItem[]> {
  const candidates: Array<{
    enabled: boolean;
    load: () => Promise<WorkItem[]>;
    label: string;
  }> = [
    {
      enabled: Boolean(process.env.CRM_DEALS_DB_ID),
      load: crmDealItems,
      label: "CRM案件",
    },
    {
      enabled: Boolean(process.env.NOTION_SALES_PROGRESS_DATABASE_ID),
      load: salesProgressItems,
      label: "売買案件進捗",
    },
    {
      enabled: Boolean(process.env.NOTION_SALES_LISTING_DATABASE_ID),
      load: salesListingItems,
      label: "売却案件",
    },
  ];

  for (const candidate of candidates) {
    if (!candidate.enabled) continue;
    try {
      return await candidate.load();
    } catch (err) {
      console.error(`${candidate.label}を取得できず次の案件ボードへ切替:`, err);
    }
  }
  return [];
}

/**
 * Notion上の進行中案件と未完了タスクを合算する。
 * 案件=1点、契約・引渡段階=1.5点、LINEタスク=0.25点（今日中は0.5点）。
 * 任意の案件DBが未設定・取得失敗でも、取得できた情報だけで継続する。
 */
export async function loadSalesWorkload(): Promise<SalesWorkload> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const settled = await Promise.allSettled([lineTaskItems(), primaryCaseItems()]);
  const items: WorkItem[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") items.push(...result.value);
    else console.error("担当負荷データの一部を取得できませんでした:", result.reason);
  }

  const scores: SalesWorkload["scores"] = {
    [HASHIMOTO]: 0,
    [ARIYOSHI]: 0,
  };
  let lastAssignee: SalesWorkload["lastAssignee"] = null;
  let latest = "";
  const sources = new Set<string>();

  for (const item of items) {
    const assignee = officialAssignee(item.assignee);
    if (!assignee) continue;
    scores[assignee] += item.weight;
    sources.add(item.source);
    if (item.createdTime > latest) {
      latest = item.createdTime;
      lastAssignee = assignee;
    }
  }

  const value = {
    scores: {
      [HASHIMOTO]: Number(scores[HASHIMOTO].toFixed(2)),
      [ARIYOSHI]: Number(scores[ARIYOSHI].toFixed(2)),
    },
    lastAssignee,
    sources: Array.from(sources),
  };
  cache = { at: Date.now(), value };
  return value;
}

/** 同じ実行環境へ続けて届いた依頼が同じ人へ偏らないよう、キャッシュへ仮加算する。 */
export function recordSalesAssignment(assignee: string): void {
  if (!cache) return;
  const official = officialAssignee(assignee);
  if (!official) return;
  cache.value.scores[official] = Number(
    (cache.value.scores[official] + 0.25).toFixed(2)
  );
  cache.value.lastAssignee = official;
}
