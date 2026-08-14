/**
 * 社内向け画面のログイン認証。
 *
 * 当初は Basic認証にしていたが、アプリ内ブラウザ／WebView では
 * ログイン窓（ブラウザ標準のダイアログ）が出ず、
 * 「認証が必要です」の文字だけ出て誰も入れない画面になった。
 * そのため、普通のログインフォーム＋Cookie方式に変更した。
 *
 * Cookieには合言葉そのものを入れない。パスワードを鍵にしたHMACを入れ、
 * 検証側で同じ値を作り直して突き合わせる（Cookieを覗かれても復元できない）。
 * パスワードを変えるとHMACも変わるので、既存のログインは自動的に無効になる。
 *
 * Edge(middleware)とNode(APIルート)の両方から呼ぶため、Web Crypto のみを使う。
 */

export const AUTH_COOKIE = "aisecretary_auth";
export const AUTH_MAX_AGE = 60 * 60 * 24 * 30; // 30日

const encoder = new TextEncoder();

/** 認証を有効にするか（環境変数が両方そろっている時だけ有効） */
export function isAuthConfigured(): boolean {
  return Boolean(process.env.APP_BASIC_USER && process.env.APP_BASIC_PASSWORD);
}

/** Cookieに入れる合言葉（パスワードから決定的に作る） */
export async function expectedToken(): Promise<string | null> {
  const user = process.env.APP_BASIC_USER;
  const password = process.env.APP_BASIC_PASSWORD;
  if (!user || !password) return null;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`aisecretary:${user}`)
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 長さの違いで早期リターンしない比較（総当たりの手掛かりを減らす） */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 入力されたID・パスワードが正しいか */
export function verifyCredentials(user: string, password: string): boolean {
  const u = process.env.APP_BASIC_USER;
  const p = process.env.APP_BASIC_PASSWORD;
  if (!u || !p) return false;
  // 片方だけ先に判定すると、どちらが違うのかが応答時間から漏れる。両方評価する。
  const okUser = safeEqual(user, u);
  const okPassword = safeEqual(password, p);
  return okUser && okPassword;
}
