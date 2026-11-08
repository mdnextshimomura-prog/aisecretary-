/**
 * 業務指示グループ：タスクの返事に付けるボタン（2026-11-08 からは LINE の Flex Message のカード）。
 * スイッチは TASK_BUTTONS（"1" かつ TASK_FOLLOWUP=1 のときだけ動く。既定 off。off なら返事は今と同じバイト）。
 * 送り方：文字の返事（text）は1文字も変えずに1通目、カードを2通目に足す（line.ts の sendLineMessage）。
 * 返す ID は1通目（text）のまま（引用での回答・二重登録の確認・rememberConfirmMessage がこの ID を使う）。
 * カードを付けるのは受付の返事（確定・初動確認の聞き返し・確認失敗のどれでも。下村さん指示）と、
 * ボタンを押したあとの返事のうち続くタスク（待ち・延期・担当変更）。済・不要で閉じたら付けない。
 * 押せるのは担当者・依頼者（依頼者ID）・特権者（TASK_BUTTONS_ADMIN_IDS の LINE userId）。
 *
 * ボタン：［済］［待ち（3日後に確認）］［延期］［不要］［担当を変える］
 * 押したときの処理は、文字の返事（「3済」「3待ち」「3延期 10/20」「3不要」・引用での担当変更）と
 * 同じ関数を呼ぶ（completeTask・applyStatusToTask・updateTaskAssignee＋recordAssigneeChange）。
 * Notion・名簿は deps で受け取る（本物へのつなぎは task-buttons-wire.ts）。
 *
 * ── クイックリプライからカードに替えた理由と公式の記述（2026-11-08 に読んで確かめた）──
 * - クイックリプライは「Android版とiOS版のLINEでサポート」（PC 版では出ない）。押す・誰かが発言すると消える：
 *   https://developers.line.biz/ja/docs/messaging-api/using-quick-reply/
 * - Flex Message は「すべてのバージョンのLINEでサポート」（動作環境の表に PC版LINE（macOS版、Windows版）の列。
 *   ここで使う機能はその表の対象外＝全バージョン）。トークに残る：
 *   https://developers.line.biz/ja/docs/messaging-api/using-flex-messages/
 *   https://developers.line.biz/en/reference/messaging-api/#flex-message
 * - Flex の button コンポーネントの action にポストバックアクションを付けられる。ラベルの上限は
 *   「Flex Message Button: 40」（クイックリプライは 20）。data・displayText は 300 字：
 *   https://developers.line.biz/en/reference/messaging-api/#postback-action
 * - 未確認：PC 版でカードのボタンを押したときに postback が届くこと（PC を除く記述は無いが、明記も無い）。
 *
 * ── displayText を付けるかの確認（2026-11-08、公式を読んで決めた。カードでも同じ）──
 * 出典：Messaging API reference「Postback action」「Postback event」
 *   https://developers.line.biz/en/reference/messaging-api/#postback-action
 *   https://developers.line.biz/en/reference/messaging-api/#postback-event
 * - displayText：「Text displayed on the LINE chat screen as a message sent by the user when the
 *   action is performed」（最大 300 字）。画面に出るだけで、webhook には postback イベントだけが届く。
 * - text（非推奨）のほうが「Returned from the server through a webhook」＝メッセージとして届く。→ text は使わない。
 * - data は postback.data で返る（最大 300 字）。担当の候補は最大 13 人（今までと同じ）。
 * 判断：displayText を付ける（グループの皆に「誰が何を押したか」が見える）。追加の message イベントは
 * 来ないので、文字コマンド・依頼の判定に二重に入ることはない。念のため、表示の文は番号も
 * @メンションも依頼の言い回しも含まない形にしてある（万一メッセージとして届いても、番号の
 * 完了・状況の返事・新規依頼・候補のどれにも読まれない）。
 */
import type { Member } from "./members";
import {
  applyStatusToTask,
  followupEnabled,
  type StatusDeps,
} from "./task-status";
import { addDaysStr, resolveDateToken } from "./task-status-command";
import {
  buildTaskCard,
  cardButton,
  dueFromParsed,
  type CardButton,
  type CardInfo,
  type FlexMessage,
} from "./task-card";

export type { FlexMessage, CardInfo } from "./task-card";

export function buttonsEnabled(): boolean {
  return process.env.TASK_BUTTONS === "1";
}

/**
 * ボタンを付ける・押されたら処理するか。TASK_BUTTONS=1 かつ TASK_FOLLOWUP=1 のときだけ
 * （待ち・不要は TASK_FOLLOWUP の欄を使うため）。片方でも off なら付けない・処理しない。
 */
export function buttonsActive(): boolean {
  return buttonsEnabled() && followupEnabled();
}

/** 片方が off のあいだに押されたときの返事 */
export const MSG_PAUSED =
  "いまボタン操作は止めています。文字で操作してください";

export const MSG_FORBIDDEN =
  "このタスクを操作できるのは担当者・依頼者・下村さんだけです";
export const MSG_CLOSED = "このタスクはもう処理済みです";
/** タスクを読めなかった（見つからない＝削除・共有外・権限喪失のどれか分からない） */
export const MSG_UNCONFIRMED =
  "このタスクを確認できませんでした。少し時間をおいてもう一度お試しください";

export type ButtonOp =
  "done" | "wait" | "pmenu" | "pp" | "drop" | "amenu" | "as";
const OPS_NO_EXTRA: ButtonOp[] = ["done", "wait", "pmenu", "drop", "amenu"];

const POSTPONE_KEYS = [
  "tomorrow",
  "dayafter",
  "thisfri",
  "nextmon",
  "nextfri",
] as const;
type PostponeKey = (typeof POSTPONE_KEYS)[number];
const POSTPONE_LABEL: Record<PostponeKey, string> = {
  tomorrow: "明日",
  dayafter: "明後日",
  thisfri: "今週金曜",
  nextmon: "来週月曜",
  nextfri: "来週金曜",
};

const PAGE_ID_RE =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/;
const MAX_DATA = 300;
/** 担当の候補の人数（クイックリプライのときの上限 13 をそのまま使う） */
const MAX_ITEMS = 13;

export function encodeButtonData(
  op: ButtonOp,
  pageId: string,
  extra?: string,
): string {
  return ["v1", op, pageId, ...(extra ? [extra] : [])].join("|");
}

/** `v1|操作|pageId[|追加]` を読む。形が違えば null。 */
export function parseButtonData(
  data: string,
): { op: ButtonOp; pageId: string; extra?: string } | null {
  if (!data || data.length > MAX_DATA) return null;
  const parts = data.split("|");
  if (parts[0] !== "v1" || parts.length < 3 || parts.length > 4) return null;
  const op = parts[1] as ButtonOp;
  const pageId = parts[2];
  const extra = parts[3];
  if (!PAGE_ID_RE.test(pageId)) return null;
  if (OPS_NO_EXTRA.includes(op)) {
    return extra === undefined ? { op, pageId } : null;
  }
  if (op === "pp") {
    return extra && (POSTPONE_KEYS as readonly string[]).includes(extra)
      ? { op, pageId, extra }
      : null;
  }
  if (op === "as") {
    return extra && LINE_USER_ID_RE.test(extra) ? { op, pageId, extra } : null;
  }
  return null;
}

// ── メニュー・一覧のボタン（B1。task-menu.ts。TASK_MENU=1 のときだけ出す・扱う）──
// data は `v1|操作|オフセット`。オフセットは一覧の何件目から出すか（0, 10, 20…）。表示番号ではない。
// menu＝メニュー／lt＝今日・期限切れ／lm＝自分の未完了／lc＝候補／ld＝案件
export type MenuOp = "menu" | "lt" | "lm" | "lc" | "ld";
const MENU_OPS: MenuOp[] = ["menu", "lt", "lm", "lc", "ld"];
export interface MenuAction {
  op: MenuOp;
  offset: number;
}
/** 一覧の1ページの件数（カルーセルは［次の10件］を足して最大11枚） */
export const MENU_PAGE_SIZE = 10;
const MENU_OFFSET_MAX = 500;

export function encodeMenuData(op: MenuOp, offset = 0): string {
  return ["v1", op, String(offset)].join("|");
}

/** `v1|操作|オフセット` を読む。メニューの形でなければ null（タスクのボタンは parseButtonData）。 */
export function parseMenuData(data: string): MenuAction | null {
  if (!data || data.length > MAX_DATA) return null;
  const parts = data.split("|");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const op = parts[1] as MenuOp;
  if (!MENU_OPS.includes(op)) return null;
  if (!/^(0|[1-9][0-9]{0,2})$/.test(parts[2])) return null;
  const offset = Number(parts[2]);
  if (offset > MENU_OFFSET_MAX || offset % MENU_PAGE_SIZE !== 0) return null;
  return { op, offset };
}

/** タスクの 5 つのボタン（data・displayText は今までと同じ）。 */
function taskButtons(pageId: string): CardButton[] {
  return [
    cardButton(
      "済",
      encodeButtonData("done", pageId),
      "（ボタン）済にする",
      true,
    ),
    cardButton(
      "待ち（3日後に確認）",
      encodeButtonData("wait", pageId),
      "（ボタン）待ちにする",
    ),
    cardButton("延期", encodeButtonData("pmenu", pageId), "（ボタン）延期する"),
    cardButton(
      "不要",
      encodeButtonData("drop", pageId),
      "（ボタン）不要にする",
    ),
    cardButton(
      "担当を変える",
      encodeButtonData("amenu", pageId),
      "（ボタン）担当を変える",
    ),
  ];
}

/** タスクのカード（5 つのボタンつき）。 */
export function taskCard(info: CardInfo): FlexMessage {
  return buildTaskCard(info, taskButtons(info.pageId));
}

/**
 * 受付の返事に付けるカード。スイッチが off なら undefined（今の返事のまま）。
 * 2026-11-08 から、確定した受付だけでなく初動確認の聞き返し・確認失敗の返事にも付ける（下村さん指示）。
 * 聞き返し中に押されたときの安全：済・不要は確認セッションを消す／担当変更はセッションの担当も合わせる／
 * 回答の前に処理済みか確かめる（route.ts の stopIfClosed）。
 */
export function registeredCard(info: CardInfo): FlexMessage | undefined {
  return buttonsActive() ? taskCard(info) : undefined;
}

/** 受付の解析結果（ParsedTask）から：期日・担当は分かる範囲で（無ければカードに「未定」） */
export function registeredCardFor(
  pageId: string,
  parsed: {
    title: string;
    dueDate: string | null;
    dueTime: string | null;
    assignee: string | null;
  },
): FlexMessage | undefined {
  return registeredCard({
    pageId,
    title: parsed.title,
    due: dueFromParsed(parsed),
    assignee: parsed.assignee,
  });
}

/** 延期の日付。今日より後でなければ null（金曜〜日曜の「今週金曜」など）。 */
export function resolvePostponeKey(
  key: string,
  todayJst: string,
): string | null {
  let d: string | null = null;
  if (key === "tomorrow") d = resolveDateToken("明日", todayJst);
  else if (key === "dayafter") d = resolveDateToken("明後日", todayJst);
  else if (key === "nextmon") d = resolveDateToken("来週月", todayJst);
  else if (key === "nextfri") d = resolveDateToken("来週金", todayJst);
  else if (key === "thisfri") {
    // 月曜始まりの週の金曜
    const dow = new Date(`${todayJst}T00:00:00Z`).getUTCDay();
    d = addDaysStr(todayJst, 4 - ((dow + 6) % 7));
  }
  return d && d > todayJst ? d : null;
}

export function postponeCard(info: CardInfo, todayJst: string): FlexMessage {
  return buildTaskCard(
    info,
    POSTPONE_KEYS.filter((k) => resolvePostponeKey(k, todayJst) !== null).map(
      (k) =>
        cardButton(
          POSTPONE_LABEL[k],
          encodeButtonData("pp", info.pageId, k),
          `（ボタン）延期：${POSTPONE_LABEL[k]}`,
        ),
    ),
    "いつに延期しますか？",
  );
}

/** 担当にできる人：在籍・社内・LINE userId あり。名前順に最大 13 人。 */
export function assignableMembers(members: Member[]): Member[] {
  return members
    .filter(
      (m) =>
        m.active &&
        !m.external &&
        m.userIds.some((id) => LINE_USER_ID_RE.test(id)),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "ja"))
    .slice(0, MAX_ITEMS);
}

function assigneeButtons(pageId: string, members: Member[]): CardButton[] {
  return assignableMembers(members).map((m) =>
    cardButton(
      m.name,
      encodeButtonData(
        "as",
        pageId,
        m.userIds.find((id) => LINE_USER_ID_RE.test(id)),
      ),
      `（ボタン）担当を変える：${m.name}`,
    ),
  );
}

export function assigneeCard(info: CardInfo, members: Member[]): FlexMessage {
  return buildTaskCard(
    info,
    assigneeButtons(info.pageId, members),
    "誰に替えますか？",
  );
}

export interface ButtonTask {
  id: string;
  title: string;
  /** 完了・不要（ステータスが完了）か、消されている */
  closed: boolean;
  assigneeId: string | null;
  requesterId: string | null;
  /** カードに出す期日（Notion の 期日 の date.start）。分からなければ null・省略 */
  due?: string | null;
  /** カードに出す担当者の名前（Notion の 担当者）。分からなければ null・省略 */
  assignee?: string | null;
}

export interface ButtonDeps {
  /** 見つからなければ null */
  getTask(pageId: string): Promise<ButtonTask | null>;
  members(): Promise<Member[]>;
  /** 「済」と同じ完了の処理（completeTask） */
  complete(pageId: string): Promise<void>;
  status: Pick<StatusDeps, "update" | "defaultCheckDate">;
  /** 引用での担当変更と同じ書き込み（updateTaskAssignee＋recordAssigneeChange） */
  setAssignee(pageId: string, name: string, userId: string): Promise<void>;
  today(): string;
  /** 初動確認のセッション（KV）。残っていなければ何もしない */
  session: {
    /** 済・不要にしたときに消す */
    clear(pageId: string): Promise<void>;
    /** 担当を替えたときに、セッションの担当も合わせる */
    syncAssignee(pageId: string, name: string, userId: string): Promise<void>;
  };
}

export interface ButtonReply {
  text: string;
  /** 2通目に付けるカード（済・不要で閉じたとき・押せないときは無し） */
  card?: FlexMessage;
  /** カードを付けたときだけ：対象のタスク（入口が再掲カードの ID を cardref に控える） */
  pageId?: string;
  /** Notion に書いたか */
  changed: boolean;
  /** true なら入口はイベントの完了印を付けない（タスクを確認できなかった） */
  retryable?: boolean;
  /** 返事は成功のまま、ログに種別だけ出す印（例：session-clear-failed） */
  warnings?: string[];
}

/** Notion を書けたあとに確認セッションを消す。消せなくても返事は成功のまま（印だけ返す）。 */
async function clearSessionAfter(
  deps: ButtonDeps,
  pageId: string,
): Promise<string[] | undefined> {
  try {
    await deps.session.clear(pageId);
    return undefined;
  } catch {
    return ["session-clear-failed"];
  }
}

/** 特権者（下村さん）：TASK_BUTTONS_ADMIN_IDS（LINE userId、カンマ区切り）。未設定なら誰もいない */
function adminIds(): string[] {
  return (process.env.TASK_BUTTONS_ADMIN_IDS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function canOperate(
  actorId: string | undefined,
  task: ButtonTask,
  members: Member[],
): boolean {
  if (!actorId) return false;
  if (adminIds().includes(actorId)) return true;
  // 依頼者ID が空（TASK_RECORD=0 の間に登録）なら、担当者と特権者だけが押せる
  const owners = [task.assigneeId, task.requesterId].filter((v): v is string =>
    Boolean(v),
  );
  if (owners.includes(actorId)) return true;
  const me = members.find((m) => m.userIds.includes(actorId));
  if (!me) return false;
  // 名簿で同じ人の別アカウント
  return me.userIds.some((id) => owners.includes(id));
}

/**
 * ボタンが押されたとき（postback の data）。data の形が違えば null（何も返さない）。
 */
export async function handleTaskButton(
  data: string,
  actorId: string | undefined,
  deps: ButtonDeps,
): Promise<ButtonReply | null> {
  const parsed = parseButtonData(data);
  if (!parsed) return null;
  const { op, pageId, extra } = parsed;

  const task = await deps.getTask(pageId);
  // 見つからないは処理済みにしない（共有外・権限喪失でも同じ答えが返るため）。完了印も付けさせない
  if (!task) return { text: MSG_UNCONFIRMED, changed: false, retryable: true };
  if (task.closed) return { text: MSG_CLOSED, changed: false };

  const members = await deps.members().catch(() => [] as Member[]);
  if (!canOperate(actorId, task, members))
    return { text: MSG_FORBIDDEN, changed: false };

  const info: CardInfo = {
    pageId: task.id,
    title: task.title,
    due: task.due ?? null,
    assignee: task.assignee ?? null,
  };
  const again = taskCard(info);
  const t: ButtonTask = task;
  const runOp = async (): Promise<ButtonReply> => {
    switch (op) {
      case "done": {
        // Notion が先。書けなければ例外で抜け、確認セッション（回答先）は残す。
        // 書けたらセッションを消す（残すと、後の回答で「未着手」に戻る）
        await deps.complete(task.id);
        const warnings = await clearSessionAfter(deps, task.id);
        return {
          text: `☑️ 完了にしました\n📋 ${task.title}`,
          changed: true,
          ...(warnings ? { warnings } : {}),
        };
      }
      case "wait": {
        const text = await applyStatusToTask(
          { kind: "wait", note: "", date: null },
          task,
          deps.status,
        );
        return { text, card: again, changed: true };
      }
      case "drop": {
        const text = await applyStatusToTask(
          { kind: "drop" },
          task,
          deps.status,
        );
        const warnings = await clearSessionAfter(deps, task.id);
        return { text, changed: true, ...(warnings ? { warnings } : {}) };
      }
      case "pmenu": {
        return {
          text: `📅 いつに延期しますか？\n📋 ${task.title}`,
          card: postponeCard(info, deps.today()),
          changed: false,
        };
      }
      case "pp": {
        const date = resolvePostponeKey(extra as string, deps.today());
        if (!date) {
          return {
            text: `⚠️ その日はもう過ぎています。日を選び直してください\n📋 ${task.title}`,
            card: postponeCard(info, deps.today()),
            changed: false,
          };
        }
        const text = await applyStatusToTask(
          { kind: "postpone", date },
          task,
          deps.status,
        );
        // 期日が変わったので、新しい期日でカードを付け直す
        return { text, card: taskCard({ ...info, due: date }), changed: true };
      }
      case "amenu": {
        const buttons = assigneeButtons(task.id, members);
        if (buttons.length === 0) {
          return { text: "⚠️ 名簿に替えられる人がいません", changed: false };
        }
        return {
          text: `👤 誰に替えますか？\n📋 ${task.title}`,
          card: assigneeCard(info, members),
          changed: false,
        };
      }
      case "as": {
        const m = assignableMembers(members).find((x) =>
          x.userIds.includes(extra as string),
        );
        if (!m) {
          return {
            text: "⚠️ 名簿にいない人には替えられません",
            changed: false,
          };
        }
        // Notion が先。書けなければ例外で抜け、確認セッションの担当は変えない（済・不要と同じ考え方）。
        // 書けたら確認セッションの担当も合わせる（残すと、確認が済んだとき旧担当へ渡る）。
        // 合わせられなくても返事は成功のまま（印だけ返す）
        await deps.setAssignee(task.id, m.name, extra as string);
        let warnings: string[] | undefined;
        try {
          await deps.session.syncAssignee(task.id, m.name, extra as string);
        } catch {
          warnings = ["session-sync-failed"];
        }
        return {
          ...(warnings ? { warnings } : {}),
          text: `👤 担当者を ${m.name} さんに設定しました\n📋 ${task.title}`,
          card: taskCard({ ...info, assignee: m.name }),
          changed: true,
        };
      }
    }
  };
  const r = await runOp();
  // カードを付けたときだけ、入口が再掲カードの ID を控えられるようにタスクの ID を添える
  return r.card ? { ...r, pageId: t.id } : r;
}
