/**
 * Webhook のイベントの振り分け（帯替えの分）を、偽物の KV・LINE・portal・予約で確かめる。
 * route.ts は dispatchObiEvents の rest だけを今までのループに渡し、needsRetry なら 503 を返す。
 *
 * 「今までの流れ」（メールの下書き・タスク等）は rest に入ったかどうかで確かめる。
 */
import { createHash } from "node:crypto";
import { dispatchObiEvents, type ObiEventDeps, type ObiLineEvent } from "../src/lib/obi/webhook-event";
import { createMemoryObiStore, recordObiPdf, type MemoryObiStore, type ObiStore } from "../src/lib/obi/memo";
import { OBI_MESSAGES } from "../src/lib/obi/intake";
import type { ObiEnv } from "../src/lib/obi/config";
import type { ReplyOutcome } from "../src/lib/line";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

const G = "C" + "a".repeat(32);
const G2 = "C" + "e".repeat(32);
const SHIMO = "U" + "b".repeat(32);
const OTHER = "U" + "c".repeat(32);
const BOT = "U" + "f".repeat(32);
const T = 1_760_000_000_000;
const env: ObiEnv = {
  LINE_GROUP_ID: G,
  JOB_ALLOWED_USER_IDS: SHIMO,
  PORTAL_BASE_URL: "https://portal.example.test",
  JOB_API_TOKEN: "tok",
};
const enc = (s: string) => new TextEncoder().encode(s);
const pdf = (s: string) => enc(`%PDF-1.7\n${s}`);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ab = (u8: Uint8Array) => {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type PortalAnswer = "accept" | "timeout" | "mismatch";

interface World {
  store: ObiStore & Partial<Pick<MemoryObiStore, "sizes">>;
  memory: MemoryObiStore;
  clock: { t: number };
  line: Record<string, Uint8Array>;
  portal: PortalAnswer[];
  portalForms: FormData[];
  replies: Array<{ token: string; text: string; timeoutMs?: number }>;
  pushes: string[];
  pushTimeouts: Array<number | undefined>;
  reserved: string[];
  completed: string[];
  released: string[];
  reserveAnswer: { proceed: boolean; inProgress?: boolean };
}

function world(): World {
  const clock = { t: T + 1000 };
  const memory = createMemoryObiStore(() => clock.t);
  return {
    store: memory,
    memory,
    clock,
    line: {},
    portal: ["accept"],
    portalForms: [],
    replies: [],
    pushes: [],
    pushTimeouts: [],
    reserved: [],
    completed: [],
    released: [],
    reserveAnswer: { proceed: true },
  };
}

async function portalAnswer(w: World, form: FormData): Promise<Response> {
  const a = w.portal.length > 1 ? w.portal.shift()! : w.portal[0];
  if (a === "timeout") throw new DOMException("timed out", "TimeoutError");
  const inputs = [];
  for (const f of form.getAll("files") as File[]) {
    const b = new Uint8Array(await f.arrayBuffer());
    inputs.push({ name: f.name, sha256: a === "mismatch" ? "0".repeat(64) : sha(b), size: b.byteLength });
  }
  return json(201, { no: 12, status: "下準備中", created: true, inputs });
}

function deps(w: World, envOver: ObiEnv = env): ObiEventDeps {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const m = u.match(/message\/(\d+)\/content$/);
    if (m) {
      const b = w.line[m[1]];
      return b ? new Response(ab(b), { status: 200 }) : new Response("x", { status: 404 });
    }
    if (u === "https://portal.example.test/api/jobs/intake") {
      w.portalForms.push(init?.body as FormData);
      return portalAnswer(w, init?.body as FormData);
    }
    throw new Error(`想定外の宛先: ${u}`);
  }) as typeof fetch;
  return {
    env: envOver,
    botUserId: BOT,
    startedAt: w.clock.t,
    store: w.store,
    events: {
      reserve: async (id) => {
        w.reserved.push(id);
        return w.reserveAnswer;
      },
      complete: async (id) => {
        w.completed.push(id);
      },
      release: async (id) => {
        w.released.push(id);
      },
    },
    fetchImpl,
    lineToken: "line-token",
    now: () => w.clock.t,
    reply: async (token: string, text: string, timeoutMs?: number): Promise<ReplyOutcome> => {
      w.replies.push({ token, text, timeoutMs });
      return { kind: "sent", messageId: "bot-1" };
    },
    push: async (to: string, text: string, timeoutMs?: number) => {
      w.pushes.push(`${to}|${text}`);
      w.pushTimeouts.push(timeoutMs);
      return true;
    },
  };
}

/** @MD NEXT秘書 へのメンションつきのテキストのイベント */
const textEvent = (
  id: string,
  body: string,
  over: { groupId?: string; userId?: string; sourceType?: string; timestamp?: number | null; mention?: boolean } = {}
): ObiLineEvent => {
  const prefix = "@MD NEXT秘書 ";
  const mention = over.mention ?? true;
  return {
    type: "message",
    replyToken: `rt-${id}`,
    timestamp: over.timestamp === null ? undefined : over.timestamp ?? T,
    source: {
      type: over.sourceType ?? "group",
      groupId: over.groupId ?? G,
      userId: over.userId ?? SHIMO,
    },
    message: {
      id,
      type: "text",
      text: mention ? prefix + body : body,
      ...(mention
        ? { mention: { mentionees: [{ index: 0, length: prefix.length - 1, type: "user" as const, userId: BOT }] } }
        : {}),
    },
  };
};
const fileEvent = (
  id: string,
  fileName: string,
  over: { groupId?: string; timestamp?: number | null } = {}
): ObiLineEvent => ({
  type: "message",
  replyToken: `rt-${id}`,
  timestamp: over.timestamp === null ? undefined : over.timestamp ?? T - 60_000,
  source: { type: "group", groupId: over.groupId ?? G, userId: OTHER },
  message: { id, type: "file", fileName, fileSize: 100 },
});

/** 営業部に PDF を1件控え、LINE の偽物に中身を置く */
async function seedPdf(w: World, id = "600000000000000002", name = "a.pdf") {
  await recordObiPdf(w.memory, G, { messageId: id, fileName: name, size: 100, timestamp: T - 60_000, userId: OTHER });
  w.line[id] = pdf(name);
}

const REQ = "600000000000000100";

async function main() {
  // ── 他のグループ：今までの流れへ（portal を呼ばない・予約もしない） ──
  {
    const w = world();
    const ev = textEvent(REQ, "帯替え 架空邸", { groupId: G2 });
    const r = await dispatchObiEvents([ev], deps(w));
    ok("他のグループの依頼の形は今までの流れへ", r.rest.length === 1 && r.rest[0] === ev && !r.needsRetry);
    ok("他のグループ：portal も返事も予約もない", w.portalForms.length === 0 && w.replies.length === 0 && w.reserved.length === 0);
  }
  {
    const w = world();
    const ev = textEvent(REQ, "帯替え 架空邸", { sourceType: "user", groupId: undefined });
    const r = await dispatchObiEvents([ev], deps(w));
    ok("個別トークは今までの流れへ", r.rest.length === 1 && w.reserved.length === 0);
  }

  // ── メールの下書きの途中でも、先頭が依頼語なら帯替え（今までの流れに渡さない） ──
  {
    const w = world();
    await seedPdf(w);
    // 今までの流れ（メールの下書き中なら handleConfirmReply が拾う）は rest に入ったものだけを見る
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w));
    ok("依頼は今までの流れに渡さない（下書きの返事として拾われない）", r.rest.length === 0 && !r.needsRetry);
    ok("依頼は portal に送り、受付の返事を reply で返す", w.portalForms.length === 1 && w.replies.length === 1 && w.replies[0].token === `rt-${REQ}` && w.replies[0].text.startsWith("#J12 受付しました"), JSON.stringify(w.replies));
    ok("依頼の予約を取り、済みにする", w.reserved.join() === REQ && w.completed.join() === REQ && w.released.length === 0);
  }
  {
    const w = world();
    const ev = textEvent(REQ, "送信");
    const r = await dispatchObiEvents([ev], deps(w));
    ok("先頭が依頼語でない発言（下書きへの「送信」）は今までの流れへ", r.rest.length === 1 && w.reserved.length === 0);
  }
  {
    const w = world();
    const ev = textEvent(REQ, "帯替え 架空邸", { mention: false });
    const r = await dispatchObiEvents([ev], deps(w));
    ok("@MD NEXT秘書 のメンションが無ければ今までの流れへ", r.rest.length === 1 && w.reserved.length === 0);
  }

  // ── 1回分に複数のイベント：順番を変えずに今までの流れへ ──
  {
    const w = world();
    w.line["600000000000000090"] = pdf("x");
    const f = fileEvent("600000000000000090", "図面.pdf");
    const req = textEvent(REQ, "帯替え 架空邸");
    const other = textEvent("600000000000000101", "明日の予定は？", { mention: false });
    const img: ObiLineEvent = { type: "message", replyToken: "rt-i", timestamp: T, source: { type: "group", groupId: G, userId: OTHER }, message: { id: "600000000000000102", type: "image" } };
    const follow: ObiLineEvent = { type: "follow", replyToken: "rt-f", timestamp: T, source: { type: "user", userId: OTHER } };
    const r = await dispatchObiEvents([f, req, other, img, follow], deps(w));
    ok("PDF・依頼以外は元の順番のまま今までの流れへ", r.rest.length === 4 && r.rest[0] === f && r.rest[1] === other && r.rest[2] === img && r.rest[3] === follow);
    ok("同じ回の先に出た PDF を控えてから依頼を扱う", w.portalForms.length === 1 && (w.portalForms[0].getAll("files") as File[])[0].name === "図面.pdf");
  }

  // ── PDF の控え ──
  {
    const w = world();
    const f = fileEvent("600000000000000003", "図面.PDF");
    const r = await dispatchObiEvents([f], deps(w));
    ok("営業部の PDF は控え、今までの流れ（handleIncomingFile）にも渡す", w.memory.sizes(G).z === 1 && r.rest[0] === f && !r.needsRetry);
    const g = fileEvent("600000000000000004", "図面.pdf", { groupId: G2 });
    await dispatchObiEvents([g], deps(w));
    ok("他のグループの PDF は控えない", w.memory.sizes(G2).z === 0);
  }
  {
    const w = world();
    const f = fileEvent("600000000000000003", "図面.pdf", { timestamp: null });
    const r = await dispatchObiEvents([f], deps(w));
    ok("イベントの時刻が無い PDF は控えない（今の時刻で代わりにしない）", w.memory.sizes(G).z === 0 && r.rest.length === 1 && !r.needsRetry);
  }
  {
    const w = world();
    w.store = {
      ...w.memory,
      addPdf: async () => {
        throw new Error("KV down");
      },
    };
    const f = fileEvent("600000000000000003", "図面.pdf");
    const r = await dispatchObiEvents([f], deps(w));
    ok("控えに失敗：今までの流れは止めずに、503 で再送を待つ", r.needsRetry && r.rest[0] === f);
  }

  // ── 依頼の時刻が無い：受付けない ──
  {
    const w = world();
    await seedPdf(w);
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸", { timestamp: null })], deps(w));
    ok("依頼の時刻が無い：portal を呼ばず、短く断る", w.portalForms.length === 0 && w.replies.map((x) => x.text).join() === OBI_MESSAGES.noTimestamp && r.rest.length === 0 && !r.needsRetry);
    ok("依頼の時刻が無い：済みにする（再送しても時刻は付かない）", w.completed.join() === REQ);
  }

  // ── 一覧が合わない：済みにしない ──
  {
    const w = world();
    await seedPdf(w);
    w.portal = ["mismatch"];
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w));
    ok("一覧が合わない：completeEvent を呼ばない", w.completed.length === 0 && w.released.join() === REQ, JSON.stringify({ c: w.completed, r: w.released }));
    ok("一覧が合わない：503 で再送を待つ", r.needsRetry);
    ok("一覧が合わない：「確かめられませんでした」だけを返す", w.replies.map((x) => x.text).join("|") === OBI_MESSAGES.unconfirmed && w.pushes.length === 0);
  }

  // ── 結果不明：再送を待つ ──
  {
    const w = world();
    await seedPdf(w);
    w.portal = ["timeout"];
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w));
    ok("結果不明：予約を外し（completeEvent を呼ばない）、503", r.needsRetry && w.completed.length === 0 && w.released.join() === REQ);
    ok("結果不明：portal は2回まで・確かめ中の返事", w.portalForms.length === 2 && w.replies.map((x) => x.text).join() === OBI_MESSAGES.pending);
  }

  // ── 受付の確定の後に、返事の印（NX）が KV の障害で置けない ──
  {
    const w = world();
    await seedPdf(w);
    w.store = {
      ...w.memory,
      setNx: async () => {
        throw new Error("KV down");
      },
    };
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w));
    ok("印が置けない：済みにする・再送させない", !r.needsRetry && w.completed.join() === REQ && w.released.length === 0);
    ok("印が置けない：返事も push も出さない", w.replies.length === 0 && w.pushes.length === 0);
  }

  // ── 受付の確定の後に返事が例外で落ちる：再送させない ──
  {
    const w = world();
    await seedPdf(w);
    const d = deps(w);
    d.reply = async () => {
      throw new Error("crash");
    };
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], d);
    ok("確定後の例外：再送させず済みにする", !r.needsRetry && w.completed.join() === REQ);
  }
  // ── 確定の前に例外：再送でやり直す ──
  {
    const w = world();
    await seedPdf(w);
    w.store = {
      ...w.memory,
      listPdfs: async () => {
        throw new Error("KV down");
      },
    };
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w));
    ok("確定前の例外：予約を外して 503", r.needsRetry && w.released.join() === REQ && w.completed.length === 0);
  }

  // ── 「担当:」は portal に渡さない ──
  {
    const w = world();
    await seedPdf(w);
    await dispatchObiEvents([textEvent(REQ, "帯替え 担当:佐藤 架空邸")], deps(w));
    const f = w.portalForms[0];
    ok("担当を書いても assigneeName は送らない・物件名は読む", !!f && f.get("assigneeName") === null && f.get("property") === "架空邸");
  }

  // ── 予約 ──
  {
    const w = world();
    w.reserveAnswer = { proceed: false };
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w));
    ok("済みの依頼の再送は何もしない（今までの流れにも渡さない）", !r.needsRetry && r.rest.length === 0 && w.portalForms.length === 0 && w.replies.length === 0);
    w.reserveAnswer = { proceed: false, inProgress: true };
    const r2 = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w));
    ok("処理中の依頼の再送は 503（処理中の側が落ちていたら引き継ぐ）", r2.needsRetry && r2.rest.length === 0);
  }

  // ── 許可リスト外 ──
  {
    const w = world();
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸", { userId: OTHER })], deps(w));
    ok("許可リスト外の人：下村さんから、とだけ返す", w.replies.map((x) => x.text).join() === OBI_MESSAGES.forbidden && w.portalForms.length === 0 && r.rest.length === 0 && w.completed.join() === REQ);
  }

  // ── 設定 ──
  {
    const w = world();
    await seedPdf(w);
    const noGroup = { ...env, LINE_GROUP_ID: undefined };
    const f = fileEvent("600000000000000003", "図面.pdf");
    const r1 = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸"), f], deps(w, noGroup));
    const r2 = await dispatchObiEvents([textEvent("600000000000000104", "帯替え 架空邸", { groupId: G2 })], deps(w, noGroup));
    ok("LINE_GROUP_ID が無い：どのグループの依頼も今までの流れへ（返事なし）", r1.rest.length === 2 && r2.rest.length === 1 && w.replies.length === 0 && w.reserved.length === 0 && w.portalForms.length === 0);
    ok("LINE_GROUP_ID が無い：PDF も控えない", w.memory.sizes(G).z === 1 /* seedPdf の1件だけ */);
  }
  {
    const w = world();
    const noToken = { ...env, JOB_API_TOKEN: undefined };
    const r1 = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w, noToken));
    ok("LINE_GROUP_ID は正しく鍵が無い：営業部の依頼の形には「止めています」", r1.rest.length === 0 && w.replies.map((x) => x.text).join() === OBI_MESSAGES.stopped && w.portalForms.length === 0 && w.completed.join() === REQ);
    const r2 = await dispatchObiEvents([textEvent("600000000000000105", "帯替え 架空邸", { groupId: G2 })], deps(w, noToken));
    ok("LINE_GROUP_ID は正しく鍵が無い：他のグループは今までの流れへ", r2.rest.length === 1 && w.replies.length === 1);
    const r3 = await dispatchObiEvents([textEvent("600000000000000106", "おはようございます")], deps(w, noToken));
    ok("LINE_GROUP_ID は正しく鍵が無い：依頼の形でない発言は今までの流れへ", r3.rest.length === 1 && w.replies.length === 1);
    await dispatchObiEvents([fileEvent("600000000000000003", "図面.pdf")], deps(w, noToken));
    ok("LINE_GROUP_ID は正しく鍵が無い：PDF は控えない", w.memory.sizes(G).z === 0);
  }


  // ── 引き継ぎの確認（T3・T5・T8 のレビューからの持ち越し） ──
  {
    // reply は 5 秒で打ち切る（replyLineMessageDetailed の既定 8 秒のままにしない）
    const w = world();
    await seedPdf(w);
    await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w));
    ok("受付の返事の reply は 5 秒で打ち切る", w.replies.length === 1 && w.replies[0].timeoutMs === 5000, JSON.stringify(w.replies.map((x) => x.timeoutMs)));
    const w2 = world();
    await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸", { userId: OTHER })], deps(w2));
    ok("断りの返事（許可リスト外）の reply も 5 秒", w2.replies.length === 1 && w2.replies[0].timeoutMs === 5000);
    const w3 = world();
    await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w3, { ...env, JOB_API_TOKEN: undefined }));
    ok("「止めています」の reply も 5 秒", w3.replies.length === 1 && w3.replies[0].timeoutMs === 5000);
  }
  {
    // reply がはっきり断られたときの push も上限つき
    const w = world();
    const d = deps(w);
    d.reply = async () => ({ kind: "rejected", status: 400 });
    await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸", { userId: OTHER })], d);
    ok("reply を断られたら push（5 秒で打ち切る）で営業部へ", w.pushes.join() === `${G}|${OBI_MESSAGES.forbidden}` && w.pushTimeouts.join() === "5000");
  }
  {
    // 確定の後に返事（say）が例外：予約は外さず・503 にせず・別の文言も出さない
    const w = world();
    await seedPdf(w);
    const d = deps(w);
    const tried: string[] = [];
    d.reply = async (_t: string, text: string) => {
      tried.push(text);
      throw new Error("crash");
    };
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], d);
    ok("確定後の返事の例外：予約を外さず、push も他の返事も出さない", !r.needsRetry && w.released.length === 0 && w.pushes.length === 0 && tried.length === 1 && tried[0].startsWith("#J12 受付しました"), JSON.stringify(tried));
  }
  {
    // 結果不明で「確かめています」の印（NX）が KV の障害で置けない：受付できなかったとは言わない
    const w = world();
    await seedPdf(w);
    w.portal = ["timeout"];
    w.store = {
      ...w.memory,
      setNx: async () => {
        throw new Error("KV down");
      },
    };
    const r = await dispatchObiEvents([textEvent(REQ, "帯替え 架空邸")], deps(w));
    ok("確かめ中の印が置けない：予約を外して 503・返事は何も出さない", r.needsRetry && w.released.join() === REQ && w.completed.length === 0 && w.replies.length === 0 && w.pushes.length === 0, JSON.stringify(w.replies));
  }
  {
    // メンションは @MD NEXT秘書 のものだけを数え、判定はメンションを除いた本文で行う
    const w = world();
    const prefix = "@佐藤 ";
    const ev: ObiLineEvent = {
      ...textEvent(REQ, "帯替え 架空邸", { mention: false }),
    };
    ev.message = { ...ev.message!, text: prefix + "帯替え 架空邸", mention: { mentionees: [{ index: 0, length: prefix.length - 1, type: "user", userId: OTHER }] } };
    const r = await dispatchObiEvents([ev], deps(w));
    ok("社員へのメンションだけなら今までの流れへ", r.rest.length === 1 && w.reserved.length === 0);
    const w2 = world();
    await seedPdf(w2);
    const r2 = await dispatchObiEvents([textEvent(REQ, "帯替え")], deps(w2));
    const f = w2.portalForms[0];
    ok("物件名が無い依頼：PDF の名前から物件名を作って送る（メンション部分は物件名にしない）", r2.rest.length === 0 && !!f && f.get("property") === "a", String(f?.get("property")));
  }
  {
    // 控えは数字の message.id だけ
    const w = world();
    const f = fileEvent("abc", "図面.pdf");
    const r = await dispatchObiEvents([f], deps(w));
    ok("数字でない message.id の PDF は控えない（今までの流れには渡す）", w.memory.sizes(G).z === 0 && r.rest[0] === f && !r.needsRetry);
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
