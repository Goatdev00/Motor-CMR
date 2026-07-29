import { NextResponse, type NextRequest } from "next/server";
import { deleteConversation, getConversationById } from "@/lib/db";
import { requireMember } from "@/lib/auth";

// Next.js 16: params es Promise y hay que await-earlo.
interface Ctx {
  params: Promise<{ conversationId: string }>;
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const auth = await requireMember(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.orgId;

    const { conversationId } = await params;
    const id = Number(conversationId);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "conversationId inválido" }, { status: 400 });
    }
    const conversation = await getConversationById(id, orgId);
    if (!conversation) {
      return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
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
