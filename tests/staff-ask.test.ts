/** 担当に聞く：仕分ける人が 1対1 のカードから担当へ聞き、返事を Notion と自分の 1対1 に受ける */
import assert from "node:assert/strict";
import * as A from "../src/lib/staff-ask";
import * as R from "../src/lib/staff-digest-reply";
import { digestMsgKey } from "../src/lib/staff-digest";

let n = 0;
const t = async (name: string, f: () => Promise<void> | void) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const ON = { STAFF_DIGEST: "1" };
const OWNER = "U" + "b".repeat(32);
const OGA = "U" + "1".repeat(32);
const G = "C" + "a".repeat(32);
const G2 = "C" + "e".repeat(32);
const NOW = Date.UTC(2026, 10, 28, 1, 30); // JST 11/28 10:30
const DAY = "2026-11-28";
const PID = "0123456789abcdef0123456789abcdef";
const TASK: A.AskTask = { id: PID, title: "天満の資料を送る", propertyName: "天満ハイツ", assignee: "小笠原", assigneeUserId: OGA, origin: G2, closed: false, private: false };

function mkKv() {
  const m = new Map<string, unknown>();
  const lists = new Map<string, unknown[]>();
  const sets = new Map<string, Set<string>>();
  const ops: string[] = [];
  const kv: R.SdKv = {
    get: async (k) => { ops.push(`get ${k}`); return m.get(k) ?? null; },
    set: async (k, v) => { ops.push(`set ${k}`); m.set(k, v); },
    setNx: async (k, v) => { ops.push(`setNx ${k}`); if (m.has(k)) return false; m.set(k, v); return true; },
    del: async (k) => { ops.push(`del ${k}`); m.delete(k); },
    rpush: async (k, vs) => { ops.push(`rpush ${k}`); lists.set(k, [...(lists.get(k) ?? []), ...vs]); },
    lrange: async (k, a, b) => { ops.push(`lrange ${k}`); const l = lists.get(k) ?? []; return b < 0 ? l.slice(a) : l.slice(a, b + 1); },
    ltrim: async (k, a) => { ops.push(`ltrim ${k}`); lists.set(k, (lists.get(k) ?? []).slice(a)); },
    sadd: async (k, vs) => { ops.push(`sadd ${k}`); const s = sets.get(k) ?? new Set<string>(); vs.forEach((v) => s.add(v)); sets.set(k, s); },
    smembers: async (k) => { ops.push(`smembers ${k}`); return Array.from(sets.get(k) ?? []); },
  };
  return { kv, m, lists, sets, ops };
}

function mk(o: { env?: Record<string, string>; task?: A.AskTask | null; status?: Array<number | null>; busy?: boolean; ownerName?: string | null; now?: () => number } = {}) {
  const x = mkKv();
  const replies: Array<{ text: string; card?: unknown }> = [];
  const logs: string[] = [];
  const pushes: Array<{ to: string; chunk: { text: string; mentions: Record<string, string> }; key: string }> = [];
  const notes: Array<{ id: string; lines: string[] }> = [];
  const calls: string[] = [];
  const status = [...(o.status ?? [])];
  const deps: A.AskDeps = {
    env: o.env ?? ON,
    now: o.now ?? (() => NOW),
    kv: x.kv,
    isOwner: async (u) => { calls.push("isOwner"); return u === OWNER; },
    getTask: async () => { calls.push("getTask"); return o.task === undefined ? TASK : o.task; },
    ownerName: async () => (o.ownerName === undefined ? "下村" : o.ownerName),
    otherMarker: async () => o.busy ?? false,
    mainGroup: G,
    pushGroup: async (to, chunk, key) => { pushes.push({ to, chunk, key }); const s = status.length > 0 ? status.shift()! : 200; return { status: s, ids: s === 200 ? [`M${pushes.length}`] : [] }; },
    appendNote: async (id, lines) => { notes.push({ id, lines }); },
    reply: async (text, card) => { replies.push({ text, card }); },
    log: (l) => logs.push(l),
  };
  return { ...x, deps, replies, logs, pushes, notes, calls };
}
const press = (x: ReturnType<typeof mk>, data: string, userId = OWNER, ev = "e1") =>
  A.handleAskPostback(A.parseAskData(data)!, { userId, webhookEventId: ev }, x.deps);

async function main() {
  await t("ボタンの data：v1|ka|・v1|kw|・v1|kp|<タスク>|1・2 だけ読む", () => {
    assert.deepEqual(A.parseAskData(`v1|ka|${PID}`), { op: "ka", pageId: PID });
    assert.deepEqual(A.parseAskData(`v1|kw|${PID}`), { op: "kw", pageId: PID });
    assert.deepEqual(A.parseAskData(`v1|kp|${PID}|2`), { op: "kp", pageId: PID, preset: 2 });
    assert.deepEqual(A.parseAskData(A.encodeAsk("kp", PID, 1)), { op: "kp", pageId: PID, preset: 1 });
    for (const s of ["v1|ka|x", `v1|kp|${PID}|3`, `v1|kp|${PID}`, `v1|ka|${PID}|1`, `v1|done|${PID}`, ""]) assert.equal(A.parseAskData(s), null, s);
  });

  await t("カードのボタン：［担当に聞く］は、渡したとき（仕分ける人の 1対1）だけ6つ目に付く。渡さなければ今までと同じ JSON", async () => {
    Object.assign(process.env, { TASK_BUTTONS: "1", TASK_FOLLOWUP: "1", TASK_MENU: "1" });
    const tb = await import("../src/lib/task-buttons");
    const tm = await import("../src/lib/task-menu");
    const info = { pageId: PID, title: "天満の資料を送る", due: "2026-12-01", assignee: "小笠原" };
    const plain = tb.taskCard(info);
    assert.deepEqual(tb.taskCard(info, {}), plain);
    assert.deepEqual(tb.taskCard(info, { ask: false }), plain);
    const withAsk = tb.taskCard(info, { ask: true });
    const labels = (c: { contents: Record<string, unknown> }) =>
      ((c.contents.footer as { contents: Array<{ action: { label: string; data: string } }> }).contents).map((b) => [b.action.label, b.action.data]);
    assert.deepEqual(labels(withAsk).slice(0, 5), labels(plain));
    assert.deepEqual(labels(withAsk)[5], ["担当に聞く", `v1|ka|${PID}`]);
    assert.deepEqual(A.parseAskData(labels(withAsk)[5][1]), { op: "ka", pageId: PID });
    // 受付の返事のカード・一覧のカードも同じ（付けるのは呼び手が渡したときだけ）
    const parsed = { title: info.title, dueDate: "2026-12-01", dueTime: null, assignee: "小笠原" };
    assert.deepEqual(tb.registeredCardFor(PID, parsed, { property: null, ask: false }), tb.registeredCardFor(PID, parsed));
    assert.equal(labels(tb.registeredCardFor(PID, parsed, { ask: true })!).length, 6);
    const tasks = [{ id: PID, title: "a", due: null, assignee: null, closed: false, origin: null }] as never;
    const page = tm.buildListPage("lt", tasks, 0, "なし");
    assert.deepEqual(tm.buildListPage("lt", tasks, 0, "なし", {}), page);
    assert.ok(!JSON.stringify(page).includes("担当に聞く"));
    assert.ok(JSON.stringify(tm.buildListPage("lt", tasks, 0, "なし", { ask: true })).includes(`v1|ka|${PID}`));
  });

  await t("グループへの1通：メンション＋【題名／物件】＋「下村さんから：…」＋返信の案内（担当者ID なし・担当なしの形も）", () => {
    assert.deepEqual(A.buildAskMessage(TASK, "下村", "アポ取れてる？"), {
      text: "{m1} 【天満の資料を送る／天満ハイツ】\n下村さんから：アポ取れてる？\nこのメッセージに返信（リプライ）で答えてください",
      mentions: { m1: OGA },
    });
    assert.deepEqual(A.buildAskMessage({ ...TASK, assigneeUserId: null, propertyName: null }, null, "進み具合は{どう}ですか？"), {
      text: "小笠原さん 【天満の資料を送る】\n下村さんから：進み具合は（どう）ですか？\nこのメッセージに返信（リプライ）で答えてください",
      mentions: {},
    });
    assert.deepEqual(A.buildAskMessage({ ...TASK, assignee: null, assigneeUserId: null, title: "天満ハイツの鍵" }, "下村", "誰がやる？"), {
      text: "【天満ハイツの鍵】\n下村さんから：誰がやる？\n担当が決まっていません。どなたが進めるか、このメッセージに返信で教えてください",
      mentions: {},
    });
  });

  await t("off：ボタンは「いまは止めています」だけ。1通の取り込みは KV も読まない（LINE・Notion も呼ばない）", async () => {
    const x = mk({ env: {} });
    await press(x, `v1|kp|${PID}|1`);
    x.m.set(A.askMarkerKey(OWNER), { taskId: PID, at: NOW });
    assert.equal(await A.handleAskText({ userId: OWNER, text: "アポ取れてる？" }, x.deps), false);
    assert.deepEqual(x.replies.map((r) => r.text), ["いまは止めています"]);
    assert.equal(x.ops.length + x.pushes.length + x.notes.length + x.calls.length, 0);
  });

  await t("押せるのは仕分ける人だけ。見つからない・完了・グループに出していないタスクは聞かない", async () => {
    const a = mk();
    await press(a, `v1|ka|${PID}`, OGA);
    const b = mk({ task: null });
    await press(b, `v1|ka|${PID}`);
    const c = mk({ task: { ...TASK, closed: true } });
    await press(c, `v1|kp|${PID}|1`);
    const d = mk({ task: { ...TASK, origin: "LINE WORKS", private: true } });
    await press(d, `v1|kp|${PID}|1`);
    assert.deepEqual([a, b, c, d].map((x) => x.replies[0].text), [
      "このボタンを押せるのは下村さんだけです", "タスクが見つかりませんでした", "このタスクはもう完了しています", "このタスクはグループに出していないので、担当に聞けません",
    ]);
    assert.equal(a.calls.includes("getTask"), false);
    for (const x of [a, b, c, d]) assert.equal(x.pushes.length, 0);
  });

  await t("［担当に聞く］：1対1 に小さなカード（題名・物件・担当・［進み具合は？］［いつ終わりそう？］［自分で書く］）。送信はしない", async () => {
    const x = mk();
    await press(x, `v1|ka|${PID}`);
    assert.equal(x.replies[0].text, "どう聞きますか？");
    const j = JSON.stringify(x.replies[0].card);
    for (const w of ["担当に聞く", "天満の資料を送る", "天満ハイツ", "小笠原", "進み具合は？", "いつ終わりそう？", "自分で書く", `v1|kp|${PID}|1`, `v1|kp|${PID}|2`, `v1|kw|${PID}`]) assert.ok(j.includes(w), w);
    assert.equal(x.pushes.length, 0);
    assert.deepEqual(x.logs, ["[staff-ask] ka shown"]);
  });

  await t("決まった質問：発生元のグループへ1通（retry key つき）。返信の照合の控え・その日の聞いた件・Notion の記録を残し「◯◯さんに聞きました」", async () => {
    const x = mk();
    await press(x, `v1|kp|${PID}|1`);
    assert.equal(x.pushes.length, 1);
    assert.equal(x.pushes[0].to, G2);
    assert.equal(x.pushes[0].chunk.text, "{m1} 【天満の資料を送る／天満ハイツ】\n下村さんから：進み具合はどうですか？\nこのメッセージに返信（リプライ）で答えてください");
    const askId = `${PID}:p1:e1`;
    assert.equal(x.pushes[0].key, `sd-ask:${askId}`);
    assert.deepEqual(x.m.get(digestMsgKey("M1")), { at: NOW, slot: "ask", taskId: PID, title: "天満の資料を送る", uid: OGA, askId });
    assert.deepEqual(x.lists.get(R.askListKey(DAY)), [{ askId, taskId: PID, title: "天満の資料を送る", assignee: "小笠原", assigneeUserId: OGA, at: NOW }]);
    assert.deepEqual(x.notes, [{ id: PID, lines: ["質問（11/28 下村）：進み具合はどうですか？"] }]);
    assert.deepEqual(x.replies.map((r) => r.text), ["小笠原さんに聞きました"]);
    assert.deepEqual(x.logs, ["[staff-ask] kp sent"]);
    // 10分のあいだ、同じ質問は重ねない（別の質問は送れる）
    await press(x, `v1|kp|${PID}|1`, OWNER, "e2");
    assert.equal(x.replies[1].text, "同じ質問を送ったばかりです（10分あけてください）");
    await press(x, `v1|kp|${PID}|2`, OWNER, "e3");
    assert.equal(x.pushes.length, 2);
    assert.ok(x.pushes[1].chunk.text.includes("いつ終わりそうですか？"));
  });

  await t("発生元の無いタスクは会社のグループへ。担当なしは「グループに聞きました（担当が決まっていません）」", async () => {
    const x = mk({ task: { ...TASK, origin: null, assignee: null, assigneeUserId: null } });
    await press(x, `v1|kp|${PID}|2`);
    assert.equal(x.pushes[0].to, G);
    assert.equal(x.replies[0].text, "グループに聞きました（担当が決まっていません）");
  });

  await t("決まった質問：結果が分からないときは印を残し、押し直しは同じ retry key（409 は送れた扱い）。はっきり断られたら印を外す", async () => {
    const x = mk({ status: [null, 409] });
    await press(x, `v1|kp|${PID}|1`, OWNER, "e1");
    assert.equal(x.replies[0].text, A.MSG_ASK_UNKNOWN);
    assert.equal(x.notes.length, 0);
    await press(x, `v1|kp|${PID}|1`, OWNER, "e2");
    assert.equal(x.replies[1].text, "小笠原さんに聞きました");
    assert.deepEqual(x.pushes.map((p) => p.key), [`sd-ask:${PID}:p1:e1`, `sd-ask:${PID}:p1:e1`]);
    const y = mk({ status: [400, 200] });
    await press(y, `v1|kp|${PID}|1`, OWNER, "e1");
    assert.equal(y.replies[0].text, A.MSG_ASK_FAILED);
    assert.equal(y.m.has(A.askPresetKey(PID, 1)), false);
    await press(y, `v1|kp|${PID}|1`, OWNER, "e2");
    assert.equal(y.replies[1].text, "小笠原さんに聞きました");
  });

  await t("［自分で書く］：印を置いて次の1通を待つ。ほかの入力待ちがあるときは断る", async () => {
    const x = mk();
    await press(x, `v1|kw|${PID}`);
    assert.deepEqual(x.m.get(A.askMarkerKey(OWNER)), { taskId: PID, at: NOW });
    assert.equal(x.replies[0].text, "このあと送った1通を、そのまま担当に伝えます（10分間）。やめるときは「やめる」");
    assert.equal(x.pushes.length, 0);
    const busy = mk({ busy: true });
    await press(busy, `v1|kw|${PID}`);
    assert.equal(busy.replies[0].text, "いまは別の入力を待っています。そちらが終わってから、もう一度押してください");
    assert.equal(busy.m.has(A.askMarkerKey(OWNER)), false);
  });

  await t("自分で書いた1通：そのまま担当へ。送れたら印を消す。印が無い人・グループの発言は扱わない（今までの流れへ）", async () => {
    const x = mk();
    assert.equal(await A.handleAskText({ userId: OWNER, text: "アポ取れてる？" }, x.deps), false);
    assert.equal(x.replies.length + x.pushes.length, 0);
    await press(x, `v1|kw|${PID}`);
    assert.equal(await A.handleAskText({ userId: OWNER, groupId: G, text: "アポ取れてる？" }, x.deps), false);
    assert.equal(await A.handleAskText({ userId: OGA, text: "アポ取れてる？" }, x.deps), false);
    assert.equal(await A.handleAskText({ userId: OWNER, text: " アポ取れてる？\n急ぎです " }, x.deps), true);
    assert.equal(x.pushes[0].chunk.text, "{m1} 【天満の資料を送る／天満ハイツ】\n下村さんから：アポ取れてる？ 急ぎです\nこのメッセージに返信（リプライ）で答えてください");
    assert.equal(x.pushes[0].key, `sd-ask:${PID}:w:${NOW}`);
    assert.equal(x.replies[1].text, "小笠原さんに聞きました");
    assert.equal(x.m.has(A.askMarkerKey(OWNER)), false);
    assert.deepEqual(x.notes, [{ id: PID, lines: ["質問（11/28 下村）：アポ取れてる？ 急ぎです"] }]);
    // 印が消えたあとの1通は今までの流れへ
    assert.equal(await A.handleAskText({ userId: OWNER, text: "次の話" }, x.deps), false);
  });

  await t("自分で書いた1通：「やめる」で取りやめ・300字を超えたら送らずに聞き直す・送れなければ印を残す（同じ retry key で送り直せる）", async () => {
    const x = mk();
    await press(x, `v1|kw|${PID}`);
    assert.equal(await A.handleAskText({ userId: OWNER, text: "あ".repeat(301) }, x.deps), true);
    assert.equal(x.replies[1].text, A.MSG_ASK_TOO_LONG);
    assert.equal(x.m.has(A.askMarkerKey(OWNER)), true);
    assert.equal(await A.handleAskText({ userId: OWNER, text: "やめる" }, x.deps), true);
    assert.equal(x.replies[2].text, "やめました");
    assert.equal(x.m.has(A.askMarkerKey(OWNER)), false);
    assert.equal(x.pushes.length, 0);
    const y = mk({ status: [null, 500, 409] });
    await press(y, `v1|kw|${PID}`);
    assert.equal(await A.handleAskText({ userId: OWNER, text: "アポ取れてる？" }, y.deps), true);
    assert.equal(y.replies[1].text, A.MSG_ASK_UNKNOWN_TEXT);
    assert.equal(await A.handleAskText({ userId: OWNER, text: "アポ取れてる？" }, y.deps), true);
    assert.equal(y.m.has(A.askMarkerKey(OWNER)), true);
    assert.equal(await A.handleAskText({ userId: OWNER, text: "アポ取れてる？" }, y.deps), true);
    assert.equal(y.replies[3].text, "小笠原さんに聞きました");
    assert.equal(new Set(y.pushes.map((p) => p.key)).size, 1);
    assert.equal(y.m.has(A.askMarkerKey(OWNER)), false);
  });

  await t("ログに題名・本文・ID を出さない", async () => {
    const x = mk();
    await press(x, `v1|kp|${PID}|1`);
    await press(x, `v1|kw|${PID}`);
    await A.handleAskText({ userId: OWNER, text: "アポ取れてる？" }, x.deps);
    for (const l of x.logs) assert.ok(!/天満|アポ|0123456789|U1|Ub|Ca|Ce/.test(l), l);
  });

  // ── 返事の取り込み（staff-digest-reply.ts） ──
  const ASK_REC = { at: NOW, slot: "ask", taskId: PID, title: "天満の資料を送る", uid: OGA, askId: "A1" };
  function mkAns(o: { name?: string | null; owner?: boolean; pushOk?: boolean; applied?: { text: string; changed: R.ReplyItem[] } | null } = {}) {
    const x = mkKv();
    x.m.set(digestMsgKey("Q1"), ASK_REC);
    const notes: Array<{ id: string; lines: string[] }> = [];
    const replies: string[] = [];
    const logs: string[] = [];
    const noted: Array<{ items: R.ReplyItem[]; opts?: { noForward?: boolean } }> = [];
    const owner: Array<{ text: string; key: string }> = [];
    const done: string[][] = [];
    const numbered: number[] = [];
    const applied: string[] = [];
    const deps: R.DigestReplyDeps = {
      env: ON, now: () => NOW + 3_600_000, kv: x.kv,
      isKnown: (l) => /^\d+\s*(済|完了|待ち|延期|不要)/.test(l),
      isOther: (l) => /^\d+\s*(登録|なし)$/.test(l),
      runKnown: async () => { throw new Error("番号では処理しない"); },
      findByNumber: async (num) => { numbered.push(num); return null; },
      appendNote: async (id, lines) => { notes.push({ id, lines }); },
      senderName: async () => (o.name === undefined ? "小笠原" : o.name),
      reply: async (text) => { replies.push(text); },
      note: async (items, _name, opts) => { noted.push({ items, opts }); },
      log: (l) => logs.push(l),
      applyToTask: async (_task, body) => { applied.push(body); return o.applied === undefined ? null : o.applied; },
      notifyOwner: async (text, key) => { owner.push({ text, key }); return o.pushOk ?? true; },
      askDone: async (day, askId) => { done.push([day, askId]); },
      isOwner: async () => o.owner ?? false,
    };
    return { ...x, deps, notes, replies, logs, noted, owner, done, numbered, applied };
  }
  const ans = (text: string, extra: Partial<R.DigestReplyInput> = {}) => ({ text, quotedMessageId: "Q1", groupId: G2, userId: OGA, ...extra });

  await t("返事：聞いたメッセージへの返信（番号なし）を、そのタスクの進捗として残し、すぐ下村さんの 1対1 へ。30分の知らせには重ねない", async () => {
    const x = mkAns();
    assert.deepEqual(await R.handleDigestReply(ans("来週火曜にアポです"), x.deps), { handled: true, committed: true });
    assert.deepEqual(x.notes, [{ id: PID, lines: ["進捗（11/28 小笠原）：来週火曜にアポです"] }]);
    assert.deepEqual(x.replies, ["📝 回答を記録しました"]);
    assert.equal(x.owner.length, 1);
    assert.equal(x.owner[0].text, "💬 小笠原さん：天満の資料を送る → 『来週火曜にアポです』");
    assert.ok(x.owner[0].key.startsWith("sd-ask-ans:A1:"));
    assert.deepEqual(x.done, [[DAY, "A1"]]);
    assert.deepEqual(x.noted, [{ items: [{ id: PID, title: "天満の資料を送る", what: "進捗「来週火曜にアポです」" }], opts: { noForward: true } }]);
    assert.deepEqual(x.logs, ["[staff-digest] ask answer 1"]);
    assert.equal(x.numbered.length, 0);
  });

  await t("返事：頭に番号があっても、人へのメンションがあっても、そのタスク1件の返事（番号では引かない）。秘書あて・あいづち・絵文字・候補の言葉は受けない", async () => {
    const x = mkAns();
    await R.handleDigestReply(ans("3 来週火曜にアポです"), x.deps);
    await R.handleDigestReply(ans("アポ取れました", { hasMention: true }), x.deps);
    assert.deepEqual(x.notes.map((nn) => nn.lines[0]), ["進捗（11/28 小笠原）：来週火曜にアポです", "進捗（11/28 小笠原）：アポ取れました"]);
    assert.equal(x.numbered.length, 0);
    const before = x.ops.length;
    for (const m of [ans("これタスクにして", { hasMention: true, mentionsBot: true }), ans("了解です"), ans("👍"), ans("1 登録")]) {
      assert.deepEqual(await R.handleDigestReply(m, x.deps), { handled: false, committed: false });
    }
    assert.equal(x.ops.length, before);
    assert.equal(x.notes.length, 2);
  });

  await t("返事：「済」「3済」「完了しました」「待ち 売主の書類 金曜」は、そのタスクに今の言葉として当てる（進捗には書かない）", async () => {
    const x = mkAns({ applied: { text: "☑️ 完了にしました\n📋 天満の資料を送る", changed: [{ id: PID, title: "天満の資料を送る", what: "済" }] } });
    assert.deepEqual(await R.handleDigestReply(ans("済"), x.deps), { handled: true, committed: true });
    await R.handleDigestReply(ans("3済"), x.deps);
    await R.handleDigestReply(ans("完了しました"), x.deps);
    assert.deepEqual(x.applied, ["済", "済", "完了しました"]);
    assert.equal(x.notes.length, 0);
    assert.equal(x.replies[0], "☑️ 完了にしました\n📋 天満の資料を送る");
    assert.equal(x.owner[0].text, "💬 小笠原さん：天満の資料を送る → 済");
    assert.equal(x.numbered.length, 0);
  });

  await t("返事：すぐの知らせが送れなかったら30分の知らせの列に回す。下村さん本人の返事は知らせない。書けなければ「書き込めませんでした」", async () => {
    const x = mkAns({ pushOk: false, name: null });
    await R.handleDigestReply(ans("来週火曜にアポです"), x.deps);
    assert.equal(x.owner[0].text, "💬 担当：天満の資料を送る → 『来週火曜にアポです』");
    assert.deepEqual(x.noted[0].opts, { noForward: false });
    assert.deepEqual(x.logs, ["[staff-digest] ask answer 1 queued"]);
    const y = mkAns({ owner: true });
    await R.handleDigestReply(ans("自分で確認しました"), y.deps);
    assert.equal(y.owner.length, 0);
    assert.deepEqual(y.noted[0].opts, { noForward: true });
    const z = mkAns();
    z.deps.appendNote = async () => { throw new Error("notion"); };
    assert.deepEqual(await R.handleDigestReply(ans("来週火曜にアポです"), z.deps), { handled: true, committed: false });
    assert.deepEqual(z.replies, ["⚠️ 回答を書き込めませんでした。もう一度お試しください。"]);
    assert.equal(z.owner.length + z.done.length + z.noted.length, 0);
  });

  // ── 返事が無いとき：夕方の［催促する］ ──
  const row = (askId: string, taskId: string, title: string, o: Partial<R.AskRow> = {}): R.AskRow => ({ askId, taskId, title, assignee: "小笠原", assigneeUserId: OGA, at: NOW, ...o });

  await t("まだ返事の無い「聞いた件」：同じタスクに何度も聞いていたら1件に。どれかに返事があれば外す", () => {
    const rows = [row("A1", "t1", "天満の資料を送る"), row("A2", "t2", "鍵の手配"), row("A3", "t1", "天満の資料を送る", { at: NOW + 1 })];
    assert.deepEqual(R.openAsks(rows, []).map((r) => r.askId), ["A3", "A2"]);
    assert.deepEqual(R.openAsks(rows, ["A1"]).map((r) => r.askId), ["A2"]);
    assert.deepEqual(R.openAsks("x", []), []);
  });

  const nudgeDeps = (x: ReturnType<typeof mkKv>) => {
    const pushes: Array<{ to: string; messages: unknown[]; key: string }> = [];
    const logs: string[] = [];
    return { pushes, logs, deps: { env: ON, kv: x.kv, owner: OWNER, now: () => NOW, log: (l: string) => logs.push(l), push: async (to: string, messages: unknown[], key: string) => { pushes.push({ to, messages, key }); return 200; } } };
  };

  await t("夕方の前：聞いて返事の無い件を［催促する］のカードに「（聞いた件）題名」で載せる（朝のまとめの分が無い日でも出す）", async () => {
    const x = mkKv();
    x.lists.set(R.askListKey(DAY), [row("A1", "t1", "天満の資料を送る"), row("A2", "t2", "鍵の手配", { assignee: null, assigneeUserId: null })]);
    x.sets.set(R.askDoneKey(DAY), new Set(["A2"]));
    const f = nudgeDeps(x);
    assert.equal(await R.askNudge(DAY, [], f.deps), "asked");
    const card = JSON.stringify(f.pushes[0].messages[0]);
    assert.ok(card.includes("聞いた件に、まだ返事がありません（1件）"));
    assert.ok(card.includes("・小笠原さん：（聞いた件）天満の資料を送る"));
    assert.ok(!card.includes("鍵の手配"));
    assert.ok(card.includes(`"data":"v1|sd|${DAY}"`));
    assert.deepEqual((x.m.get(R.askNudgeKey(DAY)) as R.AskRow[]).map((r) => r.askId), ["A1"]);
    assert.deepEqual(f.logs, ["[staff-digest] nudge asked 0 ask 1"]);
    // 朝のまとめの分と一緒のときは、見出しは今までどおりで、聞いた件は別の段
    const y = mkKv();
    y.m.set(R.amKey(DAY), [{ id: "a", n: 1, title: "査定書を作る", assignee: "山口", assigneeUserId: null, status: "未着手", due: "" }]);
    y.lists.set(R.askListKey(DAY), [row("A1", "t1", "天満の資料を送る")]);
    const g = nudgeDeps(y);
    assert.equal(await R.askNudge(DAY, [{ id: "a", status: "未着手", dueDate: "" }], g.deps), "asked");
    const card2 = JSON.stringify(g.pushes[0].messages[0]);
    for (const w of ["朝のまとめに返事が無いタスクが 1件あります", "・1. 査定書を作る", "聞いた件（返事なし）", "（聞いた件）天満の資料を送る"]) assert.ok(card2.includes(w), w);
  });

  await t("催促のグループの文：朝の分の行のあとに「@担当 『題名』の件も、返信で教えてください」（1日1通のまま）", async () => {
    const am: R.AmEntry[] = [{ id: "a", n: 1, title: "査定書を作る", assignee: "小笠原", assigneeUserId: OGA, status: "未着手", due: "" }];
    assert.deepEqual(R.nudgeChunks(am, [row("A1", "t1", "天満の資料を送る"), row("A2", "t2", "鍵の{手配}", { assignee: "山口", assigneeUserId: null }), row("A3", "t3", "看板", { assignee: null, assigneeUserId: null })]), [{
      text: [
        "{m1} 朝の件、進み具合を返信で教えてください（1）",
        "{m2} 『天満の資料を送る』の件も、返信で教えてください",
        "山口さん 『鍵の（手配）』の件も、返信で教えてください",
        "『看板』の件も、返信で教えてください",
        "",
        "朝のまとめか、このメッセージに返信（リプライ）で、番号をつけて答えてください",
      ].join("\n"),
      mentions: { m1: OGA, m2: OGA },
    }]);
    // ［催促する］：聞いた件だけでも送る。カードのあとに返事が来た件は外す
    const x = mkKv();
    x.m.set(R.askNudgeKey(DAY), [row("A1", "t1", "天満の資料を送る"), row("A2", "t2", "鍵の手配")]);
    x.sets.set(R.askDoneKey(DAY), new Set(["A2"]));
    const sent: Array<{ text: string }> = [];
    const replies: string[] = [];
    await R.handleSdPostback({ day: DAY }, { userId: OWNER }, {
      env: ON, kv: x.kv, owner: OWNER, now: () => NOW, log: () => undefined,
      pushGroup: async (chunk) => { sent.push(chunk); return { status: 200, ids: [] }; },
      reply: async (text) => { replies.push(text); },
    });
    assert.equal(sent[0].text.split("\n")[0], "{m1} 『天満の資料を送る』の件も、返信で教えてください");
    assert.ok(!sent[0].text.includes("鍵の手配"));
    assert.deepEqual(replies, ["📣 グループへ催促を送りました（1件）"]);
  });

  await t("本物へのつなぎ：STAFF_DIGEST が無ければ、ボタンの付け方・1通の取り込みは何も呼ばない（外へ出たら落ちる）", async () => {
    delete process.env.STAFF_DIGEST;
    process.env.TASK_BUTTONS_ADMIN_IDS = OWNER;
    const W = await import("../src/lib/staff-ask-wire");
    assert.equal(W.askButtonFor({ userId: OWNER }), false);
    assert.equal(await W.handleStaffAskText({ userId: OWNER, text: "アポ取れてる？" }, async () => { throw new Error("返事しない"); }), false);
    process.env.STAFF_DIGEST = "1";
    assert.equal(W.askButtonFor({ userId: OWNER }), true);
    assert.equal(W.askButtonFor({ userId: OWNER, groupId: G }), false);
    assert.equal(W.askButtonFor({ userId: OGA }), false);
    delete process.env.STAFF_DIGEST;
  });

  console.log(`\n${n} passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
