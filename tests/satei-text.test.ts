/**
 * B2 査定書：返事・通知の文面と下書きカード（satei-text.ts）。
 */
import { parseSateiData } from "../src/lib/satei-data";
import {
  driveViewUrl,
  jobTag,
  MSG_SATEI_AWAITING_REASON,
  msgSateiAccepted,
  msgSateiInProgress,
  msgSateiReasonClosed,
  msgSateiReasonFailed,
  msgSateiRejectAsk,
  sateiDraftCard,
  sateiNoticeMessages,
  sateiNoticeText,
  type SateiNotice,
} from "../src/lib/satei-text";
import type { FlexMessage } from "../src/lib/task-card";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};

const SHA = "b".repeat(64);
const DRAFT: SateiNotice = {
  no: 12,
  kind: "draft",
  generation: 3,
  dealName: "テストマンション101",
  driveFileId: "1FileId_abcdefghij",
  verdict: "要修正",
  findings: ["指摘1", "指摘2", "指摘3", "指摘4"],
  missing: [],
  failReason: null,
  artifactSha256: SHA,
};
const HEAD = "【査定書 #J12・テストマンション101】\n";

ok("J番号の形", jobTag(12) === "#J12");
ok("受付の返事", msgSateiAccepted(5) === "受け付けました。結果は個人の LINE に届きます（#J5）");
ok("作成中の返事", msgSateiInProgress(4) === "作成中です（#J4）");
ok(
  "差し戻しの返事",
  msgSateiRejectAsk(12) === "差し戻しました（#J12）。理由を一言返信してください（次の1通を理由として記録します）",
);
ok(
  "理由待ちの返事（契約 6-10）",
  MSG_SATEI_AWAITING_REASON === "差し戻しの理由を待っています（理由を返信するか、30分後に押し直してください）",
);
ok("理由の記録に失敗（契約 6-11）", msgSateiReasonFailed(12) === "記録できませんでした。もう一度送ってください（#J12）");
ok("理由を受ける段を過ぎた", msgSateiReasonClosed(12) === "理由を記録できませんでした。この差し戻しはもう閉じています（#J12）");

// ── 下書きカード ──
const msgs = sateiNoticeMessages(DRAFT);
ok("draft は Flex 1通", msgs !== null && msgs.length === 1 && (msgs[0] as FlexMessage).type === "flex");
const card = sateiDraftCard(DRAFT) as FlexMessage;
const json = JSON.stringify(card);
ok("見出し", json.includes("🏢 査定書の下書きができました（#J12・テストマンション101）"));
ok("altText も見出し", card.altText === "🏢 査定書の下書きができました（#J12・テストマンション101）");
ok("判定", json.includes("判定：要修正"));
ok("指摘は上位3件まで", json.includes("・指摘3") && !json.includes("指摘4"));
type Act = { type: string; label: string; uri?: string; data?: string; displayText?: string };
const acts = ((card.contents as { footer: { contents: Array<{ action: Act }> } }).footer.contents).map((b) => b.action);
ok("ボタンは3つ", acts.length === 3);
ok("下書きを見る＝Drive の閲覧 URL", acts[0].type === "uri" && acts[0].label === "下書きを見る" && acts[0].uri === "https://drive.google.com/file/d/1FileId_abcdefghij/view");
ok("driveViewUrl", driveViewUrl("X") === "https://drive.google.com/file/d/X/view");
ok(
  "OK の data の往復",
  acts[1].label === "OK" &&
    JSON.stringify(parseSateiData(acts[1].data ?? "")) === JSON.stringify({ op: "so", no: 12, generation: 3, sha256: SHA }),
);
ok(
  "差し戻しの data の往復",
  acts[2].label === "差し戻し" &&
    JSON.stringify(parseSateiData(acts[2].data ?? "")) === JSON.stringify({ op: "sr", no: 12, generation: 3, sha256: SHA }),
);
ok("ラベルは40字以内", acts.every((a) => Array.from(a.label).length <= 40));
const long = JSON.stringify(sateiDraftCard({ ...DRAFT, findings: ["あ".repeat(300)] }));
ok("指摘は1件120字まで", long.includes(`・${"あ".repeat(120)}"`) && !long.includes("あ".repeat(121)));
ok("指摘が無ければ「指摘：なし」", JSON.stringify(sateiDraftCard({ ...DRAFT, findings: [] })).includes("指摘：なし"));
ok("案件名が空なら（無題）", JSON.stringify(sateiDraftCard({ ...DRAFT, dealName: "" })).includes("（#J12・（無題））"));
ok("Drive ID が無い draft は作らない", sateiNoticeMessages({ ...DRAFT, driveFileId: null }) === null);
ok("sha が無い draft は作らない", sateiDraftCard({ ...DRAFT, artifactSha256: null }) === null);
ok("判定が無い draft は作らない", sateiDraftCard({ ...DRAFT, verdict: null }) === null);

// ── 文字の通知 ──
const base: SateiNotice = { ...DRAFT, kind: "failed", driveFileId: null, verdict: null, findings: [], artifactSha256: null };
ok(
  "failed materials",
  sateiNoticeText({ ...base, failReason: "materials", missing: ["成約事例のPDF", "専有面積"] }) ===
    `${HEAD}材料が足りないので作っていません：成約事例のPDF、専有面積。入れたら［査定書を作る］を押し直してください`,
);
ok("failed timeout", sateiNoticeText({ ...base, failReason: "timeout" }) === `${HEAD}作れませんでした（時間切れ）。押し直すと最初からやり直します`);
ok("failed check", sateiNoticeText({ ...base, failReason: "check" }) === `${HEAD}作れませんでした（検品できませんでした）。押し直すと最初からやり直します`);
ok("failed internal", sateiNoticeText({ ...base, failReason: "internal" }) === `${HEAD}作れませんでした（内部のエラー）。押し直すと最初からやり直します`);
ok("failed 理由なし → internal と同じ", sateiNoticeText({ ...base, failReason: null }) === `${HEAD}作れませんでした（内部のエラー）。押し直すと最初からやり直します`);
ok("failed folder", sateiNoticeText({ ...base, failReason: "folder" }) === `${HEAD}案件フォルダを確かめられませんでした`);
ok("saved", sateiNoticeText({ ...base, kind: "saved" }) === `${HEAD}案件フォルダの 02_査定・事例 に保存しました`);
ok(
  "aborted input-changed",
  sateiNoticeText({ ...base, kind: "aborted", failReason: "input-changed" }) ===
    `${HEAD}資料が変わったので保存していません。［査定書を作る］を押し直してください`,
);
ok(
  "aborted name-conflict",
  sateiNoticeText({ ...base, kind: "aborted", failReason: "name-conflict" }) ===
    `${HEAD}同じ名前で中身の違うファイルがあるので保存していません`,
);
const sm = sateiNoticeMessages({ ...base, kind: "saved" });
ok("draft 以外は文字1通", JSON.stringify(sm) === JSON.stringify([{ type: "text", text: `${HEAD}案件フォルダの 02_査定・事例 に保存しました` }]));

if (fail > 0) {
  console.log(`\n${fail} 件失敗`);
  process.exit(1);
}
console.log("\nすべて成功");
