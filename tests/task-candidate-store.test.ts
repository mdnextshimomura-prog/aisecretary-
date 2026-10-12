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
  assigneeUserId: null,
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
  const ids = (l: Array<Candidate | null>) => l.map((c) => c?.id ?? null);
  eq("番号を振る", ids(await s.numberCandidates(NOW)), ["m1", "m2"]);
  await s.addCandidate(cand("m3"), NOW);
  eq("後から届いた分は、次に番号を振るまで入らない", ids(await s.getNumbered()), ["m1", "m2"]);

  eq("1 番を見る（消さない）", (await s.peekCandidate(1, NOW))?.id, "m1");
  eq("見ただけでは残る", (await s.peekCandidate(1, NOW))?.id, "m1");
  await s.removeCandidate(1);
  eq("片付けた番号は見えない", await s.peekCandidate(1, NOW), null);
  eq("番号はずれない", (await s.peekCandidate(2, NOW))?.id, "m2");
  eq("無い番号", await s.peekCandidate(9, NOW), null);
  eq("片付けた分は一覧からも消える", ids(await s.listCandidates(NOW)), ["m2", "m3"]);

  eq(
    "一覧を出し直しても番号は変わらず、新しい分が後ろに付く",
    ids(await s.numberCandidates(NOW)),
    [null, "m2", "m3"],
  );
  eq(
    "期限が切れた分は番号が空く",
    ids(await s.numberCandidates(NOW + 6 * DAY)),
    [],
  );
  await s.addCandidate(cand("m9", NOW + 6 * DAY), NOW + 6 * DAY);
  eq(
    "全部片付いた後は 1 番から振り直す",
    ids(await s.numberCandidates(NOW + 6 * DAY)),
    ["m9"],
  );
  eq("期限切れの候補は番号が残っていても取れない", await s.peekCandidate(1, NOW + 12 * DAY), null);

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
