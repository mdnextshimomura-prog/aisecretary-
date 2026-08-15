/**
 * 休業日カレンダー — 会社が休みの日に期日が当たらないようにする。
 *
 * 経緯:
 *   期日は「暦日」で数える設計にしてある（土日祝を飛ばさない）。不動産は
 *   土日も動くため、これは意図した仕様。ただし**会社の長期休業**は別で、
 *   お盆に「8/16(日)まで」と期日が付いても誰も対応できない。
 *
 * 設計:
 *   休業日は Notion の「休業日カレンダー」に置く。**行を足すだけで反映される**
 *   （コード変更もデプロイも要らない）。年末年始・GW・臨時休業もここで足す。
 *   引けない時は素通しする（fail-open）。休業日カレンダーの不調で
 *   タスク登録そのものが止まる方が損失が大きい。
 *
 * 土日の扱い:
 *   営業日のまま。休みにしたい場合はカレンダーに個別に足す。
 */
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const CLOSURES_DB_ID = process.env.NOTION_CLOSURES_DATABASE_ID ?? "";

export interface Closure {
  name: string;
  start: string; // "YYYY-MM-DD"
  end: string; // "YYYY-MM-DD"（単日なら start と同じ）
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; closures: Closure[] } | null = null;

/**
 * 予備の設定。Notionの休業日カレンダーが**まだ共有されていない／引けない**ときだけ使う。
 * Notionが読めればそちらが常に優先で、これは無視される（正は1つに保つ）。
 *   CLOSURE_DATES='[{"name":"お盆休み 2026","start":"2026-08-13","end":"2026-08-19"}]'
 */
function fallbackClosures(): Closure[] {
  const raw = process.env.CLOSURE_DATES;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as Closure[];
    return Array.isArray(arr)
      ? arr.filter((c) => c?.start).map((c) => ({
          name: c.name ?? "休業",
          start: c.start.slice(0, 10),
          end: (c.end ?? c.start).slice(0, 10),
        }))
      : [];
  } catch (err) {
    console.error("CLOSURE_DATES のJSON解析に失敗:", err);
    return [];
  }
}

export async function loadClosures(): Promise<Closure[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.closures;

  if (!CLOSURES_DB_ID) {
    const fb = fallbackClosures();
    cache = { at: Date.now(), closures: fb };
    return fb;
  }

  let res;
  try {
    res = await notion.databases.query({
      database_id: CLOSURES_DB_ID,
      page_size: 100,
      filter: { property: "有効", checkbox: { equals: true } },
    });
  } catch (err) {
    // まだ共有されていない等で読めない場合は予備の設定で動かす。
    // 休業日が読めないだけで期日計算を止めない。
    const fb = fallbackClosures();
    console.warn(
      `休業日カレンダーを読めないため予備の設定を使う（${fb.length}件）:`,
      err instanceof Error ? err.message : err
    );
    cache = { at: Date.now(), closures: fb };
    return fb;
  }

  const closures: Closure[] = [];
  for (const page of res.results) {
    const props =
      ((page as Record<string, unknown>).properties as Record<string, unknown>) ??
      {};
    const title = (props["名称"] as { title: Array<{ plain_text: string }> })
      ?.title;
    const date = (
      props["期間"] as { date: { start: string; end: string | null } | null }
    )?.date;
    if (!date?.start) continue;
    closures.push({
      name: title?.[0]?.plain_text ?? "休業",
      start: date.start.slice(0, 10),
      // 終了日が空なら単日の休業とみなす
      end: (date.end ?? date.start).slice(0, 10),
    });
  }

  cache = { at: Date.now(), closures };
  return closures;
}

/** その日が休業日なら、該当する休業の名前を返す（営業日なら null） */
export function closureOn(day: string, closures: Closure[]): string | null {
  const d = day.slice(0, 10);
  const hit = closures.find((c) => c.start <= d && d <= c.end);
  return hit ? hit.name : null;
}

function addDays(day: string, n: number): string {
  const t = Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

// 休業が延々と続く設定になっていても止まらないための上限
const MAX_SHIFT_DAYS = 60;

export interface ShiftResult {
  date: string;
  /** ずらした理由（ずらしていなければ null） */
  reason: string | null;
}

/**
 * 期日が休業日に当たっていたら、次の営業日へ送る。
 * 休業でなければそのまま返す。
 */
export function shiftToBusinessDay(
  dueDate: string,
  closures: Closure[]
): ShiftResult {
  if (closures.length === 0) return { date: dueDate, reason: null };

  let day = dueDate.slice(0, 10);
  const firstHit = closureOn(day, closures);
  if (!firstHit) return { date: dueDate, reason: null };

  for (let i = 0; i < MAX_SHIFT_DAYS; i++) {
    day = addDays(day, 1);
    if (!closureOn(day, closures)) {
      return { date: day, reason: `${firstHit}のため翌営業日` };
    }
  }
  // 上限に達したら元の期日を返す（設定ミスで永久に先送りされるのを防ぐ）
  console.error("休業日が長すぎて営業日が見つからない:", dueDate);
  return { date: dueDate, reason: null };
}

/**
 * 今日が「休業明けの初日」か。該当すればその休業の名前を返す。
 * 昨日が休業で今日が営業日なら初日、という単純な判定にしてある。
 *
 * この日は朝のリマインドを止め、代わりに10時の棚卸しを送る。
 * 両方送ると番号が二重に振られ、朝の番号で返信した人が
 * 別のタスクを完了にしてしまう。
 */
export function firstBusinessDayAfterClosure(
  todayJst: string,
  closures: Closure[]
): string | null {
  if (closureOn(todayJst, closures)) return null; // 今日がまだ休業中
  return closureOn(addDays(todayJst, -1), closures);
}

/** 今日が休業日か（朝のリマインドを止めるのに使う） */
export async function todayClosure(todayJst: string): Promise<string | null> {
  try {
    return closureOn(todayJst, await loadClosures());
  } catch (err) {
    // 引けないときは通常どおり動かす
    console.error("休業日カレンダーの取得に失敗（通常運転で続行）:", err);
    return null;
  }
}
