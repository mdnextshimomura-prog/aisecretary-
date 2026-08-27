import fs from "fs";
// clarify.ts は読み込み時に Anthropic クライアントを作るので、
// import より前に環境変数を入れる必要がある（動的importを使う）
for (const l of fs.readFileSync(".env.local", "utf8").split("\n")) {
  if (!l.includes("=") || l.trim().startsWith("#")) continue;
  const i = l.indexOf("=");
  process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

let fail = 0;
const chk = (n: string, ok: boolean, d = "") => {
  if (!ok) { fail++; console.log(`❌ ${n} ${d}`); } else console.log(`✅ ${n} ${d}`);
};

async function main() {
  const { detectMissing, interpretAnswer, checklistFor } = await import("../src/lib/clarify");

  console.log("\n【A】不足検知 — 履歴の実例「これ買いたい」");
  const a = await detectMissing("これ買いたい", "購入申込書", "北堀江", []);
  console.log("  不足:", a.missing.map(f => f.label).join("・"));
  console.log("  読取:", JSON.stringify(a.found));
  chk("買主名義が不足", a.missing.some(f => f.key === "buyerName"));
  chk("購入金額が不足", a.missing.some(f => f.key === "price"));

  console.log("\n【A2】条件が揃った依頼は聞き返さない");
  const a2 = await detectMissing(
    "北堀江の物件、株式会社MD NEXT名義で1億400万で買付入れてください。手付500万、現金決済、決済は9月30日希望。",
    "購入申込書", "北堀江", []);
  console.log("  不足:", a2.missing.map(f => f.label).join("・") || "（なし）");
  console.log("  読取:", JSON.stringify(a2.found));
  chk("買主名義は不足に出ない", !a2.missing.some(f => f.key === "buyerName"));
  chk("金額は不足に出ない", !a2.missing.some(f => f.key === "price"));
  chk("手付は不足に出ない", !a2.missing.some(f => f.key === "deposit"));

  console.log("\n【A3】査定 —「土地としてでしょうか？」が自動で出るか");
  const a3 = await detectMissing("この物件の査定お願い", "査定書", "北堀江", []);
  console.log("  不足:", a3.missing.map(f => f.label).join("・"));
  chk("査定の前提が不足", a3.missing.some(f => f.key === "basis"));

  const fields = checklistFor("購入申込書");
  console.log("\n【B】回答の解釈 —「買主様の名義を仲介会社宛てに変えて」");
  // 引用リプライとして扱う（引用が無い発言では「回答ではない」を覆さない）
  const b = await interpretAnswer("買主様の名義を仲介会社宛てに変えて", fields,
    { buyerName: "前田様個人" }, "北堀江の物件で購入申込書を作成", true);
  console.log(" ", JSON.stringify(b));
  // 安全弁は isNewRequest。確信度が低くても修正指示があれば既存タスクへ付ける
  const relates = b.isAnswer && !b.isNewRequest && (b.confidence >= 0.7 || Boolean(b.amendment));
  chk("既存タスクへの指示と判定＝新規タスクにしない", relates,
    `isNew=${b.isNewRequest} conf=${b.confidence}`);
  chk("名義か宛先のどちらかに反映される",
    "buyerName" in b.updates || "addressee" in b.updates || Boolean(b.amendment),
    JSON.stringify({ updates: b.updates, amendment: b.amendment }));

  console.log("\n【B2】部分回答「手付は300万で」");
  const b2 = await interpretAnswer("手付は300万で", fields, {}, "北堀江の物件で購入申込書を作成", false);
  console.log(" ", JSON.stringify(b2));
  chk("回答と判定", b2.isAnswer && b2.confidence >= 0.7);
  chk("depositを更新", "deposit" in b2.updates, JSON.stringify(b2.updates));

  console.log("\n【B3】★最重要★ 確認中に来た別依頼を吸い込まないか");
  for (const t of [
    "別件やけど豊中の物件の謄本取っといて",
    "あと明日までに西宮の販売図面も作って",
    "高槻の再販資料ください！",
  ]) {
    const r = await interpretAnswer(t, fields, {}, "北堀江の物件で購入申込書を作成", false);
    // 新規依頼と分かれば、回答として吸い込まない（=新規タスクとして登録される）
    const swallowed = r.isAnswer && !r.isNewRequest && r.confidence >= 0.7;
    chk(`別依頼を吸い込まない: ${t.slice(0, 12)}…`, !swallowed,
      `isNew=${r.isNewRequest} isAns=${r.isAnswer} conf=${r.confidence}`);
  }

  console.log("\n【B5】必須項目を推測で埋めないか（5回連続）");
  for (let i = 0; i < 5; i++) {
    const r = await detectMissing("この物件の査定お願い", "査定書", "北堀江", [], "2026-09-04");
    chk(`  ${i + 1}回目: 前提を推測で埋めない`, !("basis" in r.found), JSON.stringify(r.found));
  }

  console.log("\n【B4】履歴の実例「収益」（1語の回答）");
  const b4 = await interpretAnswer("収益", checklistFor("査定書"), {}, "北堀江の査定", false);
  console.log(" ", JSON.stringify(b4));
  chk("回答と判定", b4.isAnswer);

  console.log("\n【B6】引用なしの別依頼は、修正指示に見えても吸い込まない");
  for (const t of ["請求書の宛先をA社に変えて", "販売図面の写真を差し替えといて"]) {
    const r = await interpretAnswer(t, fields, {}, "北堀江の物件で購入申込書を作成", false);
    const swallowed = r.isAnswer && !r.isNewRequest && (r.confidence >= 0.7 || Boolean(r.amendment));
    chk(`引用なしで吸い込まない: ${t.slice(0, 10)}…`, !swallowed,
      `isAns=${r.isAnswer} isNew=${r.isNewRequest} amend=${Boolean(r.amendment)}`);
  }

  console.log("\n【B7】必須項目を発言の根拠なしに確定させない");
  const b7 = await interpretAnswer("よろしく頼むわ", fields, {}, "北堀江の物件で購入申込書を作成", true);
  chk("金額を勝手に埋めない", !("price" in b7.updates), JSON.stringify(b7.updates));
  chk("名義を勝手に埋めない", !("buyerName" in b7.updates));

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
}
main();
