/**
 * グループからの帯替えの受付（設計 2026-10-09 の 9〜15）。
 *
 * 1回の Webhook の中で最後まで行う（同期）：
 *   控えから PDF を選ぶ → LINE から全部取り出す → 同じ中身を1つに →
 *   portal の /api/jobs/intake に1回で送る → 返った一覧を照合 → グループに返事
 *
 * 時間：Webhook の関数は maxDuration = 60。その中に収まるように段階ごとに上限を置く
 *   LINE の取得は1件15秒・全体30秒まで、かつ開始+35秒まで（portal のために10秒は残す）。
 *   portal の段階は開始+45秒までに終える（1回 min(20秒, 開始+45秒−今)、残り5秒未満なら呼ばない）。
 *   その後の返事の段階は、KV の印（NX）3秒・reply 5秒・push 5秒が上限（45+3+5+5＝58秒）。
 *   既存のイベントの予約（3分）より短いので、別の処理が同じ依頼を途中から引き継ぐことはない。
 *
 * 「済み」の境目：portal から受付番号と PDF の一覧が返り、**その一覧が送った PDF と一致した**時点
 * （件数と sha256 の集合。onCommitted）。その後の返事の失敗では受付を取り消さない。
 * 一覧が合わないときは済みにせず「受付を確かめられませんでした」と1回だけ返し、再送を待つ（retry）。
 * portal が `INTAKE_MISMATCH`（409）で断ったときも同じ返事を同じ NX（`obi-unconfirmed-notified:<id>`）で1回だけ
 * 返す（こちらははっきり断られたので済みにする＝retry:false・onCommitted は呼ばない）。NX が既にある・NX が例外のときは送らない。
 * portal の結果が分からないときは「結果不明」として LINE の再送を待つ（retry）。
 * 結果不明の後の呼び直しで portal が断った（OBI_BUSY・INTAKE_STOPPED など）ときも、はっきりした
 * 断りとは扱わず結果不明のままにする（1回目が通っていて、自分の依頼で busy になっているかもしれない）。
 * ただし INTAKE_MISMATCH は「同じ lineMessageId で中身が違う」というはっきりした答えなので、そのまま扱う。
 * portal は1つの依頼につき、1回の Webhook の中で最大2回（最初の1回＋締め切りの中での呼び直し1回）。
 *
 * 返事は依頼1つにつき1回だけ：受付の返事は `obi-accepted-notified:<id>`、結果不明の返事は
 * `obi-pending-notified:<id>`、一覧が合わないときの返事は `obi-unconfirmed-notified:<id>` を
 * NX（期限24時間）で置けたときだけ送る。受付の確定の後に NX が KV の障害で置けないときは、
 * 返事を出さずにログだけ残す（二重を避ける。受付は portal・Discord で見える）。
 * **NX を置いた直後に落ちると、その返事は出ない**（二重に出すよりよい。受付は portal の一覧と
 * Discord で見える）。これは設計で受け入れた動き。
 */
import { deliverReply, type ReplyOutcome } from "../line";
import type { ObiConfig } from "./config";
import {
  OBI_NOTIFY_TTL_SECONDS,
  OBI_WINDOW_MS,
  selectObiPdfs,
  type ObiStore,
} from "./memo";
import { dedupeBySha256, fetchObiPdfs } from "./fetch-pdfs";
import { inputsMatch, postIntake, type IntakeOutcome, type IntakeRequest } from "./portal";
import { propertyFor, requestTextFor, sanitizeForReply } from "./sanitize";

/**
 * 設計 10 の締め切り（開始+55秒）。実際の時間の割り振りは下の段階ごとの上限で行う
 * （portal の段階は開始+45秒まで、その後の返事の段階は最長13秒。合計で maxDuration 60 に収まる）。
 */
export const OBI_DEADLINE_MS = 55_000;
/** portal の段階を終える時刻（開始からの ms）。この後の返事の段階が maxDuration 60 に収まるように */
const PORTAL_PHASE_END_MS = 45_000;
const LINE_FETCH_TOTAL_MS = 30_000;
const PORTAL_RESERVE_MS = 10_000; // 取り出しの段階で portal のために残す時間
const PORTAL_CALL_MS = 20_000;
const REPLY_TIMEOUT_MS = 5_000;
const PUSH_TIMEOUT_MS = 5_000;
const KV_TIMEOUT_MS = 3_000; // 返事の印（NX）を置く時間の上限
const PORTAL_MIN_MS = 5_000; // これより短い残り時間では portal を呼ばない（呼び直さない）
const MAX_PORTAL_ATTEMPTS = 2; // 最初の1回＋呼び直し1回
const REQUESTED_BY = "LINEグループ（営業部）";

export const OBI_MESSAGES = {
  stopped: "いま帯替えの受付を止めています",
  forbidden: "帯替えの依頼は下村さんからお願いします",
  noPdf: "直近30分に PDF がありません。PDF を貼ってからもう一度送ってください",
  tooMany: (count: number) =>
    `直近30分の PDF が${count}件あり、上限（20件・合計25MB）を超えるため受付できませんでした（1件も使っていません）。PDF を減らしてからもう一度送ってください`,
  tooLarge:
    "直近30分の PDF の合計が上限（20件・合計25MB）を超えるため受付できませんでした（1件も使っていません）。PDF を減らしてからもう一度送ってください",
  fetchFailed: (name: string) =>
    `受付できませんでした（${name} を取り出せません）。貼り直してからもう一度送ってください`,
  notPdf: (name: string) =>
    `受付できませんでした（${name} は PDF として読めません）。貼り直してからもう一度送ってください`,
  timeUp: "受付できませんでした（PDF の取り出しに時間がかかりました）。少し待ってからもう一度送ってください",
  noTimestamp: "受付できませんでした（依頼の時刻が分かりません）。もう一度送ってください",
  busy: (no?: number) =>
    no
      ? `前の帯替え（#J${no}）を処理中です。終わってからもう一度送ってください`
      : "前の帯替えを処理中です。終わってからもう一度送ってください",
  unreachable: "受付できませんでした（portal に届きません）。少し待ってからもう一度送ってください",
  rejected: (code: string) => `受付できませんでした（${code}）。portal の一覧を確かめてください`,
  pending:
    "受付の結果を確かめています。同じ依頼をもう一度送らないでください。結果は Discord の AI会社か portal の一覧で確かめられます",
  accepted: (no: number, property: string, names: string[]) => {
    const files = names.length > 1 ? `${names[0]} ほか${names.length - 1}件` : names[0];
    return `#J${no} 受付しました（物件：${property}／PDF：${files}）。完成したらここにリンクを出します`;
  },
  unconfirmed:
    "受付を確かめられませんでした（portal に入った PDF が送ったものと合いません）。同じ依頼はもう一度送らず、portal の一覧を確かめてください",
};

export interface ObiIntakeInput {
  requestMessageId: string; // 依頼の LINE message.id（数字の文字列）
  /** 依頼の LINE イベントの時刻（ms）。無い・不正なら受付けない（今の時刻で代わりにしない） */
  requestTimestamp: number | undefined;
  groupId: string; // 営業部（config.groupId と同じ）
  requestText: string; // 依頼の本文（そのまま。portal の requestText に入れる）
  property: string; // parseJobCommand の property（空のこともある）。「担当:」は portal に渡さないので持たない
  startedAt: number; // Webhook の開始時刻（ms）
  config: ObiConfig;
}

export interface ObiIntakeDeps {
  store: ObiStore;
  fetchImpl: typeof fetch;
  lineToken: string;
  now: () => number;
  /** 依頼への reply（結果を3つに分けて返す。例外は投げない作り）。timeoutMs で打ち切る */
  reply: (text: string, timeoutMs: number) => Promise<ReplyOutcome>;
  /** reply がはっきり断られたときの push（送れたら true）。timeoutMs で打ち切る */
  push: (to: string, text: string, timeoutMs: number) => Promise<boolean>;
  /** portal で受付が確定し、一覧も一致した（以後は再送させない） */
  onCommitted: () => void;
  /** 返事の印（NX）を置く時間の上限（ms）。省略時は3秒。テストで短くする */
  kvTimeoutMs?: number;
}

export interface ObiIntakeResult {
  /** unconfirmed＝portal は受付番号を返したが、一覧が送った PDF と合わない（済みにしない） */
  outcome: "accepted" | "refused" | "pending" | "unconfirmed";
  /** true なら Webhook はこのイベントを済みにせず、5xx で LINE の再送を待つ */
  retry: boolean;
}

/**
 * 返事の印（NX）を時間の上限つきで置く。上限を過ぎたら例外（KV の障害と同じ扱い）。
 * ObiStore.setNx は打ち切りの手段を持たないので、待つのをやめるだけ（KV への書込み自体は
 * 後で通るかもしれない。そのときは返事が出ないだけで、二重にはならない）。
 */
async function setNxBounded(deps: ObiIntakeDeps, key: string): Promise<boolean> {
  const ms = deps.kvTimeoutMs ?? KV_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      deps.store.setNx(key, OBI_NOTIFY_TTL_SECONDS),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`KV の印が${ms}ms で返らない`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function rejectionMessage(o: Extract<IntakeOutcome, { kind: "rejected" }>): string {
  if (o.code === "OBI_BUSY") return OBI_MESSAGES.busy(o.busyJobNo);
  if (o.code === "INTAKE_STOPPED") return OBI_MESSAGES.stopped;
  if (o.code === "INPUT_TOO_LARGE") return OBI_MESSAGES.tooLarge;
  return OBI_MESSAGES.rejected(sanitizeForReply(o.code));
}

/**
 * 「受付を確かめられませんでした」を依頼1つにつき1回だけ送る（一覧が合わないとき・portal の
 * INTAKE_MISMATCH の両方がここを通る）。NX が既にあれば送らない。NX が例外（KV の障害）でも
 * 送らない（二重を避ける。返事が出ないだけ。例外は呼び出し側へ投げない）。
 */
async function notifyUnconfirmedOnce(
  input: ObiIntakeInput,
  deps: ObiIntakeDeps,
  say: (text: string) => Promise<unknown>
): Promise<void> {
  let first: boolean;
  try {
    first = await setNxBounded(deps, `obi-unconfirmed-notified:${input.requestMessageId}`);
  } catch (err) {
    console.error(
      "帯替え：確かめられない返事の印を置けない（返事は出さない）:",
      input.requestMessageId,
      (err as Error)?.message ?? err
    );
    return;
  }
  if (first) await say(OBI_MESSAGES.unconfirmed);
}

export async function runObiIntake(
  input: ObiIntakeInput,
  deps: ObiIntakeDeps
): Promise<ObiIntakeResult> {
  const portalPhaseEnd = input.startedAt + PORTAL_PHASE_END_MS;
  const say = (text: string) =>
    deliverReply(text, {
      reply: (t) => deps.reply(t, REPLY_TIMEOUT_MS),
      push: (t) => deps.push(input.groupId, t, PUSH_TIMEOUT_MS),
    });
  const refuse = async (text: string): Promise<ObiIntakeResult> => {
    await say(text);
    return { outcome: "refused", retry: false };
  };

  if (!/^\d{1,64}$/.test(input.requestMessageId)) {
    return refuse(OBI_MESSAGES.rejected("INVALID_REQUEST"));
  }
  // 依頼の時刻が無いと「30分以内」を決められない。今の時刻で代わりにしない（再送で窓がずれるため）
  const requestTimestamp = input.requestTimestamp;
  if (
    typeof requestTimestamp !== "number" ||
    !Number.isSafeInteger(requestTimestamp) ||
    requestTimestamp <= 0
  ) {
    return refuse(OBI_MESSAGES.noTimestamp);
  }

  // ① 控えから選ぶ（依頼の時刻から30分以内・依頼より前）
  const records = await deps.store.listPdfs(
    input.groupId,
    requestTimestamp - OBI_WINDOW_MS,
    requestTimestamp
  );
  const sel = selectObiPdfs(records, {
    messageId: input.requestMessageId,
    timestamp: requestTimestamp,
  });
  if (sel.kind === "none") return refuse(OBI_MESSAGES.noPdf);
  if (sel.kind === "too-many") return refuse(OBI_MESSAGES.tooMany(sel.count));
  if (sel.kind === "too-large") return refuse(OBI_MESSAGES.tooLarge);

  // ② LINE から全部取り出す。1件でもだめならやめる
  const fetched = await fetchObiPdfs(sel.pdfs, {
    fetchImpl: deps.fetchImpl,
    lineToken: deps.lineToken,
    now: deps.now,
    deadline: Math.min(deps.now() + LINE_FETCH_TOTAL_MS, portalPhaseEnd - PORTAL_RESERVE_MS),
  });
  if (fetched.kind === "too-large") return refuse(OBI_MESSAGES.tooLarge);
  if (fetched.kind === "failed") {
    const name = sanitizeForReply(fetched.fileName);
    return refuse(
      fetched.reason === "not-pdf" ? OBI_MESSAGES.notPdf(name) : OBI_MESSAGES.fetchFailed(name)
    );
  }
  // 同じ中身は1つに（先に出たものを残す）。この一覧を正本として送る・照合する・返事に書く
  const files = dedupeBySha256(fetched.files);
  const property = propertyFor(input.property, files[0].fileName);
  const request: IntakeRequest = {
    lineMessageId: input.requestMessageId,
    property,
    requestText: requestTextFor(input.requestText), // UTF-16 の1000ユニットまで（P1 と同じ数え方）
    requestedBy: REQUESTED_BY,
    replyGroupId: input.config.groupId,
    files: files.map((f) => ({ fileName: f.fileName, bytes: f.bytes })),
  };

  // ③ portal へ1回で送る。結果が分からなければ、開始+45秒までの中で同じ内容をもう1回だけ（同じ
  //    lineMessageId なので portal 側で二重にならない）。呼ぶのは最大2回。1回の時間は
  //    min(20秒, 開始+45秒−今) なので、portal の段階は開始+45秒を越えない
  let outcome: IntakeOutcome | null = null;
  let sawUnknown = false;
  for (let i = 0; i < MAX_PORTAL_ATTEMPTS; i++) {
    const remaining = portalPhaseEnd - deps.now();
    if (remaining < PORTAL_MIN_MS) break;
    outcome = await postIntake(request, {
      fetchImpl: deps.fetchImpl,
      baseUrl: input.config.portalBaseUrl,
      token: input.config.jobApiToken,
      timeoutMs: Math.min(PORTAL_CALL_MS, remaining),
    });
    if (outcome.kind === "unknown") {
      sawUnknown = true;
      continue;
    }
    // unknown 以外は呼び直さない。unknown の後の「つながらない」も、ここでやめて下で結果不明として
    // 扱う（前の呼び出しが届いたか分からないので、受付できなかったとは言えない）
    break;
  }
  // 一度も送っていない＝portal に受付は無い
  if (outcome === null) return refuse(OBI_MESSAGES.timeUp);
  // 2回目を呼ぶ時間が無かったときは outcome が1回目の unknown のまま残る＝下の結果不明へ

  if (outcome.kind === "accepted") {
    // 一覧が送った PDF と合わなければ済みにしない（受付の返事も出さない）。
    // 「確かめられませんでした」を1回だけ返し、再送を待つ
    if (!inputsMatch(files, outcome.inputs)) {
      console.error("帯替え：portal の一覧が送った PDF と合わない:", outcome.no);
      await notifyUnconfirmedOnce(input, deps, say);
      return { outcome: "unconfirmed", retry: true };
    }
    deps.onCommitted();
    let first: boolean;
    try {
      first = await setNxBounded(deps, `obi-accepted-notified:${input.requestMessageId}`);
    } catch (err) {
      // 受付は確定済み。印が置けないまま送ると二重になりうるので、返事は出さずにログだけ
      console.error(
        "帯替え：受付の返事の印を置けない（返事は出さない）:",
        input.requestMessageId,
        (err as Error)?.message ?? err
      );
      return { outcome: "accepted", retry: false };
    }
    if (first) {
      await say(
        OBI_MESSAGES.accepted(
          outcome.no,
          sanitizeForReply(property),
          files.map((f) => sanitizeForReply(f.fileName))
        )
      );
    }
    return { outcome: "accepted", retry: false };
  }
  if (outcome.kind === "rejected") {
    // portal の INTAKE_MISMATCH は「はっきりした断り」：済みにする（retry:false）・onCommitted は呼ばない。
    // 返事は一覧が合わないときと同じ NX を通す（直接 refuse() で送ると、LINE の再送などで二重になる）
    if (outcome.code === "INTAKE_MISMATCH") {
      await notifyUnconfirmedOnce(input, deps, say);
      return { outcome: "refused", retry: false };
    }
    // 結果不明の後の断りは、はっきりした断りとは言えない（1回目が通っていて、OBI_BUSY が
    // 自分の依頼のことかもしれない）。下の結果不明へ
    if (!sawUnknown) return refuse(rejectionMessage(outcome));
  }
  if (outcome.kind === "unreachable" && !sawUnknown) return refuse(OBI_MESSAGES.unreachable);

  // ④ 結果不明：受付できなかったとは言わない。返事は1回だけにして、LINE の再送を待つ
  console.error("帯替え：portal の受付の結果が分からない:", input.requestMessageId);
  // 印が置けない（例外・時間切れ）ときは例外のまま外へ（受付は確定していないので再送を待ってよい）
  if (await setNxBounded(deps, `obi-pending-notified:${input.requestMessageId}`)) {
    await say(OBI_MESSAGES.pending);
  }
  return { outcome: "pending", retry: true };
}
