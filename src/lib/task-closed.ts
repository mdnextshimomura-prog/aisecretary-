/**
 * タスクがもう処理済みか（ステータスが完了／終わり方が入っている／ページが消されている）。
 *
 * 使い道：
 *  - 初動確認への回答で Notion を更新する直前の安全網（route.ts）。ボタン等で完了・不要にした
 *    タスクを、残っていた確認セッションへの回答で「未着手」に戻さない。
 *  - ボタンの「このタスクはもう処理済みです」の判定（task-buttons-wire.ts）。
 */

type PageLike = Record<string, unknown>;

function selectName(
  props: Record<string, unknown>,
  key: string,
): string | null {
  return (
    (props[key] as { select?: { name: string } | null } | undefined)?.select
      ?.name ?? null
  );
}

export function isClosedPage(page: PageLike): boolean {
  if (page.archived || page.in_trash) return true;
  const props = (page.properties as Record<string, unknown>) ?? {};
  return (
    selectName(props, "ステータス") === "完了" ||
    Boolean(selectName(props, "終わり方"))
  );
}

/**
 * Notion からページを読んで判定する。見つからない（消えた）タスクは処理済みとみなす。
 * それ以外の読み取りの失敗は例外のまま返す（呼び出し側は更新しない側に倒す）。
 */
export async function readTaskClosed(
  pageId: string,
  retrieve: (pageId: string) => Promise<PageLike>,
): Promise<boolean> {
  let page: PageLike;
  try {
    page = await retrieve(pageId);
  } catch (err) {
    if ((err as { code?: string }).code === "object_not_found") return true;
    throw err;
  }
  return isClosedPage(page);
}
