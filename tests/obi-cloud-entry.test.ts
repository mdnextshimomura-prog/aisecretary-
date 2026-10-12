/**
 * クラウド配達の見回りの入口（約束 2026-10-11-obi-cloud-contract.md の「K4 の見回り」・設計 C1・C14・C16）。
 * 合言葉 → スイッチ → 共通の設定 →（ここで初めて部品を組む）→ 見回り。
 * 値はどれもテスト用（本物の合言葉・鍵ではない）。
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ObiEnv } from "../src/lib/obi/config";
import {
  buildCheckpoint,
  tickAuthorized,
  tickTokenFor,
  handleCloudTick,
} from "../src/lib/obi/cloud-entry";
import { CloudHalt, type CloudCheckpoint } from "../src/lib/obi/cloud-tick";
import {
  GROUP,
  KID,
  LIFF_ID,
  PORTAL_TOKEN,
  TEST_PRIVATE_PEM,
  fakeWorld,
} from "./helpers/obi-cloud-fakes";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name}`);
};

// 合言葉は、portal と共有している JOB_API_TOKEN から導く（新しい変数は足さない）。
// 期待値は、実装を通さずにここで計算する：HMAC-SHA256(鍵 = JOB_API_TOKEN の UTF-8, 文 = "obi-cloud-tick.v1") の小文字16進64桁
const SECRET = PORTAL_TOKEN;
const derive = (token: string) =>
  createHmac("sha256", Buffer.from(token, "utf8")).update("obi-cloud-tick.v1", "utf8").digest("hex");
const GOOD = derive(SECRET);
const ENV: ObiEnv = {
  OBI_CLOUD_DELIVERY: "1",
  PORTAL_BASE_URL: "https://portal.example.test",
  JOB_API_TOKEN: PORTAL_TOKEN,
  LINE_GROUP_ID: GROUP,
  LINE_CHANNEL_ACCESS_TOKEN: "line-token-for-test",
  KV_REST_API_URL: "https://kv.example.test",
  KV_REST_API_TOKEN: "kv-token-for-test",
  OBI_CLOUD_SIGNING_KEY: TEST_PRIVATE_PEM.trim().replace(/\n/g, "\\n"),
  OBI_CLOUD_KID: KID,
  OBI_CLOUD_LIFF_ID: LIFF_ID,
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** console.log・error・warn を集めながら動かす */
async function captured<T>(
  run: () => Promise<T>,
): Promise<{ value: T; out: string[] }> {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const out: string[] = [];
  const grab = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.log = grab;
  console.error = grab;
  console.warn = grab;
  try {
    return { value: await run(), out };
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
  }
}
const root = path.join(__dirname, "..");

async function main() {
  // ---- 合言葉（x-obi-tick-token）
  ok("導き方：HMAC-SHA256(JOB_API_TOKEN, \"obi-cloud-tick.v1\") の小文字16進64桁", tickTokenFor(SECRET) === GOOD && /^[0-9a-f]{64}$/.test(GOOD));
  ok("導き方：固定の値（鍵 32字の a）", tickTokenFor("a".repeat(32)) === derive("a".repeat(32)) && tickTokenFor("a".repeat(32)) !== GOOD);
  ok("合言葉：正しい鍵 → 通る", tickAuthorized(GOOD, SECRET) === true);
  for (const header of [
    null,
    "",
    GOOD.toUpperCase(),
    GOOD.slice(0, 63),
    `${GOOD}0`,
    ` ${GOOD}`,
    `${GOOD} `,
    `Bearer ${GOOD}`,
    SECRET, // JOB_API_TOKEN そのもの
    `Bearer ${SECRET}`,
    derive(`${SECRET}x`), // 違う鍵から導いた値
    createHmac("sha256", SECRET).update("obi-cloud-tick.v2").digest("hex"), // 違う文
    "0".repeat(64),
    "undefined",
    "x".repeat(100_000),
  ]) {
    ok(`合言葉：${JSON.stringify(header).slice(0, 24)} → 通さない（長さが違っても例外にならない）`, tickAuthorized(header, SECRET) === false);
  }
  for (const token of [undefined, "", "short", "a".repeat(31)]) {
    const forged = typeof token === "string" ? derive(token) : derive("");
    for (const header of [forged, GOOD, "", null]) {
      ok(`合言葉：JOB_API_TOKEN が ${token === undefined ? "無い" : `${token.length}字`}・ヘッダ ${header === null ? "なし" : header === forged ? "その値から導いた鍵" : header === "" ? "空" : "ほかの鍵"} → 通さない`, tickAuthorized(header, token) === false);
    }
  }
  ok("合言葉：JOB_API_TOKEN が32字ちょうどなら、導いた鍵で通る", tickAuthorized(derive("a".repeat(32)), "a".repeat(32)) === true);

  let made = 0;
  const never = () => {
    made += 1;
    throw new Error("部品を組み立ててはいけない");
  };

  {
    const r = await handleCloudTick(derive(`${SECRET}x`), ENV, never);
    ok(
      "401：本文は Unauthorized だけ・鍵も導いた値も含まない",
      r.status === 401 && same(r.body, { error: "Unauthorized" }) && !JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes(GOOD),
    );
    const r2 = await handleCloudTick(derive(""), { ...ENV, JOB_API_TOKEN: undefined }, never);
    const r3 = await handleCloudTick(null, ENV, never);
    const r4 = await handleCloudTick(derive("a".repeat(31)), { ...ENV, JOB_API_TOKEN: "a".repeat(31) }, never);
    ok("401：JOB_API_TOKEN が無い・32字未満なら必ず通さない・ヘッダなしも通さない", r2.status === 401 && r3.status === 401 && r4.status === 401 && made === 0);
    // 前の道（Vercel の cron の Authorization: Bearer <CRON_SECRET>）は外した
    const r5 = await handleCloudTick("Bearer cron-secret-for-test-0001", { ...ENV, CRON_SECRET: "cron-secret-for-test-0001" }, never);
    ok("401：CRON_SECRET の Bearer では通らない（その道は外した）", r5.status === 401 && made === 0);
  }

  // ---- スイッチ off
  for (const v of [undefined, "0", "true", ""]) {
    const r = await captured(() =>
      handleCloudTick(GOOD, { ...ENV, OBI_CLOUD_DELIVERY: v }, never),
    );
    ok(
      `スイッチ ${JSON.stringify(v)} → 200 skipped off・部品を組み立てない・ログなし`,
      r.value.status === 200 &&
        same(r.value.body, { skipped: "off" }) &&
        made === 0 &&
        r.out.length === 0,
    );
  }
  {
    const r = await handleCloudTick(
      GOOD,
      {
        JOB_API_TOKEN: SECRET,
        PORTAL_BASE_URL: "めちゃくちゃ",
        LINE_GROUP_ID: "x",
      },
      never,
    );
    ok(
      "スイッチ off：設定がめちゃくちゃでも同じ答え",
      r.status === 200 && same(r.body, { skipped: "off" }) && made === 0,
    );
    const r2 = await handleCloudTick(
      "0".repeat(64),
      { ...ENV, OBI_CLOUD_DELIVERY: undefined },
      never,
    );
    ok(
      "合言葉が先：スイッチが off でも、合言葉が違えば 401",
      r2.status === 401,
    );
  }

  // ---- 共通の設定の不足
  for (const name of [
    "PORTAL_BASE_URL",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "LINE_CHANNEL_ACCESS_TOKEN",
    "LINE_GROUP_ID",
  ]) {
    const r = await captured(() =>
      handleCloudTick(GOOD, { ...ENV, [name]: undefined }, never),
    );
    ok(
      `共通の設定：${name} が無い → 200 skipped config・その名前だけ・部品を組み立てない`,
      r.value.status === 200 &&
        same(r.value.body, { skipped: "config", problems: [name] }) &&
        made === 0,
    );
    ok(
      `共通の設定：${name} が無い → ログは1行（名前だけ）`,
      same(r.out, [`cloud-tick config-missing ${name}`]),
      r.out.join("|"),
    );
  }
  {
    // JOB_API_TOKEN の形の違い（空白入り）は、合言葉が通った後の設定の確認で止まる
    const spaced = `${"a".repeat(20)} ${"b".repeat(20)}`;
    const r = await captured(() =>
      handleCloudTick(derive(spaced), { ...ENV, PORTAL_BASE_URL: "http://portal.example.test", JOB_API_TOKEN: spaced }, never),
    );
    ok(
      "共通の設定：形が違う → 値を出さない",
      same(r.value.body, { skipped: "config", problems: ["PORTAL_BASE_URL", "JOB_API_TOKEN"] }) &&
        !JSON.stringify([r.value, r.out]).includes("portal.example.test") &&
        !JSON.stringify([r.value, r.out]).includes(spaced),
    );
  }

  // ---- on・設定あり
  {
    const w = fakeWorld();
    w.portal.add({ no: 12, status: "完成", property: "A" });
    let calls = 0;
    let gotGroup = "";
    const r = await captured(() =>
      handleCloudTick(
        GOOD,
        ENV,
        (shared) => {
          calls += 1;
          gotGroup = shared.groupId;
          return w.deps;
        },
        w.clock.now,
      ),
    );
    ok(
      "on・設定あり：部品を1回だけ組み、見回りの応答がそのまま 200 で返る",
      calls === 1 &&
        gotGroup === GROUP &&
        r.value.status === 200 &&
        same(r.value.body, {
          delivered: 1,
          notSent: 0,
          unknown: 0,
          notices: 0,
          seeded: false,
        }),
      JSON.stringify(r.value),
    );
    ok(
      "on・設定あり：完成を1件配った",
      w.line.texts.length === 1 &&
        w.portal.job(12).status === "納品済み" &&
        w.line.texts[0].includes(`https://liff.line.me/${LIFF_ID}?t=`),
    );
  }
  {
    const w = fakeWorld();
    w.portal.add({ no: 12, status: "完成" });
    const r = await captured(() =>
      handleCloudTick(
        GOOD,
        { ...ENV, OBI_CLOUD_FIX_GUIDE: "1" },
        () => w.deps,
        w.clock.now,
      ),
    );
    ok(
      "番号の案内のスイッチが on → 末尾に付く",
      r.value.status === 200 && w.line.texts[0].includes("▼ 確認したら番号で返信してください"),
    );
  }
  {
    const w = fakeWorld();
    w.portal.add({ no: 12, status: "完成" });
    const r = await captured(() =>
      handleCloudTick(
        GOOD,
        {
          ...ENV,
          OBI_CLOUD_KID: undefined,
          OBI_CLOUD_SIGNING_KEY: "not-a-key",
        },
        () => w.deps,
        w.clock.now,
      ),
    );
    ok(
      "完成の設定が無い → 200 で completionSkipped・problems（名前だけ）",
      r.value.status === 200 &&
        same(r.value.body, {
          delivered: 0,
          notSent: 0,
          unknown: 0,
          notices: 0,
          seeded: false,
          completionSkipped: "config",
          problems: ["OBI_CLOUD_SIGNING_KEY", "OBI_CLOUD_KID"],
        }) &&
        w.line.texts.length === 0,
      JSON.stringify(r.value.body),
    );
    ok(
      "完成の設定が無い → ログに値が出ない・名前だけ",
      !r.out.join("\n").includes("not-a-key") &&
        !w.logs.join("\n").includes("not-a-key") &&
        w.logs.includes(
          "cloud-tick completion-config-missing OBI_CLOUD_SIGNING_KEY,OBI_CLOUD_KID",
        ),
    );
  }

  // ---- 見回りが例外
  {
    const w = fakeWorld();
    w.portal.add({ no: 12, status: "完成" });
    w.portal.failNext("listJobs", { kind: "throw" });
    const r = await captured(() =>
      handleCloudTick(GOOD, ENV, () => w.deps, w.clock.now),
    );
    ok(
      "見回りが例外 → 500 internal（例外の文を含まない）",
      r.value.status === 500 && same(r.value.body, { error: "internal" }),
    );
    ok(
      "見回りが例外 → ログは error <例外の名前> の1行だけ",
      same(r.out, ["cloud-tick error FakePortalError"]),
      r.out.join("|"),
    );
    const r2 = await captured(() =>
      handleCloudTick(GOOD, ENV, () => {
        throw Object.assign(
          new Error(`boom https://portal.example.test ${PORTAL_TOKEN}`),
          { name: "Weird Name!" },
        );
      }),
    );
    ok(
      "部品の組み立てが例外 → 500・ログに文も変な名前も出ない",
      r2.value.status === 500 && same(r2.out, ["cloud-tick error Error"]),
      r2.out.join("|"),
    );
  }

  // ---- 途中で止める仕掛け
  {
    const cp = buildCheckpoint({
      OBI_CLOUD_HALT_AT: "completion-prepared",
      VERCEL_ENV: "preview",
    });
    let halted: unknown = null;
    try {
      cp("completion-prepared");
    } catch (e) {
      halted = e;
    }
    ok(
      "止める仕掛け：その名前で CloudHalt を投げる",
      halted instanceof CloudHalt && halted.point === "completion-prepared",
    );
    let other = false;
    try {
      cp("completion-attempting");
      cp("notice-pushed");
    } catch {
      other = true;
    }
    ok("止める仕掛け：ほかの名前では投げない", other === false);
    const all: CloudCheckpoint[] = [
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
    ];
    const throwsAt = (env: ObiEnv, p: CloudCheckpoint) => {
      try {
        buildCheckpoint(env)(p);
        return false;
      } catch {
        return true;
      }
    };
    ok(
      "止める仕掛け：10の差し込み口のどれでも止められる（本番以外）",
      all.every(
        (p) =>
          throwsAt({ OBI_CLOUD_HALT_AT: p }, p) &&
          throwsAt({ OBI_CLOUD_HALT_AT: p, VERCEL_ENV: "development" }, p),
      ),
    );
    ok(
      "止める仕掛け：本番（VERCEL_ENV=production）では、どの名前でも投げない",
      all.every(
        (p) => !throwsAt({ OBI_CLOUD_HALT_AT: p, VERCEL_ENV: "production" }, p),
      ),
    );
    ok(
      "止める仕掛け：変数が無い・知らない名前 → 投げない",
      all.every(
        (p) =>
          !throwsAt({}, p) &&
          !throwsAt({ OBI_CLOUD_HALT_AT: "nowhere" }, p) &&
          !throwsAt({ OBI_CLOUD_HALT_AT: "" }, p),
      ),
    );
    // 入口を通しても、止めたときは 500（関数が落ちたのと同じ）で、錠は残る
    const w = fakeWorld();
    w.portal.add({ no: 12, status: "完成" });
    w.haltAt("completion-prepared");
    const r = await captured(() =>
      handleCloudTick(GOOD, ENV, () => w.deps, w.clock.now),
    );
    ok(
      "止めた回：500・ログは error CloudHalt・錠は残る",
      r.value.status === 500 &&
        same(r.out, ["cloud-tick error CloudHalt"]) &&
        w.store.lockHeld(),
    );
  }

  // ---- vercel.json・route.ts
  {
    const vercel = JSON.parse(
      readFileSync(path.join(root, "vercel.json"), "utf8"),
    ) as { crons: Array<{ path: string; schedule: string }> };
    const find = (p: string) =>
      vercel.crons.find((c) => c.path === p)?.schedule;
    ok(
      "vercel.json：cron は決まった3本だけ（見回りは Vercel の cron を使わない。portal の worker が毎分たたく）",
      // 3本目は、タスクの候補を17時台に聞く入口（2026-10-12。日に1回なので Hobby プランの cron で足りる）
      vercel.crons.length === 3 && find("/api/remind") === "0 23 * * *" && find("/api/report") === "0 1 * * *" && find("/api/candidates-ask") === "0 8 * * *" && find("/api/obi/cloud-tick") === undefined,
    );
    const route = readFileSync(
      path.join(root, "src", "app", "api", "obi", "cloud-tick", "route.ts"),
      "utf8",
    );
    ok(
      "route.ts：maxDuration 60・runtime nodejs・dynamic force-dynamic",
      /^export const maxDuration = 60;$/m.test(route) &&
        /^export const runtime = "nodejs";$/m.test(route) &&
        /^export const dynamic = "force-dynamic";$/m.test(route),
    );
    ok(
      "route.ts：見回りを動かすのは POST だけ（ヘッダ x-obi-tick-token を渡す）",
      /export async function POST\(/.test(route) &&
        (route.match(/handleCloudTick\(/g) ?? []).length === 1 &&
        route.includes('req.headers.get("x-obi-tick-token")') &&
        !/export (async )?function (PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(route),
    );
    const get = /export (?:async )?function GET\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(route);
    ok("route.ts：GET は 405（見回りを動かさない・Allow: POST）", get !== null && get[1].includes("status: 405") && !get[1].includes("handleCloudTick") && /allow: "POST"/.test(get[1]));
    ok(
      "route.ts：合言葉を比べない（cloud-entry.ts だけ）・本文もクエリも Authorization も読まない",
      !route.includes("CRON_SECRET") && !route.includes("JOB_API_TOKEN") && !route.includes("authorization") && !/req\.(json|text|formData)\(|searchParams|nextUrl/.test(route),
    );
    const entry = readFileSync(path.join(root, "src", "lib", "obi", "cloud-entry.ts"), "utf8");
    ok("cloud-entry.ts：CRON_SECRET を読まない", !/env\.CRON_SECRET|process\.env\.CRON_SECRET/.test(entry));
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error("テストが例外で止まった:", e);
  process.exit(1);
});
