/**
 * タスクのカード（LINE の Flex Message・bubble）を組み立てる。どのボタンを並べるかは task-buttons.ts が決める。
 * ここは見た目だけ：1行目にタスク名、その下に「期日」「担当」（分からなければ「未定」）、下にボタン。
 *
 * ── 公式の記述（2026-11-08 に読んで確かめた）──
 * - Flex Message は全バージョンの LINE で使える。PC 版（macOS・Windows）も一部の新しい機能
 *   （deca/hecto・scaling 等。ここでは使わない）を除いて対応：
 *   https://developers.line.biz/ja/docs/messaging-api/using-flex-messages/ （「動作環境」）
 *   https://developers.line.biz/en/reference/messaging-api/#flex-message （"Flex Messages are supported in all LINE versions."）
 * - クイックリプライは iOS 版・Android 版だけ（PC 版では出ない）：
 *   https://developers.line.biz/ja/docs/messaging-api/using-quick-reply/ （「注意」）
 * - ボタン（button コンポーネント）には action（ポストバックアクションを含むアクションオブジェクト）を付けられる。
 *   ボタンのラベルは Flex Message の button なら最大 40 字（クイックリプライは 20 字）。
 *   data・displayText は最大 300 字。altText は最大 1500 字。bubble の JSON は 30KB まで：
 *   https://developers.line.biz/en/reference/messaging-api/#postback-action （Specifications of the label）
 *   https://developers.line.biz/en/reference/messaging-api/#bubble
 * - Reply API は 1 回で最大 5 通（messages Max: 5）：
 *   https://developers.line.biz/en/reference/messaging-api/#send-reply-message
 *   応答の sentMessages は送った順に並ぶ（公式で保証）。sentMessages[0]＝1通目（text）、[1]＝カード：
 *   https://developers.line.biz/en/docs/messaging-api/get-quote-tokens/
 * - 未確認：PC 版でカードのボタン（postback）を押したときに webhook が届くこと（公式に PC だけの
 *   制限の記述は無いが、明記も無い）。実機で確かめる。
 */

export const FLEX_LABEL_MAX = 40;
export const POSTBACK_TEXT_MAX = 300;
/** 下村さんの指定：altText は 400 字以内（公式の上限 1500 字より短く） */
export const ALT_TEXT_MAX = 400;
/** カードの1行目に出すタスク名の長さ（長ければ切って「…」） */
export const CARD_TITLE_MAX = 40;
export const UNKNOWN = "未定";

export interface CardPostback {
  type: "postback";
  label: string;
  data: string;
  displayText: string;
}

export interface CardButton {
  label: string;
  data: string;
  displayText: string;
  /** 目立たせるボタン（済） */
  primary?: boolean;
}

/** カードに出すタスクの情報。期日は Notion の date.start の形（"YYYY-MM-DD" か日時）。 */
export interface CardInfo {
  pageId: string;
  title: string;
  due: string | null;
  assignee: string | null;
}

export interface FlexMessage {
  type: "flex";
  altText: string;
  contents: Record<string, unknown>;
}

const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");
const cutEllipsis = (s: string, n: number) =>
  Array.from(s).length > n ? `${cut(s, n - 1)}…` : s;

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** "2026-11-20" → "11月20日(金)"、"2026-11-20T17:00:00+09:00" → "11月20日(金) 17:00"。読めなければ null。 */
export function formatDue(due: string | null | undefined): string | null {
  if (!due) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(due);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return null;
  // 曜日は JST 正午で数える（UTC の日付ずれを避ける）
  const dow = WEEKDAYS[new Date(d.getTime() + 9 * 3600_000).getUTCDay()];
  const date = `${Number(m[2])}月${Number(m[3])}日(${dow})`;
  return m[4] ? `${date} ${m[4]}:${m[5]}` : date;
}

/** 受付の解析結果（ParsedTask）の期日を、Notion に書くのと同じ形にする */
export function dueFromParsed(p: {
  dueDate: string | null;
  dueTime: string | null;
}): string | null {
  if (!p.dueDate) return null;
  return p.dueTime ? `${p.dueDate}T${p.dueTime}:00+09:00` : p.dueDate;
}

function row(name: string, value: string) {
  return {
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      { type: "text", text: name, size: "sm", color: "#888888", flex: 2 },
      {
        type: "text",
        text: value,
        size: "sm",
        color: "#333333",
        flex: 6,
        wrap: true,
      },
    ],
  };
}

export function cardButton(
  label: string,
  data: string,
  displayText: string,
  primary = false,
): CardButton {
  return { label, data, displayText, ...(primary ? { primary } : {}) };
}

/**
 * カードを組み立てる。prompt があれば情報の下に1行足す（「いつに延期しますか？」など）。
 * ボタンが無ければ footer を付けない。
 */
export function buildTaskCard(
  info: CardInfo,
  buttons: CardButton[],
  prompt?: string,
): FlexMessage {
  const title = info.title.trim() || "（無題）";
  const body: unknown[] = [
    {
      type: "text",
      text: cutEllipsis(title, CARD_TITLE_MAX),
      weight: "bold",
      size: "md",
      wrap: true,
    },
    {
      type: "box",
      layout: "vertical",
      margin: "md",
      spacing: "sm",
      contents: [
        row("期日", formatDue(info.due) ?? UNKNOWN),
        row("担当", info.assignee?.trim() || UNKNOWN),
      ],
    },
  ];
  if (prompt) {
    body.push({
      type: "text",
      text: prompt,
      size: "sm",
      margin: "md",
      wrap: true,
    });
  }
  const contents: Record<string, unknown> = {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: body },
  };
  if (buttons.length > 0) {
    contents.footer = {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: buttons.map((b) => ({
        type: "button",
        style: b.primary ? "primary" : "secondary",
        height: "sm",
        action: {
          type: "postback",
          label: cut(b.label, FLEX_LABEL_MAX),
          data: b.data,
          displayText: cut(b.displayText, POSTBACK_TEXT_MAX),
        } satisfies CardPostback,
      })),
    };
  }
  return {
    type: "flex",
    altText: cut(`【タスク】${title}`, ALT_TEXT_MAX),
    contents,
  };
}

/** カードの中のボタン（テスト・確認用） */
export function cardActions(card: FlexMessage): CardPostback[] {
  const footer = card.contents.footer as
    { contents?: Array<{ action?: CardPostback }> } | undefined;
  return (footer?.contents ?? [])
    .map((c) => c.action)
    .filter((a): a is CardPostback => Boolean(a));
}
