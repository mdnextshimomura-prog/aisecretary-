/**
 * タスクの候補の置き場（Vercel KV）。Notion には入れない（台帳を荒らさないため）。
 *
 * 置き方は2つある。どちらを使うかは TASK_MENU（menuActive）で決める。
 *
 * ■ TASK_MENU off（今までの形。1バイトも変えていない）
 *   taskcand:items     … まだ聞いていない分も含む、控えている候補の一覧
 *   taskcand:numbered  … 最後に聞いたときの番号つきの一覧（番号 n は [n-1]。片付いた番号は null）
 *   taskcand:asked:<日付> … その日の分を聞いたか（17 時台に 1 回だけ聞くための印）
 *   一覧は丸ごと読み書きする（同時に 2 件届くと片方が消えうる）。
 *
 * ■ TASK_MENU on（B1 Task 2・1件ずつのキー。全置換をやめた）
 *   taskcand:c:<id>         … 候補1件の中身（期限 5 日）
 *   taskcand:index          … 候補の目次（集合。要素は "c:<id>"。sadd/srem で足し引きする＝原子的）
 *                             ※ id は LINE のメッセージ ID（数字だけ）。そのまま入れると KV の読み出しで数に
 *                               戻って桁が落ちるので、頭に "c:" を付ける
 *   taskcand:num:<groupId>  … グループごとの番号の並び（id の配列。片付いた番号は null）。
 *                             番号を振る（聞く・一覧を出す）ときだけ書く。片付けるときは書かない
 *                             （中身のキーが消えれば、その番号は自然に空く）
 *   taskcand:hold:<id>      … 保留の印（次の 17 時まで出さない。値はその時刻のミリ秒）
 *   taskcand:reg:<id>       … 登録の予約（SET NX・5 分。［登録する］の二重押しで2回登録しない）
 *   taskcand:asked:<日付>[:<groupId>] … 17 時に聞いた印（営業部は今までと同じキー）
 *   古い形（taskcand:items・taskcand:numbered）が残っていれば、読むときに新しい形へ移す
 *   （営業部の番号もそのまま引き継ぐ）。移したら古いキーは消す。
 *
 * KV が未設定の環境（テスト・ローカル）では、同じインスタンスの中だけのメモリに置く。
 * TASK_MENU on で KV の設定が片方だけ（URL か TOKEN のどちらかだけ）のときは、候補を控えない
 * （インスタンスごとのメモリに散らばらせない。ログに符号だけ出す）。
 */
import { kv } from "@vercel/kv";
import {
  CANDIDATE_TTL_MS,
  pruneExpired,
  type Candidate,
} from "./task-candidate";
import { menuActive } from "./task-menu";

const ITEMS_KEY = "taskcand:items";
const NUMBERED_KEY = "taskcand:numbered";
const ASKED_PREFIX = "taskcand:asked:";
const TTL_SECONDS = Math.ceil(CANDIDATE_TTL_MS / 1000);
const MAX_ITEMS = 30;

function kvEnabled(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

const mem = new Map<string, unknown>();

async function read<T>(key: string): Promise<T | null> {
  if (!kvEnabled()) return (mem.get(key) as T | undefined) ?? null;
  return (await kv.get<T>(key)) ?? null;
}

async function write(key: string, value: unknown): Promise<void> {
  if (!kvEnabled()) {
    mem.set(key, value);
    return;
  }
  await kv.set(key, value, { ex: TTL_SECONDS });
}

/** テスト用：メモリの置き場を空にする */
export function _resetMemoryForTest(): void {
  mem.clear();
  mem2.clear();
}

async function legacyListCandidates(
  nowMs: number = Date.now(),
): Promise<Candidate[]> {
  return pruneExpired((await read<Candidate[]>(ITEMS_KEY)) ?? [], nowMs);
}

/** 候補を控える。同じ発言は 2 度控えない。多すぎるときは古いものから落とす。 */
async function legacyAddCandidate(
  c: Candidate,
  nowMs: number = Date.now(),
): Promise<"added" | "exists"> {
  const list = await legacyListCandidates(nowMs);
  if (list.some((x) => x.id === c.id)) return "exists";
  await write(ITEMS_KEY, [...list, c].slice(-MAX_ITEMS));
  return "added";
}

/**
 * いま控えている候補に番号を振って、その並びを覚える（聞く直前・一覧を出す直前に呼ぶ）。
 * 以後の「1 登録」「2 なし」は、この並びの番号で引く。
 *
 * 番号は振り直さない：前に聞いたときの番号をそのまま保ち、新しく届いた分を後ろに足す。
 * 途中で誰かが一覧を出し直しても、先に届いた文面の番号がずれないようにするため。
 * 期限が切れた分は、番号を空ける（null）。全部片付いたら、次は 1 番から振り直す。
 */
async function legacyNumberCandidates(
  nowMs: number = Date.now(),
): Promise<Array<Candidate | null>> {
  const items = await legacyListCandidates(nowMs);
  const alive = new Set(items.map((c) => c.id));
  const kept = (await legacyGetNumbered()).map((c) => (c && alive.has(c.id) ? c : null));
  const base = kept.some((c) => c !== null) ? kept : [];
  const known = new Set(base.filter((c) => c !== null).map((c) => (c as Candidate).id));
  const numbered = [...base, ...items.filter((c) => !known.has(c.id))];
  await write(NUMBERED_KEY, numbered);
  return numbered;
}

async function legacyGetNumbered(): Promise<Array<Candidate | null>> {
  return (await read<Array<Candidate | null>>(NUMBERED_KEY)) ?? [];
}

/** 番号の候補を見る（消さない）。無い番号・片付け済み・期限切れは null。 */
async function legacyPeekCandidate(
  n: number,
  nowMs: number = Date.now(),
): Promise<Candidate | null> {
  const c = (await legacyGetNumbered())[n - 1] ?? null;
  if (!c) return null;
  return pruneExpired([c], nowMs).length > 0 ? c : null;
}

/**
 * 番号の候補を片付ける（一覧からも消す）。番号はずらさない。
 * 登録できたと分かってから呼ぶ（先に消すと、登録に失敗したとき候補まで失う）。
 */
async function legacyRemoveCandidate(n: number): Promise<void> {
  const numbered = await legacyGetNumbered();
  const c = numbered[n - 1] ?? null;
  if (!c) return;
  numbered[n - 1] = null;
  await write(NUMBERED_KEY, numbered);
  const items = (await read<Candidate[]>(ITEMS_KEY)) ?? [];
  await write(
    ITEMS_KEY,
    items.filter((x) => x.id !== c.id),
  );
}

/**
 * その日の分を「これから聞く」と印を付ける。すでに付いていれば false（聞かない）。
 * KV では NX（無いときだけ書く）で、10 分おきの見回りが重なっても 1 回にする。
 */
async function legacyClaimDailyAsk(dateJst: string): Promise<boolean> {
  const key = `${ASKED_PREFIX}${dateJst}`;
  if (!kvEnabled()) {
    if (mem.has(key)) return false;
    mem.set(key, 1);
    return true;
  }
  const r = await kv.set(key, 1, { nx: true, ex: 2 * 24 * 60 * 60 });
  return r === "OK";
}

// ─────────────────────────────────────────────────────────────────────────────
// B1 Task 2：1件ずつのキー（TASK_MENU on のときだけ使う）
// ─────────────────────────────────────────────────────────────────────────────

/** 候補の置き場に使う KV の操作（本物は @vercel/kv。テストでは差し替える） */
export interface CandKv {
  get<T>(key: string): Promise<T | null>;
  mget<T>(keys: string[]): Promise<Array<T | null>>;
  /** nx なら「無いときだけ書く」。書けたら "OK"、書けなければ null */
  set(
    key: string,
    value: unknown,
    opts: { ex: number; nx?: boolean },
  ): Promise<"OK" | null>;
  del(key: string): Promise<void>;
  sadd(key: string, member: string): Promise<void>;
  srem(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<unknown[]>;
  expire(key: string, seconds: number): Promise<void>;
}

const realKv: CandKv = {
  get: async <T>(key: string) => ((await kv.get<T>(key)) ?? null) as T | null,
  mget: async <T>(keys: string[]) =>
    keys.length === 0 ? [] : ((await kv.mget<T[]>(...keys)) as Array<T | null>),
  set: async (key, value, opts) => {
    const r = opts.nx
      ? await kv.set(key, value, { ex: opts.ex, nx: true })
      : await kv.set(key, value, { ex: opts.ex });
    return r === "OK" ? "OK" : null;
  },
  del: async (key) => {
    await kv.del(key);
  },
  sadd: async (key, member) => {
    await kv.sadd(key, member);
  },
  srem: async (key, member) => {
    await kv.srem(key, member);
  },
  smembers: async (key) => (await kv.smembers<unknown[]>(key)) ?? [],
  expire: async (key, seconds) => {
    await kv.expire(key, seconds);
  },
};

// メモリの置き場（KV 未設定のテスト・ローカル）。期限は本物の時計で数える（中身の期限切れは createdAt で別に見る）
const mem2 = new Map<string, { v: unknown; exp: number }>();
const live = (key: string) => {
  const e = mem2.get(key);
  if (!e) return undefined;
  if (Date.now() >= e.exp) {
    mem2.delete(key);
    return undefined;
  }
  return e;
};
// 1回ずつ await を挟む（本物の KV と同じく、並行した呼び出しが入り混じるようにする）
const tick = () => new Promise<void>((r) => setImmediate(r));
const memoryKv: CandKv = {
  get: async <T>(key: string) => {
    await tick();
    return ((live(key)?.v as T | undefined) ?? null) as T | null;
  },
  mget: async <T>(keys: string[]) => {
    await tick();
    return keys.map((k) => ((live(k)?.v as T | undefined) ?? null) as T | null);
  },
  set: async (key, value, opts) => {
    await tick();
    if (opts.nx && live(key)) return null;
    mem2.set(key, {
      v: JSON.parse(JSON.stringify(value)),
      exp: Date.now() + opts.ex * 1000,
    });
    return "OK";
  },
  del: async (key) => {
    await tick();
    mem2.delete(key);
  },
  sadd: async (key, member) => {
    await tick();
    const e = live(key);
    const set = new Set((e?.v as string[] | undefined) ?? []);
    set.add(member);
    mem2.set(key, { v: Array.from(set), exp: e?.exp ?? Number.MAX_SAFE_INTEGER });
  },
  srem: async (key, member) => {
    await tick();
    const e = live(key);
    if (!e) return;
    e.v = (e.v as string[]).filter((m) => m !== member);
  },
  smembers: async (key) => {
    await tick();
    return [...(((live(key)?.v as string[] | undefined) ?? []) as string[])];
  },
  expire: async (key, seconds) => {
    await tick();
    const e = live(key);
    if (e) e.exp = Date.now() + seconds * 1000;
  },
};

let kvOverride: CandKv | null = null;
/** テスト用：KV を差し替える（null で戻す） */
export function _setKvForTest(client: CandKv | null): void {
  kvOverride = client;
}

type KvMode = "kv" | "memory" | "partial";
function kvMode(): KvMode {
  const url = Boolean(process.env.KV_REST_API_URL);
  const token = Boolean(process.env.KV_REST_API_TOKEN);
  if (url && token) return "kv";
  if (!url && !token) return "memory";
  return "partial";
}
/** 使う KV。設定が片方だけなら null（何も控えない・何も読まない） */
function client(): CandKv | null {
  if (kvOverride) return kvOverride;
  const m = kvMode();
  if (m === "partial") {
    console.log("[task-candidate] kv-partial skip");
    return null;
  }
  return m === "kv" ? realKv : memoryKv;
}

const ITEM_PREFIX = "taskcand:c:";
const INDEX_KEY = "taskcand:index";
const NUM_PREFIX = "taskcand:num:";
const HOLD_PREFIX = "taskcand:hold:";
const REG_PREFIX = "taskcand:reg:";
const MEMBER_PREFIX = "c:";
/** 登録の予約の長さ（登録の解析・Notion の書き込みが終わるまで。数分） */
const REG_TTL_SECONDS = 5 * 60;
/** 候補 ID の形（元の発言の LINE メッセージ ID など）。キー・postback の data に入るので形を決めておく */
export const CANDIDATE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

const mainGroup = () => (process.env.LINE_GROUP_ID ?? "").trim();
/** 候補を控えたグループ（古い候補・TASK_MENU off のあいだに控えたものは営業部） */
export function groupOf(c: Candidate): string {
  return (c.groupId ?? "") || mainGroup();
}
const memberOf = (id: string) => `${MEMBER_PREFIX}${id}`;
const idOfMember = (m: unknown) => {
  const s = String(m);
  return s.startsWith(MEMBER_PREFIX) ? s.slice(MEMBER_PREFIX.length) : null;
};
const itemTtl = (c: Candidate, nowMs: number) =>
  Math.ceil((c.createdAt + CANDIDATE_TTL_MS - nowMs) / 1000);

function isCandidate(v: unknown): v is Candidate {
  const c = v as Candidate | null;
  return (
    Boolean(c) &&
    typeof c?.id === "string" &&
    CANDIDATE_ID_RE.test(c.id) &&
    typeof c.text === "string" &&
    typeof c.title === "string" &&
    typeof c.createdAt === "number"
  );
}

/**
 * 古い形（taskcand:items・taskcand:numbered）が残っていれば新しい形へ移す。
 * 移行の元は GETDEL で原子的に1回だけ取り出す（取り出せた側だけが移す）。並行した2つの移行の片方が
 * 古い控え（スナップショット）から、もう片方が移したあとに消した候補を作り直さないため。
 * 取り出したあとで移しきれずに落ちた分は失われる（候補は補助。元の発言は LINE に残る）。
 */
async function migrateLegacy(k: CandKv, nowMs: number): Promise<void> {
  const old = await takeLegacy<Candidate[]>(ITEMS_KEY);
  // 番号も同じく1回だけ取り出す（items を取れなかった側は numbered も触らない）
  const oldNum = Array.isArray(old)
    ? await takeLegacy<Array<Candidate | null>>(NUMBERED_KEY)
    : null;
  if (!Array.isArray(old)) return;
  for (const c of pruneExpired(old.filter(isCandidate), nowMs)) {
    const ttl = itemTtl(c, nowMs);
    if (ttl <= 0) continue;
    // 先に同じ ID が新しい形にあれば、そちらを正とする（NX）
    await k.set(
      `${ITEM_PREFIX}${c.id}`,
      { ...c, groupId: groupOf(c) || null },
      { ex: ttl, nx: true },
    );
    await k.sadd(INDEX_KEY, memberOf(c.id));
  }
  await k.expire(INDEX_KEY, TTL_SECONDS);
  // 営業部の番号を引き継ぐ（新しい番号の並びがまだ無いときだけ）
  const g = mainGroup();
  if (g && Array.isArray(oldNum)) {
    const ids = oldNum.map((c) => (c && isCandidate(c) ? c.id : null));
    await k.set(`${NUM_PREFIX}${g}`, ids, { ex: TTL_SECONDS, nx: true });
  }
}

/** 今までの置き場から1つ取り出して消す（KV は GETDEL。メモリは同じ同期の中で読んで消す＝原子的） */
async function takeLegacy<T>(key: string): Promise<T | null> {
  if (!kvEnabled()) {
    const v = mem.get(key) as T | undefined;
    mem.delete(key);
    return v ?? null;
  }
  return ((await kv.getdel<T>(key)) ?? null) as T | null;
}

/** 目次の全件（期限切れ・中身の消えたものは目次からも外す）。控えた順 */
async function allItems(k: CandKv, nowMs: number): Promise<Candidate[]> {
  await migrateLegacy(k, nowMs);
  const ids = (await k.smembers(INDEX_KEY))
    .map(idOfMember)
    .filter((v): v is string => v !== null && CANDIDATE_ID_RE.test(v));
  if (ids.length === 0) return [];
  const vals = await k.mget<Candidate>(ids.map((id) => `${ITEM_PREFIX}${id}`));
  const out: Candidate[] = [];
  for (let i = 0; i < ids.length; i++) {
    const v = vals[i];
    if (isCandidate(v) && v.id === ids[i] && pruneExpired([v], nowMs).length > 0) {
      out.push(v);
    } else {
      await k.srem(INDEX_KEY, memberOf(ids[i]));
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

async function newList(nowMs: number, groupId?: string): Promise<Candidate[]> {
  const k = client();
  if (!k) return [];
  const all = await allItems(k, nowMs);
  const g = groupId ?? mainGroup();
  return all.filter((c) => groupOf(c) === g);
}

async function newAdd(c: Candidate, nowMs: number): Promise<"added" | "exists" | "failed"> {
  const k = client();
  if (!k) return "failed";
  if (!CANDIDATE_ID_RE.test(c.id)) return "failed";
  const ttl = itemTtl(c, nowMs);
  if (ttl <= 0) return "failed";
  await migrateLegacy(k, nowMs);
  // 中身を先に書き、目次は後に足す（目次だけ残っても読むときに外れる）。同じ発言は 2 度控えない（NX）
  const r = await k.set(
    `${ITEM_PREFIX}${c.id}`,
    { ...c, groupId: c.groupId ?? (mainGroup() || null) },
    { ex: ttl, nx: true },
  );
  if (r !== "OK") return "exists";
  await k.sadd(INDEX_KEY, memberOf(c.id));
  await k.expire(INDEX_KEY, TTL_SECONDS);
  // 多すぎるときは古いものから落とす（全体で 30 件まで）
  const all = await allItems(k, nowMs);
  for (const old of all.slice(0, Math.max(0, all.length - MAX_ITEMS))) {
    await removeById(k, old.id);
  }
  return "added";
}

async function removeById(k: CandKv, id: string): Promise<void> {
  await k.del(`${ITEM_PREFIX}${id}`);
  await k.srem(INDEX_KEY, memberOf(id));
  await k.del(`${HOLD_PREFIX}${id}`);
}

async function newGetNumberedIds(
  k: CandKv,
  groupId: string,
): Promise<Array<string | null>> {
  const v = await k.get<unknown[]>(`${NUM_PREFIX}${groupId}`);
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" && CANDIDATE_ID_RE.test(x) ? x : null));
}

async function newNumber(
  nowMs: number,
  groupId?: string,
): Promise<Array<Candidate | null>> {
  const k = client();
  if (!k) return [];
  const g = groupId ?? mainGroup();
  const items = await newList(nowMs, g);
  const byId = new Map(items.map((c) => [c.id, c]));
  const kept = (await newGetNumberedIds(k, g)).map((id) =>
    id && byId.has(id) ? id : null,
  );
  const base = kept.some((id) => id !== null) ? kept : [];
  const known = new Set(base.filter((id): id is string => id !== null));
  const ids = [...base, ...items.filter((c) => !known.has(c.id)).map((c) => c.id)];
  await k.set(`${NUM_PREFIX}${g}`, ids, { ex: TTL_SECONDS });
  return ids.map((id) => (id ? (byId.get(id) ?? null) : null));
}

async function newGetNumbered(groupId?: string): Promise<Array<Candidate | null>> {
  const k = client();
  if (!k) return [];
  const g = groupId ?? mainGroup();
  const items = await newList(Date.now(), g);
  const byId = new Map(items.map((c) => [c.id, c]));
  return (await newGetNumberedIds(k, g)).map((id) =>
    id ? (byId.get(id) ?? null) : null,
  );
}

async function newPeek(
  n: number,
  nowMs: number,
  groupId?: string,
): Promise<Candidate | null> {
  const k = client();
  if (!k) return null;
  const g = groupId ?? mainGroup();
  await migrateLegacy(k, nowMs);
  const id = (await newGetNumberedIds(k, g))[n - 1] ?? null;
  if (!id) return null;
  const c = await getCandidate(id, nowMs);
  return c && groupOf(c) === g ? c : null;
}

async function newRemove(n: number, groupId?: string): Promise<void> {
  const k = client();
  if (!k) return;
  const g = groupId ?? mainGroup();
  const id = (await newGetNumberedIds(k, g))[n - 1] ?? null;
  if (!id) return;
  await removeById(k, id);
}

// ── 外から呼ぶ入口（TASK_MENU で振り分ける。off なら今までと同じ関数・同じ引数の扱い）──

export async function listCandidates(
  nowMs: number = Date.now(),
  groupId?: string,
): Promise<Candidate[]> {
  return menuActive() ? newList(nowMs, groupId) : legacyListCandidates(nowMs);
}

/** 候補を控える。同じ発言は 2 度控えない。多すぎるときは古いものから落とす。 */
export async function addCandidate(
  c: Candidate,
  nowMs: number = Date.now(),
): Promise<boolean> {
  // 例外は今までどおり外に出す（呼び出し側のログに任せる）
  return (await addCandidateRaw(c, nowMs)) === "added";
}

async function addCandidateRaw(
  c: Candidate,
  nowMs: number,
): Promise<"added" | "exists" | "failed"> {
  if (menuActive()) return newAdd(c, nowMs);
  // off のあいだは今までと同じ中身（B1 で足した欄は書かない）
  const { groupId: _g, mentionedUserIds: _m, ...rest } = c;
  void _g;
  void _m;
  return legacyAddCandidate(rest, nowMs);
}

/**
 * addCandidate と同じ控え方で、結果を3つに分けて返す（2026-11-13）。
 * "added"＝新しく控えた／"exists"＝同じ発言がもう控えてある／"failed"＝控えられなかった（例外・置き場なし・形が不正）。
 * 例外は外に出さない（"failed" にする）。
 */
export async function addCandidateResult(
  c: Candidate,
  nowMs: number = Date.now(),
): Promise<"added" | "exists" | "failed"> {
  try {
    return await addCandidateRaw(c, nowMs);
  } catch {
    return "failed";
  }
}

/**
 * いま控えている候補に番号を振って、その並びを覚える（聞く直前・一覧を出す直前に呼ぶ）。
 * 番号は振り直さない（legacyNumberCandidates の説明と同じ）。TASK_MENU on ならグループごと。
 */
export async function numberCandidates(
  nowMs: number = Date.now(),
  groupId?: string,
): Promise<Array<Candidate | null>> {
  return menuActive() ? newNumber(nowMs, groupId) : legacyNumberCandidates(nowMs);
}

export async function getNumbered(
  groupId?: string,
): Promise<Array<Candidate | null>> {
  return menuActive() ? newGetNumbered(groupId) : legacyGetNumbered();
}

/** 番号の候補を見る（消さない）。無い番号・片付け済み・期限切れは null。 */
export async function peekCandidate(
  n: number,
  nowMs: number = Date.now(),
  groupId?: string,
): Promise<Candidate | null> {
  return menuActive() ? newPeek(n, nowMs, groupId) : legacyPeekCandidate(n, nowMs);
}

/** 番号の候補を片付ける。登録できたと分かってから呼ぶ。 */
export async function removeCandidate(n: number, groupId?: string): Promise<void> {
  return menuActive() ? newRemove(n, groupId) : legacyRemoveCandidate(n);
}

/**
 * その日の分を「これから聞く」と印を付ける。すでに付いていれば false（聞かない）。
 * groupId が営業部以外のときだけキーにグループを足す（営業部は今までと同じキー）。
 */
export async function claimDailyAsk(
  dateJst: string,
  groupId?: string,
): Promise<boolean> {
  if (!menuActive()) return legacyClaimDailyAsk(dateJst);
  const k = client();
  if (!k) return false;
  const key =
    groupId && groupId !== mainGroup()
      ? `${ASKED_PREFIX}${dateJst}:${groupId}`
      : `${ASKED_PREFIX}${dateJst}`;
  return (await k.set(key, 1, { nx: true, ex: 2 * 24 * 60 * 60 })) === "OK";
}

// ── B1 Task 2 だけの操作（TASK_MENU on のときだけ呼ばれる）──

/** ID で候補を見る。無い・期限切れ・形が違えば null */
export async function getCandidate(
  id: string,
  nowMs: number = Date.now(),
): Promise<Candidate | null> {
  if (!CANDIDATE_ID_RE.test(id)) return null;
  const k = client();
  if (!k) return null;
  await migrateLegacy(k, nowMs);
  const v = await k.get<Candidate>(`${ITEM_PREFIX}${id}`);
  if (!isCandidate(v) || v.id !== id) return null;
  return pruneExpired([v], nowMs).length > 0 ? v : null;
}

/** ID で候補を片付ける（中身・目次・保留の印）。登録の予約は残す（期限で消える） */
export async function removeCandidateById(id: string): Promise<void> {
  if (!CANDIDATE_ID_RE.test(id)) return;
  const k = client();
  if (!k) return;
  await removeById(k, id);
}

/** 保留：untilMs（次の 17 時）まで出さない印を付ける */
export async function holdCandidate(
  id: string,
  untilMs: number,
  nowMs: number = Date.now(),
): Promise<void> {
  if (!CANDIDATE_ID_RE.test(id)) return;
  const k = client();
  if (!k) return;
  const ex = Math.max(1, Math.ceil((untilMs - nowMs) / 1000)) + 60;
  await k.set(`${HOLD_PREFIX}${id}`, untilMs, { ex });
}

/** 保留中（印の時刻がまだ来ていない）の ID */
export async function heldIds(
  ids: string[],
  nowMs: number = Date.now(),
): Promise<Set<string>> {
  const k = client();
  const valid = ids.filter((id) => CANDIDATE_ID_RE.test(id));
  if (!k || valid.length === 0) return new Set();
  const vals = await k.mget<number>(valid.map((id) => `${HOLD_PREFIX}${id}`));
  return new Set(valid.filter((_, i) => Number(vals[i]) > nowMs));
}

/** 登録の予約（SET NX）。取れたら true。同時に2回押されても片方だけが true */
export async function claimRegister(id: string): Promise<boolean> {
  if (!CANDIDATE_ID_RE.test(id)) return false;
  const k = client();
  if (!k) return false;
  return (
    (await k.set(`${REG_PREFIX}${id}`, 1, { ex: REG_TTL_SECONDS, nx: true })) === "OK"
  );
}

/** 登録の予約を外す（登録に失敗して候補を残すとき） */
export async function releaseRegister(id: string): Promise<void> {
  if (!CANDIDATE_ID_RE.test(id)) return;
  const k = client();
  if (!k) return;
  await k.del(`${REG_PREFIX}${id}`);
}
