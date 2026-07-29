import { NextResponse, type NextRequest } from "next/server";
import {
  createCalendarEvent,
  getConversationById,
  listCalendarEvents,
  listFollowUpsBetween,
  type CalendarEventDraft,
} from "@/lib/db";
import { parseEventInput } from "@/lib/calendar";
import { requireMember } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Rango máximo por consulta: el front pide de a un mes/semana; 400 días
// cubre la vista agenda sin permitir barrer la tabla completa.
const MAX_RANGE_SECONDS = 400 * 86400;

function errorResponse(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : "Error desconocido";
  // FK de conversation_id: el lead se borró entre abrir el modal y guardar.
  // Es un error de datos del cliente (400), no de infraestructura.
  if (/foreign key/i.test(message)) {
    return NextResponse.json(
      { error: "El lead vinculado ya no existe. Recarga y elige otro (o guarda sin lead)." },
      { status: 400 }
    );
  }
  const hint = /does not exist|schema cache/i.test(message)
    ? " — Parece que falta la migración del Calendario: re-ejecuta supabase/schema.sql completo en el SQL Editor de Supabase."
    : "";
  return NextResponse.json({ error: message + hint }, { status: 500 });
}

// Eventos + seguimientos programados del CRM dentro de [from, to).
export async function GET(req: NextRequest) {
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;
  const orgId = auth.orgId;
  try {
    const from = Number(req.nextUrl.searchParams.get("from"));
    const to = Number(req.nextUrl.searchParams.get("to"));
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) {
      return NextResponse.json({ error: "Rango from/to inválido" }, { status: 400 });
    }
    if (to - from > MAX_RANGE_SECONDS) {
      return NextResponse.json({ error: "Rango demasiado amplio" }, { status: 400 });
    }
    const [events, followups] = await Promise.all([
      listCalendarEvents(orgId, from, to),
      listFollowUpsBetween(orgId, from, to),
    ]);
    return NextResponse.json({ events, followups });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;
  const orgId = auth.orgId;
  try {
    const body = await req.json().catch(() => null);
    const parsed = parseEventInput(body, false);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const draft = parsed.draft as CalendarEventDraft;
    // Guarda multi-org: el lead vinculado debe ser de ESTA organización.
    if (draft.conversation_id != null) {
      const convo = await getConversationById(draft.conversation_id, orgId);
      if (!convo) {
        return NextResponse.json({ error: "Lead no encontrado" }, { status: 404 });
      }
    }
    const event = await createCalendarEvent(orgId, draft);
    return NextResponse.json({ event });
  } catch (err) {
    return errorResponse(err);
  }
}
