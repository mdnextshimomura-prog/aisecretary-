// 配布トークンと管理メッセージの検証。秘密鍵は持たない（署名は Mac 側 src/dtoken.js）。
// グループあての印（aud・g）は 2026-10-09 の設計 18。印の無いトークンは今までどおり
// 文字列の規約は Mac 側と同一：署名対象 = 接頭辞 + base64url(JSON)。互換は test/fixtures/dtoken-vector.json で担保
const crypto = require("crypto");

const TOKEN_PREFIX = "dtoken.v1.";
const ADMIN_PREFIX = "dadmin.v1.";
const MAX_TTL_SEC = 90000;
const AUD_LINE_GROUP = "line-group";
const GROUP_ID = /^C[0-9a-f]{32}$/;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// 宛先の印（設計 18）。aud も g も無い → 今までのトークン（名簿を見る）。
// aud が "line-group" で g が groupId の形 → グループあて（g が閲覧ページのグループと一致するかは gate が見る）。
// 片方だけ・値が違う・形が違う → bad（拒否）
function audienceOf(p) {
  if (!p || typeof p !== "object") return { kind: "bad" };
  if (!has(p, "aud") && !has(p, "g")) return { kind: "roster" };
  if (p.aud === AUD_LINE_GROUP && typeof p.g === "string" && GROUP_ID.test(p.g)) return { kind: "line-group", g: p.g };
  return { kind: "bad" };
}

const isHex = (s, n) => typeof s === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
const nonEmpty = (s) => typeof s === "string" && s.length > 0 && s.length <= 200;

function verifyRaw(prefix, body, sigB64u, publicKeyPem) {
  try {
    return crypto.verify(null, Buffer.from(prefix + body, "utf8"), publicKeyPem, Buffer.from(sigB64u, "base64url"));
  } catch {
    return false;
  }
}

function open(str, prefix, publicKeys) {
  if (typeof str !== "string" || str.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(str)) return { ok: false, reason: "malformed" };
  const [body, sig] = str.split(".");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || typeof payload !== "object" || payload.v !== 1 || !nonEmpty(payload.kid)) return { ok: false, reason: "malformed" };
  const pem = publicKeys && publicKeys[payload.kid];
  if (!pem) return { ok: false, reason: "unknown-kid" };
  if (!verifyRaw(prefix, body, sig, pem)) return { ok: false, reason: "bad-signature" };
  return { ok: true, payload };
}

function verify(d, { publicKeys, now = Date.now(), maxTtlSec = MAX_TTL_SEC } = {}) {
  const r = open(d, TOKEN_PREFIX, publicKeys);
  if (!r.ok) return r;
  const p = r.payload;
  if (!isHex(p.jti, 16) || !nonEmpty(p.s) || !nonEmpty(p.f) || !isHex(p.h, 64) ||
      !Number.isInteger(p.i) || !Number.isInteger(p.e) || p.e <= p.i) {
    return { ok: false, reason: "bad-fields" };
  }
  // 印の形の違いは、期限の判定より先に言う（期限切れの読み直し peek の側でも gate が同じ関数で見る）
  if (audienceOf(p).kind === "bad") return { ok: false, reason: "bad-aud" };
  const nowSec = Math.floor(now / 1000);
  if (p.e - p.i > maxTtlSec) return { ok: false, reason: "ttl-too-long" };
  if (p.i > nowSec + 60) return { ok: false, reason: "not-yet-valid" };
  if (p.e <= nowSec) return { ok: false, reason: "expired" };
  return { ok: true, payload: p };
}

function verifyAdmin(a, { publicKeys, now = Date.now(), skewSec = 120 } = {}) {
  const r = open(a, ADMIN_PREFIX, publicKeys);
  if (!r.ok) return r;
  const p = r.payload;
  if (!nonEmpty(p.op) || !isHex(p.n, 16) || !Number.isInteger(p.i)) return { ok: false, reason: "bad-fields" };
  if (Math.abs(Math.floor(now / 1000) - p.i) > skewSec) return { ok: false, reason: "stale" };
  return { ok: true, payload: p };
}

// 署名と kid だけ確かめて payload を返す（期限は見ない）。
// 期限切れの理由を「本人確認と在籍が通った人にだけ」言うために gate が使う
function peek(d, publicKeys) {
  const r = open(d, TOKEN_PREFIX, publicKeys);
  return r.ok ? r.payload : null;
}

// 環境変数 DELIVERY_PUBLIC_KEYS（1 行 JSON、PEM の改行は \n）→ { kid: pem }
function parsePublicKeys(envValue) {
  try {
    const obj = JSON.parse(envValue || "");
    if (!obj || typeof obj !== "object") return {};
    const out = {};
    for (const [kid, pem] of Object.entries(obj)) {
      if (typeof pem === "string" && pem.includes("BEGIN PUBLIC KEY")) out[kid] = pem.replace(/\\n/g, "\n");
    }
    return out;
  } catch {
    return {};
  }
}

module.exports = { verify, verifyAdmin, peek, parsePublicKeys, audienceOf, TOKEN_PREFIX, ADMIN_PREFIX, MAX_TTL_SEC, AUD_LINE_GROUP };
