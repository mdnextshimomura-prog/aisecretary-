// 自動生成ファイル — 直接編集しないこと。
// 正本は docs/依頼チェックリスト.md。編集後に `npm run build:checklist` を実行する。
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
  "購入申込書": [
    { key: "buyerType", label: "買主の立場（自社買取／一般のお客様／法人）", suggest: null, critical: true },
    { key: "buyerName", label: "買主様のお名前・名義", suggest: null, critical: true },
    { key: "price", label: "購入金額（指値）", suggest: null, critical: true },
    { key: "deposit", label: "手付金", suggest: "売買代金の5%", critical: false },
    { key: "loan", label: "融資利用の有無", suggest: "融資利用あり・ローン特約あり", critical: false },
    { key: "settlement", label: "決済（引渡）の希望時期", suggest: "契約から45日後", critical: false },
    { key: "addressee", label: "申込書の宛先", suggest: "売主様宛て", critical: false },
    { key: "expiry", label: "申込の有効期限", suggest: "発行日から7日間", critical: false },
    { key: "deadline", label: "期限", suggest: "{期日}", critical: false },
  ],
  "査定書": [
    { key: "ownerName", label: "売主様のお名前", suggest: null, critical: true },
    { key: "basis", label: "査定の前提（更地／収益／実需）", suggest: null, critical: true },
    { key: "purpose", label: "用途・提出先", suggest: "売主様への提示用", critical: false },
    { key: "range", label: "価格の出し方", suggest: "上限・下限の幅で提示", critical: false },
    { key: "deadline", label: "期限", suggest: "{期日}", critical: false },
  ],
  "物件資料": [
    { key: "kind", label: "必要な資料の種類", suggest: null, critical: true },
    { key: "recipient", label: "提出先・送り先", suggest: null, critical: false },
    { key: "format", label: "形式", suggest: "PDF", critical: false },
    { key: "deadline", label: "期限", suggest: "{期日}", critical: false },
  ],
  "重要事項説明書": [
    { key: "parties", label: "売主・買主", suggest: null, critical: true },
    { key: "contractDate", label: "契約予定日", suggest: null, critical: true },
    { key: "price", label: "売買代金", suggest: null, critical: true },
    { key: "deadline", label: "期限", suggest: "{期日}", critical: false },
  ],
  "売買契約書": [
    { key: "parties", label: "売主・買主", suggest: null, critical: true },
    { key: "contractDate", label: "契約予定日", suggest: null, critical: true },
    { key: "price", label: "売買代金", suggest: null, critical: true },
    { key: "settlement", label: "決済日", suggest: "契約から45日後", critical: false },
    { key: "deadline", label: "期限", suggest: "{期日}", critical: false },
  ],
  "書類取得": [
    { key: "kind", label: "取得する書類", suggest: null, critical: true },
    { key: "cost", label: "費用の負担", suggest: "会社立替", critical: false },
    { key: "deadline", label: "期限", suggest: "{期日}", critical: false },
  ],
  "業者確認": [
    { key: "question", label: "確認したい内容", suggest: null, critical: true },
    { key: "target", label: "確認先（管理会社・業者名）", suggest: null, critical: false },
    { key: "deadline", label: "期限", suggest: "{期日}", critical: false },
  ],
  "内見調整": [
    { key: "datetime", label: "希望日時", suggest: null, critical: true },
    { key: "attendee", label: "同行者・立会者", suggest: null, critical: false },
    { key: "deadline", label: "期限", suggest: "{期日}", critical: false },
  ],
  "その他": [
    { key: "detail", label: "具体的にやること", suggest: null, critical: true },
    { key: "deadline", label: "期限", suggest: "{期日}", critical: false },
  ],
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
export const DERIVE_RULES: DeriveRule[] = [
  {
    "when": "buyerType",
    "contains": "自社",
    "set": "buyerName",
    "value": "株式会社MD NEXT"
  },
  {
    "when": "buyerType",
    "contains": "買取",
    "set": "buyerName",
    "value": "株式会社MD NEXT"
  },
  {
    "when": "buyerType",
    "contains": "自社",
    "set": "addressee",
    "value": "売主様宛て"
  },
  {
    "when": "loan",
    "contains": "現金",
    "set": "settlement",
    "value": "契約から30日後（現金決済）"
  }
];
