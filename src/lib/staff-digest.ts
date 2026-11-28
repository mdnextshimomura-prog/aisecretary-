/**
 * 担当へのまとめ（段階2・2026-11-28 下村さん決定）。スイッチは STAFF_DIGEST=1（既定 off）。
 *
 * 朝8時のリマインドと夕方17時台の1回、会社グループへ「担当ごとの箇条書き」を文字だけで送る：
 *   ・担当のいるもの＝「{担当} どうなりましたか？」、担当の決まっていないもの＝「どうしますか？」
 *   ・番号は全体の通し番号（今の「3済」「3待ち …」の返事がそのまま使える）
 * off のあいだ、送る文・KV・Notion・ログは足す前と同じ（remind.ts は今の文のまま。夕方は KV も読まない）。
 *
 * 夕方は Vercel の cron を増やさず、毎分の見回り /api/obi/cloud-tick に相乗りする（KV の印で1日1回）。
 * まとめのメッセージ ID は KV に控える（段階3 の「まとめを引用した返信」の照合に使う）。
 * ログは符号と件数だけ（本文・題名・userId・groupId・messageId は出さない）。
 */
import { kv } from "@vercel/kv";
import { buildChunks, type Chunk, type ChunkItem } from "./chunk";
import { STATUS_PENDING } from "./clarify";
import { closureOn, loadClosures } from "./closures";
import { pushLineChunksWithIds, sanitizeForTextV2 } from "./line";
import { getUpcomingTasks, setRemindNumber } from "./notion";
import { bucketOf, shouldRemind } from "./remind-select";
import { splitForGroup } from "./task-origin";
import { followupEnabled } from "./task-status";

type Env = Record<string, string | undefined>;

export function staffDigestOn(env: Env = process.env): boolean {
  return env.STAFF_DIGEST === "1";
}

export type DigestSlot = "am" | "eve";

/** まとめに載せるタスク（朝のリマインドのタスクの並びと同じ形の一部） */
export interface DigestTask {
  id: string;
  title: string;
  /** Notion の期日そのまま（"YYYY-MM-DD" か ISO 日時。無ければ ""） */
  dueDate: string;
  status: string;
  assignee: string | null;
  assigneeUserId: string | null;
  /** 状況（待ち相手・理由）。無ければ "" */
  note: string;
  /** 物件名（案件名の代わり）。無ければ null */
  propertyName?: string | null;
}

const HEADERS: Record<DigestSlot, string> = {
  am: "📋 進捗の確認です",
  eve: "📋 夕方の進捗の確認です",
};
const ASK_ASSIGNED = "どうなりましたか？";
const ASK_UNASSIGNED = "担当が決まっていないもの：どうしますか？";

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.round((b - a) / 86_400_000);
}

/** 期日の言い方（本日期限／明日期限／2日超過／期日 12/3／期日なし。初動確認の回答待ちは「回答待ち」） */
function dueLabel(t: DigestTask, today: string, tomorrow: string): string {
  if (t.status === STATUS_PENDING) return "回答待ち";
  const due = t.dueDate.slice(0, 10);
  if (!due) return "期日なし";
  if (due < today) return `${daysBetween(due, today)}日超過`;
  if (due === today) return "本日期限";
  if (due === tomorrow) return "明日期限";
  return `期日 ${Number(due.slice(5, 7))}/${Number(due.slice(8, 10))}`;
}

function taskLine(n: number, t: DigestTask, today: string, tomorrow: string, followup: boolean): string {
  const title = sanitizeForTextV2(t.title);
  let line = `${n}. ${title}（${dueLabel(t, today, tomorrow)}）`;
  // 物件名は、題名に入っていなければ添える
  const prop = t.propertyName ? sanitizeForTextV2(t.propertyName.trim()) : "";
  if (prop && !title.includes(prop)) line += `［${prop}］`;
  // TASK_FOLLOWUP を off に戻したあとは、残っている状況を出さない（朝のリマインドと同じ扱い）
  if (followup && t.note) line += `（待ち：${sanitizeForTextV2(t.note)}）`;
  return line;
}

function footerOf(followup: boolean): string {
  // 例は、いま受け付ける言葉だけを載せる（自由な文の進捗「3 アポ取れました」は段階3で受けるようになってから足す）
  return (
    "\n\n──────────\n" +
    "このメッセージに返信（リプライ）で、番号をつけて答えてください\n" +
    "例：「1済」「1,2完了」" +
    (followup
      ? "\n相手待ち：「2待ち 売主の書類 金曜」\n期日を変える：「3延期 10/20」\nやらなくてよい：「3不要」"
      : "")
  );
}

export interface DigestInput<T extends DigestTask> {
  slot: DigestSlot;
  /** 載せるタスク（期日の古い順で渡す。担当の並びは、最初に出てきた順） */
  tasks: T[];
  /** JST の今日・明日（"YYYY-MM-DD"） */
  today: string;
  tomorrow: string;
  /** TASK_FOLLOWUP が on か（待ちの表示と、返事の例に使う） */
  followup: boolean;
  /** 決まっている番号（夕方：朝の番号を保つ）。無ければ載せる順に1から振る */
  numbers?: Map<string, number>;
}

export interface DigestOutput<T extends DigestTask> {
  chunks: Chunk[];
  /** 本文に載せた順と、その番号 */
  ordered: Array<{ task: T; n: number }>;
}

/** まとめの文を組み立てる（純粋な関数。5000字・メンション20件の上限は buildChunks が分ける） */
export function buildStaffDigest<T extends DigestTask>(input: DigestInput<T>): DigestOutput<T> {
  const { slot, tasks, today, tomorrow, followup, numbers } = input;

  // 担当ごとにまとめる。鍵は担当の名前（無ければ userId）。どちらも無いものは最後の「どうしますか？」
  const groups = new Map<string, { name: string | null; userId: string | null; tasks: T[] }>();
  const unassigned: T[] = [];
  for (const t of tasks) {
    const key = t.assignee || t.assigneeUserId;
    if (!key) {
      unassigned.push(t);
      continue;
    }
    const g = groups.get(key) ?? { name: t.assignee, userId: null, tasks: [] };
    if (!g.userId && t.assigneeUserId) g.userId = t.assigneeUserId;
    g.tasks.push(t);
    groups.set(key, g);
  }

  const byNumber = (list: T[]) =>
    numbers ? [...list].sort((a, b) => (numbers.get(a.id) ?? 0) - (numbers.get(b.id) ?? 0)) : list;

  const ordered: Array<{ task: T; n: number }> = [];
  const items: ChunkItem[] = [];
  const pushTasks = (list: T[]) => {
    for (const t of byNumber(list)) {
      const n = numbers?.get(t.id) ?? ordered.length + 1;
      ordered.push({ task: t, n });
      items.push({ text: taskLine(n, t, today, tomorrow, followup) });
    }
  };
  const gap = () => {
    if (items.length > 0) items.push({ text: "" });
  };

  for (const g of Array.from(groups.values())) {
    gap();
    // userId が無い担当はメンションできないので名前で呼ぶ
    items.push(
      g.userId
        ? { text: ASK_ASSIGNED, userId: g.userId, mentionFirst: true }
        : { text: `${sanitizeForTextV2(g.name ?? "")}さん ${ASK_ASSIGNED}` }
    );
    pushTasks(g.tasks);
  }
  if (unassigned.length > 0) {
    gap();
    items.push({ text: ASK_UNASSIGNED });
    pushTasks(unassigned);
  }

  return { chunks: buildChunks(HEADERS[slot], items, footerOf(followup)), ordered };
}

// ── 夕方に出すもの・番号 ──

type EveTask = DigestTask & { remindNumber: number | null };

/**
 * 夕方の対象：まだ完了していない（＝渡された並びにある）もののうち、
 * 朝の知らせに載ったもの（リマインド番号が残っている）＋本日期限・期限超過。
 * 今日入った明日以降のタスクは出さない（次の朝に出る）。
 */
export function selectEvening<T extends EveTask>(tasks: T[], today: string, tomorrow: string): T[] {
  return tasks.filter((t) => {
    if (t.remindNumber !== null) return true;
    const b = bucketOf({ dueDate: t.dueDate, nextCheck: null, createdDate: "" }, today, tomorrow);
    return b === "overdue" || b === "today";
  });
}

/**
 * 夕方の番号：朝の番号はそのまま使う（朝のまとめに「3済」と返しても、夕方のまとめに返しても同じタスクに当たる）。
 * 番号の無いもの・同じ番号が重なったものだけ、いま付いているいちばん大きい番号の次から振る。
 * all＝引いてきたタスク全部（載せないものの番号とも重ねないため）。fresh＝Notion に書く分。
 */
export function assignEveningNumbers<T extends EveTask>(
  selected: T[],
  all: T[]
): { numbers: Map<string, number>; fresh: Array<{ id: string; n: number }> } {
  const numbers = new Map<string, number>();
  const used = new Set<number>();
  const need: T[] = [];
  for (const t of selected) {
    if (t.remindNumber !== null && t.remindNumber > 0 && !used.has(t.remindNumber)) {
      numbers.set(t.id, t.remindNumber);
      used.add(t.remindNumber);
    } else need.push(t);
  }
  let next = Math.max(0, ...all.map((t) => t.remindNumber ?? 0)) + 1;
  const fresh: Array<{ id: string; n: number }> = [];
  for (const t of need) {
    numbers.set(t.id, next);
    fresh.push({ id: t.id, n: next });
    next += 1;
  }
  return { numbers, fresh };
}

// ── KV（鍵は staffdigest:*） ──

export const DIGEST_MSG_TTL_SEC = 3 * 24 * 60 * 60;
const EVE_MARK_TTL_SEC = 2 * 24 * 60 * 60;
/** まとめのメッセージの控え（段階3 が引用リプライの照合に読む）。値は {at, slot} */
export const digestMsgKey = (messageId: string) => `staffdigest:msg:${messageId}`;
/** 夕方の「今日は送った」印（day は JST の "YYYY-MM-DD"） */
export const digestEveKey = (day: string) => `staffdigest:eve:${day}`;

export interface DigestMsgKv {
  set(key: string, value: unknown, exSeconds: number): Promise<void>;
}
const realMsgKv: DigestMsgKv = {
  set: async (key, value, ex) => {
    await kv.set(key, value, { ex });
  },
};

/** 送ったまとめのメッセージ ID を控える。ID が無ければ KV を触らない */
export async function saveDigestMessageIds(
  ids: string[],
  slot: DigestSlot,
  now: number,
  store: DigestMsgKv = realMsgKv
): Promise<void> {
  for (const id of ids) await store.set(digestMsgKey(id), { at: now, slot }, DIGEST_MSG_TTL_SEC);
}

// ── 送る ──

const LINE_GROUP_ID =
  process.env.LINE_GROUP_ID ?? "Cd5fda3261e9bdd012e598884b2e6a696";

export interface DigestSendDeps {
  /** グループへ順に送り、送れた通数とメッセージ ID を返す */
  push(chunks: Chunk[]): Promise<{ sent: number; ids: string[] }>;
  saveIds(ids: string[], slot: DigestSlot, now: number): Promise<void>;
  log(line: string): void;
}
const realSendDeps: DigestSendDeps = {
  push: (chunks) => pushLineChunksWithIds(LINE_GROUP_ID, chunks),
  saveIds: (ids, slot, now) => saveDigestMessageIds(ids, slot, now),
  log: (l) => console.log(l),
};

/**
 * まとめを送り、メッセージ ID を控える（朝・夕方の共通）。送れた通数を返す。
 * ID を控えられなくても投げない（まとめは届いている。段階3 の引用の照合ができなくなるだけ）。
 */
export async function sendDigestChunks(
  slot: DigestSlot,
  chunks: Chunk[],
  taskCount: number,
  now: number,
  deps: DigestSendDeps = realSendDeps
): Promise<number> {
  const r = await deps.push(chunks);
  if (r.sent === 0) {
    deps.log(`[staff-digest] ${slot} push-failed`);
    return 0;
  }
  try {
    await deps.saveIds(r.ids, slot, now);
  } catch {
    deps.log(`[staff-digest] ${slot} ids-save-failed`);
  }
  deps.log(`[staff-digest] ${slot} sent ${taskCount}`);
  return r.sent;
}

// ── 夕方の見回り ──

const JST_MS = 9 * 60 * 60 * 1000;
const EVE_HOUR = 17;
const jstDay = (ms: number) => new Date(ms + JST_MS).toISOString().slice(0, 10);
const jstHour = (ms: number) => new Date(ms + JST_MS).getUTCHours();

export interface EveningDeps extends DigestSendDeps {
  /** TASK_FOLLOWUP が on か */
  followup: boolean;
  /** その日の印を取る（SET NX）。すでにあれば false */
  claim(day: string): Promise<boolean>;
  /** 印を外す（送る前に失敗したときだけ） */
  release(day: string): Promise<void>;
  /** 会社が休みの日か（休業日カレンダー。朝のリマインドと同じ決まり） */
  closedToday(day: string): Promise<boolean>;
  /** 朝のリマインドと同じ選び方で、いま未完了のタスクを引く */
  fetchTasks(): Promise<EveTask[]>;
  setNumber(id: string, n: number): Promise<void>;
}

/** 朝のリマインド（sendDailyReminders）と同じ引き方・同じ絞り方 */
async function fetchLikeMorning(): Promise<EveTask[]> {
  const followup = followupEnabled();
  const today = jstDay(Date.now());
  const { shown } = splitForGroup(await getUpcomingTasks({ followup }));
  return followup
    ? shown.filter((t) => shouldRemind(t, today, jstDay(Date.now() + 86_400_000), jstDay(Date.now() - 86_400_000)))
    : shown;
}

function realEveningDeps(): EveningDeps {
  return {
    ...realSendDeps,
    followup: followupEnabled(),
    claim: async (day) => (await kv.set(digestEveKey(day), 1, { nx: true, ex: EVE_MARK_TTL_SEC })) === "OK",
    release: async (day) => {
      await kv.del(digestEveKey(day));
    },
    // 引けないときは営業日として扱う（朝と同じ fail-open）
    closedToday: async (day) => closureOn(day, await loadClosures().catch(() => [])) !== null,
    fetchTasks: fetchLikeMorning,
    setNumber: setRemindNumber,
  };
}

export type EveningResult = "off" | "skip" | "taken" | "closed" | "empty" | "sent" | "failed";

/**
 * 毎分の見回りから呼ぶ。STAFF_DIGEST=1 で JST 17時台のとき、その日に1回だけ夕方のまとめを送る。
 * off・17時台以外は KV も Notion も触らない。印を先に取る（見回りが重なっても2通出さない）。
 * 朝に送っていない日（休業明けの初日など）でも送る。休業日は送らない。0件なら送らない。
 */
export async function runStaffDigestEveningOnTick(
  now: number,
  env: Env = process.env,
  deps?: EveningDeps
): Promise<EveningResult> {
  if (!staffDigestOn(env)) return "off";
  if (jstHour(now) !== EVE_HOUR) return "skip";
  const d = deps ?? realEveningDeps();
  const today = jstDay(now);
  const tomorrow = jstDay(now + 86_400_000);
  if (!(await d.claim(today))) return "taken";
  if (await d.closedToday(today)) {
    d.log("[staff-digest] eve closed");
    return "closed";
  }

  let chunks: Chunk[];
  let count: number;
  try {
    const all = await d.fetchTasks();
    const selected = selectEvening(all, today, tomorrow);
    if (selected.length === 0) {
      d.log("[staff-digest] eve empty");
      return "empty";
    }
    const { numbers, fresh } = assignEveningNumbers(selected, all);
    // 番号を Notion に書いてから送る（先に返信されても引けるように。朝と同じ順）
    await Promise.all(fresh.map((f) => d.setNumber(f.id, f.n)));
    const built = buildStaffDigest({ slot: "eve", tasks: selected, today, tomorrow, followup: d.followup, numbers });
    chunks = built.chunks;
    count = built.ordered.length;
  } catch (err) {
    // まだ何も送っていないので、印を外して次の見回りでやり直す（17時台のあいだ）
    const name = (err as { name?: unknown } | null)?.name;
    d.log(`[staff-digest] eve fetch-failed ${typeof name === "string" ? name : "Error"}`);
    await d.release(today).catch(() => undefined);
    return "failed";
  }

  // 送り始めたあとは印を残す（届いたか分からないものを送り直さない）
  return (await sendDigestChunks("eve", chunks, count, now, d)) > 0 ? "sent" : "failed";
}
