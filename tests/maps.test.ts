/**
 * 地図リンクの解決テスト。
 * 実際にGoogleへ通信する（許可リスト内のホストのみ）。
 *   npx tsx tests/maps.test.ts
 */
import { extractMapUrls, resolveMapUrl, mapContext } from "../src/lib/maps";

let fail = 0;
const ok = (n: string, c: boolean, d = "") => {
  if (!c) { fail++; console.log(`❌ ${n} ${d}`); } else console.log(`✅ ${n} ${d}`);
};

async function main() {
  // ── 許可リスト：マップ以外は絶対に開かない ──
  for (const bad of [
    "https://evil.example.com/steal",
    "http://maps.app.goo.gl/x",          // httpは不可
    "https://www.google.com/search?q=x", // マップ以外のパス
    "https://goo.gl/other",
    "https://maps.app.goo.gl.evil.com/x",
  ]) {
    ok(`開かない: ${bad.slice(0, 38)}`, extractMapUrls(bad).length === 0);
  }
  ok("マップのリンクは拾う",
    extractMapUrls("これ見て https://maps.app.goo.gl/abc123 よろしく").length === 1);
  ok("2件までに絞る",
    extractMapUrls([1,2,3].map(i=>`https://maps.app.goo.gl/a${i}`).join(" ")).length === 2);

  // ── 実際に解決できるか（履歴に実在したリンク）──
  const a = await resolveMapUrl("https://maps.app.goo.gl/sVD2YUfmRwwRoUzy8");
  console.log("   解決結果:", a);
  ok("日本語の住所が取れる", Boolean(a && /大阪府|兵庫県|京都/.test(a)), a ?? "null");

  const ctx = await mapContext("この物件どう？ https://maps.app.goo.gl/sVD2YUfmRwwRoUzy8");
  ok("解析用の補足が作られる", ctx.includes("地図リンクの場所"), ctx.trim());

  // ── 解決できなくても落ちない ──
  const dead = await resolveMapUrl("https://maps.app.goo.gl/zzzzzzzzzzzzzzz");
  ok("無効なリンクでも例外にしない", dead === null || typeof dead === "string", String(dead));
  ok("リンクが無ければ空", (await mapContext("ただのテキスト")) === "");

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
