/**
 * 残高切れ検知のテスト。
 * 2026-08-19に実際に返ってきたエラーを使って、確実に見分けられるか確かめる。
 */
import { classifyApiError, alertMessage } from "../src/lib/apihealth";

let fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log(`❌ ${n}\n   got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
  else console.log(`✅ ${n}`);
};

// ── 実際に返ってきたエラー（8/19の停止時に記録したもの）──
eq("残高切れ（実物）",
  classifyApiError({
    status: 400,
    message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
  }),
  "credit");

eq("残高切れ（error側に入る形）",
  classifyApiError({ status: 400, error: { message: "Your credit balance is too low" } }),
  "credit");

// ── 認証エラー ──
eq("401", classifyApiError({ status: 401, message: "authentication_error" }), "auth");
eq("キー無効", classifyApiError({ message: "invalid x-api-key" }), "auth");

// ── レート制限 ──
eq("429", classifyApiError({ status: 429, message: "rate_limit_error" }), "rate");

// ── これらは「停止」ではない。警告を出してはいけない ──
eq("JSON崩れ", classifyApiError(new SyntaxError("Unexpected token")), null);
eq("通信断", classifyApiError(new Error("fetch failed")), null);
eq("500", classifyApiError({ status: 500, message: "internal server error" }), null);
eq("過負荷", classifyApiError({ status: 529, message: "overloaded_error" }), null);
eq("undefined", classifyApiError(undefined), null);

// ── 文面 ──
const m = alertMessage("credit");
console.log("\n───── 残高切れ時にLINEへ出る文面 ─────");
console.log(m);
console.log("──────────────────────────────────\n");
eq("止まっていることが分かる", m.includes("応答できません"), true);
eq("登録されないと明記", m.includes("自動では登録されません"), true);

console.log(fail === 0 ? "🎉 全て通過" : `⚠️ ${fail}件 失敗`);
process.exit(fail ? 1 : 0);
