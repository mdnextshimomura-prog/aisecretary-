/**
 * 受付の返事のボタン（TASK_BUTTONS=1）。Notion・名簿は差し替える。
 */
import {
  buttonsEnabled,
  encodeButtonData,
  parseButtonData,
  registeredQuickReply,
  taskQuickReply,
  postponeQuickReply,
  assigneeQuickReply,
  assignableMembers,
  resolvePostponeKey,
  handleTaskButton,
  MSG_FORBIDDEN,
  MSG_CLOSED,
  type ButtonDeps,
  type ButtonTask,
} from "../src/lib/task-buttons";
import type { Member } from "../src/lib/members";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};

const PAGE = "1234abcd-1234-1234-1234-1234567890ab";
const U = (n: number) => `U${String(n).padStart(32, "0")}`;
const member = (
  name: string,
  ids: string[],
  extra: Partial<Member> = {},
): Member => ({
  name,
  userIds: ids,
  aliases: [],
  email: null,
  active: true,
  external: false,
  notionUserId: null,
  ...extra,
});

// 2026-11-09 は月曜
const TODAY = "2026-11-09";

function makeDeps(task: ButtonTask | null, members: Member[]) {
  const log: string[] = [];
  const deps: ButtonDeps = {
    getTask: async () => task,
    members: async () => members,
    complete: async (id) => {
      log.push(`complete:${id}`);
    },
    status: {
      update: async (id, props) => {
        log.push(`update:${id}:${JSON.stringify(props)}`);
      },
      defaultCheckDate: async () => "2026-11-12",
    },
    setAssignee: async (id, name, userId) => {
      log.push(`assign:${id}:${name}:${userId}`);
    },
    today: () => TODAY,
  };
  return { deps, log };
}

const shimo = member("下村 亮太", [U(1)]);
const tanaka = member("田中 一郎", [U(2)]);
const requester = member("佐藤 花子", [U(3)]);
const other = member("鈴木 次郎", [U(4)]);
const roster = [tanaka, shimo, requester, other];
const openTask: ButtonTask = {
  id: PAGE,
  title: "重説の作成",
  closed: false,
  assigneeId: U(2),
  requesterId: U(3),
};

async function main() {
  // ── スイッチ ──
  delete process.env.TASK_BUTTONS;
  ok("未設定は off", !buttonsEnabled());
  ok(
    "off なら受付の返事にボタンを付けない",
    registeredQuickReply(PAGE) === undefined,
  );
  process.env.TASK_BUTTONS = "0";
  ok("0 は off", registeredQuickReply(PAGE) === undefined);
  process.env.TASK_BUTTONS = "1";
  const qr = registeredQuickReply(PAGE);
  ok("on なら受付の返事にボタンを付ける", qr !== undefined);
  const labels = qr!.items.map((i) => i.action.label);
  ok(
    "ボタンの順と文言",
    JSON.stringify(labels) ===
      JSON.stringify([
        "済",
        "待ち（3日後に確認）",
        "延期",
        "不要",
        "担当を変える",
      ]),
    JSON.stringify(labels),
  );
  ok(
    "ラベルは20字以内",
    labels.every((l) => Array.from(l).length <= 20),
  );
  ok(
    "postback で、data は v1| で始まり 300 字以内",
    qr!.items.every(
      (i) =>
        i.action.type === "postback" &&
        i.action.data.startsWith("v1|") &&
        i.action.data.length <= 300,
    ),
  );
  ok(
    "displayText を付ける（押したことが皆に見える）",
    qr!.items.every(
      (i) =>
        typeof i.action.displayText === "string" &&
        i.action.displayText.length > 0,
    ),
  );
  ok(
    "taskQuickReply は同じボタン",
    JSON.stringify(taskQuickReply(PAGE)) === JSON.stringify(qr),
  );

  // ── data の形式 ──
  ok("encode", encodeButtonData("done", PAGE) === `v1|done|${PAGE}`);
  ok(
    "encode 追加つき",
    encodeButtonData("pp", PAGE, "tomorrow") === `v1|pp|${PAGE}|tomorrow`,
  );
  const p = parseButtonData(`v1|pp|${PAGE}|tomorrow`);
  ok("parse", p?.op === "pp" && p.pageId === PAGE && p.extra === "tomorrow");
  ok(
    "ハイフン無しの pageId も読む",
    parseButtonData(`v1|done|${PAGE.replace(/-/g, "")}`) !== null,
  );
  for (const bad of [
    "",
    "v2|done|" + PAGE,
    "v1|explode|" + PAGE,
    "v1|done|not-a-page",
    "v1|done",
    `v1|done|${PAGE}|extra`, // 追加の要らない操作に追加
    `v1|pp|${PAGE}`, // 追加の要る操作に追加が無い
    `v1|pp|${PAGE}|someday`,
    `v1|as|${PAGE}|bob`,
    "x".repeat(301),
  ]) {
    ok(`形式不正は null: ${bad.slice(0, 40)}`, parseButtonData(bad) === null);
  }

  // ── 延期の日付 ──
  ok("明日", resolvePostponeKey("tomorrow", TODAY) === "2026-11-10");
  ok("明後日", resolvePostponeKey("dayafter", TODAY) === "2026-11-11");
  ok(
    "今週金曜（月曜から）",
    resolvePostponeKey("thisfri", TODAY) === "2026-11-13",
  );
  ok("来週月曜", resolvePostponeKey("nextmon", TODAY) === "2026-11-16");
  ok("来週金曜", resolvePostponeKey("nextfri", TODAY) === "2026-11-20");
  ok(
    "金曜の今週金曜は無い",
    resolvePostponeKey("thisfri", "2026-11-13") === null,
  );
  ok(
    "日曜の来週月曜は翌日",
    resolvePostponeKey("nextmon", "2026-11-15") === "2026-11-16",
  );
  const pq = postponeQuickReply(PAGE, TODAY);
  ok(
    "延期の候補の順と文言",
    JSON.stringify(pq.items.map((i) => i.action.label)) ===
      JSON.stringify(["明日", "明後日", "今週金曜", "来週月曜", "来週金曜"]),
  );
  ok(
    "金曜には今週金曜を出さない",
    !postponeQuickReply(PAGE, "2026-11-13").items.some(
      (i) => i.action.label === "今週金曜",
    ),
  );

  // ── 担当の候補 ──
  const many = Array.from({ length: 20 }, (_, i) =>
    member(`社員${String(i).padStart(2, "0")}`, [U(100 + i)]),
  );
  const withNoId = [
    ...many,
    member("ID無し", []),
    member("退職者", [U(900)], { active: false }),
    member("社外の人", [U(901)], { external: true }),
  ];
  const assignable = assignableMembers(withNoId);
  ok("13人上限", assignable.length === 13, String(assignable.length));
  ok(
    "userId の無い人・退職・社外は出さない",
    !assignable.some((m) => ["ID無し", "退職者", "社外の人"].includes(m.name)),
  );
  ok(
    "名前順",
    assignable[0].name === "社員00" && assignable[12].name === "社員12",
  );
  const aq = assigneeQuickReply(PAGE, roster);
  ok(
    "担当の候補は postback",
    aq.items.every((i) => i.action.data.startsWith(`v1|as|${PAGE}|U`)),
  );
  ok(
    "担当の候補 13 個以内",
    assigneeQuickReply(PAGE, many).items.length === 13,
  );

  // ── 各ボタンが既存の処理を呼ぶ ──
  {
    const { deps, log } = makeDeps(openTask, roster);
    const r = await handleTaskButton(`v1|done|${PAGE}`, U(2), deps);
    ok("済：完了の処理を呼ぶ", log.join() === `complete:${PAGE}`, log.join());
    ok(
      "済：文字の引用完了と同じ文面",
      r?.text === "☑️ 完了にしました\n📋 重説の作成",
      r?.text,
    );
    ok("済：ボタンは付け直さない", r?.quickReply === undefined);
  }
  {
    const { deps, log } = makeDeps(openTask, roster);
    const r = await handleTaskButton(`v1|wait|${PAGE}`, U(2), deps);
    ok(
      "待ち：理由なし・既定の確認日で書く",
      log.join() ===
        `update:${PAGE}:${JSON.stringify({
          ステータス: { select: { name: "進行中" } },
          次に確認する日: { date: { start: "2026-11-12" } },
        })}`,
      log.join(),
    );
    ok(
      "待ち：文字コマンドと同じ文面",
      r?.text ===
        "⏸ 待ちにしました（1件）\n次に確認する日：11/12（この日までは知らせません）\n📋 重説の作成",
      r?.text,
    );
    ok(
      "待ち：ボタンを付け直す",
      JSON.stringify(r?.quickReply) === JSON.stringify(taskQuickReply(PAGE)),
    );
  }
  {
    const { deps, log } = makeDeps(openTask, roster);
    const r = await handleTaskButton(`v1|drop|${PAGE}`, U(2), deps);
    ok(
      "不要：終わり方を不要にする",
      log.join() ===
        `update:${PAGE}:${JSON.stringify({
          ステータス: { select: { name: "完了" } },
          終わり方: { select: { name: "不要" } },
        })}`,
      log.join(),
    );
    ok(
      "不要：文面",
      r?.text === "🗑 不要にしました（1件。記録は残ります）\n📋 重説の作成",
      r?.text,
    );
    ok("不要：ボタンは付けない", r?.quickReply === undefined);
  }
  {
    const { deps, log } = makeDeps(openTask, roster);
    const r = await handleTaskButton(`v1|pmenu|${PAGE}`, U(2), deps);
    ok("延期：まだ何も書かない", log.length === 0);
    ok(
      "延期：日付の候補を返す",
      JSON.stringify(r?.quickReply) ===
        JSON.stringify(postponeQuickReply(PAGE, TODAY)),
    );
  }
  {
    const { deps, log } = makeDeps(openTask, roster);
    const r = await handleTaskButton(`v1|pp|${PAGE}|nextfri`, U(2), deps);
    ok(
      "延期を選ぶ：既存の延期の処理",
      log.join() ===
        `update:${PAGE}:${JSON.stringify({ 期日: { date: { start: "2026-11-20" } }, 通知済み: { checkbox: false } })}`,
      log.join(),
    );
    ok(
      "延期を選ぶ：文面",
      r?.text === "📅 期日を 11/20 に変えました（1件）\n📋 重説の作成",
      r?.text,
    );
    ok(
      "延期を選ぶ：ボタンを付け直す",
      JSON.stringify(r?.quickReply) === JSON.stringify(taskQuickReply(PAGE)),
    );
  }
  {
    const { deps, log } = makeDeps(openTask, roster);
    const r = await handleTaskButton(`v1|pp|${PAGE}|thisfri`, U(2), {
      ...deps,
      today: () => "2026-11-14",
    });
    ok(
      "過ぎた今週金曜は書かない",
      log.length === 0 && /過ぎ|選び直/.test(r?.text ?? ""),
      r?.text,
    );
  }
  {
    const { deps, log } = makeDeps(openTask, roster);
    const r = await handleTaskButton(`v1|amenu|${PAGE}`, U(3), deps);
    ok(
      "担当を変える：候補を返す",
      log.length === 0 && r?.quickReply?.items.length === 4,
    );
  }
  {
    const { deps, log } = makeDeps(openTask, roster);
    const r = await handleTaskButton(`v1|as|${PAGE}|${U(4)}`, U(3), deps);
    ok(
      "担当を選ぶ：名簿の名前と userId で書く",
      log.join() === `assign:${PAGE}:鈴木 次郎:${U(4)}`,
      log.join(),
    );
    ok(
      "担当を選ぶ：文字の担当変更と同じ文面",
      r?.text === "👤 担当者を 鈴木 次郎 さんに設定しました\n📋 重説の作成",
      r?.text,
    );
    ok("担当を選ぶ：ボタンを付け直す", r?.quickReply !== undefined);
  }
  {
    const { deps, log } = makeDeps(openTask, roster);
    const r = await handleTaskButton(`v1|as|${PAGE}|${U(777)}`, U(3), deps);
    ok(
      "名簿にいない ID は拒否",
      log.length === 0 && /名簿/.test(r?.text ?? ""),
      r?.text,
    );
  }
  {
    const { deps, log } = makeDeps(openTask, [
      ...roster,
      member("社外の人", [U(901)], { external: true }),
    ]);
    const r = await handleTaskButton(`v1|as|${PAGE}|${U(901)}`, U(3), deps);
    ok(
      "候補に出ない人（社外）も拒否",
      log.length === 0 && /名簿/.test(r?.text ?? ""),
      r?.text,
    );
  }

  // ── 押せる人 ──
  for (const [who, id] of [
    ["担当者", U(2)],
    ["依頼者", U(3)],
    ["下村さん", U(1)],
  ] as const) {
    const { deps, log } = makeDeps(openTask, roster);
    await handleTaskButton(`v1|done|${PAGE}`, id, deps);
    ok(`${who}は押せる`, log.length === 1);
  }
  {
    const { deps, log } = makeDeps(openTask, roster);
    const r = await handleTaskButton(`v1|done|${PAGE}`, U(4), deps);
    ok(
      "それ以外の人は押せない",
      log.length === 0 && r?.text === MSG_FORBIDDEN,
      r?.text,
    );
    ok(
      "文面",
      MSG_FORBIDDEN ===
        "このタスクを操作できるのは担当者・依頼者・下村さんだけです",
    );
  }
  {
    const { deps, log } = makeDeps(openTask, roster);
    const r = await handleTaskButton(`v1|amenu|${PAGE}`, U(4), deps);
    ok(
      "候補を出すボタンも押せない",
      log.length === 0 && r?.text === MSG_FORBIDDEN,
    );
  }
  {
    const { deps, log } = makeDeps(openTask, roster);
    const r = await handleTaskButton(`v1|done|${PAGE}`, undefined, deps);
    ok(
      "押した人が分からなければ押せない",
      log.length === 0 && r?.text === MSG_FORBIDDEN,
    );
  }
  {
    // 名簿で同じ人の別アカウント
    const multi = member("田中 一郎", [U(2), U(22)]);
    const { deps, log } = makeDeps(openTask, [multi, shimo]);
    await handleTaskButton(`v1|done|${PAGE}`, U(22), deps);
    ok("名簿で同じ人の別アカウントも押せる", log.length === 1);
  }
  {
    const { deps, log } = makeDeps(openTask, []);
    await handleTaskButton(`v1|done|${PAGE}`, U(1), deps);
    ok(
      "名簿が引けないと下村さんでも ID が一致しなければ押せない",
      log.length === 0,
    );
  }

  // ── 処理済み・見つからない ──
  {
    const { deps, log } = makeDeps({ ...openTask, closed: true }, roster);
    const r = await handleTaskButton(`v1|wait|${PAGE}`, U(2), deps);
    ok(
      "完了・不要のタスクは処理済み",
      log.length === 0 && r?.text === MSG_CLOSED,
      r?.text,
    );
    ok("文面", MSG_CLOSED === "このタスクはもう処理済みです");
  }
  {
    const { deps, log } = makeDeps(null, roster);
    const r = await handleTaskButton(`v1|done|${PAGE}`, U(2), deps);
    ok(
      "見つからないタスクも処理済み",
      log.length === 0 && r?.text === MSG_CLOSED,
    );
  }

  // ── 形式不正 ──
  {
    const { deps, log } = makeDeps(openTask, roster);
    const r = await handleTaskButton("v1|done|zzz", U(2), deps);
    ok("形式不正は何もしない（null）", r === null && log.length === 0);
  }

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
