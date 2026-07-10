import { NextResponse, type NextRequest } from "next/server";
import { deleteQuickReply } from "@/lib/db";

interface Ctx {
  params: Promise<{ replyId: string }>;
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { replyId } = await params;
    const id = Number(replyId);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "id inválido" }, { status: 400 });
    }

    await deleteQuickReply(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
