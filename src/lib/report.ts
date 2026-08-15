/**
 * 休業明けの棚卸しレポート。
 *
 * 休業を挟むと「休業前から残って完了報告が出ていないもの」と
 * 「休業中に届いて溜まったもの」が混ざり、朝のリマインドの
 * 「期限超過◯件」だけでは何から手を付ければいいか分からない。
 * 初日の朝に、その2つを分けて出す。
 *
 * 送信はVercel Cron（10時）から。誰のPCが起動しているかに関係なく動く。
 */
import { getUpcomingTasksAll, setRemindNumber, jstDateStr } from "./notion";
import { pushLineMessageWithMentions, sanitizeForTextV2 } from "./line";

const LINE_GROUP_ID =
  process.env.LINE_GROUP_ID ?? "Cd5fda3261e9bdd012e598884b2e6a696";

// LINEの1通の上限は5000文字。溢れると送信ごと失敗するので余裕を持って絞る。
const MAX_BEFORE = 15; // 休業前から残っている分の表示件数
const MAX_DURING = 15; // 休業中に届いた分の表示件数
const MAX_MENTIONS = 20;

type Task = Awaited<ReturnType<typeof getUpcomingTasksAll>>[number];

const dueOnly = (t: Task) => (t.dueDate ?? "").slice(0, 10);

function daysOver(due: string, today: string): number {
  const d = Date.parse(`${due}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(d) || Number.isNaN(t)) return 0;
  return Math.round((t - d) / 86_400_000);
}

export interface ReportResult {
  sent: boolean;
  before: number;
  during: number;
  unassigned: number;
  /** dryRun のときだけ入る。実際に送られる本文 */
  preview?: string;
}

/**
 * 棚卸しを組み立ててLINEへ送る。
 * @param closureName 休業の名前（「お盆休み 2026」など。見出しに出す）
 * @param closureStart 休業の開始日。これ以降に登録されたものを「休業中に届いた」とみなす
 */
export async function sendClosureStocktake(
  closureName: string,
  closureStart: string,
  // 送らずに本文だけ返す。番号も振らない（動作確認・文面の事前確認に使う）
  dryRun = false
): Promise<ReportResult> {
  const today = jstDateStr(0);
  const tasks = await getUpcomingTasksAll();
  if (tasks.length === 0) {
    return { sent: false, before: 0, during: 0, unassigned: 0 };
  }

  // 登録日で「休業前から残っていたもの」と「休業中に届いたもの」に分ける
  const before = tasks.filter((t) => t.createdTime.slice(0, 10) < closureStart);
  const during = tasks.filter((t) => t.createdTime.slice(0, 10) >= closureStart);
  const unassigned = tasks.filter((t) => !t.assignee).length;

  // 期日の古い順（放置が長いものほど上）。
  // 期日なしは末尾へ。空文字のまま並べると最も古い扱いになり、
  // 何も情報のないタスクが一番上に出てしまう。
  const byDue = (a: Task, b: Task) => {
    const da = dueOnly(a) || "9999-12-31";
    const db = dueOnly(b) || "9999-12-31";
    return da.localeCompare(db);
  };
  before.sort(byDue);
  during.sort(byDue);

  const mentions: Record<string, string> = {};
  let mentionCount = 0;
  const shown: Task[] = [];

  const append = (t: Task) => {
    shown.push(t);
    const d = dueOnly(t);
    const label = d
      ? d < today
        ? `${daysOver(d, today)}日超過`
        : `期日${d.slice(5).replace("-", "/")}`
      : "期日なし";
    let line = `\n${shown.length}. ${sanitizeForTextV2(t.title)}`;
    if (t.propertyName) line += `【${sanitizeForTextV2(t.propertyName)}】`;
    line += `（${label}）`;
    if (t.assigneeUserId && t.assignee && mentionCount < MAX_MENTIONS) {
      mentionCount += 1;
      const key = `m${mentionCount}`;
      line += ` {${key}}`;
      mentions[key] = t.assigneeUserId;
    } else if (t.assignee) {
      line += `（担当：${t.assignee}）`;
    } else {
      line += "（担当未定）";
    }
    return line;
  };

  let text = `📋 ${closureName}明けの棚卸しです（未完了 ${tasks.length}件）\n`;

  if (during.length > 0) {
    text += `\n📥 休業中に届いたもの（${during.length}件）`;
    for (const t of during.slice(0, MAX_DURING)) text += append(t);
    const rest = during.length - MAX_DURING;
    if (rest > 0) text += `\n…ほか${rest}件`;
    text += "\n";
  }

  if (before.length > 0) {
    text += `\n⚠️ 休業前から残っているもの（${before.length}件）`;
    text += "\n※完了しているものは番号で返信してください";
    for (const t of before.slice(0, MAX_BEFORE)) text += append(t);
    const rest = before.length - MAX_BEFORE;
    if (rest > 0) text += `\n…ほか${rest}件（ダッシュボードで確認できます）`;
    text += "\n";
  }

  if (unassigned > 0) {
    text += `\n👤 担当が決まっていないものが ${unassigned}件 あります。\n引用リプライで担当者をメンションすると設定できます。`;
  }

  text +=
    "\n\n──────────\n" +
    "終わったものは番号で返信してください\n" +
    "例：「3済」「1,2完了」「4おわった」";

  if (dryRun) {
    return {
      sent: false,
      before: before.length,
      during: during.length,
      unassigned,
      preview: text,
    };
  }

  // 本文に載せた順で番号を確定させてから送る（送信後だと先に返信されたとき引けない）
  await Promise.all(shown.map((t, i) => setRemindNumber(t.id, i + 1)));
  await pushLineMessageWithMentions(LINE_GROUP_ID, text, mentions);

  return {
    sent: true,
    before: before.length,
    during: during.length,
    unassigned,
  };
}
