// LINEのファイル/画像メッセージの実体（PDF等）をダウンロードする。
// メール送信の直前に呼び、nodemailerの添付として使う。
const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;

export async function fetchLineFileBuffer(
  messageId: string
): Promise<Buffer | null> {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
  if (!res.ok) {
    console.error("LINEファイル取得失敗:", messageId, res.status);
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}
