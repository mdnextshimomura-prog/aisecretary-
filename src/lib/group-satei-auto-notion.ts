/**
 * 案件の自動登録（計画 docs/superpowers/plans/2026-11-27-group-satei-auto-deal.md の A4）：Notion への読み書き。
 * 書くのは、この流れで新しく作る CRM_物件・CRM_案件 のページと、その案件（備考に「票 <tid の頭8字>」のあるページ）の
 * `Driveフォルダ`・`フォルダ状態` だけ。既存のページは書き換えない（使い回す物件ページは relation を張るだけ）。
 * どの段も「印で探してから作る」＝落ちてやり直しても増えない。
 * client は呼ぶ側が渡す（本物は makeSateiNotion＝SDK のログを出さない。テストは偽物）。ここではログを出さない。例外はそのまま投げる。
 * 欄の名前：CRM_物件 はデータ辞書（00_データ辞書.md 4-3）どおり、CRM_案件 は 2026-11-27 に本番で確認済み（裁定 R4）。
 */
import type { GsPrepKind } from "./group-satei-data";
import { folderIdFromUrl, normNotionId, readSateiDealPage } from "./satei-deal";

/** 使う Notion の口だけ（@notionhq/client の Client がそのまま入る） */
export interface GsAutoNotionClient {
  databases: { query(args: Record<string, unknown>): Promise<{ results: unknown[] }> };
  pages: {
    create(args: Record<string, unknown>): Promise<unknown>;
    retrieve(args: { page_id: string }): Promise<unknown>;
    update(args: Record<string, unknown>): Promise<unknown>;
  };
}

export interface GsAutoPropertyInput {
  title: string;
  kind: GsPrepKind;
  address: string | null;
  landArea: number | null;
  buildingArea: number | null;
  /** 備考の全文（「グループ査定 受付 G7 から自動登録（票 ab12cd34）」） */
  remark: string;
  /** 探すときの印（「票 ab12cd34」） */
  mark: string;
}
export interface GsAutoDealInput {
  name: string;
  propTitle: string;
  propertyId: string;
  remark: string;
  mark: string;
}
export type GsAutoDealResult = { kind: "ok"; id: string; dealNo: number | null } | { kind: "dup" };
export type GsAutoLinkResult = "linked" | "same" | "conflict" | "foreign";

type Page = Record<string, unknown>;
const live = (v: unknown): v is Page => Boolean(v) && typeof v === "object" && !(v as Page).archived && !(v as Page).in_trash;
const text = (s: string) => [{ text: { content: Array.from(s).slice(0, 2000).join("") } }];
const richOf = (page: Page, prop: string): string => {
  const p = (page.properties as Record<string, unknown> | undefined)?.[prop] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  return (p?.rich_text ?? []).map((t) => t.plain_text ?? "").join("");
};
const titleOf = (page: Page, prop: string): string => {
  const p = (page.properties as Record<string, unknown> | undefined)?.[prop] as { title?: Array<{ plain_text?: string }> } | undefined;
  return (p?.title ?? []).map((t) => t.plain_text ?? "").join("").trim();
};
const ACTIVE = [
  { property: "フェーズ", select: { does_not_equal: "完了" } },
  { property: "フェーズ", select: { does_not_equal: "失注" } },
];

export function gsAutoNotion(client: GsAutoNotionClient, ids: { propsDbId: string; dealsDbId: string }) {
  const first = async (database_id: string, filter: unknown): Promise<Page | null> => {
    const r = await client.databases.query({ database_id, page_size: 5, filter });
    return (r.results.find(live) as Page | undefined) ?? null;
  };
  return {
    /** CRM_物件：①備考に印のあるページ ②物件名が完全に同じページ の順で探し、無ければ作る。見つけたページは書き換えない */
    async findOrCreateProperty(p: GsAutoPropertyInput): Promise<{ id: string }> {
      const byMark = await first(ids.propsDbId, { property: "備考", rich_text: { contains: p.mark } });
      if (byMark && richOf(byMark, "備考").includes(p.mark)) return { id: normNotionId(String(byMark.id)) };
      const byName = await first(ids.propsDbId, { property: "物件名", title: { equals: p.title } });
      if (byName && titleOf(byName, "物件名") === p.title) return { id: normNotionId(String(byName.id)) };
      const made = (await client.pages.create({
        parent: { database_id: ids.propsDbId },
        properties: {
          物件名: { title: text(p.title) },
          種別: { select: { name: p.kind } },
          ...(p.address ? { 所在地: { rich_text: text(p.address) } } : {}),
          ...(typeof p.landArea === "number" ? { "土地面積㎡": { number: p.landArea } } : {}),
          ...(typeof p.buildingArea === "number" ? { "建物面積㎡": { number: p.buildingArea } } : {}),
          備考: { rich_text: text(p.remark) },
        },
      })) as Page;
      return { id: normNotionId(String(made.id)) };
    },

    /**
     * CRM_案件：①備考に印のある案件があればそれ（やり直しで増やさない）②案件名が物件名を含む進行中の案件があれば作らない（dup）。
     * ②は毎回 Notion に聞く（5分の覚えを使わない）。無ければ作る。顧客・案件ソース・主担当・フォルダ状態は空
     */
    async findOrCreateDeal(p: GsAutoDealInput): Promise<GsAutoDealResult> {
      const byMark = await first(ids.dealsDbId, { property: "備考", rich_text: { contains: p.mark } });
      if (byMark && richOf(byMark, "備考").includes(p.mark)) {
        const d = readSateiDealPage(byMark);
        return { kind: "ok", id: d.id, dealNo: d.dealNo };
      }
      const dup = await first(ids.dealsDbId, { and: [{ property: "案件名", title: { contains: p.propTitle } }, ...ACTIVE] });
      if (dup) return { kind: "dup" };
      const made = (await client.pages.create({
        parent: { database_id: ids.dealsDbId },
        properties: {
          案件名: { title: text(p.name) },
          フェーズ: { select: { name: "【売】査定" } },
          案件種別: { select: { name: "売買仲介" } },
          取引区分: { select: { name: "仲介" } },
          取引の立場: { select: { name: "売却" } },
          "担当（仮）": { select: { name: "下村" } },
          物件: { relation: [{ id: p.propertyId }] },
          備考: { rich_text: text(p.remark) },
        },
      })) as Page;
      const d = readSateiDealPage(made);
      return { kind: "ok", id: d.id, dealNo: d.dealNo };
    },

    /** 案件番号（ID の連番）を読み直す。まだ無ければ null */
    async readDealNo(dealId: string): Promise<number | null> {
      return readSateiDealPage((await client.pages.retrieve({ page_id: dealId })) as Page).dealNo;
    },

    /** CRM_物件 の物件名（フォルダ名は毎回ここから作る）。消えていれば null */
    async propTitle(propertyId: string): Promise<string | null> {
      const page = (await client.pages.retrieve({ page_id: propertyId })) as Page;
      return live(page) ? titleOf(page, "物件名") || null : null;
    },

    /**
     * フォルダができたあと：その案件の Driveフォルダ と フォルダ状態（作成済）を書く。書く直前に読み直し、
     * この流れで作った案件（備考に印がある・CRM_案件 の子・消えていない）で、Driveフォルダ が空のときだけ書く。
     * 同じ URL が入っていれば書かない（same）。別の URL なら書かない（conflict＝人が先に入れた）。この流れの案件でなければ書かない（foreign）
     */
    async linkDealFolder(dealId: string, folderId: string, mark: string): Promise<GsAutoLinkResult> {
      const page = (await client.pages.retrieve({ page_id: dealId })) as Page;
      const d = readSateiDealPage(page);
      if (!live(page) || d.parentDbId !== normNotionId(ids.dealsDbId) || !richOf(page, "備考").includes(mark)) return "foreign";
      const cur = ((page.properties as Record<string, unknown> | undefined)?.["Driveフォルダ"] as { url?: unknown } | undefined)?.url;
      if (typeof cur === "string" && cur.trim()) return folderIdFromUrl(cur) === folderId ? "same" : "conflict";
      await client.pages.update({
        page_id: dealId,
        properties: {
          Driveフォルダ: { url: `https://drive.google.com/drive/folders/${folderId}` },
          フォルダ状態: { select: { name: "作成済" } },
        },
      });
      return "linked";
    },
  };
}
export type GsAutoNotion = ReturnType<typeof gsAutoNotion>;
