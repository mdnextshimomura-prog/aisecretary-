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
  notionId: string | null;
  calendarId: string | null;
  createdAt: string;
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

export default function Dashboard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("全て");

  useEffect(() => {
    fetchTasks();
  }, []);

  async function fetchTasks() {
    setLoading(true);
    const res = await fetch("/api/tasks");
    const data = await res.json();
    setTasks(data);
    setLoading(false);
  }

  async function updateStatus(id: string, status: string) {
    await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status } : t))
    );
  }

  async function deleteTask(id: string) {
    if (!confirm("このタスクを削除しますか？")) return;
    await fetch(`/api/tasks?id=${id}`, { method: "DELETE" });
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  const displayed =
    filter === "全て" ? tasks : tasks.filter((t) => t.status === filter);

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
}: {
  task: Task;
  onStatusChange: (id: string, status: string) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
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
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-400">
            {task.dueDate && (
              <span>📅 {formatDate(task.dueDate)}</span>
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
          {task.notionId && (
            <a
              href={`https://notion.so/${task.notionId.replace(/-/g, "")}`}
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
