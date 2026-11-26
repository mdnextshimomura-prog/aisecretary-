/**
 * 段2d：山口さんの候補の userId が依頼のグループにいるか（LINE の GET /v2/bot/group/{groupId}/member/{userId}）。
 * 200＝in、404＝out、ほか（5xx・401・時間切れ・例外・設定なし）＝unknown。プロフィール（displayName）は読まない・残さない。
 * ログは出さない（呼ぶ側が符号だけ出す）。例外は投げない。
 */
export type GsMemberStatus = "in" | "out" | "unknown";

export const GS_MEMBER_TIMEOUT_MS = 3_000;
const GROUP_RE = /^C[0-9a-f]{32}$/;
const USER_RE = /^U[0-9a-f]{32}$/;

export async function gsGroupMemberStatus(
  groupId: string,
  userId: string,
  o: { token?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<GsMemberStatus> {
  const token = o.token ?? process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "";
  if (!token || !GROUP_RE.test(groupId) || !USER_RE.test(userId)) return "unknown";
  const f = o.fetch ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? GS_MEMBER_TIMEOUT_MS);
  try {
    const res = await f(`https://api.line.me/v2/bot/group/${groupId}/member/${userId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    // 本文（名前など）は読まずに捨てる
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 200) return "in";
    if (res.status === 404) return "out";
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}
