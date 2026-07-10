import { NextResponse, type NextRequest } from "next/server";
import {
  getConversationById,
  getMessages,
  insertHumanMessage,
} from "@/lib/db";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ conversationId: string }>;
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Devuelve la conversación (incluye mode, para mantener el toggle en sync)
// y sus mensajes. El dashboard lo pollea cada 2s.
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { conversationId } = await params;
    const id = parseId(conversationId);
    if (!id) {
      return NextResponse.json({ error: "conversationId inválido" }, { status: 400 });
    }

    const conversation = await getConversationById(id);
    if (!conversation) {
      return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
    }

    const messages = await getMessages(id, 50);
    return NextResponse.json({ conversation, messages });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}

// Mensaje humano desde el dashboard: la RPC insert_human_message guarda el
// mensaje (visible al instante) Y lo encola en outbox atómicamente; el
// proceso bot lo envía por Baileys en ≤2s.
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { conversationId } = await params;
    const id = parseId(conversationId);
    if (!id) {
      return NextResponse.json({ error: "conversationId inválido" }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as { content?: unknown } | null;
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) {
      return NextResponse.json({ error: "content requerido" }, { status: 400 });
    }

    const conversation = await getConversationById(id);
    if (!conversation) {
      return NextResponse.json({ error: "Conversación no encontrada" }, { status: 404 });
    }
    // Los leads del canal 'api' (inyectados por otra app, sin teléfono) no
    // tienen por dónde recibir mensajes: mejor un error claro que encolar
    // un envío imposible.
    if (conversation.channel === "api") {
      return NextResponse.json(
        { error: "Este lead llegó por la API sin teléfono: no tiene canal de respuesta. Contáctalo por correo o agrega su WhatsApp." },
        { status: 400 }
      );
    }

    const message = await insertHumanMessage(id, content);

    return NextResponse.json({ ok: true, messageId: message.id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
