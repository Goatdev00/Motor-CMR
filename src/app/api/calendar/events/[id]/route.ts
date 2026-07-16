import { NextResponse, type NextRequest } from "next/server";
import { deleteCalendarEvent, updateCalendarEvent } from "@/lib/db";
import { parseEventInput } from "@/lib/calendar";
import { requireMember } from "@/lib/auth";

export const dynamic = "force-dynamic";

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;
  const orgId = auth.orgId;
  try {
    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: "id inválido" }, { status: 400 });

    const body = await req.json().catch(() => null);
    const parsed = parseEventInput(body, true);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    if (Object.keys(parsed.draft).length === 0) {
      return NextResponse.json({ error: "Nada que actualizar" }, { status: 400 });
    }

    const event = await updateCalendarEvent(id, parsed.draft, orgId);
    if (!event) return NextResponse.json({ error: "Evento no encontrado" }, { status: 404 });
    return NextResponse.json({ event });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    // El lead vinculado se borró mientras el modal estaba abierto.
    if (/foreign key/i.test(message)) {
      return NextResponse.json(
        { error: "El lead vinculado ya no existe. Recarga y elige otro (o guarda sin lead)." },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;
  const orgId = auth.orgId;
  try {
    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: "id inválido" }, { status: 400 });
    await deleteCalendarEvent(id, orgId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
