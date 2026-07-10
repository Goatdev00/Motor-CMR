import { NextResponse, type NextRequest } from "next/server";
import {
  ALARM_KINDS,
  ALARM_REPEATS,
  createAlarm,
  listAlarms,
  type AlarmDraft,
  type AlarmKind,
  type AlarmRepeat,
} from "@/lib/db";

export const dynamic = "force-dynamic";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function migrationHint(message: string): string {
  return /does not exist|schema cache/i.test(message)
    ? message +
        " — Parece que falta la migración de Alarmas: re-ejecuta supabase/schema.sql completo en el SQL Editor de Supabase."
    : message;
}

// Todas las alarmas (activas primero, luego por fecha de disparo).
export async function GET() {
  try {
    const alarms = await listAlarms();
    return NextResponse.json({ alarms });
  } catch (err) {
    return NextResponse.json(
      { error: migrationHint(err instanceof Error ? err.message : "Error desconocido") },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "body inválido" }, { status: 400 });

    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 120) {
      return NextResponse.json({ error: "Título requerido (1 a 120 caracteres)" }, { status: 400 });
    }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message || message.length > 2000) {
      return NextResponse.json({ error: "Mensaje requerido (1 a 2000 caracteres)" }, { status: 400 });
    }
    const kind = (body.kind ?? "OTRO") as AlarmKind;
    if (!ALARM_KINDS.includes(kind)) {
      return NextResponse.json({ error: "Tipo inválido" }, { status: 400 });
    }
    const via = body.via as "whatsapp" | "email";
    if (via !== "whatsapp" && via !== "email") {
      return NextResponse.json({ error: "Canal inválido (whatsapp o email)" }, { status: 400 });
    }

    let toPhone: string | null = null;
    let toEmail: string | null = null;
    if (via === "whatsapp") {
      const digits = typeof body.to_phone === "string" ? body.to_phone.replace(/[\s\-+().]/g, "") : "";
      if (!/^\d{7,15}$/.test(digits)) {
        return NextResponse.json(
          { error: "Teléfono inválido (solo dígitos, con indicativo de país)" },
          { status: 400 }
        );
      }
      toPhone = digits;
    } else {
      const email = typeof body.to_email === "string" ? body.to_email.trim() : "";
      if (!EMAIL_REGEX.test(email) || email.length > 200) {
        return NextResponse.json({ error: "Correo inválido" }, { status: 400 });
      }
      toEmail = email;
    }

    const nextFireAt = Number(body.next_fire_at);
    if (!Number.isInteger(nextFireAt) || nextFireAt <= 0 || nextFireAt > 32503680000) {
      return NextResponse.json({ error: "Fecha de disparo inválida" }, { status: 400 });
    }
    const repeat = (body.repeat_every ?? "NUNCA") as AlarmRepeat;
    if (!ALARM_REPEATS.includes(repeat)) {
      return NextResponse.json({ error: "Recurrencia inválida" }, { status: 400 });
    }

    let conversationId: number | null = null;
    if (body.conversation_id !== undefined && body.conversation_id !== null && body.conversation_id !== "") {
      const v = Number(body.conversation_id);
      if (!Number.isInteger(v) || v <= 0) {
        return NextResponse.json({ error: "Lead inválido" }, { status: 400 });
      }
      conversationId = v;
    }

    const draft: AlarmDraft = {
      title,
      message,
      kind,
      via,
      to_phone: toPhone,
      to_email: toEmail,
      conversation_id: conversationId,
      next_fire_at: nextFireAt,
      repeat_every: repeat,
    };
    const alarm = await createAlarm(draft);
    return NextResponse.json({ ok: true, alarm });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    if (/foreign key/i.test(message)) {
      return NextResponse.json({ error: "El lead vinculado ya no existe" }, { status: 400 });
    }
    return NextResponse.json({ error: migrationHint(message) }, { status: 500 });
  }
}
