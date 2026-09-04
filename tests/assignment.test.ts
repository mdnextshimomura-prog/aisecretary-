import {
  ASSIGNMENT_MEMBERS,
  applyAutomaticAssignment,
  chooseSalesAssignee,
} from "../src/lib/assignment";
import { officialAssignee } from "../src/lib/workload";

let fail = 0;
const ok = (name: string, condition: boolean) => {
  if (condition) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name}`);
  }
};

const workload = (
  hashimoto: number,
  ariyoshi: number,
  lastAssignee: "橋本 由人" | "有吉 勇弥" | null = null
) => ({
  scores: { "橋本 由人": hashimoto, "有吉 勇弥": ariyoshi },
  lastAssignee,
  sources: ["test"],
});

ok(
  "橋本さんの負荷が少なければ橋本さん",
  chooseSalesAssignee(workload(1, 2)).assignee === ASSIGNMENT_MEMBERS.sales[0]
);
ok(
  "有吉さんの負荷が少なければ有吉さん",
  chooseSalesAssignee(workload(3, 1)).assignee === ASSIGNMENT_MEMBERS.sales[1]
);
ok(
  "同点かつ直前が橋本さんなら有吉さん",
  chooseSalesAssignee(workload(2, 2, "橋本 由人")).assignee ===
    ASSIGNMENT_MEMBERS.sales[1]
);
ok(
  "同点かつ直前が有吉さんなら橋本さん",
  chooseSalesAssignee(workload(2, 2, "有吉 勇弥")).assignee ===
    ASSIGNMENT_MEMBERS.sales[0]
);
ok("姓だけの有吉も正式名へ寄せる", officialAssignee("有吉") === "有吉 勇弥");
ok("姓だけの橋本も正式名へ寄せる", officialAssignee("橋本") === "橋本 由人");
ok("1文字だけでは担当者とみなさない", officialAssignee("橋") === null);

const baseTask = {
  isTask: true,
  confidence: 1,
  title: "テスト",
  category: "賃貸" as const,
  urgency: "今週中" as const,
  requestType: "その他" as const,
  urgentHint: false,
  dueDate: null,
  dueTime: null,
  assignee: null,
  memo: null,
};

async function main() {
  const rental = await applyAutomaticAssignment(baseTask);
  ok("賃貸は野原さん", rental.assignee === ASSIGNMENT_MEMBERS.rental);

  const management = await applyAutomaticAssignment({
    ...baseTask,
    category: "管理",
  });
  ok("管理は足立さん", management.assignee === ASSIGNMENT_MEMBERS.management);

  const explicit = await applyAutomaticAssignment({
    ...baseTask,
    assignee: "別の担当者",
  });
  ok("明示された担当者は上書きしない", explicit.assignee === "別の担当者");
  ok("明示担当は自動割当扱いにしない", !explicit.automatic);

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
