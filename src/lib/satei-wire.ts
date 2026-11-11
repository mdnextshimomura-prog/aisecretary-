/**
 * B2 査定書：satei-actions.ts・satei-notify.ts を本物の Notion・portal・LINE・KV・予約につなぐ。
 * - 案件：CRM_NOTION_TOKEN（無ければ NOTION_API_KEY）で CRM_案件 のページと、`物件` の1件目の CRM_物件 を読む（書かない）。
 * - portal：PORTAL_BASE_URL・JOB_API_TOKEN（帯替えと同じ）。そろわなければ呼ばずに断り扱い（ログ config-missing portal）。
 * - KV：deal-card-wire.ts の defaultDealKv（URL と TOKEN の両方があるときだけ）。
 * ログは出さない（呼ぶ側が操作名と結果の符号だけ出す）。例外：config-missing の1行。
 */
import { randomUUID } from "node:crypto";
import { Client } from "@notionhq/client";
import { kv } from "@vercel/kv";
import { pushMessagesWithRetryKey, replyTextAndCard, sendLineMessage } from "./line";
import { defaultDealKv } from "./deal-card-wire";
import { completeEvent, reserveEvent } from "./email/session";
import { readPropertyKind, readSateiDealPage, type SateiDeal } from "./satei-deal";
import {
  sateiDecide,
  sateiIntake,
  sateiPortalConfig,
  sateiReason,
  SATEI_PORTAL_TIMEOUT_MS,
  type SateiCall,
  type SateiPortalOpts,
} from "./satei-portal";
import type { SateiActionDeps, SateiReasonDeps, SateiReasonKv } from "./satei-actions";
import type { SateiNotifyDeps } from "./satei-notify";
import type { FolderCheckDeps } from "./satei-folder-check";

/**
 * satei 用の CRM の Notion Client。SDK の既定のログ（失敗時に error.message＝ページ ID を含む）を出さないよう、
 * 何も出さない logger を渡す。fetchImpl はテスト用（通信せずに本物の Client の経路を通すため）
 */
export function makeSateiNotion(fetchImpl?: typeof fetch): Client {
  return new Client({
    auth: process.env.CRM_NOTION_TOKEN ?? process.env.NOTION_API_KEY,
    logger: () => undefined,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

const crmNotion = makeSateiNotion();
const log = (line: string) => console.log(line);

async function retrieve(client: Client, pageId: string): Promise<Record<string, unknown> | null> {
  try {
    return (await client.pages.retrieve({ page_id: pageId })) as unknown as Record<string, unknown>;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "object_not_found" || code === "validation_error") return null;
    throw err;
  }
}

/** 案件ページだけ（物件は読まない）。見つからなければ null。読めなければ例外 */
export async function readSateiDealPageReal(
  dealId: string,
  client: Client = crmNotion,
): Promise<SateiDeal | null> {
  const page = await retrieve(client, dealId);
  return page ? readSateiDealPage(page) : null;
}

/** 案件ページと物件の1件目の種別。案件ページが無ければ null。物件が読めない・無ければ kind は null */
export async function readSateiDealReal(
  dealId: string,
  client: Client = crmNotion,
): Promise<{ deal: SateiDeal; kind: string | null } | null> {
  const deal = await readSateiDealPageReal(dealId, client);
  if (!deal) return null;
  const propertyId = deal.propertyIds[0];
  const prop = propertyId ? await retrieve(client, propertyId) : null;
  const kind = prop && !prop.archived && !prop.in_trash ? readPropertyKind(prop) : null;
  return { deal, kind };
}

function portalOpts(): SateiPortalOpts | null {
  const c = sateiPortalConfig();
  return c ? { fetchImpl: fetch, baseUrl: c.baseUrl, token: c.token, timeoutMs: SATEI_PORTAL_TIMEOUT_MS } : null;
}

async function withPortal<T>(run: (o: SateiPortalOpts) => Promise<SateiCall<T>>): Promise<SateiCall<T>> {
  const o = portalOpts();
  if (!o) {
    log("[satei] config-missing portal");
    return { kind: "rejected", status: 0, code: "CONFIG" };
  }
  return run(o);
}

export function sateiActionDeps(): SateiActionDeps {
  return {
    dealsDbId: process.env.CRM_DEALS_DB_ID || null,
    readDeal: (dealId) => readSateiDealReal(dealId),
    intake: (req) => withPortal((o) => sateiIntake(req, o)),
    decide: (no, req) => withPortal((o) => sateiDecide(no, req, o)),
    kv: defaultDealKv(),
    newToken: () => randomUUID(),
    reserve: reserveEvent,
    complete: completeEvent,
    reply: (token, text) => replyTextAndCard(token, text),
    log,
  };
}

/**
 * 理由の印の KV（URL と TOKEN の両方があるときだけ）。delIfToken は Upstash の EVAL（Lua）で
 * 「GET して token を含めば DEL」を1回で行う。token は UUID なので、値が JSON で保存されていても部分一致で確かめられる
 * （@vercel/kv が文字列の引数を引用符つきで送っても `"uuid"` は保存した JSON の中にそのまま現れる）。
 */
const DEL_IF_TOKEN_LUA =
  'local v = redis.call("GET", KEYS[1]) if v and string.find(v, ARGV[1], 1, true) then return redis.call("DEL", KEYS[1]) end return 0';

export function sateiReasonKv(): SateiReasonKv | null {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  return {
    get: (key) => kv.get(key),
    delIfToken: async (key, token) => Number(await kv.eval(DEL_IF_TOKEN_LUA, [key], [token])) === 1,
  };
}

export function sateiReasonDeps(): SateiReasonDeps {
  return {
    kv: sateiReasonKv(),
    reason: (no, text) => withPortal((o) => sateiReason(no, text, o)),
    reply: (token, text) => sendLineMessage(token, text),
    log,
  };
}

export function sateiNotifyDeps(): SateiNotifyDeps {
  return {
    env: process.env,
    push: (to, messages, retryKey) => pushMessagesWithRetryKey(to, messages, retryKey),
    log,
  };
}

export function sateiFolderCheckDeps(): FolderCheckDeps {
  return { env: process.env, readDealPage: (dealId) => readSateiDealPageReal(dealId), log };
}
