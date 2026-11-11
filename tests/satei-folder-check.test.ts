/**
 * B2 査定書：保存直前のフォルダ照合の受け口（契約 6-3）。Notion は差し替え。外部へ通信しない。
 */
import {
  folderMatches,
  handleSateiFolderCheck,
  parseFolderCheckInput,
  type FolderCheckDeps,
} from "../src/lib/satei-folder-check";
import { sateiNotifyToken } from "../src/lib/satei-notify";
import type { SateiDeal } from "../src/lib/satei-deal";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};
globalThis.fetch = (async () => {
  throw new Error("このテストで外部へ通信してはいけない");
}) as typeof fetch;

const KEY = "k".repeat(40);
const TOKEN = sateiNotifyToken(KEY);
const DB = "11112222-3333-4444-5555-666677778888";
const DEAL = "0123abcd-0123-4567-89ab-0123456789ab";
const FOLDER = "1AbC_dEf-GhIjKlMnOp";
const GOOD: SateiDeal = {
  id: "0123abcd0123456789ab0123456789ab",
  name: "テスト案件",
  dealNo: 42,
  folderId: FOLDER,
  propertyIds: [],
  gone: false,
  parentDbId: "11112222333344445555666677778888",
};
const env = { JOB_API_TOKEN: KEY, TASK_SATEI: "1", CRM_DEALS_DB_ID: DB };
const IN = { no: 12, dealId: DEAL, folderId: FOLDER };

function mk(read: () => Promise<SateiDeal | null>, e: Record<string, string | undefined> = env, timeoutMs = 1000) {
  const r = { reads: 0, logs: [] as string[] };
  const deps: FolderCheckDeps = {
    env: e,
    readDealPage: async () => {
      r.reads++;
      return read();
    },
    timeoutMs,
    log: (l) => r.logs.push(l),
  };
  return { r, deps };
}

// ── 純関数 ──
ok("入力を読む", JSON.stringify(parseFolderCheckInput(IN)) === JSON.stringify(IN));
ok("ハイフンなしの dealId も読む", parseFolderCheckInput({ ...IN, dealId: GOOD.id }) !== null);
ok("no が0 → null", parseFolderCheckInput({ ...IN, no: 0 }) === null);
ok("dealId の形が違う → null", parseFolderCheckInput({ ...IN, dealId: "x" }) === null);
ok("folderId の形が違う → null", parseFolderCheckInput({ ...IN, folderId: "a/b" }) === null);
ok("配列 → null", parseFolderCheckInput([IN]) === null);
ok("一致", folderMatches(GOOD, IN, DB));
ok("フォルダ違い", !folderMatches({ ...GOOD, folderId: "9ZzZ_otherFolderId" }, IN, DB));
ok("フォルダ欄が空", !folderMatches({ ...GOOD, folderId: null }, IN, DB));
ok("消えたページ", !folderMatches({ ...GOOD, gone: true }, IN, DB));
ok("ほかの DB のページ", !folderMatches({ ...GOOD, parentDbId: "99990000000000000000000000000000" }, IN, DB));
ok("違う案件のページ", !folderMatches({ ...GOOD, id: "ffffffff0123456789ab0123456789ab" }, IN, DB));

(async () => {
  const RAW = JSON.stringify(IN);
  let m = mk(async () => GOOD);
  let r = await handleSateiFolderCheck(TOKEN, RAW, m.deps);
  ok("一致 → 200 {match:true}", r.status === 200 && r.body.match === true);
  ok("ログは J番号と結果だけ", m.r.logs.includes("[satei] folder-check #J12 match") && !m.r.logs.join("").includes(FOLDER) && !m.r.logs.join("").includes("0123abcd"));

  m = mk(async () => ({ ...GOOD, folderId: "9ZzZ_otherFolderId" }));
  r = await handleSateiFolderCheck(TOKEN, RAW, m.deps);
  ok("不一致 → 200 {match:false}", r.status === 200 && r.body.match === false && m.r.logs.includes("[satei] folder-check #J12 mismatch"));

  m = mk(async () => {
    throw new Error("notion");
  });
  r = await handleSateiFolderCheck(TOKEN, RAW, m.deps);
  ok("Notion の失敗 → 503", r.status === 503 && r.body.match === undefined);

  m = mk(async () => null);
  r = await handleSateiFolderCheck(TOKEN, RAW, m.deps);
  ok("ページが見つからない（読めない）→ 503", r.status === 503);

  m = mk(() => new Promise<SateiDeal | null>(() => undefined), env, 50);
  r = await handleSateiFolderCheck(TOKEN, RAW, m.deps);
  ok("時間切れ → 503", r.status === 503);

  m = mk(async () => GOOD);
  r = await handleSateiFolderCheck("0".repeat(64), RAW, m.deps);
  ok("鍵違い → 401・Notion を読まない", r.status === 401 && m.r.reads === 0);
  r = await handleSateiFolderCheck(null, RAW, m.deps);
  ok("ヘッダ無し → 401", r.status === 401 && m.r.reads === 0);
  m = mk(async () => GOOD, { ...env, TASK_SATEI: "" });
  r = await handleSateiFolderCheck("bad", RAW, m.deps);
  ok("off でも鍵違いは 401", r.status === 401);
  r = await handleSateiFolderCheck(TOKEN, RAW, m.deps);
  ok("off → 503・Notion を読まない", r.status === 503 && m.r.reads === 0);
  m = mk(async () => GOOD, { ...env, CRM_DEALS_DB_ID: "" });
  r = await handleSateiFolderCheck(TOKEN, RAW, m.deps);
  ok("CRM_DEALS_DB_ID 未設定 → 503", r.status === 503 && m.r.reads === 0);
  m = mk(async () => GOOD);
  r = await handleSateiFolderCheck(TOKEN, "{bad", m.deps);
  ok("JSON でない → 400", r.status === 400 && m.r.reads === 0);
  r = await handleSateiFolderCheck(TOKEN, JSON.stringify({ ...IN, folderId: "" }), m.deps);
  ok("形が違う → 400", r.status === 400 && m.r.reads === 0);

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
