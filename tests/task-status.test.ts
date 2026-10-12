import {
  applyStatusCommand,
  applyStatusToTask,
  closeProps,
  postponeProps,
  waitProps,
  type StatusDeps,
} from "../src/lib/task-status";

let fail = 0;
const ok = (name: string, condition: boolean) => {
  if (condition) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name}`);
  }
};
const eq = (name: string, a: unknown, b: unknown) =>
  ok(`${name}`, JSON.stringify(a) === JSON.stringify(b));

// ── Notion に渡す形 ──
eq("待ち：進行中にして、状況と確認日を入れる", waitProps("売主の書類", "2026-10-16"), {
  ステータス: { select: { name: "進行中" } },
  状況: { rich_text: [{ text: { content: "売主の書類" } }] },
  次に確認する日: { date: { start: "2026-10-16" } },
});
eq("待ち：理由が空なら状況は空にする", waitProps("", "2026-10-16"), {
  ステータス: { select: { name: "進行中" } },
  状況: { rich_text: [] },
  次に確認する日: { date: { start: "2026-10-16" } },
});
eq("延期：期日を変え、期限前の通知をもう一度出せるようにする", postponeProps("2026-10-20"), {
  期日: { date: { start: "2026-10-20" } },
  通知済み: { checkbox: false },
});
eq("不要：完了にして終わり方を残す", closeProps("不要"), {
  ステータス: { select: { name: "完了" } },
  終わり方: { select: { name: "不要" } },
});

// ── 適用と返事 ──
function fakeDeps(tasks: Record<number, { id: string; title: string }>) {
  const updates: Array<{ pageId: string; props: Record<string, unknown> }> = [];
  const deps: StatusDeps = {
    findByNumber: async (n) => tasks[n] ?? null,
    update: async (pageId, props) => {
      updates.push({ pageId, props });
    },
    defaultCheckDate: async () => "2026-10-15",
  };
  return { deps, updates };
}

(async () => {
  {
    const { deps, updates } = fakeDeps({ 3: { id: "p3", title: "見積を送る" } });
    const r = await applyStatusCommand(
      { kind: "wait", note: "売主の書類", date: "2026-10-16", numbers: [3] },
      deps
    );
    eq("待ち：1 件書く", updates, [
      { pageId: "p3", props: waitProps("売主の書類", "2026-10-16") },
    ]);
    ok("待ち：返事に題名・状況・確認日が入る", r.text.includes("3. 見積を送る") && r.text.includes("売主の書類") && r.text.includes("10/16"));
    eq("待ち：変えた件数", r.changed, 1);
  }
  {
    const { deps, updates } = fakeDeps({ 3: { id: "p3", title: "見積を送る" } });
    const r = await applyStatusCommand(
      { kind: "wait", note: "", date: null, numbers: [3] },
      deps
    );
    eq("待ち：日付なしは既定の確認日を使う", updates[0].props, waitProps("", "2026-10-15"));
    ok("待ち：返事に既定の確認日が入る", r.text.includes("10/15"));
  }
  {
    const { deps, updates } = fakeDeps({ 3: { id: "p3", title: "見積を送る" } });
    const r = await applyStatusCommand(
      { kind: "postpone", date: null, numbers: [3] },
      deps
    );
    eq("延期：日付なしは何も書かない", updates, []);
    ok("延期：日付を付けるよう返す", r.text.includes("3延期 10/20"));
    eq("延期：変えた件数は 0", r.changed, 0);
  }
  {
    const { deps, updates } = fakeDeps({
      1: { id: "p1", title: "鍵を返す" },
      2: { id: "p2", title: "図面を直す" },
    });
    const r = await applyStatusCommand(
      { kind: "postpone", date: "2026-10-20", numbers: [1, 2, 7] },
      deps
    );
    eq("延期：見つかった分だけ書く", updates.map((u) => u.pageId), ["p1", "p2"]);
    ok("延期：見つからない番号を知らせる", r.text.includes("7番は見つかりませんでした"));
    eq("延期：変えた件数", r.changed, 2);
  }
  {
    const { deps, updates } = fakeDeps({ 4: { id: "p4", title: "案内の準備" } });
    const r = await applyStatusCommand({ kind: "drop", numbers: [4] }, deps);
    eq("不要：完了・終わり方＝不要で書く", updates[0].props, closeProps("不要"));
    ok("不要：記録が残ることを返す", r.text.includes("記録は残ります"));
  }
  {
    const { deps, updates } = fakeDeps({});
    const text = await applyStatusToTask(
      { kind: "wait", note: "銀行の回答", date: null },
      { id: "q1", title: "ローンの確認" },
      deps
    );
    eq("引用リプライ：その 1 件に書く", updates, [
      { pageId: "q1", props: waitProps("銀行の回答", "2026-10-15") },
    ]);
    ok("引用リプライ：返事に題名が入る", text.includes("ローンの確認"));
  }
  {
    const { deps } = fakeDeps({ 3: { id: "p3", title: "見積を送る" } });
    deps.update = async () => {
      throw new Error("notion down");
    };
    let threw = false;
    try {
      await applyStatusCommand({ kind: "drop", numbers: [3] }, deps);
    } catch {
      threw = true;
    }
    ok("Notion の失敗は握りつぶさず呼び出し側へ投げる", threw);
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
})();
