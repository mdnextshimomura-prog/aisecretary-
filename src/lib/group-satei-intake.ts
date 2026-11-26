/**
 * 段1の［案件を選ぶ］（group-satei-actions.ts の pick）と段2e の見回り（group-satei-propose.ts）で共有する、
 * 今の査定（下書き）の受付の呼び出し。eventId は受付票ごとに同じ gs<tid>（portal が二重に作らない）。例外は投げない（結果不明にする）
 */
import { gsEventId } from "./group-satei-data";
import type { SateiCall, SateiIntakeOk, SateiIntakeReq } from "./satei-portal";

export async function gsSateiIntake(
  tid: string,
  deal: { id: string; name: string; dealNo: number | null; folderId: string },
  requestedBy: string,
  intake: (req: SateiIntakeReq) => Promise<SateiCall<SateiIntakeOk>>,
): Promise<SateiCall<SateiIntakeOk>> {
  try {
    return await intake({ eventId: gsEventId(tid), dealId: deal.id, dealNo: deal.dealNo, folderId: deal.folderId, dealName: deal.name, requestedBy });
  } catch {
    return { kind: "unknown", reason: "exception" };
  }
}
