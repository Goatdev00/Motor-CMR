import { NextResponse, type NextRequest } from "next/server";
import {
  ALARM_KINDS,
  ALARM_REPEATS,
  deleteAlarm,
  getAlarmById,
  getConversationById,
  updateAlarm,
  type AlarmDraft,
  type AlarmKind,
  type AlarmRepeat,
} from "@/lib/db";
import { requireMember } from "@/lib/auth";

export const dynamic = "force-dynamic";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;
  const orgId = auth.orgId;
  try {
    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: "id inválido" }, { status: 400 });

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "body inválido" }, { status: 400 });

    const patch: Partial<AlarmDraft> & { active?: boolean } = {};

    if (body.title !== undefined) {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title || title.length > 120) {
        return NextResponse.json({ error: "Título inválido (1 a 120 caracteres)" }, { status: 400 });
      }
      patch.title = title;
    }
    if (body.message !== undefined) {
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message || message.length > 2000) {
        return NextResponse.json({ error: "Mensaje inválido (1 a 2000 caracteres)" }, { status: 400 });
      }
      patch.message = message;
    }
    if (body.kind !== undefined) {
      if (!ALARM_KINDS.includes(body.kind as AlarmKind)) {
        return NextResponse.json({ error: "Tipo inválido" }, { status: 400 });
      }
      patch.kind = body.kind as AlarmKind;
    }
    // El canal siempre viaja junto a su destino (el modal manda todo).
    if (body.via !== undefined) {
      const via = body.via as "whatsapp" | "email";
      if (via !== "whatsapp" && via !== "email") {
        return NextResponse.json({ error: "Canal inválido" }, { status: 400 });
      }
      patch.via = via;
      if (via === "whatsapp") {
        const digits = typeof body.to_phone === "string" ? body.to_phone.replace(/[\s\-+().]/g, "") : "";
        if (!/^\d{7,15}$/.test(digits)) {
          return NextResponse.json(
            { error: "Teléfono inválido (solo dígitos, con indicativo de país)" },
            { status: 400 }
          );
        }
        patch.to_phone = digits;
        patch.to_email = null;
      } else {
        const email = typeof body.to_email === "string" ? body.to_email.trim() : "";
        if (!EMAIL_REGEX.test(email) || email.length > 200) {
          return NextResponse.json({ error: "Correo inválido" }, { status: 400 });
        }
        patch.to_email = email;
        patch.to_phone = null;
      }
    }
    if (body.next_fire_at !== undefined) {
      const v = Number(body.next_fire_at);
      if (!Number.isInteger(v) || v <= 0 || v > 32503680000) {
        return NextResponse.json({ error: "Fecha de disparo inválida" }, { status: 400 });
      }
      patch.next_fire_at = v;
    }
    if (body.repeat_every !== undefined) {
      if (!ALARM_REPEATS.includes(body.repeat_every as AlarmRepeat)) {
        return NextResponse.json({ error: "Recurrencia inválida" }, { status: 400 });
      }
      patch.repeat_every = body.repeat_every as AlarmRepeat;
    }
    if (body.conversation_id !== undefined) {
      if (body.conversation_id === null || body.conversation_id === "") {
        patch.conversation_id = null;
      } else {
        const v = Number(body.conversation_id);
        if (!Number.isInteger(v) || v <= 0) {
          return NextResponse.json({ error: "Lead inválido" }, { status: 400 });
        }
        // Guarda multi-org: el lead vinculado debe ser de la organización del usuario.
        const convo = await getConversationById(v, orgId);
        if (!convo) {
          return NextResponse.json({ error: "Lead no encontrado" }, { status: 404 });
        }
        patch.conversation_id = v;
      }
    }
    if (body.active !== undefined) {
      if (typeof body.active !== "boolean") {
        return NextResponse.json({ error: "active inválido" }, { status: 400 });
      }
      patch.active = body.active;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nada que actualizar" }, { status: 400 });
    }

    // Re-armar una alarma de un solo disparo con la fecha ya vencida haría
    // que el bot la re-enviara en ≤2s (aviso duplicado al cliente sin que
    // el operador lo espere).
    if (patch.active === true) {
      const current = await getAlarmById(id, orgId);
      if (!current) return NextResponse.json({ error: "Alarma no encontrada" }, { status: 404 });
      const effRepeat = patch.repeat_every ?? current.repeat_every;
      const effNext = patch.next_fire_at ?? current.next_fire_at;
      if (effRepeat === "NUNCA" && effNext <= Math.floor(Date.now() / 1000)) {
        return NextResponse.json(
          { error: "Esta alarma de un solo disparo ya pasó: ponle una fecha futura antes de reactivarla" },
          { status: 400 }
        );
      }
    }

    const alarm = await updateAlarm(id, patch, orgId);
    if (!alarm) return NextResponse.json({ error: "Alarma no encontrada" }, { status: 404 });
    return NextResponse.json({ ok: true, alarm });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    if (/foreign key/i.test(message)) {
      return NextResponse.json({ error: "El lead vinculado ya no existe" }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;
  const orgId = auth.orgId;
  try {
    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: "id inválido" }, { status: 400 });
    await deleteAlarm(id, orgId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
