import { NextRequest, NextResponse } from "next/server";

/**
 * 社内向け画面の簡易認証（Basic認証）。
 *
 * 背景:
 *   本番URLは誰でも開ける状態だった。とくに /restoration は
 *   PDFをアップロードすると当社のClaude APIを消費するため、URLが漏れると
 *   第三者に費用を使われる。画面側だけを守る。
 *
 * ここで守らないもの（意図的に除外・matcher参照）:
 *   - /api/webhook  … LINEからのPOST。Basic認証を掛けると秘書が止まる。
 *                     LINE署名の検証で既に守られている。
 *   - /api/remind, /api/remind-due … Cron/GASからの呼び出し。
 *                     CRON_SECRET のBearer検証で既に守られている。
 *   ※ Vercel側のDeployment Protectionで一括に掛けると上記まで401になり、
 *     LINE秘書が無言で停止する。だからアプリ内で画面だけを守る。
 *
 * 設定:
 *   環境変数 APP_BASIC_USER / APP_BASIC_PASSWORD をVercelに設定する。
 *   **未設定の間は素通しする**（設定前にデプロイして社員が締め出されるのを防ぐため）。
 *   設定後は再デプロイで有効になる。
 */

const REALM = "MD NEXT AI秘書";

// 長さの違いで早期リターンしない比較（総当たりの手掛かりを減らす）
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function unauthorized(): NextResponse {
  return new NextResponse("認証が必要です", {
    status: 401,
    headers: { "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"` },
  });
}

export function middleware(req: NextRequest): NextResponse {
  const user = process.env.APP_BASIC_USER;
  const password = process.env.APP_BASIC_PASSWORD;

  // 未設定なら素通し（＝これまでどおり）。設定するまで保護は掛からない。
  if (!user || !password) {
    console.warn(
      "[middleware] APP_BASIC_USER / APP_BASIC_PASSWORD が未設定のため画面は公開状態です"
    );
    return NextResponse.next();
  }

  const header = req.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("basic ")) return unauthorized();

  let decoded: string;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return unauthorized();
  }

  // パスワードに「:」が含まれても壊れないよう、最初の「:」だけで分割する
  const sep = decoded.indexOf(":");
  if (sep < 0) return unauthorized();
  const givenUser = decoded.slice(0, sep);
  const givenPassword = decoded.slice(sep + 1);

  // 片方だけ先に判定すると、どちらが違うのかが応答時間から漏れる。両方評価する。
  const okUser = safeEqual(givenUser, user);
  const okPassword = safeEqual(givenPassword, password);
  if (!okUser || !okPassword) return unauthorized();

  return NextResponse.next();
}

// 保護する経路。LINE/Cronが叩く /api/webhook・/api/remind・/api/remind-due は含めない。
export const config = {
  matcher: [
    "/",
    "/dashboard/:path*",
    "/restoration/:path*",
    "/api/tasks/:path*",
    "/api/restoration/:path*",
  ],
};
