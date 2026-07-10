import { NextResponse, type NextRequest } from "next/server";
import { createTeamMember, listTeamMembers, setMemberPassword, TEAM_ROLES, type TeamRole } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

function migrationHint(message: string): string {
  return /does not exist|schema cache/i.test(message)
    ? message +
        " — Parece que falta la migración de Equipo: re-ejecuta supabase/schema.sql completo en el SQL Editor de Supabase."
    : message;
}

// Teléfono para avisos: solo dígitos con indicativo de país (como los
// números de WhatsApp del resto del sistema). Módulo-privada: Next prohíbe
// exports arbitrarios en archivos de ruta.
function normalizePhoneInput(raw: unknown): string | null | "invalid" {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") return "invalid";
  const digits = raw.replace(/[\s\-+().]/g, "");
  if (!/^\d{7,15}$/.test(digits)) return "invalid";
  return digits;
}

export async function GET() {
  try {
    const members = await listTeamMembers();
    return NextResponse.json({ members });
  } catch (err) {
    return NextResponse.json(
      { error: migrationHint(err instanceof Error ? err.message : "Error desconocido") },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as {
      name?: unknown;
      role?: unknown;
      wa_account_id?: unknown;
      notify_phone?: unknown;
      username?: unknown;
      password?: unknown;
    } | null;

    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 60) {
      return NextResponse.json({ error: "Nombre requerido (1 a 60 caracteres)" }, { status: 400 });
    }
    const role = (body?.role ?? "VENDEDOR") as TeamRole;
    if (!TEAM_ROLES.includes(role)) {
      return NextResponse.json({ error: "Rol inválido" }, { status: 400 });
    }
    let waAccountId: number | null = null;
    if (body?.wa_account_id !== undefined && body.wa_account_id !== null && body.wa_account_id !== "") {
      const v = Number(body.wa_account_id);
      if (!Number.isInteger(v) || v <= 0) {
        return NextResponse.json({ error: "Cuenta inválida" }, { status: 400 });
      }
      waAccountId = v;
    }
    const notifyPhone = normalizePhoneInput(body?.notify_phone ?? null);
    if (notifyPhone === "invalid") {
      return NextResponse.json(
        { error: "Teléfono de avisos inválido (solo dígitos, con indicativo de país)" },
        { status: 400 }
      );
    }

    // Credenciales opcionales al crear (también se pueden agregar después).
    let username: string | null = null;
    if (typeof body?.username === "string" && body.username.trim() !== "") {
      username = body.username.trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
        return NextResponse.json(
          { error: "Usuario inválido (3 a 30: letras, números, punto, guion)" },
          { status: 400 }
        );
      }
    }
    const password = typeof body?.password === "string" ? body.password : "";
    if (password && (password.length < 6 || password.length > 100)) {
      return NextResponse.json(
        { error: "La contraseña debe tener entre 6 y 100 caracteres" },
        { status: 400 }
      );
    }
    if (password && !username) {
      return NextResponse.json(
        { error: "Para asignar contraseña primero define el usuario" },
        { status: 400 }
      );
    }

    const member = await createTeamMember({
      name,
      role,
      wa_account_id: waAccountId,
      notify_phone: notifyPhone,
      username,
    });
    if (password) await setMemberPassword(member.id, password);
    return NextResponse.json({ ok: true, member });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    if (/foreign key/i.test(message)) {
      return NextResponse.json({ error: "La cuenta seleccionada ya no existe" }, { status: 400 });
    }
    if (/duplicate key|23505|idx_team_members_username/i.test(message)) {
      return NextResponse.json({ error: "Ese usuario ya existe" }, { status: 400 });
    }
    return NextResponse.json({ error: migrationHint(message) }, { status: 500 });
  }
}
