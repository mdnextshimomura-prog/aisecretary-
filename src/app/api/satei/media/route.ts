import { NextRequest, NextResponse } from "next/server";
import { gsMediaAuthorized, handleGsMedia } from "@/lib/group-satei-media";
import { groupSateiMediaDeps } from "@/lib/group-satei-wire";
import { SATEI_TOKEN_HEADER } from "@/lib/satei-notify";

// 段2e：Mac の査定係が事例の PDF を1件ずつ取る口（計画 2026-11-26-group-satei-2e）。合言葉はヘッダ x-satei-token（文 "satei-media"）。
// src/middleware.ts の matcher には入れない（入れると査定係が 401 になる）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "cache-control": "no-store" };
const BODY_MAX = 1024;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = req.headers.get(SATEI_TOKEN_HEADER);
  // 合言葉を確かめてから本文を読む（合言葉の無い大きな POST を読まない）
  if (!gsMediaAuthorized(token, process.env.JOB_API_TOKEN)) {
    console.log("[group-satei] media unauthorized");
    return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401, headers: NO_STORE });
  }
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > BODY_MAX) {
    return NextResponse.json({ code: "BAD_REQUEST" }, { status: 400, headers: NO_STORE });
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > BODY_MAX) {
    return NextResponse.json({ code: "BAD_REQUEST" }, { status: 400, headers: NO_STORE });
  }
  const r = await handleGsMedia(token, raw, groupSateiMediaDeps());
  if ("pdf" in r) {
    return new NextResponse(new Uint8Array(r.pdf), {
      status: 200,
      headers: { ...NO_STORE, "content-type": "application/pdf", "content-length": String(r.pdf.length) },
    });
  }
  return NextResponse.json({ code: r.code }, { status: r.status, headers: NO_STORE });
}

export function GET(): NextResponse {
  return NextResponse.json({ error: "Method Not Allowed" }, { status: 405, headers: { ...NO_STORE, allow: "POST" } });
}
