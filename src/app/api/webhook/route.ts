import { NextRequest, NextResponse } from "next/server";
import { verifyLineSignature, sendLineMessage, buildTaskRegisteredMessage } from "@/lib/line";
import { parseTaskFromMessage, TASK_CONFIDENCE_THRESHOLD } from "@/lib/claude";
import {
  createNotionTask,
  setTaskMessageIds,
  findTaskByMessageId,
  updateTaskAssignee,
  archiveTask,
} from "@/lib/notion";
import {
  classifyIntent,
  looksLikeEmailCommand,
  looksLikeSendWithMaterial,
  buildClarificationMenu,
  interpretClarification,
  EMAIL_INTENT_THRESHOLD,
} from "@/lib/intent";
import {
  savePendingClarification,
  getPendingClarification,
  deletePendingClarification,
} from "@/lib/email/session";
import {
  startEmailFlow,
  handleConfirmReply,
  handleIncomingImage,
  handleIncomingFile,
  hasPendingEmailContext,
  getDraftSession,
} from "@/lib/email/flow";
import {
  detectNewCustomerCommand,
  parseCustomerFromMessage,
  createCrmCustomer,
  buildCustomerRegisteredMessage,
} from "@/lib/crm";

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
  fileName?: string; // ファイルメッセージのファイル名（type === "file"）
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

// テキストからタスクを登録して返信する（曖昧確認で「タスク」を選ばれた時に使う）。
async function registerTaskFromText(
  text: string,
  replyToken: string
): Promise<void> {
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
  let parsed;
  try {
    parsed = await parseTaskFromMessage(text, today);
  } catch (err) {
    console.error("タスク解析エラー:", err);
    await sendLineMessage(replyToken, "⚠️ タスクの解析に失敗しました。");
    return;
  }
  try {
    await createNotionTask(parsed, text);
    await sendLineMessage(replyToken, buildTaskRegisteredMessage(parsed));
  } catch (err) {
    console.error("タスク登録エラー:", err);
    await sendLineMessage(
      replyToken,
      "⚠️ タスクの登録中にエラーが発生しました。もう一度お試しください。"
    );
  }
}

// テキストから顧客をCRMへ登録して返信する（曖昧確認で「顧客」を選ばれた時に使う）。
async function registerCrmFromText(
  text: string,
  replyToken: string
): Promise<void> {
  try {
    const customer = await parseCustomerFromMessage(text);
    await createCrmCustomer(customer, text);
    await sendLineMessage(replyToken, buildCustomerRegisteredMessage(customer));
  } catch (err) {
    console.error("CRM顧客登録エラー:", err);
    await sendLineMessage(
      replyToken,
      "⚠️ 顧客の登録中にエラーが発生しました。もう一度お試しください。"
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";

  if (!verifyLineSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const body: LineWebhookBody = JSON.parse(rawBody);

  for (const event of body.events) {
    if (event.type !== "message" || !event.message) continue;

    const replyToken = event.replyToken!;

    // メール機能: 送受信の発言元（グループ/個人 × ユーザー）を特定するためのキー。
    const source = {
      userId: event.source.userId,
      groupId: event.source.groupId,
    };

    // 画像 → 通常は黙って「直近メディア」として控えるだけ（返信しない）。
    // ただし下書きの宛先待ち中は、その場で名刺として読み宛先に設定して返信する。
    if (event.message.type === "image") {
      await handleIncomingImage(event.message.id, source, replyToken);
      continue;
    }

    // ファイル（PDF等）→ 通常は黙って「直近メディア＋添付候補」として控えるだけ。
    // 下書き作成中は、名刺PDFなら宛先に、そうでなければ添付候補として案内する。
    if (event.message.type === "file") {
      await handleIncomingFile(
        event.message.id,
        event.message.fileName ?? "file",
        source,
        replyToken
      );
      continue;
    }

    // 以降はテキストメッセージのみ対象
    if (event.message.type !== "text") continue;

    // 引用リプライ → 既存タスクへの操作（取り消し／担当者の後付け・変更）として扱う。
    // 元の依頼メッセージ or Botの「✅タスク登録しました」への引用のどちらでも特定できる。
    const userMentions =
      event.message.mention?.mentionees.filter(
        (m) => m.type === "user" && m.userId !== BOT_USER_ID
      ) ?? [];

    // ① メール下書きの確認セッションがある場合は最優先。
    //    「送信 / 修正 / 宛先補完 / キャンセル」への返答として処理し、
    //    既存のタスク解析には一切渡さない。
    const draftSession = await getDraftSession(source.groupId, source.userId);
    if (draftSession) {
      await handleConfirmReply(
        stripMentions(event.message),
        source,
        replyToken,
        draftSession
      );
      continue;
    }

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

    // ①' 曖昧確認への返答（「①」「メール」等）→ 保留していた発言を選んだフローへ流す。
    const pendingClar = await getPendingClarification(
      source.groupId,
      source.userId
    );
    if (pendingClar) {
      const choice = interpretClarification(text);
      if (choice) {
        await deletePendingClarification(source.groupId, source.userId);
        if (choice === "none") {
          await sendLineMessage(replyToken, "了解しました。今回は何もしません。");
        } else if (choice === "email") {
          await startEmailFlow(pendingClar, source, replyToken);
        } else if (choice === "crm") {
          await registerCrmFromText(pendingClar, replyToken);
        } else {
          await registerTaskFromText(pendingClar, replyToken);
        }
        continue;
      }
      // 選択と解釈できない返答 → 保留を解除し、この新しい発言を通常処理する
      await deletePendingClarification(source.groupId, source.userId);
    }

    // ②' 「#新規」コマンド → 紹介客をCRM_顧客へ登録（どの行の行頭でも検知）
    const crmText = detectNewCustomerCommand(text);
    if (crmText !== null) {
      try {
        const customer = await parseCustomerFromMessage(crmText || text);
        await createCrmCustomer(customer, text);
        await sendLineMessage(replyToken, buildCustomerRegisteredMessage(customer));
      } catch (err) {
        console.error("CRM顧客登録エラー:", err);
        await sendLineMessage(
          replyToken,
          "⚠️ 顧客の登録中にエラーが発生しました。もう一度お試しください。"
        );
      }
      continue;
    }

    // ③ 「メール送って」等の明確なメール指示は、AI判定より前に確定でメールへ。
    //    （AIが稀にタスクと誤判定するのを防ぐ）
    if (looksLikeEmailCommand(text)) {
      await startEmailFlow(text, source, replyToken);
      continue;
    }

    // ③+ 直近に画像/PDFが届いている文脈での「この名刺の方にPDFを送って」等も
    //     確定でメールへ（「メール」という単語が無くても曖昧メニューを出さない）。
    if (looksLikeSendWithMaterial(text) && (await hasPendingEmailContext(source))) {
      await startEmailFlow(text, source, replyToken);
      continue;
    }

    // ③' 上記に当てはまらない場合、AIで意図判定。
    //     ・曖昧（メール/タスク/顧客のどれとも取れる）→ どう対応するか確認する
    //     ・emailかつ確信度が高い → メールフロー
    //     ・それ以外（task/other/判定失敗）→ 既存タスク処理へ
    try {
      const intent = await classifyIntent(text);
      if (intent.ambiguous) {
        await savePendingClarification(source.groupId, source.userId, text);
        await sendLineMessage(replyToken, buildClarificationMenu());
        continue;
      }
      if (
        intent.intent === "email" &&
        intent.confidence >= EMAIL_INTENT_THRESHOLD
      ) {
        await startEmailFlow(text, source, replyToken);
        continue;
      }
    } catch (err) {
      console.error("intent判定エラー（タスク処理へフォールバック）:", err);
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
