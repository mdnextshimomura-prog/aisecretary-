/**
 * クラウド配達の見回りの本体（約束 2026-10-11-obi-cloud-contract.md の「K4 の見回り」・設計 C1・C16）。
 * 回が抜ける・同じ回が2回呼ばれる・前の回と重なる場面と、ログ・応答・控えに出してはいけない値が出ないこと。
 * portal・KV・LINE は偽物（tests/helpers/obi-cloud-fakes.ts）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CloudCompletionResult } from "../src/lib/obi/cloud-config";
import {
  CloudHalt,
  createTickClock,
  runCloudTick,
  type CloudCheckpoint,
  type CloudTickBody,
} from "../src/lib/obi/cloud-tick";
import {
  CLEAN_PROPERTY,
  COMPLETION_OK,
  GROUP,
  OTHER_GROUP,
  PORTAL_TOKEN,
  RAW_PROPERTY,
  SHARED,
  TEST_PRIVATE_PEM,
  fakeWorld,
  sha,
  tokenOf,
  withoutToken,
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

const MIN = 60_000;
const FIXED_GEN = "p0123abcd";
const doneJob = (no: number, over: Record<string, unknown> = {}) => ({
  no,
  status: "完成",
  property: RAW_PROPERTY,
  ...over,
});
const rejectJob = (no: number) => ({
  no,
  status: "差し戻し",
  row: { rejectState: "", choiceGen: 0, choices: [], prepNote: "x" },
  notice: { kind: "reject" as const, gen: FIXED_GEN },
});
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

// ---- この試験で動かした全部の世界と、その出力（最後に「出してはいけない値」が無いことを見る）
const worlds: FakeWorld[] = [];
const bodies: unknown[] = [];
const consoleOut: string[] = [];
const dumps: string[] = [];
function world(...jobs: Array<Parameters<FakePortal["add"]>[0]>): FakeWorld {
  const w = fakeWorld();
  worlds.push(w);
  for (const j of jobs) w.portal.add(j);
  return w;
}
type TickResult = {
  body: CloudTickBody | null;
  halted: string | null;
  error: string | null;
};
/** 見回りを1回（開始＝今）。その間の console の出力と、終わった時点の KV の中身を集める */
async function tick(
  w: FakeWorld,
  over: { completion?: CloudCompletionResult; fixGuide?: boolean } = {},
): Promise<TickResult> {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const grab = (...a: unknown[]) =>
    void consoleOut.push(a.map(String).join(" "));
  console.log = grab;
  console.error = grab;
  console.warn = grab;
  const out: TickResult = { body: null, halted: null, error: null };
  try {
    out.body = await runCloudTick({
      deps: w.deps,
      shared: SHARED,
      completion: over.completion ?? COMPLETION_OK,
      fixGuide: over.fixGuide ?? false,
      startedAt: w.clock.now(),
    });
    bodies.push(out.body);
  } catch (e) {
    if (e instanceof CloudHalt) out.halted = e.point;
    else out.error = (e as { name?: string })?.name ?? "Error";
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
  }
  dumps.push(JSON.stringify(w.store.dump()));
  return out;
}
const haltOnce = async (w: FakeWorld, point: CloudCheckpoint) => {
  w.haltAt(point);
  const r = await tick(w);
  w.haltAt(null);
  if (r.halted !== point) throw new Error(`止まらなかった: ${point}`);
};
const count = (w: FakeWorld, op: Parameters<FakePortal["callsOf"]>[0]) =>
  w.portal.callsOf(op).length;
const hasLog = (w: FakeWorld, s: string) => w.logs.includes(`cloud-tick ${s}`);
const key = (w: FakeWorld) =>
  w.journal
    .filter((e) =>
      /^(store:(acquireLock|listJobNos|releaseLock)|portal:(listJobs|claimDelivery|attemptDelivery|noticeSeed|noticeClaim)|line:push)/.test(
        e,
      ),
    )
    .join(" > ");
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

async function main() {
  // ---- 時間の部品
  {
    let now = 1_000_000;
    const c = createTickClock(() => now, now);
    ok(
      "時計：開始の時点",
      c.canStartNew() &&
        c.canSendCompletion() &&
        c.canAttemptNotice() &&
        c.portalTimeout() === 10_000,
    );
    now += 30_000;
    ok(
      "時計：30秒ちょうどは、まだ進める",
      c.canAttemptNotice() && c.elapsed() === 30_000,
    );
    now += 1;
    ok(
      "時計：30秒を過ぎたら、知らせの attempt へ進まない",
      !c.canAttemptNotice() && c.canSendCompletion() && c.canStartNew(),
    );
    now += 10_000;
    ok(
      "時計：40秒を過ぎたら、完成の attempt へ進まない",
      !c.canSendCompletion() && c.canStartNew(),
    );
    now += 5_000;
    ok(
      "時計：45秒を過ぎたら、新しい件に手を付けない",
      !c.canStartNew() && c.portalTimeout() === 10_000,
    );
    now += 5_000;
    ok(
      "時計：portal の上限は57秒の線で縮む",
      c.portalTimeout() === 57_000 - 50_001,
    );
    now += 6_000;
    ok("時計：1秒に満たなければ 0（呼ばない）", c.portalTimeout() === 0);
  }

  // ---- モジュールの読み込みの向き（互いに読み込まない）
  {
    const src = (name: string) => readFileSync(path.join(__dirname, "..", "src", "lib", "obi", name), "utf8");
    const imports = (name: string) => Array.from(src(name).matchAll(/from "\.\/(cloud-[a-z]+)"/g)).map((m) => m[1]);
    ok("共有の定数・型（cloud-const.ts）は、値としては何も読み込まない", !/^import (?!type )/m.test(src("cloud-const.ts")), imports("cloud-const.ts").join());
    ok("cloud-deliver.ts は cloud-tick.ts・cloud-notice.ts を読み込まない", !imports("cloud-deliver.ts").some((m) => m === "cloud-tick" || m === "cloud-notice"), imports("cloud-deliver.ts").join());
    ok("cloud-notice.ts は cloud-tick.ts を読み込まない", !imports("cloud-notice.ts").includes("cloud-tick"), imports("cloud-notice.ts").join());
  }

  // ---- 通し
  {
    const w = world(doneJob(12), rejectJob(4), failedJob(7));
    const r = await tick(w);
    ok(
      "通し：push 3回・応答の形",
      w.line.texts.length === 3 &&
        same(r.body, {
          delivered: 1,
          notSent: 0,
          unknown: 0,
          notices: 2,
          seeded: false,
        }),
      JSON.stringify(r.body),
    );
    ok("通し：錠が外れている", !w.store.lockHeld());
    ok(
      "通し：依頼は納品済み・知らせは sent",
      w.portal.job(12).status === "納品済み" &&
        w.portal.noticeRow(4, "reject", FIXED_GEN)?.state === "sent" &&
        w.portal.noticeRow(7, "failure", "")?.state === "sent",
    );
    ok(
      "順番：錠 → 目次 → 完成の一覧 → 予約 → attempt → push → 種まき → 差し戻しの一覧 → 失敗の一覧 → 知らせ → 錠を外す",
      key(w) ===
        "store:acquireLock > store:listJobNos > portal:listJobs:ok > portal:claimDelivery:12:ok > portal:attemptDelivery:12:ok > line:push > portal:noticeSeed:ok > portal:listJobs:ok > portal:listJobs:ok > portal:noticeClaim:4:ok > line:push > portal:noticeClaim:7:ok > line:push > store:releaseLock",
      key(w),
    );
    // 同じ回が2回呼ばれる
    const r2 = await tick(w);
    ok(
      "同じ回が2回呼ばれる → 2回目は push 0回",
      w.line.texts.length === 3 &&
        same(r2.body, {
          delivered: 0,
          notSent: 0,
          unknown: 0,
          notices: 0,
          seeded: false,
        }),
    );
    ok(
      "2回目は種まきを呼ばない（このインスタンスの覚え）",
      count(w, "noticeSeed") === 1,
    );
  }
  {
    // 控えがあれば、完成の一覧より前に再開する
    const w = world(doneJob(12), doneJob(13));
    await haltOnce(w, "completion-prepared");
    w.clock.advance(2 * MIN);
    w.journal.length = 0;
    await tick(w);
    ok(
      "順番：prepared の控えがあれば、目次 → attempt → push → 完成の一覧 → 予約 …",
      key(w).startsWith(
        "store:acquireLock > store:listJobNos > portal:attemptDelivery:12:ok > line:push > portal:listJobs:ok > portal:claimDelivery:13:ok > portal:attemptDelivery:13:ok > line:push",
      ),
      key(w),
    );
  }

  // ---- 種まきの回は知らせを送らない
  {
    const w = world(doneJob(12), rejectJob(4), failedJob(7));
    w.portal.setSeeded(false);
    const r = await tick(w);
    ok(
      "種まきの回：push は完成の分だけ・seeded true・notices 0",
      w.line.texts.length === 1 &&
        same(r.body, {
          delivered: 1,
          notSent: 0,
          unknown: 0,
          notices: 0,
          seeded: true,
        }),
      JSON.stringify(r.body),
    );
    ok(
      "種まきの回：候補の行は by seed・sent・予約を呼ばない",
      w.portal.noticeRow(4, "reject", FIXED_GEN)?.by === "seed" &&
        w.portal.noticeRow(7, "failure", "")?.state === "sent" &&
        count(w, "noticeClaim") === 0,
    );
    ok(
      "種まきの回：知らせの一覧そのものを取らない（一覧は完成の1回だけ）",
      count(w, "listJobs") === 1 && count(w, "noticeSeed") === 1,
    );
    const r2 = await tick(w);
    ok(
      "次の回も、種まきで知らせ済みの2件には送らない",
      w.line.texts.length === 1 &&
        same(r2.body, {
          delivered: 0,
          notSent: 0,
          unknown: 0,
          notices: 0,
          seeded: false,
        }),
    );
    w.portal.add(rejectJob(5));
    const r3 = await tick(w);
    ok(
      "その後に新しく差し戻しになった依頼には送る",
      w.line.texts.length === 2 &&
        w.line.texts[1].startsWith("#J5 ") &&
        (r3.body as { notices: number }).notices === 1,
    );
  }

  // ---- 錠
  {
    const w = world(doneJob(12), rejectJob(4));
    await w.store.acquireLock();
    w.journal.length = 0;
    const r = await tick(w);
    ok(
      "錠が取れない → locked・portal と LINE の呼び出し0回",
      same(r.body, { skipped: "locked" }) &&
        w.portal.calls.length === 0 &&
        w.line.texts.length === 0,
    );
    ok(
      "錠が取れない回は、人の錠を外さない",
      w.store.lockHeld() && !w.journal.includes("store:releaseLock"),
    );
  }
  {
    const w = world(doneJob(12));
    w.store.failOn("acquireLock");
    const r = await tick(w);
    ok(
      "錠の操作が例外 → locked・呼び出し0回",
      same(r.body, { skipped: "locked" }) &&
        w.portal.calls.length === 0 &&
        w.line.texts.length === 0 &&
        hasLog(w, "lock-error"),
    );
  }
  {
    const w = world(doneJob(12), rejectJob(4), failedJob(7));
    const [a, b] = await Promise.all([tick(w), tick(w)]);
    const lockedCount = [a, b].filter((r) =>
      same(r.body, { skipped: "locked" }),
    ).length;
    ok(
      "前の回と重なる（2つ同時）→ 片方が locked・push は合計3回のまま",
      lockedCount === 1 && w.line.texts.length === 3,
    );
  }
  {
    const w = world(doneJob(12), rejectJob(4), failedJob(7));
    w.store.brokenLock();
    const [a, b] = await Promise.all([tick(w), tick(w)]);
    ok(
      "錠が効かない場面でも二重にならない：どちらも locked でない",
      !same(a.body, { skipped: "locked" }) &&
        !same(b.body, { skipped: "locked" }),
    );
    ok(
      "錠が効かない場面でも二重にならない：push は完成1回・知らせ各1回",
      w.line.texts.length === 3 &&
        new Set(w.line.texts.map(withoutToken)).size === 3,
      String(w.line.texts.length),
    );
    ok(
      "錠が効かない場面：完成の予約は片方しか通らない",
      count(w, "attemptDelivery") === 1 &&
        w.portal.job(12).status === "納品済み",
    );
  }
  {
    // 錠が効かない場面で、動いている回の控えを別の回が触らない
    const w = world(doneJob(12));
    w.store.brokenLock();
    await haltOnce(w, "completion-attempting");
    w.clock.advance(60_000);
    await tick(w);
    ok(
      "錠が効かない場面：70秒たたない attempting の控えは、別の回が報告しない",
      w.store.rawJob(12)?.stage === "attempting" &&
        count(w, "reportDeliveryResult") === 0,
    );
  }

  // ---- 回が抜ける
  {
    const w = world(
      doneJob(1),
      doneJob(2),
      doneJob(3),
      rejectJob(4),
      rejectJob(5),
      failedJob(6),
      failedJob(7),
    );
    const r1 = await tick(w);
    ok(
      "1回目：完成2件・知らせ3通",
      same(r1.body, {
        delivered: 2,
        notSent: 0,
        unknown: 0,
        notices: 3,
        seeded: false,
      }) && w.line.texts.length === 5,
    );
    w.clock.advance(5 * MIN); // 回が抜けた
    const r2 = await tick(w);
    ok(
      "回が抜けた後：残っていた分（3件目の完成・4通目の知らせ）が進む",
      same(r2.body, {
        delivered: 1,
        notSent: 0,
        unknown: 0,
        notices: 1,
        seeded: false,
      }) && w.line.texts.length === 7,
    );
    ok(
      "回が抜けても、二重にも漏れにもならない",
      new Set(w.line.texts.map(withoutToken)).size === 7 &&
        [1, 2, 3].every((no) => w.portal.job(no).status === "納品済み"),
    );
    const r3 = await tick(w);
    ok(
      "その次の回は何も無い",
      same(r3.body, {
        delivered: 0,
        notSent: 0,
        unknown: 0,
        notices: 0,
        seeded: false,
      }) && w.line.texts.length === 7,
    );
  }

  // ---- 途中で止める試験
  {
    const control = world(doneJob(12, { reviewPages: 1 }));
    await tick(control);
    const w = world(doneJob(12, { reviewPages: 1 }));
    await haltOnce(w, "completion-prepared");
    ok(
      "止めた回：錠が残る（関数が落ちたのと同じ）",
      w.store.lockHeld() && w.line.texts.length === 0,
    );
    w.clock.advance(60_000);
    const r1 = await tick(w);
    ok(
      "完成（prepared で止めた）：次の回（60秒後）は locked",
      same(r1.body, { skipped: "locked" }) && w.line.texts.length === 0,
    );
    w.clock.advance(60_000);
    w.journal.length = 0;
    const r2 = await tick(w);
    ok(
      "完成（prepared で止めた）：その次（120秒後）に、attempt を通してから再開してリンクが1通だけ",
      w.line.texts.length === 1 &&
        key(w).includes("portal:attemptDelivery:12:ok > line:push") &&
        (r2.body as { delivered: number }).delivered === 1,
    );
    ok(
      "…止まらなかったときと同じ文（物件名入り）",
      withoutToken(w.line.texts[0]) === withoutToken(control.line.texts[0]) &&
        w.line.texts[0].startsWith(
          `#J12 帯替えが完成しました（${CLEAN_PROPERTY}）`,
        ),
    );
  }
  {
    const w = world(doneJob(12));
    await haltOnce(w, "completion-prepared");
    w.portal.takeOver(12);
    const mac = w.portal.job(12).claim!.claimId;
    w.clock.advance(2 * MIN);
    const r = await tick(w);
    ok(
      "完成（prepared で止めた後、Mac が取り直した）：push 0回・控えが消える・Mac の予約に触らない",
      w.line.texts.length === 0 &&
        w.store.rawJob(12) === null &&
        w.portal.job(12).claim?.claimId === mac &&
        w.portal.job(12).status === "納品中" &&
        count(w, "reportDeliveryResult") === 0 &&
        same(r.body, {
          delivered: 0,
          notSent: 0,
          unknown: 0,
          notices: 0,
          seeded: false,
        }),
    );
  }
  {
    const w = world(doneJob(12));
    await haltOnce(w, "completion-attempt-requested");
    w.clock.advance(2 * MIN);
    const r = await tick(w);
    ok(
      "完成（attempt-requested で止めた）：120秒後に attempt をやり直してリンクが1通だけ（unknown にならない）",
      w.line.texts.length === 1 &&
        same(r.body, {
          delivered: 1,
          notSent: 0,
          unknown: 0,
          notices: 0,
          seeded: false,
        }),
    );
  }
  {
    const w = world(doneJob(12));
    await haltOnce(w, "completion-attempting");
    w.clock.advance(2 * MIN);
    const r = await tick(w);
    const res = w.portal.callsOf("reportDeliveryResult")[0].args as Record<
      string,
      unknown
    >;
    ok(
      "完成（attempting で止めた）：120秒後に送り直さず、納品要確認・理由 interrupted",
      w.line.texts.length === 0 &&
        w.portal.job(12).status === "納品要確認" &&
        res.outcome === "unknown" &&
        res.reason === "interrupted" &&
        same(r.body, {
          delivered: 0,
          notSent: 0,
          unknown: 1,
          notices: 0,
          seeded: false,
        }),
    );
  }
  {
    const w = world(rejectJob(4));
    await haltOnce(w, "notice-claimed");
    w.clock.advance(11 * MIN);
    const r = await tick(w);
    ok(
      "知らせ（notice-claimed で止めた）：11分後に取り直して1通だけ",
      w.line.texts.length === 1 &&
        (r.body as { notices: number }).notices === 1,
    );
  }
  {
    const w = world(rejectJob(4));
    await haltOnce(w, "notice-attempting");
    w.clock.advance(11 * MIN);
    await tick(w);
    ok(
      "知らせ（notice-attempting で止めた）：11分後に行が unknown・送り直さない",
      w.line.texts.length === 0 &&
        w.portal.noticeRow(4, "reject", FIXED_GEN)?.state === "unknown",
    );
  }
  {
    const w = world(doneJob(12));
    w.portal.failNext("listJobs", { kind: "throw" });
    const r = await tick(w);
    ok(
      "ほかの例外：錠が外れ、例外は外へ出る",
      r.error === "FakePortalError" && !w.store.lockHeld(),
    );
    ok(
      "ほかの例外：見回りの中ではログを出さない（入口が1行出す）",
      !w.logs.some((l) => l.includes("error")),
    );
  }

  // ---- 完成の設定が無い
  {
    const w = world(doneJob(12), rejectJob(4));
    w.portal.setSeeded(false);
    const missing: CloudCompletionResult = {
      ok: false,
      problems: ["OBI_CLOUD_KID", "OBI_CLOUD_LIFF_ID"],
    };
    const r = await tick(w, { completion: missing });
    ok(
      "完成の設定が無い：completionSkipped・problems（名前だけ）・種まきは進む",
      same(r.body, {
        delivered: 0,
        notSent: 0,
        unknown: 0,
        notices: 0,
        seeded: true,
        completionSkipped: "config",
        problems: ["OBI_CLOUD_KID", "OBI_CLOUD_LIFF_ID"],
      }),
      JSON.stringify(r.body),
    );
    ok(
      "完成の設定が無い：完成の予約0件・ログ",
      count(w, "claimDelivery") === 0 &&
        hasLog(w, "completion-config-missing OBI_CLOUD_KID,OBI_CLOUD_LIFF_ID"),
    );
    w.portal.add(rejectJob(5));
    const r2 = await tick(w, { completion: missing });
    ok(
      "完成の設定が無い：知らせは出る",
      w.line.texts.length === 1 &&
        (r2.body as { notices: number }).notices === 1 &&
        (r2.body as { completionSkipped?: string }).completionSkipped ===
          "config",
    );
  }
  {
    const w = world(doneJob(12));
    await haltOnce(w, "completion-prepared");
    w.clock.advance(2 * MIN);
    const r = await tick(w, {
      completion: { ok: false, problems: ["OBI_CLOUD_SIGNING_KEY"] },
    });
    ok(
      "完成の設定が無い回に prepared の控えが残っている → not_sent・config",
      (r.body as { notSent: number }).notSent === 1 &&
        w.portal.job(12).status === "完成" &&
        w.line.texts.length === 0 &&
        (w.portal.callsOf("reportDeliveryResult")[0].args as { reason: string })
          .reason === "config",
    );
  }

  // ---- portal が 401
  {
    const w = world(doneJob(12), rejectJob(4), failedJob(7));
    w.portal.failNext("listJobs", {
      kind: "rejected",
      status: 401,
      code: "UNAUTHORIZED",
    });
    const r = await tick(w);
    ok(
      "portal が 401（最初の一覧）→ 残りの portal の呼び出しをしない・push 0回・錠は外れる",
      w.portal.calls.length === 1 &&
        w.line.texts.length === 0 &&
        !w.store.lockHeld() &&
        same(r.body, {
          delivered: 0,
          notSent: 0,
          unknown: 0,
          notices: 0,
          seeded: false,
        }),
    );
  }

  // ---- push が断られる・分からない（見回りを通して）
  {
    const w = world(doneJob(12), doneJob(13), choiceJob(4));
    w.line.next("rejected", "unknown");
    const r = await tick(w);
    ok(
      "push が 4xx と分からない：notSent 1・unknown 1・知らせは出る",
      same(r.body, {
        delivered: 0,
        notSent: 1,
        unknown: 1,
        notices: 1,
        seeded: false,
      }),
      JSON.stringify(r.body),
    );
  }
  {
    // 古い控え・形の違う控え・目次だけの番号
    const w = world(doneJob(12));
    w.store.putRaw(30, { v: 2 });
    w.store.orphanIndex(31);
    w.store.putRaw(12, {
      v: 1,
      claimId: "99999999-9999-4999-8999-999999999999",
      sha256: sha("artifact-12"),
      stage: "attempting",
      leaseUntil: new Date(w.clock.now() + 40 * MIN).toISOString(),
      facts: {
        reviewPages: 0,
        outsideErased: 0,
        outsidePages: [],
        fix: null,
        property: CLEAN_PROPERTY,
      },
      at: new Date(w.clock.now() - 5 * MIN).toISOString(),
    });
    const r = await tick(w, { fixGuide: true });
    ok(
      "古い控え・形の違う控えを片付けた後、同じ回に新しい予約で1回配る",
      w.line.texts.length === 1 &&
        (r.body as { delivered: number }).delivered === 1 &&
        hasLog(w, "#J30 memo-invalid") &&
        hasLog(w, "#J12 memo-stale CLAIM_MISMATCH"),
    );
  }
  {
    // 返し先の違う予約・古い portal
    const w = world(doneJob(12));
    w.portal.job(12).replyGroupId = GROUP;
    w.portal.onCall = (op) => {
      if (op === "claimDelivery") w.portal.job(12).replyGroupId = OTHER_GROUP; // 一覧の後に、返し先が変わっていた
    };
    const r = await tick(w);
    ok(
      "予約の応答の返し先が違う → push 0回・not_sent・target",
      w.line.texts.length === 0 &&
        (r.body as { notSent: number }).notSent === 1 &&
        hasLog(w, "#J12 not-sent target"),
    );
  }

  // ---- 時間の予算
  {
    const w = world(doneJob(1), doneJob(2), doneJob(3), rejectJob(4));
    w.portal.onCall = () => w.clock.advance(12_500); // portal の呼び出しごとに 12.5 秒かかる
    await tick(w);
    ok(
      "時間：45秒を過ぎた後は、新しい予約を呼ばない",
      count(w, "claimDelivery") === 1 &&
        w.portal.job(1).status === "納品済み" &&
        w.portal.job(2).status === "完成",
    );
    ok(
      "時間：45秒を過ぎた後は、種まきも知らせの予約も呼ばない",
      count(w, "noticeSeed") === 0 && count(w, "noticeClaim") === 0,
    );
    ok(
      "時間：portal の上限が57秒の線で縮む",
      w.portal.timeouts.join() === "10000,10000,10000,10000,7000",
      w.portal.timeouts.join(),
    );
  }
  {
    const w = world(rejectJob(4), rejectJob(5));
    w.portal.onCall = () => w.clock.advance(8_000);
    await tick(w);
    ok(
      "時間：知らせは30秒の線を過ぎたら、予約（notice/claim）を1回も呼ばない",
      count(w, "noticeClaim") === 0 &&
        count(w, "noticeAttempt") === 0 &&
        w.line.texts.length === 0 &&
        count(w, "listJobs") === 3,
    );
  }
  {
    const w = world(doneJob(12));
    w.portal.onCall = (op) => {
      if (op === "claimDelivery") w.clock.advance(41_000); // 予約に時間がかかり、40秒の線を過ぎた
    };
    await tick(w);
    ok(
      "時間：完成は40秒の線を過ぎたら attempt へ進まない（控えは prepared のまま）",
      count(w, "attemptDelivery") === 0 &&
        w.store.rawJob(12)?.stage === "prepared" &&
        w.line.texts.length === 0,
    );
    w.clock.advance(2 * MIN);
    await tick(w);
    ok(
      "…次の回に再開して1通だけ",
      w.line.texts.length === 1 && w.portal.job(12).status === "納品済み",
    );
  }

  // ---- ログ・控え・応答に、出してはいけない値が出ない（ここまでの全部の場面）
  {
    const logs = worlds.flatMap((w) => w.logs);
    const texts = worlds.flatMap((w) => w.line.texts);
    const secrets = new Set<string>([
      GROUP,
      OTHER_GROUP,
      PORTAL_TOKEN,
      CLEAN_PROPERTY,
      "evil",
      "liff.line.me",
      "使わない",
    ]);
    for (const w of worlds) {
      for (const id of w.line.ids) secrets.add(id);
      for (const id of w.portal.issuedClaimIds) secrets.add(id);
    }
    for (let no = 1; no <= 40; no++) secrets.add(sha(`artifact-${no}`));
    for (const t of texts) {
      const token = tokenOf(t);
      if (token) {
        secrets.add(token);
        secrets.add(token.split(".")[0]);
        secrets.add(token.split(".")[1]);
      }
      for (const line of t.split("\n").slice(1)) secrets.add(line); // 本文の2行目以降
    }
    for (const line of TEST_PRIVATE_PEM.split("\n"))
      if (line && !line.startsWith("-----")) secrets.add(line);
    const list = Array.from(secrets).filter((s) => s.length >= 4);
    const leak = (hay: string) => list.find((s) => hay.includes(s)) ?? null;
    ok(
      "（準備）場面の数と、見ている値の数",
      worlds.length >= 25 &&
        logs.length >= 40 &&
        texts.length >= 30 &&
        list.length >= 100,
      `${worlds.length} ${logs.length} ${texts.length} ${list.length}`,
    );
    ok(
      "ログに、出してはいけない値が出ない",
      leak(logs.join("\n")) === null,
      String(leak(logs.join("\n"))),
    );
    ok(
      "console の出力に、出してはいけない値が出ない",
      leak(consoleOut.join("\n")) === null,
      String(leak(consoleOut.join("\n"))),
    );
    ok(
      "応答に、出してはいけない値が出ない",
      leak(JSON.stringify(bodies)) === null && bodies.length >= 30,
    );
    // 控えは claimId・sha256・messageId と、facts.property の中の整えた物件名を持ってよい。それ以外は④にも無い
    const dumpSecrets = [
      GROUP,
      OTHER_GROUP,
      PORTAL_TOKEN,
      "evil",
      "liff.line.me",
      "使わない",
      ...texts.map(tokenOf).filter(Boolean),
      ...texts.flatMap((t) => t.split("\n").slice(1)),
    ].filter((s) => s.length >= 4);
    const allDumps = dumps.join("\n");
    ok(
      "控えに、生の物件名・本文・リンク・トークン・グループの ID が無い",
      dumpSecrets.every((s) => !allDumps.includes(s)),
    );
    ok(
      "控えの鍵は、約束の6種類だけ",
      dumps.every((d) =>
        Object.keys(
          (JSON.parse(d) as { keys: Record<string, unknown> }).keys,
        ).every((k) =>
          /^obi-cloud:(lock|job:\d+|retry:\d+:[0-9a-f]{64}|notice-msg:\d+:\d+)$/.test(
            k,
          ),
        ),
      ),
    );
    ok(
      "目次の値は、受付番号と <no>:<choiceGen> だけ",
      dumps.every((d) => {
        const sets = (JSON.parse(d) as { sets: Record<string, string[]> }).sets;
        return (
          Object.keys(sets).every(
            (k) => k === "obi-cloud:jobs" || k === "obi-cloud:notice-msgs",
          ) &&
          (sets["obi-cloud:jobs"] ?? []).every((v) => /^\d+$/.test(v)) &&
          (sets["obi-cloud:notice-msgs"] ?? []).every((v) =>
            /^\d+:\d+$/.test(v),
          )
        );
      }),
    );
    const bad = logs.filter(
      (l) => !/^cloud-tick( #J[0-9]+)? [a-z-]+( [A-Za-z0-9_,-]+)*$/.test(l),
    );
    ok(
      "ログの形：全部の行が cloud-tick（#J<番号>）<段> <符号> の形",
      bad.length === 0,
      bad.slice(0, 3).join(" | "),
    );
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error("テストが例外で止まった:", e);
  process.exit(1);
});
