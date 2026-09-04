import type { ParsedTask } from "./claude";
import {
  loadSalesWorkload,
  recordSalesAssignment,
  type SalesWorkload,
} from "./workload";

export const ASSIGNMENT_MEMBERS = {
  sales: ["橋本 由人", "有吉 勇弥"] as const,
  rental: "野原 大樹",
  management: "足立 稜太",
};

export interface AssignmentDecision {
  assignee: string | null;
  automatic: boolean;
  reason: string | null;
}

/**
 * 売買・買取再販の担当を決める。
 *
 * 1. 進行中案件と未完了タスクから作った負荷点が少ない人
 * 2. 同点なら直近に割り当てられていない人
 * 3. 履歴も無ければ橋本さんから開始
 */
export function chooseSalesAssignee(workload: SalesWorkload): AssignmentDecision {
  const [hashimoto, ariyoshi] = ASSIGNMENT_MEMBERS.sales;
  const hashimotoScore = workload.scores[hashimoto] ?? 0;
  const ariyoshiScore = workload.scores[ariyoshi] ?? 0;

  if (hashimotoScore < ariyoshiScore) {
    return {
      assignee: hashimoto,
      automatic: true,
      reason: `売買・買取再販の負荷点が少ないため（橋本 ${hashimotoScore}／有吉 ${ariyoshiScore}）`,
    };
  }
  if (ariyoshiScore < hashimotoScore) {
    return {
      assignee: ariyoshi,
      automatic: true,
      reason: `売買・買取再販の負荷点が少ないため（橋本 ${hashimotoScore}／有吉 ${ariyoshiScore}）`,
    };
  }

  const assignee = workload.lastAssignee === hashimoto ? ariyoshi : hashimoto;
  return {
    assignee,
    automatic: true,
    reason: workload.lastAssignee
      ? `負荷点が同じため、直前の${workload.lastAssignee.split(" ")[0]}さんと交互に割り当て`
      : "負荷点と割当履歴が同じため、既定順の橋本さんから開始",
  };
}

/**
 * 担当者が明示されていない依頼だけ、会社の担当ルールで補完する。
 * LINEメンションや本文で担当者が指定されている場合は絶対に上書きしない。
 */
export async function applyAutomaticAssignment(
  task: ParsedTask
): Promise<AssignmentDecision> {
  if (task.assignee) {
    return { assignee: task.assignee, automatic: false, reason: null };
  }

  if (task.category === "賃貸") {
    return {
      assignee: ASSIGNMENT_MEMBERS.rental,
      automatic: true,
      reason: "賃貸の固定担当ルール",
    };
  }
  if (task.category === "管理") {
    return {
      assignee: ASSIGNMENT_MEMBERS.management,
      automatic: true,
      reason: "管理の固定担当ルール",
    };
  }
  if (task.category !== "売買" && task.category !== "買取再販") {
    return { assignee: null, automatic: false, reason: null };
  }

  try {
    const decision = chooseSalesAssignee(await loadSalesWorkload());
    if (decision.assignee) recordSalesAssignment(decision.assignee);
    return decision;
  } catch (err) {
    // 集計障害で依頼自体を失わない。担当未定として登録し、人が確認できるようにする。
    console.error("担当負荷の集計に失敗（担当未定で継続）:", err);
    return {
      assignee: null,
      automatic: false,
      reason: "担当負荷を取得できなかったため未割当",
    };
  }
}
