import { getUpcomingTasks, jstDateStr, setRemindNumber } from "./notion";
import { pushLineChunks, sanitizeForTextV2 } from "./line";
import { buildChunks, type ChunkItem } from "./chunk";
import { STATUS_PENDING } from "./clarify";
import { loadClosures, closureOn, firstBusinessDayAfterClosure } from "./closures";
import { buildHandoffMessage } from "./clarify";
import { pushLineMessage, pushLineMessageWithMentions } from "./line";
import { getPendingHandoffs, removePendingHandoff } from "./email/session";
import { listTasks } from "./notion";

/**
 * 送信に失敗した「担当者への引き渡し」を送り直す。
 *
 * 通常のリマインドは**期日が明日までのタスクしか出さない**ため、
 * 納期の長いタスク（査定書は7日）は何日も表に出てこない。
 * 引き渡しの失敗をリマインド任せにすると、条件は固まったのに
 * 担当者が何日も気づかないことになる。ここで独立に再送する。
 */
async function retryPendingHandoffs(): Promise<void> {
  const pendings = await getPendingHandoffs(LINE_GROUP_ID).catch(() => []);
  if (pendings.length === 0) return;

  // 既に完了・削除されたタスクへは送らない
  const alive = new Map(
    (await listTasks().catch(() => []))
      .filter((t) => t.status !== "完了")
      .map((t) => [t.id, t])
  );

  for (const p of pendings) {
    if (!alive.has(p.pageId)) {
      await removePendingHandoff(LINE_GROUP_ID, p.pageId).catch(() => undefined);
      continue;
    }
    const hasMention = Boolean(p.assigneeUserId);
    const text = buildHandoffMessage(
      p.title,
      p.propertyName ?? null,
      p.settled,
      p.fields,
      p.assignee ?? null,
      hasMention
    );
    const ok = await (hasMention && p.assigneeUserId
      ? pushLineMessageWithMentions(LINE_GROUP_ID, text, { assignee: p.assigneeUserId })
      : pushLineMessage(LINE_GROUP_ID, text)
    ).catch(() => false);
    if (ok) {
      console.log("[remind] 引き渡しを再送しました:", p.pageId);
      await removePendingHandoff(LINE_GROUP_ID, p.pageId).catch(() => undefined);
    } else {
      console.error("[remind] 引き渡しの再送に失敗（次回に持ち越し）:", p.pageId);
    }
  }
}

// リマインドの送信先＝会社グループ。反響通知と同じグループに送る。
const LINE_GROUP_ID =
  process.env.LINE_GROUP_ID ?? "Cd5fda3261e9bdd012e598884b2e6a696";

type UpcomingTask = Awaited<ReturnType<typeof getUpcomingTasks>>[number];

// 期日は時刻付き（"2026-08-02T15:00:00+09:00"）で保存されることがある。
// 日付だけを取り出さないと "YYYY-MM-DD" との比較が常に不一致になり、
// 「時刻を指定した本日期限のタスクが明日扱いになる」不具合が起きる。
function dueDateOnly(t: UpcomingTask): string {
  return (t.dueDate ?? "").slice(0, 10);
}

// 期日から何日超過しているか（JST基準の日数差）
function daysOverdue(dueStr: string, todayStr: string): number {
  const due = Date.parse(`${dueStr}T00:00:00Z`);
  const today = Date.parse(`${todayStr}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(today)) return 0;
  return Math.round((today - due) / 86_400_000);
}

export async function sendDailyReminders(): Promise<void> {
  const todayStr = jstDateStr(0);

  // 会社が休みの日は送らない。誰も対応できない日に
  // 「期限超過30件」を毎朝投げても、読まれなくなるだけ。
  const closures = await loadClosures().catch(() => []);
  const closure = closureOn(todayStr, closures);
  if (closure) {
    console.log(`[remind] ${closure}のため送信しない (${todayStr})`);
    return;
  }

  // 休業明けの初日は、10時の棚卸し（/api/report）に任せて朝は送らない。
  // 両方送ると番号が二重に振られ、朝の番号で返信した人が
  // 別のタスクを完了にしてしまう。
  const back = firstBusinessDayAfterClosure(todayStr, closures);
  if (back) {
    console.log(`[remind] ${back}明けの初日。10時の棚卸しに任せる (${todayStr})`);
    return;
  }

  // 送れていない引き渡しを先に片付ける。リマインド本体より優先度が高い
  // （担当者がまだ着手を知らない状態なので）
  await retryPendingHandoffs().catch((e) =>
    console.error("[remind] 引き渡し再送でエラー:", e)
  );

  // 期日が明日まで・未完了のタスク（期限超過を含む）を期日の古い順で取得
  const tasks = await getUpcomingTasks();
  if (tasks.length === 0) return;

  const tomorrowStr = jstDateStr(1);

  // 初動確認の回答待ち。期日の枠に混ぜず先頭に独立させる。
  // 混ぜると「担当者がやっていない」ように見えるが、実際は
  // **依頼者の回答が無くて着手できない**状態で、動かすべき人が違う。
  const pendingTasks = tasks.filter((t) => t.status === STATUS_PENDING);
  const actionable = tasks.filter((t) => t.status !== STATUS_PENDING);

  const overdueTasks = actionable.filter((t) => dueDateOnly(t) < todayStr);
  const todayTasks = actionable.filter((t) => dueDateOnly(t) === todayStr);
  const tomorrowTasks = actionable.filter((t) => dueDateOnly(t) === tomorrowStr);

  // 本文に載せる順（この順に1から番号を振る）
  const shown: UpcomingTask[] = [];
  const items: ChunkItem[] = [];

  const push = (t: UpcomingTask, suffix?: string) => {
    shown.push(t);
    let text = `${shown.length}. ${sanitizeForTextV2(t.title)}（${suffix ?? t.urgency}）`;
    // userIdが無い担当者はメンションできないので名前だけ出す
    if (t.assignee && !t.assigneeUserId) text += `（担当：${t.assignee}）`;
    items.push({ text, userId: t.assigneeUserId });
  };

  // 確認待ちを最上段に出す。ここが詰まっている限り担当者は手を出せない。
  if (pendingTasks.length > 0) {
    items.push({ text: `\n❓ 条件の確認待ち（${pendingTasks.length}件）` });
    for (const t of pendingTasks) push(t, "回答待ち");
  }

  // 期限超過を最初に出す。放置されているものほど上に来るよう古い順のまま。
  // 以前は10件で打ち切って「…ほか18件（Notionで確認）」としていたが、
  // LINEだけで消し込めないと結局進まないので**全件出す**。
  // 長くなったぶんは chunk.ts が複数通に分ける。
  if (overdueTasks.length > 0) {
    items.push({ text: `\n⚠️ 期限超過（${overdueTasks.length}件）` });
    for (const t of overdueTasks) {
      push(t, `${daysOverdue(dueDateOnly(t), todayStr)}日超過`);
    }
  }
  if (todayTasks.length > 0) {
    items.push({ text: `\n【本日期限】` });
    for (const t of todayTasks) push(t);
  }
  if (tomorrowTasks.length > 0) {
    items.push({ text: `\n【明日期限】` });
    for (const t of tomorrowTasks) push(t);
  }

  const footer =
    "\n\n──────────\n" +
    "終わったものは番号で返信してください\n" +
    "例：「3済」「1,2完了」「4おわった」";

  const chunks = buildChunks("🔔 本日のリマインドです", items, footer);

  // 本文に載せた順で番号を確定させてから送る。
  // 送信後に番号を振ると、先に返信されたときに引けないため順序が重要。
  await Promise.all(shown.map((t, i) => setRemindNumber(t.id, i + 1)));
  await pushLineChunks(LINE_GROUP_ID, chunks);
}
