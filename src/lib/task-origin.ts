/**
 * タスクの「発生元」の読み方と、グループへ出してよいかの判定（2026-11-15）。
 *
 * 台帳「LINEタスク」には、営業の LINE グループ発のタスクと、下村さん個人の LINE WORKS 発のタスク
 * （Mac 側の line-secretary が 発生元＝"LINE WORKS" で登録）が混ざっている。
 * 営業部グループあての通知（期限前・朝のリマインド・棚卸し）に後者を載せると、本人の仕事が
 * 題名と名前つきでグループに出るので、ここで外す。
 *
 * 外すのは「LINE WORKS 発とはっきり分かるもの」だけ。発生元が空の古い行（10/12 より前の登録）と、
 * 発生元がグループ ID の行は今までどおり出す。
 */
export const ORIGIN_LINE_WORKS = "LINE WORKS";

/** Notion のページの properties から「発生元」を読む。空・欄なしは null */
export function originOf(props: Record<string, unknown>): string | null {
  const rich = (
    props["発生元"] as { rich_text?: Array<{ plain_text?: string }> } | undefined
  )?.rich_text;
  const s = (rich ?? []).map((t) => t.plain_text ?? "").join("").trim();
  return s || null;
}

/** LINE WORKS 発か（＝グループあての通知に載せない） */
export function isLineWorksOrigin(origin: string | null | undefined): boolean {
  return (origin ?? "").trim() === ORIGIN_LINE_WORKS;
}

/** グループあての通知に載せるもの（shown）と、載せないもの（hidden）に分ける。順番は変えない */
export function splitForGroup<T extends { origin: string | null }>(
  tasks: T[]
): { shown: T[]; hidden: T[] } {
  const shown: T[] = [];
  const hidden: T[] = [];
  for (const t of tasks) (isLineWorksOrigin(t.origin) ? hidden : shown).push(t);
  return { shown, hidden };
}
