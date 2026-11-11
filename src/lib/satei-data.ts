/**
 * B2 査定書の下書き（2026-11-11）：スイッチ・押せる人・通知先・postback の data。
 * 契約 docs/superpowers/specs/2026-11-11-b2-satei-contract.md 第3節。
 * - TASK_SATEI=1 のときだけ動く（既定 off）。押せるのは TASK_SATEI_USER_IDS の人だけ（先頭が通知先＝下村さん）。
 * - data：案件カード `v1|sa|<dealId>`、個人カード `v1|so|<no>|<generation>|<sha256>`・`v1|sr|…`。
 */
import { PAGE_ID_RE } from "./task-buttons";
import { parseAllowedUserIds } from "./webhook-source";

export type SateiEnv = Record<string, string | undefined>;

const USER_ID_RE = /^U[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const JOB_NO_RE = /^[1-9][0-9]{0,8}$/;
const GENERATION_RE = /^[1-9][0-9]{0,5}$/;
const DATA_MAX = 300;

export function sateiActive(env: SateiEnv = process.env): boolean {
  return env.TASK_SATEI === "1";
}

export function sateiUserIds(env: SateiEnv = process.env): string[] {
  return parseAllowedUserIds(env.TASK_SATEI_USER_IDS).filter((id) => USER_ID_RE.test(id));
}

export function isSateiUser(userId: string | null | undefined, env: SateiEnv = process.env): boolean {
  return typeof userId === "string" && sateiUserIds(env).includes(userId);
}

/** 個人あての通知先（TASK_SATEI_USER_IDS の先頭）。無ければ null */
export function sateiNotifyTarget(env: SateiEnv = process.env): string | null {
  return sateiUserIds(env)[0] ?? null;
}

export type SateiDecisionOp = "so" | "sr";
export type SateiAction =
  | { op: "sa"; dealId: string }
  | { op: SateiDecisionOp; no: number; generation: number; sha256: string };

export function encodeSateiStart(dealId: string): string {
  return `v1|sa|${dealId}`;
}

export function encodeSateiDecision(
  op: SateiDecisionOp,
  no: number,
  generation: number,
  sha256: string,
): string {
  return ["v1", op, String(no), String(generation), sha256].join("|");
}

/** satei のボタンの data を読む。形が違えば null（ほかのボタンの data は読まない） */
export function parseSateiData(data: string): SateiAction | null {
  if (!data || data.length > DATA_MAX) return null;
  const parts = data.split("|");
  if (parts[0] !== "v1") return null;
  if (parts[1] === "sa") {
    return parts.length === 3 && PAGE_ID_RE.test(parts[2]) ? { op: "sa", dealId: parts[2] } : null;
  }
  if ((parts[1] !== "so" && parts[1] !== "sr") || parts.length !== 5) return null;
  const [, op, no, generation, sha256] = parts;
  if (!JOB_NO_RE.test(no) || !GENERATION_RE.test(generation) || !SHA256_RE.test(sha256)) return null;
  return { op: op as SateiDecisionOp, no: Number(no), generation: Number(generation), sha256 };
}

/** ［差し戻し］のあと、次の1対1の文字を理由として受ける印（値は `{ no, token }`。token は UUID） */
export const sateiReasonKey = (userId: string): string => `satei:reason:${userId}`;
export const SATEI_REASON_TTL = 30 * 60;
export const SATEI_REASON_MAX = 200;
