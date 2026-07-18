import { kv } from "@vercel/kv";

// 「下書き提示 → ユーザー確認 → 送信」の間、下書きを一時保存する。
// Serverless（Vercel）はファイルシステムが読み取り専用なのでSQLiteは使えない。
// Vercel KV（Redis）にTTL付きで保存する。KVが未設定の環境では、
// 同一インスタンス内だけ有効なメモリMapにフォールバックする（動作確認・ローカル用）。

export interface DraftSession {
  toName: string; // 宛先の表示名（未解決なら生テキスト）
  toEmail: string | null; // 解決済みメールアドレス。未解決は null（送信不可）
  cc: string[]; // 解決済みCCアドレス
  subject: string;
  body: string; // 本文（署名は含まない。プレビュー・送信時に signature を連結）
  signature: string; // 差出人の署名ブロック
  // 差出人（送信元）。パスワードはKVに保存せず、送信時にlabelからenvで引き当てる。
  senderLabel: string; // 送信元アカウントのラベル（例: 会社 / 下村）
  senderEmail: string; // 送信元メールアドレス（プレビュー表示用）
  senderName: string; // 送信元表示名
  // 添付ファイル（LINEのメッセージID＋ファイル名。実体は送信時にLINEから取得）
  attachments: PendingAttachment[];
  // 再修正時に文面を作り直すための元依頼情報
  purpose: string;
  tone: string;
  subjectHint: string;
  createdAt: number;
}

// LINEで届いた添付ファイルの参照（実体は保持せず、送信時に取得）
export interface PendingAttachment {
  messageId: string;
  fileName: string;
}

const TTL_SECONDS = 60 * 30; // 30分で自動失効
const PREFIX = "emaildraft";

function keyOf(groupId: string | undefined, userId: string): string {
  return `${PREFIX}:${groupId ?? "direct"}:${userId}`;
}

// KVが使えるか（環境変数が設定されているか）
function kvEnabled(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
  );
}

// フォールバック用のインメモリストア（TTLは簡易的に期限を持たせる）
const memStore = new Map<string, { value: DraftSession; expireAt: number }>();

export async function saveDraftSession(
  groupId: string | undefined,
  userId: string,
  session: DraftSession
): Promise<void> {
  const key = keyOf(groupId, userId);
  if (kvEnabled()) {
    await kv.set(key, session, { ex: TTL_SECONDS });
    return;
  }
  memStore.set(key, {
    value: session,
    expireAt: Date.now() + TTL_SECONDS * 1000,
  });
}

export async function getDraftSession(
  groupId: string | undefined,
  userId: string
): Promise<DraftSession | null> {
  const key = keyOf(groupId, userId);
  if (kvEnabled()) {
    return (await kv.get<DraftSession>(key)) ?? null;
  }
  const hit = memStore.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expireAt) {
    memStore.delete(key);
    return null;
  }
  return hit.value;
}

export async function deleteDraftSession(
  groupId: string | undefined,
  userId: string
): Promise<void> {
  const key = keyOf(groupId, userId);
  if (kvEnabled()) {
    await kv.del(key);
    return;
  }
  memStore.delete(key);
}

// ── 名刺などから読み取った「宛先候補」を一時保持する（画像→次の指示で使う） ──
export interface PendingRecipient {
  name: string; // 氏名（会社名を含めても可）
  email: string | null;
  company: string | null;
  phone: string | null;
  createdAt: number;
}

const REC_PREFIX = "emailrecipient";
const recMemStore = new Map<
  string,
  { value: PendingRecipient; expireAt: number }
>();

function recKey(groupId: string | undefined, userId: string): string {
  return `${REC_PREFIX}:${groupId ?? "direct"}:${userId}`;
}

export async function savePendingRecipient(
  groupId: string | undefined,
  userId: string,
  recipient: PendingRecipient
): Promise<void> {
  const key = recKey(groupId, userId);
  if (kvEnabled()) {
    await kv.set(key, recipient, { ex: TTL_SECONDS });
    return;
  }
  recMemStore.set(key, {
    value: recipient,
    expireAt: Date.now() + TTL_SECONDS * 1000,
  });
}

export async function getPendingRecipient(
  groupId: string | undefined,
  userId: string
): Promise<PendingRecipient | null> {
  const key = recKey(groupId, userId);
  if (kvEnabled()) {
    return (await kv.get<PendingRecipient>(key)) ?? null;
  }
  const hit = recMemStore.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expireAt) {
    recMemStore.delete(key);
    return null;
  }
  return hit.value;
}

export async function deletePendingRecipient(
  groupId: string | undefined,
  userId: string
): Promise<void> {
  const key = recKey(groupId, userId);
  if (kvEnabled()) {
    await kv.del(key);
    return;
  }
  recMemStore.delete(key);
}

// ── LINEで届いた添付ファイル（PDF等）を、次のメール指示まで一時保持する ──
const ATT_PREFIX = "emailattach";
const attMemStore = new Map<
  string,
  { value: PendingAttachment[]; expireAt: number }
>();

function attKey(groupId: string | undefined, userId: string): string {
  return `${ATT_PREFIX}:${groupId ?? "direct"}:${userId}`;
}

export async function getPendingAttachments(
  groupId: string | undefined,
  userId: string
): Promise<PendingAttachment[]> {
  const key = attKey(groupId, userId);
  if (kvEnabled()) {
    return (await kv.get<PendingAttachment[]>(key)) ?? [];
  }
  const hit = attMemStore.get(key);
  if (!hit) return [];
  if (Date.now() > hit.expireAt) {
    attMemStore.delete(key);
    return [];
  }
  return hit.value;
}

// 追加（既存リストに追記）。複数ファイルをまとめて添付できる。
export async function addPendingAttachment(
  groupId: string | undefined,
  userId: string,
  att: PendingAttachment
): Promise<number> {
  const cur = await getPendingAttachments(groupId, userId);
  const next = [...cur, att];
  const key = attKey(groupId, userId);
  if (kvEnabled()) {
    await kv.set(key, next, { ex: TTL_SECONDS });
  } else {
    attMemStore.set(key, {
      value: next,
      expireAt: Date.now() + TTL_SECONDS * 1000,
    });
  }
  return next.length;
}

export async function clearPendingAttachments(
  groupId: string | undefined,
  userId: string
): Promise<void> {
  const key = attKey(groupId, userId);
  if (kvEnabled()) {
    await kv.del(key);
    return;
  }
  attMemStore.delete(key);
}
