import { NextRequest, NextResponse } from "next/server";
import { askCandidatesIfDue } from "@/lib/task-candidate-ask";
import { isCronAuthorized } from "@/lib/cron-auth";

// タスクの候補を 1 日 1 回、会社グループに聞く（Vercel Cron から。17 時台＝UTC 8 時台）。
// vercel.json: { "path": "/api/candidates-ask", "schedule": "0 8 * * *" }
//
// /api/remind-due（外の仕組みが 10 分おきに叩く前提の入口）にも同じ聞き取りを相乗りさせてあるが、
// 2026-10-12 に本番の記録を見たところ、その入口が呼ばれている形跡が無かった。
// 外の仕組みに頼らず出せるよう、朝のリマインドと同じ Vercel Cron の入口を別に持つ。
// 両方が動いても、1 日 1 回に絞る印（claimDailyAsk）があるので二重には聞かない。
export async function GET(req: NextRequest): Promise<NextResponse> {
  // CRON_SECRET が未設定のときは誰も通さない（`Bearer undefined` で通る書き方にしない）
  if (!isCronAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ログに出すのは結果の符号だけ（候補の本文・題名は出さない）
  const result = await askCandidatesIfDue(Date.now()).catch((e) => {
    console.error("[candidates-ask] エラー:", e);
    return "error" as const;
  });
  console.log(`[candidates-ask] ${result}`);
  return NextResponse.json({ status: result });
}
