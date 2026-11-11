import { NextRequest, NextResponse } from "next/server";
import { handleSateiNotify, SATEI_TOKEN_HEADER } from "@/lib/satei-notify";
import { sateiNotifyDeps } from "@/lib/satei-wire";

// B2 査定書：Mac の査定係からの通知（契約 第3節）。合言葉はヘッダ x-satei-token（satei-notify.ts）。
// src/middleware.ts の matcher には入れない（入れると査定係が 401 になる）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "cache-control": "no-store" };
const BODY_MAX = 32 * 1024;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > BODY_MAX) {
    return NextResponse.json({ error: "too-large" }, { status: 413, headers: NO_STORE });
  }
  const r = await handleSateiNotify(req.headers.get(SATEI_TOKEN_HEADER), raw, sateiNotifyDeps());
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

export function GET(): NextResponse {
  return NextResponse.json(
    { error: "Method Not Allowed" },
    { status: 405, headers: { ...NO_STORE, allow: "POST" } },
  );
}
