/**
 * 帯替えのクラウド配達（毎分の見回り）の、スイッチと設定の確認
 * （設計 2026-10-11 の C14・約束 2026-10-11-obi-cloud-contract.md の「K4 の見回り」）。
 * 値はログ・応答に出さない（出すのは「どの名前がだめか」だけ）。
 */
import type { KeyObject } from "node:crypto";
import { loadObiConfig, type ObiEnv } from "./config";
import { loadSigningKey } from "./cloud-dtoken";

/** スイッチ。厳密に "1" のときだけ on（既定 off） */
export const cloudSwitchOn = (env: ObiEnv = process.env): boolean => env.OBI_CLOUD_DELIVERY === "1";
/** 完成の知らせの末尾に番号の案内を付けるか。Mac の JOB_FIX_GUIDE と同じ値にそろえる */
export const cloudFixGuideOn = (env: ObiEnv = process.env): boolean => env.OBI_CLOUD_FIX_GUIDE === "1";

export interface CloudSharedConfig {
  groupId: string;
  portalBaseUrl: string; // 末尾の / は除いてある
  jobApiToken: string;
}
export type CloudSharedResult = { ok: true; config: CloudSharedConfig } | { ok: false; problems: string[] };

// 見回りは「誰が頼めるか」を使わない。loadObiConfig の検査（PORTAL_BASE_URL・JOB_API_TOKEN・LINE_GROUP_ID）を
// そのまま使うために、形の正しい仮の値を入れて呼ぶ（config.ts を変えずに「今の loadObiConfig と同じ」検査にする）
const PLACEHOLDER_ALLOWED = "U" + "0".repeat(32);

export function loadCloudSharedConfig(env: ObiEnv = process.env): CloudSharedResult {
  const loaded = loadObiConfig({ ...env, JOB_ALLOWED_USER_IDS: PLACEHOLDER_ALLOWED });
  const problems: string[] = loaded.ok ? [] : [...loaded.problems];
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) problems.push("LINE_CHANNEL_ACCESS_TOKEN");
  // KV が無いと、錠・控え・待ち時間が関数の外へ残らない（毎分、同じ依頼を取り直しうる）。見回りは動かさない
  if (!env.KV_REST_API_URL) problems.push("KV_REST_API_URL");
  if (!env.KV_REST_API_TOKEN) problems.push("KV_REST_API_TOKEN");
  if (!loaded.ok || problems.length > 0) return { ok: false, problems };
  const { groupId, portalBaseUrl, jobApiToken } = loaded.config;
  return { ok: true, config: { groupId, portalBaseUrl, jobApiToken } };
}

export interface CloudCompletionConfig {
  signingKey: KeyObject;
  kid: string;
  liffId: string;
}
export type CloudCompletionResult =
  | { ok: true; config: CloudCompletionConfig }
  | { ok: false; problems: string[] };

export const CLOUD_KID_RE = /^cloud-[0-9]{4}-[0-9]{2}$/;
const LIFF_ID_RE = /^[0-9]{6,20}-[A-Za-z0-9]{4,20}$/;

/** 完成の配達だけに要る3つ。欠けていても、種まき・知らせ・控えの片付けは進める */
export function loadCloudCompletionConfig(env: ObiEnv = process.env): CloudCompletionResult {
  const problems: string[] = [];
  const signingKey = loadSigningKey(env.OBI_CLOUD_SIGNING_KEY);
  if (!signingKey) problems.push("OBI_CLOUD_SIGNING_KEY");
  const kid = env.OBI_CLOUD_KID ?? "";
  if (!CLOUD_KID_RE.test(kid)) problems.push("OBI_CLOUD_KID");
  const liffId = env.OBI_CLOUD_LIFF_ID ?? "";
  if (!LIFF_ID_RE.test(liffId)) problems.push("OBI_CLOUD_LIFF_ID");
  if (!signingKey || problems.length > 0) return { ok: false, problems };
  return { ok: true, config: { signingKey, kid, liffId } };
}
