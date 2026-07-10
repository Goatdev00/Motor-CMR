import { NextResponse, type NextRequest } from "next/server";
import { getConversationById, setMode, type ConversationMode } from "@/lib/db";

interface Ctx {
  params: Promise<{ conversationId: string }>;
}

export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { conversationId } = await params;
    const id = Number(conversationId);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "conversationId inválido" }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as { mode?: unknown } | null;
    const mode = body?.mode;
    if (mode !== "AI" && mode !== "HUMAN") {
      return NextResponse.json({ error: "mode debe ser 'AI' o 'HUMAN'" }, { status: 400 });
    }

    const conversation = await getConversationById(id);
    if (!conversation) {
      return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
    }

    await setMode(id, mode as ConversationMode);
    return NextResponse.json({ ok: true, mode });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
