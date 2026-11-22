import { NextRequest, NextResponse } from "next/server";
import { handleSateiAsk } from "@/lib/satei-ask";
import { sateiAskDeps } from "@/lib/satei-ask-wire";
import { SATEI_TOKEN_HEADER } from "@/lib/satei-notify";

// 「案件はどれですか」のカードを頼む口（設計 2026-11-22-satei-ask-card-design）。合言葉はヘッダ x-satei-token（文は "satei-ask"）。
// src/middleware.ts の matcher には入れない（入れると Mac が 401 になる）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const NO_STORE = { "cache-control": "no-store" };
const BODY_MAX = 4 * 1024;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > BODY_MAX) {
    return NextResponse.json({ error: "too-large" }, { status: 413, headers: NO_STORE });
  }
  const r = await handleSateiAsk(req.headers.get(SATEI_TOKEN_HEADER), raw, sateiAskDeps());
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

export function GET(): NextResponse {
  return NextResponse.json({ error: "Method Not Allowed" }, { status: 405, headers: { ...NO_STORE, allow: "POST" } });
}
