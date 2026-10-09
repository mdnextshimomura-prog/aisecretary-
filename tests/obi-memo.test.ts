/**
 * 帯替え用の PDF の控え（設計 9）。メモリの控えと、KV の操作の順番（偽物の KV）を確かめる。
 */
import {
  createMemoryObiStore,
  createKvObiStore,
  recordObiPdf,
  selectObiPdfs,
  OBI_WINDOW_MS,
  type ObiKvClient,
  type ObiPdfRecord,
} from "../src/lib/obi/memo";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

const G = "C" + "a".repeat(32);
const U = "U" + "b".repeat(32);
const T = 1_760_000_000_000;
const MIN = 60_000;
const rec = (id: string, ts: number, name = `${id}.pdf`, size = 1000): ObiPdfRecord => ({
  messageId: id,
  fileName: name,
  size,
  timestamp: ts,
  userId: U,
});

async function main() {
  // ── メモリの控え ──
  {
    const s = createMemoryObiStore(() => T);
    await recordObiPdf(s, G, rec("100", T - 75 * MIN));
    await recordObiPdf(s, G, rec("200", T - 10 * MIN));
    ok("1時間より古いものは追加のときに並びと詳細の両方から消える", s.sizes(G).z === 1 && s.sizes(G).h === 1, JSON.stringify(s.sizes(G)));
    const got = await s.listPdfs(G, T - OBI_WINDOW_MS, T);
    ok("時刻の範囲で引ける", got.length === 1 && got[0].messageId === "200");
    await recordObiPdf(s, G, rec("200", T - 10 * MIN));
    ok("同じ message.id の再送は重複しない", (await s.listPdfs(G, 0, T)).length === 1);
    await recordObiPdf(s, G, rec("abc", T));
    ok("数字でない message.id は控えない", (await s.listPdfs(G, 0, T)).length === 1);
    ok("別のグループの控えは混ざらない", (await s.listPdfs("C" + "f".repeat(32), 0, T)).length === 0);
    ok("NX：1回目は置ける", await s.setNx("k", 60));
    ok("NX：2回目は置けない", !(await s.setNx("k", 60)));
  }
  {
    let now = T;
    const s = createMemoryObiStore(() => now);
    await s.setNx("k", 60);
    now += 61_000;
    ok("NX：期限が切れたらまた置ける", await s.setNx("k", 60));
    ok("印の有無：期限内は true", await s.has("k"));
    now += 61_000;
    ok("印の有無：期限が切れたら false・無いものも false", !(await s.has("k")) && !(await s.has("none")));
  }

  // ── KV の控え（偽物の KV で、呼ぶ順番と引数を確かめる） ──
  {
    const calls: unknown[][] = [];
    const zrangeResults: string[][] = [];
    let hmgetResult: Record<string, unknown> | null = null;
    let setResult: unknown = "OK";
    const fake: ObiKvClient = {
      hset: async (k, v) => { calls.push(["hset", k, v]); return 1; },
      zadd: async (k, sm) => { calls.push(["zadd", k, sm]); return 1; },
      zrange: async (k, min, max, o) => { calls.push(["zrange", k, min, max, o]); return zrangeResults.shift() ?? []; },
      zremrangebyscore: async (k, min, max) => { calls.push(["zremrangebyscore", k, min, max]); return 1; },
      hdel: async (k, ...f) => { calls.push(["hdel", k, ...f]); return 1; },
      hmget: async (k, ...f) => { calls.push(["hmget", k, ...f]); return hmgetResult; },
      expire: async (k, sec) => { calls.push(["expire", k, sec]); return 1; },
      set: async (k, v, o) => { calls.push(["set", k, v, o]); return setResult; },
      exists: async (k) => { calls.push(["exists", k]); return 0; },
    };
    const s = createKvObiStore(fake);
    const z = `obi-pdf:z:${G}`;
    const h = `obi-pdf:h:${G}`;
    const r = rec("9007199254740993", T);
    zrangeResults.push(["m:100", "m:101"]);
    await recordObiPdf(s, G, r);
    const cut = T - 60 * MIN - 1;
    const expected = [
      ["hset", h, { "m:9007199254740993": JSON.stringify(r) }],
      ["zadd", z, { score: T, member: "m:9007199254740993" }],
      ["zrange", z, "-inf", cut, { byScore: true }],
      ["zremrangebyscore", z, "-inf", cut],
      ["hdel", h, "m:100", "m:101"],
      ["expire", z, 3600],
      ["expire", h, 3600],
    ];
    ok("足す：詳細→並び→古いものを並びと詳細から消す→期限1時間", JSON.stringify(calls) === JSON.stringify(expected), JSON.stringify(calls));

    calls.length = 0;
    await recordObiPdf(s, G, rec("300", T));
    ok("古いものが無ければ消さない", !calls.some((c) => c[0] === "zremrangebyscore" || c[0] === "hdel"));

    calls.length = 0;
    zrangeResults.push(["m:200", "m:300", "m:400"]);
    hmgetResult = {
      "m:200": JSON.stringify(rec("200", T - MIN)),
      "m:300": rec("300", T - MIN), // KV が JSON を読み替えて返した形
      "m:400": null, // 詳細が消えている
    };
    const listed = await s.listPdfs(G, T - OBI_WINDOW_MS, T);
    ok("引く：時刻の範囲で並びを引き、詳細をまとめて読む", JSON.stringify(calls[0]) === JSON.stringify(["zrange", z, T - OBI_WINDOW_MS, T, { byScore: true }]) && calls[1][0] === "hmget");
    ok("引く：文字列・読み替え済みのどちらも読め、詳細の無いものは飛ばす", listed.map((x) => x.messageId).join() === "200,300", JSON.stringify(listed));

    calls.length = 0;
    ok("NX：OK なら true", await s.setNx("obi-accepted-notified:1", 86400));
    ok("NX：nx と期限24時間で置く", JSON.stringify(calls[0]) === JSON.stringify(["set", "obi-accepted-notified:1", 1, { nx: true, ex: 86400 }]));
    setResult = null;
    ok("NX：置けなければ false", !(await s.setNx("obi-accepted-notified:1", 86400)));
    calls.length = 0;
    ok("印の有無：exists が0なら false", !(await s.has("obi-portal-attempted:1")) && JSON.stringify(calls[0]) === JSON.stringify(["exists", "obi-portal-attempted:1"]));
  }

  // ── 依頼に使う PDF の選び方 ──
  {
    const req = { messageId: "500", timestamp: T };
    const s1 = selectObiPdfs(
      [
        rec("100", T - OBI_WINDOW_MS), // ちょうど30分前：使う
        rec("101", T - OBI_WINDOW_MS - 1), // 30分より前：使わない
        rec("102", T), // 依頼と同じ時刻・依頼より前の id：使う
        rec("600", T - 1000), // 依頼より後の id：使わない
        rec("103", T - 1000, "a.jpg"), // PDF でない：使わない
        rec("104", T + 1), // 依頼より後の時刻：使わない
      ],
      req
    );
    ok("30分の境目・依頼より後・PDF 以外の扱い", s1.kind === "ok" && s1.pdfs.map((p) => p.messageId).join() === "100,102", JSON.stringify(s1));

    const big = "9007199254740999";
    const s2 = selectObiPdfs(
      [rec("9007199254740995", T - 5000), rec("9007199254740993", T - 5000), rec("10", T - 6000), rec("9", T - 5000)],
      { messageId: big, timestamp: T }
    );
    ok("時刻の古い順・同じ時刻は id を数として小さい順（安全な整数を超えても）", s2.kind === "ok" && s2.pdfs.map((p) => p.messageId).join() === "10,9,9007199254740993,9007199254740995", JSON.stringify(s2));

    const many = (n: number) => Array.from({ length: n }, (_, i) => rec(String(i + 1), T - 1000));
    const s20 = selectObiPdfs(many(20), req);
    ok("20件は全部使う", s20.kind === "ok" && s20.pdfs.length === 20);
    const s21 = selectObiPdfs(many(21), req);
    ok("21件以上は1件も使わない", s21.kind === "too-many" && s21.count === 21);

    const s3 = selectObiPdfs([rec("1", T - 1, "a.pdf", 12_500_000), rec("2", T - 1, "b.pdf", 12_500_000)], req);
    ok("合計 25,000,000 バイトちょうどは使う", s3.kind === "ok");
    const s4 = selectObiPdfs([rec("1", T - 1, "a.pdf", 12_500_000), rec("2", T - 1, "b.pdf", 12_500_001)], req);
    ok("合計が上限を超えたら使わない", s4.kind === "too-large" && s4.totalBytes === 25_000_001);

    ok("同じ message.id が2つあっても1つ", (() => { const x = selectObiPdfs([rec("1", T - 1), rec("1", T - 1)], req); return x.kind === "ok" && x.pdfs.length === 1; })());
    ok("無ければ none", selectObiPdfs([], req).kind === "none");
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
