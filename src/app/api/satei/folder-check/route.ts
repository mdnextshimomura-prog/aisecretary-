import { NextRequest, NextResponse } from "next/server";
import { handleSateiFolderCheck } from "@/lib/satei-folder-check";
import { SATEI_TOKEN_HEADER } from "@/lib/satei-notify";
import { sateiFolderCheckDeps } from "@/lib/satei-wire";

// B2 査定書：保存直前のフォルダ照合（契約 6-3）。合言葉はヘッダ x-satei-token（通知の受け口と同じ）。
// src/middleware.ts の matcher には入れない（入れると査定係が 401 になる）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "cache-control": "no-store" };
const BODY_MAX = 4 * 1024;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > BODY_MAX) {
    return NextResponse.json({ error: "too-large" }, { status: 413, headers: NO_STORE });
  }
  const r = await handleSateiFolderCheck(req.headers.get(SATEI_TOKEN_HEADER), raw, sateiFolderCheckDeps());
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

export function GET(): NextResponse {
  return NextResponse.json(
    { error: "Method Not Allowed" },
    { status: 405, headers: { ...NO_STORE, allow: "POST" } },
  );
}
