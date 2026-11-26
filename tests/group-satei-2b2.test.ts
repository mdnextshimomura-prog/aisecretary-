/** 段2b-2：足りない項目を下村さんに聞く（group-satei-actions.ts の pick・gi／group-satei-info.ts。KV・portal・Claude は差し替え） */
import assert from "node:assert/strict";
import { gsResumeInfo, handleGroupSateiPostback, type GsActionDeps } from "../src/lib/group-satei-actions";
import { GS_OUTBOX_SET, gsOutboxRetry } from "../src/lib/group-satei-outbox";
import { gsBuildingOf } from "../src/lib/group-satei-case";
import {
  asTicket, GS_INFO_GO_MS, GS_INFO_MS, GS_INFO_SET, gsInfoGoKey, GS_STAGE2_SET, gsDecKey, gsFixKey, gsInfoKey, gsOpenKey, gsTicketKey, parseGsData, ticketIdOf, type GsRead, type GsTicket,
} from "../src/lib/group-satei-data";
import { handleGsInfoText, sweepGsInfo, type GsInfoDeps } from "../src/lib/group-satei-info";
import { gsAnswerFact, gsInfoParse } from "../src/lib/group-satei-facts";
import { MSG_GS_STALE, MSG_GS_PAUSED } from "../src/lib/group-satei-card";
import type { SateiPrepIntakeReq } from "../src/lib/group-satei-prep-portal";
import type { SateiDeal } from "../src/lib/satei-deal";
import { sateiReasonKey } from "../src/lib/satei-data";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const G = "C" + "a".repeat(32);
const DB = "9999abcd0123456789ab0123456789ab";
const DEAL = "0123abcd0123456789ab0123456789ab";
const tid = ticketIdOf("m1");
const NOW = 1_000_000;
const FULL: GsRead = {
  address: "大阪市北区天満2丁目3-4", propertyName: "パークハウス天満 1203号室", kind: "マンション", basis: "本文", confidence: 0.9,
  facts: { roomNo: "1203", exclusiveArea: 65.3, landArea: null, buildingArea: null, builtYm: "2005-03", layout: null, floor: null, totalUnits: null, structure: null },
};
// 専有面積・築年月が読めていない（号室は読めていなくても聞かない）
const MISSING: GsRead = { ...FULL, facts: { ...FULL.facts!, roomNo: null, exclusiveArea: null, builtYm: null } };
const ticketOf = (read: GsRead | null): GsTicket => ({
  no: 7, ver: 1, groupId: G, requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], state: "asking", read,
});
const ON = { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, GROUP_SATEI_STAGE2: "1", GROUP_SATEI_CASE_STAFF_ID: STAFF };
const deal: SateiDeal = { id: DEAL, name: "山田様 売却", dealNo: 12, folderId: "folder_abcdefghij", propertyIds: ["p"], gone: false, parentDbId: DB };

function mk(o: { env?: Record<string, string>; read?: GsRead | null; kind?: string; prepIntake?: unknown; answer?: (text: string) => Promise<string | null> } = {}) {
  const m = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  m.set(gsTicketKey(tid), ticketOf(o.read === undefined ? MISSING : o.read));
  sets.set(gsOpenKey(G), new Set([tid]));
  const replies: Array<{ text: string; card?: unknown }> = [];
  const preps: SateiPrepIntakeReq[] = [];
  const intakes: unknown[] = [];
  const pushes: unknown[] = [];
  const answers: string[] = [];
  const logs: string[] = [];
  let now = NOW;
  const kv = {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: unknown) => { m.set(k, v); },
    setNx: async (k: string, v: unknown) => (m.has(k) ? false : (m.set(k, v), true)),
    incr: async () => 1, expire: async () => undefined,
    sadd: async (k: string, v: string) => { (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(v); },
    lpushTrim: async () => undefined, lrange: async () => [],
    del: async (k: string) => { m.delete(k); }, srem: async (k: string, v: string) => { sets.get(k)?.delete(v); },
    smembers: async (k: string) => Array.from(sets.get(k) ?? new Set<string>()),
    delIfToken: async (k: string, token: string) => {
      const v = m.get(k) as { token?: string } | undefined;
      if (v?.token !== token) return false;
      m.delete(k);
      return true;
    },
  };
  const common = {
    env: o.env ?? ON,
    dealsDbId: DB,
    readDeal: async () => ({ deal, kind: o.kind ?? "マンション" }),
    intake: async (req: unknown) => { intakes.push(req); return { kind: "ok" as const, value: { created: true, no: 12, status: "受付" } }; },
    prep: {
      intake: async (req: SateiPrepIntakeReq) => { preps.push(req); return (o.prepIntake as never) ?? { kind: "ok", value: { created: true, status: "受付" } }; },
      notices: async () => ({ kind: "ok" as const, value: [] }),
      decide: async () => ({ kind: "ok" as const, value: { status: "手作業" } }),
    },
    now: () => now,
    log: (l: string) => logs.push(l),
  };
  const deps: GsActionDeps = {
    ...common, kv,
    loadDeals: async () => [{ id: DEAL, name: "x", phase: "査定" }],
    reserve: async () => ({ proceed: true }),
    complete: async () => undefined,
    reply: async (_t, text, card) => { replies.push({ text, card }); },
    push: async () => 200,
  };
  const infoDeps: GsInfoDeps = {
    ...common, kv,
    answer: async (_keys, text) => { answers.push(text); return o.answer ? o.answer(text) : null; },
    reply: async (_t, text, card) => { replies.push({ text, card }); },
  };
  const sweep = () => sweepGsInfo({ ...common, kv, push: async (...a) => { pushes.push(a); return 200; }, now: () => now, startedAt: now });
  return { deps, infoDeps, sweep, kv, m, sets, replies, preps, intakes, pushes, answers, logs, setNow: (v: number) => { now = v; } };
}
type X = ReturnType<typeof mk>;
let ev = 0;
const press = (x: X, data: string, user = SHIMO) =>
  handleGroupSateiPostback(parseGsData(data)!, { replyToken: "r", webhookEventId: `e${++ev}`, source: { userId: user } }, x.deps);
const pick = (x: X) => press(x, `v1|gs|${tid}|1|${DEAL}`);
const answer = (x: X, text: string) => handleGsInfoText({ userId: SHIMO, text, replyToken: "r2" }, x.infoDeps);
const ticket = (x: X) => asTicket(x.m.get(gsTicketKey(tid)))!;
const lastText = (x: X) => x.replies[x.replies.length - 1].text;
const tokOf = (x: X) => ticket(x).info?.token.slice(0, 8) ?? "abcdef01";
const gi = (x: X, ver = 1) => `v1|gi|${tid}|${ver}|${tokOf(x)}`;

const ASK = [
  "【受付 G7】資料から読めなかった項目があります。分かる分だけ1通で送ってください（喋ったままで大丈夫です）",
  "・専有面積（例：65.3）",
  "・築年月（例：2005年3月）",
  "分からなければ［このまま進める］を押してください。30分たつと、このまま進めます",
].join("\n");

(async () => {
  const tk0 = (x: X) => tokOf(x);
  await t("足りない：準備へ進まず、1回にまとめて聞く（号室は聞かない）。仮の印・印・見回りの集合", async () => {
    const x = mk();
    await pick(x);
    assert.equal(x.preps.length, 0);
    assert.equal(x.replies[0].text, ASK);
    assert.ok(JSON.stringify(x.replies[0].card).includes(`"data":"v1|gi|${tid}|1|${tk0(x)}"`));
    assert.ok(JSON.stringify(x.replies[0].card).includes("このまま進める"));
    const tk = ticket(x);
    assert.equal(tk.state, "asking-info");
    assert.equal(tk.dealId, DEAL);
    assert.deepEqual(tk.info?.keys, ["exclusiveArea", "builtYm"]);
    assert.equal(tk.info?.by, SHIMO);
    assert.equal(tk.info?.at, NOW);
    assert.equal(x.m.get(gsDecKey(tid)), `info:${DEAL}`);
    const mark = x.m.get(gsInfoKey(SHIMO)) as { tid: string; token: string };
    assert.equal(mark.tid, tid);
    assert.equal(mark.token, tk.info?.token);
    assert.ok(x.sets.get(GS_INFO_SET)?.has(tid));
    assert.equal(x.sets.get(gsOpenKey(G))?.has(tid), false, "聞いているあいだは開いている票から外す");
    assert.ok(x.logs.includes("[group-satei] info asked G7 2"));
    assert.equal(JSON.stringify(x.logs).includes("65"), false);
  });
  await t("足りている（号室だけ無いのも）：今どおり準備へ", async () => {
    for (const read of [FULL, { ...FULL, facts: { ...FULL.facts!, roomNo: null } }]) {
      const x = mk({ read });
      await pick(x);
      assert.equal(x.preps.length, 1);
      assert.equal(ticket(x).state, "gathering");
      assert.equal(x.m.has(gsInfoKey(SHIMO)), false);
      assert.equal(x.m.get(gsDecKey(tid)), `prep:${DEAL}`);
    }
  });
  await t("答えで足す：全角・和暦・㎡を読み、準備へ（受付票の facts に入り、portal にも渡る）", async () => {
    const x = mk({ answer: async () => '{"専有面積":"６５．３㎡","築年月":"平成17年3月"}' });
    await pick(x);
    assert.equal(await answer(x, "65.3平米で平成17年3月築です"), true);
    assert.equal(x.answers[0], "65.3平米で平成17年3月築です");
    const tk = ticket(x);
    assert.equal(tk.state, "gathering");
    assert.equal(tk.read?.facts?.exclusiveArea, 65.3);
    assert.equal(tk.read?.facts?.builtYm, "2005-03");
    assert.deepEqual(x.preps[0].facts, { builtYm: "2005-03", exclusiveArea: 65.3, landArea: null, buildingArea: null });
    assert.equal(x.m.get(gsDecKey(tid)), `prep:${DEAL}`);
    assert.equal(x.m.has(gsInfoKey(SHIMO)), false);
    assert.equal(x.sets.get(GS_INFO_SET)?.has(tid), false);
    assert.ok(x.sets.get(GS_STAGE2_SET)?.has(tid));
    assert.equal(lastText(x), "受け取りました（専有面積・築年月）。事例の相談の案を作ります");
    assert.ok(x.logs.includes("[group-satei] info filled G7 2/2"));
  });
  await t("答えの一部だけ：通った分だけ足す（坪は捨てる）", async () => {
    const x = mk({ answer: async () => '{"専有面積":"20坪","築年月":"2005年3月"}' });
    await pick(x);
    await answer(x, "20坪、2005年3月");
    assert.equal(ticket(x).read?.facts?.exclusiveArea, null);
    assert.equal(ticket(x).read?.facts?.builtYm, "2005-03");
    assert.equal(lastText(x), "受け取りました（築年月）。事例の相談の案を作ります");
    assert.ok(x.logs.includes("[group-satei] info filled G7 1/2"));
  });
  await t("読めた項目が0件（坪だけ・Claude の失敗・答えでない）：取り込まずに今の流れへ。印と進める権を戻す", async () => {
    for (const ans of [async () => '{"専有面積":"20坪","築年月":null}', async () => { throw new Error("timeout"); }, async () => "わかりません"]) {
      const x = mk({ answer: ans });
      await pick(x);
      const token = ticket(x).info!.token;
      assert.equal(await answer(x, "20坪くらい"), false);
      assert.equal(x.preps.length, 0);
      assert.equal(ticket(x).state, "asking-info");
      assert.deepEqual(x.m.get(gsInfoKey(SHIMO)), { tid, token });
      assert.equal(x.m.has(gsInfoGoKey(tid, token)), false);
      assert.ok(x.logs.includes("[group-satei] info filled G7 0/2"));
      // あとの［このまま進める］で進められる
      await press(x, gi(x));
      assert.equal(x.preps.length, 1);
    }
  });
  await t("答えらしい手がかりの無い1通は Claude を呼ばず、印も消さずに今の流れへ", async () => {
    const x = mk({ answer: async () => '{"専有面積":"65.3"}' });
    await pick(x);
    assert.equal(await answer(x, "送信してください"), false);
    assert.equal(x.answers.length, 0);
    assert.ok(x.m.has(gsInfoKey(SHIMO)));
    assert.ok(x.logs.includes("[group-satei] info not-answer G7"));
    assert.equal(await answer(x, "専有面積は六十五"), true, "聞いた項目の言葉があれば受ける");
  });
  await t("印は読めたのに消せない：「記録できませんでした」で受ける（今の流れへ渡さない）", async () => {
    const x = mk({ answer: async () => '{"専有面積":"65.3"}' });
    await pick(x);
    const got = await handleGsInfoText({ userId: SHIMO, text: "65.3", replyToken: "r2" }, { ...x.infoDeps, kv: { ...x.kv, delIfToken: async () => { throw new Error("kv"); } } });
    assert.equal(got, true);
    assert.equal(lastText(x), "記録できませんでした。もう一度送ってください");
    assert.equal(x.answers.length, 0);
  });
  await t("受付票が読めない・進める権が取れない：「もう一度送ってください」。印は残す", async () => {
    const x = mk({ answer: async () => '{"専有面積":"65.3"}' });
    await pick(x);
    const get = x.kv.get;
    const broken = { ...x.kv, get: async (k: string) => { if (k === gsTicketKey(tid)) throw new Error("kv"); return get(k); } };
    assert.equal(await handleGsInfoText({ userId: SHIMO, text: "65.3", replyToken: "r2" }, { ...x.infoDeps, kv: broken }), true);
    assert.ok(lastText(x).startsWith("いま受け取れませんでした"));
    assert.ok(x.m.has(gsInfoKey(SHIMO)));
    const noClaim = { ...x.kv, setNx: async (k: string, v: unknown) => { if (k.startsWith("gsatei:infogo:")) throw new Error("kv"); return x.kv.setNx(k, v); } };
    assert.equal(await handleGsInfoText({ userId: SHIMO, text: "65.3", replyToken: "r2" }, { ...x.infoDeps, kv: noClaim }), true);
    assert.equal(lastText(x), "いま受け取れませんでした。少し待ってからもう一度送ってください（受付 G7）");
    assert.ok(x.m.has(gsInfoKey(SHIMO)), "印を置き直す");
    assert.equal(await answer(x, "65.3"), true);
    assert.equal(x.preps.length, 1);
  });
  await t("所在・物件名：名前らしい値は捨て、通った所在は read.address に", async () => {
    const read: GsRead = { ...FULL, address: null, propertyName: null };
    const x = mk({ read, answer: async () => '{"所在":"大阪市北区天満2丁目","物件名":"山田様のお部屋"}' });
    await pick(x);
    assert.ok(x.replies[0].text.includes("・所在（例："));
    assert.ok(x.replies[0].text.includes("・物件名（例："));
    await answer(x, "天満2丁目の山田様のお部屋");
    assert.equal(ticket(x).read?.address, "大阪市北区天満2丁目");
    assert.equal(ticket(x).read?.propertyName, null);
    assert.equal(x.preps[0].place, "大阪市北区天満2丁目");
    assert.equal(lastText(x), "受け取りました（所在）。事例の相談の案を作ります");
  });
  await t("戸建：土地面積・建物面積・築年月を聞く", async () => {
    const x = mk({ kind: "戸建", read: { ...FULL, kind: "戸建" } });
    await pick(x);
    assert.deepEqual(ticket(x).info?.keys, ["landArea", "buildingArea"]);
    assert.ok(x.replies[0].text.includes("・土地面積（例：120.5）\n・建物面積（例：98.2）"));
  });
  await t("［このまま進める］：足りないまま準備へ。印を消す。答えの1通は今の流れへ", async () => {
    const x = mk();
    await pick(x);
    await press(x, gi(x));
    assert.equal(x.preps.length, 1);
    assert.equal(x.preps[0].facts.exclusiveArea, null);
    assert.equal(ticket(x).state, "gathering");
    assert.equal(x.m.has(gsInfoKey(SHIMO)), false);
    assert.equal(lastText(x), "査定で進めます。事例の取り方の案を作って、数分でお送りします（受付 G7）");
    assert.ok(x.logs.includes("[group-satei] info skipped G7"));
    assert.equal(await answer(x, "65.3"), false);
    assert.equal(x.answers.length, 0);
  });
  await t("二度押し・答えのあとの［このまま進める］：「もう進めています」。古い版：新しいカード", async () => {
    const x = mk({ answer: async () => '{"専有面積":"65.3"}' });
    await pick(x);
    await press(x, gi(x));
    await press(x, gi(x));
    assert.equal(lastText(x), "この受付はもう進めています（受付 G7）");
    assert.equal(x.preps.length, 1);
    const y = mk({ answer: async () => '{"専有面積":"65.3"}' });
    await pick(y);
    await answer(y, "65.3");
    await press(y, gi(y));
    assert.equal(lastText(y), "この受付はもう進めています（受付 G7）");
    assert.equal(y.preps.length, 1);
    await press(y, gi(y, 2));
    assert.equal(lastText(y), MSG_GS_STALE);
  });
  await t("聞いているあいだに同じカードの案件・gm・gn・gk：選択済み（I5）", async () => {
    const x = mk();
    await pick(x);
    for (const d of [`v1|gs|${tid}|1|${DEAL}`, `v1|gm|${tid}|1`, `v1|gn|${tid}|1`, `v1|gk|${tid}|1|doc`]) {
      await press(x, d);
      assert.equal(lastText(x), "選択済みです（受付 G7）", d);
    }
    assert.equal(ticket(x).state, "asking-info");
    assert.equal(x.preps.length, 0);
  });
  await t("30分：見回りが足りないまま進める（下村さんへは送らない）。30分前は何もしない", async () => {
    const x = mk();
    await pick(x);
    x.setNow(NOW + GS_INFO_MS - 1);
    await x.sweep();
    assert.equal(x.preps.length, 0);
    x.setNow(NOW + GS_INFO_MS);
    await x.sweep();
    assert.equal(x.preps.length, 1);
    assert.equal(ticket(x).state, "gathering");
    assert.equal(x.m.has(gsInfoKey(SHIMO)), false);
    assert.equal(x.sets.get(GS_INFO_SET)?.has(tid), false);
    assert.equal(x.pushes.length, 0);
    assert.ok(x.logs.includes("[group-satei] info timeout G7"));
    // 進めたあとの答えは今の流れへ
    assert.equal(await answer(x, "65.3"), false);
  });
  await t("ほかの印（差し戻し理由・［直す］・別の聞き取り）があると聞かずに進める", async () => {
    for (const key of [sateiReasonKey(SHIMO), gsFixKey(SHIMO), gsInfoKey(SHIMO)]) {
      const x = mk();
      x.m.set(key, { tid: "x", token: "y" });
      await pick(x);
      assert.equal(x.preps.length, 1, key);
      assert.equal(ticket(x).state, "gathering");
      assert.ok(x.logs.includes("[group-satei] info skip:busy G7"));
    }
  });
  await t("進めたら portal が断った：票を asking に戻し、仮の印を外す（押し直せる）", async () => {
    const x = mk({ prepIntake: { kind: "rejected", status: 400, code: "INVALID_REQUEST" } });
    await pick(x);
    await press(x, gi(x));
    assert.equal(ticket(x).state, "asking");
    assert.equal(ticket(x).info, undefined);
    assert.equal(x.m.has(gsDecKey(tid)), false);
    assert.ok(x.sets.get(gsOpenKey(G))?.has(tid));
    assert.ok(lastText(x).startsWith("事例の案づくりを受け付けられませんでした"));
  });
  await t("進めたら PREP_DISABLED：2a の道（マンションは今の受付）", async () => {
    const x = mk({ prepIntake: { kind: "rejected", status: 503, code: "PREP_DISABLED" } });
    await pick(x);
    await press(x, gi(x));
    assert.equal(x.intakes.length, 1);
    assert.equal(ticket(x).state, "started");
    assert.equal(x.m.get(gsDecKey(tid)), `gs:${DEAL}`);
  });
  await t("30分の見回りで準備へ進めなかったら、その文を下村さんへ1通（0通にしない）", async () => {
    const x = mk({ prepIntake: { kind: "rejected", status: 400, code: "INVALID_REQUEST" } });
    await pick(x);
    const tok = tokOf(x);
    x.setNow(NOW + GS_INFO_MS);
    await x.sweep();
    assert.equal(x.pushes.length, 1);
    assert.equal((x.pushes[0] as unknown[])[2], `info-to:${tid}:${tok}`);
  });
  await t("答えの取り込み：印が無い・グループ・ほかの人・off は false（off は KV も読まない）", async () => {
    const x = mk();
    assert.equal(await answer(x, "65.3"), false);
    await pick(x);
    assert.equal(await handleGsInfoText({ userId: SHIMO, groupId: G, text: "65.3", replyToken: "r" }, x.infoDeps), false);
    assert.equal(await handleGsInfoText({ userId: "U" + "e".repeat(32), text: "65.3", replyToken: "r" }, x.infoDeps), false);
    let touched = false;
    const kvSpy = new Proxy(x.kv, { get: (o, p) => { touched = true; return (o as never)[p]; } });
    assert.equal(await handleGsInfoText({ userId: SHIMO, text: "65.3", replyToken: "r" }, { ...x.infoDeps, kv: kvSpy, env: { ...ON, GROUP_SATEI_CASE_STAFF_ID: "" } }), false);
    assert.equal(touched, false);
    assert.equal(x.answers.length, 0);
  });
  await t("off（山口さんの ID が無い）：聞かずに今と同じ（2a。マンションは今の受付）。gi は「止めています」", async () => {
    const env = { ...ON, GROUP_SATEI_CASE_STAFF_ID: "" };
    const x = mk({ env });
    await pick(x);
    assert.equal(x.intakes.length, 1);
    assert.equal(x.preps.length, 0);
    assert.equal(x.m.has(gsInfoKey(SHIMO)), false);
    assert.equal(ticket(x).state, "started");
    assert.equal(ticket(x).info, undefined);
    assert.equal(JSON.stringify(x.logs).includes("info"), false);
    const y = mk({ env });
    await press(y, gi(y));
    assert.equal(lastText(y), MSG_GS_PAUSED);
    const z = mk({ env });
    await z.sweep();
    assert.equal(z.logs.length, 0);
  });
  await t("押せるのは TASK_SATEI_USER_IDS の人だけ", async () => {
    const x = mk();
    await pick(x);
    await press(x, gi(x), "U" + "e".repeat(32));
    assert.equal(lastText(x), "いまは下村さんだけが使えます");
    assert.equal(ticket(x).state, "asking-info");
  });
  await t("data の形：v1|gi|<tid>|<ver>|<token の頭8字> だけ", async () => {
    assert.deepEqual(parseGsData(`v1|gi|${tid}|3|abcdef01`), { op: "gi", tid, ver: 3, tok: "abcdef01" });
    assert.equal(parseGsData(`v1|gi|${tid}|3`), null);
    assert.equal(parseGsData(`v1|gi|${tid}|3|x`), null);
    assert.equal(parseGsData(`v1|gi|xyz|3|abcdef01`), null);
  });
  await t("前の回のカードの［このまま進める］は、聞き直した回を進めない", async () => {
    const x = mk();
    await pick(x);
    await press(x, `v1|gi|${tid}|1|00000000`);
    assert.equal(lastText(x), MSG_GS_STALE);
    assert.equal(ticket(x).state, "asking-info");
  });
  await t("進める権：取ったあとに落ちても3分たてば取り直せる。新しい権があるうちは取れない", async () => {
    const x = mk();
    await pick(x);
    const token = ticket(x).info!.token;
    x.m.set(gsInfoGoKey(tid, token), { at: NOW });
    await press(x, gi(x));
    assert.equal(lastText(x), "この受付はもう進めています（受付 G7）");
    x.setNow(NOW + GS_INFO_GO_MS);
    await press(x, gi(x));
    assert.equal(x.preps.length, 1);
    assert.equal(ticket(x).state, "gathering");
  });
  await t("再開が二度走っても準備は1回（startGsPrep の印）", async () => {
    const x = mk();
    await pick(x);
    const tk = ticket(x);
    const [a, b] = await Promise.all([gsResumeInfo(tid, tk, x.deps, x.kv), gsResumeInfo(tid, tk, x.deps, x.kv)]);
    assert.equal(x.preps.length, 1);
    assert.equal(ticket(x).state, "gathering");
    assert.ok([a.code, b.code].includes("already"));
  });
  await t("答えの所在・物件名：地名らしい語・建物らしい語が無ければ捨てる", async () => {
    const read: GsRead = { ...FULL, address: null, propertyName: null };
    const x = mk({ read, answer: async () => '{"所在":"天満","物件名":"山田太郎"}' });
    await pick(x);
    assert.equal(await answer(x, "天満の山田太郎"), false, "0件なので今の流れへ");
    for (const [k, v, want] of [
      ["propertyName", "山田太郎", null], ["propertyName", "天満荘", "天満荘"], ["propertyName", "ジオ西宮", "ジオ西宮"], ["propertyName", "グランドメゾン", "グランドメゾン"],
      ["address", "天満", null], ["address", "大阪市北区天満2丁目", "大阪市北区天満2丁目"], ["address", "甲子園町1番", "甲子園町1番"],
    ] as const) assert.equal(gsAnswerFact(k, v), want, v);
  });
  await t("建物名：「第N」「N番館」は残し、「N階」は落とす", async () => {
    const b = (name: string) => gsBuildingOf({ ...FULL, propertyName: name, facts: { ...FULL.facts!, roomNo: null } });
    assert.equal(b("ライオンズ第2"), "ライオンズ第2");
    assert.equal(b("ブランズ2番館 305"), "ブランズ2番館");
    assert.equal(b("パークハウス 12階 1203号"), "パークハウス");
    assert.equal(b("ジオ西宮606号室"), "ジオ西宮");
  });
  await t("30分の見回りの知らせが送れない：2f の控えに積み、asking のあいだだけ文を作り直して送る", async () => {
    const x = mk({ prepIntake: { kind: "rejected", status: 400, code: "INVALID_REQUEST" } });
    await pick(x);
    const tok = tokOf(x);
    x.setNow(NOW + GS_INFO_MS);
    await sweepGsInfo({ ...x.infoDeps, kv: x.kv, push: async () => 500, now: () => NOW + GS_INFO_MS, startedAt: NOW + GS_INFO_MS });
    assert.ok(x.sets.get(GS_OUTBOX_SET)?.has(`info-to:${tid}:${tok}`));
    const sentMsgs: unknown[][] = [];
    const later = NOW + GS_INFO_MS + 3 * 60_000;
    await gsOutboxRetry({ kv: x.kv, to: SHIMO, push: async (...a) => { sentMsgs.push(a); return 200; }, now: () => later, startedAt: later, log: () => undefined });
    assert.equal(sentMsgs.length, 1);
    assert.equal(sentMsgs[0][2], `info-to:${tid}:${tok}`);
    assert.equal((sentMsgs[0][1] as Array<{ text: string }>)[0].text, "足りない項目を待ったあと、事例の案づくりへ進められませんでした。もう一度案件を選んでください（受付 G7）");
  });
  await t("gsInfoParse：聞いていない項目は読まない", async () => {
    assert.deepEqual(gsInfoParse(["builtYm"], '{"専有面積":"65.3","築年月":"R2.4"}'), { builtYm: "2020-04" });
    assert.deepEqual(gsInfoParse(["builtYm"], "壊れた答え"), {});
  });
  console.log(`${n} passed`);
})();
