/**
 * 返事・portal に渡す文字の整え（設計「返事に入れるファイル名・物件名は、改行・制御文字を取り、40文字までにする」）。
 *
 * LINE のファイル名や依頼文は誰でも好きに付けられる。改行や見えない文字が入ると、
 * グループの返事の見た目を崩したり、別の行の文に見せかけたりできるため取り除く。
 */
// 改行（CR/LF と U+2028 行区切り・U+2029 段落区切り）。空白に置き換える
// （tsconfig の target が es5 のため u フラグの正規表現リテラルは書けない。実行環境（Node）は対応しているので RegExp で作る）
const LINE_BREAK_RE = new RegExp("\\r\\n|[\\r\\n\\p{Zl}\\p{Zp}]", "gu");
// 制御文字（Cc：C0・DEL・C1、タブを含む）と書式文字（Cf：幅のない文字・文字の向きを変える／隔てる文字・BOM など）
const INVISIBLE_RE = new RegExp("[\\p{Cc}\\p{Cf}]", "gu");

function cut(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : s;
}

/** 改行は空白に、制御文字・見えない文字は除き、空白の連続を1つにしてトリムする（長さは切らない） */
function flatten(s: string): string {
  return String(s ?? "")
    .replace(LINE_BREAK_RE, " ")
    .replace(INVISIBLE_RE, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** 返事に書く1項目（ファイル名・物件名）。改行は空白に、制御文字は除き、max 文字まで */
export function sanitizeForReply(s: string, max = 40): string {
  return cut(flatten(s), max);
}

/** portal に送るファイル名。区切り文字（/ \）を潰し、100文字まで、末尾は必ず .pdf */
export function sanitizeUploadName(name: string): string {
  let s = flatten(name).replace(/[\\/]/g, "_");
  if (!/\.pdf$/i.test(s)) s = `${s || "file"}.pdf`;
  const chars = Array.from(s);
  if (chars.length > 100) s = chars.slice(0, 96).join("") + ".pdf";
  return s;
}

/**
 * String.length（UTF-16 コードユニット）で max 以内に切る。サロゲートペアの途中で切れそうなら1つ手前で切る。
 * portal（P1）は property・requestText を String.length で数えて検査するので、こちらも同じ数え方にそろえる。
 * 末尾に残った対にならない上位サロゲートも落とす。
 */
export function cutUtf16(s: string, max: number): string {
  let end = Math.min(s.length, Math.max(0, max));
  if (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end -= 1; // 上位サロゲートで終わる＝対を割る（または対の相手が無い）
  }
  return s.slice(0, end);
}

/** portal の property 用：トリム後 max ユニット以内（超えたら max-1 ユニットで切って … を付ける） */
function fitForPortal(s: string, max: number): string {
  const flat = flatten(s);
  if (flat.length <= max) return cutUtf16(flat, max).trim();
  return cutUtf16(flat, max - 1).trimEnd() + "…";
}

/**
 * portal に送る物件名（必須・トリム後 1〜100 UTF-16 コードユニット。P1 の検査と同じ）。
 * 依頼文に物件名が無い（「帯替えお願いします」だけ）ときは、最初の PDF の名前（.pdf を除く）を使う。
 * それも空なら「帯替え」。
 */
export function propertyFor(parsedProperty: string, firstFileName: string): string {
  const p = fitForPortal(parsedProperty, 100);
  if (p) return p;
  const base = fitForPortal(String(firstFileName ?? "").replace(/\.pdf$/i, ""), 100);
  return base || "帯替え";
}

/** portal に送る依頼文（トリム後 〜1000 UTF-16 コードユニット。空でもよい。P1 の検査と同じ数え方） */
export function requestTextFor(s: string): string {
  return cutUtf16(String(s ?? "").trim(), 1000).trim();
}
