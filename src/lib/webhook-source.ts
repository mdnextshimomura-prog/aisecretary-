/**
 * 秘書の本処理（メール送信・番号での完了・#新規 の顧客登録・タスク登録など）を
 * 受け付けてよい送り主かどうか。
 *
 * 通すのは次の2つだけ（それ以外は何もしないで読み飛ばす）:
 *   - 会社グループ：source.type === "group" かつ groupId が LINE_GROUP_ID か SECRETARY_ALLOWED_GROUP_IDS（カンマ区切り）のどれか
 *   - 1対1     ：source.type === "user" かつ userId が SECRETARY_ALLOWED_USER_IDS（カンマ区切り）に含まれる
 *                （SECRETARY_ALLOWED_USER_IDS が空なら TASK_BUTTONS_ADMIN_IDS を使う）
 *
 * 設定が無ければ閉じる側に倒す（fail-closed）:
 *   - LINE_GROUP_ID・SECRETARY_ALLOWED_GROUP_IDS がどちらも未設定・空 → グループはすべて拒否
 *   - SECRETARY_ALLOWED_USER_IDS も TASK_BUTTONS_ADMIN_IDS も未設定・空 → 1対1 はすべて拒否
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
    // 通すグループ = LINE_GROUP_ID（営業部）＋ SECRETARY_ALLOWED_GROUP_IDS（業務指示グループなど、カンマ区切り）
    const groups = [
      ...parseAllowedUserIds(env.LINE_GROUP_ID),
      ...parseAllowedUserIds(env.SECRETARY_ALLOWED_GROUP_IDS),
    ];
    if (groups.length === 0) return { ok: false, reason: "group-not-configured" };
    if (!source?.groupId || !groups.includes(source.groupId)) {
      return { ok: false, reason: "group-mismatch" };
    }
    return { ok: true };
  }
  if (type === "user") {
    // SECRETARY_ALLOWED_USER_IDS が空なら、ボタンの管理者（TASK_BUTTONS_ADMIN_IDS＝下村さん）だけを通す
    const explicit = parseAllowedUserIds(env.SECRETARY_ALLOWED_USER_IDS);
    const allowed =
      explicit.length > 0 ? explicit : parseAllowedUserIds(env.TASK_BUTTONS_ADMIN_IDS);
    if (allowed.length === 0) return { ok: false, reason: "user-not-configured" };
    if (!source?.userId || !allowed.includes(source.userId)) {
      return { ok: false, reason: "user-not-allowed" };
    }
    return { ok: true };
  }
  if (type === "room") return { ok: false, reason: "room" };
  return { ok: false, reason: "unknown-source" };
}
