/**
 * 画像のあとの「@下村」だけの名指しを読んで、下村さんの1対1で聞く（2026-11-22）。
 * 設計 docs/superpowers/specs/2026-11-22-photo-mention-ask-design.md。
 * - スイッチ PHOTO_MENTION_ASK=1 かつ PHOTO_MENTION_GROUP_IDS に入ったグループだけ（既定 off）。
 * - 名指しの判定は mention の userId（名前の文字では見ない）。下村さん＝TASK_SATEI_USER_IDS の先頭。
 * - この処理はグループに何も返さない（replyToken を使わない）。
 * - 画像の選び方：引用リプライなら引用された画像だけ（送り主の控えに無ければ読まない）。引用が無ければ、送り主の控えのうち
 *   発言の30分前から後の画像（新しい方から3枚まで）。
 * - 読めた・査定の依頼らしい →「〈物件名〉の査定の依頼に見えます」（確信度が低ければ「かもしれません」）＋案件が1件に絞れたら
 *   ［査定書を作る］のカード（既存の v1|sa|。自動で査定は始めない）。
 * - 読めない（引用先が無い・取れない・時間切れ）→ 黙らず「画像つきの名指しがありました。グループで確かめてください」。
 * - 査定ではない → 何もしない。
 * - 同じ画像の組では二度聞かない（画像の ID の組で SET NX・1日。画像が無ければ発言の ID）。
 * - ログは符号だけ（画像の中身・物件名・本文・ID は出さない）。
 * 本物の KV・画像・AI・案件・LINE は photo-ask-wire.ts。ここは deps を受け取るだけ。
 */
import { encodeSateiStart, sateiActive, sateiNotifyTarget } from "./satei-data";
import { parseAllowedUserIds } from "./webhook-source";
import { matchDeals, type DealRef } from "./task-record";
import { POSTBACK_TEXT_MAX, pressedText, type FlexMessage } from "./task-card";
import { GS_PHOTO_WAIT_MS, groupSateiOn, type GsMedia } from "./group-satei-data";
import { gsTicketsTakeImages } from "./group-satei-open";

export type PhotoAskEnv = Record<string, string | undefined>;

/** メンションを除いた本文がこれ以下なら「名指しだけ（短い一言）」とみなす */
export const PHOTO_ASK_TEXT_MAX = 20;
export const PHOTO_ASK_RESERVE_TTL = 24 * 60 * 60;
/** 発言より前の、この時間内に届いた画像だけを使う */
export const PHOTO_ASK_WINDOW_MS = 30 * 60 * 1000;
/** 引用の無いときに読む画像の上限（新しい方から） */
export const PHOTO_ASK_IMAGES_MAX = 3;
/** これ未満なら「査定の依頼かもしれません」（断定しない） */
export const PHOTO_ASK_SURE = 0.7;
/** これ未満は査定の依頼として扱わない */
export const PHOTO_ASK_MIN = 0.5;

export function photoAskActive(env: PhotoAskEnv = process.env): boolean {
  return env.PHOTO_MENTION_ASK === "1";
}

export function photoAskGroupIds(env: PhotoAskEnv = process.env): string[] {
  return parseAllowedUserIds(env.PHOTO_MENTION_GROUP_IDS);
}

export interface PhotoAskEvent {
  messageId: string;
  groupId?: string;
  senderId?: string;
  /** LINE の mention.mentionees（type・userId） */
  mentionees: Array<{ type: string; userId?: string }>;
  /** メンションを除いた本文 */
  text: string;
  botUserId?: string;
  /** 発言の時刻（LINE の event.timestamp。ミリ秒） */
  timestamp: number;
  /** 引用リプライの引用元 */
  quotedMessageId?: string;
}

export type PhotoAskSkip =
  | "off"
  | "group"
  | "no-target"
  | "not-mentioned"
  | "bot-mentioned"
  | "self"
  | "long-text";

/** 条件（画像の有無は deps で見る）。通れば宛先の userId、通らなければ理由 */
export function photoAskGate(
  ev: PhotoAskEvent,
  env: PhotoAskEnv = process.env,
): { ok: true; target: string } | { ok: false; reason: PhotoAskSkip } {
  if (!photoAskActive(env)) return { ok: false, reason: "off" };
  if (!ev.groupId || !photoAskGroupIds(env).includes(ev.groupId)) return { ok: false, reason: "group" };
  const target = sateiNotifyTarget(env);
  if (!target) return { ok: false, reason: "no-target" };
  const users = ev.mentionees.filter((m) => m.type === "user" && m.userId);
  if (ev.botUserId && users.some((m) => m.userId === ev.botUserId)) return { ok: false, reason: "bot-mentioned" };
  if (!users.some((m) => m.userId === target)) return { ok: false, reason: "not-mentioned" };
  if (ev.senderId === target) return { ok: false, reason: "self" };
  const t = (ev.text ?? "").replace(/[\s　]/g, "");
  if (Array.from(t).length > PHOTO_ASK_TEXT_MAX) return { ok: false, reason: "long-text" };
  return { ok: true, target };
}

/** 控えの画像（emailmedia の1件。at は控えた時刻。古い控えには無い） */
export interface PhotoAskMedia {
  messageId: string;
  kind: string;
  at?: number;
}

/**
 * 読む画像を選ぶ。引用リプライなら引用された画像だけ（控えに無ければ空＝読まない。別の画像で代わりにしない）。
 * 引用が無ければ、発言の30分前〜発言の1分後に控えた画像を新しい方から3枚まで（at の無い古い控えは使う）。
 */
export function pickPhotoAskImages(
  media: PhotoAskMedia[],
  ev: Pick<PhotoAskEvent, "timestamp" | "quotedMessageId">,
): { ids: string[]; quoted: boolean } {
  const images = media.filter((m) => m.kind === "image");
  if (ev.quotedMessageId) {
    return { ids: images.some((m) => m.messageId === ev.quotedMessageId) ? [ev.quotedMessageId] : [], quoted: true };
  }
  const inWindow = images.filter(
    (m) => m.at === undefined || (m.at >= ev.timestamp - PHOTO_ASK_WINDOW_MS && m.at <= ev.timestamp + 60_000),
  );
  return { ids: inWindow.slice(-PHOTO_ASK_IMAGES_MAX).map((m) => m.messageId), quoted: false };
}

export interface PhotoAskRead {
  isTask: boolean;
  requestType: string;
  confidence: number;
  propertyName: string | null;
  propertyKey: string | null;
}

export interface PhotoAskDeps {
  env?: PhotoAskEnv;
  /** 送り主の、このグループでの控え（画像・ファイル） */
  listMedia(groupId: string, senderId: string): Promise<PhotoAskMedia[]>;
  /** 同じ画像の組（または発言）で二度聞かない（SET NX）。取れたら true */
  reserve(key: string): Promise<boolean>;
  /** 画像を添えて既存のタスク判定で読む。1枚でも取れない・読めなければ例外（一部だけで「査定でない」と決めない） */
  read(imageIds: string[], text: string): Promise<PhotoAskRead>;
  loadDeals(): Promise<DealRef[]>;
  /** key は予約の鍵（本物は X-Line-Retry-Key に使う＝同じ知らせを二重に届けない） */
  push(to: string, text: string, card: FlexMessage | undefined, key: string): Promise<boolean>;
  log(line: string): void;
  /**
   * 段2f：以下はグループ査定へ譲るかの判定（GROUP_SATEI が on でそのグループが対象のときだけ使う。無ければ譲らない）。
   * gsEntry：同じ発言の入口 B の結果（opened のときだけ譲る）。
   * gsClaimed：送り主の「開こうとしている印」（gsatei:claim）があるか。あるあいだ待つ。
   * listGsTickets：このグループの開いている・事例待ちの受付票（gsatei:t の値。形はそのまま）。
   */
  gsEntry?: Promise<string>;
  gsClaimed?(groupId: string, senderId: string): Promise<boolean>;
  listGsTickets?(groupId: string): Promise<unknown[]>;
  /** 待つ上限の起点（webhook の開始の時刻）。無ければ呼ばれた時刻 */
  startedAt?: number;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

/** 段2f：待つのは最大45秒。webhook の開始から190秒（あとの読み取り・送信の分を残す）を超えない */
const GS_PHOTO_WEBHOOK_MS = 190_000;
const GS_CLAIM_POLL_MS = 2_000;

/** 段2f（F1・M1・M2・H1）：グループ査定へ譲るか。どちらか迷う道は譲らない（2通の側に倒す。0通を作らない） */
async function yieldToGroupSatei(ev: PhotoAskEvent, groupId: string, senderId: string, imageIds: string[], media: PhotoAskMedia[], deps: PhotoAskDeps): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = now();
  const until = Math.min(t0 + GS_PHOTO_WAIT_MS, (deps.startedAt ?? t0) + GS_PHOTO_WEBHOOK_MS);
  // 同じ発言で入口 B が受付票を開いたら譲る（開かなかった・失敗・時間切れは進める）
  if (deps.gsEntry) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const o = await Promise.race([
      deps.gsEntry.catch(() => "failed"),
      new Promise<string>((r) => { timer = setTimeout(() => r("timeout"), Math.max(0, until - now())); }),
    ]);
    clearTimeout(timer);
    if (o === "opened") return true;
  }
  if (imageIds.length === 0 || !deps.listGsTickets) return false;
  // 別の発言の入口が開こうとしているあいだは待つ（票ができるか印が消えるまで）
  if (deps.gsClaimed) {
    try {
      while (await deps.gsClaimed(groupId, senderId)) {
        if (now() + GS_CLAIM_POLL_MS > until) break;
        await sleep(GS_CLAIM_POLL_MS);
      }
    } catch {
      deps.log("[photo-ask] gs-check-failed");
    }
  }
  let tickets: unknown[];
  try {
    tickets = await deps.listGsTickets(groupId);
  } catch {
    deps.log("[photo-ask] gs-check-failed");
    return false;
  }
  const rows: GsMedia[] = imageIds.map((id) => ({ messageId: id, kind: "image", senderId, at: media.find((m) => m.messageId === id)?.at ?? ev.timestamp }));
  return gsTicketsTakeImages(tickets, rows, groupId, deps.env ?? process.env);
}

const NAME_MAX = 60;
const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");

const HEAD = "📷 業務指示のグループで、画像つきで下村さんあての名指しがありました。";

/** 読めなかったときの知らせ（黙らない） */
export const MSG_PHOTO_ASK_UNREAD = `${HEAD}\n画像を読めませんでした。LINE のグループで確かめてください。`;

export function photoAskText(o: {
  propertyName: string | null;
  sure: boolean;
  deal: DealRef | null;
  cardAttached: boolean;
  candidates?: string[];
  /** CRM が読めなかった（0件と分ける） */
  dealsFailed?: boolean;
}): string {
  const what = o.propertyName ? `「${cut(o.propertyName, NAME_MAX)}」の査定の依頼` : "査定の依頼";
  const lines = [HEAD, `${what}${o.sure ? "に見えます" : "かもしれません"}。画像は LINE のグループで確かめてください。`];
  const candidates = o.candidates ?? [];
  if (o.cardAttached) lines.push("作るときは、下のカードの［査定書を作る］を押してください（自動では始めません）。");
  else if (o.deal) lines.push("作るときは、案件カードの［査定書を作る］から押してください（自動では始めません）。");
  else if (o.dealsFailed) lines.push("CRM の案件を確かめられませんでした。案件カードの［査定書を作る］から押してください（自動では始めません）。");
  else if (candidates.length > 0) {
    lines.push(
      `CRM の案件を1件に絞れませんでした（近い案件：${candidates.slice(0, 3).map((n) => cut(n, NAME_MAX)).join("、")}）。案件カードの［査定書を作る］から押してください（自動では始めません）。`,
    );
  } else lines.push("CRM の進行中の案件に、同じ名前の案件が見つかりませんでした。案件を確かめてから［査定書を作る］を押してください。");
  return lines.join("\n");
}

/** ［査定書を作る］のカード（既存の v1|sa|<案件ID>。押せる人・確かめ方は今の査定の受付のまま） */
export function photoAskCard(deal: DealRef, propertyName: string | null): FlexMessage {
  const name = cut(deal.name, NAME_MAX);
  return {
    type: "flex",
    altText: cut(`🏢 ${name}`, 100),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: `🏢 ${name}`, weight: "bold", size: "md", wrap: true },
          // 案件名の「｜」の一部とだけ当たることがあるので、画像から読んだ物件名も並べて人が見比べられるようにする
          ...(propertyName ? [{ type: "text", text: `画像の物件：${cut(propertyName, NAME_MAX)}`, size: "sm", color: "#555555", wrap: true }] : []),
          ...(deal.phase ? [{ type: "text", text: `フェーズ：${cut(deal.phase, 30)}`, size: "sm", color: "#555555", wrap: true }] : []),
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            height: "sm",
            action: { type: "postback", label: "査定書を作る", data: encodeSateiStart(deal.id), displayText: cut(pressedText("査定書を作る", deal.name), POSTBACK_TEXT_MAX) },
          },
        ],
      },
    },
  };
}

function validRead(v: unknown): PhotoAskRead | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.isTask !== "boolean" || typeof r.requestType !== "string") return null;
  // 確信度は 0〜1 の有限の数だけ（欠けている・範囲外は読めなかった扱い＝黙って「査定でない」にしない）
  if (typeof r.confidence !== "number" || !Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1) return null;
  const confidence = r.confidence;
  const str = (x: unknown) => (typeof x === "string" && x.trim() ? x : null);
  return { isTask: r.isTask, requestType: r.requestType, confidence, propertyName: str(r.propertyName), propertyKey: str(r.propertyKey) };
}

/** メンションの無い発言ごとに呼ぶ。例外は投げない（ほかの流れを止めない）。下村さんへ送れたら true */
export async function maybeAskPhotoMention(ev: PhotoAskEvent, deps: PhotoAskDeps): Promise<boolean> {
  const env = deps.env ?? process.env;
  const gate = photoAskGate(ev, env);
  // off・別のグループ・下村さんへの名指しの無い発言（ふつうの会話）はログも出さない
  if (!gate.ok) {
    if (gate.reason !== "off" && gate.reason !== "group" && gate.reason !== "not-mentioned") deps.log(`[photo-ask] skip:${gate.reason}`);
    return false;
  }
  const groupId = ev.groupId as string;
  const senderId = ev.senderId;
  if (!senderId) {
    deps.log("[photo-ask] skip:no-sender");
    return false;
  }
  let picked: { ids: string[]; quoted: boolean };
  let media: PhotoAskMedia[];
  try {
    media = await deps.listMedia(groupId, senderId);
    picked = pickPhotoAskImages(media, ev);
  } catch {
    deps.log("[photo-ask] skip:kv-failed");
    return false;
  }
  // 引用でなく画像も無い＝ふつうの名指し。何もしない
  if (picked.ids.length === 0 && !picked.quoted) {
    deps.log("[photo-ask] skip:no-image");
    return false;
  }
  // 段2f（F1）：グループ査定が受付票を開いて、この画像も扱うなら譲る（下村さんへ2通にしない）。予約は取らない。
  // GROUP_SATEI が off・そのグループが対象外なら何も待たず読まない（今のまま）
  if (groupSateiOn(groupId, env) && (await yieldToGroupSatei(ev, groupId, senderId, picked.ids, media, deps))) {
    deps.log("[photo-ask] skip:group-satei");
    return false;
  }
  const key = picked.ids.length > 0 ? `img:${[...picked.ids].sort().join(",")}` : `msg:${ev.messageId}`;
  try {
    if (!(await deps.reserve(key))) {
      deps.log("[photo-ask] skip:duplicate");
      return false;
    }
  } catch {
    deps.log("[photo-ask] skip:kv-failed");
    return false;
  }
  const send = async (text: string, card: FlexMessage | undefined, code: string) => {
    let sent = false;
    try {
      sent = await deps.push(gate.target, text, card, key);
    } catch {
      sent = false;
    }
    deps.log(sent ? `[photo-ask] ${code}` : `[photo-ask] push-failed ${code}`);
    return sent;
  };
  // 引用先の画像が控えに無い（別の人の画像・30分より前）：別の画像で代わりにしない。読まずに知らせる
  if (picked.ids.length === 0) return send(MSG_PHOTO_ASK_UNREAD, undefined, "unread quoted-missing");
  let r: PhotoAskRead | null;
  try {
    r = validRead(await deps.read(picked.ids, ev.text));
  } catch {
    r = null;
  }
  if (!r) return send(MSG_PHOTO_ASK_UNREAD, undefined, "unread read-failed");
  if (!r.isTask || r.requestType !== "査定書" || r.confidence < PHOTO_ASK_MIN) {
    deps.log("[photo-ask] not-satei");
    return false;
  }
  let deal: DealRef | null = null;
  let candidates: string[] = [];
  let dealsFailed = false;
  try {
    const all = await deps.loadDeals();
    const m = matchDeals(r.propertyKey, all);
    // 完全一致で1件に絞れたときだけ（複数・部分一致はカードを付けない）
    if (m.dealId) deal = all.find((d) => d.id === m.dealId) ?? null;
    else candidates = m.names;
  } catch {
    // CRM が読めなくても知らせは送る（カードだけ省く）
    dealsFailed = true;
    deps.log("[photo-ask] deals-failed");
  }
  const card = deal && sateiActive(env) ? photoAskCard(deal, r.propertyName) : undefined;
  const text = photoAskText({ propertyName: r.propertyName, sure: r.confidence >= PHOTO_ASK_SURE, deal, cardAttached: Boolean(card), candidates, dealsFailed });
  return send(text, card, card ? "asked card" : "asked");
}
