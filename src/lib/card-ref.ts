/**
 * 付け直したカードの引用を、タスクに結び付ける控え（KV の `cardref:<messageId>` = pageId、30 日）。
 *
 * ボタンを押したあとの返事（text＋カード）は送るたびに増える。その ID を Notion の メッセージID や
 * 確認セッションへ「読み直して足して全置換」すると、並ぶ操作・回答の保存と取り合いになる
 * （Codex レビュー 4 回目）。そこで、送れた ID ごとに単発の SET だけを書き、照合の側で引く。
 * - 書くのは TASK_BUTTONS が有効（buttonsActive）で、KV の設定（URL とトークンの両方）があるときだけ。
 *   無い・半分だけ・失敗したときは書かない／引かない（ログは `cardref-failed` だけ。メモリでは代用しない）。
 * - 引くのは、引用先がメッセージID で見つからなかったときだけ（findQuotedTask）。
 * 初回（受付時）の ID は今までどおり作成時に Notion の メッセージID へ書く（ここは使わない）。
 */
import { kv } from "@vercel/kv";
import { buttonsActive } from "./task-buttons";

export const CARDREF_TTL_SECONDS = 60 * 60 * 24 * 30;
const PAGE_ID_RE =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export interface CardRefStore {
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<string | null>;
}

/** KV の設定が揃っていれば本物の KV、無い・半分だけなら null */
export function defaultCardRefStore(): CardRefStore | null {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN)
    return null;
  return {
    set: async (key, value, ttl) => {
      await kv.set(key, value, { ex: ttl });
    },
    get: async (key) => {
      const v = await kv.get<string>(key);
      return typeof v === "string" ? v : null;
    },
  };
}

const keyOf = (messageId: string) => `cardref:${messageId}`;

/** 送れた返事の ID（text・カード）ごとに pageId を控える。失敗しても投げない（ログだけ）。 */
export async function saveCardRefs(
  messageIds: Array<string | null | undefined>,
  pageId: string,
  store: CardRefStore | null,
  log: (line: string) => void,
): Promise<void> {
  if (!buttonsActive()) return;
  const ids = messageIds.filter((v): v is string => Boolean(v));
  if (ids.length === 0) return;
  if (!store) {
    log("[task-buttons] cardref-failed");
    return;
  }
  let failed = false;
  for (const id of ids) {
    try {
      await store.set(keyOf(id), pageId, CARDREF_TTL_SECONDS);
    } catch {
      failed = true;
    }
  }
  if (failed) log("[task-buttons] cardref-failed");
}

/** 引用先の ID から控えた pageId を引く。無い・引けないときは null。 */
export async function lookupCardRef(
  messageId: string,
  store: CardRefStore | null,
  log: (line: string) => void,
): Promise<string | null> {
  if (!buttonsActive()) return null;
  if (!store) {
    log("[task-buttons] cardref-failed");
    return null;
  }
  try {
    const v = await store.get(keyOf(messageId));
    return v && PAGE_ID_RE.test(v) ? v : null;
  } catch {
    log("[task-buttons] cardref-failed");
    return null;
  }
}

export interface QuotedTaskDeps {
  /** Notion の メッセージID で探す（findTaskByMessageId） */
  findByMessageId(
    messageId: string,
  ): Promise<{ id: string; title: string } | null>;
  store: CardRefStore | null;
  /** pageId からタスクを読む。消された（アーカイブ・ゴミ箱）・見つからないなら null */
  readTask(pageId: string): Promise<{ id: string; title: string } | null>;
  log(line: string): void;
}

/**
 * 引用先のタスク。まずメッセージID で探し（今までどおり）、見つからなければ cardref を引く。
 * TASK_BUTTONS が off なら findByMessageId だけ（今と同じ動き）。
 */
export async function findQuotedTask(
  messageId: string,
  deps: QuotedTaskDeps,
): Promise<{ id: string; title: string } | null> {
  const found = await deps.findByMessageId(messageId);
  if (found || !buttonsActive()) return found;
  const pageId = await lookupCardRef(messageId, deps.store, deps.log);
  if (!pageId) return null;
  return deps.readTask(pageId);
}
