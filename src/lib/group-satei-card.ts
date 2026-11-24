/**
 * 普通のグループの査定依頼：下村さんへの知らせの文・候補のカード・一覧のカード・ボタンの返事（設計 8.3〜8.4）。
 * お客様の名前・本文は入れない。依頼者は名簿の正式氏名だけ（呼ぶ側が渡す）。
 */
import {
  encodeGsList, encodeGsManual, encodeGsNone, encodeGsPick, GS_PAGE, GS_SURE, receiptOf, type GsRead,
} from "./group-satei-data";
import type { DealRef } from "./task-record";
import { ALT_TEXT_MAX, FLEX_LABEL_MAX, POSTBACK_TEXT_MAX, pressedText, type FlexMessage } from "./task-card";

const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");
const NAME_MAX = 60;

function jst(at: number): string {
  const d = new Date(at + 9 * 60 * 60 * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const FAILED_TEXT: Record<string, string> = {
  cap: "資料を読めませんでした（本日の上限）。LINE のグループで確かめてください。",
};

export function gsNoticeText(o: {
  no: number;
  at: number;
  requesterName: string | null;
  read: GsRead | null;
  readFailed?: string;
  materials: { images: number; pdfs: number; others: number };
}): string {
  const sure = o.read ? o.read.confidence >= GS_SURE : true;
  const lines = [`🏠 LINE のグループで査定の依頼${sure ? "がありました" : "かもしれません"}`];
  lines.push(`${jst(o.at)}${o.requesterName ? `・${cut(o.requesterName, 20)}さん` : ""}（受付 ${receiptOf(o.no)}）`);
  if (o.read) {
    const what = o.read.propertyName ?? o.read.address;
    lines.push(`読み取った物件：${what ? cut(what, NAME_MAX) : "分かりませんでした"}`);
    if (o.read.propertyName && o.read.address) lines.push(`所在：${cut(o.read.address, NAME_MAX)}`);
    lines.push(`種別の見込み：${o.read.kind}（${o.read.basis}から）`);
  } else {
    lines.push(FAILED_TEXT[o.readFailed ?? ""] ?? "資料を読めませんでした。LINE のグループで確かめてください。");
  }
  const m = o.materials;
  const parts = [m.images ? `画像${m.images}枚` : "", m.pdfs ? `PDF${m.pdfs}件` : ""].filter(Boolean);
  lines.push(`資料：${parts.length ? parts.join("・") : "なし（本文だけ）"}`);
  lines.push("どの案件か選んでください。");
  return lines.join("\n");
}

export function gsPickLabel(name: string, kind: string | null): string {
  const tail = kind === "マンション" ? "で査定書を作る" : kind === "戸建" || kind === "土地" ? "で進める（手作業）" : "で進める";
  const room = FLEX_LABEL_MAX - Array.from(tail).length;
  return `${cut(name, room)}${tail}`;
}

const button = (label: string, data: string, subject: string | null, primary = false) => ({
  type: "button",
  style: primary ? "primary" : "secondary",
  height: "sm",
  action: { type: "postback", label: cut(label, FLEX_LABEL_MAX), data, displayText: cut(pressedText(label, subject), POSTBACK_TEXT_MAX) },
});
const small = (text: string, color = "#555555") => ({ type: "text", text, size: "sm", color, wrap: true });

export interface GsCandidate {
  deal: DealRef;
  kind: string | null;
}

export function gsCard(tid: string, ver: number, cands: GsCandidate[], dealsFailed: boolean, no?: number): FlexMessage {
  const subj = no !== undefined ? `受付 ${receiptOf(no)}` : null;
  const guide =
    cands.length > 0
      ? "どの案件ですか？"
      : dealsFailed
        ? "CRM の案件を確かめられませんでした。一覧から選んでください"
        : "名前の合う進行中の案件が見つかりませんでした。一覧から選んでください";
  return {
    type: "flex",
    altText: cut("査定の依頼：どの案件か選んでください", ALT_TEXT_MAX),
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "sm", contents: [small(guide, "#333333")] },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          ...cands.map((c) => button(gsPickLabel(c.deal.name, c.kind), encodeGsPick(tid, ver, c.deal.id), null, true)),
          button("一覧から選ぶ", encodeGsList(tid, ver, 0), subj),
          button("案件がまだ無い（手作業で査定）", encodeGsManual(tid, ver), subj),
          button("査定の依頼ではない", encodeGsNone(tid, ver), subj),
        ],
      },
    },
  };
}

export function gsListCard(tid: string, ver: number, no: number, deals: DealRef[], offset: number): FlexMessage | null {
  const sorted = [...deals].sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const page = sorted.slice(offset, offset + GS_PAGE);
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
    footer: { type: "box", layout: "vertical", contents: [button("この案件で進める", encodeGsPick(tid, ver, d.id), cut(d.name, NAME_MAX), true)] },
  }));
  const rest = sorted.length - offset - page.length;
  if (rest > 0 && offset + GS_PAGE <= 500) {
    bubbles.push({
      type: "bubble",
      size: "kilo",
      body: { type: "box", layout: "vertical", contents: [small(`残り${rest}件`)] },
      footer: { type: "box", layout: "vertical", contents: [button("次の10件", encodeGsList(tid, ver, offset + GS_PAGE), `受付 ${receiptOf(no)}`)] },
    });
  }
  return { type: "flex", altText: cut(`どの案件ですか（${receiptOf(no)}）`, ALT_TEXT_MAX), contents: { type: "carousel", contents: bubbles } };
}

export const MSG_GS_PAUSED = "いまは止めています";
export const MSG_GS_FORBIDDEN = "いまは下村さんだけが使えます";
export const MSG_GS_EXPIRED = "この査定の依頼は期限が切れています（7日）";
export const MSG_GS_STALE = "新しいカードが届いています。そちらから選んでください";
export const MSG_GS_BUSY = "いま操作を受け付けられません。少し待ってからもう一度押してください";
export const MSG_GS_DEALS_FAILED = "案件を読み取れませんでした。少し待ってからもう一度押してください";
export const MSG_GS_NOT_ACTIVE = "この案件は進行中の一覧にありません。［一覧から選ぶ］から選び直してください";
export const MSG_GS_UNKNOWN = "結果を確かめられませんでした。portal の依頼箱で確かめてください";
export const msgGsAlready = (no: number) => `選択済みです（受付 ${receiptOf(no)}）`;
export const msgGsManual = (no: number, kind: string | null) =>
  kind === "戸建" || kind === "土地"
    ? `${kind}のため自動作成はできません。手作業の査定に回します（受付 ${receiptOf(no)}）`
    : kind === "マンション"
    ? `いまは査定書の自動作成を止めています。手作業の査定に回します（受付 ${receiptOf(no)}）`
    : `物件の種別が分からないため自動では作れません。手作業の査定に回します（受付 ${receiptOf(no)}）。CRM_物件 の種別を入れると、次からは自動で判断します`;
export const msgGsNoDeal = (no: number) =>
  `手作業の査定に回します（受付 ${receiptOf(no)}）。CRM_案件 を作ったあとなら、このカードの［一覧から選ぶ］で選び直せます（7日間）`;
export const msgGsDismissed = (no: number) => `査定の依頼ではないとして閉じました（受付 ${receiptOf(no)}）`;
export const msgGsKindMismatch = (readKind: string) => `資料からは${readKind}に見えます。CRM_物件 の種別を確かめてください`;
export const MSG_GS_LIST_END = "これより後の案件はありません";
export const MSG_GS_NO_FOLDER = "案件の Driveフォルダが未設定です。設定してから、もう一度押してください";
