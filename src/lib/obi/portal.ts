/**
 * portal の帯替えの受付 `POST {PORTAL_BASE_URL}/api/jobs/intake` を呼ぶ（設計 12・13・14の2・15）。
 * 形は docs/superpowers/plans/2026-10-09-group-obi-contract.md の「P1 が作り、P2 が使う」。
 * `assigneeName` はこの入口では受け付けないので送らない（依頼文の「担当:」は読んでも捨てる）。
 *
 * 結果は4つに分ける：
 *   accepted    … 受付番号と保存した PDF の一覧が返った（201 新規・200 同じ依頼の照合一致）
 *   rejected    … portal がはっきり断った（4xx・503 INTAKE_STOPPED）
 *   unreachable … 送る前に失敗したのが確か（名前が引けない・接続を拒まれた）
 *   unknown     … 届いたか分からない（時間切れ・通信の切断・5xx・成功なのに中身が読めない）
 */
import type { FetchedPdf } from "./fetch-pdfs";

export interface IntakeRequest {
  lineMessageId: string;
  property: string;
  requestText: string;
  requestedBy: string;
  replyGroupId: string;
  files: Array<{ fileName: string; bytes: Uint8Array }>;
}

export interface IntakeInput {
  name: string;
  sha256: string;
  size: number;
}

export type IntakeOutcome =
  | { kind: "accepted"; no: number; created: boolean; inputs: IntakeInput[] }
  | { kind: "rejected"; code: string; httpStatus: number; busyJobNo?: number }
  | { kind: "unreachable" }
  | { kind: "unknown"; reason: string };

const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

function parseInputs(v: unknown): IntakeInput[] | null {
  if (!Array.isArray(v)) return null;
  const out: IntakeInput[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") return null;
    const r = x as Record<string, unknown>;
    if (typeof r.name !== "string" || typeof r.sha256 !== "string" || typeof r.size !== "number") {
      return null;
    }
    out.push({ name: r.name, sha256: r.sha256, size: r.size });
  }
  return out;
}

function classifyFetchError(err: unknown): { kind: "unreachable" } | { kind: "unknown"; reason: string } {
  const e = err as { name?: string; cause?: { code?: string } } | undefined;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return { kind: "unknown", reason: "timeout" };
  if (e?.cause?.code && UNREACHABLE_CODES.has(e.cause.code)) return { kind: "unreachable" };
  return { kind: "unknown", reason: "network" };
}

export async function postIntake(
  req: IntakeRequest,
  opts: { fetchImpl: typeof fetch; baseUrl: string; token: string; timeoutMs: number }
): Promise<IntakeOutcome> {
  const form = new FormData();
  form.append("workflow", "obi");
  form.append("lineMessageId", req.lineMessageId);
  form.append("property", req.property);
  if (req.requestText) form.append("requestText", req.requestText);
  if (req.requestedBy) form.append("requestedBy", req.requestedBy);
  form.append("replyKind", "line-group");
  form.append("replyGroupId", req.replyGroupId);
  for (const f of req.files) {
    form.append("files", new Blob([toArrayBuffer(f.bytes)], { type: "application/pdf" }), f.fileName);
  }

  let res: Response;
  try {
    res = await opts.fetchImpl(`${opts.baseUrl}/api/jobs/intake`, {
      method: "POST",
      headers: { "x-job-token": opts.token },
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    return classifyFetchError(err);
  }

  let body: Record<string, unknown> = {};
  let bodyOk = true;
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    else bodyOk = false;
  } catch {
    bodyOk = false;
  }

  if (res.status === 200 || res.status === 201) {
    const inputs = bodyOk ? parseInputs(body.inputs) : null;
    const no = body.no;
    if (typeof no === "number" && Number.isInteger(no) && no > 0 && inputs) {
      return { kind: "accepted", no, created: res.status === 201, inputs };
    }
    // 成功の番号なのに中身が読めない＝受付できたかもしれない
    return { kind: "unknown", reason: "invalid-success-body" };
  }
  const code = typeof body.code === "string" ? body.code : "";
  if (res.status === 503 && code === "INTAKE_STOPPED") {
    return { kind: "rejected", code, httpStatus: 503 };
  }
  if (res.status >= 500) return { kind: "unknown", reason: `http-${res.status}` };
  if (res.status >= 400) {
    const busy = body.busyJobNo;
    return {
      kind: "rejected",
      code: code || `HTTP_${res.status}`,
      httpStatus: res.status,
      ...(typeof busy === "number" && Number.isInteger(busy) && busy > 0 ? { busyJobNo: busy } : {}),
    };
  }
  return { kind: "unknown", reason: `http-${res.status}` };
}

/**
 * 返ってきた一覧が送った PDF と一致するか（設計 13）。
 * 約束：portal の inputs は「初回に保存した順」なので、順番では比べず、
 * 件数と sha256 の集合（＋同じ sha256 の大きさ）で比べる。送る側で同じ sha256 は1つにしてある。
 */
export function inputsMatch(sent: FetchedPdf[], got: IntakeInput[]): boolean {
  if (sent.length !== got.length) return false;
  const sizeBySha = new Map<string, number>();
  for (const f of sent) sizeBySha.set(f.sha256, f.size);
  if (sizeBySha.size !== sent.length) return false;
  const seen = new Set<string>();
  for (const g of got) {
    if (seen.has(g.sha256)) return false;
    seen.add(g.sha256);
    if (sizeBySha.get(g.sha256) !== g.size) return false;
  }
  return true;
}


// ── 番号で直す（設計 2026-10-10・約束 2026-10-11-obi-fix-contract.md） ──
//
// 2つの入口を呼ぶ。どちらも本文は JSON、鍵はヘッダ `x-job-token`。結果は受付（postIntake）と同じ4つに分ける。
//   POST /api/jobs/fix/resolve … 引用先・受付番号から、直せる依頼かを引く（何も書き換えない）
//   POST /api/jobs/{no}/fix    … 訂正を受け付ける（冪等のかぎは訂正の発言の message.id）
// **発言者を表す項目は送らない**（userId・表示名。誰が訂正できるかは呼ぶ前に確かめてある）。

export type FixEstimate = "ok" | "closed" | "expired" | "not-ready" | "unavailable";
const FIX_ESTIMATES = new Set<string>(["ok", "closed", "expired", "not-ready", "unavailable"]);

export interface FixResolved {
  no: number;
  /**
   * 引用なら「その知らせが指す完成品」、番号なら「今の完成品」。fix の expectSha256 にそのまま渡す。
   * 空文字＝完成品がまだ無い（fix は呼べない。fixable・closable の値で返事を決める）
   */
  artifactSha256: string;
  /** artifactSha256 が今の完成品と同じか */
  current: boolean;
  /** 今の1冊のページ数（分からなければ 0） */
  pageCount: number;
  /** 1〜5 を送ったときの見込み */
  fixable: FixEstimate;
  /** 0 を送ったときの見込み */
  closable: FixEstimate;
  /**
   * 引用で引いたとき、その知らせの種類。"completion"＝完成の知らせ。番号で引いたとき・項目の無い portal は ""。
   * "completion"・"" 以外（差し戻しの選択肢の設計 2026-10-11 の "reject"・"review" など。いまの portal は返さない）への引用は、
   * 「番号で直す」の返事として扱わない（約束の「差し戻しの選択肢のための土台」P1・P4）
   */
  kind: string;
  /**
   * 今の依頼が待っている返事の種類。"fix"＝番号で直す／"choose"＝差し戻しの対応の選択待ち／"review"＝確認の知らせへの OK 待ち
   * （差し戻しの選択肢の設計 2026-10-11 の E12）。項目の無い portal は "fix" とみなす
   */
  phase: string;
  /** 始めた作り直しの回数（0〜3）。項目の無い portal は 0。古さの比べには使わない（ログ用） */
  rejectRound: number;
  /** 今の選択肢の世代（0 以上）。#J つきの選択・OK・9 の expectGen にそのまま渡す。項目の無い portal は 0 */
  choiceGen: number;
  /** 引用先の知らせの世代。引用で引いたときだけ数が入る（番号で引いたとき・項目の無い portal は null）。引用の返信の expectGen に渡す */
  messageGen: number | null;
  /** 今出せる番号（1〜4 の昇順。phase が "choose" のときだけ中身がある）。項目の無い portal は []。文には使わない（断りの choices を使う） */
  choices: number[];
}

export type FixResolveRequest =
  | { groupId: string; quotedMessageId: string }
  | { groupId: string; no: number };

export type FixResolveOutcome =
  | { kind: "accepted"; resolved: FixResolved }
  | { kind: "rejected"; code: string; httpStatus: number }
  | { kind: "unreachable" }
  | { kind: "unknown"; reason: string };

interface PortalOpts {
  fetchImpl: typeof fetch;
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

type JsonCall =
  | { kind: "http"; status: number; body: Record<string, unknown>; bodyOk: boolean }
  | { kind: "unreachable" }
  | { kind: "unknown"; reason: string };

async function postJson(path: string, payload: Record<string, unknown>, opts: PortalOpts): Promise<JsonCall> {
  let res: Response;
  try {
    res = await opts.fetchImpl(`${opts.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-job-token": opts.token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    return classifyFetchError(err);
  }
  let body: Record<string, unknown> = {};
  let bodyOk = true;
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    else bodyOk = false;
  } catch {
    bodyOk = false;
  }
  return { kind: "http", status: res.status, body, bodyOk };
}

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
/** 選択の番号の並び（1〜4 の整数だけ）。形が違えば null */
function parseChoices(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const x of v) {
    if (typeof x !== "number" || !Number.isInteger(x) || x < 1 || x > 4) return null;
    out.push(x);
  }
  return out;
}

/**
 * 断りの共通の分け方。503 は、portal がはっきり止めていると答えた code（stopCodes）のときだけ断り。
 * それ以外の 5xx は「届いたか分からない」。
 */
function rejectionOf(
  call: Extract<JsonCall, { kind: "http" }>,
  stopCodes: string[]
): { kind: "rejected"; code: string; httpStatus: number } | { kind: "unknown"; reason: string } {
  const code = typeof call.body.code === "string" ? call.body.code : "";
  if (call.status === 503 && stopCodes.includes(code)) return { kind: "rejected", code, httpStatus: 503 };
  if (call.status >= 400 && call.status < 500) {
    return { kind: "rejected", code: code || `HTTP_${call.status}`, httpStatus: call.status };
  }
  return { kind: "unknown", reason: `http-${call.status}` };
}

export async function postFixResolve(req: FixResolveRequest, opts: PortalOpts): Promise<FixResolveOutcome> {
  const payload: Record<string, unknown> = { source: "line-group", groupId: req.groupId };
  if ("quotedMessageId" in req) payload.quotedMessageId = req.quotedMessageId;
  else payload.no = req.no;
  const call = await postJson("/api/jobs/fix/resolve", payload, opts);
  if (call.kind !== "http") return call;
  if (call.status === 200) {
    const b = call.body;
    if (
      call.bodyOk &&
      isPositiveInt(b.no) &&
      typeof b.artifactSha256 === "string" &&
      // 空文字＝完成品のまだ無い依頼（受付・入力待ち・下準備中・完成品の無い差し戻し／取消／失敗）。正しい応答として読む。
      // そのときは fixable・closable が ok 以外のはず。fix を呼ばないのは呼ぶ側（fix.ts）
      (b.artifactSha256 === "" || /^[0-9a-f]{64}$/.test(b.artifactSha256)) &&
      typeof b.current === "boolean" &&
      typeof b.pageCount === "number" &&
      Number.isInteger(b.pageCount) &&
      b.pageCount >= 0 &&
      typeof b.fixable === "string" &&
      FIX_ESTIMATES.has(b.fixable) &&
      typeof b.closable === "string" &&
      FIX_ESTIMATES.has(b.closable) &&
      // kind・phase は、あれば文字列（無い portal は今までどおり受ける。文字列でなければ形の違う応答）
      (b.kind === undefined || typeof b.kind === "string") &&
      (b.phase === undefined || typeof b.phase === "string") &&
      // 差し戻しの選択肢の4項目も、あれば決まった形（無い portal は 0・0・null・[] とみなす。形が違えば、形の違う応答）
      (b.rejectRound === undefined || isCount(b.rejectRound)) &&
      (b.choiceGen === undefined || isCount(b.choiceGen)) &&
      (b.messageGen === undefined || b.messageGen === null || isCount(b.messageGen)) &&
      (b.choices === undefined || parseChoices(b.choices) !== null)
    ) {
      return {
        kind: "accepted",
        resolved: {
          no: b.no,
          artifactSha256: b.artifactSha256,
          current: b.current,
          pageCount: b.pageCount,
          fixable: b.fixable as FixEstimate,
          closable: b.closable as FixEstimate,
          kind: typeof b.kind === "string" ? b.kind : "",
          phase: typeof b.phase === "string" ? b.phase : "fix",
          rejectRound: isCount(b.rejectRound) ? b.rejectRound : 0,
          choiceGen: isCount(b.choiceGen) ? b.choiceGen : 0,
          messageGen: isCount(b.messageGen) ? b.messageGen : null,
          choices: parseChoices(b.choices) ?? [],
        },
      };
    }
    return { kind: "unknown", reason: "invalid-success-body" };
  }
  return rejectionOf(call, ["FIX_DISABLED"]);
}

// ── 番号で直す：訂正を受け付ける POST /api/jobs/{no}/fix ──

export interface FixRequest {
  /** 訂正の発言の LINE message.id */
  messageId: string;
  groupId: string;
  code: number;
  page: number | null;
  turn: "" | "right" | "left";
  /** resolve で受け取った artifactSha256 */
  expectSha256: string;
}

export type FixResult = "closed" | "queued" | "human";
const FIX_RESULTS = new Set<string>(["closed", "queued", "human"]);

export type FixOutcome =
  | { kind: "accepted"; no: number; created: boolean; result: FixResult; reason: string }
  | { kind: "rejected"; code: string; httpStatus: number; busyJobNo?: number; pageCount?: number }
  | { kind: "unreachable" }
  | { kind: "unknown"; reason: string };

export async function postFix(no: number, req: FixRequest, opts: PortalOpts): Promise<FixOutcome> {
  const payload: Record<string, unknown> = {
    messageId: req.messageId,
    source: "line-group",
    groupId: req.groupId,
    code: req.code,
    turn: req.turn,
    expectSha256: req.expectSha256,
  };
  if (req.page !== null) payload.page = req.page; // 無いときは項目ごと省く（約束）
  const call = await postJson(`/api/jobs/${no}/fix`, payload, opts);
  if (call.kind !== "http") return call;
  if (call.status === 200 || call.status === 201) {
    const b = call.body;
    if (call.bodyOk && isPositiveInt(b.no) && typeof b.result === "string" && FIX_RESULTS.has(b.result)) {
      return {
        kind: "accepted",
        no: b.no,
        created: call.status === 201,
        result: b.result as FixResult,
        reason: typeof b.reason === "string" ? b.reason : "",
      };
    }
    // 成功の番号なのに中身が読めない＝受け付けられたかもしれない
    return { kind: "unknown", reason: "invalid-success-body" };
  }
  const r = rejectionOf(call, ["FIX_DISABLED", "INTAKE_STOPPED"]);
  if (r.kind !== "rejected") return r;
  const busy = call.body.busyJobNo;
  const pages = call.body.pageCount;
  return {
    ...r,
    ...(isPositiveInt(busy) ? { busyJobNo: busy } : {}),
    ...(isPositiveInt(pages) ? { pageCount: pages } : {}),
  };
}

// ── 差し戻しの対応の選択：POST /api/jobs/{no}/reject（設計 2026-10-11 の E12・約束 2026-10-11-obi-reject-contract.md） ──
//
// 選択（choose）・完成（approve）・選び直し（rechoose）を受け付ける。冪等のかぎは、その発言の message.id。
// **発言者を表す項目は送らない**（userId・表示名。誰が選べるかは呼ぶ前に確かめてある）。
// 結果は、ほかの入口と同じ4つに分ける（accepted／rejected／unreachable／unknown）。

export type RejectAction = "choose" | "approve" | "rechoose";

export interface RejectRequest {
  /** 選択の発言の LINE message.id */
  messageId: string;
  groupId: string;
  action: RejectAction;
  /** choose のときだけ 1〜4。approve・rechoose は 0（本文には入れない） */
  choice: number;
  /** 引用の返信なら引用先の知らせの世代（resolve の messageGen）、#J つきなら今の世代（resolve の choiceGen） */
  expectGen: number;
  /** approve・rechoose のときだけ、resolve の artifactSha256（64桁）。choose は ""（本文には入れない） */
  expectSha256: string;
}

export type RejectResult = "queued" | "human" | "canceled" | "approved" | "reopened";
const REJECT_RESULTS = new Set<string>(["queued", "human", "canceled", "approved", "reopened"]);

export type RejectOutcome =
  | { kind: "accepted"; no: number; created: boolean; result: RejectResult; choice: number }
  | {
      kind: "rejected";
      code: string;
      httpStatus: number;
      busyJobNo?: number;
      /** CHOICE_NOT_OFFERED のとき、今出している番号 */
      choices?: number[];
      /** GATE_FAILED のとき、通らなかった理由の符号 */
      reason?: string;
    }
  | { kind: "unreachable" }
  | { kind: "unknown"; reason: string };

export async function postReject(no: number, req: RejectRequest, opts: PortalOpts): Promise<RejectOutcome> {
  const payload: Record<string, unknown> = {
    messageId: req.messageId,
    source: "line-group",
    groupId: req.groupId,
    action: req.action,
    expectGen: req.expectGen,
  };
  // 約束：choice は choose のときだけ、expectSha256 は approve・rechoose のときだけ（余分に付けると INVALID_REQUEST）
  if (req.action === "choose") payload.choice = req.choice;
  else payload.expectSha256 = req.expectSha256;
  const call = await postJson(`/api/jobs/${no}/reject`, payload, opts);
  if (call.kind !== "http") return call;
  if (call.status === 200 || call.status === 201) {
    const b = call.body;
    if (
      call.bodyOk &&
      isPositiveInt(b.no) &&
      typeof b.result === "string" &&
      REJECT_RESULTS.has(b.result) &&
      isCount(b.choice) &&
      b.choice <= 4
    ) {
      return {
        kind: "accepted",
        no: b.no,
        created: call.status === 201,
        result: b.result as RejectResult,
        choice: b.choice,
      };
    }
    // 成功の番号なのに中身が読めない＝受け付けられたかもしれない
    return { kind: "unknown", reason: "invalid-success-body" };
  }
  // 503 は、portal がはっきり止めていると答えた2つだけ断り（CHOICE_DISABLED はスイッチ off・切った後の再送。結果不明にしない。T3・U2）
  const r = rejectionOf(call, ["CHOICE_DISABLED", "INTAKE_STOPPED"]);
  if (r.kind !== "rejected") return r;
  const busy = call.body.busyJobNo;
  const choices = parseChoices(call.body.choices);
  const reason = call.body.reason;
  return {
    ...r,
    ...(isPositiveInt(busy) ? { busyJobNo: busy } : {}),
    ...(choices ? { choices } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
  };
}
