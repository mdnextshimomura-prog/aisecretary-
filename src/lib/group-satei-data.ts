/**
 * 普通のグループの査定依頼（2026-11-24 設計 docs/superpowers/specs/2026-11-24-group-satei-intake-design.md）：
 * スイッチ・定数・KV の鍵・受付票の型・ボタンの data。通信はしない。
 * - GROUP_SATEI=1 かつ GROUP_SATEI_GROUP_IDS に入ったグループだけ（既定 off）。
 * - 受付票に本文・ファイル名・お客様の名前は入れない（所在・物件名だけ）。
 */
import { createHash } from "node:crypto";
import { PAGE_ID_RE } from "./task-buttons";
import { parseAllowedUserIds } from "./webhook-source";

export type GsEnv = Record<string, string | undefined>;

export const groupSateiActive = (env: GsEnv = process.env) => env.GROUP_SATEI === "1";
export const groupSateiGroupIds = (env: GsEnv = process.env) => parseAllowedUserIds(env.GROUP_SATEI_GROUP_IDS);
export function groupSateiOn(groupId: string | undefined, env: GsEnv = process.env): boolean {
  return Boolean(groupId) && groupSateiActive(env) && groupSateiGroupIds(env).includes(groupId as string);
}

/** 段2（設計 2026-11-25 の 12）。GROUP_SATEI も on のときだけ。off なら段1のまま */
export const groupSateiStage2On = (env: GsEnv = process.env) => groupSateiActive(env) && env.GROUP_SATEI_STAGE2 === "1";

/** 段2：「何の依頼？」の8つ（設計 3。並びはこの順。AI の見立ては先頭に出す） */
export type GsReqKind = "satei" | "doc" | "check" | "sched" | "survey" | "money" | "mail" | "other";
export const GS_REQ_KINDS: ReadonlyArray<{ code: GsReqKind; label: string }> = [
  { code: "satei", label: "査定" },
  { code: "doc", label: "資料を送る" },
  { code: "check", label: "書類の作成・チェック" },
  { code: "sched", label: "日程・内見" },
  { code: "survey", label: "物件調査・謄本" },
  { code: "money", label: "振込・お金" },
  { code: "mail", label: "メール・電話" },
  { code: "other", label: "その他" },
];
export const isGsReqKind = (x: unknown): x is GsReqKind => typeof x === "string" && GS_REQ_KINDS.some((k) => k.code === x);
export const gsReqLabel = (code: GsReqKind): string => GS_REQ_KINDS.find((k) => k.code === code)?.label ?? "その他";
export const encodeGsKind = (tid: string, ver: number, code: GsReqKind) => `v1|gk|${tid}|${ver}|${code}`;

export const GS_TICKET_TTL = 7 * 24 * 60 * 60;
export const GS_MEDIA_TTL = 3 * 60 * 60;
export const GS_MEDIA_MAX = 30;
export const GS_MATERIALS_MAX = 8;
export const GS_READS_PER_DAY = 20;
export const GS_MIN = 0.5;
export const GS_SURE = 0.7;
export const GS_CANDIDATES_MAX = 5;
export const GS_PAGE = 10;
/** 本人の資料を束ねる幅（入口の発言の30分前〜1分後。後から来る分は段2） */
export const GS_BEFORE_MS = 30 * 60 * 1000;
export const GS_AFTER_MS = 60 * 1000;
/** あとから届いた資料（11/25）：本人の画像は依頼から30分まで、ほかの人は開いている票が1件だけのとき2時間まで足す */
export const GS_LATE_OWN_MS = 30 * 60 * 1000;
export const GS_LATE_ANY_MS = 2 * 60 * 60 * 1000;
/** 最後の資料から静かになって読み直すまで（画像を続けて貼る間は待つ） */
export const GS_QUIET_MS = 60 * 1000;
/** 文字だけで読めず資料も無いとき、知らせを待つ長さ（その間に画像が来なければ「まだ届いていません」で知らせる） */
export const GS_DEFER_MS = 90 * 1000;
/** 知らせたあとの読み直し（版を上げて出し直す）の上限 */
export const GS_REREAD_MAX = 2;
/** 読み直しの係（webhook の中で動く。関数の上限は 300 秒） */
export const GS_WORKER_DEADLINE_MS = 250 * 1000;
/** 1周（読み取り40秒＋候補・種別16秒＋名前3秒＋送信）に要る時間。これより残りが少なければ始めない */
export const GS_ROUND_MS = 75 * 1000;
/** 待つときに KV を見直す間隔 */
export const GS_POLL_MS = 5 * 1000;
/** 係の印の期限（関数の上限 300 秒より短く、係の打ち切り 250 秒より長く） */
export const GS_LOCK_TTL_S = 280;
/** 画像の webhook が、ほかの係の印が空くのを待つ長さ（応答を長く止めない） */
export const GS_LOCK_WAIT_MS = 20 * 1000;
/** 知らせが出ていない受付票の控え（見回りの掃除が拾う）と、掃除するまでの猶予 */
export const GS_PENDING_SET = "gsatei:pending";
export const GS_SWEEP_AFTER_MS = 3 * 60 * 1000;
/** あとから届いた資料の控え（受付票ごとの集合。要素は "image:<id>" か "pdf:<id>"。足すのは原子的な sadd だけ） */
export const gsLateKey = (tid: string) => `gsatei:late:${tid}`;
/** 読み直す時刻（受付票とは別に置く＝資料が届くたびに受付票を書き戻さない） */
export const gsRereadAtKey = (tid: string) => `gsatei:rat:${tid}`;
/** 読み直しの見回りの重なりを防ぐ印 */
export const gsRereadLockKey = (tid: string) => `gsatei:rlock:${tid}`;
// X-Line-Retry-Key の uuidv5 の名前空間（固定。変えると二重防止が効かなくなる）
export const GS_RETRY_NAMESPACE = "3f6a1c9e-8b2d-4e7f-a5c1-9d0e2b4f6a8c";

export const gsMediaKey = (groupId: string) => `gsatei:media:${groupId}`;
export const gsTicketKey = (tid: string) => `gsatei:t:${tid}`;
export const GS_SEQ_KEY = "gsatei:seq";
export const gsOpenKey = (groupId: string) => `gsatei:open:${groupId}`;
export const gsMsgKey = (messageId: string) => `gsatei:msg:${messageId}`;
export const gsDecKey = (tid: string) => `gsatei:dec:${tid}`;
export const gsReadsKey = (ymd: string) => `gsatei:reads:${ymd}`;

export const ticketIdOf = (messageId: string) => createHash("sha256").update(messageId).digest("hex").slice(0, 16);
export const receiptOf = (no: number) => `G${no}`;
export const gsEventId = (tid: string) => `gs${tid}`;

export type GsKind = "マンション" | "戸建" | "土地" | "不明";
export const GS_KINDS: readonly GsKind[] = ["マンション", "戸建", "土地", "不明"];
export type GsBasis = "本文" | "登記" | "地図" | "チラシ" | "その他";
export const GS_BASES: readonly GsBasis[] = ["本文", "登記", "地図", "チラシ", "その他"];

/** 段2b：査定書の表紙・概要に要る項目（同じ1回の読み取りで読む。分からなければ null） */
export interface GsFacts {
  /** 号室（物件名とは別に。例 "1203"） */
  roomNo: string | null;
  /** 専有面積（㎡） */
  exclusiveArea: number | null;
  /** 土地面積（㎡） */
  landArea: number | null;
  /** 建物面積（延床・㎡） */
  buildingArea: number | null;
  /** 築年月 "YYYY-MM" */
  builtYm: string | null;
  layout: string | null;
  floor: number | null;
  totalUnits: number | null;
  structure: string | null;
}

export interface GsRead {
  address: string | null;
  propertyName: string | null;
  kind: GsKind;
  basis: GsBasis;
  confidence: number;
  /** 段2b（GROUP_SATEI_STAGE2 on のときだけ読む）。段1の票には無い */
  facts?: GsFacts;
}

/** グループ単位の控えの1行（ファイル名は持たない） */
export interface GsMedia {
  messageId: string;
  kind: "image" | "pdf" | "other";
  senderId: string;
  at: number;
  quoted?: string;
}

export type GsState = "asking" | "started" | "manual" | "dismissed";

export interface GsTicket {
  no: number;
  ver: number;
  groupId: string;
  requesterId: string;
  at: number;
  triggerMsgIds: string[];
  mediaIds: string[];
  read: GsRead | null;
  /** 読めなかった理由の符号（cap・read-failed・no-material 等）。読めたら無い */
  readFailed?: string;
  state: GsState;
  /** ［案件がまだ無い］の仮の決定（7日以内に1回だけ選び直せる） */
  provisional?: boolean;
  dealId?: string;
  jobNo?: number;
  /** portal の受付の結果が分からない */
  unknown?: boolean;
  /** 下村さんへの知らせの push が通った（false のまま＝届いていないかもしれない。再送は段2） */
  pushed?: boolean;
  /** 束ねた資料の数（知らせの「資料：」の行。読み直しのとき控えが消えていても数えられるように） */
  materials?: { images: number; pdfs: number };
  /** 最初の知らせを、資料を待つために遅らせている */
  deferred?: boolean;
  /** この時刻を過ぎたら見回りで読み直す（ミリ秒） */
  rereadAt?: number;
  /** 知らせたあとに読み直した回数 */
  rereads?: number;
  /** 段2：押された「何の依頼？」の符号（GROUP_SATEI_STAGE2 on のときだけ書く） */
  requestKind?: GsReqKind;
}

const STATES: readonly GsState[] = ["asking", "started", "manual", "dismissed"];

export function asTicket(raw: unknown): GsTicket | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const strs = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string");
  if (typeof r.no !== "number" || typeof r.ver !== "number" || typeof r.groupId !== "string") return null;
  if (typeof r.requesterId !== "string" || typeof r.at !== "number") return null;
  if (!strs(r.triggerMsgIds) || !strs(r.mediaIds) || !STATES.includes(r.state as GsState)) return null;
  if (r.pushed !== undefined && typeof r.pushed !== "boolean") return null;
  if (r.requestKind !== undefined && !isGsReqKind(r.requestKind)) return null;
  return r as unknown as GsTicket;
}

export type GsAction =
  | { op: "gs"; tid: string; ver: number; dealId: string }
  | { op: "gl"; tid: string; ver: number; offset: number }
  | { op: "gm"; tid: string; ver: number }
  | { op: "gn"; tid: string; ver: number }
  | { op: "gk"; tid: string; ver: number; code: GsReqKind };

const TID_RE = /^[0-9a-f]{16}$/;
const VER_RE = /^[1-9][0-9]?$/;
const OFFSET_RE = /^(0|[1-9][0-9]{0,2})$/;
const OFFSET_MAX = 500;

export const encodeGsPick = (tid: string, ver: number, dealId: string) => `v1|gs|${tid}|${ver}|${dealId}`;
export const encodeGsList = (tid: string, ver: number, offset: number) => `v1|gl|${tid}|${ver}|${offset}`;
export const encodeGsManual = (tid: string, ver: number) => `v1|gm|${tid}|${ver}`;
export const encodeGsNone = (tid: string, ver: number) => `v1|gn|${tid}|${ver}`;

/** このカードのボタンの data を読む。形が違えば null（ほかのボタンは読まない） */
export function parseGsData(data: string): GsAction | null {
  if (!data || data.length > 300) return null;
  const p = data.split("|");
  if (p[0] !== "v1" || !TID_RE.test(p[2] ?? "") || !VER_RE.test(p[3] ?? "")) return null;
  const tid = p[2];
  const ver = Number(p[3]);
  if (p[1] === "gs") return p.length === 5 && PAGE_ID_RE.test(p[4]) ? { op: "gs", tid, ver, dealId: p[4] } : null;
  if (p[1] === "gl") {
    if (p.length !== 5 || !OFFSET_RE.test(p[4]) || Number(p[4]) > OFFSET_MAX) return null;
    return { op: "gl", tid, ver, offset: Number(p[4]) };
  }
  if (p[1] === "gm" && p.length === 4) return { op: "gm", tid, ver };
  if (p[1] === "gn" && p.length === 4) return { op: "gn", tid, ver };
  if (p[1] === "gk") {
    const code = p[4];
    return p.length === 5 && isGsReqKind(code) ? { op: "gk", tid, ver, code } : null;
  }
  return null;
}
