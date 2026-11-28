import { Client } from "@notionhq/client";
import type { ParsedTask } from "./claude";
import { closeProps, followupEnabled } from "./task-status";
import { isLineWorksOrigin, originOf, ORIGIN_LINE_WORKS } from "./task-origin";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATABASE_ID = process.env.NOTION_DATABASE_ID!;

// グループあての取得で、LINE WORKS 発を Notion の側で外す絞り込み条件。
// 手元で外すだけだと、LINE WORKS 発が 1 ページ（100件）を埋めたときに後ろのグループ発を取りこぼす。
// 発生元が空の古い行は「空である」を明示して必ず通す（does_not_equal の空の扱いに頼らない）。
const NOT_LINE_WORKS = {
  or: [
    { property: "発生元", rich_text: { is_empty: true as const } },
    { property: "発生元", rich_text: { does_not_equal: ORIGIN_LINE_WORKS } },
  ],
};

export async function createNotionTask(
  task: ParsedTask,
  rawMessage: string,
  /**
   * 発端になったLINEメッセージID。**作成時に一緒に書き込む**。
   *
   * 作成後に別途書き込む作りだと、作成の応答だけが失われたときに
   * 「このメッセージのタスクは既にあるか？」を問い合わせても見つからず、
   * 再送で同じ依頼が二重に登録される。
   */
  sourceMessageId?: string
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
      ...(sourceMessageId && {
        メッセージID: {
          rich_text: [{ text: { content: sourceMessageId } }],
        },
      }),
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
    /** 発生元（グループ ID／"LINE WORKS"）。空なら null。グループへ出すかの判定に使う */
    origin: string | null;
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
        // 送り先は営業部グループ。LINE WORKS 発は Notion の側でも外す（呼び出し側でも外す＝二重の守り）
        NOT_LINE_WORKS,
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
      origin: originOf(props),
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
): Promise<{ id: string; title: string; origin: string | null } | null> {
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
    origin: originOf(props),
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
    properties: followupEnabled()
      ? // 終わり方（完了／不要／重複）を残す。「不要」は状況の返事（3不要）が入れる
        (closeProps("完了") as Parameters<
          typeof notion.pages.update
        >[0]["properties"])
      : { ステータス: { select: { name: "完了" } } },
  });
}

// 状況の返事（待ち・延期・不要）で、欄をまとめて書き換える。
// 欄の組み立ては task-status.ts（テストあり）が行い、ここは渡すだけ。
export async function updateTaskProps(
  pageId: string,
  properties: Record<string, unknown>
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: properties as Parameters<
      typeof notion.pages.update
    >[0]["properties"],
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

// 1件の番号を消す。グループあての知らせから外したタスク（LINE WORKS 発）に古い番号が残っていると、
// 新しく振った同じ番号と重なり、「3済」が外したほうに当たることがあるため。
export async function clearRemindNumber(pageId: string): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: { リマインド番号: { number: null } },
  });
}

// グループあての知らせから外したタスク（LINE WORKS 発）のうち、番号が残っているものを消す。
// 消せなかった件数を返す。失敗は握りつぶさず 1 行だけログに出す（番号・ID・題名は出さない）。
// 消せなくても、番号検索（findTaskByRemindNumber）が LINE WORKS 発を外すので取り違えは起きない。
export async function clearHiddenRemindNumbers(
  hidden: Array<{ id: string; remindNumber: number | null }>,
  label: string,
  log: (line: string) => void = (l) => console.error(l)
): Promise<number> {
  const targets = hidden.filter((t) => t.remindNumber !== null);
  const results = await Promise.allSettled(
    targets.map((t) => clearRemindNumber(t.id))
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) log(`[${label}] hidden-number-clear-failed ${failed}/${targets.length}`);
  return failed;
}

// 今回の知らせに載せなかったタスクの番号を消す。
// 新しい知らせ方では期日が先のタスクにも番号が付くので、古い番号が残っていると
// 「3済」が別のタスクに当たる。知らせるたびに、載せた分以外の番号を消しておく。
export async function clearStaleRemindNumbers(keepIds: string[]): Promise<number> {
  const keep = new Set(keepIds);
  let cleared = 0;
  let cursor: string | undefined;
  do {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      start_cursor: cursor,
      filter: {
        and: [
          { property: "リマインド番号", number: { is_not_empty: true } },
          { property: "ステータス", select: { does_not_equal: "完了" } },
        ],
      },
    });
    for (const page of response.results) {
      if (keep.has(page.id)) continue;
      await notion.pages.update({
        page_id: page.id,
        properties: { リマインド番号: { number: null } },
      });
      cleared++;
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);
  return cleared;
}

// リマインド番号からタスクを引く。
// 「未完了」かつ「期日が明日まで」＝リマインドに載る範囲に限定しているため、
// 過去に振られた古い番号を誤って拾うことがない（範囲内のタスクは毎回振り直されるため）。
export async function findTaskByRemindNumber(
  num: number,
  /**
   * inGroup：グループからの呼び出しか（省略時は true＝安全側）。グループでは LINE WORKS 発を引けない
   * ようにする（古い番号が残っていても題名を返さない・完了にしない）。Notion の側で外し、手元でも外す。
   * 1対1（false）は今までどおり引ける。同じ番号が重なっていたら、知らせに載っているほう
   * （LINE WORKS 発でないほう）を先に使う。
   */
  opts: { anyDue?: boolean; inGroup?: boolean } = {}
): Promise<{ id: string; title: string } | null> {
  const inGroup = opts.inGroup ?? true;
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        { property: "リマインド番号", number: { equals: num } },
        { property: "ステータス", select: { does_not_equal: "完了" } },
        // anyDue：新しい知らせ方では、期日が先のタスクにも番号が付く。
        // 古い番号の取り違えは、知らせるたびに載せなかったタスクの番号を消すことで防ぐ
        ...(opts.anyDue
          ? []
          : [{ property: "期日", date: { on_or_before: jstDateStr(1) } }]),
        ...(inGroup ? [NOT_LINE_WORKS] : []),
      ],
    },
  });

  const propsOf = (pg: unknown) =>
    ((pg as Record<string, unknown>).properties as Record<string, unknown>) ?? {};
  const notLineWorks = response.results.find(
    (pg) => !isLineWorksOrigin(originOf(propsOf(pg)))
  );
  const page = notLineWorks ?? (inGroup ? undefined : response.results[0]);
  if (!page) return null;
  const props = propsOf(page);
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
    /** 発生元（グループ ID／"LINE WORKS"）。空なら null */
    origin: string | null;
    /** いま入っているリマインド番号。無ければ null */
    remindNumber: number | null;
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
      origin: originOf(props),
      remindNumber:
        (props["リマインド番号"] as { number: number | null } | undefined)
          ?.number ?? null,
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
export async function getUpcomingTasks(opts: { followup?: boolean } = {}): Promise<
  Array<{
    id: string;
    title: string;
    dueDate: string;
    urgency: string;
    assignee: string | null;
    assigneeUserId: string | null;
    /** 「要確認」＝初動確認の回答待ち。リマインドで別枠に出して回答を促す */
    status: string;
    url: string;
    /** 次に確認する日（"YYYY-MM-DD"）。無ければ null */
    nextCheck: string | null;
    /** 状況（待ち相手・理由のひとこと）。無ければ "" */
    note: string;
    /** 登録した日（JST の "YYYY-MM-DD"） */
    createdDate: string;
    /** 発生元（グループ ID／"LINE WORKS"）。空なら null */
    origin: string | null;
    /** いま入っているリマインド番号。無ければ null */
    remindNumber: number | null;
    /** 物件名。空なら null（担当へのまとめ STAFF_DIGEST が添える。ほかは読まない） */
    propertyName: string | null;
    /** ページの最終更新（Notion の last_edited_time。無ければ ""。STAFF_DIGEST の「Notion で更新＝返事あり」だけが読む） */
    lastEdited: string;
  }>
> {
  const tomorrowStr = jstDateStr(1);
  const notDone = { property: "ステータス", select: { does_not_equal: "完了" } };
  const dueSoon = { property: "期日", date: { on_or_before: tomorrowStr } };

  // followup（TASK_FOLLOWUP=1）のときだけ、期日が先のタスクも候補に入れる。
  // 載せるかどうかの最終判定は remind-select.ts の shouldRemind が行う。
  // 「入ったばかり」は登録日時での絞り込みで、Notion の型の都合で入れ子の or に
  // 混ぜられないため、問い合わせを 2 本に分けて ID で重ねる。
  const sorts = [{ property: "期日", direction: "ascending" as const }];
  const primary = await notion.databases.query({
    database_id: DATABASE_ID,
    sorts,
    filter: opts.followup
      ? {
          and: [
            notDone,
            {
              or: [
                dueSoon,
                // 確認日が来たもの（待ちにしていたもの）
                {
                  property: "次に確認する日",
                  date: { on_or_before: jstDateStr(0) },
                },
              ],
            },
          ],
        }
      : { and: [dueSoon, notDone] },
  });
  const results = [...primary.results];
  if (opts.followup) {
    // 入ったばかりのもの（期日が先でも一度は知らせる）
    const fresh = await notion.databases.query({
      database_id: DATABASE_ID,
      sorts,
      filter: {
        and: [
          notDone,
          {
            timestamp: "created_time",
            created_time: { on_or_after: `${jstDateStr(-1)}T00:00:00+09:00` },
          },
        ],
      },
    });
    const seen = new Set(results.map((r) => r.id));
    for (const r of fresh.results) if (!seen.has(r.id)) results.push(r);
  }

  return results.map((page) => {
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
      status:
        (props["ステータス"] as { select: { name: string } | null } | undefined)
          ?.select?.name ?? "未着手",
      url: (p.url as string) ?? "",
      nextCheck:
        (
          props["次に確認する日"] as
            | { date: { start: string } | null }
            | undefined
        )?.date?.start?.slice(0, 10) ?? null,
      note:
        (
          props["状況"] as
            | { rich_text: Array<{ plain_text: string }> }
            | undefined
        )?.rich_text
          ?.map((r) => r.plain_text)
          .join("") ?? "",
      createdDate: (() => {
        const ms = Date.parse((p.created_time as string) ?? "");
        return Number.isNaN(ms)
          ? ""
          : new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
      })(),
      origin: originOf(props),
      remindNumber:
        (props["リマインド番号"] as { number: number | null } | undefined)
          ?.number ?? null,
      propertyName:
        (
          props["物件名"] as
            | { rich_text: Array<{ plain_text: string }> }
            | undefined
        )?.rich_text
          ?.map((r) => r.plain_text)
          .join("") || null,
      lastEdited: typeof p.last_edited_time === "string" ? p.last_edited_time : "",
    };
  });
}

/**
 * タスクのNotionページ**本文**に一行追記する。
 *
 * プロパティではなく本文に書くのは、**DBのスキーマを変えずに済ませる**ため。
 * 稼働中の会社DBにプロパティを足すのは、失敗したときの影響が大きい。
 * 本文なら追記のみで、既存データを一切壊さない。
 *
 * 確認のやりとり（提案→承認、指示の追加）を時系列で残す用途に使う。
 */
export async function appendTaskNote(
  pageId: string,
  lines: string[]
): Promise<void> {
  if (lines.length === 0) return;
  await notion.blocks.children.append({
    block_id: pageId,
    children: lines.map((line) => ({
      object: "block" as const,
      type: "paragraph" as const,
      paragraph: {
        rich_text: [{ type: "text" as const, text: { content: line } }],
      },
    })),
  });
}
