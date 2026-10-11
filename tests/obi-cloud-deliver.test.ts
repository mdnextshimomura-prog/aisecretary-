/**
 * クラウド配達の完成の段取り（約束 2026-10-11-obi-cloud-contract.md の「K4 の見回り」・設計 C2・C3・C11）。
 * portal・KV・LINE は偽物（tests/helpers/obi-cloud-fakes.ts）。
 */
import path from "node:path";
import { deliverNew } from "../src/lib/obi/cloud-deliver";
import type { CloudJobRow } from "../src/lib/obi/cloud-portal";
import {
  MEMO_SETTLE_MS,
  type CloudCheckpoint,
} from "../src/lib/obi/cloud-tick";
import {
  CLEAN_PROPERTY,
  COMPLETION,
  GROUP,
  KID,
  LIFF_ID,
  OTHER_GROUP,
  RAW_PROPERTY,
  TEST_PUBLIC_PEM,
  fakeWorld,
  haltedAt,
  sha,
  tokenOf,
  type FakeWorld,
} from "./helpers/obi-cloud-fakes";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const viewer = require(path.join(__dirname, "fixtures", "dtoken-viewer.cjs"));

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name}`);
};

const T = 10_000;
const NO = 12;
/** 完成の依頼が1件ある世界 */
function world(over: Record<string, unknown> = {}): FakeWorld {
  const w = fakeWorld();
  w.portal.add({ no: NO, status: "完成", property: RAW_PROPERTY, ...over });
  return w;
}
/** その回の一覧の行（deliverNew に渡す） */
async function rowOf(w: FakeWorld, no = NO): Promise<CloudJobRow> {
  const l = await w.portal.listJobs({ status: "完成" }, T);
  if (l.kind !== "ok") throw new Error("list");
  const row = l.value.jobs.find((j) => j.no === no);
  if (!row) throw new Error("row");
  w.portal.calls.length = 0;
  w.journal.length = 0;
  return row;
}
const ops = (w: FakeWorld) => w.portal.calls.map((c) => c.op).join();
const stage = (w: FakeWorld, no = NO) => w.store.rawJob(no)?.stage ?? null;
const retry = (w: FakeWorld, no = NO) =>
  w.store.dump().keys[`obi-cloud:retry:${no}:${sha(`artifact-${no}`)}`] as
    { count: number } | undefined;
const lastResult = (w: FakeWorld) => {
  const c = w.portal.callsOf("reportDeliveryResult");
  return c.length ? (c[c.length - 1].args as Record<string, unknown>) : null;
};
const hasLog = (w: FakeWorld, s: string) => w.logs.includes(`cloud-tick ${s}`);

async function main() {
  // ---- 偽物そのものの確かめ
  {
    const w = world();
    const [a, b] = await Promise.all([
      w.portal.claimDelivery(NO, T),
      w.portal.claimDelivery(NO, T),
    ]);
    ok(
      "偽物：予約が2つ同時に来ても片方だけ",
      [a.kind, b.kind].sort().join() === "ok,rejected",
    );
    const claim = a.kind === "ok" ? a : b;
    if (claim.kind !== "ok") throw new Error("claim");
    const other = "00000000-0000-4000-8000-000000000000";
    const bad = await w.portal.reportDeliveryResult(
      NO,
      { claimId: other, outcome: "delivered" },
      T,
    );
    ok(
      "偽物：違う claimId は 409",
      bad.kind === "rejected" && bad.status === 409,
    );
    const ns = await w.portal.reportDeliveryResult(
      NO,
      { claimId: claim.value.claimId, outcome: "not_sent", reason: "config" },
      T,
    );
    ok(
      "偽物：not_sent で完成に戻る",
      ns.kind === "ok" && w.portal.job(NO).status === "完成",
    );
    const again = await w.portal.reportDeliveryResult(
      NO,
      { claimId: claim.value.claimId, outcome: "not_sent", reason: "config" },
      T,
    );
    ok("偽物：同じ結果の再送は 200", again.kind === "ok");
    const c2 = await w.portal.claimDelivery(NO, T);
    if (c2.kind !== "ok") throw new Error("claim2");
    const at1 = await w.portal.attemptDelivery(NO, c2.value.claimId, T);
    const at2 = await w.portal.attemptDelivery(NO, c2.value.claimId, T);
    const at3 = await w.portal.attemptDelivery(NO, claim.value.claimId, T);
    ok(
      "偽物：attempt は同じ claimId に冪等・古い claimId は CLAIM_MISMATCH",
      at1.kind === "ok" &&
        at2.kind === "ok" &&
        at3.kind === "rejected" &&
        at3.code === "CLAIM_MISMATCH",
    );
    let threw = false;
    try {
      w.portal.returnToDone(NO);
    } catch {
      threw = true;
    }
    ok(
      "偽物：attempt の通った期限内の納品中は、完成へ戻せない",
      threw && w.portal.job(NO).status === "納品中",
    );
  }

  ok("MEMO_SETTLE_MS は 70,000", MEMO_SETTLE_MS === 70_000);
  ok(
    "MEMO_SETTLE_MS：関数の上限（60秒）より長く、錠の期限（90秒）より短い",
    60_000 < MEMO_SETTLE_MS && MEMO_SETTLE_MS < 90_000,
  );

  // ---- ふつうの完成
  {
    const w = world({ reviewPages: 2 });
    const ctx = w.ctx();
    await deliverNew(await rowOf(w), ctx);
    ok(
      "ふつう：portal は 予約 → attempt → id の報告 → 結果 の順",
      ops(w) ===
        "claimDelivery,attemptDelivery,reportDeliveryMessage,reportDeliveryResult",
      ops(w),
    );
    ok("ふつう：push は1回", w.line.texts.length === 1);
    const lines = w.line.texts[0].split("\n");
    ok(
      "ふつう：1行目に整えた物件名",
      lines[0] === `#J12 帯替えが完成しました（${CLEAN_PROPERTY}）`,
      lines[0],
    );
    ok(
      "ふつう：要確認の行",
      lines[1] === "⚠ 要確認 2ページ（使う前に中身を確認してください）",
    );
    ok(
      "ふつう：リンクの形",
      lines[2].startsWith(`https://liff.line.me/${LIFF_ID}?t=`) &&
        lines[3] === "（このグループの方が開けます・24時間有効）" &&
        lines.length === 4,
    );
    const v = viewer.verify(tokenOf(w.line.texts[0]), {
      publicKeys: { [KID]: TEST_PUBLIC_PEM },
      now: w.clock.now(),
    });
    ok(
      "ふつう：トークンが閲覧ページの verify を通る",
      v.ok === true,
      String(v.reason),
    );
    ok(
      "ふつう：f・h・g",
      v.ok &&
        v.payload.f === "portal:job-12" &&
        v.payload.h === sha("artifact-12") &&
        v.payload.g === GROUP &&
        v.payload.aud === "line-group",
    );
    ok("ふつう：依頼は納品済み", w.portal.job(NO).status === "納品済み");
    const res = lastResult(w)!;
    ok(
      "ふつう：結果は delivered（reason が無い）",
      res.outcome === "delivered" &&
        !("reason" in res) &&
        !("driveFileId" in res) &&
        !("legacy" in res),
    );
    const msg = w.portal.callsOf("reportDeliveryMessage")[0].args as Record<
      string,
      unknown
    >;
    ok(
      "ふつう：id の報告の中身",
      msg.groupId === GROUP &&
        msg.artifactSha256 === sha("artifact-12") &&
        msg.messageId === w.line.ids[0] &&
        !("kind" in msg),
    );
    ok(
      "ふつう：attempt に渡すのは予約の番号",
      (w.portal.callsOf("attemptDelivery")[0].args as { claimId: string })
        .claimId === w.portal.issuedClaimIds[0],
    );
    ok(
      "ふつう：控えが消えている・目次も空",
      w.store.rawJob(NO) === null &&
        (w.store.dump().sets["obi-cloud:jobs"] ?? []).length === 0,
    );
    ok("ふつう：待ち時間の鍵が無い", retry(w) === undefined);
    ok(
      "ふつう：件数とログ",
      ctx.counts.delivered === 1 &&
        ctx.counts.notSent === 0 &&
        ctx.counts.unknown === 0 &&
        hasLog(w, "#J12 delivered"),
    );
    ok(
      "ふつう：本文に生の物件名・予約の応答の物件名が無い",
      !w.line.texts[0].includes("evil") &&
        !w.line.texts[0].includes("使わない"),
    );

    // 段の順番
    const j = w.journal
      .filter((e) => /^(store:putJob|portal:attemptDelivery|line:push)/.test(e))
      .join(" > ");
    ok(
      "段の順番：prepared → attempt-requested → attempt(200) → attempting → push → sent",
      j ===
        "store:putJob:12:prepared > store:putJob:12:attempt-requested > portal:attemptDelivery:12:ok > store:putJob:12:attempting > line:push > store:putJob:12:sent",
      j,
    );
  }

  // ---- 番号の案内・直しの回
  {
    const w = world();
    await deliverNew(await rowOf(w), w.ctx({ fixGuide: true }));
    ok(
      "番号の案内：on のとき末尾に付く",
      w.line.texts[0].split("\n").length === 5 &&
        w.line.texts[0].includes("問題なければ"),
    );
    const w2 = world();
    await deliverNew(await rowOf(w2), w2.ctx({ fixGuide: false }));
    ok(
      "番号の案内：off のとき付かない",
      !w2.line.texts[0].includes("問題なければ"),
    );
    const w3 = world({
      fix: {
        round: 1,
        code: 1,
        page: 3,
        turn: "",
        by: "auto",
        source: "line-group",
      },
    });
    w3.haltAt("completion-attempting");
    await haltedAt(deliverNew(await rowOf(w3), w3.ctx()));
    const facts = w3.store.rawJob(NO)!.facts as Record<string, unknown>;
    ok(
      "直しの回：控えの facts.property には整えた物件名が入っている",
      facts.property === CLEAN_PROPERTY,
    );
    const w4 = world({
      fix: {
        round: 1,
        code: 1,
        page: 3,
        turn: "",
        by: "auto",
        source: "line-group",
      },
    });
    await deliverNew(await rowOf(w4), w4.ctx());
    ok(
      "直しの回：文に物件名が出ない",
      w4.line.texts[0].split("\n")[0] ===
        "#J12 を直しました（3ページ・帯の位置）",
    );
  }

  // ---- attempt が通らなければ push しない
  {
    const w = world();
    const ctx = w.ctx();
    w.portal.failNext("attemptDelivery", {
      kind: "rejected",
      status: 409,
      code: "CLAIM_MISMATCH",
    });
    await deliverNew(await rowOf(w), ctx);
    ok(
      "attempt：CLAIM_MISMATCH → push 0回・控えが消える・結果の報告なし・待ち時間を数えない",
      w.line.texts.length === 0 &&
        w.store.rawJob(NO) === null &&
        w.portal.callsOf("reportDeliveryResult").length === 0 &&
        retry(w) === undefined &&
        hasLog(w, "#J12 memo-stale CLAIM_MISMATCH"),
    );
    const keep: Array<
      [string, Parameters<FakeWorld["portal"]["failNext"]>[1]]
    > = [
      [
        "WRITE_CONFLICT",
        { kind: "rejected", status: 409, code: "WRITE_CONFLICT" },
      ],
      ["500", { kind: "unknown", reason: "http-5xx" }],
      ["時間切れ", { kind: "unknown", reason: "timeout" }],
      ["401", { kind: "rejected", status: 401, code: "UNAUTHORIZED" }],
      ["形の違う応答", { kind: "unknown", reason: "invalid-body" }],
    ];
    for (const [label, canned] of keep) {
      const k = world();
      const kctx = k.ctx();
      k.portal.failNext("attemptDelivery", canned);
      await deliverNew(await rowOf(k), kctx);
      ok(
        `attempt：${label} → push 0回・控えは attempt-requested のまま・結果の報告なし`,
        k.line.texts.length === 0 &&
          stage(k) === "attempt-requested" &&
          k.portal.callsOf("reportDeliveryResult").length === 0 &&
          k.portal.job(NO).status === "納品中",
        String(stage(k)),
      );
      if (label === "401")
        ok(
          "attempt：401 → その回の portal の仕事を打ち切る",
          kctx.state.portalStopped === true,
        );
      else
        ok(
          `attempt：${label} → 打ち切らない`,
          kctx.state.portalStopped === false,
        );
    }
    for (const [status, code] of [
      [404, "NOT_FOUND"],
      [400, "INVALID_REQUEST"],
      [403, "HTTP_403"],
    ] as const) {
      const d = world();
      const dctx = d.ctx();
      d.portal.failNext("attemptDelivery", { kind: "rejected", status, code });
      await deliverNew(await rowOf(d), dctx);
      ok(
        `attempt：${status} → push 0回・控えが消える・結果の報告なし`,
        d.line.texts.length === 0 &&
          d.store.rawJob(NO) === null &&
          d.portal.callsOf("reportDeliveryResult").length === 0 &&
          hasLog(d, `#J12 memo-stale ${code}`),
      );
      ok(
        `attempt：${status} → 打ち切り${status === 403 ? "る" : "らない"}`,
        dctx.state.portalStopped === (status === 403),
      );
    }
    const m = world();
    m.portal.failNext("attemptDelivery", {
      kind: "rejected",
      status: 409,
      code: "CLAIM_MISMATCH",
    });
    const row = await rowOf(m);
    m.store.failOn("delJob");
    await deliverNew(row, m.ctx());
    ok(
      "attempt：CLAIM_MISMATCH で控えを消せない → push 0回・報告なし・memo-del-failed",
      m.line.texts.length === 0 &&
        m.portal.callsOf("reportDeliveryResult").length === 0 &&
        hasLog(m, "#J12 memo-del-failed") &&
        stage(m) === "attempt-requested",
    );
  }
  {
    // attempt は通ったが、控え attempting が書けない
    const w = world();
    const row = await rowOf(w);
    let puts = 0;
    const orig = w.store.putJob;
    w.store.putJob = async (no, memo) => {
      puts += 1;
      if (memo.stage === "attempting") throw new Error("kv down");
      return orig(no, memo);
    };
    await deliverNew(row, w.ctx());
    ok(
      "attempting が書けない → push 0回・控えは attempt-requested のまま・not_sent にしない",
      w.line.texts.length === 0 &&
        stage(w) === "attempt-requested" &&
        w.portal.callsOf("reportDeliveryResult").length === 0 &&
        puts === 3 &&
        hasLog(w, "#J12 memo-save-failed"),
    );
  }

  // ---- 返し先・予約
  for (const [label, over] of [
    ["別のグループ", { replyGroupId: OTHER_GROUP }],
    ["秘書室あて", { replyKind: "secretary", replyGroupId: null }],
  ] as const) {
    const w = world(over);
    const ctx = w.ctx();
    await deliverNew(await rowOf(w), ctx);
    const res = lastResult(w);
    ok(
      `返し先が違う（${label}）→ push 0回・not_sent・target・完成に戻る`,
      w.line.texts.length === 0 &&
        res?.outcome === "not_sent" &&
        res.reason === "target" &&
        w.portal.job(NO).status === "完成" &&
        ctx.counts.notSent === 1,
    );
    ok(
      `返し先が違う（${label}）→ 待ち時間が1回・控えなし`,
      retry(w)?.count === 1 &&
        w.store.rawJob(NO) === null &&
        hasLog(w, "#J12 not-sent target"),
    );
  }
  {
    const w = world();
    const row = await rowOf(w);
    await w.portal.claimDelivery(NO, T); // Mac が先に取った
    w.portal.calls.length = 0;
    await deliverNew(row, w.ctx());
    ok(
      "予約が断られる → push 0回・控えなし・claim-skip",
      w.line.texts.length === 0 &&
        w.store.rawJob(NO) === null &&
        hasLog(w, "#J12 claim-skip DELIVERY_IN_PROGRESS") &&
        ops(w) === "claimDelivery",
    );
  }
  {
    const w = world();
    const row = await rowOf(w);
    w.portal.failNext("claimDelivery", {
      kind: "unknown",
      reason: "timeout",
      applied: true,
    });
    await deliverNew(row, w.ctx());
    ok(
      "予約の答えが分からない → push 0回・控えなし・結果の報告もしない",
      w.line.texts.length === 0 &&
        w.store.rawJob(NO) === null &&
        ops(w) === "claimDelivery" &&
        w.portal.job(NO).status === "納品中" &&
        hasLog(w, "#J12 claim-unknown timeout"),
    );
  }
  {
    const w = world();
    const row = await rowOf(w);
    w.portal.failNext("claimDelivery", {
      kind: "rejected",
      status: 401,
      code: "UNAUTHORIZED",
    });
    const ctx = w.ctx();
    await deliverNew(row, ctx);
    ok(
      "予約が 401 → 打ち切る",
      ctx.state.portalStopped && w.line.texts.length === 0,
    );
  }
  {
    const w = world();
    w.portal.legacyClaim();
    const ctx = w.ctx();
    await deliverNew(await rowOf(w), ctx);
    const res = lastResult(w)!;
    ok(
      "古い portal（via が空）→ push 0回・not_sent（legacy＝via・reason なし）",
      w.line.texts.length === 0 &&
        res.outcome === "not_sent" &&
        res.legacy === true &&
        !("reason" in res) &&
        w.portal.job(NO).status === "完成",
    );
    ok(
      "古い portal → 待ち時間が数えられる・控えなし",
      retry(w)?.count === 1 &&
        w.store.rawJob(NO) === null &&
        hasLog(w, "#J12 claim-not-cloud"),
    );
  }

  // ---- 控えが書けない
  {
    const w = world();
    const row = await rowOf(w);
    w.store.failOn("putJob", 1);
    await deliverNew(row, w.ctx());
    const res = lastResult(w);
    ok(
      "prepared が書けない → push 0回・not_sent・config",
      w.line.texts.length === 0 &&
        res?.outcome === "not_sent" &&
        res.reason === "config" &&
        w.portal.job(NO).status === "完成" &&
        w.portal.callsOf("attemptDelivery").length === 0,
    );
  }
  {
    const w = world();
    const row = await rowOf(w);
    w.store.failOn("putJob");
    w.store.failOn("delJob");
    await deliverNew(row, w.ctx());
    ok(
      "prepared が書けず、消すこともできない → push 0回・結果の報告もしない・納品中のまま",
      w.line.texts.length === 0 &&
        w.portal.callsOf("reportDeliveryResult").length === 0 &&
        w.portal.job(NO).status === "納品中" &&
        hasLog(w, "#J12 memo-del-failed"),
    );
  }
  {
    const w = world();
    await deliverNew(
      await rowOf(w),
      w.ctx({ completion: { ...COMPLETION, kid: "mac-2026-10" } }),
    );
    const res = lastResult(w);
    ok(
      "トークンが作れない → push 0回・not_sent・config",
      w.line.texts.length === 0 &&
        res?.outcome === "not_sent" &&
        res.reason === "config" &&
        w.store.rawJob(NO) === null &&
        w.portal.callsOf("attemptDelivery").length === 0,
    );
  }
  {
    const w = world();
    const row = await rowOf(w);
    const orig = w.store.putJob;
    w.store.putJob = async (no, memo) => {
      if (memo.stage === "attempt-requested") throw new Error("kv down");
      return orig(no, memo);
    };
    await deliverNew(row, w.ctx());
    const res = lastResult(w);
    ok(
      "attempt-requested が書けない → push 0回・attempt を呼ばない・not_sent・config",
      w.line.texts.length === 0 &&
        w.portal.callsOf("attemptDelivery").length === 0 &&
        res?.outcome === "not_sent" &&
        res.reason === "config",
    );
  }

  // ---- push の結果
  {
    const w = world();
    w.line.next("rejected");
    const ctx = w.ctx();
    await deliverNew(await rowOf(w), ctx);
    const res = lastResult(w)!;
    ok(
      "push が 4xx → not_sent・push-rejected・完成・待ち時間 1・控えなし",
      res.outcome === "not_sent" &&
        res.reason === "push-rejected" &&
        w.portal.job(NO).status === "完成" &&
        retry(w)?.count === 1 &&
        w.store.rawJob(NO) === null &&
        ctx.counts.notSent === 1,
    );
  }
  for (const kind of ["unknown", "throw"] as const) {
    const w = world();
    // 前の not_sent の数え（数え直されることを見る）
    await w.store.bumpRetry(
      NO,
      sha("artifact-12"),
      new Date(w.clock.now() - 2 * 3_600_000).toISOString(),
    );
    w.line.next(kind);
    const ctx = w.ctx();
    await deliverNew(await rowOf(w), ctx);
    const res = lastResult(w)!;
    ok(
      `push が${kind === "throw" ? "投げる" : "分からない"} → unknown・push-unknown・納品要確認・push は1回`,
      res.outcome === "unknown" &&
        res.reason === "push-unknown" &&
        w.portal.job(NO).status === "納品要確認" &&
        w.line.texts.length === 1 &&
        ctx.counts.unknown === 1,
    );
    ok(
      `push が${kind === "throw" ? "投げる" : "分からない"} → 待ち時間の鍵が消える・控えなし`,
      retry(w) === undefined &&
        w.store.rawJob(NO) === null &&
        hasLog(w, "#J12 unknown push-unknown"),
    );
  }
  {
    const w = world();
    w.line.next("unknown");
    w.portal.failNext("reportDeliveryResult", {
      kind: "unknown",
      reason: "network",
    });
    const ctx = w.ctx();
    await deliverNew(await rowOf(w), ctx);
    ok(
      "push が分からない＋結果の報告も届かない → 控えは attempting のまま",
      stage(w) === "attempting" &&
        ctx.counts.unknown === 0 &&
        w.portal.job(NO).status === "納品中",
    );
  }

  // ---- 送れた後
  {
    const w = world();
    w.portal.failNext("reportDeliveryMessage", {
      kind: "unknown",
      reason: "timeout",
    });
    await deliverNew(await rowOf(w), w.ctx());
    const memo = w.store.rawJob(NO)!;
    ok(
      "送れたが id を記録できない → この回は結果を報告しない・控えは sent・msgTries 1",
      w.portal.callsOf("reportDeliveryResult").length === 0 &&
        memo.stage === "sent" &&
        memo.msgTries === 1 &&
        memo.messageId === w.line.ids[0] &&
        hasLog(w, "#J12 message-report-retry"),
    );
  }
  {
    const w = world();
    w.line.next("no-id");
    await deliverNew(await rowOf(w), w.ctx());
    ok(
      "送れたが id が無い → id の報告を呼ばず、結果へ進む",
      w.portal.callsOf("reportDeliveryMessage").length === 0 &&
        w.portal.job(NO).status === "納品済み",
    );
  }
  {
    const w = world();
    const row = await rowOf(w);
    const orig = w.store.putJob;
    w.store.putJob = async (no, memo) => {
      if (memo.stage === "sent") throw new Error("kv down");
      return orig(no, memo);
    };
    w.portal.failNext("reportDeliveryMessage", {
      kind: "unknown",
      reason: "timeout",
    });
    await deliverNew(row, w.ctx());
    ok(
      "送れた・控え sent が書けない・id の報告が失敗 → 待たずに結果の報告へ進む",
      w.portal.job(NO).status === "納品済み" &&
        hasLog(w, "#J12 message-report-gave-up"),
    );
  }
  {
    const w = world();
    w.portal.failNext("reportDeliveryResult", {
      kind: "unknown",
      reason: "timeout",
    });
    const ctx = w.ctx();
    await deliverNew(await rowOf(w), ctx);
    ok(
      "送れたが結果の報告が届かない → 控えは sent のまま・納品中",
      stage(w) === "sent" &&
        w.portal.job(NO).status === "納品中" &&
        ctx.counts.delivered === 0 &&
        hasLog(w, "#J12 result-unknown"),
    );
  }
  {
    const w = world();
    w.portal.failNext("reportDeliveryResult", {
      kind: "rejected",
      status: 400,
      code: "INVALID_REQUEST",
    });
    await deliverNew(await rowOf(w), w.ctx());
    ok(
      "送れたが結果の報告を断られる（400）→ 控えを消す・result-rejected",
      w.store.rawJob(NO) === null &&
        hasLog(w, "#J12 result-rejected INVALID_REQUEST"),
    );
  }
  {
    const w = world();
    w.portal.failNext("reportDeliveryResult", {
      kind: "rejected",
      status: 401,
      code: "UNAUTHORIZED",
    });
    const ctx = w.ctx();
    await deliverNew(await rowOf(w), ctx);
    ok(
      "送れたが結果の報告が 401 → 控えは sent のまま（鍵が直れば次の回に報告できる）・打ち切る",
      stage(w) === "sent" && ctx.state.portalStopped,
    );
  }

  // ---- 時間
  {
    const w = world();
    const row = await rowOf(w);
    const ctx = w.ctx();
    w.clock.advance(40_001);
    await deliverNew(row, ctx);
    ok(
      "40秒を過ぎている → push 0回・控えは prepared のまま・attempt を呼ばない",
      w.line.texts.length === 0 &&
        stage(w) === "prepared" &&
        w.portal.callsOf("attemptDelivery").length === 0 &&
        hasLog(w, "#J12 deferred"),
    );
  }

  // ---- 差し込み口（完成の7つ）
  const points: Array<[CloudCheckpoint, string | null, number, number]> = [
    ["completion-claimed", null, 0, 0],
    ["completion-prepared", "prepared", 0, 0],
    ["completion-attempt-requested", "attempt-requested", 0, 0],
    ["completion-attempting", "attempting", 0, 1],
    ["completion-pushed", "attempting", 1, 1],
    ["completion-sent-saved", "sent", 1, 1],
    ["completion-before-result", "sent", 1, 1],
  ];
  for (const [point, wantStage, pushes, attempts] of points) {
    const w = world();
    const row = await rowOf(w);
    w.haltAt(point);
    const at = await haltedAt(deliverNew(row, w.ctx()));
    ok(
      `差し込み口 ${point}：控え ${wantStage}・push ${pushes}回・attempt ${attempts}回`,
      at === point &&
        stage(w) === wantStage &&
        w.line.texts.length === pushes &&
        w.portal.callsOf("attemptDelivery").length === attempts &&
        w.portal.callsOf("reportDeliveryResult").length === 0,
      `${at} ${stage(w)} ${w.line.texts.length}`,
    );
  }

  // ---- 控えの中身
  {
    const w = world({ reviewPages: 1, outsideErased: 2, outsidePages: [1] });
    const row = await rowOf(w);
    w.haltAt("completion-sent-saved");
    await haltedAt(deliverNew(row, w.ctx()));
    const dump = w.store.dump();
    const memo = dump.keys["obi-cloud:job:12"] as Record<string, unknown>;
    const facts = memo.facts as Record<string, unknown>;
    ok(
      "控え：facts はちょうど5項目",
      Object.keys(facts).sort().join() ===
        "fix,outsideErased,outsidePages,property,reviewPages",
    );
    ok(
      "控え：facts の値は予約の応答から",
      facts.reviewPages === 1 &&
        facts.outsideErased === 2 &&
        JSON.stringify(facts.outsidePages) === "[1]" &&
        facts.fix === null &&
        facts.property === CLEAN_PROPERTY,
    );
    ok(
      "控え：leaseUntil は予約の応答の値",
      memo.leaseUntil ===
        new Date(w.portal.job(NO).claim!.leaseUntil).toISOString(),
    );
    ok(
      "控え：項目の名前",
      Object.keys(memo).sort().join() ===
        "at,claimId,facts,leaseUntil,messageId,msgTries,sha256,stage,v",
    );
    const all = JSON.stringify(dump);
    const { property: _p, ...rest } = facts;
    void _p;
    ok(
      "控え：整えた物件名は facts.property にだけある",
      JSON.stringify({ ...memo, facts: rest }).indexOf(CLEAN_PROPERTY) === -1,
    );
    ok(
      "控え：生の物件名・リンク・トークン・グループの ID が無い",
      !all.includes("evil") &&
        !all.includes("liff.line.me") &&
        !all.includes(tokenOf(w.line.texts[0])) &&
        !all.includes(GROUP) &&
        !all.includes(w.line.texts[0].split("\n")[1]),
    );
    ok(
      "控え：あるあいだ、目次に番号がある",
      JSON.stringify(dump.sets["obi-cloud:jobs"]) === '["12"]',
    );
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error("テストが例外で止まった:", e);
  process.exit(1);
});
