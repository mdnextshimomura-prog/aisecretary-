/**
 * B2 査定書：webhook の差し戻し理由の取り込みの置き場所。
 * 文字メッセージの判定のあと・メールの下書きの確認より前に1か所だけあり、true のときだけ次のイベントへ進むこと。
 */
import { readFileSync } from "node:fs";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};

const src = readFileSync("src/app/api/webhook/route.ts", "utf8");
const at = (s: string) => src.indexOf(s);
const call = "await handleSateiReasonText(";
ok("取り込みは1か所だけ", src.split(call).length === 2);
ok("import がある", src.includes('import { handleSateiReasonText } from "@/lib/satei-actions";') && src.includes('import { sateiReasonDeps } from "@/lib/satei-wire";'));
ok("送り主の制限（checkSecretarySource）より後", at("checkSecretarySource(event.source)") >= 0 && at("checkSecretarySource(event.source)") < at(call));
ok("文字メッセージの判定より後", at('if (event.message.type !== "text") continue;') < at(call));
ok("「@秘書 案件」の入口より後", at("dealWordEntry({") < at(call));
ok("メールの下書きの確認より前", at(call) < at("const draftSession = await getDraftSession("));
ok("初動確認への回答より前", at(call) < at("const pending = await getPendingTaskConfirm("));
const block = src.slice(at(call), at(call) + 600);
ok("1対1の送り主の ID・本文・replyToken を渡す", block.includes("userId: source.userId") && block.includes("groupId: source.groupId") && block.includes("text: event.message.text") && block.includes("replyToken"));
ok("受けたときだけ確定して次へ", /markCommitted\(\);\s*continue;/.test(block));

if (fail > 0) {
  console.log(`\n${fail} 件失敗`);
  process.exit(1);
}
console.log("\nすべて成功");
