"use client";

import { useState } from "react";

// コピペで使える雛形ブロック（クリックでクリップボードにコピー）。
// スタイルは page.tsx 側の #hisho スコープCSS（.tpl 系）を使う。
export default function CopyBlock({
  items,
}: {
  items: { label: string; code: string }[];
}) {
  const [copied, setCopied] = useState<number | null>(null);

  const copy = async (text: string, i: number) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // クリップボードAPIが使えない環境向けのフォールバック
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* noop */
      }
      document.body.removeChild(ta);
    }
    setCopied(i);
    window.setTimeout(() => setCopied((c) => (c === i ? null : c)), 1600);
  };

  return (
    <div className="tpl">
      {items.map((t, i) => (
        <div className="tpl-item" key={i}>
          <div className="tpl-head">
            <span className="tpl-lbl">{t.label}</span>
            <button
              type="button"
              className={`copy-btn${copied === i ? " done" : ""}`}
              onClick={() => copy(t.code, i)}
              aria-label={`「${t.label}」の雛形をコピー`}
            >
              {copied === i ? "✓ コピーしました" : "コピー"}
            </button>
          </div>
          <pre className="tpl-code">
            <code>{t.code}</code>
          </pre>
        </div>
      ))}
    </div>
  );
}
