/**
 * 期日テンプレート — 依頼の種類ごとの標準納期。
 *
 * 設計の意図:
 *   以前は Claude のプロンプト内の日本語文章で「常識的に判断」させていたため、
 *   同じ依頼文でも実行のたびに違う期日が出ていた（非決定的）。
 *   Claude には「依頼タイプの判定」だけをさせ、日付の計算はここで決定的に行う。
 *
 * ルールを変えるときはこのファイルの TYPE_RULES だけを直せばよい。
 * ただし REQUEST_TYPES を増減したときは claude.ts のプロンプトも合わせること。
 *
 * 決定事項（2026-08-08）:
 *   - 日数は「暦日」で数える（土日祝を飛ばさない）
 *   - 時刻の指定が無いときの既定は 18:00
 */

export const REQUEST_TYPES = [
  "査定書",
  "購入申込書",
  "物件資料",
  "重要事項説明書",
  "売買契約書",
  "書類取得",
  "業者確認",
  "内見調整",
  "その他",
] as const;

export type RequestType = (typeof REQUEST_TYPES)[number];
export type Urgency = "今日中" | "今週中" | "来週以降";

/** 時刻の明示が無いときの既定の期限 */
export const DEFAULT_DUE_TIME = "18:00";

export interface DueDecision {
  dueDate: string; // "YYYY-MM-DD"
  dueTime: string; // "HH:mm"
  urgency: Urgency;
  reason: string; // 返信に出す根拠（なぜこの期日になったか）
}

interface Rule {
  /** 受信日から何日後か（暦日）。0＝当日 */
  days: number;
  time: string;
  /** 返信に出す説明。「〜で設定しました」に続く形で書く */
  label: string;
  /**
   * 当日納期の締切時刻（時）。この時刻以降に受信したら翌日にずらす。
   * 例: 18 なら「18時までに来た依頼は当日、18時以降は翌日」。
   */
  sameDayCutoffHour?: number;
  /** 値が未確定で、実務に合わせて要調整のもの */
  provisional?: boolean;
}

/**
 * 緊急度は期日から導出する。ルール表に別途持たせない。
 *
 * 2つの場所で持つと必ず矛盾する。実際、当初は表に urgency を持たせていたため
 * 「午後受信で期日は翌日なのに緊急度が今日中」という食い違いが出た。
 */
function urgencyFromDays(days: number): Urgency {
  if (days <= 0) return "今日中";
  if (days <= 7) return "今週中";
  return "来週以降";
}

const TYPE_RULES: Record<RequestType, Rule> = {
  // 現行プロンプトで明文化されていたルール
  査定書: { days: 7, time: "17:00", label: "査定書の標準納期（7日）" },
  // 買付は相手のある話で、出すのが遅れると物件を押さえられない。当日扱いにする。
  購入申込書: {
    days: 0,
    time: DEFAULT_DUE_TIME,
    label: "購入申込書の標準納期（当日）",
    sameDayCutoffHour: 18,
  },
  物件資料: {
    days: 0,
    time: DEFAULT_DUE_TIME,
    label: "資料作成の標準納期（当日）",
    sameDayCutoffHour: 18, // 18時までの受信は当日、18時以降は翌日（2026-08-08 決定）
  },

  // ★要確定 — 実務の感覚に合わせて days / time を調整してください（2026-08-08 時点は暫定値）
  重要事項説明書: { days: 5, time: "17:00", label: "重要事項説明書の標準納期（暫定5日）", provisional: true },
  売買契約書: { days: 5, time: "17:00", label: "売買契約書の標準納期（暫定5日）", provisional: true },
  書類取得: { days: 3, time: DEFAULT_DUE_TIME, label: "書類取得の標準納期（暫定3日）", provisional: true },

  業者確認: { days: 1, time: DEFAULT_DUE_TIME, label: "業者・管理会社への確認の標準納期（翌日）" },
  内見調整: { days: 0, time: DEFAULT_DUE_TIME, label: "内見・現地調整の標準納期（当日）" },
  その他: { days: 1, time: DEFAULT_DUE_TIME, label: "標準納期（翌日）" },
};

/** 値がまだ実務と突き合わせられていない依頼タイプ（運用で気づけるよう外に出す） */
export function provisionalTypes(): RequestType[] {
  return REQUEST_TYPES.filter((t) => TYPE_RULES[t].provisional);
}

/** JST の日付に日数を足して "YYYY-MM-DD" を返す（暦日） */
function addDaysJst(baseJst: Date, days: number): string {
  const d = new Date(baseJst.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 依頼タイプから期日を決める。
 *
 * @param type        Claude が判定した依頼タイプ
 * @param receivedAtJst 受信時刻を JST に補正した Date（UTC メソッドで読む前提）
 * @param urgentHint  「急ぎ」「至急」の指定があったか
 */
export function resolveDue(
  type: RequestType,
  receivedAtJst: Date,
  urgentHint = false
): DueDecision {
  const rule = TYPE_RULES[type] ?? TYPE_RULES["その他"];

  // 「急ぎ」指定は最優先で当日扱いにする
  if (urgentHint) {
    return {
      dueDate: addDaysJst(receivedAtJst, 0),
      dueTime: rule.time,
      urgency: "今日中",
      reason: "急ぎの指定があったため当日",
    };
  }

  let days = rule.days;
  let reason = rule.label;

  // 当日納期のものは、締切時刻を過ぎて受信したら翌日にずらす
  if (
    rule.sameDayCutoffHour != null &&
    days === 0 &&
    receivedAtJst.getUTCHours() >= rule.sameDayCutoffHour
  ) {
    days = 1;
    reason = `${rule.label}・${rule.sameDayCutoffHour}時以降の受信のため翌日`;
  }

  return {
    dueDate: addDaysJst(receivedAtJst, days),
    dueTime: rule.time,
    urgency: urgencyFromDays(days),
    reason: `${reason}で設定`,
  };
}
