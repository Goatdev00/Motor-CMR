import { NextResponse, type NextRequest } from "next/server";
import {
  assignLead,
  getConversationById,
  getLeadEvents,
  getLeadNotes,
  setStage,
  updateLeadFields,
  LEAD_STAGES,
  type LeadPatch,
  type LeadStage,
} from "@/lib/db";
import { requireMember } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ conversationId: string }>;
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Ficha completa del lead: datos + notas internas + historial de actividad.
export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    const auth = await requireMember(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.orgId;

    const { conversationId } = await params;
    const id = parseId(conversationId);
    if (!id) return NextResponse.json({ error: "id inválido" }, { status: 400 });

    const lead = await getConversationById(id, orgId);
    if (!lead) return NextResponse.json({ error: "Lead no encontrado" }, { status: 404 });

    const [notes, events] = await Promise.all([getLeadNotes(id), getLeadEvents(id)]);
    return NextResponse.json({ lead, notes, events });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}

// Edición del lead: etapa (con evento) y/o campos de la ficha (whitelist).
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const auth = await requireMember(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.orgId;

    const { conversationId } = await params;
    const id = parseId(conversationId);
    if (!id) return NextResponse.json({ error: "id inválido" }, { status: 400 });

    const existing = await getConversationById(id, orgId);
    if (!existing) return NextResponse.json({ error: "Lead no encontrado" }, { status: 404 });

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "body inválido" }, { status: 400 });

    if (body.stage !== undefined) {
      if (!LEAD_STAGES.includes(body.stage as LeadStage)) {
        return NextResponse.json({ error: "stage inválido" }, { status: 400 });
      }
      // Si el guardado también trae asignación manual, el enrutamiento por
      // etapa se apaga: sin esto, el vendedor de la regla recibía un aviso
      // de WhatsApp por una asignación que se pisa una línea más abajo.
      await setStage(id, body.stage as LeadStage, body.assigned_member_id === undefined);
    }

    // Asignación manual a un miembro del equipo (null = sin asignar).
    // Va DESPUÉS de setStage: si el operador cambia etapa y asignado en el
    // mismo guardado, su elección manual pisa la regla de enrutamiento.
    if (body.assigned_member_id !== undefined) {
      let memberId: number | null = null;
      if (body.assigned_member_id !== null && body.assigned_member_id !== "") {
        const v = Number(body.assigned_member_id);
        if (!Number.isInteger(v) || v <= 0) {
          return NextResponse.json({ error: "Miembro inválido" }, { status: 400 });
        }
        memberId = v;
      }
      try {
        await assignLead(id, memberId, "asignación manual");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (/no existe/i.test(msg)) {
          return NextResponse.json({ error: "El miembro seleccionado ya no existe" }, { status: 400 });
        }
        throw err;
      }
    }

    const patch: LeadPatch = {};
    if (body.name !== undefined) {
      patch.name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
    }
    if (body.deal_value !== undefined) {
      if (body.deal_value === null || body.deal_value === "") {
        patch.deal_value = null;
      } else {
        const v = Number(body.deal_value);
        // Un NaN silencioso o un negativo corrompen los KPIs del pipeline.
        if (!Number.isFinite(v) || v < 0 || v > 1e12) {
          return NextResponse.json(
            { error: "deal_value inválido (debe ser un número positivo)" },
            { status: 400 }
          );
        }
        patch.deal_value = v;
      }
    }
    if (body.company !== undefined) {
      patch.company =
        typeof body.company === "string" && body.company.trim() ? body.company.trim() : null;
    }
    if (body.email !== undefined) {
      patch.email = typeof body.email === "string" && body.email.trim() ? body.email.trim() : null;
    }
    if (body.tags !== undefined) {
      patch.tags = Array.isArray(body.tags)
        ? body.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim())
        : [];
    }

    const lead = await updateLeadFields(id, patch);
    return NextResponse.json({ ok: true, lead });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
