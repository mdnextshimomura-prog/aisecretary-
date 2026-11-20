import { NextRequest, NextResponse } from "next/server";
import { handleSateiRequest } from "@/lib/satei-request";
import { SATEI_TOKEN_HEADER } from "@/lib/satei-notify";
import { sateiRequestDeps } from "@/lib/satei-wire";

// B2 査定書：機械から査定を頼む口（約束 agent-hub 2026-11-19-satei-request）。合言葉はヘッダ x-satei-token（文は "satei-request"）。
// src/middleware.ts の matcher には入れない（入れると査定係が 401 になる）。
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
  const r = await handleSateiRequest(req.headers.get(SATEI_TOKEN_HEADER), raw, sateiRequestDeps());
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

export function GET(): NextResponse {
  return NextResponse.json(
    { error: "Method Not Allowed" },
    { status: 405, headers: { ...NO_STORE, allow: "POST" } },
  );
}
