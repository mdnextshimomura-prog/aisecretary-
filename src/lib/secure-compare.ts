import crypto from "crypto";

/**
 * 秘密の値どうしを、かかる時間で中身が漏れない形で比べる（Node の crypto.timingSafeEqual）。
 * 長さが違えば先に false（timingSafeEqual は長さ違いで例外を投げるため）。
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
