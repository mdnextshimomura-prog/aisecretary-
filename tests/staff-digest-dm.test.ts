/**
 * 個人 LINE へ先に送るまとめ（STAFF_DIGEST_DM・2026-11-28）：友だちの担当は 1対1 へ、1時間後に返事の無い分だけグループへ張り出す。
 * 1対1 の返事は、その人あての番号だけ受ける。KV・LINE・Notion は全部にせもの（外へはつながない）。
 */
import assert from "node:assert/strict";

process.env.LINE_CHANNEL_ACCESS_TOKEN = "t";
let n = 0;
const t = async (name: string, f: () => Promise<void> | void) => { await f(); n++; console.log("ok", name); };

const U1 = "U" + "1".repeat(32);
const U2 = "U" + "2".repeat(32);
const U3 = "U" + "3".repeat(32);
const BOSS = "U" + "b".repeat(32);
const TODAY = "2026-11-28";
const TOMORROW = "2026-11-29";
const MIN = 60_000;
// 2026-11-28 08:00 / 09:00 / 17:00 / 18:00 JST
const AM8 = Date.UTC(2026, 10, 27, 23, 0);
const AM9 = AM8 + 60 * MIN;
const PM5 = Date.UTC(2026, 10, 28, 8, 0);
const PM6 = PM5 + 60 * MIN;

type Row = {
  id: string; title: string; dueDate: string; status: string;
  assignee: string | null; assigneeUserId: string | null; note: string;
  propertyName: string | null; remindNumber: number | null; lastEdited?: string; nextCheck?: string | null;
};
const row = (id: string, title: string, dueDate: string, over: Partial<Row> = {}): Row => ({
  id, title, dueDate, status: "未着手", assignee: null, assigneeUserId: null, note: "", propertyName: null, remindNumber: null, ...over,
});
const OGA = { assignee: "小笠原", assigneeUserId: U1 };
const YAMA = { assignee: "山口", assigneeUserId: U2 };
const SHIMO = { assignee: "下村", assigneeUserId: BOSS };
const TASKS: Row[] = [
  row("a", "天満の資料を送る", "2026-11-26", OGA),
  row("b", "売主へ電話", "2026-11-28", OGA),
  row("c", "査定書を作る", "2026-11-28", YAMA),
  row("d", "看板の確認", "2026-11-28", { assignee: "樫元" }),
  row("e", "鍵の手配", "2026-11-28"),
  row("f", "決済の準備", "2026-11-28", SHIMO),
];

class FakeKv {
  store = new Map<string, unknown>();
  ttl = new Map<string, number>();
  sets = new Map<string, Set<string>>();
  calls: string[] = [];
  failSet: (key: string) => boolean = () => false;
  get = async (key: string) => { this.calls.push(`get ${key}`); return this.store.get(key) ?? null; };
  set = async (key: string, value: unknown, ex: number) => {
    this.calls.push(`set ${key}`);
    if (this.failSet(key)) throw new Error("kv down");
    this.store.set(key, JSON.parse(JSON.stringify(value)));
    this.ttl.set(key, ex);
  };
  setNx = async (key: string, value: unknown, ex: number) => {
    this.calls.push(`setnx ${key}`);
    if (this.store.has(key)) return false;
    this.store.set(key, value);
    this.ttl.set(key, ex);
    return true;
  };
  del = async (key: string) => { this.calls.push(`del ${key}`); this.store.delete(key); };
  smembers = async (key: string) => { this.calls.push(`smembers ${key}`); return Array.from(this.sets.get(key) ?? []); };
  lrange = async (key: string) => { this.calls.push(`lrange ${key}`); return (this.store.get(key) as unknown[] | undefined) ?? []; };
}

(async () => {
  const D = await import("../src/lib/staff-digest");
  const M = await import("../src/lib/staff-digest-dm");
  const R = await import("../src/lib/staff-digest-reply");

  const build = (slot: "am" | "eve", tasks: Row[] = TASKS, notionUrl: string | null = null) =>
    D.buildStaffDigest({ slot, tasks, today: TODAY, tomorrow: TOMORROW, followup: true, notionUrl });

  /** 送るときのにせもの。friends＝友だちの人、pushStatus＝その人への 1対1 の push の結果 */
  function sendFake(over: { friends?: Record<string, boolean | null>; pushStatus?: Record<string, number | null>; allow?: string[]; groupOk?: boolean } = {}) {
    const kv = new FakeKv();
    const logs: string[] = [];
    const dms: Array<{ uid: string; texts: string[]; key: string }> = [];
    const group: Array<Array<{ text: string; mentions: Record<string, string> }>> = [];
    const saved: unknown[] = [];
    const profiles: string[] = [];
    const deps = {
      kv,
      allowListed: (uid: string) => (over.allow ?? [BOSS]).includes(uid),
      profile: async (uid: string) => { profiles.push(uid); return (over.friends ?? { [U1]: true, [U2]: false })[uid] ?? null; },
      pushUser: async (uid: string, texts: string[], key: string) => {
        dms.push({ uid, texts, key });
        const st = over.pushStatus && uid in over.pushStatus ? over.pushStatus[uid] : 200;
        return { status: st, ids: st === 200 ? texts.map((_, i) => `dm-${uid.slice(1, 2)}-${i}`) : [] };
      },
      push: async (chunks: Array<{ text: string; mentions: Record<string, string> }>) => {
        group.push(chunks);
        return over.groupOk === false ? { sent: 0, ids: chunks.map(() => null) } : { sent: chunks.length, ids: chunks.map((_, i) => `g${i}`) };
      },
      saveMsgs: async (rows: unknown, slot: string, now: number) => { saved.push([rows, slot, now]); },
      log: (l: string) => { logs.push(l); },
    };
    return { deps, kv, logs, dms, group, saved, profiles };
  }

  await t("スイッチ：STAFF_DIGEST=1 かつ STAFF_DIGEST_DM=1 のときだけ on", () => {
    assert.deepEqual(
      [M.staffDigestDmOn({}), M.staffDigestDmOn({ STAFF_DIGEST_DM: "1" }), M.staffDigestDmOn({ STAFF_DIGEST: "1" }), M.staffDigestDmOn({ STAFF_DIGEST: "1", STAFF_DIGEST_DM: "0" }), M.staffDigestDmOn({ STAFF_DIGEST: "1", STAFF_DIGEST_DM: "1" })],
      [false, false, false, false, true]
    );
  });

  await t("1対1 の文（朝）：見出しにメンションなし・案内は「このトークに…」・例は同じ・9時の1行・Notion の行は最後", () => {
    const d = build("am", TASKS, "https://www.notion.so/abc");
    assert.equal(
      D.dmTextOf(d.messages[0], "am"),
      [
        "進捗の確認です。どうなりましたか？",
        "1. 天満の資料を送る（2日超過）",
        "2. 売主へ電話（本日期限）",
        "",
        "このトークに、番号をつけて返信してください",
        "例：「1済」「2 アポ取れました。来週火曜です」「2待ち 売主の書類 金曜」",
        "返事がない分は、9時にグループへ出します",
        "くわしく書くときは Notion へ：https://www.notion.so/abc",
      ].join("\n")
    );
  });

  await t("1対1 の文（夕方）：「夕方の進捗の確認です」・18時の1行。担当者ID の無い通・担当なしの通は null（グループへ）", () => {
    const d = build("eve");
    assert.equal(
      D.dmTextOf(d.messages[1], "eve"),
      [
        "夕方の進捗の確認です。どうなりましたか？",
        "3. 査定書を作る（本日期限）",
        "",
        "このトークに、番号をつけて返信してください",
        "例：「3済」「3 アポ取れました。来週火曜です」「3待ち 売主の書類 金曜」",
        "返事がない分は、18時にグループへ出します",
      ].join("\n")
    );
    // 樫元さん（担当者ID なし）・担当なし
    assert.deepEqual([D.dmTextOf(d.messages[2], "eve"), D.dmTextOf(d.messages[4], "eve")], [null, null]);
    // 朝の通を夕方として渡す（形が違う）→ null
    assert.equal(D.dmTextOf(build("am").messages[0], "eve"), null);
  });

  await t("送る：友だちの担当は 1対1 へ、友だちでない・担当者ID なし・担当なし・許可リストの人（下村さん）は今までどおりグループへ", async () => {
    const d = build("am");
    const f = sendFake();
    const sent = await M.sendDigestWithDm("am", TODAY, d.messages, d.ordered, AM8, f.deps);
    // 1対1：小笠原さんだけ（retry key の元は 日付・回・相手）
    assert.deepEqual(f.dms.map((x) => [x.uid, x.key, x.texts.length]), [[U1, `sd-dm:${TODAY}:am:${U1}`, 1]]);
    assert.ok(f.dms[0].texts[0].startsWith("進捗の確認です。どうなりましたか？\n1. 天満の資料を送る"));
    // グループ：山口（友だちでない）・樫元（ID なし）・下村（許可リスト）・担当なし。文は今のまま
    assert.deepEqual(f.group.length, 1);
    assert.deepEqual(f.group[0], [d.messages[1].chunk, d.messages[2].chunk, d.messages[3].chunk, d.messages[4].chunk]);
    assert.equal(sent, 5);
    // 下村さん（許可リスト）には友だちかどうかも聞かない
    assert.deepEqual(f.profiles.sort(), [U1, U2]);
    // 控え：その回の一覧・その人の控え・1対1 のメッセージ（dm: true）・友だちの覚え
    assert.deepEqual(f.kv.store.get(M.dmRunKey(TODAY, "am")), [
      { uid: U1, name: "小笠原", nums: [1, 2], taskIds: ["a", "b"], tasks: [{ id: "a", n: 1, status: "未着手", due: "2026-11-26" }, { id: "b", n: 2, status: "未着手", due: "2026-11-28" }], at: AM8 },
    ]);
    assert.deepEqual(f.kv.store.get(M.dmUserKey(U1)), { date: TODAY, slot: "am", nums: [1, 2], taskIds: ["a", "b"], at: AM8 });
    assert.deepEqual(f.kv.store.get(D.digestMsgKey("dm-1-0")), { at: AM8, slot: "am", nums: [1, 2], uid: U1, dm: true });
    assert.deepEqual([f.kv.store.get(M.dmFriendKey(U1)), f.kv.store.get(M.dmFriendKey(U2))], [1, 0]);
    assert.deepEqual(
      [f.kv.ttl.get(M.dmRunKey(TODAY, "am")), f.kv.ttl.get(M.dmUserKey(U1)), f.kv.ttl.get(M.dmFriendKey(U1))],
      [2 * 24 * 3600, 36 * 3600, 6 * 3600]
    );
    assert.equal(f.kv.store.has(M.dmUserKey(U2)), false);
    assert.deepEqual(f.logs, ["[staff-digest] am sent 4", "[staff-digest] dm sent 1 group 4"]);
    // ログに userId・題名を出さない
    assert.ok(!f.logs.join("\n").includes(U1) && !f.logs.join("\n").includes("天満"));
  });

  await t("友だちかどうかは6時間覚える（覚えがあれば LINE に聞かない）。分からない（時間切れ・5xx）ときはグループへ回し、覚えない", async () => {
    const d = build("am");
    const f = sendFake({ friends: { [U1]: true, [U2]: null } });
    f.kv.store.set(M.dmFriendKey(U1), 1);
    await M.sendDigestWithDm("am", TODAY, d.messages, d.ordered, AM8, f.deps);
    assert.deepEqual(f.profiles, [U2]);
    assert.deepEqual(f.dms.map((x) => x.uid), [U1]);
    assert.equal(f.kv.store.has(M.dmFriendKey(U2)), false);
    // 「友だちでない」の覚えがあれば、聞かずにグループへ
    const g = sendFake({ friends: { [U1]: true, [U2]: true } });
    g.kv.store.set(M.dmFriendKey(U1), 0);
    await M.sendDigestWithDm("am", TODAY, d.messages, d.ordered, AM8, g.deps);
    assert.deepEqual([g.profiles, g.dms.map((x) => x.uid)], [[U2], [U2]]);
  });

  await t("1対1 がはっきり断られた・結果が分からないときは、その人の通をその場でグループへ回す（失くさない）。張り出しの一覧からは外す", async () => {
    const d = build("am");
    for (const st of [400, null, 500] as const) {
      const f = sendFake({ friends: { [U1]: true, [U2]: true }, pushStatus: { [U1]: st } });
      const sent = await M.sendDigestWithDm("am", TODAY, d.messages, d.ordered, AM8, f.deps);
      assert.deepEqual(f.dms.map((x) => x.uid).sort(), [U1, U2]);
      // 小笠原さんの通は、元の文のままグループへ（元の順）
      assert.deepEqual(f.group[0].map((c) => c.text.split("\n")[0]), [
        "{m1} 進捗の確認です。どうなりましたか？", "樫元さん 進捗の確認です。どうなりましたか？", "{m1} 進捗の確認です。どうなりましたか？", "担当が決まっていないもの：どうしますか？",
      ]);
      assert.deepEqual(f.group[0][0], d.messages[0].chunk);
      assert.equal(sent, 5);
      assert.deepEqual((f.kv.store.get(M.dmRunKey(TODAY, "am")) as Array<{ uid: string }>).map((r) => r.uid), [U2]);
      assert.deepEqual(f.logs, ["[staff-digest] am sent 5", "[staff-digest] dm sent 1 group 4", "[staff-digest] dm fallback 1"]);
    }
    // 409（同じ retry key でもう受け付け済み）は送れた扱い（グループへ回さない）
    const h = sendFake({ pushStatus: { [U1]: 409 } });
    await M.sendDigestWithDm("am", TODAY, d.messages, d.ordered, AM8, h.deps);
    assert.equal(h.group[0].length, 4);
  });

  await t("控えが書けないときは個人あてにしない（全部グループへ）。その人の控えだけ書けなければ、その人だけグループへ", async () => {
    const d = build("am");
    const f = sendFake({ friends: { [U1]: true, [U2]: true } });
    f.kv.failSet = (key) => key === M.dmRunKey(TODAY, "am");
    await M.sendDigestWithDm("am", TODAY, d.messages, d.ordered, AM8, f.deps);
    assert.deepEqual([f.dms.length, f.group[0].length], [0, 5]);
    assert.ok(f.logs.includes("[staff-digest] dm record-failed"));
    const g = sendFake({ friends: { [U1]: true, [U2]: true } });
    g.kv.failSet = (key) => key === M.dmUserKey(U1);
    await M.sendDigestWithDm("am", TODAY, d.messages, d.ordered, AM8, g.deps);
    assert.deepEqual([g.dms.map((x) => x.uid), g.group[0].length], [[U2], 4]);
    assert.deepEqual((g.kv.store.get(M.dmRunKey(TODAY, "am")) as Array<{ uid: string }>).map((r) => r.uid), [U2]);
  });

  await t("全員が 1対1 に届いたら、グループには何も送らない", async () => {
    const d = build("am", TASKS.slice(0, 3));
    const f = sendFake({ friends: { [U1]: true, [U2]: true } });
    const sent = await M.sendDigestWithDm("am", TODAY, d.messages, d.ordered, AM8, f.deps);
    assert.deepEqual([sent, f.group.length, f.logs], [2, 0, ["[staff-digest] dm sent 2 group 0"]]);
  });

  await t("夕方の見回り：sendSplit があればそれで送る（無ければ今までどおり＝既存のテスト）。日付・通・番号つきのタスクを渡す", async () => {
    const seen: unknown[] = [];
    const calls: string[] = [];
    const deps: import("../src/lib/staff-digest").EveningDeps = {
      followup: true,
      claim: async () => true,
      release: async () => undefined,
      closedToday: async () => false,
      fetchTasks: async () => [row("a", "天満の資料を送る", "2026-11-26", { ...OGA, remindNumber: 1 })],
      setNumber: async () => undefined,
      push: async (c) => { calls.push("group-push"); return { sent: c.length, ids: c.map(() => null) }; },
      saveMsgs: async () => undefined,
      log: () => undefined,
      sendSplit: async (day, messages, ordered, now) => { seen.push([day, messages.length, ordered.map((o) => [o.task.id, o.n]), now]); return 1; },
    };
    assert.equal(await D.runStaffDigestEveningOnTick(PM5, { STAFF_DIGEST: "1" }, deps), "sent");
    assert.deepEqual([seen, calls], [[[TODAY, 1, [["a", 1]], PM5]], []]);
  });

  // ── 張り出し ──

  const ON = { STAFF_DIGEST: "1", STAFF_DIGEST_DM: "1" };
  const runRow = (uid: string, name: string, tasks: Array<[string, number, string?]>, at: number) => ({
    uid, name, nums: tasks.map((x) => x[1]), taskIds: tasks.map((x) => x[0]),
    tasks: tasks.map(([id, num, due]) => ({ id, n: num, status: "未着手", due: due ?? "2026-11-28" })), at,
  });
  function escFake(over: { tasks?: Row[] | (() => Promise<Row[]>); closed?: boolean; rows?: unknown; slot?: "am" | "eve"; answered?: string[]; pushOk?: boolean } = {}) {
    const kv = new FakeKv();
    const slot = over.slot ?? "am";
    if (over.rows !== null) {
      kv.store.set(M.dmRunKey(TODAY, slot), over.rows ?? [
        runRow(U1, "小笠原", [["a", 1, "2026-11-26"], ["b", 2]], slot === "am" ? AM8 : PM5),
        runRow(U2, "山口", [["c", 3]], slot === "am" ? AM8 : PM5),
      ]);
    }
    kv.sets.set(R.answeredKey(TODAY), new Set(over.answered ?? []));
    const logs: string[] = [];
    const pushed: Array<Array<{ text: string; mentions: Record<string, string> }>> = [];
    const saved: unknown[] = [];
    const calls: string[] = [];
    const deps = {
      followup: true,
      kv,
      closedToday: async () => { calls.push("closed?"); return over.closed ?? false; },
      fetchTasks: async () => { calls.push("fetch"); return typeof over.tasks === "function" ? over.tasks() : (over.tasks ?? TASKS); },
      push: async (chunks: Array<{ text: string; mentions: Record<string, string> }>) => {
        pushed.push(chunks);
        return over.pushOk === false ? { sent: 0, ids: chunks.map(() => null) } : { sent: chunks.length, ids: chunks.map((_, i) => `e${i}`) };
      },
      saveMsgs: async (rows: unknown, s: string, now: number) => { saved.push([rows, s, now]); },
      log: (l: string) => { logs.push(l); },
    };
    return { deps, kv, logs, pushed, saved, calls };
  }

  await t("張り出し：off・9時台と18時台以外は KV も Notion も触らない", async () => {
    const f = escFake();
    assert.equal(await M.runDmEscalationOnTick(AM9, { STAFF_DIGEST: "1" }, f.deps), "off");
    assert.equal(await M.runDmEscalationOnTick(AM9, { STAFF_DIGEST_DM: "1" }, f.deps), "off");
    for (const at of [AM8 + 59 * MIN, AM9 + 60 * MIN, PM5, PM6 + 60 * MIN]) assert.equal(await M.runDmEscalationOnTick(at, ON, f.deps), "skip");
    assert.deepEqual([f.kv.calls, f.calls, f.logs], [[], [], []]);
  });

  await t("張り出し（朝・9時台）：返事の無い分だけ、担当ごとに1通・同じ番号で。文と控え（am-esc）を固定。毎分呼ばれても1日1回", async () => {
    const f = escFake({ answered: ["b"] });
    assert.equal(await M.runDmEscalationOnTick(AM9, { ...ON, NOTION_DATABASE_ID: "0123456789abcdef0123456789abcdef" }, f.deps), "sent");
    assert.deepEqual(f.pushed, [[
      {
        text: [
          "{m1} 進捗の確認です（個人 LINE に返事がなかった分）。どうなりましたか？",
          "1. 天満の資料を送る（2日超過）",
          "",
          "このメッセージに返信（リプライ）で答えてください",
          "例：「1済」「1 アポ取れました。来週火曜です」「1待ち 売主の書類 金曜」",
          "くわしく書くときは Notion へ：https://www.notion.so/0123456789abcdef0123456789abcdef",
        ].join("\n"),
        mentions: { m1: U1 },
      },
      {
        text: [
          "{m1} 進捗の確認です（個人 LINE に返事がなかった分）。どうなりましたか？",
          "3. 査定書を作る（本日期限）",
          "",
          "このメッセージに返信（リプライ）で答えてください",
          "例：「3済」「3 アポ取れました。来週火曜です」「3待ち 売主の書類 金曜」",
          "くわしく書くときは Notion へ：https://www.notion.so/0123456789abcdef0123456789abcdef",
        ].join("\n"),
        mentions: { m1: U2 },
      },
    ]]);
    assert.deepEqual(f.saved, [[[{ id: "e0", nums: [1], uid: U1 }, { id: "e1", nums: [3], uid: U2 }], "am-esc", AM9]]);
    assert.deepEqual(f.logs, ["[staff-digest] esc am sent 2"]);
    assert.equal(await M.runDmEscalationOnTick(AM9 + MIN, ON, f.deps), "taken");
    assert.equal(await M.runDmEscalationOnTick(AM9 + 30 * MIN, ON, f.deps), "taken");
    assert.equal(f.pushed.length, 1);
    assert.equal(f.kv.ttl.get(M.dmEscKey(TODAY, "am")), 2 * 24 * 3600);
  });

  await t("張り出しから外すもの：1対1 で返事済み・Notion で更新・完了（一覧に無い）・「次に確認する日」が先・状態や期日が変わった・担当が替わった", async () => {
    const at = AM8;
    const iso = (ms: number) => new Date(ms).toISOString();
    const rows = [runRow(U1, "小笠原", [["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5], ["f", 6], ["g", 7], ["h", 8]], at)];
    const base = (id: string, over: Partial<Row> = {}) => row(id, `件${id}`, "2026-11-28", { ...OGA, lastEdited: iso(at + 2 * MIN), ...over });
    const tasks = [
      base("a"), // 返事の印あり
      base("b", { lastEdited: iso(at + 4 * MIN) }), // Notion で更新（送ってから3分より後）
      // c は完了（一覧に無い）
      base("d", { nextCheck: "2026-12-01" }), // 次に確認する日が先
      base("e", { status: "進行中" }), // 状態が変わった
      base("f", { dueDate: "2026-12-05" }), // 期日が変わった
      base("g", { ...YAMA }), // 担当が替わった
      base("h"), // 残る
    ];
    const f = escFake({ rows, tasks, answered: ["a"] });
    assert.equal(await M.runDmEscalationOnTick(AM9, ON, f.deps), "sent");
    assert.deepEqual(f.pushed[0].map((c) => c.text.split("\n").slice(1, 3)), [["8. 件h（本日期限）", ""]]);
    assert.deepEqual(f.logs, ["[staff-digest] esc am sent 1"]);
    // 純粋な関数でも同じ（ページ ID のハイフンの有無は区別しない）
    const cur = new Map(tasks.map((x) => [M.pageKey(x.id), x]));
    assert.deepEqual(M.unansweredOf(M.asDmRunRows(rows)[0], cur, new Set(["a"]), TODAY).map((o) => o.n), [8]);
  });

  await t("その日に担当に聞いたタスクは、聞いた時刻＋3分より後の更新だけを「Notion で更新」と数える", async () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const rows = [runRow(U1, "小笠原", [["a", 1]], AM8)];
    const f = escFake({ rows, tasks: [row("a", "天満の資料を送る", "2026-11-28", { ...OGA, lastEdited: iso(AM8 + 20 * MIN) })] });
    f.kv.store.set(R.askListKey(TODAY), [{ askId: "x", taskId: "a", title: "t", at: AM8 + 19 * MIN }]);
    assert.equal(await M.runDmEscalationOnTick(AM9, ON, f.deps), "sent");
  });

  await t("全員返事済みなら何も送らない（印は残す）。その回に 1対1 へ送った人がいなければ印も取らない", async () => {
    const f = escFake({ answered: ["a", "b", "c"] });
    assert.equal(await M.runDmEscalationOnTick(AM9, ON, f.deps), "empty");
    assert.equal(await M.runDmEscalationOnTick(AM9 + MIN, ON, f.deps), "taken");
    assert.deepEqual([f.pushed.length, f.logs], [0, ["[staff-digest] esc am empty"]]);
    const g = escFake({ rows: null });
    assert.equal(await M.runDmEscalationOnTick(AM9, ON, g.deps), "none");
    assert.deepEqual([g.kv.calls, g.calls, g.logs], [[`get ${M.dmRunKey(TODAY, "am")}`], [], []]);
  });

  await t("夕方の分は18時台に（eve-esc）。朝の分とは別の印", async () => {
    const f = escFake({ slot: "eve" });
    assert.equal(await M.runDmEscalationOnTick(AM9, ON, f.deps), "none");
    assert.equal(await M.runDmEscalationOnTick(PM6, ON, f.deps), "sent");
    assert.equal(await M.runDmEscalationOnTick(PM6 + MIN, ON, f.deps), "taken");
    assert.deepEqual(f.logs, ["[staff-digest] esc eve sent 2"]);
    assert.equal((f.saved[0] as unknown[])[1], "eve-esc");
    assert.ok(f.pushed[0][0].text.startsWith("{m1} 進捗の確認です（個人 LINE に返事がなかった分）。どうなりましたか？\n1. 天満の資料を送る"));
  });

  await t("個人あてが遅れて届いた日（朝の cron が 8:50）は、30分たってから張り出す", async () => {
    const f = escFake({ rows: [runRow(U1, "小笠原", [["a", 1, "2026-11-26"]], AM8 + 50 * MIN)] });
    assert.equal(await M.runDmEscalationOnTick(AM9, ON, f.deps), "wait");
    assert.equal(await M.runDmEscalationOnTick(AM9 + 19 * MIN, ON, f.deps), "wait");
    assert.equal(f.kv.store.has(M.dmEscKey(TODAY, "am")), false);
    assert.equal(await M.runDmEscalationOnTick(AM9 + 20 * MIN, ON, f.deps), "sent");
  });

  await t("休業日は張り出さない。タスクを引けなかったら印を外して次の見回りでやり直す。送り始めたあとは送り直さない", async () => {
    const c = escFake({ closed: true });
    assert.equal(await M.runDmEscalationOnTick(AM9, ON, c.deps), "closed");
    assert.deepEqual([c.calls, c.logs, c.pushed.length], [["closed?"], ["[staff-digest] esc am closed"], 0]);
    let first = true;
    const f = escFake({ tasks: async () => { if (first) { first = false; throw new Error("天満 notion down"); } return TASKS; } });
    assert.equal(await M.runDmEscalationOnTick(AM9, ON, f.deps), "failed");
    assert.deepEqual(f.logs, ["[staff-digest] esc am fetch-failed Error"]);
    assert.equal(f.kv.store.has(M.dmEscKey(TODAY, "am")), false);
    assert.equal(await M.runDmEscalationOnTick(AM9 + MIN, ON, f.deps), "sent");
    const p = escFake({ pushOk: false });
    assert.equal(await M.runDmEscalationOnTick(AM9, ON, p.deps), "failed");
    assert.equal(await M.runDmEscalationOnTick(AM9 + MIN, ON, p.deps), "taken");
    assert.deepEqual([p.pushed.length, p.logs], [1, ["[staff-digest] esc am push-failed"]]);
  });

  await t("準備が時間切れなら印を外してやり直す", async () => {
    const f = escFake({ tasks: () => new Promise<Row[]>((r) => setTimeout(() => r(TASKS), 300)) });
    assert.equal(await M.runDmEscalationOnTick(AM9, ON, { ...f.deps, budgetMs: 50 }), "failed");
    assert.deepEqual(f.logs, ["[staff-digest] esc am fetch-failed TimeoutError"]);
    assert.equal(f.kv.store.has(M.dmEscKey(TODAY, "am")), false);
  });

  // ── 1対1 の返事 ──

  const REC2 = { date: TODAY, slot: "am" as const, nums: [1, 2], taskIds: ["a", "b"], at: AM8 };
  const REC1 = { date: TODAY, slot: "am" as const, nums: [3], taskIds: ["c"], at: AM8 };
  const TITLES: Record<number, { id: string; title: string }> = { 1: { id: "a", title: "天満の資料を送る" }, 2: { id: "b", title: "売主へ電話" }, 3: { id: "c", title: "査定書を作る" }, 9: { id: "z", title: "別の人の件" } };
  function replyFake(over: { noticeOk?: boolean[] } = {}) {
    const replies: string[] = [];
    const logs: string[] = [];
    const ran: string[] = [];
    const notes: Array<[string, string[]]> = [];
    const noted: unknown[] = [];
    const finds: number[] = [];
    const notice = [...(over.noticeOk ?? [true])];
    const isDone = (l: string) => /^\d{1,2}(?:[,、]\d{1,2})*\s*(済|完了)$/.test(l);
    const isStatus = (l: string) => /^\d{1,2}\s*(待ち|延期|不要)(\s|$)/.test(l);
    const deps = {
      now: () => AM8 + 10 * MIN,
      isKnown: (l: string) => isDone(l) || isStatus(l),
      isOther: (l: string) => /^\d+\s*(登録|なし)$/.test(l),
      numbersOf: (l: string) => (l.match(/^[\d,、]+/)?.[0].match(/\d+/g) ?? []).map(Number),
      runKnown: async (l: string) => {
        ran.push(l);
        const nums = (l.match(/^[\d,、]+/)?.[0].match(/\d+/g) ?? []).map(Number);
        return { text: `☑️ ${l}`, changed: nums.map((x) => ({ ...TITLES[x], what: isDone(l) ? "済" : "待ち" })) };
      },
      findByNumber: async (x: number) => { finds.push(x); return TITLES[x] ?? null; },
      appendNote: async (id: string, lines: string[]) => { notes.push([id, lines]); },
      senderName: async () => "小笠原",
      reply: async (text: string) => { replies.push(text); },
      note: async (items: unknown, name: string | null) => { noted.push([items, name]); },
      noticeOnce: async () => notice.shift() ?? false,
      log: (l: string) => { logs.push(l); },
    };
    return { deps, replies, logs, ran, notes, noted, finds };
  }

  await t("1対1 の返事：「1済」「2待ち …」は今の言葉として、「2 自由な文」は進捗として、グループの返事と同じ処理へ。返事の印・知らせの控えも付く", async () => {
    const f = replyFake();
    await M.handleDmReply({ kind: "text", text: "1済\n2 アポ取れました。\n来週火曜です" }, REC2, f.deps);
    assert.deepEqual(f.ran, ["1済"]);
    assert.deepEqual(f.notes, [["b", ["進捗（11/28 小笠原）：アポ取れました。 来週火曜です"]]]);
    assert.deepEqual(f.replies, ["☑️ 1済\n\n📝 2 の進捗を記録しました"]);
    assert.deepEqual(f.noted, [[[{ id: "a", title: "天満の資料を送る", what: "済" }, { id: "b", title: "売主へ電話", what: "進捗「アポ取れました。 来週火曜です」" }], "小笠原"]]);
    assert.deepEqual(f.logs, ["[staff-digest] dm reply progress 1 known 1"]);
    const g = replyFake();
    await M.handleDmReply({ kind: "text", text: "２待ち 売主の書類 金曜" }, REC2, g.deps);
    assert.deepEqual(g.ran, ["2待ち 売主の書類 金曜"]);
  });

  await t("その人あてでない番号は受けない（何もしない・「その番号は…」と返す）。同じ通の自分の番号の行は受ける", async () => {
    const f = replyFake();
    await M.handleDmReply({ kind: "text", text: "9済" }, REC2, f.deps);
    assert.deepEqual([f.ran, f.notes, f.finds, f.noted], [[], [], [], []]);
    assert.deepEqual(f.replies, ["その番号は、あなたあての確認にはありません"]);
    assert.deepEqual(f.logs, ["[staff-digest] dm reply progress 0 known 0 foreign 1"]);
    const g = replyFake();
    await M.handleDmReply({ kind: "text", text: "1,9済\n3 進めています\n2 送りました" }, REC2, g.deps);
    assert.deepEqual([g.ran, g.notes.map((x) => x[0])], [[], ["b"]]);
    assert.deepEqual(g.replies, ["📝 2 の進捗を記録しました\nその番号は、あなたあての確認にはありません"]);
  });

  await t("番号の区切りは今までと同じ（「3ヶ月後…」「10時…」は番号と読まない）。番号の無い文は、1件ならそのタスク・2件以上は聞き返す", async () => {
    const one = replyFake();
    await M.handleDmReply({ kind: "text", text: "3ヶ月後に決済の予定です" }, REC1, one.deps);
    assert.deepEqual(one.notes, [["c", ["進捗（11/28 小笠原）：3ヶ月後に決済の予定です"]]]);
    assert.deepEqual(one.replies, ["📝 3 の進捗を記録しました"]);
    const done = replyFake();
    await M.handleDmReply({ kind: "text", text: "済" }, REC1, done.deps);
    assert.deepEqual([done.ran, done.replies], [["3 済"], ["☑️ 3 済"]]);
    const two = replyFake();
    await M.handleDmReply({ kind: "text", text: "アポ取れました" }, REC2, two.deps);
    assert.deepEqual([two.notes, two.ran, two.noted], [[], [], []]);
    assert.deepEqual(two.replies, ["どの番号の件か分かりませんでした。番号をつけて返信してください（例：「1 送りました」）"]);
    assert.deepEqual(two.logs, ["[staff-digest] dm reply no-number"]);
  });

  await t("ほか（文字でない・ほかの機能の言葉・あいづち・絵文字だけ）：1時間に1回だけ案内、あとは黙る。何も書かない", async () => {
    const f = replyFake({ noticeOk: [true, false, false, false, false, false, false] });
    const inputs: Array<{ kind: "text" | "other"; text?: string }> = [
      { kind: "other" },
      { kind: "text", text: "メニュー" },
      { kind: "text", text: "#新規 山田太郎" },
      { kind: "text", text: "1 登録" },
      { kind: "text", text: "了解です" },
      { kind: "text", text: "👍" },
      { kind: "text", text: "送信" },
    ];
    for (const i of inputs) await M.handleDmReply(i, REC1, f.deps);
    assert.deepEqual(f.replies, ["このトークでは、進捗の確認への返事だけ受け付けています。番号をつけて返信してください（例：「1済」）"]);
    assert.deepEqual([f.ran, f.notes, f.noted, f.finds], [[], [], [], []]);
    assert.deepEqual(f.logs, [
      "[staff-digest] dm reply other", "[staff-digest] dm reply command quiet", "[staff-digest] dm reply command quiet", "[staff-digest] dm reply command quiet",
      "[staff-digest] dm reply chatter quiet", "[staff-digest] dm reply chatter quiet", "[staff-digest] dm reply command quiet",
    ]);
  });

  await t("処理が投げても外へ投げない（細い口はここで終わり）。ログに本文・題名を出さない", async () => {
    const f = replyFake();
    await M.handleDmReply({ kind: "text", text: "1済\n2 天満の件です" }, REC2, { ...f.deps, runKnown: async () => { throw new Error("x"); }, appendNote: async () => { throw new Error("y"); }, reply: async () => { throw new Error("z"); } });
    assert.deepEqual(f.logs, ["[staff-digest] dm reply send-failed", "[staff-digest] dm reply progress 0 known 0 write-failed 1 known-failed 1"]);
    assert.ok(!f.logs.join("\n").includes("天満"));
  });

  await t("細い口を試す条件：on・1対1 のメッセージ・許可リストに無い人（理由が user-not-allowed／user-not-configured）のときだけ", () => {
    const ev = (over: Record<string, unknown> = {}) => ({ type: "message", source: { type: "user", userId: U1 }, message: { id: "m1", type: "text" }, ...over });
    assert.equal(M.dmPassageCandidate(ev(), "user-not-allowed", ON), true);
    assert.equal(M.dmPassageCandidate(ev(), "user-not-configured", ON), true);
    assert.equal(M.dmPassageCandidate(ev({ message: { id: "m1", type: "image" } }), "user-not-allowed", ON), true);
    assert.equal(M.dmPassageCandidate(ev(), "user-not-allowed", { STAFF_DIGEST: "1" }), false);
    assert.equal(M.dmPassageCandidate(ev(), "user-not-allowed", { STAFF_DIGEST_DM: "1" }), false);
    assert.equal(M.dmPassageCandidate(ev(), "group-mismatch", ON), false);
    assert.equal(M.dmPassageCandidate(ev(), "room", ON), false);
    assert.equal(M.dmPassageCandidate(ev({ type: "postback" }), "user-not-allowed", ON), false);
    assert.equal(M.dmPassageCandidate(ev({ source: { type: "group", userId: U1 } }), "user-not-allowed", ON), false);
    assert.equal(M.dmPassageCandidate(ev({ source: { type: "user", userId: "x" } }), "user-not-allowed", ON), false);
  });

  await t("控えの読み方：形の違うもの・番号とタスクの数が合わないものは使わない", () => {
    assert.deepEqual(M.asDmUserRec(REC2), REC2);
    assert.deepEqual(M.asDmUserRec(JSON.stringify(REC2)), REC2);
    for (const bad of [null, {}, { ...REC2, taskIds: ["a"] }, { ...REC2, nums: [] , taskIds: [] }, { ...REC2, slot: "nudge" }, { date: TODAY, slot: "am", nums: [1], at: 1 }]) assert.equal(M.asDmUserRec(bad), null);
    assert.deepEqual(M.asDmRunRows([{ uid: "x", tasks: [], at: 1 }, null, "x"]), []);
  });

  await t("スイッチ off：朝の入口（remind.ts）・夕方の見回りは個人あての道を読み込まない。細い口・張り出しは KV・LINE を呼ばない", async () => {
    const fs = await import("node:fs");
    const remind = fs.readFileSync("src/lib/remind.ts", "utf8");
    // off なら足す前と同じ1行（sendDigestMessages）に落ちる
    assert.ok(remind.includes('const sentAm = staffDigestDmOn()\n      ? await (await import("./staff-digest-dm-wire")).sendDigestWithDmReal("am", todayStr, digest.messages, digest.ordered, Date.now())\n      : await sendDigestMessages("am", digest.messages, order.length, Date.now());'));
    let fetches = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => { fetches++; throw new Error("外へ出てはいけない"); }) as typeof fetch;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    try {
      for (const env of [{}, { STAFF_DIGEST: "1" }, { STAFF_DIGEST_DM: "1" }] as Array<Record<string, string>>) {
        for (const k of ["STAFF_DIGEST", "STAFF_DIGEST_DM", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[k];
        Object.assign(process.env, env);
        const W = await import("../src/lib/staff-digest-dm-wire");
        assert.equal(await W.staffDmPassage({ type: "message", replyToken: "r", source: { type: "user", userId: U1 }, message: { id: "m1", type: "text", text: "1済" } }, "user-not-allowed", () => [1]), false);
        await W.runStaffDigestDmEscalationOnTick(AM9);
      }
    } finally {
      globalThis.fetch = origFetch;
      console.log = origLog;
      for (const k of ["STAFF_DIGEST", "STAFF_DIGEST_DM"]) delete process.env[k];
    }
    assert.deepEqual([fetches, logs], [0, []]);
  });

  await t("友だちかどうかの口：200＝友だち・404＝友だちでない・ほか／時間切れ＝分からない。本文は読まない", async () => {
    const W = await import("../src/lib/staff-digest-dm-wire");
    const urls: string[] = [];
    let read = 0;
    const res = (status: number) => (async (url: string) => {
      urls.push(String(url));
      return { status, body: { cancel: async () => undefined }, json: async () => { read++; return {}; }, text: async () => { read++; return ""; } } as unknown as Response;
    }) as unknown as typeof fetch;
    assert.equal(await W.lineFriendStatus(U1, { token: "t", fetch: res(200) }), true);
    assert.equal(await W.lineFriendStatus(U1, { token: "t", fetch: res(404) }), false);
    assert.equal(await W.lineFriendStatus(U1, { token: "t", fetch: res(500) }), null);
    assert.equal(await W.lineFriendStatus(U1, { token: "t", fetch: (async () => { throw new Error("x"); }) as unknown as typeof fetch }), null);
    const slow = ((_u: string, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    assert.equal(await W.lineFriendStatus(U1, { token: "t", fetch: slow, timeoutMs: 30 }), null);
    assert.equal(await W.lineFriendStatus("not-a-user", { token: "t", fetch: res(200) }), null);
    assert.deepEqual([urls[0], read], [`https://api.line.me/v2/bot/profile/${U1}`, 0]);
  });

  void U3;
  console.log(`\n${n} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
