import { NextRequest, NextResponse } from "next/server";
import { handleCloudTick } from "@/lib/obi/cloud-entry";

// 帯替えの完成リンク・差し戻し・失敗の知らせを、クラウドから出す毎分の見回り（設計 2026-10-11 の C1）。
// vercel.json: { "path": "/api/obi/cloud-tick", "schedule": "* * * * *" }
// 合言葉・スイッチ・設定の確認は cloud-entry.ts。本文・クエリは読まない。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const r = await handleCloudTick(req.headers.get("authorization"));
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
