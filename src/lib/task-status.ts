/**
 * 読み取った状況の言葉を、Notion の欄と LINE の返事にする。
 *
 * Notion と LINE を直接呼ばず、deps で受け取る（route.ts にはテストが無いので、
 * 判断の部分をここに出してテストする）。
 */
import type { StatusBody, StatusCommand } from "./task-status-command";

/** 新しい追いかけ方（状況の返事・朝の知らせの絞り込み）を使うか。外せば今までの動きに戻る。 */
export function followupEnabled(): boolean {
  return process.env.TASK_FOLLOWUP === "1";
}

export type CloseReason = "完了" | "不要" | "重複";

export function waitProps(note: string, checkDate: string) {
  return {
    ステータス: { select: { name: "進行中" } },
    // 理由を省いた「3待ち」では、前に入れた状況を消さない（確認日だけ延ばす使い方のため）
    ...(note ? { 状況: { rich_text: [{ text: { content: note } }] } } : {}),
    次に確認する日: { date: { start: checkDate } },
  };
}

export function postponeProps(dueDate: string) {
  return {
    期日: { date: { start: dueDate } },
    // 期限前の通知（/api/remind-due）を、新しい期日でもう一度出せるようにする
    通知済み: { checkbox: false },
  };
}

export function closeProps(reason: CloseReason) {
  return {
    ステータス: { select: { name: "完了" } },
    終わり方: { select: { name: reason } },
  };
}

export interface StatusDeps {
  findByNumber(n: number): Promise<{ id: string; title: string } | null>;
  update(pageId: string, props: Record<string, unknown>): Promise<void>;
  /** 「待ち」で日付を省いたときの、次に確認する日 */
  defaultCheckDate(): Promise<string>;
}

const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

async function applyBody(
  body: StatusBody,
  pageId: string,
  deps: Pick<StatusDeps, "update" | "defaultCheckDate">
): Promise<{ checkDate?: string }> {
  if (body.kind === "wait") {
    const checkDate = body.date ?? (await deps.defaultCheckDate());
    await deps.update(pageId, waitProps(body.note, checkDate));
    return { checkDate };
  }
  if (body.kind === "postpone") {
    // date が null のときは呼び出し側で弾く
    await deps.update(pageId, postponeProps(body.date as string));
    return {};
  }
  await deps.update(pageId, closeProps("不要"));
  return {};
}

const NEED_DATE =
  "⚠️ 延期する日を付けてください\n例：「3延期 10/20」「3延期 金曜」";

function head(body: StatusBody, count: number, checkDate?: string): string[] {
  if (body.kind === "wait") {
    const lines = [`⏸ 待ちにしました（${count}件）`];
    if (body.note) lines.push(`状況：${body.note}`);
    if (checkDate) lines.push(`次に確認する日：${md(checkDate)}（この日までは知らせません）`);
    return lines;
  }
  if (body.kind === "postpone") {
    return [`📅 期日を ${md(body.date as string)} に変えました（${count}件）`];
  }
  return [`🗑 不要にしました（${count}件。記録は残ります）`];
}

/** 番号つきの返事（「3待ち …」）を適用する。 */
export async function applyStatusCommand(
  cmd: StatusCommand,
  deps: StatusDeps
): Promise<{ text: string; changed: number }> {
  if (cmd.kind === "postpone" && !cmd.date) return { text: NEED_DATE, changed: 0 };

  const done: string[] = [];
  const notFound: number[] = [];
  let checkDate: string | undefined;
  for (const n of cmd.numbers) {
    const t = await deps.findByNumber(n);
    if (!t) {
      notFound.push(n);
      continue;
    }
    const r = await applyBody(cmd, t.id, deps);
    checkDate = r.checkDate ?? checkDate;
    done.push(`${n}. ${t.title}`);
  }

  const lines: string[] = [];
  if (done.length > 0) lines.push(...head(cmd, done.length, checkDate), ...done);
  if (notFound.length > 0) {
    if (done.length > 0) lines.push("");
    lines.push(
      `⚠️ ${notFound.join("・")}番は見つかりませんでした`,
      "（完了済みか、直近の知らせに無い番号です）"
    );
  }
  return { text: lines.join("\n"), changed: done.length };
}

/** 引用リプライ（対象が 1 件に決まっている）に適用する。 */
export async function applyStatusToTask(
  body: StatusBody,
  task: { id: string; title: string },
  deps: Pick<StatusDeps, "update" | "defaultCheckDate">
): Promise<string> {
  if (body.kind === "postpone" && !body.date) return NEED_DATE;
  const r = await applyBody(body, task.id, deps);
  return [...head(body, 1, r.checkDate), `📋 ${task.title}`].join("\n");
}
