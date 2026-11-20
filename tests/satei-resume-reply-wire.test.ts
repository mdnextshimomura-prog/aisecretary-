/**
 * B2 査定書：上限の返事の［もう一度作る］カードを、本物のつなぎ（sateiReasonDeps().reply）で送ったときの判定。
 * LINE が 400 で断ったときだけ false（呼び手がボタンなしで送り直す）。401・5xx・成功・成功で ID が無いときは送り直さない。
 * fetch は差し替え（外へは出ない）。
 */
import { sateiReasonDeps } from "../src/lib/satei-wire";
import { sateiResumeCard } from "../src/lib/satei-text";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};
const calls: Array<{ url: string; body: string }> = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };
globalThis.fetch = (async (url: string, init: RequestInit) => {
  calls.push({ url: String(url), body: String(init.body) });
  if (!String(url).startsWith("https://api.line.me/v2/bot/message/reply")) throw new Error("LINE の返事以外へ通信してはいけない");
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const card = sateiResumeCard(12, "0123abcd0123456789ab0123456789ab");
(async () => {
  const deps = sateiReasonDeps();
  const cases: Array<[string, number, unknown, boolean | undefined]> = [
    ["400（中身を断った）は false＝送り直す", 400, { message: "invalid" }, false],
    ["401 は送り直さない", 401, {}, undefined],
    ["500 は送り直さない", 500, {}, undefined],
    ["成功は送り直さない", 200, { sentMessages: [{ id: "1" }, { id: "2" }] }, undefined],
    ["成功で ID が無くても送り直さない", 200, {}, undefined],
  ];
  for (const [name, status, body, want] of cases) {
    calls.length = 0;
    answer = { status, body };
    const got = await deps.reply("rt", "文", card);
    ok(name, got === want && calls.length === 1 && calls[0].body.includes("v1|sx|"), `got=${String(got)}`);
  }
  calls.length = 0;
  answer = { status: 200, body: { sentMessages: [{ id: "9" }] } };
  await deps.reply("rt", "文");
  ok("カードが無ければ文字だけ（今までどおり）", calls.length === 1 && !calls[0].body.includes("flex"));
  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
