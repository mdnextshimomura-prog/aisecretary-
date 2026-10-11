/**
 * クラウド配達の見回りの入口の判定（設計 2026-10-11 の C1・C14・C16、約束の「K4 の見回り」）。
 * 順番：合言葉 → スイッチ → 共通の設定 →（ここで初めて KV・portal・LINE の実物を組む）→ 見回り。
 * スイッチが off・設定が足りない回は、外への呼び出しを1回もしない。
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { pushLineMessageWithId } from "../line";
import type { ObiEnv } from "./config";
import {
  cloudFixGuideOn,
  cloudSwitchOn,
  loadCloudCompletionConfig,
  loadCloudSharedConfig,
  type CloudSharedConfig,
} from "./cloud-config";
import { createCloudPortal } from "./cloud-portal";
import { getCloudStore } from "./cloud-store";
import { CloudHalt, runCloudTick, type CloudCheckpoint, type CloudDeps } from "./cloud-tick";

/** 見回りの入口の合言葉を入れるヘッダ */
export const TICK_TOKEN_HEADER = "x-obi-tick-token";
/** 合言葉を導くときの文（版つき。変えるときは、呼ぶ側＝portal と同じ変更で） */
export const TICK_TOKEN_CONTEXT = "obi-cloud-tick.v1";
/** これより短い JOB_API_TOKEN からは導かない（誰も通さない） */
export const TICK_KEY_MIN_LENGTH = 32;

/**
 * 見回りの入口の合言葉：HMAC-SHA256(鍵 = JOB_API_TOKEN の UTF-8, 文 = "obi-cloud-tick.v1") の小文字16進64桁。
 * 呼ぶのは portal（worker が毎分、web を経由してたたく）。portal と aisecretary が既に持っている JOB_API_TOKEN から
 * 両方が同じ値を導く（新しい環境変数は足さない。JOB_API_TOKEN そのものは、この入口へは送らない）。
 */
export function tickTokenFor(jobApiToken: string): string {
  return createHmac("sha256", Buffer.from(jobApiToken, "utf8")).update(TICK_TOKEN_CONTEXT, "utf8").digest("hex");
}

/**
 * 合言葉の確認。JOB_API_TOKEN が無い・32字未満なら誰も通さない。
 * 長さの違いで例外にならないよう、両方の sha256 を取ってから時間の一定な比べ方で比べる。
 */
export function tickAuthorized(header: string | null, jobApiToken: string | undefined): boolean {
  if (typeof jobApiToken !== "string" || jobApiToken.length < TICK_KEY_MIN_LENGTH) return false;
  if (typeof header !== "string") return false;
  const a = createHash("sha256").update(header, "utf8").digest();
  const b = createHash("sha256").update(tickTokenFor(jobApiToken), "utf8").digest();
  return timingSafeEqual(a, b);
}

const CHECKPOINTS: ReadonlySet<string> = new Set<CloudCheckpoint>([
  "completion-claimed",
  "completion-prepared",
  "completion-attempt-requested",
  "completion-attempting",
  "completion-pushed",
  "completion-sent-saved",
  "completion-before-result",
  "notice-claimed",
  "notice-attempting",
  "notice-pushed",
]);

/** 途中で止める試験の仕掛け（OBI_CLOUD_HALT_AT）。本番（VERCEL_ENV が production）では効かない */
export function buildCheckpoint(env: ObiEnv): (point: CloudCheckpoint) => void {
  const at = env.OBI_CLOUD_HALT_AT ?? "";
  if (env.VERCEL_ENV === "production" || !CHECKPOINTS.has(at)) return () => {};
  return (point) => {
    if (point === at) throw new CloudHalt(point);
  };
}

const tickLog = (line: string): void => console.log(`cloud-tick ${line}`);

// 「種まきが済んでいる」と portal に確かめたことの覚え（この関数のインスタンスの中だけ。消えても、portal に聞き直すだけ）
const seedMemo = { confirmed: false };

/** 実物の部品を組む。スイッチが on で、共通の設定がそろっているときだけ呼ばれる */
export function realCloudDeps(shared: CloudSharedConfig, env: ObiEnv): CloudDeps {
  return {
    now: Date.now,
    portal: createCloudPortal({ fetchImpl: fetch, baseUrl: shared.portalBaseUrl, token: shared.jobApiToken }),
    // 実物の KV の包み（sadd・srem・smembers。SCAN は使わない）は cloud-store.ts にある
    store: getCloudStore(),
    push: (text) => pushLineMessageWithId(shared.groupId, text),
    log: tickLog,
    checkpoint: buildCheckpoint(env),
    seedMemo,
  };
}

export interface CloudTickResponse {
  status: number;
  body: Record<string, unknown>;
}

export async function handleCloudTick(
  /** ヘッダ x-obi-tick-token の値（無ければ null） */
  tickToken: string | null,
  env: ObiEnv = process.env,
  makeDeps: (shared: CloudSharedConfig, env: ObiEnv) => CloudDeps = realCloudDeps,
  now: () => number = Date.now
): Promise<CloudTickResponse> {
  const startedAt = now();
  if (!tickAuthorized(tickToken, env.JOB_API_TOKEN)) return { status: 401, body: { error: "Unauthorized" } };
  if (!cloudSwitchOn(env)) return { status: 200, body: { skipped: "off" } };
  const shared = loadCloudSharedConfig(env);
  if (!shared.ok) {
    tickLog(`config-missing ${shared.problems.join(",")}`);
    return { status: 200, body: { skipped: "config", problems: shared.problems } };
  }
  try {
    const body = await runCloudTick({
      deps: makeDeps(shared.config, env),
      shared: shared.config,
      completion: loadCloudCompletionConfig(env),
      fixGuide: cloudFixGuideOn(env),
      startedAt,
    });
    return { status: 200, body: { ...body } };
  } catch (err) {
    // 例外の文は出さない（中に URL・ID が入りうる）。名前だけ（名前の形でないものは Error と書く）
    const name = (err as { name?: unknown } | null)?.name;
    tickLog(`error ${typeof name === "string" && /^[A-Za-z]{1,40}$/.test(name) ? name : "Error"}`);
    return { status: 500, body: { error: "internal" } };
  }
}
