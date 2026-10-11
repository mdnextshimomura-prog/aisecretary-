import { NextRequest, NextResponse } from "next/server";
import { handleCloudTick } from "@/lib/obi/cloud-entry";

// 帯替えの完成リンク・差し戻し・失敗の知らせを、クラウドから出す毎分の見回り（設計 2026-10-11 の C1）。
// 起こすのは portal（Railway の worker が毎分、portal の web を経由して、ここを POST でたたく）。
// Vercel の cron は使わない（Hobby プランは毎分の cron を受けない）。vercel.json に、この入口の cron は無い。
// 合言葉（ヘッダ x-obi-tick-token）・スイッチ・設定の確認は cloud-entry.ts。本文・クエリは読まない。
// 1回の見回りを終えてから応答する（portal は応答を待つ）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "cache-control": "no-store" };

export async function POST(req: NextRequest): Promise<NextResponse> {
  const r = await handleCloudTick(req.headers.get("x-obi-tick-token"));
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

// GET では見回りを動かさない（合言葉も見ない）
export function GET(): NextResponse {
  return NextResponse.json({ error: "Method Not Allowed" }, { status: 405, headers: { ...NO_STORE, allow: "POST" } });
}
