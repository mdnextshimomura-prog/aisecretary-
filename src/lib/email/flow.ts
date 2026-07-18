import { sendLineMessage } from "@/lib/line";
import { resolveRecipient } from "@/lib/contacts";
import {
  extractEmailRequest,
  generateEmailDraft,
  type EmailRequest,
} from "./draft";
import { sendGmail, type EmailAttachment } from "./send";
import { resolveSender, getSenderByLabel, resolveSignature } from "./accounts";
import {
  fetchLineContent,
  readContactFromContent,
  type CardContact,
} from "./card";
import { fetchLineFileBuffer } from "./attachments";
import {
  saveDraftSession,
  getDraftSession,
  deleteDraftSession,
  addPendingMedia,
  getPendingMediaList,
  clearPendingMedia,
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

// 「添付して」の意図を表す語（これが指示に含まれるときだけ直近ファイルを添付する）
const ATTACH_INTENT_RE =
  /資料|ファイル|添付|同封|書類|pdf|付けて|つけて|一緒に送|も送って|これも|それも/i;

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

  // 宛先が解決できない（台帳に無い・宛先未指定）場合のみ、直前に届いた画像/PDFを
  // 名刺として読み取り、宛先に使う（「この人に送って」等に対応）。
  // ※ここで初めてAI解析する（無関係な画像には反応しないための遅延読み取り）。
  if (!toEmail) {
    const fromCard = await resolveRecipientFromMedia(source);
    if (fromCard) {
      toName = fromCard.name;
      toEmail = fromCard.email;
    }
  }

  const ccResolved = req.cc
    .map(resolveRecipient)
    .map((r) => r.email)
    .filter((e): e is string => Boolean(e));

  // 添付は「資料/ファイル/添付/PDF」等が指示に含まれるときだけ付ける（無関係な
  // PDFを勝手に添付しない）。指示があれば直近の添付候補を使い、候補は消費する。
  const wantsAttach = ATTACH_INTENT_RE.test(text);
  let attachments = wantsAttach
    ? await getPendingAttachments(source.groupId, source.userId)
    : [];
  if (attachments.length) {
    await clearPendingAttachments(source.groupId, source.userId);
  } else {
    attachments = [];
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
    // アドレスの直書きが無ければ、直近に届いた画像/PDF（名刺）から宛先を解決してみる。
    // 「宛先は画像送ってる」「これでいける？」のような返信でも名刺が読まれるようにする。
    const fromCard = await resolveRecipientFromMedia(source);
    if (fromCard) {
      const updated: DraftSession = {
        ...session,
        toName: fromCard.name,
        toEmail: fromCard.email,
      };
      await saveDraftSession(source.groupId, source.userId, updated);
      await sendLineMessage(
        replyToken,
        `📇 名刺から宛先を設定しました。\n\n${buildPreview(updated)}`
      );
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

  // 「添付して」等 → 下書き作成後に届いたファイルを、この下書きに追加する
  if (ATTACH_INTENT_RE.test(text)) {
    const pend = await getPendingAttachments(source.groupId, source.userId);
    if (pend.length) {
      const merged = [
        ...session.attachments,
        ...pend.filter(
          (p) => !session.attachments.some((a) => a.messageId === p.messageId)
        ),
      ];
      await clearPendingAttachments(source.groupId, source.userId);
      const updated: DraftSession = { ...session, attachments: merged };
      await saveDraftSession(source.groupId, source.userId, updated);
      await sendLineMessage(
        replyToken,
        `📎 添付を追加しました。\n\n${buildPreview(updated)}`
      );
      return;
    }
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

// 直近に届いた画像/PDFのリストを名刺として読み、宛先を解決する。
// 画像を優先（名刺は画像で届くことが多い）、新しいものから最大3件まで試す。
// 物件資料PDFなど「名刺でないもの」は isBusinessCard=false で自然にスキップされる。
// 試し終えたら控えは消費する（再送されれば再登録されるので詰まらない）。
async function resolveRecipientFromMedia(
  source: MessageSource
): Promise<{ name: string; email: string } | null> {
  const list = await getPendingMediaList(source.groupId, source.userId);
  if (!list.length) return null;
  const ordered = [...list].reverse(); // 新しい順
  ordered.sort(
    (a, b) => (a.kind === "image" ? 0 : 1) - (b.kind === "image" ? 0 : 1)
  ); // 安定ソート → 画像優先・各種別の中では新しい順
  for (const m of ordered.slice(0, 3)) {
    const card = await readCardFromMedia(m.messageId);
    if (card?.email) {
      await clearPendingMedia(source.groupId, source.userId);
      return {
        name: card.name || card.company || card.email,
        email: card.email,
      };
    }
  }
  await clearPendingMedia(source.groupId, source.userId);
  return null;
}

// 画像/PDFの中身から名刺として連絡先を読み取る（保存はしない）。
// メール指示が来て宛先が未解決のときだけ呼ぶ（無関係な画像を解析しないため）。
async function readCardFromMedia(messageId: string): Promise<CardContact | null> {
  const content = await fetchLineContent(messageId);
  if (!content) return null;
  try {
    const card = await readContactFromContent(
      content.base64,
      content.contentType
    );
    if (!card.isBusinessCard) return null;
    return card;
  } catch (err) {
    console.error("名刺読み取りエラー:", err);
    return null;
  }
}

// 名刺の読み取り結果で下書きの宛先を更新し、プレビューを返信する（成功時true）
async function fillRecipientFromCard(
  messageId: string,
  source: MessageSource,
  replyToken: string,
  session: DraftSession
): Promise<boolean> {
  const card = await readCardFromMedia(messageId);
  if (!card?.email) return false;
  const updated: DraftSession = {
    ...session,
    toName: card.name || card.company || card.email,
    toEmail: card.email,
  };
  await saveDraftSession(source.groupId, source.userId, updated);
  await sendLineMessage(
    replyToken,
    `📇 名刺から宛先を設定しました。\n\n${buildPreview(updated)}`
  );
  return true;
}

// 画像を受信。
// - 下書きの宛先待ち中 → その場で名刺として読み、宛先に設定して返信する。
//   （読めなければその旨を返信。黙ったままだと「画像送ってるのに！」となるため）
// - それ以外 → 黙って「直近メディア」として控えるだけ（返信もAI解析もしない）。
export async function handleIncomingImage(
  messageId: string,
  source: MessageSource,
  replyToken: string
): Promise<void> {
  const session = await getDraftSession(source.groupId, source.userId);
  if (session && !session.toEmail) {
    const ok = await fillRecipientFromCard(messageId, source, replyToken, session);
    if (!ok) {
      await sendLineMessage(
        replyToken,
        "⚠️ 画像から宛先のメールアドレスを読み取れませんでした。鮮明な名刺画像をもう一度送るか、メールアドレスを直接返信してください。"
      );
    }
    return;
  }
  await addPendingMedia(source.groupId, source.userId, {
    messageId,
    fileName: "image",
    kind: "image",
  });
}

// ファイル(PDF等)を受信。
// - 下書きの宛先待ち中 → まず名刺PDFとして読んでみて、宛先が取れれば設定する。
// - 下書き作成中（宛先は解決済み）→ 添付候補として控え、「添付して」で追加できると案内する。
// - それ以外 → 黙って「直近メディア＋添付候補」として控えるだけ（返信しない）。
export async function handleIncomingFile(
  messageId: string,
  fileName: string,
  source: MessageSource,
  replyToken: string
): Promise<void> {
  const name = fileName || "file";
  const session = await getDraftSession(source.groupId, source.userId);
  if (session) {
    if (!session.toEmail) {
      const ok = await fillRecipientFromCard(messageId, source, replyToken, session);
      if (ok) return; // 名刺PDFとして宛先に使ったので、添付候補には入れない
    }
    await addPendingAttachment(source.groupId, source.userId, {
      messageId,
      fileName: name,
    });
    await sendLineMessage(
      replyToken,
      `📎 「${name}」を受け取りました。「添付して」と返信すると、作成中のメールに添付します。`
    );
    return;
  }
  await addPendingMedia(source.groupId, source.userId, {
    messageId,
    fileName: name,
    kind: "file",
  });
  await addPendingAttachment(source.groupId, source.userId, {
    messageId,
    fileName: name,
  });
}

// webhook から使う: 直近に画像/ファイルが届いているか（「送って」の文脈判定用）
export async function hasPendingEmailContext(
  source: MessageSource
): Promise<boolean> {
  const media = await getPendingMediaList(source.groupId, source.userId);
  if (media.length) return true;
  const atts = await getPendingAttachments(source.groupId, source.userId);
  return atts.length > 0;
}

// webhook から使う: 確認セッションの有無を返す
export { getDraftSession };
