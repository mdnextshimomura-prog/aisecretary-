/**
 * B2 査定書：返事・個人あての通知の文面と、下書きのカード（契約 第3節の「文面」）。
 * J番号は帯替えと同じ `#J<no>` の形。draft 以外の通知は、どの依頼か分かるよう頭に【査定書 #J番号・案件名】を付ける。
 */
import { encodeSateiDecision } from "./satei-data";
import {
  ALT_TEXT_MAX,
  FLEX_LABEL_MAX,
  POSTBACK_TEXT_MAX,
  type FlexMessage,
} from "./task-card";

const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");

export const jobTag = (no: number): string => `#J${no}`;

export const MSG_SATEI_PAUSED = "いまは止めています";
export const MSG_SATEI_FORBIDDEN = "いまは下村さんだけが使えます";
export const MSG_SATEI_NOT_MANSION = "いまはマンションの案件だけ作れます";
export const MSG_SATEI_NO_FOLDER = "案件の Driveフォルダが未設定です";
export const MSG_SATEI_DEAL_NOT_FOUND = "案件を読み取れませんでした";
export const MSG_SATEI_BUSY = "いま操作を受け付けられません。少し待ってからもう一度押してください";
export const MSG_SATEI_FAILED = "⚠️ 受け付けられませんでした。少し時間をおいてもう一度お試しください。";
export const MSG_SATEI_UNKNOWN = "受け付けられたか確かめられませんでした。少し待ってからもう一度押してください";
/** 同じ案件が差し戻しで理由待ちのあいだの［査定書を作る］（契約 6-10 の文） */
export const MSG_SATEI_AWAITING_REASON =
  "差し戻しの理由を待っています（理由を返信するか、30分後に押し直してください）";

export const msgSateiAccepted = (no: number) => `受け付けました。結果は個人の LINE に届きます（${jobTag(no)}）`;
export const msgSateiInProgress = (no: number) => `作成中です（${jobTag(no)}）`;
export const msgSateiOk = (no: number) => `OK を受け付けました。案件フォルダに保存したら知らせます（${jobTag(no)}）`;
export const msgSateiRejectAsk = (no: number) =>
  `差し戻しました（${jobTag(no)}）。理由を一言返信してください（次の1通を理由として記録します）`;
export const msgSateiRejected = (no: number) => `差し戻しました（${jobTag(no)}）`;
export const msgSateiStale = (no: number) => `この下書きは古いか、もう処理済みです（${jobTag(no)}）`;
export const msgSateiReasonSaved = (no: number) => `理由を記録しました（${jobTag(no)}）`;
/** 通信の失敗・結果不明（印は残すので、次の1通をもう一度理由として受ける。契約 6-11 の文） */
export const msgSateiReasonFailed = (no: number) => `記録できませんでした。もう一度送ってください（${jobTag(no)}）`;
/** portal がはっきり断った（30分を過ぎて取消になった・もう理由が入っている）。印は消す */
export const msgSateiReasonClosed = (no: number) =>
  `理由を記録できませんでした。この差し戻しはもう閉じています（${jobTag(no)}）`;

export type SateiNoticeKind = "draft" | "failed" | "saved" | "aborted";

export interface SateiNotice {
  no: number;
  kind: SateiNoticeKind;
  generation: number;
  dealName: string;
  driveFileId: string | null;
  verdict: string | null;
  /** 指摘（上位3件・各120字に切ったもの） */
  findings: string[];
  missing: string[];
  failReason: string | null;
  artifactSha256: string | null;
}

const DEAL_NAME_MAX = 60;
const FINDINGS_MAX = 3;
const FINDING_LEN = 120;

const nameOf = (n: SateiNotice) => cut(n.dealName.trim() || "（無題）", DEAL_NAME_MAX);

export const driveViewUrl = (fileId: string): string => `https://drive.google.com/file/d/${fileId}/view`;

const FAIL_LABEL: Record<string, string> = {
  timeout: "時間切れ",
  check: "検品できませんでした",
  internal: "内部のエラー",
};

function bodyOf(n: SateiNotice): string {
  if (n.kind === "saved") return "案件フォルダの 02_査定・事例 に保存しました";
  if (n.kind === "aborted") {
    return n.failReason === "name-conflict"
      ? "同じ名前で中身の違うファイルがあるので保存していません"
      : "資料が変わったので保存していません。［査定書を作る］を押し直してください";
  }
  // failed（draft は呼ばれない）
  if (n.failReason === "materials") {
    const what = n.missing.length > 0 ? n.missing.join("、") : "（一覧なし）";
    return `材料が足りないので作っていません：${what}。入れたら［査定書を作る］を押し直してください`;
  }
  if (n.failReason === "folder") return "案件フォルダを確かめられませんでした";
  const label = FAIL_LABEL[n.failReason ?? ""] ?? FAIL_LABEL.internal;
  return `作れませんでした（${label}）。押し直すと最初からやり直します`;
}

/** draft 以外の通知の文 */
export function sateiNoticeText(n: SateiNotice): string {
  return `【査定書 ${jobTag(n.no)}・${nameOf(n)}】\n${bodyOf(n)}`;
}

const postback = (label: string, data: string, displayText: string, primary: boolean) => ({
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

/** 下書きのカード（判定・指摘3件・［下書きを見る］［OK］［差し戻し］）。必要な値がそろわなければ null */
export function sateiDraftCard(n: SateiNotice): FlexMessage | null {
  if (!n.driveFileId || !n.artifactSha256 || !n.verdict) return null;
  const head = `🏢 査定書の下書きができました（${jobTag(n.no)}・${nameOf(n)}）`;
  const findings = n.findings.slice(0, FINDINGS_MAX).map((f) => ({
    type: "text",
    text: `・${cut(f, FINDING_LEN)}`,
    size: "sm",
    color: "#555555",
    wrap: true,
  }));
  return {
    type: "flex",
    altText: cut(head, ALT_TEXT_MAX),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: head, weight: "bold", size: "md", wrap: true },
          { type: "text", text: `判定：${n.verdict}`, size: "sm", wrap: true },
          ...(findings.length > 0 ? findings : [{ type: "text", text: "指摘：なし", size: "sm", wrap: true }]),
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: { type: "uri", label: "下書きを見る", uri: driveViewUrl(n.driveFileId) },
          },
          postback("OK", encodeSateiDecision("so", n.no, n.generation, n.artifactSha256), "（ボタン）査定書OK", true),
          postback(
            "差し戻し",
            encodeSateiDecision("sr", n.no, n.generation, n.artifactSha256),
            "（ボタン）査定書を差し戻す",
            false,
          ),
        ],
      },
    },
  };
}

/** push する中身（draft はカード1通、ほかは文字1通）。draft で値がそろわなければ null */
export function sateiNoticeMessages(n: SateiNotice): unknown[] | null {
  if (n.kind === "draft") {
    const card = sateiDraftCard(n);
    return card ? [card] : null;
  }
  return [{ type: "text", text: sateiNoticeText(n) }];
}
