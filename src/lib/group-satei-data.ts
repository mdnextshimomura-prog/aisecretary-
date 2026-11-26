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

/** 段2d：山口さん（事例を取る係）の LINE userId（env GROUP_SATEI_CASE_STAFF_ID。1人）。形が違えば null（＝2d は動かない） */
const LINE_USER_RE = /^U[0-9a-f]{32}$/;
export function gsCaseStaffId(env: GsEnv = process.env): string | null {
  const v = (env.GROUP_SATEI_CASE_STAFF_ID ?? "").trim();
  return LINE_USER_RE.test(v) ? v : null;
}
/** 段2d が動くか（計画 2026-11-26-group-satei-2d の D6）。off なら 2a のまま */
export const groupSateiPrepOn = (env: GsEnv = process.env) => groupSateiStage2On(env) && gsCaseStaffId(env) !== null;

/** 段2d の決まり（設計 6・10・14、計画 D8〜D16） */
export const GS_FIX_MAX = 2;
export const GS_PROPOSE_TRIES = 2;
export const GS_GROUP_PUSH_MAX = 2;
export const GS_LATE_MS = 30 * 60 * 1000;
/** リマインドの push がはっきり失敗したとき、毎分の見回りで試す回数の上限 */
export const GS_REMIND_TRIES = 3;
/** 毎分の見回り（段2d）の時間の予算：開始から50秒のうち、残りが12秒を切ったら新しい票に手を付けない */
export const GS_SWEEP_BUDGET_MS = 50_000;
export const GS_SWEEP_MARGIN_MS = 12_000;
export const GS_FIX_TTL = 30 * 60;
export const GS_CASES_TTL = 14 * 24 * 60 * 60;
/** 見回りが見る受付票（gathering・proposing・waiting-cases） */
export const GS_STAGE2_SET = "gsatei:s2";
/** そのグループで事例を待っている受付票 */
export const gsWaitKey = (groupId: string) => `gsatei:wait:${groupId}`;
/** 受付票ごとの、依頼のあとに貼られた PDF の messageId（リマインドを出すかの判定だけに使う。取り出しは 2e） */
export const gsCasesKey = (tid: string) => `gsatei:cases:${tid}`;
/** ［いいよ］は受付票ごとに最初の1回だけ */
export const gsOkKey = (tid: string) => `gsatei:ok:${tid}`;
/** ［いいよ］の印だけ残って送れていない票の、送り直しの1回（同じ retry key で。LINE が重ねない） */
export const gsOkRetryKey = (tid: string) => `gsatei:okr:${tid}`;
/** ［いいよ］の印が残ったまま送れていないとみなすまで */
export const GS_OK_STALE_MS = 2 * 60 * 1000;
/** リマインドは受付票ごとに1回だけ */
export const gsRemindKey = (tid: string) => `gsatei:rem:${tid}`;
/** ［直す］のあとの次の1通（30分） */
export const gsFixKey = (userId: string) => `gsatei:fix:${userId}`;

/** 段2e（計画 2026-11-26-group-satei-2e）：受付票に結びついた事例の PDF（JSON の配列 [{m: messageId, at}]。結びついた順。14日・10件まで） */
export const gsCaseItemsKey = (tid: string) => `gsatei:caseitems:${tid}`;
/** どの受付のものか決められない PDF の知らせは、グループ・JST の日・候補の受付票の組ごとに1回だけ（1日。messageId は鍵に入れない） */
export const gsAmbigKey = (groupId: string, day: string, tids: string[]) => `gsatei:ambig:${groupId}:${day}:${[...tids].sort().join(",")}`;
export const GS_AMBIG_TTL = 24 * 60 * 60;
/** 1受付票の事例 PDF の上限 */
export const GS_CASE_ITEMS_MAX = 10;
/** 控えの置き場の生の行の上限（同じ messageId の重なりの分の余り。読むときに重ねを除いて GS_CASE_ITEMS_MAX 件） */
export const GS_CASE_ITEMS_RAW_MAX = 20;
/** 1件の PDF の上限（Vercel の応答の上限 4.5MB のため） */
export const GS_CASE_PDF_MAX = 4 * 1024 * 1024;
/** 最後の PDF からこれだけ静かになったら portal へ渡す */
export const GS_CASES_QUIET_MS = 2 * 60 * 1000;
/** 事例の結果の知らせの push（retry key cases:<tid>）を試す回数 */
export const GS_CASES_PUSH_TRIES = 2;
/** マンションの下書きの受付（結果不明のとき）を試す回数。push の回数とは別に数える */
export const GS_CASES_DRAFT_TRIES = 2;
/** 渡してから（渡せていなければ最後の PDF から）これだけ結果が無ければ、下村さんへ1回だけ知らせる */
export const GS_CASES_LATE_MS = 30 * 60 * 1000;
/** 結果の知らせ（finishCases）に入るのは、見回りの予算の残りがこれ以上あるときだけ */
export const GS_CASES_FINISH_MIN_MS = 30_000;
export interface GsCaseItem {
  m: string;
  at: number;
}
/** 控えの行を読む（文字列の JSON でも、読み出しで戻った形でもよい）。重ねを除き、結びついた順に max 件（既定 GS_CASE_ITEMS_MAX）まで */
export function asCaseItems(raw: unknown, max: number = GS_CASE_ITEMS_MAX): GsCaseItem[] {
  if (!Array.isArray(raw)) return [];
  const out: GsCaseItem[] = [];
  for (const r of raw) {
    let v: unknown = r;
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {
        continue;
      }
    }
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    if (typeof o.m !== "string" || !o.m || typeof o.at !== "number") continue;
    if (out.some((x) => x.m === o.m)) continue;
    out.push({ m: o.m, at: o.at });
    if (out.length >= max) break;
  }
  return out;
}

export type GsPrepKind = "マンション" | "戸建" | "土地";
export const GS_PREP_KINDS: readonly GsPrepKind[] = ["マンション", "戸建", "土地"];
export interface GsPrep {
  kind: GsPrepKind;
  /** 今の案の版（1＝Mac の最初の案。［直す］で +1。0＝まだ届いていない） */
  rev: number;
  lines: string[];
  /** ［直す］で作り直した回数（GS_FIX_MAX まで） */
  fixes: number;
  /** 下村さんへ送れた版 */
  sentRev: number;
  /** 最初の案の push を試した回数（GS_PROPOSE_TRIES まで） */
  tries: number;
  /** グループへの push の数（依頼・リマインド。GS_GROUP_PUSH_MAX まで） */
  groupPushes: number;
  /** 事例の期日（ミリ秒。［いいよ］で決める） */
  deadline?: number;
  /** グループに依頼した時刻（これより後の PDF だけを事例の控えに数える） */
  requestedAt?: number;
  reminded?: boolean;
  /** リマインドの push がはっきり失敗した回数（GS_REMIND_TRIES であきらめる） */
  remindFails?: number;
  /** 30分の遅れの知らせを出した */
  lateNotified?: boolean;
  /** 段2e：グループへの依頼カードの messageId（PDF の引用で受付票を決める。push の応答から取れたときだけ） */
  cardMsgId?: string;
  /** 段2e：portal に「事例あり」で渡した件数と時刻 */
  casesHanded?: number;
  casesHandedAt?: number;
  /** 段2e：結果を下村さんへ知らせ終えた */
  casesDone?: boolean;
  /** 段2e：結果の知らせを試した回数（GS_CASES_PUSH_TRIES まで） */
  casesPushTries?: number;
  /** 段2e：下書きの受付が結果不明だった回数（GS_CASES_DRAFT_TRIES まで） */
  casesDraftTries?: number;
  /** 段2e：30分たっても結果が無いことを知らせた */
  casesLateNotified?: boolean;
  /** 段2f（F4）：結果の知らせの文を作り直すための数（文は入れない）。送る前に書く */
  casesNote?: GsCasesNote;
  /** 段2f（F3）：催促のあとの下村さんへの1行がどれだったか（送り直しで文を作り直す） */
  remindNote?: "sent" | "unknown" | "failed";
}

/** 段2f（F4）：段2e の結果の知らせの中身（数と下書きの結果の種類だけ） */
export interface GsCasesNote {
  contract: number;
  listing: number;
  failed: number;
  unsaved: number;
  draft: "started" | "manual" | "unknown" | "house" | "land" | "failed";
  jobNo?: number;
}
const GS_CASES_DRAFTS: ReadonlyArray<GsCasesNote["draft"]> = ["started", "manual", "unknown", "house", "land", "failed"];

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
/** 段2f（F2）：掃除が最初の知らせを送り直す回数の上限（毎分1回＝約10分以上）。超えたら掃除の対象から外す */
export const GS_TICKET_PUSH_TRIES = 10;
/**
 * 段2f（M2）：入口 A・B が受付票を開こうとしている印（送り主ごと。AI の判定のあいだ置き、開いた・開かなかったで消す）。
 * photo-ask はこの印があるあいだ待つ（GS_PHOTO_WAIT_MS まで）
 */
export const gsClaimKey = (groupId: string, senderId: string) => `gsatei:claim:${groupId}:${senderId}`;
export const GS_CLAIM_TTL = 5 * 60;
export const GS_PHOTO_WAIT_MS = 45_000;
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

export type GsState = "asking" | "started" | "manual" | "dismissed" | "gathering" | "proposing" | "waiting-cases";

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
  /** 段2f（F2）：掃除が最初の知らせを送ろうとした回数（GS_TICKET_PUSH_TRIES まで） */
  pushTries?: number;
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
  /** 段2d：portal の準備を頼んだ時刻（ミリ秒。遅れの知らせに使う） */
  prepAt?: number;
  /** 段2d：事例の取り方の案と、グループへの依頼の控え */
  prep?: GsPrep;
}

const STATES: readonly GsState[] = ["asking", "started", "manual", "dismissed", "gathering", "proposing", "waiting-cases"];

const isCount = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 99;
function isGsPrep(v: unknown): v is GsPrep {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    GS_PREP_KINDS.includes(p.kind as GsPrepKind) &&
    isCount(p.rev) && isCount(p.fixes) && isCount(p.sentRev) && isCount(p.tries) && isCount(p.groupPushes) &&
    Array.isArray(p.lines) && p.lines.every((s) => typeof s === "string") &&
    (p.deadline === undefined || typeof p.deadline === "number") &&
    (p.requestedAt === undefined || typeof p.requestedAt === "number") &&
    (p.remindFails === undefined || isCount(p.remindFails)) &&
    (p.cardMsgId === undefined || (typeof p.cardMsgId === "string" && p.cardMsgId.length > 0)) &&
    (p.casesHanded === undefined || isCount(p.casesHanded)) &&
    (p.casesHandedAt === undefined || typeof p.casesHandedAt === "number") &&
    (p.casesDone === undefined || typeof p.casesDone === "boolean") &&
    (p.casesPushTries === undefined || isCount(p.casesPushTries)) &&
    (p.casesDraftTries === undefined || isCount(p.casesDraftTries)) &&
    (p.casesLateNotified === undefined || typeof p.casesLateNotified === "boolean") &&
    (p.casesNote === undefined || isCasesNote(p.casesNote)) &&
    (p.remindNote === undefined || p.remindNote === "sent" || p.remindNote === "unknown" || p.remindNote === "failed")
  );
}
function isCasesNote(v: unknown): v is GsCasesNote {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  return (
    isCount(n.contract) && isCount(n.listing) && isCount(n.failed) && isCount(n.unsaved) &&
    GS_CASES_DRAFTS.includes(n.draft as GsCasesNote["draft"]) &&
    (n.jobNo === undefined || (typeof n.jobNo === "number" && Number.isInteger(n.jobNo) && n.jobNo > 0))
  );
}

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
  if (r.pushTries !== undefined && !isCount(r.pushTries)) return null;
  if (r.requestKind !== undefined && !isGsReqKind(r.requestKind)) return null;
  if (r.prep !== undefined && !isGsPrep(r.prep)) return null;
  return r as unknown as GsTicket;
}

export type GsAction =
  | { op: "gs"; tid: string; ver: number; dealId: string }
  | { op: "gl"; tid: string; ver: number; offset: number }
  | { op: "gm"; tid: string; ver: number }
  | { op: "gn"; tid: string; ver: number }
  | { op: "gk"; tid: string; ver: number; code: GsReqKind }
  | { op: "gy"; tid: string; ver: number; rev: number }
  | { op: "gf"; tid: string; ver: number; rev: number };

const TID_RE = /^[0-9a-f]{16}$/;
const VER_RE = /^[1-9][0-9]?$/;
const OFFSET_RE = /^(0|[1-9][0-9]{0,2})$/;
const OFFSET_MAX = 500;

export const encodeGsPick = (tid: string, ver: number, dealId: string) => `v1|gs|${tid}|${ver}|${dealId}`;
export const encodeGsList = (tid: string, ver: number, offset: number) => `v1|gl|${tid}|${ver}|${offset}`;
export const encodeGsManual = (tid: string, ver: number) => `v1|gm|${tid}|${ver}`;
export const encodeGsNone = (tid: string, ver: number) => `v1|gn|${tid}|${ver}`;
/** 段2d：事例の取り方の案の［いいよ］［直す］（rev＝案の版） */
export const encodeGsYes = (tid: string, ver: number, rev: number) => `v1|gy|${tid}|${ver}|${rev}`;
export const encodeGsFix = (tid: string, ver: number, rev: number) => `v1|gf|${tid}|${ver}|${rev}`;
const REV_RE = /^[1-9]$/;

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
  if (p[1] === "gy" || p[1] === "gf") {
    return p.length === 5 && REV_RE.test(p[4]) ? { op: p[1], tid, ver, rev: Number(p[4]) } : null;
  }
  return null;
}
