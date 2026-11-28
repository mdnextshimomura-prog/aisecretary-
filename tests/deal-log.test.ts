/** 案件ページに LINE の動きを溜める（DEAL_LOG）：ひも付けの決め方・控え・行の形・書き出し・失敗のとき */
import assert from "node:assert/strict";
import {
  DL_FLUSH_GUARD_SEC, DL_HEADING, DL_Q, DL_ROW_TTL_MS, captureDealLog, dealLogOn, dlHeadKey, dlLastKey, dlMsgKey,
  flushDealLog, formatDlRow, matchDealsInText, richChunks,
  type DlCaptureDeps, type DlEvent, type DlFlushDeps, type DlRow,
} from "../src/lib/deal-log";

let n = 0;
const t = async (name: string, f: () => Promise<void> | void) => { await f(); n++; console.log("ok", name); };
globalThis.fetch = (async () => { throw new Error("外へ出てはいけない"); }) as typeof fetch;

const G = "C" + "a".repeat(32);
const U1 = "U" + "b".repeat(32);
const U2 = "U" + "c".repeat(32);
const BOT = "U" + "f".repeat(32);
const D1 = "11111111-1111-1111-1111-111111111111";
const D2 = "22222222-2222-2222-2222-222222222222";
const D3 = "33333333-3333-3333-3333-333333333333";
const NOW = Date.UTC(2026, 10, 28, 7, 40); // JST 11/28 16:40
const deals = [
  { id: D1, name: "天満ハイツ302｜売り" },
  { id: D2, name: "ジオ北浜1205｜山田様｜買い" },
  { id: D3, name: "吹田市山手町四丁目" },
];

/** 本物の Lua と同じ動きをする偽の KV（呼び出しを ops に控える） */
function mkKv() {
  const vals = new Map<string, unknown>();
  const lists = new Map<string, unknown[]>();
  const ops: string[] = [];
  let failSettle = false;
  return {
    vals, lists, ops,
    setFailSettle: (v: boolean) => { failSettle = v; },
    kv: {
      get: async (key: string) => { ops.push(`get ${key}`); return vals.get(key) ?? null; },
      set: async (key: string, value: unknown, _ex: number) => { ops.push(`set ${key}`); vals.set(key, value); },
      setNx: async (key: string, value: unknown, _ex: number) => {
        ops.push(`setNx ${key}`);
        if (vals.has(key)) return false;
        vals.set(key, value);
        return true;
      },
      commit: async (c: { msgKey: string; lastKey: string | null; row: DlRow; last: unknown }) => {
        ops.push(`commit ${c.msgKey}`);
        if (vals.has(c.msgKey)) return false;
        vals.set(c.msgKey, c.row.dealId);
        lists.set(DL_Q, [...(lists.get(DL_Q) ?? []), c.row]);
        if (c.lastKey && c.last) vals.set(c.lastKey, c.last);
        return true;
      },
      peek: async (count: number) => { ops.push("peek"); return (lists.get(DL_Q) ?? []).slice(0, count); },
      settle: async (taken: number, head: DlRow[], tail: DlRow[]) => {
        ops.push(`settle ${taken} ${head.length} ${tail.length}`);
        if (failSettle) throw new Error("kv down");
        lists.set(DL_Q, [...head, ...(lists.get(DL_Q) ?? []).slice(taken), ...tail]);
      },
    },
  };
}
const capDeps = (k: ReturnType<typeof mkKv>, o: Partial<DlCaptureDeps> = {}): DlCaptureDeps => ({
  on: true, botUserId: BOT, loadDeals: async () => deals, nameOf: async (u) => (u === U1 ? "小笠原" : null), kv: k.kv, ...o,
});
const ev = (o: Partial<DlEvent>): DlEvent => ({ groupId: G, senderId: U1, messageId: "m1", kind: "text", text: "", at: NOW, ...o });

/** Notion の偽物：ページごとの最上位のブロックを持つ */
function mkNotion(pages: Record<string, unknown[]> = {}) {
  const calls: string[] = [];
  const failFor = new Set<string>();
  return {
    pages, calls, failFor,
    notion: {
      list: async (pageId: string, cursor?: string) => {
        calls.push(`list ${pageId}`);
        const all = pages[pageId] ?? [];
        const from = cursor ? Number(cursor) : 0;
        const next = from + 100;
        return { results: all.slice(from, next), next: next < all.length ? String(next) : null };
      },
      append: async (pageId: string, children: unknown[]) => {
        calls.push(`append ${pageId} ${children.length}`);
        if (failFor.has(pageId)) throw Object.assign(new Error("boom"), { code: "rate_limited" });
        pages[pageId] = [...(pages[pageId] ?? []), ...children];
      },
    },
  };
}
const plain = (b: unknown): string => {
  const o = b as Record<string, { rich_text?: Array<{ text?: { content?: string }; plain_text?: string }> }> & { type: string };
  return (o[o.type]?.rich_text ?? []).map((r) => r.text?.content ?? r.plain_text ?? "").join("");
};
const row = (dealId: string, at: number, text = "本文", o: Partial<DlRow> = {}): DlRow => ({ dealId, at, who: "小笠原", kind: "text", text, via: "name", ...o });
const flushDeps = (k: ReturnType<typeof mkKv>, nt: ReturnType<typeof mkNotion>, logs: string[], o: Partial<DlFlushDeps> = {}): DlFlushDeps => ({
  on: true, kv: k.kv, notion: nt.notion, loadDeals: async () => deals, log: (l) => logs.push(l), clock: () => NOW, ...o,
});

(async () => {
  await t("スイッチは DEAL_LOG=1 のときだけ", () => {
    assert.equal(dealLogOn({ DEAL_LOG: "1" }), true);
    assert.equal(dealLogOn({ DEAL_LOG: "true" }), false);
    assert.equal(dealLogOn({}), false);
  });

  await t("名前の一致：案件名の各部分（4字以上）が本文に入っている案件", () => {
    assert.deepEqual(matchDealsInText("天満ハイツ302の鍵を受け取りました", deals).map((d) => d.id), [D1]);
    // 表記ゆれ（全角・空白・漢数字の丁目）は物件の鍵と同じ規則で吸収する
    assert.deepEqual(matchDealsInText("天満ハイツ ３０２ 内覧OK", deals).map((d) => d.id), [D1]);
    assert.deepEqual(matchDealsInText("吹田市山手町4丁目の測量が終わりました", deals).map((d) => d.id), [D3]);
    assert.deepEqual(matchDealsInText("【至急】ジオ北浜1205 ローン通りました", deals).map((d) => d.id), [D2]);
    // 「売り」「買い」「山田様」（短い）・一般的な言葉では当てない
    assert.deepEqual(matchDealsInText("山田様から売りの相談です", deals), []);
    assert.deepEqual(matchDealsInText("天満ハイツの件", deals), []);
    assert.deepEqual(matchDealsInText("", deals), []);
    // 2件に当たる
    assert.deepEqual(matchDealsInText("天満ハイツ302とジオ北浜1205の資料", deals).map((d) => d.id).sort(), [D1, D2]);
  });

  await t("名前の一致：数字の続きは別の部屋（302 は 3021 ではない）・一般的な言葉だけの部分は使わない", () => {
    const ds = [{ id: D1, name: "天満ハイツ30" }, { id: D2, name: "両手仲介｜マンション｜買取再販" }, { id: D3, name: "1200万円｜ABC123" }];
    assert.deepEqual(matchDealsInText("天満ハイツ302の件", ds), []);
    assert.deepEqual(matchDealsInText("天満ハイツ30の件", ds).map((d) => d.id), [D1]);
    assert.deepEqual(matchDealsInText("両手仲介のマンションで買取再販、1200万円 abc123", ds), []);
  });

  await t("a 名前：ちょうど1件のときだけ控える（行の中身・印2つ）", async () => {
    const k = mkKv();
    const r = await captureDealLog(ev({ text: "天満ハイツ302\nの鍵を受け取りました" }), capDeps(k));
    assert.equal(r, "name");
    assert.deepEqual(k.lists.get(DL_Q), [{ dealId: D1, at: NOW, who: "小笠原", kind: "text", text: "天満ハイツ302 の鍵を受け取りました", via: "name" }]);
    assert.equal(k.vals.get(dlMsgKey("m1")), D1);
    assert.deepEqual(k.vals.get(dlLastKey(G, U1)), { dealId: D1, at: NOW });
  });

  await t("a 名前：2件に当たる・当たらないは控えない（当てずっぽうにしない）", async () => {
    const k = mkKv();
    assert.equal(await captureDealLog(ev({ text: "天満ハイツ302とジオ北浜1205の資料" }), capDeps(k)), "ambiguous");
    assert.equal(await captureDealLog(ev({ messageId: "m2", text: "お昼行ってきます" }), capDeps(k)), "unmatched");
    assert.equal(k.lists.get(DL_Q), undefined);
    assert.ok(!k.ops.some((o) => o.startsWith("commit")));
  });

  await t("本文は頭の300字まで・名簿に無い人は「不明」", async () => {
    const k = mkKv();
    await captureDealLog(ev({ senderId: U2, text: "天満ハイツ302 " + "あ".repeat(400) }), capDeps(k));
    const r = (k.lists.get(DL_Q) as DlRow[])[0];
    assert.equal(Array.from(r.text).length, 300);
    assert.ok(r.text.endsWith("…"));
    assert.equal(r.who, "不明");
  });

  await t("b 引用：ひも付いた発言への引用はその案件へ。引用先が控えに無ければ控えない", async () => {
    const k = mkKv();
    await captureDealLog(ev({ text: "天満ハイツ302 契約日が決まりました" }), capDeps(k));
    const r = await captureDealLog(ev({ messageId: "m2", senderId: U2, text: "了解です", quotedMessageId: "m1", at: NOW + 60_000 }), capDeps(k));
    assert.equal(r, "quote");
    assert.equal((k.lists.get(DL_Q) as DlRow[])[1].via, "quote");
    assert.equal((k.lists.get(DL_Q) as DlRow[])[1].dealId, D1);
    // 引用の引用もつながる
    assert.equal(await captureDealLog(ev({ messageId: "m3", text: "ありがとうございます", quotedMessageId: "m2", at: NOW + 120_000 }), capDeps(k)), "quote");
    assert.equal(await captureDealLog(ev({ messageId: "m4", text: "了解です", quotedMessageId: "zzz" }), capDeps(k)), "unmatched");
    // 本文が別の1件を名指ししていれば、名前が先
    assert.equal(await captureDealLog(ev({ messageId: "m5", text: "ジオ北浜1205も同じ日です", quotedMessageId: "m1" }), capDeps(k)), "name");
    assert.equal((k.lists.get(DL_Q) as DlRow[])[3].dealId, D2);
  });

  await t("c 続きの添付：同じ人の5分以内の画像・ファイル・動画だけ。文字・他人・5分過ぎは控えない", async () => {
    const k = mkKv();
    await captureDealLog(ev({ text: "天満ハイツ302 室内の写真です" }), capDeps(k));
    assert.equal(await captureDealLog(ev({ messageId: "i1", kind: "image", at: NOW + 10_000 }), capDeps(k)), "follow");
    assert.equal(await captureDealLog(ev({ messageId: "f1", kind: "file", at: NOW + 5 * 60_000 }), capDeps(k)), "follow");
    assert.equal(await captureDealLog(ev({ messageId: "v1", kind: "video", at: NOW + 20_000 }), capDeps(k)), "follow");
    const rows = k.lists.get(DL_Q) as DlRow[];
    assert.deepEqual(rows.slice(1).map((r) => [r.kind, r.text, r.via, r.dealId]), [["image", "", "follow", D1], ["file", "", "follow", D1], ["video", "", "follow", D1]]);
    // 続きの添付は「最後のひも付け」の時刻を延ばさない
    assert.deepEqual(k.vals.get(dlLastKey(G, U1)), { dealId: D1, at: NOW });
    assert.equal(await captureDealLog(ev({ messageId: "i2", kind: "image", at: NOW + 5 * 60_000 + 1 }), capDeps(k)), "unmatched");
    assert.equal(await captureDealLog(ev({ messageId: "i3", kind: "image", senderId: U2, at: NOW + 10_000 }), capDeps(k)), "unmatched");
    assert.equal(await captureDealLog(ev({ messageId: "t2", text: "よろしくお願いします", at: NOW + 10_000 }), capDeps(k)), "unmatched");
    // 画像は案件の一覧を読まない（KV だけ）
    let loads = 0;
    await captureDealLog(ev({ messageId: "i4", kind: "image", at: NOW + 30_000 }), capDeps(k, { loadDeals: async () => { loads++; return deals; } }));
    assert.equal(loads, 0);
  });

  await t("同じ発言が届き直しても行は1つ", async () => {
    const k = mkKv();
    await captureDealLog(ev({ text: "天満ハイツ302 鍵を返しました" }), capDeps(k));
    assert.equal(await captureDealLog(ev({ text: "天満ハイツ302 鍵を返しました" }), capDeps(k)), "dup");
    assert.equal((k.lists.get(DL_Q) as DlRow[]).length, 1);
  });

  await t("off・1対1・Bot 自身は KV も案件の一覧も触らない", async () => {
    const k = mkKv();
    let loads = 0;
    const d = (o: Partial<DlCaptureDeps> = {}) => capDeps(k, { loadDeals: async () => { loads++; return deals; }, ...o });
    assert.equal(await captureDealLog(ev({ text: "天満ハイツ302" }), d({ on: false })), "off");
    assert.equal(await captureDealLog(ev({ text: "天満ハイツ302", groupId: null }), d()), "skip");
    assert.equal(await captureDealLog(ev({ text: "天満ハイツ302", senderId: BOT }), d()), "skip");
    assert.equal(await captureDealLog(ev({ text: "天満ハイツ302", messageId: "" }), d()), "skip");
    assert.deepEqual(k.ops, []);
    assert.equal(loads, 0);
  });

  await t("案件の一覧・KV が読めない・遅いときは黙って飛ばす（投げない）", async () => {
    const k = mkKv();
    assert.equal(await captureDealLog(ev({ text: "天満ハイツ302" }), capDeps(k, { loadDeals: async () => { throw new Error("x"); } })), "error");
    assert.equal(await captureDealLog(ev({ text: "天満ハイツ302" }), capDeps(k, { loadDeals: () => new Promise(() => undefined), loadTimeoutMs: 20 })), "error");
    const bad = { ...k.kv, commit: async () => { throw new Error("kv"); } };
    assert.equal(await captureDealLog(ev({ text: "天満ハイツ302" }), capDeps(k, { kv: bad })), "error");
    assert.equal(k.lists.get(DL_Q), undefined);
  });

  await t("行の形：JST の「月/日 時:分 名前：本文」。画像などは（画像）（ファイル）（動画）", () => {
    assert.equal(formatDlRow(row(D1, NOW, "鍵を受け取りました")), "11/28 16:40 小笠原：鍵を受け取りました");
    assert.equal(formatDlRow(row(D1, NOW + 60_000, "", { kind: "image" })), "11/28 16:41 小笠原：（画像）");
    assert.equal(formatDlRow(row(D1, NOW, "", { kind: "file" })), "11/28 16:40 小笠原：（ファイル）");
    assert.equal(formatDlRow(row(D1, NOW, "", { kind: "video" })), "11/28 16:40 小笠原：（動画）");
    // UTC 11/30 15:05 = JST 12/1 00:05（日付が変わる）
    assert.equal(formatDlRow(row(D1, Date.UTC(2026, 10, 30, 15, 5), "a", { who: "不明" })), "12/1 00:05 不明：a");
  });

  await t("Notion の文字は 1900 字ごとに分ける", () => {
    const c = richChunks("あ".repeat(4000));
    assert.deepEqual(c.map((x) => Array.from(x.text.content).length), [1900, 1900, 200]);
    assert.equal(richChunks("短い").length, 1);
  });

  await t("書き出し：見出しは最初の1回だけ。行は古い順", async () => {
    const k = mkKv();
    const nt = mkNotion({ [D1]: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "メモ" }] } }] });
    const logs: string[] = [];
    k.lists.set(DL_Q, [row(D1, NOW + 60_000, "あと"), row(D1, NOW, "さき"), row(D1, NOW + 120_000, "", { kind: "image", via: "follow" })]);
    await flushDealLog(NOW, flushDeps(k, nt, logs));
    assert.deepEqual(nt.pages[D1].slice(1).map(plain), [DL_HEADING, "11/28 16:40 小笠原：さき", "11/28 16:41 小笠原：あと", "11/28 16:42 小笠原：（画像）"]);
    assert.equal((nt.pages[D1][1] as { type: string }).type, "heading_2");
    assert.equal((nt.pages[D1][2] as { type: string }).type, "bulleted_list_item");
    assert.deepEqual(k.lists.get(DL_Q), []);
    assert.ok(k.vals.has(dlHeadKey(D1)));
    assert.deepEqual(logs, ["[deal-log] flush deals 1 rows 3 fail 0 kept 0 dropped 0"]);

    // 2回目：印があるのでページを読まず、見出しも足さない
    k.vals.delete("deallog:flush");
    nt.calls.length = 0;
    k.lists.set(DL_Q, [row(D1, NOW + 180_000, "次")]);
    await flushDealLog(NOW + 200_000, flushDeps(k, nt, logs));
    assert.deepEqual(nt.calls, [`append ${D1} 1`]);
    assert.equal(nt.pages[D1].map(plain).filter((s) => s === DL_HEADING).length, 1);
  });

  await t("書き出し：印が無くても、ページに見出しがあれば足さない（100件より先も見る）。200件見て無ければ足す", async () => {
    const filler = (c: number) => Array.from({ length: c }, () => ({ type: "paragraph", paragraph: { rich_text: [] } }));
    const head = { type: "heading_2", heading_2: { rich_text: [{ plain_text: "LINE の動き" }, { plain_text: "（自動記録）" }] } };
    const k = mkKv();
    const nt = mkNotion({ [D1]: [...filler(150), head], [D2]: [...filler(250), head] });
    k.lists.set(DL_Q, [row(D1, NOW), row(D2, NOW)]);
    await flushDealLog(NOW, flushDeps(k, nt, []));
    assert.equal(nt.pages[D1].length, 152);
    assert.equal(nt.calls.filter((c) => c === `list ${D1}`).length, 2);
    assert.ok(k.vals.has(dlHeadKey(D1)));
    // 200件までに見つからない＝分からない → 印が無いので見出しを足す
    assert.equal(nt.calls.filter((c) => c === `list ${D2}`).length, 2);
    assert.equal(nt.pages[D2].length, 253);
    // 見出しに似た別のブロック（段落・見出し3・文が少し違う）は見出しと数えない
    const k2 = mkKv();
    const nt2 = mkNotion({ [D1]: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: DL_HEADING }] } }, { type: "heading_2", heading_2: { rich_text: [{ plain_text: DL_HEADING + " " }] } }] });
    k2.lists.set(DL_Q, [row(D1, NOW)]);
    await flushDealLog(NOW, flushDeps(k2, nt2, []));
    assert.equal(nt2.pages[D1].length, 4);
  });

  await t("書き出し：ページを読めないときも、印が無ければ見出しを足して書く", async () => {
    const k = mkKv();
    const nt = mkNotion();
    const notion = { ...nt.notion, list: async () => { throw new Error("x"); } };
    k.lists.set(DL_Q, [row(D1, NOW)]);
    await flushDealLog(NOW, flushDeps(k, nt, [], { notion }));
    assert.deepEqual(nt.pages[D1].map(plain), [DL_HEADING, "11/28 16:40 小笠原：本文"]);
  });

  await t("書き出し：1回に5案件・40行まで。残りは列に残る（順番のまま）", async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `${i}`.repeat(8) + "-0000-0000-0000-000000000000");
    const many = ids.map((id, i) => ({ id, name: `テスト物件${i}番館` }));
    const k = mkKv();
    const nt = mkNotion();
    const logs: string[] = [];
    k.lists.set(DL_Q, ids.map((id, i) => row(id, NOW + i)));
    await flushDealLog(NOW, flushDeps(k, nt, logs, { loadDeals: async () => many }));
    assert.equal(nt.calls.filter((c) => c.startsWith("append")).length, 5);
    assert.deepEqual((k.lists.get(DL_Q) as DlRow[]).map((r) => r.dealId), [ids[5], ids[6]]);
    assert.deepEqual(logs, ["[deal-log] flush deals 5 rows 5 fail 0 kept 2 dropped 0"]);

    const k2 = mkKv();
    const nt2 = mkNotion();
    k2.lists.set(DL_Q, Array.from({ length: 55 }, (_, i) => row(D1, NOW + i, `行${i}`)));
    await flushDealLog(NOW, flushDeps(k2, nt2, []));
    assert.equal(nt2.pages[D1].length, 41);
    assert.equal((k2.lists.get(DL_Q) as DlRow[]).length, 15);
    assert.equal((k2.lists.get(DL_Q) as DlRow[])[0].text, "行40");
  });

  await t("書き出し：Notion が失敗した案件の行は列に戻す（消さない）。ほかの案件は書く。投げない", async () => {
    const k = mkKv();
    const nt = mkNotion();
    const logs: string[] = [];
    nt.failFor.add(D1);
    k.lists.set(DL_Q, [row(D1, NOW, "一"), row(D2, NOW, "二"), row(D1, NOW + 1, "三")]);
    await flushDealLog(NOW, flushDeps(k, nt, logs));
    assert.deepEqual((k.lists.get(DL_Q) as DlRow[]).map((r) => r.text), ["一", "三"]);
    assert.deepEqual(nt.pages[D2].map(plain), [DL_HEADING, "11/28 16:40 小笠原：二"]);
    assert.ok(!k.vals.has(dlHeadKey(D1)));
    assert.deepEqual(logs, ["[deal-log] append-failed rate_limited", "[deal-log] flush deals 1 rows 1 fail 2 kept 0 dropped 0"]);
    // 直ったら次の回で書ける
    nt.failFor.clear();
    k.vals.delete("deallog:flush");
    await flushDealLog(NOW + 120_000, flushDeps(k, nt, logs));
    assert.deepEqual(nt.pages[D1].map(plain), [DL_HEADING, "11/28 16:40 小笠原：一", "11/28 16:40 小笠原：三"]);
    assert.deepEqual(k.lists.get(DL_Q), []);
  });

  await t("書き出し：完了・失注になった案件（進行中の一覧に無い）と2日より古い行は書かずに捨て、数をログに出す", async () => {
    const k = mkKv();
    const nt = mkNotion();
    const logs: string[] = [];
    const GONE = "99999999-9999-9999-9999-999999999999";
    k.lists.set(DL_Q, [row(GONE, NOW - 11 * 60_000), row(D1, NOW - DL_ROW_TTL_MS - 1, "古い"), row(D1, NOW, "新しい"), { broken: true }, "{bad"]);
    await flushDealLog(NOW, flushDeps(k, nt, logs));
    assert.equal(nt.pages[GONE], undefined);
    // 控えたばかり（10分以内）の行は、一覧の覚えが古いだけかもしれないので捨てずに待つ
    const k3 = mkKv();
    const logs3: string[] = [];
    k3.lists.set(DL_Q, [row(GONE, NOW - 60_000)]);
    await flushDealLog(NOW, flushDeps(k3, nt, logs3));
    assert.equal(nt.pages[GONE], undefined);
    assert.equal((k3.lists.get(DL_Q) as DlRow[]).length, 1);
    assert.deepEqual(logs3, ["[deal-log] flush deals 0 rows 0 fail 0 kept 1 dropped 0"]);
    assert.deepEqual(nt.pages[D1].map(plain), [DL_HEADING, "11/28 16:40 小笠原：新しい"]);
    assert.deepEqual(k.lists.get(DL_Q), []);
    assert.deepEqual(logs, ["[deal-log] flush deals 1 rows 1 fail 0 kept 0 dropped 4"]);
  });

  await t("書き出し：進行中の案件を読めない回は、何も書かず列をそのまま残す", async () => {
    const k = mkKv();
    const nt = mkNotion();
    const logs: string[] = [];
    k.lists.set(DL_Q, [row(D1, NOW)]);
    await flushDealLog(NOW, flushDeps(k, nt, logs, { loadDeals: async () => { throw new Error("x"); } }));
    assert.deepEqual(nt.calls, []);
    assert.equal((k.lists.get(DL_Q) as DlRow[]).length, 1);
    assert.deepEqual(logs, ["[deal-log] flush deals-unreadable"]);
  });

  await t("書き出し：時間の予算を使い切ったら、残りの案件には手を付けず列に残す", async () => {
    const k = mkKv();
    const nt = mkNotion();
    let now = NOW;
    const notion = { ...nt.notion, append: async (p: string, c: unknown[]) => { now += 9_000; await nt.notion.append(p, c); } };
    k.lists.set(DL_Q, [row(D1, NOW), row(D2, NOW)]);
    const logs: string[] = [];
    await flushDealLog(NOW, flushDeps(k, nt, logs, { notion, clock: () => now }));
    assert.deepEqual((k.lists.get(DL_Q) as DlRow[]).map((r) => r.dealId), [D2]);
    assert.deepEqual(logs, ["[deal-log] flush deals 1 rows 1 fail 0 kept 1 dropped 0"]);
  });

  await t("書き出し：2分に1回だけ（印が取れない回は KV を1回たたくだけ）。off は KV も触らない", async () => {
    const k = mkKv();
    const nt = mkNotion();
    k.lists.set(DL_Q, [row(D1, NOW)]);
    await flushDealLog(NOW, flushDeps(k, nt, [], { on: false }));
    assert.deepEqual(k.ops, []);
    await flushDealLog(NOW, flushDeps(k, nt, []));
    k.lists.set(DL_Q, [row(D1, NOW + 1)]);
    k.ops.length = 0;
    await flushDealLog(NOW + 60_000, flushDeps(k, nt, []));
    assert.deepEqual(k.ops, ["setNx deallog:flush"]);
    assert.equal((k.lists.get(DL_Q) as DlRow[]).length, 1);
    assert.ok(DL_FLUSH_GUARD_SEC >= 100 && DL_FLUSH_GUARD_SEC <= 120);
    // 列が空の回はログも Notion も無い
    const k2 = mkKv();
    const logs: string[] = [];
    await flushDealLog(NOW, flushDeps(k2, nt, logs));
    assert.deepEqual(k2.ops, ["setNx deallog:flush", "peek"]);
    assert.deepEqual(logs, []);
  });

  await t("書き出し：列の片付けに失敗したら符号を出す（投げない）", async () => {
    const k = mkKv();
    const nt = mkNotion();
    const logs: string[] = [];
    k.setFailSettle(true);
    k.lists.set(DL_Q, [row(D1, NOW)]);
    await flushDealLog(NOW, flushDeps(k, nt, logs));
    assert.deepEqual(logs, ["[deal-log] settle-failed"]);
  });

  await t("つなぎ（dealLogBatch・flushDealLogOnTick）：off は何も呼ばずログも出さない。on で読めないときは件数の1行だけ", async () => {
    for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "KV_URL", "CRM_DEALS_DB_ID", "DEAL_LOG"]) delete process.env[k];
    const wire = await import("../src/lib/deal-log-wire");
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try {
      const off = wire.dealLogBatch();
      off.add(ev({ text: "天満ハイツ302" }));
      await off.done();
      await wire.flushDealLogOnTick(NOW);
      assert.deepEqual(lines, []);
      process.env.DEAL_LOG = "1";
      const on = wire.dealLogBatch();
      on.add(ev({ text: "天満ハイツ302 の鍵" }));
      on.add(ev({ text: "1対1", groupId: null }));
      await on.done();
      assert.deepEqual(lines, ["[deal-log] in 1 hit 0 skip 0 error 1"]);
    } finally {
      console.log = orig;
      delete process.env.DEAL_LOG;
    }
  });

  console.log(`\n${n} 件 ok`);
})().catch((e) => { console.error(e); process.exit(1); });
