/**
 * 案件ページに LINE の動きを溜める（DEAL_LOG・2026-11-28）。
 * 下村さん「LINE とかで動きがあったものが、Notion に勝手に溜まっていくみたいな仕組み」「確認は Notion 上でしてもらう」。
 *
 *   ・溜めるのは、案件にひも付くと決められた発言だけ。決められないものは当てずっぽうにせず、溜めない（聞きもしない）
 *   ・決め方（AI は使わない）：a 本文に、進行中の案件ちょうど1件の名前（「｜」で分けた部分）が入っている
 *                             b ひも付いた発言への引用
 *                             c ひも付いた発言のあと5分以内の、同じ人の画像・ファイル・動画
 *   ・ひも付いたら KV の列 deallog:q に1行（本文は頭300字）。2分に1回の見回りが、案件ごとに Notion のページ本文の末尾へ足す
 *   ・CRM_案件 の欄（フェーズ・担当・歩合など）には書かない。本文だけ
 * ここは判断と形だけ。KV・Notion・名簿は渡してもらう（本物は deal-log-wire.ts）。どの関数も例外を投げない。ログに本文・名前・ID は出さない。
 */
import { normalizeProperty } from "./property";
import type { DealRef } from "./task-record";

export const dealLogOn = (env: Record<string, string | undefined> = process.env): boolean => env.DEAL_LOG === "1";

export const DL_Q = "deallog:q";
export const DL_FLUSH_GUARD = "deallog:flush";
export const dlMsgKey = (messageId: string) => `deallog:msg:${messageId}`;
export const dlLastKey = (groupId: string, userId: string) => `deallog:last:${groupId}:${userId}`;
export const dlHeadKey = (dealId: string) => `deallog:head:${dealId}`;

export const DL_Q_MAX = 500;
export const DL_Q_TTL_SEC = 2 * 24 * 60 * 60;
/** 列の行は2日より古くなったら書かずに捨てる（発言の控えを KV に長く残さない） */
export const DL_ROW_TTL_MS = DL_Q_TTL_SEC * 1000;
export const DL_MSG_TTL_SEC = 3 * 24 * 60 * 60;
export const DL_LAST_TTL_SEC = 10 * 60;
export const DL_FOLLOW_MS = 5 * 60 * 1000;
export const DL_HEAD_TTL_SEC = 30 * 24 * 60 * 60;
/** 書き出しは2分に1回（毎分の見回りの1回おき。印が先に切れているよう少し短くしてある） */
export const DL_FLUSH_GUARD_SEC = 110;
export const DL_FLUSH_BUDGET_MS = 10_000;
/** 残りがこれを切ったら、新しい案件には手を付けない */
export const DL_FLUSH_MIN_LEFT_MS = 2_500;
export const DL_FLUSH_DEALS = 5;
/** 進行中の一覧に無い案件の行を捨てるまでの待ち（一覧の覚え5分より長く） */
export const DL_CLOSED_WAIT_MS = 10 * 60 * 1000;
export const DL_FLUSH_ROWS = 40;
export const DL_TEXT_MAX = 300;
export const DL_RICH_MAX = 1900;
export const DL_HEAD_SCAN_PAGES = 2; // 100件×2＝200ブロックまで
export const DL_HEADING = "LINE の動き（自動記録）";
export const DL_LOAD_TIMEOUT_MS = 2_000;
export const DL_KV_TIMEOUT_MS = 1_500;
export const DL_NAME_TIMEOUT_MS = 1_500;
const DL_KEY_MIN = 4;

export type DlKind = "text" | "image" | "file" | "video";
export type DlVia = "name" | "quote" | "follow";
export interface DlRow {
  dealId: string;
  /** 発言の時刻（ms） */
  at: number;
  /** 名簿の名前。無ければ「不明」 */
  who: string;
  kind: DlKind;
  /** 本文の頭300字（改行は空白）。画像・ファイル・動画は空 */
  text: string;
  via: DlVia;
}
export interface DlLast {
  dealId: string;
  at: number;
}
export interface DlEvent {
  groupId?: string | null;
  senderId?: string | null;
  messageId: string;
  kind: DlKind;
  text?: string;
  quotedMessageId?: string | null;
  at: number;
}

const within = <T>(p: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};

// ── 名前の一致 ──

// 案件名の部分としてよく付く、物件を指さない言葉（これだけの部分は照合に使わない）
const GENERIC = new Set(
  [
    "売り", "買い", "売却", "購入", "買取", "仲介", "管理", "賃貸", "売買", "再販", "査定", "両手仲介", "片手仲介", "買取再販", "売買仲介",
    "賃貸管理", "賃貸仲介", "売却査定", "価格査定", "賃料査定", "査定依頼", "顧客未定", "マンション", "中古マンション", "新築マンション",
    "一戸建て", "戸建て", "中古戸建", "新築戸建", "中古戸建て", "新築戸建て", "収益物件", "収益マンション", "オーナーチェンジ", "自己案件", "会社案件",
  ].map((w) => normalizeProperty(w)),
);
const DIGIT = /[0-9]/;
// 本文の括弧は外して中身を残す（鍵のほうは括弧の中を落としてあるので、「（天満ハイツ302）」も当たるように）
const textKey = (text: string) => normalizeProperty((text ?? "").replace(/[（(【［\[）)】］\]]/g, " "));

/** 案件名を「｜」で分けた各部分のうち、照合に使える鍵（4字以上・一般的な言葉でない・数字や英数字だけでない） */
export function dealTextKeys(name: string): string[] {
  const keys = (name ?? "")
    .split(/[｜|]/)
    .map((p) => normalizeProperty(p))
    .filter((k) => Array.from(k).length >= DL_KEY_MIN && !GENERIC.has(k) && !/^[0-9a-z.,]+$/.test(k) && !/^[0-9.,]+(万|億)?円?$/.test(k));
  return keys.filter((k, i) => keys.indexOf(k) === i);
}

/** 鍵が本文に入っているか。数字の続き（302 と 3021、12 と 112）は別のものとして当てない */
function hasKey(hay: string, key: string): boolean {
  for (let i = hay.indexOf(key); i >= 0; i = hay.indexOf(key, i + 1)) {
    const before = i > 0 ? hay[i - 1] : "";
    const after = hay[i + key.length] ?? "";
    if (DIGIT.test(key[0]) && DIGIT.test(before)) continue;
    if (DIGIT.test(key[key.length - 1]) && DIGIT.test(after)) continue;
    return true;
  }
  return false;
}

/** 本文に名前の入っている進行中の案件（同じ ID は1回）。ちょうど1件かどうかは呼ぶ側が見る */
export function matchDealsInText(text: string, deals: DealRef[]): DealRef[] {
  const hay = textKey(text);
  if (!hay) return [];
  const hits: DealRef[] = [];
  for (const d of deals) {
    if (hits.some((h) => h.id === d.id)) continue;
    if (dealTextKeys(d.name).some((k) => hasKey(hay, k))) hits.push(d);
  }
  return hits;
}

// ── 控える（webhook） ──

export interface DlCommit {
  msgKey: string;
  /** 「最後のひも付け」を書く鍵。書かないとき（続きの添付・送り主が分からない）は null */
  lastKey: string | null;
  row: DlRow;
  last: DlLast | null;
}
export interface DlCaptureKv {
  get(key: string): Promise<unknown>;
  /** 発言の印を SET NX で取り、取れたときだけ列に足して印を書く（1回の呼び出し）。もう印があれば false */
  commit(c: DlCommit): Promise<boolean>;
}
export interface DlCaptureDeps {
  on: boolean;
  botUserId?: string | null;
  loadDeals(): Promise<DealRef[]>;
  /** 名簿の名前。無ければ null */
  nameOf(userId: string): Promise<string | null>;
  kv: DlCaptureKv;
  loadTimeoutMs?: number;
}
export type DlOutcome = "off" | "skip" | "unmatched" | "ambiguous" | "dup" | "error" | DlVia;

const idOf = (v: unknown): string | null => {
  let x = v;
  if (typeof x === "string" && x.startsWith('"')) {
    try {
      x = JSON.parse(x);
    } catch {
      return null;
    }
  }
  return typeof x === "string" && x ? x : null;
};
const lastOf = (v: unknown): DlLast | null => {
  let x = v;
  if (typeof x === "string") {
    try {
      x = JSON.parse(x);
    } catch {
      return null;
    }
  }
  const o = x as Partial<DlLast> | null;
  return o && typeof o === "object" && typeof o.dealId === "string" && o.dealId && typeof o.at === "number" ? { dealId: o.dealId, at: o.at } : null;
};
const cutText = (s: string): string => {
  const a = Array.from((s ?? "").replace(/\s+/g, " ").trim());
  return a.length > DL_TEXT_MAX ? `${a.slice(0, DL_TEXT_MAX - 1).join("")}…` : a.join("");
};

/**
 * グループの発言1件を、ひも付く案件が決まったときだけ列に足す。
 * off・1対1・Bot 自身は何も呼ばない。決まらない・読めない・遅いは黙って飛ばす。
 */
export async function captureDealLog(ev: DlEvent, d: DlCaptureDeps): Promise<DlOutcome> {
  if (!d.on) return "off";
  try {
    if (!ev.groupId || !ev.messageId) return "skip";
    if (d.botUserId && ev.senderId === d.botUserId) return "skip";
    const media = ev.kind !== "text";
    const quoted = async (): Promise<string | null> =>
      ev.quotedMessageId ? idOf(await within(d.kv.get(dlMsgKey(String(ev.quotedMessageId))), DL_KV_TIMEOUT_MS)) : null;

    let dealId: string | null = null;
    let via: DlVia = "name";
    if (!media) {
      const deals = await within(d.loadDeals(), d.loadTimeoutMs ?? DL_LOAD_TIMEOUT_MS);
      const hits = matchDealsInText(ev.text ?? "", deals);
      if (hits.length === 1) dealId = hits[0].id;
      else {
        const q = await quoted();
        // 本文が2件以上を名指ししているときは、引用先がそのうちの1件のときだけ引用で決める
        if (q && (hits.length === 0 || hits.some((h) => h.id === q))) {
          dealId = q;
          via = "quote";
        } else if (hits.length > 1) return "ambiguous";
      }
    } else {
      const q = await quoted();
      if (q) {
        dealId = q;
        via = "quote";
      } else if (ev.senderId) {
        const last = lastOf(await within(d.kv.get(dlLastKey(ev.groupId, ev.senderId)), DL_KV_TIMEOUT_MS));
        if (last && ev.at >= last.at && ev.at - last.at <= DL_FOLLOW_MS) {
          dealId = last.dealId;
          via = "follow";
        }
      }
    }
    if (!dealId) return "unmatched";

    let who: string | null = null;
    if (ev.senderId) who = await within(d.nameOf(ev.senderId), DL_NAME_TIMEOUT_MS).catch(() => null);
    const row: DlRow = { dealId, at: ev.at, who: who || "不明", kind: ev.kind, text: media ? "" : cutText(ev.text ?? ""), via };
    // 続きの添付では「最後のひも付け」を書き直さない（画像が続くだけで5分が延び続けないように）
    const setLast = via !== "follow" && Boolean(ev.senderId);
    const added = await within(
      d.kv.commit({
        msgKey: dlMsgKey(ev.messageId),
        lastKey: setLast ? dlLastKey(ev.groupId, ev.senderId as string) : null,
        row,
        last: setLast ? { dealId, at: ev.at } : null,
      }),
      DL_KV_TIMEOUT_MS,
    );
    return added ? via : "dup";
  } catch {
    return "error";
  }
}

// ── 行の形 ──

const KIND_LABEL: Record<Exclude<DlKind, "text">, string> = { image: "（画像）", file: "（ファイル）", video: "（動画）" };
const p2 = (n: number) => String(n).padStart(2, "0");

/** 「11/28 16:40 小笠原：本文」（JST） */
export function formatDlRow(r: DlRow): string {
  const j = new Date(r.at + 9 * 60 * 60 * 1000);
  const body = r.kind === "text" ? r.text : KIND_LABEL[r.kind];
  return `${j.getUTCMonth() + 1}/${j.getUTCDate()} ${p2(j.getUTCHours())}:${p2(j.getUTCMinutes())} ${r.who}：${body}`;
}

/** Notion の rich_text（1つ 1900 字まで）に分ける */
export function richChunks(s: string): Array<{ type: "text"; text: { content: string } }> {
  const a = Array.from(s);
  const out: Array<{ type: "text"; text: { content: string } }> = [];
  for (let i = 0; i < a.length; i += DL_RICH_MAX) out.push({ type: "text", text: { content: a.slice(i, i + DL_RICH_MAX).join("") } });
  return out.length > 0 ? out : [{ type: "text", text: { content: "" } }];
}
const headingBlock = () => ({ object: "block", type: "heading_2", heading_2: { rich_text: richChunks(DL_HEADING) } });
const bulletBlock = (r: DlRow) => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: richChunks(formatDlRow(r)) } });

function isHeading(block: unknown): boolean {
  const b = block as { type?: string; heading_2?: { rich_text?: Array<{ plain_text?: string; text?: { content?: string } }> } } | null;
  if (!b || b.type !== "heading_2") return false;
  return (b.heading_2?.rich_text ?? []).map((t) => t.plain_text ?? t.text?.content ?? "").join("") === DL_HEADING;
}

// ── 書き出す（毎分の見回り） ──

export interface DlFlushKv {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, exSec: number): Promise<void>;
  setNx(key: string, value: unknown, exSec: number): Promise<boolean>;
  /** 列の頭から count 行を読む（消さない） */
  peek(count: number): Promise<unknown[]>;
  /** 列の頭の taken 行を消し、head を頭に（順番のまま）・tail を後ろに戻す（1回の呼び出し） */
  settle(taken: number, head: DlRow[], tail: DlRow[]): Promise<void>;
}
export interface DlNotion {
  /** ページの最上位のブロックを100件ずつ */
  list(pageId: string, cursor?: string): Promise<{ results: unknown[]; next: string | null }>;
  append(pageId: string, children: unknown[]): Promise<void>;
}
export interface DlFlushDeps {
  on: boolean;
  kv: DlFlushKv;
  notion: DlNotion;
  /** 進行中（完了・失注以外）の案件。ここに無い案件には書かない */
  loadDeals(): Promise<DealRef[]>;
  log(line: string): void;
  clock?: () => number;
  budgetMs?: number;
}

function rowOf(raw: unknown): DlRow | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  const r = v as Partial<DlRow> | null;
  if (!r || typeof r !== "object" || typeof r.dealId !== "string" || !r.dealId || typeof r.at !== "number") return null;
  const kind: DlKind | null = r.kind === "text" || r.kind === "image" || r.kind === "file" || r.kind === "video" ? r.kind : null;
  if (!kind) return null;
  const via: DlVia = r.via === "quote" || r.via === "follow" ? r.via : "name";
  return { dealId: r.dealId, at: r.at, who: typeof r.who === "string" && r.who ? r.who : "不明", kind, text: typeof r.text === "string" ? r.text : "", via };
}
const errCode = (err: unknown): string => {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^[a-z_]{1,40}$/.test(c) ? c : (err as Error | null)?.message === "timeout" ? "timeout" : "error";
};
const normId = (id: string) => id.replace(/-/g, "").toLowerCase();

/** 見出しがもうあるか。分からない（読めない・200件見ても無い）ときは false＝足す側に倒す（印が無いときだけ呼ぶ） */
async function pageHasHeading(pageId: string, d: DlFlushDeps, left: () => number): Promise<boolean> {
  try {
    let cursor: string | undefined;
    for (let i = 0; i < DL_HEAD_SCAN_PAGES; i++) {
      if (left() < DL_FLUSH_MIN_LEFT_MS) return false;
      const r = await within(d.notion.list(pageId, cursor), left());
      if (r.results.some(isHeading)) return true;
      if (!r.next) return false;
      cursor = r.next;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 列にたまった行を、案件ごとに Notion のページ本文の末尾へ足す。2分に1回・1回に5案件40行・合わせて約10秒まで。
 * Notion が失敗した案件の行は列に戻す（消さない）。例外は投げない。
 */
export async function flushDealLog(now: number, d: DlFlushDeps): Promise<void> {
  if (!d.on) return;
  try {
    const clock = d.clock ?? Date.now;
    const deadline = clock() + (d.budgetMs ?? DL_FLUSH_BUDGET_MS);
    const left = () => deadline - clock();
    if (!(await within(d.kv.setNx(DL_FLUSH_GUARD, now, DL_FLUSH_GUARD_SEC), DL_KV_TIMEOUT_MS * 2))) return;
    const raw = await within(d.kv.peek(DL_FLUSH_ROWS), DL_KV_TIMEOUT_MS * 2);
    if (raw.length === 0) return;

    let dropped = 0;
    const rows: DlRow[] = [];
    for (const x of raw) {
      const r = rowOf(x);
      if (!r || now - r.at > DL_ROW_TTL_MS) dropped++;
      else rows.push(r);
    }
    let active: Set<string>;
    try {
      active = new Set((await within(d.loadDeals(), Math.min(3_000, Math.max(1, left())))).map((x) => normId(x.id)));
    } catch {
      // 進行中かどうか分からない回は書かない（完了・失注の案件に書かないため）。列はそのまま
      d.log("[deal-log] flush deals-unreadable");
      return;
    }

    const byDeal = new Map<string, DlRow[]>();
    for (const r of rows) byDeal.set(r.dealId, [...(byDeal.get(r.dealId) ?? []), r]);
    const kept: DlRow[] = [];
    const failed: DlRow[] = [];
    const keptIds = new Set<string>();
    let deals = 0;
    let written = 0;
    let tried = 0;
    for (const [dealId, list] of Array.from(byDeal)) {
      if (!active.has(normId(dealId))) {
        // 進行中の一覧に無い＝完了・失注になった。ただし一覧は5分覚えているので、控えたばかりの行（登録したての案件かもしれない）は次の回まで待つ
        if (list.some((r) => now - r.at < DL_CLOSED_WAIT_MS)) keptIds.add(dealId);
        else dropped += list.length;
        continue;
      }
      if (tried >= DL_FLUSH_DEALS || left() < DL_FLUSH_MIN_LEFT_MS) {
        keptIds.add(dealId);
        continue;
      }
      tried++;
      try {
        const marked = Boolean(await within(d.kv.get(dlHeadKey(dealId)), DL_KV_TIMEOUT_MS).catch(() => null));
        const needHead = !marked && !(await pageHasHeading(dealId, d, left));
        const sorted = list.map((r, i) => ({ r, i })).sort((a, b) => a.r.at - b.r.at || a.i - b.i).map((x) => x.r);
        await within(d.notion.append(dealId, [...(needHead ? [headingBlock()] : []), ...sorted.map(bulletBlock)]), Math.max(1, left()));
        deals++;
        written += list.length;
        // 印は書くたびに延ばす（動きのある案件では、ページを読み直さない）
        await within(d.kv.set(dlHeadKey(dealId), 1, DL_HEAD_TTL_SEC), DL_KV_TIMEOUT_MS).catch(() => undefined);
      } catch (err) {
        failed.push(...list);
        d.log(`[deal-log] append-failed ${errCode(err)}`);
      }
    }
    for (const r of rows) if (keptIds.has(r.dealId)) kept.push(r);
    try {
      await within(d.kv.settle(raw.length, kept, failed), DL_KV_TIMEOUT_MS * 2);
    } catch {
      // 片付けられなかった＝列は元のまま（書けた行が次の回にもう一度書かれることがある。消えはしない）
      d.log("[deal-log] settle-failed");
      return;
    }
    d.log(`[deal-log] flush deals ${deals} rows ${written} fail ${failed.length} kept ${kept.length} dropped ${dropped}`);
  } catch {
    d.log("[deal-log] flush error");
  }
}
