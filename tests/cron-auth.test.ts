/**
 * Cron の入口の認証（2026-11-08）と、LINE 署名の比較。
 *
 * - isCronAuthorized：CRON_SECRET が無ければ誰も通さない／違えば拒否／正しければ通す
 * - 4 つの入口（/api/remind・/api/report・/api/remind-due・/api/candidates-ask）を本物のまま呼び、
 *   CRON_SECRET なし・間違い・「Bearer undefined」で 401 になることを確かめる。
 *   正しい値で 401 にならない（＝認証を通って本処理に入る）ことも確かめる。本処理の外への通信は横取りする。
 * - verifyLineSignature：正しい署名は通り、違う・長さ違いは false（例外を投げない）
 */
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { isCronAuthorized } from "../src/lib/cron-auth";
import { timingSafeEqualStr } from "../src/lib/secure-compare";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

// ---- 比較の部品 ----
ok("同じ文字列は true", timingSafeEqualStr("abc", "abc"));
ok("違う文字列は false", !timingSafeEqualStr("abc", "abd"));
ok("長さ違いは false（例外を投げない）", !timingSafeEqualStr("abc", "abcd"));
ok("空どうしは true", timingSafeEqualStr("", ""));
ok("日本語も比べられる", timingSafeEqualStr("秘密", "秘密") && !timingSafeEqualStr("秘密", "秘蜜"));

// ---- isCronAuthorized ----
ok("secret 未設定なら Bearer undefined でも拒否", !isCronAuthorized("Bearer undefined", undefined));
ok("secret 未設定なら Bearer だけでも拒否", !isCronAuthorized("Bearer ", undefined));
ok("secret が空文字なら拒否", !isCronAuthorized("Bearer ", ""));
ok("ヘッダーなしは拒否", !isCronAuthorized(null, "s3cret"));
ok("間違いは拒否", !isCronAuthorized("Bearer wrong", "s3cret"));
ok("Bearer なしの値だけは拒否", !isCronAuthorized("s3cret", "s3cret"));
ok("正しい値は通す", isCronAuthorized("Bearer s3cret", "s3cret"));

// ---- 外への通信を横取り（正しい値で本処理に入ったとき用） ----
let outbound = 0;
globalThis.fetch = (async () => {
  outbound++;
  return new Response("{}", { status: 500 });
}) as typeof fetch;
const block = (() => {
  outbound++;
  throw new Error("テストでは外へつながない");
}) as never;
(http as { request: unknown }).request = block;
(https as { request: unknown }).request = block;
(net as { connect: unknown }).connect = block;
(net as { createConnection: unknown }).createConnection = block;
(tls as { connect: unknown }).connect = block;
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "KV_URL"]) delete process.env[k];

type Route = { GET: (req: never) => Promise<Response> };

(async () => {
  // line.ts は読み込み時に秘密を読む。入口の route が line.ts を読み込むので、それより前に設定する
  process.env.LINE_CHANNEL_SECRET = "line-secret-for-test";
  const { NextRequest } = await import("next/server");
  const call = async (route: Route, path: string, auth?: string) => {
    const headers: Record<string, string> = {};
    if (auth !== undefined) headers.authorization = auth;
    // dry=1：/api/report は送らずに本文だけ返す側へ（万一通っても送信しない）
    // 本処理の中で例外になった＝認証を通ってしまった、を status -1 として返す
    try {
      const res = await route.GET(new NextRequest(`https://example.test${path}?dry=1`, { headers }) as never);
      return { status: res.status };
    } catch {
      return { status: -1 };
    }
  };

  const routes: Array<[string, Route]> = [
    ["/api/remind", (await import("../src/app/api/remind/route")) as unknown as Route],
    ["/api/report", (await import("../src/app/api/report/route")) as unknown as Route],
    ["/api/remind-due", (await import("../src/app/api/remind-due/route")) as unknown as Route],
    ["/api/candidates-ask", (await import("../src/app/api/candidates-ask/route")) as unknown as Route],
  ];

  for (const [path, route] of routes) {
    delete process.env.CRON_SECRET;
    outbound = 0;
    let res = await call(route, path, "Bearer undefined");
    ok(`${path} CRON_SECRET なし＋「Bearer undefined」→ 401・本処理なし`, res.status === 401 && outbound === 0, `status=${res.status}`);
    res = await call(route, path);
    ok(`${path} CRON_SECRET なし＋ヘッダーなし → 401`, res.status === 401);

    process.env.CRON_SECRET = "s3cret-for-test";
    outbound = 0;
    res = await call(route, path, "Bearer wrong");
    ok(`${path} 間違い → 401・本処理なし`, res.status === 401 && outbound === 0, `status=${res.status}`);
    res = await call(route, path, "Bearer s3cret-for-test-longer");
    ok(`${path} 長さ違い → 401`, res.status === 401);

    // 正しい値：認証は通る（本処理は外へつながないので失敗しうるが、401 にはならない）
    const status = (await call(route, path, "Bearer s3cret-for-test")).status;
    ok(`${path} 正しい値 → 認証を通る（401 にならない）`, status !== 401, `status=${status}`);
  }

  // ---- LINE 署名 ----
  const { verifyLineSignature } = await import("../src/lib/line");
  const body = JSON.stringify({ events: [] });
  const good = crypto.createHmac("sha256", "line-secret-for-test").update(body).digest("base64");
  ok("LINE 署名：正しい署名は通る", verifyLineSignature(body, good));
  ok("LINE 署名：違う署名は false", !verifyLineSignature(body, good.slice(0, -2) + (good.endsWith("AA") ? "BB" : "AA")));
  ok("LINE 署名：長さ違いは false", !verifyLineSignature(body, good + "x"));
  ok("LINE 署名：空は false", !verifyLineSignature(body, ""));

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
