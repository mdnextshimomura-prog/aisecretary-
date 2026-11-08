/**
 * 業務指示グループ：タスクの受付の返事に付けるボタン（LINE のクイックリプライ）。
 * スイッチは TASK_BUTTONS（"1" かつ TASK_FOLLOWUP=1 のときだけ動く。既定 off。off なら返事は今と同じバイト）。
 * ボタンを付けるのは確定した受付の返事だけ（初動確認・聞き返しの質問には付けない）。
 * 押せるのは担当者・依頼者（依頼者ID）・特権者（TASK_BUTTONS_ADMIN_IDS の LINE userId）。
 *
 * ボタン：［済］［待ち（3日後に確認）］［延期］［不要］［担当を変える］
 * 押したときの処理は、文字の返事（「3済」「3待ち」「3延期 10/20」「3不要」・引用での担当変更）と
 * 同じ関数を呼ぶ（completeTask・applyStatusToTask・updateTaskAssignee＋recordAssigneeChange）。
 * Notion・名簿は deps で受け取る（本物へのつなぎは task-buttons-wire.ts）。
 *
 * ── displayText を付けるかの確認（2026-11-08、公式を読んで決めた）──
 * 出典：Messaging API reference「Postback action」「Postback event」「Quick reply」
 *   https://developers.line.biz/en/reference/messaging-api/#postback-action
 *   https://developers.line.biz/en/reference/messaging-api/#postback-event
 *   https://developers.line.biz/en/reference/messaging-api/#quick-reply
 *   https://developers.line.biz/en/docs/messaging-api/using-quick-reply/
 *   （グループでも使える。ボタンは、押したとき・誰かが次の発言をしたときに消える）
 * - displayText：「Text displayed on the LINE chat screen as a message sent by the user when the
 *   action is performed」（最大 300 字）。画面に出るだけで、webhook には postback イベントだけが届く。
 * - text（非推奨）のほうが「Returned from the server through a webhook」＝メッセージとして届く。
 *   しかも「shouldn't be used with quick reply buttons」。→ text は使わない。
 * - data は postback.data で返る（最大 300 字）。クイックリプライのボタンは最大 13 個。
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
export const MSG_PAUSED = "いまボタン操作は止めています。文字で操作してください";

export const MSG_FORBIDDEN =
  "このタスクを操作できるのは担当者・依頼者・下村さんだけです";
export const MSG_CLOSED = "このタスクはもう処理済みです";

export interface PostbackAction {
  type: "postback";
  label: string;
  data: string;
  displayText: string;
}
export interface QuickReply {
  items: Array<{ type: "action"; action: PostbackAction }>;
}

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
const MAX_LABEL = 20;
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

const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");

function button(label: string, data: string, displayText: string) {
  return {
    type: "action" as const,
    action: {
      type: "postback" as const,
      label: cut(label, MAX_LABEL),
      data,
      displayText: cut(displayText, MAX_DATA),
    },
  };
}

/** タスクの 5 つのボタン。 */
export function taskQuickReply(pageId: string): QuickReply {
  return {
    items: [
      button("済", encodeButtonData("done", pageId), "（ボタン）済にする"),
      button(
        "待ち（3日後に確認）",
        encodeButtonData("wait", pageId),
        "（ボタン）待ちにする",
      ),
      button("延期", encodeButtonData("pmenu", pageId), "（ボタン）延期する"),
      button("不要", encodeButtonData("drop", pageId), "（ボタン）不要にする"),
      button(
        "担当を変える",
        encodeButtonData("amenu", pageId),
        "（ボタン）担当を変える",
      ),
    ],
  };
}

/** 受付の返事に付けるボタン。スイッチが off なら undefined（今の返事のまま）。 */
/**
 * @param confirmed 登録が確定した受付の返事か。初動確認・聞き返し（確定前）の返事は false
 *   （確認への答えでタスクが「未着手」に戻ったり旧担当へ渡ったりしないよう、ボタンを付けない）
 */
export function registeredQuickReply(
  pageId: string,
  confirmed: boolean,
): QuickReply | undefined {
  return buttonsActive() && confirmed ? taskQuickReply(pageId) : undefined;
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

export function postponeQuickReply(
  pageId: string,
  todayJst: string,
): QuickReply {
  return {
    items: POSTPONE_KEYS.filter(
      (k) => resolvePostponeKey(k, todayJst) !== null,
    ).map((k) =>
      button(
        POSTPONE_LABEL[k],
        encodeButtonData("pp", pageId, k),
        `（ボタン）延期：${POSTPONE_LABEL[k]}`,
      ),
    ),
  };
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

export function assigneeQuickReply(
  pageId: string,
  members: Member[],
): QuickReply {
  return {
    items: assignableMembers(members).map((m) =>
      button(
        m.name,
        encodeButtonData(
          "as",
          pageId,
          m.userIds.find((id) => LINE_USER_ID_RE.test(id)),
        ),
        `（ボタン）担当を変える：${m.name}`,
      ),
    ),
  };
}

export interface ButtonTask {
  id: string;
  title: string;
  /** 完了・不要（ステータスが完了）か、消されている */
  closed: boolean;
  assigneeId: string | null;
  requesterId: string | null;
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
  quickReply?: QuickReply;
  /** Notion に書いたか */
  changed: boolean;
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
  if (!task || task.closed) return { text: MSG_CLOSED, changed: false };

  const members = await deps.members().catch(() => [] as Member[]);
  if (!canOperate(actorId, task, members))
    return { text: MSG_FORBIDDEN, changed: false };

  const again = taskQuickReply(task.id);
  switch (op) {
    case "done":
      // 確認セッションを先に消す（残すと、後の回答で「未着手」に戻る）
      await deps.session.clear(task.id);
      await deps.complete(task.id);
      return { text: `☑️ 完了にしました\n📋 ${task.title}`, changed: true };
    case "wait": {
      const text = await applyStatusToTask(
        { kind: "wait", note: "", date: null },
        task,
        deps.status,
      );
      return { text, quickReply: again, changed: true };
    }
    case "drop": {
      await deps.session.clear(task.id);
      const text = await applyStatusToTask({ kind: "drop" }, task, deps.status);
      return { text, changed: true };
    }
    case "pmenu": {
      const quickReply = postponeQuickReply(task.id, deps.today());
      return {
        text: `📅 いつに延期しますか？\n📋 ${task.title}`,
        quickReply,
        changed: false,
      };
    }
    case "pp": {
      const date = resolvePostponeKey(extra as string, deps.today());
      if (!date) {
        return {
          text: `⚠️ その日はもう過ぎています。日を選び直してください\n📋 ${task.title}`,
          quickReply: postponeQuickReply(task.id, deps.today()),
          changed: false,
        };
      }
      const text = await applyStatusToTask(
        { kind: "postpone", date },
        task,
        deps.status,
      );
      return { text, quickReply: again, changed: true };
    }
    case "amenu": {
      const quickReply = assigneeQuickReply(task.id, members);
      if (quickReply.items.length === 0) {
        return { text: "⚠️ 名簿に替えられる人がいません", changed: false };
      }
      return {
        text: `👤 誰に替えますか？\n📋 ${task.title}`,
        quickReply,
        changed: false,
      };
    }
    case "as": {
      const m = assignableMembers(members).find((x) =>
        x.userIds.includes(extra as string),
      );
      if (!m) {
        return { text: "⚠️ 名簿にいない人には替えられません", changed: false };
      }
      // 確認セッションの担当を先に合わせる（残すと、確認が済んだとき旧担当へ渡る）
      await deps.session.syncAssignee(task.id, m.name, extra as string);
      await deps.setAssignee(task.id, m.name, extra as string);
      return {
        text: `👤 担当者を ${m.name} さんに設定しました\n📋 ${task.title}`,
        quickReply: again,
        changed: true,
      };
    }
  }
}
