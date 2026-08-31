/**
 * 聞き返しの対象者テスト。
 * 全員に聞き返すとグループがうるさくなるので、社長からの依頼だけに絞る。
 */
import { shouldClarifyFor, clarifyTargets } from "../src/lib/clarify-target";

let fail = 0;
const ok = (n: string, c: boolean, d = "") => {
  if (!c) { fail++; console.log(`❌ ${n} ${d}`); } else console.log(`✅ ${n} ${d}`);
};

const 社長 = "U8d0899ebb7bca2093fe45c24a500ce9c";  // 前田 誠治（名簿より）
const 下村 = "Uc0d018f0000000000000000000000000";
const 小笠原 = "U4050efc0000000000000000000000000";

delete process.env.CLARIFY_SENDER_IDS;
ok("社長には聞き返す", shouldClarifyFor(社長));
ok("下村さんには聞き返さない", !shouldClarifyFor(下村));
ok("小笠原さんには聞き返さない", !shouldClarifyFor(小笠原));
ok("発言者不明は対象外（安全側）", !shouldClarifyFor(undefined));
ok("空文字も対象外", !shouldClarifyFor(""));
ok("既定の対象は1名", clarifyTargets().length === 1, clarifyTargets().join(","));

// 環境変数で一時的に止められる
process.env.CLARIFY_SENDER_IDS = "off";
ok("off にすると誰にも聞き返さない", !shouldClarifyFor(社長));

// 対象を足せる
process.env.CLARIFY_SENDER_IDS = `${社長},${下村}`;
ok("追加した人にも聞き返す", shouldClarifyFor(下村));
ok("社長は引き続き対象", shouldClarifyFor(社長));
ok("それ以外は対象外", !shouldClarifyFor(小笠原));

delete process.env.CLARIFY_SENDER_IDS;
console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
process.exit(fail ? 1 : 0);
