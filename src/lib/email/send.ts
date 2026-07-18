import nodemailer from "nodemailer";

// Gmail の「アプリパスワード」を使って SMTP でメール送信する。
// 差出人（from）は呼び出し側が明示指定できる。未指定なら既定の GMAIL_SENDER を使う。
// OAuth（Google Cloudのプロジェクト・同意画面）は不要。

const DEFAULT_SENDER = process.env.GMAIL_SENDER ?? "mdnext.proposer@gmail.com";
const DEFAULT_NAME = process.env.GMAIL_SENDER_NAME ?? "MDNEXT";

export interface SenderCredentials {
  email: string;
  password: string; // アプリパスワード
  name: string; // 表示名
}

function makeTransport(email: string, password: string) {
  const pass = (password ?? "").replace(/\s/g, "");
  if (!email || !pass) {
    throw new Error(
      "送信元の認証情報（メールアドレス／アプリパスワード）が未設定です"
    );
  }
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: email, pass },
  });
}

export interface SendEmailInput {
  to: string; // メールアドレス
  cc?: string[]; // メールアドレスの配列
  subject: string;
  body: string; // プレーンテキスト本文
  from?: SenderCredentials; // 差出人。未指定なら既定（会社アカウント）
}

export async function sendGmail(input: SendEmailInput): Promise<string> {
  const fromEmail = input.from?.email ?? DEFAULT_SENDER;
  const fromName = input.from?.name ?? DEFAULT_NAME;
  const fromPassword =
    input.from?.password ?? (process.env.GMAIL_APP_PASSWORD ?? "");

  const transport = makeTransport(fromEmail, fromPassword);
  const info = await transport.sendMail({
    from: `${fromName} <${fromEmail}>`,
    to: input.to,
    cc: input.cc && input.cc.length ? input.cc.join(", ") : undefined,
    subject: input.subject,
    text: input.body, // nodemailerがUTF-8エンコードを自動処理
  });
  return info.messageId ?? "";
}

export function getSenderAddress(): string {
  return DEFAULT_SENDER;
}
