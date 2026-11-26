/**
 * 段2d（計画 docs/superpowers/plans/2026-11-26-group-satei-2d.md）：事例の取り方の相談のカード・グループへの依頼の文・リマインド・
 * 作り直しの指示文・返事の文と、送る前の検査。純粋（通信しない）。
 * グループに出す文には、お客様の名前・REINS の物件番号・号室・番地を入れない（設計 6.2）。gsSafeText に通らないものは出さない（D14）。
 * 案件名（Notion）は使わない（お客様の名前が入りうる。D13）。
 */
import { encodeGsFix, encodeGsYes, receiptOf, type GsPrepKind, type GsRead } from "./group-satei-data";
import { gsDeadlineLabel } from "./group-satei-deadline";
import { GS_READ_MODEL, type GsCreateReq } from "./group-satei-read";
import { ALT_TEXT_MAX, FLEX_LABEL_MAX, POSTBACK_TEXT_MAX, pressedText, type FlexMessage } from "./task-card";

const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");
export const GS_LINES_MAX = 6;
export const GS_LINE_LEN = 80;
const PLACE_MAX = 40;
const BUILDING_MAX = 30;

const NG_RE = /[0-9]+\s*号室|[0-9]+\s*番地|[0-9]+番[0-9]|[0-9]+-[0-9]+|[0-9]{9,}|様/;
/** 送ってよい文か（全角の数字・ハイフンも NFKC でそろえてから見る） */
export function gsSafeText(s: string): boolean {
  return !NG_RE.test(s.normalize("NFKC").replace(/[‐‑‒–—―ー−]/g, (c) => (c === "ー" ? c : "-")));
}

/** 案の行をそろえる。形が違う・1行も無い・1つでも検査に通らなければ null */
export function gsCleanLines(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return null;
  // 頭の全角の空白（「　」で始める条件の行）は残す。半角の空白・改行と、末尾の空白だけ落とす
  const lines = (v as string[])
    .map((x) => x.replace(/^[ \t\r\n]+/, "").trimEnd())
    .filter((x) => x.trim() !== "")
    .slice(0, GS_LINES_MAX)
    .map((x) => cut(x, GS_LINE_LEN));
  if (lines.length === 0 || !lines.every(gsSafeText)) return null;
  return lines;
}

/** 所在を町名まで：「丁目」があればそこまで、無ければ最初の数字の前まで（番地・号を落とす） */
export function gsTownOf(address: string | null): string | null {
  if (!address) return null;
  const s = address.normalize("NFKC").replace(/\s+/g, "");
  const chome = /^(.*?丁目)/.exec(s);
  if (chome) return cut(chome[1], PLACE_MAX);
  const i = s.search(/[0-9]/);
  const head = (i >= 0 ? s.slice(0, i) : s).replace(/[-‐－ーの]+$/, "");
  return Array.from(head).length >= 2 ? cut(head, PLACE_MAX) : null;
}

/** 物件名から号室を落とした建物名（読み取りの物件名は「マンション名と号室」。R8） */
export function gsBuildingOf(read: GsRead | null): string | null {
  const name = read?.propertyName?.normalize("NFKC").trim();
  if (!name) return null;
  let s = name;
  const room = read?.facts?.roomNo?.normalize("NFKC").trim();
  if (room) s = s.split(room).join("");
  // 号室の番号を抜いたあとに残る「号室」も落とす（「パークハウス天満 1203号室」で roomNo が 1203 のとき）
  s = s.replace(/\s*(?:[0-9]+\s*(?:号室|号|室)?|号室)\s*$/, "").trim();
  return s && gsSafeText(s) ? cut(s, BUILDING_MAX) : null;
}

/** グループのカードの「物件：」。マンションは町名・建物名、戸建・土地は町名だけ。どちらも無ければ null */
export function gsPublicPlace(read: GsRead | null, kind: GsPrepKind): string | null {
  const town = gsTownOf(read?.address ?? null);
  const building = kind === "マンション" ? gsBuildingOf(read) : null;
  const s = [town, building].filter(Boolean).join("・");
  return s && gsSafeText(s) ? s : null;
}

const text = (t: string, o: Record<string, unknown> = {}) => ({ type: "text", text: t, size: "sm", color: "#333333", wrap: true, ...o });
const button = (label: string, data: string, subject: string, primary = false) => ({
  type: "button",
  style: primary ? "primary" : "secondary",
  height: "sm",
  action: { type: "postback", label: cut(label, FLEX_LABEL_MAX), data, displayText: cut(pressedText(label, subject), POSTBACK_TEXT_MAX) },
});

/** 下村さんへの相談のカード（設計 6.1）。期日は「今押したら」の見込み（押した時刻で決め直す） */
export function gsProposalCard(o: { tid: string; ver: number; no: number; rev: number; place: string | null; lines: string[]; previewDeadline: number }): FlexMessage {
  const subj = `受付 ${receiptOf(o.no)}`;
  return {
    type: "flex",
    altText: cut(`事例の取り方の相談（${subj}）`, ALT_TEXT_MAX),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          text(`事例の取り方の相談（${subj}）`, { weight: "bold", size: "md" }),
          text(`${o.place ?? "この物件"}の REINS の事例を、次の条件で山口さんに頼んでいいですか？`),
          ...o.lines.map((l) => text(l, { color: "#555555" })),
          text(`期日：今押すと ${gsDeadlineLabel(o.previewDeadline)}（17時を過ぎたら次の営業日の18時）`, { color: "#555555" }),
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [button("いいよ", encodeGsYes(o.tid, o.ver, o.rev), subj, true), button("直す", encodeGsFix(o.tid, o.ver, o.rev), subj)],
      },
    },
  };
}

const mention = (staffId: string) => ({ staff: { type: "mention", mentionee: { type: "user", userId: staffId } } });

/** グループへの依頼（D9）：textV2 のメンション＋ボタンなしのカード。検査に通らなければ null（送らない） */
export function gsCaseRequestMessages(o: { staffId: string; no: number; place: string | null; lines: string[]; deadline: number }): unknown[] | null {
  const subj = `受付 ${receiptOf(o.no)}`;
  const head = `査定の事例をお願いします（${subj}）`;
  const body = [`物件：${o.place ?? "（カードの条件で）"}`, ...o.lines, `期日：${gsDeadlineLabel(o.deadline)}`, "取れたら、このトークに PDF を貼ってください"];
  if (![head, ...body].every(gsSafeText)) return null;
  return [
    { type: "textV2", text: `{staff} ${head}`, substitution: mention(o.staffId) },
    {
      type: "flex",
      altText: cut(head, ALT_TEXT_MAX),
      contents: {
        type: "bubble",
        body: { type: "box", layout: "vertical", spacing: "sm", contents: [text(head, { weight: "bold", size: "md" }), ...body.map((b) => text(b))] },
      },
    },
  ];
}

/** 手で頼むときに下村さんへ渡す文面（同じ中身の文字だけ） */
export function gsCaseRequestPlain(o: { no: number; place: string | null; lines: string[]; deadline: number }): string {
  return [`査定の事例をお願いします（受付 ${receiptOf(o.no)}）`, `物件：${o.place ?? "（町名を入れてください）"}`, ...o.lines, `期日：${gsDeadlineLabel(o.deadline)}`].join("\n");
}

/** リマインド（設計 6.2）：グループに1回だけ */
export function gsReminderMessages(staffId: string, no: number): unknown[] {
  return [{ type: "textV2", text: `{staff} 受付 ${receiptOf(no)} の事例はいかがでしょうか`, substitution: mention(staffId) }];
}

const FIX_SYSTEM = [
  "あなたは不動産会社の査定の手伝いです。REINS の事例の取り方の案（行の配列）を、担当者の直しの言葉に合わせて書き直します。",
  '答えは JSON だけ：{"lines":["…","…"]}。行は6行まで、1行80字まで。書き方は今の行にそろえる（「成約：」「売出：」で始める行と、「　」で始める条件の行）。',
  "直しの言葉に無いことは変えない。号室・番地・人の名前・REINS の物件番号は書かない。分からないことを作らない。",
].join("\n");

/** ［直す］の作り直し（D3）。Claude 1回 */
export function gsFixRequest(lines: string[], fixText: string, kind: GsPrepKind): GsCreateReq {
  return {
    model: GS_READ_MODEL,
    max_tokens: 800,
    system: FIX_SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text: `種別：${kind}\n今の行：\n${JSON.stringify(lines)}\n直しの言葉：\n${fixText}` }] }],
  };
}

/** 作り直しの答えを読む。JSON の lines が検査に通るときだけ */
export function gsParseFix(out: { content: Array<{ type: string; text?: string }> }): string[] | null {
  const raw = out.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("");
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  try {
    return gsCleanLines((JSON.parse(m[0]) as { lines?: unknown }).lines);
  } catch {
    return null;
  }
}

const R = (no: number) => `受付 ${receiptOf(no)}`;
export const msgGsPrepStarted = (no: number) => `査定で進めます。事例の取り方の案を作って、数分でお送りします（${R(no)}）`;
export const msgGsPrepUnknown = (no: number) =>
  `事例の案づくりを頼めたか確かめられませんでした。30分たっても案が届かなければ、山口さんへは手で頼んでください（${R(no)}）`;
export const msgGsPrepRejected = (no: number) => `事例の案づくりを受け付けられませんでした。山口さんへは手で頼んでください（${R(no)}）`;
export const msgGsPrepStopped = (no: number) => `いま受付を止めています。少し待ってから、もう一度案件を選んでください（${R(no)}）`;
export const msgGsPrepFailed = (no: number) => `事例の取り方の案を作れませんでした。山口さんへは手で頼んでください（${R(no)}）`;
export const msgGsPrepLate = (no: number) =>
  `事例の取り方の案がまだできていません（${R(no)}）。Mac の査定係が止まっているかもしれません。山口さんへは手で頼んでも大丈夫です`;
export const msgGsCaseRequested = (no: number, label: string) =>
  `山口さんに頼みました（${R(no)}・期日 ${label}）。PDF が貼られたら、案件フォルダの 02 に入れて［査定書を作る］を押してください（自動の保存は次の段）`;
export const msgGsCaseSendFailed = (no: number, unknown: boolean, plain: string) =>
  `${unknown ? "山口さんへの依頼を送れたか確かめられませんでした。グループを見て、届いていなければ" : "山口さんへの依頼を送れませんでした。"}手で頼んでください（${R(no)}）\n\n${plain}`;
export const msgGsFixAsk = (no: number, left: number) =>
  `直すところを1通で送ってください（喋ったままで大丈夫です）。30分以内・あと${left}回まで（${R(no)}）`;
export const msgGsFixLimit = (no: number) => `直すのは2回までです。山口さんへは手で頼んでください（${R(no)}）`;
export const msgGsFixDone = (no: number, fixes: number) => `直しました（${fixes}回目／2回まで）。これでよければ［いいよ］を押してください（${R(no)}）`;
export const msgGsFixFailed = (no: number) => `うまく作り直せませんでした。［直す］をもう一度押すか、山口さんへは手で頼んでください（${R(no)}）`;
export const msgGsRemindMe = (no: number, label: string) =>
  `${R(no)} の事例がまだ届いていないので、グループで山口さんに1回だけ声をかけました（期日 ${label}）`;
export const msgGsAlreadyRequested = (no: number) => `山口さんへはもう頼んであります（${R(no)}）`;
export const MSG_GS_PROPOSAL_STALE = "新しい案が届いています。そちらから選んでください";
