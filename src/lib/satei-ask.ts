/**
 * 「案件はどれですか」のカード（2026-11-22）。設計 docs/superpowers/specs/2026-11-22-satei-ask-card-design.md。
 * 約束の案：agent-hub docs/contracts/2026-11-19-satei-ask.md（propertyHint を足した・答えは7日で消える・最初の1回だけ有効）。
 * - 口1 POST /api/satei/ask：Mac が頼むと、下村さん（TASK_SATEI_USER_IDS の先頭）との1対1へ候補のカードを push。
 * - ボタン：v1|qa|<askId>|<案件ID>［この案件］／v1|ql|<askId>|<オフセット>［一覧から選ぶ］／v1|qn|<askId>［査定にしない］。
 * - 口2 POST /api/satei/ask/answers：Mac が答えを取りに来る（位置 `<ミリ秒>:<askId>` より後を古い順に）。
 * 秘書は査定を始めない。ログは符号だけ（抜粋・案件名・userId は出さない）。本物の KV・CRM・LINE は satei-ask-wire.ts。
 */
import { createHmac } from "node:crypto";
import { timingSafeEqualStr } from "./secure-compare";
import { isSateiUser, sateiActive, sateiNotifyTarget } from "./satei-data";
import { SATEI_KEY_MIN_LENGTH, uuidv5 } from "./satei-notify";
import { MSG_SATEI_BUSY, MSG_SATEI_FORBIDDEN, MSG_SATEI_PAUSED } from "./satei-text";
import { normalizeProperty } from "./property";
import { candidateDeals, type DealRef } from "./task-record";
import { PAGE_ID_RE } from "./task-buttons";
import { ALT_TEXT_MAX, FLEX_LABEL_MAX, POSTBACK_TEXT_MAX, type FlexMessage } from "./task-card";

export const SATEI_ASK_CONTEXT = "satei-ask";
/** 控え・答えを置く期間（秒） */
export const SATEI_ASK_TTL = 7 * 24 * 60 * 60;
/** X-Line-Retry-Key の uuidv5 の名前空間（固定。変えると送り直しの二重防止が効かなくなる） */
export const SATEI_ASK_RETRY_NAMESPACE = "c4e8a2d6-1b3f-4a59-8e7d-6f0a2b4c8d1e";
export const SATEI_ASK_CANDIDATES_MAX = 5;
export const SATEI_ASK_PAGE = 10;
export const SATEI_ASK_ANSWERS_MAX = 50;
export const SATEI_ASK_DEALS_MS = 8_000;

const ASK_ID_RE = /^[0-9A-Za-z]{10,64}$/;
const RECEIPT_RE = /^H[1-9][0-9]{0,8}$/;
const OFFSET_RE = /^(0|[1-9][0-9]{0,2})$/;
const CURSOR_RE = /^[1-9][0-9]{0,14}$/;
// タイムゾーンつき（Z か ±hh:mm）の ISO 8601
const ISO_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const EXCERPT_MAX = 80;
const HINT_MAX = 60;
const LABEL_MAX = 60;
const NAME_MAX = 60;
const OFFSET_MAX = 500;
const DATA_MAX = 300;
/** お客様の名前が混じっていそうな物件名は label を空にする */
const LABEL_NG_RE = /様|邸|さん|氏/;

export const askKey = (askId: string) => `sateiask:ask:${askId}`;
export const answerKey = (askId: string) => `sateiask:ans:${askId}`;
export const SATEI_ASK_INDEX = "sateiask:answers";
/** 答えの通し番号（目次の順番。答えを置くのと同じ1回の処理で振る） */
export const SATEI_ASK_SEQ = "sateiask:seq";
/** 送れたか分からないカードを、同じ再送キーで送り直してよい時間（LINE が再送キーを覚えているのは24時間） */
export const SATEI_ASK_RESEND_MS = 23 * 60 * 60 * 1000;

const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");

export function sateiAskToken(jobApiToken: string): string {
  return createHmac("sha256", Buffer.from(jobApiToken, "utf8")).update(SATEI_ASK_CONTEXT, "utf8").digest("hex");
}

export function sateiAskAuthorized(header: string | null, jobApiToken: string | undefined): boolean {
  if (typeof jobApiToken !== "string" || jobApiToken.length < SATEI_KEY_MIN_LENGTH) return false;
  if (typeof header !== "string") return false;
  return timingSafeEqualStr(header, sateiAskToken(jobApiToken));
}

export const sateiAskRetryKey = (askId: string) => uuidv5(askId, SATEI_ASK_RETRY_NAMESPACE);

export type SateiAskReason = "MISSING_CASE" | "TOO_OLD";

export interface SateiAskInput {
  askId: string;
  receipt: string;
  reason: SateiAskReason;
  occurredAt: string;
  excerpt: string;
  propertyHint: string | null;
}

/** askId の控え（抜粋・候補は持たない） */
export interface SateiAskRecord {
  receipt: string;
  reason: SateiAskReason;
  sent: boolean;
  at: number;
}

export interface SateiAskAnswer {
  askId: string;
  receipt: string;
  decision: "deal" | "none";
  dealId?: string;
  /** 案件の CRM_物件 の物件名（空でもよい）。お客様の名前を含めない */
  label?: string;
  answeredAt: string;
}

export interface SateiAskKv {
  get(key: string): Promise<unknown>;
  /** 無ければ置いて true。あれば何もせず false */
  setNx(key: string, value: unknown, ex: number): Promise<boolean>;
  set(key: string, value: unknown, ex: number): Promise<void>;
  del(key: string): Promise<void>;
  mget(keys: string[]): Promise<unknown[]>;
  /**
   * 答えを置き（まだ無ければ）、目次に載っていなければ通し番号を振って載せる。1回の処理で（本物は Lua）。
   * 新しく置いたら true、もうあれば false（そのときも目次に無ければ載せ直す）
   */
  saveAnswer(askId: string, answer: SateiAskAnswer, ex: number): Promise<boolean>;
  /** 目次のうち通し番号が after より大きいもの（小さい順に limit 件まで） */
  indexAfter(after: number, limit: number): Promise<Array<{ askId: string; seq: number }>>;
  /** 答えが消えた（7日を過ぎた）ものを目次から外す */
  indexRemove(askIds: string[]): Promise<void>;
}

type Res = { status: number; body: Record<string, unknown> };

function readJson(raw: string): Record<string, unknown> | null {
  let b: unknown;
  try {
    b = JSON.parse(raw);
  } catch {
    return null;
  }
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

const ASK_FIELDS = new Set(["askId", "receipt", "reason", "occurredAt", "excerpt", "propertyHint"]);

export function parseAskInput(raw: string): SateiAskInput | null {
  const o = readJson(raw);
  if (!o || Object.keys(o).some((k) => !ASK_FIELDS.has(k))) return null;
  const { askId, receipt, reason, occurredAt, excerpt, propertyHint } = o;
  if (typeof askId !== "string" || !ASK_ID_RE.test(askId)) return null;
  if (typeof receipt !== "string" || !RECEIPT_RE.test(receipt)) return null;
  if (reason !== "MISSING_CASE" && reason !== "TOO_OLD") return null;
  if (typeof occurredAt !== "string" || !ISO_TZ_RE.test(occurredAt) || Number.isNaN(Date.parse(occurredAt))) return null;
  if (typeof excerpt !== "string" || Array.from(excerpt).length > EXCERPT_MAX) return null;
  let hint: string | null = null;
  if (propertyHint !== undefined && propertyHint !== null && propertyHint !== "") {
    if (typeof propertyHint !== "string" || Array.from(propertyHint).length > HINT_MAX) return null;
    hint = propertyHint.trim() || null;
  }
  return { askId, receipt, reason, occurredAt, excerpt: excerpt.trim(), propertyHint: hint };
}

/** 日本時間の「11/22 12:34」 */
export function jstLabel(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 日本時間の ISO 8601（+09:00） */
export function jstIso(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return `${d.toISOString().slice(0, 19)}+09:00`;
}

export function encodeAskPick(askId: string, dealId: string): string {
  return `v1|qa|${askId}|${dealId}`;
}
export function encodeAskList(askId: string, offset: number): string {
  return `v1|ql|${askId}|${offset}`;
}
export function encodeAskNone(askId: string): string {
  return `v1|qn|${askId}`;
}

export type SateiAskAction =
  | { op: "qa"; askId: string; dealId: string }
  | { op: "ql"; askId: string; offset: number }
  | { op: "qn"; askId: string };

/** このカードのボタンの data を読む。形が違えば null（ほかのボタンの data は読まない） */
export function parseSateiAskData(data: string): SateiAskAction | null {
  if (!data || data.length > DATA_MAX) return null;
  const p = data.split("|");
  if (p[0] !== "v1" || !ASK_ID_RE.test(p[2] ?? "")) return null;
  if (p[1] === "qa") return p.length === 4 && PAGE_ID_RE.test(p[3]) ? { op: "qa", askId: p[2], dealId: p[3] } : null;
  if (p[1] === "ql") {
    if (p.length !== 4 || !OFFSET_RE.test(p[3])) return null;
    const offset = Number(p[3]);
    return offset <= OFFSET_MAX ? { op: "ql", askId: p[2], offset } : null;
  }
  if (p[1] === "qn") return p.length === 3 ? { op: "qn", askId: p[2] } : null;
  return null;
}

const button = (label: string, data: string, displayText: string, primary = false) => ({
  type: "button",
  style: primary ? "primary" : "secondary",
  height: "sm",
  action: {
    type: "postback",
    label: cut(label, FLEX_LABEL_MAX),
    data,
    displayText: cut(displayText, POSTBACK_TEXT_MAX),
  },
});

const small = (text: string, color = "#555555") => ({ type: "text", text, size: "sm", color, wrap: true });

export function sateiAskCard(
  input: SateiAskInput,
  candidates: DealRef[],
  dealsFailed: boolean,
): FlexMessage {
  const head = `🏢 査定の依頼らしい発言がありました（${input.receipt}）`;
  const guide =
    candidates.length > 0
      ? "どの案件ですか？"
      : dealsFailed
        ? "CRM の案件を確かめられませんでした。一覧から選んでください"
        : "名前の合う進行中の案件が見つかりませんでした。一覧から選んでください";
  return {
    type: "flex",
    altText: cut(`${head}。どの案件か選んでください`, ALT_TEXT_MAX),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: head, weight: "bold", size: "md", wrap: true },
          ...(input.reason === "TOO_OLD"
            ? [small("24時間より前の発言です。まだ必要なら案件を選んでください", "#C0392B")]
            : []),
          small(`発言：${jstLabel(input.occurredAt)}`),
          ...(input.excerpt ? [small(`「${cut(input.excerpt, EXCERPT_MAX)}」`)] : []),
          small(guide, "#333333"),
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          ...candidates.map((d) =>
            button(cut(d.name, NAME_MAX), encodeAskPick(input.askId, d.id), `（ボタン）この案件：${cut(d.name, NAME_MAX)}`, true),
          ),
          button("一覧から選ぶ", encodeAskList(input.askId, 0), "（ボタン）一覧から選ぶ"),
          button("査定にしない", encodeAskNone(input.askId), "（ボタン）査定にしない"),
        ],
      },
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

function asRecord(v: unknown): SateiAskRecord | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.receipt !== "string" || (r.reason !== "MISSING_CASE" && r.reason !== "TOO_OLD")) return null;
  return { receipt: r.receipt, reason: r.reason, sent: r.sent === true, at: typeof r.at === "number" ? r.at : 0 };
}

function asAnswer(raw: unknown): SateiAskAnswer | null {
  let v = raw;
  // KV の読み出しが JSON の文字列のまま返ることがある（Lua で置いた値）
  for (let i = 0; i < 2 && typeof v === "string"; i++) {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.askId !== "string" || typeof r.receipt !== "string" || typeof r.answeredAt !== "string") return null;
  if (r.decision === "none") return { askId: r.askId, receipt: r.receipt, decision: "none", answeredAt: r.answeredAt };
  if (r.decision !== "deal" || typeof r.dealId !== "string") return null;
  return {
    askId: r.askId,
    receipt: r.receipt,
    decision: "deal",
    dealId: r.dealId,
    label: typeof r.label === "string" ? r.label : "",
    answeredAt: r.answeredAt,
  };
}

// ───────────── 口1：カードを頼む ─────────────

export interface SateiAskDeps {
  env: Record<string, string | undefined>;
  kv: SateiAskKv | null;
  /** 進行中の CRM_案件。読めなければ例外 */
  loadDeals(): Promise<DealRef[]>;
  push(to: string, messages: unknown[], retryKey: string): Promise<number | null>;
  now(): number;
  log(line: string): void;
}

export async function handleSateiAsk(header: string | null, raw: string, deps: SateiAskDeps): Promise<Res> {
  if (!sateiAskAuthorized(header, deps.env.JOB_API_TOKEN)) return { status: 401, body: { error: "Unauthorized" } };
  const input = parseAskInput(raw);
  if (!input) {
    deps.log("[satei-ask] bad-input");
    return { status: 400, body: { error: "bad-input" } };
  }
  const to = sateiNotifyTarget(deps.env);
  if (!sateiActive(deps.env) || !to) {
    deps.log(`[satei-ask] ${input.receipt} rejected TASK_SATEI_OFF`);
    return { status: 200, body: { result: "rejected", code: "TASK_SATEI_OFF" } };
  }
  const unknown = (code: string): Res => {
    deps.log(`[satei-ask] ${input.receipt} unknown ${code}`);
    return { status: 200, body: { result: "unknown" } };
  };
  if (!deps.kv) return unknown("config-missing");
  const key = askKey(input.askId);
  let rec: SateiAskRecord | null;
  try {
    rec = asRecord(await deps.kv.get(key));
    if (rec?.sent) {
      deps.log(`[satei-ask] ${input.receipt} same`);
      return { status: 200, body: { result: "ok", created: false } };
    }
    // 前に送ろうとして結果が分からないまま24時間近くたったもの：LINE が再送キーを忘れているので、送り直すと二重に届きうる。
    // 送り直さず断る（Mac は下村さんに確かめてもらう）
    if (rec && deps.now() - rec.at > SATEI_ASK_RESEND_MS) {
      deps.log(`[satei-ask] ${input.receipt} rejected ASK_UNCERTAIN`);
      return { status: 200, body: { result: "rejected", code: "ASK_UNCERTAIN" } };
    }
    if (!rec) {
      rec = { receipt: input.receipt, reason: input.reason, sent: false, at: deps.now() };
      // 同じ askId が同時に来たら、控えを置けた側だけが送る（もう片方は unknown＝Mac がもう一度呼べば same になる）
      if (!(await deps.kv.setNx(key, rec, SATEI_ASK_TTL))) return unknown("busy");
    }
  } catch {
    return unknown("kv-failed");
  }
  let candidates: DealRef[] = [];
  let dealsFailed = false;
  if (input.propertyHint) {
    try {
      const deals = await withTimeout(deps.loadDeals(), SATEI_ASK_DEALS_MS);
      candidates = candidateDeals(normalizeProperty(input.propertyHint), deals, SATEI_ASK_CANDIDATES_MAX);
    } catch {
      dealsFailed = true;
    }
  }
  let status: number | null;
  try {
    status = await deps.push(to, [sateiAskCard(input, candidates, dealsFailed)], sateiAskRetryKey(input.askId));
  } catch {
    status = null;
  }
  if (status !== 200 && status !== 409) return unknown(`push-${status ?? "error"}`);
  try {
    await deps.kv.set(key, { ...rec, sent: true }, SATEI_ASK_TTL);
  } catch {
    // 印を付けられなくても、次に呼ばれたら同じ再送キーで送り直す（24時間以内なら LINE が二重に届けない）
    deps.log(`[satei-ask] ${input.receipt} mark-failed`);
  }
  deps.log(`[satei-ask] ${input.receipt} asked ${candidates.length}${dealsFailed ? " deals-failed" : ""}`);
  return { status: 200, body: { result: "ok", created: true } };
}

// ───────────── 口2：答えを取りに行く ─────────────

export interface SateiAskAnswersDeps {
  env: Record<string, string | undefined>;
  kv: SateiAskKv | null;
  now(): number;
  log(line: string): void;
}

export async function handleSateiAskAnswers(header: string | null, raw: string, deps: SateiAskAnswersDeps): Promise<Res> {
  if (!sateiAskAuthorized(header, deps.env.JOB_API_TOKEN)) return { status: 401, body: { error: "Unauthorized" } };
  const o = readJson(raw);
  const after = o?.after;
  if (!o || Object.keys(o).some((k) => k !== "after") || typeof after !== "string") {
    deps.log("[satei-ask] answers bad-input");
    return { status: 400, body: { error: "bad-input" } };
  }
  if (after !== "" && !CURSOR_RE.test(after)) {
    deps.log("[satei-ask] answers bad-input");
    return { status: 400, body: { error: "bad-input" } };
  }
  const pos = after === "" ? 0 : Number(after);
  if (!deps.kv) {
    deps.log("[satei-ask] answers unknown config-missing");
    return { status: 200, body: { result: "unknown" } };
  }
  try {
    const entries = (await deps.kv.indexAfter(pos, SATEI_ASK_ANSWERS_MAX))
      .filter((e) => ASK_ID_RE.test(e.askId) && Number.isSafeInteger(e.seq) && e.seq > pos)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, SATEI_ASK_ANSWERS_MAX);
    const values = entries.length > 0 ? await deps.kv.mget(entries.map((e) => answerKey(e.askId))) : [];
    const answers: Array<Record<string, unknown>> = [];
    const gone: string[] = [];
    entries.forEach((e, i) => {
      const a = asAnswer(values[i]);
      if (!a || a.askId !== e.askId) {
        gone.push(e.askId);
        return;
      }
      answers.push(
        a.decision === "none"
          ? { askId: a.askId, receipt: a.receipt, decision: a.decision, answeredAt: a.answeredAt }
          : { askId: a.askId, receipt: a.receipt, decision: a.decision, dealId: a.dealId, label: a.label ?? "", answeredAt: a.answeredAt },
      );
    });
    // 7日を過ぎて消えた答えは目次から外す（外せなくても、位置は進むので返事は変わらない）
    if (gone.length > 0) await deps.kv.indexRemove(gone).catch(() => deps.log("[satei-ask] answers trim-failed"));
    const last = entries[entries.length - 1];
    const next = last ? String(last.seq) : after;
    deps.log(`[satei-ask] answers ${answers.length}`);
    return { status: 200, body: { result: "ok", answers, next } };
  } catch {
    deps.log("[satei-ask] answers unknown kv-failed");
    return { status: 200, body: { result: "unknown" } };
  }
}

// ───────────── ボタン ─────────────

export const MSG_ASK_EXPIRED = "この確認は期限が切れています（7日）。必要なら、もう一度依頼してください";
export const MSG_ASK_DEALS_FAILED = "案件を読み取れませんでした。少し待ってからもう一度押してください";
export const MSG_ASK_NOT_ACTIVE = "この案件は進行中の一覧にありません。［一覧から選ぶ］から選び直してください";
export const MSG_ASK_SAVE_FAILED = "記録できませんでした。少し待ってからもう一度押してください";
export const msgAskPicked = (receipt: string, name: string) =>
  `✅ ${receipt} は「${cut(name, NAME_MAX)}」の査定として受けます。Mac が受け口に出し直します（査定書づくりは Mac が始めます）`;
export const msgAskNone = (receipt: string) => `${receipt} は査定にしません`;
export const msgAskAlready = (receipt: string, a: SateiAskAnswer, name: string | null) =>
  a.decision === "none"
    ? `${receipt} はもう「査定にしない」で選択済みです`
    : `${receipt} はもう選択済みです（${name ? cut(name, NAME_MAX) : "選んだ案件"}）`;

export interface SateiAskActionDeps {
  kv: SateiAskKv | null;
  loadDeals(): Promise<DealRef[]>;
  /** 案件の CRM_物件（`物件` の1件目）の物件名。無ければ null。読めなければ例外 */
  readLabel(dealId: string): Promise<string | null>;
  reserve(key: string): Promise<{ proceed: boolean }>;
  complete(key: string): Promise<void>;
  reply(replyToken: string, text: string, card?: FlexMessage): Promise<unknown>;
  now(): number;
  log(line: string): void;
}

export interface SateiAskPostbackEvent {
  replyToken: string;
  webhookEventId?: string;
  source: { userId?: string; groupId?: string };
}

export function safeLabel(name: string | null): string {
  // 敬称は切る前の全文で見る（61字目以降の「様」を切り落として名前の頭だけ残さないため）
  const full = (name ?? "").trim();
  return full && !LABEL_NG_RE.test(full) ? cut(full, LABEL_MAX) : "";
}

/** ［一覧から選ぶ］のカルーセル（名前順に10件＋［次の10件］） */
export function sateiAskListCard(askId: string, receipt: string, deals: DealRef[], offset: number): FlexMessage | null {
  const sorted = [...deals].sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const page = sorted.slice(offset, offset + SATEI_ASK_PAGE);
  if (page.length === 0) return null;
  const bubbles: Array<Record<string, unknown>> = page.map((d) => ({
    type: "bubble",
    size: "kilo",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: `🏢 ${cut(d.name, NAME_MAX)}`, weight: "bold", size: "sm", wrap: true },
        ...(d.phase ? [small(`フェーズ：${cut(d.phase, 30)}`)] : []),
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      contents: [button("この案件", encodeAskPick(askId, d.id), `（ボタン）この案件：${cut(d.name, NAME_MAX)}`, true)],
    },
  }));
  const rest = sorted.length - offset - page.length;
  if (rest > 0 && offset + SATEI_ASK_PAGE <= OFFSET_MAX) {
    bubbles.push({
      type: "bubble",
      size: "kilo",
      body: { type: "box", layout: "vertical", contents: [small(`残り${rest}件`)] },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [button("次の10件", encodeAskList(askId, offset + SATEI_ASK_PAGE), "（ボタン）次の10件")],
      },
    });
  }
  return {
    type: "flex",
    altText: cut(`どの案件ですか（${receipt}）`, ALT_TEXT_MAX),
    contents: { type: "carousel", contents: bubbles },
  };
}

interface Outcome {
  text: string;
  card?: FlexMessage;
  code: string;
  settled: boolean;
}

async function decide(
  a: Extract<SateiAskAction, { op: "qa" | "qn" }>,
  rec: SateiAskRecord,
  deps: SateiAskActionDeps,
  kv: SateiAskKv,
): Promise<Outcome> {
  const existing = asAnswer(await kv.get(answerKey(a.askId)));
  let deals: DealRef[] | null = null;
  const nameOf = async (id: string | undefined) => {
    if (!id) return null;
    try {
      deals ??= await withTimeout(deps.loadDeals(), SATEI_ASK_DEALS_MS);
      return deals.find((d) => d.id === id)?.name ?? null;
    } catch {
      return null;
    }
  };
  if (existing) {
    // 前の押下で答えだけ置けて目次に載らなかった（通信が途中で切れた）ものを、ここで載せ直す
    try {
      await kv.saveAnswer(a.askId, existing, SATEI_ASK_TTL);
    } catch {
      return { text: MSG_ASK_SAVE_FAILED, code: "repair-failed", settled: false };
    }
    return { text: msgAskAlready(rec.receipt, existing, await nameOf(existing.dealId)), code: "already", settled: true };
  }
  const at = deps.now();
  let answer: SateiAskAnswer;
  let pickedName = "";
  if (a.op === "qa") {
    try {
      deals ??= await withTimeout(deps.loadDeals(), SATEI_ASK_DEALS_MS);
    } catch {
      return { text: MSG_ASK_DEALS_FAILED, code: "deals-failed", settled: false };
    }
    const deal = deals.find((d) => d.id === a.dealId);
    if (!deal) return { text: MSG_ASK_NOT_ACTIVE, code: "not-active", settled: true };
    pickedName = deal.name;
    let label = "";
    try {
      label = safeLabel(await withTimeout(deps.readLabel(a.dealId), SATEI_ASK_DEALS_MS));
    } catch {
      // 物件名が読めなくても受ける（hub は空なら受付番号と案件の番号だけを見せる）
      deps.log("[satei-ask] qa label-failed");
    }
    answer = { askId: a.askId, receipt: rec.receipt, decision: "deal", dealId: a.dealId, label, answeredAt: jstIso(at) };
  } else {
    answer = { askId: a.askId, receipt: rec.receipt, decision: "none", answeredAt: jstIso(at) };
  }
  let created: boolean;
  try {
    created = await kv.saveAnswer(a.askId, answer, SATEI_ASK_TTL);
  } catch {
    // 置けたか分からない。押し直すと、置けていれば「選択済み」＋目次の載せ直し、置けていなければ置く
    return { text: MSG_ASK_SAVE_FAILED, code: "save-failed", settled: false };
  }
  if (!created) {
    // 同時に押された別のボタンが先に入れた
    const won = asAnswer(await kv.get(answerKey(a.askId)));
    return won
      ? { text: msgAskAlready(rec.receipt, won, await nameOf(won.dealId)), code: "already", settled: true }
      : { text: MSG_ASK_SAVE_FAILED, code: "save-race", settled: false };
  }
  return a.op === "qa"
    ? { text: msgAskPicked(rec.receipt, pickedName), code: "saved", settled: true }
    : { text: msgAskNone(rec.receipt), code: "saved", settled: true };
}

/** このカードのボタンが押されたとき。例外は投げない（返事で知らせる） */
export async function handleSateiAskPostback(
  action: SateiAskAction,
  ev: SateiAskPostbackEvent,
  deps: SateiAskActionDeps,
): Promise<void> {
  const say = async (text: string, code: string, card?: FlexMessage) => {
    try {
      await deps.reply(ev.replyToken, text, card);
    } catch {
      deps.log(`[satei-ask] reply-failed ${action.op} ${code}`);
    }
  };
  if (!sateiActive()) {
    deps.log(`[satei-ask] ${action.op} paused`);
    return say(MSG_SATEI_PAUSED, "paused");
  }
  if (!ev.source.userId || !isSateiUser(ev.source.userId)) {
    deps.log(`[satei-ask] ${action.op} forbidden`);
    return say(MSG_SATEI_FORBIDDEN, "forbidden");
  }
  const kv = deps.kv;
  if (!kv) {
    deps.log(`[satei-ask] ${action.op} config-missing`);
    return say(MSG_ASK_SAVE_FAILED, "config-missing");
  }
  let rec: SateiAskRecord | null;
  try {
    rec = asRecord(await kv.get(askKey(action.askId)));
  } catch {
    deps.log(`[satei-ask] ${action.op} kv-failed`);
    return say(MSG_SATEI_BUSY, "kv-failed");
  }
  if (!rec) {
    deps.log(`[satei-ask] ${action.op} expired`);
    return say(MSG_ASK_EXPIRED, "expired");
  }
  if (action.op === "ql") {
    let deals: DealRef[];
    try {
      deals = await withTimeout(deps.loadDeals(), SATEI_ASK_DEALS_MS);
    } catch {
      deps.log("[satei-ask] ql deals-failed");
      return say(MSG_ASK_DEALS_FAILED, "deals-failed");
    }
    const card = sateiAskListCard(action.askId, rec.receipt, deals, action.offset);
    deps.log(`[satei-ask] ql shown ${card ? Math.min(SATEI_ASK_PAGE, Math.max(0, deals.length - action.offset)) : 0}`);
    return card
      ? say(`どの案件ですか（${rec.receipt}）`, "shown", card)
      : say("これより後の案件はありません", "empty");
  }
  const eventId = ev.webhookEventId;
  if (!eventId) {
    deps.log(`[satei-ask] ${action.op} no-event-id`);
    return say(MSG_ASK_SAVE_FAILED, "no-event-id");
  }
  const rkey = `pb:${eventId}`;
  let claim: { proceed: boolean };
  try {
    claim = await deps.reserve(rkey);
  } catch {
    deps.log(`[satei-ask] ${action.op} reserve-failed`);
    return say(MSG_SATEI_BUSY, "busy");
  }
  if (!claim.proceed) {
    deps.log(`[satei-ask] ${action.op} duplicate`);
    return;
  }
  let settled = false;
  try {
    let r: Outcome;
    try {
      r = await decide(action, rec, deps, kv);
    } catch {
      r = { text: MSG_ASK_SAVE_FAILED, code: "kv-failed", settled: false };
    }
    settled = r.settled;
    deps.log(`[satei-ask] ${action.op} ${r.code}`);
    await say(r.text, r.code);
  } finally {
    // 結果が分からないときは完了印を付けない（押し直しは新しいイベント ID で通る）
    if (settled) await deps.complete(rkey).catch(() => deps.log(`[satei-ask] mark-failed ${action.op}`));
  }
}
