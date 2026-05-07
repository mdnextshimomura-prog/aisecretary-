import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LINE秘書アプリ",
  description: "LINEメッセージをAIが解析してタスク・スケジュール管理",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body className="bg-gray-50 text-gray-900 antialiased">{children}</body>
    </html>
  );
}
