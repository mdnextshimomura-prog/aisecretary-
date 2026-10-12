import { NextRequest, NextResponse } from "next/server";
import { runDueReminders } from "@/lib/remind-due";
import { askCandidatesIfDue } from "@/lib/task-candidate-ask";

// 期限前通知の入口（CRON_SECRET で守る）。本体は src/lib/remind-due.ts。
// 10 分おきに外から叩く前提で作られたが、その仕組みは作られていない。
// いま起こしているのは、毎分の見回り /api/obi/cloud-tick への相乗り（DUE_REMIND_TICK=1）。

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();

  // タスクの候補を 1 日 1 回（17 時台）聞く。この入口が 10 分おきに叩かれるのに相乗りする。
  // 失敗しても、下の期限前通知は止めない。ログには結果の符号だけ出す（本文は出さない）
  const asked = await askCandidatesIfDue(now).catch((e) => {
    console.error("[remind-due] 候補の聞き取りでエラー（続行）:", e);
    return "error" as const;
  });
  if (asked !== "off" && asked !== "not-time") {
    console.log(`[remind-due] 候補の聞き取り: ${asked}`);
  }

  const r = await runDueReminders(now);
  // この入口が叩かれたか可視化するための目印
  console.log(`[remind-due] invoked / 対象候補 ${r.checked}件`);

  return NextResponse.json({ status: "ok", checked: r.checked, sent: r.sent });
}
