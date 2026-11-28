/** 担当へのまとめ・段階3：リプライの取り込み（進捗）・下村さんへの知らせ・［催促する］ */
import assert from "node:assert/strict";
import * as R from "../src/lib/staff-digest-reply";
import { digestMsgKey } from "../src/lib/staff-digest";

let n = 0;
const t = async (name: string, f: () => Promise<void> | void) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const ON = { STAFF_DIGEST: "1" };
const OWNER = "U" + "b".repeat(32);
const OGA = "U" + "1".repeat(32);
const YAMA = "U" + "2".repeat(32);
const G = "C" + "a".repeat(32);
const NOW = Date.UTC(2026, 10, 28, 1, 30); // JST 11/28 10:30
const DAY = "2026-11-28";

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
    lrange: async (k, a, b) => { ops.push(`lrange ${k}`); return (lists.get(k) ?? []).slice(a, b + 1); },
    ltrim: async (k, a) => { ops.push(`ltrim ${k}`); lists.set(k, (lists.get(k) ?? []).slice(a)); },
    sadd: async (k, vs) => { ops.push(`sadd ${k}`); const s = sets.get(k) ?? new Set<string>(); vs.forEach((v) => s.add(v)); sets.set(k, s); },
    smembers: async (k) => { ops.push(`smembers ${k}`); return Array.from(sets.get(k) ?? []); },
  };
  return { kv, m, lists, sets, ops };
}

// 今の言葉（済・待ち・延期・不要）の見分けの代わり
const isKnown = (line: string) => /^\d+\s*(済|完了|待ち|延期|不要)/.test(line);

function mkReply(o: { env?: Record<string, string>; tasks?: Record<number, { id: string; title: string }>; name?: string | null; appendFail?: boolean } = {}) {
  const x = mkKv();
  const notes: Array<{ id: string; lines: string[] }> = [];
  const replies: string[] = [];
  const logs: string[] = [];
  const noted: R.ReplyItem[][] = [];
  const known: string[] = [];
  const tasks = o.tasks ?? { 3: { id: "p3", title: "天満の資料を送る" }, 2: { id: "p2", title: "売主へ電話" } };
  const deps: R.DigestReplyDeps = {
    env: o.env ?? ON,
    now: () => NOW,
    kv: x.kv,
    isKnown,
    runKnown: async (line) => { known.push(line); return { text: `☑️ 完了にしました（1件）\n1. 鍵の手配`, changed: [{ id: "p1", title: "鍵の手配", what: "済" }] }; },
    findByNumber: async (num) => tasks[num] ?? null,
    appendNote: async (id, lines) => { if (o.appendFail) throw new Error("x"); notes.push({ id, lines }); },
    senderName: async () => (o.name === undefined ? "小笠原" : o.name),
    reply: async (text) => { replies.push(text); },
    note: async (items) => { noted.push(items); },
    log: (l) => logs.push(l),
  };
  return { ...x, deps, notes, replies, logs, noted, known };
}
const msg = (text: string, quoted: string | null = "D1", groupId: string | null = G) => ({ text, quotedMessageId: quoted, groupId, userId: OGA });

async function main() {
  // ── 読み方 ──
  await t("読み方：番号＋文だけを進捗として読む（雑談・単位つきの数字・今の言葉だけの返事は読まない）", () => {
    const p = (s: string) => R.parseDigestReply(s, isKnown);
    assert.deepEqual(p("3 アポ取れました。来週火曜です"), [{ kind: "progress", numbers: [3], body: "アポ取れました。来週火曜です" }]);
    assert.deepEqual(p("３　アポ取れました"), [{ kind: "progress", numbers: [3], body: "アポ取れました" }]);
    assert.deepEqual(p("3. アポ取れました"), [{ kind: "progress", numbers: [3], body: "アポ取れました" }]);
    assert.deepEqual(p("3）アポ取れました"), [{ kind: "progress", numbers: [3], body: "アポ取れました" }]);
    assert.deepEqual(p("3、アポ取れました"), [{ kind: "progress", numbers: [3], body: "アポ取れました" }]);
    assert.deepEqual(p("3： 10時に内見です"), [{ kind: "progress", numbers: [3], body: "10時に内見です" }]);
    assert.deepEqual(p("1,2 まだです"), [{ kind: "progress", numbers: [1, 2], body: "まだです" }]);
    assert.deepEqual(p("3 小笠原が担当します"), [{ kind: "progress", numbers: [3], body: "小笠原が担当します" }]);
    // 雑談・番号でないもの
    // 番号のあとに区切りが無いものは読まない（「3ヶ月後に…」「1つ確認ですが」を番号と取り違えない）。小数・時刻も読まない
    for (const s of ["こんにちは", "了解です", "3", "3アポ取れました", "3件アポ取れました", "3ヶ月後に決済です", "1つ確認ですが", "10時に電話します", "12/3 に内見です", "3,000万円で申込です", "3.5万円で申込です", "10:30に電話します", "2階の鍵です", "100 まだです", "0 まだです", ""]) {
      assert.equal(p(s), null, s);
    }
    // 今の言葉だけ（「3済」）は今までの道に任せる
    assert.equal(p("3済"), null);
    assert.equal(p("3待ち 売主の書類 金曜"), null);
    assert.equal(p("1済\n2完了"), null);
    // 候補への返事（「1 登録」「2 なし」）の行が1つでもあれば読まない
    const cand = (l: string) => /^\d+\s*(登録|なし)$/.test(l);
    assert.equal(R.parseDigestReply("1 登録", isKnown, cand), null);
    assert.equal(R.parseDigestReply("2 なし\n3 まだです", isKnown, cand), null);
    assert.deepEqual(R.parseDigestReply("3 登録は来週します", isKnown, cand), [{ kind: "progress", numbers: [3], body: "登録は来週します" }]);
  });

  await t("読み方：「3 契約済みです」は進捗、「3済」は今までどおり完了（まとめを引用した返信の中だけの決まり）", () => {
    // 本物のつなぎと同じ見分け：完了の言葉だけの形のときだけ「今の言葉」
    const p = (s: string) => R.parseDigestReply(s, R.isBareCompletion);
    assert.deepEqual(p("3 契約済みです"), [{ kind: "progress", numbers: [3], body: "契約済みです" }]);
    assert.deepEqual(p("3 連絡済みです"), [{ kind: "progress", numbers: [3], body: "連絡済みです" }]);
    for (const s of ["3済", "3 済", "3完了", "3おわった", "1,2完了"]) assert.equal(p(s), null, s);
    assert.deepEqual(p("1済\n2 連絡済みです"), [{ kind: "known", raw: "1済" }, { kind: "progress", numbers: [2], body: "連絡済みです" }]);
    // 区切りの無い「3連絡済みです」は読まない（今までの流れに任せる）
    assert.equal(p("3連絡済みです"), null);
  });

  await t("読み方：まとめへの返信の中では、番号＋完了の言葉だけを完了と読む（文になっていれば進捗）", () => {
    for (const s of ["3済", "3 済", "３済み", "3完了", "3おわった", "1,2完了", "1 2 済", "4 終わりました", "3 完了しました。", "3 done"]) assert.equal(R.isBareCompletion(s), true, s);
    for (const s of ["3 契約済みです", "3 連絡済みです", "3 決済完了の連絡をしました", "3 もう終わったと思います", "3 済んでいません", "済", "3"]) assert.equal(R.isBareCompletion(s), false, s);
  });

  await t("読み方：改行で分けた各行を1件に。番号の無い行は前の進捗の続き。今の言葉の行も順に残す", () => {
    const p = (s: string) => R.parseDigestReply(s, isKnown);
    assert.deepEqual(p("1済\n2 まだです"), [{ kind: "known", raw: "1済" }, { kind: "progress", numbers: [2], body: "まだです" }]);
    assert.deepEqual(p("3 アポ取れました\n来週火曜です\n\n2 まだです"), [
      { kind: "progress", numbers: [3], body: "アポ取れました 来週火曜です" },
      { kind: "progress", numbers: [2], body: "まだです" },
    ]);
    // 先頭が番号でない・今の言葉の行のあとに文が続く → 読まない（今までどおり）
    assert.equal(p("お疲れ様です\n3 アポ取れました"), null);
    assert.equal(p("1済\nありがとうございます"), null);
  });

  // ── 進捗の取り込み ──
  await t("off なら KV を1回も触らない（Notion・返事・ログも無し）", async () => {
    const x = mkReply({ env: {} });
    assert.deepEqual(await R.handleDigestReply(msg("3 アポ取れました"), x.deps), { handled: false, committed: false });
    assert.equal(x.ops.length + x.notes.length + x.replies.length + x.logs.length + x.noted.length, 0);
  });

  await t("引用が無い・グループでない・雑談は、on でも KV を触らず今までどおり", async () => {
    const x = mkReply();
    x.m.set(digestMsgKey("D1"), { at: 1, slot: "am" });
    for (const m of [msg("3 アポ取れました", null), msg("3 アポ取れました", "D1", null), msg("了解です"), msg("👍"), msg("1 登録")]) {
      assert.deepEqual(await R.handleDigestReply({ ...m }, { ...x.deps, isOther: (l) => /^\d+\s*(登録|なし)$/.test(l) }), { handled: false, committed: false });
    }
    assert.equal(x.ops.length + x.notes.length + x.replies.length + x.logs.length, 0);
    // 今の言葉だけの返事（「3済」）は、引用先が「担当に聞く」のメッセージかを見るために KV を1回読むだけで、今までの流れへ
    assert.deepEqual(await R.handleDigestReply(msg("3済"), x.deps), { handled: false, committed: false });
    assert.deepEqual([x.ops.length, x.notes.length + x.replies.length + x.logs.length + x.known.length], [1, 0]);
    x.ops.length = 0;
    // 番号の控えの無い古いまとめ（1通に全員ぶん）への番号なしの文は、KV を1回読むだけで受けない
    assert.deepEqual(await R.handleDigestReply(msg("3件アポ取れました"), x.deps), { handled: false, committed: false });
    assert.deepEqual([x.ops.length, x.notes.length + x.replies.length + x.logs.length], [1, 0]);
  });

  await t("番号の無い文として読むもの・読まないもの（あいづち・絵文字だけ・1字・メンションつき・今の言葉は読まない）", () => {
    const f = (text: string, hasMention = false) => R.freeTextOf({ text, hasMention }, isKnown, (l) => /^\d+\s*(登録|なし)$/.test(l));
    assert.equal(f("先方に送りました"), "先方に送りました");
    assert.equal(f("送りました\n返事待ちです"), "送りました 返事待ちです");
    assert.equal(f("済"), "済"); // 番号を付ければ今の言葉（「1 済」）になるものは、1字でも読む
    assert.equal(f("完了しました"), "完了しました");
    assert.equal(f("了解です。明日の10時に内見に行きます"), "了解です。明日の10時に内見に行きます");
    for (const s of ["了解です", "承知しました！", "ありがとうございます", "OK", "はい", "👍", "🙏🙏", "！？", "あ", "", "3済", "1 登録"]) assert.equal(f(s), null, s);
    assert.equal(f("これタスクにして", true), null);
  });

  await t("番号の無い返信：引用した通のタスクが1件だけなら、そのタスクの進捗として記録する", async () => {
    const x = mkReply();
    x.m.set(digestMsgKey("D1"), { at: 1, slot: "am", nums: [3], uid: OGA });
    assert.deepEqual(await R.handleDigestReply(msg("先方に送りました。\n返事待ちです"), x.deps), { handled: true, committed: true });
    assert.deepEqual(x.notes, [{ id: "p3", lines: ["進捗（11/28 小笠原）：先方に送りました。 返事待ちです"] }]);
    assert.deepEqual(x.replies, ["📝 3 の進捗を記録しました"]);
    assert.deepEqual(x.logs, ["[staff-digest] reply progress 1"]);
  });

  await t("番号の無い返信（1件の通）：「完了しました」「終わりました」はその番号の完了として今の処理へ（進捗には書かない）", async () => {
    const x = mkReply();
    x.m.set(digestMsgKey("D1"), { at: 1, slot: "am", nums: [3], uid: OGA });
    // 本物のつなぎと同じ見分け（番号＋完了の言葉だけ）
    const deps = { ...x.deps, isKnown: R.isBareCompletion };
    assert.deepEqual(await R.handleDigestReply(msg("完了しました"), deps), { handled: true, committed: true });
    assert.deepEqual(await R.handleDigestReply(msg("終わりました"), deps), { handled: true, committed: true });
    assert.deepEqual(await R.handleDigestReply(msg("済"), deps), { handled: true, committed: true });
    assert.deepEqual(x.known, ["3 完了しました", "3 終わりました", "3 済"]);
    assert.equal(x.notes.length, 0);
    // 文になっていれば進捗（「契約済みです」）
    await R.handleDigestReply(msg("契約済みです"), deps);
    assert.deepEqual(x.notes, [{ id: "p3", lines: ["進捗（11/28 小笠原）：契約済みです"] }]);
  });

  await t("番号の無い返信：引用した通のタスクが2件以上なら、番号を聞き返すだけ（何も書かない）。メンションつき・あいづちは今までどおり", async () => {
    const x = mkReply();
    x.m.set(digestMsgKey("D1"), { at: 1, slot: "eve", nums: [2, 3], uid: OGA });
    assert.deepEqual(await R.handleDigestReply(msg("先方に送りました"), x.deps), { handled: true, committed: false });
    assert.deepEqual(x.replies, ["どの番号の件か分かりませんでした。番号をつけて返信してください（例：「1 送りました」）"]);
    assert.deepEqual([x.notes.length, x.noted.length, x.logs], [0, 0, ["[staff-digest] reply no-number"]]);
    const ops = x.ops.length;
    // @AI秘書 あて・あいづちは KV も読まない
    assert.deepEqual(await R.handleDigestReply({ ...msg("これお願いします"), hasMention: true, mentionsBot: true }, x.deps), { handled: false, committed: false });
    assert.deepEqual(await R.handleDigestReply(msg("ありがとうございます"), x.deps), { handled: false, committed: false });
    assert.equal(x.ops.length, ops);
    // 人へのメンションつきは、引用先が「担当に聞く」のメッセージかを見るために1回読むだけ（まとめなら受けない）
    assert.deepEqual(await R.handleDigestReply({ ...msg("これお願いします"), hasMention: true }, x.deps), { handled: false, committed: false });
    assert.equal(x.ops.length, ops + 1);
    assert.equal(x.replies.length, 1);
  });

  await t("番号つきの返信：引用した通に載っていない番号でも、今のまとめの番号なら受ける（別の人の通を引用していても）", async () => {
    const x = mkReply();
    x.m.set(digestMsgKey("D1"), { at: 1, slot: "am", nums: [7], uid: YAMA });
    assert.deepEqual(await R.handleDigestReply(msg("3 アポ取れました"), x.deps), { handled: true, committed: true });
    assert.deepEqual(x.notes.map((n) => n.id), ["p3"]);
  });

  await t("引用先がまとめでなければ受けない（KV を1回読むだけ）", async () => {
    const x = mkReply();
    assert.deepEqual(await R.handleDigestReply(msg("3 アポ取れました", "other"), x.deps), { handled: false, committed: false });
    assert.deepEqual(x.ops, [`get ${digestMsgKey("other")}`]);
    assert.equal(x.notes.length + x.replies.length, 0);
  });

  await t("まとめを引用した「3 アポ取れました。来週火曜です」：Notion に追記・短い返事・知らせの控え・ログは件数だけ", async () => {
    const x = mkReply();
    x.m.set(digestMsgKey("D1"), { at: 1, slot: "am" });
    assert.deepEqual(await R.handleDigestReply(msg("3 アポ取れました。来週火曜です"), x.deps), { handled: true, committed: true });
    assert.deepEqual(x.notes, [{ id: "p3", lines: ["進捗（11/28 小笠原）：アポ取れました。来週火曜です"] }]);
    assert.deepEqual(x.replies, ["📝 3 の進捗を記録しました"]);
    assert.deepEqual(x.noted, [[{ id: "p3", title: "天満の資料を送る", what: "進捗「アポ取れました。来週火曜です」" }]]);
    assert.deepEqual(x.logs, ["[staff-digest] reply progress 1"]);
  });

  await t("名簿に無い人は「担当」。見つからない番号は知らせる（書かない）", async () => {
    const x = mkReply({ name: null });
    x.m.set(digestMsgKey("D1"), { at: 1, slot: "eve" });
    const r = await R.handleDigestReply(msg("3 連絡済みです\n9 まだです"), x.deps);
    assert.deepEqual(r, { handled: true, committed: true });
    assert.deepEqual(x.notes, [{ id: "p3", lines: ["進捗（11/28 担当）：連絡済みです"] }]);
    assert.equal(x.replies[0], "📝 3 の進捗を記録しました\n⚠️ 9番は見つかりませんでした\n（完了済みか、直近のまとめに無い番号です）");
    assert.deepEqual(x.logs, ["[staff-digest] reply progress 1 not-found 1"]);
  });

  await t("1通に複数（「1済」＋「2 まだです」）：今の言葉は今の処理へ、進捗は追記。返事は1通", async () => {
    const x = mkReply();
    x.m.set(digestMsgKey("D1"), { at: 1, slot: "am" });
    const r = await R.handleDigestReply(msg("1済\n2 まだです。明日電話します"), x.deps);
    assert.deepEqual(r, { handled: true, committed: true });
    assert.deepEqual(x.known, ["1済"]);
    assert.deepEqual(x.notes, [{ id: "p2", lines: ["進捗（11/28 小笠原）：まだです。明日電話します"] }]);
    assert.deepEqual(x.replies, ["☑️ 完了にしました（1件）\n1. 鍵の手配\n\n📝 2 の進捗を記録しました"]);
    assert.deepEqual(x.noted[0].map((i) => i.what), ["済", "進捗「まだです。明日電話します」"]);
  });

  await t("Notion に書けなければ、書けなかったと返す（記録したとは言わない。知らせにも載せない）", async () => {
    const x = mkReply({ appendFail: true });
    x.m.set(digestMsgKey("D1"), { at: 1, slot: "am" });
    assert.deepEqual(await R.handleDigestReply(msg("3 アポ取れました"), x.deps), { handled: true, committed: false });
    assert.deepEqual(x.replies, ["⚠️ 3 の進捗を書き込めませんでした。もう一度お試しください。"]);
    assert.equal(x.noted.length, 0);
    assert.deepEqual(x.logs, ["[staff-digest] reply progress 0 write-failed 1"]);
  });

  await t("ログに本文・題名・ID を出さない", async () => {
    const x = mkReply();
    x.m.set(digestMsgKey("D1"), { at: 1, slot: "am" });
    await R.handleDigestReply(msg("3 アポ取れました"), x.deps);
    for (const l of x.logs) assert.ok(!/アポ|天満|D1|U1|Ca|p3/.test(l), l);
  });

  // ── 下村さんへの知らせ ──
  const fwdDeps = (x: ReturnType<typeof mkKv>, o: { env?: Record<string, string>; owner?: string | null; status?: Array<number | null> } = {}) => {
    const pushes: Array<{ to: string; messages: unknown[]; key: string }> = [];
    const logs: string[] = [];
    const st = [...(o.status ?? [])];
    return {
      pushes, logs,
      deps: {
        env: o.env ?? ON, kv: x.kv, owner: o.owner === undefined ? OWNER : o.owner, log: (l: string) => logs.push(l),
        push: async (to: string, messages: unknown[], key: string) => { pushes.push({ to, messages, key }); return st.length > 0 ? st.shift()! : 200; },
      },
    };
  };
  const rec = (x: ReturnType<typeof mkKv>, items: R.ReplyItem[], who = "小笠原", userId = OGA, env: Record<string, string> = ON) =>
    R.recordReplies({ userId, name: who, items, now: NOW }, { env, kv: x.kv, owner: OWNER, log: () => undefined });

  await t("返事の控え：答えた ID を集合に、知らせの列に1件ずつ。off なら KV を触らない", async () => {
    const x = mkKv();
    await rec(x, [{ id: "p1", title: "鍵の手配", what: "済" }], "小笠原", OGA, {});
    assert.equal(x.ops.length, 0);
    await rec(x, [{ id: "p1", title: "鍵の手配", what: "済" }]);
    assert.deepEqual(Array.from(x.sets.get(R.answeredKey(DAY)) ?? []), ["p1"]);
    assert.deepEqual(x.lists.get(R.FWD_KEY), [{ at: NOW, who: "小笠原", title: "鍵の手配", what: "済" }]);
  });

  await t("下村さん本人の返事は、知らせには載せない（答えた印は付ける）。名簿で同じ人の別アカウントも同じ", async () => {
    const x = mkKv();
    await rec(x, [{ id: "p1", title: "鍵の手配", what: "済" }], "下村", OWNER);
    assert.deepEqual(Array.from(x.sets.get(R.answeredKey(DAY)) ?? []), ["p1"]);
    assert.equal(x.lists.get(R.FWD_KEY), undefined);
    await R.recordReplies(
      { userId: YAMA, name: "下村", items: [{ id: "p2", title: "x", what: "済" }], now: NOW, sameAsOwner: true },
      { env: ON, kv: x.kv, owner: OWNER, log: () => undefined },
    );
    assert.deepEqual(Array.from(x.sets.get(R.answeredKey(DAY)) ?? []), ["p1", "p2"]);
    assert.equal(x.lists.get(R.FWD_KEY), undefined);
  });

  await t("KV が落ちていても控えは例外を投げない（今の返事を壊さない）", async () => {
    const boom = new Proxy({}, { get: () => async () => { throw new Error("kv down"); } }) as R.SdKv;
    const logs: string[] = [];
    await R.recordReplies({ userId: OGA, name: "小笠原", items: [{ id: "p1", title: "x", what: "済" }], now: NOW }, { env: ON, kv: boom, owner: OWNER, log: (l) => logs.push(l) });
    assert.deepEqual(logs, ["[staff-digest] fwd note-failed"]);
  });

  await t("知らせ：30分に1回、まとめて1通（retry key つき）。送れたら列から消す", async () => {
    const x = mkKv();
    await rec(x, [{ id: "p1", title: "天満の資料を送る", what: "済" }]);
    await rec(x, [{ id: "p2", title: "査定書を作る", what: "待ち（売主の書類）" }], "山口", YAMA);
    await rec(x, [{ id: "p3", title: "売主へ電話", what: "進捗「アポ取れました」" }], null as unknown as string);
    const f = fwdDeps(x);
    assert.equal(await R.flushForward(NOW, f.deps), "sent");
    assert.equal(f.pushes.length, 1);
    assert.equal(f.pushes[0].to, OWNER);
    assert.deepEqual(f.pushes[0].messages, [{
      type: "text",
      text: "💬 グループの返事（3件）\n・小笠原さん：天満の資料を送る → 済\n・山口さん：査定書を作る → 待ち（売主の書類）\n・担当：売主へ電話 → 進捗「アポ取れました」",
    }]);
    assert.ok(f.pushes[0].key.startsWith("sd-fwd:"));
    assert.deepEqual(x.lists.get(R.FWD_KEY), []);
    assert.deepEqual(f.logs, ["[staff-digest] fwd sent 3"]);
    // 30分のあいだは次を送らない
    await rec(x, [{ id: "p4", title: "看板の確認", what: "不要" }]);
    assert.equal(await R.flushForward(NOW + 60_000, f.deps), "wait");
    assert.equal(f.pushes.length, 1);
    // 枠が明けたら、たまった分を1通
    x.m.delete(R.FWD_GUARD_KEY);
    assert.equal(await R.flushForward(NOW + 31 * 60_000, f.deps), "sent");
    assert.equal(f.pushes.length, 2);
  });

  await t("知らせ：0件なら送らない。送れなければ列に残す。off・仕分ける人なしは KV を触らない", async () => {
    const x = mkKv();
    const f = fwdDeps(x, { status: [500] });
    assert.equal(await R.flushForward(NOW, f.deps), "empty");
    assert.equal(f.pushes.length, 0);
    x.m.delete(R.FWD_GUARD_KEY);
    await rec(x, [{ id: "p1", title: "鍵の手配", what: "済" }]);
    assert.equal(await R.flushForward(NOW, f.deps), "failed");
    assert.equal(x.lists.get(R.FWD_KEY)?.length, 1);
    assert.deepEqual(f.logs, ["[staff-digest] fwd push-failed"]);

    const y = mkKv();
    assert.equal(await R.flushForward(NOW, fwdDeps(y, { env: {} }).deps), "off");
    assert.equal(await R.flushForward(NOW, fwdDeps(y, { owner: null }).deps), "no-owner");
    assert.equal(y.ops.length, 0);
  });

  // ── 催促 ──
  const AM: R.AmEntry[] = [
    { id: "a", n: 1, title: "天満の資料を送る", assignee: "小笠原", assigneeUserId: OGA, status: "未着手", due: "2026-11-28" },
    { id: "b", n: 2, title: "査定書を作る", assignee: "山口", assigneeUserId: null, status: "未着手", due: "2026-11-29" },
    { id: "c", n: 3, title: "鍵の手配", assignee: null, assigneeUserId: null, status: "未着手", due: "" },
    { id: "d", n: 4, title: "売主へ電話", assignee: "小笠原", assigneeUserId: OGA, status: "進行中", due: "2026-11-28" },
    { id: "e", n: 5, title: "看板の確認", assignee: "小笠原", assigneeUserId: OGA, status: "未着手", due: "2026-11-28" },
  ];
  const cur = (over: Record<string, { status?: string; dueDate?: string } | null> = {}) =>
    AM.filter((a) => over[a.id] !== null).map((a) => ({ id: a.id, status: over[a.id]?.status ?? a.status, dueDate: over[a.id]?.dueDate ?? a.due }));

  await t("朝に出したタスクを控える（off の道からは呼ばれない。失敗しても投げない）", async () => {
    const x = mkKv();
    const logs: string[] = [];
    await R.saveMorningSnapshot(DAY, AM.map((a) => ({ n: a.n, task: { id: a.id, title: a.title, assignee: a.assignee, assigneeUserId: a.assigneeUserId, status: a.status, dueDate: a.due } })), x.kv, (l) => logs.push(l));
    assert.deepEqual(x.m.get(R.amKey(DAY)), AM);
    const boom = new Proxy({}, { get: () => async () => { throw new Error("kv down"); } }) as R.SdKv;
    await R.saveMorningSnapshot(DAY, [], boom, (l) => logs.push(l));
    assert.deepEqual(logs, ["[staff-digest] am snapshot-failed"]);
  });

  await t("夕方の前：朝から変わっていない・返事も無いものだけ、下村さんへカード（［催促する］）", async () => {
    const x = mkKv();
    x.m.set(R.amKey(DAY), AM);
    x.sets.set(R.answeredKey(DAY), new Set(["d"])); // 4 は進捗の返事があった
    const f = fwdDeps(x);
    // 2 は完了（一覧に無い）、5 は期日が変わった
    const r = await R.askNudge(DAY, cur({ b: null, e: { dueDate: "2026-12-01" } }), f.deps);
    assert.equal(r, "asked");
    assert.equal(f.pushes.length, 1);
    assert.equal(f.pushes[0].to, OWNER);
    assert.equal(f.pushes[0].key, `sd-nudge-ask:${DAY}`);
    const card = JSON.stringify(f.pushes[0].messages[0]);
    assert.ok(card.includes("朝のまとめに返事が無いタスクが 2件あります"));
    assert.ok(card.includes("小笠原さん") && card.includes("1. 天満の資料を送る"));
    assert.ok(card.includes("担当が決まっていないもの") && card.includes("3. 鍵の手配"));
    assert.ok(!card.includes("査定書を作る") && !card.includes("売主へ電話") && !card.includes("看板の確認"));
    assert.ok(card.includes(`"data":"v1|sd|${DAY}"`) && card.includes("催促する"));
    assert.deepEqual((x.m.get(R.nudgeKey(DAY)) as R.AmEntry[]).map((e) => e.n), [1, 3]);
    assert.deepEqual(f.logs, ["[staff-digest] nudge asked 2"]);
  });

  await t("夕方の前：Notion で直接更新されたタスクは返事ありと見る（朝の送信＋3分より後）。催促から外し、下村さんへの知らせに1回だけ足す", async () => {
    const AT = NOW - 9 * 3_600_000; // 朝の送信
    const iso = (ms: number) => new Date(ms).toISOString();
    const x = mkKv();
    x.m.set(R.amKey(DAY), AM.map((a) => ({ ...a, at: AT })));
    x.sets.set(R.answeredKey(DAY), new Set(["d"])); // 4 は LINE で返事済み（Notion も動いているが、知らせは重ねない）
    const f = fwdDeps(x);
    const current = AM.map((a) => ({ id: a.id, status: a.status, dueDate: a.due, lastEdited: iso(AT) }));
    current[0].lastEdited = iso(AT + 2 * 3_600_000);            // 1：担当が Notion に書いた
    current[1].lastEdited = iso(AT + 2 * 60_000);               // 2：朝の番号書き（3分以内）＝更新と数えない
    current[2].lastEdited = iso(AT + 3 * 60_000 + 1_000);       // 3：3分を過ぎた更新（担当なし）
    current[3].lastEdited = iso(AT + 5 * 3_600_000);            // 4：LINE で返事済み
    current[4].lastEdited = "";                                 // 5：読めない＝更新と数えない
    const r = await R.askNudge(DAY, current, { ...f.deps, now: () => NOW });
    assert.equal(r, "asked");
    assert.deepEqual(Array.from(x.sets.get(R.answeredKey(DAY)) ?? []).sort(), ["a", "c", "d"]);
    assert.deepEqual(x.lists.get(R.FWD_KEY), [
      { at: NOW, who: "小笠原", title: "天満の資料を送る", what: "Notion で更新" },
      { at: NOW, who: null, title: "鍵の手配", what: "Notion で更新" },
    ]);
    // 催促のカードに残るのは 2 と 5 だけ
    assert.deepEqual((x.m.get(R.nudgeKey(DAY)) as R.AmEntry[]).map((e) => e.n), [2, 5]);
    assert.deepEqual(f.logs, ["[staff-digest] notion-edited 2", "[staff-digest] nudge asked 2"]);
    // 知らせの文
    x.m.delete(R.FWD_GUARD_KEY);
    assert.equal(await R.flushForward(NOW, f.deps), "sent");
    assert.equal(
      (f.pushes[1].messages[0] as { text: string }).text,
      "💬 グループの返事（2件）\n・小笠原さん：天満の資料を送る → Notion で更新\n・担当：鍵の手配 → Notion で更新"
    );
    // もう一度見ても、同じタスクは足さない（返事の印が付いている）
    await R.askNudge(DAY, current, { ...f.deps, now: () => NOW });
    assert.deepEqual(x.lists.get(R.FWD_KEY), []);
  });

  await t("夕方の前：朝の控えに送信の時刻が無い（前の版の控え）・KV に書けないときも、今までどおり催促の判定をする", async () => {
    const x = mkKv();
    x.m.set(R.amKey(DAY), AM); // at なし
    const f = fwdDeps(x);
    const current = AM.map((a) => ({ id: a.id, status: a.status, dueDate: a.due, lastEdited: new Date(NOW).toISOString() }));
    assert.equal(await R.askNudge(DAY, current, f.deps), "asked");
    assert.deepEqual(f.logs, ["[staff-digest] nudge asked 5"]);
    assert.equal(x.lists.get(R.FWD_KEY), undefined);
    // 印・知らせの列に書けなくても投げない。更新されたタスクは催促から外す
    const y = mkKv();
    y.m.set(R.amKey(DAY), AM.map((a) => ({ ...a, at: NOW - 3_600_000 })));
    const g = fwdDeps(y);
    const kv = { ...y.kv, sadd: async () => { throw new Error("kv"); } };
    const cur2 = current.map((c, i) => ({ ...c, lastEdited: i === 0 ? c.lastEdited : "" }));
    assert.equal(await R.askNudge(DAY, cur2, { ...g.deps, kv }), "asked");
    assert.deepEqual(g.logs, ["[staff-digest] notion-edited note-failed", "[staff-digest] nudge asked 4"]);
  });

  await t("仕分ける人が担当のタスクの Notion の更新は、知らせには足さない（返事の印は付ける）", async () => {
    const x = mkKv();
    x.m.set(R.amKey(DAY), [{ ...AM[0], assignee: "下村", assigneeUserId: OWNER, at: NOW - 3_600_000 }]);
    const f = fwdDeps(x);
    assert.equal(await R.askNudge(DAY, [{ id: "a", status: AM[0].status, dueDate: AM[0].due, lastEdited: new Date(NOW).toISOString() }], f.deps), "none");
    assert.deepEqual(Array.from(x.sets.get(R.answeredKey(DAY)) ?? []), ["a"]);
    assert.equal(x.lists.get(R.FWD_KEY), undefined);
  });

  await t("朝の控えに送信の時刻を入れる", async () => {
    const x = mkKv();
    await R.saveMorningSnapshot(DAY, [{ n: 1, task: { id: "a", title: "x", assignee: null, assigneeUserId: null, status: "未着手", dueDate: "" } }], x.kv, () => undefined, 1234);
    assert.deepEqual(x.m.get(R.amKey(DAY)), [{ id: "a", n: 1, title: "x", assignee: null, assigneeUserId: null, status: "未着手", due: "", at: 1234 }]);
  });

  await t("夕方の前：全員から返事があれば何も送らない。朝の控えが無い日・off・仕分ける人なしも送らない", async () => {
    const x = mkKv();
    x.m.set(R.amKey(DAY), AM);
    x.sets.set(R.answeredKey(DAY), new Set(["a", "b", "c", "d", "e"]));
    const f = fwdDeps(x);
    assert.equal(await R.askNudge(DAY, cur(), f.deps), "none");
    assert.equal(await R.askNudge("2026-11-29", cur(), f.deps), "none");
    assert.equal(f.pushes.length, 0);
    const y = mkKv();
    assert.equal(await R.askNudge(DAY, cur(), fwdDeps(y, { env: {} }).deps), "off");
    assert.equal(await R.askNudge(DAY, cur(), fwdDeps(y, { owner: null }).deps), "off");
    assert.equal(y.ops.length, 0);
  });

  const mkPress = (o: { env?: Record<string, string>; status?: Array<number | null>; now?: number } = {}) => {
    const x = mkKv();
    x.m.set(R.nudgeKey(DAY), [AM[0], AM[2], AM[3], AM[1]]);
    const replies: string[] = [];
    const logs: string[] = [];
    const group: Array<Array<{ text: string; mentions: Record<string, string> }>> = [];
    const status = [...(o.status ?? [])];
    const keys: string[] = [];
    const deps: R.NudgeDeps = {
      env: o.env ?? ON, kv: x.kv, owner: OWNER, now: () => o.now ?? NOW,
      pushGroup: async (chunk, key) => { group.push([chunk]); keys.push(key); const s = status.length > 0 ? status.shift()! : 200; return { status: s, ids: s === 200 ? ["N1"] : [] }; },
      reply: async (text) => { replies.push(text); },
      log: (l) => logs.push(l),
    };
    return { ...x, deps, replies, logs, group, keys };
  };

  await t("ボタンの data：v1|sd|<日付> だけ読む", () => {
    assert.equal(R.encodeSd(DAY), `v1|sd|${DAY}`);
    assert.deepEqual(R.parseSdData(`v1|sd|${DAY}`), { day: DAY });
    for (const s of ["v1|sd|", "v1|sd|2026-1-1", "v1|gr|x|1", `v1|sd|${DAY}|x`, ""]) assert.equal(R.parseSdData(s), null);
  });

  await t("［催促する］：押したときだけ、グループへ担当ごとにまとめて1通（メンション）。二度押しは「もう送ってあります」", async () => {
    const x = mkPress();
    await R.handleSdPostback({ day: DAY }, { userId: OWNER }, x.deps);
    assert.equal(x.group.length, 1);
    assert.deepEqual(x.group[0], [{
      text: [
        "{m1} 朝の件、進み具合を返信で教えてください（1, 4）",
        "山口さん 朝の件、進み具合を返信で教えてください（2）",
        "担当が決まっていないもの（3）：どなたが進めるか、返信で教えてください",
        "",
        "朝のまとめか、このメッセージに返信（リプライ）で、番号をつけて答えてください",
      ].join("\n"),
      mentions: { m1: OGA },
    }]);
    assert.deepEqual(x.replies, ["📣 グループへ催促を送りました（4件）"]);
    assert.deepEqual(x.logs, ["[staff-digest] nudge sent"]);
    assert.deepEqual(x.keys, [`sd-nudge:${DAY}`]);
    // 催促のメッセージへの返信も、まとめへの返信として受けられるよう ID と番号を控える
    assert.deepEqual(x.m.get(digestMsgKey("N1")), { at: NOW, slot: "nudge", nums: [1, 3, 4, 2], uid: null, asks: [] });
    await R.handleSdPostback({ day: DAY }, { userId: OWNER }, x.deps);
    assert.equal(x.group.length, 1);
    assert.equal(x.replies[1], "もう送ってあります");
    assert.equal(x.logs[1], "[staff-digest] nudge already");
  });

  await t("［催促する］：押せるのは仕分ける人だけ。カードを出したあとに返事が来た分は外す", async () => {
    const x = mkPress();
    await R.handleSdPostback({ day: DAY }, { userId: OGA }, x.deps);
    assert.equal(x.group.length, 0);
    assert.deepEqual(x.replies, ["このボタンを押せるのは下村さんだけです"]);
    x.sets.set(R.answeredKey(DAY), new Set(["a", "c", "b"]));
    await R.handleSdPostback({ day: DAY }, { userId: OWNER }, x.deps);
    assert.equal(x.group[0][0].text.split("\n")[0], "{m1} 朝の件、進み具合を返信で教えてください（4）");
    x.m.delete(R.nudgedKey(DAY));
    x.sets.set(R.answeredKey(DAY), new Set(["a", "c", "b", "d"]));
    await R.handleSdPostback({ day: DAY }, { userId: OWNER }, x.deps);
    assert.equal(x.group.length, 1);
    assert.equal(x.replies[2], "もう全員から返事が届いています");
  });

  await t("［催促する］：前の日のカード・off は送らない。はっきり断られたら（4xx）印を外してもう一度押せる", async () => {
    const old = mkPress({ now: NOW + 86_400_000 });
    await R.handleSdPostback({ day: DAY }, { userId: OWNER }, old.deps);
    assert.equal(old.group.length, 0);
    assert.deepEqual(old.replies, ["このカードは古くなりました（催促できるのは、その日のうちだけです）"]);

    const off = mkPress({ env: {} });
    await R.handleSdPostback({ day: DAY }, { userId: OWNER }, off.deps);
    assert.deepEqual(off.replies, ["いまは止めています"]);
    assert.equal(off.ops.length + off.group.length, 0);

    const x = mkPress({ status: [429, 200] });
    await R.handleSdPostback({ day: DAY }, { userId: OWNER }, x.deps);
    assert.equal(x.replies[0], "⚠️ 送れませんでした。もう一度押してください");
    assert.equal(x.logs[0], "[staff-digest] nudge push-failed");
    assert.equal(x.m.has(R.nudgedKey(DAY)), false);
    await R.handleSdPostback({ day: DAY }, { userId: OWNER }, x.deps);
    assert.equal(x.replies[1], "📣 グループへ催促を送りました（4件）");
  });

  await t("［催促する］：結果が分からない（時間切れ・5xx）ときは印を残し、押し直しは同じ retry key で送る（409 は送れた扱い＝2通にならない）", async () => {
    const x = mkPress({ status: [null, 500, 409] });
    await R.handleSdPostback({ day: DAY }, { userId: OWNER }, x.deps);
    assert.equal(x.replies[0], "⚠️ 送れたか確かめられませんでした。グループに出ていなければ、もう一度押してください");
    assert.equal(x.logs[0], "[staff-digest] nudge unknown");
    assert.equal(x.m.get(R.nudgedKey(DAY)), "trying");
    await R.handleSdPostback({ day: DAY }, { userId: OWNER }, x.deps);
    assert.equal(x.m.get(R.nudgedKey(DAY)), "trying");
    await R.handleSdPostback({ day: DAY }, { userId: OWNER }, x.deps);
    assert.equal(x.replies[2], "📣 グループへ催促を送りました（4件）");
    assert.equal(x.m.get(R.nudgedKey(DAY)), "sent");
    // どの回も同じ retry key
    assert.deepEqual(x.keys, [`sd-nudge:${DAY}`, `sd-nudge:${DAY}`, `sd-nudge:${DAY}`]);
    await R.handleSdPostback({ day: DAY }, { userId: OWNER }, x.deps);
    assert.equal(x.replies[3], "もう送ってあります");
    assert.equal(x.group.length, 3);
  });

  await t("催促の1通を LINE のメッセージにする（メンションがあれば textV2）", () => {
    assert.deepEqual(R.chunkToMessage({ text: "a", mentions: {} }), { type: "text", text: "a" });
    assert.deepEqual(R.chunkToMessage({ text: "{m1} a", mentions: { m1: OGA } }), {
      type: "textV2", text: "{m1} a", substitution: { m1: { type: "mention", mentionee: { type: "user", userId: OGA } } },
    });
  });

  await t("状況の言葉の言い方（知らせ用）", () => {
    assert.equal(R.statusWhat({ kind: "wait", note: "売主の書類", date: "2026-12-04" }), "待ち（売主の書類）");
    assert.equal(R.statusWhat({ kind: "wait", note: "", date: null }), "待ち");
    assert.equal(R.statusWhat({ kind: "postpone", date: "2026-12-03" }), "延期（12/3）");
    assert.equal(R.statusWhat({ kind: "drop" }), "不要");
  });

  await t("本物へのつなぎ：STAFF_DIGEST が無ければ、どの入口も KV・Notion・LINE に触らず今までどおり（外へ出たら落ちる）", async () => {
    delete process.env.STAFF_DIGEST;
    const W = await import("../src/lib/staff-digest-reply-wire");
    const r = await W.tryDigestProgressReply({ text: "3 アポ取れました", quotedMessageId: "D1", groupId: G, userId: OGA, replyToken: "r", parseCompletion: () => { throw new Error("読まない"); } });
    assert.deepEqual(r, { handled: false, committed: false });
    await W.noteGroupReply({ groupId: G, userId: OGA }, [{ id: "p1", title: "x" }], "済");
    await W.flushStaffDigestForwardOnTick(NOW);
    // 状況の返事の横の控えは、今の処理の結果を変えない
    const tap = W.tapFound({ findByNumber: async (num) => (num === 1 ? { id: "p1", title: "x" } : null), update: async () => undefined, defaultCheckDate: async () => DAY });
    assert.deepEqual([await tap.deps.findByNumber(1), await tap.deps.findByNumber(2)], [{ id: "p1", title: "x" }, null]);
    assert.deepEqual(tap.hits, [{ id: "p1", title: "x" }]);
  });

  console.log(`\n${n} passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
