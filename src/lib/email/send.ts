import nodemailer from "nodemailer";

// Gmail の「アプリパスワード」を使って SMTP でメール送信する。
// 送信元アカウント（GMAIL_SENDER）で2段階認証を有効化し、アプリパスワードを発行して
// GMAIL_APP_PASSWORD に設定する。OAuth（Google Cloudのプロジェクト・同意画面）は不要。

const SENDER = process.env.GMAIL_SENDER ?? "mdnext.proposer@gmail.com";
const SENDER_NAME = process.env.GMAIL_SENDER_NAME ?? "MDNEXT";

function getTransport() {
  // アプリパスワードは表示時に空白入りのことがある（例: "abcd efgh ijkl mnop"）ので除去
  const pass = (process.env.GMAIL_APP_PASSWORD ?? "").replace(/\s/g, "");
  if (!pass) {
    throw new Error(
      "Gmailアプリパスワード（GMAIL_APP_PASSWORD）が未設定です"
    );
  }
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: SENDER, pass },
  });
}

export interface SendEmailInput {
  to: string; // メールアドレス
  cc?: string[]; // メールアドレスの配列
  subject: string;
  body: string; // プレーンテキスト本文
}

export async function sendGmail(input: SendEmailInput): Promise<string> {
  const transport = getTransport();
  const info = await transport.sendMail({
    from: `${SENDER_NAME} <${SENDER}>`,
    to: input.to,
    cc: input.cc && input.cc.length ? input.cc.join(", ") : undefined,
    subject: input.subject,
    text: input.body, // nodemailerがUTF-8エンコードを自動処理
  });
  return info.messageId ?? "";
}

export function getSenderAddress(): string {
  return SENDER;
}
