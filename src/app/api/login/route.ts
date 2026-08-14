import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  AUTH_MAX_AGE,
  expectedToken,
  isAuthConfigured,
  verifyCredentials,
} from "@/lib/auth";

// ログインフォームからの送信を受け、正しければCookieを発行する。
// このルートは middleware の matcher に含めない（含めると入口が無くなる）。
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAuthConfigured()) {
    return NextResponse.json(
      { error: "認証が設定されていません（APP_BASIC_USER / APP_BASIC_PASSWORD）" },
      { status: 500 }
    );
  }

  let user = "";
  let password = "";
  try {
    const body = (await req.json()) as { user?: string; password?: string };
    user = String(body.user ?? "");
    password = String(body.password ?? "");
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }

  if (!verifyCredentials(user, password)) {
    // どちらが違うかは返さない（総当たりの手掛かりになるため）
    return NextResponse.json(
      { error: "IDまたはパスワードが違います" },
      { status: 401 }
    );
  }

  const token = await expectedToken();
  if (!token) {
    return NextResponse.json({ error: "認証の初期化に失敗しました" }, { status: 500 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true, // JavaScriptから読めないようにする
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_MAX_AGE,
  });
  return res;
}
