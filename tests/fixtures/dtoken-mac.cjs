// 配布トークン（Mac が署名・Vercel が検証）と、Mac → Vercel の管理メッセージの署名。
// 非対称（Ed25519）：秘密鍵は Mac だけが持つ。Vercel が侵害されても偽造できない（設計書 §6）。
// 形式は docs/superpowers/plans/2026-09-24-authenticated-delivery.md の Global Constraints に固定。
const crypto = require("crypto");

const TOKEN_PREFIX = "dtoken.v1.";
const ADMIN_PREFIX = "dadmin.v1.";
const DEFAULT_TTL_SEC = 86400;
const MAX_TTL_SEC = 90000; // 24h + 1h。これより長い有効期限のトークンは作らないし通さない

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const isHex = (s, n) => typeof s === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
const nonEmpty = (s) => typeof s === "string" && s.length > 0 && s.length <= 200;
// グループあての印（設計書 18）の g の形。LINE の groupId と同じ
const GROUP_ID_RE = /^C[0-9a-f]{32}$/;

function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

function _signRaw(prefix, body, privateKeyPem) {
  return b64u(crypto.sign(null, Buffer.from(prefix + body, "utf8"), privateKeyPem));
}

function _verifyRaw(prefix, body, sigB64u, publicKeyPem) {
  try {
    return crypto.verify(null, Buffer.from(prefix + body, "utf8"), publicKeyPem, Buffer.from(sigB64u, "base64url"));
  } catch {
    return false;
  }
}

// 形（2 つの base64url を "." で繋いだもの）と kid までを見て、署名を確かめ、payload を返す
function open(str, prefix, publicKeys) {
  if (typeof str !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(str)) return { ok: false, reason: "malformed" };
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
  if (!_verifyRaw(prefix, body, sig, pem)) return { ok: false, reason: "bad-signature" };
  return { ok: true, payload };
}

function issue({ shelfId, driveFileId, sha256, ttlSec = DEFAULT_TTL_SEC, now = Date.now(), aud, g }, { privateKeyPem, kid }) {
  if (!nonEmpty(privateKeyPem)) throw new Error("privateKeyPem がありません");
  if (!nonEmpty(kid)) throw new Error("kid がありません");
  if (!nonEmpty(shelfId)) throw new Error("shelfId がありません");
  if (!nonEmpty(driveFileId)) throw new Error("driveFileId がありません");
  if (!isHex(sha256, 64)) throw new Error("sha256 の形が違います");
  const ttl = Number(ttlSec);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("ttlSec の形が違います");
  // 受け側（Vercel）は MAX_TTL_SEC を超えるトークンを通さない。出してから開けないリンクになるより、
  // DELIVERY_TTL_SEC の設定ミスとしてここで止める（docreply は issue-failed として秘書室に出す）
  if (ttl > MAX_TTL_SEC) throw new Error(`ttlSec が長すぎます（上限 ${MAX_TTL_SEC} 秒）`);
  // グループあての印（設計書 18）。aud と g は両方そろえて渡すか、両方渡さないか（null は渡さないのと同じ）。
  // 印の無いトークン（秘書室あて・今まで）は、閲覧ページが名簿も見る
  const marked = aud != null || g != null;
  if (marked && aud !== "line-group") throw new Error("aud の形が違います");
  if (marked && !(typeof g === "string" && GROUP_ID_RE.test(g))) throw new Error("g の形が違います");
  const i = Math.floor(now / 1000);
  const e = i + Math.floor(ttl);
  const jti = crypto.randomBytes(8).toString("hex");
  const payload = { v: 1, kid, jti, s: shelfId, f: driveFileId, h: sha256, i, e };
  if (marked) {
    payload.aud = aud;
    payload.g = g;
  }
  const body = b64u(JSON.stringify(payload));
  return { d: `${body}.${_signRaw(TOKEN_PREFIX, body, privateKeyPem)}`, jti, exp: e };
}

function verify(d, { publicKeys, now = Date.now(), maxTtlSec = MAX_TTL_SEC } = {}) {
  const r = open(d, TOKEN_PREFIX, publicKeys);
  if (!r.ok) return r;
  const p = r.payload;
  if (!isHex(p.jti, 16) || !nonEmpty(p.s) || !nonEmpty(p.f) || !isHex(p.h, 64) ||
      !Number.isInteger(p.i) || !Number.isInteger(p.e) || p.e <= p.i) {
    return { ok: false, reason: "bad-fields" };
  }
  const nowSec = Math.floor(now / 1000);
  if (p.e - p.i > maxTtlSec) return { ok: false, reason: "ttl-too-long" };
  if (p.i > nowSec + 60) return { ok: false, reason: "not-yet-valid" };
  if (p.e <= nowSec) return { ok: false, reason: "expired" };
  return { ok: true, payload: p };
}

function signAdmin({ op, arg = null }, { privateKeyPem, kid, now = Date.now() }) {
  if (!nonEmpty(privateKeyPem)) throw new Error("privateKeyPem がありません");
  if (!nonEmpty(kid)) throw new Error("kid がありません");
  if (!nonEmpty(op)) throw new Error("op がありません");
  const n = crypto.randomBytes(8).toString("hex");
  const body = b64u(JSON.stringify({ v: 1, kid, op, arg, i: Math.floor(now / 1000), n }));
  return { a: `${body}.${_signRaw(ADMIN_PREFIX, body, privateKeyPem)}`, n };
}

function verifyAdmin(a, { publicKeys, now = Date.now(), skewSec = 120 } = {}) {
  const r = open(a, ADMIN_PREFIX, publicKeys);
  if (!r.ok) return r;
  const p = r.payload;
  if (!nonEmpty(p.op) || !isHex(p.n, 16) || !Number.isInteger(p.i)) return { ok: false, reason: "bad-fields" };
  if (Math.abs(Math.floor(now / 1000) - p.i) > skewSec) return { ok: false, reason: "stale" };
  return { ok: true, payload: p };
}

module.exports = {
  issue, verify, signAdmin, verifyAdmin, generateKeyPair,
  _signRaw, _verifyRaw, TOKEN_PREFIX, ADMIN_PREFIX, DEFAULT_TTL_SEC, MAX_TTL_SEC,
};
