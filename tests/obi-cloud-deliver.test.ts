/**
 * クラウド配達の完成の段取り（約束 2026-10-11-obi-cloud-contract.md の「K4 の見回り」・設計 C2・C3・C11）。
 * portal・KV・LINE は偽物（tests/helpers/obi-cloud-fakes.ts）。
 */
import path from "node:path";
import { deliverNew, runCompletion } from "../src/lib/obi/cloud-deliver";
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
  withoutToken,
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
      lines[2] === "" && // リンクの前に空行
        lines[3].startsWith(`https://liff.line.me/${LIFF_ID}?t=`) &&
        lines[4] === "（このグループの方が開けます・24時間有効）" &&
        lines.length === 5,
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
      w.line.texts[0].split("\n").length === 16 &&
        w.line.texts[0].includes(
          "（このグループの方が開けます・24時間有効）\n\n▼ 確認したら番号で返信してください\n（帯替えを依頼できる方から）\n0 問題なし\n",
        ) &&
        w.line.texts[0].endsWith(
          "このメッセージを長押し →「リプライ」で送ってください",
        ),
    );
    const w2 = world();
    await deliverNew(await rowOf(w2), w2.ctx({ fixGuide: false }));
    ok(
      "番号の案内：off のとき付かない",
      !w2.line.texts[0].includes("▼") && w2.line.texts[0].split("\n").length === 4,
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

  // ================================================================ Task 8：残っている控えの片付け・再開・予約し直さない時間
  const run = async (w: FakeWorld, over: Parameters<FakeWorld["ctx"]>[0] = {}) => {
    const ctx = w.ctx(over);
    await runCompletion(ctx);
    return ctx;
  };
  /** その差し込み口で1回止めた世界（止めた後、差し込み口は外してある） */
  const haltedWorld = async (point: CloudCheckpoint, over: Record<string, unknown> = {}) => {
    const w = world(over);
    w.haltAt(point);
    const at = await haltedAt(runCompletion(w.ctx()));
    if (at !== point) throw new Error(`止まらなかった: ${point}`);
    w.haltAt(null);
    return w;
  };
  const MIN = 60_000;
  const count = (w: FakeWorld, op: Parameters<FakeWorld["portal"]["callsOf"]>[0]) => w.portal.callsOf(op).length;
  const FACT_JOB = { reviewPages: 2, outsideErased: 1, outsidePages: [3] };

  // ---- prepared で止まった → attempt を通してから再開
  {
    const control = world(FACT_JOB);
    await run(control);
    const w = await haltedWorld("completion-prepared", FACT_JOB);
    ok("再開（prepared）：止まった回は push 0・attempt 0", w.line.texts.length === 0 && count(w, "attemptDelivery") === 0);
    w.clock.advance(2 * MIN);
    w.journal.length = 0;
    const ctx = await run(w);
    const j = w.journal.filter((e) => /^(portal:attemptDelivery|line:push)/.test(e)).join(" > ");
    ok("再開（prepared）：attempt が1回あり、push より前", j === "portal:attemptDelivery:12:ok > line:push", j);
    ok("再開（prepared）：attempt に渡すのは控えの claimId", (w.portal.callsOf("attemptDelivery")[0].args as { claimId: string }).claimId === w.portal.issuedClaimIds[0]);
    ok("再開（prepared）：push は合計1回・納品済み", w.line.texts.length === 1 && w.portal.job(NO).status === "納品済み" && ctx.counts.delivered === 1);
    ok("再開（prepared）：文は、止まらなかった回と同じ（トークンの所を除く）", withoutToken(w.line.texts[0]) === withoutToken(control.line.texts[0]), w.line.texts[0]);
    const lines = w.line.texts[0].split("\n");
    ok("再開（prepared）：1行目は整えた物件名・要確認と帯の外の行は控えの facts から", lines[0] === `#J12 帯替えが完成しました（${CLEAN_PROPERTY}）` && lines[1].startsWith("⚠ 要確認 2ページ") && lines[2].startsWith("帯の外の他社の文字を1か所消しました（3ページ）"));
    const v = viewer.verify(tokenOf(w.line.texts[0]), { publicKeys: { [KID]: TEST_PUBLIC_PEM }, now: w.clock.now() });
    ok("再開（prepared）：トークンは再開の回に作っている", v.ok === true && v.payload.i === Math.floor(w.clock.now() / 1000));
    ok("再開（prepared）：完成の一覧より前に再開している", w.journal.findIndex((e) => e === "line:push") < w.journal.findIndex((e) => e.startsWith("portal:listJobs")));
  }
  // ---- attempt-requested で止まった → 結果不明にせず、attempt をやり直す
  {
    const w = await haltedWorld("completion-attempt-requested");
    ok("再開（attempt-requested）：止まった回は attempt 0", count(w, "attemptDelivery") === 0 && stage(w) === "attempt-requested");
    w.clock.advance(2 * MIN);
    const ctx = await run(w);
    ok("再開（attempt-requested）：attempt 1回・push 合計1回・納品済み（unknown にならない）", count(w, "attemptDelivery") === 1 && w.line.texts.length === 1 && w.portal.job(NO).status === "納品済み" && ctx.counts.unknown === 0);
  }
  {
    const w = world();
    w.portal.failNext("attemptDelivery", { kind: "unknown", reason: "timeout", applied: true });
    await run(w);
    ok("attempt は通ったが答えが届かない → push 0回・控えは attempt-requested・結果の報告なし", w.line.texts.length === 0 && stage(w) === "attempt-requested" && count(w, "reportDeliveryResult") === 0 && w.portal.job(NO).claim?.attemptAt !== null);
    w.clock.advance(2 * MIN);
    const ctx = await run(w);
    ok("…次の回に attempt をやり直して、push は合計1回・納品済み（interrupted にならない）", w.line.texts.length === 1 && w.portal.job(NO).status === "納品済み" && ctx.counts.unknown === 0 && count(w, "attemptDelivery") === 2);
  }
  {
    const w = await haltedWorld("completion-prepared");
    w.clock.advance(2 * MIN);
    w.portal.failNext("listJobs", { kind: "unknown", reason: "http-5xx" });
    await run(w);
    ok("再開は、完成の一覧が取れない回でも進む", w.line.texts.length === 1 && w.portal.job(NO).status === "納品済み");
  }
  for (const point of ["completion-prepared", "completion-attempt-requested", "completion-attempting"] as const) {
    const w = await haltedWorld(point);
    w.clock.advance(60_000);
    w.portal.calls.length = 0;
    await run(w);
    ok(`70秒未満（${point}）→ 触らない・push 0回・attempt も結果も呼ばない`, w.line.texts.length === 0 && count(w, "attemptDelivery") === 0 && count(w, "reportDeliveryResult") === 0 && w.store.rawJob(NO) !== null);
  }
  for (const point of ["completion-prepared", "completion-attempt-requested"] as const) {
    const w = await haltedWorld(point);
    if (point === "completion-attempt-requested") await w.portal.attemptDelivery(NO, w.portal.issuedClaimIds[0], T); // portal の側は attempt が通っていた
    w.clock.advance(41 * MIN);
    w.portal.calls.length = 0;
    const ctx = await run(w);
    const res = lastResult(w);
    ok(`期限まで5分を切っている（${point}）→ push 0回・not_sent・config・完成・待ち時間`, w.line.texts.length === 0 && res?.outcome === "not_sent" && res.reason === "config" && w.portal.job(NO).status === "完成" && retry(w)?.count === 1 && count(w, "attemptDelivery") === 0 && ctx.counts.notSent === 1);
    ok(`期限まで5分を切っている（${point}）→ 同じ回には取り直さない`, count(w, "claimDelivery") === 0);
  }
  {
    const w = await haltedWorld("completion-prepared");
    w.clock.advance(2 * MIN);
    const ctx = await run(w, { completion: null });
    const res = lastResult(w);
    ok("prepared の控えがあり、完成の設定が無い → push 0回・not_sent・config", w.line.texts.length === 0 && res?.outcome === "not_sent" && res.reason === "config" && ctx.counts.notSent === 1);
  }
  // ---- attempt が届かない
  {
    const cases: Array<[string, Parameters<FakeWorld["portal"]["failNext"]>[1]]> = [
      ["時間切れ", { kind: "unknown", reason: "timeout" }],
      ["5xx", { kind: "unknown", reason: "http-5xx" }],
      ["形の違う応答", { kind: "unknown", reason: "invalid-body" }],
      ["401", { kind: "rejected", status: 401, code: "UNAUTHORIZED" }],
      ["WRITE_CONFLICT", { kind: "rejected", status: 409, code: "WRITE_CONFLICT" }],
    ];
    for (const [label, canned] of cases) {
      const w = await haltedWorld("completion-prepared");
      w.clock.advance(2 * MIN);
      w.portal.failNext("attemptDelivery", canned);
      await run(w);
      ok(`再開で attempt が届かない（${label}）→ push 0回・控えは attempt-requested・結果の報告なし`, w.line.texts.length === 0 && stage(w) === "attempt-requested" && count(w, "reportDeliveryResult") === 0);
      w.clock.advance(2 * MIN);
      await run(w);
      ok(`…次の回に attempt が通れば、1通だけ（${label}）`, w.line.texts.length === 1 && w.portal.job(NO).status === "納品済み");
    }
    const w = await haltedWorld("completion-prepared");
    for (let i = 0; i < 20; i++) {
      w.clock.advance(2 * MIN);
      w.portal.failNext("attemptDelivery", { kind: "unknown", reason: "timeout" });
      await run(w);
    }
    ok("届かない回が続く（40分）→ まだ控えは attempt-requested・push 0回", stage(w) === "attempt-requested" && w.line.texts.length === 0 && count(w, "reportDeliveryResult") === 0);
    // 控えは直前の回に書き直している（70秒たつまで触らない）ので、次に見るのは2分後
    w.clock.advance(2 * MIN);
    await run(w);
    ok("…期限まで5分を切ったら not_sent・config", lastResult(w)?.outcome === "not_sent" && lastResult(w)?.reason === "config" && w.portal.job(NO).status === "完成" && w.line.texts.length === 0);
  }
  // ---- 競合
  {
    const w = await haltedWorld("completion-prepared");
    w.portal.takeOver(NO);
    const macClaim = { ...w.portal.job(NO).claim! };
    const events = w.portal.events.length;
    w.clock.advance(2 * MIN);
    w.portal.calls.length = 0;
    const ctx = await run(w);
    ok("【競合】attempt の前に Mac が取り直した → push 0回・控えを消すだけ・結果を呼ばない・待ち時間を数えない", w.line.texts.length === 0 && w.store.rawJob(NO) === null && count(w, "reportDeliveryResult") === 0 && retry(w) === undefined && hasLog(w, "#J12 memo-stale CLAIM_MISMATCH"));
    const after = w.portal.job(NO);
    ok("【競合】Mac の予約は何も変わらない", after.status === "納品中" && after.claim?.claimId === macClaim.claimId && after.claim.leaseUntil === macClaim.leaseUntil && after.claim.attemptAt === null && w.portal.events.length === events);
    ok("【競合】件数は増えない", ctx.counts.delivered === 0 && ctx.counts.notSent === 0 && ctx.counts.unknown === 0);
  }
  {
    const w = await haltedWorld("completion-attempting");
    let refused = false;
    try {
      w.portal.returnToDone(NO);
    } catch {
      refused = true;
    }
    w.clock.advance(2 * MIN);
    const ctx = await run(w);
    const res = lastResult(w);
    ok("【競合】attempt の後は完成へ戻せない → 次の回は push 0回・unknown・interrupted", refused && w.line.texts.length === 0 && res?.outcome === "unknown" && res.reason === "interrupted" && w.portal.job(NO).status === "納品要確認" && ctx.counts.unknown === 1);
  }
  {
    const w = await haltedWorld("completion-prepared");
    w.portal.returnToDone(NO);
    w.clock.advance(2 * MIN);
    await run(w);
    ok("人が完成へ戻しただけ → 古い控えでは送らず、同じ回に新しい予約で1回だけ配る", w.line.texts.length === 1 && w.portal.job(NO).status === "納品済み" && w.portal.issuedClaimIds.length === 2 && hasLog(w, "#J12 memo-stale CLAIM_MISMATCH"));
    ok("…attempt は2回（古い claimId は断られ、新しい claimId が通る）", count(w, "attemptDelivery") === 2 && (w.portal.callsOf("attemptDelivery")[1].args as { claimId: string }).claimId === w.portal.issuedClaimIds[1]);
  }
  for (const [status, code] of [[404, "NOT_FOUND"], [400, "INVALID_REQUEST"], [403, "HTTP_403"]] as const) {
    const w = await haltedWorld("completion-prepared");
    w.clock.advance(2 * MIN);
    w.portal.calls.length = 0;
    w.portal.failNext("attemptDelivery", { kind: "rejected", status, code });
    const ctx = await run(w);
    ok(`再開で attempt が ${status} → 控えを消すだけ・push 0回・結果の報告なし`, w.store.rawJob(NO) === null && w.line.texts.length === 0 && count(w, "reportDeliveryResult") === 0);
    ok(`再開で attempt が ${status} → ${status === 403 ? "その回の portal の仕事を打ち切る（一覧も呼ばない）" : "打ち切らない"}`, ctx.state.portalStopped === (status === 403) && (count(w, "listJobs") === 0) === (status === 403));
  }
  {
    const w = await haltedWorld("completion-prepared");
    w.portal.takeOver(NO);
    w.clock.advance(2 * MIN);
    w.store.failOn("delJob", 1);
    await run(w);
    ok("CLAIM_MISMATCH で控えを消せない → push 0回・報告なし・memo-del-failed", w.line.texts.length === 0 && count(w, "reportDeliveryResult") === 0 && hasLog(w, "#J12 memo-del-failed") && w.store.rawJob(NO) !== null);
    w.clock.advance(2 * MIN);
    await run(w);
    ok("…次の回にもう一度 attempt して消す", w.store.rawJob(NO) === null && count(w, "attemptDelivery") === 2 && w.line.texts.length === 0);
  }
  // ---- 枠・時間
  {
    const w = fakeWorld();
    for (const no of [1, 2, 3]) w.portal.add({ no, status: "完成" });
    w.haltAt("completion-prepared");
    for (let i = 0; i < 3; i++) await haltedAt(runCompletion(w.ctx()));
    w.haltAt(null);
    ok("（準備）prepared の控えが3つ", [1, 2, 3].every((no) => stage(w, no) === "prepared"));
    w.clock.advance(2 * MIN);
    await run(w);
    ok("枠：再開は1回に2件まで（3件目は attempt も呼ばない）", w.line.texts.length === 2 && count(w, "attemptDelivery") === 2 && stage(w, 3) === "prepared" && w.portal.job(1).status === "納品済み" && w.portal.job(2).status === "納品済み");
    await run(w);
    ok("枠：3件目は次の回", w.line.texts.length === 3 && w.portal.job(3).status === "納品済み");
  }
  {
    const w = await haltedWorld("completion-prepared");
    w.clock.advance(2 * MIN);
    const ctx = w.ctx();
    w.clock.advance(45_001);
    await runCompletion(ctx);
    ok("45秒を過ぎている → 再開しない（attempt を呼ばない・触らない）", count(w, "attemptDelivery") === 0 && stage(w) === "prepared" && w.line.texts.length === 0);
  }
  {
    // 40秒の線（送る線）は、新しい予約を取る前・再開の前に見る
    const w = world();
    const ctx = w.ctx();
    w.clock.advance(40_001);
    await runCompletion(ctx);
    ok(
      "40秒を過ぎている → 新しい予約（delivery/claim）を1回も呼ばない・依頼は完成のまま",
      count(w, "claimDelivery") === 0 && w.portal.job(NO).status === "完成" && w.store.rawJob(NO) === null && w.line.texts.length === 0,
    );
    const w2 = fakeWorld();
    for (const no of [1, 2]) w2.portal.add({ no, status: "完成" });
    const ctx2 = w2.ctx();
    w2.portal.onCall = (op) => {
      if (op === "reportDeliveryResult") w2.clock.advance(40_001); // 1件目のあいだに線を過ぎた
    };
    await runCompletion(ctx2);
    ok(
      "1件目の後に40秒の線を過ぎた → 2件目の予約は取らない",
      count(w2, "claimDelivery") === 1 && w2.portal.job(1).status === "納品済み" && w2.portal.job(2).status === "完成",
    );
    const r = await haltedWorld("completion-prepared");
    r.clock.advance(2 * MIN);
    const rctx = r.ctx();
    r.clock.advance(40_001);
    await runCompletion(rctx);
    ok(
      "40秒を過ぎている → 再開もしない（attempt を呼ばない・控えは prepared のまま・枠を使わない）",
      count(r, "attemptDelivery") === 0 && stage(r) === "prepared" && rctx.state.completionsUsed === 0 && !hasLog(r, "#J12 deferred"),
    );
  }
  // ---- 約束どおりの形でない控え
  for (const missing of ["facts", "leaseUntil"] as const) {
    const w = world();
    const c = await w.portal.claimDelivery(NO, T);
    if (c.kind !== "ok") throw new Error("claim");
    const memo: Record<string, unknown> = {
      v: 1,
      claimId: c.value.claimId,
      sha256: c.value.artifactSha256,
      stage: "prepared",
      leaseUntil: c.value.leaseUntil,
      facts: { reviewPages: 0, outsideErased: 0, outsidePages: [], fix: null, property: "" },
      at: new Date(w.clock.now()).toISOString(),
    };
    delete memo[missing];
    w.store.putRaw(NO, memo);
    w.clock.advance(2 * MIN);
    await run(w);
    const res = lastResult(w);
    ok(`${missing} の無い prepared の控え → attempt を呼ばず・push 0回・not_sent・config`, count(w, "attemptDelivery") === 0 && w.line.texts.length === 0 && res?.outcome === "not_sent" && res.reason === "config" && w.store.rawJob(NO) === null);
  }
  // ---- attempting で止まった → 送り直さない
  {
    const w = await haltedWorld("completion-attempting");
    w.clock.advance(2 * MIN);
    const ctx = await run(w);
    const res = lastResult(w);
    ok("attempting で止まった → push 合計0回・unknown・interrupted・納品要確認・控えが消える", w.line.texts.length === 0 && res?.outcome === "unknown" && res.reason === "interrupted" && w.portal.job(NO).status === "納品要確認" && w.store.rawJob(NO) === null && ctx.counts.unknown === 1 && hasLog(w, "#J12 unknown interrupted"));
  }
  {
    const w = await haltedWorld("completion-pushed");
    w.clock.advance(2 * MIN);
    await run(w);
    const res = lastResult(w);
    ok("push の直後に止まった → push は合計1回のまま・unknown・interrupted", w.line.texts.length === 1 && res?.outcome === "unknown" && res.reason === "interrupted" && w.portal.job(NO).status === "納品要確認");
  }
  {
    const w = await haltedWorld("completion-attempting");
    w.clock.advance(2 * MIN);
    w.portal.failNext("reportDeliveryResult", { kind: "unknown", reason: "timeout" });
    await run(w);
    ok("interrupted の報告が届かない → 控えは attempting のまま（次の回にやり直す）・push 0回", stage(w) === "attempting" && w.line.texts.length === 0);
  }
  for (const jobStatus of ["納品中", "完成"] as const) {
    // 古い attempting の控え（別の claimId）
    const w = world();
    if (jobStatus === "納品中") w.portal.takeOver(NO); // Mac が取り直して納品中
    const mac = w.portal.job(NO).claim ? { ...w.portal.job(NO).claim! } : null;
    w.store.putRaw(NO, {
      v: 1,
      claimId: "99999999-9999-4999-8999-999999999999",
      sha256: sha("artifact-12"),
      stage: "attempting",
      leaseUntil: new Date(w.clock.now() + 40 * MIN).toISOString(),
      facts: { reviewPages: 0, outsideErased: 0, outsidePages: [], fix: null, property: "" },
      at: new Date(w.clock.now() - 5 * MIN).toISOString(),
    });
    const before = w.portal.issuedClaimIds.length;
    await run(w);
    if (jobStatus === "納品中") {
      ok("古い attempting の控え・依頼は Mac の納品中 → 報告は断られ、控えを消すだけ・今の予約は変わらない・push 0回", w.store.rawJob(NO) === null && w.portal.job(NO).status === "納品中" && w.portal.job(NO).claim?.claimId === mac?.claimId && w.line.texts.length === 0 && hasLog(w, "#J12 memo-stale CLAIM_MISMATCH"));
    } else {
      ok("古い attempting の控え・依頼は完成 → 片付けた後、同じ回に新しい予約で1回配る", w.line.texts.length === 1 && w.portal.job(NO).status === "納品済み" && w.portal.issuedClaimIds.length === before + 1);
    }
  }
  // ---- sent で止まった
  for (const point of ["completion-sent-saved", "completion-before-result"] as const) {
    const w = await haltedWorld(point);
    w.portal.calls.length = 0;
    const ctx = await run(w);
    ok(`sent で止まった（${point}）→ 次の回は id の報告と結果の報告だけ・push は合計1回・納品済み`, w.line.texts.length === 1 && w.portal.job(NO).status === "納品済み" && ops(w).startsWith("reportDeliveryMessage,reportDeliveryResult") && count(w, "attemptDelivery") === 0 && ctx.counts.delivered === 1);
  }
  {
    const w = world();
    for (let i = 1; i <= 3; i++) {
      w.portal.failNext("reportDeliveryMessage", { kind: "unknown", reason: "timeout" });
      await run(w);
      if (i < 3) ok(`id の報告が${i}回だめ → まだ結果を報告しない（msgTries ${i}）`, w.portal.job(NO).status === "納品中" && w.store.rawJob(NO)?.msgTries === i);
    }
    ok("id の報告が3回だめ → 3回目の回に、あきらめて結果の報告へ進む", w.portal.job(NO).status === "納品済み" && w.line.texts.length === 1 && hasLog(w, "#J12 message-report-gave-up"));
  }
  {
    const w = world();
    for (let i = 0; i < 3; i++) {
      w.portal.failNext("reportDeliveryResult", { kind: "unknown", reason: "network" });
      await run(w);
      w.clock.advance(MIN);
    }
    ok("結果の報告が届かない回が続く → 控えは sent のまま・毎回やり直す", stage(w) === "sent" && count(w, "reportDeliveryResult") === 3 && w.line.texts.length === 1);
    w.clock.advance(46 * MIN);
    await run(w);
    ok("…予約の期限が切れて納品要確認になった後の delivered も受け付けられる", w.portal.events.some((e) => e.includes("納品中->納品要確認:lease")) && w.portal.job(NO).status === "納品済み" && w.store.rawJob(NO) === null);
  }
  {
    const w = await haltedWorld("completion-before-result");
    w.store.failOn("delJob", 1);
    await run(w);
    ok("sent の報告が通ったが消せなかった → 控えは残る", w.portal.job(NO).status === "納品済み" && stage(w) === "sent");
    await run(w);
    ok("…次の回に同じ報告（200）をして消す", w.store.rawJob(NO) === null && w.portal.job(NO).status === "納品済み" && w.line.texts.length === 1);
  }
  {
    const w = fakeWorld();
    w.store.putRaw(5, { v: 2, x: 1 });
    w.store.orphanIndex(7);
    await run(w);
    ok("形の違う控え → 消す", w.store.rawJob(5) === null && hasLog(w, "#J5 memo-invalid"));
    ok("目次の掃除：控えの無い番号は目次から消える・portal は一覧だけ", (w.store.dump().sets["obi-cloud:jobs"] ?? []).length === 0 && ops(w) === "listJobs");
  }
  // ---- 待ち時間
  {
    const w = world();
    w.line.next("rejected");
    await run(w);
    ok("（準備）not_sent が1回", retry(w)?.count === 1 && w.portal.job(NO).status === "完成");
    w.clock.advance(59 * MIN);
    await run(w);
    ok("待ち時間：not_sent の後、59分は予約を取らない", count(w, "claimDelivery") === 1);
    w.clock.advance(2 * MIN);
    w.line.next("rejected");
    await run(w);
    ok("待ち時間：61分で取る", count(w, "claimDelivery") === 2 && retry(w)?.count === 2);
    w.clock.advance(61 * MIN);
    w.line.next("rejected");
    await run(w);
    ok("（準備）not_sent が3回続いた", count(w, "claimDelivery") === 3 && retry(w)?.count === 3);
    w.clock.advance(23 * 60 * MIN);
    await run(w);
    ok("待ち時間：3回続いた後は、最後から23時間は取らない", count(w, "claimDelivery") === 3);
    w.clock.advance(2 * 60 * MIN);
    await run(w);
    ok("待ち時間：25時間で取る・delivered で終えたら数え直す", count(w, "claimDelivery") === 4 && w.portal.job(NO).status === "納品済み" && retry(w) === undefined);
  }
  {
    const w = world();
    w.line.next("rejected");
    await run(w);
    w.clock.advance(61 * MIN);
    w.line.next("unknown");
    await run(w);
    ok("待ち時間：unknown で終えたら数え直す", retry(w) === undefined && w.portal.job(NO).status === "納品要確認");
  }
  {
    const w = world();
    w.line.next("rejected");
    await run(w);
    w.portal.job(NO).artifactSha256 = sha("artifact-12-v2"); // 作り直した完成品
    await run(w);
    ok("待ち時間：sha256 が変わった完成品は別に数える（すぐ取る）", count(w, "claimDelivery") === 2 && w.portal.job(NO).status === "納品済み");
  }
  {
    const w = world();
    w.store.failOn("getRetry");
    await run(w);
    ok("待ち時間の鍵が読めない → 予約を取らない", count(w, "claimDelivery") === 0 && hasLog(w, "#J12 retry-read-failed"));
  }
  {
    const w = world();
    w.store.failOn("listJobNos");
    await run(w);
    ok("目次が読めない → 一覧も予約も attempt も呼ばない", w.portal.calls.length === 0 && hasLog(w, "memo-list-failed"));
  }
  // ---- 絞り込み
  {
    const w = fakeWorld();
    w.portal.add({ no: 1, status: "完成", workflow: "satei" });
    w.portal.add({ no: 2, status: "完成", replyKind: "secretary", replyGroupId: null });
    w.portal.add({ no: 3, status: "完成", replyGroupId: OTHER_GROUP });
    w.portal.add({ no: 4, status: "完成", artifactSha256: null });
    await run(w);
    ok("絞り込み：帯替えでない・秘書室あて・別のグループ・sha256 の無い行は予約を呼ばない", count(w, "claimDelivery") === 0 && w.line.texts.length === 0 && hasLog(w, "#J4 list-row-invalid"));
    for (const via of ["cloud", ""]) {
      const d = world({ row: { deliveryVia: via } });
      await run(d);
      ok(`絞り込み：完成の行の deliveryVia（${JSON.stringify(via)}）は見ない`, d.portal.job(NO).status === "納品済み" && d.line.texts.length === 1);
    }
  }
  {
    const w = fakeWorld();
    for (const no of [9, 5, 7]) w.portal.add({ no, status: "完成" });
    await run(w);
    ok("枠：完成が3件あっても、1回に配るのは2件（番号の小さい順）", w.line.texts.length === 2 && w.portal.job(5).status === "納品済み" && w.portal.job(7).status === "納品済み" && w.portal.job(9).status === "完成" && count(w, "claimDelivery") === 2);
    await run(w);
    ok("枠：3件目は次の回", w.portal.job(9).status === "納品済み");
  }
  {
    const w = await haltedWorld("completion-sent-saved");
    w.portal.add({ no: 20, status: "完成" });
    const ctx = w.ctx();
    w.clock.advance(45_001);
    await runCompletion(ctx);
    ok("45秒を過ぎている → 新しい予約を取らない（sent の片付けは進める）", w.portal.job(NO).status === "納品済み" && w.portal.job(20).status === "完成" && count(w, "claimDelivery") === 1);
  }
  {
    const a = await haltedWorld("completion-attempting");
    const s = await haltedWorld("completion-sent-saved");
    for (const w of [a, s]) {
      w.portal.add({ no: 20, status: "完成" });
      w.clock.advance(2 * MIN);
      w.portal.calls.length = 0;
      await run(w, { completion: null });
    }
    ok("完成の設定が無い回：新しい予約0件（一覧も呼ばない）", count(a, "claimDelivery") === 0 && count(a, "listJobs") === 0 && a.portal.job(20).status === "完成");
    ok("完成の設定が無い回：attempting／sent の片付けは進む", a.portal.job(NO).status === "納品要確認" && s.portal.job(NO).status === "納品済み");
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error("テストが例外で止まった:", e);
  process.exit(1);
});
