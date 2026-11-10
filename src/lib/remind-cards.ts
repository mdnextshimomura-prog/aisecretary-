/**
 * 朝のリマインドのカード（2026-11-10）。
 * スイッチは TASK_REMIND_CARDS（"1" かつ TASK_BUTTONS=1 かつ TASK_FOLLOWUP=1 のときだけ動く。既定 off。
 * off なら朝のリマインドは今と1バイトも変わらない）。
 *
 * - 文字の一覧（番号つき）はそのまま送り、そのあとに同じタスクを同じ順でカードにして1通足す。
 * - カードは受付と同じタスクカード（task-buttons.ts の taskCard：済・待ち・延期・不要・担当を変える）。
 *   押したあとの権限・処理は今のまま（handleTaskButton）。
 * - 題名の頭に文字の一覧と同じ番号（「3. 」）を付ける。
 * - 1通に載せるのは最大10枚（JSON が 30KB 以上になるなら減らす）。残りがあれば最後に「残り◯件」のカード。
 *   メニュー（TASK_MENU）が on なら［今日・期限切れ］（v1|lt|0）を付け、off なら番号での返信を案内する。
 * ログに出すのは件数・符号だけ（題名・userId は出さない）。
 */
import {
  buttonsActive,
  encodeMenuData,
  MENU_PAGE_SIZE,
  taskCard,
} from "./task-buttons";
import {
  ALT_TEXT_MAX,
  FLEX_LABEL_MAX,
  POSTBACK_TEXT_MAX,
  type FlexMessage,
} from "./task-card";
import { FLEX_JSON_MAX, menuActive } from "./task-menu";

export function remindCardsActive(): boolean {
  return process.env.TASK_REMIND_CARDS === "1" && buttonsActive();
}

export interface RemindCardTask {
  id: string;
  title: string;
  /** Notion の期日（"YYYY-MM-DD" か日時。空なら未定） */
  dueDate: string | null;
  assignee: string | null;
}

export const REMIND_REST_TITLE = "続きがあります";

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function restBubble(rest: number, withMenu: boolean) {
  const body: unknown[] = [
    { type: "text", text: REMIND_REST_TITLE, weight: "bold", size: "md" },
    {
      type: "text",
      text: withMenu
        ? `残り${rest}件は［今日・期限切れ］から見られます`
        : `残り${rest}件は上の一覧の番号で返信してください`,
      size: "sm",
      color: "#888888",
      margin: "md",
      wrap: true,
    },
  ];
  const bubble: Record<string, unknown> = {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: body },
  };
  if (withMenu) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "button",
          style: "primary",
          height: "sm",
          action: {
            type: "postback",
            label: cut("今日・期限切れ", FLEX_LABEL_MAX),
            data: encodeMenuData("lt", 0),
            displayText: cut("（ボタン）今日・期限切れ", POSTBACK_TEXT_MAX),
          },
        },
      ],
    };
  }
  return bubble;
}

/**
 * 文字の一覧に載せた順のタスクから、カードのカルーセルを作る。0件なら undefined。
 * 番号は配列の位置＋1（文字の一覧の番号と同じ）。
 */
export function buildRemindCarousel(
  tasks: RemindCardTask[],
): FlexMessage | undefined {
  const total = tasks.length;
  if (total === 0) return undefined;
  const withMenu = menuActive();
  let count = Math.min(MENU_PAGE_SIZE, total);
  for (;;) {
    const bubbles: unknown[] = tasks.slice(0, count).map(
      (t, i) =>
        taskCard({
          pageId: t.id,
          title: `${i + 1}. ${t.title.trim() || "（無題）"}`,
          due: t.dueDate ? t.dueDate : null,
          assignee: t.assignee,
        }).contents,
    );
    if (count < total) bubbles.push(restBubble(total - count, withMenu));
    const card: FlexMessage = {
      type: "flex",
      altText: cut(
        `🔔 本日のリマインド（${total}件）。ボタンで「済」などにできます`,
        ALT_TEXT_MAX,
      ),
      contents: { type: "carousel", contents: bubbles },
    };
    if (
      Buffer.byteLength(JSON.stringify(card.contents), "utf8") <
        FLEX_JSON_MAX ||
      count === 1
    ) {
      return card;
    }
    count--;
  }
}

/**
 * 文字の一覧を送ったあとにカードを1通送る。スイッチが off・0件なら何もしない（"off"・"empty"）。
 * 送れなかった（LINE が断った・例外）ときも朝のリマインド全体は止めない（文字の一覧は届いている）。
 * ログは1行だけ：`[remind] cards shown N`／`[remind] cards push-failed`。
 */
export async function sendRemindCards(
  to: string,
  tasks: RemindCardTask[],
  push: (to: string, card: FlexMessage) => Promise<boolean>,
  log: (line: string) => void = (l) => console.log(l),
): Promise<"off" | "empty" | "shown" | "failed"> {
  if (!remindCardsActive()) return "off";
  const card = buildRemindCarousel(tasks);
  if (!card) return "empty";
  let ok = false;
  try {
    ok = await push(to, card);
  } catch {
    ok = false;
  }
  log(ok ? `[remind] cards shown ${tasks.length}` : "[remind] cards push-failed");
  return ok ? "shown" : "failed";
}
