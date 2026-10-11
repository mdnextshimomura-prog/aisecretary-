/**
 * 帯替えの完成リンクへの「番号で直す」（設計 2026-10-10 の E11・E12・「流れ」・「文」・「うまくいかないとき」）。
 *
 * 2段に分ける。呼ぶのは webhook-event.ts。
 *   locateObiFix … どの依頼への返事かを決める（イベントの予約より前。portal は何も書き換えない）
 *     - #J つき           ：その番号（portal は呼ばない）
 *     - 聞き返しへの引用   ：KV の `obi-fix-askmsg:<引用先の id>` → 受付番号（portal は呼ばない）
 *     - 完成の知らせへの引用：portal の resolve（quotedMessageId）。NOT_FOUND なら訂正として扱わない
 *     - 引用先を確かめられない：返事も予約もせず、初回から今までの流れへ（LINE の Webhook の再送は本番で無効。Z3）
 *   runObiFix … 認可 → resolve（まだなら）→ 聞き返し／fix → 返事
 *
 * 認可は呼ぶ側が済ませ、ここには「許可されたか」の真偽だけが来る（userId は受け取らない。
 * portal・KV・ログ・返事のどこにも出さない）。許可されていなければ fix は呼ばない。
 *
 * portal を呼ぶのは1通につき resolve 1回＋fix 1回まで。同じ Webhook の中での呼び直しはしない。
 * 時間（Webhook の開始から25秒）：KV は1回1秒、resolve 6秒、fix 8秒、reply 4秒、push 4秒。
 *   返事より前の段階（KV・resolve・fix・返事の印）は開始+17秒までに終える。
 *   fix の時間は min(8秒, 開始+17秒−今−返事の印の1秒)。2秒に満たなければ fix を呼ばない。
 *
 * resolve の見込み（fixable・closable・current）は、fix を呼ばないとき（聞き返し・完成品がまだ無い＝sha256 が空文字）の案内にだけ使う。
 * ページまで揃った訂正は、見込みに関わらず fix を呼び、portal の答えで返事を決める
 * （fix は同じ message.id を先に照合するので、同じ発言がもう一度届いても最初の結果が返る。Z11）。
 *
 * 返事は1通につき1回：`obi-fix-replied:<id>`（結果不明は `obi-fix-pending-notified:<id>`、
 * 断りは `obi-fix-forbidden:<id>`）を NX で置けたときだけ送る。聞き返しは依頼ごとに1回
 * （`obi-fix-ask:<受付番号>`）。印が置けない・読めないときは返事をしない。かぎの期限はどれも8日。
 * 聞き返しの印は送る前に置くので、届いていないことが確か（reply も push もはっきり断られた）なときだけ消す
 * （次の機会に聞き返せるように。届いたかどうか分からないときは消さない＝二重に出さない側）。
 *
 * LINE の Webhook の再送は本番で無効。どの場面でも「503 を返して、同じ発言がもう一度届くのを待つ」ことはしない（AA1）。
 *   fix を呼んだ後、はっきりした答え（受け付けた・はっきり断った）が無く、届いたかどうかも分からない
 *     （時間切れ・応答の途中の切断・5xx・形の違う応答）：結果不明。「受付の結果を確かめられませんでした…
 *     同じ番号をもう一度送らないでください」を1回返して済みにする（人が送り直すと message.id が変わり、
 *     portal の冪等では二重の訂正を防げないので、「もう一度送ってください」とは言わない）
 *   fix を呼ぶ前の失敗（resolve が届かない・時間が足りない）と、fix を呼んだが送っていないことが確かな失敗
 *     （postFix の unreachable＝ECONNREFUSED・ENOTFOUND・EAI_AGAIN。AB1）：何も変わっていないのが確かなので
 *     「…portal に届きません。少し待ってからもう一度送ってください」を返して済みにする（送り直しても二重にならない）
 *
 * ログに出すのは、処理の段階・受付番号（#J）・番号・ページ・結果の code・返事の結果だけ。
 * message.id・userId・groupId・本文・リンク・例外の文は出さない（AA4。例外は名前だけ）。
 */
import { deliverReply, type ReplyDelivery, type ReplyOutcome } from "../line";
import type { ObiConfig } from "./config";
import type { FixBody, FixCode } from "./fix-parse";
import { OBI_MESSAGES } from "./intake";
import { OBI_FIX_KEY_TTL_SECONDS, type ObiStore } from "./memo";
import { postFix, postFixResolve, type FixEstimate, type FixOutcome, type FixResolved } from "./portal";
import { sanitizeForReply } from "./sanitize";

/** Webhook の開始からの締め切り */
export const OBI_FIX_DEADLINE_MS = 25_000;
/** 返事より前の段階（KV・resolve・fix・返事の印）を終える時刻（開始からの ms） */
export const OBI_FIX_PORTAL_PHASE_END_MS = 17_000;
/**
 * これより遅く始まる訂正は、portal を呼ばない（同じ Webhook に先の処理があったとき。Z11）。
 * LINE の Webhook の再送は本番で無効なので、503 で戻ってくるのを当てにしない（Z3）：
 * 引用の形は今までの流れへ渡し、#J つきは「portal に届きません…」を1通につき1回返して済みにする。
 * 17秒 −（KV 1秒＋resolve 6秒＋fix の最小 2秒＋返事の印 1秒）
 */
export const OBI_FIX_LATE_START_MS = 7_000;
// 下の4つと kvBounded・sayOnce・portalOpts・errName・Said・unknownTarget は、差し戻しの対応の選択（reject.ts）も使う（同じ時間の予算・同じ返事の印）
export const KV_OP_MS = 1_000;
export const RESOLVE_MS = 6_000;
export const FIX_MS = 8_000;
export const FIX_MIN_MS = 2_000;
const REPLY_TIMEOUT_MS = 4_000;
const PUSH_TIMEOUT_MS = 4_000;
const PAGE_MIN = 1;
const PAGE_MAX = 120;

const CODE_LABEL: Record<FixCode, string> = {
  0: "問題なし",
  1: "帯の位置",
  2: "他社の文字",
  3: "向き",
  4: "順番",
  5: "その他",
};

/** 「（3ページ・帯の位置）」。ページが無ければ「（順番）」 */
function what(code: FixCode, page: number | null): string {
  return page === null ? `（${CODE_LABEL[code]}）` : `（${page}ページ・${CODE_LABEL[code]}）`;
}

export const OBI_FIX_MESSAGES = {
  closed: (no: number) => `ありがとうございます。#J${no} を完了にしました`,
  queued: (no: number, code: FixCode, page: number) =>
    `#J${no} の直しを受け付けました${what(code, page)}。直せたら、ここに新しいリンクを出します`,
  queuedUpsideDown: (no: number, page: number) =>
    `#J${no} の直しを受け付けました${what(3, page)}。逆さ（180度）として直します。右に90度なら「${page}ページ 3右」、左に90度なら「${page}ページ 3左」と返信してください`,
  human: (no: number, code: FixCode, page: number | null) => `#J${no} 担当が確認します${what(code, page)}`,
  humanLimit: (no: number) => `#J${no} は自動の直しが3回になりました。担当が確認します`,
  humanRepeat: (no: number, page: number) =>
    `#J${no} の${page}ページは帯の位置を一度直しています。担当が確認します`,
  humanAlreadyStandard: (no: number, page: number) =>
    `#J${no} の${page}ページの帯は、すでに標準の位置にあります。担当が確認します`,
  askPage: (no: number) => `何ページ目ですか？ 例：3ページ 2（#J${no}。この知らせに返信してください）`,
  notFound: (no: number) => `#J${no} は見つかりません。番号を確かめてもう一度送ってください`,
  badPage: (no: number, page: number, pageCount: number) =>
    pageCount > 0
      ? `#J${no} に${page}ページはありません（全部で${pageCount}ページです）。ページを確かめてもう一度送ってください`
      : `#J${no} に${page}ページはありません。ページを確かめてもう一度送ってください`,
  stale: (no: number) => `#J${no} には新しい完成の知らせがあります。いちばん新しい知らせに返信してください`,
  notReady: (no: number) => `#J${no} はいま処理中です。少し待ってからもう一度送ってください`,
  alreadyClosed: (no: number) => `#J${no} は完了にしてあります。直すときは、もう一度依頼してください`,
  expired: "期限（7日）を過ぎたので直せません。もう一度依頼してください",
  unavailable: (no: number) => `#J${no} は番号では直せません。担当に声をかけてください`,
  rejected: (code: string) => `訂正を受け付けられませんでした（${code}）。担当に声をかけてください`,
  unreachable: "訂正を受け付けられませんでした（portal に届きません）。少し待ってからもう一度送ってください",
  /** fix の結果が分からない。「もう一度送ってください」とは書かない（送り直すと二重の訂正になりうる） */
  unknown:
    "受付の結果を確かめられませんでした。届く知らせか portal の依頼ボックスで確かめてください。同じ番号をもう一度送らないでください",
};

export interface ObiFixInput {
  /** 訂正の発言の LINE message.id（数字の文字列）。冪等のかぎ・返事の印のかぎ。ログには出さない */
  messageId: string;
  body: FixBody;
  /** 引用リプライの引用先（無ければ null） */
  quotedMessageId: string | null;
  /** 発言者が JOB_ALLOWED_USER_IDS にいるか（照合は呼ぶ側。userId そのものは渡さない） */
  allowed: boolean;
  /** Webhook の開始時刻（ms） */
  startedAt: number;
  config: ObiConfig;
  /** true なら、始まるのが遅すぎた（開始+7秒より後）。認可の後、portal を呼ばずに「届きません」を返す */
  late?: boolean;
}

export interface ObiFixDeps {
  store: ObiStore;
  fetchImpl: typeof fetch;
  now: () => number;
  /** 訂正の発言への reply（例外は投げない作り）。timeoutMs で打ち切る */
  reply: (text: string, timeoutMs: number) => Promise<ReplyOutcome>;
  /**
   * reply がはっきり断られたときの push。送ったメッセージの ID も返す（例外は投げない作り）。
   * rejected: true は「はっきり断られた（4xx）＝届いていないことが確か」のときだけ（時間切れ・通信の失敗・5xx には付けない）
   */
  push: (
    to: string,
    text: string,
    timeoutMs: number
  ) => Promise<{ ok: boolean; messageId: string | null; rejected?: boolean }>;
  /** KV の1回の操作の時間の上限（ms）。省略時は1秒。テストで短くする */
  kvTimeoutMs?: number;
}

export type FixTarget =
  /** 訂正として扱わない（今までの流れへ）。引用先を確かめられなかったときもここ（Z3） */
  | { kind: "rest"; reason: string }
  | {
      kind: "target";
      /** number＝#J つき／ask＝聞き返しへの引用／notice＝完成の知らせへの引用 */
      via: "number" | "ask" | "notice";
      no: number;
      /** notice のときだけ、もう引いてある（runObiFix は resolve を呼び直さない） */
      resolved: FixResolved | null;
    };

export interface ObiFixResult {
  outcome:
    | "closed"
    | "queued"
    | "human"
    | "asked"
    | "ask-suppressed"
    /** 聞き返しが届いていないことが確か（reply も push もはっきり断られた）。依頼ごとの印は消した（消せなければ残る） */
    | "ask-failed"
    | "forbidden"
    | "refused"
    /** fix を呼んだが、結果が分からない（「確かめられませんでした」を1回返した） */
    | "unknown";
}

/** runObiFix が呼ぶ側へ段階を知らせる（例外で止まったときの扱いを、呼ぶ側が決めるため） */
export interface ObiFixStageHooks {
  /** portal の fix を呼ぶ直前。これより前の例外は「何も変わっていない」のが確か */
  onFixCalled: () => void;
  /** portal の fix の結果が確かになった（受け付けた・はっきり断った・送っていないことが確か＝unreachable。AB1） */
  onCommitted: () => void;
}

/** KV の操作を時間の上限つきで待つ（上限を過ぎたら例外）。until（時刻）を越えては待たない */
export async function kvBounded<T>(deps: ObiFixDeps, until: number, op: () => Promise<T>): Promise<T> {
  const ms = Math.min(deps.kvTimeoutMs ?? KV_OP_MS, until - deps.now());
  if (ms <= 0) throw new Error("KV を待つ時間が残っていない");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`KV が${ms}ms で返らない`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 例外はログに名前だけを出す（文には、かぎ＝message.id などが入りうる） */
export const errName = (err: unknown) => (err as { name?: string })?.name ?? "error";

export function portalOpts(input: Pick<ObiFixInput, "config">, deps: ObiFixDeps, timeoutMs: number) {
  return {
    fetchImpl: deps.fetchImpl,
    baseUrl: input.config.portalBaseUrl,
    token: input.config.jobApiToken,
    timeoutMs,
  };
}

/**
 * reply → はっきり断られたときだけ push。送れたメッセージの ID も返す（結果不明は送り直さない）。
 * undelivered：届いていないことが確か（reply がはっきり断られ、push もはっきり断られた）。
 *   時間切れ・通信の失敗・5xx は「届いたかどうか分からない」ので false のまま
 */
async function send(groupId: string, deps: ObiFixDeps, text: string): Promise<Said> {
  let sentId: string | null = null;
  let pushRejected = false;
  const delivery = await deliverReply(text, {
    reply: async (t) => {
      const r = await deps.reply(t, REPLY_TIMEOUT_MS);
      if (r.kind === "sent") sentId = r.messageId;
      return r;
    },
    push: async (t) => {
      const p = await deps.push(groupId, t, PUSH_TIMEOUT_MS);
      if (p.ok) sentId = p.messageId;
      else pushRejected = p.rejected === true;
      return p.ok;
    },
  });
  return { delivery, sentId, undelivered: delivery === "push-failed" && pushRejected };
}

export type Said = { delivery: ReplyDelivery | "skipped"; sentId: string | null; undelivered: boolean };

/**
 * 印（NX・8日）を置けたときだけ送る。既にある・置けない（KV の障害・時間切れ）ときは送らない
 * （二重の返事を避ける。例外は外へ投げない）。
 */
export async function sayOnce(
  input: { messageId: string; startedAt: number },
  groupId: string,
  deps: ObiFixDeps,
  key: string,
  text: string
): Promise<Said> {
  let first: boolean;
  try {
    first = await kvBounded(deps, input.startedAt + OBI_FIX_PORTAL_PHASE_END_MS, () =>
      deps.store.setNx(key, OBI_FIX_KEY_TTL_SECONDS)
    );
  } catch (err) {
    console.error("帯替えの訂正：返事の印を置けない（返事は出さない）:", errName(err));
    return { delivery: "skipped", sentId: null, undelivered: false };
  }
  if (!first) return { delivery: "skipped", sentId: null, undelivered: false };
  return send(groupId, deps, text);
}

/**
 * 設定が足りないとき（#J つきの営業部の発言にだけ）：「いま帯替えの受付を止めています」を1回だけ返す。
 * 許可リストも読めないので、人の確認より先にこれを返す。portal は呼ばない。
 */
export async function replyObiFixStopped(
  input: { messageId: string; groupId: string; startedAt: number },
  deps: ObiFixDeps
): Promise<void> {
  const said = await sayOnce(input, input.groupId, deps, `obi-fix-replied:${input.messageId}`, OBI_MESSAGES.stopped);
  console.log("帯替えの訂正:", "stopped", said.delivery);
}

/**
 * 引用先を確かめられない（KV の照会の失敗・resolve の時間切れ・つながらない・5xx・形の違う 200）。
 * LINE の Webhook の再送は本番で無効なので、503 で待たず、初回から今までの流れへ渡す（返事も予約もしない。Z3）。
 * 帯替えの知らせへの引用だったとしても、ここでは訂正として扱われない（「#J12 3ページ 2」の形なら通る）
 */
export function unknownTarget(why: string): FixTarget {
  console.error("帯替えの訂正：引用先を確かめられない（今までの流れへ）:", why);
  return { kind: "rest", reason: "resolve-unknown" };
}

/**
 * どの依頼への返事かを決める（イベントの予約より前に呼ぶ）。
 * 認可はここでは見ない（引用先が帯替えの知らせかどうかが分かるまで「訂正」と決められないため）。
 */
export async function locateObiFix(input: ObiFixInput, deps: ObiFixDeps): Promise<FixTarget> {
  // #J つき：その場で訂正として扱う（portal も KV も呼ばない。認可が先）
  if (input.body.no !== null) {
    return { kind: "target", via: "number", no: input.body.no, resolved: null };
  }
  // #J なし・引用なしは訂正として扱わない
  const quoted = input.quotedMessageId;
  if (!quoted || !/^\d{1,64}$/.test(quoted)) return { kind: "rest", reason: "no-quote" };
  const phaseEnd = input.startedAt + OBI_FIX_PORTAL_PHASE_END_MS;

  // ① 自分が出した聞き返しへの引用か
  let asked: string | null;
  try {
    asked = await kvBounded(deps, phaseEnd, () => deps.store.getText(`obi-fix-askmsg:${quoted}`));
  } catch (err) {
    return unknownTarget(`askmsg:${errName(err)}`);
  }
  const m = asked?.match(/^J(\d{1,6})$/);
  if (m) return { kind: "target", via: "ask", no: Number(m[1]), resolved: null };

  // ② 完成の知らせへの引用か（portal に聞く。何も書き換えない）
  const timeoutMs = Math.min(RESOLVE_MS, phaseEnd - deps.now());
  if (timeoutMs <= 0) return unknownTarget("no-time");
  const r = await postFixResolve(
    { groupId: input.config.groupId, quotedMessageId: quoted },
    portalOpts(input, deps, timeoutMs)
  );
  if (r.kind === "accepted") {
    // 「番号で直す」が受けるのは、完成の知らせ（kind が "completion"。項目の無い portal は ""）への引用だけ。
    // ほかの種類の知らせ（差し戻しの選択肢の設計 2026-10-11 の "reject"・"review" など。いまの portal は返さない）への引用は、
    // 訂正として扱わない（返事をせず今までの流れへ。その番号を訂正の番号と読み違えないため。約束の P1・P4）
    if (r.resolved.kind !== "" && r.resolved.kind !== "completion") {
      console.log("帯替えの訂正：引用先が完成の知らせではない（今までの流れへ）:", sanitizeForReply(r.resolved.kind));
      return { kind: "rest", reason: "notice-kind" };
    }
    return { kind: "target", via: "notice", no: r.resolved.no, resolved: r.resolved };
  }
  if (r.kind === "rejected") {
    // NOT_FOUND＝タスクの確認・リマインドなど別のものへの引用。それ以外の断り（FIX_DISABLED など）も、
    // 「帯替えの完成の知らせ」と確かめられていないので、訂正として扱わない
    if (r.code !== "NOT_FOUND") console.error("帯替えの訂正：引用先を引けない（今までの流れへ）:", sanitizeForReply(r.code));
    return { kind: "rest", reason: r.code };
  }
  return unknownTarget(r.kind === "unknown" ? r.reason : "unreachable");
}

/** resolve の見込み（ok 以外）→ 文。fix の同じ意味の code と同じ文にする */
function estimateMessage(no: number, e: Exclude<FixEstimate, "ok">): string {
  if (e === "closed") return OBI_FIX_MESSAGES.alreadyClosed(no);
  if (e === "expired") return OBI_FIX_MESSAGES.expired;
  if (e === "not-ready") return OBI_FIX_MESSAGES.notReady(no);
  return OBI_FIX_MESSAGES.unavailable(no);
}

/** portal の断り（resolve・fix）→ 文 */
function rejectionMessage(
  no: number,
  page: number | null,
  o: { code: string; busyJobNo?: number; pageCount?: number }
): string {
  switch (o.code) {
    case "FIX_DISABLED":
    case "INTAKE_STOPPED":
      return OBI_MESSAGES.stopped;
    case "NOT_FOUND":
      return OBI_FIX_MESSAGES.notFound(no);
    case "FIX_BAD_PAGE":
      return page === null
        ? OBI_FIX_MESSAGES.rejected("FIX_BAD_PAGE")
        : OBI_FIX_MESSAGES.badPage(no, page, o.pageCount ?? 0);
    case "FIX_STALE":
      return OBI_FIX_MESSAGES.stale(no);
    case "FIX_NOT_READY":
      return OBI_FIX_MESSAGES.notReady(no);
    case "FIX_CLOSED":
      return OBI_FIX_MESSAGES.alreadyClosed(no);
    case "FIX_EXPIRED":
      return OBI_FIX_MESSAGES.expired;
    case "FIX_UNAVAILABLE":
      return OBI_FIX_MESSAGES.unavailable(no);
    case "OBI_BUSY":
      return OBI_MESSAGES.busy(o.busyJobNo);
    default:
      return OBI_FIX_MESSAGES.rejected(sanitizeForReply(o.code));
  }
}

/** fix が受け付けた結果 → 文 */
function acceptedMessage(
  no: number,
  body: FixBody,
  o: Extract<FixOutcome, { kind: "accepted" }>
): string {
  const { code, page, turn } = body;
  if (o.result === "closed") return OBI_FIX_MESSAGES.closed(no);
  if (o.result === "queued" && page !== null) {
    return code === 3 && turn === ""
      ? OBI_FIX_MESSAGES.queuedUpsideDown(no, page)
      : OBI_FIX_MESSAGES.queued(no, code, page);
  }
  if (o.reason === "limit") return OBI_FIX_MESSAGES.humanLimit(no);
  if (o.reason === "repeat" && page !== null) return OBI_FIX_MESSAGES.humanRepeat(no, page);
  if (o.reason === "already-standard" && page !== null) return OBI_FIX_MESSAGES.humanAlreadyStandard(no, page);
  return OBI_FIX_MESSAGES.human(no, code, page);
}

/**
 * 訂正と決まったイベントを最後まで扱う（イベントの予約の中で呼ぶ）。
 * どの結果でも、呼ぶ側はイベントを済みにする（やり直さない。503 にしない）。
 * onFixCalled：portal の fix を呼ぶ直前／onCommitted：fix の結果が確かになった（送っていないことが確か、を含む。AB1）。
 * 例外で止まったときの扱い（replyObiFixInterrupted）を、呼ぶ側がこの2つで決める。
 */
export async function runObiFix(
  input: ObiFixInput,
  target: Extract<FixTarget, { kind: "target" }>,
  deps: ObiFixDeps & ObiFixStageHooks
): Promise<ObiFixResult> {
  const { messageId } = input;
  const groupId = input.config.groupId;
  const no = target.no;
  const { code, page, turn } = input.body;
  const phaseEnd = input.startedAt + OBI_FIX_PORTAL_PHASE_END_MS;
  const repliedKey = `obi-fix-replied:${messageId}`;
  const log = (result: string, said: Said) =>
    console.log("帯替えの訂正:", `#J${no}`, `code=${code}`, `page=${page ?? "-"}`, result, said.delivery);
  const refuse = async (result: string, text: string): Promise<ObiFixResult> => {
    log(result, await sayOnce(input, groupId, deps, repliedKey, text));
    return { outcome: "refused" };
  };

  // 認可（0 も同じ）。許可されていなければ、ここから先の portal は呼ばない
  if (!input.allowed) {
    log("forbidden", await sayOnce(input, groupId, deps, `obi-fix-forbidden:${messageId}`, OBI_MESSAGES.fixForbidden));
    return { outcome: "forbidden" };
  }

  // #J0：受付番号は1以上なので、無い番号（portal は no が 0 だと形の違いで断るだけ）。portal を呼ばずに、
  //   約束の NOT_FOUND と同じ文を返す。文法（fix-parse.ts・共有の表）は変えず、no=0 と読んだものをここで受ける
  if (no === 0) return refuse("NOT_FOUND", OBI_FIX_MESSAGES.notFound(no));

  // 遅く始まった訂正（#J つきだけがここに来る）：portal を呼ぶ時間が無い。fix は呼んでいないので、「届きません…もう一度送ってください」を返して済みにする（AA1）
  if (input.late) return refuse("late-start", OBI_FIX_MESSAGES.unreachable);

  // resolve（完成の知らせへの引用は、もう引いてある）
  let resolved = target.resolved;
  if (!resolved) {
    const timeoutMs = Math.min(RESOLVE_MS, phaseEnd - deps.now());
    const r: Awaited<ReturnType<typeof postFixResolve>> =
      timeoutMs > 0
        ? await postFixResolve({ groupId, no }, portalOpts(input, deps, timeoutMs))
        : { kind: "unreachable" };
    // code は portal の本文から来る。fix の断りと同じく、整えてからログに出す（改行・見えない文字を除き、40文字まで）
    if (r.kind === "rejected") return refuse(sanitizeForReply(r.code), rejectionMessage(no, page, r));
    // 結果不明でも fix は呼ばない（resolve は何も書き換えないので、何も変わっていないのが確か）
    if (r.kind !== "accepted") return refuse(`resolve-${r.kind}`, OBI_FIX_MESSAGES.unreachable);
    resolved = r.resolved;
  }

  // 完成品がまだ無い依頼（resolve の sha256 が空文字）：fix は呼ばない（expectSha256 に渡すものが無い）。
  //   portal の見込み（0 は closable、1〜5 は fixable。ok 以外のはず）どおりの文を返す。聞き返しもしない。
  //   「ok なのに空」は本来起きない組み合わせ：番号では直せない、に倒す
  if (resolved.artifactSha256 === "") {
    const estimate = code === 0 ? resolved.closable : resolved.fixable;
    return estimate === "ok"
      ? refuse("no-artifact", OBI_FIX_MESSAGES.unavailable(no))
      : refuse(`no-artifact:${estimate}`, estimateMessage(no, estimate));
  }

  // ページが要る番号（1・2・3）でページが無い：聞き返す（fix は呼ばない）
  if ((code === 1 || code === 2 || code === 3) && page === null) {
    if (!resolved.current) return refuse("stale", OBI_FIX_MESSAGES.stale(no));
    if (resolved.fixable !== "ok") return refuse(resolved.fixable, estimateMessage(no, resolved.fixable));
    // 依頼ごとに1回。2回目からは返事をしない
    const said = await sayOnce(input, groupId, deps, `obi-fix-ask:${no}`, OBI_FIX_MESSAGES.askPage(no));
    if (said.delivery === "skipped") {
      log("ask-suppressed", said);
      return { outcome: "ask-suppressed" };
    }
    // 届いていないことが確か（reply も push もはっきり断られた）：依頼ごとの印を消して、次の機会に聞き返せるようにする。
    //   届いたかどうか分からない（時間切れ・通信の失敗・5xx）ときは消さない（二重に出さない側）。消せなければ印は残る（同じ側）
    if (said.undelivered) {
      try {
        await kvBounded(deps, input.startedAt + OBI_FIX_DEADLINE_MS, () => deps.store.del(`obi-fix-ask:${no}`));
      } catch (err) {
        console.error("帯替えの訂正：届かなかった聞き返しの印を消せない（次は聞き返さない）:", `#J${no}`, errName(err));
      }
      log("ask-failed", said);
      return { outcome: "ask-failed" };
    }
    // 聞き返しへの引用の返事を引けるよう、出した聞き返しの ID → 受付番号を控える
    if (said.sentId && /^\d{1,64}$/.test(said.sentId)) {
      try {
        await kvBounded(deps, input.startedAt + OBI_FIX_DEADLINE_MS, () =>
          deps.store.putText(`obi-fix-askmsg:${said.sentId}`, `J${no}`, OBI_FIX_KEY_TTL_SECONDS)
        );
      } catch (err) {
        console.error("帯替えの訂正：聞き返しの控えを置けない（#J つきの返事なら通る）:", `#J${no}`, errName(err));
      }
    } else {
      console.error("帯替えの訂正：聞き返しの ID が取れない（#J つきの返事なら通る）:", `#J${no}`, said.delivery);
    }
    log("asked", said);
    return { outcome: "asked" };
  }

  // ページの範囲（portal が受ける 1〜120 の外）。fix に送っても形の違いで断られるだけなので、ここで返す
  if (page !== null && (page < PAGE_MIN || page > PAGE_MAX)) {
    return refuse("bad-page", OBI_FIX_MESSAGES.badPage(no, page, resolved.pageCount));
  }

  // fix（1回だけ）。返事の印の1秒を残して、開始+17秒までに終える
  const remaining = phaseEnd - deps.now() - KV_OP_MS;
  if (remaining < FIX_MIN_MS) return refuse("no-time", OBI_FIX_MESSAGES.unreachable); // 送る前の失敗が確か
  deps.onFixCalled();
  const o = await postFix(
    no,
    { messageId, groupId, code, page, turn, expectSha256: resolved.artifactSha256 },
    portalOpts(input, deps, Math.min(FIX_MS, remaining))
  );
  if (o.kind === "accepted") {
    deps.onCommitted();
    log(o.reason ? `${o.result}:${sanitizeForReply(o.reason)}` : o.result, await sayOnce(input, groupId, deps, repliedKey, acceptedMessage(no, input.body, o)));
    return { outcome: o.result };
  }
  if (o.kind === "rejected") {
    deps.onCommitted();
    return refuse(sanitizeForReply(o.code), rejectionMessage(no, page, o));
  }

  // 送っていないことが確かな失敗（postFix の unreachable＝ECONNREFUSED・ENOTFOUND・EAI_AGAIN。AB1）。
  //    つなぐ前に失敗しているので、portal には何も届いていない＝何も変わっていない。結果不明ではない。
  //    送り直しても二重にならないので「…portal に届きません。少し待ってからもう一度送ってください」を返して済みにする
  if (o.kind === "unreachable") {
    deps.onCommitted();
    return refuse("fix-unreachable", OBI_FIX_MESSAGES.unreachable);
  }

  // fix を呼んだ後、はっきりした答えが無く、届いたかどうかも分からない
  //    （時間切れ・応答の途中の切断・5xx・形の違う応答）＝結果不明（AA1）。
  //    受け付けられなかったとは言わない。「もう一度送ってください」とも言わない
  //    （人が送り直すと message.id が変わり、portal の冪等では二重の訂正を防げない）。
  //    1回だけ知らせて、済みにする（やり直さない・503 にしない）。結果は、Mac の後の知らせか portal の依頼ボックスで分かる
  log(`unknown:${o.reason}`, await sayOnce(input, groupId, deps, `obi-fix-pending-notified:${messageId}`, OBI_FIX_MESSAGES.unknown));
  return { outcome: "unknown" };
}

/**
 * runObiFix が例外で止まったときの返事（webhook-event.ts が、予約を持ったまま呼ぶ。例外は外へ投げない）。
 *   before-fix … fix をまだ呼んでいない（#J つきだけ。引用の形は呼ぶ側が今までの流れへ渡す）。
 *                何も変わっていないのが確かなので「…portal に届きません。少し待ってからもう一度送ってください」
 *   fix-called … fix を呼んだが、答えを受け取る前に止まった。結果不明と同じ「受付の結果を確かめられませんでした…」
 * どちらも1通につき1回（NX）。この後、呼ぶ側はイベントを済みにする（503 にしない。AA1）
 */
export async function replyObiFixInterrupted(
  input: Pick<ObiFixInput, "messageId" | "startedAt" | "config">,
  stage: "before-fix" | "fix-called",
  deps: ObiFixDeps
): Promise<void> {
  const { messageId } = input;
  try {
    const said =
      stage === "before-fix"
        ? await sayOnce(input, input.config.groupId, deps, `obi-fix-replied:${messageId}`, OBI_FIX_MESSAGES.unreachable)
        : await sayOnce(input, input.config.groupId, deps, `obi-fix-pending-notified:${messageId}`, OBI_FIX_MESSAGES.unknown);
    console.log("帯替えの訂正:", `interrupted:${stage}`, said.delivery);
  } catch (err) {
    console.error("帯替えの訂正：例外の後の返事を出せない:", stage, errName(err));
  }
}
