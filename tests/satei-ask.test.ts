/**
 * 「案件はどれですか」のカード（設計 2026-11-22-satei-ask-card-design）。KV・CRM・LINE は差し替え。外部へ通信しない。
 */
import {
  answerKey,
  askKey,
  encodeAskList,
  encodeAskNone,
  encodeAskPick,
  handleSateiAsk,
  handleSateiAskAnswers,
  handleSateiAskPostback,
  parseSateiAskData,
  safeLabel,
  sateiAskListCard,
  sateiAskRetryKey,
  sateiAskToken,
  type SateiAskActionDeps,
  type SateiAskDeps,
  type SateiAskKv,
} from "../src/lib/satei-ask";
import { sateiNotifyToken, sateiRetryKey } from "../src/lib/satei-notify";
import { sateiRequestToken } from "../src/lib/satei-request";
import { candidateDeals, type DealRef } from "../src/lib/task-record";
import { handleTaskPostbackEvent } from "../src/lib/task-buttons-wire";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};
globalThis.fetch = (async () => {
  throw new Error("このテストで外部へ通信してはいけない");
}) as typeof fetch;

const KEY = "k".repeat(40);
const TOKEN = sateiAskToken(KEY);
const USER = "U" + "a".repeat(32);
const OTHER = "U" + "b".repeat(32);
const ASK = "ask" + "0123456789abcdef".repeat(2) + "01234567";
const DEAL_A = "0123abcd0123456789ab0123456789ab";
const DEAL_B = "1123abcd0123456789ab0123456789ab";
const DEAL_C = "2123abcd0123456789ab0123456789ab";
const DEALS: DealRef[] = [
  { id: DEAL_A, name: "【下村】サンクレイドル津田沼3号棟 222号室", phase: "【売】査定" },
  { id: DEAL_B, name: "サンクレイドル津田沼1号棟 101号室｜売却", phase: null },
  { id: DEAL_C, name: "コート千里山西Ⅲ", phase: null },
];
const ENV = { JOB_API_TOKEN: KEY, TASK_SATEI: "1", TASK_SATEI_USER_IDS: USER };

function fakeKv() {
  const store = new Map<string, unknown>();
  // askId → 通し番号
  const index = new Map<string, number>();
  let seq = 0;
  const calls: string[] = [];
  const k: SateiAskKv & {
    store: typeof store;
    index: typeof index;
    calls: string[];
    /** 保存は済んだのに例外（通信が途中で切れた）を1回起こす */
    throwAfterSave?: boolean;
    /** 保存の前に例外 */
    failSave?: boolean;
  } = {
    store,
    index,
    calls,
    get: async (key) => (store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null),
    setNx: async (key, v) => {
      calls.push(`setNx ${key}`);
      if (store.has(key)) return false;
      store.set(key, v);
      return true;
    },
    set: async (key, v) => {
      calls.push(`set ${key}`);
      store.set(key, v);
    },
    del: async (key) => {
      calls.push(`del ${key}`);
      store.delete(key);
    },
    mget: async (keys) => keys.map((x) => (store.has(x) ? store.get(x) : null)),
    saveAnswer: async (askId, answer) => {
      if (k.failSave) throw new Error("kv");
      const key = answerKey(askId);
      let created = false;
      if (!store.has(key)) {
        // 本物と同じく JSON の文字列で置く（Lua の SET）
        store.set(key, JSON.stringify(answer));
        created = true;
      }
      if (!index.has(askId)) index.set(askId, ++seq);
      if (k.throwAfterSave) {
        k.throwAfterSave = false;
        index.delete(askId); // 目次に載る前に切れた形
        throw new Error("lost");
      }
      return created;
    },
    indexAfter: async (after, limit) =>
      Array.from(index.entries())
        .filter(([, n]) => n > after)
        .sort((a, b) => a[1] - b[1])
        .slice(0, limit)
        .map(([askId, n]) => ({ askId, seq: n })),
    indexRemove: async (ids) => {
      for (const id of ids) index.delete(id);
    },
  };
  return k;
}

const body = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    askId: ASK,
    receipt: "H12",
    reason: "MISSING_CASE",
    occurredAt: "2026-11-22T03:34:00Z",
    excerpt: "津田沼の222号室、査定お願いします",
    propertyHint: "サンクレイドル津田沼3号棟 222号室",
    ...o,
  });

function askDeps(over: Partial<SateiAskDeps> = {}) {
  const logs: string[] = [];
  const pushes: Array<{ to: string; messages: unknown[]; key: string }> = [];
  const kv = fakeKv();
  const d: SateiAskDeps = {
    env: ENV,
    kv,
    loadDeals: async () => DEALS,
    push: async (to, messages, key) => {
      pushes.push({ to, messages, key });
      return 200;
    },
    now: () => 1_000,
    log: (l) => logs.push(l),
    ...over,
  };
  return { d, logs, pushes, kv };
}

const footerData = (card: unknown): string[] => {
  const c = card as { contents: { footer: { contents: Array<{ action: { data: string } }> } } };
  return c.contents.footer.contents.map((b) => b.action.data);
};

function actDeps(kv: ReturnType<typeof fakeKv>, over: Partial<SateiAskActionDeps> = {}) {
  const logs: string[] = [];
  const replies: Array<{ text: string; card?: unknown }> = [];
  const reserved = new Set<string>();
  const completed: string[] = [];
  let t = 5_000;
  const d: SateiAskActionDeps = {
    kv,
    loadDeals: async () => DEALS,
    readLabel: async () => "サンクレイドル津田沼3号棟 222号室",
    reserve: async (key) => {
      if (reserved.has(key)) return { proceed: false };
      reserved.add(key);
      return { proceed: true };
    },
    complete: async (key) => {
      completed.push(key);
    },
    reply: async (_t, text, card) => {
      replies.push({ text, card });
      return null;
    },
    now: () => (t += 1_000),
    log: (l) => logs.push(l),
    ...over,
  };
  return { d, logs, replies, completed };
}

const ev = (id: string, userId = USER) => ({ replyToken: "rt", webhookEventId: id, source: { userId } });

async function main() {
  process.env.TASK_SATEI = "1";
  process.env.TASK_SATEI_USER_IDS = USER;

  // 鍵：ほかの口の合言葉では通らない
  {
    const { d } = askDeps();
    ok("鍵なしは 401", (await handleSateiAsk(null, body(), d)).status === 401);
    ok("知らせの鍵は 401", (await handleSateiAsk(sateiNotifyToken(KEY), body(), d)).status === 401);
    ok("依頼の鍵は 401", (await handleSateiAsk(sateiRequestToken(KEY), body(), d)).status === 401);
    const short = askDeps({ env: { ...ENV, JOB_API_TOKEN: "short" } });
    ok("短い JOB_API_TOKEN は誰も通さない", (await handleSateiAsk(sateiAskToken("short"), body(), short.d)).status === 401);
    ok("answers も鍵なしは 401", (await handleSateiAskAnswers(null, '{"after":""}', d)).status === 401);
  }

  // 形
  {
    const { d, pushes } = askDeps();
    const bad = [
      body({ extra: 1 }),
      body({ askId: "short" }),
      body({ receipt: "H0" }),
      body({ receipt: "J12" }),
      body({ reason: "OTHER" }),
      body({ occurredAt: "2026-11-22T12:34:00" }),
      body({ occurredAt: "きのう" }),
      body({ excerpt: "あ".repeat(81) }),
      body({ propertyHint: "あ".repeat(61) }),
      body({ propertyHint: 3 }),
      "[]",
      "nope",
    ];
    let all400 = true;
    for (const b of bad) if ((await handleSateiAsk(TOKEN, b, d)).status !== 400) all400 = false;
    ok("形の違う本文はどれも 400", all400);
    ok("形が違うときは送らない", pushes.length === 0);
    ok("抜粋80字ちょうどは通る", (await handleSateiAsk(TOKEN, body({ excerpt: "あ".repeat(80) }), d)).status === 200);
  }

  // off・宛先なし・KV なし
  {
    const off = askDeps({ env: { ...ENV, TASK_SATEI: "0" } });
    const r = await handleSateiAsk(TOKEN, body(), off.d);
    ok("TASK_SATEI off は TASK_SATEI_OFF", r.body.result === "rejected" && r.body.code === "TASK_SATEI_OFF");
    ok("off は送らない・控えない", off.pushes.length === 0 && off.kv.calls.length === 0);
    const noUser = askDeps({ env: { ...ENV, TASK_SATEI_USER_IDS: "" } });
    ok("宛先なしも TASK_SATEI_OFF", (await handleSateiAsk(TOKEN, body(), noUser.d)).body.code === "TASK_SATEI_OFF");
    const noKv = askDeps({ kv: null });
    ok("KV なしは unknown", (await handleSateiAsk(TOKEN, body(), noKv.d)).body.result === "unknown" && noKv.pushes.length === 0);
  }

  // ふつうに出す
  {
    const { d, pushes, logs, kv } = askDeps();
    const r = await handleSateiAsk(TOKEN, body(), d);
    ok("ok created:true", r.body.result === "ok" && r.body.created === true, JSON.stringify(r.body));
    ok("宛先は TASK_SATEI_USER_IDS の先頭", pushes.length === 1 && pushes[0].to === USER);
    ok("再送キーは askId から", pushes[0].key === sateiAskRetryKey(ASK));
    ok("再送キーはほかの知らせと重ならない", pushes[0].key !== sateiRetryKey(12, "failed", 0));
    const card = pushes[0].messages[0];
    const data = footerData(card);
    ok("完全一致の案件が先頭の候補", data[0] === encodeAskPick(ASK, DEAL_A), data.join(","));
    ok("候補の後ろに［一覧から選ぶ］［査定にしない］", data.at(-2) === encodeAskList(ASK, 0) && data.at(-1) === encodeAskNone(ASK));
    const json = JSON.stringify(card);
    ok("カードに受付番号・日本時間・抜粋", json.includes("H12") && json.includes("11/22 12:34") && json.includes("津田沼の222号室"));
    ok("MISSING_CASE には古さの注意を出さない", !json.includes("24時間より前"));
    ok("控えは sent", (kv.store.get(askKey(ASK)) as { sent: boolean }).sent === true);
    ok("ログは符号だけ（抜粋・案件名なし）", logs.join("\n") === "[satei-ask] H12 asked 1", logs.join("|"));

    const again = await handleSateiAsk(TOKEN, body(), d);
    ok("同じ askId は created:false・出し直さない", again.body.created === false && pushes.length === 1);
  }

  // TOO_OLD・ヒントなし・CRM が読めない
  {
    const { d, pushes } = askDeps();
    await handleSateiAsk(TOKEN, body({ reason: "TOO_OLD", propertyHint: undefined }), d);
    const json = JSON.stringify(pushes[0].messages[0]);
    ok("TOO_OLD は古さの注意", json.includes("24時間より前"));
    ok("ヒントなしは候補なし（一覧・査定にしないだけ）", footerData(pushes[0].messages[0]).length === 2);
    ok("ヒントなしは「見つかりませんでした」", json.includes("見つかりませんでした"));
    const f = askDeps({ loadDeals: async () => { throw new Error("crm"); } });
    const r = await handleSateiAsk(TOKEN, body(), f.d);
    ok("CRM が読めなくても送る", r.body.created === true && f.pushes.length === 1);
    ok("CRM が読めないことをカードで言う", JSON.stringify(f.pushes[0].messages[0]).includes("確かめられませんでした"));
    ok("CRM が読めないことをログに符号で", f.logs.some((l) => l.endsWith("deals-failed")));
  }

  // 送れない・結果不明
  {
    const { d, kv, pushes } = askDeps({ push: async () => 500 });
    const r = await handleSateiAsk(TOKEN, body(), d);
    ok("LINE 500 は unknown", r.body.result === "unknown");
    ok("送れなかった控えは sent にしない", (kv.store.get(askKey(ASK)) as { sent: boolean }).sent === false);
    d.push = async (to, messages, key) => {
      pushes.push({ to, messages, key });
      return 409;
    };
    const r2 = await handleSateiAsk(TOKEN, body(), d);
    ok("2回目は同じ再送キーで送り直す・409 は送れた扱い", r2.body.created === true && (kv.store.get(askKey(ASK)) as { sent: boolean }).sent === true);
    const x = askDeps({ push: async () => { throw new Error("net"); } });
    ok("例外も unknown", (await handleSateiAsk(TOKEN, body(), x.d)).body.result === "unknown");
    // 24時間近くたって結果不明のものは送り直さない（LINE が再送キーを忘れているので二重に届きうる）
    let now = 1_000;
    const stale = askDeps({ push: async () => 500, now: () => now });
    await handleSateiAsk(TOKEN, body(), stale.d);
    now = 1_000 + 23 * 3600 * 1000 + 1;
    stale.d.push = async (to, messages, key) => {
      stale.pushes.push({ to, messages, key });
      return 200;
    };
    const late = await handleSateiAsk(TOKEN, body(), stale.d);
    ok("23時間を過ぎた結果不明は ASK_UNCERTAIN・送らない", late.body.code === "ASK_UNCERTAIN" && stale.pushes.length === 0);
    now = 1_000 + 22 * 3600 * 1000;
    const st2 = askDeps({ push: async () => 500, now: () => now });
    await handleSateiAsk(TOKEN, body(), st2.d);
    st2.d.push = async (to, messages, key) => {
      st2.pushes.push({ to, messages, key });
      return 200;
    };
    now += 3600 * 1000 - 1;
    ok("23時間以内なら送り直す", (await handleSateiAsk(TOKEN, body(), st2.d)).body.created === true && st2.pushes.length === 1);
    const busy = askDeps();
    busy.kv.setNx = async () => false;
    ok("控えを置けない（同時）は unknown・送らない", (await handleSateiAsk(TOKEN, body(), busy.d)).body.result === "unknown" && busy.pushes.length === 0);
  }

  // 候補の選び方
  {
    ok("完全一致→部分一致", candidateDeals("サンクレイドル津田沼3号棟222号室", DEALS).map((d) => d.id).join() === DEAL_A, candidateDeals("サンクレイドル津田沼3号棟222号室", DEALS).map((d) => d.name).join());
    ok("短い鍵は部分一致に使わない", candidateDeals("津田", DEALS).length === 0);
    ok("空は候補なし", candidateDeals("", DEALS).length === 0);
    const many = Array.from({ length: 8 }, (_, i) => ({ id: String(i).repeat(32).slice(0, 32), name: `サンクレイドル津田沼${i}号棟` }));
    ok("最大5件", candidateDeals("サンクレイドル津田沼", many).length === 5);
  }

  // data の読み方
  {
    ok("qa を読む", JSON.stringify(parseSateiAskData(encodeAskPick(ASK, DEAL_A))) === JSON.stringify({ op: "qa", askId: ASK, dealId: DEAL_A }));
    ok("ql を読む", parseSateiAskData(encodeAskList(ASK, 10))?.op === "ql");
    ok("qn を読む", parseSateiAskData(encodeAskNone(ASK))?.op === "qn");
    ok("ql のオフセット上限", parseSateiAskData(encodeAskList(ASK, 510)) === null);
    ok("ql の先頭0は読まない", parseSateiAskData(`v1|ql|${ASK}|010`) === null);
    ok("案件 ID の形が違えば null", parseSateiAskData(`v1|qa|${ASK}|xyz`) === null);
    ok("ほかのボタンは読まない", parseSateiAskData(`v1|sa|${DEAL_A}`) === null && parseSateiAskData("v1|done|x") === null);
    ok("要素の数が違えば null", parseSateiAskData(`v1|qn|${ASK}|1`) === null);
  }

  // ボタン：選ぶ
  {
    const { d: ad, kv } = askDeps();
    await handleSateiAsk(TOKEN, body(), ad);
    const a = actDeps(kv);
    await handleSateiAskPostback({ op: "qa", askId: ASK, dealId: DEAL_A }, ev("e1"), a.d);
    const ans = JSON.parse(kv.store.get(answerKey(ASK)) as string) as Record<string, unknown>;
    ok("答えを置く", ans?.decision === "deal" && ans.dealId === DEAL_A && ans.receipt === "H12");
    ok("label は物件名", ans.label === "サンクレイドル津田沼3号棟 222号室");
    ok("answeredAt は日本時間", typeof ans.answeredAt === "string" && (ans.answeredAt as string).endsWith("+09:00"));
    ok("目次に載る", kv.index.has(ASK));
    ok("返事は案件名つき", a.replies[0]?.text.includes("サンクレイドル津田沼3号棟 222号室") && a.replies[0].text.includes("H12"));
    ok("完了印", a.completed.includes("pb:e1"));
    await handleSateiAskPostback({ op: "qn", askId: ASK }, ev("e2"), a.d);
    ok("2回目は選択済み（変えない）", a.replies[1]?.text.includes("選択済み") && (JSON.parse(kv.store.get(answerKey(ASK)) as string) as { decision: string }).decision === "deal");
    await handleSateiAskPostback({ op: "qa", askId: ASK, dealId: DEAL_A }, ev("e1"), a.d);
    ok("同じイベントの再送は何もしない", a.replies.length === 2);
    ok("ログに案件名・userId なし", !a.logs.join("\n").includes("サンクレイドル") && !a.logs.join("\n").includes(USER));
  }

  // ボタン：査定にしない・押せない人・止めている・期限切れ・進行中でない
  {
    const { d: ad, kv } = askDeps();
    await handleSateiAsk(TOKEN, body(), ad);
    const a = actDeps(kv);
    await handleSateiAskPostback({ op: "qn", askId: ASK }, ev("n1", OTHER), a.d);
    ok("ほかの人は押せない", a.replies[0]?.text.includes("下村さん") && !kv.store.has(answerKey(ASK)));
    process.env.TASK_SATEI = "0";
    await handleSateiAskPostback({ op: "qn", askId: ASK }, ev("n2"), a.d);
    process.env.TASK_SATEI = "1";
    ok("off は止めています", a.replies[1]?.text.includes("止めて") && !kv.store.has(answerKey(ASK)));
    await handleSateiAskPostback({ op: "qa", askId: ASK, dealId: "9".repeat(32) }, ev("n3"), a.d);
    ok("進行中でない案件は受けない", a.replies[2]?.text.includes("進行中の一覧にありません") && !kv.store.has(answerKey(ASK)));
    await handleSateiAskPostback({ op: "qn", askId: ASK }, ev("n4"), a.d);
    const ans = JSON.parse(kv.store.get(answerKey(ASK)) as string) as Record<string, unknown>;
    ok("査定にしない", ans.decision === "none" && ans.dealId === undefined && a.replies[3]?.text.includes("査定にしません"));
    const e = actDeps(fakeKv());
    await handleSateiAskPostback({ op: "qn", askId: ASK }, ev("n5"), e.d);
    ok("控えが無い（7日を過ぎた）は期限切れ", e.replies[0]?.text.includes("期限が切れて"));
  }

  // ボタン：記録の失敗・目次の載せ直し
  {
    const { d: ad, kv } = askDeps();
    await handleSateiAsk(TOKEN, body(), ad);
    kv.failSave = true;
    const a = actDeps(kv);
    await handleSateiAskPostback({ op: "qa", askId: ASK, dealId: DEAL_A }, ev("f0"), a.d);
    ok("保存の前に失敗：記録できませんでした・完了印なし", a.replies[0]?.text.includes("記録できませんでした") && a.completed.length === 0);
    kv.failSave = false;
    kv.throwAfterSave = true;
    await handleSateiAskPostback({ op: "qa", askId: ASK, dealId: DEAL_A }, ev("f1"), a.d);
    ok("保存後に切れた：答えはあるが目次に無い", kv.store.has(answerKey(ASK)) && !kv.index.has(ASK));
    ok("切れたときは記録できませんでした・完了印なし", a.replies[1]?.text.includes("記録できませんでした") && a.completed.length === 0);
    await handleSateiAskPostback({ op: "qa", askId: ASK, dealId: DEAL_A }, ev("f2"), a.d);
    ok("押し直しで目次に載せ直す（選択済みと返す）", kv.index.has(ASK) && a.replies[2]?.text.includes("選択済み"));
    const r = await handleSateiAskAnswers(TOKEN, '{"after":""}', { env: ENV, kv, now: () => 0, log: () => undefined });
    ok("載せ直した答えを Mac が取れる", (r.body.answers as Array<{ askId: string }>).some((x) => x.askId === ASK));
    const b = actDeps(kv, { loadDeals: async () => { throw new Error("crm"); } });
    const { d: ad2, kv: kv2 } = askDeps();
    await handleSateiAsk(TOKEN, body(), ad2);
    const b2 = actDeps(kv2, { loadDeals: b.d.loadDeals });
    await handleSateiAskPostback({ op: "qa", askId: ASK, dealId: DEAL_A }, ev("f3"), b2.d);
    ok("CRM が読めなければ受けない・完了印なし", !kv2.store.has(answerKey(ASK)) && b2.completed.length === 0 && b2.replies[0]?.text.includes("読み取れません"));
    const c = actDeps(kv2, { readLabel: async () => { throw new Error("prop"); } });
    await handleSateiAskPostback({ op: "qa", askId: ASK, dealId: DEAL_A }, ev("f4"), c.d);
    ok("物件名が読めなくても受ける（label 空）", (JSON.parse(kv2.store.get(answerKey(ASK)) as string) as { label: string }).label === "");
  }

  // label の守り
  {
    ok("様を含めば空", safeLabel("山田様邸") === "");
    ok("さんを含めば空", safeLabel("田中さんの家") === "");
    ok("60字で切る", Array.from(safeLabel("あ".repeat(70))).length === 60);
    ok("null は空", safeLabel(null) === "");
    ok("61字目以降の敬称でも空（切る前に見る）", safeLabel("あ".repeat(57) + "山田太郎様") === "");
  }

  // 一覧
  {
    const deals = Array.from({ length: 23 }, (_, i) => ({ id: (String(i).padStart(2, "0") + "a".repeat(30)), name: `物件${String(i).padStart(2, "0")}` }));
    const card = sateiAskListCard(ASK, "H12", deals, 0) as unknown as { contents: { contents: unknown[] } };
    ok("10件＋［次の10件］", card.contents.contents.length === 11);
    ok("次は offset 10", JSON.stringify(card).includes(encodeAskList(ASK, 10)));
    const last = sateiAskListCard(ASK, "H12", deals, 20) as unknown as { contents: { contents: unknown[] } };
    ok("最後のページは次なし", last.contents.contents.length === 3);
    ok("範囲外は null", sateiAskListCard(ASK, "H12", deals, 30) === null);
    ok("1枚の JSON が 30KB 未満", JSON.stringify(card).length < 30_000);
    const { d: ad, kv } = askDeps();
    await handleSateiAsk(TOKEN, body(), ad);
    const a = actDeps(kv);
    await handleSateiAskPostback({ op: "ql", askId: ASK, offset: 0 }, ev("l1"), a.d);
    ok("一覧はカルーセルで返す", a.replies[0]?.text.includes("H12") && Boolean(a.replies[0].card));
    ok("一覧は予約を使わない（読むだけ）", a.completed.length === 0);
  }

  // 口2：答え（通し番号の順）
  {
    const kv = fakeKv();
    const A1 = "askaaaaaaaaaa1", A2 = "askaaaaaaaaaa2", A3 = "askaaaaaaaaaa3";
    const deal = (askId: string) => ({ askId, receipt: "H1", decision: "deal" as const, dealId: DEAL_A, label: "L", answeredAt: "x" });
    await kv.saveAnswer(A3, deal(A3), 1);
    await kv.saveAnswer(A1, { askId: A1, receipt: "H2", decision: "none", answeredAt: "y" }, 1);
    const dd = { env: ENV, kv, now: () => 4_000, log: () => undefined };
    const r = await handleSateiAskAnswers(TOKEN, '{"after":""}', dd);
    const answers = r.body.answers as Array<Record<string, unknown>>;
    ok("置いた順（通し番号の順）", answers.map((a) => a.askId).join() === [A3, A1].join());
    ok("next は最後の番号", r.body.next === "2");
    ok("none は dealId・label なし", !("dealId" in answers[1]) && !("label" in answers[1]));
    ok("deal は dealId・label つき", answers[0].dealId === DEAL_A && answers[0].label === "L");
    // Mac が位置を進めたあとに置かれた答えは、askId が小さくても必ず見える（時刻・askId の順にしない）
    await kv.saveAnswer(A2, deal(A2), 1);
    const later = await handleSateiAskAnswers(TOKEN, JSON.stringify({ after: r.body.next }), dd);
    ok("後から置いた答えを取りこぼさない", (later.body.answers as Array<{ askId: string }>).map((a) => a.askId).join() === A2 && later.body.next === "3");
    const end2 = await handleSateiAskAnswers(TOKEN, '{"after":"3"}', dd);
    ok("無ければ空・位置はそのまま", (end2.body.answers as unknown[]).length === 0 && end2.body.next === "3");
    const again = await handleSateiAskAnswers(TOKEN, '{"after":""}', dd);
    ok("位置を進めるまで何度でも同じ答え", (again.body.answers as unknown[]).length === 3);
    kv.store.delete(answerKey(A1));
    const gone = await handleSateiAskAnswers(TOKEN, '{"after":""}', dd);
    ok("消えた答えは飛ばすが位置は進む", (gone.body.answers as unknown[]).length === 2 && gone.body.next === "3");
    ok("消えた答えは目次から外す", !kv.index.has(A1));
    ok("形の違う after は 400", (await handleSateiAskAnswers(TOKEN, '{"after":"x"}', dd)).status === 400);
    ok("先頭0の after は 400", (await handleSateiAskAnswers(TOKEN, '{"after":"01"}', dd)).status === 400);
    ok("余計な欄は 400", (await handleSateiAskAnswers(TOKEN, '{"after":"","x":1}', dd)).status === 400);
    ok("KV なしは unknown", (await handleSateiAskAnswers(TOKEN, '{"after":""}', { ...dd, kv: null })).body.result === "unknown");
    ok("off でも答えは返す", (await handleSateiAskAnswers(TOKEN, '{"after":""}', { ...dd, env: { ...ENV, TASK_SATEI: "0" } })).body.result === "ok");
  }

  // postback の振り分け（task-buttons-wire）
  {
    const { d: ad, kv } = askDeps();
    await handleSateiAsk(TOKEN, body(), ad);
    const a = actDeps(kv);
    const replies: string[] = [];
    await handleTaskPostbackEvent(
      { type: "postback", replyToken: "rt", webhookEventId: "w1", source: { type: "user", userId: USER }, postback: { data: encodeAskNone(ASK) } } as never,
      {
        reserve: a.d.reserve,
        complete: a.d.complete,
        reply: async (_t: string, text: string) => {
          replies.push(text);
          return null;
        },
        log: () => undefined,
        cardRefs: null,
        sateiAsk: { kv, loadDeals: a.d.loadDeals, readLabel: a.d.readLabel, now: a.d.now },
      } as never,
    );
    ok("振り分けでカードのボタンに届く", replies[0]?.includes("査定にしません") && (JSON.parse((kv.store.get(answerKey(ASK)) as string) ?? "{}") as { decision: string })?.decision === "none", replies.join("|"));
  }

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて通過");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
