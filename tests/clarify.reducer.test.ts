/**
 * 初動確認の状態遷移テスト（API不要・決定的）。
 *
 * 本番と**同じ関数**（clarify.ts の applyApproval / applyAnswer）を呼ぶ。
 * 以前は webhook 内の処理をテスト側に書き写していたため、
 * 「テストは通るが本番は別物」になっていた。
 *
 *   npm run test
 */
import {
  applyApproval,
  applyAnswer,
  isApproval,
  checklistFor,
  fillPlaceholders,
  buildHandoffMessage,
  jpDate,
  PROPERTY_FIELD,
  type PendingState,
} from "../src/lib/clarify";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    fail++;
    console.log(`❌ ${name}\n   got =${JSON.stringify(got)}\n   want=${JSON.stringify(want)}`);
  } else console.log(`✅ ${name}`);
};
const ok = (name: string, cond: boolean, d = "") => eq(name + (d ? ` ${d}` : ""), cond, true);

const fields = fillPlaceholders(checklistFor("購入申込書"), { 期日: "2026-08-28" });
const fresh = (): PendingState => ({
  fields,
  awaitingKeys: fields.filter((f) => !f.suggest).map((f) => f.key),
  proposalKeys: fields.filter((f) => f.suggest).map((f) => f.key),
  settled: {},
});

// ── 承認判定 ──
for (const s of ["はい", "OK", "おけ", "了解！", "それでOK", "大丈夫です", "yes"])
  ok(`承認: ${s}`, isApproval(s));
for (const s of ["手付は300万で", "いや違う", "大丈夫ですか", "OKですか？", "はいはい、でも金額は3000万に変更して"])
  ok(`非承認: ${s}`, !isApproval(s));

// ── 必須が残っているのに「はい」だけ来た場合、着手可能にしない ──
{
  const p = fresh();
  const r = applyApproval(p);
  ok("必須未回答なら complete にしない", !r.complete);
  ok("残項目を返す", r.remaining.length > 0, JSON.stringify(r.remaining));
}

// ── 具体回答 → 自動補完 → 完了 → 提案値も確定される ──
{
  const p = fresh();
  const r1 = applyAnswer(p, { buyerType: "自社買取", price: "1億400万円" });
  eq("自動補完で名義が入る", p.settled.buyerName, "株式会社MD NEXT");
  ok("自動補完を返す", r1.derived.length > 0);
  ok("完了になる", r1.complete);
  // ★ここが Codex 指摘。未承認の提案も確定させないと引き渡し文が歯抜けになる
  eq("手付金が確定している", p.settled.deposit, "売買代金の5%");
  eq("有効期限が確定している", p.settled.expiry, "発行日から7日間");
  eq("提案キーは空になる", p.proposalKeys, []);

  const msg = buildHandoffMessage("購入申込書の作成", "北堀江", p.settled, fields, "小笠原 陸", true);
  ok("引き渡し文に手付金が出る", msg.includes("手付金"));
  ok("引き渡し文に金額が出る", msg.includes("1億400万円"));
  ok("メンション用の差込がある", msg.includes("{assignee}"));
}

// ── 定義に無いキーは書き込ませない ──
{
  const p = fresh();
  applyAnswer(p, { nonexistent: "値", price: "1億" });
  ok("未知キーは無視", !("nonexistent" in p.settled));
  eq("既知キーは入る", p.settled.price, "1億");
}

// ── 上書き ──
{
  const p = fresh();
  applyAnswer(p, { buyerName: "前田様個人" });
  const r = applyAnswer(p, { buyerName: "株式会社MD NEXT" });
  eq("値が上書きされる", p.settled.buyerName, "株式会社MD NEXT");
  ok("上書きも applied に出る", r.applied.some((a) => a.includes("株式会社MD NEXT")));
}

// ── 物件不明を必須項目として持たせる ──
{
  const withProp = [PROPERTY_FIELD, ...fields];
  const p: PendingState = {
    fields: withProp,
    awaitingKeys: ["property", ...fields.filter((f) => !f.suggest).map((f) => f.key)],
    proposalKeys: fields.filter((f) => f.suggest).map((f) => f.key),
    settled: {},
  };
  const r = applyAnswer(p, { buyerType: "自社買取", price: "1億" });
  ok("物件が未回答なら完了にしない", !r.complete);
  ok("物件が残項目に出る", r.remaining.includes("対象の物件"), JSON.stringify(r.remaining));
  const r2 = applyAnswer(p, { property: "北堀江1-2-3" });
  ok("物件が答えられたら完了", r2.complete);
}

// ── 日付表記 ──
eq("jpDate", jpDate("2026-08-28"), "8/28（金）");

console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
process.exit(fail ? 1 : 0);
