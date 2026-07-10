import { NextResponse, type NextRequest } from "next/server";
import { addLeadNote, getConversationById } from "@/lib/db";

interface Ctx {
  params: Promise<{ conversationId: string }>;
}

// Nota interna del lead (solo visible en el dashboard, nunca se envía).
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { conversationId } = await params;
    const id = Number(conversationId);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "id inválido" }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as { content?: unknown } | null;
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) return NextResponse.json({ error: "content requerido" }, { status: 400 });

    const lead = await getConversationById(id);
    if (!lead) return NextResponse.json({ error: "Lead no encontrado" }, { status: 404 });

    const note = await addLeadNote(id, content);
    return NextResponse.json({ ok: true, note });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
