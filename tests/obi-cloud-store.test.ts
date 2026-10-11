/**
 * クラウド配達の KV：錠・控え・目次・待ち時間・知らせの id の控え
 * （約束 2026-10-11-obi-cloud-contract.md の「KV の鍵」）。KV は偽物。
 */
import {
  createKvCloudStore,
  readMemoFacts,
  type CloudJobMemo,
  type CloudKvClient,
} from "../src/lib/obi/cloud-store";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name}`);
};

const CLAIM = "11111111-2222-4333-8444-555555555555";
const SHA = "2".repeat(64);
const ISO = "2026-10-11T03:00:00.000Z";
const LEASE = "2026-10-11T03:45:00.000Z";
const FACTS = {
  reviewPages: 2,
  outsideErased: 4,
  outsidePages: [1, 3],
  fix: null,
  property: "グランメゾン北浜 302",
};
const MEMO: CloudJobMemo = {
  v: 1,
  claimId: CLAIM,
  sha256: SHA,
  stage: "prepared",
  leaseUntil: LEASE,
  facts: FACTS,
  at: ISO,
};

type Op = [string, ...unknown[]];
function fakeKv() {
  const ops: Op[] = [];
  const data = new Map<string, unknown>();
  const sets = new Map<string, unknown[]>();
  const failOn = new Set<string>();
  let hang = "";
  const step = async <T>(
    name: string,
    args: unknown[],
    run: () => T,
  ): Promise<T> => {
    ops.push([name, ...args]);
    if (hang === name) return new Promise<T>(() => {});
    if (failOn.has(name))
      throw Object.assign(new Error(`${name} failed`), { name: "FakeKvError" });
    return run();
  };
  const client: CloudKvClient = {
    set: (key, value, opts) =>
      step("set", [key, value, opts], () => {
        if (opts.nx && data.has(key)) return null;
        data.set(key, value);
        return "OK";
      }),
    get: (key) =>
      step("get", [key], () => (data.has(key) ? data.get(key) : null)),
    del: (key) => step("del", [key], () => (data.delete(key) ? 1 : 0)),
    sadd: (key, member) => step("sadd", [key, member], () => 1),
    srem: (key, member) => step("srem", [key, member], () => 1),
    smembers: (key) => step("smembers", [key], () => sets.get(key) ?? []),
  };
  return {
    client,
    ops,
    data,
    sets,
    failOn,
    setHang: (n: string) => (hang = n),
  };
}
const names = (ops: Op[]) => ops.map((o) => o[0]).join();
const rejects = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { name?: string })?.name ?? "Error";
  }
};

async function main() {
  // ---- 錠
  let k = fakeKv();
  let s = createKvCloudStore(k.client);
  ok("錠：置けたら true", (await s.acquireLock()) === true);
  ok(
    "錠：set NX・90秒",
    JSON.stringify(k.ops[0]) ===
      JSON.stringify(["set", "obi-cloud:lock", "1", { nx: true, ex: 90 }]),
    JSON.stringify(k.ops[0]),
  );
  ok("錠：もうあれば false", (await s.acquireLock()) === false);
  await s.releaseLock();
  ok(
    "錠：外すのは del",
    JSON.stringify(k.ops[2]) === JSON.stringify(["del", "obi-cloud:lock"]),
  );

  // ---- 控えを書く
  k = fakeKv();
  s = createKvCloudStore(k.client);
  await s.putJob(12, MEMO);
  ok(
    "控え：sadd（目次）→ set の順",
    names(k.ops) === "sadd,set" &&
      JSON.stringify(k.ops[0]) ===
        JSON.stringify(["sadd", "obi-cloud:jobs", "12"]),
  );
  ok(
    "控え：鍵・期限 3,600 秒・nx なし",
    k.ops[1][1] === "obi-cloud:job:12" &&
      JSON.stringify(k.ops[1][3]) === JSON.stringify({ ex: 3600 }),
  );
  const written = JSON.parse(String(k.ops[1][2]));
  ok(
    "控え：JSON を戻すと元と同じ",
    JSON.stringify(written) === JSON.stringify(MEMO),
  );
  ok(
    "控え：項目の名前の一覧",
    Object.keys(written).sort().join() ===
      "at,claimId,facts,leaseUntil,sha256,stage,v",
  );
  ok(
    "控え：facts はちょうど5項目",
    Object.keys(written.facts).sort().join() ===
      "fix,outsideErased,outsidePages,property,reviewPages",
  );
  await s.putJob(12, {
    ...MEMO,
    stage: "sent",
    messageId: "600000000000000001",
    msgTries: 0,
  });
  ok(
    "控え：messageId・msgTries は入れたときだけ",
    Object.keys(JSON.parse(String(k.ops[3][2])))
      .sort()
      .join() ===
      "at,claimId,facts,leaseUntil,messageId,msgTries,sha256,stage,v",
  );
  ok("控え：書き直しでも毎回 sadd", names(k.ops) === "sadd,set,sadd,set");
  const text = String(k.ops[1][2]);
  ok(
    "控え：リンク・トークン・グループの ID に当たる項目と値が無い",
    !/liff|https?:|token|groupId|"C[0-9a-f]{32}"|text|link/i.test(text),
    text,
  );

  k = fakeKv();
  s = createKvCloudStore(k.client);
  k.failOn.add("sadd");
  ok(
    "控え：sadd が例外 → 外へ出る",
    (await rejects(s.putJob(12, MEMO))) === "FakeKvError",
  );
  ok("控え：sadd が例外 → set を呼ばない", names(k.ops) === "sadd");
  k = fakeKv();
  s = createKvCloudStore(k.client);
  k.failOn.add("set");
  ok(
    "控え：set が例外 → 外へ出る（握りつぶさない）",
    (await rejects(s.putJob(12, MEMO))) === "FakeKvError",
  );

  const INVISIBLE = String.fromCharCode(0x200b);
  const badMemos: Array<[string, unknown]> = [
    ["facts に6つ目の項目", { ...MEMO, facts: { ...FACTS, groupId: "x" } }],
    [
      "facts.property が62字",
      { ...MEMO, facts: { ...FACTS, property: "あ".repeat(62) } },
    ],
    [
      "facts.property に改行",
      { ...MEMO, facts: { ...FACTS, property: "a\nb" } },
    ],
    [
      "facts.property に見えない文字",
      { ...MEMO, facts: { ...FACTS, property: `a${INVISIBLE}b` } },
    ],
    [
      "facts.property が無い",
      {
        ...MEMO,
        facts: {
          reviewPages: 0,
          outsideErased: 0,
          outsidePages: [],
          fix: null,
        },
      },
    ],
    ["leaseUntil が空", { ...MEMO, leaseUntil: "" }],
    ["stage が知らない値", { ...MEMO, stage: "done" }],
    ["claimId が UUID でない", { ...MEMO, claimId: "x" }],
    [
      "reviewPages が文字列",
      { ...MEMO, facts: { ...FACTS, reviewPages: "2" } },
    ],
    [
      "fix に余分な項目",
      {
        ...MEMO,
        facts: {
          ...FACTS,
          fix: {
            round: 1,
            code: 1,
            page: null,
            turn: "",
            by: "auto",
            source: "line-group",
            text: "x",
          },
        },
      },
    ],
  ];
  for (const [label, memo] of badMemos) {
    k = fakeKv();
    s = createKvCloudStore(k.client);
    const err = await rejects(s.putJob(12, memo as CloudJobMemo));
    ok(
      `控え：${label} は書かない（sadd も set も呼ばず例外）`,
      err !== null && k.ops.length === 0,
      `${err} ${names(k.ops)}`,
    );
  }
  ok(
    "facts：61字（60字＋…）は可",
    readMemoFacts({ ...FACTS, property: "𠮷".repeat(60) + "…" }) !== null,
  );
  ok(
    "facts：空の物件名は可",
    readMemoFacts({ ...FACTS, property: "" }) !== null,
  );
  ok(
    "facts：fix の項目の順番が違っても同じ",
    readMemoFacts({
      ...FACTS,
      fix: {
        source: "line-group",
        by: "auto",
        turn: "",
        page: 3,
        code: 1,
        round: 1,
      },
    })?.fix?.page === 3,
  );

  // ---- 控えを消す
  k = fakeKv();
  s = createKvCloudStore(k.client);
  await s.delJob(12);
  ok(
    "控え：消すのは del → srem の順",
    JSON.stringify(k.ops) ===
      JSON.stringify([
        ["del", "obi-cloud:job:12"],
        ["srem", "obi-cloud:jobs", "12"],
      ]),
  );
  k = fakeKv();
  s = createKvCloudStore(k.client);
  k.failOn.add("srem");
  ok(
    "控え：srem が例外でも delJob は成功",
    (await rejects(s.delJob(12))) === null && names(k.ops) === "del,srem",
  );
  k = fakeKv();
  s = createKvCloudStore(k.client);
  k.failOn.add("del");
  ok(
    "控え：del が例外なら外へ出て、srem を呼ばない",
    (await rejects(s.delJob(12))) === "FakeKvError" && names(k.ops) === "del",
  );
  k = fakeKv();
  s = createKvCloudStore(k.client);
  await s.unindexJob(12);
  ok(
    "目次：unindexJob は srem",
    JSON.stringify(k.ops) ===
      JSON.stringify([["srem", "obi-cloud:jobs", "12"]]),
  );
  k.failOn.add("srem");
  ok(
    "目次：unindexJob は例外でも成功",
    (await rejects(s.unindexJob(12))) === null,
  );

  // ---- 控えを読む
  k = fakeKv();
  s = createKvCloudStore(k.client);
  ok(
    "読む：無ければ null",
    (await s.getJob(12)) === null &&
      JSON.stringify(k.ops[0]) === JSON.stringify(["get", "obi-cloud:job:12"]),
  );
  k.data.set("obi-cloud:job:12", JSON.stringify(MEMO));
  const a = await s.getJob(12);
  k.data.set("obi-cloud:job:12", JSON.parse(JSON.stringify(MEMO)));
  const b = await s.getJob(12);
  ok(
    "読む：文字列の JSON でも物でも同じ結果",
    a !== null &&
      a !== "invalid" &&
      JSON.stringify(a) === JSON.stringify(b) &&
      JSON.stringify(a) === JSON.stringify(MEMO),
  );
  const readOf = async (v: unknown) => {
    k.data.set("obi-cloud:job:12", v);
    return s.getJob(12);
  };
  const invalids: Array<[string, unknown]> = [
    ["v: 2", { ...MEMO, v: 2 }],
    ["stage: done", { ...MEMO, stage: "done" }],
    ["claimId が UUID でない", { ...MEMO, claimId: "abc" }],
    ["sha256 が63桁", { ...MEMO, sha256: "2".repeat(63) }],
    ["msgTries: 4", { ...MEMO, msgTries: 4 }],
    ["messageId が数字でない", { ...MEMO, messageId: "abc" }],
    ["at が読めない", { ...MEMO, at: "x" }],
    ["壊れた JSON", "{oops"],
    ["配列", [MEMO]],
    ["数", 12],
  ];
  for (const [label, v] of invalids)
    ok(`読む：${label} → invalid`, (await readOf(v)) === "invalid");
  for (const stage of ["prepared", "attempt-requested", "attempting", "sent"]) {
    const r = await readOf({ ...MEMO, stage });
    ok(
      `読む：stage ${stage} は読める`,
      r !== null && r !== "invalid" && r.stage === stage,
    );
  }
  const partial: Array<[string, unknown, "leaseUntil" | "facts"]> = [
    [
      "leaseUntil が無い",
      (() => {
        const { leaseUntil: _l, ...rest } = MEMO;
        void _l;
        return rest;
      })(),
      "leaseUntil",
    ],
    ["leaseUntil が読めない", { ...MEMO, leaseUntil: "いつか" }, "leaseUntil"],
    [
      "facts が無い",
      (() => {
        const { facts: _f, ...rest } = MEMO;
        void _f;
        return rest;
      })(),
      "facts",
    ],
    [
      "facts.property が無い",
      {
        ...MEMO,
        facts: {
          reviewPages: 0,
          outsideErased: 0,
          outsidePages: [],
          fix: null,
        },
      },
      "facts",
    ],
    [
      "facts.property が62字",
      { ...MEMO, facts: { ...FACTS, property: "あ".repeat(62) } },
      "facts",
    ],
    [
      "facts.property が改行入り",
      { ...MEMO, facts: { ...FACTS, property: "a\r\nb" } },
      "facts",
    ],
    [
      "facts に余分な項目",
      { ...MEMO, facts: { ...FACTS, link: "x" } },
      "facts",
    ],
    [
      "facts.reviewPages が文字列",
      { ...MEMO, facts: { ...FACTS, reviewPages: "2" } },
      "facts",
    ],
    ["facts が配列", { ...MEMO, facts: [] }, "facts"],
  ];
  for (const [label, v, field] of partial) {
    const r = await readOf(v);
    ok(
      `読む：${label} → ${field} だけ null（控えは読める）`,
      r !== null &&
        r !== "invalid" &&
        r[field] === null &&
        r.claimId === CLAIM &&
        r.sha256 === SHA,
    );
  }

  // ---- 目次
  k = fakeKv();
  s = createKvCloudStore(k.client);
  k.sets.set("obi-cloud:jobs", [
    "12",
    3,
    "abc",
    "0",
    "12:x",
    "007",
    null,
    { a: 1 },
  ]);
  let nos = await s.listJobNos(20);
  ok(
    "目次：形の合う番号だけ・小さい順（数で返った値も受ける）",
    nos.join() === "3,12",
    nos.join(),
  );
  const srems = k.ops.filter((o) => o[0] === "srem").map((o) => String(o[2]));
  ok(
    "目次：形の違う値は srem（1回ずつ）",
    srems.sort().join() === ["0", "007", "12:x", "abc"].sort().join(),
    srems.join(),
  );
  ok(
    "目次：引くのは smembers（scan は無い）",
    k.ops[0][0] === "smembers" &&
      k.ops[0][1] === "obi-cloud:jobs" &&
      !("scan" in k.client),
  );
  k.sets.set("obi-cloud:jobs", ["5", "1", "9", "3"]);
  nos = await s.listJobNos(2);
  ok("目次：limit で切る", nos.join() === "1,3");
  k = fakeKv();
  s = createKvCloudStore(k.client);
  k.sets.set("obi-cloud:jobs", ["12", "abc"]);
  k.failOn.add("srem");
  ok(
    "目次：掃除の srem が例外でも一覧は返る",
    (await s.listJobNos(20)).join() === "12",
  );
  k.failOn.add("smembers");
  ok(
    "目次：smembers が例外 → 外へ出る",
    (await rejects(s.listJobNos(20))) === "FakeKvError",
  );

  // ---- 待ち時間
  k = fakeKv();
  s = createKvCloudStore(k.client);
  ok(
    "待ち時間：無ければ null",
    (await s.getRetry(12, SHA)) === null &&
      k.ops[0][1] === `obi-cloud:retry:12:${SHA}`,
  );
  await s.bumpRetry(12, SHA, ISO);
  const set1 = k.ops.find((o) => o[0] === "set")!;
  ok(
    "待ち時間：無ければ count 1・7日",
    set1[1] === `obi-cloud:retry:12:${SHA}` &&
      String(set1[2]) === JSON.stringify({ count: 1, lastAt: ISO }) &&
      JSON.stringify(set1[3]) === JSON.stringify({ ex: 604800 }),
  );
  await s.bumpRetry(12, SHA, LEASE);
  const r2 = await s.getRetry(12, SHA);
  ok("待ち時間：あれば count + 1", r2?.count === 2 && r2.lastAt === LEASE);
  k.data.set(`obi-cloud:retry:12:${SHA}`, { count: 3, lastAt: ISO });
  ok("待ち時間：物で返っても読める", (await s.getRetry(12, SHA))?.count === 3);
  await s.clearRetry(12, SHA);
  ok(
    "待ち時間：clearRetry は del",
    JSON.stringify(k.ops[k.ops.length - 1]) ===
      JSON.stringify(["del", `obi-cloud:retry:12:${SHA}`]) &&
      (await s.getRetry(12, SHA)) === null,
  );
  k.failOn.add("get");
  ok(
    "待ち時間：読めなければ例外",
    (await rejects(s.getRetry(12, SHA))) === "FakeKvError",
  );

  // ---- 知らせの id
  k = fakeKv();
  s = createKvCloudStore(k.client);
  await s.putNoticeMsg(4, 41, { messageId: "600000000000000002", tries: 1 });
  ok(
    "知らせの id：sadd → set の順・24時間",
    JSON.stringify(k.ops) ===
      JSON.stringify([
        ["sadd", "obi-cloud:notice-msgs", "4:41"],
        [
          "set",
          "obi-cloud:notice-msg:4:41",
          JSON.stringify({ messageId: "600000000000000002", tries: 1 }),
          { ex: 86400 },
        ],
      ]),
    JSON.stringify(k.ops),
  );
  const nm = await s.getNoticeMsg(4, 41);
  k.data.set("obi-cloud:notice-msg:4:41", {
    messageId: "600000000000000002",
    tries: 1,
  });
  const nm2 = await s.getNoticeMsg(4, 41);
  ok(
    "知らせの id：読み方（文字列・物）",
    nm?.messageId === "600000000000000002" &&
      nm.tries === 1 &&
      JSON.stringify(nm) === JSON.stringify(nm2),
  );
  ok("知らせの id：無ければ null", (await s.getNoticeMsg(4, 40)) === null);
  k.ops.length = 0;
  await s.delNoticeMsg(4, 41);
  ok(
    "知らせの id：消すのは del → srem",
    JSON.stringify(k.ops) ===
      JSON.stringify([
        ["del", "obi-cloud:notice-msg:4:41"],
        ["srem", "obi-cloud:notice-msgs", "4:41"],
      ]),
  );
  k = fakeKv();
  s = createKvCloudStore(k.client);
  k.failOn.add("sadd");
  ok(
    "知らせの id：sadd が例外なら set を呼ばない",
    (await rejects(s.putNoticeMsg(4, 41, { messageId: "1", tries: 1 }))) ===
      "FakeKvError" && names(k.ops) === "sadd",
  );
  k = fakeKv();
  s = createKvCloudStore(k.client);
  k.sets.set("obi-cloud:notice-msgs", ["4:41", "4:x", "0:1", "5:0"]);
  const list = await s.listNoticeMsgs(10);
  ok(
    "知らせの id の目次：形の合う値だけ",
    JSON.stringify(list) ===
      JSON.stringify([
        { no: 4, choiceGen: 41 },
        { no: 5, choiceGen: 0 },
      ]),
    JSON.stringify(list),
  );
  ok(
    "知らせの id の目次：形の違う値は srem",
    k.ops
      .filter((o) => o[0] === "srem")
      .map((o) => o[2])
      .sort()
      .join() === "0:1,4:x",
  );
  k.ops.length = 0;
  await s.unindexNoticeMsg(4, 41);
  ok(
    "知らせの id の目次：unindexNoticeMsg は srem",
    JSON.stringify(k.ops) ===
      JSON.stringify([["srem", "obi-cloud:notice-msgs", "4:41"]]),
  );

  // ---- 時間切れ
  k = fakeKv();
  s = createKvCloudStore(k.client, 20);
  k.setHang("get");
  const t0 = Date.now();
  ok(
    "時間切れ：返らない get は例外（KvTimeout）",
    (await rejects(s.getJob(12))) === "KvTimeout" && Date.now() - t0 < 1000,
  );
  k.setHang("sadd");
  ok(
    "時間切れ：返らない sadd → 控えを書かない",
    (await rejects(s.putJob(12, MEMO))) === "KvTimeout" &&
      !k.ops.some((o) => o[0] === "set"),
  );
  k.setHang("srem");
  ok(
    "時間切れ：消した後の srem が返らなくても delJob は成功",
    (await rejects(s.delJob(12))) === null,
  );
  k.setHang("set");
  ok(
    "時間切れ：返らない錠 → 例外",
    (await rejects(s.acquireLock())) === "KvTimeout",
  );

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
