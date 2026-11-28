/**
 * 担当へのまとめ・段階3（2026-11-28 下村さん決定）：リプライの取り込みと催促。スイッチは段階2と同じ STAFF_DIGEST=1。
 *
 *   1. 自由な文の進捗：まとめ（か催促）のメッセージを**引用した**返信で、行の頭が番号の「3 アポ取れました。来週火曜です」を
 *      Notion の本文に「進捗（11/28 小笠原）：…」と足す。状態は変えない。引用の無い「3 …」は今までどおり（何もしない）。
 *   2. 下村さんへの知らせ：グループでの番号・引用の返事（済・待ち・延期・不要・進捗）を KV の列に足し、
 *      毎分の見回りが30分に1回まとめて1通で 1対1 へ push する。
 *   3. 催促：夕方のまとめの前に、朝のまとめから動きの無いタスクがあれば下村さんの 1対1 へ［催促する］のカード。
 *      押したときだけ、グループへ担当ごとにまとめて1通。
 *
 * ここは判断と文だけ（KV・LINE・Notion・名簿は渡してもらう）。本物へのつなぎは staff-digest-reply-wire.ts。
 * off のあいだは KV を1回も触らない。どの関数も例外を投げない（今ある返事・見回りを壊さない）。
 * ログは符号と件数だけ（本文・題名・userId・groupId・messageId は出さない）。
 */
import type { Chunk } from "./chunk";
import { sanitizeForTextV2 } from "./line";
import { DIGEST_MSG_TTL_SEC, digestMsgKey, staffDigestOn } from "./staff-digest";
import { ALT_TEXT_MAX, FLEX_LABEL_MAX, POSTBACK_TEXT_MAX, pressedText, type FlexMessage } from "./task-card";
import type { StatusBody } from "./task-status-command";

type Env = Record<string, string | undefined>;

// ── KV（鍵は staffdigest:*） ──

export interface SdKv {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, exSeconds: number): Promise<void>;
  /** SET NX。取れたら true */
  setNx(key: string, value: unknown, exSeconds: number): Promise<boolean>;
  del(key: string): Promise<void>;
  /** 列の後ろに足す（本物は長さの上限と期限も付ける） */
  rpush(key: string, values: unknown[]): Promise<void>;
  lrange(key: string, start: number, stop: number): Promise<unknown[]>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  sadd(key: string, members: string[], exSeconds: number): Promise<void>;
  smembers(key: string): Promise<string[]>;
}

const DAY_TTL_SEC = 2 * 24 * 60 * 60;
/** 下村さんへ知らせる返事の列（要素は FwdRow） */
export const FWD_KEY = "staffdigest:fwd";
/** 知らせの間隔の印（30分） */
export const FWD_GUARD_KEY = "staffdigest:fwd:guard";
export const FWD_INTERVAL_SEC = 30 * 60;
/** 1通に載せる上限（残りは次の回） */
export const FWD_MAX = 30;
/** 朝のまとめに出したタスク（day は JST の "YYYY-MM-DD"。2日） */
export const amKey = (day: string) => `staffdigest:am:${day}`;
/** その日に返事のあったタスクの ID（集合。2日） */
export const answeredKey = (day: string) => `staffdigest:answered:${day}`;
/** ［催促する］のカードに載せたタスク（2日） */
export const nudgeKey = (day: string) => `staffdigest:nudge:${day}`;
/** 催促を送った印（SET NX。2日） */
export const nudgedKey = (day: string) => `staffdigest:nudged:${day}`;

const JST_MS = 9 * 60 * 60 * 1000;
const jstDay = (ms: number) => new Date(ms + JST_MS).toISOString().slice(0, 10);
const mdOf = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const cut = (s: string, n: number) => {
  const a = Array.from(s);
  return a.length > n ? `${a.slice(0, n - 1).join("")}…` : s;
};

// ── 1. 読み方 ──

export type ReplyEntry =
  | { kind: "known"; raw: string }
  | { kind: "progress"; numbers: number[]; body: string };

const normalize = (s: string) =>
  s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, " ").trim();

// 番号（「3」「1,2」）のあとに区切り（空白・. ：）など）を置くか、区切りなしで文が続く形。
// 区切りなしのときは、数え方・時刻・日付の字が続くもの（「3件」「10時」「12/3」「3,000万」）を番号と読まない。
const PROGRESS_RE = /^(\d{1,2}(?:[,、，・]\d{1,2})*)(?![\d,，、・])(\s*[.．:：）)]\s*|\s+)?(\S[\s\S]*)$/;
const UNIT_HEAD_RE = /^[件時日月年階万円号分名人回社週番個枚本通度割坪㎡%％\/／:：~〜\-ー]/;
const BODY_MAX = 1500;

function parseProgressLine(line: string): { numbers: number[]; body: string } | null {
  const m = line.match(PROGRESS_RE);
  if (!m) return null;
  const body = m[3].trim();
  if (!m[2] && UNIT_HEAD_RE.test(body)) return null;
  const nums = (m[1].match(/\d+/g) ?? []).map(Number);
  if (nums.some((n) => n < 1 || n > 99)) return null;
  const numbers = nums.filter((n, i) => nums.indexOf(n) === i);
  return numbers.length > 0 && body ? { numbers, body } : null;
}

/**
 * まとめへの返信を行ごとに読む。進捗として受ける行が1つも無ければ null（＝今までの流れに任せる）。
 *   ・先頭の行は、今の言葉（「1済」「2待ち …」。isKnown が決める）か「番号＋文」であること
 *   ・番号で始まらない行は、直前の進捗の続き（今の言葉の行のあとに文が続く形は読まない）
 */
export function parseDigestReply(text: string, isKnown: (line: string) => boolean): ReplyEntry[] | null {
  const lines = text.split(/\r?\n/).map(normalize).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const entries: ReplyEntry[] = [];
  for (const line of lines) {
    if (isKnown(line)) {
      entries.push({ kind: "known", raw: line });
      continue;
    }
    const p = parseProgressLine(line);
    if (p) {
      entries.push({ kind: "progress", ...p });
      continue;
    }
    const last = entries[entries.length - 1];
    if (!last || last.kind !== "progress") return null;
    last.body = `${last.body} ${line}`;
  }
  if (!entries.some((e) => e.kind === "progress")) return null;
  for (const e of entries) if (e.kind === "progress") e.body = cut(e.body, BODY_MAX);
  return entries;
}

// ── 1. 進捗の取り込み ──

/** 返事で動いたタスク（下村さんへの知らせ・「返事があった」印に使う） */
export interface ReplyItem {
  id: string;
  title: string;
  /** 「済」「待ち（売主の書類）」「進捗「…」」 */
  what: string;
}

export interface DigestReplyInput {
  /** メンションを除いた本文 */
  text: string;
  quotedMessageId?: string | null;
  groupId?: string | null;
  userId?: string | null;
}

export interface DigestReplyDeps {
  env?: Env;
  now(): number;
  kv: Pick<SdKv, "get">;
  /** 今の言葉（済・完了・待ち・延期・不要）として読める行か。副作用なし */
  isKnown(line: string): boolean;
  /** 今の言葉の行を、今ある処理で実行する（1通に進捗と混ざっていたときだけ呼ぶ） */
  runKnown(line: string): Promise<{ text: string; changed: ReplyItem[] }>;
  findByNumber(n: number): Promise<{ id: string; title: string } | null>;
  appendNote(pageId: string, lines: string[]): Promise<void>;
  /** 名簿の名前。分からなければ null */
  senderName(userId: string | null): Promise<string | null>;
  reply(text: string): Promise<void>;
  /** 動いたタスクを控える（recordReplies）。例外は投げない約束 */
  note(items: ReplyItem[], name: string | null): Promise<void>;
  log(line: string): void;
}

const PROGRESS_WHAT_MAX = 60;

/**
 * まとめを引用した返信のうち、番号＋自由な文を進捗として受ける。
 * 受ける条件：STAFF_DIGEST on・グループ・引用先がまとめ（staffdigest:msg:*）・読める行が番号で始まる・進捗の行が1つ以上。
 * どれか欠ければ {handled:false}（今までの流れへ）。off・引用なし・雑談は KV も読まない。
 */
export async function handleDigestReply(
  input: DigestReplyInput,
  deps: DigestReplyDeps
): Promise<{ handled: boolean; committed: boolean }> {
  const pass = { handled: false, committed: false };
  if (!staffDigestOn(deps.env ?? process.env)) return pass;
  if (!input.groupId || !input.quotedMessageId) return pass;
  let entries: ReplyEntry[] | null;
  try {
    entries = parseDigestReply(input.text, deps.isKnown);
  } catch {
    return pass;
  }
  if (!entries) return pass;
  try {
    if (!(await deps.kv.get(digestMsgKey(input.quotedMessageId)))) return pass;
  } catch {
    deps.log("[staff-digest] reply kv-failed");
    return pass;
  }

  const name = await deps.senderName(input.userId ?? null).catch(() => null);
  const stamp = `進捗（${mdOf(jstDay(deps.now()))} ${name || "担当"}）：`;
  const knownTexts: string[] = [];
  const changed: ReplyItem[] = [];
  const ok: number[] = [];
  const notFound: number[] = [];
  const failed: number[] = [];
  let knownFailed = 0;

  for (const e of entries) {
    if (e.kind === "known") {
      try {
        const r = await deps.runKnown(e.raw);
        if (r.text) knownTexts.push(r.text);
        changed.push(...r.changed);
      } catch {
        knownFailed += 1;
      }
      continue;
    }
    for (const n of e.numbers) {
      try {
        const t = await deps.findByNumber(n);
        if (!t) {
          notFound.push(n);
          continue;
        }
        await deps.appendNote(t.id, [`${stamp}${e.body}`]);
        ok.push(n);
        changed.push({ id: t.id, title: t.title, what: `進捗「${cut(e.body, PROGRESS_WHAT_MAX)}」` });
      } catch {
        failed.push(n);
      }
    }
  }

  const lines: string[] = [];
  if (knownTexts.length > 0) lines.push(knownTexts.join("\n\n"), "");
  if (ok.length > 0) lines.push(`📝 ${ok.join("・")} の進捗を記録しました`);
  if (notFound.length > 0) lines.push(`⚠️ ${notFound.join("・")}番は見つかりませんでした`, "（完了済みか、直近のまとめに無い番号です）");
  if (failed.length > 0) lines.push(`⚠️ ${failed.join("・")} の進捗を書き込めませんでした。もう一度お試しください。`);
  if (knownFailed > 0) lines.push("⚠️ 一部の返事を処理できませんでした。その分だけ、もう一度送ってください。");
  await deps.reply(lines.join("\n").trim()).catch(() => deps.log("[staff-digest] reply send-failed"));

  if (changed.length > 0) await deps.note(changed, name).catch(() => undefined);
  deps.log(
    `[staff-digest] reply progress ${ok.length}` +
      (notFound.length > 0 ? ` not-found ${notFound.length}` : "") +
      (failed.length > 0 ? ` write-failed ${failed.length}` : "") +
      (knownFailed > 0 ? ` known-failed ${knownFailed}` : "")
  );
  return { handled: true, committed: changed.length > 0 };
}

/** 状況の言葉の言い方（下村さんへの知らせ用） */
export function statusWhat(body: StatusBody): string {
  if (body.kind === "drop") return "不要";
  if (body.kind === "postpone") return body.date ? `延期（${mdOf(body.date)}）` : "延期";
  return body.note ? `待ち（${body.note}）` : "待ち";
}

// ── 2. 下村さんへの知らせ ──

export interface FwdRow {
  at: number;
  /** 名簿の名前。分からなければ null */
  who: string | null;
  title: string;
  what: string;
}
const TITLE_MAX = 40;

export interface RecordDeps {
  env?: Env;
  kv: Pick<SdKv, "sadd" | "rpush">;
  /** 仕分ける人（inboxOwner）。いなければ知らせの列には足さない */
  owner: string | null;
  log(line: string): void;
}

/**
 * グループでの返事で動いたタスクを控える：「返事があった」印（催促の判定用）と、下村さんへの知らせの列。
 * 下村さん本人の返事は知らせに載せない。KV が落ちていても投げない。off なら KV を触らない。
 */
export async function recordReplies(
  input: { userId?: string | null; name: string | null; items: ReplyItem[]; now: number },
  deps: RecordDeps
): Promise<void> {
  if (!staffDigestOn(deps.env ?? process.env) || input.items.length === 0) return;
  try {
    await deps.kv.sadd(answeredKey(jstDay(input.now)), input.items.map((i) => i.id), DAY_TTL_SEC);
    if (deps.owner && input.userId !== deps.owner) {
      const rows: FwdRow[] = input.items.map((i) => ({
        at: input.now,
        who: input.name || null,
        title: cut(i.title, TITLE_MAX),
        what: i.what,
      }));
      await deps.kv.rpush(FWD_KEY, rows);
    }
  } catch {
    deps.log("[staff-digest] fwd note-failed");
  }
}

function asFwdRow(v: unknown): FwdRow | null {
  const r = v as Partial<FwdRow> | null;
  if (!r || typeof r !== "object" || typeof r.title !== "string" || typeof r.what !== "string") return null;
  return { at: typeof r.at === "number" ? r.at : 0, who: typeof r.who === "string" && r.who ? r.who : null, title: r.title, what: r.what };
}

export function forwardText(rows: FwdRow[], more: boolean): string {
  return [
    `💬 グループの返事（${rows.length}件）`,
    ...rows.map((r) => `・${r.who ? `${r.who}さん` : "担当"}：${r.title} → ${r.what}`),
    ...(more ? ["（続きは、次の知らせで出します）"] : []),
  ].join("\n");
}

const sentOk = (status: number | null) => status !== null && ((status >= 200 && status < 300) || status === 409);

export interface ForwardDeps {
  env?: Env;
  kv: Pick<SdKv, "setNx" | "lrange" | "ltrim">;
  owner: string | null;
  /** 1対1 へ retry key つきで push（key は retry key の元になる文字列）。HTTP の状態（結果不明は null） */
  push(to: string, messages: unknown[], key: string): Promise<number | null>;
  log(line: string): void;
}
export type ForwardResult = "off" | "no-owner" | "wait" | "empty" | "sent" | "failed";

/**
 * 毎分の見回りから呼ぶ。30分に1回（KV の印）、たまった返事をまとめて1通で下村さんの 1対1 へ。
 * 0件なら送らない。送れなければ列に残す（次の枠で送る）。off・仕分ける人なしは KV を触らない。例外は投げない。
 */
export async function flushForward(now: number, deps: ForwardDeps): Promise<ForwardResult> {
  if (!staffDigestOn(deps.env ?? process.env)) return "off";
  if (!deps.owner) return "no-owner";
  try {
    if (!(await deps.kv.setNx(FWD_GUARD_KEY, now, FWD_INTERVAL_SEC))) return "wait";
    // 上限より1件多く読み、残りがあるかを見る
    const raw = await deps.kv.lrange(FWD_KEY, 0, FWD_MAX);
    const take = raw.slice(0, FWD_MAX);
    const rows = take.map(asFwdRow).filter((r): r is FwdRow => r !== null);
    if (rows.length === 0) {
      if (take.length > 0) await deps.kv.ltrim(FWD_KEY, take.length, -1);
      return "empty";
    }
    const text = forwardText(rows, raw.length > FWD_MAX);
    const status = await deps.push(deps.owner, [{ type: "text", text }], `sd-fwd:${rows[0].at}:${rows.length}`).catch(() => null);
    if (!sentOk(status)) {
      deps.log("[staff-digest] fwd push-failed");
      return "failed";
    }
    await deps.kv.ltrim(FWD_KEY, take.length, -1);
    deps.log(`[staff-digest] fwd sent ${rows.length}`);
    return "sent";
  } catch {
    deps.log("[staff-digest] fwd error");
    return "failed";
  }
}

// ── 3. 催促 ──

export interface AmEntry {
  id: string;
  n: number;
  title: string;
  assignee: string | null;
  assigneeUserId: string | null;
  status: string;
  /** 期日（"YYYY-MM-DD"。無ければ ""） */
  due: string;
}

function asAmEntries(v: unknown): AmEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (e): e is AmEntry => Boolean(e) && typeof e === "object" && typeof (e as AmEntry).id === "string" && typeof (e as AmEntry).n === "number"
  );
}

/** 朝のまとめに出したタスクを控える（朝の送信のあと。STAFF_DIGEST on の道からだけ呼ぶ）。失敗しても投げない */
export async function saveMorningSnapshot(
  day: string,
  ordered: Array<{ n: number; task: { id: string; title: string; assignee: string | null; assigneeUserId: string | null; status: string; dueDate: string } }>,
  kv: Pick<SdKv, "set">,
  log: (line: string) => void
): Promise<void> {
  try {
    const rows: AmEntry[] = ordered.map(({ n, task }) => ({
      id: task.id,
      n,
      title: task.title,
      assignee: task.assignee ?? null,
      assigneeUserId: task.assigneeUserId ?? null,
      status: task.status,
      due: (task.dueDate ?? "").slice(0, 10),
    }));
    await kv.set(amKey(day), rows, DAY_TTL_SEC);
  } catch {
    log("[staff-digest] am snapshot-failed");
  }
}

const SD_RE = /^v1\|sd\|(\d{4}-\d{2}-\d{2})$/;
export const encodeSd = (day: string) => `v1|sd|${day}`;
export function parseSdData(data: string): { day: string } | null {
  const m = data.match(SD_RE);
  return m ? { day: m[1] } : null;
}

/** 担当ごとにまとめる（まとめの本文と同じ分け方：名前、無ければ userId。どちらも無ければ「担当が決まっていないもの」） */
function groupByAssignee(list: AmEntry[]): { groups: Array<{ name: string | null; userId: string | null; tasks: AmEntry[] }>; unassigned: AmEntry[] } {
  const groups = new Map<string, { name: string | null; userId: string | null; tasks: AmEntry[] }>();
  const unassigned: AmEntry[] = [];
  for (const t of [...list].sort((a, b) => a.n - b.n)) {
    const key = t.assignee || t.assigneeUserId;
    if (!key) {
      unassigned.push(t);
      continue;
    }
    const g = groups.get(key) ?? { name: t.assignee, userId: null, tasks: [] };
    if (!g.userId && t.assigneeUserId) g.userId = t.assigneeUserId;
    g.tasks.push(t);
    groups.set(key, g);
  }
  return { groups: Array.from(groups.values()), unassigned };
}

const CARD_LINES_MAX = 12;
const NUDGE_SUBJECT = "朝のまとめ";
const flexText = (t: string, o: Record<string, unknown> = {}) => ({ type: "text", text: t, size: "sm", color: "#333333", wrap: true, ...o });

/** 下村さんの 1対1 へ出す［催促する］のカード */
export function nudgeAskCard(day: string, silent: AmEntry[]): FlexMessage {
  const head = `朝のまとめに返事が無いタスクが ${silent.length}件あります`;
  const { groups, unassigned } = groupByAssignee(silent);
  const body: unknown[] = [flexText(head, { weight: "bold", size: "md" })];
  let shown = 0;
  const add = (label: string, tasks: AmEntry[]) => {
    if (shown >= CARD_LINES_MAX) return;
    body.push(flexText(label, { weight: "bold", margin: "md" }));
    for (const t of tasks) {
      if (shown >= CARD_LINES_MAX) break;
      body.push(flexText(`・${t.n}. ${cut(t.title, TITLE_MAX)}`));
      shown += 1;
    }
  };
  for (const g of groups) add(g.name ? `${g.name}さん` : "担当（名前なし）", g.tasks);
  if (unassigned.length > 0) add("担当が決まっていないもの", unassigned);
  if (silent.length > shown) body.push(flexText(`ほか ${silent.length - shown}件`, { color: "#555555" }));
  body.push(
    flexText("押すと、会社のグループで担当にメンションして声をかけます。押さなければ何も送りません", { color: "#555555", margin: "md" })
  );
  return {
    type: "flex",
    altText: cut(head, ALT_TEXT_MAX),
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "sm", contents: body },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            height: "sm",
            action: {
              type: "postback",
              label: cut("催促する", FLEX_LABEL_MAX),
              data: encodeSd(day),
              displayText: cut(pressedText("催促する", NUDGE_SUBJECT), POSTBACK_TEXT_MAX),
            },
          },
        ],
      },
    },
  } as FlexMessage;
}

export interface NudgeAskDeps {
  env?: Env;
  kv: Pick<SdKv, "get" | "set" | "smembers">;
  owner: string | null;
  push(to: string, messages: unknown[], key: string): Promise<number | null>;
  log(line: string): void;
}
export type NudgeAskResult = "off" | "none" | "asked" | "failed";

/**
 * 夕方のまとめを送る直前に呼ぶ（夕方の1日1回の印の中）。朝のまとめに出したタスクのうち、
 * いまも未完了の一覧にあり・状態も期日も朝のまま・返事（番号・引用・進捗）も無いものを、下村さんの 1対1 へカードで知らせる。
 * 0件・朝の控えなし・off・仕分ける人なしは送らない。例外は投げない（夕方のまとめを止めない）。
 */
export async function askNudge(
  day: string,
  current: Array<{ id: string; status: string; dueDate: string }>,
  deps: NudgeAskDeps
): Promise<NudgeAskResult> {
  if (!staffDigestOn(deps.env ?? process.env) || !deps.owner) return "off";
  try {
    const am = asAmEntries(await deps.kv.get(amKey(day)));
    if (am.length === 0) return "none";
    const answered = new Set(await deps.kv.smembers(answeredKey(day)));
    const cur = new Map(current.map((t) => [t.id, t]));
    const silent = am.filter((a) => {
      const c = cur.get(a.id);
      return Boolean(c) && c!.status === a.status && (c!.dueDate ?? "").slice(0, 10) === a.due && !answered.has(a.id);
    });
    if (silent.length === 0) return "none";
    await deps.kv.set(nudgeKey(day), silent, DAY_TTL_SEC);
    const status = await deps.push(deps.owner, [nudgeAskCard(day, silent)], `sd-nudge-ask:${day}`).catch(() => null);
    if (!sentOk(status)) {
      deps.log("[staff-digest] nudge ask-failed");
      return "failed";
    }
    deps.log(`[staff-digest] nudge asked ${silent.length}`);
    return "asked";
  } catch {
    deps.log("[staff-digest] nudge ask-failed");
    return "failed";
  }
}

const NUDGE_ASK = "朝の件、進み具合を返信で教えてください";
const NUDGE_FOOTER = "朝のまとめか、このメッセージに返信（リプライ）で、番号をつけて答えてください";
const MAX_MENTIONS = 20;

/** グループへ出す催促（文字だけ・担当ごとに1行・メンション）。1通にまとめる */
export function nudgeChunks(list: AmEntry[]): Chunk[] {
  const { groups, unassigned } = groupByAssignee(list);
  const mentions: Record<string, string> = {};
  const lines: string[] = [];
  for (const g of groups) {
    const nums = `（${g.tasks.map((t) => t.n).join(", ")}）`;
    const count = Object.keys(mentions).length;
    if (g.userId && count < MAX_MENTIONS) {
      const key = `m${count + 1}`;
      mentions[key] = g.userId;
      lines.push(`{${key}} ${NUDGE_ASK}${nums}`);
    } else {
      lines.push(`${sanitizeForTextV2(g.name ?? "担当")}さん ${NUDGE_ASK}${nums}`);
    }
  }
  if (unassigned.length > 0) {
    lines.push(`担当が決まっていないもの（${unassigned.map((t) => t.n).join(", ")}）：どなたが進めるか、返信で教えてください`);
  }
  return [{ text: [...lines, "", NUDGE_FOOTER].join("\n"), mentions }];
}

export const MSG_SD_PAUSED = "いまは止めています";
export const MSG_SD_OWNER_ONLY = "このボタンを押せるのは下村さんだけです";
export const MSG_SD_STALE = "このカードは古くなりました（催促できるのは、その日のうちだけです）";
export const MSG_SD_NONE = "もう全員から返事が届いています";
export const MSG_SD_ALREADY = "もう送ってあります";
export const MSG_SD_FAILED = "⚠️ 送れなかったようです。グループに出ていなければ、もう一度押してください";
export const msgSdSent = (n: number) => `📣 グループへ催促を送りました（${n}件）`;

export interface NudgeDeps {
  env?: Env;
  kv: Pick<SdKv, "get" | "set" | "setNx" | "del" | "smembers">;
  owner: string | null;
  now(): number;
  /** 会社のグループへ順に送り、送れた通数とメッセージ ID を返す */
  pushGroup(chunks: Chunk[]): Promise<{ sent: number; ids: string[] }>;
  reply(text: string): Promise<void>;
  log(line: string): void;
}

/**
 * ［催促する］（v1|sd|<JSTの日付>）。押せるのは仕分ける人だけ・その日のうちだけ・1日1回（二度押しは「もう送ってあります」）。
 * カードを出したあとに返事の来たタスクは外す。送れなければ印を外す（もう一度押せる）。例外は投げない。
 */
export async function handleSdPostback(a: { day: string }, src: { userId?: string | null }, deps: NudgeDeps): Promise<void> {
  const say = (text: string, code: string) => {
    deps.log(`[staff-digest] nudge ${code}`);
    return deps.reply(text).catch(() => deps.log("[staff-digest] nudge reply-failed"));
  };
  if (!staffDigestOn(deps.env ?? process.env)) return say(MSG_SD_PAUSED, "paused");
  if (!deps.owner || src.userId !== deps.owner) return say(MSG_SD_OWNER_ONLY, "denied");
  if (a.day !== jstDay(deps.now())) return say(MSG_SD_STALE, "stale");
  try {
    const answered = new Set(await deps.kv.smembers(answeredKey(a.day)));
    const list = asAmEntries(await deps.kv.get(nudgeKey(a.day))).filter((e) => !answered.has(e.id));
    if (list.length === 0) return say(MSG_SD_NONE, "none");
    if (!(await deps.kv.setNx(nudgedKey(a.day), deps.now(), DAY_TTL_SEC))) return say(MSG_SD_ALREADY, "already");
    const r = await deps.pushGroup(nudgeChunks(list)).catch(() => ({ sent: 0, ids: [] as string[] }));
    if (r.sent === 0) {
      await deps.kv.del(nudgedKey(a.day)).catch(() => undefined);
      return say(MSG_SD_FAILED, "push-failed");
    }
    // 催促のメッセージへの返信も、まとめへの返信として受けられるようにする（控えられなくても催促は届いている）
    for (const id of r.ids) {
      await deps.kv.set(digestMsgKey(id), { at: deps.now(), slot: "nudge" }, DIGEST_MSG_TTL_SEC).catch(() => undefined);
    }
    return say(msgSdSent(list.length), "sent");
  } catch {
    return say(MSG_SD_FAILED, "error");
  }
}
