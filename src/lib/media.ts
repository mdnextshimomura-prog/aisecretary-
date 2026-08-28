/**
 * 直前に届いた画像・PDFを、タスク判定に添えるための取得処理。
 *
 * 背景（2026-08-14 のトーク履歴の実測）:
 *   このグループでの依頼の主な形は「資料の写真を送る → 担当者をメンションする」だった。
 *   社長の発言3,394件のうち571件が画像で、その直後は「@杉山 舜」「@All」のような
 *   ひと言だけ。文字だけ見ると内容ゼロなのでタスクにならず、**この形の依頼は
 *   1件もタスク化できていなかった**（稼働後のタスク化率は12%にとどまっていた）。
 *
 *   画像そのものは以前から `addPendingMedia` で控えてあった（メール宛先の名刺読み取り用）。
 *   ここではそれをタスク判定にも回す。
 */
import { getPendingMediaList, clearPendingMedia } from "./email/session";
import { fetchLineContent } from "./email/card";
import type { TaskAttachment } from "./claude";

export interface MediaSource {
  userId: string;
  groupId?: string;
}

// 1メッセージに添える上限。全部渡すと遅くなり、費用も増える。
// 依頼はたいてい直前の1〜2枚なので、新しい方から拾う。
// トーク履歴の実測（2025.10〜2026.08、添付を伴う依頼646件）:
//   1件 575回 / 2件 45回 / 3件 13回 / 4件以上 13回
// 3件だと2%を取りこぼす。5件にすると99.5%を拾える。
// 上限を設けるのは、依頼と無関係な古い画像まで巻き込まないため。
const MAX_ATTACHMENTS = 5;

// Claudeに渡せる添付のサイズ上限（概ね5MB）。超えるものは黙って捨てる。
// ここで落とさないとAPIがエラーになり、タスク登録ごと失敗する。
const MAX_BYTES = 3.5 * 1024 * 1024;

function base64Bytes(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
}

function imageMediaType(ct: string): string {
  if (/png/i.test(ct)) return "image/png";
  if (/webp/i.test(ct)) return "image/webp";
  if (/gif/i.test(ct)) return "image/gif";
  return "image/jpeg";
}

/**
 * 直近に届いた画像・PDFを取得してタスク判定用の添付にする。
 * 取得に失敗したものは黙って飛ばす（添付が取れないだけでタスク登録を止めない）。
 */
export async function loadRecentAttachments(
  source: MediaSource
): Promise<TaskAttachment[]> {
  let media;
  try {
    media = await getPendingMediaList(source.groupId, source.userId);
  } catch (err) {
    console.error("直近メディアの取得に失敗（添付なしで続行）:", err);
    return [];
  }
  if (media.length === 0) return [];

  // 新しいものを優先する（依頼の直前に送られた資料が本命）
  const targets = media.slice(-MAX_ATTACHMENTS);
  const out: TaskAttachment[] = [];

  for (const m of targets) {
    try {
      const c = await fetchLineContent(m.messageId);
      if (!c) continue;
      if (base64Bytes(c.base64) > MAX_BYTES) {
        console.warn("添付が大きすぎるため除外:", m.messageId, m.fileName);
        continue;
      }
      const isPdf = /pdf/i.test(c.contentType) || /\.pdf$/i.test(m.fileName);
      out.push(
        isPdf
          ? { kind: "pdf", mediaType: "application/pdf", base64: c.base64 }
          : {
              kind: "image",
              mediaType: imageMediaType(c.contentType),
              base64: c.base64,
            }
      );
    } catch (err) {
      console.error("添付の取得に失敗（この1件を飛ばす）:", m.messageId, err);
    }
  }
  return out;
}

/**
 * 使い終わった直近メディアを消す。
 * 消さないと、同じ画像が後続のメッセージにも繰り返し添付され、
 * 無関係な発言が「その画像の依頼」として登録されてしまう。
 */
export async function consumeRecentAttachments(
  source: MediaSource
): Promise<void> {
  try {
    await clearPendingMedia(source.groupId, source.userId);
  } catch (err) {
    console.error("直近メディアの消去に失敗:", err);
  }
}
