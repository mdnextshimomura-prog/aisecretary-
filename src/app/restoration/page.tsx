"use client";

import { useState, useCallback, useRef } from "react";
import Link from "next/link";
import type { RestorationAnalysis } from "@/app/api/restoration/route";

type UploadedFile = {
  file: File;
  name: string;
  size: string;
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatYen(n: number): string {
  return n.toLocaleString("ja-JP") + "円";
}

function FileDropZone({
  label,
  icon,
  description,
  file,
  onFile,
  accept,
}: {
  label: string;
  icon: string;
  description: string;
  file: UploadedFile | null;
  onFile: (f: UploadedFile | null) => void;
  accept?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const dropped = e.dataTransfer.files[0];
      if (dropped) {
        onFile({ file: dropped, name: dropped.name, size: formatFileSize(dropped.size) });
      }
    },
    [onFile]
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    if (picked) {
      onFile({ file: picked, name: picked.name, size: formatFileSize(picked.size) });
    }
  };

  return (
    <div
      onClick={() => !file && inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`relative rounded-xl border-2 border-dashed transition-all cursor-pointer select-none ${
        file
          ? "border-blue-300 bg-blue-50 cursor-default"
          : dragging
          ? "border-blue-400 bg-blue-50 scale-[1.01]"
          : "border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50/30"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept ?? "application/pdf"}
        onChange={handleChange}
        className="hidden"
      />

      {file ? (
        <div className="p-4 flex items-center gap-3">
          <span className="text-3xl">📄</span>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm text-gray-800 truncate">{file.name}</div>
            <div className="text-xs text-gray-400">{file.size}</div>
            <div className="text-xs text-blue-600 mt-0.5">{label}</div>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onFile(null); }}
            className="text-gray-300 hover:text-red-400 transition-colors p-1"
            title="削除"
          >
            ✕
          </button>
        </div>
      ) : (
        <div className="p-6 text-center">
          <div className="text-4xl mb-2">{icon}</div>
          <div className="font-semibold text-gray-700 mb-1">{label}</div>
          <div className="text-xs text-gray-400 mb-3">{description}</div>
          <div className="inline-block text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-1.5 rounded-full transition-colors">
            クリックまたはドラッグ＆ドロップ
          </div>
        </div>
      )}
    </div>
  );
}

function ConfidenceBadge({ level }: { level: "high" | "medium" | "low" }) {
  const map = {
    high: { label: "読み取り精度：高", cls: "bg-green-100 text-green-700" },
    medium: { label: "読み取り精度：中", cls: "bg-yellow-100 text-yellow-700" },
    low: { label: "読み取り精度：低", cls: "bg-red-100 text-red-700" },
  };
  const { label, cls } = map[level];
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>{label}</span>;
}

export default function RestorationPage() {
  const [estimateFile, setEstimateFile] = useState<UploadedFile | null>(null);
  const [propertyFile, setPropertyFile] = useState<UploadedFile | null>(null);
  const [isHighRisk, setIsHighRisk] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RestorationAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const canAnalyze = (estimateFile || propertyFile) && !loading;

  const handleAnalyze = async () => {
    if (!canAnalyze) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const fd = new FormData();
      if (estimateFile) fd.append("estimate", estimateFile.file);
      if (propertyFile) fd.append("property", propertyFile.file);
      fd.append("isHighRisk", String(isHighRisk));

      const res = await fetch("/api/restoration", { method: "POST", body: fd });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "解析に失敗しました");
        return;
      }
      setResult(data as RestorationAnalysis);
    } catch {
      setError("通信エラーが発生しました。もう一度お試しください。");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = useCallback(() => {
    if (!result) return;
    const lines = [
      "【原状回復費用 社内共有判定】",
      result.propertyAddress ? `物件：${result.propertyAddress}` : "",
      result.size ? `面積：${result.size}㎡（${result.judgment?.category ?? ""}）` : "面積：不明",
      result.cost ? `請求金額：${formatYen(result.cost)}` : "金額：不明",
      isHighRisk ? "⚠️ 高額・トラブル案件フラグあり" : "",
      "",
      result.judgment
        ? `判定結果：${result.judgment.needsShare ? "✅ 社内共有が必要" : "⬜ 共有不要"}`
        : "判定結果：情報不足のため判定不可",
      result.judgment ? `理由：${result.judgment.reason}` : "",
      result.costBreakdown ? `\n内訳：\n${result.costBreakdown}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    navigator.clipboard.writeText(lines).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [result, isHighRisk]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-3">
        <Link href="/" className="text-gray-400 hover:text-gray-600 text-sm">
          ← TOP
        </Link>
        <h1 className="text-xl font-bold">🏠 原状回復費用 社内共有判定ツール</h1>
      </header>

      <main className="max-w-2xl mx-auto p-6 space-y-5">

        {/* ルール早見表 */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <p className="text-xs font-semibold text-blue-700 mb-2">社内共有ライン（たたき案）</p>
          <div className="grid grid-cols-3 gap-2 text-sm text-center">
            {[
              { range: "30㎡未満", note: "単身タイプ", threshold: "15万円以上" },
              { range: "30〜50㎡", note: "", threshold: "20万円以上" },
              { range: "50㎡以上", note: "", threshold: "30万円以上" },
            ].map((r) => (
              <div key={r.range} className="bg-white rounded-lg p-2 border border-blue-100">
                <div className="text-xs text-gray-500">{r.range}</div>
                {r.note && <div className="text-xs text-gray-400">{r.note}</div>}
                <div className="font-bold text-blue-700 mt-0.5">{r.threshold}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-blue-500 mt-2">
            ※ 高額請求・トラブル案件は金額に関わらず共有対象
          </p>
        </div>

        {/* ファイルアップロード */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <h2 className="font-semibold text-gray-700">書類をアップロード</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FileDropZone
              label="見積書・請求書"
              icon="🧾"
              description="原状回復工事の見積書や請求書（PDF）"
              file={estimateFile}
              onFile={setEstimateFile}
            />
            <FileDropZone
              label="募集図面・契約書"
              icon="📐"
              description="平米数が記載された図面や賃貸借契約書（PDF）"
              file={propertyFile}
              onFile={setPropertyFile}
            />
          </div>

          <p className="text-xs text-gray-400">
            どちらか一方のみでも解析できます。両方あるとより正確な判定が可能です。
          </p>

          {/* 高額・トラブルフラグ */}
          <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isHighRisk}
              onChange={(e) => setIsHighRisk(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-orange-500"
            />
            <div>
              <span className="font-medium text-gray-700 text-sm">
                ⚠️ 高額請求・トラブル化の可能性がある案件
              </span>
              <p className="text-xs text-gray-400">
                チェックすると金額に関わらず「社内共有が必要」と判定されます
              </p>
            </div>
          </label>

          <button
            onClick={handleAnalyze}
            disabled={!canAnalyze}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 text-white font-semibold py-3 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <span className="animate-spin">⏳</span> AIが解析中...
              </>
            ) : (
              "AIで解析・判定する"
            )}
          </button>
        </div>

        {/* エラー */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700 text-sm">
            ❌ {error}
          </div>
        )}

        {/* 判定結果 */}
        {result && (
          <div className="space-y-4">
            {/* 判定メイン */}
            {result.judgment ? (
              <div
                className={`rounded-xl border-2 p-5 ${
                  result.judgment.needsShare
                    ? "bg-red-50 border-red-300"
                    : "bg-green-50 border-green-300"
                }`}
              >
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <span className="text-4xl">
                      {result.judgment.needsShare ? "🔴" : "🟢"}
                    </span>
                    <div>
                      <div
                        className={`text-2xl font-bold ${
                          result.judgment.needsShare ? "text-red-700" : "text-green-700"
                        }`}
                      >
                        {result.judgment.needsShare ? "社内共有が必要" : "共有不要"}
                      </div>
                      <div className="text-sm text-gray-500">{result.judgment.category}</div>
                    </div>
                  </div>
                  <button
                    onClick={handleCopy}
                    className="text-sm border border-gray-300 bg-white hover:bg-gray-50 px-3 py-1.5 rounded-lg text-gray-600 transition-colors"
                  >
                    {copied ? "✅ コピー済み" : "📋 コピー"}
                  </button>
                </div>

                <div className="bg-white rounded-lg p-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">請求金額</span>
                    <span className="font-semibold">
                      {result.cost ? formatYen(result.cost) : "—"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">社内共有ライン</span>
                    <span className="font-semibold">
                      {formatYen(result.judgment.threshold)}
                    </span>
                  </div>
                  {!isHighRisk && (
                    <div className="flex justify-between border-t border-gray-100 pt-2">
                      <span className="text-gray-500">差額</span>
                      <span
                        className={`font-bold ${
                          result.judgment.diff >= 0 ? "text-red-600" : "text-green-600"
                        }`}
                      >
                        {result.judgment.diff >= 0 ? "+" : ""}
                        {formatYen(result.judgment.diff)}
                      </span>
                    </div>
                  )}
                </div>

                <p className="mt-3 text-sm text-gray-600">{result.judgment.reason}</p>

                {isHighRisk && (
                  <div className="mt-2 flex items-center gap-2 text-sm text-orange-700 bg-orange-50 rounded-lg px-3 py-2">
                    <span>⚠️</span>
                    <span>高額・トラブル案件フラグが立っています</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-5">
                <div className="flex items-center gap-2 text-yellow-800 font-semibold mb-2">
                  <span>⚠️</span> 判定に必要な情報が不足しています
                </div>
                <p className="text-sm text-yellow-700">
                  {!result.size && !result.cost
                    ? "面積・金額ともに読み取れませんでした。"
                    : !result.size
                    ? "面積が読み取れませんでした。募集図面や契約書も添付してください。"
                    : "金額が読み取れませんでした。見積書・請求書も添付してください。"}
                </p>
              </div>
            )}

            {/* 抽出情報詳細 */}
            <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-gray-700">AIが読み取った情報</h3>
                <ConfidenceBadge level={result.confidence} />
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-xs text-gray-400 mb-1">専有面積</div>
                  <div className="font-semibold text-gray-800">
                    {result.size ? `${result.size} ㎡` : "読み取り不可"}
                  </div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-xs text-gray-400 mb-1">請求金額（税込）</div>
                  <div className="font-semibold text-gray-800">
                    {result.cost ? formatYen(result.cost) : "読み取り不可"}
                  </div>
                </div>
                {result.propertyAddress && (
                  <div className="bg-gray-50 rounded-lg p-3 col-span-2">
                    <div className="text-xs text-gray-400 mb-1">物件所在地</div>
                    <div className="font-semibold text-gray-800">{result.propertyAddress}</div>
                  </div>
                )}
                {result.propertyType && (
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-1">部屋タイプ</div>
                    <div className="font-semibold text-gray-800">{result.propertyType}</div>
                  </div>
                )}
              </div>

              {result.costBreakdown && (
                <div>
                  <div className="text-xs font-medium text-gray-500 mb-1">費用内訳（要約）</div>
                  <div className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3 whitespace-pre-wrap">
                    {result.costBreakdown}
                  </div>
                </div>
              )}

              <div>
                <div className="text-xs font-medium text-gray-500 mb-1">書類の概要</div>
                <div className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3">
                  {result.rawSummary}
                </div>
              </div>

              {result.warnings.length > 0 && (
                <div className="bg-orange-50 rounded-lg p-3">
                  <div className="text-xs font-medium text-orange-700 mb-1">⚠️ 注意事項</div>
                  <ul className="text-sm text-orange-700 space-y-1">
                    {result.warnings.map((w, i) => (
                      <li key={i}>• {w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
