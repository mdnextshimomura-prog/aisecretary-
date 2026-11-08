/**
 * タスクがもう処理済みか（完了・終わり方あり・消されている）。初動確認への回答で「未着手」に
 * 戻さないための安全網と、ボタンの「処理済み」の判定に使う。Notion は差し替える。
 */
import { isClosedPage, readTaskClosed } from "../src/lib/task-closed";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};

const page = (
  status: string | null,
  end: string | null,
  extra: Record<string, unknown> = {},
) => ({
  id: "p1",
  properties: {
    ステータス: { select: status ? { name: status } : null },
    終わり方: { select: end ? { name: end } : null },
  },
  ...extra,
});

async function main() {
  ok("完了は処理済み", isClosedPage(page("完了", null)));
  ok("終わり方が入っていれば処理済み", isClosedPage(page("進行中", "不要")));
  ok(
    "消されたページは処理済み",
    isClosedPage(page("未着手", null, { archived: true })),
  );
  ok(
    "ゴミ箱も処理済み",
    isClosedPage(page("未着手", null, { in_trash: true })),
  );
  ok("未着手は処理済みでない", !isClosedPage(page("未着手", null)));
  ok("確認待ちは処理済みでない", !isClosedPage(page("確認待ち", null)));
  ok("欄が無くても処理済みでない", !isClosedPage({ id: "p1", properties: {} }));

  ok(
    "読めたページで判定する",
    (await readTaskClosed("p1", async () => page("完了", null))) === true,
  );
  ok(
    "見つからないタスクは処理済み",
    (await readTaskClosed("p1", async () => {
      throw Object.assign(new Error("nf"), { code: "object_not_found" });
    })) === true,
  );
  let threw = false;
  try {
    await readTaskClosed("p1", async () => {
      throw new Error("network");
    });
  } catch {
    threw = true;
  }
  ok("読み取りに失敗したら例外（更新しない側に倒す）", threw);

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
