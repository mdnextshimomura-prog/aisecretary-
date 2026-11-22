import { NextRequest, NextResponse } from "next/server";
import { handleSateiAskAnswers } from "@/lib/satei-ask";
import { sateiAskAnswersDeps } from "@/lib/satei-ask-wire";
import { SATEI_TOKEN_HEADER } from "@/lib/satei-notify";

// 「案件はどれですか」の答えを Mac が取りに来る口（設計 2026-11-22-satei-ask-card-design）。合言葉は /api/satei/ask と同じ。
// src/middleware.ts の matcher には入れない（入れると Mac が 401 になる）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const NO_STORE = { "cache-control": "no-store" };
const BODY_MAX = 1024;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > BODY_MAX) {
    return NextResponse.json({ error: "too-large" }, { status: 413, headers: NO_STORE });
  }
  const r = await handleSateiAskAnswers(req.headers.get(SATEI_TOKEN_HEADER), raw, sateiAskAnswersDeps());
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

export function GET(): NextResponse {
  return NextResponse.json({ error: "Method Not Allowed" }, { status: 405, headers: { ...NO_STORE, allow: "POST" } });
}
