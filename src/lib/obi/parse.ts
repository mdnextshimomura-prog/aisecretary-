/**
 * 帯替え・査定の依頼文の読み取り（設計 2026-10-09 の 7）。
 *
 * line-secretary の src/jobs/parse.js をそのまま移したもの。秘書室とグループで
 * 依頼の読み方がずれないよう、**同じ入力から同じ結果になること**を共通の表
 * tests/fixtures/job-command-cases.json で固定している（line-secretary 側にも同じ表を置く）。
 * ここを直すときは、parse.js と表も同時に直すこと。
 */
import { parseFixBody, FIX_TEXT_MAX, type FixCode, type FixTurn } from "./fix-parse";

export type JobCommand =
  | { action: "review"; no: number; verdict: "ok" | "fix" }
  | { action: "fix"; no: number; code: FixCode; page: number | null; turn: FixTurn }
  | { action: "rechoose"; no: number }
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
// 「#J12 9」＝対応の選び直し（差し戻しの選択肢の設計 2026-10-11 の E12）。**文法だけ先に入れてある**
// （番号で直す の約束「差し戻しの選択肢のための土台」P4・P5。共通の表を後からもう一度替えずに済ませるため）。
// 9 はページ・向きを付けない形だけ。全体で30文字まで。line-secretary の parse.js と同じ正規表現
const RECHOOSE_RE = /^#\s*[Jj]\s*(\d{1,6})(?!\d)\s*9番?$/;
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

  // 「#J12 2」「#J12 3ページ 2」＝番号で直す（設計 2026-10-10 の E12）。#J つきの形だけ
  const fix = parseFixBody(normalized);
  if (fix && fix.no !== null) {
    return { action: "fix", no: fix.no, code: fix.code, page: fix.page, turn: fix.turn };
  }

  // 「#J12 9」＝対応の選び直し。番号の訂正に合わなかったときだけ試す。
  // いまは、この結果を使う所は無い（classifyObiEntry は request だけを見る。Webhook の訂正の枝は parseFixBody で読むので、ここを通らない）
  const rechoose = normalized.length <= FIX_TEXT_MAX ? normalized.match(RECHOOSE_RE) : null;
  if (rechoose) return { action: "rechoose", no: Number(rechoose[1]) };

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
