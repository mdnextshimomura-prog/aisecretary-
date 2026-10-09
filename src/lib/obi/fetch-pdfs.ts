/**
 * 控えた PDF を LINE から全部取り出す（設計 2026-10-09 の 10・11）。
 *
 * 1件でも取れない（LINE 側の保存期間切れなど）・`%PDF-` で始まらない・時間切れなら、
 * 受付全体をやめる。受付の返事に書いたファイルと portal に入ったファイルを必ず一致させるため、
 * 「取れた分だけ送る」はしない。
 */
import { createHash } from "crypto";
import { OBI_MAX_TOTAL_BYTES, type ObiPdfRecord } from "./memo";
import { sanitizeUploadName } from "./sanitize";

export interface FetchedPdf {
  messageId: string;
  fileName: string; // portal に送る名前（sanitizeUploadName 済み）
  bytes: Uint8Array;
  size: number;
  sha256: string; // 16進64桁
}

export type FetchPdfsResult =
  | { kind: "ok"; files: FetchedPdf[] }
  | { kind: "failed"; fileName: string; reason: "unavailable" | "timeout" | "not-pdf" }
  | { kind: "too-large"; totalBytes: number };

export const LINE_FETCH_PER_FILE_MS = 15_000;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

function isPdf(b: Uint8Array): boolean {
  return b.length >= PDF_MAGIC.length && PDF_MAGIC.every((c, i) => b[i] === c);
}

/**
 * 本文を少しずつ読み、読んだ量が limit を超えた時点で読むのをやめる。
 * Content-Length は付かないこともあり、付いていても正しいとは限らないので頼らない
 * （arrayBuffer() で全部を読んでから大きさを見ると、巨大な応答でメモリを使い切る）。
 */
async function readBodyLimited(
  res: Response,
  limit: number
): Promise<{ kind: "ok"; bytes: Uint8Array } | { kind: "too-large"; read: number }> {
  if (!res.body) return { kind: "ok", bytes: new Uint8Array(0) };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    if (read > limit) {
      await reader.cancel().catch(() => undefined);
      return { kind: "too-large", read };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(read);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { kind: "ok", bytes };
}

export async function fetchObiPdfs(
  pdfs: ObiPdfRecord[],
  opts: {
    fetchImpl: typeof fetch;
    lineToken: string;
    now: () => number;
    /** 取り出し全体の締め切り（絶対時刻 ms） */
    deadline: number;
  }
): Promise<FetchPdfsResult> {
  const files: FetchedPdf[] = [];
  let total = 0;
  for (const p of pdfs) {
    const remaining = opts.deadline - opts.now();
    if (remaining <= 0) return { kind: "failed", fileName: p.fileName, reason: "timeout" };
    let bytes: Uint8Array;
    try {
      const res = await opts.fetchImpl(
        `https://api-data.line.me/v2/bot/message/${p.messageId}/content`,
        {
          headers: { Authorization: `Bearer ${opts.lineToken}` },
          signal: AbortSignal.timeout(Math.min(LINE_FETCH_PER_FILE_MS, remaining)),
          cache: "no-store",
        }
      );
      if (!res.ok) {
        console.error("帯替え：LINE の PDF を取り出せない:", p.messageId, res.status);
        return { kind: "failed", fileName: p.fileName, reason: "unavailable" };
      }
      // Content-Length が付いていて上限を超えるなら、読まずにやめる（近道。頼るのは下の読み取り）
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > 0 && total + declared > OBI_MAX_TOTAL_BYTES) {
        await res.body?.cancel().catch(() => undefined);
        return { kind: "too-large", totalBytes: total + declared };
      }
      // 実際に読んだバイト数の合計が上限を超えた時点で読むのをやめる
      const body = await readBodyLimited(res, OBI_MAX_TOTAL_BYTES - total);
      if (body.kind === "too-large") return { kind: "too-large", totalBytes: total + body.read };
      bytes = body.bytes;
    } catch (err) {
      const name = (err as { name?: string })?.name;
      console.error("帯替え：LINE の PDF の取り出しに失敗:", p.messageId, name);
      return {
        kind: "failed",
        fileName: p.fileName,
        reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "unavailable",
      };
    }
    if (!isPdf(bytes)) return { kind: "failed", fileName: p.fileName, reason: "not-pdf" };
    // 控えの大きさは LINE の申告。取り出した実際のバイト数でも確かめ直してある（readBodyLimited）
    total += bytes.byteLength;
    files.push({
      messageId: p.messageId,
      fileName: sanitizeUploadName(p.fileName),
      bytes,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return { kind: "ok", files };
}

/** 同じ中身（sha256 が同じ）の PDF を1つにまとめる。先に出たものを残す（設計 11） */
export function dedupeBySha256(files: FetchedPdf[]): FetchedPdf[] {
  const seen = new Set<string>();
  return files.filter((f) => {
    if (seen.has(f.sha256)) return false;
    seen.add(f.sha256);
    return true;
  });
}
