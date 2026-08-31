/**
 * 初動確認（聞き返し）の対象者。
 *
 * 全員に聞き返すと、担当者同士の細かいやり取りにまで確認が挟まって
 * グループがうるさくなる。**条件が省かれやすいのは社長からの指示**なので、
 * そこに絞る（履歴の実測：社長の指示1,133件のうち35%が12文字以下）。
 *
 * 対象を変えるときはここの配列を直す。userIdはNotionの「メンバー名簿」の
 * LINE userId 欄で確認できる。
 */

/** 前田 誠治（社長）— 2026-08-28 時点。名簿の「LINE userId」より */
const PRESIDENT = "U8d0899ebb7bca2093fe45c24a500ce9c";

/**
 * 環境変数で上書きできるようにしておく。
 * 対象を急いで変えたい・一時的に止めたいときに、デプロイせずに済ませるため。
 *   CLARIFY_SENDER_IDS="U123...,U456..."   … この人たちだけ
 *   CLARIFY_SENDER_IDS="off"               … 誰にも聞き返さない
 */
function configured(): string[] | null {
  const raw = (process.env.CLARIFY_SENDER_IDS ?? "").trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "off") return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** その発言者に初動確認をかけるか */
export function shouldClarifyFor(userId: string | undefined | null): boolean {
  if (!userId) return false; // 発言者が分からないものは対象外（安全側）
  const list = configured() ?? [PRESIDENT];
  return list.includes(userId);
}

/** 現在の対象者（ログ・動作確認用） */
export function clarifyTargets(): string[] {
  return configured() ?? [PRESIDENT];
}
