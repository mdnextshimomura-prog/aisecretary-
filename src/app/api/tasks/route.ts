import { NextRequest, NextResponse } from "next/server";
import { listTasks, setTaskStatus, archiveTask } from "@/lib/notion";

// ダッシュボード用のAPI。
// 以前はPrisma(SQLite)を見ていたが、Vercelのサーバーレスではファイルに書けず
// 中身が常に空・GETは500で落ちていた。永続化はNotionに一本化済みなのでそちらを読む。
// ※ このルートは middleware でログイン必須にしてある。

const STATUS_OPTIONS = ["未着手", "進行中", "完了"];

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await listTasks());
  } catch (err) {
    console.error("タスク一覧の取得エラー:", err);
    return NextResponse.json(
      { error: "タスクの取得に失敗しました" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const { id, status } = (await req.json()) as {
    id?: string;
    status?: string;
  };

  if (!id || !status) {
    return NextResponse.json(
      { error: "id と status は必須です" },
      { status: 400 }
    );
  }
  // Notionのセレクト選択肢に無い値を送ると、Notion側に勝手な選択肢が増えてしまう
  if (!STATUS_OPTIONS.includes(status)) {
    return NextResponse.json(
      { error: `status は ${STATUS_OPTIONS.join(" / ")} のいずれかです` },
      { status: 400 }
    );
  }

  try {
    await setTaskStatus(id, status);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("ステータス更新エラー:", err);
    return NextResponse.json(
      { error: "ステータスの更新に失敗しました" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id は必須です" }, { status: 400 });
  }

  try {
    // Notionページをアーカイブする（LINEの「取り消し」と同じ挙動）
    await archiveTask(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("タスク削除エラー:", err);
    return NextResponse.json(
      { error: "タスクの削除に失敗しました" },
      { status: 500 }
    );
  }
}
