// 送信元アカウント（差出人）の管理。
// 既定の1件は既存の GMAIL_SENDER / GMAIL_APP_PASSWORD / GMAIL_SENDER_NAME から作る。
// 追加の差出人は GMAIL_ACCOUNTS（JSON）で複数登録できる。
//   例:
//   GMAIL_ACCOUNTS='{
//     "下村":{"email":"mdnext.shimomura@gmail.com","password":"xxxxxxxxxxxxxxxx","name":"MDNEXT 下村"},
//     "社長":{"email":"boss@example.com","password":"yyyyyyyyyyyyyyyy","name":"MDNEXT 山田"}
//   }'
// パスワードはそれぞれのGmailアカウントで発行したアプリパスワード（空白は自動除去）。

export interface SenderAccount {
  label: string; // 呼び出しキーワード（例: 会社 / 下村 / 社長）
  email: string;
  password: string; // アプリパスワード（空白除去済み）
  name: string; // 差出人表示名（署名にも使う）
  signature: string; // メール末尾の署名ブロック（会社名・役職氏名・住所・電話等）
}

function stripPw(s: string): string {
  return (s ?? "").replace(/\s/g, "");
}

// 既定＋追加をまとめて返す（先頭が既定＝指定なし時の送信元）。
export function loadSenderAccounts(): SenderAccount[] {
  const list: SenderAccount[] = [];

  // 既定（会社アカウント）: 既存のenvをそのまま流用
  const defEmail = process.env.GMAIL_SENDER;
  const defPass = stripPw(process.env.GMAIL_APP_PASSWORD ?? "");
  const defLabel = process.env.GMAIL_DEFAULT_LABEL ?? "会社";
  const defName = process.env.GMAIL_SENDER_NAME ?? defLabel;
  const defSig = process.env.GMAIL_DEFAULT_SIGNATURE ?? "";
  if (defEmail && defPass) {
    list.push({
      label: defLabel,
      email: defEmail,
      password: defPass,
      name: defName,
      signature: defSig,
    });
  }

  // 追加の差出人
  const raw = process.env.GMAIL_ACCOUNTS;
  if (raw) {
    try {
      const obj = JSON.parse(raw) as Record<
        string,
        { email?: string; password?: string; name?: string; signature?: string }
      >;
      for (const [label, v] of Object.entries(obj)) {
        if (v?.email && v?.password) {
          list.push({
            label,
            email: v.email,
            password: stripPw(v.password),
            name: v.name || label,
            signature: v.signature || "",
          });
        }
      }
    } catch (err) {
      console.error("GMAIL_ACCOUNTS のJSON解析に失敗:", err);
    }
  }

  return list;
}

// 差出人ヒント（キーワード or メールアドレス）から送信元を決める。
// 該当が無ければ既定（先頭）を返す。1件も無ければ null。
export function resolveSender(hint?: string): SenderAccount | null {
  const accounts = loadSenderAccounts();
  if (accounts.length === 0) return null;

  const h = (hint ?? "").trim().toLowerCase();
  if (h) {
    // 1) メールアドレス完全一致
    const byEmail = accounts.find((a) => a.email.toLowerCase() === h);
    if (byEmail) return byEmail;
    // 2) ラベル / 表示名の部分一致
    const byLabel = accounts.find((a) => {
      const lab = a.label.toLowerCase();
      const nm = a.name.toLowerCase();
      return lab.includes(h) || h.includes(lab) || nm.includes(h);
    });
    if (byLabel) return byLabel;
    // 3) メールのローカル部分に含まれる（例: "shimomura"）
    const byLocal = accounts.find((a) =>
      a.email.toLowerCase().split("@")[0].includes(h)
    );
    if (byLocal) return byLocal;
  }

  return accounts[0]; // 既定
}

// ラベル完全一致で送信元を取得（送信時に session.senderLabel から引き当てる用）。
export function getSenderByLabel(label: string): SenderAccount | null {
  const accounts = loadSenderAccounts();
  return (
    accounts.find((a) => a.label === label) ??
    accounts[0] ??
    null
  );
}

export function listSenderLabels(): string[] {
  return loadSenderAccounts().map((a) => a.label);
}
