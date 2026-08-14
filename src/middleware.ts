import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  expectedToken,
  isAuthConfigured,
  safeEqual,
  verifyCredentials,
} from "@/lib/auth";

/**
 * 社内向け画面の入口チェック。
 *
 * 背景:
 *   本番URLは誰でも開ける状態だった。とくに /restoration は
 *   PDFをアップロードすると当社のClaude APIを消費するため、URLが漏れると
 *   第三者に費用を使われる。画面側だけを守る。
 *
 * ここで守らないもの（意図的に matcher から除外）:
 *   - /api/webhook  … LINEからのPOST。認証を掛けると秘書が止まる。
 *                     LINE署名の検証で既に守られている。
 *   - /api/remind, /api/remind-due … Cron/GASからの呼び出し。
 *                     CRON_SECRET のBearer検証で既に守られている。
 *   - /login, /api/login … ログイン自体。ここを守ると入口が無くなる。
 *   ※ Vercel側のDeployment Protectionで一括に掛けると上記まで401になり、
 *     LINE秘書が無言で停止する。だからアプリ内で画面だけを守る。
 *
 * 設定:
 *   環境変数 APP_BASIC_USER / APP_BASIC_PASSWORD をVercelに設定する。
 *   **未設定の間は素通しする**（設定前にデプロイして社員が締め出されるのを防ぐため）。
 */

function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  // 未設定なら素通し（＝これまでどおり）。設定するまで保護は掛からない。
  if (!isAuthConfigured()) {
    console.warn(
      "[middleware] APP_BASIC_USER / APP_BASIC_PASSWORD が未設定のため画面は公開状態です"
    );
    return NextResponse.next();
  }

  const token = await expectedToken();

  // ① ログイン済みCookie
  const cookie = req.cookies.get(AUTH_COOKIE)?.value;
  if (token && cookie && safeEqual(cookie, token)) return NextResponse.next();

  // ② Basic認証も引き続き受け付ける。
  //    curl や監視ツールから叩くときに、フォームを経由せず認証できるようにするため。
  const header = req.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(header.slice(6).trim());
      const sep = decoded.indexOf(":");
      // パスワードに「:」が含まれても壊れないよう、最初の「:」だけで分割する
      if (sep >= 0 && verifyCredentials(decoded.slice(0, sep), decoded.slice(sep + 1))) {
        return NextResponse.next();
      }
    } catch {
      // デコードできない Authorization は無視して未認証扱いにする
    }
  }

  // ③ 未認証。APIはJSONで返し、画面はログインフォームへ送る
  //    （画面に401の文字だけ出すと、入口が分からず詰む）
  if (isApiPath(req.nextUrl.pathname)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

// 保護する経路。LINE/Cronが叩く /api/webhook・/api/remind・/api/remind-due と、
// ログイン画面自身（/login・/api/login）は含めない。
export const config = {
  matcher: [
    "/",
    "/dashboard/:path*",
    "/restoration/:path*",
    "/api/tasks/:path*",
    "/api/restoration/:path*",
  ],
};
