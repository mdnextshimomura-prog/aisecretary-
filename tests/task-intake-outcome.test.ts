/**
 * @秘書 あての発言を登録しなかった枝の、理由のログと返事（2026-11-13）。
 * 枝ごとに符号1行だけを出し、本文・ID を出さないこと。返事は @秘書 あてと分かるときだけ。
 */
import {
  MSG_INTAKE_NOT_REGISTERED,
  MSG_INTAKE_TYPED_MENTION,
  finishNoBotMention,
  finishUnregisteredIntake,
  hasTypedBotMention,
  logTaskIntake,
  unregisteredReason,
} from "../src/lib/task-intake";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};

function fake() {
  const logs: string[] = [];
  const sent: { token: string; text: string }[] = [];
  return {
    logs,
    sent,
    log: (l: string) => logs.push(l),
    send: async (token: string, text: string) => {
      sent.push({ token, text });
      return "id";
    },
  };
}

async function main() {
  // ── 手打ちの「@秘書」の見分け ──
  ok("手打ちの @秘書 を拾う", hasTypedBotMention("@秘書 契約書の確認", []));
  ok("手打ちの @AI秘書 を拾う", hasTypedBotMention("@AI秘書 明日までに見積", undefined));
  ok("全角の ＠ＡＩ秘書 も拾う", hasTypedBotMention("＠ＡＩ秘書　見積", []));
  ok("ふつうの会話は拾わない", !hasTypedBotMention("秘書さんにお願いしておきます", []));
  ok("@ の無い「AI秘書」は拾わない", !hasTypedBotMention("AI秘書に頼んだ件", []));
  ok("「@秘書課」は別の言葉", !hasTypedBotMention("@秘書課 へ連絡", []));
  ok(
    "本物のメンションの範囲にある @AI秘書 は数えない（userId の設定違い）",
    !hasTypedBotMention("@AI秘書 見積", [{ type: "user", userId: "U_OTHER", index: 0, length: 5 }])
  );
  ok(
    "社員のメンションとは別に手打ちの @秘書 があれば拾う",
    hasTypedBotMention("@杉山 舜 @秘書 見積", [{ type: "user", userId: "U_S", index: 0, length: 5 }])
  );
  ok("本文が無ければ拾わない", !hasTypedBotMention(undefined, undefined));
  ok("文の途中（空白のあと）の @秘書 も拾う", hasTypedBotMention("これ見て @秘書 お願い", []));
  ok("区切りの記号のあとの @秘書 を拾う", hasTypedBotMention("確認、@秘書。", []));
  ok("行末の @AI秘書 を拾う", hasTypedBotMention("見積の件 @AI秘書", []));
  ok("改行のあとの @秘書 を拾う", hasTypedBotMention("見積の件\n@秘書 明日まで", []));
  ok("「@秘書bot」は拾わない", !hasTypedBotMention("@秘書bot 見積", []));
  ok("「@秘書2」は拾わない", !hasTypedBotMention("@秘書2 見積", []));
  ok("メールの形 office@秘書.example.jp は拾わない", !hasTypedBotMention("宛先は office@秘書.example.jp です", []));
  ok("「@秘書.example.jp」も拾わない", !hasTypedBotMention("@秘書.example.jp", []));
  ok("かなが続く「@秘書が」は拾わない", !hasTypedBotMention("@秘書がやってくれます", []));
  ok("「」の中の説明は拾わない", !hasTypedBotMention("「@秘書」と入力してください", []));
  ok("『』の中は拾わない", !hasTypedBotMention("『@AI秘書 見積』と送ると登録されます", []));
  ok("“”の中は拾わない", !hasTypedBotMention("“@秘書 見積” の形で", []));
  ok('"" の中は拾わない', !hasTypedBotMention('"@秘書" と打つ', []));
  ok("引用が閉じたあとの @秘書 は拾う", hasTypedBotMention("「見積」の件 @秘書 お願いします", []));
  ok("漢字・かなの直後の @秘書 は拾わない（メールの local part と同じく狭く）", !hasTypedBotMention("これ@秘書", []));

  // ── 理由の分け方 ──
  ok("タスクでない → not-task", unregisteredReason({ isTask: false, confidence: 0.9 }, 0.5) === "not-task");
  ok("確信度 0.49 → low-conf", unregisteredReason({ isTask: true, confidence: 0.49 }, 0.5) === "low-conf");
  ok("確信度 0.5 → candidate-range", unregisteredReason({ isTask: true, confidence: 0.5 }, 0.5) === "candidate-range");
  ok("確信度 0.69 → candidate-range", unregisteredReason({ isTask: true, confidence: 0.69 }, 0.5) === "candidate-range");

  // ── (a) メンションなし ──
  {
    const f = fake();
    await finishNoBotMention({ isGroup: true, typedMention: false, replyTokenUsed: false, replyToken: "R", send: f.send, log: f.log });
    ok("(a) ふつうの会話：mention-none のログ1行", f.logs.length === 1 && f.logs[0] === "[task-intake] mention-none", JSON.stringify(f.logs));
    ok("(a) ふつうの会話：返事をしない", f.sent.length === 0);
  }
  {
    const f = fake();
    await finishNoBotMention({ isGroup: true, typedMention: true, replyTokenUsed: false, replyToken: "R", send: f.send, log: f.log });
    ok("(a) 手打ちの @秘書：typed-mention のログ1行", f.logs.length === 1 && f.logs[0] === "[task-intake] typed-mention", JSON.stringify(f.logs));
    ok("(a) 手打ちの @秘書：一覧から選ぶよう返す", f.sent.length === 1 && f.sent[0].token === "R" && f.sent[0].text === MSG_INTAKE_TYPED_MENTION);
  }
  {
    const f = fake();
    await finishNoBotMention({ isGroup: true, typedMention: true, replyTokenUsed: true, replyToken: "R", send: f.send, log: f.log });
    ok("(a) 候補の返事で replyToken を使ったあとは返さない", f.sent.length === 0 && f.logs[0] === "[task-intake] typed-mention");
  }
  {
    const f = fake();
    await finishNoBotMention({ isGroup: false, typedMention: true, replyTokenUsed: false, replyToken: "R", send: f.send, log: f.log });
    ok("(a) 1対1の手打ちは返さない（mention-none）", f.sent.length === 0 && f.logs[0] === "[task-intake] mention-none");
  }

  // ── (b)(c) @秘書 あてで登録しなかった ──
  for (const code of ["not-task", "low-conf", "candidate-skip"] as const) {
    const f = fake();
    await finishUnregisteredIntake({ code, replyToken: "R", send: f.send, log: f.log });
    ok(`${code}：ログは符号1行`, f.logs.length === 1 && f.logs[0] === `[task-intake] ${code}`, JSON.stringify(f.logs));
    ok(`${code}：受け付けなかったことを返す`, f.sent.length === 1 && f.sent[0].token === "R" && f.sent[0].text === MSG_INTAKE_NOT_REGISTERED);
  }
  for (const code of ["candidate-saved", "candidate-exists"] as const) {
    const f = fake();
    await finishUnregisteredIntake({ code, replyToken: "R", send: f.send, log: f.log });
    ok(`${code}：ログ1行・返事はしない`, f.logs.length === 1 && f.logs[0] === `[task-intake] ${code}` && f.sent.length === 0);
  }
  {
    const f = fake();
    await finishUnregisteredIntake({ code: "candidate-save-failed", replyToken: "R", send: f.send, log: f.log });
    ok("candidate-save-failed：ログ1行・受け付けなかったことを返す", f.logs[0] === "[task-intake] candidate-save-failed" && f.sent.length === 1 && f.sent[0].text === MSG_INTAKE_NOT_REGISTERED);
  }
  {
    // 候補の置き場：新規・既存・失敗を分けて返す（KV 未設定＝メモリ経路、TASK_MENU off）
    const store = await import("../src/lib/task-candidate-store");
    store._resetMemoryForTest();
    const c = { id: "m-outcome-1", text: "t", title: "t", assignee: null, assigneeUserId: null, senderId: null, createdAt: Date.now() };
    ok("1回目は added", (await store.addCandidateResult(c)) === "added");
    ok("同じ発言の2回目は exists", (await store.addCandidateResult(c)) === "exists");
    ok("addCandidate は今までどおり2回目に false", (await store.addCandidate(c)) === false);
    store._resetMemoryForTest();
  }
  {
    const logs: string[] = [];
    let threw = false;
    try {
      await finishUnregisteredIntake({
        code: "not-task",
        replyToken: "R",
        send: async () => {
          throw new Error("line down");
        },
        log: (l) => logs.push(l),
      });
    } catch {
      threw = true;
    }
    ok("返事が送れなくても例外を外に出さない", !threw && logs.includes("[task-intake] reply-failed"));
  }
  {
    const logs: string[] = [];
    logTaskIntake("registered", (l) => logs.push(l));
    ok("registered のログ", logs.length === 1 && logs[0] === "[task-intake] registered");
  }
  ok("返事の文に @秘書 と送り直し方がある", MSG_INTAKE_NOT_REGISTERED.includes("もう一度 @秘書") && MSG_INTAKE_NOT_REGISTERED.includes("期限や担当"));

  // route.ts を通した動きは tests/task-intake-webhook.test.ts（POST を本物のまま呼ぶ）で確かめる。

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
}
main();
