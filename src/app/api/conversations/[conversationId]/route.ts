import { NextResponse, type NextRequest } from "next/server";
import { deleteConversation } from "@/lib/db";

// Next.js 16: params es Promise y hay que await-earlo.
interface Ctx {
  params: Promise<{ conversationId: string }>;
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { conversationId } = await params;
    const id = Number(conversationId);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "conversationId inválido" }, { status: 400 });
    }
    await deleteConversation(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
