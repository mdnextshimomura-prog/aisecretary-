/**
 * 物件名の表記ゆれを吸収する。
 *
 * 背景（2026-08-14 トーク履歴7,050件の実測）:
 *   同じ物件が別表記で散っていた。実際に見つかった例:
 *     ぶどうヶ丘ハイツ ／ ぶどうケ丘ハイツ
 *     吹田市山手町４丁目 ／ 吹田市山手町4丁目
 *     八尾市泉町二丁目 ／ 八尾市泉町２丁目
 *     ダイアパレス ／ ダイヤパレス
 *     ザ・ファインタワー ／ ファインタワー
 *   237の異なり表記が、正規化で216に収束した（19組が同一物件と判明）。
 *
 * 方針:
 *   人が読む用の「物件名」は原文のまま残し、照合用の「物件キー」を別に持つ。
 *   キーを消しても原文は失われないので、ルールを変えても後から作り直せる。
 *
 * ここで吸収できないもの（人の判断が要る）:
 *   「永楽荘」と「豊中市永楽荘4丁目」のような、略称と正式名称の対応。
 *   これは機械的には決められないので、必要になったら別途 別名の対応表を用意する。
 */

const KANJI_DIGITS: Record<string, string> = {
  "〇": "0", 零: "0", 一: "1", 二: "2", 三: "3", 四: "4",
  五: "5", 六: "6", 七: "7", 八: "8", 九: "9",
};

/** 「二丁目」「十一丁目」→「2丁目」「11丁目」 */
function kanjiChomeToArabic(s: string): string {
  return s.replace(/([〇零一二三四五六七八九十]+)丁目/g, (_m, n: string) => {
    let v: string;
    if (n.includes("十")) {
      const [tens, ones] = n.split("十");
      const t = tens ? Number(KANJI_DIGITS[tens] ?? "1") : 1;
      const o = ones ? Number(KANJI_DIGITS[ones] ?? "0") : 0;
      v = String(t * 10 + o);
    } else {
      v = n.split("").map((c) => KANJI_DIGITS[c] ?? c).join("");
    }
    return `${v}丁目`;
  });
}

/**
 * 照合用のキーを作る。表示には使わない（読めない形になるため）。
 * 空文字を返したら「物件名として扱わない」の意味。
 */
export function normalizeProperty(name: string | null | undefined): string {
  if (!name) return "";
  let x = name
    // 全角英数・半角カナ・数学用英数字記号などを標準形へ
    .normalize("NFKC")
    .replace(/[\s　]/g, "");

  x = kanjiChomeToArabic(x);

  x = x
    // 泉ヶ丘／泉ケ丘／泉が丘／泉ヵ丘 を同一視
    .replace(/[ヶヵケが]/g, "ケ")
    // ダイアパレス／ダイヤパレス、レジデンス表記のゆれ
    .replace(/ヤ/g, "ア")
    // 「ザ・」「THE」の有無（ザ・ファインタワー ＝ ファインタワー）
    .replace(/^(ザ|the)/i, "")
    // 中点・各種ハイフン・長音の有無は同一視する
    .replace(/[・･\-‐‑–—―ーｰ─]/g, "")
    // 括弧の中は補足であることが多い（例:「〇〇マンション（旧△△）」）
    .replace(/[（(【［\[].*?[）)】］\]]/g, "")
    .toLowerCase();

  // 1文字だけのキーは誤って束ねるだけなので採用しない
  return x.length >= 2 ? x : "";
}

/**
 * 物件名として妥当か。Claudeが会社名や地名の一部を拾うことがあるため、
 * 明らかに物件でないものを落とす。
 */
const NOT_PROPERTY = /^(なし|不明|未定|該当なし|-|ー|同上|上記)$/;

export function cleanPropertyName(name: string | null | undefined): string | null {
  const t = (name ?? "").trim();
  if (!t || NOT_PROPERTY.test(t)) return null;
  // 極端に長いものは文章を拾っている
  if (t.length > 60) return null;
  return t;
}
