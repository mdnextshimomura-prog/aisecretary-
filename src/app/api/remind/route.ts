import { NextRequest, NextResponse } from "next/server";
import { sendDailyReminders } from "@/lib/remind";
import { isCronAuthorized } from "@/lib/cron-auth";

// Vercel Cron Jobs から呼び出される（毎朝8時）
// vercel.json: { "crons": [{ "path": "/api/remind", "schedule": "0 23 * * *" }] }
// ※ UTCで23時 = JST 08時

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Vercel Cron の認証ヘッダー検証。CRON_SECRET が未設定なら誰も通さない（`Bearer undefined` で通る書き方にしない）
  if (!isCronAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await sendDailyReminders();
  return NextResponse.json({ status: "ok" });
}
