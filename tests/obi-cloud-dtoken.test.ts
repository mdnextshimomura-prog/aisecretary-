/**
 * クラウド配達のリンクのトークン（約束 2026-10-11-obi-cloud-contract.md の「トークン」）。
 * Mac の src/dtoken.js の issue とバイト単位で同じになること・閲覧ページの verify を通ることを、
 * 写し（tests/fixtures/dtoken-mac.cjs・dtoken-viewer.cjs）と固定のベクタで確かめる。
 * 鍵はテスト専用（種の文から組み立てる。PEM の秘密鍵はリポジトリに置かない）。
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CLOUD_TOKEN_TTL_SEC,
  cloudLink,
  issueCloudToken,
  loadSigningKey,
} from "../src/lib/obi/cloud-dtoken";

// 写し（CommonJS）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mac = require(path.join(__dirname, "fixtures", "dtoken-mac.cjs"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const viewer = require(path.join(__dirname, "fixtures", "dtoken-viewer.cjs"));
const vec = JSON.parse(
  readFileSync(
    path.join(__dirname, "fixtures", "obi-cloud-dtoken-vector.json"),
    "utf8",
  ),
);

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name}`);
};

// PKCS8 の頭（Ed25519）＋種32バイト
const PKCS8_HEAD = Buffer.from("302e020100300506032b657004220420", "hex");
const seed = createHash("sha256").update(vec.seedText).digest();
const testKey = createPrivateKey({
  key: Buffer.concat([PKCS8_HEAD, seed]),
  format: "der",
  type: "pkcs8",
});
const testPrivPem = testKey.export({ type: "pkcs8", format: "pem" }) as string;
const pubPem = (k: ReturnType<typeof createPrivateKey>) =>
  createPublicKey(k).export({ type: "spki", format: "pem" }) as string;

const base = () => ({
  no: vec.no as number,
  sha256: vec.sha256 as string,
  groupId: vec.groupId as string,
  kid: vec.kid as string,
  key: testKey,
  nowMs: vec.nowMs as number,
  randomJti: () => vec.jti as string,
});
const throws = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (e) {
    return String(e);
  }
};
const sha = (p: string) =>
  createHash("sha256")
    .update(readFileSync(path.join(__dirname, "fixtures", p)))
    .digest("hex");

function main() {
  // 固定のベクタ
  const t = issueCloudToken(base());
  ok("ベクタ：トークンが文字列として同じ", t.token === vec.token);
  const [body, sig] = t.token.split(".");
  ok(
    "ベクタ：本文の JSON が同じ（順番・空白なし）",
    Buffer.from(body, "base64url").toString("utf8") === vec.payloadJson,
  );
  ok("ベクタ：公開鍵が同じ", pubPem(testKey) === vec.publicKeyPem);
  ok(
    "戻りの jti・exp",
    t.jti === vec.jti && t.exp === Math.floor(vec.nowMs / 1000) + 86400,
  );
  ok("期限の定数は 86,400 秒", CLOUD_TOKEN_TTL_SEC === 86_400);

  // Mac と同じ署名対象
  ok("Mac の接頭辞", mac.TOKEN_PREFIX === "dtoken.v1.");
  ok(
    "Mac の _signRaw が同じ署名を出す",
    mac._signRaw(mac.TOKEN_PREFIX, body, testPrivPem) === sig,
  );

  // Mac の issue とバイト単位で同じ
  const fresh = generateKeyPairSync("ed25519").privateKey;
  for (const [label, key] of [
    ["固定の鍵", testKey],
    ["新しい鍵", fresh],
  ] as const) {
    const pem = key.export({ type: "pkcs8", format: "pem" }) as string;
    const m = mac.issue(
      {
        shelfId: `job-${vec.no}`,
        driveFileId: `portal:job-${vec.no}`,
        sha256: vec.sha256,
        ttlSec: 86400,
        now: vec.nowMs,
        aud: "line-group",
        g: vec.groupId,
      },
      { privateKeyPem: pem, kid: vec.kid },
    );
    const mine = issueCloudToken({ ...base(), key, randomJti: () => m.jti });
    ok(
      `Mac の issue と同じトークン（${label}）`,
      typeof m.d === "string" && mine.token === m.d,
    );
  }

  // 閲覧ページの検証（K2 の版：クラウドの鍵は、今までの表とは別の表 cloudPublicKeys で受ける）
  const keys = { [vec.kid]: vec.publicKeyPem };
  const asCloud = (now: number, cloudPublicKeys: Record<string, string> = keys) =>
    viewer.verify(t.token, { publicKeys: {}, cloudPublicKeys, now });
  const v = asCloud(vec.nowMs);
  ok("閲覧ページの verify を通る（クラウドの鍵の表に入れたとき）", v.ok === true, JSON.stringify(v.reason ?? ""));
  ok("閲覧ページがクラウドのリンクと読む（originOf）", v.ok === true && viewer.originOf(v.payload, keys).kind === "cloud");
  const aud = viewer.audienceOf(v.payload);
  ok("閲覧ページがグループあてと読む", aud.kind === "line-group" && aud.g === vec.groupId);
  const asMac = viewer.verify(t.token, { publicKeys: keys, now: vec.nowMs });
  ok("今までの鍵の表に入れると断られる（bad-origin）", asMac.ok === false && asMac.reason === "bad-origin", JSON.stringify(asMac.reason ?? ""));
  ok("今までの表にも入っていて、クラウドの表が空でも断られる", viewer.verify(t.token, { publicKeys: keys, cloudPublicKeys: {}, now: vec.nowMs }).reason === "bad-origin");
  ok("どちらの表にも無ければ unknown-kid", viewer.verify(t.token, { publicKeys: {}, now: vec.nowMs }).reason === "unknown-kid");
  ok("期限の直前は通る", asCloud(vec.nowMs + 86_400_000 - 1000).ok === true);
  ok("期限ちょうどは expired", asCloud(vec.nowMs + 86_400_000).reason === "expired");
  ok("別の鍵の公開鍵では bad-signature", asCloud(vec.nowMs, { [vec.kid]: pubPem(fresh) }).reason === "bad-signature");
  ok("kid が表に無ければ unknown-kid", asCloud(vec.nowMs, { "cloud-9999-99": vec.publicKeyPem }).reason === "unknown-kid");

  // 約束の検査（K2 がクラウドの kid に掛ける検査）
  const p = v.payload as Record<string, unknown>;
  ok(
    "項目は10個・この順",
    Object.keys(p).join() === "v,kid,jti,s,f,h,i,e,aud,g",
  );
  ok(
    "f の形",
    typeof p.f === "string" && /^portal:job-[1-9][0-9]{0,8}$/.test(p.f),
  );
  ok("s は f の後ろ", p.s === String(p.f).slice(7) && p.s === `job-${vec.no}`);
  ok(
    "aud・g・h・v",
    p.aud === "line-group" &&
      p.g === vec.groupId &&
      p.h === vec.sha256 &&
      p.v === 1,
  );
  ok("期限は 86,400 秒", (p.e as number) - (p.i as number) === 86400);
  ok(
    "jti は16桁の小文字16進",
    typeof p.jti === "string" && /^[0-9a-f]{16}$/.test(p.jti),
  );

  // jti の乱数
  const { randomJti: _omit, ...noJti } = base();
  void _omit;
  const a = issueCloudToken(noJti);
  const b = issueCloudToken(noJti);
  ok(
    "randomJti を渡さないと毎回違う jti",
    a.jti !== b.jti &&
      /^[0-9a-f]{16}$/.test(a.jti) &&
      /^[0-9a-f]{16}$/.test(b.jti),
  );

  // 断る入力
  const bad: Array<[string, Partial<ReturnType<typeof base>>]> = [
    ["no が 0", { no: 0 }],
    ["no が負", { no: -1 }],
    ["no が小数", { no: 1.5 }],
    ["no が 1,000,000,000", { no: 1_000_000_000 }],
    ["sha256 が大文字", { sha256: "AB".repeat(32) }],
    ["sha256 が63桁", { sha256: "a".repeat(63) }],
    ["groupId の形違い", { groupId: "U" + "0".repeat(32) }],
    ["kid が cloud- でない", { kid: "mac-2026-10" }],
    ["kid の桁違い", { kid: "cloud-26-10" }],
    ["jti が16桁でない", { randomJti: () => "abc" }],
  ];
  for (const [label, over] of bad) {
    const input = { ...base(), ...over };
    const err = throws(() => issueCloudToken(input));
    ok(`断る：${label}`, err !== null);
    ok(
      `断る：${label}（例外の文に値が入らない）`,
      err !== null &&
        ![input.sha256, input.groupId, input.kid, vec.sha256, vec.groupId].some(
          (s) => err.includes(s),
        ),
      String(err),
    );
  }
  ok(
    "no が 999,999,999 は通る",
    throws(() => issueCloudToken({ ...base(), no: 999_999_999 })) === null,
  );

  // loadSigningKey
  ok(
    "鍵：PEM そのまま",
    loadSigningKey(testPrivPem)?.asymmetricKeyType === "ed25519",
  );
  ok(
    "鍵：改行が \\n の1行",
    loadSigningKey(testPrivPem.trim().replace(/\n/g, "\\n"))
      ?.asymmetricKeyType === "ed25519",
  );
  ok("鍵：末尾に改行あり", loadSigningKey(testPrivPem + "\n") !== null);
  const oneLine = loadSigningKey(testPrivPem.trim().replace(/\n/g, "\\n"));
  ok(
    "鍵：1行の鍵で作ったトークンも同じ",
    oneLine !== null &&
      issueCloudToken({ ...base(), key: oneLine }).token === vec.token,
  );
  ok(
    "鍵：undefined・空は null",
    loadSigningKey(undefined) === null && loadSigningKey("") === null,
  );
  ok(
    "鍵：壊れた PEM は null",
    // 壊れた PEM は、テスト用の鍵の中身を崩して作る（PEM の秘密鍵の字面をリポジトリに置かない）
    loadSigningKey(testPrivPem.replace(/\n[A-Za-z0-9+/=]+\n/, "\nxxxx\n")) ===
      null && loadSigningKey("abc") === null,
  );
  const rsa = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  ok("鍵：RSA の秘密鍵は null", loadSigningKey(rsa) === null);
  ok("鍵：Ed25519 の公開鍵は null", loadSigningKey(vec.publicKeyPem) === null);

  ok(
    "リンク",
    cloudLink("1234567890-AbCdEfGh", "TOKEN") ===
      "https://liff.line.me/1234567890-AbCdEfGh?t=TOKEN",
  );

  // 写しを勝手に直していないこと（元：Mac＝feature/v1 の src/dtoken.js〔5cb9d62 から 7ff13e4 まで同じ〕、閲覧ページ＝K2 の枝 feature/obi-cloud-viewer 9d6c28e の delivery/lib/dtoken.js）
  ok(
    "写し：dtoken-mac.cjs の sha256",
    sha("dtoken-mac.cjs") ===
      "21b39ff87ec607c1cc40a340ee6e7913cb6dea2f13f404cfd293c7048433f600",
  );
  ok(
    "写し：dtoken-viewer.cjs の sha256",
    sha("dtoken-viewer.cjs") ===
      "b1fe57a71878ac063a5c14691d49252cb3f33b800af3ddb89f08cd79e6f09389",
  );

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
