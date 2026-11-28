/**
 * 担当に聞く（2026-11-28 下村さん「次は担当に聞くを作って」）。スイッチは STAFF_DIGEST=1（新しい環境変数は無い）。
 *
 * 仕分ける人（inboxOwner）が、自分の 1対1 に出たタスクのカードの［担当に聞く］から、担当へ一言聞く：
 *   ［担当に聞く］(v1|ka|<タスク>) → 小さなカード［進み具合は？］［いつ終わりそう？］(v1|kp|<タスク>|1・2)［自分で書く］(v1|kw|<タスク>)
 *   → グループ（タスクの発生元。無ければ会社のグループ）へ文字だけ1通「@担当 【題名／物件】 下村さんから：… 返信で答えてください」
 *   → 担当がそのメッセージに返信 → Notion に残し、すぐ下村さんの 1対1 へ（取り込みは staff-digest-reply.ts の handleAskAnswer）
 *   → 夕方まで返事が無ければ、その日の［催促する］のカードに載る（staff-digest-reply.ts の askNudge）
 *
 * ここは判断と文だけ（KV・LINE・Notion・名簿は渡してもらう）。本物へのつなぎは staff-ask-wire.ts。
 * off のあいだは KV・LINE・Notion を呼ばない。例外は投げない。ログは符号だけ（題名・本文・ID は出さない）。
 */
import type { Chunk } from "./chunk";
import { sanitizeForTextV2 } from "./line";
import { DIGEST_MSG_TTL_SEC, digestMsgKey, staffDigestOn } from "./staff-digest";
import { askListKey, jstDayOf, type AskRow, type SdKv } from "./staff-digest-reply";
import { ALT_TEXT_MAX, FLEX_LABEL_MAX, POSTBACK_TEXT_MAX, pressedText, type FlexMessage } from "./task-card";

type Env = Record<string, string | undefined>;

// ── ボタンの data ──

const PAGE_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
export type AskAction =
  | { op: "ka"; pageId: string }
  | { op: "kw"; pageId: string }
  | { op: "kp"; pageId: string; preset: 1 | 2 };

export const encodeAsk = (op: "ka" | "kw" | "kp", pageId: string, preset?: 1 | 2) =>
  op === "kp" ? `v1|kp|${pageId}|${preset ?? 1}` : `v1|${op}|${pageId}`;

export function parseAskData(data: string): AskAction | null {
  const p = (data ?? "").split("|");
  if (p[0] !== "v1" || !PAGE_RE.test(p[2] ?? "")) return null;
  if ((p[1] === "ka" || p[1] === "kw") && p.length === 3) return { op: p[1], pageId: p[2] };
  if (p[1] === "kp" && p.length === 4 && (p[3] === "1" || p[3] === "2")) return { op: "kp", pageId: p[2], preset: p[3] === "1" ? 1 : 2 };
  return null;
}

/** タスクのカードに足すボタン（仕分ける人の 1対1 に出すカードだけ） */
export const ASK_BUTTON_LABEL = "担当に聞く";

export const ASK_PRESETS: Record<1 | 2, { label: string; text: string }> = {
  1: { label: "進み具合は？", text: "進み具合はどうですか？" },
  2: { label: "いつ終わりそう？", text: "いつ終わりそうですか？" },
};

// ── KV（鍵は staffask:*） ──

/** ［自分で書く］のあとの1通を待つ印（10分）。値は {taskId, at} */
export const askMarkerKey = (userId: string) => `staffask:${userId}`;
export const ASK_MARKER_TTL_SEC = 10 * 60;
/** 決まった質問の二重送信を防ぐ印（10分）。値は {askId, state: "trying" | "sent"} */
export const askPresetKey = (taskId: string, preset: number) => `staffask:p:${taskId}:${preset}`;
export const ASK_TEXT_MAX = 300;

// ── 文 ──

export const MSG_ASK_PAUSED = "いまは止めています";
export const MSG_ASK_OWNER_ONLY = "このボタンを押せるのは下村さんだけです";
export const MSG_ASK_NOT_FOUND = "タスクが見つかりませんでした";
export const MSG_ASK_CLOSED = "このタスクはもう完了しています";
export const MSG_ASK_PRIVATE = "このタスクはグループに出していないので、担当に聞けません";
export const MSG_ASK_HOW = "どう聞きますか？";
export const MSG_ASK_WRITE = "このあと送った1通を、そのまま担当に伝えます（10分間）。やめるときは「やめる」";
export const MSG_ASK_BUSY = "いまは別の入力を待っています。そちらが終わってから、もう一度押してください";
export const MSG_ASK_CANCELED = "やめました";
export const MSG_ASK_TOO_LONG = "300字までで、もう一度送ってください（やめるときは「やめる」）";
export const MSG_ASK_RECENT = "同じ質問を送ったばかりです（10分あけてください）";
export const MSG_ASK_FAILED = "⚠️ 送れませんでした。もう一度お試しください";
export const MSG_ASK_FAILED_TEXT = "⚠️ 送れませんでした。もう一度送ってください（やめるときは「やめる」）";
export const MSG_ASK_UNKNOWN = "⚠️ 送れたか確かめられませんでした。グループに出ていなければ、もう一度押してください（同じ1通として送り直します）";
export const MSG_ASK_UNKNOWN_TEXT = "⚠️ 送れたか確かめられませんでした。グループに出ていなければ、もう一度送ってください（同じ1通として送り直します。やめるときは「やめる」）";
export const MSG_ASK_ERROR = "⚠️ いま処理できませんでした。少し待ってから、もう一度お試しください";
export const msgAskSent = (assignee: string | null) =>
  assignee ? `${assignee}さんに聞きました` : "グループに聞きました（担当が決まっていません）";

export interface AskTask {
  id: string;
  title: string;
  propertyName: string | null;
  assignee: string | null;
  assigneeUserId: string | null;
  /** 発生元（グループ ID／"LINE WORKS"）。空なら null */
  origin: string | null;
  closed: boolean;
  /** LINE WORKS 発（グループに出していない、本人の仕事） */
  private: boolean;
}

const cut = (s: string, n: number) => {
  const a = Array.from(s);
  return a.length > n ? `${a.slice(0, n - 1).join("")}…` : s;
};
const TITLE_MAX = 60;
const GROUP_RE = /^C[0-9a-f]{32}$/;

/** 「【題名／物件】」（物件は、題名に入っていなければ添える） */
function subjectOf(t: Pick<AskTask, "title" | "propertyName">): string {
  const title = sanitizeForTextV2(cut(t.title.trim() || "（無題）", TITLE_MAX));
  const prop = t.propertyName ? sanitizeForTextV2(cut(t.propertyName.trim(), TITLE_MAX)) : "";
  return `【${title}${prop && !title.includes(prop) ? `／${prop}` : ""}】`;
}

/** グループへ出す1通（文字だけ。担当に userId があればメンション） */
export function buildAskMessage(t: AskTask, ownerName: string | null, question: string): Chunk {
  const subject = subjectOf(t);
  const from = `${ownerName ? `${sanitizeForTextV2(ownerName)}さん` : "下村さん"}から：${sanitizeForTextV2(question)}`;
  if (t.assigneeUserId) {
    return { text: [`{m1} ${subject}`, from, "このメッセージに返信（リプライ）で答えてください"].join("\n"), mentions: { m1: t.assigneeUserId } };
  }
  if (t.assignee) {
    return { text: [`${sanitizeForTextV2(t.assignee)}さん ${subject}`, from, "このメッセージに返信（リプライ）で答えてください"].join("\n"), mentions: {} };
  }
  return { text: [subject, from, "担当が決まっていません。どなたが進めるか、このメッセージに返信で教えてください"].join("\n"), mentions: {} };
}

const flexText = (t: string, o: Record<string, unknown> = {}) => ({ type: "text", text: t, size: "sm", color: "#333333", wrap: true, ...o });
const flexRow = (name: string, value: string) => ({
  type: "box",
  layout: "baseline",
  spacing: "sm",
  contents: [
    { type: "text", text: name, size: "sm", color: "#888888", flex: 2 },
    { type: "text", text: value, size: "sm", color: "#333333", flex: 6, wrap: true },
  ],
});
const flexButton = (label: string, data: string, subject: string, primary = false) => ({
  type: "button",
  style: primary ? "primary" : "secondary",
  height: "sm",
  action: { type: "postback", label: cut(label, FLEX_LABEL_MAX), data, displayText: cut(pressedText(label, subject), POSTBACK_TEXT_MAX) },
});

/** ［担当に聞く］を押したあとの小さなカード（1対1 の返事） */
export function askCard(t: AskTask): FlexMessage {
  const title = t.title.trim() || "（無題）";
  return {
    type: "flex",
    altText: cut(`【担当に聞く】${title}`, ALT_TEXT_MAX),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          flexText("担当に聞く", { size: "xs", color: "#888888" }),
          flexText(cut(title, 40), { weight: "bold", size: "md", margin: "sm" }),
          {
            type: "box",
            layout: "vertical",
            margin: "md",
            spacing: "sm",
            contents: [
              ...(t.propertyName?.trim() ? [flexRow("物件", cut(t.propertyName.trim(), TITLE_MAX))] : []),
              flexRow("担当", t.assignee?.trim() || "未定"),
            ],
          },
          flexText("押すと、グループで担当にメンションして聞きます", { color: "#555555", margin: "md" }),
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          flexButton(ASK_PRESETS[1].label, encodeAsk("kp", t.id, 1), title, true),
          flexButton(ASK_PRESETS[2].label, encodeAsk("kp", t.id, 2), title),
          flexButton("自分で書く", encodeAsk("kw", t.id), title),
        ],
      },
    },
  };
}

// ── 処理 ──

export interface AskDeps {
  env?: Env;
  now(): number;
  kv: Pick<SdKv, "get" | "set" | "setNx" | "del" | "rpush">;
  /** 仕分ける人（名簿で同じ人の別アカウントも）か */
  isOwner(userId: string | null | undefined): Promise<boolean>;
  /** タスクを読む。見つからなければ null */
  getTask(pageId: string): Promise<AskTask | null>;
  /** 仕分ける人の名簿の名前。分からなければ null（文は「下村さん」） */
  ownerName(): Promise<string | null>;
  /** ほかの「次の1通を待つ印」（査定の差し戻し理由・直す・足りない項目）がその人に立っているか */
  otherMarker(userId: string): Promise<boolean>;
  /** 会社のグループ（発生元が無いタスクの送り先） */
  mainGroup: string | null;
  /** グループへ retry key つきで1通（時間の上限つき）。HTTP の状態（結果不明は null）と送れたメッセージの ID */
  pushGroup(to: string, chunk: Chunk, key: string): Promise<{ status: number | null; ids: string[] }>;
  /** Notion に質問を残す（失敗しても送信は成功のまま） */
  appendNote(pageId: string, lines: string[]): Promise<void>;
  reply(text: string, card?: FlexMessage): Promise<void>;
  log(line: string): void;
}

const sentOk = (status: number | null) => status !== null && ((status >= 200 && status < 300) || status === 409);
const mdOf = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

/** グループへ聞く（1通）。sent・failed（はっきり断られた）・unknown（結果が分からない） */
async function sendAsk(t: AskTask, question: string, askId: string, deps: AskDeps): Promise<"sent" | "failed" | "unknown"> {
  const to = t.origin && GROUP_RE.test(t.origin) ? t.origin : deps.mainGroup;
  if (!to) return "failed";
  const ownerName = await deps.ownerName().catch(() => null);
  const r = await deps
    .pushGroup(to, buildAskMessage(t, ownerName, question), `sd-ask:${askId}`)
    .catch(() => ({ status: null as number | null, ids: [] as string[] }));
  if (!sentOk(r.status)) return r.status !== null && r.status >= 400 && r.status < 500 ? "failed" : "unknown";
  const now = deps.now();
  // 返信の照合用の控え・催促用の控え・Notion の記録は、失敗しても「聞きました」のまま（届いている）
  for (const id of r.ids) {
    await deps.kv
      .set(digestMsgKey(id), { at: now, slot: "ask", taskId: t.id, title: t.title, uid: t.assigneeUserId, askId }, DIGEST_MSG_TTL_SEC)
      .catch(() => deps.log("[staff-ask] msg-save-failed"));
  }
  const row: AskRow = { askId, taskId: t.id, title: t.title, assignee: t.assignee, assigneeUserId: t.assigneeUserId, at: now };
  await deps.kv.rpush(askListKey(jstDayOf(now)), [row]).catch(() => deps.log("[staff-ask] list-save-failed"));
  await deps
    .appendNote(t.id, [`質問（${mdOf(jstDayOf(now))} ${ownerName || "下村"}）：${question}`])
    .catch(() => deps.log("[staff-ask] note-failed"));
  return "sent";
}

/** タスクを読んで、聞いてよいか確かめる。だめなら返事の文と符号 */
async function loadForAsk(pageId: string, deps: AskDeps): Promise<{ task: AskTask } | { text: string; code: string }> {
  const t = await deps.getTask(pageId);
  if (!t) return { text: MSG_ASK_NOT_FOUND, code: "not-found" };
  if (t.closed) return { text: MSG_ASK_CLOSED, code: "closed" };
  if (t.private) return { text: MSG_ASK_PRIVATE, code: "private" };
  return { task: t };
}

/** ボタン（v1|ka|・v1|kp|・v1|kw|）。押せるのは仕分ける人だけ。返事は reply で。例外は投げない */
export async function handleAskPostback(a: AskAction, src: { userId?: string | null; webhookEventId?: string | null }, deps: AskDeps): Promise<void> {
  const say = (text: string, code: string, card?: FlexMessage) => {
    deps.log(`[staff-ask] ${a.op} ${code}`);
    return deps.reply(text, card).catch(() => deps.log(`[staff-ask] reply-failed ${a.op}`));
  };
  if (!staffDigestOn(deps.env ?? process.env)) return say(MSG_ASK_PAUSED, "paused");
  try {
    if (!src.userId || !(await deps.isOwner(src.userId))) return say(MSG_ASK_OWNER_ONLY, "denied");
    const got = await loadForAsk(a.pageId, deps);
    if (!("task" in got)) return say(got.text, got.code);
    const t = got.task;
    if (a.op === "ka") return say(MSG_ASK_HOW, "shown", askCard(t));
    if (a.op === "kw") {
      if (await deps.otherMarker(src.userId)) return say(MSG_ASK_BUSY, "busy");
      // 押し直したら、新しいほうのタスクに付け替える
      await deps.kv.set(askMarkerKey(src.userId), { taskId: t.id, at: deps.now() }, ASK_MARKER_TTL_SEC);
      return say(MSG_ASK_WRITE, "waiting");
    }
    // 決まった質問：10分のあいだ同じ質問を重ねない。結果が分からなかった回の押し直しは、同じ retry key で送り直す
    const key = askPresetKey(t.id, a.preset);
    let askId = `${t.id}:p${a.preset}:${src.webhookEventId || deps.now()}`;
    if (!(await deps.kv.setNx(key, { askId, state: "trying" }, ASK_MARKER_TTL_SEC))) {
      const g = (await deps.kv.get(key)) as { askId?: unknown; state?: unknown } | null;
      if (g?.state === "sent") return say(MSG_ASK_RECENT, "recent");
      if (typeof g?.askId === "string" && g.askId) askId = g.askId;
    }
    const r = await sendAsk(t, ASK_PRESETS[a.preset].text, askId, deps);
    if (r === "sent") {
      await deps.kv.set(key, { askId, state: "sent" }, ASK_MARKER_TTL_SEC).catch(() => undefined);
      return say(msgAskSent(t.assignee), "sent");
    }
    if (r === "failed") {
      await deps.kv.del(key).catch(() => undefined);
      return say(MSG_ASK_FAILED, "push-failed");
    }
    return say(MSG_ASK_UNKNOWN, "unknown");
  } catch {
    return say(MSG_ASK_ERROR, "error");
  }
}

/**
 * ［自分で書く］のあとの 1対1 の1通。印（staffask:<userId>）があるときだけ true を返して扱う（無ければ false＝今までの流れへ）。
 * off・グループの発言は KV も読まない。「やめる」で取りやめ。300字まで。
 * 送れたら印を消す。送れなかった・結果が分からないときは印を残す（同じ retry key で送り直せる）。
 */
export async function handleAskText(
  input: { userId?: string | null; groupId?: string | null; text: string },
  deps: AskDeps
): Promise<boolean> {
  if (!staffDigestOn(deps.env ?? process.env) || input.groupId || !input.userId) return false;
  let marker: { taskId?: unknown; at?: unknown } | null;
  try {
    marker = (await deps.kv.get(askMarkerKey(input.userId))) as { taskId?: unknown; at?: unknown } | null;
  } catch {
    return false;
  }
  if (!marker || typeof marker.taskId !== "string" || !marker.taskId) return false;
  const say = (text: string, code: string) => {
    deps.log(`[staff-ask] text ${code}`);
    return deps.reply(text).catch(() => deps.log("[staff-ask] reply-failed text"));
  };
  const key = askMarkerKey(input.userId);
  try {
    const text = input.text.replace(/\s+/g, " ").trim();
    if (/^(やめる|やめます|キャンセル|中止)[。.!！]*$/.test(text)) {
      await deps.kv.del(key);
      await say(MSG_ASK_CANCELED, "canceled");
      return true;
    }
    if (!text || Array.from(text).length > ASK_TEXT_MAX) {
      await say(MSG_ASK_TOO_LONG, "too-long");
      return true;
    }
    const got = await loadForAsk(marker.taskId, deps);
    if (!("task" in got)) {
      await deps.kv.del(key).catch(() => undefined);
      await say(got.text, got.code);
      return true;
    }
    const at = typeof marker.at === "number" ? marker.at : 0;
    const r = await sendAsk(got.task, text, `${got.task.id}:w:${at}`, deps);
    if (r === "sent") {
      await deps.kv.del(key).catch(() => undefined);
      await say(msgAskSent(got.task.assignee), "sent");
    } else {
      await say(r === "failed" ? MSG_ASK_FAILED_TEXT : MSG_ASK_UNKNOWN_TEXT, r === "failed" ? "push-failed" : "unknown");
    }
    return true;
  } catch {
    await say(MSG_ASK_ERROR, "error");
    return true;
  }
}
