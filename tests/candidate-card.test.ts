/**
 * B1 Task 2：候補をカードで登録（candidate-card.ts・task-candidate-store.ts の1件ずつのキー）。
 * KV・Notion・LINE は差し替え。外部へ通信したら失敗にする。
 */
// KV の環境変数が無い＝今までの置き場（off のとき）はメモリで動く
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.NOTION_MEMBERS_DATABASE_ID;

import { Client } from "@notionhq/client";
import type { Candidate } from "../src/lib/task-candidate";
import type { CandKv } from "../src/lib/task-candidate-store";
import type { FlexMessage } from "../src/lib/task-card";
import type { Member } from "../src/lib/members";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};

let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("このテストで外部へ通信してはいけない");
}) as typeof fetch;
let notionCalls = 0;
Client.prototype.request = (async () => {
  notionCalls++;
  throw new Error("このテストで Notion へ通信してはいけない");
}) as typeof Client.prototype.request;

// ── 差し替えの KV（呼ばれた操作を数える。1回ずつ await を挟んで並行の呼び出しを入り混ぜる）──
const tick = () => new Promise<void>((r) => setImmediate(r));
function fakeKv() {
  const data = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  const calls: string[] = [];
  const kv: CandKv = {
    get: async <T>(key: string) => {
      calls.push(`get ${key}`);
      await tick();
      return (
        data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : null
      ) as T | null;
    },
    mget: async <T>(keys: string[]) => {
      calls.push(`mget ${keys.length}`);
      await tick();
      return keys.map((k) =>
        data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : null,
      ) as Array<T | null>;
    },
    set: async (key, value, opts) => {
      calls.push(`set ${key}${opts.nx ? " nx" : ""}`);
      await tick();
      if (opts.nx && data.has(key)) return null;
      data.set(key, JSON.parse(JSON.stringify(value)));
      return "OK";
    },
    del: async (key) => {
      calls.push(`del ${key}`);
      await tick();
      data.delete(key);
      sets.delete(key);
    },
    sadd: async (key, m) => {
      calls.push(`sadd ${key}`);
      await tick();
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key)!.add(m);
    },
    srem: async (key, m) => {
      calls.push(`srem ${key}`);
      await tick();
      sets.get(key)?.delete(m);
    },
    smembers: async (key) => {
      calls.push(`smembers ${key}`);
      await tick();
      return Array.from(sets.get(key) ?? []);
    },
    expire: async (key) => {
      calls.push(`expire ${key}`);
      await tick();
    },
  };
  return { kv, data, sets, calls };
}

const G1 = "Cgroup1";
const G2 = "Cgroup2";
const U_REQ = `U${"a".repeat(32)}`;
const U_TO = `U${"b".repeat(32)}`;
const U_ADMIN = `U${"c".repeat(32)}`;
const U_OTHER = `U${"d".repeat(32)}`;
const U_TO_ALT = `U${"e".repeat(32)}`;
const DAY = 24 * 60 * 60 * 1000;
// 2026-11-08 14:05 JST
const NOW = Date.UTC(2026, 10, 8, 5, 5);
const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  text: `${id} の本文`,
  title: `${id} の題名`,
  assignee: null,
  assigneeUserId: null,
  senderId: U_REQ,
  createdAt: NOW,
  groupId: G1,
  mentionedUserIds: [U_TO],
  ...over,
});
const members: Member[] = [
  {
    name: "依頼 太郎",
    userIds: [U_REQ],
    aliases: [],
    email: null,
    active: true,
    external: false,
    notionUserId: null,
  },
  {
    name: "宛先 花子",
    userIds: [U_TO, U_TO_ALT],
    aliases: [],
    email: null,
    active: true,
    external: false,
    notionUserId: null,
  },
];

const setEnv = (on: { menu?: boolean; cand?: boolean }) => {
  process.env.TASK_MENU = on.menu ? "1" : "";
  process.env.TASK_BUTTONS = "1";
  process.env.TASK_FOLLOWUP = "1";
  process.env.TASK_CANDIDATES = on.cand === false ? "" : "1";
  process.env.LINE_GROUP_ID = G1;
  process.env.TASK_CANDIDATE_GROUP_IDS = G2;
  process.env.TASK_BUTTONS_ADMIN_IDS = U_ADMIN;
};

(async () => {
  const s = await import("../src/lib/task-candidate-store");
  const t = await import("../src/lib/task-candidate");
  const cc = await import("../src/lib/candidate-card");
  const ask = await import("../src/lib/task-candidate-ask");
  const menu = await import("../src/lib/task-menu");
  const wire = await import("../src/lib/task-buttons-wire");
  const { cardActions } = await import("../src/lib/task-card");

  // ── off：今までの置き場のまま（新しいキーを1回も触らない・B1 の欄を書かない）──
  {
    setEnv({ menu: false });
    s._resetMemoryForTest();
    const f = fakeKv();
    s._setKvForTest(f.kv);
    await s.addCandidate(cand("m1"), NOW);
    const list = await s.listCandidates(NOW);
    ok("off：新しい KV を1回も呼ばない", f.calls.length === 0, f.calls.join());
    ok(
      "off：控えた中身は今までの欄だけ（groupId・mentionedUserIds を書かない）",
      list.length === 1 &&
        !("groupId" in list[0]) &&
        !("mentionedUserIds" in list[0]),
      JSON.stringify(list),
    );
    ok(
      "off：受け付けるグループは営業部だけ",
      JSON.stringify(t.candidateGroupIds()) === JSON.stringify([G1]),
    );
    ok("off：別グループは候補のグループでない", !t.isCandidateGroup(G2));
    ok("off：候補のカードは出さない", !cc.candidateCardsActive());
    s._setKvForTest(null);
  }

  // ── 移行：古い形（taskcand:items・taskcand:numbered）→ 新しい形。番号も引き継ぐ ──
  {
    setEnv({ menu: false });
    s._resetMemoryForTest();
    await s.addCandidate(
      cand("old1", { groupId: undefined, mentionedUserIds: undefined }),
      NOW,
    );
    await s.addCandidate(
      cand("old2", { groupId: undefined, mentionedUserIds: undefined }),
      NOW,
    );
    const before = await s.numberCandidates(NOW);
    ok("移行の前：番号 1・2", before.map((c) => c?.id).join() === "old1,old2");
    setEnv({ menu: true });
    const f = fakeKv();
    s._setKvForTest(f.kv);
    const list = await s.listCandidates(NOW, G1);
    ok(
      "移行：古い候補が新しい形で見える",
      list.map((c) => c.id).join() === "old1,old2",
      JSON.stringify(list),
    );
    ok(
      "移行：古い候補は営業部の候補になる",
      list.every((c) => c.groupId === G1),
    );
    ok(
      "移行：1件ずつのキーになる",
      f.data.has("taskcand:c:old1") && f.data.has("taskcand:c:old2"),
    );
    ok(
      "移行：目次の要素は頭に c: を付ける",
      f.sets.get("taskcand:index")?.has("c:old1") === true,
    );
    ok(
      "移行：番号はそのまま（2 番は old2）",
      (await s.peekCandidate(2, NOW, G1))?.id === "old2",
    );
    // 古いキーは消えた（off に戻すと見えない＝今までの置き場は空）
    setEnv({ menu: false });
    ok("移行：古い一覧は消えた", (await s.listCandidates(NOW)).length === 0);
    setEnv({ menu: true });
    ok(
      "移行：2回目は何もしない（同じ結果）",
      (await s.listCandidates(NOW, G1)).length === 2,
    );
    s._setKvForTest(null);
  }

  // ── 原子的な保存：並行2件の追加で両方残る ──
  {
    setEnv({ menu: true });
    s._resetMemoryForTest();
    const f = fakeKv();
    s._setKvForTest(f.kv);
    const r = await Promise.all([
      s.addCandidate(cand("p1"), NOW),
      s.addCandidate(cand("p2"), NOW),
    ]);
    const ids = (await s.listCandidates(NOW, G1))
      .map((c) => c.id)
      .sort()
      .join();
    ok("並行2件：両方控えた", r.join() === "true,true" && ids === "p1,p2", ids);
    ok(
      "同じ発言は2度控えない",
      (await s.addCandidate(cand("p1"), NOW)) === false,
    );
    ok(
      "全置換をしない（taskcand:items を書かない）",
      !f.calls.some((c) => c.startsWith("set taskcand:items")),
    );
    ok(
      "期限切れは出ない",
      (await s.listCandidates(NOW + 6 * DAY, G1)).length === 0,
    );
    ok(
      "ID の形が違う候補は控えない",
      (await s.addCandidate(cand("a|b"), NOW)) === false,
    );
    // 30 件まで（古いものから落とす）
    for (let i = 0; i < 32; i++)
      await s.addCandidate(
        cand(`n${String(i).padStart(2, "0")}`, { createdAt: NOW + i }),
        NOW + 40,
      );
    const all = await s.listCandidates(NOW + 40, G1);
    ok(
      "全体で30件まで",
      all.length === 30 && all[29].id === "n31",
      `${all.length}`,
    );
    s._setKvForTest(null);
  }

  // ── 番号の文字コマンド（「1 登録」「2 なし」）が今まで通り（グループごとの番号）──
  {
    setEnv({ menu: true });
    const f = fakeKv();
    s._setKvForTest(f.kv);
    await s.addCandidate(cand("x1"), NOW);
    await s.addCandidate(cand("x2"), NOW + 1);
    await s.addCandidate(cand("y1", { groupId: G2 }), NOW + 2);
    const n1 = await s.numberCandidates(NOW, G1);
    const n2 = await s.numberCandidates(NOW, G2);
    ok("営業部の番号", n1.map((c) => c?.id).join() === "x1,x2");
    ok(
      "別グループは別の番号（1 番から）",
      n2.map((c) => c?.id).join() === "y1",
    );
    ok(
      "「1 登録」の読みは今まで通り",
      JSON.stringify(t.parseCandidateCommand("1 登録")) ===
        '{"action":"register","numbers":[1]}',
    );
    ok(
      "「2,3 なし」も今まで通り",
      JSON.stringify(t.parseCandidateCommand("2,3 なし")) ===
        '{"action":"skip","numbers":[2,3]}',
    );
    ok(
      "番号で見る（別グループの1番は見えない）",
      (await s.peekCandidate(1, NOW, G1))?.id === "x1" &&
        (await s.peekCandidate(2, NOW, G2)) === null,
    );
    await s.removeCandidate(1, G1);
    ok(
      "片付けた番号は空く・番号はずれない",
      (await s.peekCandidate(1, NOW, G1)) === null &&
        (await s.peekCandidate(2, NOW, G1))?.id === "x2",
    );
    await s.addCandidate(cand("x3"), NOW + 3);
    ok(
      "新しい分は後ろに付く",
      (await s.numberCandidates(NOW, G1)).map((c) => c?.id ?? null).join() ===
        ",x2,x3",
    );
    s._setKvForTest(null);
  }

  // ── data の形 ──
  {
    ok("encode", cc.encodeCandidateData("cr", "123") === "v1|cr|123");
    ok(
      "parse",
      JSON.stringify(cc.parseCandidateData("v1|ch|123")) ===
        '{"op":"ch","id":"123"}',
    );
    ok("知らない操作は読まない", cc.parseCandidateData("v1|cz|123") === null);
    ok(
      "ID の形が違えば読まない",
      cc.parseCandidateData("v1|cr|a b") === null &&
        cc.parseCandidateData("v1|cr|") === null,
    );
    ok(
      "長すぎる ID は読まない",
      cc.parseCandidateData(`v1|cr|${"1".repeat(101)}`) === null,
    );
    ok(
      "300字を超える data は読まない",
      cc.parseCandidateData(`v1|cr|1${"|".repeat(300)}`) === null,
    );
    ok("追加つきは読まない", cc.parseCandidateData("v1|cr|1|x") === null);
    const { parseMenuData, parseButtonData } =
      await import("../src/lib/task-buttons");
    ok(
      "候補の data はメニュー・タスクと読まない",
      parseMenuData("v1|cr|123") === null &&
        parseButtonData("v1|cr|123") === null,
    );
  }

  // ── カード ──
  {
    setEnv({ menu: true });
    const names = cc.nameResolver(members);
    const card = cc.candidateCard(
      cand("1234567890123456789", { title: "見積書の送付" }),
      names,
    );
    const acts = cardActions(card);
    ok(
      "ボタンの順と文言",
      acts.map((a) => a.label).join() === "登録する,保留,いらない",
    );
    ok(
      "ボタンの data は ID（表示番号でない）",
      acts.map((a) => a.data).join() ===
        "v1|cr|1234567890123456789,v1|ch|1234567890123456789,v1|cx|1234567890123456789",
    );
    ok(
      "表示の文に番号・@ が無い",
      acts.every(
        (a) =>
          !/[0-9０-９@＠]/.test(a.displayText) &&
          a.displayText.startsWith("（ボタン）"),
      ),
    );
    const json = JSON.stringify(card.contents);
    ok(
      "依頼者・宛先の名前・発言の時刻",
      json.includes("依頼 太郎") &&
        json.includes("宛先 花子") &&
        json.includes("11月8日(日) 14:05"),
      json,
    );
    ok("altText 400 字以内", Array.from(card.altText).length <= 400);
    // 10件＋次の10件・30KB 未満
    const many = Array.from({ length: 23 }, (_, i) =>
      cand(`k${i}`, { title: "長".repeat(200), text: "本".repeat(400) }),
    );
    const r = cc.digestWithCards(many, new Set(), names, 0);
    const car = r.card?.contents as {
      type: string;
      contents: Array<Record<string, unknown>>;
    };
    const lastActs = cardActions({
      type: "flex",
      altText: "",
      contents: car.contents[car.contents.length - 1],
    });
    ok(
      "カルーセルは10枚＋［次の10件］",
      car.type === "carousel" &&
        car.contents.length === 11 &&
        lastActs[0]?.data === "v1|lc|10",
      `${car.contents.length}`,
    );
    ok(
      "JSON 30KB 未満",
      Buffer.byteLength(JSON.stringify(car), "utf8") < 30_000,
    );
    ok("文字の一覧は今の buildDigest と同じ", r.text === t.buildDigest(many));
    const r2 = cc.digestWithCards(many, new Set(), names, 20);
    ok(
      "最後のページ（3件・続き無し）",
      (r2.card?.contents as { contents: unknown[] }).contents.length === 3 &&
        r2.shown === 3,
    );
    ok(
      "ラベルは40字以内",
      acts.every((a) => Array.from(a.label).length <= 40),
    );
  }

  // ── 次の 17 時 ──
  {
    ok(
      "14時→今日の17時",
      cc.nextDigestTimeMs(NOW) === Date.UTC(2026, 10, 8, 8, 0),
    );
    ok(
      "17時ちょうど→明日の17時",
      cc.nextDigestTimeMs(Date.UTC(2026, 10, 8, 8, 0)) ===
        Date.UTC(2026, 10, 9, 8, 0),
    );
    ok(
      "18時→明日の17時",
      cc.nextDigestTimeMs(Date.UTC(2026, 10, 8, 9, 0)) ===
        Date.UTC(2026, 10, 9, 8, 0),
    );
  }

  // ── ボタンの処理（handleCandidateAction）──
  const mkDeps = (
    f: ReturnType<typeof fakeKv>,
    over: Partial<import("../src/lib/candidate-card").CandidateActionDeps> = {},
  ) => {
    const replies: string[] = [];
    const logs: string[] = [];
    let registered = 0;
    let now = NOW;
    const deps: import("../src/lib/candidate-card").CandidateActionDeps = {
      ...cc.defaultCandidateActionDeps({
        register: async () => {
          registered++;
          await tick();
          await tick();
          return "ok";
        },
        reply: async (_t, text) => {
          replies.push(text);
        },
        log: (l) => logs.push(l),
      }),
      members: async () => members,
      now: () => now,
      ...over,
    };
    void f;
    return {
      deps,
      replies,
      logs,
      reg: () => registered,
      setNow: (v: number) => {
        now = v;
      },
    };
  };
  {
    setEnv({ menu: true });
    const f = fakeKv();
    s._setKvForTest(f.kv);
    await s.addCandidate(cand("r1"), NOW);
    const d = mkDeps(f);
    // 登録の二重押し（同時）
    await Promise.all([
      cc.handleCandidateAction(
        { op: "cr", id: "r1" },
        U_REQ,
        G1,
        "rt1",
        d.deps,
      ),
      cc.handleCandidateAction(
        { op: "cr", id: "r1" },
        U_REQ,
        G1,
        "rt2",
        d.deps,
      ),
    ]);
    ok("二重押し：登録は1回だけ", d.reg() === 1, `${d.reg()}`);
    ok(
      "二重押し：もう片方は「手続き中」",
      d.replies.join() === cc.MSG_CAND_BUSY,
      d.replies.join(),
    );
    ok("登録できたら候補を消す", (await s.getCandidate("r1", NOW)) === null);
    ok(
      "ログは符号だけ",
      d.logs.every(
        (l) => l.startsWith("[task-candidate] ") && !l.includes("題名"),
      ),
      d.logs.join(),
    );

    // 登録に失敗したら予約を外して候補を残す → もう一度押せる
    await s.addCandidate(cand("r2"), NOW);
    let tries = 0;
    const d2 = mkDeps(f, {
      register: async () => (++tries === 1 ? "retry" : "ok"),
    });
    await cc.handleCandidateAction(
      { op: "cr", id: "r2" },
      U_REQ,
      G1,
      "rt",
      d2.deps,
    );
    ok("失敗：候補は残る", (await s.getCandidate("r2", NOW))?.id === "r2");
    ok("失敗：予約を外す", !f.data.has("taskcand:reg:r2"));
    ok("失敗（retry）：知らせる", d2.replies.join() === cc.MSG_CAND_RETRY);
    await cc.handleCandidateAction(
      { op: "cr", id: "r2" },
      U_REQ,
      G1,
      "rt",
      d2.deps,
    );
    ok(
      "押し直しで登録できる",
      tries === 2 && (await s.getCandidate("r2", NOW)) === null,
    );

    // 登録済み（duplicate）
    await s.addCandidate(cand("r3"), NOW);
    const d3 = mkDeps(f, { register: async () => "duplicate" });
    await cc.handleCandidateAction(
      { op: "cr", id: "r3" },
      U_TO,
      G1,
      "rt",
      d3.deps,
    );
    ok(
      "登録済み：知らせて候補を消す",
      d3.replies.join() === cc.MSG_CAND_DUPLICATE &&
        (await s.getCandidate("r3", NOW)) === null,
    );

    // 例外
    await s.addCandidate(cand("r4"), NOW);
    const d4 = mkDeps(f, {
      register: async () => {
        throw new Error("x");
      },
    });
    await cc.handleCandidateAction(
      { op: "cr", id: "r4" },
      U_REQ,
      G1,
      "rt",
      d4.deps,
    );
    ok(
      "登録で例外：予約を外して候補を残す",
      !f.data.has("taskcand:reg:r4") &&
        (await s.getCandidate("r4", NOW)) !== null &&
        d4.replies.join() === cc.MSG_CAND_ERROR,
    );

    // 保留：次の 17 時まで出さない
    await s.addCandidate(cand("h1"), NOW);
    const d5 = mkDeps(f);
    await cc.handleCandidateAction(
      { op: "ch", id: "h1" },
      U_TO,
      G1,
      "rt",
      d5.deps,
    );
    ok("保留：返事", d5.replies.join() === cc.msgHeld("h1 の題名"));
    const ldeps = (
      now: number,
    ): import("../src/lib/candidate-card").CandidateListDeps => ({
      ...cc.defaultCandidateListDeps(),
      members: async () => members,
      now: () => now,
    });
    const page1 = await cc.candidateListPage(0, G1, ldeps(NOW + 60_000));
    const shownIds = (p: { card?: FlexMessage }) =>
      (
        (p.card?.contents as { contents?: Array<Record<string, unknown>> })
          ?.contents ?? []
      )
        .flatMap((b) => cardActions({ type: "flex", altText: "", contents: b }))
        .filter((a) => a.data.startsWith("v1|cr|"))
        .map((a) => a.data.slice(6));
    ok(
      "保留中はカードに出ない",
      !shownIds(page1).includes("h1") && shownIds(page1).includes("r4"),
      shownIds(page1).join(),
    );
    ok("保留中は文字の一覧にも出ない", !page1.text.includes("h1 の題名"));
    const page2 = await cc.candidateListPage(
      0,
      G1,
      ldeps(Date.UTC(2026, 10, 8, 8, 1)),
    );
    ok("17時を過ぎたらまた出る", shownIds(page2).includes("h1"));

    // いらない
    const d6 = mkDeps(f);
    await cc.handleCandidateAction(
      { op: "cx", id: "h1" },
      U_ADMIN,
      G1,
      "rt",
      d6.deps,
    );
    ok(
      "いらない：候補から外す（ADMIN も押せる）",
      d6.replies.join() === cc.msgDropped("h1 の題名") &&
        (await s.getCandidate("h1", NOW)) === null,
    );

    // 押せない人・別アカウント
    await s.addCandidate(cand("f1"), NOW);
    const d7 = mkDeps(f);
    await cc.handleCandidateAction(
      { op: "cx", id: "f1" },
      U_OTHER,
      G1,
      "rt",
      d7.deps,
    );
    ok(
      "押せない人：決まった文で断る・消さない",
      d7.replies.join() === cc.MSG_CAND_FORBIDDEN &&
        (await s.getCandidate("f1", NOW)) !== null,
    );
    await cc.handleCandidateAction(
      { op: "cr", id: "f1" },
      undefined,
      G1,
      "rt",
      d7.deps,
    );
    ok(
      "送り主の分からない postback も断る",
      d7.replies[1] === cc.MSG_CAND_FORBIDDEN && d7.reg() === 0,
    );
    const d8 = mkDeps(f);
    await cc.handleCandidateAction(
      { op: "ch", id: "f1" },
      U_TO_ALT,
      G1,
      "rt",
      d8.deps,
    );
    ok(
      "宛先の人の別アカウント（名簿）は押せる",
      d8.replies.join() === cc.msgHeld("f1 の題名"),
    );

    // グループ越し：見えない・押せない
    const d9 = mkDeps(f);
    await cc.handleCandidateAction(
      { op: "cx", id: "f1" },
      U_ADMIN,
      G2,
      "rt",
      d9.deps,
    );
    await cc.handleCandidateAction(
      { op: "cx", id: "f1" },
      U_ADMIN,
      undefined,
      "rt",
      d9.deps,
    );
    await cc.handleCandidateAction(
      { op: "cx", id: "f1" },
      U_ADMIN,
      "Cnotallowed",
      "rt",
      d9.deps,
    );
    ok(
      "別のグループ・1対1・受け付けないグループからは「見つかりません」",
      d9.replies.every((r) => r === cc.MSG_CAND_NOT_FOUND) &&
        d9.replies.length === 3,
    );
    ok("グループ越しでは消えない", (await s.getCandidate("f1", NOW)) !== null);
    const other = await cc.candidateListPage(0, G2, ldeps(NOW));
    ok("別のグループの一覧には出ない", !shownIds(other).includes("f1"));
    ok(
      "1対1の一覧は出さない",
      (await cc.candidateListPage(0, undefined, ldeps(NOW))).text ===
        cc.MSG_CAND_ONLY_GROUP,
    );

    // メニューの［候補］（handleMenuAction → deps.candidates）
    const md: import("../src/lib/task-menu").MenuDeps = {
      listToday: async () => [],
      listMine: async () => [],
      aliasIds: async (u) => [u],
      today: () => "2026-11-08",
      candidates: (off, _a, g) => cc.candidateListPage(off, g, ldeps(NOW)),
    };
    const mr = await menu.handleMenuAction(
      { op: "lc", offset: 0 },
      U_REQ,
      G1,
      md,
    );
    ok(
      "メニューの［候補］：文字の一覧＋カード",
      Boolean(mr.card) &&
        mr.text.startsWith("📝 タスクにしますか？") &&
        (mr.shown ?? 0) > 0,
    );
    const { candidates: _drop, ...noCand } = md;
    void _drop;
    ok(
      "candidates の部品が無ければ今まで通り「準備中です」",
      (await menu.handleMenuAction({ op: "lc", offset: 0 }, U_REQ, G1, noCand))
        .text === menu.MSG_PREPARING,
    );
    setEnv({ menu: true, cand: false });
    ok(
      "TASK_CANDIDATES off なら止めている旨",
      (await cc.candidateListPage(0, G1, ldeps(NOW))).text === cc.MSG_CAND_OFF,
    );
    s._setKvForTest(null);
  }

  // ── postback の入口（handleTaskPostbackEvent）──
  {
    const f = fakeKv();
    s._setKvForTest(f.kv);
    setEnv({ menu: true });
    await s.addCandidate(cand("w1"), NOW);
    const replies: Array<{ text: string; card?: FlexMessage }> = [];
    const logs: string[] = [];
    let registered = 0;
    let reserved = 0;
    const io = {
      reserve: async () => {
        reserved++;
        return { proceed: true };
      },
      complete: async () => undefined,
      reply: async (_t: string, text: string, card?: FlexMessage) => {
        replies.push({ text, card });
        return { textId: "T", cardId: null };
      },
      cardRefs: null,
      log: (l: string) => logs.push(l),
      candidates: {
        register: async () => {
          registered++;
          return "ok" as const;
        },
        members: async () => members,
        now: () => NOW,
      },
    };
    const ev = (
      data: string,
      userId = U_REQ,
      groupId: string | undefined = G1,
    ) => ({
      type: "postback",
      replyToken: "rt",
      webhookEventId: "e1",
      source: { userId, groupId },
      postback: { data },
    });
    await wire.handleTaskPostbackEvent(ev("v1|cr|w1"), io);
    ok(
      "postback：［登録する］で登録に回す",
      registered === 1 && (await s.getCandidate("w1", NOW)) === null,
    );
    ok("postback：タスクの予約（pb:）は使わない", reserved === 0);
    // off：候補のボタンは扱わない（今までどおり「使えません」）
    setEnv({ menu: false });
    replies.length = 0;
    await wire.handleTaskPostbackEvent(ev("v1|cr|w1"), io);
    ok(
      "off：候補の data は今までどおり「使えません」",
      replies.length === 1 &&
        replies[0].text === "⚠️ このボタンは使えません" &&
        registered === 1,
    );
    s._setKvForTest(null);
  }

  // ── 17 時：文字＋カードを1回の push で（off は今と同じ）──
  {
    const AT_17 = Date.UTC(2026, 10, 8, 8, 5);
    const pushes: Array<{ to: string; args: number; card?: FlexMessage }> = [];
    const claims: string[] = [];
    const deps: import("../src/lib/task-candidate-ask").AskDeps = {
      claim: async (...a: [string, string?]) => {
        claims.push(a.join("@"));
        return true;
      },
      number: async (_n: number, g?: string) =>
        g === G2 ? [cand("g2", { groupId: G2 })] : [cand("g1")],
      push: async (...a: [string, string, FlexMessage?]) => {
        pushes.push({ to: a[0], args: a.length, card: a[2] });
        return true;
      },
      members: async () => members,
    };
    setEnv({ menu: false });
    const r0 = await ask.askCandidatesIfDue(AT_17, deps, G1, "2026-11-08");
    ok(
      "off：営業部へ文字だけ（引数も今と同じ2つ）",
      r0 === "sent" &&
        pushes.length === 1 &&
        pushes[0].args === 2 &&
        claims.join() === "2026-11-08",
    );
    pushes.length = 0;
    claims.length = 0;
    setEnv({ menu: true });
    const r1 = await ask.askCandidatesIfDue(AT_17, deps, G1, "2026-11-08");
    ok(
      "on：営業部と別グループへ、文字＋カード",
      r1 === "sent" &&
        pushes.map((p) => p.to).join() === `${G1},${G2}` &&
        pushes.every(
          (p) =>
            p.card?.contents &&
            (p.card.contents as { type: string }).type === "carousel",
        ),
    );
    ok(
      "on：印はグループごと",
      claims.join() === `2026-11-08@${G1},2026-11-08@${G2}`,
    );
    // 本物の置き場の印：営業部は今までと同じキー
    const f = fakeKv();
    s._setKvForTest(f.kv);
    await s.claimDailyAsk("2026-11-08", G1);
    await s.claimDailyAsk("2026-11-08", G2);
    ok(
      "営業部の印は今までと同じキー",
      f.data.has("taskcand:asked:2026-11-08") &&
        f.data.has(`taskcand:asked:2026-11-08:${G2}`),
    );
    ok(
      "同じ日の2回目は聞かない",
      (await s.claimDailyAsk("2026-11-08", G1)) === false,
    );
    s._setKvForTest(null);
  }

  // ── 迷った依頼の返事：候補カード1枚（reply）──
  {
    setEnv({ menu: true });
    const sent: Array<{ text: string; card?: FlexMessage }> = [];
    await cc.replyCandidateCard("rt", cand("q1"), {
      reply: async (_t, text, card) => {
        sent.push({ text, card });
        return { textId: "T", cardId: "C" };
      },
      members: async () => members,
    });
    ok(
      "迷った依頼：文字＋候補カード1枚",
      sent.length === 1 &&
        sent[0].text === cc.MSG_CAND_ASKED &&
        (sent[0].card?.contents as { type: string }).type === "bubble",
    );
  }

  // ── 本番の部分設定（URL か TOKEN の片方だけ）：控えない ──
  {
    setEnv({ menu: true });
    s._resetMemoryForTest();
    process.env.KV_REST_API_URL = "https://example.invalid";
    const logSpy: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => {
      logSpy.push(a.join(" "));
    };
    const added = await s.addCandidate(cand("z1"), NOW);
    const list = await s.listCandidates(NOW, G1);
    console.log = orig;
    delete process.env.KV_REST_API_URL;
    ok("部分設定：控えない・読まない", added === false && list.length === 0);
    ok(
      "部分設定：ログは符号だけ",
      logSpy.every((l) => l === "[task-candidate] kv-partial skip"),
      logSpy.join(),
    );
    ok(
      "部分設定：メモリにも置かない",
      (await s.listCandidates(NOW, G1)).length === 0,
    );
  }

  ok("外部への通信は0回（fetch）", fetchCalls === 0, `${fetchCalls}`);
  ok("外部への通信は0回（Notion）", notionCalls === 0, `${notionCalls}`);
  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
})();
