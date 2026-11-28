/** 担当へのまとめ（段階2・2026-11-28）：STAFF_DIGEST=1 のとき、朝夕の知らせを「担当ごとの箇条書き」にする。off は今までどおり */
import assert from "node:assert/strict";

process.env.LINE_CHANNEL_ACCESS_TOKEN = "t";
let n = 0;
const t = async (name: string, f: () => Promise<void> | void) => { await f(); n++; console.log("ok", name); };

const U1 = "U" + "1".repeat(32);
const G = "C" + "a".repeat(32);
const TODAY = "2026-11-28";
const TOMORROW = "2026-11-29";
// 2026-11-28 17:05 JST
const EVE = Date.UTC(2026, 10, 28, 8, 5);
const MIN = 60_000;

type Row = {
  id: string; title: string; dueDate: string; status: string;
  assignee: string | null; assigneeUserId: string | null; note: string;
  propertyName: string | null; remindNumber: number | null;
};
const row = (id: string, title: string, dueDate: string, over: Partial<Row> = {}): Row => ({
  id, title, dueDate, status: "未着手", assignee: null, assigneeUserId: null, note: "", propertyName: null, remindNumber: null, ...over,
});
const OGA = { assignee: "小笠原", assigneeUserId: U1 };
const SAMPLE: Row[] = [
  row("a", "天満の資料を送る", "2026-11-26", { ...OGA, propertyName: "天満ハイツ" }),
  row("b", "鍵の手配", "2026-12-03"),
  row("c", "査定書を作る", "2026-11-29T15:00:00+09:00", { assignee: "山口" }),
  row("d", "売主へ電話", "2026-11-28", { ...OGA, note: "売主の書類" }),
  row("e", "看板の確認", ""),
];

(async () => {
  const D = await import("../src/lib/staff-digest");
  const { buildChunks } = await import("../src/lib/chunk");

  await t("スイッチ：1 のときだけ on", () => {
    assert.deepEqual([D.staffDigestOn({}), D.staffDigestOn({ STAFF_DIGEST: "0" }), D.staffDigestOn({ STAFF_DIGEST: "1" })], [false, false, true]);
  });

  await t("buildChunks：mentionFirst を付けなければ今までどおり（メンションは行の末尾）。付ければ行の頭", () => {
    const old = buildChunks("H", [{ text: "1. a", userId: U1 }], "F");
    assert.deepEqual(old, [{ text: "H\n\n1. a {m1}F", mentions: { m1: U1 } }]);
    const head = buildChunks("H", [{ text: "どうなりましたか？", userId: U1, mentionFirst: true }], "F");
    assert.deepEqual(head, [{ text: "H\n\n{m1} どうなりましたか？F", mentions: { m1: U1 } }]);
  });

  await t("朝：担当ごとにまとめ、通し番号を振る（担当なしは最後）", () => {
    const d = D.buildStaffDigest({ slot: "am", tasks: SAMPLE, today: TODAY, tomorrow: TOMORROW, followup: true });
    assert.equal(d.chunks.length, 1);
    assert.equal(
      d.chunks[0].text,
      [
        "📋 進捗の確認です",
        "",
        "{m1} どうなりましたか？",
        "1. 天満の資料を送る（2日超過）［天満ハイツ］",
        "2. 売主へ電話（本日期限）（待ち：売主の書類）",
        "",
        "山口さん どうなりましたか？",
        "3. 査定書を作る（明日期限）",
        "",
        "担当が決まっていないもの：どうしますか？",
        "4. 鍵の手配（期日 12/3）",
        "5. 看板の確認（期日なし）",
        "",
        "──────────",
        "このメッセージに返信（リプライ）で、番号をつけて答えてください",
        "例：「1済」「1,2完了」",
        "相手待ち：「2待ち 売主の書類 金曜」",
        "期日を変える：「3延期 10/20」",
        "やらなくてよい：「3不要」",
        "進み具合を書く：「3 アポ取れました。来週火曜です」（番号のあとに空白）",
      ].join("\n")
    );
    assert.deepEqual(d.chunks[0].mentions, { m1: U1 });
    assert.deepEqual(d.ordered.map((o) => [o.task.id, o.n]), [["a", 1], ["d", 2], ["c", 3], ["b", 4], ["e", 5]]);
  });

  await t("夕方：見出しが変わる。渡した番号をそのまま使い、担当の中は番号の小さい順", () => {
    const numbers = new Map([["a", 4], ["d", 1], ["b", 7]]);
    const d = D.buildStaffDigest({ slot: "eve", tasks: [SAMPLE[0], SAMPLE[1], SAMPLE[3]], today: TODAY, tomorrow: TOMORROW, followup: true, numbers });
    const lines = d.chunks[0].text.split("\n");
    assert.equal(lines[0], "📋 夕方の進捗の確認です");
    assert.deepEqual(lines.slice(2, 5), ["{m1} どうなりましたか？", "1. 売主へ電話（本日期限）（待ち：売主の書類）", "4. 天満の資料を送る（2日超過）［天満ハイツ］"]);
    assert.equal(lines[7], "7. 鍵の手配（期日 12/3）");
  });

  await t("文の細部：{ } は全角に・TASK_FOLLOWUP off は待ちと例を出さない・題名に物件名があれば重ねない・要確認は「回答待ち」", () => {
    const d = D.buildStaffDigest({
      slot: "am",
      today: TODAY,
      tomorrow: TOMORROW,
      followup: false,
      tasks: [
        row("x", "{m1}の件", TODAY, { note: "先方{待ち}", propertyName: "A{B}" }),
        row("y", "天満ハイツの鍵", TODAY, { propertyName: "天満ハイツ" }),
        row("z", "条件の確認", TODAY, { status: "要確認" }),
      ],
    });
    const text = d.chunks[0].text;
    assert.ok(text.includes("1. （m1）の件（本日期限）［A（B）］\n2. 天満ハイツの鍵（本日期限）\n3. 条件の確認（回答待ち）"));
    assert.ok(!text.includes("待ち："));
    assert.ok(text.endsWith("例：「1済」「1,2完了」\n進み具合を書く：「3 アポ取れました。来週火曜です」（番号のあとに空白）"));
    assert.deepEqual(d.chunks[0].mentions, {});
  });

  await t("同じ担当は userId のある行・無い行が混ざっても1つにまとめ、メンションする", () => {
    const d = D.buildStaffDigest({
      slot: "am", today: TODAY, tomorrow: TOMORROW, followup: true,
      tasks: [row("p", "一", TODAY, { assignee: "小笠原" }), row("q", "二", TODAY, OGA)],
    });
    assert.equal(d.chunks[0].text.split("どうなりましたか？").length, 2);
    assert.deepEqual(d.chunks[0].mentions, { m1: U1 });
  });

  await t("夕方の対象：朝の番号が残っているもの＋本日期限・期限超過。明日以降で番号なしは出さない", () => {
    const picked = D.selectEvening(
      [
        row("a", "超過", "2026-11-20"),
        row("b", "本日", TODAY),
        row("c", "明日・朝に出した", TOMORROW, { remindNumber: 3 }),
        row("d", "明日・今日入った", TOMORROW),
        row("e", "期日なし・今日入った", ""),
      ],
      TODAY,
      TOMORROW
    );
    assert.deepEqual(picked.map((p) => p.id), ["a", "b", "c"]);
  });

  await t("夕方の番号：朝の番号はそのまま。無いもの・重なったものだけ、いちばん大きい番号の次から振る", () => {
    const sel = [row("a", "a", TODAY, { remindNumber: 2 }), row("b", "b", TODAY), row("c", "c", TODAY, { remindNumber: 2 }), row("d", "d", TODAY, { remindNumber: 5 })];
    const all = [...sel, row("z", "載せないが番号あり", TOMORROW, { remindNumber: 9 })];
    const r = D.assignEveningNumbers(sel, all);
    assert.deepEqual(Array.from(r.numbers.entries()), [["a", 2], ["d", 5], ["b", 10], ["c", 11]]);
    assert.deepEqual(r.fresh, [{ id: "b", n: 10 }, { id: "c", n: 11 }]);
  });

  // ── 夕方の見回り ──
  function fake(over: { tasks?: Row[] | (() => Promise<Row[]>); closed?: boolean; taken?: string[] } = {}) {
    const calls: string[] = [];
    const logs: string[] = [];
    const claimed = new Set(over.taken ?? []);
    const pushed: Array<{ text: string; mentions: Record<string, string> }[]> = [];
    const saved: Array<[string[], string, number]> = [];
    const numbered: Array<[string, number]> = [];
    const deps = {
      followup: true,
      claim: async (day: string) => { calls.push("claim"); if (claimed.has(day)) return false; claimed.add(day); return true; },
      release: async (day: string) => { calls.push("release"); claimed.delete(day); },
      closedToday: async () => { calls.push("closed?"); return over.closed ?? false; },
      fetchTasks: async () => { calls.push("fetch"); return typeof over.tasks === "function" ? over.tasks() : (over.tasks ?? []); },
      setNumber: async (id: string, num: number) => { numbered.push([id, num]); },
      push: async (chunks: { text: string; mentions: Record<string, string> }[]) => { calls.push("push"); pushed.push(chunks); return { sent: chunks.length, ids: chunks.map((_, i) => `mid${i}`) }; },
      saveIds: async (ids: string[], slot: string, now: number) => { saved.push([ids, slot, now]); },
      log: (l: string) => { logs.push(l); },
    };
    return { deps, calls, logs, pushed, saved, numbered, claimed };
  }
  const ON = { STAFF_DIGEST: "1" };
  const EVE_TASKS = [row("a", "天満の資料を送る", "2026-11-26", { ...OGA, remindNumber: 1 }), row("b", "今日入った本日期限", TODAY)];

  await t("off：KV も Notion も触らない", async () => {
    const f = fake({ tasks: EVE_TASKS });
    assert.equal(await D.runStaffDigestEveningOnTick(EVE, {}, f.deps), "off");
    assert.deepEqual([f.calls, f.logs], [[], []]);
  });

  await t("17時台でなければ何もしない（16:59・18:00）", async () => {
    const f = fake({ tasks: EVE_TASKS });
    assert.equal(await D.runStaffDigestEveningOnTick(EVE - 6 * MIN, ON, f.deps), "skip");
    assert.equal(await D.runStaffDigestEveningOnTick(EVE + 55 * MIN, ON, f.deps), "skip");
    assert.deepEqual(f.calls, []);
  });

  await t("17時台に毎分呼ばれても1日1回だけ送る。番号は無いものだけ振り、ID を控える。次の日はまた送る", async () => {
    const f = fake({ tasks: EVE_TASKS });
    const out = [
      await D.runStaffDigestEveningOnTick(EVE, ON, f.deps),
      await D.runStaffDigestEveningOnTick(EVE + MIN, ON, f.deps),
      await D.runStaffDigestEveningOnTick(EVE + 30 * MIN, ON, f.deps),
    ];
    assert.deepEqual(out, ["sent", "taken", "taken"]);
    assert.equal(f.pushed.length, 1);
    assert.ok(f.pushed[0][0].text.startsWith("📋 夕方の進捗の確認です\n\n{m1} どうなりましたか？\n1. 天満の資料を送る（2日超過）\n\n担当が決まっていないもの：どうしますか？\n2. 今日入った本日期限（本日期限）"));
    assert.deepEqual(f.numbered, [["b", 2]]);
    assert.deepEqual(f.saved, [[["mid0"], "eve", EVE]]);
    assert.deepEqual(Array.from(f.claimed), ["2026-11-28"]);
    assert.deepEqual(f.logs, ["[staff-digest] eve sent 2"]);
    assert.equal(await D.runStaffDigestEveningOnTick(EVE + 24 * 60 * MIN, ON, f.deps), "sent");
  });

  await t("0件なら送らない（印は付けたまま＝その日はもう調べない）", async () => {
    const f = fake({ tasks: [row("d", "明日・今日入った", TOMORROW)] });
    assert.equal(await D.runStaffDigestEveningOnTick(EVE, ON, f.deps), "empty");
    assert.equal(await D.runStaffDigestEveningOnTick(EVE + MIN, ON, f.deps), "taken");
    assert.deepEqual([f.pushed.length, f.saved.length, f.logs], [0, 0, ["[staff-digest] eve empty"]]);
  });

  await t("休業日は送らない（タスクも引かない）", async () => {
    const f = fake({ tasks: EVE_TASKS, closed: true });
    assert.equal(await D.runStaffDigestEveningOnTick(EVE, ON, f.deps), "closed");
    assert.deepEqual([f.calls, f.logs], [["claim", "closed?"], ["[staff-digest] eve closed"]]);
  });

  await t("別の見回りが先に印を付けていたら動かない", async () => {
    const f = fake({ tasks: EVE_TASKS, taken: ["2026-11-28"] });
    assert.equal(await D.runStaffDigestEveningOnTick(EVE, ON, f.deps), "taken");
    assert.deepEqual(f.calls, ["claim"]);
  });

  await t("タスクを引けなかったら印を外し、次の見回りでやり直す（送る前なので二重にならない）", async () => {
    let first = true;
    const f = fake({ tasks: async () => { if (first) { first = false; throw new Error("天満の資料 notion down"); } return EVE_TASKS; } });
    assert.equal(await D.runStaffDigestEveningOnTick(EVE, ON, f.deps), "failed");
    assert.deepEqual(f.logs, ["[staff-digest] eve fetch-failed Error"]);
    assert.equal(await D.runStaffDigestEveningOnTick(EVE + MIN, ON, f.deps), "sent");
    assert.equal(f.pushed.length, 1);
  });

  await t("段階3：夕方のまとめを送る直前に1回だけ beforeSend（いま未完了の全タスクつき）。失敗しても夕方のまとめは送る。0件・休業日は呼ばない", async () => {
    const f = fake({ tasks: EVE_TASKS });
    const seen: Array<[string, number, number]> = [];
    const fd: import("../src/lib/staff-digest").EveningDeps = { ...f.deps, beforeSend: async (day, all) => { seen.push([day, all.length, f.pushed.length]); throw new Error("x"); } };
    assert.equal(await D.runStaffDigestEveningOnTick(EVE, ON, fd), "sent");
    assert.equal(await D.runStaffDigestEveningOnTick(EVE + MIN, ON, fd), "taken");
    assert.deepEqual(seen, [["2026-11-28", EVE_TASKS.length, 0]]);
    assert.deepEqual(f.logs, ["[staff-digest] nudge ask-failed", "[staff-digest] eve sent 2"]);
    const g = fake({ tasks: [row("d", "明日・今日入った", TOMORROW)] });
    let called = 0;
    assert.equal(await D.runStaffDigestEveningOnTick(EVE, ON, { ...g.deps, beforeSend: async () => { called++; } }), "empty");
    assert.equal(called, 0);
  });

  await t("夕方の番号：朝のまとめで使った番号（朝の控え）より後ろから振る（待ち・延期で一覧から外れたタスクの番号と重ねない）", async () => {
    // 朝は 1〜5 を出した。3〜5 は待ち・延期で夕方の一覧に無いが、Notion には番号が残っている
    const r = D.assignEveningNumbers([EVE_TASKS[0], EVE_TASKS[1]], EVE_TASKS, 5);
    assert.deepEqual(r.fresh, [{ id: "b", n: 6 }]);
    // 控えが無い（0）なら足す前と同じ
    assert.deepEqual(D.assignEveningNumbers([EVE_TASKS[0], EVE_TASKS[1]], EVE_TASKS).fresh, [{ id: "b", n: 2 }]);
    const f = fake({ tasks: EVE_TASKS });
    assert.equal(await D.runStaffDigestEveningOnTick(EVE, ON, { ...f.deps, morningMax: async () => 5 }), "sent");
    assert.deepEqual(f.numbered, [["b", 6]]);
    assert.ok(f.pushed[0][0].text.includes("6. 今日入った本日期限"));
    // 朝の控えを読めなくても送る（引いてきたタスクの番号だけで決める）
    const g = fake({ tasks: EVE_TASKS });
    assert.equal(await D.runStaffDigestEveningOnTick(EVE, ON, { ...g.deps, morningMax: async () => { throw new Error("kv"); } }), "sent");
    assert.deepEqual(g.numbered, [["b", 2]]);
  });

  await t("送る前の準備が時間切れなら、印を外してやり直す（印だけ残ってその日送られない、を防ぐ）。催促のカードが遅くてもまとめは送る", async () => {
    const never = new Promise<never>(() => undefined);
    let hang = true;
    const f = fake({ tasks: () => (hang ? never : Promise.resolve(EVE_TASKS)) });
    const fd = { ...f.deps, budgetMs: 50 };
    assert.equal(await D.runStaffDigestEveningOnTick(EVE, ON, fd), "failed");
    assert.deepEqual(f.logs, ["[staff-digest] eve fetch-failed TimeoutError"]);
    assert.equal(f.claimed.size, 0);
    assert.equal(f.pushed.length, 0);
    hang = false;
    assert.equal(await D.runStaffDigestEveningOnTick(EVE + MIN, ON, fd), "sent");
    // 番号を書くのが終わらないときも同じ（まだ何も送っていない）
    const g = fake({ tasks: EVE_TASKS });
    assert.equal(await D.runStaffDigestEveningOnTick(EVE, ON, { ...g.deps, budgetMs: 50, setNumber: () => never }), "failed");
    assert.equal(g.claimed.size + g.pushed.length, 0);
    // 催促のカード（beforeSend）が返ってこなくても、待つのをやめて送る
    const h = fake({ tasks: EVE_TASKS });
    const t0 = Date.now();
    assert.equal(await D.runStaffDigestEveningOnTick(EVE, ON, { ...h.deps, budgetMs: 50, beforeSend: () => never }), "sent");
    assert.ok(Date.now() - t0 < 5_000);
    assert.deepEqual(h.logs, ["[staff-digest] nudge ask-failed", "[staff-digest] eve sent 2"]);
  });

  await t("1通も送れなかったら failed（印は残す＝送り直さない）。ID は控えない", async () => {
    const f = fake({ tasks: EVE_TASKS });
    f.deps.push = async () => ({ sent: 0, ids: [] });
    assert.equal(await D.runStaffDigestEveningOnTick(EVE, ON, f.deps), "failed");
    assert.deepEqual([f.saved.length, f.logs, Array.from(f.claimed)], [0, ["[staff-digest] eve push-failed"], ["2026-11-28"]]);
  });

  await t("ログに題名・userId・メッセージ ID を出さない", async () => {
    const f = fake({ tasks: EVE_TASKS });
    await D.runStaffDigestEveningOnTick(EVE, ON, f.deps);
    const all = f.logs.join("\n");
    assert.ok(!all.includes("天満") && !all.includes(U1) && !all.includes("mid0"));
  });

  await t("まとめのメッセージ ID の控え：staffdigest:msg:<id> = {at, slot}（3日）。ID が無ければ KV を触らない", async () => {
    const sets: Array<[string, unknown, number]> = [];
    const kv = { set: async (k: string, v: unknown, ex: number) => { sets.push([k, v, ex]); } };
    await D.saveDigestMessageIds(["111", "222"], "am", 1000, kv);
    assert.deepEqual(sets, [
      ["staffdigest:msg:111", { at: 1000, slot: "am" }, 3 * 24 * 60 * 60],
      ["staffdigest:msg:222", { at: 1000, slot: "am" }, 3 * 24 * 60 * 60],
    ]);
    sets.length = 0;
    await D.saveDigestMessageIds([], "eve", 1000, kv);
    assert.equal(sets.length, 0);
  });

  await t("朝の送信：送って ID を控え、件数だけログに出す。控えに失敗しても投げない", async () => {
    const f = fake();
    f.deps.saveIds = async () => { throw new Error("kv down"); };
    const d = D.buildStaffDigest({ slot: "am", tasks: SAMPLE, today: TODAY, tomorrow: TOMORROW, followup: true });
    const sent = await D.sendDigestChunks("am", d.chunks, d.ordered.length, 5, f.deps);
    assert.equal(sent, 1);
    assert.deepEqual(f.logs, ["[staff-digest] am ids-save-failed", "[staff-digest] am sent 5"]);
  });

  // ── line.ts：ID を返す送り方（pushLineChunks は変えない） ──
  await t("pushLineChunksWithIds：送る中身は pushLineChunks と同じで、送れた通数と ID を返す", async () => {
    const sent: string[] = [];
    let fail = false;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      sent.push(init.body);
      if (fail) return new Response("{}", { status: 400 });
      return new Response(JSON.stringify({ sentMessages: [{ id: `id${sent.length}` }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const L = await import("../src/lib/line");
    const chunks: Array<{ text: string; mentions: Record<string, string> }> = [{ text: "{m1} a", mentions: { m1: U1 } }, { text: "b", mentions: {} }];
    await L.pushLineChunks(G, chunks);
    const before = sent.splice(0);
    const r = await L.pushLineChunksWithIds(G, chunks);
    assert.deepEqual(sent, before);
    assert.deepEqual(r, { sent: 2, ids: ["id1", "id2"] });
    assert.equal(JSON.parse(sent[0]).messages[0].type, "textV2");
    assert.equal(JSON.parse(sent[1]).messages[0].type, "text");
    fail = true;
    const errs: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errs.push(a); };
    const r2 = await L.pushLineChunksWithIds(G, chunks);
    console.error = orig;
    assert.deepEqual(r2, { sent: 0, ids: [] });
    assert.ok(!JSON.stringify(errs).includes(G));
  });

  console.log(`\n${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
