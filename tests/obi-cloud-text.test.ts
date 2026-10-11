/**
 * クラウド配達の文（約束 2026-10-11-obi-cloud-contract.md の「文」）。
 * 期待値は共通のテスト用データ tests/fixtures/obi-cloud-texts.json。
 * line-secretary の test/fixtures/obi-cloud-texts.json と同じバイト。片方だけ直すと、ここで落ちる。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  cloudProperty,
  completionText,
  failureNoticeText,
  offeredChoices,
  readCompletionFacts,
  rejectNoticeText,
} from "../src/lib/obi/cloud-text";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name}`);
};

const raw = readFileSync(
  path.join(__dirname, "fixtures", "obi-cloud-texts.json"),
);
const doc = JSON.parse(raw.toString("utf8")) as {
  link: string;
  completion: Array<{
    name: string;
    in: {
      no: number;
      property: string;
      claim: Record<string, unknown>;
      fixGuide: boolean;
    };
    text: string;
  }>;
  reject: Array<{
    name: string;
    in: { no: number; row: Record<string, unknown> };
    kind: string;
    text: string;
  }>;
  failure: Array<{ in: { no: number }; text: string }>;
  property: Array<{ in: string; out: string }>;
};
const clean = (s: string) => !/undefined|null|NaN|\[object/.test(s);

function main() {
  ok(
    "共通の表の sha256（Mac と同じバイト）",
    createHash("sha256").update(raw).digest("hex") ===
      "cfe546979ba4f84a45ea8ef7c2957378f43ca6e24c5b5a8b795fa0973d26eca4",
  );
  ok(
    "共通の表の件数（11・13・1・9）",
    doc.completion.length === 11 &&
      doc.reject.length === 13 &&
      doc.failure.length === 1 &&
      doc.property.length === 9,
  );

  // 完成（Mac：deliver.js 173行 groupText）。物件名は、整えた後の値を渡す（見回りと同じ使い方）
  for (const c of doc.completion) {
    const t = completionText({
      no: c.in.no,
      property: cloudProperty(c.in.property),
      facts: readCompletionFacts(c.in.claim),
      link: doc.link,
      fixGuide: c.in.fixGuide,
    });
    ok(`完成：${c.name}`, t === c.text, JSON.stringify(t));
    ok(`完成：${c.name}（変な字が出ない）`, clean(t));
  }
  // 差し戻し（Mac：rejecttext.js 50・83行／notify.js 44行）
  for (const c of doc.reject) {
    const r = rejectNoticeText(c.in.no, c.in.row);
    ok(
      `差し戻し：${c.name}`,
      r.kind === c.kind && r.text === c.text,
      JSON.stringify(r),
    );
    ok(
      `差し戻し：${c.name}（choiceGen は行の値）`,
      r.kind !== "choices" || r.choiceGen === c.in.row.choiceGen,
    );
    ok(`差し戻し：${c.name}（変な字が出ない）`, clean(r.text));
  }
  // 失敗（Mac：notify.js 45行）
  for (const c of doc.failure) {
    ok(
      `失敗：#J${c.in.no}`,
      failureNoticeText(c.in.no) === c.text && clean(c.text),
    );
  }
  // 物件名（Mac：room.js 28行 sanitizeField(…, 60)）
  for (const c of doc.property) {
    ok(
      `物件名：${JSON.stringify(c.in).slice(0, 30)}`,
      cloudProperty(c.in) === c.out,
      JSON.stringify(cloudProperty(c.in)),
    );
  }

  // 表の外：readCompletionFacts
  let f = readCompletionFacts({ outsideErased: 0, outsidePages: [1, 2] });
  ok(
    "facts：消した数が 0 ならページは空",
    f.outsideErased === 0 && f.outsidePages.length === 0,
  );
  f = readCompletionFacts({
    outsideErased: 3,
    outsidePages: Array.from({ length: 21 }, (_, i) => i + 1),
  });
  ok(
    "facts：21件のページは先頭20件",
    f.outsidePages.length === 20 && f.outsidePages[19] === 20,
  );
  const FIX = {
    round: 1,
    code: 1,
    page: 3,
    turn: "",
    by: "auto",
    source: "line-group",
  };
  const { page: _p, ...noPage } = FIX;
  void _p;
  f = readCompletionFacts({ fix: noPage });
  ok(
    "facts：fix.page が undefined でも null と同じ",
    f.fix !== null && f.fix.page === null,
  );
  ok(
    "facts：fix の項目は6つ",
    f.fix !== null &&
      Object.keys(f.fix).sort().join() === "by,code,page,round,source,turn",
  );
  const badFix: unknown[] = [
    [FIX],
    "fix",
    { ...FIX, round: 10 },
    { ...FIX, turn: "up" },
    { ...FIX, by: "x" },
    { ...FIX, source: "x" },
    { ...FIX, page: 121 },
    { ...FIX, code: 0 },
  ];
  for (const b of badFix) {
    ok(
      `facts：fix の形違いは null（${JSON.stringify(b).slice(0, 40)}）`,
      readCompletionFacts({ fix: b }).fix === null,
    );
  }
  ok(
    "facts：項目は4つ",
    Object.keys(readCompletionFacts({})).sort().join() ===
      "fix,outsideErased,outsidePages,reviewPages",
  );

  // 表の外：cloudProperty
  ok(
    "物件名：文字列でない値は空",
    cloudProperty(undefined) === "" &&
      cloudProperty(12) === "" &&
      cloudProperty(null) === "" &&
      cloudProperty({}) === "",
  );
  // 表の外：理由の名前が持ち主の項目でも、既定の文（共通の表には入れない＝sha256 を変えない）
  for (const k of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    const r = rejectNoticeText(4, {
      workflow: "obi",
      rejectState: "offered",
      choiceGen: 41,
      choices: [3],
      rejectRound: 0,
      rejectKind: k,
      rejectReason: "",
    });
    ok(
      `差し戻し：rejectKind が ${k} でも既定の理由`,
      r.kind === "choices" &&
        r.text.startsWith(
          "#J4 自動では仕上げられませんでした（理由：自動で1冊にできません）\n",
        ),
      r.text,
    );
  }
  ok(
    "offeredChoices：重複を除いて小さい順・範囲外は捨てる",
    offeredChoices({ choices: [4, 2, 2, 9, 1, "3", 1.5] }).join() === "1,2,4",
  );
  ok(
    "offeredChoices：配列でなければ空",
    offeredChoices({ choices: "1" }).length === 0 &&
      offeredChoices({}).length === 0,
  );

  // 表の外：completionText は物件名を整え直さない（整えるのは cloudProperty の1回だけ。Mac の groupText と同じ結果）
  ok(
    "物件名の整えは冪等でない（2回通すと変わる入力がある）",
    cloudProperty("hthttp://tp://x") === "http://x" &&
      cloudProperty("http://x") === "x",
  );
  const t = completionText({
    no: 1,
    property: "http://x",
    facts: readCompletionFacts({}),
    link: doc.link,
    fixGuide: false,
  });
  ok(
    "completionText は受け取った物件名を整え直さない",
    t.split("\n")[0] === "#J1 帯替えが完成しました（http://x）",
    t,
  );

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
