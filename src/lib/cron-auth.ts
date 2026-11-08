import { timingSafeEqualStr } from "./secure-compare";

/**
 * Cron の入口（/api/remind・/api/report・/api/remind-due・/api/candidates-ask）の認証。
 *
 * CRON_SECRET が未設定・空なら誰も通さない。
 * （`authHeader !== \`Bearer ${process.env.CRON_SECRET}\`` の書き方だと、未設定のとき
 *   「Bearer undefined」を送れば通ってしまう）
 */
export function isCronAuthorized(
  authHeader: string | null,
  secret: string | undefined = process.env.CRON_SECRET
): boolean {
  if (!secret || !authHeader) return false;
  return timingSafeEqualStr(authHeader, `Bearer ${secret}`);
}
