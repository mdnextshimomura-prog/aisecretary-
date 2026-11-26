/**
 * 段2：山口さんに頼む事例の期日（設計 2026-11-25-group-satei-stage2-design.md の 16「決まったこと」2）。通信はしない。
 * - ［いいよ］を押した時刻が、営業日（火・水以外。土日は営業日）の JST 17:00 より前 → その日の 18:00。
 * - 17:00 ちょうど以降・火・水に押した → 次の営業日の 18:00。
 * - 祝日・年末年始は扱わない（設計に無い。決まったら GS_CLOSED_DAYS とは別の表で足す）。
 * 戻り値はミリ秒（UTC の epoch）。表示は gsDeadlineLabel。
 */
export const GS_CLOSE_HOUR = 18;
export const GS_CUTOFF_HOUR = 17;
/** 休みの曜日（0=日 … 6=土）。火・水 */
export const GS_CLOSED_DAYS: readonly number[] = [2, 3];

const JST_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** JST の壁時計の 0:00（UTC の欄で読む値）がその曜日か */
const isBusinessDay = (jstMidnight: number) => !GS_CLOSED_DAYS.includes(new Date(jstMidnight).getUTCDay());

export function gsCaseDeadline(pressedAt: number): number {
  if (!Number.isFinite(pressedAt)) throw new RangeError("pressedAt");
  const local = pressedAt + JST_MS;
  let day = Math.floor(local / DAY_MS) * DAY_MS;
  const minutes = Math.floor((local - day) / 60_000);
  if (!(isBusinessDay(day) && minutes < GS_CUTOFF_HOUR * 60)) {
    do day += DAY_MS;
    while (!isBusinessDay(day));
  }
  return day + GS_CLOSE_HOUR * 60 * 60 * 1000 - JST_MS;
}

/** 「11/26（木）18時」の形（グループの依頼カード・リマインド・下村さんへの相談に使う） */
export function gsDeadlineLabel(deadline: number): string {
  const d = new Date(deadline + JST_MS);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAYS[d.getUTCDay()]}）${d.getUTCHours()}時`;
}
