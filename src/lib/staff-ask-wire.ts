/**
 * 担当に聞く（staff-ask.ts）を、本物の KV・LINE・Notion・名簿につなぐ。
 * どの入口も、STAFF_DIGEST が off なら KV・Notion・名簿・LINE の push を呼ばずに返る。例外は投げない。
 */
import { Client } from "@notionhq/client";
import { kv } from "@vercel/kv";
import { inboxOwner } from "./candidate-card";
import { GS_RETRY_NAMESPACE, gsFixKey, gsInfoKey } from "./group-satei-data";
import { pushMessagesWithRetryKeyIds } from "./line";
import { loadMembers, type Member } from "./members";
import { appendTaskNote } from "./notion";
import { sateiReasonKey } from "./satei-data";
import { uuidv5 } from "./satei-notify";
import { handleAskPostback, handleAskText, type AskAction, type AskDeps, type AskTask } from "./staff-ask";
import { DIGEST_GROUP_ID, staffDigestOn } from "./staff-digest";
import { chunkToMessage } from "./staff-digest-reply";
import { sdRealKv } from "./staff-digest-reply-wire";
import type { FlexMessage } from "./task-card";
import { isClosedPage } from "./task-closed";
import { isLineWorksOrigin, originOf } from "./task-origin";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const ROSTER_TIMEOUT_MS = 3_000;

const within = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};
const roster = () => within(loadMembers().catch(() => [] as Member[]), ROSTER_TIMEOUT_MS, [] as Member[]);

/** 仕分ける人か（名簿で同じ人の別アカウントも） */
export async function isInboxOwner(userId: string | null | undefined): Promise<boolean> {
  const owner = inboxOwner();
  if (!owner || !userId) return false;
  if (userId === owner) return true;
  const me = (await roster()).find((m) => m.userIds.includes(userId));
  return Boolean(me?.userIds.includes(owner));
}

/** タスクのカードに［担当に聞く］を足すか（仕分ける人の 1対1 に出すカードだけ。名簿は読まない） */
export function askButtonFor(src: { userId?: string | null; groupId?: string | null }): boolean {
  return staffDigestOn() && !src.groupId && Boolean(src.userId) && src.userId === inboxOwner();
}

const text = (props: Record<string, unknown>, key: string): string =>
  ((props[key] as { rich_text?: Array<{ plain_text?: string }> } | undefined)?.rich_text ?? [])
    .map((t) => t.plain_text ?? "")
    .join("")
    .trim();

/** タスクを読む（題名・物件・担当・発生元）。見つからない・消されたなら null */
async function readAskTask(pageId: string): Promise<AskTask | null> {
  let page: Record<string, unknown>;
  try {
    page = (await notion.pages.retrieve({ page_id: pageId })) as unknown as Record<string, unknown>;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "object_not_found" || code === "validation_error") return null;
    throw err;
  }
  if (page.archived || page.in_trash) return null;
  const props = (page.properties as Record<string, unknown>) ?? {};
  const origin = originOf(props);
  return {
    id: String(page.id),
    title: (props["名前"] as { title?: Array<{ plain_text: string }> } | undefined)?.title?.[0]?.plain_text ?? "（無題）",
    propertyName: text(props, "物件名") || null,
    assignee: (props["担当者"] as { select?: { name?: string } | null } | undefined)?.select?.name ?? null,
    assigneeUserId: text(props, "担当者ID") || null,
    origin,
    closed: isClosedPage(page),
    private: isLineWorksOrigin(origin),
  };
}

function askDeps(reply: (text: string, card?: FlexMessage) => Promise<void>): AskDeps {
  return {
    now: Date.now,
    kv: sdRealKv,
    isOwner: isInboxOwner,
    getTask: readAskTask,
    ownerName: async () => {
      const owner = inboxOwner();
      return owner ? ((await roster()).find((m) => m.userIds.includes(owner))?.name ?? null) : null;
    },
    // 査定の差し戻し理由・［直す］・足りない項目の「次の1通を待つ印」。どれかが立っていたら［自分で書く］は断る
    otherMarker: async (userId) => {
      const got = await Promise.all([kv.get(sateiReasonKey(userId)), kv.get(gsFixKey(userId)), kv.get(gsInfoKey(userId))]);
      return got.some(Boolean);
    },
    mainGroup: DIGEST_GROUP_ID || null,
    // retry key つき・時間の上限つき（line.ts の既定 5 秒）
    pushGroup: (to, chunk, key) => pushMessagesWithRetryKeyIds(to, [chunkToMessage(chunk)], uuidv5(key, GS_RETRY_NAMESPACE)),
    appendNote: appendTaskNote,
    reply,
    log: (line) => console.log(line),
  };
}

/** ［担当に聞く］のボタン（v1|ka|・v1|kp|・v1|kw|）の postback */
export async function handleStaffAskPostback(
  a: AskAction,
  src: { userId?: string | null; webhookEventId?: string | null },
  reply: (text: string, card?: FlexMessage) => Promise<void>
): Promise<void> {
  await handleAskPostback(a, src, askDeps(reply));
}

/** webhook の 1対1 の文字から：［自分で書く］のあとの1通なら扱って true。off・グループ・印なしは false（今までの流れへ） */
export async function handleStaffAskText(
  input: { userId?: string | null; groupId?: string | null; text: string },
  reply: (text: string) => Promise<void>
): Promise<boolean> {
  if (!staffDigestOn() || input.groupId || !input.userId) return false;
  try {
    return await handleAskText(input, askDeps(reply));
  } catch {
    console.log("[staff-ask] text error");
    return false;
  }
}
