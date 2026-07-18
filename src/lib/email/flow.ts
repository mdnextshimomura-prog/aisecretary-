import { sendLineMessage } from "@/lib/line";
import { resolveRecipient } from "@/lib/contacts";
import {
  extractEmailRequest,
  generateEmailDraft,
  type EmailRequest,
} from "./draft";
import { sendGmail, type EmailAttachment } from "./send";
import { resolveSender, getSenderByLabel, resolveSignature } from "./accounts";
import { fetchLineContent, readContactFromContent } from "./card";
import { fetchLineFileBuffer } from "./attachments";
import {
  saveDraftSession,
  getDraftSession,
  deleteDraftSession,
  getPendingRecipient,
  savePendingRecipient,
  deletePendingRecipient,
  getPendingAttachments,
  addPendingAttachment,
  clearPendingAttachments,
  type DraftSession,
} from "./session";

export interface MessageSource {
  userId: string;
  groupId?: string;
}

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

const CANCEL_PHRASES = [
  "キャンセル",
  "取り消",
  "取消",
  "やめ",
  "中止",
  "破棄",
  "送らない",
  "いらない",
  "不要",
];

function hitsAny(compact: string, phrases: string[]): boolean {
  const lower = compact.toLowerCase();
  return phrases.some((p) => lower.includes(p.toLowerCase()));
}

// ── 誤送信防止：確認返信が「純粋に送信の合図だけ」か判定する ──
// 少しでも修正指示や他の内容が混ざっていたら false を返し、送信ではなく
// 「修正 → 下書きを作り直して再確認」に回す。
// 例:「送信」「OK」「これで送信」→ 送信 / 「丁寧にして送って」→ 修正（送信しない）
const SEND_WORDS = [
  "送信して",
  "送信",
  "送ってください",
  "送って",
  "おくって",
  "そうしん",
  "ok",
  "おk",
  "おっけー",
  "オッケー",
  "了解です",
  "了解",
  "りょうかい",
  "お願いします",
  "おねがいします",
  "お願い",
  "おねがい",
  "はい",
  "うん",
  "よし",
  "👍",
  "🆗",
];
const SEND_FILLERS = [
  "これで",
  "それで",
  "じゃあ",
  "もう",
  "この内容で",
  "この内容",
  "以上で",
  "以上",
  "ください",
  "下さい",
  "です",
  "でお願いします",
  "でお願い",
  "で",
  "ね",
  "よ",
];

function isPureSendConfirmation(text: string): boolean {
  // 記号・空白を除去
  let s = text.toLowerCase().replace(/[\s、。，．,.！!？?〜~・「」]/g, "");
  if (!s) return false;
  for (const f of SEND_FILLERS) s = s.split(f.toLowerCase()).join("");
  // 送信語を長い順に全部除去し、送信語が1つでも有って残りが空なら「純粋な送信」
  let hadSend = false;
  for (const w of [...SEND_WORDS].sort((a, b) => b.length - a.length)) {
    const wl = w.toLowerCase();
    if (s.includes(wl)) {
      hadSend = true;
      s = s.split(wl).join("");
    }
  }
  return hadSend && s.length === 0;
}

// 署名テンプレの {name}（名前の差し込み口）に署名者名を入れる。
// 名前が空なら {name} を含む行ごと削除（空行が残らないように）。
// {name} が無いテンプレはそのまま返す。
function applyName(sig: string, name: string): string {
  if (!sig.includes("{name}")) return sig;
  if (name) return sig.replace(/\{name\}/g, name);
  return sig.replace(/^.*\{name\}.*\n?/gm, "");
}

// 本文＋署名を連結した「送信される最終テキスト」を作る
function composeFullBody(session: DraftSession): string {
  const sig = (session.signature ?? "").trim();
  return sig ? `${session.body}\n\n${sig}` : session.body;
}

// 下書きプレビューのLINEメッセージを組み立てる
function buildPreview(session: DraftSession): string {
  const fromLine = `👤 差出人：${session.senderName} <${session.senderEmail}>`;
  const toLine = session.toEmail
    ? `📮 宛先：${session.toName} <${session.toEmail}>`
    : `⚠️ 宛先：${session.toName}（メールアドレス未解決）`;
  const ccLine = session.cc.length ? `📎 CC：${session.cc.join(", ")}` : null;
  const attachLine = session.attachments.length
    ? `📎 添付：${session.attachments.map((a) => a.fileName).join(", ")}`
    : null;

  const lines = [
    "✉️ メール下書きを作成しました。内容をご確認ください。",
    "",
    fromLine,
    toLine,
    ccLine,
    attachLine,
    `件名：${session.subject}`,
    "――――――――――",
    composeFullBody(session),
    "――――――――――",
    "",
    session.toEmail
      ? "▶ 送信するには「送信」、直したい場合は修正内容を返信、やめる場合は「キャンセル」。"
      : "▶ 宛先が未解決です。メールアドレスを返信してください（例: tanaka@example.com）。修正は内容を返信、やめる場合は「キャンセル」。",
  ].filter(Boolean);

  return lines.join("\n");
}

// メール依頼を受けて、下書きを生成しLINEへ提示、確認セッションを保存する。
export async function startEmailFlow(
  text: string,
  source: MessageSource,
  replyToken: string
): Promise<void> {
  const req = await extractEmailRequest(text);

  let toName = "";
  let toEmail: string | null = null;
  const toResolved = resolveRecipient(req.to);
  toName = toResolved.name;
  toEmail = toResolved.email;

  // 宛先が解決できない（台帳に無い・宛先未指定）場合は、直前に読み取った
  // 名刺などの「宛先候補」を使う（「この人に送って」等に対応）。
  if (!toEmail) {
    const pending = await getPendingRecipient(source.groupId, source.userId);
    if (pending?.email) {
      toName = pending.name || pending.email;
      toEmail = pending.email;
      await deletePendingRecipient(source.groupId, source.userId);
    }
  }

  const ccResolved = req.cc
    .map(resolveRecipient)
    .map((r) => r.email)
    .filter((e): e is string => Boolean(e));

  // 直前にLINEで届いた添付ファイル（PDF等）があれば、このメールに付ける。
  const attachments = await getPendingAttachments(
    source.groupId,
    source.userId
  );
  if (attachments.length) {
    await clearPendingAttachments(source.groupId, source.userId);
  }

  // 送信元アドレス（アカウント）を決める。無指定なら既定＝会社。
  const sender = resolveSender(req.from);
  // 署名（名義）を決める。優先順位:
  //  1. 登録済みの署名ペルソナ/アカウント（社長・下村 等）
  //  2. 未登録の名前（例: 事務の山口）→ 送信元の署名テンプレの {name} に差し込む
  //  3. 指定なし → 送信元の署名（テンプレの {name} 行は除去）
  const hint = (req.as || req.from).trim();
  const persona = resolveSignature(hint);
  let senderName: string;
  let signature: string;
  if (persona) {
    senderName = persona.name;
    signature = applyName(persona.signature, "");
  } else if (hint) {
    senderName = hint;
    signature = applyName(sender?.signature ?? "", hint);
  } else {
    senderName = sender?.name ?? "MDNEXT";
    signature = applyName(sender?.signature ?? "", "");
  }
  signature = signature.trim() || senderName;

  const draft = await generateEmailDraft(req, senderName);

  const session: DraftSession = {
    toName,
    toEmail,
    cc: ccResolved,
    subject: draft.subject,
    body: draft.body,
    signature,
    senderLabel: sender?.label ?? "会社",
    senderEmail: sender?.email ?? "",
    senderName,
    attachments,
    purpose: req.purpose,
    tone: req.tone,
    subjectHint: req.subject_hint,
    createdAt: Date.now(),
  };

  await saveDraftSession(source.groupId, source.userId, session);
  await sendLineMessage(replyToken, buildPreview(session));
}

// 確認セッションが有るときの返信を処理する（送信 / 宛先補完 / 修正 / キャンセル）。
export async function handleConfirmReply(
  text: string,
  source: MessageSource,
  replyToken: string,
  session: DraftSession
): Promise<void> {
  const compact = text.replace(/\s/g, "");

  // キャンセル
  if (hitsAny(compact, CANCEL_PHRASES)) {
    await deleteDraftSession(source.groupId, source.userId);
    await sendLineMessage(replyToken, "🗑 メールの送信をキャンセルしました。");
    return;
  }

  // 宛先が未解決のとき、返信にメールアドレスが含まれていれば補完する
  if (!session.toEmail) {
    const m = text.match(EMAIL_RE);
    if (m) {
      const updated: DraftSession = { ...session, toEmail: m[0] };
      await saveDraftSession(source.groupId, source.userId, updated);
      await sendLineMessage(replyToken, buildPreview(updated));
      return;
    }
  }

  // 送信（「純粋に送信の合図だけ」のときのみ。修正指示が混ざっていたら送信しない）
  if (isPureSendConfirmation(text)) {
    if (!session.toEmail) {
      await sendLineMessage(
        replyToken,
        "⚠️ 宛先のメールアドレスが未解決のため送信できません。アドレスを返信してください。"
      );
      return;
    }
    try {
      // 送信時に差出人アカウントの認証情報をenvから引き当てる（パスワードはKVに置かない）
      const sender = getSenderByLabel(session.senderLabel);

      // 添付ファイルの実体を送信直前にLINEから取得する
      const attFiles: EmailAttachment[] = [];
      for (const a of session.attachments) {
        const buf = await fetchLineFileBuffer(a.messageId);
        if (buf) attFiles.push({ filename: a.fileName, content: buf });
      }
      const droppedAtt = session.attachments.length - attFiles.length;

      await sendGmail({
        to: session.toEmail,
        cc: session.cc,
        subject: session.subject,
        body: composeFullBody(session), // 本文＋署名
        from: sender
          ? { email: sender.email, password: sender.password, name: sender.name }
          : undefined,
        attachments: attFiles,
      });
      await deleteDraftSession(source.groupId, source.userId);
      const attNote = attFiles.length
        ? `\n添付：${attFiles.map((f) => f.filename).join(", ")}`
        : "";
      const dropNote =
        droppedAtt > 0
          ? `\n⚠️ ${droppedAtt}件の添付は取得できず送信できませんでした。`
          : "";
      await sendLineMessage(
        replyToken,
        `📧 送信しました。\n差出人：${session.senderName} <${session.senderEmail}>\n宛先：${session.toName} <${session.toEmail}>\n件名：${session.subject}${attNote}${dropNote}`
      );
    } catch (err) {
      console.error("メール送信エラー:", err);
      // 原因切り分け用に理由を短く添える（パスワード等の機密は含まれない）。
      const e = err as { response?: string; message?: string; code?: string };
      const reason = String(e?.response || e?.message || e?.code || "").slice(0, 180);
      const authFailed =
        /535|5\.7\.8|badcredentials|invalid login|username and password not accepted|eauth/i.test(
          reason
        );
      const hint = authFailed
        ? "\n※Gmailのアプリパスワードが、送信元アカウント（GMAIL_SENDER）本人のものと一致していない可能性が高いです。"
        : "";
      await sendLineMessage(
        replyToken,
        `⚠️ メールの送信に失敗しました。${hint}\n詳細: ${reason}`
      );
    }
    return;
  }

  // 上記以外 → 修正指示として下書きを作り直す
  const req: EmailRequest = {
    to: session.toName,
    cc: session.cc,
    subject_hint: session.subjectHint,
    purpose: session.purpose,
    tone: session.tone,
    from: session.senderLabel,
    as: "", // 修正時は署名を変えない（session.signatureを維持）
  };
  try {
    const draft = await generateEmailDraft(req, session.senderName, text, {
      subject: session.subject,
      body: session.body,
    });
    const updated: DraftSession = {
      ...session,
      subject: draft.subject,
      body: draft.body,
    };
    await saveDraftSession(source.groupId, source.userId, updated);
    await sendLineMessage(replyToken, buildPreview(updated));
  } catch (err) {
    console.error("下書き修正エラー:", err);
    await sendLineMessage(
      replyToken,
      "⚠️ 下書きの修正に失敗しました。もう一度指示してください。"
    );
  }
}

// 名刺情報を「宛先候補」として保存する共通処理。読めた名刺（or null）を返す。
async function tryReadAndSaveCard(
  messageId: string,
  source: MessageSource
): Promise<{
  isBusinessCard: boolean;
  name: string;
  company: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
} | null> {
  const content = await fetchLineContent(messageId);
  if (!content) return null;
  let card;
  try {
    card = await readContactFromContent(content.base64, content.contentType);
  } catch (err) {
    console.error("名刺読み取りエラー:", err);
    return null;
  }
  if (!card.isBusinessCard || (!card.email && !card.name)) return null;

  await savePendingRecipient(source.groupId, source.userId, {
    name: card.name || card.company || "（氏名不明）",
    email: card.email,
    company: card.company,
    phone: card.phone,
    createdAt: Date.now(),
  });
  return card;
}

function cardSummaryLines(card: {
  name: string;
  title: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
}): string[] {
  return [
    card.name ? `氏名：${card.name}` : null,
    card.title ? `役職：${card.title}` : null,
    card.company ? `会社：${card.company}` : null,
    card.email ? `メール：${card.email}` : "メール：（読み取れず）",
    card.phone ? `電話：${card.phone}` : null,
  ].filter((l): l is string => Boolean(l));
}

// 画像（名刺）を受け取り、連絡先を読み取って「宛先候補」として保存する。
// この後の「この人にメール送って」等で、その連絡先が宛先に使われる。
export async function handleBusinessCard(
  messageId: string,
  source: MessageSource,
  replyToken: string
): Promise<void> {
  const card = await tryReadAndSaveCard(messageId, source);
  if (!card) {
    // 連絡先が読み取れない画像は黙ってスキップ（雑談画像などを誤爆させない）
    return;
  }
  const lines = [
    "📇 名刺を読み取りました。",
    ...cardSummaryLines(card),
    "",
    card.email
      ? "▶ この方にメールするなら、続けて用件を送ってください（例:「この人に内見のお礼メール送って」）。"
      : "▶ メールアドレスが読み取れませんでした。アドレスが写るように撮り直すか、宛先を文字で教えてください。",
  ];
  await sendLineMessage(replyToken, lines.join("\n"));
}

// LINEで届いたファイル（PDF等）を「添付候補」として一時保持する。
// さらに、そのファイルが名刺なら連絡先も読み取って「宛先候補」にする
// （PDF名刺で「この人に送って」に対応。用件で相手を指定すれば添付として扱われる）。
export async function handleFileAttachment(
  messageId: string,
  fileName: string,
  source: MessageSource,
  replyToken: string
): Promise<void> {
  const name = fileName || "file";
  const count = await addPendingAttachment(source.groupId, source.userId, {
    messageId,
    fileName: name,
  });

  // PDF等が名刺なら宛先候補としても読み取る
  const isPdf = /\.pdf$/i.test(name);
  const card = isPdf ? await tryReadAndSaveCard(messageId, source) : null;

  const lines = [
    `📎 ファイル「${name}」を受け取りました（添付候補 ${count}件）。`,
  ];
  if (card && card.email) {
    lines.push("", "📇 このファイルは名刺として連絡先も読み取りました。");
    lines.push(...cardSummaryLines(card));
    lines.push(
      "",
      "▶「この人に送って」→ この相手にメール（名刺の宛先）",
      "▶「この資料を〇〇さんに送って」→ 〇〇さん宛にこのPDFを添付"
    );
  } else {
    lines.push(
      "▶ メールに添付するなら、続けて用件を送ってください（例:「この資料を田中さんに送って」）。"
    );
  }

  await sendLineMessage(replyToken, lines.join("\n"));
}

// webhook から使う: 確認セッションの有無を返す
export { getDraftSession };
