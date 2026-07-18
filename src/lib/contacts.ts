// 名前 → メールアドレスの解決。
// 社内メンバーの台帳は環境変数 EMAIL_CONTACTS に JSON で持つ（git管理外の秘密ではないが、
// 人により変わるためコードに埋め込まない）。
//   例: EMAIL_CONTACTS='{"下村":"shimomura@example.com","田中":"tanaka@example.com"}'
// 名前ゆらぎ（「下村さん」「下村太郎」等）にゆるく対応するため、部分一致も許可する。

export interface ResolvedRecipient {
  raw: string; // 元の指定（名前 or アドレス）
  name: string; // 表示用の名前（アドレス直指定時はアドレスそのまま）
  email: string | null; // 解決できたメールアドレス。未解決は null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function loadContacts(): Record<string, string> {
  const raw = process.env.EMAIL_CONTACTS;
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, string>;
    return obj && typeof obj === "object" ? obj : {};
  } catch (err) {
    console.error("EMAIL_CONTACTS のJSON解析に失敗:", err);
    return {};
  }
}

// 「下村さん」→「下村」のように敬称を落として突き合わせやすくする
function normalizeName(s: string): string {
  return s.trim().replace(/(さん|様|君|くん|ちゃん|部長|課長|社長)$/, "");
}

export function resolveRecipient(nameOrEmail: string): ResolvedRecipient {
  const raw = (nameOrEmail ?? "").trim();

  // すでにメールアドレスならそのまま採用
  if (EMAIL_RE.test(raw)) {
    return { raw, name: raw, email: raw };
  }

  const contacts = loadContacts();
  const target = normalizeName(raw);

  // 1) 完全一致（正規化後）
  for (const [name, email] of Object.entries(contacts)) {
    if (normalizeName(name) === target) {
      return { raw, name, email };
    }
  }
  // 2) 部分一致（「下村太郎」で登録 / 「下村」で指定 などを救う）
  for (const [name, email] of Object.entries(contacts)) {
    const n = normalizeName(name);
    if (target && (n.includes(target) || target.includes(n))) {
      return { raw, name, email };
    }
  }

  return { raw, name: raw, email: null };
}
