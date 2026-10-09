/**
 * グループからの帯替えの入口の確認（設計 2026-10-09 の 6）。
 *
 * 「どこから・誰から」を固定し、合わなければ何もしない（fail closed）。
 *   - 営業部のグループ（LINE_GROUP_ID）からだけ
 *   - 発言者が JOB_ALLOWED_USER_IDS のどれかと完全一致
 *   - LINE_GROUP_ID が欠ける・形が違うなら、営業部がどこか分からないので帯替えの機能は何もしない
 *     （どのグループでも返事も控えもしない。今までの流れのまま）
 *   - LINE_GROUP_ID は正しく、ほかの設定（JOB_ALLOWED_USER_IDS・PORTAL_BASE_URL・JOB_API_TOKEN）が
 *     欠ける・形が違うなら、営業部の依頼の形の発言にだけ「止めています」と返す（控えもしない）
 * 値はログに出さない（出すのは「どの項目がだめか」だけ）。
 */
import { parseJobCommand } from "./parse";

const USER_ID_RE = /^U[0-9a-f]{32}$/;
const GROUP_ID_RE = /^C[0-9a-f]{32}$/;

export interface ObiConfig {
  groupId: string;
  allowedUserIds: string[];
  portalBaseUrl: string; // 末尾の / は除いてある
  jobApiToken: string;
}

export type ObiEnv = Record<string, string | undefined>;

export type ObiConfigResult =
  | { ok: true; config: ObiConfig }
  | {
      ok: false;
      /** LINE_GROUP_ID だけは正しい場合の値（他のグループの発言を「止めています」にしないため） */
      groupId: string | null;
      problems: string[];
    };

function parsePortalBaseUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  if (u.search || u.hash || u.username || u.password) return null;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

export function loadObiConfig(env: ObiEnv = process.env): ObiConfigResult {
  const problems: string[] = [];

  const groupId = env.LINE_GROUP_ID ?? "";
  const groupOk = GROUP_ID_RE.test(groupId);
  if (!groupOk) problems.push("LINE_GROUP_ID");

  const allowedUserIds = (env.JOB_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedUserIds.length === 0 || !allowedUserIds.every((id) => USER_ID_RE.test(id))) {
    problems.push("JOB_ALLOWED_USER_IDS");
  }

  const portalBaseUrl = parsePortalBaseUrl(env.PORTAL_BASE_URL);
  if (!portalBaseUrl) problems.push("PORTAL_BASE_URL");

  const jobApiToken = env.JOB_API_TOKEN ?? "";
  // 前後の空白・改行が混ざった値は直さずに止める（勝手に削ると、違う鍵で通ってしまう事故に気づけない）
  if (!jobApiToken || /\s/.test(jobApiToken)) problems.push("JOB_API_TOKEN");

  if (problems.length > 0) {
    return { ok: false, groupId: groupOk ? groupId : null, problems };
  }
  return {
    ok: true,
    config: { groupId, allowedUserIds, portalBaseUrl: portalBaseUrl!, jobApiToken },
  };
}

export type ObiEntry =
  | { kind: "not-obi" }
  | { kind: "stopped"; groupId: string }
  | { kind: "forbidden"; groupId: string }
  | {
      kind: "request";
      config: ObiConfig;
      property: string;
      /** 「担当:」は読むが portal には渡さない（約束：intake は assigneeName を受け付けない） */
      assigneeName: string;
    };

export interface ObiEntryInput {
  sourceType: string | undefined;
  groupId: string | undefined;
  userId: string | undefined;
  /** @MD NEXT秘書 へのメンションがあるか */
  mentionsBot: boolean;
  /** メンションを除いた本文 */
  text: string;
}

/**
 * 帯替えの依頼かどうかの判定（設計 6・7・8）。
 *
 * 帯替えとして扱うのは「@MD NEXT秘書 へのメンションがあり、本文の先頭が依頼語」のときだけ。
 * それ以外・個別トーク・他のグループは not-obi（今までどおりの流れへ）。
 */
export function classifyObiEntry(input: ObiEntryInput, env: ObiEnv = process.env): ObiEntry {
  if (!input.mentionsBot) return { kind: "not-obi" };
  const cmd = parseJobCommand(input.text);
  if (!cmd || cmd.action !== "request" || cmd.workflow !== "obi") return { kind: "not-obi" };
  if (input.sourceType !== "group" || !input.groupId) return { kind: "not-obi" };

  const loaded = loadObiConfig(env);
  if (!loaded.ok) {
    // LINE_GROUP_ID が無い・形が違う：どのグループが営業部か分からない。
    // どのグループでも帯替えとして扱わない（返事も控えもしない。今までの流れのまま）
    if (!loaded.groupId) return { kind: "not-obi" };
    // 営業部の ID は分かっていて、それと違うグループなら、帯替えとして扱わない
    if (loaded.groupId !== input.groupId) return { kind: "not-obi" };
    console.error("帯替えの受付を止めています（設定の不足・不正）:", loaded.problems.join(","));
    return { kind: "stopped", groupId: input.groupId };
  }
  const { config } = loaded;
  if (input.groupId !== config.groupId) return { kind: "not-obi" };
  if (!input.userId || !config.allowedUserIds.includes(input.userId)) {
    return { kind: "forbidden", groupId: input.groupId };
  }
  return { kind: "request", config, property: cmd.property, assigneeName: cmd.assigneeName };
}

/** 帯替え用の PDF の控えに足すファイルか（営業部のグループ・設定が揃っている・.pdf） */
export function shouldRecordObiPdf(
  input: { sourceType: string | undefined; groupId: string | undefined; fileName: string },
  env: ObiEnv = process.env
): boolean {
  if (input.sourceType !== "group" || !input.groupId) return false;
  if (!/\.pdf$/i.test(String(input.fileName ?? "").trim())) return false;
  const loaded = loadObiConfig(env);
  return loaded.ok && loaded.config.groupId === input.groupId;
}
