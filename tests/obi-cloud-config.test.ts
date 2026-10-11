/**
 * クラウド配達のスイッチと設定の確認（約束 2026-10-11-obi-cloud-contract.md の「K4 の見回り」）。
 * 値はテスト用（本物の鍵・ID ではない）。
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { loadObiConfig, type ObiEnv } from "../src/lib/obi/config";
import {
  cloudFixGuideOn,
  cloudSwitchOn,
  loadCloudCompletionConfig,
  loadCloudSharedConfig,
} from "../src/lib/obi/cloud-config";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name}`);
};

const seed = createHash("sha256")
  .update("obi-cloud-config test key (not a secret)")
  .digest();
const testKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]),
  format: "der",
  type: "pkcs8",
});
const PRIV_PEM = testKey.export({ type: "pkcs8", format: "pem" }) as string;
const PUB_PEM = createPublicKey(testKey).export({
  type: "spki",
  format: "pem",
}) as string;

const G = "C" + "a".repeat(32);
const SHARED: ObiEnv = {
  PORTAL_BASE_URL: "https://portal.example.test/",
  JOB_API_TOKEN: "job-token-value-xyz",
  LINE_GROUP_ID: G,
  LINE_CHANNEL_ACCESS_TOKEN: "line-token-value-xyz",
  KV_REST_API_URL: "https://kv.example.test",
  KV_REST_API_TOKEN: "kv-token-value-xyz",
};
const COMPLETION: ObiEnv = {
  OBI_CLOUD_SIGNING_KEY: PRIV_PEM,
  OBI_CLOUD_KID: "cloud-2026-10",
  OBI_CLOUD_LIFF_ID: "1234567890-AbCdEfGh",
};
const noValues = (result: unknown, env: ObiEnv): boolean => {
  const s = JSON.stringify(result);
  return Object.values(env).every((v) => !v || !s.includes(v));
};

function main() {
  // スイッチ
  ok(
    'スイッチ："1" だけ on',
    cloudSwitchOn({ OBI_CLOUD_DELIVERY: "1" }) === true,
  );
  for (const v of [undefined, "", "0", "true", "1 ", " 1", "on"]) {
    ok(
      `スイッチ：${JSON.stringify(v)} は off`,
      cloudSwitchOn({ OBI_CLOUD_DELIVERY: v }) === false,
    );
  }
  ok(
    '番号の案内："1" だけ on',
    cloudFixGuideOn({ OBI_CLOUD_FIX_GUIDE: "1" }) === true,
  );
  for (const v of [undefined, "", "0", "true", "1 "]) {
    ok(
      `番号の案内：${JSON.stringify(v)} は off`,
      cloudFixGuideOn({ OBI_CLOUD_FIX_GUIDE: v }) === false,
    );
  }

  // 共通
  let r = loadCloudSharedConfig(SHARED);
  ok(
    "共通：そろえば ok（末尾の / を除く）",
    r.ok &&
      r.config.portalBaseUrl === "https://portal.example.test" &&
      r.config.groupId === G &&
      r.config.jobApiToken === "job-token-value-xyz",
    JSON.stringify(r),
  );
  ok(
    "共通：config の項目は3つだけ",
    r.ok &&
      Object.keys(r.config).sort().join() ===
        "groupId,jobApiToken,portalBaseUrl",
  );
  ok(
    "共通：JOB_ALLOWED_USER_IDS が無くても ok",
    !("JOB_ALLOWED_USER_IDS" in SHARED) && r.ok,
  );
  for (const name of Object.keys(SHARED)) {
    for (const [label, v] of [
      ["欠ける", undefined],
      ["空", ""],
    ] as const) {
      r = loadCloudSharedConfig({ ...SHARED, [name]: v });
      ok(
        `共通：${name} が${label} → その名前だけ`,
        !r.ok && r.problems.join() === name,
        JSON.stringify(r),
      );
      ok(`共通：${name} が${label} → 値が入らない`, noValues(r, SHARED));
    }
  }
  r = loadCloudSharedConfig({});
  ok(
    "共通：全部無い → 6つの名前",
    !r.ok &&
      [...r.problems].sort().join() === Object.keys(SHARED).sort().join(),
    JSON.stringify(r),
  );
  ok(
    "共通：problems に JOB_ALLOWED_USER_IDS は出ない",
    !r.ok && !r.problems.includes("JOB_ALLOWED_USER_IDS"),
  );

  // 形の検査が loadObiConfig と同じ
  const THREE = ["PORTAL_BASE_URL", "JOB_API_TOKEN", "LINE_GROUP_ID"];
  const table: Array<[string, ObiEnv]> = [
    [
      "PORTAL_BASE_URL が http://",
      { PORTAL_BASE_URL: "http://portal.example.test" },
    ],
    [
      "PORTAL_BASE_URL が http://localhost",
      { PORTAL_BASE_URL: "http://localhost:3000" },
    ],
    [
      "PORTAL_BASE_URL が末尾 ?",
      { PORTAL_BASE_URL: "https://portal.example.test?" },
    ],
    [
      "PORTAL_BASE_URL が空白入り",
      { PORTAL_BASE_URL: "https://portal.example.test " },
    ],
    ["JOB_API_TOKEN に改行", { JOB_API_TOKEN: "abc\n" }],
    ["LINE_GROUP_ID が大文字の16進", { LINE_GROUP_ID: "C" + "A".repeat(32) }],
    ["LINE_GROUP_ID が31桁", { LINE_GROUP_ID: "C" + "a".repeat(31) }],
    ["そのまま", {}],
  ];
  for (const [label, over] of table) {
    const env = { ...SHARED, ...over };
    const a = loadObiConfig({
      ...env,
      JOB_ALLOWED_USER_IDS: "U" + "1".repeat(32),
    });
    const b = loadCloudSharedConfig(env);
    const pa = (a.ok ? [] : a.problems)
      .filter((p) => THREE.includes(p))
      .sort()
      .join();
    const pb = (b.ok ? [] : b.problems)
      .filter((p) => THREE.includes(p))
      .sort()
      .join();
    ok(
      `形の検査が loadObiConfig と同じ：${label}`,
      pa === pb && a.ok === b.ok,
      `${pa} / ${pb}`,
    );
    ok(`形の検査：${label} → 値が入らない`, b.ok || noValues(b, env));
  }

  // 完成
  let c = loadCloudCompletionConfig(COMPLETION);
  ok(
    "完成：そろえば ok",
    c.ok &&
      c.config.kid === "cloud-2026-10" &&
      c.config.liffId === "1234567890-AbCdEfGh" &&
      c.config.signingKey.asymmetricKeyType === "ed25519",
  );
  c = loadCloudCompletionConfig({
    ...COMPLETION,
    OBI_CLOUD_SIGNING_KEY: PRIV_PEM.trim().replace(/\n/g, "\\n"),
  });
  ok("完成：鍵は改行が \\n の1行でも読める", c.ok);
  const rsa = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  for (const [label, v] of [
    ["無い", undefined],
    ["空", ""],
    ["PEM でない", "not-a-pem"],
    ["RSA", rsa],
    ["公開鍵", PUB_PEM],
  ] as const) {
    const env = { ...COMPLETION, OBI_CLOUD_SIGNING_KEY: v };
    c = loadCloudCompletionConfig(env);
    ok(
      `完成：鍵が${label} → OBI_CLOUD_SIGNING_KEY`,
      !c.ok && c.problems.join() === "OBI_CLOUD_SIGNING_KEY",
      JSON.stringify(c.ok ? "" : c.problems),
    );
    ok(
      `完成：鍵が${label} → 値が入らない`,
      noValues(c.ok ? {} : c, env) &&
        !JSON.stringify(c.ok ? {} : c).includes("BEGIN"),
    );
  }
  ok("完成：kid cloud-2026-10 は可", loadCloudCompletionConfig(COMPLETION).ok);
  for (const v of [
    "cloud-26-10",
    "mac-2026-10",
    "cloud-2026-10 ",
    "",
    undefined,
  ]) {
    c = loadCloudCompletionConfig({ ...COMPLETION, OBI_CLOUD_KID: v });
    ok(
      `完成：kid ${JSON.stringify(v)} は不可`,
      !c.ok && c.problems.join() === "OBI_CLOUD_KID",
    );
  }
  for (const v of [
    "1234567890",
    "12345-AbCd",
    "1234567890-Ab_d",
    "",
    undefined,
  ]) {
    c = loadCloudCompletionConfig({ ...COMPLETION, OBI_CLOUD_LIFF_ID: v });
    ok(
      `完成：LIFF の ID ${JSON.stringify(v)} は不可`,
      !c.ok && c.problems.join() === "OBI_CLOUD_LIFF_ID",
    );
    ok(
      `完成：LIFF の ID ${JSON.stringify(v)} → 値が入らない`,
      !c.ok && (!v || !JSON.stringify(c).includes(v)),
    );
  }
  c = loadCloudCompletionConfig({});
  ok(
    "完成：全部無い → 3つの名前",
    !c.ok &&
      c.problems.join() ===
        "OBI_CLOUD_SIGNING_KEY,OBI_CLOUD_KID,OBI_CLOUD_LIFF_ID",
    JSON.stringify(c.ok ? "" : c.problems),
  );

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
