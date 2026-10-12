/**
 * LINE から返す「状況の言葉」を読み取る。
 *
 *   「3待ち 売主の書類 金曜」→ 相手待ち（理由と、次に確認する日）
 *   「3延期 10/20」         → 期日を変える
 *   「3不要」               → やらなくてよくなった（記録は残す）
 *
 * 完了（「3済」）はここでは扱わない。route.ts の parseNumberedCompletion が今までどおり読む。
 *
 * 数字だけの返事はコマンドにしない。営業部のグループでは、引用つきの数字だけの返事を
 * 帯替えの訂正の枝が先に確かめるため、形を分けておく。
 */

export type StatusBody =
  | { kind: "wait"; note: string; date: string | null }
  | { kind: "postpone"; date: string | null }
  | { kind: "drop" };

export type StatusCommand = StatusBody & { numbers: number[] };

const MAX_COMMAND_LENGTH = 60;
const MAX_NOTE_LENGTH = 40;

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function addDaysStr(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function normalize(text: string): string {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/／/g, "/")
    .replace(/　/g, " ")
    .trim();
}

/** 日付の言葉を YYYY-MM-DD にする。読めなければ null。 */
export function resolveDateToken(token: string, todayJst: string): string | null {
  const t = normalize(token).replace(/(まで|までに|に|へ|。)$/, "");
  if (t === "今日" || t === "本日") return todayJst;
  if (t === "明日") return addDaysStr(todayJst, 1);
  if (t === "明後日") return addDaysStr(todayJst, 2);

  const md = t.match(/^(\d{1,2})[/月](\d{1,2})日?$/);
  if (md) {
    const month = Number(md[1]);
    const dayOfMonth = Number(md[2]);
    const year = Number(todayJst.slice(0, 4));
    for (const y of [year, year + 1]) {
      const d = new Date(Date.UTC(y, month - 1, dayOfMonth));
      // 13/40 のような日付は、月日がずれるので弾く
      if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== dayOfMonth) {
        return null;
      }
      const s = d.toISOString().slice(0, 10);
      if (s >= todayJst) return s;
    }
    return null;
  }

  const wd = t.match(/^(来週)?([日月火水木金土])(曜|曜日)?$/);
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[2]);
    const today = new Date(`${todayJst}T00:00:00Z`).getUTCDay();
    if (wd[1]) {
      // 来週＝次の月曜から始まる週
      const toNextMonday = ((8 - today) % 7) || 7;
      const offsetFromMonday = (target + 6) % 7;
      return addDaysStr(todayJst, toNextMonday + offsetFromMonday);
    }
    // 「金曜」＝今日より後で最初に来る金曜（今日が金曜なら来週の金曜）
    const diff = ((target - today + 7) % 7) || 7;
    return addDaysStr(todayJst, diff);
  }
  return null;
}

// 待ち・延期の後ろは、空白か文末に限る。前方一致だけだと「待ち合わせは14時で」
// 「2まちがいです」まで待ちとして読んでしまう。
const WAIT_POSTPONE_RE = /^(待ち|まち|延期)(?:\s+(.*))?$/;
// 不要は「3不要です。」のように語尾が続くので、後ろをそのまま取って下で確かめる
const DROP_RE = /^(不要|いらない)(.*)$/;

/** 番号なしの本文（「待ち 売主の書類 金曜」）を読む。引用リプライ用。 */
export function parseStatusBody(
  text: string,
  todayJst: string,
): StatusBody | null {
  const t = normalize(text);
  if (t.length === 0 || t.length > MAX_COMMAND_LENGTH) return null;
  const m = t.match(WAIT_POSTPONE_RE) ?? t.match(DROP_RE);
  if (!m) return null;
  const word = m[1];
  const rest = (m[2] ?? "").trim();

  if (word === "不要" || word === "いらない") {
    // 後ろに文が続くなら依頼文（「不要な書類を整理して」）
    return rest.replace(/^(です|でした)?[。.!！]*$/, "") === ""
      ? { kind: "drop" }
      : null;
  }

  if (word === "延期") {
    if (rest === "") return { kind: "postpone", date: null };
    const date = resolveDateToken(rest, todayJst);
    // 後ろが日付として読めないなら依頼文（「延期の連絡をしてください」）
    return date ? { kind: "postpone", date } : null;
  }

  // 待ち：最後の語が日付なら「次に確認する日」、残りが理由
  const tokens = rest.split(/\s+/).filter(Boolean);
  let date: string | null = null;
  if (tokens.length > 0) {
    const last = resolveDateToken(tokens[tokens.length - 1], todayJst);
    if (last) {
      date = last;
      tokens.pop();
    }
  }
  const note = tokens.join(" ");
  if (note.length > MAX_NOTE_LENGTH) return null;
  return { kind: "wait", note, date };
}

const HEAD_RE = /^(\d{1,3}(?:[\s,、，・]+\d{1,3})*)\s*(.+)$/;

/** 番号つき（「3待ち 売主の書類 金曜」「1,2延期 10/20」）を読む。 */
export function parseStatusCommand(
  text: string,
  todayJst: string
): StatusCommand | null {
  const t = normalize(text);
  if (t.length === 0 || t.length > MAX_COMMAND_LENGTH) return null;
  const m = t.match(HEAD_RE);
  if (!m) return null;
  const nums = (m[1].match(/\d+/g) ?? []).map(Number);
  if (nums.some((n) => n < 1 || n > 99)) return null;
  const numbers = nums.filter((n, i) => nums.indexOf(n) === i);
  if (numbers.length === 0) return null;
  const body = parseStatusBody(m[2], todayJst);
  return body ? { ...body, numbers } : null;
}
