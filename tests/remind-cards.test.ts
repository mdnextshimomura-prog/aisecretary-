/**
 * 朝のリマインドのカード（TASK_REMIND_CARDS・2026-11-10）
 * 実行: tsx tests/remind-cards.test.ts
 */
import assert from "node:assert/strict";
import {
  buildRemindCarousel,
  sendRemindCards,
  remindCardsActive,
  REMIND_REST_TITLE,
} from "../src/lib/remind-cards";
import { cardActions, FLEX_LABEL_MAX } from "../src/lib/task-card";

let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`NG  ${name}`);
    console.error(e);
  }
}

const ENV_KEYS = [
  "TASK_REMIND_CARDS",
  "TASK_BUTTONS",
  "TASK_FOLLOWUP",
  "TASK_MENU",
];
function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env))
    if (v !== undefined) process.env[k] = v;
  try {
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const task = (
  i: number,
  extra: Partial<{
    title: string;
    dueDate: string;
    assignee: string | null;
  }> = {},
) => ({
  id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  title: extra.title ?? `タスク${i}`,
  dueDate: extra.dueDate ?? "2026-11-10",
  assignee: extra.assignee === undefined ? "山田" : extra.assignee,
});

type Bubble = {
  body: { contents: Array<{ text?: string }> };
  footer?: unknown;
};
const bubbles = (c: { contents: unknown }) =>
  (c.contents as { contents: Bubble[] }).contents;
const titleOf = (b: Bubble) => b.body.contents[0].text;

const ON = { TASK_REMIND_CARDS: "1", TASK_BUTTONS: "1", TASK_FOLLOWUP: "1" };

test("スイッチ：3つとも 1 のときだけ動く", () => {
  withEnv(ON, () => assert.equal(remindCardsActive(), true));
  withEnv({ ...ON, TASK_REMIND_CARDS: undefined }, () =>
    assert.equal(remindCardsActive(), false),
  );
  withEnv({ ...ON, TASK_BUTTONS: undefined }, () =>
    assert.equal(remindCardsActive(), false),
  );
  withEnv({ ...ON, TASK_FOLLOWUP: undefined }, () =>
    assert.equal(remindCardsActive(), false),
  );
  withEnv({ ...ON, TASK_REMIND_CARDS: "true" }, () =>
    assert.equal(remindCardsActive(), false),
  );
});

test("0件ならカードを作らない", () => {
  withEnv(ON, () => assert.equal(buildRemindCarousel([]), undefined));
});

test("文字の一覧と同じ順・同じ番号を題名の頭に付ける", () => {
  withEnv(ON, () => {
    const card = buildRemindCarousel([task(1), task(2), task(3)])!;
    const bs = bubbles(card);
    assert.equal(bs.length, 3);
    assert.equal(titleOf(bs[0]), "1. タスク1");
    assert.equal(titleOf(bs[2]), "3. タスク3");
    assert.match(card.altText, /本日のリマインド/);
  });
});

test("各カードに今のタスクのボタン（済・待ち・延期・不要・担当を変える）が付き、data にそのタスクの ID が入る", () => {
  withEnv(ON, () => {
    const card = buildRemindCarousel([task(7)])!;
    const acts = cardActions({
      type: "flex",
      altText: "x",
      contents: bubbles(card)[0],
    });
    assert.equal(acts.length, 5);
    for (const a of acts) assert.ok(a.data.includes(task(7).id), a.data);
    for (const a of acts) assert.ok(a.label.length <= FLEX_LABEL_MAX);
  });
});

test("11件以上：10枚＋「残り」のカード。メニューが on なら［今日・期限切れ］ボタン", () => {
  withEnv({ ...ON, TASK_MENU: "1" }, () => {
    const card = buildRemindCarousel(
      Array.from({ length: 13 }, (_, i) => task(i + 1)),
    )!;
    const bs = bubbles(card);
    assert.equal(bs.length, 11);
    assert.equal(titleOf(bs[9]), "10. タスク10");
    const rest = bs[10];
    assert.equal(titleOf(rest), REMIND_REST_TITLE);
    assert.ok(JSON.stringify(rest).includes("残り3件"));
    const acts = cardActions({ type: "flex", altText: "x", contents: rest });
    assert.equal(acts.length, 1);
    assert.equal(acts[0].data, "v1|lt|0");
  });
});

test("11件以上でメニューが off：「残り」のカードにボタンを付けない（番号での返信を案内）", () => {
  withEnv(ON, () => {
    const card = buildRemindCarousel(
      Array.from({ length: 12 }, (_, i) => task(i + 1)),
    )!;
    const rest = bubbles(card)[10];
    assert.equal(rest.footer, undefined);
    assert.ok(JSON.stringify(rest).includes("番号で返信"));
  });
});

test("ちょうど10件なら「残り」のカードは付けない", () => {
  withEnv({ ...ON, TASK_MENU: "1" }, () => {
    const card = buildRemindCarousel(
      Array.from({ length: 10 }, (_, i) => task(i + 1)),
    )!;
    assert.equal(bubbles(card).length, 10);
  });
});

test("長い題名・担当なし・期日なしでも作れて、JSON が 30KB 未満", () => {
  withEnv({ ...ON, TASK_MENU: "1" }, () => {
    const long = "あ".repeat(500);
    const card = buildRemindCarousel(
      Array.from({ length: 30 }, (_, i) =>
        task(i + 1, { title: long, assignee: null, dueDate: "" }),
      ),
    )!;
    assert.ok(
      Buffer.byteLength(JSON.stringify(card.contents), "utf8") < 30_000,
    );
    const bs = bubbles(card);
    assert.ok(bs.length >= 2);
    // 載せきれなかった分は「残り」に数える
    const shown = bs.length - 1;
    assert.ok(
      JSON.stringify(bs[bs.length - 1]).includes(`残り${30 - shown}件`),
    );
  });
});


const asyncTests: Array<[string, () => Promise<void>]> = [];
function atest(name: string, fn: () => Promise<void>) {
  asyncTests.push([name, fn]);
}
async function withEnvAsync(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try {
    await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

atest("送信：off なら LINE を呼ばない", async () => {
  await withEnvAsync({ ...ON, TASK_REMIND_CARDS: undefined }, async () => {
    let called = 0;
    const logs: string[] = [];
    const r = await sendRemindCards("G", [task(1)], async () => (called++, true), (l) => logs.push(l));
    assert.equal(r, "off");
    assert.equal(called, 0);
    assert.deepEqual(logs, []);
  });
});

atest("送信：0件なら呼ばない", async () => {
  await withEnvAsync(ON, async () => {
    let called = 0;
    const r = await sendRemindCards("G", [], async () => (called++, true), () => {});
    assert.equal(r, "empty");
    assert.equal(called, 0);
  });
});

atest("送信：成功で1行だけ（件数だけ。題名・ID は出さない）", async () => {
  await withEnvAsync(ON, async () => {
    const logs: string[] = [];
    let to = "";
    const r = await sendRemindCards("G1", [task(1), task(2)], async (t) => ((to = t), true), (l) => logs.push(l));
    assert.equal(r, "shown");
    assert.equal(to, "G1");
    assert.deepEqual(logs, ["[remind] cards shown 2"]);
  });
});

atest("送信：LINE が断った・例外でも投げずに failed を1行", async () => {
  await withEnvAsync(ON, async () => {
    const logs: string[] = [];
    assert.equal(await sendRemindCards("G", [task(1)], async () => false, (l) => logs.push(l)), "failed");
    assert.equal(
      await sendRemindCards("G", [task(1)], async () => { throw new Error("x"); }, (l) => logs.push(l)),
      "failed",
    );
    assert.deepEqual(logs, ["[remind] cards push-failed", "[remind] cards push-failed"]);
  });
});

(async () => {
  for (const [name, fn] of asyncTests) {
    try {
      await fn();
      console.log(`ok  ${name}`);
    } catch (e) {
      failed++;
      console.error(`NG  ${name}`);
      console.error(e);
    }
  }
if (failed > 0) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log("\nremind-cards: all ok");
})();
