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

// 索引は**原子的なメンバー操作**で持つ。
// 配列をGETしてSETし直す作りだと、同時に2件保存されたときに片方の追加が消え、
// 消えた側は「引用なしの返事」で選ばれなくなる（引き渡しの索引なら再送されない）。
async function indexAdd(
  key: string,
  member: string,
  score: number,
  ttl: number
): Promise<void> {
  if (kvEnabled()) {
    await kv.zadd(key, { score, member });
    await kv.expire(key, ttl);
    return;
  }
  const cur = indexMem.get(key)?.value ?? [];
  indexMem.set(key, {
    value: [member, ...cur.filter((m) => m !== member)],
    expireAt: Date.now() + ttl * 1000,
  });
}

async function indexRemove(key: string, member: string): Promise<void> {
  if (kvEnabled()) {
    await kv.zrem(key, member);
    return;
  }
  const hit = indexMem.get(key);
  if (!hit) return;
  hit.value = hit.value.filter((m) => m !== member);
}

/** 新しい順にメンバーを返す */
async function indexList(key: string, limit: number): Promise<string[]> {
  if (kvEnabled()) {
    return (await kv.zrange<string[]>(key, 0, limit - 1, { rev: true })) ?? [];
  }
  const hit = indexMem.get(key);
  if (!hit || Date.now() > hit.expireAt) return [];
  return hit.value.slice(0, limit);
}

async function readIndex(groupId: string | undefined): Promise<string[]> {
  return indexList(confirmIndexKey(groupId), CONFIRM_INDEX_MAX);
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
  await indexAdd(
    confirmIndexKey(groupId),
    value.pageId,
    value.createdAt,
    CONFIRM_TTL_SECONDS
  );
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
    // **引用先が特定できなければ、直近に当てない。**
    // 無関係な発言を引用しただけで「直近の確認への回答」と見なされ、
    // 別依頼がそのタスクに吸い込まれて登録されなくなる。
    return items.find((i) => i.botMessageId === quotedMessageId) ?? null;
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
  await indexRemove(confirmIndexKey(groupId), pageId);
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
interface MsgClaim {
  state: "processing" | "done";
  pageId?: string;
  at: number;
}

/** 処理中とみなす猶予。これを過ぎた予約は落ちたものとして引き継ぐ */
const CLAIM_LEASE_MS = 3 * 60 * 1000;
const CLAIM_TTL_SECONDS = 60 * 60 * 24;
const claimMem = new Map<string, MsgClaim>();

async function readClaim(key: string): Promise<MsgClaim | null> {
  if (kvEnabled()) return (await kv.get<MsgClaim>(key)) ?? null;
  return claimMem.get(key) ?? null;
}
async function writeClaim(key: string, c: MsgClaim): Promise<void> {
  if (kvEnabled()) await kv.set(key, c, { ex: CLAIM_TTL_SECONDS });
  else claimMem.set(key, c);
}

export interface ReserveResult {
  /** 自分が登録処理を進めてよいか */
  proceed: boolean;
  /** 既に登録済みのページID（done のとき） */
  pageId?: string;
  /**
   * 他のインスタンスが処理中で、まだ完了していない状態か。
   *
   * これを 200 で握り潰してはいけない。処理中の側が落ちていた場合、
   * LINEは再送をやめ、猶予が切れても誰も引き継がず**依頼が永久に消える**。
   * 呼び出し側は再送されるよう非2xxを返すこと。
   */
  inProgress?: boolean;
}

/**
 * LINEメッセージIDの**原子的な予約**。
 *
 * LINEは2xxを返さないとWebhookを再送する。「Notionを検索して無ければ作る」だけだと
 * 同時到達で両方がすり抜け、同じ依頼が二重に登録される。KVのNXで旗を立てる。
 *
 * ただの24時間フラグにすると、予約直後に関数が落ちた場合に
 * **以降の再送が全部スキップされ、依頼が永久に登録されない**。
 * そのため「処理中」には猶予（lease）を持たせ、猶予切れは引き継げるようにする。
 */
export async function reserveMessage(messageId: string): Promise<ReserveResult> {
  const key = `msgclaim:${messageId}`;
  const now = Date.now();

  if (kvEnabled()) {
    const won = await kv.set(key, { state: "processing", at: now }, {
      nx: true,
      ex: CLAIM_TTL_SECONDS,
    });
    if (won === "OK") return { proceed: true };

    const cur = await readClaim(key);
    // claim が消えている＝直前に他が解放した。ここで proceed を返すと、
    // 同時に読んだ複数の呼び出しが**全員 proceed** になり二重登録になる。
    // 必ず NX を取り直し、取れた者だけが進む。
    if (!cur) {
      const retry = await kv.set(key, { state: "processing", at: now }, {
        nx: true,
        ex: CLAIM_TTL_SECONDS,
      });
      return retry === "OK" ? { proceed: true } : { proceed: false, inProgress: true };
    }
    if (cur.state === "done") return { proceed: false, pageId: cur.pageId };
    // 処理中でも猶予を過ぎていれば、落ちたものとして引き継ぐ。
    // 引き継ぎ自体を read-then-write でやると、複数インスタンスが
    // 同じ失効claimを読んで全員が引き継いでしまう。別キーのNXで1つに絞る。
    if (now - cur.at > CLAIM_LEASE_MS) {
      const lease = await kv.set(`${key}:takeover`, now, {
        nx: true,
        ex: Math.ceil(CLAIM_LEASE_MS / 1000),
      });
      if (lease !== "OK") return { proceed: false, inProgress: true };
      await writeClaim(key, { state: "processing", at: now });
      return { proceed: true };
    }
    return { proceed: false, inProgress: true };
  }

  const cur = claimMem.get(key);
  if (!cur) {
    claimMem.set(key, { state: "processing", at: now });
    return { proceed: true };
  }
  if (cur.state === "done") return { proceed: false, pageId: cur.pageId };
  if (now - cur.at > CLAIM_LEASE_MS) {
    claimMem.set(key, { state: "processing", at: now });
    return { proceed: true };
  }
  return { proceed: false, inProgress: true };
}

/** 登録完了を記録する（以後の再送はこのページIDで既登録と判断できる） */
export async function completeMessage(
  messageId: string,
  pageId: string
): Promise<void> {
  await writeClaim(`msgclaim:${messageId}`, {
    state: "done",
    pageId,
    at: Date.now(),
  });
}

/** 予約を取り消す（登録に失敗したときに、再送でやり直せるようにする） */
export async function releaseMessage(messageId: string): Promise<void> {
  const key = `msgclaim:${messageId}`;
  if (kvEnabled()) await kv.del(key);
  else claimMem.delete(key);
}

// ── 引き渡し（担当者への通知）の再送待ち ──
//
// 送信に失敗したまま確認状態を消すと、条件は固まったのに担当者へ
// 永久に伝わらない。翌朝のリマインドは期日が明日までのものしか出さないため、
// 納期の長いタスクは何日も表に出てこない。再送待ちとして別に持つ。
// 休業（お盆・年末年始）をまたぐと日次ジョブが走らない日が続く。
// 24時間で失効させると、その間に積んだ引き渡しが消えて誰にも伝わらない。
const HANDOFF_TTL_SECONDS = 60 * 60 * 24 * 30;
const HANDOFF_PREFIX = "handoffpending";

// 配列を読んで書き戻す作りだと、同時に複数の送信が失敗したときに
// 互いの追加を消してしまう（送信失敗はネットワーク障害でまとめて起きる）。
// 確認待ちと同じく、ページ単位の独立キー＋索引にする。
function handoffItemKey(groupId: string | undefined, pageId: string): string {
  return `${HANDOFF_PREFIX}:${groupId ?? "direct"}:${pageId}`;
}
function handoffIndexKey(groupId: string | undefined): string {
  return `${HANDOFF_PREFIX}idx:${groupId ?? "direct"}`;
}

const handoffItemMem = new Map<string, PendingTaskConfirm>();

export async function addPendingHandoff(
  groupId: string | undefined,
  value: PendingTaskConfirm
): Promise<void> {
  const ik = handoffItemKey(groupId, value.pageId);
  if (kvEnabled()) await kv.set(ik, value, { ex: HANDOFF_TTL_SECONDS });
  else handoffItemMem.set(ik, value);

  await indexAdd(
    handoffIndexKey(groupId),
    value.pageId,
    value.createdAt,
    HANDOFF_TTL_SECONDS
  );
}

export async function getPendingHandoffs(
  groupId: string | undefined
): Promise<PendingTaskConfirm[]> {
  const ids = await indexList(handoffIndexKey(groupId), 200);
  const out: PendingTaskConfirm[] = [];
  for (const id of ids) {
    const ik = handoffItemKey(groupId, id);
    const v = kvEnabled()
      ? await kv.get<PendingTaskConfirm>(ik)
      : handoffItemMem.get(ik);
    if (v) out.push(v);
  }
  return out;
}

export async function removePendingHandoff(
  groupId: string | undefined,
  pageId: string
): Promise<void> {
  const ik = handoffItemKey(groupId, pageId);
  if (kvEnabled()) await kv.del(ik);
  else handoffItemMem.delete(ik);

  await indexRemove(handoffIndexKey(groupId), pageId);
}

// ── LINEイベントの処理済み記録 ──
//
// バッチ内の1件でも再送が必要になると、LINEはバッチ全体を送り直す。
// 記録が無いと、既に処理し終えたイベント（確認への回答、メール送信、
// 顧客登録など）まで作り直され、二重の副作用が起きる。
// タスク登録の予約とは別に、**全メッセージイベント**に印を付ける。
const EVENT_TTL_SECONDS = 60 * 60 * 24;
const eventMem = new Map<string, number>();

export async function isEventHandled(messageId: string): Promise<boolean> {
  const key = `evt:${messageId}`;
  if (kvEnabled()) return Boolean(await kv.get(key));
  const exp = eventMem.get(key);
  if (!exp) return false;
  if (Date.now() > exp) {
    eventMem.delete(key);
    return false;
  }
  return true;
}

export async function markEventHandled(messageId: string): Promise<void> {
  const key = `evt:${messageId}`;
  if (kvEnabled()) await kv.set(key, 1, { ex: EVENT_TTL_SECONDS });
  else eventMem.set(key, Date.now() + EVENT_TTL_SECONDS * 1000);
}
