import { google } from "googleapis";

// Gmail API でメール送信する。
// 送信元アカウント（mtnext.proposer@gmail.com）の OAuth2 リフレッシュトークンを使う。
// スコープは https://www.googleapis.com/auth/gmail.send が必要。
// calendar.ts と同じ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET を共用し、
// リフレッシュトークンだけ GMAIL_REFRESH_TOKEN（無ければ GOOGLE_REFRESH_TOKEN）で切り替える。

const SENDER = process.env.GMAIL_SENDER ?? "mtnext.proposer@gmail.com";

function getGmailClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken =
    process.env.GMAIL_REFRESH_TOKEN ?? process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Gmail送信の認証情報が未設定です（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GMAIL_REFRESH_TOKEN）"
    );
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: "v1", auth: oauth2 });
}

// 件名の非ASCII対応（RFC 2047 の =?UTF-8?B?...?= エンコード）
function encodeSubject(subject: string): string {
  return `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
}

function toBase64Url(s: string): string {
  return Buffer.from(s, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface SendEmailInput {
  to: string; // メールアドレス
  cc?: string[]; // メールアドレスの配列
  subject: string;
  body: string; // プレーンテキスト本文
}

export async function sendGmail(input: SendEmailInput): Promise<string> {
  const gmail = getGmailClient();

  const headers = [
    `From: ${SENDER}`,
    `To: ${input.to}`,
    ...(input.cc && input.cc.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    `Subject: ${encodeSubject(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];

  // 本文もbase64にして、日本語や長い行での崩れを防ぐ
  const rawMessage =
    headers.join("\r\n") +
    "\r\n\r\n" +
    Buffer.from(input.body, "utf-8").toString("base64");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: toBase64Url(rawMessage) },
  });

  return res.data.id ?? "";
}

export function getSenderAddress(): string {
  return SENDER;
}
