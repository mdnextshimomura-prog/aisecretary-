/**
 * 期限前の通知（「⏰ まもなく期限です」）の本体。
 * - 期日当日に登録されたタスク（短期のもの）: 期限の1時間前に通知
 * - それより前に登録されたタスク: 期限の2時間前に通知
 * 期日に時刻が無いタスクは 18:00 を期限とみなす。
 * 通知は会社グループへ送り、担当者が分かる場合は@メンションを付ける。
 *
 * 起こす入口は 2 つ：/api/remind-due（CRON_SECRET。外から叩く仕組みは作られていない）と、
 * 毎分の見回り /api/obi/cloud-tick への相乗り（DUE_REMIND_TICK=1 のとき、10 分に 1 回）。
 */
import { kv } from "@vercel/kv";
import { getDueSoonTasks, markNotified } from "./notion";
import { pushLineMessageWithMentions, sanitizeForTextV2 } from "./line";

const LINE_GROUP_ID =
  process.env.LINE_GROUP_ID ?? "Cd5fda3261e9bdd012e598884b2e6a696";

const DEFAULT_DUE_HOUR = "18:00";
const JST_MS = 9 * 60 * 60 * 1000;

// ISO日時のJSTでの日付部分 "YYYY-MM-DD"
function jstDateOf(iso: string): string {
  return new Date(new Date(iso).getTime() + JST_MS).toISOString().slice(0, 10);
}

export async function runDueReminders(
  now: number = Date.now()
): Promise<{ checked: number; sent: number }> {
  const tasks = await getDueSoonTasks();
  let sent = 0;

  for (const t of tasks) {
    if (!t.dueStart) continue;

    // 期限日時（時刻なしはデフォルト18:00 JST）
    const dueIso =
      t.dueStart.length === 10
        ? `${t.dueStart}T${DEFAULT_DUE_HOUR}:00+09:00`
        : t.dueStart;
    const dueMs = Date.parse(dueIso);
    if (Number.isNaN(dueMs)) continue;

    // 当日登録（今日中タスク）は1時間前、事前に積まれたタスクは2時間前
    const leadMin = jstDateOf(t.createdTime) === jstDateOf(dueIso) ? 60 : 120;
    const notifyAt = dueMs - leadMin * 60 * 1000;
    if (now < notifyAt) continue;

    const dueLabel = new Date(dueMs + JST_MS)
      .toISOString()
      .slice(11, 16); // "HH:mm" (JST)

    let text = `⏰ まもなく期限です（本日${dueLabel}まで）\n・${sanitizeForTextV2(t.title)}`;
    const mentions: Record<string, string> = {};
    if (t.assignee) {
      text += "\n担当: ";
      if (t.assigneeUserId) {
        text += "{m1}";
        mentions.m1 = t.assigneeUserId;
      } else {
        text += `${t.assignee}さん`;
      }
    }

    await pushLineMessageWithMentions(LINE_GROUP_ID, text, mentions);
    await markNotified(t.id); // 送信後に印を付けて二重通知を防ぐ
    sent += 1;
  }

  return { checked: tasks.length, sent };
}

export const DUE_TICK_INTERVAL_MS = 10 * 60 * 1000;

export function dueTickEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.DUE_REMIND_TICK === "1";
}

/** 10 分ごとの枠の番号（同じ枠では 1 回しか動かさない） */
export function dueTickSlot(now: number): number {
  return Math.floor(now / DUE_TICK_INTERVAL_MS);
}

export interface DueTickDeps {
  /** その枠を取る。すでに取られていれば false */
  claim(slot: number): Promise<boolean>;
  run(now: number): Promise<{ checked: number; sent: number }>;
}

async function claimSlot(slot: number): Promise<boolean> {
  const r = await kv.set(`remind-due:slot:${slot}`, 1, { nx: true, ex: 60 * 60 });
  return r === "OK";
}

export type DueTickResult = "off" | "skip" | "ran";

/**
 * 毎分の見回りから呼ぶ。スイッチが入っていて、その 10 分の枠でまだ動かしていなければ通知を出す。
 * 枠を先に取る：見回りが重なっても 2 回出さない（二重の通知は「通知済み」の印でも防がれる）。
 */
export async function runDueRemindersOnTick(
  now: number,
  env: Record<string, string | undefined> = process.env,
  deps: DueTickDeps = { claim: claimSlot, run: runDueReminders }
): Promise<DueTickResult> {
  if (!dueTickEnabled(env)) return "off";
  if (!(await deps.claim(dueTickSlot(now)))) return "skip";
  const r = await deps.run(now);
  console.log(`[remind-due] tick / 対象候補 ${r.checked}件 / 送信 ${r.sent}件`);
  return "ran";
}
