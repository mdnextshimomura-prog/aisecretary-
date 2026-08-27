/**
 * docs/依頼チェックリスト.md → src/lib/checklist.generated.ts
 *
 * 定義を .md に置いているのは、**プログラムを触らずに項目を足し引きできる**ようにするため。
 * ただし Vercel のサーバーレス環境で実行時にファイルを読むのは経路が壊れやすいので、
 * ビルド時にTypeScriptへ焼き込む。npm run build から自動で呼ばれる。
 */
import fs from "fs";
import path from "path";

const SRC = path.join(process.cwd(), "docs", "依頼チェックリスト.md");
const OUT = path.join(process.cwd(), "src", "lib", "checklist.generated.ts");

const md = fs.readFileSync(SRC, "utf8");
const lines = md.split("\n");

const sections = {};
const derives = [];
let current = null;   // 確認項目の表を読んでいる種別名
let inDerive = false; // 自動補完ルールの表を読んでいるか
let inTable = false;

const TYPES = /^(共通|購入申込書|査定書|物件資料|重要事項説明書|売買契約書|書類取得|業者確認|内見調整|その他)/;

for (const line of lines) {
  const h2 = line.match(/^##\s+(.+?)\s*$/);
  if (h2) {
    const title = h2[1].trim();
    inTable = false;
    inDerive = title === "自動補完ルール";
    if (!inDerive && TYPES.test(title)) {
      current = title.replace(/（.*$/, "").trim();
      sections[current] = [];
    } else {
      current = null;
    }
    continue;
  }

  if (!line.startsWith("|")) { inTable = false; continue; }
  if (/^\|\s*-+/.test(line)) continue;

  const cells = line.split("|").slice(1, -1).map((c) => c.trim());

  if (inDerive) {
    if (cells[0] === "条件の項目") { inTable = true; continue; }
    if (!inTable || cells.length < 4) continue;
    const [when, contains, set, value] = cells;
    if (when && contains && set && value) derives.push({ when, contains, set, value });
    continue;
  }

  if (!current) continue;
  if (cells[0] === "キー") { inTable = true; continue; }
  if (!inTable || cells.length < 4) continue;
  const [key, label, suggestRaw, req] = cells;
  if (!key) continue;
  sections[current].push({
    key,
    label,
    suggest: suggestRaw === "-" || suggestRaw === "" ? null : suggestRaw,
    critical: req.includes("★"),
  });
}

const common = sections["共通"] ?? [];
delete sections["共通"];

const total = Object.values(sections).reduce((n, v) => n + v.length, 0);
if (total === 0) {
  console.error("❌ 項目を1つも読み取れませんでした。docs/依頼チェックリスト.md の表を確認してください");
  process.exit(1);
}

const body = Object.entries(sections)
  .map(([type, fields]) => {
    // 共通項目は各種別の末尾に足す。先頭に置くと「期限は？」が最初に来て、
    // 本当に聞きたい金額や名義が下に押しやられる。
    const all = [...fields, ...common];
    const rows = all
      .map(
        (f) =>
          `    { key: ${JSON.stringify(f.key)}, label: ${JSON.stringify(f.label)}, suggest: ${
            f.suggest === null ? "null" : JSON.stringify(f.suggest)
          }, critical: ${f.critical} },`
      )
      .join("\n");
    return `  ${JSON.stringify(type)}: [\n${rows}\n  ],`;
  })
  .join("\n");

const out = `// 自動生成ファイル — 直接編集しないこと。
// 正本は docs/依頼チェックリスト.md。編集後に \`npm run build:checklist\` を実行する。
// 生成元: docs/依頼チェックリスト.md

export interface RequiredField {
  key: string;
  label: string;
  /** 既定の提案。null なら「どうしますか？」と聞くしかない項目 */
  suggest: string | null;
  /** これが無いと着手できない項目 */
  critical: boolean;
}

/** 依頼種別 -> 確認項目。共通項目は各種別の末尾に展開済み */
export const CHECKLIST: Record<string, RequiredField[]> = {
${body}
};

export interface DeriveRule {
  /** この項目の値が */
  when: string;
  /** この語を含んでいたら */
  contains: string;
  /** この項目を */
  set: string;
  /** この値で埋める（すでに値があるときは上書きしない） */
  value: string;
}

/** 答えれば自動的に決まる項目。社長に聞き返さないためのルール */
export const DERIVE_RULES: DeriveRule[] = ${JSON.stringify(derives, null, 2)};
`;

fs.writeFileSync(OUT, out);
console.log(`✅ ${Object.keys(sections).length}種別 / ${total + common.length * Object.keys(sections).length}項目 ／ 自動補完 ${derives.length}件 を生成しました`);
for (const [t, f] of Object.entries(sections)) {
  console.log(`   ${t}: ${f.length + common.length}項目（必須 ${f.filter((x) => x.critical).length}）`);
}
