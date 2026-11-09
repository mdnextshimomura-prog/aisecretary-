/**
 * B1 Task 2：タスクの候補をカードで出し、ボタンで登録・保留・いらないを決める。
 * スイッチは TASK_MENU（menuActive）かつ TASK_CANDIDATES=1。どちらか off なら、カードは出さず、
 * postback もここに来ない（今の文字の「1 登録」「2 なし」・17 時の文字の一覧のまま）。
 *
 * - カード：候補1件＝1枚（題名・依頼者・いつの発言か・メンションされた人）。
 *   ボタン［登録する］［保留］［いらない］。data は `v1|cr|候補ID`（登録）・`v1|ch|候補ID`（保留）・
 *   `v1|cx|候補ID`（いらない）。候補ID は元の発言の ID（形は CANDIDATE_ID_RE）。表示番号は ID にしない。
 * - カルーセル：最大10枚＋［次の10件］（data は `v1|lc|オフセット`＝メニューの［候補］と同じ）。
 * - 登録：`taskcand:reg:<id>` を SET NX で予約してから登録（同時に2回押されても1回）。登録できたら候補を消す。
 *   失敗したら予約を外して候補を残す（もう一度押せる）。
 * - 保留：その候補を次の 17 時まで出さない（印を付ける）。いらない：候補から外す。
 * - 見える・押せる：候補を控えたグループの中だけ（別のグループ・1対1からは「見つかりません」）。
 *   押せる人は、依頼者・メンションされた人・ADMIN（TASK_BUTTONS_ADMIN_IDS）。名簿で同じ人の別アカウントも。
 * ログに出すのは操作名・結果の符号・件数だけ（題名・本文・userId は出さない）。
 */
import { loadMembers, type Member } from "./members";
import { replyTextAndCard } from "./line";
import {
  buildDigest,
  candidatesEnabled,
  isCandidateGroup,
  type Candidate,
  type CandidateCommand,
} from "./task-candidate";
import {
  CANDIDATE_ID_RE,
  claimRegister,
  getCandidate,
  groupOf,
  heldIds,
  holdCandidate,
  numberCandidates,
  peekCandidate,
  releaseRegister,
  removeCandidateById,
} from "./task-candidate-store";
import {
  FLEX_JSON_MAX,
  menuActive,
  nextBubble,
  type ListPage,
} from "./task-menu";
import { MENU_PAGE_SIZE } from "./task-buttons";
import {
  ALT_TEXT_MAX,
  CARD_TITLE_MAX,
  FLEX_LABEL_MAX,
  POSTBACK_TEXT_MAX,
  type FlexMessage,
} from "./task-card";

/** 候補のカードを出す・押されたら扱うか */
export function candidateCardsActive(): boolean {
  return menuActive() && candidatesEnabled();
}

/**
 * メンションの無い依頼を候補に控えたとき、その場の返事（reply）で候補カードを出すか。
 * TASK_CANDIDATE_INSTANT=1 かつ候補カードが on のときだけ。off なら今までどおり黙って控える（17時に聞く）。
 */
export function instantCandidateActive(): boolean {
  return candidateCardsActive() && process.env.TASK_CANDIDATE_INSTANT === "1";
}

export type CandidateOp = "cr" | "ch" | "cx";
const OPS: CandidateOp[] = ["cr", "ch", "cx"];
export interface CandidateAction {
  op: CandidateOp;
  id: string;
}

export function encodeCandidateData(op: CandidateOp, id: string): string {
  return ["v1", op, id].join("|");
}

/** `v1|cr|候補ID` などを読む。形が違えば null（300字以内・ID の形を確かめる） */
export function parseCandidateData(data: string): CandidateAction | null {
  if (!data || data.length > POSTBACK_TEXT_MAX) return null;
  const parts = data.split("|");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const op = parts[1] as CandidateOp;
  if (!OPS.includes(op)) return null;
  if (!CANDIDATE_ID_RE.test(parts[2])) return null;
  return { op, id: parts[2] };
}

export const MSG_CAND_FORBIDDEN =
  "この候補を操作できるのは依頼者・宛先の人・下村さんだけです";
export const MSG_CAND_NOT_FOUND =
  "この候補は見つかりませんでした（登録済みか、消えています）";
export const MSG_CAND_BUSY =
  "この候補はいま登録の手続き中です。少し待ってから確かめてください";
export const MSG_CAND_DUPLICATE = "この候補はすでに登録済みです。";
export const MSG_CAND_RETRY =
  "⚠️ 登録できたか確かめられませんでした。少し待ってから、もう一度［登録する］を押してください。";
export const MSG_CAND_ERROR =
  "⚠️ 候補を処理できませんでした。もう一度お試しください。";
export const MSG_CAND_EMPTY = "いま控えている候補はありません。";
export const MSG_CAND_ONLY_GROUP = "候補は、控えたグループの中でだけ見られます";
export const MSG_CAND_OFF = "いま候補の機能は止めています";
export const MSG_CAND_ASKED =
  "📝 タスクにするか迷ったので、候補に控えました。タスクにするならボタンを押してください";
/** メンションの無い依頼をその場で聞くときの文（押さなければ17時のまとめでも聞く） */
export const MSG_CAND_INSTANT =
  "📝 タスクにしますか？登録するならボタンを押してください（押さなければ、17時のまとめでも聞きます）";
export const msgHeld = (title: string) =>
  `⏸ 次の17時まで出さないでおきます\n📋 ${title}`;
export const msgDropped = (title: string) =>
  `🗑 候補から外しました\n📋 ${title}`;

const JST_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 次の 17 時（JST）。いまが 17:00 ちょうど以降なら翌日の 17 時 */
export function nextDigestTimeMs(nowMs: number): number {
  const j = new Date(nowMs + JST_MS);
  let t =
    Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate(), 17) - JST_MS;
  if (t <= nowMs) t += 24 * 60 * 60 * 1000;
  return t;
}

/** 発言の時刻 → "11月8日(日) 14:05"（JST） */
export function formatSaidAt(ms: number): string {
  const j = new Date(ms + JST_MS);
  const hh = String(j.getUTCHours()).padStart(2, "0");
  const mm = String(j.getUTCMinutes()).padStart(2, "0");
  return `${j.getUTCMonth() + 1}月${j.getUTCDate()}日(${WEEKDAYS[j.getUTCDay()]}) ${hh}:${mm}`;
}

const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");
const cutEllipsis = (s: string, n: number) =>
  Array.from(s).length > n ? `${cut(s, n - 1)}…` : s;

/** userId → 名簿の名前（無ければ null） */
export type NameOf = (userId: string) => string | null;
export function nameResolver(members: Member[]): NameOf {
  return (id) => members.find((m) => m.userIds.includes(id))?.name ?? null;
}

/** メンションされた人（Bot 以外）。古い候補は担当の userId だけ */
function mentionedOf(c: Candidate): string[] {
  const ids = [...(c.mentionedUserIds ?? []), c.assigneeUserId ?? ""].filter(
    Boolean,
  );
  return ids.filter((v, i) => ids.indexOf(v) === i);
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

function button(
  label: string,
  data: string,
  displayText: string,
  primary = false,
) {
  return {
    type: "button",
    style: primary ? "primary" : "secondary",
    height: "sm",
    action: {
      type: "postback",
      label: cut(label, FLEX_LABEL_MAX),
      data,
      displayText: cut(displayText, POSTBACK_TEXT_MAX),
    },
  };
}

/** 候補1件のカード（bubble）。n は文字の一覧の番号（見出しに出すだけ。data には入れない） */
export function candidateBubble(
  c: Candidate,
  nameOf: NameOf,
  n?: number,
): Record<string, unknown> {
  const requester = c.senderId ? (nameOf(c.senderId) ?? "不明") : "不明";
  const mentioned = mentionedOf(c).map(
    (id) =>
      nameOf(id) ?? (id === c.assigneeUserId ? c.assignee : null) ?? "不明",
  );
  const to =
    mentioned.length > 0
      ? mentioned.filter((v, i) => mentioned.indexOf(v) === i).join("・")
      : c.assignee?.trim() || "なし";
  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: n ? `タスクの候補 ${n}` : "タスクの候補",
          size: "xs",
          color: "#888888",
        },
        {
          type: "text",
          text: cutEllipsis(c.title.trim() || "（無題）", CARD_TITLE_MAX),
          weight: "bold",
          size: "md",
          wrap: true,
          margin: "sm",
        },
        {
          type: "box",
          layout: "vertical",
          margin: "md",
          spacing: "sm",
          contents: [
            row("依頼者", requester),
            row("発言", formatSaidAt(c.createdAt)),
            row("宛先", to),
          ],
        },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        button(
          "登録する",
          encodeCandidateData("cr", c.id),
          "（ボタン）候補を登録する",
          true,
        ),
        button(
          "保留",
          encodeCandidateData("ch", c.id),
          "（ボタン）候補を保留にする",
        ),
        button(
          "いらない",
          encodeCandidateData("cx", c.id),
          "（ボタン）候補を外す",
        ),
      ],
    },
  };
}

/** 候補1枚だけのカード（迷った依頼への返事） */
export function candidateCard(c: Candidate, nameOf: NameOf): FlexMessage {
  return {
    type: "flex",
    altText: cut(`【タスクの候補】${c.title}`, ALT_TEXT_MAX),
    contents: candidateBubble(c, nameOf),
  };
}

export interface NumberedEntry {
  n: number;
  c: Candidate;
}

/** 番号つきの並び → カードに出す分（片付いた番号・保留中を除く） */
export function visibleEntries(
  numbered: Array<Candidate | null>,
  held: Set<string>,
): NumberedEntry[] {
  const out: NumberedEntry[] = [];
  numbered.forEach((c, i) => {
    if (c && !held.has(c.id)) out.push({ n: i + 1, c });
  });
  return out;
}

/**
 * 候補のカルーセル（offset から最大10枚＋続きがあれば［次の10件］）。JSON が 30KB 以上なら後ろを減らす。
 * 出す分が無ければ undefined。
 */
export function candidateCarousel(
  entries: NumberedEntry[],
  offset: number,
  nameOf: NameOf,
): { card: FlexMessage; end: number } | undefined {
  const total = entries.length;
  if (offset >= total) return undefined;
  let count = Math.min(MENU_PAGE_SIZE, total - offset);
  for (;;) {
    const shown = entries.slice(offset, offset + count);
    const bubbles: unknown[] = shown.map((e) =>
      candidateBubble(e.c, nameOf, e.n),
    );
    const end = offset + count;
    if (end < total) bubbles.push(nextBubble("lc", end, total - end));
    const card: FlexMessage = {
      type: "flex",
      altText: cut(
        `【タスクの候補】${total}件（${offset + 1}〜${end}件目）`,
        ALT_TEXT_MAX,
      ),
      contents: { type: "carousel", contents: bubbles },
    };
    if (
      Buffer.byteLength(JSON.stringify(card.contents), "utf8") <
        FLEX_JSON_MAX ||
      count === 1
    ) {
      return { card, end };
    }
    count--;
  }
}

/** 番号つきの並びから、保留中を除いた文字の一覧（buildDigest）とカード */
export function digestWithCards(
  numbered: Array<Candidate | null>,
  held: Set<string>,
  nameOf: NameOf,
  offset = 0,
): { text: string | null; card?: FlexMessage; shown: number } {
  const visible = numbered.map((c) => (c && !held.has(c.id) ? c : null));
  const entries = visibleEntries(numbered, held);
  const page = candidateCarousel(entries, offset, nameOf);
  const shown = page ? Math.min(page.end, entries.length) - offset : 0;
  const text =
    offset === 0
      ? buildDigest(visible)
      : entries.length === 0
        ? null
        : page
          ? `📝 タスクの候補（${entries.length}件中 ${offset + 1}〜${page.end}件目）`
          : `続きの候補はありません（全${entries.length}件）`;
  return { text, ...(page ? { card: page.card } : {}), shown };
}

export interface CandidateListDeps {
  number(nowMs: number, groupId: string): Promise<Array<Candidate | null>>;
  held(ids: string[], nowMs: number): Promise<Set<string>>;
  members(): Promise<Member[]>;
  now(): number;
}

/** メニューの［候補］・「@秘書 候補」：押したグループの候補（17 時と同じ形：文字の一覧＋カード） */
export async function candidateListPage(
  offset: number,
  groupId: string | undefined,
  deps: CandidateListDeps,
): Promise<ListPage> {
  if (!candidatesEnabled()) return { text: MSG_CAND_OFF, pageIds: [] };
  if (!groupId) return { text: MSG_CAND_ONLY_GROUP, pageIds: [] };
  if (!isCandidateGroup(groupId)) return { text: MSG_CAND_EMPTY, pageIds: [] };
  const now = deps.now();
  const numbered = await deps.number(now, groupId);
  const ids = numbered
    .filter((c): c is Candidate => c !== null)
    .map((c) => c.id);
  const held = await deps.held(ids, now);
  const members = await deps.members().catch(() => [] as Member[]);
  const r = digestWithCards(numbered, held, nameResolver(members), offset);
  return {
    text: r.text ?? MSG_CAND_EMPTY,
    ...(r.card ? { card: r.card } : {}),
    pageIds: [],
    shown: r.shown,
  };
}

function adminIds(): string[] {
  return (process.env.TASK_BUTTONS_ADMIN_IDS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** 押せる人：依頼者・メンションされた人・ADMIN（名簿で同じ人の別アカウントも） */
export function canOperateCandidate(
  actorId: string | undefined,
  c: Candidate,
  members: Member[],
): boolean {
  if (!actorId) return false;
  if (adminIds().includes(actorId)) return true;
  const owners = [c.senderId ?? "", ...mentionedOf(c)].filter(Boolean);
  if (owners.includes(actorId)) return true;
  const me = members.find((m) => m.userIds.includes(actorId));
  return Boolean(me && me.userIds.some((id) => owners.includes(id)));
}

export type RegisterResult = "ok" | "retry" | "failed" | "duplicate";

export interface CandidateActionDeps {
  get(id: string, nowMs: number): Promise<Candidate | null>;
  /** 控えたグループ（古い候補は営業部） */
  groupOf(c: Candidate): string;
  claimRegister(id: string): Promise<boolean>;
  releaseRegister(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  hold(id: string, untilMs: number, nowMs: number): Promise<void>;
  members(): Promise<Member[]>;
  /**
   * 通常の登録（route.ts の registerTaskFromText。元の発言の ID が鍵）。ok・failed のときは
   * 登録の側が返事を送る（replyToken を使う）。duplicate・retry のときは返事をしていない
   */
  register(
    c: Candidate,
    replyToken: string,
    groupId: string,
  ): Promise<RegisterResult>;
  reply(replyToken: string, text: string): Promise<unknown>;
  now(): number;
  log(line: string): void;
}

/**
 * 候補のボタン（postback）。返事は replyToken で。例外は投げない（返事で知らせる）。
 * groupId：押したグループ（1対1なら undefined）。控えたグループと違えば「見つかりません」。
 */
export async function handleCandidateAction(
  action: CandidateAction,
  actorId: string | undefined,
  groupId: string | undefined,
  replyToken: string,
  deps: CandidateActionDeps,
): Promise<void> {
  const say = async (text: string, code: string) => {
    deps.log(`[task-candidate] ${action.op} ${code}`);
    try {
      await deps.reply(replyToken, text);
    } catch {
      deps.log(`[task-candidate] reply-failed ${action.op} ${code}`);
    }
  };
  let c: Candidate | null;
  let members: Member[];
  try {
    const now = deps.now();
    c = await deps.get(action.id, now);
    // 別のグループ・1対1からは、あることも見せない
    if (
      !c ||
      !groupId ||
      !isCandidateGroup(groupId) ||
      deps.groupOf(c) !== groupId
    ) {
      await say(MSG_CAND_NOT_FOUND, "not-found");
      return;
    }
    members = await deps.members().catch(() => [] as Member[]);
    if (!canOperateCandidate(actorId, c, members)) {
      await say(MSG_CAND_FORBIDDEN, "forbidden");
      return;
    }
    if (action.op === "ch") {
      await deps.hold(c.id, nextDigestTimeMs(now), now);
      await say(msgHeld(c.title), "held");
      return;
    }
    if (action.op === "cx") {
      await deps.remove(c.id);
      await say(msgDropped(c.title), "dropped");
      return;
    }
  } catch {
    await say(MSG_CAND_ERROR, "error");
    return;
  }

  // 登録：予約（SET NX）が取れた1回だけ通す
  let claimed: boolean;
  try {
    claimed = await deps.claimRegister(c.id);
  } catch {
    await say(MSG_CAND_ERROR, "reserve-failed");
    return;
  }
  if (!claimed) {
    await say(MSG_CAND_BUSY, "busy");
    return;
  }
  let r: RegisterResult;
  try {
    r = await deps.register(c, replyToken, groupId);
  } catch {
    await deps.releaseRegister(c.id).catch(() => undefined);
    await say(MSG_CAND_ERROR, "error");
    return;
  }
  if (r === "ok" || r === "duplicate") {
    // 登録できた（または前に登録済み）と分かってから消す。予約は期限で消える（すぐ押し直されても2回目は通らない）
    await deps
      .remove(c.id)
      .catch(() => deps.log("[task-candidate] cr remove-failed"));
    if (r === "ok") deps.log("[task-candidate] cr registered");
    else await say(MSG_CAND_DUPLICATE, "duplicate");
    return;
  }
  // 失敗：予約を外して候補を残す（もう一度押せる）
  await deps
    .releaseRegister(c.id)
    .catch(() => deps.log("[task-candidate] cr release-failed"));
  if (r === "retry") await say(MSG_CAND_RETRY, "retry");
  else deps.log("[task-candidate] cr failed"); // 理由は登録の側が返事済み
}

// ── 本物へのつなぎ（KV・名簿）。LINE への返事と登録は入口（task-buttons-wire.ts・route.ts）が渡す ──

export function defaultCandidateListDeps(): CandidateListDeps {
  return {
    number: (nowMs, g) => numberCandidates(nowMs, g),
    held: heldIds,
    members: loadMembers,
    now: Date.now,
  };
}

export function defaultCandidateActionDeps(
  io: Pick<CandidateActionDeps, "register" | "reply" | "log">,
): CandidateActionDeps {
  return {
    get: getCandidate,
    groupOf,
    claimRegister,
    releaseRegister,
    remove: removeCandidateById,
    hold: holdCandidate,
    members: loadMembers,
    now: Date.now,
    ...io,
  };
}

/**
 * 迷った依頼（@秘書 あてで確信度 0.5〜0.7）を候補に控えたとき、その場の返事で候補カード1枚を返す（reply）。
 * 送信の例外はそのまま投げる（呼び出し側がログだけ出す）。
 */
export async function replyCandidateCard(
  replyToken: string,
  c: Candidate,
  over: {
    reply?: typeof replyTextAndCard;
    members?: () => Promise<Member[]>;
    /** 1通目の文（既定は迷った依頼の文。メンションの無い依頼は MSG_CAND_INSTANT） */
    text?: string;
  } = {},
): Promise<void> {
  const members = await (over.members ?? loadMembers)().catch(
    () => [] as Member[],
  );
  const text = over.text ?? MSG_CAND_ASKED;
  await (over.reply ?? replyTextAndCard)(
    replyToken,
    text,
    candidateCard(c, nameResolver(members)),
  );
  console.log(
    text === MSG_CAND_ASKED
      ? "[task-candidate] asked-card shown 1"
      : "[task-candidate] instant-card shown 1",
  );
}

/** 「@秘書 候補」（TASK_MENU on）：メニューの［候補］と同じ返事（文字の一覧＋カード） */
export async function replyCandidateList(
  replyToken: string,
  groupId: string | undefined,
  over: { reply?: typeof replyTextAndCard; list?: CandidateListDeps } = {},
): Promise<void> {
  const r = await candidateListPage(
    0,
    groupId,
    over.list ?? defaultCandidateListDeps(),
  );
  await (over.reply ?? replyTextAndCard)(replyToken, r.text, r.card);
  console.log(`[task-candidate] list shown ${r.shown ?? 0}`);
}

// ── 文字の「n 登録」「n なし」（TASK_MENU on のときだけ route.ts から呼ぶ。off は route.ts の今の処理のまま）──

export interface CandidateTextDeps {
  /** 番号の候補（そのグループの番号の並びで引く） */
  peek(n: number, nowMs: number, groupId: string): Promise<Candidate | null>;
  claimRegister(id: string): Promise<boolean>;
  releaseRegister(id: string): Promise<void>;
  /** ID で片付ける（番号では消さない：登録の間に番号が振り直されても別の候補を消さない） */
  remove(id: string): Promise<void>;
  members(): Promise<Member[]>;
  register(
    c: Candidate,
    replyToken: string,
    groupId: string,
  ): Promise<RegisterResult>;
  reply(replyToken: string, text: string): Promise<unknown>;
  now(): number;
  log(line: string): void;
}

export function defaultCandidateTextDeps(
  io: Pick<CandidateTextDeps, "register" | "reply" | "log">,
): CandidateTextDeps {
  return {
    peek: (n, nowMs, g) => peekCandidate(n, nowMs, g),
    claimRegister,
    releaseRegister,
    remove: removeCandidateById,
    members: loadMembers,
    now: Date.now,
    ...io,
  };
}

/**
 * 文字の「n 登録」「n なし」。押せる人はボタンと同じ（依頼者・メンションされた人・ADMIN・名簿の別アカウント）。
 * 登録はボタンと同じ予約（SET NX）を通し、失敗・例外では予約を外して候補を残す。片付けは手元の ID で。
 * 返事の文は今の文字の処理と同じ（押せないときだけボタンと同じ断りの文）。例外は投げない。
 * committed：何かを片付けた・登録した（route.ts の markCommitted に使う）。
 */
export async function handleCandidateTextCommand(
  cmd: CandidateCommand,
  actorId: string | undefined,
  groupId: string,
  replyToken: string,
  deps: CandidateTextDeps,
): Promise<{ committed: boolean }> {
  const say = async (text: string, code: string) => {
    deps.log(`[task-candidate] text-${cmd.action} ${code}`);
    try {
      await deps.reply(replyToken, text);
    } catch {
      deps.log(`[task-candidate] reply-failed text-${cmd.action} ${code}`);
    }
  };
  try {
    const now = deps.now();
    const members = await deps.members().catch(() => [] as Member[]);
    if (cmd.action === "register") {
      // 登録は 1 件ずつ。登録の返信（期日・担当の説明や聞き返し）を 1 件ごとに出すため
      if (cmd.numbers.length > 1) {
        await say("登録は 1 件ずつお願いします（例：「1 登録」）", "multi");
        return { committed: false };
      }
      const n = cmd.numbers[0];
      const c = await deps.peek(n, now, groupId);
      if (!c) {
        await say(
          `⚠️ ${n}番の候補は見つかりませんでした（登録済みか、消えています）`,
          "not-found",
        );
        return { committed: false };
      }
      if (!canOperateCandidate(actorId, c, members)) {
        await say(MSG_CAND_FORBIDDEN, "forbidden");
        return { committed: false };
      }
      if (!(await deps.claimRegister(c.id))) {
        await say(MSG_CAND_BUSY, "busy");
        return { committed: false };
      }
      let r: RegisterResult;
      try {
        r = await deps.register(c, replyToken, groupId);
      } catch {
        await deps
          .releaseRegister(c.id)
          .catch(() =>
            deps.log("[task-candidate] text-register release-failed"),
          );
        await say(MSG_CAND_ERROR, "error");
        return { committed: false };
      }
      if (r === "ok" || r === "duplicate") {
        await deps
          .remove(c.id)
          .catch(() =>
            deps.log("[task-candidate] text-register remove-failed"),
          );
        if (r === "ok") deps.log("[task-candidate] text-register registered");
        else await say(`${n}番はすでに登録済みです。`, "duplicate");
        return { committed: true };
      }
      // 失敗：予約を外して候補を残す（送り直せる）
      await deps
        .releaseRegister(c.id)
        .catch(() => deps.log("[task-candidate] text-register release-failed"));
      if (r === "retry") {
        // LINE の再送は無効なので、503 で待たずにその場で知らせる
        await say(
          `⚠️ 登録できたか確かめられませんでした。少し待ってから、もう一度「${n} 登録」と送ってください。`,
          "retry",
        );
      } else deps.log("[task-candidate] text-register failed"); // 理由は登録の側が返事済み
      return { committed: false };
    }

    const dropped: string[] = [];
    const notFound: number[] = [];
    const forbidden: number[] = [];
    for (const n of cmd.numbers) {
      const c = await deps.peek(n, now, groupId);
      if (!c) notFound.push(n);
      else if (!canOperateCandidate(actorId, c, members)) forbidden.push(n);
      else {
        await deps.remove(c.id);
        dropped.push(`${n}. ${c.title}`);
      }
    }
    if (dropped.length === 0 && notFound.length === 0 && forbidden.length > 0) {
      await say(MSG_CAND_FORBIDDEN, "forbidden");
      return { committed: false };
    }
    const lines: string[] = [];
    if (dropped.length > 0) {
      lines.push(`🗑 候補から外しました（${dropped.length}件）`, ...dropped);
    }
    if (notFound.length > 0) {
      lines.push(`⚠️ ${notFound.join("・")}番の候補は見つかりませんでした`);
    }
    if (forbidden.length > 0) {
      lines.push(`⚠️ ${forbidden.join("・")}番：${MSG_CAND_FORBIDDEN}`);
    }
    await say(lines.join("\n"), dropped.length > 0 ? "dropped" : "not-found");
    return { committed: dropped.length > 0 };
  } catch {
    await say(MSG_CAND_ERROR, "error");
    return { committed: false };
  }
}
