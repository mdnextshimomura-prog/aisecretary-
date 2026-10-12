/**
 * タスクを作った直後に、「誰が頼んだか・どこから来たか・どの案件か・担当の Notion ユーザー」を書き足す。
 *
 * 管理職が Notion を見て「誰の何がどこで止まっているか」を追えるようにするための記録。
 * タスクの登録そのものとは切り離してある：ここが失敗しても、登録は終わっている
 * （案件の DB を読めない・ユーザーの欄に書けない、でタスクが消えることは起こさない）。
 *
 * 案件は決めつけない。秘書が入れるのは「候補」までで、「確定」にするのは人
 * （同じ建物の別の部屋、売却と購入、同じお客様の別取引で間違うため）。
 */
import { normalizeProperty } from "./property";

/** 記録の書き足しを使うか。外せば今までどおり（何も書き足さない）。 */
export function recordEnabled(): boolean {
  return process.env.TASK_RECORD === "1";
}

export interface DealRef {
  id: string;
  name: string;
}

export type DealState = "候補あり" | "未割当" | "案件なし";

export interface DealMatch {
  state: DealState;
  /** 1 件に絞れたときだけ入る（それでも「候補」。確定は人） */
  dealId: string | null;
  /** 候補の案件名（人が選ぶための控え。最大 5 件） */
  names: string[];
}

const MAX_NAMES = 5;
// これより短い鍵は、部分一致に使わない（「東」「1」のような断片で大量に当たるのを防ぐ）
const MIN_PARTIAL_LENGTH = 4;

/** 案件名を「｜」で分けた各部分と全体を、物件名と同じ規則で照合用の鍵にする。 */
function dealKeys(name: string): string[] {
  const parts = [name, ...name.split(/[｜|]/)];
  const keys = parts.map((p) => normalizeProperty(p)).filter(Boolean);
  return keys.filter((k, i) => keys.indexOf(k) === i);
}

/**
 * タスクの物件の鍵を、進行中の案件に照らす。
 *   ・物件の鍵が無い → 案件なし
 *   ・鍵が完全に一致する案件が 1 件だけ → その案件を候補として入れる
 *   ・完全一致が複数、または部分一致だけ → 案件は入れず、候補の名前だけ控える
 *   ・当たらない → 未割当
 */
export function matchDeals(
  propertyKey: string | null | undefined,
  deals: DealRef[]
): DealMatch {
  const key = (propertyKey ?? "").trim();
  if (!key) return { state: "案件なし", dealId: null, names: [] };

  const exact: DealRef[] = [];
  const partial: DealRef[] = [];
  for (const d of deals) {
    const keys = dealKeys(d.name);
    if (keys.includes(key)) {
      exact.push(d);
      continue;
    }
    if (key.length < MIN_PARTIAL_LENGTH) continue;
    if (
      keys.some(
        (k) => k.length >= MIN_PARTIAL_LENGTH && (k.includes(key) || key.includes(k))
      )
    ) {
      partial.push(d);
    }
  }

  if (exact.length === 1) {
    return { state: "候補あり", dealId: exact[0].id, names: [exact[0].name] };
  }
  const hits = exact.length > 1 ? exact : partial;
  if (hits.length > 0) {
    return {
      state: "候補あり",
      dealId: null,
      names: hits.slice(0, MAX_NAMES).map((d) => d.name),
    };
  }
  return { state: "未割当", dealId: null, names: [] };
}

export interface RecordInfo {
  /** 頼んだ人（名簿の氏名）。分からなければ null */
  requester: string | null;
  /** 頼んだ人の LINE userId */
  requesterId: string | null;
  /** 発言の来たグループの ID。1 対 1 なら null */
  groupId: string | null;
  /** 担当の Notion ユーザー ID（名簿の対応表から）。無ければ null */
  assigneeNotionUserId: string | null;
  /** タスクの物件の鍵（表記ゆれを吸収したもの） */
  propertyKey: string | null;
}

const text = (s: string) => ({ rich_text: [{ text: { content: s } }] });

/** 頼んだ人・発生元の欄（文字だけ。権限の影響を受けない） */
export function originProps(info: RecordInfo): Record<string, unknown> {
  return {
    ...(info.requester ? { 依頼者: text(info.requester) } : {}),
    ...(info.requesterId ? { 依頼者ID: text(info.requesterId) } : {}),
    ...(info.groupId ? { 発生元: text(info.groupId) } : {}),
  };
}

/** 担当の Notion ユーザーの欄。null なら空にする（担当を外した・未登録の人に替えた） */
export function assigneeUserProps(
  notionUserId: string | null
): Record<string, unknown> {
  return {
    "担当（ユーザー）": { people: notionUserId ? [{ id: notionUserId }] : [] },
  };
}

/** 案件の状態だけ（案件そのものは入れない） */
export function dealStateProps(state: DealState): Record<string, unknown> {
  return { 案件の状態: { select: { name: state } } };
}

/** 案件（1 件に絞れたとき）と状態 */
export function dealLinkProps(match: DealMatch): Record<string, unknown> {
  return {
    ...dealStateProps(match.state),
    ...(match.dealId ? { 案件: { relation: [{ id: match.dealId }] } } : {}),
  };
}

export interface RecordDeps {
  loadDeals(): Promise<DealRef[]>;
  update(pageId: string, props: Record<string, unknown>): Promise<void>;
  /** ページ本文への追記（候補の案件名を残す） */
  note(pageId: string, line: string): Promise<void>;
  /** 失敗の記録。出してよいのは段の名前だけ（本文・ID は出さない） */
  warn(stage: string): void;
}

/**
 * 作ったタスクに記録を書き足す。段ごとに分けて書き、どれかが失敗しても残りは続ける。
 * 何が書けたかを返す（テストと記録用）。例外は投げない。
 */
export async function enrichTask(
  pageId: string,
  info: RecordInfo,
  deps: RecordDeps
): Promise<{ origin: boolean; assignee: boolean; deal: DealState | "failed" }> {
  const done: { origin: boolean; assignee: boolean; deal: DealState | "failed" } =
    { origin: false, assignee: false, deal: "failed" };

  const origin = originProps(info);
  if (Object.keys(origin).length > 0) {
    try {
      await deps.update(pageId, origin);
      done.origin = true;
    } catch {
      deps.warn("origin");
    }
  }

  if (info.assigneeNotionUserId) {
    try {
      await deps.update(pageId, assigneeUserProps(info.assigneeNotionUserId));
      done.assignee = true;
    } catch {
      deps.warn("assignee");
    }
  }

  let match: DealMatch;
  try {
    match = matchDeals(info.propertyKey, info.propertyKey ? await deps.loadDeals() : []);
  } catch {
    // 案件を読めないときは、状態を決めない（「未割当」と書くと、探したが無かった、に見えてしまう）
    deps.warn("deal-load");
    return done;
  }
  try {
    await deps.update(pageId, dealLinkProps(match));
    done.deal = match.state;
  } catch {
    deps.warn("deal-link");
    // 案件の欄に書けない（案件の DB が秘書の連携に共有されていない等）ときは、状態だけでも残す
    try {
      await deps.update(pageId, dealStateProps(match.state));
      done.deal = match.state;
    } catch {
      deps.warn("deal-state");
    }
  }
  if (match.state === "候補あり" && !match.dealId && match.names.length > 0) {
    await deps
      .note(pageId, `案件の候補：${match.names.join(" ／ ")}`)
      .catch(() => deps.warn("deal-note"));
  }
  return done;
}
