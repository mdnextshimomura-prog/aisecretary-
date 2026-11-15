/**
 * 状況の返事を、本物の Notion と休業日カレンダーにつなぐ。
 * 判断は task-status.ts、言葉の読み取りは task-status-command.ts。
 */
import { loadClosures, shiftToBusinessDay, type Closure } from "./closures";
import { findTaskByRemindNumber, jstDateStr, updateTaskProps } from "./notion";
import { addDaysStr } from "./task-status-command";
import type { StatusDeps } from "./task-status";

/** 「待ち」で日付を省いたときの確認日。3 日後、休業日なら翌営業日。 */
export function defaultCheckDateFrom(todayJst: string, closures: Closure[]): string {
  return shiftToBusinessDay(addDaysStr(todayJst, 3), closures).date.slice(0, 10);
}

/**
 * inGroup：グループからの呼び出しか（省略時は true＝安全側）。グループでは、番号で LINE WORKS 発を
 * 引けない。1対1（false）は今までどおり。
 */
export function statusDeps(inGroup: boolean = true): StatusDeps {
  return {
    findByNumber: (n) => findTaskByRemindNumber(n, { anyDue: true, inGroup }),
    update: updateTaskProps,
    defaultCheckDate: async () =>
      defaultCheckDateFrom(jstDateStr(0), await loadClosures().catch(() => [])),
  };
}
