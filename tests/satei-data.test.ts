/**
 * B2 査定書：スイッチ・押せる人・postback の data（satei-data.ts）。外部へ通信しない。
 */
import {
  encodeSateiDecision,
  encodeSateiStart,
  isSateiUser,
  parseSateiData,
  sateiActive,
  sateiNotifyTarget,
  sateiReasonKey,
  sateiUserIds,
  SATEI_REASON_MAX,
  SATEI_REASON_TTL,
} from "../src/lib/satei-data";
import { parseButtonData, parseMenuData } from "../src/lib/task-buttons";
import { parseDealData } from "../src/lib/deal-card";
import { parseCandidateData } from "../src/lib/candidate-card";

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

const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const DEAL = "0123abcd-0123-4567-89ab-0123456789ab";
const SHA = "a".repeat(64);

ok("既定は off", !sateiActive({}));
ok("TASK_SATEI=1 で on", sateiActive({ TASK_SATEI: "1" }));
ok("1 以外は off", !sateiActive({ TASK_SATEI: "true" }) && !sateiActive({ TASK_SATEI: "0" }));
ok(
  "押せる人は空白・空要素・形の違う値を捨てて読む",
  JSON.stringify(sateiUserIds({ TASK_SATEI_USER_IDS: ` ${SHIMO}, x ,,${STAFF}` })) ===
    JSON.stringify([SHIMO, STAFF]),
);
ok("通知先は先頭の人", sateiNotifyTarget({ TASK_SATEI_USER_IDS: `${SHIMO},${STAFF}` }) === SHIMO);
ok("未設定なら通知先なし", sateiNotifyTarget({}) === null);
ok(
  "入っている人だけ",
  isSateiUser(SHIMO, { TASK_SATEI_USER_IDS: SHIMO }) &&
    !isSateiUser(STAFF, { TASK_SATEI_USER_IDS: SHIMO }) &&
    !isSateiUser(undefined, { TASK_SATEI_USER_IDS: SHIMO }) &&
    !isSateiUser(SHIMO, {}),
);

const sa = encodeSateiStart(DEAL);
ok("sa の data", sa === `v1|sa|${DEAL}`);
ok("sa の往復", JSON.stringify(parseSateiData(sa)) === JSON.stringify({ op: "sa", dealId: DEAL }));
const so = encodeSateiDecision("so", 12, 3, SHA);
ok("so の data", so === `v1|so|12|3|${SHA}`);
ok(
  "so の往復",
  JSON.stringify(parseSateiData(so)) === JSON.stringify({ op: "so", no: 12, generation: 3, sha256: SHA }),
);
const sr = encodeSateiDecision("sr", 7, 1, SHA);
ok(
  "sr の往復",
  JSON.stringify(parseSateiData(sr)) === JSON.stringify({ op: "sr", no: 7, generation: 1, sha256: SHA }),
);
ok("いちばん長い data も 300 字以内", encodeSateiDecision("sr", 999999999, 999999, SHA).length <= 300);
for (const bad of [
  "v1|sa|xyz",
  `v1|sa|${DEAL}|1`,
  `v1|so|0|1|${SHA}`,
  `v1|so|012|1|${SHA}`,
  `v1|so|12|0|${SHA}`,
  `v1|so|12|1|${"A".repeat(64)}`,
  `v1|so|12|1|${"a".repeat(63)}`,
  "v1|so|12|1",
  `v1|sx|12|1|${SHA}`,
  `v2|so|12|1|${SHA}`,
  "",
]) {
  ok(`形の違う data は読まない: ${bad.slice(0, 16)}`, parseSateiData(bad) === null);
}
for (const d of [sa, so, sr]) {
  ok(
    `既存の読み方は ${d.slice(0, 5)} を拾わない`,
    parseButtonData(d) === null &&
      parseMenuData(d) === null &&
      parseDealData(d) === null &&
      parseCandidateData(d) === null,
  );
}
ok("理由の印の鍵", sateiReasonKey(SHIMO) === `satei:reason:${SHIMO}`);
ok("理由の印は30分・200字", SATEI_REASON_TTL === 1800 && SATEI_REASON_MAX === 200);

if (fail > 0) {
  console.log(`\n${fail} 件失敗`);
  process.exit(1);
}
console.log("\nすべて成功");
