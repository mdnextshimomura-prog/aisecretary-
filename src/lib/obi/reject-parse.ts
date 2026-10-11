/**
 * 差し戻しの対応の選択（設計 2026-10-11 の E12）のうち、「言葉」の返事の読み取り。
 *
 * 読むのは2つだけ：
 *   ok       … よければ完成にする（確認の知らせへの「OK」）
 *   rechoose … 対応を選び直す（確認の知らせへの「9」）
 *
 * 形は2通り。どちらも、本文の**全体**が合ったときだけ結果を返す（合わなければ null＝今までの流れへ）。
 *   #J つき  ：「#J4 OK」「#J4 9」。共通の文法 parseJobCommand の結果をそのまま使う
 *             （{ action: "review", verdict: "ok" }／{ action: "rechoose" }。「#J4 完成」「#J4 オーケー」も ok）。
 *             共通の表 tests/fixtures/job-command-cases.json は変えない
 *   #J なし  ：「OK」「ok」「オーケー」「9」「9番」。**引用つきのときだけ**呼ぶ側が使う（aisecretary だけの読み。
 *             Mac の秘書室は引用を読まないので、共通の表には足さない）
 *
 * 番号（1〜4・0）の返事はここでは読まない（今までどおり fix-parse.ts の parseFixBody が読む）。
 * 何をするか（選択・完成・選び直し・訂正・今までの流れ）は、portal の resolve の kind・phase で決める（reject-plan.ts）。
 * 全体で30文字まで（全角を半角にし、前後の空白を除いた後の長さ。parseFixBody と同じ）。
 */
import { parseJobCommand } from "./parse";

export type ChoiceWord = "ok" | "rechoose";

export interface ChoiceWordBody {
  /** 受付番号（#J つきのときだけ。無ければ null） */
  no: number | null;
  word: ChoiceWord;
}

export const CHOICE_WORD_TEXT_MAX = 30;

// parse.ts・fix-parse.ts の normalizeFullWidth と同じ（全角英数・全角空白・全角＃だけを半角に）
function normalizeFullWidth(s: string): string {
  return String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    )
    .replace(/　/g, " ")
    .replace(/＃/g, "#");
}

const QUOTED_OK_RE = /^(?:ok|オーケー)$/i;
const QUOTED_RECHOOSE_RE = /^9番?$/;

export function parseChoiceWord(
  text: string | null | undefined,
): ChoiceWordBody | null {
  const normalized = normalizeFullWidth(String(text ?? "")).trim();
  if (!normalized || normalized.length > CHOICE_WORD_TEXT_MAX) return null;

  if (normalized.startsWith("#")) {
    const cmd = parseJobCommand(normalized);
    if (cmd?.action === "review" && cmd.verdict === "ok")
      return { no: cmd.no, word: "ok" };
    if (cmd?.action === "rechoose") return { no: cmd.no, word: "rechoose" };
    return null;
  }
  if (QUOTED_OK_RE.test(normalized)) return { no: null, word: "ok" };
  if (QUOTED_RECHOOSE_RE.test(normalized))
    return { no: null, word: "rechoose" };
  return null;
}
