import {
  dueTickEnabled,
  dueTickSlot,
  runDueRemindersOnTick,
  type DueTickDeps,
} from "../src/lib/remind-due";

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (JSON.stringify(a) === JSON.stringify(b)) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} → ${JSON.stringify(a)}`);
  }
};

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 9, 13, 7, 0); // 16:00 JST

function fake(taken: number[] = []) {
  const calls: string[] = [];
  const seen = new Set(taken);
  const deps: DueTickDeps = {
    claim: async (slot) => {
      calls.push("claim");
      if (seen.has(slot)) return false;
      seen.add(slot);
      return true;
    },
    run: async () => {
      calls.push("run");
      return { checked: 2, sent: 1 };
    },
  };
  return { deps, calls };
}

(async () => {
  eq("スイッチ：1 のときだけ on", [dueTickEnabled({}), dueTickEnabled({ DUE_REMIND_TICK: "0" }), dueTickEnabled({ DUE_REMIND_TICK: "1" })], [false, false, true]);
  eq("枠：同じ 10 分は同じ番号", dueTickSlot(T0) === dueTickSlot(T0 + 9 * MIN), true);
  eq("枠：10 分たつと次の番号", dueTickSlot(T0 + 10 * MIN) - dueTickSlot(T0), 1);
  {
    const f = fake();
    eq("off：枠も取らず、何もしない", [await runDueRemindersOnTick(T0, {}, f.deps), f.calls], ["off", []]);
  }
  {
    const f = fake();
    const env = { DUE_REMIND_TICK: "1" };
    const out = [
      await runDueRemindersOnTick(T0, env, f.deps),
      await runDueRemindersOnTick(T0 + MIN, env, f.deps),
      await runDueRemindersOnTick(T0 + 9 * MIN, env, f.deps),
      await runDueRemindersOnTick(T0 + 10 * MIN, env, f.deps),
    ];
    eq("毎分呼ばれても、10 分に 1 回だけ動く", out, ["ran", "skip", "skip", "ran"]);
    eq("動いた回数は 2", f.calls.filter((c) => c === "run").length, 2);
  }
  {
    const f = fake([dueTickSlot(T0)]);
    eq("別の見回りが先に枠を取っていたら動かない", [await runDueRemindersOnTick(T0, { DUE_REMIND_TICK: "1" }, f.deps), f.calls], ["skip", ["claim"]]);
  }
  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
})();
