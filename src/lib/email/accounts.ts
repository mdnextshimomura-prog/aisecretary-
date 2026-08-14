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

// 環境変数に "\n"（バックスラッシュ+n）で書かれた改行を実際の改行に直す。
// JSON.parse済みの実改行はそのまま通す（no-op）。
function normSig(s: string): string {
  return (s ?? "").replace(/\\n/g, "\n");
}

// 既定＋追加をまとめて返す（先頭が既定＝指定なし時の送信元）。
export function loadSenderAccounts(): SenderAccount[] {
  const list: SenderAccount[] = [];

  // 既定（会社アカウント）: 既存のenvをそのまま流用
  const defEmail = process.env.GMAIL_SENDER;
  const defPass = stripPw(process.env.GMAIL_APP_PASSWORD ?? "");
  const defLabel = process.env.GMAIL_DEFAULT_LABEL ?? "会社";
  const defName = process.env.GMAIL_SENDER_NAME ?? defLabel;
  const defSig = normSig(process.env.GMAIL_DEFAULT_SIGNATURE ?? "");
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
            signature: normSig(v.signature || ""),
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
    // 完全一致を最優先（ゆるい部分一致より前に判定する。
    // 例: 会社の表示名が「MDNEXT 下村」でも、"下村"はラベル完全一致の下村口座を選ぶ）
    const byEmail = accounts.find((a) => a.email.toLowerCase() === h);
    if (byEmail) return byEmail;
    const byLabelExact = accounts.find((a) => a.label.toLowerCase() === h);
    if (byLabelExact) return byLabelExact;
    const byNameExact = accounts.find((a) => a.name.toLowerCase() === h);
    if (byNameExact) return byNameExact;
    // ゆるい一致（ラベル→ローカル部→表示名の順）
    const byLabelLoose = accounts.find((a) => {
      const lab = a.label.toLowerCase();
      return lab.includes(h) || h.includes(lab);
    });
    if (byLabelLoose) return byLabelLoose;
    const byLocal = accounts.find((a) =>
      a.email.toLowerCase().split("@")[0].includes(h)
    );
    if (byLocal) return byLocal;
    const byName = accounts.find((a) => a.name.toLowerCase().includes(h));
    if (byName) return byName;
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

// ── 署名（名義）ペルソナ ──
// 送信アドレスとは別に「誰の署名で締めるか」を選べるようにする。
// 送信アカウントを持たない人（例: 会社アドレスから送る社長）は GMAIL_SIGNATURES に登録。
//   GMAIL_SIGNATURES='{"社長":{"name":"前田誠司","signature":"MD NEXT株式会社\n代表取締役 前田誠司\n..."}}'
export interface SignaturePersona {
  name: string; // 差出人表示名（From表示にも使う）
  signature: string; // 署名ブロック
}

function loadSignatures(): Record<string, SignaturePersona> {
  const out: Record<string, SignaturePersona> = {};
  const raw = process.env.GMAIL_SIGNATURES;
  if (raw) {
    try {
      const obj = JSON.parse(raw) as Record<
        string,
        { name?: string; signature?: string }
      >;
      for (const [label, v] of Object.entries(obj)) {
        if (v?.signature) {
          out[label] = { name: v.name || label, signature: normSig(v.signature) };
        }
      }
    } catch (err) {
      console.error("GMAIL_SIGNATURES のJSON解析に失敗:", err);
    }
  }
  return out;
}

// 署名ヒント（「社長名義で」「下村の署名で」等）から署名ペルソナを決める。
// 署名専用ペルソナ（GMAIL_SIGNATURES）＋各送信アカウントの署名を候補にし、
// 完全一致（ラベル→表示名）を部分一致より優先する。
export function resolveSignature(hint?: string): SignaturePersona | null {
  const h = (hint ?? "").trim().toLowerCase();
  if (!h) return null;

  const candidates: Array<{ label: string; persona: SignaturePersona }> = [];
  const sigs = loadSignatures();
  for (const [label, v] of Object.entries(sigs)) {
    candidates.push({ label, persona: v });
  }
  for (const a of loadSenderAccounts()) {
    if (a.signature) {
      candidates.push({
        label: a.label,
        persona: { name: a.name, signature: a.signature },
      });
    }
  }

  const byLabelExact = candidates.find((c) => c.label.toLowerCase() === h);
  if (byLabelExact) return byLabelExact.persona;
  const byNameExact = candidates.find(
    (c) => c.persona.name.toLowerCase() === h
  );
  if (byNameExact) return byNameExact.persona;
  const byLabelLoose = candidates.find((c) => {
    const lab = c.label.toLowerCase();
    return lab.includes(h) || h.includes(lab);
  });
  if (byLabelLoose) return byLabelLoose.persona;
  const byName = candidates.find((c) =>
    c.persona.name.toLowerCase().includes(h)
  );
  if (byName) return byName.persona;

  return null;
}
