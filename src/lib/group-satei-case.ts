/**
 * 段2d（計画 docs/superpowers/plans/2026-11-26-group-satei-2d.md）：事例の取り方の相談のカード・グループへの依頼の文・リマインド・
 * 作り直しの指示文・返事の文と、送る前の検査。純粋（通信しない）。
 * グループに出す文には、お客様の名前・REINS の物件番号・号室・番地を入れない（設計 6.2）。gsSafeText に通らないものは出さない（D14）。
 * 案件名（Notion）は使わない（お客様の名前が入りうる。D13）。
 */
import { encodeGsFix, encodeGsRemind, encodeGsYes, receiptOf, type GsPrepKind, type GsRead } from "./group-satei-data";
import { gsDeadlineLabel } from "./group-satei-deadline";
import { GS_READ_MODEL, type GsCreateReq } from "./group-satei-read";
import { ALT_TEXT_MAX, FLEX_LABEL_MAX, POSTBACK_TEXT_MAX, pressedText, type FlexMessage } from "./task-card";

const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");
export const GS_LINES_MAX = 6;
export const GS_LINE_LEN = 80;
const PLACE_MAX = 40;
const BUILDING_MAX = 30;

/** 漢数字（番地の「百二十三」「六〇二」など） */
const KN = "〇一二三四五六七八九十百千";
const NG_RE = new RegExp(
  [
    "[0-9]+\\s*号室", "[0-9]+\\s*番地", "[0-9]+番[0-9]", "[0-9]+-[0-9]+", "[0-9]{9,}",
    // 漢数字の番地：「百二十三番地」「三号」「百二十三番五」「二十の五」（「一番近い」「一番町」は通す）
    `[${KN}]+\\s*(?:番地|号|番[${KN}0-9]|の[${KN}0-9])`,
    // 数字の間の長音・ハイフン（「2ー3」「二ー三」。全角の「－」「―」は下で「-」にそろえる）
    `[0-9${KN}]\\s*[-ー]\\s*[0-9${KN}]`,
  ].join("|"),
);
/** 人の名前らしい形：漢字・カタカナの後の さん・ちゃん・くん・殿・氏・邸、名字＋方（「田中方」）、様（同様・様子・様式・仕様・多様・模様・様々は通す） */
const PERSON_RE = new RegExp(
  [
    "[一-龥々ァ-ヶー](?:さん|ちゃん|くん|殿|氏(?!名)|邸)",
    "(?<![同多仕模])様(?![子式々相])",
    "(?![両片双地仕味夕朝親先後前東西南北上下貴当行裏表])[一-龥々ァ-ヶ]方(?=[、。\\s)）]|$)",
  ].join("|"),
);
/** 人の名前の形でも通す言葉（Mac の案の「幅は山口さんにお任せ」など） */
const PERSON_OK_RE = /山口さん|皆さん|皆様/g;
/** 送ってよい文か（全角の数字・ハイフンも NFKC でそろえてから見る）。号室・番地（漢数字も）・長い番号・人の名前は通さない */
export function gsSafeText(s: string): boolean {
  const n = s.normalize("NFKC").replace(/[‐‑‒–—―ー−]/g, (c) => (c === "ー" ? c : "-"));
  return !NG_RE.test(n) && !PERSON_RE.test(n.replace(PERSON_OK_RE, ""));
}

/** 案の行の形だけそろえる（検査はしない）。形が違う・1行も無ければ null */
function tidyLines(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return null;
  // 頭の全角の空白（「　」で始める条件の行）は残す。半角の空白・改行と、末尾の空白だけ落とす
  const lines = (v as string[])
    .map((x) => x.replace(/^[ \t\r\n]+/, "").trimEnd())
    .filter((x) => x.trim() !== "")
    .slice(0, GS_LINES_MAX)
    .map((x) => cut(x, GS_LINE_LEN));
  return lines.length === 0 ? null : lines;
}

/** 案の行をそろえる。形が違う・1行も無い・1つでも検査に通らなければ null */
export function gsCleanLines(v: unknown): string[] | null {
  const lines = tidyLines(v);
  return lines && lines.every(gsSafeText) ? lines : null;
}

const PREF_RE = /^(?:東京都|北海道|京都府|大阪府|[^\s]{2,3}県)/;
/** 町名の後ろで切る所：数字・小字（「字」）・漢数字の番地（「百二十三番地」「六〇二」。「四条通」「一番町」では切らない）・番地・号 */
const TOWN_CUTS = [/[0-9]/, /字/, new RegExp(`[${KN}]+(?:番地|番(?!町)|号|の|[-ー]|$)`), /番地|号/];
/** 所在を市区町村＋町名まで：都道府県を落とし、「丁目」があればそこまで、無ければ番地・小字の前まで */
export function gsTownOf(address: string | null): string | null {
  if (!address) return null;
  const s = address.normalize("NFKC").replace(/\s+/g, "").replace(PREF_RE, "").replace(/大字/g, "");
  const chome = /^(.*?丁目)/.exec(s);
  if (chome) return cut(chome[1], PLACE_MAX);
  const at = TOWN_CUTS.map((re) => s.search(re)).filter((i) => i >= 0);
  const i = at.length ? Math.min(...at) : -1;
  const head = (i >= 0 ? s.slice(0, i) : s).replace(/[-‐－ーの]+$/, "");
  return Array.from(head).length >= 2 && gsSafeText(head) ? cut(head, PLACE_MAX) : null;
}

/** 物件名から号室を落とした建物名（読み取りの物件名は「マンション名と号室」。R8） */
export function gsBuildingOf(read: GsRead | null): string | null {
  const name = read?.propertyName?.normalize("NFKC").trim();
  if (!name) return null;
  let s = name;
  const room = read?.facts?.roomNo?.normalize("NFKC").trim();
  if (room) s = s.split(room).join("");
  // 号室の番号を抜いたあとに残る「号室」も落とす（「パークハウス天満 1203号室」で roomNo が 1203 のとき）
  s = dropRoomTail(s);
  // 段2b-2（点検 LOW-4）：「N階」も落とす（グループに階を出さない）。「第N」「N番館」は建物名の一部なので残す
  s = s.replace(/\s*[0-9]+\s*階\s*$/, "").trim();
  s = dropRoomTail(s);
  return s && gsSafeText(s) ? cut(s, BUILDING_MAX) : null;
}

/** 末尾の号室（数字＋号室・号・室、または「号室」だけ）を落とす。「第2」のように「第」に続く数字だけのときは残す */
function dropRoomTail(s: string): string {
  const m = /\s*(?:([0-9]+)\s*(号室|号|室)?|号室)\s*$/.exec(s);
  if (!m) return s.trim();
  const before = s.slice(0, m.index).trimEnd();
  if (m[1] && !m[2] && before.endsWith("第")) return s.trim();
  return before.trim();
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

/**
 * 催促はボタンで（2026-11-27）：期日を過ぎたら、下村さんの1対1に［催促する］のカード。
 * 押したときだけグループへ催促（gsReminderMessages）。押さなければグループには何も出さない
 */
export function gsRemindAskCard(o: { tid: string; ver: number; no: number; deadlineLabel: string }): FlexMessage {
  const subj = `受付 ${receiptOf(o.no)}`;
  return {
    type: "flex",
    altText: cut(`事例がまだ届いていません（${subj}）`, ALT_TEXT_MAX),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          text(`事例がまだ届いていません（${subj}）`, { weight: "bold", size: "md" }),
          text(`期日（${o.deadlineLabel}）を過ぎました。山口さんに催促しますか？`),
          text("押すと、依頼のグループで山口さんにメンションして声をかけます。押さなければ何も送りません", { color: "#555555" }),
        ],
      },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: [button("催促する", encodeGsRemind(o.tid, o.ver), subj, true)] },
    },
  };
}

/** リマインド（設計 6.2）：グループに1回だけ（2026-11-27 から、下村さんが［催促する］を押したときだけ） */
export function gsReminderMessages(staffId: string, no: number): unknown[] {
  return [{ type: "textV2", text: `{staff} 受付 ${receiptOf(no)} の事例はいかがでしょうか`, substitution: mention(staffId) }];
}

const FIX_SYSTEM = [
  "あなたは不動産会社の査定の手伝いです。REINS の事例の取り方の案（行の配列）を、担当者の直しの言葉に合わせて書き直します。",
  '答えは JSON だけ：{"lines":["…","…"]}。行は6行まで、1行80字まで。書き方は今の行にそろえる（「成約：」「売出：」で始める行と、「　」で始める条件の行）。',
  "直しの言葉に無いことは変えない。号室・番地・人の名前・REINS の物件番号は書かない。分からないことを作らない。",
  "人の名前（「〇〇さん」「〇〇様」など）は、直しの言葉に出てきても書かない（「田中さんの部屋と同じ階」なら「同じ階」のように言い換える）。",
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

/**
 * 作り直しの答えを読む。行の配列＝使える／{ unsafe: true }＝行はあるが検査に通らない（人の名前・番地など。前の行のまま）／null＝読めない
 */
export function gsParseFixResult(out: { content: Array<{ type: string; text?: string }> }): string[] | { unsafe: true } | null {
  const raw = out.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("");
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  let lines: string[] | null;
  try {
    lines = tidyLines((JSON.parse(m[0]) as { lines?: unknown }).lines);
  } catch {
    return null;
  }
  if (!lines) return null;
  return lines.every(gsSafeText) ? lines : { unsafe: true };
}

/** 作り直しの答えを読む。JSON の lines が検査に通るときだけ */
export function gsParseFix(out: { content: Array<{ type: string; text?: string }> }): string[] | null {
  const r = gsParseFixResult(out);
  return Array.isArray(r) ? r : null;
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
export const msgGsCaseStaffNone = (no: number, plain: string) =>
  `山口さんがこの依頼のグループにいないようです。手で頼んでください（${R(no)}）\n\n${plain}`;
export const msgGsCaseStaffUnknown = (no: number, plain: string) =>
  `山口さんがグループにいるか確かめられませんでした。手で頼んでください（${R(no)}）\n\n${plain}`;
export const msgGsFixAsk = (no: number, left: number) =>
  `直すところを1通で送ってください（喋ったままで大丈夫です）。30分以内・あと${left}回まで（${R(no)}）`;
export const msgGsFixLimit = (no: number) => `直すのは2回までです。山口さんへは手で頼んでください（${R(no)}）`;
export const msgGsFixDone = (no: number, fixes: number) => `直しました（${fixes}回目／2回まで）。これでよければ［いいよ］を押してください（${R(no)}）`;
export const msgGsFixUnsafe = (no: number) =>
  `直した案に人の名前や番地のような言葉が入ったので、使わずに前の案のままにしました。名前を出さない言い方で［直す］をもう一度押すか、山口さんへは手で頼んでください（${R(no)}）`;
export const msgGsFixFailed = (no: number) => `うまく作り直せませんでした。［直す］をもう一度押すか、山口さんへは手で頼んでください（${R(no)}）`;
export const msgGsRemindMe = (no: number, label: string) =>
  `${R(no)} の事例がまだ届いていないので、グループで山口さんに1回だけ声をかけました（期日 ${label}）`;
export const msgGsRemindUnknown = (no: number) =>
  `${R(no)} の事例がまだ届いていないので、グループで山口さんに声をかけましたが、届いたか確かめられませんでした。グループを見て、出ていなければ手で声をかけてください`;
export const msgGsRemindFailed = (no: number) =>
  `${R(no)} の事例がまだ届いていないので、グループで山口さんに声をかけようとしましたが、送れませんでした。手で声をかけてください`;
export const msgGsRemindPressed = (no: number) => `グループで山口さんに声をかけました（${R(no)}）`;
export const msgGsRemindPressUnknown = (no: number) =>
  `グループで山口さんに声をかけましたが、届いたか確かめられませんでした。グループを見て、出ていなければ手で声をかけてください（${R(no)}）`;
export const msgGsRemindPressFailed = (no: number) => `送れませんでした。少し待ってから、もう一度［催促する］を押してください（${R(no)}）`;
export const msgGsRemindPressGaveUp = (no: number) => `何度か送れませんでした。グループで手で声をかけてください（${R(no)}）`;
export const msgGsRemindAlready = (no: number) => `催促はもう送ってあります（${R(no)}）`;
export const msgGsRemindCasesIn = (no: number) => `もう事例の PDF が届いています。催促はしません（${R(no)}）`;
export const msgGsRemindClosed = (no: number) => `この受付はもう事例待ちではありません（${R(no)}）`;
export const msgGsAlreadyRequested = (no: number) => `山口さんへはもう頼んであります（${R(no)}）`;
export const MSG_GS_PROPOSAL_STALE = "新しい案が届いています。そちらから選んでください";

// ─── 段2e（計画 2026-11-26-group-satei-2e）：事例の PDF の保存の知らせ（下村さんへ。グループには出さない） ───
const gsCasesCount = (c: { contract: number; listing: number }) => `成約 ${c.contract}件・売出 ${c.listing}件`;
export const msgGsCasesAmbig = (nos: number[]) =>
  `どの受付のものか決められません（受付 ${[...nos].sort((a, b) => a - b).map(receiptOf).join("・")}）。02 に入れてください`;
export const msgGsCasesStarted = (no: number, c: { contract: number; listing: number }, jobNo: number) =>
  `事例を保存しました（${gsCasesCount(c)}）。下書きを作ります（受付 ${receiptOf(no)}・#J${jobNo}）`;
export const msgGsCasesNoStart = (no: number, c: { contract: number; listing: number }) =>
  `事例を保存しました（${gsCasesCount(c)}）。下書きを始められませんでした。案件カードの［査定書を作る］を押してください（受付 ${receiptOf(no)}）`;
export const msgGsCasesDraftUnknown = (no: number, c: { contract: number; listing: number }) =>
  `事例を保存しました（${gsCasesCount(c)}）。下書きを始められたか確かめられませんでした。しばらくして #J の知らせが来なければ、案件カードの［査定書を作る］を押してください（受付 ${receiptOf(no)}）`;
export const msgGsCasesNoAuto = (no: number, c: { contract: number; listing: number }, kind: "戸建" | "土地") =>
  `事例を保存しました（${gsCasesCount(c)}）。${kind}の下書きは自動で作れません。資料は 01・02 にそろえました（受付 ${receiptOf(no)}）`;
export const msgGsCasesFailed = (no: number) => `事例の PDF を取り出せませんでした。案件フォルダの 02 に入れてください（受付 ${receiptOf(no)}）`;
export const msgGsCasesSomeFailed = (n: number) => `取り出せなかった PDF が ${n}件あります。02 に入れてください`;
export const msgGsCasesUnsaved = (n: number) => `保存していない PDF が ${n}件あります。02 に入れてください`;
export const msgGsCasesSlow = (no: number) =>
  `事例の PDF の保存がまだ終わっていません。Mac の様子を見るか、案件フォルダの 02 に入れてください（受付 ${receiptOf(no)}）`;

/**
 * 案件の自動登録（計画 2026-11-27-group-satei-auto-deal の A6。M1〜M8）。下村さんの1対1だけ。文は一字一句テストで固定。
 * D＝案件番号（DEAL-0231）
 */
const D = (dealNo: number) => `DEAL-${String(dealNo).padStart(4, "0")}`;
const driveUrl = (folderId: string) => `https://drive.google.com/drive/folders/${folderId}`;
/** M1：ぴったり合った（返事の頭。このあとに今の文） */
export const msgGsAutoMatched = (no: number, dealName: string) => `進行中の案件「${dealName}」に合ったので、この案件で進めます（${R(no)}）`;
/** M2：登録した（返事） */
export const msgGsAutoRegistered = (no: number, dealNo: number) =>
  `案件 ${D(dealNo)} として登録しました（${R(no)}）。フォルダを作って、事例の取り方の案を数分でお送りします。顧客と案件ソースは、あとで Notion に入れてください`;
/** M3：決められない（今のカードの文の頭） */
export const msgGsAutoAsk = (no: number) => `合いそうな案件が複数あるので、選んでください（${R(no)}）`;
export const msgGsAutoDup = (no: number) => `同じ物件の進行中の案件が見つかりました。一覧から選んでください（${R(no)}）`;
/** M4：フォルダを作れなかった（push。retry key prepfail:<tid>） */
export const msgGsAutoFolderFailed = (no: number, dealNo: number, config: boolean) =>
  `案件 ${D(dealNo)} は登録しましたが、案件フォルダを作れませんでした（${R(no)}）。フォルダを手で作り、CRM_案件 の Driveフォルダ に入れてください。山口さんへは手で頼んでください` +
  (config ? "（Mac の親フォルダの設定がありません）" : "");
/** M5：Notion に URL を書けなかった（push。retry key auto-link:<tid>） */
export const msgGsAutoLinkFailed = (no: number, dealNo: number, folderId: string) =>
  `案件 ${D(dealNo)} のフォルダは作りましたが、Notion に書けませんでした（${R(no)}）。CRM_案件 の Driveフォルダ に次を入れてください：${driveUrl(folderId)}`;
export const msgGsAutoLinkConflict = (no: number, dealNo: number, folderId: string) =>
  `案件 ${D(dealNo)} のフォルダは作りましたが、Notion に書けませんでした（${R(no)}）。CRM_案件 の Driveフォルダ に別のフォルダが入っています。新しく作ったフォルダは次です：${driveUrl(folderId)}`;
/** M6：案を作れなかった（今の msgGsPrepFailed の頭に） */
export const msgGsAutoPrepFailed = (no: number, dealNo: number) => `案件 ${D(dealNo)} とフォルダは作ってあります。${msgGsPrepFailed(no)}`;
/** M7：登録が途中で止まった（push。retry key auto-fail:<tid>） */
export const msgGsAutoStopped = (no: number, dealNo?: number) =>
  `案件の自動登録が途中で止まりました（${R(no)}）。` +
  (dealNo ? `CRM_案件 ${D(dealNo)} はできています。` : "") +
  "カードの［一覧から選ぶ］で選ぶか、もう一度［査定］を押してください";
/** M8：その場で失敗（返事） */
export const msgGsAutoFailed = (no: number) => `案件を登録できませんでした（${R(no)}）。少し待ってから、もう一度［査定］を押してください`;
export const msgGsAutoIntakeRejected = (no: number, dealNo: number) =>
  `案件 ${D(dealNo)} は登録しましたが、事例の案づくりを受け付けられませんでした（${R(no)}）。山口さんへは手で頼んでください`;
/** portal が止めている・結果不明のとき、今の文の頭に付ける（A7） */
export const msgGsAutoRegisteredHead = (dealNo: number) => `案件 ${D(dealNo)} として登録しました。`;
