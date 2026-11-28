/**
 * 案件ページに LINE の動きを溜める（DEAL_LOG・2026-11-28）。
 * 下村さん「LINE とかで動きがあったものが、Notion に勝手に溜まっていくみたいな仕組み」「確認は Notion 上でしてもらう」。
 *
 *   ・溜めるのは、案件にひも付くと決められた発言だけ。決められないものは当てずっぽうにせず、溜めない（聞きもしない）
 *   ・決め方（AI は使わない）：a 本文に、進行中の案件の名前・お客様・町名・建物名のどれかが入っていて、1件に決まる
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
// 進行中の案件名の実際の形（2026-11-28 に確かめた）は「｜」区切りではなく、
//   住所「門真市月出町16-15」「川西市水明台3-1-16（村上様）」「枚方市出口町 戸建て」／建物＋号室「…中之島タワー618号（柏原様）」「…六甲の丘D304」／
//   そのほか「嘉祥様」「武庫川団地」「大阪市内MT」。
// 人は「月出町の件」「柏原様」「…レジデンスの502」と書くので、案件ごとに鍵を作って照らす（どれも物件の鍵と同じ規則でゆれを吸収してから）。

// 案件名（やその部分）としてよく付く、物件を指さない言葉（これだけの名前は照合に使わない）
const GENERIC = new Set(
  [
    "売り", "買い", "売却", "購入", "買取", "仲介", "管理", "賃貸", "売買", "再販", "査定", "両手仲介", "片手仲介", "買取再販", "売買仲介",
    "賃貸管理", "賃貸仲介", "売却査定", "価格査定", "賃料査定", "査定依頼", "顧客未定", "マンション", "中古マンション", "新築マンション",
    "一戸建て", "戸建て", "中古戸建", "新築戸建", "中古戸建て", "新築戸建て", "収益物件", "収益マンション", "オーナーチェンジ", "自己案件", "会社案件",
  ].map((w) => normalizeProperty(w)),
);
const DIGIT = /[0-9]/;
const HAN = /[\u4e00-\u9fff]/;
const BRACKETS = /[（(【［\[][^（(【［\[）)】］\]]*[）)】］\]]/g;
const len = (s: string) => Array.from(s).length;
// 本文の括弧は外して中身を残す（鍵のほうは括弧の中を落としてあるので、「（月出町）」も当たるように）
const textKey = (text: string) => normalizeProperty((text ?? "").replace(/[（(【［\[）)】］\]]/g, " "));
const usableFull = (k: string) => len(k) >= DL_KEY_MIN && !GENERIC.has(k) && !/^[0-9a-z.,]+$/.test(k) && !/^[0-9.,]+(万|億)?円?$/.test(k);

/** 案件1件の鍵。full＝名前そのもの（強い）／customer＝お客様（弱い）／town＝町名（弱い）／building＝号室を除いた建物名（弱い。rooms と一緒なら強い） */
export interface DlDealKeys {
  full: string[];
  customer: string[];
  town: string | null;
  /** 町名のあとに続く番地の数字（「月出町16-15」→「1615」）。本文の番地が食い違うときは町名で当てない */
  townDigits: string;
  building: string | null;
  rooms: string[];
}

const PERSON = /^[\u4e00-\u9fffぁ-んァ-ヶー々]{1,8}(?:[ 　]+[\u4e00-\u9fffぁ-んァ-ヶー々]{1,8})?(?:様|さん|社長)$/;
const HONORIFIC = /(様|さん|社長)$/;
/** 「村上様」「寺本 昌司様」「田中社長」→ 姓＋様・姓＋さん（社長は 姓＋社長 だけ）。姓は空白の前・2字以上 */
function customerKeys(person: string): string[] {
  const m = HONORIFIC.exec(person.trim());
  if (!m) return [];
  const body = person.trim().slice(0, -m[1].length).trim();
  const surname = body.split(/[\s　]+/)[0] ?? "";
  if (len(surname) < 2 || !/^[\u4e00-\u9fffぁ-んァ-ヶー々]+$/.test(surname)) return [];
  const forms = m[1] === "社長" ? [`${surname}社長`] : [`${surname}様`, `${surname}さん`];
  // 氏名で書かれたとき（「寺本昌司様」）も同じお客様
  if (body !== surname) forms.push(`${body}${m[1]}`);
  return forms.map((f) => normalizeProperty(f)).filter(Boolean);
}

const PREF = /^(東京都|北海道|(?:京都|大阪)府|[\u4e00-\u9fff]{2,3}県)/;
const ADDR = /^([\u4e00-\u9fffぁ-んケヶノ]{1,6}?)市(.*)$/;
const KIND_TAIL = /[\s　]*(一?戸建て?|土地|マンション|アパート|店舗|倉庫|駐車場)$/;
const ROOM_GO = /^(.*?)[\s　]*([A-Za-z]?[0-9]{2,4})[\s　]*号室?$/;
const ROOM_BARE = /^(.*?)[\s　]*([A-Za-z][0-9]{2,4}|[0-9]{3,4})$/;

function keysOfPart(part: string, out: DlDealKeys): void {
  const raw = (part ?? "").normalize("NFKC").trim();
  if (!raw) return;
  // 末尾の「（…様）」はお客様。「（青春）」「(2筆)」のような人でない括弧からは作らない
  const tail = /[（(]([^（()）]*)[）)]\s*$/.exec(raw);
  if (tail && HONORIFIC.test(tail[1].trim())) out.customer.push(...customerKeys(tail[1]));
  // 頭の「（査定）」なども含め、括弧は中身ごと外して名前の本体にする
  const base = raw.replace(BRACKETS, " ").replace(/\s+/g, " ").trim();
  if (!base) return;
  if (PERSON.test(base)) {
    // 名前がお客様だけの案件（「嘉祥様」）。名前そのものも「お客様」の鍵として扱う（強い鍵にはしない）
    out.customer.push(...customerKeys(base));
    return;
  }
  const full = normalizeProperty(base);
  if (usableFull(full)) out.full.push(full);

  const addr = ADDR.exec(base.replace(PREF, ""));
  if (addr) {
    // 住所の形：種別の言葉を除いた形（「枚方市出口町 戸建て」→「枚方市出口町」）も名前そのものとして使う
    const core = normalizeProperty(base.replace(KIND_TAIL, ""));
    if (core !== full && usableFull(core)) out.full.push(core);
    // 町名：最初の「市」（続く「…区」）のあとの、数字・空白・英字までのかな漢字。末尾の「二丁目」は落とす。3字以上
    const rest = addr[2].replace(/^[\u4e00-\u9fff]{1,4}区/, "");
    const run = (/^[\u4e00-\u9fffぁ-んァ-ヶ々]+/.exec(rest)?.[0] ?? "").replace(/[一二三四五六七八九十〇]+丁目$/, "");
    const town = normalizeProperty(run);
    if (len(run) >= 3 && town && !GENERIC.has(town) && !out.town) {
      out.town = town;
      const at = full.indexOf(town);
      out.townDigits = at >= 0 ? full.slice(at + town.length).replace(/[^0-9]/g, "") : "";
    }
    return;
  }
  // 建物＋号室の形：号室を除いた建物名（5字以上）と、号室の数字
  const room = ROOM_GO.exec(base) ?? ROOM_BARE.exec(base);
  if (room && !out.building) {
    const b = normalizeProperty(room[1]);
    // 建物名＋号室の数字（「ジオ北浜1205」。「号」を書かない言い方・建物名が短いときのための、名前そのものと同じ強さの鍵）
    const joined = b ? `${b}${room[2].toLowerCase()}` : "";
    if (b && !GENERIC.has(b) && usableFull(joined) && !out.full.includes(joined)) out.full.push(joined);
    if (len(b) >= 5 && !GENERIC.has(b) && !/^[0-9a-z.,]+$/.test(b)) {
      out.building = b;
      const tok = room[2].toLowerCase();
      out.rooms = /^[a-z]/.test(tok) ? [tok, tok.slice(1)] : [tok];
    }
  }
}

/** 案件名から照合の鍵を作る（「｜」があれば各部分から。自動登録の「査定｜顧客未定｜物件名」のため） */
export function dealTextKeys(name: string): DlDealKeys {
  const out: DlDealKeys = { full: [], customer: [], town: null, townDigits: "", building: null, rooms: [] };
  for (const part of (name ?? "").split(/[｜|]/)) keysOfPart(part, out);
  out.full = out.full.filter((k, i) => out.full.indexOf(k) === i);
  out.customer = out.customer.filter((k, i) => out.customer.indexOf(k) === i);
  return out;
}

type KeyOk = (hay: string, at: number, key: string) => boolean;
/** 鍵が本文に入っているか。数字の続き（302 と 3021、12 と 112）は別のものとして当てない。ok でさらに絞る */
function hasKey(hay: string, key: string, ok?: KeyOk): boolean {
  if (!key) return false;
  for (let i = hay.indexOf(key); i >= 0; i = hay.indexOf(key, i + 1)) {
    const before = i > 0 ? hay[i - 1] : "";
    const after = hay[i + key.length] ?? "";
    if (DIGIT.test(key[0]) && DIGIT.test(before)) continue;
    if (DIGIT.test(key[key.length - 1]) && DIGIT.test(after)) continue;
    if (ok && !ok(hay, i, key)) continue;
    return true;
  }
  return false;
}
// お客様の鍵は、前が漢字なら当てない（「上村上様」の中の「村上様」）。よくある前置き（売主・買主・号室 など）のすぐ後ろは当てる
const BEFORE_NAME = /(売主|買主|貸主|借主|家主|地主|施主|号|室|棟)$/;
const noKanjiBefore: KeyOk = (hay, at) => !(at > 0 && HAN.test(hay[at - 1])) || BEFORE_NAME.test(hay.slice(Math.max(0, at - 2), at));
// 号室の数字は、前が英数字なら当てない（「a304」の中の「304」）
const roomStart: KeyOk = (hay, at) => !(at > 0 && /[0-9a-z]/.test(hay[at - 1]));

interface DlHit {
  deal: DealRef;
  strong: boolean;
}
function hitOf(hay: string, deal: DealRef, k: DlDealKeys): DlHit | null {
  const full = k.full.some((key) => hasKey(hay, key));
  const customer = k.customer.some((key) => hasKey(hay, key, noKanjiBefore));
  // 町名：すぐ後ろに番地の数字が書いてあって、案件の番地と食い違うなら別の物件（「月出町20-1」は「月出町16-15」の案件に当てない）
  const town =
    k.town !== null &&
    hasKey(hay, k.town, (h, at, key) => {
      const d = /^[0-9]+/.exec(h.slice(at + key.length))?.[0] ?? "";
      return !d || !k.townDigits || k.townDigits.startsWith(d) || d.startsWith(k.townDigits);
    });
  const roomInText = k.rooms.some((r) => hasKey(hay, r, roomStart));
  // 建物名：すぐ後ろに別の号室が書いてあって、この案件の号室が本文のどこにも無いなら別の部屋（「…レジデンス805」は 502号 の案件に当てない）
  const building =
    k.building !== null &&
    hasKey(hay, k.building, (h, at, key) => {
      const r = /^(?:の)?([a-z]?[0-9]{2,4})(?![0-9])/.exec(h.slice(at + key.length))?.[1];
      return !r || k.rooms.includes(r) || roomInText;
    });
  const room = building && roomInText;
  if (!full && !customer && !town && !building) return null;
  // 強い当たり：名前そのもの／建物名＋号室／町名とお客様の両方
  return { deal, strong: full || room || (town && customer) };
}

const keyCache = new WeakMap<DealRef[], DlDealKeys[]>();
function hitsInText(text: string, deals: DealRef[]): DlHit[] {
  const hay = textKey(text);
  if (!hay) return [];
  let keys = keyCache.get(deals);
  if (!keys) {
    keys = deals.map((d) => dealTextKeys(d.name));
    keyCache.set(deals, keys);
  }
  const hits: DlHit[] = [];
  deals.forEach((d, i) => {
    if (hits.some((h) => h.deal.id === d.id)) return;
    const h = hitOf(hay, d, (keys as DlDealKeys[])[i]);
    if (h) hits.push(h);
  });
  return hits;
}

/** 本文がどれかの鍵で当たった進行中の案件（同じ ID は1回） */
export function matchDealsInText(text: string, deals: DealRef[]): DealRef[] {
  return hitsInText(text, deals).map((h) => h.deal);
}

/**
 * 本文から案件を1件に決める。当たった案件がちょうど1件ならそれ。複数に当たったときは、強い当たり
 * （名前そのもの／建物名＋号室／町名とお客様の両方）がちょうど1件のときだけそれ。ほかは決めない（pick は null）。
 * 2件以上の案件が同じ鍵を持つ（同じ建物の 501 と 502・同じお客様）と、その鍵では必ず複数に当たるので、それだけでは決まらない。
 */
export function pickDealInText(text: string, deals: DealRef[]): { pick: DealRef | null; hits: DealRef[] } {
  const hits = hitsInText(text, deals);
  const all = hits.map((h) => h.deal);
  if (hits.length === 1) return { pick: hits[0].deal, hits: all };
  const strong = hits.filter((h) => h.strong);
  return { pick: strong.length === 1 ? strong[0].deal : null, hits: all };
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
      const { pick, hits } = pickDealInText(ev.text ?? "", deals);
      if (pick) dealId = pick.id;
      else {
        const q = await quoted();
        // 本文が複数の案件に当たって決められないときは、引用先がそのうちの1件のときだけ引用で決める
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
