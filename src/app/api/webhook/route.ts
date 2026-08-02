import { NextRequest, NextResponse } from "next/server";
import { verifyLineSignature, sendLineMessage, buildTaskRegisteredMessage } from "@/lib/line";
import { parseTaskFromMessage, TASK_CONFIDENCE_THRESHOLD } from "@/lib/claude";
import { isNewCustomerCommand, handleNewCustomer } from "@/lib/crm";
import {
  createNotionTask,
  setTaskMessageIds,
  findTaskByMessageId,
  updateTaskAssignee,
  archiveTask,
  completeTask,
} from "@/lib/notion";

// 「これはタスクじゃない／取り消したい」意図の判定（引用リプライ時のみ使用）
const CANCEL_PHRASES = [
  "タスクではない",
  "タスクじゃない",
  "タスクではありません",
  "タスクじゃなかった",
  "キャンセル",
  "取り消",
  "取消",
  "削除",
  "消して",
  "いらない",
  "不要",
];
function isCancelIntent(text: string): boolean {
  const t = text.replace(/\s/g, "");
  return CANCEL_PHRASES.some((p) => t.includes(p));
}

// 「終わった」意図の判定（引用リプライ時のみ使用）。
// 取り消し（＝そもそもタスクではなかった）と違い、記録を残したまま完了にする。
const COMPLETE_PHRASES = [
  "完了",
  "完了しました",
  "終わりました",
  "おわりました",
  "終わった",
  "終了",
  "済み",
  "済です",
  "対応済",
  "対応しました",
  "やりました",
  "done",
  // 「OK」「了解」は入れない。着手の返事（了解、やります）と区別できないため。
];
// 「まだ完了してない」を完了と誤認しないための否定表現
const NEGATION_PHRASES = [
  "まだ",
  "未完了",
  "未済",
  "してない",
  "していない",
  "できてない",
  "できていない",
  "ません",
  "ないです",
];
function isCompleteIntent(text: string): boolean {
  const t = text.replace(/\s/g, "");
  if (NEGATION_PHRASES.some((p) => t.includes(p))) return false;
  const lower = t.toLowerCase();
  return COMPLETE_PHRASES.some((p) => lower.includes(p.toLowerCase()));
}

interface LineMentionee {
  index: number;
  length: number;
  userId?: string;
  type: "user" | "all";
}

interface LineMessage {
  id: string;
  type: string;
  text: string;
  quotedMessageId?: string; // 引用リプライのとき、引用元メッセージのID
  mention?: {
    mentionees: LineMentionee[];
  };
}

interface LineWebhookEvent {
  type: string;
  replyToken?: string;
  source: { userId: string; type: string; groupId?: string };
  message?: LineMessage;
}

interface LineWebhookBody {
  events: LineWebhookEvent[];
}

const BOT_USER_ID = process.env.LINE_BOT_USER_ID!;

// メンション部分をテキストから除去して純粋なタスク内容だけ取り出す
function stripMentions(message: LineMessage): string {
  if (!message.mention) return message.text;
  const mentionees = [...message.mention.mentionees].sort(
    (a, b) => b.index - a.index
  );
  let text = message.text;
  for (const m of mentionees) {
    text = text.slice(0, m.index) + text.slice(m.index + m.length);
  }
  return text.trim();
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";

  if (!verifyLineSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const body: LineWebhookBody = JSON.parse(rawBody);

  for (const event of body.events) {
    if (event.type !== "message" || event.message?.type !== "text") continue;

    const replyToken = event.replyToken!;

    // 引用リプライ → 既存タスクへの操作（取り消し／担当者の後付け・変更）として扱う。
    // 元の依頼メッセージ or Botの「✅タスク登録しました」への引用のどちらでも特定できる。
    const userMentions =
      event.message.mention?.mentionees.filter(
        (m) => m.type === "user" && m.userId !== BOT_USER_ID
      ) ?? [];
    if (event.message.quotedMessageId) {
      const task = await findTaskByMessageId(event.message.quotedMessageId);
      if (task) {
        // (a) 「タスクじゃない／取り消し」→ タスクを削除
        if (isCancelIntent(stripMentions(event.message))) {
          try {
            await archiveTask(task.id);
            await sendLineMessage(
              replyToken,
              `🗑 タスクを取り消しました\n📋 ${task.title}`
            );
          } catch (err) {
            console.error("タスク取り消しエラー:", err);
          }
          continue;
        }
        // (a2) 「完了／終わりました」→ ステータスを完了にする（記録は残す）
        if (isCompleteIntent(stripMentions(event.message))) {
          try {
            await completeTask(task.id);
            await sendLineMessage(
              replyToken,
              `☑️ 完了にしました\n📋 ${task.title}`
            );
          } catch (err) {
            console.error("タスク完了エラー:", err);
            await sendLineMessage(
              replyToken,
              "⚠️ 完了処理中にエラーが発生しました。もう一度お試しください。"
            );
          }
          continue;
        }
        // (b) @メンション → 担当者の設定・変更
        if (userMentions.length > 0) {
          const m = userMentions[0];
          const raw = event.message.text.slice(m.index, m.index + m.length);
          const name = raw.startsWith("@") ? raw.slice(1) : raw;
          if (name) {
            try {
              await updateTaskAssignee(task.id, name, m.userId ?? null);
              await sendLineMessage(
                replyToken,
                `👤 担当者を ${name} さんに設定しました\n📋 ${task.title}`
              );
            } catch (err) {
              console.error("担当者更新エラー:", err);
            }
            continue; // 担当者設定のリプライは新規タスクとして解析しない
          }
        }
      }
    }

    // メンションは必須ではない。全発言をClaudeに渡し、タスクかどうかを判定させる。
    const text = stripMentions(event.message);
    if (!text) continue;

    // #新規 で始まるメッセージは CRM顧客登録として処理（タスク分類には流さない）
    if (isNewCustomerCommand(text)) {
      try {
        await sendLineMessage(replyToken, await handleNewCustomer(text));
      } catch (err) {
        console.error("CRM顧客登録エラー:", err);
        await sendLineMessage(
          replyToken,
          "⚠️ 顧客登録中にエラーが発生しました。もう一度お試しください。"
        );
      }
      continue;
    }
    // JST（日本時間）の日時を渡す。UTCのままだと朝9時まで前日扱いになる上、
    // 午前/午後で期日を変えるルールの判定に受信時刻が必要。
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16)
      .replace("T", " ");

    // 1. Claude でタスク判定＋解析。解析自体が失敗した発言は雑談扱いで黙ってスキップ。
    let parsed;
    try {
      parsed = await parseTaskFromMessage(text, today);
    } catch (err) {
      console.error("タスク解析エラー（スキップ）:", err);
      continue;
    }

    // タスクでない、または確信度が低い発言は登録しない（雑談・相槌・報告など）
    if (!parsed.isTask || parsed.confidence < TASK_CONFIDENCE_THRESHOLD) {
      continue;
    }

    // メンションがあれば、その名前を担当者として優先採用（ボット自身のメンションは除く）
    if (event.message.mention) {
      const others = event.message.mention.mentionees.filter(
        (m) => m.type === "user" && m.userId !== BOT_USER_ID
      );
      if (others.length > 0) {
        const m = others[0];
        const raw = event.message.text.slice(m.index, m.index + m.length);
        const name = raw.startsWith("@") ? raw.slice(1) : raw;
        if (name) parsed.assignee = name;
        // リマインド時にLINEメンション（@通知）するため userId も保存する
        if (m.userId) parsed.assigneeUserId = m.userId;
      }
    }

    try {
      // 2. Notion に登録
      const pageId = await createNotionTask(parsed, text);

      // 3. LINE に「登録しました」と返信
      const reply = buildTaskRegisteredMessage(parsed);
      const botMsgId = await sendLineMessage(replyToken, reply);

      // 4. 元メッセージとBot返信のIDを保存（後からの引用リプライで
      //    「どのタスクへの担当者指定か」を特定できるようにする）
      await setTaskMessageIds(
        pageId,
        [event.message.id, botMsgId ?? ""].filter(Boolean)
      );
    } catch (err) {
      console.error("タスク登録エラー:", err);
      await sendLineMessage(
        replyToken,
        "⚠️ タスクの登録中にエラーが発生しました。もう一度お試しください。"
      );
    }
  }

  return NextResponse.json({ status: "ok" });
}
