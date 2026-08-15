import { NextRequest, NextResponse } from "next/server";
import { loadClosures, firstBusinessDayAfterClosure } from "@/lib/closures";
import { sendClosureStocktake } from "@/lib/report";
import { jstDateStr } from "@/lib/notion";

/**
 * 休業明けの棚卸しレポート（Vercel Cronから毎日10時に呼ばれる）。
 *
 * 毎日呼ばれるが、**休業明けの初日だけ**送る。それ以外の日は何もしない。
 * お盆・年末年始・GW・臨時休業、どれでも休業日カレンダーに入っていれば自動で働く。
 *
 * この日は朝のリマインド（8時）を止めてある。両方送ると番号が二重に振られ、
 * 朝の番号で返信した人が別のタスクを完了にしてしまうため。
 *
 * `?force=1` を付けると休業明けでなくても送る（動作確認用）。
 * `?dry=1` を付けると送らずに本文だけ返す（文面の事前確認用）。
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = jstDateStr(0);
  const closures = await loadClosures();
  const closureName = firstBusinessDayAfterClosure(today, closures);
  const params = new URL(req.url).searchParams;
  const dry = params.get("dry") === "1";
  const force = params.get("force") === "1" || dry;

  if (!closureName && !force) {
    console.log(`[report] ${today} は休業明けではないため送らない`);
    return NextResponse.json({ status: "skipped", today });
  }

  // 休業の開始日＝「ここから後に登録されたものは休業中に届いた分」の境目
  const closure = closures.find((c) => c.name === closureName);
  const name = closureName ?? "休業";
  const start = closure?.start ?? today;

  try {
    const result = await sendClosureStocktake(name, start, dry);
    console.log(`[report] ${name}明けの棚卸しを送信:`, result);
    return NextResponse.json({ status: "ok", today, closure: name, ...result });
  } catch (err) {
    console.error("[report] 棚卸しの送信に失敗:", err);
    return NextResponse.json(
      { error: "棚卸しの送信に失敗しました" },
      { status: 500 }
    );
  }
}
