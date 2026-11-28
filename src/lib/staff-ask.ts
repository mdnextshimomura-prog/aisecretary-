/**
 * 担当に聞く（2026-11-28 下村さん「次は担当に聞くを作って」）。スイッチは STAFF_DIGEST=1（新しい環境変数は無い）。
 *
 * 仕分ける人（inboxOwner）が、自分の 1対1 に出たタスクのカードの［担当に聞く］から、担当へ一言聞く：
 *   ［担当に聞く］(v1|ka|<タスク>) → 小さなカード［進み具合は？］［いつ終わりそう？］(v1|kp|<タスク>|1・2)［自分で書く］(v1|kw|<タスク>)
 *   ［自分で書く］は、次の 1対1 の1通を控えるだけで送らない。「この内容で送りますか？」のカード
 *   ［送る］(v1|ks|<合言葉>)［書き直す］(v1|kr|…)［やめる］(v1|kx|…) を返し、［送る］を押したときだけグループへ出す
 *   （10分のあいだ 1対1 の発言がそのままグループへ出てしまうのを防ぐ。2026-11-28 の点検）
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
import { askListKey, bounded, jstDayOf, type AskRow, type SdKv } from "./staff-digest-reply";
import { ALT_TEXT_MAX, FLEX_LABEL_MAX, POSTBACK_TEXT_MAX, pressedText, type FlexMessage } from "./task-card";

type Env = Record<string, string | undefined>;

// ── ボタンの data ──

const PAGE_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{16}$/;
export type AskAction =
  | { op: "ka"; pageId: string }
  | { op: "kw"; pageId: string }
  | { op: "kp"; pageId: string; preset: 1 | 2 }
  /** 自分で書いた1通の確認のカード：送る・書き直す・やめる（token＝そのとき控えた文の合言葉） */
  | { op: "ks" | "kr" | "kx"; token: string };

export const encodeAsk = (op: "ka" | "kw" | "kp", pageId: string, preset?: 1 | 2) =>
  op === "kp" ? `v1|kp|${pageId}|${preset ?? 1}` : `v1|${op}|${pageId}`;
export const encodeAskConfirm = (op: "ks" | "kr" | "kx", token: string) => `v1|${op}|${token}`;

export function parseAskData(data: string): AskAction | null {
  const p = (data ?? "").split("|");
  if (p[0] !== "v1") return null;
  if ((p[1] === "ks" || p[1] === "kr" || p[1] === "kx") && p.length === 3 && TOKEN_RE.test(p[2])) return { op: p[1], token: p[2] };
  if (!PAGE_RE.test(p[2] ?? "")) return null;
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
/** 自分で書いた1通の、送る前の控え（10分。SET EX の1回で書く）。値は {token, taskId, text, at} */
export const askPendingKey = (userId: string) => `staffask:c:${userId}`;
/** Notion の「質問」と、その日の聞いた件の控えを、1回の質問につき1回だけ書くための印（10分） */
export const askWrittenKey = (askId: string) => `staffask:w:${askId}`;
export const ASK_TEXT_MAX = 300;

// ── 文 ──

export const MSG_ASK_PAUSED = "いまは止めています";
export const MSG_ASK_OWNER_ONLY = "このボタンを押せるのは下村さんだけです";
export const MSG_ASK_NOT_FOUND = "タスクが見つかりませんでした";
export const MSG_ASK_CLOSED = "このタスクはもう完了しています";
export const MSG_ASK_PRIVATE = "このタスクはグループに出していないので、担当に聞けません";
export const MSG_ASK_HOW = "どう聞きますか？";
export const MSG_ASK_WRITE = "このあと送った1通を、担当への質問として受け取ります（10分間。送る前に確認のカードを出します）。やめるときは「やめる」";
export const MSG_ASK_CONFIRM = "この内容で担当に聞きますか？［送る］を押すまで、グループには出しません";
export const MSG_ASK_STALE = "このカードは古くなったか、もう送ってあります";
export const MSG_ASK_BUSY = "いまは別の入力を待っています。そちらが終わってから、もう一度押してください";
export const MSG_ASK_CANCELED = "やめました";
export const MSG_ASK_TOO_LONG = "300字までで、もう一度送ってください（やめるときは「やめる」）";
export const MSG_ASK_RECENT = "同じ質問を送ったばかりです（10分あけてください）";
export const MSG_ASK_FAILED = "⚠️ 送れませんでした。もう一度お試しください";
export const MSG_ASK_FAILED_CONFIRM = "⚠️ 送れませんでした。もう一度［送る］を押してください";
export const MSG_ASK_UNKNOWN = "⚠️ 送れたか確かめられませんでした。グループに出ていなければ、もう一度押してください（同じ1通として送り直します）";
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

/** 自分で書いた1通の確認のカード（グループに出る中身をそのまま見せる） */
export function askConfirmCard(t: AskTask, question: string, token: string): FlexMessage {
  const title = t.title.trim() || "（無題）";
  return {
    type: "flex",
    altText: cut(`【担当に聞く・確認】${title}`, ALT_TEXT_MAX),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          flexText("担当に聞く（確認）", { size: "xs", color: "#888888" }),
          flexText(cut(title, 40), { weight: "bold", size: "md", margin: "sm" }),
          {
            type: "box",
            layout: "vertical",
            margin: "md",
            spacing: "sm",
            contents: [
              ...(t.propertyName?.trim() ? [flexRow("物件", cut(t.propertyName.trim(), TITLE_MAX))] : []),
              flexRow("担当", t.assignee?.trim() || "未定"),
              flexRow("質問", question),
            ],
          },
          flexText("［送る］を押すと、グループで担当にメンションして聞きます", { color: "#555555", margin: "md" }),
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          flexButton("送る", encodeAskConfirm("ks", token), title, true),
          flexButton("書き直す", encodeAskConfirm("kr", token), title),
          flexButton("やめる", encodeAskConfirm("kx", token), title),
        ],
      },
    },
  };
}

const CANCEL_RE = /^(やめる|やめます|中止)[。.!！]*$/;
const COMMAND_WORD_RE = /^(送信|送って|送ってください|キャンセル|メニュー|候補|案件|案件一覧)[。.!！]*$/;
const NUM_COMMAND_RE = /^\d{1,2}(?:[\s,、，・]+\d{1,2})*\s*(済|完了|終わ|おわ|終了|done|待ち|まち|延期|不要|いらない|登録|なし)/i;
/**
 * ほかの機能への指示に見える1通か（質問として控えない＝今までの流れに任せる。印は残す）：
 * # で始まる（#新規・#J12）・番号の言葉（「3済」「3待ち …」「1 登録」）・「送信」「送って」「キャンセル」「メニュー」「候補」「案件」・@AI秘書 あて
 */
export function looksLikeCommand(text: string, mentionsBot?: boolean): boolean {
  const t = text.replace(/[０-９＃]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\s+/g, " ").trim();
  return Boolean(mentionsBot) || t.startsWith("#") || NUM_COMMAND_RE.test(t) || COMMAND_WORD_RE.test(t);
}

// ── 処理 ──

export interface AskDeps {
  env?: Env;
  now(): number;
  kv: Pick<SdKv, "get" | "set" | "setNx" | "del" | "rpush">;
  /** 確認のカードの合言葉（16桁の16進）。控えた文ごとに新しく作る */
  token(): string;
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
  // Notion の「質問」と、その日の聞いた件は、送れた（2xx・409）と分かってから、1回の質問につき1回だけ書く
  // （結果不明のあとの押し直し・二度押しで同じ行を重ねない）
  const first = await deps.kv.setNx(askWrittenKey(askId), 1, ASK_MARKER_TTL_SEC).catch(() => true);
  if (!first) return "sent";
  const row: AskRow = { askId, taskId: t.id, title: t.title, assignee: t.assignee, assigneeUserId: t.assigneeUserId, at: now, group: to };
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

interface Pending {
  token: string;
  taskId: string;
  text: string;
  at: number;
}
function asPending(v: unknown): Pending | null {
  const p = v as Partial<Pending> | null;
  if (!p || typeof p !== "object" || typeof p.token !== "string" || typeof p.taskId !== "string" || typeof p.text !== "string" || !p.text) return null;
  return { token: p.token, taskId: p.taskId, text: p.text, at: typeof p.at === "number" ? p.at : 0 };
}

/** ボタン（v1|ka|・v1|kp|・v1|kw|・v1|ks|・v1|kr|・v1|kx|）。押せるのは仕分ける人だけ。返事は reply で。例外は投げない */
export async function handleAskPostback(a: AskAction, src: { userId?: string | null; webhookEventId?: string | null }, deps: AskDeps): Promise<void> {
  const say = (text: string, code: string, card?: FlexMessage) => {
    deps.log(`[staff-ask] ${a.op} ${code}`);
    return deps.reply(text, card).catch(() => deps.log(`[staff-ask] reply-failed ${a.op}`));
  };
  if (!staffDigestOn(deps.env ?? process.env)) return say(MSG_ASK_PAUSED, "paused");
  try {
    if (!src.userId || !(await deps.isOwner(src.userId))) return say(MSG_ASK_OWNER_ONLY, "denied");
    if ("token" in a) return await confirmAction(a, src.userId, deps, say);
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
 * 確認のカードのボタン。控え（staffask:c:<userId>）の合言葉がカードのものと同じときだけ動く
 * （古いカードで、あとから控えた別の文を送らない）。
 *   ［送る］：グループへ1通。retry key は合言葉から作る（1つの確認＝1つの key。結果不明のあとの押し直しは同じ文・同じ key）。
 *            送れたら控えを消す。送れなかった・結果が分からないときは控えを残す（もう一度押せる）
 *   ［書き直す］：控えを消して、次の1通を待つ印を10分置き直す
 *   ［やめる］：控えを消す
 */
async function confirmAction(
  a: { op: "ks" | "kr" | "kx"; token: string },
  userId: string,
  deps: AskDeps,
  say: (text: string, code: string, card?: FlexMessage) => Promise<void>
): Promise<void> {
  const key = askPendingKey(userId);
  const pend = asPending(await deps.kv.get(key));
  if (!pend || pend.token !== a.token) return say(MSG_ASK_STALE, "stale");
  if (a.op === "kx") {
    await deps.kv.del(key);
    return say(MSG_ASK_CANCELED, "canceled");
  }
  if (a.op === "kr") {
    if (await deps.otherMarker(userId)) return say(MSG_ASK_BUSY, "busy");
    await deps.kv.set(askMarkerKey(userId), { taskId: pend.taskId, at: deps.now() }, ASK_MARKER_TTL_SEC);
    await deps.kv.del(key).catch(() => undefined);
    return say(MSG_ASK_WRITE, "waiting");
  }
  const got = await loadForAsk(pend.taskId, deps);
  if (!("task" in got)) {
    await deps.kv.del(key).catch(() => undefined);
    return say(got.text, got.code);
  }
  const r = await sendAsk(got.task, pend.text, `${got.task.id}:c:${pend.token}`, deps);
  if (r === "sent") {
    await deps.kv.del(key).catch(() => undefined);
    return say(msgAskSent(got.task.assignee), "sent");
  }
  return say(r === "failed" ? MSG_ASK_FAILED_CONFIRM : MSG_ASK_UNKNOWN, r === "failed" ? "push-failed" : "unknown");
}

/**
 * ［自分で書く］のあとの 1対1 の1通。印（staffask:<userId>）があるときだけ扱う（無ければ false＝今までの流れへ）。
 * off・グループの発言は KV も読まない。印の読み出しは2.5秒まで（遅ければ今までの流れへ）。
 * **その場では送らない**：文を控え（staffask:c:<userId>・10分）、印を消して、確認のカード（［送る］［書き直す］［やめる］）を返す。
 * ほかの機能への指示に見える1通（looksLikeCommand）は控えずに false（印は残す）。「やめる」で取りやめ。300字まで。
 */
export async function handleAskText(
  input: { userId?: string | null; groupId?: string | null; text: string; mentionsBot?: boolean },
  deps: AskDeps
): Promise<boolean> {
  if (!staffDigestOn(deps.env ?? process.env) || input.groupId || !input.userId) return false;
  let marker: { taskId?: unknown; at?: unknown } | null;
  try {
    marker = (await bounded(deps.kv.get(askMarkerKey(input.userId)))) as { taskId?: unknown; at?: unknown } | null;
  } catch {
    return false;
  }
  if (!marker || typeof marker.taskId !== "string" || !marker.taskId) return false;
  const say = (text: string, code: string, card?: FlexMessage) => {
    deps.log(`[staff-ask] text ${code}`);
    return deps.reply(text, card).catch(() => deps.log("[staff-ask] reply-failed text"));
  };
  const key = askMarkerKey(input.userId);
  try {
    const text = input.text.replace(/\s+/g, " ").trim();
    if (CANCEL_RE.test(text)) {
      await deps.kv.del(key);
      await say(MSG_ASK_CANCELED, "canceled");
      return true;
    }
    // ほかの機能への指示（「3済」「#新規…」「送信」など）は質問として控えない。印は残し、今までの流れに任せる
    if (looksLikeCommand(input.text, input.mentionsBot)) {
      deps.log("[staff-ask] text skip:command");
      return false;
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
    // 控えを置いてから印を消す（この1通だけを控える。次の発言は今までの流れへ）
    const token = deps.token();
    await deps.kv.set(askPendingKey(input.userId), { token, taskId: got.task.id, text, at: deps.now() }, ASK_MARKER_TTL_SEC);
    await deps.kv.del(key).catch(() => undefined);
    await say(MSG_ASK_CONFIRM, "confirm", askConfirmCard(got.task, text, token));
    return true;
  } catch {
    await say(MSG_ASK_ERROR, "error");
    return true;
  }
}
