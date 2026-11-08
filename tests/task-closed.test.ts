/**
 * タスクがもう処理済みか（完了・終わり方あり・消されている）。初動確認への回答で「未着手」に
 * 戻さないための安全網と、ボタンの「処理済み」の判定に使う。Notion は差し替える。
 */
import {
  isClosedPage,
  readTaskState,
  statusAfterConfirm,
  readTaskStatusName,
  statusForConfirmComplete,
} from "../src/lib/task-closed";

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
  ok(
    "終わり方だけでは処理済みにしない（再開でステータスだけ戻したタスク）",
    !isClosedPage(page("進行中", "不要")) && !isClosedPage(page("未着手", "完了")),
  );
  ok("完了＋終わり方は処理済み", isClosedPage(page("完了", "不要")));
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
    (await readTaskState("p1", async () => page("完了", null))) === "closed" &&
      (await readTaskState("p1", async () => page("進行中", null))) === "open",
  );
  ok(
    "見つからない（削除・共有外・権限喪失）は処理済みにせず missing",
    (await readTaskState("p1", async () => {
      throw Object.assign(new Error("nf"), { code: "object_not_found" });
    })) === "missing",
  );
  let threw = false;
  try {
    await readTaskState("p1", async () => {
      throw new Error("network");
    });
  } catch {
    threw = true;
  }
  ok("読み取りに失敗したら例外（更新しない側に倒す）", threw);

  // ── 初動確認の回答で条件がそろったときのステータス（2026-11-08。カードを聞き返しにも付けたため）──
  ok("要確認なら今までどおり未着手にする", statusAfterConfirm("要確認") === "未着手");
  ok("進行中（ボタンの待ち・延期のあと）は未着手で上書きしない", statusAfterConfirm("進行中") === null);
  ok("未着手は未着手のまま（今までどおり書く）", statusAfterConfirm("未着手") === "未着手");
  ok("ステータスが空なら今までどおり未着手", statusAfterConfirm(null) === "未着手");
  ok("完了は開き直さない", statusAfterConfirm("完了") === null);
  {
    const name = await readTaskStatusName("p", async () => page("進行中", null));
    ok("今のステータスを読む", name === "進行中", String(name));
    const none = await readTaskStatusName("p", async () => page(null, null));
    ok("ステータスが無ければ null", none === null);
    let threw = false;
    try {
      await readTaskStatusName("p", async () => {
        throw Object.assign(new Error("x"), { code: "rate_limited" });
      });
    } catch {
      threw = true;
    }
    ok("読めなければ例外（書かない側に倒す）", threw);
  }

  // ── スイッチ（TASK_BUTTONS）と読み取りの失敗 ──
  {
    let reads = 0;
    const read = async () => {
      reads++;
      return "進行中";
    };
    ok(
      "ボタンが off なら読まずに未着手（今と同じ動き）",
      (await statusForConfirmComplete(false, read)) === "未着手" && reads === 0,
    );
    ok("ボタンが on で進行中なら書かない", (await statusForConfirmComplete(true, read)) === null && reads === 1);
    ok(
      "on で要確認なら未着手",
      (await statusForConfirmComplete(true, async () => "要確認")) === "未着手",
    );
    ok(
      // 2026-11-08 再レビューで変更：読めなければ書かない（待ちの進行中・完了を戻さないため。要確認のまま残るのは許容）
      "on で読めなければステータスを書かない（エラーにもしない）",
      (await statusForConfirmComplete(true, async () => {
        throw new Error("notion down");
      })) === null,
    );
  }

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
