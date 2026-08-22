/**
 * LINEの1通あたりの上限に収まるよう、本文を複数通に分ける。
 *
 * 経緯:
 *   これまでは「…ほか18件（Notionで確認してください）」と件数だけ出して
 *   打ち切っていた。LINEだけで完結しないと結局Notionを開くことになり、
 *   消し込みが進まない。上限まで詰めて、溢れたら次の通に送る方式へ変えた。
 *
 * LINEの制約:
 *   ・1通のテキストは5000文字まで
 *   ・1通あたりのメンションは20件まで
 *   どちらかに達したらそこで区切る。
 */

export interface ChunkItem {
  /** 本文に出す1行（番号は呼び出し側で振っておく） */
  text: string;
  /** @メンションする相手のLINE userId。いなければ null */
  userId?: string | null;
}

export interface Chunk {
  text: string;
  /** text 内の {キー} → userId */
  mentions: Record<string, string>;
}

// 5000が上限。絵文字や置換キーの展開で膨らむ余地を見て余裕を持たせる。
const MAX_CHARS = 4200;
const MAX_MENTIONS = 20;

export function buildChunks(
  header: string,
  items: ChunkItem[],
  footer: string
): Chunk[] {
  const chunks: Chunk[] = [];
  let body = "";
  let mentions: Record<string, string> = {};
  let mentionCount = 0;

  const flush = (last: boolean) => {
    if (!body) return;
    const head = chunks.length === 0 ? header : `（続き）`;
    chunks.push({ text: `${head}\n${body}${last ? footer : ""}`, mentions });
    body = "";
    mentions = {};
    mentionCount = 0;
  };

  for (const item of items) {
    // メンションを足すと上限を超えるなら、この行から次の通に回す
    const willMention = Boolean(item.userId) && mentionCount < MAX_MENTIONS;
    const key = willMention ? `m${mentionCount + 1}` : null;
    const line = `\n${item.text}${key ? ` {${key}}` : ""}`;

    const overChars =
      header.length + body.length + line.length + footer.length > MAX_CHARS;
    const overMentions = Boolean(item.userId) && mentionCount >= MAX_MENTIONS;

    if (body && (overChars || overMentions)) flush(false);

    // 区切った直後はカウンタが戻るのでキーを振り直す
    const k = item.userId && mentionCount < MAX_MENTIONS ? `m${mentionCount + 1}` : null;
    body += `\n${item.text}${k ? ` {${k}}` : ""}`;
    if (k && item.userId) {
      mentions[k] = item.userId;
      mentionCount += 1;
    }
  }

  flush(true);
  return chunks;
}
