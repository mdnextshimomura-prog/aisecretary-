import { sendLineMessage } from "@/lib/line";
import { resolveRecipient } from "@/lib/contacts";
import {
  extractEmailRequest,
  generateEmailDraft,
  type EmailRequest,
} from "./draft";
import { sendGmail } from "./send";
import { resolveSender, getSenderByLabel } from "./accounts";
import { fetchLineImage, readBusinessCard } from "./card";
import {
  saveDraftSession,
  getDraftSession,
  deleteDraftSession,
  getPendingRecipient,
  savePendingRecipient,
  deletePendingRecipient,
  type DraftSession,
} from "./session";

export interface MessageSource {
  userId: string;
  groupId?: string;
}

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

// 確認セッション中の「送信」意図。空白除去後に部分一致で判定（既存 isCancelIntent と同方式）。
const SEND_PHRASES = [
  "送信",
  "送って",
  "おくって",
  "これで送",
  "これでok",
  "これでOK",
  "これでいい",
  "オッケー",
  "おっけー",
  "おk",
  "ok",
  "了解",
  "お願いします",
  "お願い",
];
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

  const lines = [
    "✉️ メール下書きを作成しました。内容をご確認ください。",
    "",
    fromLine,
    toLine,
    ccLine,
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

  // 差出人を決める（「自分から」「社長名義で」等。無指定なら既定＝会社）
  const sender = resolveSender(req.from);
  const senderName = sender?.name ?? "MDNEXT";
  // 署名は差出人アカウントのもの。未設定なら最低限「表示名」を署名にする。
  const signature = (sender?.signature ?? "").trim() || senderName;

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

  // 送信
  if (hitsAny(compact, SEND_PHRASES)) {
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
      await sendGmail({
        to: session.toEmail,
        cc: session.cc,
        subject: session.subject,
        body: composeFullBody(session), // 本文＋署名
        from: sender
          ? { email: sender.email, password: sender.password, name: sender.name }
          : undefined,
      });
      await deleteDraftSession(source.groupId, source.userId);
      await sendLineMessage(
        replyToken,
        `📧 送信しました。\n差出人：${session.senderName} <${session.senderEmail}>\n宛先：${session.toName} <${session.toEmail}>\n件名：${session.subject}`
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

// 画像（名刺）を受け取り、連絡先を読み取って「宛先候補」として保存する。
// この後の「この人にメール送って」等で、その連絡先が宛先に使われる。
export async function handleBusinessCard(
  messageId: string,
  source: MessageSource,
  replyToken: string
): Promise<void> {
  const img = await fetchLineImage(messageId);
  if (!img) {
    await sendLineMessage(
      replyToken,
      "⚠️ 画像を取得できませんでした。もう一度送ってみてください。"
    );
    return;
  }

  let card;
  try {
    card = await readBusinessCard(img.base64, img.mediaType);
  } catch (err) {
    console.error("名刺読み取りエラー:", err);
    await sendLineMessage(
      replyToken,
      "⚠️ 画像の読み取りに失敗しました。文字がはっきり写るように撮り直してみてください。"
    );
    return;
  }

  if (!card.isBusinessCard || (!card.email && !card.name)) {
    // 連絡先が読み取れない画像は黙ってスキップ（雑談画像などを誤爆させない）
    return;
  }

  await savePendingRecipient(source.groupId, source.userId, {
    name: card.name || card.company || "（氏名不明）",
    email: card.email,
    company: card.company,
    phone: card.phone,
    createdAt: Date.now(),
  });

  const lines = [
    "📇 名刺を読み取りました。",
    card.name ? `氏名：${card.name}` : null,
    card.title ? `役職：${card.title}` : null,
    card.company ? `会社：${card.company}` : null,
    card.email ? `メール：${card.email}` : "メール：（読み取れず）",
    card.phone ? `電話：${card.phone}` : null,
    "",
    card.email
      ? "▶ この方にメールするなら、続けて用件を送ってください（例:「この人に内見のお礼メール送って」）。"
      : "▶ メールアドレスが読み取れませんでした。アドレスが写るように撮り直すか、宛先を文字で教えてください。",
  ].filter(Boolean);

  await sendLineMessage(replyToken, lines.join("\n"));
}

// webhook から使う: 確認セッションの有無を返す
export { getDraftSession };
