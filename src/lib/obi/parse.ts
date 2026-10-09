/**
 * 帯替え・査定の依頼文の読み取り（設計 2026-10-09 の 7）。
 *
 * line-secretary の src/jobs/parse.js をそのまま移したもの。秘書室とグループで
 * 依頼の読み方がずれないよう、**同じ入力から同じ結果になること**を共通の表
 * tests/fixtures/job-command-cases.json で固定している（line-secretary 側にも同じ表を置く）。
 * ここを直すときは、parse.js と表も同時に直すこと。
 */
export type JobCommand =
  | { action: "review"; no: number; verdict: "ok" | "fix" }
  | {
      action: "request";
      workflow: "obi" | "satei";
      property: string;
      assigneeName: string;
    };

// 全角英数・全角空白・全角＃だけを半角に正規化する（他の記号はそのまま。担当の "：" 等は正規化しない）
function normalizeFullWidth(s: string): string {
  return String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .replace(/＃/g, "#");
}

const REVIEW_RE = /^#\s*J\s*(\d{1,6})\s*(OK|オーケー|完成|直す|直して|差し戻し)$/i;
const OBI_WORDS = ["帯替え", "帯かえ", "帯変え", "オビ替え", "おび替え"];
// 長い語を先に試す（"してください" の前に "して" だけ剥がしてしまわないため）
const FILLERS = ["してください", "して下さい", "お願いします", "下さい", "お願い", "して", "依頼", "を"];
const ASSIGNEE_RE = /担当[:：\s]*(\S+?)(さん)?(\s|$)/;

function verdictOf(word: string): "ok" | "fix" {
  return /^ok$/i.test(word) || word === "オーケー" || word === "完成" ? "ok" : "fix";
}

function isRequestSeparator(rest: string): boolean {
  return rest === "" || /^\s/.test(rest) || FILLERS.some((filler) => rest.startsWith(filler));
}

// 読み飛ばす語を、先頭からなくなるまで繰り返し除く（「をお願いします」「依頼お願いします」のように続くため）
function stripFiller(text: string): string {
  let rest = text;
  for (;;) {
    const filler = FILLERS.find((f) => rest.startsWith(f));
    if (!filler) return rest;
    rest = rest.slice(filler.length);
  }
}

function extractAssignee(text: string): { rest: string; assigneeName: string } {
  const m = text.match(ASSIGNEE_RE);
  if (!m || m.index === undefined) return { rest: text, assigneeName: "" };
  const rest = text.slice(0, m.index) + " " + text.slice(m.index + m[0].length);
  return { rest, assigneeName: m[1] };
}

function toProperty(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[、。]+|[、。]+$/g, "")
    .slice(0, 100);
}

export function parseJobCommand(text: string | null | undefined): JobCommand | null {
  const normalized = normalizeFullWidth(String(text || "")).trim();
  if (!normalized) return null;

  const review = normalized.match(REVIEW_RE);
  if (review) {
    return { action: "review", no: Number(review[1]), verdict: verdictOf(review[2]) };
  }

  let workflow: "obi" | "satei" | null = null;
  let rest = "";
  const obiWord = OBI_WORDS.find((w) => normalized.startsWith(w));
  if (obiWord) {
    workflow = "obi";
    rest = normalized.slice(obiWord.length);
  } else if (normalized.startsWith("査定")) {
    workflow = "satei";
    rest = normalized.slice(2);
  }
  if (!workflow) return null;
  // 依頼語の直後が区切り（空白・読み飛ばす語・文末）のときだけ依頼にする。
  // 「査定額も書き足して」「帯替えの件ですが」を依頼に取らないため
  if (!isRequestSeparator(rest)) return null;

  rest = stripFiller(rest);
  const { rest: withoutAssignee, assigneeName } = extractAssignee(rest);
  const property = toProperty(withoutAssignee);
  return { action: "request", workflow, property, assigneeName };
}
