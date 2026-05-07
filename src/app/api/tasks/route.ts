import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function GET(): Promise<NextResponse> {
  const tasks = await prisma.task.findMany({
    orderBy: [
      { status: "asc" },
      { dueDate: "asc" },
      { createdAt: "desc" },
    ],
  });
  return NextResponse.json(tasks);
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const { id, status } = await req.json();

  if (!id || !status) {
    return NextResponse.json({ error: "id and status are required" }, { status: 400 });
  }

  const updated = await prisma.task.update({
    where: { id },
    data: { status },
  });

  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  await prisma.task.delete({ where: { id } });
  return NextResponse.json({ status: "deleted" });
}
