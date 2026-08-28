/**
 * APIが使えなくなったことをLINEで知らせる。
 *
 * 背景（2026-08-19〜08-28に実際に起きたこと）:
 *   Anthropicの残高が切れ、AI秘書は全メッセージでAPIエラーを受けていた。
 *   しかしコードはそれを「解析できなかった発言」として黙って捨てていたため、
 *   **誰も壊れていることに気づかないまま営業日6日分・依頼30件を取りこぼした**。
 *
 * 自動リロードを使わない運用にしたので、**止まったことが即座に分かる**ことが
 * 唯一の防波堤になる。黙って落ちるのだけは避ける。
 */
import { claimAlertSlot, clearAlertSlot } from "./email/session";

export type ApiFailure = "credit" | "auth" | "rate";

/**
 * 例外が「AI秘書が働けない状態」を示すものかを見分ける。
 * 一時的なネットワークエラーなどは対象外（毎回警告を出しても意味がない）。
 */
export function classifyApiError(err: unknown): ApiFailure | null {
  const e = err as { status?: number; message?: string; error?: unknown };
  const msg = [
    e?.message ?? "",
    typeof e?.error === "string" ? e.error : JSON.stringify(e?.error ?? ""),
  ].join(" ");

  if (/credit balance is too low|insufficient.*credit/i.test(msg)) return "credit";
  if (e?.status === 401 || /authentication|invalid x-api-key|invalid api key/i.test(msg)) {
    return "auth";
  }
  if (e?.status === 429 || /rate.?limit/i.test(msg)) return "rate";
  return null;
}

const MESSAGES: Record<ApiFailure, string> = {
  // LINEはマークダウンを解釈しない。装飾記号は文字のまま出るので使わない
  credit:
    "⚠️ AI秘書が応答できません（APIの残高切れ）\n\n" +
    "いまご依頼をいただいても、自動では登録されません。\n" +
    "Anthropicの残高を補充すると、そのまま復旧します。\n\n" +
    "※ 担当者のメンション付き・資料添付のご依頼は、\n" +
    "　 内容そのままNotionに控えています（要確認の状態）。",
  auth:
    "⚠️ AI秘書が応答できません（APIキーの認証エラー）\n\n" +
    "キーが無効化されたか、差し替えが必要かもしれません。\n" +
    "いまご依頼をいただいても、自動では登録されません。",
  rate:
    "⚠️ AI秘書が一時的に混み合っています（レート制限）\n\n" +
    "しばらくしてから、もう一度お送りください。",
};

export function alertMessage(kind: ApiFailure): string {
  return MESSAGES[kind];
}

/**
 * 警告を出すべきか判定する。
 * 残高切れは復旧まで全メッセージで起きるため、種類ごとに1日1回に抑える。
 */
export async function shouldAlert(kind: ApiFailure): Promise<boolean> {
  return claimAlertSlot(kind).catch(() => false);
}

/** 正常に動いたときに呼ぶ。次に落ちたらまた警告を出せるようにする */
export async function markApiHealthy(): Promise<void> {
  await Promise.all([
    clearAlertSlot("credit").catch(() => undefined),
    clearAlertSlot("auth").catch(() => undefined),
    clearAlertSlot("rate").catch(() => undefined),
  ]);
}
