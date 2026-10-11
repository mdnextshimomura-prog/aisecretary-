/**
 * クラウド配達の種まきと、差し戻し・失敗の知らせ（約束 2026-10-11-obi-cloud-contract.md の入口 4・7、「K4 の見回り」）。
 * portal・KV・LINE は偽物（tests/helpers/obi-cloud-fakes.ts）。
 */
import { runNotices, runSeed } from "../src/lib/obi/cloud-notice";
import type { CloudCheckpoint, TickCtx } from "../src/lib/obi/cloud-tick";
import {
  GROUP,
  OTHER_GROUP,
  fakeWorld,
  haltedAt,
  type FakePortal,
  type FakeWorld,
} from "./helpers/obi-cloud-fakes";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name}`);
};

type Canned = Parameters<FakePortal["failNext"]>[1];
const MIN = 60_000;
const FIXED_GEN = "p0123abcd";
/** 固定の一言になる差し戻し */
const fixedJob = (no: number) => ({
  no,
  status: "差し戻し",
  row: { rejectState: "", choiceGen: 0, choices: [], prepNote: "x" },
  notice: { kind: "reject" as const, gen: FIXED_GEN },
});
/** 選択肢つきの差し戻し */
const choiceJob = (no: number) => ({
  no,
  status: "差し戻し",
  row: {
    rejectState: "offered",
    choiceGen: 41,
    choices: [1, 3, 4],
    rejectRound: 0,
    rejectKind: "scan",
    rejectReason: "",
  },
  notice: { kind: "reject" as const, gen: "g41" },
});
const failedJob = (no: number) => ({
  no,
  status: "失敗",
  notice: { kind: "failure" as const, gen: "" },
});

/** 種まきが済んでいる世界 */
function world(...jobs: Array<Parameters<FakePortal["add"]>[0]>): FakeWorld {
  const w = fakeWorld();
  w.deps.seedMemo.confirmed = true;
  for (const j of jobs) w.portal.add(j);
  return w;
}
const run = async (w: FakeWorld): Promise<TickCtx> => {
  const ctx = w.ctx();
  await runNotices(ctx);
  return ctx;
};
const ops = (w: FakeWorld) => w.portal.calls.map((c) => c.op).join();
const count = (w: FakeWorld, op: Parameters<FakePortal["callsOf"]>[0]) =>
  w.portal.callsOf(op).length;
const hasLog = (w: FakeWorld, s: string) => w.logs.includes(`cloud-tick ${s}`);
const rowState = (w: FakeWorld, no: number, kind = "reject", gen = FIXED_GEN) =>
  w.portal.noticeRow(no, kind, gen)?.state ?? null;
const FIXED_TEXT = (no: number) =>
  `#J${no} 自動では帯替えできませんでした。担当が確認します`;
const FAIL_TEXT = (no: number) =>
  `#J${no} 帯替えに失敗しました。担当が確認します`;

async function main() {
  // ---- 種まき
  {
    const w = fakeWorld();
    w.portal.setSeeded(false);
    w.portal.add(fixedJob(4));
    const ctx = w.ctx();
    const r = await runSeed(ctx);
    ok(
      "種まき：まだなら seed を1回呼び、その回は hold",
      r === "hold" &&
        count(w, "noticeSeed") === 1 &&
        ctx.counts.seeded === true &&
        w.deps.seedMemo.confirmed === true &&
        hasLog(w, "seeded"),
    );
    ok(
      "種まき：その時点の候補は by seed・sent",
      w.portal.noticeRow(4, "reject", FIXED_GEN)?.by === "seed" &&
        rowState(w, 4) === "sent",
    );
    const r2 = await runSeed(w.ctx());
    ok(
      "種まき：確かめた後は portal を呼ばずに go",
      r2 === "go" && count(w, "noticeSeed") === 1,
    );
  }
  {
    const w = fakeWorld(); // 種まき済みの portal
    const ctx = w.ctx();
    ok(
      "種まき済みの portal（seeded false）→ go・覚える",
      (await runSeed(ctx)) === "go" &&
        w.deps.seedMemo.confirmed === true &&
        ctx.counts.seeded === false &&
        count(w, "noticeSeed") === 1,
    );
    ok(
      "…次の回は seed を呼ばない",
      (await runSeed(w.ctx())) === "go" && count(w, "noticeSeed") === 1,
    );
  }
  for (const [label, canned] of [
    ["届かない", { kind: "unknown", reason: "timeout" }],
    ["401", { kind: "rejected", status: 401, code: "UNAUTHORIZED" }],
  ] as Array<[string, Canned]>) {
    const w = fakeWorld();
    w.portal.failNext("noticeSeed", canned);
    const ctx = w.ctx();
    ok(
      `種まきが${label} → hold・覚えない`,
      (await runSeed(ctx)) === "hold" &&
        w.deps.seedMemo.confirmed === false &&
        ctx.counts.seeded === false,
    );
    if (label === "401") ok("種まきが 401 → 打ち切る", ctx.state.portalStopped);
  }

  // ---- 差し戻し（固定の一言）
  {
    const w = world(fixedJob(4));
    const ctx = await run(w);
    ok(
      "固定の一言：一覧2つ → 予約 → 送信中の印 → 結果 の順",
      ops(w) === "listJobs,listJobs,noticeClaim,noticeAttempt,noticeResult",
      ops(w),
    );
    ok(
      "固定の一言：push 1回・本文",
      w.line.texts.length === 1 && w.line.texts[0] === FIXED_TEXT(4),
    );
    ok(
      "固定の一言：行は sent・by cloud",
      rowState(w, 4) === "sent" &&
        w.portal.noticeRow(4, "reject", FIXED_GEN)?.by === "cloud",
    );
    ok(
      "固定の一言：delivery/message を呼ばない",
      count(w, "reportDeliveryMessage") === 0,
    );
    ok(
      "固定の一言：件数とログ",
      ctx.counts.notices === 1 && hasLog(w, "#J4 notice-sent reject"),
    );
    const claim = w.portal.callsOf("noticeClaim")[0].args as Record<
      string,
      unknown
    >;
    ok(
      "固定の一言：予約の中身",
      claim.kind === "reject" &&
        claim.gen === FIXED_GEN &&
        claim.groupId === GROUP,
    );
    const j = w.journal
      .filter((e) => /^(portal:notice|line:push)/.test(e))
      .join(" > ");
    ok(
      "順番：notice/attempt の 200 より前に push が呼ばれない",
      j ===
        "portal:noticeClaim:4:ok > portal:noticeAttempt:4:ok > line:push > portal:noticeResult:4:ok",
      j,
    );
    const again = await run(w);
    ok(
      "同じ知らせは次の回に送らない（taken）",
      w.line.texts.length === 1 &&
        again.counts.notices === 0 &&
        count(w, "noticeClaim") === 1,
    );
  }
  // ---- 差し戻し（選択肢つき）
  {
    const w = world(choiceJob(4));
    await run(w);
    const lines = w.line.texts[0].split("\n");
    ok(
      "選択肢つき：本文の形",
      lines[0] === "#J4 自動では仕上げられませんでした" &&
        lines[1] === "理由：スキャンで文字が読めません" &&
        lines[2] === "" &&
        lines[3] === "▼ 対応を番号で返信してください" &&
        lines[5].startsWith("1 ") &&
        lines[6].startsWith("3 ") &&
        lines[7].startsWith("4 ") &&
        lines.length === 11 &&
        lines[10] === "または「#J4 1」のように送ってください",
    );
    ok(
      "選択肢つき：結果の後に delivery/message を1回",
      ops(w) ===
        "listJobs,listJobs,noticeClaim,noticeAttempt,noticeResult,reportDeliveryMessage",
      ops(w),
    );
    const msg = w.portal.callsOf("reportDeliveryMessage")[0].args as Record<
      string,
      unknown
    >;
    ok(
      "選択肢つき：id の報告の中身（kind reject・choiceGen・sha なし）",
      msg.kind === "reject" &&
        msg.choiceGen === 41 &&
        msg.messageId === w.line.ids[0] &&
        msg.groupId === GROUP &&
        !("artifactSha256" in msg),
    );
  }
  // ---- 失敗の一言
  {
    const w = world(failedJob(7));
    const ctx = await run(w);
    const claim = w.portal.callsOf("noticeClaim")[0].args as Record<
      string,
      unknown
    >;
    ok(
      "失敗：本文・gen は空・delivery/message を呼ばない",
      w.line.texts[0] === FAIL_TEXT(7) &&
        claim.kind === "failure" &&
        claim.gen === "" &&
        count(w, "reportDeliveryMessage") === 0 &&
        rowState(w, 7, "failure", "") === "sent",
    );
    ok(
      "失敗：件数とログ",
      ctx.counts.notices === 1 && hasLog(w, "#J7 notice-sent failure"),
    );
  }

  // ---- peers
  {
    const w = world(fixedJob(4), failedJob(7));
    w.portal.setPeers(false, "failure");
    await run(w);
    ok(
      "peers：差し戻しだけ true → 差し戻しだけ出る",
      w.line.texts.length === 1 &&
        w.line.texts[0] === FIXED_TEXT(4) &&
        hasLog(w, "notice-held failure") &&
        count(w, "noticeClaim") === 1,
    );
  }
  for (const v of [null, "absent", false] as const) {
    const w = world(fixedJob(4), failedJob(7));
    w.portal.setPeers(v);
    await run(w);
    ok(
      `peers：両方 ${String(v)} → 0通・予約も呼ばない`,
      w.line.texts.length === 0 &&
        count(w, "noticeClaim") === 0 &&
        hasLog(w, "notice-held reject") &&
        hasLog(w, "notice-held failure"),
    );
  }
  {
    const w = world(fixedJob(4));
    await run(w);
    w.portal.setPeers(false);
    w.portal.add(fixedJob(5));
    await run(w);
    ok(
      "peers を覚えない：1回目 true で1通 → 2回目 false は0通",
      w.line.texts.length === 1 && count(w, "noticeClaim") === 1,
    );
    w.portal.setPeers(true);
    await run(w);
    ok(
      "peers を覚えない：3回目に true へ戻すと出る",
      w.line.texts.length === 2 && w.line.texts[1] === FIXED_TEXT(5),
    );
    ok(
      "peers を覚えない：KV に peers に当たる鍵が無い",
      !/peer|noticeClaim/i.test(JSON.stringify(w.store.dump())) &&
        Object.keys(w.store.dump().keys).length === 0,
    );
  }

  // ---- 行の絞り込み
  {
    const w = world(
      { no: 4, status: "差し戻し", notice: null },
      { no: 7, status: "失敗", notice: null },
    );
    await run(w);
    ok(
      "groupNotice が null の行 → 予約を呼ばない",
      count(w, "noticeClaim") === 0 && w.line.texts.length === 0,
    );
  }
  {
    const w = world(fixedJob(4), failedJob(7));
    w.portal.withoutGroupNotice();
    await run(w);
    ok(
      "groupNotice の項目が無い行（古い portal）→ 予約を呼ばない",
      count(w, "noticeClaim") === 0 && w.line.texts.length === 0,
    );
  }
  {
    const raw = (no: number, status: string, groupNotice: unknown) => ({
      no,
      status,
      row: { groupNotice },
    });
    const skip: Array<[string, Parameters<FakePortal["add"]>[0]]> = [
      [
        "kind が一覧と食い違う（差し戻しの一覧に failure）",
        raw(1, "差し戻し", { kind: "failure", gen: "", taken: null }),
      ],
      [
        "kind が一覧と食い違う（失敗の一覧に reject）",
        raw(2, "失敗", { kind: "reject", gen: "g1", taken: null }),
      ],
      [
        "gen の形が違う（G1）",
        raw(3, "差し戻し", { kind: "reject", gen: "G1", taken: null }),
      ],
      [
        "gen の形が違う（p123）",
        raw(4, "差し戻し", { kind: "reject", gen: "p123", taken: null }),
      ],
      [
        "失敗の gen が空でない",
        raw(5, "失敗", { kind: "failure", gen: "g1", taken: null }),
      ],
      [
        "taken が sent・retryable false",
        raw(6, "差し戻し", {
          kind: "reject",
          gen: "g1",
          taken: { by: "mac", state: "sent", retryable: false },
        }),
      ],
      ["taken の項目が無い", raw(7, "差し戻し", { kind: "reject", gen: "g1" })],
      ["groupNotice が文字列", raw(8, "差し戻し", "reject")],
      [
        "retryable が文字列",
        raw(9, "差し戻し", {
          kind: "reject",
          gen: "g1",
          taken: { state: "failed", retryable: "true" },
        }),
      ],
    ];
    for (const [label, job] of skip) {
      const w = world(job);
      w.portal.withoutGroupNotice(); // 行に書いた groupNotice をそのまま返させる
      await run(w);
      ok(
        `絞り込み：${label} → 予約を呼ばない`,
        count(w, "noticeClaim") === 0 && w.line.texts.length === 0,
      );
    }
    for (const state of ["failed", "stale"]) {
      const w = world(
        raw(6, "差し戻し", {
          kind: "reject",
          gen: "g1",
          taken: { by: "cloud", state, retryable: true },
        }),
      );
      w.portal.withoutGroupNotice();
      await run(w);
      ok(
        `絞り込み：taken が ${state}・retryable true → 予約を呼ぶ`,
        count(w, "noticeClaim") === 1,
      );
    }
  }
  {
    const w = world(
      { ...fixedJob(1), replyGroupId: OTHER_GROUP },
      { ...fixedJob(2), replyKind: "secretary", replyGroupId: null },
      { ...fixedJob(3), workflow: "satei" },
      { ...failedJob(5), replyGroupId: OTHER_GROUP },
    );
    await run(w);
    ok(
      "返し先が違う行・帯替えでない行 → 予約を呼ばない",
      count(w, "noticeClaim") === 0 && w.line.texts.length === 0,
    );
  }

  // ---- 予約の答え
  {
    const w = world(fixedJob(4));
    w.portal.failNext("noticeClaim", {
      kind: "ok",
      status: 200,
      value: { claimed: false },
    } as unknown as Canned);
    await run(w);
    ok(
      "予約が取れない（Mac が先）→ push 0回・notice-taken",
      w.line.texts.length === 0 &&
        hasLog(w, "#J4 notice-taken") &&
        count(w, "noticeAttempt") === 0,
    );
  }
  {
    const w = world(fixedJob(4), fixedJob(5), failedJob(7));
    w.portal.setSeeded(false);
    await run(w);
    ok(
      "NOTICE_NOT_SEEDED → push 0回・覚えを消す・残りの候補に手を付けない",
      w.line.texts.length === 0 &&
        w.deps.seedMemo.confirmed === false &&
        count(w, "noticeClaim") === 1 &&
        hasLog(w, "notice-not-seeded"),
    );
  }
  for (const [label, canned, log] of [
    [
      "NOTICE_STALE",
      { kind: "rejected", status: 409, code: "NOTICE_STALE" },
      "#J4 notice-stale",
    ],
    [
      "WRITE_CONFLICT",
      { kind: "rejected", status: 409, code: "WRITE_CONFLICT" },
      "#J4 notice-claim WRITE_CONFLICT",
    ],
    [
      "そのほかの 4xx",
      { kind: "rejected", status: 404, code: "NOT_FOUND" },
      "#J4 notice-claim NOT_FOUND",
    ],
    [
      "届かない",
      { kind: "unknown", reason: "timeout" },
      "#J4 notice-claim-unknown",
    ],
  ] as Array<[string, Canned, string]>) {
    const w = world(fixedJob(4), fixedJob(5));
    w.portal.failNext("noticeClaim", canned);
    await run(w);
    ok(
      `予約が ${label} → その依頼は push 0回・予約は1回だけ・次の候補へ進む`,
      w.line.texts.length === 1 &&
        w.line.texts[0] === FIXED_TEXT(5) &&
        w.portal.callsOf("noticeClaim").filter((c) => c.no === 4).length ===
          1 &&
        hasLog(w, log),
      w.logs.join("|"),
    );
    if (label === "WRITE_CONFLICT") {
      await run(w);
      ok(
        "予約が WRITE_CONFLICT → 次の回、taken が null のままなので取り直して1通だけ",
        w.line.texts.length === 2 && w.line.texts[1] === FIXED_TEXT(4),
      );
    }
  }
  {
    const w = world(fixedJob(4), fixedJob(5));
    w.portal.failNext("noticeClaim", {
      kind: "rejected",
      status: 401,
      code: "UNAUTHORIZED",
    });
    const ctx = await run(w);
    ok(
      "予約が 401 → 打ち切る（次の候補に進まない）",
      ctx.state.portalStopped &&
        w.line.texts.length === 0 &&
        count(w, "noticeClaim") === 1,
    );
  }

  // ---- attempt の答え
  {
    const w = world(fixedJob(4));
    w.portal.onCall = (op, no) => {
      if (op === "noticeAttempt" && no === 4) w.portal.setStatus(4, "完成"); // 予約の後に依頼が動いた
    };
    const ctx = await run(w);
    ok(
      "attempt が NOTICE_STALE（依頼が動いた）→ push 0回・結果を報告しない・行は stale",
      w.line.texts.length === 0 &&
        count(w, "noticeResult") === 0 &&
        rowState(w, 4) === "stale" &&
        hasLog(w, "#J4 notice-stale") &&
        ctx.counts.notices === 0,
    );
  }
  for (const [label, canned, log] of [
    [
      "NOTICE_CLAIM_STALE",
      { kind: "rejected", status: 409, code: "NOTICE_CLAIM_STALE" },
      "#J4 notice-attempt NOTICE_CLAIM_STALE",
    ],
    [
      "NOTICE_SETTLED",
      { kind: "rejected", status: 409, code: "NOTICE_SETTLED" },
      "#J4 notice-attempt NOTICE_SETTLED",
    ],
    [
      "404",
      { kind: "rejected", status: 404, code: "NOT_FOUND" },
      "#J4 notice-attempt NOT_FOUND",
    ],
    [
      "答えが届かない（portal の側は attempting）",
      { kind: "unknown", reason: "timeout", applied: true },
      "#J4 notice-attempt-unknown",
    ],
    [
      "WRITE_CONFLICT",
      { kind: "rejected", status: 409, code: "WRITE_CONFLICT" },
      "#J4 notice-attempt WRITE_CONFLICT",
    ],
  ] as Array<[string, Canned, string]>) {
    const w = world(fixedJob(4));
    w.portal.failNext("noticeAttempt", canned);
    await run(w);
    ok(
      `attempt が ${label} → push 0回・結果を報告しない・attempt は1回だけ`,
      w.line.texts.length === 0 &&
        count(w, "noticeResult") === 0 &&
        count(w, "noticeAttempt") === 1 &&
        hasLog(w, log),
      w.logs.join("|"),
    );
    if (label === "WRITE_CONFLICT") {
      ok(
        "attempt が WRITE_CONFLICT → 行は prepared のまま",
        rowState(w, 4) === "prepared",
      );
      w.clock.advance(11 * MIN);
      await run(w);
      ok(
        "…11分後の回に取り直して1通だけ",
        w.line.texts.length === 1 && rowState(w, 4) === "sent",
      );
    }
    if (label.startsWith("答えが届かない")) {
      w.clock.advance(11 * MIN);
      await run(w);
      ok(
        "attempt の答えが届かない → 11分後に portal が unknown にし、送り直さない",
        w.line.texts.length === 0 &&
          rowState(w, 4) === "unknown" &&
          count(w, "noticeClaim") === 1,
      );
    }
  }

  // ---- push の結果
  {
    const w = world(fixedJob(4));
    w.line.next("rejected", "rejected", "rejected");
    let ctx = await run(w);
    ok(
      "push が 4xx → 結果 failed・行は failed・件数は増えない",
      rowState(w, 4) === "failed" &&
        ctx.counts.notices === 0 &&
        (w.portal.callsOf("noticeResult")[0].args as { state: string })
          .state === "failed" &&
        hasLog(w, "#J4 notice-failed"),
    );
    ctx = await run(w);
    ok(
      "push が 4xx → 次の回、retryable なので取り直して送る（tries が増える）",
      w.line.texts.length === 2 &&
        w.portal.noticeRow(4, "reject", FIXED_GEN)?.tries === 2,
    );
    await run(w);
    await run(w);
    await run(w);
    ok(
      "push が 4xx → 3回で止まる",
      w.line.texts.length === 3 &&
        w.portal.noticeRow(4, "reject", FIXED_GEN)?.tries === 3 &&
        count(w, "noticeClaim") === 3,
    );
  }
  for (const kind of ["unknown", "throw"] as const) {
    const w = world(fixedJob(4));
    w.line.next(kind);
    const ctx = await run(w);
    ok(
      `push が${kind === "throw" ? "投げる" : "分からない"} → 結果 unknown・行は unknown・件数は増えない`,
      rowState(w, 4) === "unknown" &&
        ctx.counts.notices === 0 &&
        hasLog(w, "#J4 notice-unknown"),
    );
    await run(w);
    ok(
      `push が${kind === "throw" ? "投げる" : "分からない"} → 次の回は予約を呼ばない（送り直さない）`,
      w.line.texts.length === 1 && count(w, "noticeClaim") === 1,
    );
  }

  // ---- 結果の報告の答え
  for (const code of [
    "NOTICE_CLAIM_STALE",
    "NOTICE_SETTLED",
    "STATE_CONFLICT",
    "WRITE_CONFLICT",
  ]) {
    const w = world(fixedJob(4));
    w.portal.failNext("noticeResult", { kind: "rejected", status: 409, code });
    const ctx = await run(w);
    ok(
      `結果が ${code} → ログだけ・結果の報告は1回だけ・push は合計1回・件数は増えない`,
      hasLog(w, `#J4 notice-result ${code}`) &&
        count(w, "noticeResult") === 1 &&
        w.line.texts.length === 1 &&
        ctx.counts.notices === 0,
    );
    if (code === "WRITE_CONFLICT") {
      w.clock.advance(11 * MIN);
      await run(w);
      ok(
        "結果が WRITE_CONFLICT → 11分後に portal が unknown にし、送り直さない",
        rowState(w, 4) === "unknown" && w.line.texts.length === 1,
      );
    }
  }
  {
    const w = world(fixedJob(4));
    w.portal.failNext("noticeResult", { kind: "unknown", reason: "network" });
    const ctx = await run(w);
    ok(
      "結果の報告が届かない → 同じ回にもう1回だけ呼ぶ。2回目が通れば行は sent",
      count(w, "noticeResult") === 2 &&
        rowState(w, 4) === "sent" &&
        ctx.counts.notices === 1,
    );
    const w2 = world(fixedJob(4));
    w2.portal.failNext("noticeResult", { kind: "unknown", reason: "network" });
    w2.portal.failNext("noticeResult", { kind: "unknown", reason: "http-5xx" });
    const ctx2 = await run(w2);
    ok(
      "結果の報告が2回ともだめ → ログ（3回目は呼ばない）",
      count(w2, "noticeResult") === 2 &&
        hasLog(w2, "#J4 notice-result-unknown") &&
        ctx2.counts.notices === 0 &&
        w2.line.texts.length === 1,
    );
  }

  // ---- 3通まで・時間
  {
    const w = world(
      fixedJob(9),
      failedJob(2),
      fixedJob(5),
      failedJob(7),
      fixedJob(1),
    );
    const ctx = await run(w);
    ok(
      "3通まで：候補が5件 → 1回に3通（番号の小さい順。差し戻しと失敗を合わせて）",
      w.line.texts.length === 3 &&
        w.line.texts.join("|") ===
          [FIXED_TEXT(1), FAIL_TEXT(2), FIXED_TEXT(5)].join("|") &&
        ctx.counts.notices === 3 &&
        count(w, "noticeClaim") === 3,
    );
    await run(w);
    ok(
      "3通まで：残りは次の回",
      w.line.texts.length === 5 &&
        w.line.texts[3] === FAIL_TEXT(7) &&
        w.line.texts[4] === FIXED_TEXT(9),
    );
  }
  {
    const w = world(fixedJob(4), fixedJob(5));
    w.line.next("rejected", "unknown", "rejected");
    w.portal.add(fixedJob(6));
    w.portal.add(fixedJob(8));
    await run(w);
    ok(
      "3通の枠は「LINE を呼んだ回数」（結果によらない）",
      w.line.texts.length === 3 && count(w, "noticeClaim") === 3,
    );
  }
  {
    const w = world(fixedJob(4), fixedJob(5));
    const ctx = w.ctx();
    w.portal.onCall = (op) => {
      if (op === "noticeClaim") w.clock.advance(30_001); // 予約のあいだに30秒の線を過ぎた
    };
    await runNotices(ctx);
    ok(
      "30秒を過ぎた → 予約は取るが attempt を呼ばず打ち切る・push 0回",
      count(w, "noticeClaim") === 1 &&
        count(w, "noticeAttempt") === 0 &&
        w.line.texts.length === 0 &&
        hasLog(w, "#J4 notice-deferred") &&
        rowState(w, 4) === "prepared",
    );
    const w2 = world(fixedJob(4));
    const ctx2 = w2.ctx();
    w2.clock.advance(45_001);
    await runNotices(ctx2);
    ok(
      "45秒を過ぎた → 一覧も予約も呼ばない",
      w2.portal.calls.length === 0 && w2.line.texts.length === 0,
    );
  }

  // ---- 差し込み口
  const halts: Array<[CloudCheckpoint, string, number]> = [
    ["notice-claimed", "prepared", 0],
    ["notice-attempting", "attempting", 0],
    ["notice-pushed", "attempting", 1],
  ];
  for (const [point, state, pushes] of halts) {
    const w = world(fixedJob(4));
    w.haltAt(point);
    const at = await haltedAt(runNotices(w.ctx()));
    ok(
      `差し込み口 ${point}：行は ${state}・push ${pushes}回`,
      at === point &&
        rowState(w, 4) === state &&
        w.line.texts.length === pushes &&
        count(w, "noticeResult") === 0,
    );
    w.haltAt(null);
    w.clock.advance(11 * MIN);
    await run(w);
    if (point === "notice-claimed")
      ok(
        "差し込み口 notice-claimed：11分後の回に取り直して1通だけ",
        w.line.texts.length === 1 && rowState(w, 4) === "sent",
      );
    else
      ok(
        `差し込み口 ${point}：11分後に行は unknown・送り直さない`,
        rowState(w, 4) === "unknown" &&
          w.line.texts.length === pushes &&
          count(w, "noticeClaim") === 1,
      );
  }

  // ---- 知らせの id の控え
  {
    const w = world(choiceJob(4));
    w.portal.failNext("reportDeliveryMessage", {
      kind: "unknown",
      reason: "timeout",
    });
    await run(w);
    let dump = w.store.dump();
    ok(
      "id の報告が届かない → KV に控え（tries 1）と目次",
      JSON.stringify(dump.keys["obi-cloud:notice-msg:4:41"]) ===
        JSON.stringify({ messageId: w.line.ids[0], tries: 1 }) &&
        JSON.stringify(dump.sets["obi-cloud:notice-msgs"]) === '["4:41"]',
    );
    w.portal.calls.length = 0;
    await run(w);
    dump = w.store.dump();
    ok(
      "…次の回の最初にやり直して、値も目次も消える",
      ops(w).startsWith("reportDeliveryMessage,listJobs") &&
        !("obi-cloud:notice-msg:4:41" in dump.keys) &&
        (dump.sets["obi-cloud:notice-msgs"] ?? []).length === 0,
    );
    const msg = w.portal.callsOf("reportDeliveryMessage")[0].args as Record<
      string,
      unknown
    >;
    ok(
      "…やり直しの中身",
      msg.kind === "reject" &&
        msg.choiceGen === 41 &&
        msg.messageId === w.line.ids[0] &&
        msg.groupId === GROUP,
    );
  }
  {
    const w = world(choiceJob(4));
    w.portal.failNext("reportDeliveryMessage", {
      kind: "unknown",
      reason: "timeout",
    });
    await run(w);
    w.portal.failNext("reportDeliveryMessage", {
      kind: "rejected",
      status: 409,
      code: "CHOICE_STALE",
    });
    await run(w);
    ok(
      "id の報告のやり直しが CHOICE_STALE → 1回で消す",
      !("obi-cloud:notice-msg:4:41" in w.store.dump().keys) &&
        hasLog(w, "#J4 notice-msg-dropped CHOICE_STALE"),
    );
  }
  {
    const w = world(choiceJob(4));
    w.portal.failNext("reportDeliveryMessage", {
      kind: "rejected",
      status: 409,
      code: "CHOICE_STALE",
    });
    await run(w);
    ok(
      "id の報告が最初から断られる → 控えを作らない・ログ",
      Object.keys(w.store.dump().keys).length === 0 &&
        hasLog(w, "#J4 notice-msg-dropped CHOICE_STALE"),
    );
  }
  {
    const w = world(choiceJob(4));
    for (let i = 1; i <= 3; i++) {
      w.portal.failNext("reportDeliveryMessage", {
        kind: "unknown",
        reason: "timeout",
      });
      await run(w);
      const v = w.store.dump().keys["obi-cloud:notice-msg:4:41"] as
        { tries: number } | undefined;
      if (i < 3) ok(`id の報告が${i}回届かない → tries ${i}`, v?.tries === i);
      else
        ok(
          "id の報告が3回届かない → 消す",
          v === undefined &&
            (w.store.dump().sets["obi-cloud:notice-msgs"] ?? []).length === 0,
        );
    }
    ok("…そのあいだ、知らせそのものは1通だけ", w.line.texts.length === 1);
  }
  {
    const w = world(fixedJob(4));
    w.store.orphanNoticeIndex("9:5");
    await run(w);
    ok(
      "目次に値だけ残っている → 掃除で目次から消える・portal の id の報告は呼ばない",
      (w.store.dump().sets["obi-cloud:notice-msgs"] ?? []).length === 0 &&
        count(w, "reportDeliveryMessage") === 0 &&
        w.line.texts.length === 1,
    );
  }
  {
    const w = world(fixedJob(4));
    w.store.failOn("listNoticeMsgs");
    await run(w);
    ok(
      "目次が読めない → id の報告のやり直しだけを飛ばし、知らせは出る",
      w.line.texts.length === 1 && rowState(w, 4) === "sent",
    );
  }
  {
    const w = world(choiceJob(4));
    w.portal.failNext("reportDeliveryMessage", {
      kind: "unknown",
      reason: "timeout",
    });
    w.store.failOn("putNoticeMsg");
    await run(w);
    ok(
      "id の控えが書けない → あきらめる（知らせは届いている）",
      w.line.texts.length === 1 &&
        rowState(w, 4, "reject", "g41") === "sent" &&
        Object.keys(w.store.dump().keys).length === 0,
    );
  }

  // ---- 一覧が片方だけ取れない
  {
    const w = world(fixedJob(4), failedJob(7));
    w.portal.failNext("listJobs", { kind: "unknown", reason: "http-5xx" }); // 差し戻しの一覧
    await run(w);
    ok(
      "一覧が片方だけ取れない → 取れた方の知らせは出る",
      w.line.texts.length === 1 && w.line.texts[0] === FAIL_TEXT(7),
    );
    const w2 = world(fixedJob(4), failedJob(7));
    w2.portal.failNext("listJobs", {
      kind: "rejected",
      status: 401,
      code: "UNAUTHORIZED",
    });
    const ctx2 = await run(w2);
    ok(
      "最初の一覧が 401 → 残りの呼び出しをしない",
      ctx2.state.portalStopped &&
        w2.portal.calls.length === 1 &&
        w2.line.texts.length === 0,
    );
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error("テストが例外で止まった:", e);
  process.exit(1);
});
