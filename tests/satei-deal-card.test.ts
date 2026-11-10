/**
 * B2 査定書：案件カードの［査定書を作る］。off のとき案件カードの JSON が今と1バイトも変わらないことを固定する。
 */
import { createHash } from "node:crypto";
import { buildDealPage, dealBubble, type DealSummary } from "../src/lib/deal-card";
import { parseSateiData } from "../src/lib/satei-data";
import { FLEX_JSON_MAX } from "../src/lib/task-menu";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};
globalThis.fetch = (async () => {
  throw new Error("このテストで外部へ通信してはいけない");
}) as typeof fetch;

const D: DealSummary = {
  id: "00000001-aaaa-bbbb-cccc-1234567890ab",
  name: "テスト案件",
  phase: "査定",
  count: 2,
  nearestDue: "2026-11-20",
};
const MANY: DealSummary[] = Array.from({ length: 12 }, (_, i) => ({
  ...D,
  id: `${String(i + 1).padStart(8, "0")}-aaaa-bbbb-cccc-1234567890ab`,
  name: `案件${i + 1}`,
}));
// 変更前のコードの出力（5d34914 で取得）
const OFF_JSON =
  '{"type":"bubble","body":{"type":"box","layout":"vertical","spacing":"sm","contents":[{"type":"text","text":"テスト案件","weight":"bold","size":"md","wrap":true},{"type":"box","layout":"baseline","spacing":"sm","contents":[{"type":"text","text":"フェーズ","size":"sm","color":"#888888","flex":3},{"type":"text","text":"査定","size":"sm","wrap":true,"flex":5}]},{"type":"box","layout":"baseline","spacing":"sm","contents":[{"type":"text","text":"近い期日","size":"sm","color":"#888888","flex":3},{"type":"text","text":"11月20日(金)","size":"sm","wrap":true,"flex":5}]},{"type":"box","layout":"baseline","spacing":"sm","contents":[{"type":"text","text":"残りタスク","size":"sm","color":"#888888","flex":3},{"type":"text","text":"2件","size":"sm","wrap":true,"flex":5}]}]},"footer":{"type":"box","layout":"vertical","spacing":"sm","contents":[{"type":"button","style":"primary","height":"sm","action":{"type":"postback","label":"タスクを見る","data":"v1|dt|00000001-aaaa-bbbb-cccc-1234567890ab","displayText":"（ボタン）この案件のタスクを見る"}},{"type":"button","style":"secondary","height":"sm","action":{"type":"postback","label":"タスクを足す","data":"v1|da|00000001-aaaa-bbbb-cccc-1234567890ab","displayText":"（ボタン）この案件にタスクを足す"}}]}}';
const OFF_PAGE_SHA = "f864f94a8cf41df751cb226c126dd198998483d9f9968194ce911fe0bb5d5b5e";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Btn = { type: string; style: string; action: { type: string; label: string; data: string; displayText: string } };
const footerOf = (b: unknown): Btn[] => (b as { footer: { contents: Btn[] } }).footer.contents;

for (const v of [undefined, "", "0", "true"]) {
  if (v === undefined) delete process.env.TASK_SATEI;
  else process.env.TASK_SATEI = v;
  ok(`off（TASK_SATEI=${v ?? "未設定"}）：案件カードの JSON は今と1バイトも同じ`, JSON.stringify(dealBubble(D)) === OFF_JSON);
  ok(
    `off（TASK_SATEI=${v ?? "未設定"}）：12件の一覧の JSON も今と同じ`,
    sha(JSON.stringify(buildDealPage(MANY, 0))) === OFF_PAGE_SHA,
  );
}

process.env.TASK_SATEI = "1";
const on = footerOf(dealBubble(D));
const off = footerOf(JSON.parse(OFF_JSON));
ok("on：ボタンは3つ", on.length === 3);
ok("on：前の2つは今と同じ", JSON.stringify(on.slice(0, 2)) === JSON.stringify(off));
ok("on：3つ目のラベル", on[2]?.action.label === "査定書を作る");
ok("on：3つ目の displayText", on[2]?.action.displayText === "（ボタン）査定書を作る");
ok("on：3つ目は postback・secondary", on[2]?.action.type === "postback" && on[2]?.style === "secondary");
ok("on：data は v1|sa|案件ID", on[2]?.action.data === `v1|sa|${D.id}`);
ok(
  "on：data は satei の読み方で読める",
  JSON.stringify(parseSateiData(on[2]?.action.data ?? "")) === JSON.stringify({ op: "sa", dealId: D.id }),
);
const page = buildDealPage(MANY, 0);
ok(
  "on：一覧の JSON は 30KB 未満",
  page.card !== undefined && Buffer.byteLength(JSON.stringify(page.card.contents), "utf8") < FLEX_JSON_MAX,
);
delete process.env.TASK_SATEI;

if (fail > 0) {
  console.log(`\n${fail} 件失敗`);
  process.exit(1);
}
console.log("\nすべて成功");
