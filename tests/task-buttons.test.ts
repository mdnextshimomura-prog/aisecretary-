/**
 * 受付の返事のボタン（TASK_BUTTONS=1）。Notion・名簿は差し替える。
 */
import {
  buttonsEnabled,
  encodeButtonData,
  parseButtonData,
  registeredCard,
  registeredCardFor,
  taskCard,
  postponeCard,
  assigneeCard,
  assignableMembers,
  resolvePostponeKey,
  handleTaskButton,
  MSG_FORBIDDEN,
  MSG_CLOSED,
  MSG_UNCONFIRMED,
  buttonsActive,
  type ButtonDeps,
  type ButtonTask,
} from "../src/lib/task-buttons";
import type { Member } from "../src/lib/members";
import { cardActions, type CardInfo, type FlexMessage } from "../src/lib/task-card";

const INFO: CardInfo = { pageId: "1234abcd-1234-1234-1234-1234567890ab", title: "重説の作成", due: null, assignee: null };
const acts = (c: FlexMessage | undefined) => (c ? cardActions(c) : []);

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
  const slog: string[] = [];
  const deps: ButtonDeps = {
    session: {
      clear: async (id) => {
        slog.push(`clear:${id}`);
      },
      syncAssignee: async (id, name, userId) => {
        slog.push(`assign:${id}:${name}:${userId}`);
      },
    },
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
  return { deps, log, slog };
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
  process.env.TASK_FOLLOWUP = "1";
  ok("未設定は off", !buttonsEnabled() && !buttonsActive());
  ok(
    "off なら受付の返事にボタンを付けない",
    registeredCard(INFO) === undefined,
  );
  process.env.TASK_BUTTONS = "0";
  ok("0 は off", registeredCard(INFO) === undefined);
  process.env.TASK_BUTTONS = "1";
  delete process.env.TASK_FOLLOWUP;
  ok(
    "TASK_FOLLOWUP が off ならボタンを付けない",
    !buttonsActive() && registeredCard(INFO) === undefined,
  );
  process.env.TASK_FOLLOWUP = "0";
  ok("TASK_FOLLOWUP=0 も付けない", registeredCard(INFO) === undefined);
  process.env.TASK_FOLLOWUP = "1";
  ok("両方 on で動く", buttonsActive());
  // 2026-11-08 下村さん指示：確定前（初動確認の聞き返し・確認失敗）の返事にも毎回付ける。
  // 旧テスト「確定前には付けない」は要件の変更で外した（confirmed の引数ごと無くした）
  const qr = registeredCard(INFO);
  ok("on なら受付の返事にカードを付ける", qr !== undefined && qr.type === "flex");
  const labels = acts(qr).map((a) => a.label);
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
    "ラベルは40字以内（Flex のボタンの上限）",
    labels.every((l) => Array.from(l).length <= 40),
  );
  ok(
    "postback で、data は v1| で始まり 300 字以内",
    acts(qr).every(
      (a) =>
        a.type === "postback" &&
        a.data.startsWith("v1|") &&
        a.data.length <= 300,
    ),
  );
  ok(
    "displayText を付ける（押したことが皆に見える）",
    acts(qr).every(
      (a) => typeof a.displayText === "string" && a.displayText.length > 0,
    ),
  );
  ok(
    "displayText・data は今の形のまま",
    JSON.stringify(acts(qr).map((a) => [a.data, a.displayText])) ===
      JSON.stringify([
        [`v1|done|${PAGE}`, "（ボタン）済にする"],
        [`v1|wait|${PAGE}`, "（ボタン）待ちにする"],
        [`v1|pmenu|${PAGE}`, "（ボタン）延期する"],
        [`v1|drop|${PAGE}`, "（ボタン）不要にする"],
        [`v1|amenu|${PAGE}`, "（ボタン）担当を変える"],
      ]),
  );
  ok(
    "taskCard は同じカード",
    JSON.stringify(taskCard(INFO)) === JSON.stringify(qr),
  );
  ok("altText は【タスク】＋タスク名", qr!.altText === "【タスク】重説の作成", qr!.altText);
  {
    const long = registeredCard({ ...INFO, title: "あ".repeat(500) })!;
    ok("altText は 400 字以内", Array.from(long.altText).length === 400, String(long.altText.length));
    const first = (long.contents.body as { contents: Array<{ text?: string }> }).contents[0].text;
    ok("長いタスク名は1行目で切る（40字）", first === "あ".repeat(39) + "…", first);
  }
  {
    const j = JSON.stringify(qr);
    ok("期日・担当が分からなければ「未定」", (j.match(/"未定"/g) ?? []).length === 2, j);
    ok("クイックリプライは付けない", !j.includes("quickReply"));
    const c2 = registeredCardFor(PAGE, {
      title: "査定書",
      dueDate: "2026-11-20",
      dueTime: "17:00",
      assignee: "田中 一郎",
    })!;
    const j2 = JSON.stringify(c2);
    ok(
      "登録時は解析結果の期日・担当を出す",
      j2.includes("11月20日(金) 17:00") && j2.includes("田中 一郎") && !j2.includes("未定"),
      j2,
    );
    const c3 = registeredCardFor(PAGE, { title: "査定書", dueDate: "2026-11-20", dueTime: null, assignee: null })!;
    ok("時刻なしの期日・担当なし", JSON.stringify(c3).includes("11月20日(金)") && JSON.stringify(c3).includes("未定"));
  }

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
  const pq = postponeCard(INFO, TODAY);
  ok(
    "延期の候補の順と文言（カードのボタン）",
    JSON.stringify(acts(pq).map((a) => a.label)) ===
      JSON.stringify(["明日", "明後日", "今週金曜", "来週月曜", "来週金曜"]),
  );
  ok(
    "金曜には今週金曜を出さない",
    !acts(postponeCard(INFO, "2026-11-13")).some(
      (a) => a.label === "今週金曜",
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
  const aq = assigneeCard(INFO, roster);
  ok(
    "担当の候補はカードの postback",
    aq.type === "flex" && acts(aq).length === 4 &&
      acts(aq).every((a) => a.data.startsWith(`v1|as|${PAGE}|U`)),
  );
  ok(
    "担当の候補 13 個以内",
    acts(assigneeCard(INFO, many)).length === 13,
  );
  {
    const longName = member("長".repeat(60), [U(300)]);
    const a = acts(assigneeCard(INFO, [longName]));
    ok("担当の名前のラベルは40字で切る", Array.from(a[0].label).length === 40);
    ok("担当のカードの data も 300 字以内", a.every((x) => x.data.length <= 300));
  }

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
    ok("済：カードは付けない（閉じた）", r?.card === undefined);
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
      "待ち：同じカードを付け直す",
      JSON.stringify(r?.card) === JSON.stringify(taskCard(INFO)),
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
    ok("不要：カードは付けない（閉じた）", r?.card === undefined);
  }
  {
    const { deps, log } = makeDeps(openTask, roster);
    const r = await handleTaskButton(`v1|pmenu|${PAGE}`, U(2), deps);
    ok("延期：まだ何も書かない", log.length === 0);
    ok(
      "延期：日付の候補を返す",
      JSON.stringify(r?.card) === JSON.stringify(postponeCard(INFO, TODAY)),
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
      "延期を選ぶ：新しい期日でカードを付け直す",
      JSON.stringify(r?.card) ===
        JSON.stringify(taskCard({ ...INFO, due: "2026-11-20" })),
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
      log.length === 0 && acts(r?.card).length === 4,
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
    ok(
      "担当を選ぶ：新しい担当でカードを付け直す",
      JSON.stringify(r?.card) ===
        JSON.stringify(taskCard({ ...INFO, assignee: "鈴木 次郎" })),
    );
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
  process.env.TASK_BUTTONS_ADMIN_IDS = ` ${U(1)} , ${U(50)}`;
  for (const [who, id] of [
    ["担当者", U(2)],
    ["依頼者", U(3)],
    ["特権者（TASK_BUTTONS_ADMIN_IDS）", U(1)],
    ["特権者の2人目（名簿にいなくてよい）", U(50)],
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
    ok("特権者は名簿が引けなくても押せる", log.length === 1);
  }
  {
    // 名前での判定はしない：名簿の「下村」でも、特権者の ID に無ければ押せない
    process.env.TASK_BUTTONS_ADMIN_IDS = "";
    const { deps, log } = makeDeps(openTask, roster);
    const r = await handleTaskButton(`v1|done|${PAGE}`, U(1), deps);
    ok(
      "特権者が未設定なら、名簿の下村さんでも押せない",
      log.length === 0 && r?.text === MSG_FORBIDDEN,
    );
    const shimo2 = member("下村 太郎", [U(60)]);
    const r2 = await handleTaskButton(`v1|done|${PAGE}`, U(60), {
      ...makeDeps(openTask, [...roster, shimo2]).deps,
    });
    ok("姓の前方一致では押せない", r2?.text === MSG_FORBIDDEN);
    process.env.TASK_BUTTONS_ADMIN_IDS = U(1);
  }
  {
    // 依頼者ID が空（TASK_RECORD=0 の間に登録したタスク）
    const noReq = { ...openTask, requesterId: null };
    const a = makeDeps(noReq, roster);
    await handleTaskButton(`v1|done|${PAGE}`, U(2), a.deps);
    ok("依頼者ID が空でも担当者は押せる", a.log.length === 1);
    const b = makeDeps(noReq, roster);
    await handleTaskButton(`v1|done|${PAGE}`, U(1), b.deps);
    ok("依頼者ID が空でも特権者は押せる", b.log.length === 1);
    const c = makeDeps(noReq, roster);
    const r = await handleTaskButton(`v1|done|${PAGE}`, U(3), c.deps);
    ok(
      "依頼者ID が空なら、頼んだ人でも押せない",
      c.log.length === 0 && r?.text === MSG_FORBIDDEN,
    );
  }

  // ── 初動確認のセッション ──
  {
    const { deps, log, slog } = makeDeps(openTask, roster);
    await handleTaskButton(`v1|done|${PAGE}`, U(2), deps);
    ok("済：残っている確認セッションを消す", slog.join() === `clear:${PAGE}`, slog.join());
    ok("済：完了も書く", log.join() === `complete:${PAGE}`);
  }
  {
    const { deps, slog } = makeDeps(openTask, roster);
    await handleTaskButton(`v1|drop|${PAGE}`, U(2), deps);
    ok("不要：確認セッションを消す", slog.join() === `clear:${PAGE}`, slog.join());
  }
  {
    const { deps, slog } = makeDeps(openTask, roster);
    await handleTaskButton(`v1|wait|${PAGE}`, U(2), deps);
    ok("待ち：確認セッションには触らない", slog.length === 0);
  }
  {
    const { deps, slog } = makeDeps(openTask, roster);
    await handleTaskButton(`v1|as|${PAGE}|${U(4)}`, U(3), deps);
    ok(
      "担当変更：確認セッションの担当も合わせる",
      slog.join() === `assign:${PAGE}:鈴木 次郎:${U(4)}`,
      slog.join(),
    );
  }
  {
    // 担当変更：Notion が先。書けなければ確認セッションの担当は変えない（済・不要と同じ考え方）
    const { deps, slog } = makeDeps(openTask, roster);
    const order: string[] = [];
    let threw = false;
    try {
      await handleTaskButton(`v1|as|${PAGE}|${U(4)}`, U(3), {
        ...deps,
        setAssignee: async () => {
          order.push("notion");
          throw new Error("notion down");
        },
        session: {
          ...deps.session,
          syncAssignee: async (id, name, uid) => {
            order.push("session");
            await deps.session.syncAssignee(id, name, uid);
          },
        },
      });
    } catch {
      threw = true;
    }
    ok(
      "担当変更：Notion が書けなければ例外で、確認セッションの担当は変えない",
      threw && slog.length === 0 && order.join() === "notion",
      order.join(),
    );
    const b = makeDeps(openTask, roster);
    const seq: string[] = [];
    await handleTaskButton(`v1|as|${PAGE}|${U(4)}`, U(3), {
      ...b.deps,
      setAssignee: async (id, n, u) => {
        seq.push("notion");
        await b.deps.setAssignee(id, n, u);
      },
      session: {
        ...b.deps.session,
        syncAssignee: async (id, n, u) => {
          seq.push("session");
          await b.deps.session.syncAssignee(id, n, u);
        },
      },
    });
    ok("担当変更：Notion を書いてから確認セッションを合わせる", seq.join() === "notion,session", seq.join());
    const c = makeDeps(openTask, roster);
    const r = await handleTaskButton(`v1|as|${PAGE}|${U(4)}`, U(3), {
      ...c.deps,
      session: {
        ...c.deps.session,
        syncAssignee: async () => {
          throw new Error("kv down");
        },
      },
    });
    ok(
      "担当変更：セッションが合わせられなくても返事は成功のまま（印を返す）",
      c.log.length === 1 && r?.changed === true && r.card !== undefined &&
        JSON.stringify(r.warnings) === JSON.stringify(["session-sync-failed"]),
      JSON.stringify(r?.warnings),
    );
  }
  for (const op of ["done", "drop"] as const) {
    // Notion が先。書けなければセッションは消さない（確認への回答先を残す）
    const { deps, slog } = makeDeps(openTask, roster);
    const broken: ButtonDeps = {
      ...deps,
      complete: async () => {
        throw new Error("notion down");
      },
      status: {
        ...deps.status,
        update: async () => {
          throw new Error("notion down");
        },
      },
    };
    let threw = false;
    try {
      await handleTaskButton(`v1|${op}|${PAGE}`, U(2), broken);
    } catch {
      threw = true;
    }
    ok(`${op}：Notion が書けなければ例外で、セッションは消さない`, threw && slog.length === 0, slog.join());

    // セッションが消せなくても、返事は成功のまま（印だけ返す）
    const b = makeDeps(openTask, roster);
    const r = await handleTaskButton(`v1|${op}|${PAGE}`, U(2), {
      ...b.deps,
      session: {
        ...b.deps.session,
        clear: async () => {
          throw new Error("kv down");
        },
      },
    });
    ok(
      `${op}：セッションが消せなくても返事は成功のまま`,
      b.log.length === 1 && r?.changed === true && /完了|不要/.test(r.text),
      r?.text,
    );
    ok(
      `${op}：セッションが消せなかった印を返す`,
      JSON.stringify(r?.warnings) === JSON.stringify(["session-clear-failed"]),
      JSON.stringify(r?.warnings),
    );
  }
  {
    const { deps, log, slog } = makeDeps(openTask, roster);
    const order: string[] = [];
    await handleTaskButton(`v1|done|${PAGE}`, U(2), {
      ...deps,
      complete: async (id) => {
        order.push("notion");
        await deps.complete(id);
      },
      session: {
        ...deps.session,
        clear: async (id) => {
          order.push("session");
          await deps.session.clear(id);
        },
      },
    });
    ok("済：Notion を書いてからセッションを消す", order.join() === "notion,session" && log.length === 1 && slog.length === 1, order.join());
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
      "見つからないタスクは処理済みにせず、確認できませんでしたと返す",
      log.length === 0 && r?.text === MSG_UNCONFIRMED && r.retryable === true,
      r?.text,
    );
    ok(
      "文面",
      MSG_UNCONFIRMED ===
        "このタスクを確認できませんでした。少し時間をおいてもう一度お試しください",
    );
  }

  // ── 形式不正 ──
  {
    const { deps, log } = makeDeps(openTask, roster);
    const r = await handleTaskButton("v1|done|zzz", U(2), deps);
    ok("形式不正は何もしない（null）", r === null && log.length === 0);
  }

  {
    const { deps } = makeDeps(openTask, roster);
    const r = await handleTaskButton(`v1|wait|${PAGE}`, U(2), deps);
    ok(
      "カードを付けた返事はタスクの ID を返す（入口が再掲カードの ID を cardref に控えるため）",
      r?.pageId === PAGE,
      String(r?.pageId),
    );
    const d = await handleTaskButton(`v1|done|${PAGE}`, U(2), makeDeps(openTask, roster).deps);
    ok("カードの無い返事には付けない", d?.pageId === undefined);
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
