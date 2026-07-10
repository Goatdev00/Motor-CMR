import { NextResponse, type NextRequest } from "next/server";
import { cancelFollowUp, getConversationById, scheduleFollowUp } from "@/lib/db";

interface Ctx {
  params: Promise<{ conversationId: string }>;
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Programa un seguimiento automático: el BOT envía el mensaje por WhatsApp
// a la hora indicada (aunque el dashboard esté cerrado). Uno activo por lead.
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { conversationId } = await params;
    const id = parseId(conversationId);
    if (!id) return NextResponse.json({ error: "id inválido" }, { status: 400 });

    const body = (await req.json().catch(() => null)) as
      | { content?: unknown; sendAt?: unknown }
      | null;
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    const sendAt = Number(body?.sendAt);
    if (!content) return NextResponse.json({ error: "content requerido" }, { status: 400 });
    if (!Number.isFinite(sendAt) || sendAt <= 0) {
      return NextResponse.json({ error: "sendAt (epoch en segundos) requerido" }, { status: 400 });
    }
    if (sendAt <= Math.floor(Date.now() / 1000)) {
      return NextResponse.json({ error: "sendAt debe ser una hora futura" }, { status: 400 });
    }

    const lead = await getConversationById(id);
    if (!lead) return NextResponse.json({ error: "Lead no encontrado" }, { status: 404 });
    // Un lead del canal 'api' (inyectado sin teléfono) no tiene por dónde
    // recibir el seguimiento: encolarlo crearía un envío imposible que
    // jamás sale y sin error visible.
    if (lead.channel === "api") {
      return NextResponse.json(
        { error: "Este lead llegó por la API sin teléfono: no se le pueden programar seguimientos de WhatsApp. Usa una alarma por correo." },
        { status: 400 }
      );
    }

    await scheduleFollowUp(id, content, Math.floor(sendAt));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { conversationId } = await params;
    const id = parseId(conversationId);
    if (!id) return NextResponse.json({ error: "id inválido" }, { status: 400 });

    const lead = await getConversationById(id);
    if (!lead) return NextResponse.json({ error: "Lead no encontrado" }, { status: 404 });

    await cancelFollowUp(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
