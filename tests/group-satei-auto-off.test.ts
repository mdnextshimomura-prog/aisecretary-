/**
 * 案件の自動登録（計画 2026-11-27-group-satei-auto-deal）：スイッチ GROUP_SATEI_AUTO_DEAL が off のとき、
 * 返事の文・カード・KV・portal へ送る JSON・ログが、足す前（コミット 5aa74d8）と1バイトも変わらないことを固定する。
 * 下の sha256 は、実装を足す前のコードで採ったもの（GS_PRINT=1 で出し直せるが、変わったら off の約束を破っている）。
 * off の形は3つ：スイッチが無い／スイッチはあるが CRM_PROPERTIES_DB_ID が無い／スイッチも ID もあるが 2d が off。
 * 自動登録の部品（autoDeal・autoLink）は呼ばれたら落ちる作りで渡す。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleGroupSateiPostback, type GsActionDeps } from "../src/lib/group-satei-actions";
import { GS_STAGE2_SET, gsTicketKey, parseGsData, ticketIdOf, type GsTicket } from "../src/lib/group-satei-data";
import { sateiPrepIntake, sateiPrepNotices, type SateiPrepIntakeReq, type SateiPrepNotice } from "../src/lib/group-satei-prep-portal";
import { sweepGsStage2, type GsSweepDeps } from "../src/lib/group-satei-propose";
import type { SateiDeal } from "../src/lib/satei-deal";

let n = 0;
const t = async (name: string, f: () => Promise<void>) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const G = "C" + "a".repeat(32);
const DB = "9999abcd0123456789ab0123456789ab";
const PROPS_DB = "7777abcd0123456789ab0123456789ab";
const DEAL = "0123abcd0123456789ab0123456789ab";
const tid = ticketIdOf("m1");
const NOW = Date.UTC(2026, 10, 27, 1);
const base: GsTicket = {
  no: 7, ver: 1, groupId: G, requesterId: "U" + "c".repeat(32), at: 1, triggerMsgIds: ["m1"], mediaIds: [], state: "asking",
  read: { address: "大阪市北区天満2丁目3-4", propertyName: "パークハウス天満 1203号室", kind: "マンション", basis: "本文", confidence: 0.9,
    facts: { roomNo: "1203", exclusiveArea: 65.3, landArea: null, buildingArea: null, builtYm: "2005-03", layout: null, floor: null, totalUnits: null, structure: null } },
};
const ON = { TASK_SATEI: "1", TASK_SATEI_USER_IDS: SHIMO, GROUP_SATEI: "1", GROUP_SATEI_GROUP_IDS: G, GROUP_SATEI_STAGE2: "1", GROUP_SATEI_CASE_STAFF_ID: STAFF, CRM_DEALS_DB_ID: DB };
/** off の形（どれも今と同じ動きでなければならない） */
const OFFS: Array<{ name: string; env: Record<string, string> }> = [
  { name: "スイッチなし", env: ON },
  { name: "スイッチ 0", env: { ...ON, GROUP_SATEI_AUTO_DEAL: "0", CRM_PROPERTIES_DB_ID: PROPS_DB } },
  { name: "スイッチ 1 だが CRM_物件 の ID なし", env: { ...ON, GROUP_SATEI_AUTO_DEAL: "1" } },
  { name: "スイッチ 1 だが ID の形が違う", env: { ...ON, GROUP_SATEI_AUTO_DEAL: "1", CRM_PROPERTIES_DB_ID: "xyz" } },
];
const deal: SateiDeal = { id: DEAL, name: "山田様 売却", dealNo: 12, folderId: "folder_abcdefghij", propertyIds: ["p"], gone: false, parentDbId: DB };
const boom = (name: string) => async () => { throw new Error(`off なのに ${name} を呼んだ`); };
const AUTO_BOOM = { findOrCreateProperty: boom("findOrCreateProperty"), findOrCreateDeal: boom("findOrCreateDeal"), propTitle: boom("propTitle"), readDealNo: boom("readDealNo") };

function mk(env: Record<string, string>, o: { ticket?: Partial<GsTicket>; folderId?: string | null } = {}) {
  const m = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  m.set(gsTicketKey(tid), { ...base, ...(o.ticket ?? {}) });
  const out = { replies: [] as unknown[], preps: [] as unknown[], intakes: [] as unknown[], logs: [] as string[], calls: [] as string[] };
  const deps = {
    env,
    kv: {
      get: async (k: string) => m.get(k) ?? null,
      set: async (k: string, v: unknown) => { m.set(k, v); },
      setNx: async (k: string, v: unknown) => (m.has(k) ? false : (m.set(k, v), true)),
      incr: async () => 1, expire: async () => undefined,
      sadd: async (k: string, v: string) => { (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(v); },
      lpushTrim: async () => undefined, lrange: async () => [],
      del: async (k: string) => { m.delete(k); }, srem: async (k: string, v: string) => { sets.get(k)?.delete(v); },
    },
    dealsDbId: DB,
    readDeal: async () => { out.calls.push("readDeal"); return { deal: { ...deal, folderId: o.folderId === undefined ? deal.folderId : o.folderId }, kind: "マンション" }; },
    intake: async (req: unknown) => { out.intakes.push(req); return { kind: "ok", value: { created: true, no: 12, status: "受付" } }; },
    loadDeals: async () => { out.calls.push("loadDeals"); return [{ id: DEAL, name: "山田様｜パークハウス天満", phase: "【売】査定" }]; },
    reserve: async () => ({ proceed: true }),
    complete: async () => undefined,
    reply: async (_t: string, text: string, card?: unknown) => { out.replies.push({ text, card: card ?? null }); },
    log: (l: string) => out.logs.push(l),
    prep: {
      intake: async (req: unknown) => { out.preps.push(req); return { kind: "ok", value: { created: true, status: "受付" } }; },
      notices: async () => ({ kind: "ok", value: [] }),
      decide: async () => ({ kind: "ok", value: { status: "手作業" } }),
    },
    push: async () => 200,
    now: () => NOW,
    autoDeal: AUTO_BOOM,
  } as unknown as GsActionDeps;
  const snap = () => JSON.stringify({ ...out, kv: Array.from(m.entries()).sort(), sets: Array.from(sets.entries()).map(([k, v]) => [k, Array.from(v).sort()]).sort() });
  return { deps, snap };
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const press = (data: string, x: ReturnType<typeof mk>) =>
  handleGroupSateiPostback(parseGsData(data)!, { replyToken: "r", webhookEventId: "e1", source: { userId: SHIMO } }, x.deps);

/** 足す前のコード（5aa74d8）で採った値 */
const WANT: Record<string, string> = {
  "gk-satei": "8abe3cbb48d1c2db2abed6cd7f63a8fd4a07e9541818e8c1a521a65df9692e4c",
  "gm": "2334fdc4e344370014f056fc60a499a723a21a81c69f96aa1be6baa4fbf9199f",
  "gm-satei-ticket": "316a2ab5cda3572020cf67bac309e019c23e32dd23f9982983fe269eec01bdc4",
  "gs-folder": "2cda615c9a6fcd742c2e3cf2a0156eae05d9dc93e1b4e8935d31c5d240fd44f3",
  "gs-no-folder": "9d2cc685a7d687be33dd0bdfc9bf961b386b4f4dc469c232b9f5354851154065",
  "sweep-propose": "1a361df576adbbb506b54735d473dd5633eece524822c12287bb57fd81fac71f",
  "sweep-failed": "14b83b249e9cde9f10fa5d6f3b5763bd66e5c390e8f51daa2257d595277aad15",
  "intake-body": "afc9bc4726c0b0fee1df4784e610727ba7b95cd94e998beaa4903026f4435cbd",
  "notices": "9d8fe6cc419c23ba32fe807ae29a0f67b26a3267c4729f2dda297cd610978fde",
};
const got: Record<string, string> = {};
function check(key: string, label: string, snap: string) {
  const h = sha(snap);
  if (process.env.GS_PRINT === "1") {
    if (got[key] && got[key] !== h) throw new Error(`off の形で結果が割れた: ${key} ${label}`);
    got[key] = h;
    return;
  }
  assert.equal(h, WANT[key], `${key}（${label}）が足す前と違う`);
}

(async () => {
  for (const off of OFFS) {
    await t(`off（${off.name}）：［査定］の返事・カード・KV・ログが今と同じ。案件を読まない`, async () => {
      const x = mk(off.env);
      await press(`v1|gk|${tid}|1|satei`, x);
      check("gk-satei", off.name, x.snap());
    });
    await t(`off（${off.name}）：［案件がまだ無い］は今の仮の決定のまま`, async () => {
      const x = mk(off.env);
      await press(`v1|gm|${tid}|1`, x);
      check("gm", off.name, x.snap());
      const y = mk(off.env, { ticket: { requestKind: "satei" } });
      await press(`v1|gm|${tid}|1`, y);
      check("gm-satei-ticket", off.name, y.snap());
    });
    await t(`off（${off.name}）：フォルダのある案件を選ぶと、portal へ送る JSON・受付票が今と同じ`, async () => {
      const x = mk(off.env);
      await press(`v1|gs|${tid}|1|${DEAL}`, x);
      check("gs-folder", off.name, x.snap());
    });
    await t(`off（${off.name}）：フォルダの無い案件は今の「未設定です」のまま`, async () => {
      const x = mk(off.env, { folderId: null });
      await press(`v1|gs|${tid}|1|${DEAL}`, x);
      check("gs-no-folder", off.name, x.snap());
    });
    await t(`off（${off.name}）：見回り（案の配達・失敗）の push・KV・ログが今と同じ`, async () => {
      for (const [key, nt] of [
        ["sweep-propose", { tid, no: 7, status: "相談中", lines: ["成約：同じマンション", "売出：5件ほど"], areaDone: true, failReason: "" }],
        ["sweep-failed", { tid, no: 7, status: "失敗", lines: [], areaDone: false, failReason: "folder" }],
      ] as Array<[string, SateiPrepNotice]>) {
        const m = new Map<string, unknown>();
        const sets = new Map<string, Set<string>>([[GS_STAGE2_SET, new Set([tid])]]);
        m.set(gsTicketKey(tid), { ...base, state: "gathering", prepAt: NOW - 60_000, dealId: DEAL, requestKind: "satei", prep: { kind: "マンション", rev: 0, lines: [], fixes: 0, sentRev: 0, tries: 0, groupPushes: 0 } });
        const out = { pushes: [] as unknown[], logs: [] as string[], calls: [] as string[] };
        const deps = {
          env: off.env,
          kv: {
            get: async (k: string) => m.get(k) ?? null,
            set: async (k: string, v: unknown) => { m.set(k, v); },
            setNx: async (k: string, v: unknown) => (m.has(k) ? false : (m.set(k, v), true)),
            incr: async () => 1, expire: async () => undefined,
            sadd: async (k: string, v: string) => { (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(v); },
            srem: async (k: string, v: string) => { sets.get(k)?.delete(v); },
            smembers: async (k: string) => Array.from(sets.get(k) ?? []),
            lpushTrim: async () => undefined, lrange: async () => [],
            del: async (k: string) => { m.delete(k); },
          },
          prep: {
            intake: async () => ({ kind: "unknown", reason: "x" }),
            notices: async () => { out.calls.push("notices"); return { kind: "ok", value: [nt] }; },
            decide: async (_id: string, req: { decision: string }) => { out.calls.push(`decide ${req.decision}`); return { kind: "ok", value: { status: "x" } }; },
          },
          push: async (to: string, messages: unknown[], key: string) => { out.pushes.push({ to, messages, key }); return 200; },
          now: () => NOW,
          log: (l: string) => out.logs.push(l),
          autoLink: boom("autoLink"),
        } as unknown as GsSweepDeps;
        await sweepGsStage2(deps);
        check(key, off.name, JSON.stringify({ ...out, kv: Array.from(m.entries()).sort(), sets: Array.from(sets.entries()).map(([k, v]) => [k, Array.from(v).sort()]).sort() }));
      }
    });
  }
  await t("portal の口：フォルダつきの受付の本文（JSON の文字列）と、一覧の行の読み方が今と同じ", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      calls.push(String(init.body ?? ""));
      return { status: 200, ok: true, json: async () => ({
        created: true, prep: { status: "受付" },
        preps: [
          { tid, no: 7, status: "相談中", lines: ["a"], areaDone: true, failReason: "", newFolderId: null },
          { tid, no: 8, status: "失敗", lines: [], areaDone: false, failReason: "folder" },
          { tid, no: 9, status: "事例保存済み", lines: [], areaDone: true, failReason: "", cases: { contract: 1, listing: 2, failed: 0 }, casesCount: 3 },
        ],
      }) } as Response;
    }) as unknown as typeof fetch;
    const opts = { fetchImpl, baseUrl: "https://p.example.test", token: "k", timeoutMs: 1000 };
    const req: SateiPrepIntakeReq = {
      tid, no: 7, dealId: DEAL, folderId: "folder_abcdefghij", kind: "マンション", place: "大阪市北区天満2丁目3-4", building: "パークハウス天満",
      facts: { builtYm: "2005-03", exclusiveArea: 65.3, landArea: null, buildingArea: null }, requestedBy: SHIMO,
    };
    await sateiPrepIntake(req, opts);
    check("intake-body", "-", calls[0]);
    check("notices", "-", JSON.stringify(await sateiPrepNotices(opts)));
  });
  if (process.env.GS_PRINT === "1") console.log(JSON.stringify(got, null, 2));
  console.log(`group-satei-auto-off: ${n} 件 OK`);
})().catch((e) => { console.error(e); process.exit(1); });
