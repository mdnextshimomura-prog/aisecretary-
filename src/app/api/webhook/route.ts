import { NextRequest, NextResponse } from "next/server";
import { verifyLineSignature, sendLineMessage, buildTaskRegisteredMessage } from "@/lib/line";
import { parseTaskFromMessage, TASK_CONFIDENCE_THRESHOLD, type ParsedTask } from "@/lib/claude";
import {
  detectMissing,
  buildClarifyMessage,
  buildAnswerAppliedMessage,
  interpretAnswer,
  checklistFor,
  isApproval,
  STATUS_PENDING,
} from "@/lib/clarify";
import { resolveDue, DEFAULT_DUE_TIME } from "@/lib/due-rules";
import { loadClosures, shiftToBusinessDay } from "@/lib/closures";
import { isNewCustomerCommand, handleNewCustomer } from "@/lib/crm";
import { canonicalAssignee } from "@/lib/members";
import { loadRecentAttachments, consumeRecentAttachments } from "@/lib/media";
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
  savePendingTaskConfirm,
  getPendingTaskConfirm,
  deletePendingTaskConfirm,
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
  createNotionTask,
  setTaskMessageIds,
  findTaskByMessageId,
  updateTaskAssignee,
  archiveTask,
  completeTask,
  findTaskByRemindNumber,
  countRemainingTasks,
  setTaskStatus,
  appendTaskNote,
  jstDateStr,
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

// リマインドの番号を指定した完了報告（「3済」「1,2完了」「4おわった」）を解釈する。
// 誤爆を避けるため、次を全て満たすときだけコマンドとみなす:
//   ・短い文であること（長文は通常の依頼として扱う）
//   ・完了を表す語を含むこと（数字だけの「3」には反応しない）
//   ・否定表現を含まないこと
// さらに「番号と完了語と区切り文字を取り除いたら、ほぼ何も残らない」ことも条件にする。
// これが無いと「3件の資料をまとめて明日までに完了させてください」のような
// 数字と『完了』を含む“依頼文”を、3番の完了報告と誤認してしまう。
const NUM_COMPLETE_RE = /(済|完了|終わ|おわ|終了|done)/i;
const NUM_COMPLETE_RE_G = /(済|完了|終わ|おわ|終了|done)/gi;
const COMMAND_NOISE_RE = /[\d、,，。.・とや&＆\s!！?？「」]/g;
const MAX_COMMAND_LENGTH = 40;
const MAX_COMMAND_RESIDUE = 6;
function parseNumberedCompletion(text: string): number[] | null {
  // 全角数字（１２３）でも拾えるように半角へ寄せる
  const normalized = text.replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
  const t = normalized.replace(/\s/g, "");
  if (t.length === 0 || t.length > MAX_COMMAND_LENGTH) return null;
  if (NEGATION_PHRASES.some((p) => t.includes(p))) return null;
  if (!NUM_COMPLETE_RE.test(t)) return null;
  // 番号・完了語・区切りを除いた残りが長い＝コマンドではなく文章とみなす
  const residue = t.replace(NUM_COMPLETE_RE_G, "").replace(COMMAND_NOISE_RE, "");
  if (residue.length > MAX_COMMAND_RESIDUE) return null;
  // 数字の抽出は空白を残したまま行う。先に空白を削ると「1 2 3」が123になってしまう。
  const nums = (normalized.match(/\d+/g) ?? [])
    .map(Number)
    .filter((n) => n >= 1 && n <= 99);
  const uniq = nums.filter((n, i) => nums.indexOf(n) === i);
  return uniq.length > 0 ? uniq : null;
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

// JST（日本時間）の「今」。UTCのままだと朝9時まで前日扱いになる上、
// 午前/午後で期日を変えるルールの判定に受信時刻が必要。
function jstNow(): Date {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function todayLabel(now: Date): string {
  return now.toISOString().slice(0, 16).replace("T", " ");
}

// 期日の確定。メッセージに明示があればそれが最優先、無ければ標準納期表から決める。
// Claude に日付を推測させないことで、同じ依頼には必ず同じ期日が出るようにする。
// タスク登録の入口が複数（通常フロー／曖昧確認からの選択）あるため関数に切り出す。
// ここを通さずに起票すると期日が空のまま登録されるので、必ず経由すること。
async function finalizeDue(parsed: ParsedTask, now: Date): Promise<void> {
  if (parsed.dueDate) {
    parsed.dueTime = parsed.dueTime ?? DEFAULT_DUE_TIME;
    parsed.dueReason = "メッセージの指定";
  } else {
    const decided = resolveDue(parsed.requestType, now, parsed.urgentHint);
    parsed.dueDate = decided.dueDate;
    parsed.dueTime = parsed.dueTime ?? decided.dueTime;
    parsed.urgency = decided.urgency;
    parsed.dueReason = decided.reason;
  }

  // 会社の休業日（お盆・年末年始など）に当たっていたら翌営業日へ送る。
  // 休業中に期日を置いても誰も対応できないため。
  // メッセージで日付を明示された場合もずらす（本人が休業を失念している可能性が高く、
  // 気づけるよう返信に理由を出す）。
  try {
    const shifted = shiftToBusinessDay(parsed.dueDate, await loadClosures());
    if (shifted.reason) {
      parsed.dueDate = shifted.date;
      parsed.dueReason = `${parsed.dueReason}／${shifted.reason}`;
      parsed.urgency = urgencyFromDue(parsed.dueDate, now);
    }
  } catch (err) {
    // 休業日カレンダーが引けなくても登録は続ける
    console.error("休業日の判定に失敗（元の期日のまま）:", err);
  }
}

/** 期日がずれたときに緊急度を付け直す（期日と緊急度が食い違わないように） */
function urgencyFromDue(dueDate: string, now: Date): ParsedTask["urgency"] {
  const today = now.toISOString().slice(0, 10);
  const days = Math.round(
    (Date.parse(`${dueDate.slice(0, 10)}T00:00:00Z`) -
      Date.parse(`${today}T00:00:00Z`)) /
      86_400_000
  );
  if (days <= 0) return "今日中";
  if (days <= 7) return "今週中";
  return "来週以降";
}

// テキストからタスクを登録して返信する（曖昧確認で「タスク」を選ばれた時に使う）。
// 通常フローと違い、メンション由来の担当者やメッセージIDの紐づけは行わない
// （選択の返答メッセージに紐づけても、引用リプライの照合には使えないため）。
async function registerTaskFromText(
  text: string,
  replyToken: string
): Promise<void> {
  const now = jstNow();
  let parsed;
  try {
    parsed = await parseTaskFromMessage(text, todayLabel(now));
  } catch (err) {
    console.error("タスク解析エラー:", err);
    await sendLineMessage(replyToken, "⚠️ タスクの解析に失敗しました。");
    return;
  }
  await finalizeDue(parsed, now);
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

// 顧客登録の入口。#新規 の書式で無い場合は handleNewCustomer が
// 書式の案内（usage）を返すので、そのままLINEへ流す。
async function registerCustomer(text: string, replyToken: string): Promise<void> {
  try {
    await sendLineMessage(replyToken, await handleNewCustomer(text));
  } catch (err) {
    console.error("CRM顧客登録エラー:", err);
    await sendLineMessage(
      replyToken,
      "⚠️ 顧客登録中にエラーが発生しました。もう一度お試しください。"
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

    // ① メール下書きの確認セッションがある場合は最優先。
    //    「送信 / 修正 / 宛先補完 / キャンセル」への返答として処理し、
    //    タスク処理・番号完了には一切渡さない。
    //    （やり取りの最中の返事は、その会話に属するものとして扱う。
    //      セッションはTTL30分で自動失効するため、居座り続けることはない）
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

    // ①-2 初動確認への返事。
    //
    // ②の番号完了より前に置く。ここを後ろにすると、確認への回答が
    // 新規タスクとして解析され、同じ依頼が二重に登録される。
    //
    // 返事は2種類ある。実運用では後者のほうが多い。
    //   (a) 「はい」「OK」    → 提案どおりで確定
    //   (b) 「買主名義は仲介会社宛てで」「手付は300万」「収益として」
    //        → 具体的な値の指定。**既に決まっていた値の上書きも含む**
    //
    // (b) を拾えないと、回答が元のタスクに届かず新規タスクになる。
    // 対象タスクは、引用リプライがあればそれを優先する（複数の確認が
    // 同時に走っているときに取り違えないため）。無ければ直近の1件。
    {
      let pending = await getPendingTaskConfirm(source.groupId);

      // 引用リプライなら、引用先のタスクが確認待ちかどうかで対象を確定する
      if (event.message.quotedMessageId && pending) {
        const quoted = await findTaskByMessageId(event.message.quotedMessageId);
        if (quoted && quoted.id !== pending.pageId) {
          // 別のタスクへの引用＝この確認への回答ではない。③以降に任せる
          pending = null;
        }
      }

      if (pending) {
        const body = stripMentions(event.message);
        const fields = pending.fields;
        const labelOf = (k: string) =>
          fields.find((f) => f.key === k)?.label ?? k;

        // (a) 提案をそのまま承認
        if (isApproval(body)) {
          try {
            const applied = pending.proposalKeys.map((k) => {
              const f = fields.find((x) => x.key === k);
              const v = f?.suggest ?? "";
              pending!.settled[k] = v;
              return `${labelOf(k)}：${v}`;
            });
            pending.proposalKeys = [];

            if (applied.length > 0) {
              await appendTaskNote(pending.pageId, [
                `【承認】${jstDateStr(0)} 提案どおりで確定`,
                ...applied.map((a) => `・${a}`),
              ]);
            }

            const remaining = pending.awaitingKeys.map(labelOf);
            if (remaining.length === 0) {
              await setTaskStatus(pending.pageId, "未着手");
              await deletePendingTaskConfirm(source.groupId);
            } else {
              await savePendingTaskConfirm(source.groupId, pending);
            }
            await sendLineMessage(
              replyToken,
              buildAnswerAppliedMessage(
                pending.title,
                applied,
                [],
                null,
                remaining
              )
            );
          } catch (err) {
            console.error("初動確認の確定に失敗:", err);
            await sendLineMessage(
              replyToken,
              "⚠️ 確認内容の反映に失敗しました。Notion側で直接ご確認ください。"
            );
          }
          continue;
        }

        // (b) 具体的な回答か、無関係な別依頼かを判定する。
        //     確信度が低いものは回答扱いにしない。誤判定すると
        //     **新しい依頼が確認への回答として吸い込まれて消える**。
        const ans = await interpretAnswer(
          body,
          fields,
          pending.settled,
          pending.title
        );
        if (ans.isAnswer && ans.confidence >= TASK_CONFIDENCE_THRESHOLD) {
          try {
            const applied: string[] = [];
            for (const [k, v] of Object.entries(ans.updates)) {
              pending.settled[k] = v;
              pending.awaitingKeys = pending.awaitingKeys.filter((x) => x !== k);
              pending.proposalKeys = pending.proposalKeys.filter((x) => x !== k);
              applied.push(`${labelOf(k)}：${v}`);
            }
            const overridden = ans.overrides.map(labelOf);

            await appendTaskNote(pending.pageId, [
              `【回答】${jstDateStr(0)}`,
              ...applied.map((a) => `・${a}`),
              ...(overridden.length > 0
                ? [`・変更: ${overridden.join("・")}`]
                : []),
              ...(ans.amendment ? [`・修正指示: ${ans.amendment}`] : []),
            ]);

            const remaining = pending.awaitingKeys.map(labelOf);
            if (remaining.length === 0) {
              // 提案分が未承認でも、指示待ちが無くなれば着手はできる。
              // 提案は既定値として通用するものだけを載せているため。
              await setTaskStatus(pending.pageId, "未着手");
              await deletePendingTaskConfirm(source.groupId);
            } else {
              await savePendingTaskConfirm(source.groupId, pending);
            }

            await sendLineMessage(
              replyToken,
              buildAnswerAppliedMessage(
                pending.title,
                applied,
                overridden,
                ans.amendment,
                remaining
              )
            );
            continue;
          } catch (err) {
            console.error("回答の反映に失敗:", err);
            await sendLineMessage(
              replyToken,
              "⚠️ ご回答の反映に失敗しました。Notion側で直接ご確認ください。"
            );
            continue;
          }
        }
        // 回答でなければ何もせず、通常の処理へ落とす（新規依頼として扱う）
      }
    }

    // ② 番号での完了報告（「3済」「1,2完了」）。リマインドを引用しなくても返せるようにする。
    // 引用リプライより先に判定するのは、番号の指定のほうが対象が明確なため。
    const numbers = parseNumberedCompletion(stripMentions(event.message));
    if (numbers) {
      try {
        const done: string[] = [];
        const notFound: number[] = [];
        for (const n of numbers) {
          const t = await findTaskByRemindNumber(n);
          if (!t) {
            notFound.push(n);
            continue;
          }
          await completeTask(t.id);
          done.push(`${n}. ${t.title}`);
        }

        const lines: string[] = [];
        if (done.length > 0) {
          lines.push(`☑️ 完了にしました（${done.length}件）`, ...done);
          const remaining = await countRemainingTasks();
          lines.push("", remaining > 0 ? `残り${remaining}件です。` : "残りはありません。お疲れさまです。");
        }
        if (notFound.length > 0) {
          if (done.length > 0) lines.push("");
          lines.push(
            `⚠️ ${notFound.join("・")}番は見つかりませんでした`,
            "（完了済みか、直近のリマインドに無い番号です）"
          );
        }
        await sendLineMessage(replyToken, lines.join("\n"));
      } catch (err) {
        console.error("番号での完了処理エラー:", err);
        await sendLineMessage(
          replyToken,
          "⚠️ 完了処理中にエラーが発生しました。もう一度お試しください。"
        );
      }
      continue;
    }

    // ③ 引用リプライ → 既存タスクへの操作（取り消し／完了／担当者の後付け・変更）として扱う。
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
              // 後付けの担当者指定も名簿の正式氏名に寄せる（登録時と同じ扱いにする）
              const c = await canonicalAssignee(m.userId ?? null, name);
              await updateTaskAssignee(task.id, c.name ?? name, c.userId);
              await sendLineMessage(
                replyToken,
                `👤 担当者を ${c.name ?? name} さんに設定しました\n📋 ${task.title}`
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

    // ④ 「資料の写真を送る → 担当者をメンションする」がこのグループの依頼の主な形。
    //    （履歴の実測: 社長の発言3,394件中571件が画像で、直後は「@杉山 舜」等のひと言だけ）
    //
    //    重要: 「@杉山 舜」だけの発言は stripMentions 後に **本文が空になる**。
    //    以前はここで空文字を捨てていたため、最頻の依頼パターンが丸ごと素通りしていた。
    //    添付があるなら本文が空でも依頼として扱う。
    const mentionsSomeone = (event.message.mention?.mentionees ?? []).some(
      (m) => m.type === "all" || (m.type === "user" && m.userId !== BOT_USER_ID)
    );
    // 本文もメンションも無ければ何もしない（添付の取得はまだ行わない）
    if (!text && !mentionsSomeone) continue;

    // ⑤ 本文があるときだけ、テキスト前提の分岐にかける
    if (text) {
      // 曖昧確認への返答（「①」「メール」等）→ 保留していた発言を選んだフローへ流す。
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
            await registerCustomer(pendingClar, replyToken);
          } else {
            await registerTaskFromText(pendingClar, replyToken);
          }
          continue;
        }
        // 選択と解釈できない返答 → 保留を解除し、この新しい発言を通常処理する
        await deletePendingClarification(source.groupId, source.userId);
      }

      // 「#新規」コマンド → 紹介客をCRM_顧客へ登録（タスク分類には流さない）
      if (isNewCustomerCommand(text)) {
        await registerCustomer(text, replyToken);
        continue;
      }

      // 「メール送って」等の明確なメール指示は、AI判定より前に確定でメールへ。
      // （AIが稀にタスクと誤判定するのを防ぐ）
      if (looksLikeEmailCommand(text)) {
        await startEmailFlow(text, source, replyToken);
        continue;
      }

      // 直近に画像/PDFが届いている文脈での「この名刺の方にPDFを送って」等も
      // 確定でメールへ（「メール」という単語が無くても曖昧メニューを出さない）。
      if (
        looksLikeSendWithMaterial(text) &&
        (await hasPendingEmailContext(source))
      ) {
        await startEmailFlow(text, source, replyToken);
        continue;
      }
    }

    // ⑥ ここまでで処理されなかった＝タスク候補。ここで初めて添付を取りに行く。
    //    先に取ると「@下村亮太 この名刺の方にメール送って」のようなメール指示でも
    //    画像をダウンロードしてしまい、無駄に遅くなる。
    const attachments = mentionsSomeone
      ? await loadRecentAttachments(source)
      : [];
    if (!text && attachments.length === 0) continue;

    // ⑦ 添付が無い場合だけAIで意図判定する。
    //     ・曖昧（メール/タスク/顧客のどれとも取れる）→ どう対応するか確認する
    //     ・emailかつ確信度が高い → メールフロー
    //     ・それ以外（task/other/判定失敗）→ 既存タスク処理へ
    //    添付＋メンションは依頼と分かっているので、確認メニューを挟まず直接タスクへ回す。
    if (attachments.length === 0) {
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
    }

    const now = jstNow();

    // ⑦ Claude でタスク判定＋解析。解析自体が失敗した発言は雑談扱いで黙ってスキップ。
    //    本文が空（メンションだけ）のときは、添付が依頼の中身であることを伝える。
    let parsed;
    try {
      parsed = await parseTaskFromMessage(
        text || "（本文なし・担当者へのメンションのみ）",
        todayLabel(now),
        attachments
      );
    } catch (err) {
      console.error("タスク解析エラー（スキップ）:", err);
      continue;
    }

    // タスクでない、または確信度が低い発言は登録しない（雑談・相槌・報告など）
    if (!parsed.isTask || parsed.confidence < TASK_CONFIDENCE_THRESHOLD) {
      continue;
    }

    await finalizeDue(parsed, now);

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

    // 担当者をメンバー名簿の正式氏名に寄せる。
    // LINEの表示名をそのまま入れると、同じ人が何通りもの表記でNotionに増える。
    // 名簿に無い人は元の表記のまま通す（新任者の担当が空になるのを避ける）。
    {
      const c = await canonicalAssignee(parsed.assigneeUserId, parsed.assignee);
      parsed.assignee = c.name;
      parsed.assigneeUserId = c.userId;
    }

    try {
      // Notion に登録
      // 「元メッセージ」は後から人が経緯を追うための欄。本文が空でも
      // 「画像だけ届いた」と分かるようにしておく（空欄だと何も追えない）。
      const rawForNotion =
        text || `（本文なし・添付${attachments.length}件＋担当者へのメンション）`;
      const pageId = await createNotionTask(parsed, rawForNotion);

      // ── 初動確認 ──
      // 条件が抜けていて「今すぐ着手できない」依頼は、提案付きで聞き返す。
      //
      // ★順番が重要★ createNotionTask の**後**に置いている。
      // 確認を登録の前に置くと、誰も答えなかった依頼が消える。
      // 確認はあくまで登録済みタスクへの追記として動かす。
      // detectMissing 自体が失敗しても fail-open で「不足なし」が返るので、
      // ここが落ちて登録済みタスクが宙に浮くことはない。
      const clarify = await detectMissing(
        text,
        parsed.requestType,
        parsed.propertyName ?? null,
        attachments
      );
      const needsClarify =
        clarify.missing.length > 0 || clarify.propertyUnknown;

      let reply: string;
      if (needsClarify) {
        await setTaskStatus(pageId, STATUS_PENDING);
        const proposalKeys = clarify.missing
          .filter((f) => f.suggest)
          .map((f) => f.key);
        const awaitingKeys = clarify.missing
          .filter((f) => !f.suggest)
          .map((f) => f.key);
        await appendTaskNote(pageId, [
          `【初動確認】${jstDateStr(0)}`,
          ...Object.values(clarify.found).map((v) => `・確認済み: ${v}`),
          ...clarify.missing
            .filter((f) => !f.suggest)
            .map((f) => `・要指示: ${f.label}`),
          ...clarify.missing
            .filter((f) => f.suggest)
            .map((f) => `・提案: ${f.label}：${f.suggest}`),
        ]);
        await savePendingTaskConfirm(source.groupId, {
          pageId,
          title: parsed.title,
          requestType: parsed.requestType,
          fields: checklistFor(parsed.requestType),
          awaitingKeys,
          proposalKeys,
          settled: { ...clarify.found },
          createdAt: Date.now(),
        });
        reply = buildClarifyMessage(
          parsed.title,
          clarify,
          parsed.propertyName ?? null
        );
      } else {
        reply = buildTaskRegisteredMessage(parsed);
      }

      const botMsgId = await sendLineMessage(replyToken, reply);

      // 元メッセージとBot返信のIDを保存（後からの引用リプライで
      // 「どのタスクへの担当者指定か」を特定できるようにする）
      await setTaskMessageIds(
        pageId,
        [event.message.id, botMsgId ?? ""].filter(Boolean)
      );

      // 使った添付は捨てる。残すと同じ画像が後続の発言にも繰り返し添付され、
      // 無関係な発言がその画像の依頼として登録されてしまう。
      if (attachments.length > 0) await consumeRecentAttachments(source);
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
