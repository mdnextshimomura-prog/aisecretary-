/**
 * クラウド配達のリンクのトークン（設計 2026-10-11 の C5・C6・約束の「トークン」）。
 * 規約は Mac の line-secretary/src/dtoken.js の issue と同じ：
 *   本文＝payload の JSON（UTF-8）の base64url（詰め文字なし）／署名＝"dtoken.v1." ＋本文 への Ed25519 の署名の base64url。
 * 違うのは中身だけ：f は Drive の id ではなく "portal:job-<no>"、kid はクラウド専用、宛先はグループだけ。
 * 例外の文・戻り値のどちらにも、鍵は入れない。
 */
import { createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";

/** リンクの期限（秒）。クラウドは固定（約束の「共通の値」）。文の「24時間有効」も同じ値から出す */
export const CLOUD_TOKEN_TTL_SEC = 86_400;

const TOKEN_PREFIX = "dtoken.v1.";
const KID_RE = /^cloud-[0-9]{4}-[0-9]{2}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const GROUP_ID_RE = /^C[0-9a-f]{32}$/;
const JTI_RE = /^[0-9a-f]{16}$/;

/** OBI_CLOUD_SIGNING_KEY を読む。PEM の改行は "\n" と書いてあってもよい。Ed25519 の秘密鍵でなければ null */
export function loadSigningKey(raw: string | undefined): KeyObject | null {
  if (!raw) return null;
  try {
    const key = createPrivateKey({ key: raw.replace(/\\n/g, "\n"), format: "pem" });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

export interface CloudTokenInput {
  /** 受付番号（1〜999,999,999） */
  no: number;
  /** 予約の応答の artifactSha256 */
  sha256: string;
  /** LINE_GROUP_ID */
  groupId: string;
  kid: string;
  key: KeyObject;
  nowMs: number;
  /** テスト用。省けば乱数8バイトの小文字16進 */
  randomJti?: () => string;
}

export function issueCloudToken(a: CloudTokenInput): { token: string; jti: string; exp: number } {
  if (!Number.isSafeInteger(a.no) || a.no < 1 || a.no > 999_999_999) throw new Error("受付番号の形が違います");
  if (!SHA256_RE.test(a.sha256)) throw new Error("sha256 の形が違います");
  if (!GROUP_ID_RE.test(a.groupId)) throw new Error("groupId の形が違います");
  if (!KID_RE.test(a.kid)) throw new Error("kid の形が違います");
  const jti = (a.randomJti ?? (() => randomBytes(8).toString("hex")))();
  if (!JTI_RE.test(jti)) throw new Error("jti の形が違います");
  const i = Math.floor(a.nowMs / 1000);
  const s = `job-${a.no}`;
  // 項目は約束の10個・この順（JSON.stringify は書いた順に出す。順番が変わると、Mac と同じバイトにならない）
  const payload = {
    v: 1,
    kid: a.kid,
    jti,
    s,
    f: `portal:${s}`,
    h: a.sha256,
    i,
    e: i + CLOUD_TOKEN_TTL_SEC,
    aud: "line-group",
    g: a.groupId,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = sign(null, Buffer.from(TOKEN_PREFIX + body, "utf8"), a.key).toString("base64url");
  return { token: `${body}.${sig}`, jti, exp: payload.e };
}

export const cloudLink = (liffId: string, token: string): string => `https://liff.line.me/${liffId}?t=${token}`;
