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
 * いま控えている候補に番号を振って、その並びを覚える（聞く直前に呼ぶ）。
 * 以後の「1 登録」「2 なし」は、この並びの番号で引く。
 */
export async function numberCandidates(
  nowMs: number = Date.now(),
): Promise<Candidate[]> {
  const list = await listCandidates(nowMs);
  await write(NUMBERED_KEY, list);
  return list;
}

export async function getNumbered(): Promise<Array<Candidate | null>> {
  return (await read<Array<Candidate | null>>(NUMBERED_KEY)) ?? [];
}

/**
 * 番号の候補を取り出して、片付いたことにする（一覧からも消す）。
 * 無い番号・片付け済みの番号は null。番号はずらさない（聞いた文面の番号のまま使えるように）。
 */
export async function takeCandidate(n: number): Promise<Candidate | null> {
  const numbered = await getNumbered();
  const c = numbered[n - 1] ?? null;
  if (!c) return null;
  numbered[n - 1] = null;
  await write(NUMBERED_KEY, numbered);
  const items = (await read<Candidate[]>(ITEMS_KEY)) ?? [];
  await write(
    ITEMS_KEY,
    items.filter((x) => x.id !== c.id),
  );
  return c;
}

/** 取り出した候補を戻す（登録に失敗したとき、候補まで失わないため）。 */
export async function putBackCandidate(n: number, c: Candidate): Promise<void> {
  const numbered = await getNumbered();
  if (n >= 1 && !numbered[n - 1]) {
    numbered[n - 1] = c;
    await write(NUMBERED_KEY, numbered);
  }
  const items = (await read<Candidate[]>(ITEMS_KEY)) ?? [];
  if (!items.some((x) => x.id === c.id)) await write(ITEMS_KEY, [...items, c]);
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
