/** グループの依頼を下村さんの個人 LINE で仕分ける（GROUP_INBOX・2026-11-28） */
import assert from "node:assert/strict";
import type { Candidate } from "../src/lib/task-candidate";
import type { CandidateActionDeps } from "../src/lib/candidate-card";

process.env.LINE_CHANNEL_ACCESS_TOKEN = "t";
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;
let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };

const G1 = "C" + "1".repeat(32);
const OWNER = "U" + "a".repeat(32);
const ADMIN2 = "U" + "b".repeat(32);
const REQ = "U" + "c".repeat(32);
const TO = "U" + "d".repeat(32);
const NOW = Date.UTC(2026, 10, 28, 3);
const members = [
  { name: "依頼 太郎", userIds: [REQ], aliases: [], email: null, active: true, external: false, notionUserId: null },
  { name: "小笠原", userIds: [TO], aliases: [], email: null, active: true, external: false, notionUserId: null },
];
const cand = (id: string, o: Partial<Candidate> = {}): Candidate => ({
  id, text: "小笠原さん 天満の資料を先方に送っておいてください", title: "天満の資料を送る", assignee: "小笠原", assigneeUserId: TO,
  senderId: REQ, createdAt: NOW, groupId: G1, mentionedUserIds: [TO], ...o,
});
const env = (inbox: boolean) => {
  Object.assign(process.env, { TASK_MENU: "1", TASK_BUTTONS: "1", TASK_FOLLOWUP: "1", TASK_CANDIDATES: "1", LINE_GROUP_ID: G1, TASK_BUTTONS_ADMIN_IDS: `${OWNER},${ADMIN2}`, TASK_CANDIDATE_INSTANT: "1" });
  if (inbox) process.env.GROUP_INBOX = "1"; else delete process.env.GROUP_INBOX;
};

(async () => {
  const cc = await import("../src/lib/candidate-card");
  const ask = await import("../src/lib/task-candidate-ask");
  const nameOf = cc.nameResolver(members as never);

  const mk = (c: Candidate | null) => {
    const replies: string[] = [];
    const reg: Array<{ id: string; group: string }> = [];
    const removed: string[] = [];
    const deps: CandidateActionDeps = {
      get: async () => c, groupOf: (x) => x.groupId ?? G1, claimRegister: async () => true, releaseRegister: async () => undefined,
      remove: async (id) => { removed.push(id); }, hold: async () => undefined, members: async () => members as never,
      register: async (x, _t, g) => { reg.push({ id: x.id, group: g }); return "ok"; },
      reply: async (_t, text) => { replies.push(text); }, now: () => NOW, log: () => undefined,
    };
    return { deps, replies, reg, removed };
  };

  await t("スイッチ：GROUP_INBOX=1・候補カード on・仕分ける人の ID が正しいときだけ on", async () => {
    env(false); assert.equal(cc.groupInboxOn(), false);
    env(true); assert.equal(cc.groupInboxOn(), true);
    assert.equal(cc.inboxOwner(), OWNER);
    process.env.TASK_BUTTONS_ADMIN_IDS = "x"; assert.equal(cc.groupInboxOn(), false);
    env(true); process.env.TASK_CANDIDATES = ""; assert.equal(cc.groupInboxOn(), false);
  });
  await t("カード：依頼者・担当・本文の頭。ボタンは［タスクにする］［登録しない］だけ（保留は無い）", async () => {
    const j = JSON.stringify(cc.inboxCard(cand("m1"), nameOf));
    for (const w of ["グループの依頼", "天満の資料を送る", "依頼 太郎", "小笠原", "先方に送っておいてください", "タスクにする", "登録しない", "v1|cr|m1", "v1|cx|m1"]) assert.ok(j.includes(w), w);
    assert.ok(!j.includes("v1|ch|"));
    assert.ok(JSON.stringify(cc.inboxCard(cand("m2", { mentionedUserIds: [], assignee: null, assigneeUserId: null }), nameOf)).includes("未定"));
  });
  await t("知らせ：仕分ける人の1対1へ文字＋カードを1回。送れなくても投げない", async () => {
    env(true);
    const pushes: Array<{ to: string; text: string }> = [];
    const logs: string[] = [];
    assert.equal(await cc.notifyInboxNew(cand("m1"), { push: async (to, text) => { pushes.push({ to, text }); return true; }, members: async () => members as never, log: (l) => logs.push(l) }), "sent");
    assert.deepEqual(pushes, [{ to: OWNER, text: cc.MSG_INBOX_NEW }]);
    assert.equal(await cc.notifyInboxNew(cand("m1"), { push: async () => { throw new Error("x"); }, members: async () => [], log: (l) => logs.push(l) }), "failed");
    assert.deepEqual(logs, ["[group-inbox] new sent 1", "[group-inbox] new push-failed"]);
  });
  await t("on：その場で聞くカード（グループ）は出さない", async () => {
    env(false); assert.equal(cc.instantCandidateActive(), true);
    env(true); assert.equal(cc.instantCandidateActive(), false);
  });
  await t("押す（on・仕分ける人の1対1）：［タスクにする］は控えたグループのタスクとして登録し、候補を消す", async () => {
    env(true);
    const x = mk(cand("m1"));
    await cc.handleCandidateAction({ op: "cr", id: "m1" }, OWNER, undefined, "rt", x.deps);
    assert.deepEqual(x.reg, [{ id: "m1", group: G1 }]);
    assert.deepEqual(x.removed, ["m1"]);
  });
  await t("押す（on・仕分ける人の1対1）：［登録しない］は候補を消す", async () => {
    env(true);
    const x = mk(cand("m1"));
    await cc.handleCandidateAction({ op: "cx", id: "m1" }, OWNER, undefined, "rt", x.deps);
    assert.deepEqual(x.removed, ["m1"]);
    assert.equal(x.reg.length, 0);
  });
  await t("押す：1対1でも、仕分ける人でない人・off のときは今までどおり「見つかりません」", async () => {
    env(true);
    const a = mk(cand("m1"));
    await cc.handleCandidateAction({ op: "cr", id: "m1" }, ADMIN2, undefined, "rt", a.deps);
    await cc.handleCandidateAction({ op: "cx", id: "m1" }, REQ, undefined, "rt", a.deps);
    env(false);
    await cc.handleCandidateAction({ op: "cr", id: "m1" }, OWNER, undefined, "rt", a.deps);
    assert.deepEqual(a.replies, [cc.MSG_CAND_NOT_FOUND, cc.MSG_CAND_NOT_FOUND, cc.MSG_CAND_NOT_FOUND]);
    assert.equal(a.reg.length + a.removed.length, 0);
  });
  await t("押す（グループの中）：on でも今までどおり動く", async () => {
    env(true);
    const x = mk(cand("m1"));
    await cc.handleCandidateAction({ op: "cr", id: "m1" }, REQ, G1, "rt", x.deps);
    assert.deepEqual(x.reg, [{ id: "m1", group: G1 }]);
  });
  const at17 = Date.UTC(2026, 10, 28, 8, 5); // JST 17:05
  const askDeps = (list: Array<Candidate | null>, pushes: Array<{ to: string; text: string; card: boolean }>) => ({
    claim: async () => true, number: async () => list,
    push: async (to: string, text: string, card?: unknown) => { pushes.push({ to, text, card: Boolean(card) }); return true; },
    members: async () => members as never, held: async () => new Set<string>(["h1"]),
  });
  await t("17時（on）：グループではなく仕分ける人の1対1へ、カードで。保留中・片付いた分は出さない", async () => {
    env(true);
    const pushes: Array<{ to: string; text: string; card: boolean }> = [];
    const r = await ask.askCandidatesIfDue(at17, askDeps([cand("m1"), null, cand("h1"), cand("m3")], pushes), G1, "2026-11-28");
    assert.equal(r, "sent");
    assert.deepEqual(pushes, [{ to: OWNER, text: "📥 まだ仕分けていない依頼が 2件あります", card: true }]);
  });
  await t("17時（on）：0件なら何も送らない", async () => {
    env(true);
    const pushes: Array<{ to: string; text: string; card: boolean }> = [];
    assert.equal(await ask.askCandidatesIfDue(at17, askDeps([null], pushes), G1, "2026-11-28"), "empty");
    assert.equal(pushes.length, 0);
  });
  await t("17時（off）：今までどおりグループへ", async () => {
    env(false);
    const pushes: Array<{ to: string; text: string; card: boolean }> = [];
    await ask.askCandidatesIfDue(at17, askDeps([cand("m1")], pushes), G1, "2026-11-28");
    assert.equal(pushes[0].to, G1);
  });
  await t("まとめのカード：10枚まで。残りは文に出す", async () => {
    const cs = Array.from({ length: 13 }, (_, i) => cand(`m${i}`));
    const p = cc.inboxCarousel(cs, nameOf)!;
    assert.equal(p.shown, 10);
    assert.equal(cc.msgInboxDigest(13, 3), "📥 まだ仕分けていない依頼が 13件あります（ほか 3件は、片付いたら次のまとめで出します）");
    assert.equal(cc.inboxCarousel([], nameOf), undefined);
  });
  console.log(`${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
