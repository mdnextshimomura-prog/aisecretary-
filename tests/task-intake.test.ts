import {
  isContextlessRequest,
  taskMentionState,
} from "../src/lib/task-intake";

let fail = 0;
const ok = (name: string, condition: boolean) => {
  if (condition) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name}`);
  }
};

const botId = "U_BOT";

ok(
  "AI秘書へのメンションを受付対象にする",
  taskMentionState([{ type: "user", userId: botId }], botId).mentionsBot
);
ok(
  "社員メンションだけではAI秘書を起動しない",
  !taskMentionState([{ type: "user", userId: "U_HASHIMOTO" }], botId)
    .mentionsBot
);
ok(
  "AI秘書と社員の両方をメンションした場合は担当指定も認識する",
  taskMentionState(
    [
      { type: "user", userId: botId },
      { type: "user", userId: "U_HASHIMOTO" },
    ],
    botId
  ).mentionsAssignee
);
ok("『お願いします』だけは内容不足", isContextlessRequest("お願いします"));
ok(
  "『対応お願いします』だけは内容不足",
  isContextlessRequest("対応お願いします！")
);
ok(
  "具体的な作業があれば受付可能",
  !isContextlessRequest("メロディハイム626の査定をお願いします")
);

console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
process.exit(fail ? 1 : 0);
