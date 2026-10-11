/**
 * クラウド配達の見回りが共有する、差し込み口の型・時間の線の定数・時間の部品・1回ぶんの持ち回り
 * （設計 2026-10-11 の C1〜C3・C11、約束 2026-10-11-obi-cloud-contract.md の「K4 の見回り」）。
 * cloud-tick.ts（本体）・cloud-deliver.ts・cloud-notice.ts が読み込む。
 * このファイルは、ほかのモジュールを値としては読み込まない（型だけ）＝互いに読み込む形を作らない。
 */
import type {
  CloudCompletionConfig,
  CloudCompletionResult,
  CloudSharedConfig,
} from "./cloud-config";
import type { CloudPortal } from "./cloud-portal";
import type { CloudStore } from "./cloud-store";

/** 段の境目（途中で止める試験はここへ差し込む） */
export type CloudCheckpoint =
  | "completion-claimed" // 予約の直後（控えを書く前）
  | "completion-prepared" // 控え prepared を書いた直後
  | "completion-attempt-requested" // 控え attempt-requested を書いた直後（portal の delivery/attempt を呼ぶ前）
  | "completion-attempting" // portal の attempt が 200 を返し、控え attempting を書いた直後（LINE を呼ぶ直前）
  | "completion-pushed" // push の直後（控え sent を書く前）
  | "completion-sent-saved" // 控え sent を書いた直後（知らせの id の報告の前）
  | "completion-before-result" // 結果の報告の前
  | "notice-claimed" // 知らせの予約の直後
  | "notice-attempting" // notice/attempt が通った直後（LINE を呼ぶ直前）
  | "notice-pushed"; // push の直後（結果の報告の前）

/** 差し込み口が「ここで止める」と決めたときに投げる。見回りは後始末をせず（錠も外さず）そのまま外へ出す＝関数が落ちたのと同じ */
export class CloudHalt extends Error {
  constructor(public readonly point: CloudCheckpoint) {
    super("halt");
    this.name = "CloudHalt";
  }
}

export interface CloudDeps {
  now: () => number;
  portal: CloudPortal;
  store: CloudStore;
  /** 宛先は LINE_GROUP_ID に固定済み。pushLineMessageWithId と同じ戻り */
  push: (
    text: string,
  ) => Promise<{ ok: boolean; messageId: string | null; rejected?: boolean }>;
  /** 受付番号・段・符号だけの1行（LINE の ID・本文・物件名・トークン・リンク・鍵・予約の番号は渡さない） */
  log: (line: string) => void;
  /** 本番は何もしない関数。試験では CloudHalt を投げる */
  checkpoint: (point: CloudCheckpoint) => void;
  /** テスト用。省けば乱数 */
  randomJti?: () => string;
  /** 「種まきが済んでいる」と portal に確かめたことの覚え（このインスタンスの中だけ） */
  seedMemo: { confirmed: boolean };
}

// ---- 時間の線（開始＝入口が呼ばれた時刻 t0）
/** これを過ぎたら、新しい件（新しい予約・新しい知らせ）に手を付けない */
export const TICK_NEW_ITEM_MS = 45_000;
/** 完成：これを過ぎたら「戻れない所」（portal の delivery/attempt を呼ぶ段）へ進まない */
export const TICK_COMPLETION_SEND_MS = 40_000;
/** 知らせ：これを過ぎたら notice/attempt を呼ばない */
export const TICK_NOTICE_ATTEMPT_MS = 30_000;
/** portal の呼び出しは、この線で縮める */
export const TICK_HARD_MS = 57_000;
/** portal の呼び出し1回の上限 */
export const PORTAL_CALL_MS = 10_000;
/**
 * prepared・attempt-requested・attempting の控えに触ってよくなるまでの待ち（最後に書いてから）。
 * 見回りの関数の上限 maxDuration（60秒）より長く、錠の期限（90秒）より短い
 * ＝錠が効かない場面でも、動いている回の控えを別の回が再開・報告しない。
 */
export const MEMO_SETTLE_MS = 70_000;
/** 予約の期限までこれを切っていたら、再開せずに完成へ返す */
export const LEASE_MARGIN_MS = 5 * 60_000;
/** portal の納品の予約の期限（参考。portal の値） */
export const DELIVERY_LEASE_MS = 45 * 60_000;
/** not_sent の後、予約し直さない時間 */
export const RETRY_COOLDOWN_MS = 60 * 60_000;
/** not_sent がこの回数続いたら、長い待ちにする */
export const MAX_NOT_SENT = 3;
export const CAPPED_RETRY_MS = 24 * 60 * 60_000;
/** 1回の見回りで LINE を呼ぶ所まで進める完成の件数（新しい予約＋再開） */
export const MAX_COMPLETIONS = 2;
/** 1回の見回りで送る知らせの数（LINE を呼んだ回数） */
export const MAX_NOTICES = 3;

export interface TickClock {
  elapsed(): number;
  canStartNew(): boolean;
  canSendCompletion(): boolean;
  canAttemptNotice(): boolean;
  /** portal の呼び出しに渡す上限。min(10秒, t0+57秒−今)。1秒に満たなければ 0（＝呼ばない） */
  portalTimeout(): number;
}

export function createTickClock(now: () => number, t0: number): TickClock {
  const elapsed = () => now() - t0;
  return {
    elapsed,
    canStartNew: () => elapsed() <= TICK_NEW_ITEM_MS,
    canSendCompletion: () => elapsed() <= TICK_COMPLETION_SEND_MS,
    canAttemptNotice: () => elapsed() <= TICK_NOTICE_ATTEMPT_MS,
    portalTimeout: () => {
      const left = Math.min(PORTAL_CALL_MS, TICK_HARD_MS - elapsed());
      return left >= 1_000 ? left : 0;
    },
  };
}

/** その回に portal への報告が通った件数など（応答に出す） */
export interface TickCounts {
  delivered: number;
  notSent: number;
  unknown: number;
  notices: number;
  seeded: boolean;
}

/** 1回の見回りのあいだ持ち回るもの */
export interface TickCtx {
  deps: CloudDeps;
  clock: TickClock;
  shared: CloudSharedConfig;
  /** 完成の設定。欠けていれば null（完成の配達だけ飛ばす） */
  completion: CloudCompletionConfig | null;
  fixGuide: boolean;
  counts: TickCounts;
  state: {
    /** portal に 401・403 で断られた。その回の portal の仕事を打ち切る */
    portalStopped: boolean;
    /** LINE を呼ぶ所まで進めた完成の件数（新しい予約＋再開） */
    completionsUsed: number;
  };
}

export interface CloudTickInput {
  deps: CloudDeps;
  shared: CloudSharedConfig;
  completion: CloudCompletionResult; // ok でなければ完成の配達だけ飛ばす
  fixGuide: boolean;
  /** 入口が呼ばれた時刻（ms） */
  startedAt: number;
}

export function newTickCtx(input: CloudTickInput): TickCtx {
  return {
    deps: input.deps,
    clock: createTickClock(input.deps.now, input.startedAt),
    shared: input.shared,
    completion: input.completion.ok ? input.completion.config : null,
    fixGuide: input.fixGuide,
    counts: { delivered: 0, notSent: 0, unknown: 0, notices: 0, seeded: false },
    state: { portalStopped: false, completionsUsed: 0 },
  };
}
