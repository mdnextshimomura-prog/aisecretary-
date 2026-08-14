"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// 社内向け画面のログインフォーム。
// Basic認証だとアプリ内ブラウザでログイン窓が出ず入れなかったため、
// 通常のフォームにしてある（スマホからも使える）。

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";

  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, password }),
      });
      if (res.ok) {
        // Cookieが付いた状態で本来行きたかった画面へ
        router.replace(next);
        router.refresh();
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "ログインに失敗しました");
    } catch {
      setError("通信に失敗しました。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-100 p-8 flex flex-col gap-5"
      >
        <div className="text-center">
          <div className="text-3xl mb-2">🔐</div>
          <h1 className="text-xl font-bold">MD NEXT AI秘書</h1>
          <p className="text-sm text-gray-500 mt-1">社内向け画面です</p>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-gray-700">ID</span>
          <input
            type="text"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            required
            className="border border-gray-300 rounded-lg px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-gray-700">パスワード</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            className="border border-gray-300 rounded-lg px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white rounded-lg px-4 py-2.5 font-semibold transition-colors"
        >
          {busy ? "確認中…" : "ログイン"}
        </button>
      </form>
    </main>
  );
}

export default function LoginPage() {
  // useSearchParams はSuspense境界が要る（ビルド時のプリレンダで落ちるため）
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
