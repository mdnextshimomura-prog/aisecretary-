/**
 * タスクがもう処理済みか（ステータスが完了／ページがアーカイブ・ゴミ箱）。
 * 終わり方は判定に使わない：再開（notion.ts の setTaskStatus）はステータスだけ戻して終わり方を残すため。
 * 済・不要はボタンでも文字でもステータスを「完了」にする（task-status.ts の closeProps・notion.ts の completeTask）。
 * Notion の object_not_found は削除だけでなく共有外・権限喪失でも返るので、処理済みにしない（"missing"）。
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
  return selectName(props, "ステータス") === "完了";
}

export type TaskState = "open" | "closed" | "missing";

/**
 * Notion からページを読んで判定する。見つからない（object_not_found）は "missing"。
 * それ以外の読み取りの失敗は例外のまま返す（呼び出し側は更新しない側に倒す）。
 */
export async function readTaskState(
  pageId: string,
  retrieve: (pageId: string) => Promise<PageLike>,
): Promise<TaskState> {
  let page: PageLike;
  try {
    page = await retrieve(pageId);
  } catch (err) {
    if ((err as { code?: string }).code === "object_not_found") return "missing";
    throw err;
  }
  return isClosedPage(page) ? "closed" : "open";
}

/**
 * 初動確認の回答で条件がそろったとき、ステータスを何にするか。null なら書かない。
 * 受付のカードは聞き返し中にも付くので、回答の前にボタンの［待ち］［延期］で「進行中」に
 * なっていることがある。それを「未着手」で上書きしない（要確認など、それ以外は今までどおり未着手）。
 * 完了も書かない（開き直さない。ふつうは手前の stopIfClosed で止まる）。
 */
export function statusAfterConfirm(current: string | null): string | null {
  if (current === "進行中" || current === "完了") return null;
  return "未着手";
}

/** 今のステータスの名前（無ければ null）。読めなければ例外のまま（呼び出し側は書かない側に倒す）。 */
export async function readTaskStatusName(
  pageId: string,
  retrieve: (pageId: string) => Promise<PageLike>,
): Promise<string | null> {
  const page = await retrieve(pageId);
  return selectName((page.properties as Record<string, unknown>) ?? {}, "ステータス");
}

/**
 * 初動確認の回答で条件がそろったときに書くステータス（route.ts の persist）。null なら書かない。
 * ボタン（TASK_BUTTONS）が off なら読まずに「未着手」（今と同じ動き・追加の Notion 読み取りなし）。
 * on のときは今のステータスを読み、進行中・完了なら書かない。読めなければ今までどおり「未着手」
 * （回答の反映をエラーにしない）。
 */
export async function statusForConfirmComplete(
  buttonsOn: boolean,
  readStatus: () => Promise<string | null>,
): Promise<string | null> {
  if (!buttonsOn) return "未着手";
  let current: string | null;
  try {
    current = await readStatus();
  } catch {
    return "未着手";
  }
  return statusAfterConfirm(current);
}
