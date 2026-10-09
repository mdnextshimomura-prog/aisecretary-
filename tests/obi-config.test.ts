/**
 * 帯替えの入口の確認（設計 6・7・8）。値は偽物。設定は env を引数で渡す。
 */
import {
  loadObiConfig,
  classifyObiEntry,
  shouldRecordObiPdf,
  type ObiEnv,
} from "../src/lib/obi/config";
import { sanitizeForReply, sanitizeUploadName, propertyFor, requestTextFor, cutUtf16 } from "../src/lib/obi/sanitize";

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
const env: ObiEnv = {
  LINE_GROUP_ID: G,
  JOB_ALLOWED_USER_IDS: ` ${SHIMO} , ${"U" + "d".repeat(32)}`,
  PORTAL_BASE_URL: "https://portal.example.test/",
  JOB_API_TOKEN: "tok-123",
};
const req = (over: Partial<Parameters<typeof classifyObiEntry>[0]> = {}) => ({
  sourceType: "group",
  groupId: G,
  userId: SHIMO,
  mentionsBot: true,
  text: "帯替え 架空邸",
  ...over,
});

// ── 設定の読み取り ──
{
  const r = loadObiConfig(env);
  ok("揃った設定は使える", r.ok);
  if (r.ok) {
    ok("PORTAL_BASE_URL の末尾の / を除く", r.config.portalBaseUrl === "https://portal.example.test");
    ok("許可リストはカンマ区切り・前後の空白を除く", r.config.allowedUserIds.length === 2 && r.config.allowedUserIds[0] === SHIMO);
  }
  const bad = (name: string, over: ObiEnv, problem: string) => {
    const x = loadObiConfig({ ...env, ...over });
    ok(name, !x.ok && x.problems.includes(problem), JSON.stringify(x.ok ? "ok" : x.problems));
  };
  bad("LINE_GROUP_ID が無いと止める", { LINE_GROUP_ID: undefined }, "LINE_GROUP_ID");
  bad("LINE_GROUP_ID の形が違うと止める", { LINE_GROUP_ID: "Cxyz" }, "LINE_GROUP_ID");
  bad("許可リストが空だと止める", { JOB_ALLOWED_USER_IDS: " , " }, "JOB_ALLOWED_USER_IDS");
  bad("許可リストに形の違う ID があると止める", { JOB_ALLOWED_USER_IDS: `${SHIMO},Uabc` }, "JOB_ALLOWED_USER_IDS");
  bad("PORTAL_BASE_URL が http（localhost 以外）だと止める", { PORTAL_BASE_URL: "http://portal.example.test" }, "PORTAL_BASE_URL");
  bad("PORTAL_BASE_URL が URL でないと止める", { PORTAL_BASE_URL: "portal" }, "PORTAL_BASE_URL");
  bad("JOB_API_TOKEN が無いと止める", { JOB_API_TOKEN: "" }, "JOB_API_TOKEN");
  bad("JOB_API_TOKEN に改行が混ざると止める", { JOB_API_TOKEN: "tok\n" }, "JOB_API_TOKEN");
  const local = loadObiConfig({ ...env, PORTAL_BASE_URL: "http://localhost:3000" });
  ok("localhost だけは http を許す（手元の確認用）", local.ok);
  bad("PORTAL_BASE_URL に空白が混ざると止める（削らない）", { PORTAL_BASE_URL: " https://portal.example.test" }, "PORTAL_BASE_URL");
  bad("PORTAL_BASE_URL に改行が混ざると止める", { PORTAL_BASE_URL: "https://portal.example.test\n" }, "PORTAL_BASE_URL");
  bad("PORTAL_BASE_URL に ? があると止める（空のクエリも）", { PORTAL_BASE_URL: "https://portal.example.test/?" }, "PORTAL_BASE_URL");
  bad("PORTAL_BASE_URL に # があると止める（空の # も）", { PORTAL_BASE_URL: "https://portal.example.test/#" }, "PORTAL_BASE_URL");
}

// ── 入口の判定 ──
{
  const r = classifyObiEntry(req(), env);
  ok("営業部・下村さん・@秘書・先頭が帯替え → 依頼", r.kind === "request" && r.property === "架空邸", JSON.stringify(r));
  ok("担当の指定も読む", (() => { const x = classifyObiEntry(req({ text: "帯替え 担当:佐藤 架空邸" }), env); return x.kind === "request" && x.assigneeName === "佐藤"; })());
  ok("@秘書 のメンションが無ければ扱わない", classifyObiEntry(req({ mentionsBot: false }), env).kind === "not-obi");
  ok("先頭が依頼語でなければ扱わない（メール本文の途中の「帯替え」）", classifyObiEntry(req({ text: "先方に帯替えした資料を送って" }), env).kind === "not-obi");
  ok("「帯替えの件で質問」は依頼にしない", classifyObiEntry(req({ text: "帯替えの件で質問" }), env).kind === "not-obi");
  ok("査定の依頼は扱わない（今までどおり）", classifyObiEntry(req({ text: "査定 架空邸" }), env).kind === "not-obi");
  ok("個別トークは扱わない", classifyObiEntry(req({ sourceType: "user", groupId: undefined }), env).kind === "not-obi");
  ok("複数人トーク（room）は扱わない", classifyObiEntry(req({ sourceType: "room", groupId: undefined }), env).kind === "not-obi");
  ok("他のグループは扱わない", classifyObiEntry(req({ groupId: G2 }), env).kind === "not-obi");
  ok("許可リストにない人は forbidden", classifyObiEntry(req({ userId: OTHER }), env).kind === "forbidden");
  ok("userId が無いと forbidden", classifyObiEntry(req({ userId: undefined }), env).kind === "forbidden");
  ok("鍵が無いと stopped", classifyObiEntry(req(), { ...env, JOB_API_TOKEN: undefined }).kind === "stopped");
  ok("LINE_GROUP_ID が無いと、営業部の ID のグループでも何もしない（not-obi）", classifyObiEntry(req(), { ...env, LINE_GROUP_ID: undefined }).kind === "not-obi");
  ok("LINE_GROUP_ID が無いと、他のグループでも何もしない（not-obi）", classifyObiEntry(req({ groupId: G2 }), { ...env, LINE_GROUP_ID: undefined }).kind === "not-obi");
  ok("LINE_GROUP_ID の形が違っても何もしない（not-obi）", classifyObiEntry(req(), { ...env, LINE_GROUP_ID: "Cxyz" }).kind === "not-obi");
  ok("LINE_GROUP_ID が無いと、許可リスト外の人にも返事をしない（not-obi）", classifyObiEntry(req({ userId: OTHER }), { ...env, LINE_GROUP_ID: undefined }).kind === "not-obi");
  ok("営業部の ID は正しく他が欠けている：営業部の依頼の形は stopped", classifyObiEntry(req(), { ...env, PORTAL_BASE_URL: undefined }).kind === "stopped");
  ok("営業部の ID は正しく他が欠けている：他のグループは not-obi", classifyObiEntry(req({ groupId: G2 }), { ...env, PORTAL_BASE_URL: undefined }).kind === "not-obi");
  ok("営業部の ID は正しく他が欠けている：依頼の形でない発言は not-obi", classifyObiEntry(req({ text: "おはようございます" }), { ...env, JOB_API_TOKEN: undefined }).kind === "not-obi");
}

// ── PDF の控えに足すか ──
{
  const base = { sourceType: "group", groupId: G, fileName: "図面.PDF" };
  ok("営業部の .PDF（大文字）は控える", shouldRecordObiPdf(base, env));
  ok(".pdfx は控えない", !shouldRecordObiPdf({ ...base, fileName: "a.pdfx" }, env));
  ok("画像の名前は控えない", !shouldRecordObiPdf({ ...base, fileName: "a.jpg" }, env));
  ok("他のグループは控えない", !shouldRecordObiPdf({ ...base, groupId: G2 }, env));
  ok("個別トークは控えない", !shouldRecordObiPdf({ ...base, sourceType: "user", groupId: undefined }, env));
  ok("設定が欠けていたら控えない", !shouldRecordObiPdf(base, { ...env, JOB_ALLOWED_USER_IDS: "" }));
  ok("LINE_GROUP_ID が無ければ控えない", !shouldRecordObiPdf(base, { ...env, LINE_GROUP_ID: undefined }));
}

// ── 文字の整え ──
{
  ok("改行は空白に、制御文字は除く", sanitizeForReply("a\nb\u0007c‮") === "a bc");
  const long = sanitizeForReply("あ".repeat(50));
  ok("40文字まで（超えたら末尾を…に）", Array.from(long).length === 40 && long.endsWith("…"), long);
  ok("区切り文字を潰して .pdf を付ける", sanitizeUploadName("../x/y") === ".._x_y.pdf");
  ok("100文字を超える名前は .pdf を残して切る", (() => { const n = sanitizeUploadName("い".repeat(150) + ".pdf"); return Array.from(n).length === 100 && n.endsWith(".pdf"); })());
  ok("物件名があればそれ", propertyFor("架空邸", "a.pdf") === "架空邸");
  ok("物件名が空なら最初の PDF の名前", propertyFor("", "図面A.pdf") === "図面A");
  ok("どちらも空なら「帯替え」", propertyFor("", ".pdf") === "帯替え");
}

// ── P1 と同じ数え方（String.length＝UTF-16 コードユニット）の境目。絵文字は2ユニット ──
{
  const E = "😀"; // length 2
  const noLone = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
  ok("前提：絵文字は2ユニット", E.length === 2 && Array.from(E).length === 1);
  // property：P1 は trim 後の length が 1〜100
  const p100 = "a".repeat(98) + E; // ちょうど100ユニット
  ok("物件名 100ユニットはそのまま", propertyFor(p100, "x.pdf") === p100 && propertyFor(p100, "x.pdf").length === 100);
  const p101 = "a".repeat(99) + E; // 101ユニット：絵文字を割らない
  const r101 = propertyFor(p101, "x.pdf");
  ok("物件名 101ユニットは100以内に切り、絵文字を割らない", r101.length <= 100 && noLone(r101) && r101 === "a".repeat(99) + "…", `${r101.length}`);
  const pMany = E.repeat(51); // 102ユニット
  const rMany = propertyFor(pMany, "x.pdf");
  ok("絵文字だけの102ユニットも100以内・割らない", rMany.length <= 100 && noLone(rMany), `${rMany.length}`);
  ok("物件名の前後の空白は数えない（トリム後で数える）", propertyFor("  " + p100 + "  ", "x.pdf") === p100);
  // requestText：P1 は trim 後の length が 1000 以下（空はよい）
  const t1000 = "a".repeat(998) + E;
  ok("依頼文 1000ユニットはそのまま", requestTextFor(t1000) === t1000 && requestTextFor(t1000).length === 1000);
  const t1001 = "a".repeat(999) + E;
  const rt = requestTextFor(t1001);
  ok("依頼文 1001ユニットは1000以内に切り、絵文字を割らない", rt.length <= 1000 && noLone(rt) && rt === "a".repeat(999), `${rt.length}`);
  const tMany = E.repeat(501); // 1002ユニット
  ok("絵文字だけの1002ユニットは500個（1000ユニット）", requestTextFor(tMany) === E.repeat(500));
  ok("依頼文は空でもよい", requestTextFor("   ") === "" && requestTextFor(undefined as unknown as string) === "");
  ok("cutUtf16 は割れる位置で1つ手前に切る", cutUtf16("ab" + E, 3) === "ab" && cutUtf16("ab" + E, 4) === "ab" + E);
}

// ── 行・段落の区切り（U+2028/2029）と向きを隔てる文字（U+2066〜2069）も除く ──
{
  const LS = "\u2028", PS = "\u2029", LRI = "\u2066", PDI = "\u2069";
  const hasBad = (s: string) => /[\u2028\u2029\u2066-\u2069]/.test(s);
  const r = sanitizeForReply(`a${LS}b${PS}c${LRI}d${PDI}e`);
  ok("返事：U+2028/2029 は空白に、U+2066/2069 は除く", r === "a b cde", JSON.stringify(r));
  const p = propertyFor(`架空${LS}邸${LRI}A${PDI}`, "x.pdf");
  ok("物件名：U+2028・U+2066・U+2069 を残さない", p === "架空 邸A", JSON.stringify(p));
  const pf = propertyFor(`${PS}${LRI}${PDI}`, `図面${LS}B${PDI}.pdf`);
  ok("物件名が区切りだけなら PDF 名へ（その名前からも除く）", pf === "図面 B", JSON.stringify(pf));
  const u = sanitizeUploadName(`図${LS}面${PS}${LRI}x${PDI}.pdf`);
  ok("送るファイル名：U+2028/2029/2066/2069 を残さない", !hasBad(u) && u.endsWith(".pdf") && u.includes("図") && u.includes("x"), JSON.stringify(u));
  ok("区切りの改行は引き続き空白", sanitizeForReply("a\r\nb\rc") === "a b c");
}

console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
process.exit(fail ? 1 : 0);
