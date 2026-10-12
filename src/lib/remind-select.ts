/**
 * 朝の知らせに載せるかどうかの判定（TASK_FOLLOWUP=1 のとき）。
 *
 * 今までは「未完了で、期日が明日まで」を毎朝すべて並べていた。
 * 「待ち」と返したものまで毎朝出るので、読まれなくなっていた。
 *   ・「次に確認する日」が先のものは出さない
 *   ・確認日が来たもの、入ったばかりのものは、期日が先でも出す
 */
export interface RemindRow {
  /** Notion の期日そのまま（"YYYY-MM-DD" か ISO 日時。無ければ ""） */
  dueDate: string;
  /** 次に確認する日（"YYYY-MM-DD"）。無ければ null */
  nextCheck: string | null;
  /** 登録した日（JST の "YYYY-MM-DD"） */
  createdDate: string;
}

export function shouldRemind(
  t: RemindRow,
  today: string,
  tomorrow: string,
  yesterday: string
): boolean {
  const check = t.nextCheck ? t.nextCheck.slice(0, 10) : null;
  if (check && check > today) return false;
  const due = t.dueDate.slice(0, 10);
  if (due && due <= tomorrow) return true;
  if (check) return true;
  return t.createdDate >= yesterday;
}

export function bucketOf(
  t: RemindRow,
  today: string,
  tomorrow: string
): "overdue" | "today" | "tomorrow" | "other" {
  const due = t.dueDate.slice(0, 10);
  if (!due || due > tomorrow) return "other";
  if (due < today) return "overdue";
  return due === today ? "today" : "tomorrow";
}
