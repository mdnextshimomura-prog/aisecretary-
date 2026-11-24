/**
 * 押したときにトークに出る文（displayText）に件名が入ること（2026-11-24 下村さん指示）。
 */
import { pressedText, POSTBACK_TEXT_MAX } from "../src/lib/task-card";
import { assigneeCard, postponeCard, taskCard } from "../src/lib/task-buttons";
import { candidateBubble } from "../src/lib/candidate-card";
import { sateiDraftCard, sateiResumeCard } from "../src/lib/satei-text";

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

type Act = { type: string; displayText?: string };
const acts = (m: unknown): Act[] => {
  const out: Act[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.type === "postback" && "data" in o) out.push(o as Act);
    for (const x of Object.values(o)) walk(x);
  };
  walk(m);
  return out;
};

ok("件名あり", pressedText("済にする", "重説の作成") === "（ボタン）【重説の作成】済にする");
ok("件名なしは今までの形", pressedText("済にする", "  ") === "（ボタン）済にする" && pressedText("済にする") === "（ボタン）済にする");
ok("改行・連続空白は1つの空白に", pressedText("済", "a\n\n b") === "（ボタン）【a b】済");
{
  const t = pressedText("済にする", "あ".repeat(500));
  ok("長い件名は40字で切る（…付き）", t === `（ボタン）【${"あ".repeat(39)}…】済にする`, t);
  ok("300字以内", Array.from(t).length <= POSTBACK_TEXT_MAX);
}

const INFO = { pageId: "00000001-aaaa-bbbb-cccc-1234567890ab", title: "決済の段取り", due: null, assignee: null };
ok("タスクの5つ全部に件名", acts(taskCard(INFO)).every((a) => a.displayText?.startsWith("（ボタン）【決済の段取り】")));
const pp = acts(postponeCard(INFO, "2026-11-24"));
ok("延期の選択肢にも件名", pp.length > 0 && pp.every((a) => /^（ボタン）【決済の段取り】延期：/.test(a.displayText ?? "")));
const as = acts(assigneeCard(INFO, [{ name: "田中", active: true, external: false, userIds: ["U" + "a".repeat(32)] } as never]));
ok("担当の選択肢にも件名", as.length === 1 && as[0].displayText === "（ボタン）【決済の段取り】担当を変える：田中", as[0]?.displayText);

{
  const cb = acts(candidateBubble({ id: "123", title: "鍵の受け取り", createdAt: Date.now() } as never, () => null));
  ok("候補の3つに件名", cb.length === 3 && cb.every((a) => a.displayText?.startsWith("（ボタン）【鍵の受け取り】")));
}

const draft = sateiDraftCard({
  kind: "draft", no: 12, generation: 1, dealName: "大宮1丁目", driveFileId: "f".repeat(20), artifactSha256: "a".repeat(64), verdict: "要修正", findings: [],
} as never);
const da = acts(draft);
ok("査定の OK・差し戻しに #J と案件名", da.length === 2 && da.every((a) => a.displayText?.startsWith("（ボタン）【#J12 大宮1丁目】")), JSON.stringify(da));
const ra = acts(sateiResumeCard(12, "00000001-aaaa-bbbb-cccc-1234567890ab"));
ok("もう一度作るに #J", ra[0]?.displayText === "（ボタン）【#J12】査定書をもう一度作る");

if (fail > 0) {
  console.log(`\n${fail} 件失敗`);
  process.exit(1);
}
console.log("\nすべて成功");
