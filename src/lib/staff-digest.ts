/**
 * 担当へのまとめ（段階2・2026-11-28 下村さん決定）。スイッチは STAFF_DIGEST=1（既定 off）。
 *
 * 朝8時のリマインドと夕方17時台の1回、会社グループへ「担当ごとの箇条書き」を文字だけで送る：
 *   ・担当1人につき1通（2026-11-28 下村さん「小笠原に送るやつは小笠原のまとめで1通」）。
 *     「{担当} 進捗の確認です。どうなりましたか？」＋その人の箇条書き＋返信の案内。担当の決まっていないものは最後に1通「どうしますか？」
 *   ・送信は、5通までを1回の push にまとめる（LINE の数え方では1回の push＝宛先1人につき1通）
 *   ・番号は全体の通し番号（今の「3済」「3待ち …」の返事がそのまま使える）
 * off のあいだ、送る文・KV・Notion・ログは足す前と同じ（remind.ts は今の文のまま。夕方は KV も読まない）。
 *
 * 夕方は Vercel の cron を増やさず、毎分の見回り /api/obi/cloud-tick に相乗りする（KV の印で1日1回）。
 * まとめのメッセージ ID は KV に控える（段階3 の「まとめを引用した返信」の照合に使う）。
 * ログは符号と件数だけ（本文・題名・userId・groupId・messageId は出さない）。
 */
import { kv } from "@vercel/kv";
import type { Chunk } from "./chunk";
import { STATUS_PENDING } from "./clarify";
import { closureOn, loadClosures } from "./closures";
import { pushChunksBatchedWithIds, sanitizeForTextV2 } from "./line";
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

const ASK: Record<DigestSlot, string> = {
  am: "進捗の確認です。どうなりましたか？",
  eve: "夕方の進捗の確認です。どうなりましたか？",
};
const UNASSIGNED_HEAD = "担当が決まっていないもの：どうしますか？";
const UNASSIGNED_FOOT = "どなたが進めるか、このメッセージに返信で教えてください";
// 5000が上限。メンションの展開で膨らむ余地を見て余裕を持たせる（chunk.ts と同じ）
const MAX_CHARS = 4200;

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

const NOTION_URL_MAX = 300;
/**
 * まとめの末尾に添える Notion のリンク（2026-11-28 下村さん「担当が書くのは Notion でいい。LINE だと埋もれる」）。
 *   ・STAFF_DIGEST_NOTION_URL があれば、https://www.notion.so/ か https://notion.so/ で始まるときだけ使う（ほかは無視）
 *   ・無ければ NOTION_DATABASE_ID（32桁の16進。ハイフン入りも可）から https://www.notion.so/<ID> を作る
 *   ・どちらも使えなければ null（＝リンクの行を足さない。文は足す前と同じ）
 * textV2 を壊さないよう { } ・空白を含むものは使わない。値はログに出さない。
 */
export function digestNotionUrl(env: Env = process.env): string | null {
  const raw = (env.STAFF_DIGEST_NOTION_URL ?? "").trim();
  if (raw) {
    const ok =
      (raw.startsWith("https://www.notion.so/") || raw.startsWith("https://notion.so/")) &&
      raw.length <= NOTION_URL_MAX &&
      !/[{}\s]/.test(raw);
    return ok ? raw : null;
  }
  const id = (env.NOTION_DATABASE_ID ?? "").trim().replace(/-/g, "");
  return /^[0-9a-fA-F]{32}$/.test(id) ? `https://www.notion.so/${id.toLowerCase()}` : null;
}
const notionLine = (url: string | null | undefined) => (url ? `\nくわしく書くときは Notion へ：${url}` : "");

/** 担当1人ぶんの返信の案内（人ごとに繰り返すので短く。例の番号は、その通に載せた番号を使う） */
function personFooter(nums: number[], followup: boolean): string {
  const a = nums[0];
  const b = nums[1] ?? nums[0];
  return (
    "このメッセージに返信（リプライ）で答えてください\n" +
    `例：「${a}済」「${b} アポ取れました。来週火曜です」` +
    (followup ? `「${b}待ち 売主の書類 金曜」` : "")
  );
}

/** まとめの1通（担当1人ぶん、または担当の決まっていないもの） */
export interface DigestMessage {
  chunk: Chunk;
  /** この通に載せたタスクの番号 */
  nums: number[];
  /** 誰あてか（担当の userId。名前だけの担当・担当なしは null） */
  uid: string | null;
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
  /** 各通の末尾に添える Notion のリンク（digestNotionUrl）。無ければ行を足さない */
  notionUrl?: string | null;
}

export interface DigestOutput<T extends DigestTask> {
  /** 担当ごとに1通（最初に出てきた順）。担当の決まっていないものは最後の1通。長すぎる人は見出しをくり返して分ける */
  messages: DigestMessage[];
  /** 本文に載せた順と、その番号 */
  ordered: Array<{ task: T; n: number }>;
}

/** まとめの文を組み立てる（純粋な関数。番号は全体の通し番号のまま、担当ごとに1通に分ける） */
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
  const messages: DigestMessage[] = [];
  // Notion のリンクの行（無ければ ""。長さは1通の上限の計算にも入れる）
  const link = notionLine(input.notionUrl);
  // 1人ぶんを1通に組む。4200字を超えるときだけ、見出しと案内をくり返して次の通に分ける
  const emit = (head: string, mentions: Record<string, string>, uid: string | null, list: T[], foot: (nums: number[]) => string) => {
    let lines: string[] = [];
    let nums: number[] = [];
    const flush = () => {
      if (nums.length === 0) return;
      messages.push({ chunk: { text: [head, ...lines, "", foot(nums)].join("\n"), mentions }, nums, uid });
      lines = [];
      nums = [];
    };
    for (const t of byNumber(list)) {
      const n = numbers?.get(t.id) ?? ordered.length + 1;
      ordered.push({ task: t, n });
      const line = taskLine(n, t, today, tomorrow, followup);
      const size = head.length + lines.reduce((a, l) => a + l.length + 1, 0) + line.length + 200 + link.length;
      if (nums.length > 0 && size > MAX_CHARS) flush();
      lines.push(line);
      nums.push(n);
    }
    flush();
  };

  for (const g of Array.from(groups.values())) {
    // userId が無い担当はメンションできないので名前で呼ぶ
    if (g.userId) emit(`{m1} ${ASK[slot]}`, { m1: g.userId }, g.userId, g.tasks, (nums) => personFooter(nums, followup) + link);
    else emit(`${sanitizeForTextV2(g.name ?? "")}さん ${ASK[slot]}`, {}, null, g.tasks, (nums) => personFooter(nums, followup) + link);
  }
  if (unassigned.length > 0) emit(UNASSIGNED_HEAD, {}, null, unassigned, () => UNASSIGNED_FOOT + link);

  return { messages, ordered };
}

// ── 夕方に出すもの・番号 ──

type EveTask = DigestTask & {
  remindNumber: number | null;
  /** ページの最終更新（Notion の last_edited_time）。段階3 の「Notion で更新＝返事あり」が読む。無くてもよい */
  lastEdited?: string;
};

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
  all: T[],
  /** 朝のまとめで使った、いちばん大きい番号（朝に載せて、そのあと待ち・延期で外れたタスクの番号と重ねないため） */
  floor: number = 0
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
  let next = Math.max(0, floor, ...all.map((t) => t.remindNumber ?? 0)) + 1;
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
/** 朝のまとめに出したタスクの控え（段階3 が書く。値は [{id, n, …}]。day は JST の "YYYY-MM-DD"） */
export const amKey = (day: string) => `staffdigest:am:${day}`;
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

/** 送れたまとめの1通（メッセージ ID・載せた番号・誰あてか） */
export interface DigestMsgRow {
  id: string;
  nums: number[];
  uid: string | null;
}

/** 送ったまとめを1通ずつ控える：staffdigest:msg:<id> = {at, slot, nums, uid}。無ければ KV を触らない */
export async function saveDigestMessages(
  rows: DigestMsgRow[],
  slot: DigestSlot,
  now: number,
  store: DigestMsgKv = realMsgKv
): Promise<void> {
  for (const r of rows) await store.set(digestMsgKey(r.id), { at: now, slot, nums: r.nums, uid: r.uid }, DIGEST_MSG_TTL_SEC);
}

// ── 送る ──

const LINE_GROUP_ID =
  process.env.LINE_GROUP_ID ?? "Cd5fda3261e9bdd012e598884b2e6a696";
/** まとめの送り先（段階3 の催促も同じグループへ出す） */
export const DIGEST_GROUP_ID = LINE_GROUP_ID;

export interface DigestSendDeps {
  /**
   * グループへ順に送る（5通までを1回の push にまとめる）。送れた通数と、渡した順のメッセージ ID
   * （送れなかった・分からなかった通は null）を返す
   */
  push(chunks: Chunk[]): Promise<{ sent: number; ids: Array<string | null> }>;
  saveMsgs(rows: DigestMsgRow[], slot: DigestSlot, now: number): Promise<void>;
  log(line: string): void;
}
/** まとめの送信は1回の push ごとにここまで（毎分の見回り・朝の cron を止めない） */
const DIGEST_PUSH_TIMEOUT_MS = 8_000;
const realSendDeps: DigestSendDeps = {
  push: (chunks) => pushChunksBatchedWithIds(LINE_GROUP_ID, chunks, DIGEST_PUSH_TIMEOUT_MS),
  saveMsgs: (rows, slot, now) => saveDigestMessages(rows, slot, now),
  log: (l) => console.log(l),
};

/**
 * まとめ（担当ごとの通）を送り、1通ずつ ID・番号を控える（朝・夕方の共通）。送れた通数を返す。
 * 控えられなくても投げない（まとめは届いている。段階3 の引用の照合ができなくなるだけ）。
 */
export async function sendDigestMessages(
  slot: DigestSlot,
  messages: DigestMessage[],
  taskCount: number,
  now: number,
  deps: DigestSendDeps = realSendDeps
): Promise<number> {
  const r = await deps.push(messages.map((m) => m.chunk));
  if (r.sent === 0) {
    deps.log(`[staff-digest] ${slot} push-failed`);
    return 0;
  }
  const rows: DigestMsgRow[] = [];
  messages.forEach((m, i) => {
    const id = r.ids[i];
    if (typeof id === "string" && id) rows.push({ id, nums: m.nums, uid: m.uid });
  });
  try {
    await deps.saveMsgs(rows, slot, now);
  } catch {
    deps.log(`[staff-digest] ${slot} ids-save-failed`);
  }
  // 一部の push だけ送れなかった（送り直さない。その担当の分は夕方・次の朝に出る）
  if (r.sent < messages.length) deps.log(`[staff-digest] ${slot} push-partial ${r.sent}/${messages.length}`);
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
  /**
   * 段階3：夕方のまとめを送る直前に1回（朝のまとめに返事の無いタスクを、下村さんへ［催促する］のカードで知らせる）。
   * all＝いま未完了のタスク（朝と同じ引き方）。無ければ何もしない。失敗しても夕方のまとめは送る
   */
  beforeSend?(day: string, all: EveTask[]): Promise<void>;
  /** 朝のまとめで使ったいちばん大きい番号（朝の控え staffdigest:am:<日付> から。無ければ 0） */
  morningMax?(day: string): Promise<number>;
  /** 送る前の準備（休業日・タスク・番号・催促のカード）に使ってよい時間。省けば 25 秒（テスト用） */
  budgetMs?: number;
}

/** 送る前の準備の上限。印を取ってから、ここまでに「送り始める」か「印を外す」 */
const PRE_SEND_BUDGET_MS = 25_000;

/** 時間切れなら TimeoutError で投げる（待っていた処理は止めないが、結果は使わない） */
function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error("timeout");
      e.name = "TimeoutError";
      reject(e);
    }, Math.max(0, ms));
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
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
    // 読み込みの輪を作らないよう、使うときに読む（staff-digest-reply-wire は このファイルを読む）
    beforeSend: async (day, all) => (await import("./staff-digest-reply-wire")).askNudgeBeforeEvening(day, all),
    morningMax: async (day) => {
      const v = await kv.get(amKey(day));
      if (!Array.isArray(v)) return 0;
      return Math.max(0, ...v.map((e) => (typeof (e as { n?: unknown } | null)?.n === "number" ? (e as { n: number }).n : 0)));
    },
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
  // 印を取ったあとの準備には時間の上限を付ける（見回りが途中で切られると、印だけ残ってその日は送られないため）。
  // 上限の 4/5 までに休業日・タスク・番号がそろわなければ印を外してやり直す。残りの 1/5 は催促のカード
  const started = Date.now();
  const budget = d.budgetMs ?? PRE_SEND_BUDGET_MS;
  const slice = Math.floor(budget / 5);
  const left = () => budget - (Date.now() - started);
  if (!(await d.claim(today))) return "taken";

  let messages: DigestMessage[];
  let count: number;
  let all: EveTask[];
  try {
    if (await bounded(d.closedToday(today), left() - slice)) {
      d.log("[staff-digest] eve closed");
      return "closed";
    }
    all = await bounded(d.fetchTasks(), left() - slice);
    const selected = selectEvening(all, today, tomorrow);
    if (selected.length === 0) {
      d.log("[staff-digest] eve empty");
      return "empty";
    }
    // 朝の控えが読めなければ 0（＝引いてきたタスクの番号だけで決める。足す前と同じ）
    const floor = d.morningMax ? await bounded(d.morningMax(today), left() - slice).catch(() => 0) : 0;
    const { numbers, fresh } = assignEveningNumbers(selected, all, floor);
    // 番号を Notion に書いてから送る（先に返信されても引けるように。朝と同じ順）
    await bounded(Promise.all(fresh.map((f) => d.setNumber(f.id, f.n))), left() - slice);
    const built = buildStaffDigest({ slot: "eve", tasks: selected, today, tomorrow, followup: d.followup, numbers, notionUrl: digestNotionUrl(env) });
    messages = built.messages;
    count = built.ordered.length;
  } catch (err) {
    // まだ何も送っていないので、印を外して次の見回りでやり直す（17時台のあいだ）
    const name = (err as { name?: unknown } | null)?.name;
    d.log(`[staff-digest] eve fetch-failed ${typeof name === "string" ? name : "Error"}`);
    await bounded(d.release(today), 3_000).catch(() => undefined);
    return "failed";
  }

  // 段階3：夕方のまとめの前に、朝のまとめに返事の無いタスクを下村さんへ知らせる（失敗しても夕方のまとめは送る）
  // 時間がかかりすぎたら待つのをやめて、夕方のまとめを送る
  if (d.beforeSend) {
    await bounded(d.beforeSend(today, all), Math.max(1_000, Math.min(slice, left()))).catch(() =>
      d.log("[staff-digest] nudge ask-failed")
    );
  }

  // 送り始めたあとは印を残す（届いたか分からないものを送り直さない）
  return (await sendDigestMessages("eve", messages, count, now, d)) > 0 ? "sent" : "failed";
}
