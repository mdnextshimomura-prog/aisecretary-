/**
 * 秘書の本処理（メール送信・番号での完了・#新規 の顧客登録・タスク登録など）を
 * 受け付けてよい送り主かどうか。
 *
 * 通すのは次の2つだけ（それ以外は何もしないで読み飛ばす）:
 *   - 会社グループ：source.type === "group" かつ groupId === LINE_GROUP_ID
 *   - 1対1     ：source.type === "user" かつ userId が SECRETARY_ALLOWED_USER_IDS（カンマ区切り）に含まれる
 *
 * 設定が無ければ閉じる側に倒す（fail-closed）:
 *   - LINE_GROUP_ID が未設定・空 → グループはすべて拒否
 *   - SECRETARY_ALLOWED_USER_IDS が未設定・空 → 1対1 はすべて拒否
 *   - room（複数人トーク）・その他の種類 → 拒否
 *
 * 帯替え（src/lib/obi）は別に判定してから残りを渡してくるので、ここは帯替えには関わらない。
 */

export type SourceGateReason =
  | "group-not-configured"
  | "group-mismatch"
  | "user-not-configured"
  | "user-not-allowed"
  | "room"
  | "unknown-source";

export type SourceGateResult = { ok: true } | { ok: false; reason: SourceGateReason };

export interface GateSource {
  type?: string;
  userId?: string;
  groupId?: string;
}

/** カンマ区切りの許可リストを読む（前後の空白・空要素は捨てる） */
export function parseAllowedUserIds(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function checkSecretarySource(
  source: GateSource | undefined,
  env: Record<string, string | undefined> = process.env
): SourceGateResult {
  const type = source?.type;
  if (type === "group") {
    const groupId = (env.LINE_GROUP_ID ?? "").trim();
    if (!groupId) return { ok: false, reason: "group-not-configured" };
    if (!source?.groupId || source.groupId !== groupId) {
      return { ok: false, reason: "group-mismatch" };
    }
    return { ok: true };
  }
  if (type === "user") {
    const allowed = parseAllowedUserIds(env.SECRETARY_ALLOWED_USER_IDS);
    if (allowed.length === 0) return { ok: false, reason: "user-not-configured" };
    if (!source?.userId || !allowed.includes(source.userId)) {
      return { ok: false, reason: "user-not-allowed" };
    }
    return { ok: true };
  }
  if (type === "room") return { ok: false, reason: "room" };
  return { ok: false, reason: "unknown-source" };
}
