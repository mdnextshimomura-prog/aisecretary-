/**
 * 「番号で直す」の返事の読み取り（設計 2026-10-10 の E12「訂正の形（文法）」）。
 *
 * 本文の**全体**が文法に合ったときだけ結果を返す。合わなければ null（＝訂正として扱わない。
 * 今までの流れへ）。1通に読むのは、ページ1つ・番号1つだけ（E1）。
 *
 *   訂正   := [ 番号指定 空白* ] 本体
 *   番号指定 := "#" 空白* ("J"|"j") 空白* 数字{1,6}
 *   本体   := ページ 空白* ["の"] 空白* 番号 | 番号 空白+ ページ | 番号
 *   ページ  := 数字{1,3} 空白* ("ページ"|"頁"|"P"|"p") ["目"] | ("P"|"p") 数字{1,3}
 *   番号   := ("0"|"1"|"2"|"4"|"5") ["番"] | "3" ["右"|"左"] ["番"]
 *
 * 数字の並びは途中で切らない（「#J122」を「#J12」と「2」に、「P32」を「P3」と「2」に分けない）。
 * P・p は数字と隣り合わせのときだけページの印にする（「3P」「p3」。「4 p3」を「4ページ目の3番」と
 * 読まず、「4番・3ページ」と読むため。「ページ」「頁」の前の空白は許す）。「#J12 3 P2」は
 * 「J12・2ページ・番号3」（「3 P」をページと読まない。Z1）。
 * 0 はページを付けない形だけ。全体で30文字まで（全角を半角にし、前後の空白を除いた後の長さ）。
 *
 * line-secretary の src/jobs/parse.js も「#J つき」の形で同じ結果を返す（同じ正規表現・同じ順番。共通の表
 * tests/fixtures/job-command-cases.json の全行で固定）。ここを直すときは parse.js と表も同時に直すこと。
 * 「#J なし」の形（no が null）は aisecretary だけが使う（グループで、引用つきのときだけ）。
 */
export type FixCode = 0 | 1 | 2 | 3 | 4 | 5;
export type FixTurn = "" | "right" | "left";

export interface FixBody {
  /** 受付番号（#J つきのときだけ。無ければ null） */
  no: number | null;
  code: FixCode;
  /** 1冊のページ（1始まり）。書かれていなければ null。範囲（1〜120）はここでは見ない */
  page: number | null;
  turn: FixTurn;
}

export const FIX_TEXT_MAX = 30;

// parse.ts の normalizeFullWidth と同じ（全角英数・全角空白・全角＃だけを半角に）
function normalizeFullWidth(s: string): string {
  return String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    )
    .replace(/　/g, " ")
    .replace(/＃/g, "#");
}

const HEAD_RE = /^#\s*[Jj]\s*(\d{1,6})(?!\d)\s*/;
const PAGE = "(?:(\\d{1,3})(?:\\s*(?:ページ|頁)|[Pp])目?|[Pp](\\d{1,3})(?!\\d))";
const CODE = "(?:([01245])|(3)([右左])?)番?";
const PAGE_THEN_CODE_RE = new RegExp(`^${PAGE}\\s*の?\\s*${CODE}$`);
const CODE_THEN_PAGE_RE = new RegExp(`^${CODE}\\s+${PAGE}$`);
const CODE_ONLY_RE = new RegExp(`^${CODE}$`);

function codeOf(
  plain: string | undefined,
  three: string | undefined,
  dir: string | undefined,
) {
  const code = Number(plain ?? three) as FixCode;
  const turn: FixTurn = dir === "右" ? "right" : dir === "左" ? "left" : "";
  return { code, turn };
}

export function parseFixBody(text: string | null | undefined): FixBody | null {
  const normalized = normalizeFullWidth(String(text ?? "")).trim();
  if (!normalized || normalized.length > FIX_TEXT_MAX) return null;

  let no: number | null = null;
  let body = normalized;
  const head = normalized.match(HEAD_RE);
  if (head) {
    no = Number(head[1]);
    body = normalized.slice(head[0].length);
  }

  let page: number | null = null;
  let picked: { code: FixCode; turn: FixTurn };
  let m = body.match(PAGE_THEN_CODE_RE);
  if (m) {
    page = Number(m[1] ?? m[2]);
    picked = codeOf(m[3], m[4], m[5]);
  } else if ((m = body.match(CODE_THEN_PAGE_RE))) {
    picked = codeOf(m[1], m[2], m[3]);
    page = Number(m[4] ?? m[5]);
  } else if ((m = body.match(CODE_ONLY_RE))) {
    picked = codeOf(m[1], m[2], m[3]);
  } else {
    return null;
  }
  // 0（問題なし）はページを付けない形だけ
  if (picked.code === 0 && page !== null) return null;
  return { no, code: picked.code, page, turn: picked.turn };
}
