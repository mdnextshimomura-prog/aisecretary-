import { kv } from "@vercel/kv";

// 「下書き提示 → ユーザー確認 → 送信」の間、下書きを一時保存する。
// Serverless（Vercel）はファイルシステムが読み取り専用なのでSQLiteは使えない。
// Vercel KV（Redis）にTTL付きで保存する。KVが未設定の環境では、
// 同一インスタンス内だけ有効なメモリMapにフォールバックする（動作確認・ローカル用）。

export interface DraftSession {
  toName: string; // 宛先の表示名（未解決なら生テキスト）
  toEmail: string | null; // 解決済みメールアドレス。未解決は null（送信不可）
  // 名刺から読み取った相手の情報（本文冒頭の宛名ブロックに使う）。
  // 旧セッションには無いフィールドなので、読む側は undefined も許容すること。
  toCompany?: string | null; // 会社名（屋号があれば「会社名（屋号）」）
  toTitle?: string | null; // 役職
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

// 追加（既存リストに追記。同じメッセージIDは重複させない）。
// 複数ファイルをまとめて添付できる。
export async function addPendingAttachment(
  groupId: string | undefined,
  userId: string,
  att: PendingAttachment
): Promise<number> {
  const cur = await getPendingAttachments(groupId, userId);
  const next = [...cur.filter((a) => a.messageId !== att.messageId), att];
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

// ── 直近に届いた画像/ファイルの参照（黙って控えるだけ。メール指示時に名刺として読む） ──
// 名刺画像とPDFを続けて送るケースがあるため、1件ではなくリストで保持する
// （以前は1件のみで、後から届いたPDFが名刺画像を上書きして宛先解決に失敗していた）。
export interface PendingMedia {
  messageId: string;
  fileName: string; // ファイル名（画像はダミー可）
  kind: "image" | "file";
}

const MEDIA_PREFIX = "emailmedia";
const MEDIA_MAX = 5; // 保持する直近メディアの上限（古いものから捨てる）
const mediaMemStore = new Map<
  string,
  { value: PendingMedia[]; expireAt: number }
>();

function mediaKey(groupId: string | undefined, userId: string): string {
  return `${MEDIA_PREFIX}:${groupId ?? "direct"}:${userId}`;
}

export async function getPendingMediaList(
  groupId: string | undefined,
  userId: string
): Promise<PendingMedia[]> {
  const key = mediaKey(groupId, userId);
  if (kvEnabled()) {
    const raw = await kv.get<PendingMedia[] | PendingMedia>(key);
    if (!raw) return [];
    // 旧形式（単一オブジェクト）が残っていてもリストとして扱えるようにする
    return Array.isArray(raw) ? raw : [raw];
  }
  const hit = mediaMemStore.get(key);
  if (!hit) return [];
  if (Date.now() > hit.expireAt) {
    mediaMemStore.delete(key);
    return [];
  }
  return hit.value;
}

// 追加（既存リストに追記。上限を超えたら古いものから捨てる）
export async function addPendingMedia(
  groupId: string | undefined,
  userId: string,
  media: PendingMedia
): Promise<void> {
  const cur = await getPendingMediaList(groupId, userId);
  const next = [
    ...cur.filter((m) => m.messageId !== media.messageId),
    media,
  ].slice(-MEDIA_MAX);
  const key = mediaKey(groupId, userId);
  if (kvEnabled()) {
    await kv.set(key, next, { ex: TTL_SECONDS });
    return;
  }
  mediaMemStore.set(key, {
    value: next,
    expireAt: Date.now() + TTL_SECONDS * 1000,
  });
}

export async function clearPendingMedia(
  groupId: string | undefined,
  userId: string
): Promise<void> {
  const key = mediaKey(groupId, userId);
  if (kvEnabled()) {
    await kv.del(key);
    return;
  }
  mediaMemStore.delete(key);
}

// ── 曖昧な発言の「対応フロー選択待ち」を一時保持する ──
const CLAR_PREFIX = "clarify";
const clarMemStore = new Map<string, { value: string; expireAt: number }>();

function clarKey(groupId: string | undefined, userId: string): string {
  return `${CLAR_PREFIX}:${groupId ?? "direct"}:${userId}`;
}

export async function savePendingClarification(
  groupId: string | undefined,
  userId: string,
  originalText: string
): Promise<void> {
  const key = clarKey(groupId, userId);
  if (kvEnabled()) {
    await kv.set(key, originalText, { ex: TTL_SECONDS });
    return;
  }
  clarMemStore.set(key, {
    value: originalText,
    expireAt: Date.now() + TTL_SECONDS * 1000,
  });
}

export async function getPendingClarification(
  groupId: string | undefined,
  userId: string
): Promise<string | null> {
  const key = clarKey(groupId, userId);
  if (kvEnabled()) {
    return (await kv.get<string>(key)) ?? null;
  }
  const hit = clarMemStore.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expireAt) {
    clarMemStore.delete(key);
    return null;
  }
  return hit.value;
}

export async function deletePendingClarification(
  groupId: string | undefined,
  userId: string
): Promise<void> {
  const key = clarKey(groupId, userId);
  if (kvEnabled()) {
    await kv.del(key);
    return;
  }
  clarMemStore.delete(key);
}

// ── タスクの初動確認（clarify.ts）の「回答待ち」を保持する ──
//
// メールの下書き確認（30分）と違い、こちらは**社長が数時間後に答える**前提。
// 短いTTLだと「はい」が届く前に失効し、確認が宙に浮く。24時間持たせる。
// 失効しても引用リプライ経由（messageId → Notionページ）で辿れるため、
// これはあくまで「直後に一言で答えられる」ための近道。
const CONFIRM_TTL_SECONDS = 60 * 60 * 24;
const CONFIRM_PREFIX = "taskconfirm";

export interface PendingTaskConfirm {
  pageId: string;
  title: string;
  /** 提案のまま承認された場合にメモへ書き込む内容 */
  proposals: string[];
  /** 提案では埋まらず、指示を待っている項目 */
  awaiting: string[];
  createdAt: number;
}

const confirmMemStore = new Map<
  string,
  { value: PendingTaskConfirm; expireAt: number }
>();

function confirmKey(groupId: string | undefined): string {
  // 依頼者ではなく**グループ単位**で持つ。社長が投げた依頼に
  // 担当者が代わりに答える場面が実際にあるため、userIdで縛らない。
  return `${CONFIRM_PREFIX}:${groupId ?? "direct"}`;
}

export async function savePendingTaskConfirm(
  groupId: string | undefined,
  value: PendingTaskConfirm
): Promise<void> {
  const key = confirmKey(groupId);
  if (kvEnabled()) {
    await kv.set(key, value, { ex: CONFIRM_TTL_SECONDS });
    return;
  }
  confirmMemStore.set(key, {
    value,
    expireAt: Date.now() + CONFIRM_TTL_SECONDS * 1000,
  });
}

export async function getPendingTaskConfirm(
  groupId: string | undefined
): Promise<PendingTaskConfirm | null> {
  const key = confirmKey(groupId);
  if (kvEnabled()) {
    return (await kv.get<PendingTaskConfirm>(key)) ?? null;
  }
  const hit = confirmMemStore.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expireAt) {
    confirmMemStore.delete(key);
    return null;
  }
  return hit.value;
}

export async function deletePendingTaskConfirm(
  groupId: string | undefined
): Promise<void> {
  const key = confirmKey(groupId);
  if (kvEnabled()) {
    await kv.del(key);
    return;
  }
  confirmMemStore.delete(key);
}
