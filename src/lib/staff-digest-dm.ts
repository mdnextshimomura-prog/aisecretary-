/**
 * 担当へのまとめを、個人 LINE（1対1）へ先に送る（2026-11-28 下村さん決定）。スイッチは STAFF_DIGEST_DM=1（STAFF_DIGEST=1 のときだけ効く。既定 off）。
 *
 *   「5時の段階の個人アラートは、友達登録してくれてるこの担当者らの個人のLINEに送ってあげる。
 *     6時までに当日返信がなければ、グループLINEに張り出される」「朝は8時から個人、9時からグループ」
 *
 *   1. 朝8時・夕方17時のまとめ：担当者ID があり、秘書と友だちの担当には、その人の通を 1対1 へ送る（グループには出さない）。
 *      担当者ID の無い担当・友だちでない担当・担当の決まっていないものは、今までどおりグループへ。
 *      1対1 へ送れなかった・送れたか分からない人の分は、その場でグループへ回す（まとめを黙って失くさない）。
 *   2. 1時間後（朝は9時台・夕方は18時台）の毎分の見回り：1対1 へ送った分のうち、まだ返事の無いタスクだけを
 *      担当ごとに1通でグループへ張り出す（番号は同じ）。全員返事済みなら何も送らない。
 *   3. 担当の 1対1 の返事：送り主の制限の手前の細い口（staff-digest-dm-wire.ts の staffDmPassage）で、
 *      番号つきの返事だけを受ける。ほかの機能（タスクの登録・メニュー・メール・査定）へは渡さない。
 *
 * 1対1 の送り主の制限を通る人（下村さんなど許可リストの人）には個人あてにしない（今までどおりグループ）。
 * その人の 1対1 は今ある機能（メール・査定・担当に聞く）が使うので、まとめへの返事を混ぜない。
 *
 * ここは判断と文だけ（KV・LINE・Notion・名簿は渡してもらう）。本物へのつなぎは staff-digest-dm-wire.ts。
 * off のあいだは KV・LINE を1回も触らない。ログは符号と件数だけ（本文・題名・userId・groupId・messageId は出さない）。
 */
import {
  buildStaffDigest,
  digestMsgKey,
  digestNotionUrl,
  DIGEST_MSG_TTL_SEC,
  dmTextOf,
  sendDigestMessages,
  staffDigestOn,
  type DigestBuildCtx,
  type DigestMessage,
  type DigestMsgRow,
  type DigestSendDeps,
  type DigestSlot,
  type DigestTask,
} from "./staff-digest";
import type { Chunk } from "./chunk";
import {
  answeredKey,
  askListKey,
  freeTextOf,
  MSG_SD_NO_NUMBER,
  normalizeReplyLine,
  NOTION_EDIT_MARGIN_MS,
  parseProgressLine,
  type ReplyItem,
} from "./staff-digest-reply";

type Env = Record<string, string | undefined>;

export function staffDigestDmOn(env: Env = process.env): boolean {
  return staffDigestOn(env) && env.STAFF_DIGEST_DM === "1";
}

// ── KV（鍵は staffdigest:*） ──

/** その回に 1対1 へ送った担当の控え（day は JST の "YYYY-MM-DD"・slot は am|eve。2日）。値は DmRunRow[] */
export const dmRunKey = (day: string, slot: DigestSlot) => `staffdigest:dm:${day}:${slot}`;
/** その人に最後に送った 1対1 のまとめ（1対1 の返事の口が読む。36時間）。値は DmUserRec */
export const dmUserKey = (userId: string) => `staffdigest:dmuser:${userId}`;
/** 友だちかどうかの覚え（6時間。値は 1＝友だち・0＝友だちでない） */
export const dmFriendKey = (userId: string) => `staffdigest:friend:${userId}`;
/** 張り出しの「今日は済んだ」印（SET NX。2日） */
export const dmEscKey = (day: string, slot: DigestSlot) => `staffdigest:esc:${day}:${slot}`;
/** その日・その回の個人あてを始めた印（SET NX。2日。同じ日に朝の cron が2回動いても、個人あては1回だけ） */
export const dmSentKey = (day: string, slot: DigestSlot) => `staffdigest:dmsent:${day}:${slot}`;
/** 「このトークでは…」の案内を出した印（SET NX。1時間） */
export const dmNoticeKey = (userId: string) => `staffdigest:dmnote:${userId}`;

export const DM_RUN_TTL_SEC = 2 * 24 * 60 * 60;
export const DM_USER_TTL_SEC = 36 * 60 * 60;
export const DM_FRIEND_TTL_SEC = 6 * 60 * 60;
export const DM_NOTICE_TTL_SEC = 60 * 60;
const KV_WAIT_MS = 2_500;

const USER_RE = /^U[0-9a-f]{32}$/;
const JST_MS = 9 * 60 * 60 * 1000;
const jstDay = (ms: number) => new Date(ms + JST_MS).toISOString().slice(0, 10);
const jstHour = (ms: number) => new Date(ms + JST_MS).getUTCHours();
/** Notion のページ ID はハイフンの有無がゆれるので、比べるときは外す */
export const pageKey = (id: string) => id.replace(/-/g, "").toLowerCase();

/** 時間切れなら TimeoutError で投げる（待っていた処理は止めないが、結果は使わない） */
function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error("timeout");
      e.name = "TimeoutError";
      reject(e);
    }, Math.max(0, ms));
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** 1対1 へ送ったタスク1件（張り出しの判定に、送ったときの状態と期日を持つ。題名は持たない） */
export interface DmTaskRef {
  id: string;
  n: number;
  status: string;
  /** 期日（"YYYY-MM-DD"。無ければ ""） */
  due: string;
}
export interface DmRunRow {
  uid: string;
  /** 担当の名前（タスクの担当欄。無ければ null） */
  name: string | null;
  nums: number[];
  /** nums と同じ並びのページ ID */
  taskIds: string[];
  tasks: DmTaskRef[];
  /** 送った時刻（ミリ秒） */
  at: number;
}
export interface DmUserRec {
  date: string;
  slot: DigestSlot;
  nums: number[];
  /** nums と同じ並びのページ ID（番号が次の朝に振り直されたあと、別のタスクに当てないため） */
  taskIds: string[];
  at: number;
}

const isNums = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 99);
const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);
const unjson = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

export function asDmRunRows(v: unknown): DmRunRow[] {
  const list = unjson(v);
  if (!Array.isArray(list)) return [];
  const out: DmRunRow[] = [];
  for (const raw of list) {
    const r = raw as Partial<DmRunRow> | null;
    if (!r || typeof r !== "object" || typeof r.uid !== "string" || !USER_RE.test(r.uid) || typeof r.at !== "number" || !Array.isArray(r.tasks)) continue;
    const tasks = r.tasks.filter(
      (t): t is DmTaskRef =>
        Boolean(t) && typeof t.id === "string" && Boolean(t.id) && typeof t.n === "number" && typeof t.status === "string" && typeof t.due === "string"
    );
    if (tasks.length === 0) continue;
    out.push({ uid: r.uid, name: typeof r.name === "string" && r.name ? r.name : null, nums: tasks.map((t) => t.n), taskIds: tasks.map((t) => t.id), tasks, at: r.at });
  }
  return out;
}

export function asDmUserRec(v: unknown): DmUserRec | null {
  const r = unjson(v) as Partial<DmUserRec> | null;
  if (!r || typeof r !== "object") return null;
  if (typeof r.date !== "string" || (r.slot !== "am" && r.slot !== "eve") || typeof r.at !== "number") return null;
  if (!isNums(r.nums) || !isIds(r.taskIds) || r.nums.length !== r.taskIds.length || r.nums.length === 0) return null;
  return { date: r.date, slot: r.slot, nums: r.nums, taskIds: r.taskIds, at: r.at };
}

// ── 1. 送る（朝・夕方の共通） ──

export interface DmKv {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, exSeconds: number): Promise<void>;
  /** SET NX。取れたら true */
  setNx(key: string, value: unknown, exSeconds: number): Promise<boolean>;
  del(key: string): Promise<void>;
}

export interface DmSendDeps extends DigestSendDeps {
  kv: DmKv;
  /** 1対1 の送り主の制限を通る人か（下村さんなど。その人には個人あてにしない＝今までどおりグループ） */
  allowListed(userId: string): boolean;
  /**
   * 友だちか（LINE の GET /v2/bot/profile/{userId}）。200＝true、404＝false、ほか・時間切れ＝null（分からない）。
   * プロフィールの中身は読まない・残さない
   */
  profile(userId: string): Promise<boolean | null>;
  /** 1対1 へ retry key つきで文字を送る（key は retry key の元になる文字列）。HTTP の状態（結果不明は null）と送れたメッセージの ID */
  pushUser(userId: string, texts: string[], key: string): Promise<{ status: number | null; ids: string[] }>;
  /** 個人あての分に使ってよい時間。省けば 12 秒（テスト用） */
  budgetMs?: number;
}

const sentOk = (status: number | null) => status !== null && ((status >= 200 && status < 300) || status === 409);

/** 個人あての分（友だちの確認・控え・1対1 の push）に使ってよい時間の合計。過ぎたら、まだ送っていない人は今回はグループへ */
export const DM_PHASE_BUDGET_MS = 12_000;
const FRIEND_CAP_MS = 4_000;
const PUSH_CAP_MS = 6_000;
const SAVE_CAP_MS = 3_000;

/** 友だちか（KV の覚えが先。はっきり分かった答えだけ6時間覚える。分からないときは「友だちでない」＝グループへ） */
async function isFriend(uid: string, deps: DmSendDeps): Promise<boolean> {
  try {
    const hit = await deps.kv.get(dmFriendKey(uid));
    if (hit === 1 || hit === "1") return true;
    if (hit === 0 || hit === "0") return false;
  } catch {
    // 覚えが読めない：LINE に聞く
  }
  let ans: boolean | null = null;
  try {
    ans = await deps.profile(uid);
  } catch {
    ans = null;
  }
  if (ans === null) return false;
  // 覚えるのは待たない（書けなくても、次の回にもう一度聞くだけ）
  void deps.kv.set(dmFriendKey(uid), ans ? 1 : 0, DM_FRIEND_TTL_SEC).catch(() => undefined);
  return ans;
}

/**
 * まとめ（担当ごとの通）を送る。友だちの担当のタスクは 1対1 へ、ほかはグループへ（今の sendDigestMessages）。送れた通数を返す。
 *   ・1対1 に載せるのは、そのタスク自身の担当者ID がその人のものだけ（同じ名前でも、担当者ID の無いタスク・別のアカウントのタスクは
 *     今までどおりグループの通に残す＝1人に 1対1 とグループの通の両方が出ることがある）
 *   ・その日・その回の個人あては1回だけ（印 staffdigest:dmsent:<日付>:<slot>。朝の cron が2回動いた日の2回目は、
 *     個人あてにせず控えも書き直さない＝全部グループへ）
 *   ・控え（その回の一覧 staffdigest:dm:<日付>:<slot>・その人の staffdigest:dmuser:<userId>）を書いてから 1対1 へ送る
 *     （書けなければ、その人の分はグループへ。送ったのに張り出し・返事の口が動かない、を作らない）
 *   ・1対1 は retry key つき。はっきり断られた・結果が分からない人の分は、同じ回のうちにグループへ回す
 *     （まれに個人とグループの両方に出る。黙って失くすよりよい）
 *   ・個人あての分は合わせて12秒まで（友だちの確認4秒・控え・push 6秒）。過ぎたら、まだ送っていない人は今回はグループへ
 *   ・グループへの送信を先に済ませ、メッセージ ID の控え・一覧の書き直しは最後（途中で切られても、失うのは控えだけ）
 * 例外は投げない（途中で失敗したら、まだ 1対1 に届いたと分かっていない分をグループへ送る）。
 */
export async function sendDigestWithDm<T extends DigestTask>(
  slot: DigestSlot,
  ctx: DigestBuildCtx,
  messages: DigestMessage[],
  ordered: Array<{ task: T; n: number }>,
  now: number,
  deps: DmSendDeps
): Promise<number> {
  const day = ctx.today;
  const started = Date.now();
  const left = () => (deps.budgetMs ?? DM_PHASE_BUDGET_MS) - (Date.now() - started);
  const numbers = new Map(ordered.map((o) => [o.task.id, o.n]));
  const rebuild = (tasks: T[]) => buildStaffDigest({ slot, tasks, today: ctx.today, tomorrow: ctx.tomorrow, followup: ctx.followup, numbers, notionUrl: ctx.notionUrl }).messages;
  type Plan = { uid: string; texts: string[]; nums: number[][]; row: DmRunRow };
  const delivered: Plan[] = [];
  const msgRows: DigestMsgRow[] = [];
  let listed: Plan[] = [];
  let fallback = 0;
  try {
    // その人自身の担当者ID が付いたタスクだけを、その人の 1対1 に載せる
    const own = new Map<string, Array<{ task: T; n: number }>>();
    for (const o of ordered) {
      const uid = o.task.assigneeUserId;
      if (!uid || !USER_RE.test(uid) || deps.allowListed(uid)) continue;
      own.set(uid, [...(own.get(uid) ?? []), o]);
    }
    const plans: Plan[] = [];
    for (const [uid, list] of Array.from(own)) {
      const msgs = rebuild(list.map((o) => o.task));
      const texts = msgs.map((m) => (m.uid === uid ? dmTextOf(m, slot) : null));
      if (msgs.length === 0 || msgs.length > 5 || texts.some((t) => t === null)) continue;
      const tasks: DmTaskRef[] = list.map((o) => ({ id: o.task.id, n: o.n, status: o.task.status, due: (o.task.dueDate ?? "").slice(0, 10) }));
      plans.push({
        uid,
        texts: texts as string[],
        nums: msgs.map((m) => m.nums),
        row: { uid, name: list[0].task.assignee ?? null, nums: tasks.map((t) => t.n), taskIds: tasks.map((t) => t.id), tasks, at: now },
      });
    }

    let ready: Plan[] = [];
    // その日・その回の個人あては1回だけ（2回目の実行は、個人あてにせず控えも書き直さない）
    const first = plans.length > 0 && (await bounded(deps.kv.setNx(dmSentKey(day, slot), 1, DM_RUN_TTL_SEC), KV_WAIT_MS).catch(() => false));
    if (plans.length > 0 && !first) deps.log("[staff-digest] dm skip:already");
    if (first) {
      const friendly = (
        await Promise.all(plans.map((p) => bounded(isFriend(p.uid, deps), Math.min(FRIEND_CAP_MS, left())).then((ok) => (ok ? p : null), () => null)))
      ).filter((p): p is Plan => p !== null);
      if (friendly.length > 0 && left() > 2_000) {
        // 控えを先に書く。その回の一覧が書けなければ、誰にも個人あてにしない（全部グループへ）
        const wait = Math.min(KV_WAIT_MS, left());
        const [ok, ...users] = await Promise.all([
          bounded(deps.kv.set(dmRunKey(day, slot), friendly.map((p) => p.row), DM_RUN_TTL_SEC), wait).then(() => true, () => false),
          ...friendly.map((p) => {
            const rec: DmUserRec = { date: day, slot, nums: p.row.nums, taskIds: p.row.taskIds, at: now };
            return bounded(deps.kv.set(dmUserKey(p.uid), rec, DM_USER_TTL_SEC), wait).then(() => true, () => false);
          }),
        ]);
        if (!ok) deps.log("[staff-digest] dm record-failed");
        else {
          listed = friendly;
          ready = friendly.filter((_, i) => users[i]);
        }
      } else if (friendly.length > 0) deps.log("[staff-digest] dm out-of-time");
    }
    if (ready.length > 0 && left() <= 1_000) {
      deps.log("[staff-digest] dm out-of-time");
      ready = [];
    }
    const cap = Math.min(PUSH_CAP_MS, left());
    const results = await Promise.all(
      ready.map(async (p) => {
        const r = await bounded(deps.pushUser(p.uid, p.texts, `sd-dm:${day}:${slot}:${p.uid}`), cap).catch(() => ({ status: null as number | null, ids: [] as string[] }));
        return { p, r };
      })
    );
    for (const { p, r } of results) {
      if (!sentOk(r.status)) continue;
      delivered.push(p);
      // 応答の並びで通と ID を合わせる（数が合わないとき・409 のときは控えない）
      if (r.ids.length === p.nums.length) p.nums.forEach((nums, i) => msgRows.push({ id: r.ids[i], nums, uid: p.uid }));
    }
    fallback = ready.length - delivered.length;
  } catch {
    deps.log("[staff-digest] dm error");
  }

  // グループへ：1対1 に届いた番号を除いた通（1件も除かれなかった通は、元の文のまま）。順は元のまま
  const byNum = new Map(ordered.map((o) => [o.n, o.task]));
  const viaDm = new Set(delivered.flatMap((p) => p.row.nums));
  const rest: DigestMessage[] = [];
  for (const m of messages) {
    if (!m.nums.some((x) => viaDm.has(x))) {
      rest.push(m);
      continue;
    }
    const keep = m.nums.filter((x) => !viaDm.has(x)).map((x) => byNum.get(x)).filter((t): t is T => Boolean(t));
    if (keep.length > 0) rest.push(...rebuild(keep));
  }
  let groupSent = 0;
  if (rest.length > 0) {
    groupSent = await sendDigestMessages(slot, rest, rest.reduce((a, m) => a + m.nums.length, 0), now, deps).catch(() => 0);
  }
  deps.log(`[staff-digest] dm sent ${delivered.length} group ${groupSent}`);
  if (fallback > 0) deps.log(`[staff-digest] dm fallback ${fallback}`);

  // ここから先は控えだけ（途中で切られても、まとめは届いている）。まとめて書き、合わせて3秒まで
  const tail: Array<Promise<void>> = msgRows.map((r) => deps.kv.set(digestMsgKey(r.id), { at: now, slot, nums: r.nums, uid: r.uid, dm: true }, DIGEST_MSG_TTL_SEC));
  // その回の一覧を、実際に 1対1 へ送れた人だけに書き直す（グループへ回した人を、1時間後にもう一度張り出さない）
  if (listed.length > 0 && delivered.length < listed.length) {
    tail.push(delivered.length > 0 ? deps.kv.set(dmRunKey(day, slot), delivered.map((p) => p.row), DM_RUN_TTL_SEC) : deps.kv.del(dmRunKey(day, slot)));
  }
  if (tail.length > 0) {
    await bounded(Promise.all(tail), SAVE_CAP_MS).catch(() => deps.log("[staff-digest] dm ids-save-failed"));
  }
  return delivered.length + groupSent;
}

// ── 2. 1時間後の張り出し ──

export const ESC_ASK = "進捗の確認です（個人 LINE に返事がなかった分）。どうなりましたか？";
/** 張り出す時刻（JST の時）。朝のまとめは9時台、夕方のまとめは18時台 */
const ESC_HOUR: Record<DigestSlot, number> = { am: 9, eve: 18 };
/**
 * 個人あてに送ってから張り出すまでに空ける最短の時間。
 * 朝のまとめは Vercel の cron（8時台のどこかで動く）が送るので、8:55 に届いて 9:00 に張り出す、を避ける
 */
export const ESC_MIN_WAIT_MS = 30 * 60 * 1000;
/** 送る前の準備（一覧・印・休業日・タスク・返事の印）の上限。毎分の見回りの 60 秒に収めるため短くしてある */
const ESC_BUDGET_MS = 12_000;

export type EscTask = DigestTask & { lastEdited?: string; nextCheck?: string | null };

export interface EscDeps extends Omit<DigestSendDeps, "push"> {
  /**
   * グループへ順に送る（5通までを1回の push）。送れた通数・渡した順のメッセージ ID に加えて、
   * 結果の分からなかった通数（時間切れ・5xx。無ければ 0）を返す
   */
  push(chunks: Chunk[], key: string): Promise<{ sent: number; ids: Array<string | null>; unknown?: number }>;
  /** TASK_FOLLOWUP が on か */
  followup: boolean;
  kv: {
    get(key: string): Promise<unknown>;
    setNx(key: string, value: unknown, exSeconds: number): Promise<boolean>;
    del(key: string): Promise<void>;
    smembers(key: string): Promise<string[]>;
    lrange?(key: string, start: number, stop: number): Promise<unknown[]>;
  };
  /** 会社が休みの日か（朝・夕方のまとめと同じ決まり） */
  closedToday(day: string): Promise<boolean>;
  /** 朝のリマインドと同じ引き方・絞り方で、いま未完了のタスクを引く */
  fetchTasks(): Promise<EscTask[]>;
  /** 送る前の準備に使ってよい時間。省けば 25 秒（テスト用） */
  budgetMs?: number;
}

export type EscResult = "off" | "skip" | "none" | "wait" | "taken" | "closed" | "empty" | "sent" | "failed";

/**
 * 1対1 へ送った分のうち、まだ返事の無いタスク。返事ありと見るもの：
 *   ・いまの未完了の一覧に無い（完了・不要・待ちで確認日が先）／担当が替わった
 *   ・返事の印（staffdigest:answered:<日付>。1対1・グループの番号や引用の返事）がある
 *   ・状態か期日が、送ったときから変わった
 *   ・「次に確認する日」が先
 *   ・Notion のページの最終更新が「送った時刻（その日に担当に聞いていれば、最後に聞いた時刻）＋3分」より後
 */
export function unansweredOf<T extends EscTask>(
  row: DmRunRow,
  current: Map<string, T>,
  answered: Set<string>,
  today: string,
  lastAskAt: Map<string, number> = new Map()
): Array<{ task: T; n: number }> {
  const out: Array<{ task: T; n: number }> = [];
  for (const ref of row.tasks) {
    const key = pageKey(ref.id);
    // 控えたタスクの ID で見る（担当者ID を引き直して比べない＝1対1 に載せたタスクは、返事が無ければ必ず張り出す）
    const c = current.get(key);
    if (!c) continue;
    if (answered.has(key)) continue;
    if (c.status !== ref.status || (c.dueDate ?? "").slice(0, 10) !== ref.due) continue;
    const check = c.nextCheck ? c.nextCheck.slice(0, 10) : "";
    if (check && check > today) continue;
    const edited = Date.parse(c.lastEdited ?? "");
    if (!Number.isNaN(edited) && edited > Math.max(row.at, lastAskAt.get(key) ?? 0) + NOTION_EDIT_MARGIN_MS) continue;
    out.push({ task: c, n: ref.n });
  }
  return out;
}

/**
 * 毎分の見回りから呼ぶ。STAFF_DIGEST_DM=1 で JST 9時台（朝の分）・18時台（夕方の分）のとき、その日に1回だけ、
 * 1対1 へ送って返事の無い分を担当ごとに1通でグループへ張り出す。
 * off・その時間以外は KV も Notion も触らない。その回に 1対1 へ送った人がいなければ印も取らない。
 * 印を取ったあとの準備には時間の上限を付け、送る前に失敗したら印を外してやり直す。送り始めたあとは送り直さない。
 */
export async function runDmEscalationOnTick(now: number, env: Env, deps: EscDeps): Promise<EscResult> {
  if (!staffDigestDmOn(env)) return "off";
  const hour = jstHour(now);
  const slot: DigestSlot | null = hour === ESC_HOUR.am ? "am" : hour === ESC_HOUR.eve ? "eve" : null;
  if (!slot) return "skip";
  const today = jstDay(now);
  const tomorrow = jstDay(now + 86_400_000);
  const started = Date.now();
  const budget = deps.budgetMs ?? ESC_BUDGET_MS;
  const left = () => budget - (Date.now() - started);
  let rows: DmRunRow[];
  try {
    rows = asDmRunRows(await bounded(deps.kv.get(dmRunKey(today, slot)), KV_WAIT_MS));
  } catch {
    deps.log(`[staff-digest] esc ${slot} kv-failed`);
    return "failed";
  }
  if (rows.length === 0) return "none";
  if (now < Math.max(...rows.map((r) => r.at)) + ESC_MIN_WAIT_MS) return "wait";

  try {
    if (!(await bounded(deps.kv.setNx(dmEscKey(today, slot), 1, DM_RUN_TTL_SEC), KV_WAIT_MS))) return "taken";
  } catch {
    deps.log(`[staff-digest] esc ${slot} kv-failed`);
    return "failed";
  }

  let out: DigestMessage[];
  try {
    if (await bounded(deps.closedToday(today), left())) {
      deps.log(`[staff-digest] esc ${slot} closed`);
      return "closed";
    }
    const current = new Map((await bounded(deps.fetchTasks(), left())).map((t) => [pageKey(t.id), t]));
    const answered = new Set((await bounded(deps.kv.smembers(answeredKey(today)), Math.min(left(), KV_WAIT_MS))).map(pageKey));
    // その日に担当に聞いた件（聞いたときに秘書が Notion へ「質問」を書くので、その分を「Notion で更新」と数えない）。読めなければ無いものとして続ける
    const lastAskAt = new Map<string, number>();
    if (deps.kv.lrange) {
      const asks = await bounded(deps.kv.lrange(askListKey(today), 0, -1), Math.min(left(), KV_WAIT_MS)).catch(() => [] as unknown[]);
      for (const raw of asks) {
        const a = unjson(raw) as { taskId?: unknown; at?: unknown } | null;
        if (a && typeof a.taskId === "string" && typeof a.at === "number") lastAskAt.set(pageKey(a.taskId), Math.max(lastAskAt.get(pageKey(a.taskId)) ?? 0, a.at));
      }
    }
    out = [];
    for (const row of rows) {
      const open = unansweredOf(row, current, answered, today, lastAskAt);
      if (open.length === 0) continue;
      const built = buildStaffDigest({
        slot,
        // 1対1 を送った相手にメンションする（そのあと担当が替わっていても、返事を待っているのはその人）
        tasks: open.map((o) => ({ ...o.task, assignee: row.name ?? o.task.assignee, assigneeUserId: row.uid })),
        today,
        tomorrow,
        followup: deps.followup,
        numbers: new Map(open.map((o) => [o.task.id, o.n])),
        notionUrl: digestNotionUrl(env),
        ask: ESC_ASK,
      });
      out.push(...built.messages);
    }
  } catch (err) {
    // まだ何も送っていないので、印を外して次の見回りでやり直す（その時間のあいだ）
    const name = (err as { name?: unknown } | null)?.name;
    deps.log(`[staff-digest] esc ${slot} fetch-failed ${typeof name === "string" ? name : "Error"}`);
    await bounded(deps.kv.del(dmEscKey(today, slot)), 3_000).catch(() => undefined);
    return "failed";
  }
  if (out.length === 0) {
    deps.log(`[staff-digest] esc ${slot} empty`);
    return "empty";
  }

  // 送り始めたあとは印を残す（届いたか分からないものを送り直さない）
  const r = await deps
    .push(out.map((m) => m.chunk), `sd-esc:${today}:${slot}`)
    .catch(() => ({ sent: 0, ids: [] as Array<string | null>, unknown: out.length }));
  if (r.sent === 0) {
    // 全部はっきり断られた（届いた・届いたかもしれない通が無い）ときだけ、印を外して次の見回りでやり直す
    if ((r.unknown ?? 0) === 0) {
      await bounded(deps.kv.del(dmEscKey(today, slot)), 3_000).catch(() => undefined);
      deps.log(`[staff-digest] esc ${slot} push-rejected`);
      return "failed";
    }
    deps.log(`[staff-digest] esc ${slot} push-failed`);
    return "failed";
  }
  const saved: DigestMsgRow[] = [];
  out.forEach((m, i) => {
    const id = r.ids[i];
    if (typeof id === "string" && id) saved.push({ id, nums: m.nums, uid: m.uid });
  });
  await bounded(deps.saveMsgs(saved, `${slot}-esc`, now), SAVE_CAP_MS).catch(() => deps.log(`[staff-digest] esc ${slot} ids-save-failed`));
  if (r.sent < out.length) deps.log(`[staff-digest] esc ${slot} push-partial ${r.sent}/${out.length}`);
  deps.log(`[staff-digest] esc ${slot} sent ${r.sent}`);
  return "sent";
}

// ── 3. 担当の 1対1 の返事 ──

/** 番号の無い文を受ける時間（1対1 のまとめを送ってから） */
export const DM_FREE_TEXT_WINDOW_MS = 3 * 60 * 60 * 1000;
export const MSG_DM_FOREIGN = "その番号は、あなたあての確認にはありません";
export const MSG_DM_ONLY = "このトークでは、進捗の確認への返事だけ受け付けています。番号をつけて返信してください（例：「1済」）";

// ほかの機能への指示に見える1通（# で始まる・決まった言葉だけ）。返事としては受けない
const DM_COMMAND_RE = /^(送信|送って|キャンセル|メニュー|候補|案件|案件一覧|やめる|やめます|中止|ヘルプ|help)[。.!！\s]*$/i;

export interface DmReplyDeps {
  now(): number;
  /** 今の言葉（済・完了・待ち・延期・不要）として読める行か。副作用なし */
  isKnown(line: string): boolean;
  /** ほかの機能の言葉（候補への「1 登録」「2 なし」）の行か */
  isOther(line: string): boolean;
  /** 今の言葉の行の番号（「1,2完了」→ [1,2]） */
  numbersOf(line: string): number[];
  /** 今の言葉の行を、グループの返事と同じ処理で実行する */
  runKnown(line: string): Promise<{ text: string; changed: ReplyItem[] }>;
  findByNumber(n: number): Promise<{ id: string; title: string } | null>;
  appendNote(pageId: string, lines: string[]): Promise<void>;
  /** 名簿の名前。分からなければ null */
  senderName(): Promise<string | null>;
  /** replyToken で文字を返す */
  reply(text: string): Promise<void>;
  /** 動いたタスクを控える（返事の印 staffdigest:answered・下村さんへの知らせの列）。グループの返事と同じ */
  note(items: ReplyItem[], name: string | null): Promise<void>;
  /**
   * この1通が、その人あての 1対1 のまとめを引用しているか。していれば、その通に載せた番号（していなければ null）。
   * 番号の無い文を受けるかどうかを決めるときだけ呼ぶ
   */
  quotedNums?(): Promise<number[] | null>;
  /** 「このトークでは…」の案内を出してよいか（1時間に1回。SET NX が取れたら true） */
  noticeOnce(): Promise<boolean>;
  log(line: string): void;
}

type DmEntry = { kind: "known"; raw: string; numbers: number[] } | { kind: "progress"; numbers: number[]; body: string };

const mdOf = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const cut = (s: string, n: number) => {
  const a = Array.from(s);
  return a.length > n ? `${a.slice(0, n - 1).join("")}…` : s;
};

/**
 * 番号つきの返事として読む（行ごと）。先頭の行が番号で始まらなければ null（＝番号の無い文として読む）。
 * 番号で始まらない行は直前の進捗の続き（今の言葉の行のあとの、番号の無い行は読み飛ばす）。
 */
function parseDmLines(text: string, deps: Pick<DmReplyDeps, "isKnown" | "numbersOf">): DmEntry[] | null {
  const lines = text.split(/\r?\n/).map(normalizeReplyLine).filter((l) => l.length > 0);
  const entries: DmEntry[] = [];
  for (const line of lines) {
    if (deps.isKnown(line)) {
      entries.push({ kind: "known", raw: line, numbers: deps.numbersOf(line) });
      continue;
    }
    const p = parseProgressLine(line);
    if (p) {
      entries.push({ kind: "progress", ...p });
      continue;
    }
    const last = entries[entries.length - 1];
    if (!last) return null;
    if (last.kind === "progress") last.body = cut(`${last.body} ${line}`, 1500);
  }
  return entries.length > 0 ? entries : null;
}

/**
 * 担当の 1対1 の1通（その人に 1対1 のまとめの控え rec があるときだけ呼ぶ）。ここで終わりにする（ほかの機能へは渡さない）。
 *   ・「1済」「1待ち …」「1延期 …」「1不要」「1 自由な文」→ グループの返事と同じ処理（番号は、その人あての番号だけ）
 *   ・番号の無い文 → その人あてのタスクが1件ならそのタスク。2件以上なら番号を聞き返す
 *   ・ほか（文字でない・ほかの機能の言葉・あいづち・絵文字だけ）→ 1時間に1回だけ案内、あとは黙る
 * タスクの登録・メニュー・カード・メール・査定は、ここからは動かさない。例外は投げない。
 */
export async function handleDmReply(input: { kind: "text" | "other"; text?: string }, rec: DmUserRec, deps: DmReplyDeps): Promise<void> {
  const say = (text: string) => deps.reply(text).catch(() => deps.log("[staff-digest] dm reply send-failed"));
  const notice = async (code: string) => {
    const ok = await deps.noticeOnce().catch(() => false);
    if (ok) await say(MSG_DM_ONLY);
    deps.log(`[staff-digest] dm reply ${code}${ok ? "" : " quiet"}`);
  };
  try {
    const text = input.kind === "text" ? (input.text ?? "") : "";
    const lines = text.split(/\r?\n/).map(normalizeReplyLine).filter((l) => l.length > 0);
    if (input.kind !== "text" || lines.length === 0) return await notice("other");
    if (lines.some((l) => l.startsWith("#") || l.startsWith("＃") || DM_COMMAND_RE.test(l) || deps.isOther(l))) return await notice("command");

    let entries = parseDmLines(text, deps);
    if (!entries) {
      const free = freeTextOf({ text, hasMention: false }, deps.isKnown, deps.isOther);
      if (free === null) return await notice("chatter");
      // 番号の無い文を受けるのは、①その人あての 1対1 のまとめを引用した返信か、②そのまとめを送ってから3時間以内だけ
      // （控えは36時間生きるので、あとの雑談を進捗として Notion に書かないため）。ほかは案内（1時間に1回）
      const quoted = deps.quotedNums ? await deps.quotedNums().catch(() => null) : null;
      if (!quoted && deps.now() - rec.at > DM_FREE_TEXT_WINDOW_MS) return await notice("late");
      // どのタスクか：引用した通に載せた番号が1件ならそれ。そうでなければ、その人あてのタスクが1件のときだけ
      const target = quoted && quoted.length === 1 && rec.nums.includes(quoted[0]) ? quoted[0] : rec.nums.length === 1 ? rec.nums[0] : null;
      if (target === null) {
        await say(MSG_SD_NO_NUMBER);
        deps.log("[staff-digest] dm reply no-number");
        return;
      }
      // 1件だけ：その番号を付けた返事として読む（「済」→ 完了、「待ち …」→ 状況の言葉、ほかは進捗）
      const n = target;
      const synth = `${n} ${free}`;
      entries = deps.isKnown(synth) ? [{ kind: "known", raw: synth, numbers: [n] }] : [{ kind: "progress", numbers: [n], body: free }];
    }

    const mine = new Set(rec.nums);
    const name = await deps.senderName().catch(() => null);
    const stamp = `進捗（${mdOf(jstDay(deps.now()))} ${name || "担当"}）：`;
    const knownTexts: string[] = [];
    const changed: ReplyItem[] = [];
    const ok: number[] = [];
    const notFound: number[] = [];
    const failed: number[] = [];
    let knownFailed = 0;
    let foreign = 0;
    for (const e of entries) {
      // その人あての番号だけ。1つでも外の番号が混ざった行は、何もしない
      if (e.numbers.length === 0 || e.numbers.some((n) => !mine.has(n))) {
        foreign += 1;
        continue;
      }
      if (e.kind === "known") {
        try {
          const r = await deps.runKnown(e.raw);
          if (r.text) knownTexts.push(r.text);
          changed.push(...r.changed);
        } catch {
          knownFailed += 1;
        }
        continue;
      }
      for (const n of e.numbers) {
        try {
          const t = await deps.findByNumber(n);
          if (!t) {
            notFound.push(n);
            continue;
          }
          await deps.appendNote(t.id, [`${stamp}${e.body}`]);
          ok.push(n);
          changed.push({ id: t.id, title: t.title, what: `進捗「${cut(e.body, 60)}」` });
        } catch {
          failed.push(n);
        }
      }
    }

    const outLines: string[] = [];
    if (knownTexts.length > 0) outLines.push(knownTexts.join("\n\n"), "");
    if (ok.length > 0) outLines.push(`📝 ${ok.join("・")} の進捗を記録しました`);
    if (notFound.length > 0) outLines.push(`⚠️ ${notFound.join("・")}番は見つかりませんでした`, "（完了済みか、直近のまとめに無い番号です）");
    if (failed.length > 0) outLines.push(`⚠️ ${failed.join("・")} の進捗を書き込めませんでした。もう一度お試しください。`);
    if (knownFailed > 0) outLines.push("⚠️ 一部の返事を処理できませんでした。その分だけ、もう一度送ってください。");
    if (foreign > 0) outLines.push(MSG_DM_FOREIGN);
    await say(outLines.join("\n").trim());

    if (changed.length > 0) await deps.note(changed, name).catch(() => undefined);
    deps.log(
      `[staff-digest] dm reply progress ${ok.length} known ${knownTexts.length}` +
        (foreign > 0 ? ` foreign ${foreign}` : "") +
        (notFound.length > 0 ? ` not-found ${notFound.length}` : "") +
        (failed.length > 0 ? ` write-failed ${failed.length}` : "") +
        (knownFailed > 0 ? ` known-failed ${knownFailed}` : "")
    );
  } catch {
    deps.log("[staff-digest] dm reply error");
  }
}

/** 送り主の制限で断られた理由のうち、細い口を試すもの（1対1 で、許可リストに無い人） */
export function dmPassageCandidate(
  event: { type?: string; source?: { type?: string; userId?: string }; message?: { id?: string; type?: string } },
  gateReason: string,
  env: Env = process.env
): boolean {
  if (!staffDigestDmOn(env)) return false;
  if (gateReason !== "user-not-allowed" && gateReason !== "user-not-configured") return false;
  if (event.type !== "message" || !event.message?.id || event.source?.type !== "user") return false;
  return typeof event.source.userId === "string" && USER_RE.test(event.source.userId);
}
