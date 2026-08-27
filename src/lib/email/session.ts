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
//
// **グループ内で複数の確認を同時に持てる**必要がある。
// 以前はグループ単位で1件しか持たず、2件目の依頼が1件目を上書きしていた。
// 上書きされた側は引用リプライで指しても復元できず、要確認のまま永久に残った。
// pageId ごとに保持し、引用リプライ（Botの確認メッセージID）でも引けるようにする。
const CONFIRM_TTL_SECONDS = 60 * 60 * 24;
const CONFIRM_PREFIX = "taskconfirm";
/** 索引に載せる件数の上限。本体は独立キーなので、溢れても引用があれば引ける */
const CONFIRM_INDEX_MAX = 50;

export interface ConfirmField {
  key: string;
  label: string;
  suggest: string | null;
  critical: boolean;
}

export interface PendingTaskConfirm {
  pageId: string;
  title: string;
  requestType: string;
  /** この依頼種別の確認項目すべて（回答の解釈と、残項目の表示に使う） */
  fields: ConfirmField[];
  /** まだ指示をもらえていない項目の key */
  awaitingKeys: string[];
  /** 提案を出したが、まだ承認されていない項目の key */
  proposalKeys: string[];
  /** 確定した項目。key -> 確定値 */
  settled: Record<string, string>;
  /** 引き渡し通知に出す情報（確認が終わった時点で担当者へメンションする） */
  propertyName?: string | null;
  assignee?: string | null;
  assigneeUserId?: string | null;
  /** Botが送った確認メッセージのID。引用リプライでこの確認を特定するのに使う */
  botMessageId?: string | null;
  createdAt: number;
}

// 確認は**タスク1件ごとに独立したキー**で持つ。
// 一覧を1つの配列に入れて上限で切り捨てる作りだと、件数が増えたときに
// まだ回答待ちの確認が黙って消え、そのタスクはLINEから完了できなくなる。
// 索引（最新順の一覧）は「引用なしの返事をどれに当てるか」だけに使い、
// 索引から溢れても本体は pageId で直接引ける。
function confirmItemKey(groupId: string | undefined, pageId: string): string {
  return `${CONFIRM_PREFIX}:${groupId ?? "direct"}:${pageId}`;
}
function confirmIndexKey(groupId: string | undefined): string {
  return `${CONFIRM_PREFIX}idx:${groupId ?? "direct"}`;
}

const itemMem = new Map<string, { value: PendingTaskConfirm; expireAt: number }>();
const indexMem = new Map<string, { value: string[]; expireAt: number }>();

async function readItem(
  groupId: string | undefined,
  pageId: string
): Promise<PendingTaskConfirm | null> {
  const key = confirmItemKey(groupId, pageId);
  if (kvEnabled()) return (await kv.get<PendingTaskConfirm>(key)) ?? null;
  const hit = itemMem.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expireAt) {
    itemMem.delete(key);
    return null;
  }
  return hit.value;
}

async function readIndex(groupId: string | undefined): Promise<string[]> {
  const key = confirmIndexKey(groupId);
  if (kvEnabled()) return (await kv.get<string[]>(key)) ?? [];
  const hit = indexMem.get(key);
  if (!hit || Date.now() > hit.expireAt) return [];
  return hit.value;
}

async function writeIndex(
  groupId: string | undefined,
  ids: string[]
): Promise<void> {
  const key = confirmIndexKey(groupId);
  const trimmed = ids.slice(0, CONFIRM_INDEX_MAX);
  if (kvEnabled()) {
    await kv.set(key, trimmed, { ex: CONFIRM_TTL_SECONDS });
    return;
  }
  indexMem.set(key, {
    value: trimmed,
    expireAt: Date.now() + CONFIRM_TTL_SECONDS * 1000,
  });
}

/** 保存（同じ pageId は差し替え）。本体は独立キーなので他の確認を壊さない */
export async function savePendingTaskConfirm(
  groupId: string | undefined,
  value: PendingTaskConfirm
): Promise<void> {
  const key = confirmItemKey(groupId, value.pageId);
  if (kvEnabled()) {
    await kv.set(key, value, { ex: CONFIRM_TTL_SECONDS });
  } else {
    itemMem.set(key, {
      value,
      expireAt: Date.now() + CONFIRM_TTL_SECONDS * 1000,
    });
  }
  const idx = await readIndex(groupId);
  await writeIndex(groupId, [
    value.pageId,
    ...idx.filter((id) => id !== value.pageId),
  ]);
}

/**
 * 回答の宛先になる確認を1件返す。
 *
 * @param quotedMessageId 引用リプライの引用先
 * @param quotedPageId    引用先メッセージから引けたタスクのページID
 */
export async function getPendingTaskConfirm(
  groupId: string | undefined,
  quotedMessageId?: string | null,
  quotedPageId?: string | null
): Promise<PendingTaskConfirm | null> {
  // 引用があれば索引を通さず直接引く（索引から溢れていても復元できる）
  if (quotedPageId) return readItem(groupId, quotedPageId);

  const idx = await readIndex(groupId);
  const items: PendingTaskConfirm[] = [];
  for (const id of idx) {
    const it = await readItem(groupId, id);
    if (it) items.push(it);
  }
  if (items.length === 0) return null;

  if (quotedMessageId) {
    const byMsg = items.find((i) => i.botMessageId === quotedMessageId);
    if (byMsg) return byMsg;
  }
  return items.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

export async function countPendingTaskConfirms(
  groupId: string | undefined
): Promise<number> {
  const idx = await readIndex(groupId);
  let n = 0;
  for (const id of idx) if (await readItem(groupId, id)) n++;
  return n;
}

export async function deletePendingTaskConfirm(
  groupId: string | undefined,
  pageId: string
): Promise<void> {
  const key = confirmItemKey(groupId, pageId);
  if (kvEnabled()) await kv.del(key);
  else itemMem.delete(key);
  const idx = await readIndex(groupId);
  await writeIndex(groupId, idx.filter((id) => id !== pageId));
}

/**
 * LINEメッセージIDの**原子的な予約**。
 *
 * LINEは2xxを返さないとWebhookを再送する。「Notionを検索して無ければ作る」だけだと
 * 同時到達で両方が検索をすり抜け、同じ依頼が二重に登録される。
 * KVのNXで先に旗を立て、勝った側だけが登録する。
 *
 * KV未設定の環境では同一インスタンス内のメモリで代用する（完全ではないが、
 * 少なくとも同一プロセス内の再入は防げる）。
 *
 * @returns 予約できた（＝自分が処理すべき）なら true
 */
const seenMem = new Map<string, number>();
export async function reserveMessage(messageId: string): Promise<boolean> {
  const key = `msgseen:${messageId}`;
  const ttl = 60 * 60 * 24;
  if (kvEnabled()) {
    const res = await kv.set(key, 1, { nx: true, ex: ttl });
    return res === "OK";
  }
  const now = Date.now();
  const hit = seenMem.get(key);
  if (hit && now < hit) return false;
  seenMem.set(key, now + ttl * 1000);
  return true;
}

/** 予約を取り消す（登録に失敗したときに、再送でやり直せるようにする） */
export async function releaseMessage(messageId: string): Promise<void> {
  const key = `msgseen:${messageId}`;
  if (kvEnabled()) await kv.del(key);
  else seenMem.delete(key);
}
