// KV の環境変数が無い＝メモリの置き場で動かす
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

import type { Candidate } from "../src/lib/task-candidate";

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (JSON.stringify(a) === JSON.stringify(b)) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} → ${JSON.stringify(a)}`);
  }
};

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const cand = (id: string, createdAt = NOW): Candidate => ({
  id,
  text: `${id} の本文`,
  title: `${id} の題名`,
  assignee: null,
  senderId: "U_A",
  createdAt,
});

(async () => {
  const s = await import("../src/lib/task-candidate-store");
  s._resetMemoryForTest();

  eq("最初は空", await s.listCandidates(NOW), []);
  eq("控える", await s.addCandidate(cand("m1"), NOW), true);
  eq("同じ発言は 2 度控えない", await s.addCandidate(cand("m1"), NOW), false);
  await s.addCandidate(cand("m2"), NOW);
  await s.addCandidate(cand("old", NOW - 6 * DAY), NOW);
  eq(
    "期限切れは一覧に出ない",
    (await s.listCandidates(NOW)).map((c) => c.id),
    ["m1", "m2"],
  );

  eq("聞く前は番号の一覧が無い", await s.getNumbered(), []);
  eq(
    "番号を振る",
    (await s.numberCandidates(NOW)).map((c) => c.id),
    ["m1", "m2"],
  );
  // 聞いた後に新しく届いた候補は、次に聞くまで番号が付かない
  await s.addCandidate(cand("m3"), NOW);
  eq(
    "後から届いた分は番号の一覧に入らない",
    (await s.getNumbered()).map((c) => c?.id ?? null),
    ["m1", "m2"],
  );

  eq("1 番を取り出す", (await s.takeCandidate(1))?.id, "m1");
  eq("同じ番号は 2 度取れない", await s.takeCandidate(1), null);
  eq("番号はずれない", (await s.takeCandidate(2))?.id, "m2");
  eq("無い番号", await s.takeCandidate(9), null);
  eq(
    "取り出した分は一覧からも消える",
    (await s.listCandidates(NOW)).map((c) => c.id),
    ["m3"],
  );

  await s.putBackCandidate(2, cand("m2"));
  eq("戻すと同じ番号でまた取れる", (await s.takeCandidate(2))?.id, "m2");

  eq("その日の 1 回目は聞く", await s.claimDailyAsk("2026-10-12"), true);
  eq("同じ日の 2 回目は聞かない", await s.claimDailyAsk("2026-10-12"), false);
  eq("次の日は聞く", await s.claimDailyAsk("2026-10-13"), true);

  // 多すぎるときは古いものから落とす
  s._resetMemoryForTest();
  for (let i = 0; i < 35; i++) await s.addCandidate(cand(`n${i}`), NOW);
  const all = await s.listCandidates(NOW);
  eq("30 件まで", [all.length, all[0].id, all[29].id], [30, "n5", "n34"]);

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
})();
