"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Task {
  id: string;
  title: string;
  category: string;
  urgency: string;
  dueDate: string | null;
  assignee: string | null;
  status: string;
  rawMessage: string;
  createdAt: string;
  url: string; // Notionページへのリンク
  propertyName: string | null;
  propertyKey: string | null; // 表記ゆれを吸収した照合キー。同じ物件をまとめるのに使う
}

const STATUS_OPTIONS = ["未着手", "進行中", "完了"];
const STATUS_COLORS: Record<string, string> = {
  未着手: "bg-gray-100 text-gray-700",
  進行中: "bg-blue-100 text-blue-700",
  完了: "bg-green-100 text-green-700",
};
const URGENCY_COLORS: Record<string, string> = {
  今日中: "bg-red-100 text-red-700",
  今週中: "bg-yellow-100 text-yellow-700",
  来週以降: "bg-gray-100 text-gray-600",
};

// JST基準の今日。期限超過の判定に使う（UTCのままだと朝9時まで前日扱いになる）
function jstToday(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
// 期日は時刻付き（"2026-08-02T15:00:00+09:00"）で入ることがあるので日付だけで比べる
function isOverdue(task: Task): boolean {
  if (!task.dueDate || task.status === "完了") return false;
  return task.dueDate.slice(0, 10) < jstToday();
}

export default function Dashboard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("全て");
  const [propertyFilter, setPropertyFilter] = useState<string | null>(null);

  useEffect(() => {
    fetchTasks();
  }, []);

  async function fetchTasks() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tasks");
      const data = await res.json();
      // 失敗時は配列ではなくエラーJSONが返る。そのまま入れると描画時に落ちる
      if (!res.ok || !Array.isArray(data)) {
        setError((data as { error?: string })?.error ?? "タスクを取得できませんでした");
        setTasks([]);
        return;
      }
      setTasks(data);
    } catch {
      setError("通信に失敗しました");
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }

  async function updateStatus(id: string, status: string) {
    const prev = tasks;
    // 先に画面を更新し、失敗したら戻す（Notionへの往復を待たせない）
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, status } : t)));
    const res = await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    if (!res.ok) {
      setTasks(prev);
      setError("ステータスの更新に失敗しました");
    }
  }

  async function deleteTask(id: string) {
    if (!confirm("このタスクを削除しますか？（Notionからも消えます）")) return;
    const res = await fetch(`/api/tasks?id=${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError("タスクの削除に失敗しました");
      return;
    }
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  // 物件で絞り込む。表記ゆれがあっても同じ物件が並ぶよう、表示名ではなくキーで比べる
  const displayed = tasks
    .filter((t) => (filter === "全て" ? true : t.status === filter))
    .filter((t) => (propertyFilter ? t.propertyKey === propertyFilter : true));

  const propertyLabel =
    tasks.find((t) => t.propertyKey === propertyFilter)?.propertyName ?? "";

  const counts = STATUS_OPTIONS.reduce(
    (acc, s) => ({ ...acc, [s]: tasks.filter((t) => t.status === s).length }),
    {} as Record<string, number>
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-gray-400 hover:text-gray-600 text-sm">
            ← TOP
          </Link>
          <h1 className="text-xl font-bold">📋 タスク管理</h1>
        </div>
        <button
          onClick={fetchTasks}
          className="text-sm text-gray-500 hover:text-gray-700 border border-gray-200 px-3 py-1 rounded"
        >
          🔄 更新
        </button>
      </header>

      <main className="max-w-5xl mx-auto p-6">
        {/* サマリー */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`bg-white rounded-lg p-4 border text-center transition-all ${
                filter === s
                  ? "border-green-400 shadow-sm"
                  : "border-gray-100 hover:border-gray-300"
              }`}
            >
              <div className="text-2xl font-bold">{counts[s] ?? 0}</div>
              <div className="text-sm text-gray-500">{s}</div>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm text-gray-500">フィルター：</span>
          {["全て", ...STATUS_OPTIONS].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-sm px-3 py-1 rounded-full ${
                filter === f
                  ? "bg-green-500 text-white"
                  : "bg-white text-gray-600 border border-gray-200 hover:border-gray-400"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {propertyFilter && (
          <div className="mb-4 flex items-center gap-2 text-sm bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5">
            <span className="text-amber-900">
              🏠 <span className="font-semibold">{propertyLabel}</span> のタスクだけ表示中（
              {displayed.length}件）
            </span>
            <button
              onClick={() => setPropertyFilter(null)}
              className="ml-auto text-amber-700 hover:text-amber-900 underline"
            >
              解除
            </button>
          </div>
        )}

        {error && (
          <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-center py-20 text-gray-400">読み込み中...</div>
        ) : displayed.length === 0 ? (
          <div className="text-center py-20 text-gray-400">
            タスクがありません
          </div>
        ) : (
          <div className="space-y-3">
            {displayed.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onStatusChange={updateStatus}
                onDelete={deleteTask}
                onPropertyClick={setPropertyFilter}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function TaskCard({
  task,
  onStatusChange,
  onDelete,
  onPropertyClick,
}: {
  task: Task;
  onStatusChange: (id: string, status: string) => void;
  onDelete: (id: string) => void;
  onPropertyClick: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const overdue = isOverdue(task);

  return (
    <div
      className={`bg-white rounded-xl border p-4 shadow-sm ${
        overdue ? "border-red-200 bg-red-50/40" : "border-gray-100"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <h3 className="font-semibold truncate">{task.title}</h3>
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${
                URGENCY_COLORS[task.urgency] ?? "bg-gray-100 text-gray-600"
              }`}
            >
              {task.urgency}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
              {task.category}
            </span>
            {task.propertyName && task.propertyKey && (
              <button
                onClick={() => onPropertyClick(task.propertyKey!)}
                title="この物件のタスクだけ表示"
                className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 hover:bg-amber-200 transition-colors"
              >
                🏠 {task.propertyName}
              </button>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-400">
            {task.dueDate && (
              <span className={overdue ? "text-red-600 font-semibold" : ""}>
                📅 {formatDate(task.dueDate)}
                {overdue && "（期限超過）"}
              </span>
            )}
            {task.assignee && <span>👤 {task.assignee}</span>}
            <span>{formatDateTime(task.createdAt)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <select
            value={task.status}
            onChange={(e) => onStatusChange(task.id, e.target.value)}
            className={`text-xs px-2 py-1 rounded-full border-0 outline-none cursor-pointer ${
              STATUS_COLORS[task.status] ?? "bg-gray-100"
            }`}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {task.url && (
            <a
              href={task.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-gray-600 text-sm"
              title="Notionで開く"
            >
              📎
            </a>
          )}
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-gray-400 hover:text-gray-600 text-sm"
          >
            {expanded ? "▲" : "▼"}
          </button>
          <button
            onClick={() => onDelete(task.id)}
            className="text-red-400 hover:text-red-600 text-sm"
          >
            🗑
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-gray-100 text-sm text-gray-600 whitespace-pre-wrap break-words">
          <span className="font-medium text-gray-400 text-xs">元メッセージ：</span>
          <br />
          {task.rawMessage}
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatDateTime(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}
