/**
 * 差し戻しの対応の選択：読んだ返事（番号・言葉）と、portal の resolve の答え（kind・phase）から、何をするかを決める
 * （設計 2026-10-11 の E12・約束 2026-10-11-obi-reject-contract.md の「読み方」）。
 *
 * ここは計算だけ（portal・KV・LINE を呼ばない。認可も見ない）。
 *
 *   引用つき（#J なし）：引用先の知らせの種類 kind で決める
 *     reject（選択肢の知らせ）… 本文が番号1つ（1〜4。ページ・向きなし）のときだけ choose。ほかは今までの流れへ（返事をしない）
 *     review（確認の知らせ）  … OK・0 は approve、9 は rechoose、1〜5（＋ページ）は「番号で直す」へ（fix が FIX_UNAVAILABLE を返す。T1）
 *     completion・""          … 番号は今までどおり「番号で直す」。OK・9 は今までの流れへ
 *     それ以外               … 今までの流れへ
 *     expectGen は引用先の知らせの世代（messageGen）。approve・rechoose の expectSha256 は、その知らせが指す成果物
 *   #J つき：今の依頼が待っている返事の種類 phase で決める
 *     「#J4 2」    … phase が choose・ページなし・向きなし・1〜4 のときだけ choose。それ以外は今までどおり「番号で直す」
 *     「#J4 OK」   … phase が review のときだけ approve。それ以外は今までの流れへ（グループには既存の「#J12 OK」の扱いが無い）
 *     「#J4 9」    … phase が review なら rechoose。
 *                    phase が fix で完成品があるときも、同じ rechoose を /reject に渡して portal に断らせる（裁定 V7）：
 *                    選択肢のスイッチ（OBI_REJECT_CHOICES）が off のあいだ phase は常に fix なので、「受付を止めている」
 *                    （CHOICE_DISABLED →「いま受付を止めています。portal の依頼ボックスを確認してください」）のか、
 *                    その依頼がいま選び直せないだけ（CHOICE_UNAVAILABLE →「いまその操作ができない状態です」）なのかは、
 *                    resolve の答えからは見分けられない。/reject は「形 → スイッチ → …→ 状態」の順に見るので、確実に分かれる。
 *                    それ以外（選択待ち・知らない phase・完成品が無くて /reject の本文を作れない）は「いまその操作ができない状態です」
 *     expectGen は今の世代（choiceGen）。approve・rechoose の expectSha256 は今の成果物
 *
 * 出している番号かどうか（choices）は、ここでは見ない（portal の /reject が決め、CHOICE_NOT_OFFERED で答える）。
 * 必要な値（世代・成果物の sha256）が応答に無いときは、選択として扱わない（今までの流れへ）。
 */
import type { FixBody } from "./fix-parse";
import type { FixResolved, RejectAction } from "./portal";
import type { ChoiceWord } from "./reject-parse";

export interface ChoicePlan {
  action: RejectAction;
  /** choose のときだけ 1〜4。approve・rechoose は 0 */
  choice: 0 | 1 | 2 | 3 | 4;
  expectGen: number;
  /** approve・rechoose のときだけ64桁。choose は "" */
  expectSha256: string;
}

export type QuotedDecision =
  | { kind: "choice"; plan: ChoicePlan }
  /** 今までどおり「番号で直す」（fix.ts の続きへ） */
  | { kind: "fix" }
  /** 選択としても訂正としても扱わない（返事をせず今までの流れへ） */
  | { kind: "rest"; reason: string };

export type NumberedWordDecision =
  | { kind: "choice"; plan: ChoicePlan }
  /** 「#J4 9」で、確認待ちでなく、portal にも確かめない（選択待ち・知らない phase・完成品が無い）：断りの文だけ返す */
  | { kind: "unavailable" }
  | { kind: "rest"; reason: string };

const SHA_RE = /^[0-9a-f]{64}$/;

/** 番号1つだけ（ページ・向きなし）の 1〜4 か */
function singleChoice(body: FixBody): 1 | 2 | 3 | 4 | null {
  if (body.page !== null || body.turn !== "") return null;
  return body.code === 1 || body.code === 2 || body.code === 3 || body.code === 4 ? body.code : null;
}

function withSha(action: "approve" | "rechoose", expectGen: number, sha: string): ChoicePlan | null {
  return SHA_RE.test(sha) ? { action, choice: 0, expectGen, expectSha256: sha } : null;
}

/** 引用つきの番号の形（parseFixBody が読めたもの。#J なし） */
export function planQuotedNumber(body: FixBody, r: FixResolved): QuotedDecision {
  if (r.kind === "" || r.kind === "completion") return { kind: "fix" };
  if (r.kind === "reject") {
    const choice = singleChoice(body);
    if (choice === null) return { kind: "rest", reason: "reject-not-choice" };
    if (r.messageGen === null) return { kind: "rest", reason: "no-message-gen" };
    return { kind: "choice", plan: { action: "choose", choice, expectGen: r.messageGen, expectSha256: "" } };
  }
  if (r.kind === "review") {
    // 1〜5（＋ページ）は「番号で直す」へ回す（特別な枝は作らない。fix が FIX_UNAVAILABLE を返す。T1）
    if (body.code !== 0) return { kind: "fix" };
    if (r.messageGen === null) return { kind: "rest", reason: "no-message-gen" };
    const plan = withSha("approve", r.messageGen, r.artifactSha256);
    return plan ? { kind: "choice", plan } : { kind: "rest", reason: "no-artifact" };
  }
  return { kind: "rest", reason: "notice-kind" };
}

/** 引用つきの言葉の形（「OK」「9」。#J なし） */
export function planQuotedWord(word: ChoiceWord, r: FixResolved): QuotedDecision {
  if (r.kind !== "review") return { kind: "rest", reason: "word-not-review" };
  if (r.messageGen === null) return { kind: "rest", reason: "no-message-gen" };
  const plan = withSha(word === "ok" ? "approve" : "rechoose", r.messageGen, r.artifactSha256);
  return plan ? { kind: "choice", plan } : { kind: "rest", reason: "no-artifact" };
}

/** 「#J4 2」の形（parseFixBody が読めたもの）。選択なら plan、そうでなければ null（今までどおり「番号で直す」） */
export function planNumberedNumber(body: FixBody, r: FixResolved): ChoicePlan | null {
  if (r.phase !== "choose") return null;
  const choice = singleChoice(body);
  return choice === null ? null : { action: "choose", choice, expectGen: r.choiceGen, expectSha256: "" };
}

/** 「#J4 OK」「#J4 9」の形 */
export function planNumberedWord(word: ChoiceWord, r: FixResolved): NumberedWordDecision {
  if (r.phase !== "review") {
    if (word === "ok") return { kind: "rest", reason: "ok-not-review" };
    // 「#J4 9」で確認待ちでない。phase が fix のときは、受付を止めているのか（OBI_REJECT_CHOICES が off。そのあいだ phase は常に fix）、
    // その依頼がいま選び直せないだけなのかを、/reject（rechoose）に渡して portal に答えさせる（CHOICE_DISABLED／CHOICE_UNAVAILABLE。裁定 V7）。
    // 完成品が無い依頼は、/reject の本文を作れない（expectSha256 が必須）ので確かめられない → 断りの文だけ
    if (r.phase === "fix") {
      const probe = withSha("rechoose", r.choiceGen, r.artifactSha256);
      if (probe) return { kind: "choice", plan: probe };
    }
    return { kind: "unavailable" };
  }
  const plan = withSha(word === "ok" ? "approve" : "rechoose", r.choiceGen, r.artifactSha256);
  return plan ? { kind: "choice", plan } : { kind: "rest", reason: "no-artifact" };
}
