/**
 * タスクの候補の置き場（Vercel KV）。Notion には入れない（台帳を荒らさないため）。
 *
 *   taskcand:items     … まだ聞いていない分も含む、控えている候補の一覧
 *   taskcand:numbered  … 最後に聞いたときの番号つきの一覧（番号 n は [n-1]。片付いた番号は null）
 *   taskcand:asked:<日付> … その日の分を聞いたか（17 時台に 1 回だけ聞くための印）
 *
 * 一覧は丸ごと読み書きする。同時に 2 件届くと片方が消えうるが、候補は「拾えたら助かる」
 * 補助で、消えても元の発言は LINE に残る。件数も少ないので、原子的な操作までは作り込まない。
 * KV が未設定の環境（テスト・ローカル）では、同じインスタンスの中だけのメモリに置く。
 */
import { kv } from "@vercel/kv";
import {
  CANDIDATE_TTL_MS,
  pruneExpired,
  type Candidate,
} from "./task-candidate";

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
}

export async function listCandidates(
  nowMs: number = Date.now(),
): Promise<Candidate[]> {
  return pruneExpired((await read<Candidate[]>(ITEMS_KEY)) ?? [], nowMs);
}

/** 候補を控える。同じ発言は 2 度控えない。多すぎるときは古いものから落とす。 */
export async function addCandidate(
  c: Candidate,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const list = await listCandidates(nowMs);
  if (list.some((x) => x.id === c.id)) return false;
  await write(ITEMS_KEY, [...list, c].slice(-MAX_ITEMS));
  return true;
}

/**
 * いま控えている候補に番号を振って、その並びを覚える（聞く直前・一覧を出す直前に呼ぶ）。
 * 以後の「1 登録」「2 なし」は、この並びの番号で引く。
 *
 * 番号は振り直さない：前に聞いたときの番号をそのまま保ち、新しく届いた分を後ろに足す。
 * 途中で誰かが一覧を出し直しても、先に届いた文面の番号がずれないようにするため。
 * 期限が切れた分は、番号を空ける（null）。全部片付いたら、次は 1 番から振り直す。
 */
export async function numberCandidates(
  nowMs: number = Date.now(),
): Promise<Array<Candidate | null>> {
  const items = await listCandidates(nowMs);
  const alive = new Set(items.map((c) => c.id));
  const kept = (await getNumbered()).map((c) => (c && alive.has(c.id) ? c : null));
  const base = kept.some((c) => c !== null) ? kept : [];
  const known = new Set(base.filter((c) => c !== null).map((c) => (c as Candidate).id));
  const numbered = [...base, ...items.filter((c) => !known.has(c.id))];
  await write(NUMBERED_KEY, numbered);
  return numbered;
}

export async function getNumbered(): Promise<Array<Candidate | null>> {
  return (await read<Array<Candidate | null>>(NUMBERED_KEY)) ?? [];
}

/** 番号の候補を見る（消さない）。無い番号・片付け済み・期限切れは null。 */
export async function peekCandidate(
  n: number,
  nowMs: number = Date.now(),
): Promise<Candidate | null> {
  const c = (await getNumbered())[n - 1] ?? null;
  if (!c) return null;
  return pruneExpired([c], nowMs).length > 0 ? c : null;
}

/**
 * 番号の候補を片付ける（一覧からも消す）。番号はずらさない。
 * 登録できたと分かってから呼ぶ（先に消すと、登録に失敗したとき候補まで失う）。
 */
export async function removeCandidate(n: number): Promise<void> {
  const numbered = await getNumbered();
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
export async function claimDailyAsk(dateJst: string): Promise<boolean> {
  const key = `${ASKED_PREFIX}${dateJst}`;
  if (!kvEnabled()) {
    if (mem.has(key)) return false;
    mem.set(key, 1);
    return true;
  }
  const r = await kv.set(key, 1, { nx: true, ex: 2 * 24 * 60 * 60 });
  return r === "OK";
}
