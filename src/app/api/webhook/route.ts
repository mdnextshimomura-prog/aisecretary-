import { NextRequest, NextResponse } from "next/server";
import {
  verifyLineSignature,
  sendLineMessage,
  buildTaskRegisteredMessage,
  pushLineMessage,
  pushLineMessageWithMentions,
} from "@/lib/line";
import {
  parseTaskFromMessage,
  TASK_CONFIDENCE_THRESHOLD,
  type ParsedTask,
  type TaskAttachment,
} from "@/lib/claude";
import { mapContext } from "@/lib/maps";
import { shouldClarifyFor } from "@/lib/clarify-target";
import {
  classifyApiError,
  alertMessage,
  shouldAlert,
  markApiHealthy,
} from "@/lib/apihealth";
import {
  detectMissing,
  buildClarifyMessage,
  buildAnswerAppliedMessage,
  buildHandoffMessage,
  interpretAnswer,
  checklistFor,
  fillPlaceholders,
  applyDerivedValues,
  applyApproval,
  applyAnswer,
  isApproval,
  PROPERTY_FIELD,
  STATUS_PENDING,
  type PendingState,
  type ApplyResult,
} from "@/lib/clarify";
import { resolveDue, DEFAULT_DUE_TIME } from "@/lib/due-rules";
import { loadClosures, shiftToBusinessDay } from "@/lib/closures";
import { isNewCustomerCommand, handleNewCustomer } from "@/lib/crm";
import { canonicalAssignee } from "@/lib/members";
import { applyAutomaticAssignment } from "@/lib/assignment";
import { isContextlessRequest, taskMentionState } from "@/lib/task-intake";
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
  reserveEvent,
  completeEvent,
  releaseEvent,
  savePendingTaskConfirm,
  getPendingTaskConfirm,
  deletePendingTaskConfirm,
  reserveMessage,
  releaseMessage,
  completeMessage,
  addPendingHandoff,
  removePendingHandoff,
  type PendingTaskConfirm,
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

// 「これはタスクじゃない／取り消したい」意図の判定
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
  "何もしない",
  "何もしなくて良い",
  "何もしなくてよい",
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
/**
 * 条件が揃ったタスクを担当者へ引き渡す。
 *
 * 社長との確認が終わった時点で担当者にメンションを飛ばす。
 * ここを省くと「条件は固まったのに担当者が気づかない」で止まる。
 * 担当者のuserIdが無い（名簿未登録・名前だけ）場合はメンションできないので
 * 名前をテキストで出す。送れなくても処理は続ける（引き渡しの失敗で
 * タスクの状態まで巻き戻すと、二重に混乱するため）。
 */
async function handoffToAssignee(
  groupId: string | undefined,
  pending: PendingTaskConfirm
): Promise<void> {
  if (!groupId) return;
  const hasMention = Boolean(pending.assigneeUserId);
  const text = buildHandoffMessage(
    pending.title,
    pending.propertyName ?? null,
    pending.settled,
    pending.fields,
    pending.assignee ?? null,
    hasMention
  );
  // fetch 自体が投げることもある。boolean だけ見ていると素通りする
  const ok = await (hasMention && pending.assigneeUserId
    ? pushLineMessageWithMentions(groupId, text, {
        assignee: pending.assigneeUserId,
      })
    : pushLineMessage(groupId, text)
  ).catch((e) => {
    console.error("引き渡し通知の送信で例外:", e);
    return false;
  });

  if (!ok) {
    // 送信に失敗しても状態は戻さない（条件は本当に揃っているため）。
    // ただし**再送待ちとして積む**。ここで捨てると、条件は固まったのに
    // 担当者へ永久に伝わらない。日次リマインドの前に再送を試みる。
    // 送信前に再送待ちへ積んである（write-ahead）。ここでは消さずに残すだけ。
    console.error("担当者への引き渡し通知に失敗（再送待ちに残す）:", pending.pageId);
    await appendTaskNote(pending.pageId, [
      `⚠️ ${jstDateStr(0)} 担当者への引き渡し通知をLINEへ送れませんでした。`,
      `・条件は確定済みです。次の日次ジョブで再送します。`,
      ...(pending.assignee ? [`・担当：${pending.assignee}`] : []),
    ]).catch(() => undefined);
    return;
  }
  await removePendingHandoff(groupId, pending.pageId).catch(() => undefined);
}

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

/**
 * タスク登録後の初動確認。**登録経路が2つあるので共有する。**
 *
 * 通常のWebhook経路と、曖昧確認メニューで「タスク」を選ばれた経路の両方から呼ぶ。
 * 片方だけに書くと、メニュー経由の依頼は聞き返しが一切かからない。
 *
 * @returns LINEへ返す本文
 */
async function clarifyAfterCreate(
  pageId: string,
  parsed: ParsedTask,
  text: string,
  attachments: TaskAttachment[],
  groupId: string | undefined,
  createdByUserId: string | undefined
): Promise<string> {
  const clarify = await detectMissing(
    text,
    parsed.requestType,
    parsed.propertyName ?? null,
    attachments,
    parsed.dueDate ?? undefined
  );

  // 判定そのものに失敗したときは「不足なし」と同じ扱いにしない。
  // 条件が揃っている保証はどこにも無く、着手可能に見せるほうが危険。
  if (clarify.failed) {
    await setTaskStatus(pageId, STATUS_PENDING);
    await appendTaskNote(pageId, [
      `⚠️ ${jstDateStr(0)} 条件の自動確認に失敗しました。人の目で確認してください。`,
    ]).catch(() => undefined);
    return (
      `📝 「${parsed.title}」を登録しました。\n` +
      `⚠️ 条件の自動確認ができませんでした。内容をご確認ください。`
    );
  }

  const derived = applyDerivedValues(clarify.found);
  let missing = clarify.missing.filter((f) => !derived.includes(f.key));

  // 物件が特定できないときは、確認項目として持たせる。
  // 質問文に出すだけだと、答えが来ても記録されず、他の項目が埋まった時点で
  // 物件不明のまま「着手可能」になってしまう。
  if (clarify.propertyUnknown) missing = [PROPERTY_FIELD, ...missing];

  if (missing.length === 0) {
    return buildTaskRegisteredMessage(parsed);
  }

  const fields = [
    ...fillPlaceholders(checklistFor(parsed.requestType), {
      期日: parsed.dueDate ?? undefined,
    }),
    ...(clarify.propertyUnknown ? [PROPERTY_FIELD] : []),
  ];
  await setTaskStatus(pageId, STATUS_PENDING);
  await appendTaskNote(pageId, [
    `【初動確認】${jstDateStr(0)}`,
    ...Object.entries(clarify.found).map(
      ([k, v]) => `・確認済み: ${fields.find((f) => f.key === k)?.label ?? k}：${v}`
    ),
    ...missing.filter((f) => !f.suggest).map((f) => `・要指示: ${f.label}`),
    ...missing.filter((f) => f.suggest).map((f) => `・提案: ${f.label}：${f.suggest}`),
  ]);
  await savePendingTaskConfirm(groupId, {
    pageId,
    title: parsed.title,
    requestType: parsed.requestType,
    createdByUserId: createdByUserId ?? null,
    fields,
    awaitingKeys: missing.filter((f) => !f.suggest).map((f) => f.key),
    proposalKeys: missing.filter((f) => f.suggest).map((f) => f.key),
    settled: { ...clarify.found },
    propertyName: parsed.propertyName ?? null,
    assignee: parsed.assignee ?? null,
    assigneeUserId: parsed.assigneeUserId ?? null,
    createdAt: Date.now(),
  });
  return buildClarifyMessage(
    parsed.title,
    { ...clarify, missing },
    parsed.propertyName ?? null,
    undefined,
    fields,
    parsed.assignee ?? null,
    parsed.assignmentReason ?? null
  );
}

/** Botが送った確認メッセージのIDを控える（引用リプライで確認を特定するため） */
async function rememberConfirmMessage(
  groupId: string | undefined,
  pageId: string,
  botMessageId: string | null
): Promise<void> {
  if (!botMessageId) return;
  const p = await getPendingTaskConfirm(groupId, null, pageId);
  if (!p || p.pageId !== pageId) return;
  p.botMessageId = botMessageId;
  await savePendingTaskConfirm(groupId, p);
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
  replyToken: string,
  groupId: string | undefined,
  /** 選択の返答メッセージID。二重登録を防ぐ予約キーに使う */
  sourceMessageId: string,
  /** 発言者。初動確認の対象かどうかの判定に使う */
  senderId: string | undefined
): Promise<"ok" | "retry"> {
  // 通常経路と同じ予約を通す。ここを素通しにすると、同時到達で
  // 同じ依頼が2つ登録される（選択状態は片方が消す前に両方読める）。
  const claim = await reserveMessage(sourceMessageId);
  if (!claim.proceed) {
    if (claim.inProgress) return "retry";
    return "ok"; // 既に登録済み
  }

  const now = jstNow();
  let parsed;
  try {
    parsed = await parseTaskFromMessage(text, todayLabel(now));
  } catch (err) {
    console.error("タスク解析エラー:", err);
    await releaseMessage(sourceMessageId).catch(() => undefined);
    await sendLineMessage(replyToken, "⚠️ タスクの解析に失敗しました。");
    return "ok";
  }
  await finalizeDue(parsed, now);

  let existing: { id: string } | null = null;
  try {
    existing = await findTaskByMessageId(sourceMessageId);
  } catch {
    await releaseMessage(sourceMessageId).catch(() => undefined);
    return "retry";
  }
  if (existing) {
    await completeMessage(sourceMessageId, existing.id).catch(() => undefined);
    return "ok";
  }

  let pageId: string;
  try {
    pageId = await createNotionTask(parsed, text, sourceMessageId);
  } catch (err) {
    console.error("タスク登録エラー:", err);
    let created: { id: string } | null = null;
    let lookupOk = true;
    try {
      created = await findTaskByMessageId(sourceMessageId);
    } catch {
      lookupOk = false;
    }
    if (created) {
      await completeMessage(sourceMessageId, created.id).catch(() => undefined);
      return "ok";
    }
    if (!lookupOk) return "retry"; // 出来たか不明。予約は残して再送に回す
    await releaseMessage(sourceMessageId).catch(() => undefined);
    await sendLineMessage(
      replyToken,
      "⚠️ タスクの登録中にエラーが発生しました。もう一度お試しください。"
    );
    return "ok";
  }
  await completeMessage(sourceMessageId, pageId).catch(() => undefined);

  // 通常経路と同じ初動確認をかける。ここを飛ばすと、曖昧確認メニュー経由の
  // 依頼だけ聞き返しが働かず、同じ「これ買いたい」でも挙動が変わってしまう。
  let reply: string;
  if (!shouldClarifyFor(senderId)) {
    reply = buildTaskRegisteredMessage(parsed);
  } else {
    try {
      reply = await clarifyAfterCreate(
        pageId,
        parsed,
        text,
        [],
        groupId,
        senderId
      );
    } catch (err) {
      console.error("初動確認に失敗（登録は完了）:", err);
      reply =
        `📝 「${parsed.title}」を登録しました。\n` +
        `⚠️ 条件の自動確認ができませんでした。内容をご確認ください。`;
    }
  }
  const botMsgId = await sendLineMessage(replyToken, reply);
  await setTaskMessageIds(pageId, [botMsgId ?? ""].filter(Boolean)).catch(
    () => undefined
  );
  await rememberConfirmMessage(groupId, pageId, botMsgId ?? null);
  return "ok";
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

  // 処理を完了できなかったイベントがあれば非2xxを返してLINEに再送させる。
  // 200で返すとLINEは再送をやめるため、処理中の側が落ちていた場合に
  // 誰も引き継がず依頼が永久に消える。
  let needsRetry: boolean = false;

  for (const event of body.events) {
    if (event.type !== "message" || !event.message) continue;

    // イベント単位で予約する。バッチ内の1件が再送を要求すると LINE は
    // バッチ全体を送り直すため、これが無いと処理済みのイベント
    // （確認への回答・メール送信・顧客登録）まで作り直される。
    const eventMessageId = event.message.id;
    const ev = await reserveEvent(eventMessageId);
    if (!ev.proceed) {
      if (ev.inProgress) {
        // 他が処理中。200で返すと再送が止まり、処理中の側が落ちていた場合に
        // 誰も引き継がずイベントが失われる。
        needsRetry = true;
      } else {
        console.log("処理済みのイベントをスキップ:", event.message.id);
      }
      continue;
    }

    // このイベントが再送を必要としたか。**バッチ全体の needsRetry とは別に持つ。**
    // 共有のフラグで判定すると、先のイベントが立てた true を見て
    // 「自分も再送要求済み」と誤認し、未処理のまま完了印を付けてしまう。
    let eventRetry = false;
    // 永続的な副作用（Notionへの書き込み・メール送信・顧客登録）が
    // 既に確定したか。**確定後は再送してはいけない。**
    // 確定後にLINEへの返信だけ失敗した場合に再送すると、
    // 確認状態が消えた後の回答が新規タスクとして解析されて重複する。
    let committed = false;
    const markCommitted = () => {
      committed = true;
    };
    const requestRetry = () => {
      if (committed) {
        // 副作用は確定済み。やり直すと二重になるので再送しない。
        console.error("副作用は確定済みのため再送しない:", eventMessageId);
        return;
      }
      eventRetry = true;
      needsRetry = true;
    };
    try {

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
    //   (b) 「手付は300万」「うちで買う」→ 具体的な値の指定。既存値の上書きも含む
    //
    // 対象の確認は、引用リプライがあればそれで特定する。無ければ直近の1件。
    // グループ内に複数の確認が同時に存在しうるため、直近だけを持つ実装にはしない。
    {
      const quotedId = event.message.quotedMessageId ?? null;
      const quotedTask = quotedId ? await findTaskByMessageId(quotedId) : null;
      const pending = await getPendingTaskConfirm(
        source.groupId,
        quotedId,
        quotedTask?.id ?? null,
        source.userId
      );

      // 引用先が「確認待ちではない既存タスク」なら、③の取消/完了/担当者に任せる
      const quotedIsOther = Boolean(quotedTask && pending?.pageId !== quotedTask.id);
      // 引用がこの確認を指していると確認できた場合だけ「引用リプライ」として扱う。
      // 無関係な発言を引用しただけで拾い直しを許すと、別依頼が吸い込まれる。
      const quoteResolved =
        Boolean(quotedId) &&
        Boolean(pending) &&
        (quotedTask?.id === pending?.pageId || pending?.botMessageId === quotedId);

      if (pending && !quotedIsOther) {
        const body = stripMentions(event.message);
        const state: PendingState = {
          fields: pending.fields,
          awaitingKeys: pending.awaitingKeys,
          proposalKeys: pending.proposalKeys,
          settled: pending.settled,
        };

        const persist = async (r: ApplyResult, extraNote: string[]) => {
          pending.awaitingKeys = state.awaitingKeys;
          pending.proposalKeys = state.proposalKeys;
          pending.settled = state.settled;
          await appendTaskNote(pending.pageId, [
            `【回答】${jstDateStr(0)}`,
            ...r.applied.map((a) => `・${a}`),
            ...r.derived.map((d) => `・${d}（自動補完）`),
            ...extraNote,
          ]);
          if (r.complete) {
            // **引き渡し待ちを先に積んでから**確認状態を消す。
            // 逆順だと、消した直後に落ちた場合に確認も引き渡しも残らず、
            // 条件は固まったのに担当者へ永久に伝わらない。
            await addPendingHandoff(source.groupId, pending);
            await setTaskStatus(pending.pageId, "未着手");
            await deletePendingTaskConfirm(source.groupId, pending.pageId);
          } else {
            await savePendingTaskConfirm(source.groupId, pending);
          }
        };

        // 元の依頼者が「何もしなくてよい」と返したら、確認待ちを放置しない。
        // 引用がない場合も createdByUserId で同一人物と確認済みなので、
        // この時点で安全に取り消せる。
        if (isCancelIntent(body)) {
          try {
            await archiveTask(pending.pageId);
            await deletePendingTaskConfirm(source.groupId, pending.pageId);
            markCommitted();
            await sendLineMessage(
              replyToken,
              `🗑 タスクを取り消しました\n📋 ${pending.title}`
            );
          } catch (err) {
            console.error("確認待ちタスクの取り消しエラー:", err);
            await sendLineMessage(
              replyToken,
              "⚠️ タスクの取り消しに失敗しました。Notion側で直接ご確認ください。"
            );
          }
          continue;
        }

        // (a) 提案をそのまま承認
        if (isApproval(body)) {
          try {
            const r = applyApproval(state);
            await persist(r, []);
            markCommitted();
            await sendLineMessage(
              replyToken,
              buildAnswerAppliedMessage(pending.title, r.applied, [], null, r.remaining)
            );
            if (r.complete) {
              await handoffToAssignee(source.groupId, pending);
            }
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
        //     新規依頼と判定されたものは絶対に吸い込まない。ここで吸い込むと
        //     **その依頼は登録すらされずに消える**（確認の取りこぼしより損害が大きい）。
        const ans = await interpretAnswer(
          body,
          pending.fields,
          pending.settled,
          pending.title,
          quoteResolved
        );

        // 「新しい依頼を吸い込まない」の安全弁は isNewRequest に置く。
        // 確信度だけで切ると、「名義を仲介会社宛てに変えて」のような
        // **解釈が二通りある正当な回答**が落ちて新規タスクになる（実測 0.4〜0.6）。
        // 一方 isNewRequest は別依頼を 0.97 で見分けられた。
        //
        // 修正指示（amendment）は定義上そのタスクへの指示なので、確信度が低くても拾う。
        // amendment はどの必須項目も埋めないため、これで着手可能になることはない。
        const relatesToTask =
          ans.isAnswer &&
          !ans.isNewRequest &&
          (ans.confidence >= TASK_CONFIDENCE_THRESHOLD || Boolean(ans.amendment));
        const uncertain = relatesToTask && ans.confidence < TASK_CONFIDENCE_THRESHOLD;

        if (relatesToTask) {
          try {
            const r = applyAnswer(state, ans.updates);
            const overridden = ans.overrides
              .map((k) => pending.fields.find((f) => f.key === k)?.label ?? k);
            await persist(r, [
              ...(overridden.length > 0 ? [`・変更: ${overridden.join("・")}`] : []),
              ...(ans.amendment ? [`・修正指示: ${ans.amendment}`] : []),
            ]);
            markCommitted();
            let msg = buildAnswerAppliedMessage(
              pending.title,
              [...r.applied, ...r.derived.map((d) => `${d}（自動）`)],
              overridden,
              ans.amendment,
              r.remaining
            );
            // 取り違えたときに戻せる道を残す。判断が割れる発言を黙って
            // 既存タスクに付けると、別依頼だった場合に気づけない。
            if (uncertain) {
              msg +=
                `\n\n※ このタスクへのご指示として扱いました。` +
                `別のご依頼でしたら、もう一度そのままお送りください。`;
            }
            await sendLineMessage(replyToken, msg);
            if (r.complete) {
              await handoffToAssignee(source.groupId, pending);
            }
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
          markCommitted();
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
            markCommitted();
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
              markCommitted();
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

    // 新規タスクはAI秘書への明示メンションが入口。
    // 社員へのメンションは担当指定として使うが、それだけではAIを起動しない。
    // 既存タスクへの回答・完了・担当変更はこの手前で処理済みなので影響しない。
    const text = stripMentions(event.message);
    const mentionState = taskMentionState(
      event.message.mention?.mentionees,
      BOT_USER_ID
    );

    // ④ 「資料の写真を送る → 担当者をメンションする」がこのグループの依頼の主な形。
    //    （履歴の実測: 社長の発言3,394件中571件が画像で、直後は「@杉山 舜」等のひと言だけ）
    //
    //    重要: 「@杉山 舜」だけの発言は stripMentions 後に **本文が空になる**。
    //    以前はここで空文字を捨てていたため、最頻の依頼パターンが丸ごと素通りしていた。
    //    添付があるなら本文が空でも依頼として扱う。
    // 本文もメンションも無ければ何もしない（添付の取得はまだ行わない）
    if (!text && !mentionState.mentionsBot && !mentionState.mentionsAssignee) continue;

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
          if (choice === "none") {
            await deletePendingClarification(source.groupId, source.userId);
            await sendLineMessage(replyToken, "了解しました。今回は何もしません。");
          } else if (choice === "email") {
            await deletePendingClarification(source.groupId, source.userId);
            await startEmailFlow(pendingClar, source, replyToken);
            markCommitted();
          } else if (choice === "crm") {
            await deletePendingClarification(source.groupId, source.userId);
            await registerCustomer(pendingClar, replyToken);
            markCommitted();
          } else {
            // タスク登録も通常経路と同じ冪等化を通す。
            // 選択状態を先に消すと、同時到達の両方が登録に進んで二重になる。
            const r = await registerTaskFromText(
              pendingClar,
              replyToken,
              source.groupId,
              event.message.id,
              source.userId
            );
            if (r === "retry") {
              requestRetry();
              continue;
            }
            markCommitted();
            await deletePendingClarification(source.groupId, source.userId);
          }
          continue;
        }
        // 選択と解釈できない返答 → 保留を解除し、この新しい発言を通常処理する
        await deletePendingClarification(source.groupId, source.userId);
      }

      // 「#新規」コマンド → 紹介客をCRM_顧客へ登録（タスク分類には流さない）
      if (isNewCustomerCommand(text)) {
        await registerCustomer(text, replyToken);
        markCommitted();
        continue;
      }

      // 「メール送って」等の明確なメール指示は、AI判定より前に確定でメールへ。
      // （AIが稀にタスクと誤判定するのを防ぐ）
      if (looksLikeEmailCommand(text)) {
        await startEmailFlow(text, source, replyToken);
        markCommitted();
        continue;
      }

      // 直近に画像/PDFが届いている文脈での「この名刺の方にPDFを送って」等も
      // 確定でメールへ（「メール」という単語が無くても曖昧メニューを出さない）。
      if (
        looksLikeSendWithMaterial(text) &&
        (await hasPendingEmailContext(source))
      ) {
        await startEmailFlow(text, source, replyToken);
        markCommitted();
        continue;
      }
    }

    // ⑥ 通常会話への誤反応を防ぐ。新規タスクは @AI秘書 がある発言だけ受け付ける。
    //    メンションなしの「お願いします」や、社員同士の@メンションには反応しない。
    if (!mentionState.mentionsBot) continue;

    // ここまでで処理されなかった＝タスク候補。ここで初めて添付を取りに行く。
    //    先に取ると「@下村亮太 この名刺の方にメール送って」のようなメール指示でも
    //    画像をダウンロードしてしまい、無駄に遅くなる。
    // @AI秘書 の直前に同じ発言者が送った画像/PDFを依頼内容として読む。
    const attachments = await loadRecentAttachments(source);

    // 「@AI秘書 お願いします」だけで直前資料も無い場合は、曖昧なタスクを
    // 作らない。対象と作業を1回で答えられる短い質問だけ返す。
    if (attachments.length === 0 && isContextlessRequest(text)) {
      await sendLineMessage(
        replyToken,
        "確認させてください。\nどの案件について、何をしてほしいでしょうか？"
      );
      continue;
    }

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
          markCommitted();
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
      // 地図リンクだけで物件を送ってくることが多い。住所を足してから解析する。
      // これが無いと物件を特定できず、毎回「どの物件ですか？」と聞く羽目になる。
      const geo = await mapContext(text).catch(() => "");
      parsed = await parseTaskFromMessage(
        (text || "（本文なし・担当者へのメンションのみ）") + geo,
        todayLabel(now),
        attachments
      );
    } catch (err) {
      // 残高切れ・認証エラーは「解析できない発言」ではなく**AI秘書の停止**。
      // 黙って捨てると、止まっていることに誰も気づかないまま依頼が消える
      // （2026-08-19〜28に営業日6日分・30件を失った経路がこれ）。
      const failure = classifyApiError(err);
      if (failure) {
        console.error(`[apihealth] ${failure} でAI秘書が停止中:`, err);

        // 依頼らしいものだけは、解析できなくてもNotionに控える。
        // 雑談まで拾うと復旧後の一覧が埋まるので、メンションか添付がある
        // ものに限る（履歴上、依頼の大半はこの形）。
        if (mentionState.mentionsBot || attachments.length > 0) {
          try {
            const head = (text || "（本文なし・添付のみ）").slice(0, 40);
            const pageId = await createNotionTask(
              {
                isTask: true,
                confidence: 1,
                title: `【未解析】${head}`,
                category: "その他",
                urgency: "今日中",
                requestType: "その他",
                urgentHint: false,
                dueDate: jstDateStr(0),
                dueTime: DEFAULT_DUE_TIME,
                assignee: null,
                memo: null,
              } as ParsedTask,
              `【AI停止中に受信】${text || "（本文なし）"}`,
              event.message.id
            );
            await setTaskStatus(pageId, STATUS_PENDING);
            await appendTaskNote(pageId, [
              `⚠️ ${jstDateStr(0)} APIが使えずAI解析できませんでした（${failure}）。`,
              `・内容を人の目で確認し、種別・担当・期日を設定してください。`,
            ]).catch(() => undefined);
            await completeMessage(event.message.id, pageId).catch(() => undefined);
          } catch (e2) {
            console.error("停止中の控え登録にも失敗:", e2);
          }
        }

        // 警告は種類ごとに1日1回。復旧まで毎回出すとグループが埋まる
        if (source.groupId && (await shouldAlert(failure))) {
          await pushLineMessage(source.groupId, alertMessage(failure)).catch(() =>
            undefined
          );
        }
        continue;
      }
      console.error("タスク解析エラー（スキップ）:", err);
      continue;
    }

    // ここまで来た＝APIは正常。次に落ちたときにまた警告を出せるようにする
    await markApiHealthy().catch(() => undefined);

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

    // 担当指定がない依頼だけ会社の分担ルールで補完する。
    // 明示メンションや本文中の担当者名は applyAutomaticAssignment 側でも上書きしない。
    const assignment = await applyAutomaticAssignment(parsed);
    parsed.assignee = assignment.assignee;
    parsed.assignmentReason = assignment.reason;

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
      // LINEはWebhookが2xxを返さないと再送する。「検索して無ければ作る」だけだと
      // 同時到達で両方がすり抜けて二重登録になるため、先に原子的に予約する。
      const claim = await reserveMessage(event.message.id);
      if (!claim.proceed) {
        if (claim.inProgress) {
          // 他が処理中。**200で握り潰さない。**処理中の側が落ちていると
          // 再送が止まり、猶予切れ後も誰も引き継がず依頼が消える。
          console.log("他インスタンスが処理中。再送を要求:", event.message.id);
          requestRetry();
        } else {
          console.log("登録済みのためスキップ:", event.message.id, claim.pageId ?? "");
        }
        continue;
      }

      // 予約に勝っても、猶予切れの引き継ぎ等で既に作られている可能性がある。
      // 作成時にメッセージIDを書いているので、ここで確実に拾える。
      //
      // 照会そのものが失敗した場合は「無かった」と決めつけない。
      // 決めつけて作ると、実際には在る場合に二重登録になる。
      let existing: { id: string } | null = null;
      try {
        existing = await findTaskByMessageId(event.message.id);
      } catch (err) {
        console.error("既存確認に失敗。作成せず再送に回す:", err);
        await releaseMessage(event.message.id).catch(() => undefined);
        requestRetry();
        continue;
      }
      if (existing) {
        await completeMessage(event.message.id, existing.id).catch(() => undefined);
        console.log("既に登録済みのためスキップ:", existing.id);
        continue;
      }

      let pageId: string;
      try {
        // メッセージIDを**作成時に**書き込む。後付けだと、応答が失われたときに
        // 「既に作られているか」を問い合わせても見つからず二重登録になる。
        pageId = await createNotionTask(parsed, rawForNotion, event.message.id);
      } catch (err) {
        // 応答が失われただけで、Notion側には出来ていることがある。
        // 確かめずに解放すると、再送で同じタスクが二重に作られる。
        let created: { id: string } | null = null;
        let lookupOk = true;
        try {
          created = await findTaskByMessageId(event.message.id);
        } catch {
          lookupOk = false;
        }
        if (created) {
          await completeMessage(event.message.id, created.id).catch(() => undefined);
          console.error("作成応答は失敗したが登録済みだった:", created.id);
          continue;
        }
        if (!lookupOk) {
          // 出来たかどうか分からない。解放すると二重登録の恐れがあるので
          // 予約は残したまま再送に回す。猶予切れ後に引き継がれて再確認される。
          console.error("作成結果を確認できず。予約を残して再送に回す:", err);
          requestRetry();
          continue;
        }
        // 照会が成功して「無い」と確認できた場合だけ解放する
        await releaseMessage(event.message.id).catch(() => undefined);
        throw err;
      }

      // ★ここから先は何が失敗しても「登録失敗」と返さない。
      // 返してしまうと手で再投稿され、同じ依頼が二重に登録される。
      // 登録済みを確定させる。以後の再送はここで止まり、二重登録にならない。
      await completeMessage(event.message.id, pageId).catch(() => undefined);
      markCommitted();
      if (parsed.assignmentReason) {
        await appendTaskNote(pageId, [
          `🤖 自動割当：${parsed.assignee ?? "未割当"}`,
          `・根拠：${parsed.assignmentReason}`,
        ]).catch((e) =>
          console.error("自動割当の根拠をNotionへ記録できませんでした:", e)
        );
      }
      await setTaskMessageIds(pageId, [event.message.id]).catch((e) =>
        console.error("メッセージIDの紐づけに失敗（登録は完了）:", e)
      );

      // 新規受付は @AI秘書 を付けた依頼だけなので、発言者を問わず不足確認を行う。
      // 通常会話には入らないため、以前のように全員の会話へ質問が挟まることはない。
      let reply: string;
      try {
        reply = await clarifyAfterCreate(
          pageId,
          parsed,
          text,
          attachments,
          source.groupId,
          source.userId
        );
      } catch (err) {
        console.error("初動確認に失敗（登録は完了）:", err);
        reply =
          `📝 「${parsed.title}」を登録しました。\n` +
          `⚠️ 条件の自動確認ができませんでした。内容をご確認ください。`;
      }

      const botMsgId = await sendLineMessage(replyToken, reply).catch((e) => {
        console.error("返信に失敗（登録は完了）:", e);
        return null;
      });
      await setTaskMessageIds(
        pageId,
        [event.message.id, botMsgId ?? ""].filter(Boolean)
      ).catch(() => undefined);
      await rememberConfirmMessage(source.groupId, pageId, botMsgId ?? null).catch(
        () => undefined
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
    } catch (err) {
      // 例外で抜けた＝処理し切れていない。完了印を付けてはいけない。
      // 付けると再送時にスキップされ、そのイベントが永久に失われる。
      console.error("イベント処理中の例外:", event.message.id, err);
      // 副作用が確定していれば再送しない（requestRetry 側で判定）
      requestRetry();
    } finally {
      if (eventRetry) {
        // 予約を解放し、再送でやり直せるようにする
        await releaseEvent(event.message.id).catch(() => undefined);
      } else {
        // 完了印。書けなかった場合は予約が「処理中」のまま残るので、
        // 猶予切れ後に引き継がれて再処理される（黙って再実行はされない）。
        // 記録に失敗すると、猶予切れ後に**確定済みの処理が再実行**される。
        // 握り潰さず数回試して、その窓をできるだけ塞ぐ。
        let recorded = false;
        for (let i = 0; i < 3 && !recorded; i++) {
          try {
            await completeEvent(event.message.id);
            recorded = true;
          } catch (e) {
            console.error(`イベント完了の記録に失敗（${i + 1}/3）:`, e);
          }
        }
        if (!recorded) {
          console.error(
            "イベント完了を記録できなかった。猶予切れ後に再処理される可能性がある:",
            event.message.id
          );
        }
      }
    }
  }

  if (needsRetry) {
    // LINEは非2xxで再送する。既に登録できたイベントは予約で二重登録を防いである。
    return NextResponse.json({ status: "retry" }, { status: 503 });
  }
  return NextResponse.json({ status: "ok" });
}
