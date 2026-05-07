import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 p-8">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-2">📱 LINE秘書アプリ</h1>
        <p className="text-gray-500 text-lg">
          LINEのメッセージをAIが解析してタスク・スケジュールを自動登録
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-3xl w-full">
        <FeatureCard
          emoji="🤖"
          title="AI自動解析"
          desc="Claude AIがメッセージからタスク情報を自動抽出"
        />
        <FeatureCard
          emoji="📋"
          title="Notion連携"
          desc="タスクをNotionデータベースに自動登録"
        />
        <FeatureCard
          emoji="📅"
          title="カレンダー連携"
          desc="期日付きタスクをGoogleカレンダーに自動追加"
        />
      </div>

      <Link
        href="/dashboard"
        className="bg-green-500 hover:bg-green-600 text-white px-8 py-3 rounded-lg font-semibold text-lg transition-colors"
      >
        管理画面を開く →
      </Link>

      <div className="text-sm text-gray-400 text-center max-w-md">
        <p>Webhook URL: <code className="bg-gray-100 px-2 py-1 rounded">/api/webhook</code></p>
        <p className="mt-1">Vercel Cron: 毎朝8時にリマインド送信</p>
      </div>
    </main>
  );
}

function FeatureCard({
  emoji,
  title,
  desc,
}: {
  emoji: string;
  title: string;
  desc: string;
}) {
  return (
    <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100 text-center">
      <div className="text-3xl mb-3">{emoji}</div>
      <h3 className="font-semibold mb-1">{title}</h3>
      <p className="text-sm text-gray-500">{desc}</p>
    </div>
  );
}
