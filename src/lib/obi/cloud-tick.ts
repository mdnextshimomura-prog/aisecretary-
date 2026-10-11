/**
 * クラウド配達の毎分の見回り（設計 2026-10-11 の C1〜C3・C11、約束 2026-10-11-obi-cloud-contract.md の「K4 の見回り」）。
 * このファイルは、見回りの本体（差し込み口の型・時間の線の定数・時間の部品は cloud-const.ts）。
 * 時計・portal・KV・LINE・乱数・ログ・途中で止める差し込み口は、すべて引数（CloudDeps）で受け取る。
 */
import { CloudHalt, newTickCtx, type CloudTickInput } from "./cloud-const";
import { runCompletion } from "./cloud-deliver";
import { runNotices, runSeed } from "./cloud-notice";

// 差し込み口の型・時間の線の定数・時間の部品は cloud-const.ts（ここからも、そのまま使える）
export * from "./cloud-const";

export type CloudTickBody =
  | { skipped: "locked" }
  | {
      delivered: number;
      notSent: number;
      unknown: number;
      notices: number;
      seeded: boolean;
      completionSkipped?: "config";
      problems?: string[];
    };

/**
 * 見回りの本体。順番：錠 → 控えの片付け → 完成の配達（2件まで。完成の設定があるときだけ）
 * → 種まき（まだなら。その回は知らせを送らない）→ 知らせ（3通まで）→ 錠を外す。
 * 合言葉・スイッチ・共通の設定は、入口（cloud-entry.ts）が先に見る。
 * 二重を防ぐ正は portal の予約。錠は効率のため（効かなくても二重にはならない）。
 */
export async function runCloudTick(input: CloudTickInput): Promise<CloudTickBody> {
  const { deps } = input;
  let locked: boolean;
  try {
    locked = await deps.store.acquireLock();
  } catch {
    deps.log("lock-error"); // KV が読めない。何もしない
    return { skipped: "locked" };
  }
  if (!locked) return { skipped: "locked" };

  const ctx = newTickCtx(input);
  if (!input.completion.ok) deps.log(`completion-config-missing ${input.completion.problems.join(",")}`);
  try {
    await runCompletion(ctx);
    if ((await runSeed(ctx)) === "go") await runNotices(ctx);
  } catch (err) {
    // 途中で止める試験（CloudHalt）は、錠も外さずにそのまま外へ出す＝関数が落ちたのと同じ場面にする
    if (err instanceof CloudHalt) throw err;
    // そのほかの例外は、錠を外してから投げ直す（ログは入口が1行だけ出す。例外の文はどこにも出さない）
    try {
      await deps.store.releaseLock();
    } catch {
      /* 90秒で消える */
    }
    throw err;
  }
  try {
    await deps.store.releaseLock();
  } catch {
    deps.log("lock-release-failed"); // 90秒で消える
  }
  const body: CloudTickBody = { ...ctx.counts };
  if (!input.completion.ok) {
    body.completionSkipped = "config";
    body.problems = [...input.completion.problems];
  }
  return body;
}
