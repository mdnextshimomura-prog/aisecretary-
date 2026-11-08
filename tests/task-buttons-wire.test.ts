/**
 * postback イベントの入口（handleTaskPostbackEvent）と、初動確認セッションのつなぎ（sessionDeps）。
 * LINE の返事・KV の予約は差し替え、Notion・名簿も差し替える。セッションは KV 未設定のメモリで動かす。
 */
import {
  handleTaskPostbackEvent,
  sessionDeps,
  MSG_BUSY,
  type PostbackIo,
} from "../src/lib/task-buttons-wire";
import { MSG_CLOSED, MSG_PAUSED, type ButtonDeps, type ButtonTask } from "../src/lib/task-buttons";
import { cardActions, type FlexMessage } from "../src/lib/task-card";
import {
  completeEvent,
  reserveEvent,
  getPendingTaskConfirm,
  savePendingTaskConfirm,
  confirmQuoteMatches,
  addPendingHandoff,
  getPendingHandoffs,
  deletePendingTaskConfirm,
  acquireLock,
  releaseLock,
} from "../src/lib/email/session";
import { statusForConfirmComplete } from "../src/lib/task-closed";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};

// 外部（LINE・Notion・KV）へ通信したら失敗にする（どのテストも差し替えだけで動くことを確かめる）
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("このテストで外部へ通信してはいけない");
}) as typeof fetch;

const PAGE = "1234abcd-1234-1234-1234-1234567890ab";
const U2 = `U${"2".padStart(32, "0")}`;
const U4 = `U${"4".padStart(32, "0")}`;

let writes: string[] = [];
let replies: Array<{ text: string; card?: FlexMessage }> = [];
let logs: string[] = [];
let completed: string[] = [];

const deps: ButtonDeps = {
  getTask: async () => ({
    id: PAGE,
    title: "重説",
    closed: false,
    assigneeId: U2,
    requesterId: null,
  }),
  members: async () => [],
  complete: async () => {
    writes.push("complete");
  },
  status: {
    update: async () => {
      writes.push("update");
    },
    defaultCheckDate: async () => "2026-11-12",
  },
  setAssignee: async () => {
    writes.push("assign");
  },
  today: () => "2026-11-09",
  session: {
    clear: async () => {
      writes.push("session-clear");
    },
    syncAssignee: async () => {
      writes.push("session-assign");
    },
  },
};

const claims = new Set<string>();
function io(over: Partial<PostbackIo> = {}): Partial<PostbackIo> {
  return {
    deps,
    reserve: async (key) => {
      if (claims.has(key)) return { proceed: false };
      claims.add(key);
      return { proceed: true };
    },
    complete: async (key) => {
      completed.push(key);
    },
    reply: async (_rt, text, card) => {
      replies.push({ text, card });
      return "m1";
    },
    log: (line) => logs.push(line),
    readMessageIds: async () => [],
    setMessageIds: async () => undefined,
    lock: acquireLock,
    unlock: releaseLock,
    sleep: async () => undefined,
    ...over,
  };
}
const ev = (data: string, id?: string) => ({
  type: "postback",
  replyToken: "rt",
  webhookEventId: id,
  source: { userId: U2, groupId: "G1" },
  postback: { data },
});
const reset = () => {
  writes = [];
  replies = [];
  logs = [];
  completed = [];
};

async function main() {
  // ── スイッチ ──
  delete process.env.TASK_BUTTONS;
  process.env.TASK_FOLLOWUP = "1";
  await handleTaskPostbackEvent(ev("action=other"), io());
  ok("v1| でない postback は扱わない", replies.length === 0);
  await handleTaskPostbackEvent(ev(`v1|done|${PAGE}`, "E0"), io());
  ok(
    "TASK_BUTTONS が off なら書かずに止めている旨を返す",
    writes.length === 0 && replies[0]?.text === MSG_PAUSED,
    JSON.stringify(replies),
  );
  ok(
    "文面",
    MSG_PAUSED === "いまボタン操作は止めています。文字で操作してください",
  );
  reset();
  process.env.TASK_BUTTONS = "1";
  delete process.env.TASK_FOLLOWUP;
  await handleTaskPostbackEvent(ev(`v1|wait|${PAGE}`, "E00"), io());
  ok(
    "TASK_FOLLOWUP が off でも書かずに止めている旨を返す",
    writes.length === 0 && replies[0]?.text === MSG_PAUSED,
  );
  process.env.TASK_FOLLOWUP = "1";

  // ── ふつうに押す ──
  reset();
  await handleTaskPostbackEvent(ev(`v1|wait|${PAGE}`, "E1"), io());
  ok("待ち：書いて返す", writes.join() === "update" && replies.length === 1);
  ok(
    "待ち：カードを付け直す（2通目のカード）",
    replies[0]?.card?.type === "flex" && cardActions(replies[0].card).length === 5,
  );
  ok("待ち：1通目の文は今の文面のまま", replies[0]?.text.startsWith("⏸ 待ちにしました"), replies[0]?.text);
  ok("完了印を付ける", completed.join() === "pb:E1");

  reset();
  await handleTaskPostbackEvent(ev(`v1|wait|${PAGE}`, "E1"), io());
  ok(
    "同じイベントの再送は二重に書かない",
    writes.length === 0 && replies.length === 0,
  );

  reset();
  await handleTaskPostbackEvent(ev("v1|done|bad", "E2"), io());
  ok(
    "形式不正は書かずに知らせる",
    writes.length === 0 && replies[0]?.text === "⚠️ このボタンは使えません",
  );

  reset();
  await handleTaskPostbackEvent(
    ev(`v1|done|${PAGE}`, "E3"),
    io({
      deps: {
        ...deps,
        complete: async () => {
          throw new Error("notion down");
        },
      },
    }),
  );
  ok(
    "書けなかったら知らせる（例外を投げない）",
    String(replies[0]?.text).startsWith("⚠️ 書き込めませんでした"),
  );

  // ── 見つからないタスク（完了印を付けない） ──
  reset();
  await handleTaskPostbackEvent(ev(`v1|done|${PAGE}`, "E11"), io({
    deps: { ...deps, getTask: async () => null },
  }));
  ok(
    "見つからない：確認できませんでしたと返し、書かない",
    writes.length === 0 && String(replies[0]?.text).startsWith("このタスクを確認できませんでした"),
    replies[0]?.text,
  );
  ok("見つからない：完了印を付けない", completed.length === 0, completed.join());

  // ── 返事の失敗（5） ──
  reset();
  await handleTaskPostbackEvent(
    ev(`v1|wait|${PAGE}`, "E4"),
    io({
      reply: async () => null,
    }),
  );
  ok(
    "返事が送れなければ reply-failed をログに出す",
    logs.some((l) => l.startsWith("[task-buttons] reply-failed wait")),
    logs.join(" / "),
  );
  ok(
    "ログに本文・ID を出さない",
    !logs.some((l) => l.includes(U2) || l.includes(PAGE) || l.includes("重説")),
  );
  ok(
    "Notion は書けているので完了印は付ける",
    writes.join() === "update" && completed.join() === "pb:E4",
  );
  reset();
  await handleTaskPostbackEvent(
    ev(`v1|wait|${PAGE}`, "E5"),
    io({
      reply: async () => {
        throw new Error("network");
      },
    }),
  );
  ok(
    "返事が例外でも reply-failed を出し、投げない",
    logs.some((l) => l.startsWith("[task-buttons] reply-failed wait")),
    logs.join(" / "),
  );
  ok("例外でも完了印は付ける", completed.join() === "pb:E5");

  // ── KV の障害（6） ──
  reset();
  await handleTaskPostbackEvent(
    ev(`v1|done|${PAGE}`, "E6"),
    io({
      reserve: async () => {
        throw new Error("kv down");
      },
    }),
  );
  ok("予約が例外なら書かない", writes.length === 0);
  ok(
    "予約が例外なら待ってと返す",
    replies[0]?.text === MSG_BUSY,
    replies[0]?.text,
  );
  ok(
    "文面",
    MSG_BUSY ===
      "いま操作を受け付けられません。少し待ってからもう一度押してください",
  );
  reset();
  await handleTaskPostbackEvent(
    ev(`v1|wait|${PAGE}`, "E7"),
    io({
      complete: async () => {
        throw new Error("kv down");
      },
    }),
  );
  ok(
    "完了印の失敗は mark-failed を種別だけ出す",
    logs.includes("[task-buttons] mark-failed"),
    logs.join(" / "),
  );
  ok("完了印が失敗しても返事は出る", replies.length === 1);

  // ── 初動確認のセッション（1） ──
  const base = {
    pageId: PAGE,
    title: "重説",
    requestType: "その他",
    createdByUserId: U2,
    fields: [],
    awaitingKeys: ["x"],
    proposalKeys: [],
    settled: {},
    assignee: "田中 一郎",
    assigneeUserId: U2,
    createdAt: Date.now(),
  };
  await savePendingTaskConfirm("G1", { ...base });
  const s = sessionDeps("G1");
  await s.syncAssignee(PAGE, "鈴木 次郎", U4);
  const after = await getPendingTaskConfirm("G1", null, PAGE);
  ok(
    "担当変更：残っている確認セッションの担当を合わせる",
    after?.assignee === "鈴木 次郎" && after?.assigneeUserId === U4,
    JSON.stringify(after),
  );
  // Notion が書けなければ、セッションは残り、完了印も付けない
  reset();
  await handleTaskPostbackEvent(ev(`v1|done|${PAGE}`, "E8"), io({
    deps: {
      ...deps,
      session: sessionDeps("G1"),
      complete: async () => {
        throw new Error("notion down");
      },
    },
  }));
  ok("Notion 失敗：セッションが残る", (await getPendingTaskConfirm("G1", null, PAGE)) !== null);
  ok("Notion 失敗：完了印を付けない", completed.length === 0, completed.join());
  // 本物の予約（メモリ）で：Notion 失敗のあとも予約は付けたまま（外すと、古いイベントの再実行で上書きしうる）
  reset();
  await handleTaskPostbackEvent(ev(`v1|done|${PAGE}`, "E8b"), {
    ...io({
      deps: {
        ...deps,
        complete: async () => {
          throw new Error("notion down");
        },
      },
    }),
    reserve: reserveEvent,
    complete: completeEvent,
  });
  const again = await reserveEvent("pb:E8b");
  ok(
    "Notion 失敗：予約は外さず、完了印も付けない（処理中のまま）",
    !again.proceed && Boolean((again as { inProgress?: boolean }).inProgress),
    JSON.stringify(again),
  );
  ok("Notion 失敗：もう一度の返事", String(replies[0]?.text).startsWith("⚠️ 書き込めませんでした"));
  // 成功ならセッションが消える
  reset();
  await handleTaskPostbackEvent(ev(`v1|done|${PAGE}`, "E9"), io({
    deps: { ...deps, session: sessionDeps("G1") },
  }));
  ok("成功：セッションが消える", (await getPendingTaskConfirm("G1", null, PAGE)) === null);
  ok("成功：完了印を付ける", completed.join() === "pb:E9");
  await savePendingTaskConfirm("G1", { ...base });
  // セッション削除の失敗は種別だけログ、返事は成功
  reset();
  await handleTaskPostbackEvent(ev(`v1|done|${PAGE}`, "E10"), io({
    deps: {
      ...deps,
      session: {
        ...deps.session,
        clear: async () => {
          throw new Error("kv down");
        },
      },
    },
  }));
  ok("削除失敗：session-clear-failed を出す", logs.includes("[task-buttons] session-clear-failed"), logs.join(" / "));
  ok("削除失敗：返事は成功のまま", String(replies[0]?.text).startsWith("☑️ 完了にしました"));
  ok("削除失敗：完了印は付ける", completed.join() === "pb:E10");
  await s.clear(PAGE);
  ok(
    "済・不要：確認セッションを消す",
    (await getPendingTaskConfirm("G1", null, PAGE)) === null,
  );
  await s.clear(PAGE);
  await s.syncAssignee(PAGE, "鈴木 次郎", U4);
  ok(
    "セッションが無ければ何もしない（作らない）",
    (await getPendingTaskConfirm("G1", null, PAGE)) === null,
  );

  // ── 聞き返し中（初動確認のセッションが残っている）にボタンが押されても壊れない ──
  {
    process.env.TASK_BUTTONS = "1";
    process.env.TASK_FOLLOWUP = "1";
    await savePendingTaskConfirm("G2", { ...base });
    let task: ButtonTask = {
      id: PAGE,
      title: "重説",
      closed: false,
      assigneeId: U2,
      requesterId: null,
      due: "2026-11-20",
      assignee: "田中 一郎",
    };
    const live: ButtonDeps = {
      ...deps,
      getTask: async () => task,
      members: async () => [
        { name: "鈴木 次郎", userIds: [U4], aliases: [], email: null, active: true, external: false, notionUserId: null },
      ],
      complete: async () => {
        writes.push("complete");
        task = { ...task, closed: true };
      },
      session: sessionDeps("G2"),
    };
    reset();
    await handleTaskPostbackEvent(ev(`v1|wait|${PAGE}`, "C1"), io({ deps: live }));
    const s1 = await getPendingTaskConfirm("G2", null, PAGE);
    ok(
      "聞き返し中：待ちを押しても確認セッションはそのまま（回答を待つ）",
      s1 !== null && JSON.stringify(s1.awaitingKeys) === JSON.stringify(["x"]) && writes.join() === "update",
      JSON.stringify(s1),
    );
    ok("聞き返し中：待ちの返事にカード", replies[0]?.card?.type === "flex");
    reset();
    await handleTaskPostbackEvent(ev(`v1|pmenu|${PAGE}`, "C2"), io({ deps: live }));
    ok(
      "聞き返し中：延期の候補はカードのボタン（書かない）",
      writes.length === 0 &&
        JSON.stringify(cardActions(replies[0]!.card!).map((a) => a.label)) ===
          JSON.stringify(["明日", "明後日", "今週金曜", "来週月曜", "来週金曜"]),
    );
    reset();
    await handleTaskPostbackEvent(ev(`v1|amenu|${PAGE}`, "C3"), io({ deps: live }));
    ok(
      "聞き返し中：担当の候補もカードのボタン",
      cardActions(replies[0]!.card!).map((a) => a.label).join() === "鈴木 次郎",
    );
    reset();
    await handleTaskPostbackEvent(ev(`v1|as|${PAGE}|${U4}`, "C4"), io({ deps: live }));
    const s2 = await getPendingTaskConfirm("G2", null, PAGE);
    ok(
      "聞き返し中：担当を替えたら、確認セッションの担当も合わせる（確認が済んでも旧担当へ渡らない）",
      s2?.assignee === "鈴木 次郎" && s2?.assigneeUserId === U4,
      JSON.stringify(s2),
    );
    ok(
      "聞き返し中：担当変更の返事のカードは新しい担当",
      JSON.stringify(replies[0]?.card).includes("鈴木 次郎") &&
        JSON.stringify(replies[0]?.card).includes("11月20日(金)"),
    );
    reset();
    await handleTaskPostbackEvent(ev(`v1|done|${PAGE}`, "C5"), io({ deps: live }));
    ok(
      "聞き返し中：済を押したら確認セッションを消す（後の回答で未着手に戻さない）",
      (await getPendingTaskConfirm("G2", null, PAGE)) === null,
    );
    ok("聞き返し中：済の返事にカードは付けない", replies[0]?.card === undefined && replies[0]?.text.startsWith("☑️"));
    reset();
    await handleTaskPostbackEvent(ev(`v1|wait|${PAGE}`, "C6"), io({ deps: live }));
    ok(
      "閉じたあとのボタンは処理済み（書かない・カードなし）",
      writes.length === 0 && replies[0]?.text === MSG_CLOSED && replies[0]?.card === undefined,
    );
    reset();
    await handleTaskPostbackEvent(ev(`v1|done|${PAGE}`, "C7"), {
      ...io({ deps: live }),
    });
    ok("閉じたあとの済も処理済み（二重に完了しない）", writes.length === 0 && replies[0]?.text === MSG_CLOSED);
    ok(
      "ログに本文・ID・名前を出さない",
      !logs.some((l) => l.includes(U2) || l.includes(U4) || l.includes(PAGE) || l.includes("重説") || l.includes("鈴木")),
      logs.join(" / "),
    );
  }
  {
    // 押せない人：書かず、カードも付けない
    reset();
    await handleTaskPostbackEvent(
      { ...ev(`v1|wait|${PAGE}`, "F1"), source: { userId: U4, groupId: "G1" } },
      io(),
    );
    ok(
      "押せない人：書かない・カードなし",
      writes.length === 0 && replies[0]?.card === undefined && /操作できるのは/.test(replies[0]?.text ?? ""),
      replies[0]?.text,
    );
  }

  // ── カードを引用した回答が確認に結び付く ──
  {
    await savePendingTaskConfirm("G3", { ...base, botMessageId: "TXT1", cardMessageId: "CARD1" });
    const byCard = await getPendingTaskConfirm("G3", "CARD1", null, U4);
    ok("カードを引用した回答：確認に結び付く（引用 ID だけで引く）", byCard?.pageId === PAGE, JSON.stringify(byCard));
    const byText = await getPendingTaskConfirm("G3", "TXT1", null, U4);
    ok("文字の返事を引用した回答：今までどおり結び付く", byText?.pageId === PAGE);
    ok("知らない引用は結び付けない（今までどおり）", (await getPendingTaskConfirm("G3", "OTHER", null, U4)) === null);
    ok(
      "confirmQuoteMatches：text とカードの ID のどちらでも",
      confirmQuoteMatches(byCard, "CARD1") && confirmQuoteMatches(byCard, "TXT1") &&
        !confirmQuoteMatches(byCard, "OTHER") && !confirmQuoteMatches(byCard, null) &&
        !confirmQuoteMatches(null, "CARD1"),
    );
    ok(
      "カードの ID が無い（旧データ・スイッチ off）なら text の ID だけ",
      confirmQuoteMatches({ ...base, botMessageId: "TXT1" }, "TXT1") &&
        !confirmQuoteMatches({ ...base, botMessageId: "TXT1" }, "undefined"),
    );
    await deletePendingTaskConfirm("G3", PAGE);
  }

  // ── 確認待ち → ボタン → 回答 → 引き渡し（route.ts の persist と同じ順で通す） ──
  {
    process.env.TASK_BUTTONS = "1";
    process.env.TASK_FOLLOWUP = "1";
    await savePendingTaskConfirm("G4", { ...base, botMessageId: "TXT4", cardMessageId: "CARD4" });
    let status = "要確認";
    let task: ButtonTask = {
      id: PAGE, title: "重説", closed: false, assigneeId: U2, requesterId: null,
      due: null, assignee: "田中 一郎",
    };
    const flow: ButtonDeps = {
      ...deps,
      getTask: async () => task,
      members: async () => [
        { name: "鈴木 次郎", userIds: [U4], aliases: [], email: null, active: true, external: false, notionUserId: null },
      ],
      status: {
        update: async (_id, props) => {
          const st = (props as { ステータス?: { select?: { name?: string } } }).ステータス?.select?.name;
          if (st) status = st;
        },
        defaultCheckDate: async () => "2026-11-12",
      },
      setAssignee: async (_id, name, uid) => {
        task = { ...task, assignee: name, assigneeId: uid };
      },
      session: sessionDeps("G4"),
    };
    reset();
    // 担当（U2）が待ちを押し、続けて担当を鈴木さん（U4）に替える
    await handleTaskPostbackEvent(ev(`v1|wait|${PAGE}`, "FL1"), io({ deps: flow }));
    await handleTaskPostbackEvent(ev(`v1|as|${PAGE}|${U4}`, "FL2"), io({ deps: flow }));
    ok("流れ：ボタンの待ちで進行中", status === "進行中", status);
    // 回答（カードを引用）→ 条件がそろった → persist と同じ順
    const pending = await getPendingTaskConfirm("G4", "CARD4", null, U2);
    ok("流れ：カードを引用した回答で確認を引ける", pending?.pageId === PAGE);
    const next = await statusForConfirmComplete(true, async () => status);
    await addPendingHandoff("G4", pending!);
    if (next) status = next;
    await deletePendingTaskConfirm("G4", PAGE);
    const handoffs = await getPendingHandoffs("G4");
    ok(
      "流れ：引き渡しは新しい担当あて",
      handoffs.length === 1 && handoffs[0].assignee === "鈴木 次郎" && handoffs[0].assigneeUserId === U4,
      JSON.stringify(handoffs),
    );
    ok("流れ：回答で進行中を未着手に戻さない", status === "進行中", status);
    ok("流れ：確認セッションは消える", (await getPendingTaskConfirm("G4", null, PAGE)) === null);
    // スイッチ off なら今までどおり未着手（読まない）
    let reads = 0;
    const offNext = await statusForConfirmComplete(false, async () => {
      reads++;
      return "進行中";
    });
    ok("流れ（off）：今までどおり未着手で、読まない", offNext === "未着手" && reads === 0);
  }

  // ── 確認待ち → 待ちボタン → 再掲カードを引用して回答 → 確認に結び付く（入口の本物の経路） ──
  {
    process.env.TASK_BUTTONS = "1";
    process.env.TASK_FOLLOWUP = "1";
    await savePendingTaskConfirm("G5", { ...base, botMessageId: "T1", cardMessageId: "C1" });
    let status = "要確認";
    const idWrites: string[][] = [];
    const t5: ButtonTask = {
      id: PAGE, title: "重説", closed: false, assigneeId: U2, requesterId: null,
      due: null, assignee: "田中 一郎", messageIds: ["SRC", "T1", "C1"],
    };
    const d5: ButtonDeps = {
      ...deps,
      getTask: async () => t5,
      status: {
        update: async (_id, props) => {
          const st = (props as { ステータス?: { select?: { name?: string } } }).ステータス?.select?.name;
          if (st) status = st;
        },
        defaultCheckDate: async () => "2026-11-12",
      },
      session: sessionDeps("G5"),
    };
    reset();
    await handleTaskPostbackEvent({ ...ev(`v1|wait|${PAGE}`, "RC1"), source: { userId: U2, groupId: "G5" } }, io({
      deps: d5,
      reply: async (_rt, text, card) => {
        replies.push({ text, card });
        return { textId: "T2", cardId: "C2" };
      },
      readMessageIds: async () => ["SRC", "T1", "C1"],
      setMessageIds: async (_pageId, ids) => {
        idWrites.push(ids);
      },
    }));
    ok(
      "再掲：タスクのメッセージID に text とカードの ID を足す（元発言・最初の返事は保つ）",
      idWrites.length === 1 && idWrites[0].join(",") === "SRC,T1,C1,T2,C2",
      JSON.stringify(idWrites),
    );
    const viaCard = await getPendingTaskConfirm("G5", "C2", null, U4);
    ok("再掲カードを引用した回答が確認に結び付く（確認セッションの照合）", viaCard?.pageId === PAGE, JSON.stringify(viaCard));
    const viaText = await getPendingTaskConfirm("G5", "T2", null, U4);
    ok("再掲の text を引用した回答も結び付く", viaText?.pageId === PAGE);
    ok("最初のカードの引用も今までどおり", (await getPendingTaskConfirm("G5", "C1", null, U4))?.pageId === PAGE);
    ok("confirmQuoteMatches でも再掲の ID を受ける", confirmQuoteMatches(viaCard, "C2"));
    // 条件がそろった → 進行中のまま（今のステータスを読む）
    ok("再掲：待ちで進行中", status === "進行中");
    ok("回答時：進行中は書かない", (await statusForConfirmComplete(true, async () => status)) === null);
    ok(
      "回答時：読めなければ書かない",
      (await statusForConfirmComplete(true, async () => {
        throw new Error("down");
      })) === null,
    );
    ok("ログに ID を出さない", !logs.some((l) => /T2|C2|SRC/.test(l)), logs.join(" / "));

    // ID の保存に失敗しても返事・完了印は成功のまま（種別だけログ）
    reset();
    await handleTaskPostbackEvent({ ...ev(`v1|wait|${PAGE}`, "RC2"), source: { userId: U2, groupId: "G5" } }, io({
      deps: d5,
      reply: async () => ({ textId: "T3", cardId: "C3" }),
      setMessageIds: async () => {
        throw new Error("notion down");
      },
    }));
    ok("ID の保存の失敗は ids-failed を出す", logs.includes("[task-buttons] ids-failed"), logs.join(" / "));
    ok("ID の保存の失敗でも完了印は付ける", completed.join() === "pb:RC2");
    ok("Notion に書けなくても確認セッションには足す", (await getPendingTaskConfirm("G5", "C3", null, U4))?.pageId === PAGE);

    // 確認セッションが無ければ作らない
    await deletePendingTaskConfirm("G5", PAGE);
    reset();
    await handleTaskPostbackEvent({ ...ev(`v1|wait|${PAGE}`, "RC3"), source: { userId: U2, groupId: "G5" } }, io({
      deps: d5,
      reply: async () => ({ textId: "T4", cardId: "C4" }),
      setMessageIds: async () => undefined,
    }));
    ok("確認セッションが無ければ作らない", (await getPendingTaskConfirm("G5", null, PAGE)) === null);
  }

  // ── 同じタスクへの2操作が並んでも、両方の ID が残る（ID の保存だけ KV ロックで囲み、中で読み直す） ──
  {
    process.env.TASK_BUTTONS = "1";
    process.env.TASK_FOLLOWUP = "1";
    await savePendingTaskConfirm("G6", { ...base, botMessageId: "T1", cardMessageId: "C1" });
    let store = ["SRC", "T1", "C1"];
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const shared = {
      deps: { ...deps, session: sessionDeps("G6") },
      readMessageIds: async () => {
        const v = [...store];
        await tick();
        return v;
      },
      setMessageIds: async (_p: string, ids: string[]) => {
        await tick();
        store = ids;
      },
      sleep: () => new Promise<void>((r) => setTimeout(r, 10)),
    };
    let n = 0;
    reset();
    await Promise.all(
      ["PA", "PB"].map((k) =>
        handleTaskPostbackEvent(
          { ...ev(`v1|wait|${PAGE}`, k), source: { userId: U2, groupId: "G6" } },
          io({
            ...shared,
            reply: async () => {
              n++;
              await tick();
              return { textId: `T-${k}`, cardId: `C-${k}` };
            },
          }),
        ),
      ),
    );
    ok(
      "並行2操作：Notion のメッセージID に両方の ID が残る（元の並びも保つ）",
      n === 2 && store.slice(0, 3).join() === "SRC,T1,C1" &&
        ["T-PA", "C-PA", "T-PB", "C-PB"].every((id) => store.includes(id)),
      store.join(),
    );
    const sess = await getPendingTaskConfirm("G6", null, PAGE);
    ok(
      "並行2操作：確認セッションにも両方の ID が残る",
      ["T-PA", "C-PA", "T-PB", "C-PB"].every((id) => sess?.moreMessageIds?.includes(id)),
      JSON.stringify(sess?.moreMessageIds),
    );
    ok("並行2操作：ロックは外れている", (await acquireLock(`taskids:${PAGE}`, 5)) !== null);
    await releaseLock(`taskids:${PAGE}`, "x");

    // ロックが取れないときは ids-busy だけ出し、書かない（返事・完了印は変えない）
    reset();
    let wrote = 0;
    await handleTaskPostbackEvent(
      { ...ev(`v1|wait|${PAGE}`, "PC"), source: { userId: U2, groupId: "G6" } },
      io({
        ...shared,
        reply: async () => ({ textId: "T-PC", cardId: "C-PC" }),
        lock: async () => null,
        setMessageIds: async () => {
          wrote++;
        },
      }),
    );
    ok("ロックが取れない：ids-busy を出す", logs.includes("[task-buttons] ids-busy"), logs.join(" / "));
    ok("ロックが取れない：書かない", wrote === 0);
    ok("ロックが取れない：完了印は付ける", completed.join() === "pb:PC");

    // 書けなくてもロックは外す（自分のトークンのときだけ）
    reset();
    const unlocked: string[] = [];
    await handleTaskPostbackEvent(
      { ...ev(`v1|wait|${PAGE}`, "PD"), source: { userId: U2, groupId: "G6" } },
      io({
        ...shared,
        reply: async () => ({ textId: "T-PD", cardId: "C-PD" }),
        lock: async () => "tok-1",
        unlock: async (_k, tok) => {
          unlocked.push(tok);
        },
        setMessageIds: async () => {
          throw new Error("notion down");
        },
      }),
    );
    ok("書けなくてもロックを外す（自分のトークンで）", unlocked.join() === "tok-1");
    await deletePendingTaskConfirm("G6", PAGE);
  }
  {
    // ロック本体：同じキーは1人だけ・他人のトークンでは外れない・期限で外れる
    const t1 = await acquireLock("lk:test", 1);
    const t2 = await acquireLock("lk:test", 1);
    ok("ロック：同じキーは1人だけ", t1 !== null && t2 === null);
    await releaseLock("lk:test", "someone-else");
    ok("ロック：他人のトークンでは外れない", (await acquireLock("lk:test", 1)) === null);
    await releaseLock("lk:test", t1!);
    ok("ロック：自分のトークンで外れる", (await acquireLock("lk:test", 1)) !== null);
  }
  ok("このテストは外部へ通信しない", fetchCalls === 0, String(fetchCalls));

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
