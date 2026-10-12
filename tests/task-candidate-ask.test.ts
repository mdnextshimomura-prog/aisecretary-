import {
  askCandidatesIfDue,
  type AskDeps,
} from "../src/lib/task-candidate-ask";
import type { Candidate } from "../src/lib/task-candidate";

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (JSON.stringify(a) === JSON.stringify(b)) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} → ${JSON.stringify(a)}`);
  }
};

const cand: Candidate = {
  id: "m1",
  text: "見積書を送付お願いします",
  title: "見積書の送付",
  assignee: null,
  assigneeUserId: null,
  senderId: "U_A",
  createdAt: 0,
};
// 2026-10-12 17:05 JST
const AT_17 = Date.UTC(2026, 9, 12, 8, 5);
const AT_15 = Date.UTC(2026, 9, 12, 6, 5);

function fake(
  opts: { claimed?: boolean; list?: Candidate[]; pushOk?: boolean } = {},
) {
  const calls: string[] = [];
  const sent: Array<{ to: string; text: string }> = [];
  const deps: AskDeps = {
    claim: async (d) => {
      calls.push(`claim:${d}`);
      return !opts.claimed;
    },
    number: async () => {
      calls.push("number");
      return opts.list ?? [cand];
    },
    push: async (to, text) => {
      calls.push("push");
      sent.push({ to, text });
      return opts.pushOk ?? true;
    },
  };
  return { deps, calls, sent };
}

(async () => {
  delete process.env.TASK_CANDIDATES;
  {
    const f = fake();
    eq(
      "スイッチ off：何もしない",
      [await askCandidatesIfDue(AT_17, f.deps, "G", "2026-10-12"), f.calls],
      ["off", []],
    );
  }
  process.env.TASK_CANDIDATES = "1";
  {
    const f = fake();
    eq(
      "17 時台でない：何もしない",
      [await askCandidatesIfDue(AT_15, f.deps, "G", "2026-10-12"), f.calls],
      ["not-time", []],
    );
  }
  {
    const f = fake();
    eq(
      "送り先が無い：何もしない",
      [
        await askCandidatesIfDue(AT_17, f.deps, undefined, "2026-10-12"),
        f.calls,
      ],
      ["no-group", []],
    );
  }
  {
    const f = fake({ claimed: true });
    eq(
      "今日はもう聞いた：番号も振らない",
      [await askCandidatesIfDue(AT_17, f.deps, "G", "2026-10-12"), f.calls],
      ["already", ["claim:2026-10-12"]],
    );
  }
  {
    const f = fake({ list: [] });
    eq(
      "候補が無い：送らない",
      [await askCandidatesIfDue(AT_17, f.deps, "G", "2026-10-12"), f.calls],
      ["empty", ["claim:2026-10-12", "number"]],
    );
  }
  {
    const f = fake();
    const r = await askCandidatesIfDue(AT_17, f.deps, "G", "2026-10-12");
    eq(
      "聞く：会社グループへ 1 通",
      [
        r,
        f.sent.length,
        f.sent[0].to,
        f.sent[0].text.includes("1. 見積書の送付"),
      ],
      ["sent", 1, "G", true],
    );
  }
  {
    const f = fake({ pushOk: false });
    eq(
      "送信に失敗",
      await askCandidatesIfDue(AT_17, f.deps, "G", "2026-10-12"),
      "send-failed",
    );
  }
  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
})();
