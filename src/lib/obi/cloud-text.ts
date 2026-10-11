/**
 * クラウド配達の文（設計 2026-10-11 の C7・約束の「文」）。Mac の実物と一字一句同じにする。
 * 期待値は共通のテスト用データ tests/fixtures/obi-cloud-texts.json（line-secretary にも同じバイト）。片方だけ直さない。
 * 突き合わせた Mac の版：feature/v1 の 7ff13e4（2026-10-11。知らせの文を読みやすい並べ方に直した版）
 *   完成の知らせ … line-secretary/src/jobs/deliver.js の groupText（175行）・fixtext.js の FIX_GUIDE_TEXT・FIX_AGAIN_TEXT（35・43行）
 *   差し戻し …… src/jobs/notify.js の GROUP_TEXTS（43行）・rejecttext.js の choicesGroupText（94行）
 *   失敗 ……… notify.js の GROUP_TEXTS（43行）
 * 並べ方：見出し〜帯の外の行／空行／リンクと「開けます」／（案内があるときだけ）空行／案内。末尾に改行は付けない
 *   物件名 …… src/room.js の sanitizeField(…, 60)（28行）。既存の sanitize.ts（40字・別の決まり）とは別物
 * 引用の返事を案内できないとき（Mac の fixtext.js の FIX_GUIDE_QUOTE_OK が false）の文は持たない。
 * Mac が false に変えるときは、同じ変更でこちらも受付番号つきの文に変える（約束）。
 */
import { CLOUD_TOKEN_TTL_SEC } from "./cloud-dtoken";

const INVISIBLE_RE = /[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g;
const LINE_BREAK_RE = /[\r\n\u0000-\u001F\u007F\u0085\u2028\u2029]/g;
const BARE_DOMAIN_RE = /[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|jp|io|me|ly|co|info|biz|xyz|app|dev)(?![a-z0-9-])(?:\/\S*)?/gi;

/** 完成の文に入れる物件名。約束の6つの段の順 */
export function cloudProperty(raw: unknown): string {
  let s = typeof raw === "string" ? raw : "";
  s = s.replace(INVISIBLE_RE, "");
  s = s.replace(LINE_BREAK_RE, " ");
  s = s.replace(/https?:\/\//gi, "").replace(/www\./gi, "");
  s = s.replace(BARE_DOMAIN_RE, "");
  // 半角スペースの連続を1つに畳み、前後の半角スペースを落とす（全角スペースは畳まない）
  s = s.replace(/ {2,}/g, " ").replace(/^ +| +$/g, "");
  const chars = Array.from(s);
  return chars.length > 60 ? chars.slice(0, 60).join("") + "…" : s;
}

export interface CloudFix {
  round: number;
  code: number;
  page: number | null;
  turn: "" | "right" | "left";
  by: "auto" | "human";
  source: "line-group" | "secretary";
}
/** 予約の応答から、文に使う値だけを読んだもの（4項目）。KV の控えの facts は、これに整えた後の物件名 property を足した5項目（cloud-store.ts の CloudMemoFacts） */
export interface CompletionFacts {
  reviewPages: number;
  outsideErased: number;
  outsidePages: number[];
  fix: CloudFix | null;
}

const posInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const intIn = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** 予約の応答の値の読み方（約束）。形が違えば、その行を出さない側へ倒す */
export function readCompletionFacts(claim: Record<string, unknown>): CompletionFacts {
  const reviewPages = posInt(claim.reviewPages) ? claim.reviewPages : 0;
  const outsideErased = posInt(claim.outsideErased) ? claim.outsideErased : 0;
  const pages = claim.outsidePages;
  const outsidePages =
    outsideErased > 0 && Array.isArray(pages) && pages.every(posInt) ? (pages as number[]).slice(0, 20) : [];
  let fix: CloudFix | null = null;
  const f = claim.fix;
  if (f && typeof f === "object" && !Array.isArray(f)) {
    const r = f as Record<string, unknown>;
    if (
      intIn(r.round, 0, 9) &&
      intIn(r.code, 1, 5) &&
      (r.page == null || intIn(r.page, 1, 120)) &&
      (r.turn === "" || r.turn === "right" || r.turn === "left") &&
      (r.by === "auto" || r.by === "human") &&
      (r.source === "line-group" || r.source === "secretary")
    ) {
      fix = { round: r.round, code: r.code, page: r.page == null ? null : r.page, turn: r.turn, by: r.by, source: r.source };
    }
  }
  return { reviewPages, outsideErased, outsidePages, fix };
}

const FIX_LABELS: Record<number, string> = { 1: "帯の位置", 2: "他社の文字", 3: "向き", 4: "順番", 5: "その他" };
// 番号の一覧（1行に1つ）。意味は FIX_LABELS と同じで、0 は「問題なし」
const FIX_MENU = ["0 問題なし", "1 帯の位置を直す", "2 他社の文字が残っている", "3 向きを直す", "4 順番を直す", "5 その他"].join("\n");
// 完成の知らせの末尾の案内：見出し／返せる人／番号／空行／例／送り方
const FIX_GUIDE_TEXT =
  "▼ 確認したら番号で返信してください\n" +
  "（帯替えを依頼できる方から）\n" +
  `${FIX_MENU}\n` +
  "\n" +
  "例）3ページ目に他社の文字 →「3ページ 2」\n" +
  "このメッセージを長押し →「リプライ」で送ってください";
// 直した後の知らせの末尾の案内
const FIX_AGAIN_TEXT =
  "▼ まだ違えば番号で返信してください\n" + `${FIX_MENU}\n` + "\n" + "例）3ページ目に他社の文字 →「3ページ 2」";

/**
 * 完成の知らせ。property には、整えた後の値（cloudProperty を通した文字列＝控えの facts.property）を渡す。
 * ここでは、もう一度整えない（新しい予約の回と、控えから再開した回が、同じ文になる）。直しの回の文には出ない
 */
export function completionText(a: {
  no: number;
  property: string;
  facts: CompletionFacts;
  link: string;
  fixGuide: boolean;
}): string {
  const { no, facts } = a;
  const hours = Math.max(1, Math.round(CLOUD_TOKEN_TTL_SEC / 3600));
  const lines: string[] = [];
  if (facts.fix) {
    const what =
      facts.fix.page !== null ? `${facts.fix.page}ページ・${FIX_LABELS[facts.fix.code]}` : FIX_LABELS[facts.fix.code];
    lines.push(facts.fix.by === "human" ? `#J${no} を担当が直しました` : `#J${no} を直しました（${what}）`);
  } else {
    lines.push(`#J${no} 帯替えが完成しました${a.property ? `（${a.property}）` : ""}`);
  }
  if (facts.reviewPages > 0) lines.push(`⚠ 要確認 ${facts.reviewPages}ページ（使う前に中身を確認してください）`);
  if (facts.outsideErased > 0) {
    const where = facts.outsidePages.length ? `（${facts.outsidePages.join("・")}ページ）` : "";
    lines.push(`帯の外の他社の文字を${facts.outsideErased}か所消しました${where}。消しすぎていないか確認してください`);
  }
  // リンクの前に空行。案内があるときだけ、案内の前にも空行
  lines.push("", a.link, `（このグループの方が開けます・${hours}時間有効）`);
  if (a.fixGuide) lines.push("", facts.fix ? FIX_AGAIN_TEXT : FIX_GUIDE_TEXT);
  return lines.join("\n");
}

const CHOICE_LABELS: Record<number, string> = {
  1: "帯だけ替えて仕上げる（所在地・価格の確認なし）",
  2: "AI に読ませて、他社の表記も消して仕上げる（図面の画像を AI に送ります）",
  3: "担当が手で仕上げる",
  4: "取り消す",
};
const REASON_TEXTS: Record<string, string> = {
  scan: "スキャンで文字が読めません",
  unreadable: "所在地・価格が読めません",
  boundary: "物件の切れ目が決められません",
  "no-figure": "販売図面が見つかりません",
  "too-big": "大きすぎます（分けて送り直してください）",
};
const REASON_OTHER = "自動で1冊にできません";

/** 出せる番号（1〜4 の整数・重複なし・小さい順）。形が違えば空 */
export function offeredChoices(row: Record<string, unknown>): number[] {
  const raw = Array.isArray(row.choices) ? row.choices : [];
  const set = new Set<number>();
  for (const c of raw) if (intIn(c, 1, 4)) set.add(c);
  return Array.from(set).sort((x, y) => x - y);
}

const isGen = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 999_999_999_999_999;

export type RejectNotice =
  | { kind: "choices"; text: string; choiceGen: number } // 選択肢つき。送れたら id を portal に報告する
  | { kind: "fixed"; text: string }; // 固定の一言。id は報告しない

/** 差し戻しの知らせ（一覧の行から決める）。出すかどうかは portal の groupNotice が決める。ここは文だけ */
export function rejectNoticeText(no: number, row: Record<string, unknown>): RejectNotice {
  const offered = offeredChoices(row);
  if (isGen(row.choiceGen) && row.rejectState === "offered" && offered.length > 0) {
    const reason =
      typeof row.rejectReason === "string" && row.rejectReason.startsWith("ai-")
        ? "AI で読めませんでした"
        : typeof row.rejectKind === "string" && Object.prototype.hasOwnProperty.call(REASON_TEXTS, row.rejectKind)
          ? REASON_TEXTS[row.rejectKind]
          : REASON_OTHER;
    // 1行目に理由は入れない（作り直しの回は言い方が変わる）。理由は2行目
    const head = intIn(row.rejectRound, 1, Number.MAX_SAFE_INTEGER)
      ? `#J${no} 選んだ方法では仕上げられませんでした`
      : `#J${no} 自動では仕上げられませんでした`;
    // 見出し・理由／空行／「▼ …」・返せる人・番号（出ている番号だけ。1行に1つ）／空行／送り方（2行）
    const text = [
      head,
      `理由：${reason}`,
      "",
      "▼ 対応を番号で返信してください",
      "（帯替えを依頼できる方から）",
      ...offered.map((c) => `${c} ${CHOICE_LABELS[c]}`),
      "",
      "このメッセージを長押し →「リプライ」で番号を送ってください",
      `または「#J${no} ${offered[0]}」のように送ってください`,
    ].join("\n");
    return { kind: "choices", text, choiceGen: row.choiceGen };
  }
  return { kind: "fixed", text: `#J${no} 自動では帯替えできませんでした。担当が確認します` };
}

export const failureNoticeText = (no: number): string => `#J${no} 帯替えに失敗しました。担当が確認します`;
