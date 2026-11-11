/**
 * B2 査定書：ボタン（v1|sa|・v1|so|・v1|sr|）の処理と、差し戻し理由（次の1対1の文字）の取り込み。
 * 本物の Notion・portal・LINE・KV は satei-wire.ts。ここは deps を受け取るだけ。
 * 順番：TASK_SATEI off →「いまは止めています」だけ／押した人が TASK_SATEI_USER_IDS に無い →「いまは下村さんだけ」
 * → `pb:<webhookEventId>` の予約（二度押し・再送は何もしない）→ 処理。
 * ログは `[satei] sa accepted` の形（操作名・結果の符号・J番号だけ。案件名・userId・本文は出さない）。
 */
import type { DealKv } from "./deal-card";
import {
  isSateiUser,
  sateiActive,
  sateiReasonKey,
  SATEI_REASON_MAX,
  SATEI_REASON_TTL,
  type SateiAction,
} from "./satei-data";
import { judgeSateiDeal, type SateiDeal } from "./satei-deal";
import {
  SATEI_CODE_AWAITING_REASON,
  type SateiCall,
  type SateiDecideReq,
  type SateiIntakeOk,
  type SateiIntakeReq,
} from "./satei-portal";
import {
  MSG_SATEI_AWAITING_REASON,
  MSG_SATEI_BUSY,
  MSG_SATEI_DEAL_NOT_FOUND,
  MSG_SATEI_FAILED,
  MSG_SATEI_FORBIDDEN,
  MSG_SATEI_NO_FOLDER,
  MSG_SATEI_NOT_MANSION,
  MSG_SATEI_PAUSED,
  MSG_SATEI_UNKNOWN,
  msgSateiAccepted,
  msgSateiInProgress,
  msgSateiOk,
  msgSateiReasonClosed,
  msgSateiReasonFailed,
  msgSateiReasonSaved,
  msgSateiRejectAsk,
  msgSateiRejected,
  msgSateiStale,
} from "./satei-text";

export interface SateiActionDeps {
  /** CRM_DEALS_DB_ID（無ければ案件を読まずに「読み取れませんでした」） */
  dealsDbId: string | null;
  /** 案件ページと、物件の1件目の種別。ページが無ければ null。読めなければ例外 */
  readDeal(dealId: string): Promise<{ deal: SateiDeal; kind: string | null } | null>;
  intake(req: SateiIntakeReq): Promise<SateiCall<SateiIntakeOk>>;
  decide(no: number, req: SateiDecideReq): Promise<SateiCall<{ status: string }>>;
  /** 差し戻し理由の印を置く KV（設定が無ければ null） */
  kv: Pick<DealKv, "set"> | null;
  /** 印に入れる一意の値（あとで「自分が読んだ印」だけを消すため。本物は crypto.randomUUID） */
  newToken(): string;
  reserve(key: string): Promise<{ proceed: boolean }>;
  complete(key: string): Promise<void>;
  reply(replyToken: string, text: string): Promise<unknown>;
  log(line: string): void;
}

export interface SateiPostbackEvent {
  replyToken: string;
  webhookEventId?: string;
  source: { userId?: string; groupId?: string };
}

interface Outcome {
  text: string;
  code: string;
  /** false＝結果が分からない・読めなかった（完了印を付けない） */
  settled: boolean;
}

async function startSatei(
  dealId: string,
  eventId: string,
  userId: string,
  deps: SateiActionDeps,
): Promise<Outcome> {
  if (!deps.dealsDbId) return { text: MSG_SATEI_DEAL_NOT_FOUND, code: "config-missing", settled: true };
  let got: { deal: SateiDeal; kind: string | null } | null;
  try {
    got = await deps.readDeal(dealId);
  } catch {
    return { text: MSG_SATEI_DEAL_NOT_FOUND, code: "read-failed", settled: false };
  }
  const j = judgeSateiDeal(got?.deal ?? null, got?.kind ?? null, deps.dealsDbId);
  if (!j.ok) {
    const text =
      j.reason === "not-mansion"
        ? MSG_SATEI_NOT_MANSION
        : j.reason === "no-folder"
          ? MSG_SATEI_NO_FOLDER
          : MSG_SATEI_DEAL_NOT_FOUND;
    return { text, code: j.reason, settled: true };
  }
  let r: SateiCall<SateiIntakeOk>;
  try {
    r = await deps.intake({
      eventId,
      dealId: j.deal.id,
      dealNo: j.deal.dealNo,
      folderId: j.deal.folderId,
      dealName: j.deal.name,
      requestedBy: userId,
    });
  } catch {
    r = { kind: "unknown", reason: "exception" };
  }
  if (r.kind === "ok") {
    return r.value.created
      ? { text: msgSateiAccepted(r.value.no), code: "accepted", settled: true }
      : { text: msgSateiInProgress(r.value.no), code: "in-progress", settled: true };
  }
  if (r.kind === "rejected") {
    // 契約 6-10：同じ案件が差し戻しで理由待ち（理由が来るか、30分で sweep が取消にするまで）
    return r.code === SATEI_CODE_AWAITING_REASON
      ? { text: MSG_SATEI_AWAITING_REASON, code: "awaiting-reason", settled: true }
      : { text: MSG_SATEI_FAILED, code: "rejected", settled: true };
  }
  return { text: MSG_SATEI_UNKNOWN, code: "unknown", settled: false };
}

async function decideSatei(
  a: Extract<SateiAction, { op: "so" | "sr" }>,
  userId: string,
  deps: SateiActionDeps,
): Promise<Outcome> {
  let r: SateiCall<{ status: string }>;
  try {
    r = await deps.decide(a.no, {
      decision: a.op === "so" ? "ok" : "reject",
      by: userId,
      artifactSha256: a.sha256,
      generation: a.generation,
    });
  } catch {
    r = { kind: "unknown", reason: "exception" };
  }
  if (r.kind === "rejected") {
    return r.status === 409
      ? { text: msgSateiStale(a.no), code: "stale", settled: true }
      : { text: MSG_SATEI_FAILED, code: "rejected", settled: true };
  }
  if (r.kind === "unknown") return { text: MSG_SATEI_UNKNOWN, code: "unknown", settled: false };
  if (a.op === "so") return { text: msgSateiOk(a.no), code: "ok", settled: true };
  // 同じ人・同じ版の二度押しに、portal は今の状態を返す。もう取消なら閉じた依頼なので印に触らない
  // （置き直すと、次の無関係な1対1の発言を理由として送り、別案件の印も上書きするため）
  if (r.value.status === "取消") return { text: msgSateiStale(a.no), code: "closed", settled: true };
  if (r.value.status !== "差し戻し") return { text: msgSateiRejected(a.no), code: "rejected-unexpected", settled: true };
  // 差し戻し：次の1対1の文字を理由として受ける印（30分）。置けなければ理由は聞かない
  if (deps.kv) {
    try {
      await deps.kv.set(sateiReasonKey(userId), { no: a.no, token: deps.newToken() }, SATEI_REASON_TTL);
      return { text: msgSateiRejectAsk(a.no), code: "rejected-ask", settled: true };
    } catch {
      deps.log("[satei] sr reason-wait-failed");
    }
  }
  return { text: msgSateiRejected(a.no), code: "rejected-no-ask", settled: true };
}

/** satei のボタンが押されたとき。例外は投げない（返事で知らせる） */
export async function handleSateiPostback(
  action: SateiAction,
  ev: SateiPostbackEvent,
  deps: SateiActionDeps,
): Promise<void> {
  const say = async (text: string, code: string) => {
    try {
      await deps.reply(ev.replyToken, text);
    } catch {
      deps.log(`[satei] reply-failed ${action.op} ${code}`);
    }
  };
  if (!sateiActive()) {
    deps.log(`[satei] ${action.op} paused`);
    await say(MSG_SATEI_PAUSED, "paused");
    return;
  }
  const userId = ev.source.userId;
  if (!userId || !isSateiUser(userId)) {
    deps.log(`[satei] ${action.op} forbidden`);
    await say(MSG_SATEI_FORBIDDEN, "forbidden");
    return;
  }
  const eventId = ev.webhookEventId;
  if (!eventId) {
    deps.log(`[satei] ${action.op} no-event-id`);
    await say(MSG_SATEI_FAILED, "no-event-id");
    return;
  }
  const key = `pb:${eventId}`;
  let claim: { proceed: boolean };
  try {
    claim = await deps.reserve(key);
  } catch {
    deps.log(`[satei] ${action.op} reserve-failed`);
    await say(MSG_SATEI_BUSY, "busy");
    return;
  }
  if (!claim.proceed) {
    deps.log(`[satei] ${action.op} duplicate`);
    return;
  }
  let settled = false;
  try {
    const r =
      action.op === "sa"
        ? await startSatei(action.dealId, eventId, userId, deps)
        : await decideSatei(action, userId, deps);
    settled = r.settled;
    deps.log(`[satei] ${action.op} ${r.code}`);
    await say(r.text, r.code);
  } finally {
    // 結果が分からないときは完了印を付けない（予約は残す。押し直しは新しいイベント ID で通る）
    if (settled) await deps.complete(key).catch(() => deps.log(`[satei] mark-failed ${action.op}`));
  }
}

/**
 * 理由の印の KV。契約 6-11 のとおり GETDEL は使わず、読む（get）→ reason の結果を見てから消す。
 * 消すのは「今の値が読んだときと同じ token のときだけ」を1回で（delIfToken）。reason の応答待ちのあいだに
 * 別の差し戻しが印を書き換えても、その新しい印は消さない。
 */
export interface SateiReasonKv {
  get(key: string): Promise<unknown>;
  /** 今の値の token が一致したら消して true。違う・無ければ何もせず false */
  delIfToken(key: string, token: string): Promise<boolean>;
}

export interface SateiReasonDeps {
  kv: SateiReasonKv | null;
  reason(no: number, text: string): Promise<SateiCall<{ ok: true }>>;
  reply(replyToken: string, text: string): Promise<unknown>;
  log(line: string): void;
}

export interface SateiReasonMessage {
  userId?: string;
  groupId?: string;
  text: string;
  replyToken: string;
}

/**
 * 1対1の文字メッセージを、差し戻し理由として受けるか。true＝受けた（返事も済み）、false＝今の流れへ。
 * 受けるのは TASK_SATEI=1・1対1・TASK_SATEI_USER_IDS の人・空でない文字・印（`satei:reason:<userId>`）があるときだけ。
 * それ以外は KV も読まない。
 * 契約 6-11：印は消さずに reason を呼ぶ。
 *   ok       → 印を消して「理由を記録しました」
 *   unknown  → 印を残して「記録できませんでした。もう一度送ってください」（次の1通をもう一度理由として受ける。印は30分で消える）
 *   rejected で status が 4xx → portal が実際に断った（30分を過ぎて取消・もう理由が入っている）。もう一度送っても通らないので
 *              印を消し、「この差し戻しはもう閉じています」（印を残すと、その後の1対1の発言を30分まで吸い込み続けるため）
 *   それ以外（status 0＝設定不足・5xx・unknown・例外）→ 通信できなかったものとして印を残し「もう一度送ってください」
 * 消すときは読んだ印の token を付けて delIfToken（別の差し戻しが書き換えた新しい印は消さない）。
 */
export async function handleSateiReasonText(m: SateiReasonMessage, deps: SateiReasonDeps): Promise<boolean> {
  if (!sateiActive() || m.groupId || !m.userId || !isSateiUser(m.userId) || !deps.kv) return false;
  const text = Array.from((m.text ?? "").trim()).slice(0, SATEI_REASON_MAX).join("");
  if (!text) return false;
  const key = sateiReasonKey(m.userId);
  let v: unknown;
  try {
    v = await deps.kv.get(key);
  } catch {
    deps.log("[satei] reason read-failed");
    return false;
  }
  const mark = v && typeof v === "object" ? (v as { no?: unknown; token?: unknown }) : null;
  const no = mark?.no;
  const token = mark?.token;
  if (typeof no !== "number" || !Number.isInteger(no) || no <= 0) return false;
  if (typeof token !== "string" || !token) return false;
  let r: SateiCall<{ ok: true }>;
  try {
    r = await deps.reason(no, text);
  } catch {
    r = { kind: "unknown", reason: "exception" };
  }
  // 印を消すのは、記録できたときと、portal が実際に 4xx で断ったときだけ
  const closed = r.kind === "rejected" && r.status >= 400 && r.status < 500;
  const outcome = r.kind === "ok" ? "saved" : closed ? "closed" : "retry";
  deps.log(`[satei] reason #J${no} ${outcome}`);
  if (outcome !== "retry") {
    try {
      await deps.kv.delIfToken(key, token);
    } catch {
      // 消せなくても次の1通は reason が「もう入っている」と 4xx で断り、そこで消える
      deps.log("[satei] reason clear-failed");
    }
  }
  const reply =
    outcome === "saved" ? msgSateiReasonSaved(no) : outcome === "closed" ? msgSateiReasonClosed(no) : msgSateiReasonFailed(no);
  try {
    await deps.reply(m.replyToken, reply);
  } catch {
    deps.log("[satei] reply-failed reason");
  }
  return true;
}
