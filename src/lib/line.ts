import crypto from "crypto";
import type { ParsedTask } from "./claude";
import { timingSafeEqualStr } from "./secure-compare";
import type { FlexMessage } from "./task-card";

const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET!;

// LINE署名検証
export function verifyLineSignature(
  body: string,
  signature: string
): boolean {
  const hash = crypto
    .createHmac("sha256", CHANNEL_SECRET)
    .update(body)
    .digest("base64");
  // 時間差で中身が漏れないように比べる（長さが違えば false）
  return timingSafeEqualStr(hash, signature);
}

// LINEメッセージ送信。送ったメッセージのID（引用リプライの照合に使う）を返す。
// card（タスクのカード。task-card.ts）を渡すと、text を1通目のまま、カードを2通目に足す
// （Reply API は1回で最大5通）。返す ID は今までどおり sentMessages[0]＝1通目（text）。
// card を渡さなければ、送る中身は今までと同じ1通。
export async function sendLineMessage(
  replyToken: string,
  text: string,
  card?: FlexMessage
): Promise<string | null> {
  return (await replyTextAndCard(replyToken, text, card)).textId;
}

// sendLineMessage と同じ送り方で、2通目（カード）の ID も返す。
// sentMessages は送った順に並ぶ（公式：https://developers.line.biz/en/docs/messaging-api/get-quote-tokens/）。
// カードを引用した回答を初動確認に結び付けるのに使う（route.ts の受付の返事）。
export async function replyTextAndCard(
  replyToken: string,
  text: string,
  card?: FlexMessage
): Promise<{ textId: string | null; cardId: string | null }> {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: card ? [{ type: "text", text }, card] : [{ type: "text", text }],
    }),
  });
  if (!res.ok) return { textId: null, cardId: null };
  const data = (await res.json()) as {
    sentMessages?: Array<{ id: string }>;
  };
  return {
    textId: data.sentMessages?.[0]?.id ?? null,
    cardId: card ? (data.sentMessages?.[1]?.id ?? null) : null,
  };
}

// グループメンバーの表示名を取得
export async function getGroupMemberName(
  groupId: string,
  userId: string
): Promise<string | null> {
  const res = await fetch(
    `https://api.line.me/v2/bot/group/${groupId}/member/${userId}`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return (data.displayName as string) ?? null;
}

// Push通知（replyTokenなし）
// 送信できたかを返す。呼び出し側が失敗を検知できないと
// 「送ったつもりで誰にも届いていない」が起きる。
export async function pushLineMessage(
  to: string,
  text: string
): Promise<boolean> {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text }],
    }),
  });
  if (!res.ok) {
    console.error("LINE push失敗:", res.status, await res.text());
    return false;
  }
  return true;
}

// 文字とカードを1回の push で（2通・1リクエスト。B1 の 17 時の候補）。card が無ければ pushLineMessage と同じ。
// pushLineMessage は変えていない（呼んでいる所の送る中身を1バイトも変えないため）。
export async function pushTextAndCard(
  to: string,
  text: string,
  card?: FlexMessage
): Promise<boolean> {
  if (!card) return pushLineMessage(to, text);
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text }, card],
    }),
  });
  if (!res.ok) {
    // 本文・宛先は出さない（状態の番号だけ）
    console.error("LINE push失敗:", res.status);
    return false;
  }
  return true;
}

// カード（Flex）だけを push で1通（朝のリマインドのカード・2026-11-10）。本文・宛先はログに出さない。
export async function pushCard(to: string, card: FlexMessage): Promise<boolean> {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [card] }),
  });
  if (!res.ok) {
    console.error("LINE push失敗:", res.status);
    return false;
  }
  return true;
}

// LINEメンション付きPush送信（textV2形式）。
// 通常の text メッセージに mention を付けても送信時は無視される（受信専用の仕様）ため、
// 本物のメンション（相手に通知が飛び、青くハイライトされる）には textV2 の
// substitution 置換を使う。text 中の {key} が substitution のメンションに置換される。
// 注意: userId がそのグループのメンバーでないとメンションにならない。
export async function pushLineMessageWithMentions(
  to: string,
  text: string,
  mentions: Record<string, string> // key（textの{key}） -> LINE userId
): Promise<boolean> {
  const keys = Object.keys(mentions);
  const message: Record<string, unknown> =
    keys.length === 0
      ? { type: "text", text }
      : {
          type: "textV2",
          text,
          substitution: Object.fromEntries(
            keys.map((k) => [
              k,
              {
                type: "mention",
                mentionee: { type: "user", userId: mentions[k] },
              },
            ])
          ),
        };
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [message] }),
  });
  if (!res.ok) {
    console.error("LINE push失敗:", res.status, await res.text());
    return false;
  }
  return true;
}

// textV2では { } が置換記法として解釈されるため、本文に含めない
export function sanitizeForTextV2(s: string): string {
  return s.replace(/\{/g, "（").replace(/\}/g, "）");
}

// タスク登録完了メッセージ生成
export function buildTaskRegisteredMessage(task: ParsedTask): string {
  // 期日は「いつ・何時まで」と「なぜその日か」をセットで出す。
  // 根拠を出さないと、自動で決まった期日が納得できず結局Notionを見に行くことになる。
  const dueLine = task.dueDate
    ? `📅 期日：${formatDate(task.dueDate)}${task.dueTime ? ` ${task.dueTime}` : ""}`
    : null;
  const reasonLine = task.dueDate && task.dueReason ? `　└ ${task.dueReason}` : null;
  const assigneeLine = task.assignee
    ? `👤 担当：${task.assignee}`
    : null;
  const assignmentReasonLine = task.assignmentReason
    ? `　└ ${task.assignmentReason}`
    : null;

  const lines = [
    "✅ タスク登録しました",
    "",
    `📋 ${task.title}`,
    `🏷 種別：${task.category}`,
    `🔥 緊急度：${task.urgency}`,
    dueLine,
    reasonLine,
    assigneeLine,
    assignmentReasonLine,
  ].filter(Boolean);

  return lines.join("\n");
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function formatDate(isoDate: string): string {
  // "YYYY-MM-DD" は UTC 解釈されるため、曜日がずれないよう JST 正午として扱う
  const d = new Date(`${isoDate.slice(0, 10)}T12:00:00+09:00`);
  return `${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAYS[d.getDay()]})`;
}

// 分割した本文を順に送る。
// 1リクエストにまとめず1通ずつ送るのは、途中で失敗しても
// そこまでは届く（全部落ちない）ようにするため。
export async function pushLineChunks(
  to: string,
  chunks: Array<{ text: string; mentions: Record<string, string> }>
): Promise<void> {
  for (const c of chunks) {
    await pushLineMessageWithMentions(to, c.text, c.mentions);
  }
}


// ── 返事の結果を3つに分けて返す（設計 2026-10-09 の 14） ──
//
// sendLineMessage は「送れた／送れなかった」しか返さず、通信の失敗では例外を投げる。
// 帯替えの受付の返事は、LINE が 400 番台で断った（期限切れ・使用済みの replyToken）ときだけ
// push で送り直し、通信の失敗など結果が分からないときは送り直さない（二重の返事を避ける）。
// 既存の呼び出し元は sendLineMessage のまま（動きを変えない）。
export type ReplyOutcome =
  | { kind: "sent"; messageId: string | null }
  | { kind: "rejected"; status: number }
  | { kind: "unknown" };

const REPLY_TIMEOUT_MS = 8_000;

export async function replyLineMessageDetailed(
  replyToken: string,
  text: string,
  timeoutMs: number = REPLY_TIMEOUT_MS
): Promise<ReplyOutcome> {
  let res: Response;
  try {
    res = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    // 届いたかどうか分からない（時間切れ・通信の切断）
    console.error("LINE reply の結果が分からない:", (err as { name?: string })?.name ?? err);
    return { kind: "unknown" };
  }
  if (res.status >= 400 && res.status < 500) {
    console.error("LINE reply を断られた:", res.status);
    return { kind: "rejected", status: res.status };
  }
  if (!res.ok) {
    console.error("LINE reply の結果が分からない（5xx）:", res.status);
    return { kind: "unknown" };
  }
  try {
    const data = (await res.json()) as { sentMessages?: Array<{ id: string }> };
    return { kind: "sent", messageId: data.sentMessages?.[0]?.id ?? null };
  } catch {
    return { kind: "sent", messageId: null };
  }
}

const PUSH_TIMEOUT_MS = 5_000;

/**
 * 時間の上限つきの push（帯替えの返事の送り直し用）。送れたら true。
 * 時間切れ・通信の失敗・断られたときは false（例外は投げない。投げると呼び出し側が
 * 「途中で止まった」として再送を待ち、二重の push になりうる）。
 * 既存の pushLineMessage は時間の上限なしのまま（呼び出し元の動きを変えない）。
 */
export async function pushLineMessageDetailed(
  to: string,
  text: string,
  timeoutMs: number = PUSH_TIMEOUT_MS
): Promise<boolean> {
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("LINE push を断られた:", res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error("LINE push の結果が分からない:", (err as { name?: string })?.name ?? err);
    return false;
  }
}

/**
 * 時間の上限つきの push で、送ったメッセージの ID も返す（「番号で直す」の聞き返しが push に
 * 回ったとき、その ID を控えて、引用の返事の相手を引けるようにする。設計 2026-10-10）。
 * 送れたら ok: true（応答の ID が読めなければ messageId は null。送信そのものは成功のまま）。
 * 時間切れ・通信の失敗・断られたときは ok: false（例外は投げない）。
 * rejected: true は「はっきり断られた（4xx）＝届いていないことが確か」のときだけ付ける
 * （時間切れ・通信の失敗・5xx は、届いたかどうか分からないので付けない）。
 * 既存の pushLineMessageDetailed は変えない（帯替えの受付の返事が使っている）。
 */
export async function pushLineMessageWithId(
  to: string,
  text: string,
  timeoutMs: number = PUSH_TIMEOUT_MS
): Promise<{ ok: boolean; messageId: string | null; rejected?: boolean }> {
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("LINE push を断られた:", res.status);
      return res.status >= 400 && res.status < 500
        ? { ok: false, messageId: null, rejected: true }
        : { ok: false, messageId: null };
    }
    try {
      const data = (await res.json()) as { sentMessages?: Array<{ id?: unknown }> };
      const id = data.sentMessages?.[0]?.id;
      return { ok: true, messageId: typeof id === "string" && id ? id : null };
    } catch {
      return { ok: true, messageId: null };
    }
  } catch (err) {
    console.error("LINE push の結果が分からない:", (err as { name?: string })?.name ?? err);
    return { ok: false, messageId: null };
  }
}

export type ReplyDelivery = "replied" | "pushed" | "push-failed" | "unknown";

/**
 * reply → （はっきり断られたときだけ）push の順で1回だけ送る。
 * io の関数が投げた例外は外へそのまま出す（呼び出し側が「途中で止まった」を扱えるように）。
 */
export async function deliverReply(
  text: string,
  io: {
    reply: (text: string) => Promise<ReplyOutcome>;
    push: (text: string) => Promise<boolean>;
  }
): Promise<ReplyDelivery> {
  const r = await io.reply(text);
  if (r.kind === "sent") return "replied";
  if (r.kind === "unknown") return "unknown"; // 送り直さない（二重の返事を避ける）
  const pushed = await io.push(text);
  if (!pushed) console.error("reply を断られ、push でも送れなかった");
  return pushed ? "pushed" : "push-failed";
}

/**
 * 個人あての push（B2 査定書の通知・2026-11-11）。X-Line-Retry-Key（UUID）を付けるので、同じキーで送り直しても
 * LINE は2通目を届けず 409 を返す。返すのは HTTP の状態番号（時間切れ・通信の失敗は null。例外は投げない）。
 * 本文・宛先はログに出さない。既存の push 関数は変えていない。
 */
export async function pushMessagesWithRetryKey(
  to: string,
  messages: unknown[],
  retryKey: string,
  timeoutMs: number = PUSH_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch
): Promise<number | null> {
  try {
    const res = await fetchImpl("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "X-Line-Retry-Key": retryKey,
      },
      body: JSON.stringify({ to, messages }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!res.ok && res.status !== 409) console.error("LINE push（retry key つき）を断られた:", res.status);
    return res.status;
  } catch (err) {
    console.error("LINE push（retry key つき）の結果が分からない:", (err as { name?: string })?.name ?? "Error");
    return null;
  }
}
