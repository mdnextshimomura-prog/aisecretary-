import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface RestorationAnalysis {
  size: number | null;
  cost: number | null;
  propertyAddress: string | null;
  propertyType: string | null;
  costBreakdown: string | null;
  confidence: "high" | "medium" | "low";
  warnings: string[];
  judgment: {
    needsShare: boolean;
    category: string;
    threshold: number;
    diff: number;
    reason: string;
  } | null;
  rawSummary: string;
}

function judgeRestoration(size: number, cost: number): RestorationAnalysis["judgment"] {
  let threshold: number;
  let category: string;

  if (size < 30) {
    threshold = 150000;
    category = "30㎡未満（単身タイプ）";
  } else if (size < 50) {
    threshold = 200000;
    category = "30〜50㎡";
  } else {
    threshold = 300000;
    category = "50㎡以上";
  }

  const needsShare = cost >= threshold;
  return {
    needsShare,
    category,
    threshold,
    diff: cost - threshold,
    reason: needsShare
      ? `${category}の社内共有ライン（${threshold.toLocaleString()}円）を${(cost - threshold).toLocaleString()}円超過しています。`
      : `${category}の社内共有ライン（${threshold.toLocaleString()}円）を${(threshold - cost).toLocaleString()}円下回っています。`,
  };
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const estimateFile = formData.get("estimate") as File | null;
    const propertyFile = formData.get("property") as File | null;
    const isHighRisk = formData.get("isHighRisk") === "true";

    if (!estimateFile && !propertyFile) {
      return NextResponse.json({ error: "ファイルが必要です" }, { status: 400 });
    }

    // ドキュメントコンテンツを構築
    const contentBlocks: Anthropic.MessageParam["content"] = [];

    if (estimateFile) {
      const base64 = await fileToBase64(estimateFile);
      contentBlocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64 },
        // @ts-ignore - title is supported
        title: "見積書・請求書",
      } as Anthropic.DocumentBlockParam);
    }

    if (propertyFile) {
      const base64 = await fileToBase64(propertyFile);
      contentBlocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64 },
        // @ts-ignore - title is supported
        title: "募集図面・契約書",
      } as Anthropic.DocumentBlockParam);
    }

    contentBlocks.push({
      type: "text",
      text: `添付されたPDFを解析し、以下の情報をJSON形式で返してください。

抽出する情報：
- size: 物件の専有面積・部屋面積（㎡の数値のみ、不明な場合はnull）
- cost: 原状回復工事の合計金額（税込み、円の数値のみ、不明な場合はnull）
- propertyAddress: 物件の所在地・住所（不明な場合はnull）
- propertyType: 物件タイプ（例：1K, 1DK, 2LDK など、不明な場合はnull）
- costBreakdown: 費用の内訳の要約（主な項目を箇条書き形式で）
- confidence: 情報の確信度（"high", "medium", "low"のいずれか）
- warnings: 注意事項や気になる点のリスト（配列）
- rawSummary: 書類の内容を簡潔にまとめた説明（2〜3文）

重要な注意事項：
- 面積は専有面積を優先（壁芯・内法の区別があれば内法を使用）
- 金額は必ず税込み合計を使用
- 面積や金額が複数ある場合は最も原状回復に関連するものを選択
- 不明・読み取れない場合は無理に推測せずnullを返す

JSONのみを返してください。説明文は不要です。`,
    });

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [{ role: "user", content: contentBlocks }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json(
        { error: "PDFから情報を読み取れませんでした" },
        { status: 422 }
      );
    }

    const extracted = JSON.parse(jsonMatch[0]) as Omit<RestorationAnalysis, "judgment">;

    // 高額・トラブル案件の場合は判定を上書き
    let judgment: RestorationAnalysis["judgment"] = null;
    if (isHighRisk) {
      const size = extracted.size ?? 0;
      const threshold = size < 30 ? 150000 : size < 50 ? 200000 : 300000;
      const category = size < 30 ? "30㎡未満（単身タイプ）" : size < 50 ? "30〜50㎡" : "50㎡以上";
      judgment = {
        needsShare: true,
        category,
        threshold,
        diff: 0,
        reason: "高額請求・トラブル化の可能性がある案件のため、金額に関わらず社内共有が必要です。",
      };
    } else if (extracted.size !== null && extracted.cost !== null) {
      judgment = judgeRestoration(extracted.size, extracted.cost);
    }

    const result: RestorationAnalysis = { ...extracted, judgment };
    return NextResponse.json(result);
  } catch (err) {
    console.error("Restoration API error:", err);
    return NextResponse.json(
      { error: "解析中にエラーが発生しました" },
      { status: 500 }
    );
  }
}
