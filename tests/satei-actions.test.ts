/**
 * B2 査定書：ボタン（sa・so・sr）の処理と、差し戻し理由の取り込み（satei-actions.ts）。deps はすべて差し替え。
 */
import {
  handleSateiPostback,
  handleSateiReasonText,
  type SateiActionDeps,
  type SateiReasonDeps,
} from "../src/lib/satei-actions";
import { encodeSateiDecision, parseSateiData, sateiReasonKey, type SateiAction } from "../src/lib/satei-data";
import type { SateiDeal } from "../src/lib/satei-deal";
import type { SateiCall, SateiDecideReq, SateiIntakeOk, SateiIntakeReq } from "../src/lib/satei-portal";
import * as T from "../src/lib/satei-text";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};
globalThis.fetch = (async () => {
  throw new Error("このテストで外部へ通信してはいけない");
}) as typeof fetch;

const SHIMO = "U" + "b".repeat(32);
const STAFF = "U" + "d".repeat(32);
const GROUP = "C" + "a".repeat(32);
const DB = "11112222333344445555666677778888";
const DEAL = "0123abcd0123456789ab0123456789ab";
const SHA = "e".repeat(64);
const GOOD: SateiDeal = {
  id: DEAL,
  name: "テスト案件",
  dealNo: 42,
  folderId: "1AbC_dEf-GhIjKlMnOp",
  propertyIds: ["p1"],
  gone: false,
  parentDbId: DB,
};

function mk(o: {
  deal?: SateiDeal | null;
  kind?: string | null;
  readThrows?: boolean;
  intake?: SateiCall<SateiIntakeOk>;
  decide?: SateiCall<{ status: string }>;
  proceed?: boolean;
  reserveThrows?: boolean;
  kv?: boolean;
} = {}) {
  const r = {
    replies: [] as string[],
    logs: [] as string[],
    intakes: [] as SateiIntakeReq[],
    decides: [] as Array<{ no: number; req: SateiDecideReq }>,
    kvSets: [] as Array<{ key: string; value: unknown; ex: number }>,
    reserved: [] as string[],
    completed: [] as string[],
    reads: 0,
  };
  const deps: SateiActionDeps = {
    dealsDbId: DB,
    readDeal: async () => {
      r.reads++;
      if (o.readThrows) throw new Error("notion");
      if (o.deal === null) return null;
      return { deal: o.deal ?? GOOD, kind: o.kind === undefined ? "マンション" : o.kind };
    },
    intake: async (req) => {
      r.intakes.push(req);
      return o.intake ?? { kind: "ok", value: { created: true, no: 5, status: "受付" } };
    },
    decide: async (no, req) => {
      r.decides.push({ no, req });
      return o.decide ?? { kind: "ok", value: { status: "完成" } };
    },
    kv:
      o.kv === false
        ? null
        : {
            set: async (key, value, ex) => {
              r.kvSets.push({ key, value, ex });
            },
          },
    newToken: () => "tok-new",
    reserve: async (k) => {
      r.reserved.push(k);
      if (o.reserveThrows) throw new Error("kv");
      return { proceed: o.proceed !== false };
    },
    complete: async (k) => {
      r.completed.push(k);
    },
    reply: async (_t, text) => {
      r.replies.push(text);
    },
    log: (l) => r.logs.push(l),
  };
  return { r, deps };
}
const ev = (userId: string = SHIMO, groupId?: string) => ({
  replyToken: "rt",
  webhookEventId: "01HEVENTID",
  source: { userId, groupId },
});
const SA = parseSateiData(`v1|sa|${DEAL}`) as SateiAction;
const SO = parseSateiData(encodeSateiDecision("so", 12, 3, SHA)) as SateiAction;
const SR = parseSateiData(encodeSateiDecision("sr", 12, 3, SHA)) as SateiAction;
const on = () => {
  process.env.TASK_SATEI = "1";
  process.env.TASK_SATEI_USER_IDS = SHIMO;
};
const quiet = (logs: string[]) => !logs.join("\n").includes(SHIMO) && !logs.join("\n").includes("テスト案件");

(async () => {
  // ── off の古いボタン ──
  delete process.env.TASK_SATEI;
  process.env.TASK_SATEI_USER_IDS = SHIMO;
  for (const a of [SA, SO, SR]) {
    const m = mk();
    await handleSateiPostback(a, ev(), m.deps);
    ok(
      `off：${a.op} は「いまは止めています」だけ（読まない・呼ばない・予約しない）`,
      m.r.replies.length === 1 &&
        m.r.replies[0] === T.MSG_SATEI_PAUSED &&
        m.r.reads === 0 &&
        m.r.intakes.length === 0 &&
        m.r.decides.length === 0 &&
        m.r.reserved.length === 0 &&
        m.r.kvSets.length === 0,
    );
  }

  // ── 下村さん以外 ──
  on();
  for (const a of [SA, SO, SR]) {
    const m = mk();
    await handleSateiPostback(a, ev(STAFF, GROUP), m.deps);
    ok(
      `下村さん以外：${a.op} は断る`,
      m.r.replies[0] === T.MSG_SATEI_FORBIDDEN && m.r.reads === 0 && m.r.intakes.length === 0 && m.r.decides.length === 0 && m.r.reserved.length === 0,
    );
  }
  process.env.TASK_SATEI_USER_IDS = "";
  {
    const m = mk();
    await handleSateiPostback(SA, ev(), m.deps);
    ok("押せる人の設定が空なら誰も押せない", m.r.replies[0] === T.MSG_SATEI_FORBIDDEN && m.r.intakes.length === 0);
  }
  on();

  // ── 作る（sa）──
  {
    const m = mk();
    await handleSateiPostback(SA, ev(SHIMO, GROUP), m.deps);
    ok("sa：受け付けた返事", m.r.replies[0] === T.msgSateiAccepted(5));
    ok(
      "sa：intake に契約の6項目",
      JSON.stringify(m.r.intakes[0]) ===
        JSON.stringify({ eventId: "01HEVENTID", dealId: DEAL, dealNo: 42, folderId: "1AbC_dEf-GhIjKlMnOp", dealName: "テスト案件", requestedBy: SHIMO }),
    );
    ok("sa：予約は pb:イベントID、終わったら完了印", m.r.reserved[0] === "pb:01HEVENTID" && m.r.completed[0] === "pb:01HEVENTID");
    ok("sa：返事に案件名を入れない", !m.r.replies[0].includes("テスト案件"));
    ok("sa：ログに案件名・userId を出さない", quiet(m.r.logs) && m.r.logs.includes("[satei] sa accepted"));
  }
  {
    const m = mk({ intake: { kind: "ok", value: { created: false, no: 4, status: "下準備中" } } });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：intake の created=false → 作成中です", m.r.replies[0] === T.msgSateiInProgress(4));
  }
  for (const kind of ["戸建", "土地", null]) {
    const m = mk({ kind });
    await handleSateiPostback(SA, ev(), m.deps);
    ok(`sa：種別 ${kind ?? "不明"} → マンションだけ`, m.r.replies[0] === T.MSG_SATEI_NOT_MANSION && m.r.intakes.length === 0);
  }
  {
    const m = mk({ deal: { ...GOOD, folderId: null } });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：フォルダ未設定 → 未設定です", m.r.replies[0] === T.MSG_SATEI_NO_FOLDER && m.r.intakes.length === 0);
  }
  {
    const m = mk({ deal: null });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：案件が無い → 読み取れませんでした", m.r.replies[0] === T.MSG_SATEI_DEAL_NOT_FOUND && m.r.intakes.length === 0);
  }
  {
    const m = mk({ deal: { ...GOOD, parentDbId: "99990000000000000000000000000000" } });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：CRM_案件 でないページ → 読み取れませんでした", m.r.replies[0] === T.MSG_SATEI_DEAL_NOT_FOUND && m.r.intakes.length === 0);
  }
  {
    const m = mk({ readThrows: true });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：Notion が読めない → 読み取れませんでした・完了印なし", m.r.replies[0] === T.MSG_SATEI_DEAL_NOT_FOUND && m.r.completed.length === 0);
  }
  {
    const m = mk();
    m.deps.dealsDbId = null;
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：CRM_DEALS_DB_ID 未設定 → 読み取れませんでした・Notion を読まない", m.r.replies[0] === T.MSG_SATEI_DEAL_NOT_FOUND && m.r.reads === 0);
  }
  {
    const m = mk({ intake: { kind: "rejected", status: 400, code: "BAD" } });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：intake に断られた → 受け付けられませんでした", m.r.replies[0] === T.MSG_SATEI_FAILED);
  }
  {
    const m = mk({ intake: { kind: "rejected", status: 409, code: "SATEI_AWAITING_REASON" } });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：同じ案件が差し戻しの理由待ち → 理由を待っています（契約 6-10）", m.r.replies[0] === T.MSG_SATEI_AWAITING_REASON);
  }
  {
    const m = mk({ intake: { kind: "unknown", reason: "timeout" } });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("sa：intake が分からない → 確かめられませんでした・完了印なし", m.r.replies[0] === T.MSG_SATEI_UNKNOWN && m.r.completed.length === 0);
  }
  {
    const m = mk({ proceed: false });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("二度押し（同じイベント）→ 何もしない", m.r.replies.length === 0 && m.r.reads === 0 && m.r.intakes.length === 0);
  }
  {
    const m = mk({ reserveThrows: true });
    await handleSateiPostback(SA, ev(), m.deps);
    ok("予約できない → いま受け付けられません", m.r.replies[0] === T.MSG_SATEI_BUSY && m.r.intakes.length === 0);
  }
  {
    const m = mk();
    await handleSateiPostback(SA, { replyToken: "rt", source: { userId: SHIMO } }, m.deps);
    ok("イベント ID が無い → 受け付けない", m.r.replies[0] === T.MSG_SATEI_FAILED && m.r.intakes.length === 0);
  }

  // ── OK（so）──
  {
    const m = mk();
    await handleSateiPostback(SO, ev(), m.deps);
    ok(
      "so：sha・generation を portal に渡す",
      m.r.decides[0]?.no === 12 &&
        JSON.stringify(m.r.decides[0]?.req) === JSON.stringify({ decision: "ok", by: SHIMO, artifactSha256: SHA, generation: 3 }),
    );
    ok("so：返事", m.r.replies[0] === T.msgSateiOk(12));
    ok("so：理由の印は置かない", m.r.kvSets.length === 0);
  }
  // ── 差し戻し（sr）──
  {
    const m = mk({ decide: { kind: "ok", value: { status: "差し戻し" } } });
    await handleSateiPostback(SR, ev(), m.deps);
    ok(
      "sr：decision=reject で sha・generation を渡す",
      JSON.stringify(m.r.decides[0]?.req) === JSON.stringify({ decision: "reject", by: SHIMO, artifactSha256: SHA, generation: 3 }),
    );
    ok(
      "sr：理由の印（no と一意の token）を30分置く",
      m.r.kvSets[0]?.key === sateiReasonKey(SHIMO) && JSON.stringify(m.r.kvSets[0]?.value) === JSON.stringify({ no: 12, token: "tok-new" }) && m.r.kvSets[0]?.ex === 1800,
    );
    ok("sr：理由を聞く返事", m.r.replies[0] === T.msgSateiRejectAsk(12));
  }
  {
    const m = mk({ kv: false, decide: { kind: "ok", value: { status: "差し戻し" } } });
    await handleSateiPostback(SR, ev(), m.deps);
    ok("sr：KV が無い → 差し戻しだけ伝える", m.r.replies[0] === T.msgSateiRejected(12));
  }
  // 古い［差し戻し］の押し直し（新しい webhookEventId）：portal は同じ人・同じ版なら今の状態を返す
  {
    const m = mk({ decide: { kind: "ok", value: { status: "取消" } } });
    await handleSateiPostback(SR, { ...ev(), webhookEventId: "01HEVENTNEW" }, m.deps);
    ok(
      "sr：portal が「取消」→ 印を置かない・古い下書きの文面",
      m.r.decides.length === 1 && m.r.kvSets.length === 0 && m.r.replies.length === 1 && m.r.replies[0] === T.msgSateiStale(12),
    );
    ok("sr：「取消」は済み（完了印あり）・符号 closed", m.r.completed.includes("pb:01HEVENTNEW") && m.r.logs.some((l) => l.includes("closed")));
  }
  {
    // 別案件の差し戻しの印が既にあるとき、閉じた依頼の押し直しで上書きしない
    const other = { no: 99, token: "tok-other" };
    const store = new Map<string, unknown>([[sateiReasonKey(SHIMO), other]]);
    const m = mk({ decide: { kind: "ok", value: { status: "取消" } } });
    m.deps.kv = {
      set: async (key, value) => {
        store.set(key, value);
      },
    };
    await handleSateiPostback(SR, { ...ev(), webhookEventId: "01HEVENTNEW2" }, m.deps);
    ok(
      "sr：「取消」の押し直しで別案件の印が残る",
      JSON.stringify(store.get(sateiReasonKey(SHIMO))) === JSON.stringify(other) && store.size === 1 && m.r.replies[0] === T.msgSateiStale(12),
    );
  }
  {
    const m = mk({ decide: { kind: "ok", value: { status: "差し戻し" } } });
    await handleSateiPostback(SR, { ...ev(), webhookEventId: "01HEVENTNEW3" }, m.deps);
    ok(
      "sr：portal が「差し戻し」（理由待ちのまま）→ 今までどおり印を置いて理由を聞く",
      m.r.kvSets.length === 1 && m.r.kvSets[0]?.key === sateiReasonKey(SHIMO) && m.r.replies[0] === T.msgSateiRejectAsk(12),
    );
  }
  for (const status of ["完成", "確認待ち", ""]) {
    const m = mk({ decide: { kind: "ok", value: { status } } });
    await handleSateiPostback(SR, ev(), m.deps);
    ok(
      `sr：想定外の status（${JSON.stringify(status)}）→ 印を置かない・差し戻しだけ伝える`,
      m.r.kvSets.length === 0 && m.r.replies[0] === T.msgSateiRejected(12) && m.r.completed.length === 1,
    );
  }
  {
    const m = mk({ decide: { kind: "rejected", status: 409, code: "SATEI_MISMATCH" } });
    await handleSateiPostback(SR, ev(), m.deps);
    ok("sr：409（版違い・処理済み）→ 古い下書き・印を置かない", m.r.replies[0] === T.msgSateiStale(12) && m.r.kvSets.length === 0);
  }
  {
    const m = mk({ decide: { kind: "rejected", status: 400, code: "BAD" } });
    await handleSateiPostback(SO, ev(), m.deps);
    ok("so：409 以外の断り → 受け付けられませんでした", m.r.replies[0] === T.MSG_SATEI_FAILED);
  }
  {
    const m = mk({ decide: { kind: "unknown", reason: "timeout" } });
    await handleSateiPostback(SO, ev(), m.deps);
    ok("so：分からない → 確かめられませんでした・完了印なし", m.r.replies[0] === T.MSG_SATEI_UNKNOWN && m.r.completed.length === 0);
  }

  // ── 差し戻し理由の取り込み ──
  type Mark = { no: number; token: string };
  const MA: Mark = { no: 12, token: "tok-A" };
  function mkR(
    o: {
      mark?: unknown;
      reasons?: Array<SateiCall<{ ok: true }>>;
      kv?: boolean;
      getThrows?: boolean;
      delThrows?: boolean;
      /** reason の応答待ちのあいだに起きること（別の差し戻しが印を書き換える、など） */
      during?: (store: Map<string, unknown>) => void;
    } = {},
  ) {
    const store = new Map<string, unknown>();
    if (o.mark !== undefined) store.set(sateiReasonKey(SHIMO), o.mark);
    const results = [...(o.reasons ?? [])];
    const r = {
      gets: [] as string[],
      dels: [] as Array<{ key: string; token: string }>,
      reasons: [] as Array<{ no: number; text: string }>,
      replies: [] as string[],
      logs: [] as string[],
    };
    const deps: SateiReasonDeps = {
      kv:
        o.kv === false
          ? null
          : {
              get: async (k) => {
                r.gets.push(k);
                if (o.getThrows) throw new Error("kv");
                return store.get(k) ?? null;
              },
              // 本物は Lua（GET して token が一致したら DEL）で1回に行う。ここでは同じ約束を Map で
              delIfToken: async (k, token) => {
                r.dels.push({ key: k, token });
                if (o.delThrows) throw new Error("kv");
                const v = store.get(k) as { token?: unknown } | undefined;
                if (v && v.token === token) {
                  store.delete(k);
                  return true;
                }
                return false;
              },
            },
      reason: async (no, text) => {
        r.reasons.push({ no, text });
        o.during?.(store);
        return results.shift() ?? { kind: "ok", value: { ok: true } };
      },
      reply: async (_t, text) => {
        r.replies.push(text);
      },
      log: (l) => r.logs.push(l),
    };
    return { r, deps, store };
  }
  const msg = (over: Partial<{ userId: string; groupId: string; text: string }> = {}) => ({
    userId: SHIMO,
    text: "事例が古い",
    replyToken: "rt",
    ...over,
  });

  const KEY = sateiReasonKey(SHIMO);
  delete process.env.TASK_SATEI;
  {
    const m = mkR({ mark: MA });
    ok("理由：off → 今の流れへ・KV を読まない", (await handleSateiReasonText(msg(), m.deps)) === false && m.r.gets.length === 0);
  }
  on();
  {
    const m = mkR({ mark: MA });
    ok("理由：グループの発言は横取りしない・KV を読まない", (await handleSateiReasonText(msg({ groupId: GROUP }), m.deps)) === false && m.r.gets.length === 0);
  }
  {
    const m = mkR({ mark: MA });
    ok("理由：下村さん以外の1対1は横取りしない・KV を読まない", (await handleSateiReasonText(msg({ userId: STAFF }), m.deps)) === false && m.r.gets.length === 0);
  }
  {
    const m = mkR();
    ok(
      "理由：印が無ければ今の流れへ（reason を呼ばない・返事しない・消さない）",
      (await handleSateiReasonText(msg(), m.deps)) === false && m.r.reasons.length === 0 && m.r.replies.length === 0 && m.r.dels.length === 0,
    );
  }
  {
    const m = mkR({ mark: MA });
    const first = await handleSateiReasonText(msg(), m.deps);
    ok("理由：印があれば reason に送る", first === true && JSON.stringify(m.r.reasons) === JSON.stringify([{ no: 12, text: "事例が古い" }]));
    ok("理由：成功してから、読んだ印の token を付けて消す", JSON.stringify(m.r.dels) === JSON.stringify([{ key: KEY, token: "tok-A" }]) && !m.store.has(KEY));
    ok("理由：記録しました", m.r.replies[0] === T.msgSateiReasonSaved(12));
    ok("理由：ログは J番号と結果だけ", m.r.logs.includes("[satei] reason #J12 saved") && !m.r.logs.join("").includes("事例") && !m.r.logs.join("").includes("tok-A"));
    const second = await handleSateiReasonText(msg({ text: "次の依頼" }), m.deps);
    ok("理由：次の発言は横取りしない（成功で印が消えた）", second === false && m.r.reasons.length === 1);
  }
  {
    // ③ A の reason の応答待ちのあいだに、差し戻し B が印を書き換える → A のあとも B の印が残る
    const MB: Mark = { no: 13, token: "tok-B" };
    const m = mkR({ mark: MA, during: (s) => s.set(KEY, MB) });
    await handleSateiReasonText(msg(), m.deps);
    ok("理由：A の処理中に B が印を更新すると、A のあとも B の印が残る", JSON.stringify(m.store.get(KEY)) === JSON.stringify(MB));
    ok("理由：A は自分の token でだけ消そうとする", JSON.stringify(m.r.dels) === JSON.stringify([{ key: KEY, token: "tok-A" }]));
    const next = await handleSateiReasonText(msg({ text: "B の理由" }), m.deps);
    ok("理由：次の1通は B の理由になる", next === true && m.r.reasons[1]?.no === 13 && m.r.reasons[1]?.text === "B の理由" && !m.store.has(KEY));
  }
  {
    // 契約 6-11：通信の失敗では印を残し、もう一度送ってもらう
    const m = mkR({ mark: MA, reasons: [{ kind: "unknown", reason: "network" }] });
    const first = await handleSateiReasonText(msg(), m.deps);
    ok("理由：通信失敗 → 記録できませんでした。もう一度送ってください", first === true && m.r.replies[0] === T.msgSateiReasonFailed(12));
    ok("理由：通信失敗では印が残る（消さない）", m.r.dels.length === 0 && m.store.has(KEY));
    const again = await handleSateiReasonText(msg({ text: "事例が古い（再送）" }), m.deps);
    ok(
      "理由：残った印で次の1通をもう一度受け、成功したら消す",
      again === true && m.r.reasons.length === 2 && m.r.reasons[1].text === "事例が古い（再送）" && !m.store.has(KEY) && m.r.replies[1] === T.msgSateiReasonSaved(12),
    );
  }
  for (const [label, res] of [
    ["設定不足（status 0）", { kind: "rejected", status: 0, code: "CONFIG" }],
    ["5xx", { kind: "rejected", status: 503, code: "HTTP_503" }],
    ["結果不明", { kind: "unknown", reason: "http-500" }],
  ] as Array<[string, SateiCall<{ ok: true }>]>) {
    // ④ 印を消すのは portal が実際に 4xx を返したときだけ
    const m = mkR({ mark: MA, reasons: [res] });
    const r1 = await handleSateiReasonText(msg(), m.deps);
    ok(`理由：${label}で印が残る・もう一度送ってください`, r1 === true && m.r.replies[0] === T.msgSateiReasonFailed(12) && m.r.dels.length === 0 && m.store.has(KEY));
  }
  {
    const m = mkR({ mark: MA });
    m.deps.reason = async () => {
      throw new Error("boom");
    };
    const r1 = await handleSateiReasonText(msg(), m.deps);
    ok("理由：例外で印が残る・もう一度送ってください", r1 === true && m.r.replies[0] === T.msgSateiReasonFailed(12) && m.store.has(KEY));
  }
  {
    const m = mkR({ mark: MA, reasons: [{ kind: "rejected", status: 409, code: "SATEI_STALE" }] });
    const r1 = await handleSateiReasonText(msg(), m.deps);
    ok("理由：4xx ではっきり断られた → 閉じていますと返し印を消す", r1 === true && m.r.replies[0] === T.msgSateiReasonClosed(12) && !m.store.has(KEY));
    ok("理由：断られたあとの発言は横取りしない", (await handleSateiReasonText(msg({ text: "次" }), m.deps)) === false);
  }
  {
    const m = mkR({ mark: MA, delThrows: true });
    ok("理由：成功後に印を消せなくても記録しましたと返す", (await handleSateiReasonText(msg(), m.deps)) === true && m.r.replies[0] === T.msgSateiReasonSaved(12) && m.r.logs.includes("[satei] reason clear-failed"));
  }
  {
    const m = mkR({ mark: MA });
    await handleSateiReasonText(msg({ text: "あ".repeat(250) }), m.deps);
    ok("理由：200字に切る", Array.from(m.r.reasons[0]?.text ?? "").length === 200);
  }
  {
    const m = mkR({ mark: MA });
    ok("理由：空白だけの発言は使わない・KV も読まない", (await handleSateiReasonText(msg({ text: "   " }), m.deps)) === false && m.r.gets.length === 0);
  }
  for (const bad of ["12", { no: 12 }, { no: 12, token: "" }, { no: 0, token: "t" }]) {
    const m = mkR({ mark: bad });
    ok(`理由：印の形が違えば今の流れへ（${JSON.stringify(bad)}）`, (await handleSateiReasonText(msg(), m.deps)) === false && m.r.reasons.length === 0);
  }
  {
    const m = mkR({ mark: MA, kv: false });
    ok("理由：KV が無ければ今の流れへ", (await handleSateiReasonText(msg(), m.deps)) === false);
  }
  {
    const m = mkR({ mark: MA, getThrows: true });
    ok("理由：KV が読めなければ今の流れへ", (await handleSateiReasonText(msg(), m.deps)) === false && m.r.reasons.length === 0);
  }
  delete process.env.TASK_SATEI;
  delete process.env.TASK_SATEI_USER_IDS;

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
