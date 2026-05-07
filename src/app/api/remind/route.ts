import { NextRequest, NextResponse } from "next/server";
import { sendDailyReminders } from "@/lib/remind";

// Vercel Cron Jobs から呼び出される（毎朝8時）
// vercel.json: { "crons": [{ "path": "/api/remind", "schedule": "0 23 * * *" }] }
// ※ UTCで23時 = JST 08時

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Vercel Cron の認証ヘッダー検証
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await sendDailyReminders();
  return NextResponse.json({ status: "ok" });
}
