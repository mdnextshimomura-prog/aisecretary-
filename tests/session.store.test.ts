/**
 * 確認待ちの保存まわりのテスト（KV未設定＝メモリ経路で回す・API不要）。
 *
 * ここはレビューで「件数が増えると回答待ちが黙って消える」「同時到達で
 * 二重登録される」と指摘された箇所。実際に多件・再入で確かめる。
 */
import {
  savePendingTaskConfirm,
  getPendingTaskConfirm,
  deletePendingTaskConfirm,
  countPendingTaskConfirms,
  reserveMessage,
  releaseMessage,
  completeMessage,
  addPendingHandoff,
  getPendingHandoffs,
  removePendingHandoff,
  type PendingTaskConfirm,
} from "../src/lib/email/session";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) { fail++; console.log(`❌ ${name} ${d}`); } else console.log(`✅ ${name} ${d}`);
};

const G = "Gtest";
const mk = (n: number): PendingTaskConfirm => ({
  pageId: `page-${n}`,
  title: `タスク${n}`,
  requestType: "購入申込書",
  fields: [{ key: "price", label: "購入金額", suggest: null, critical: true }],
  awaitingKeys: ["price"],
  proposalKeys: [],
  settled: {},
  botMessageId: `msg-${n}`,
  createdAt: 1000 + n,
});

async function main() {
  // ── 多件でも古いものが消えない（索引上限を超えても pageId で引ける）──
  for (let i = 1; i <= 60; i++) await savePendingTaskConfirm(G, mk(i));
  const first = await getPendingTaskConfirm(G, null, "page-1");
  ok("60件保存しても1件目が引ける", first?.pageId === "page-1", `got=${first?.pageId}`);
  const last = await getPendingTaskConfirm(G, null, "page-60");
  ok("最新も引ける", last?.pageId === "page-60");

  // ── 引用なしなら直近 ──
  const latest = await getPendingTaskConfirm(G);
  ok("引用なしは直近を返す", latest?.pageId === "page-60", `got=${latest?.pageId}`);

  // ── Botの確認メッセージIDで特定できる ──
  const byMsg = await getPendingTaskConfirm(G, "msg-55", null);
  ok("確認メッセージIDで特定", byMsg?.pageId === "page-55", `got=${byMsg?.pageId}`);

  // ── 別タスクの保存が既存を壊さない ──
  await savePendingTaskConfirm(G, { ...mk(1), title: "更新済み" });
  const again = await getPendingTaskConfirm(G, null, "page-1");
  ok("同一pageIdは差し替え", again?.title === "更新済み");
  ok("他タスクは無傷", (await getPendingTaskConfirm(G, null, "page-2"))?.pageId === "page-2");

  // ── 削除 ──
  // 索引外（古くて一覧から溢れた）のタスクも、pageId 指定で確実に消せること
  await deletePendingTaskConfirm(G, "page-2");
  ok("索引外のタスクも削除できる", (await getPendingTaskConfirm(G, null, "page-2")) === null);

  const before = await countPendingTaskConfirms(G);
  await deletePendingTaskConfirm(G, "page-59");
  ok("削除される", (await getPendingTaskConfirm(G, null, "page-59")) === null);
  ok("件数が減る", (await countPendingTaskConfirms(G)) === before - 1,
    `${before} -> ${await countPendingTaskConfirms(G)}`);

  // ── メッセージIDの予約（二重登録防止）──
  ok("初回は予約できる", (await reserveMessage("m-1")).proceed === true);
  ok("2回目は予約できない", (await reserveMessage("m-1")).proceed === false);
  // 同時到達の再現：同じIDで並行に予約を試す → 1つだけ通る
  const results = await Promise.all(
    Array.from({ length: 8 }, () => reserveMessage("m-concurrent"))
  );
  ok("同時8件で予約できるのは1つだけ",
    results.filter((r) => r.proceed).length === 1,
    `通過=${results.filter((r) => r.proceed).length}`);

  // 登録完了を記録したら、再送はページIDを添えて止まる
  await completeMessage("m-1", "page-created");
  const after = await reserveMessage("m-1");
  ok("完了後は進めない", after.proceed === false);
  ok("既存ページIDを返す", after.pageId === "page-created", `got=${after.pageId}`);

  // 登録に失敗したときは解放して再送でやり直せる
  await releaseMessage("m-1");
  ok("解放後は再度予約できる", (await reserveMessage("m-1")).proceed === true);

  // ── 引き渡しの再送待ち ──
  await addPendingHandoff(G, mk(90));
  ok("再送待ちに積める", (await getPendingHandoffs(G)).some((v) => v.pageId === "page-90"));
  await removePendingHandoff(G, "page-90");
  ok("送れたら消える", !(await getPendingHandoffs(G)).some((v) => v.pageId === "page-90"));

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
