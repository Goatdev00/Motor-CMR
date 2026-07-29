import { NextResponse, type NextRequest } from "next/server";
import {
  deleteTeamMember,
  listAdminAccessIds,
  listTeamMembers,
  listWaAccounts,
  setMemberPassword,
  TEAM_ROLES,
  updateTeamMember,
  type TeamMember,
  type TeamRole,
} from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizePhoneInput(raw: unknown): string | null | "invalid" {
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") return "invalid";
  const digits = raw.replace(/[\s\-+().]/g, "");
  if (!/^\d{7,15}$/.test(digits)) return "invalid";
  return digits;
}

// ¿La operación dejaría el dashboard sin ningún Admin activo capaz de
// ENTRAR (usuario + contraseña)? Bloqueo permanente: nadie podría volver a
// gestionar el equipo. Nota: la comprobación es check-then-act (sin
// transacción); con un solo Admin operando es suficiente, y la
// recuperación extrema siempre existe vía SQL Editor de Supabase.
async function isLastAdminWithAccess(target: TeamMember, orgId: number): Promise<boolean> {
  const adminIds = await listAdminAccessIds(orgId);
  return adminIds.length === 1 && adminIds[0] === target.id;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.member.org_id;

    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: "id inválido" }, { status: 400 });

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "body inválido" }, { status: 400 });

    const patch: {
      name?: string;
      role?: TeamRole;
      wa_account_id?: number | null;
      notify_phone?: string | null;
      active?: boolean;
      username?: string | null;
    } = {};

    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 60) {
        return NextResponse.json({ error: "Nombre inválido (1 a 60 caracteres)" }, { status: 400 });
      }
      patch.name = name;
    }
    if (body.role !== undefined) {
      if (!TEAM_ROLES.includes(body.role as TeamRole)) {
        return NextResponse.json({ error: "Rol inválido" }, { status: 400 });
      }
      patch.role = body.role as TeamRole;
    }
    if (body.wa_account_id !== undefined) {
      if (body.wa_account_id === null || body.wa_account_id === "") {
        patch.wa_account_id = null;
      } else {
        const v = Number(body.wa_account_id);
        if (!Number.isInteger(v) || v <= 0) {
          return NextResponse.json({ error: "Cuenta inválida" }, { status: 400 });
        }
        // La cuenta debe ser de ESTA organización (la FK no distingue orgs).
        const orgAccounts = await listWaAccounts(orgId);
        if (!orgAccounts.some((a) => a.id === v)) {
          return NextResponse.json(
            { error: "Esa cuenta de WhatsApp no pertenece a tu organización" },
            { status: 400 }
          );
        }
        patch.wa_account_id = v;
      }
    }
    if (body.notify_phone !== undefined) {
      const phone = normalizePhoneInput(body.notify_phone);
      if (phone === "invalid") {
        return NextResponse.json(
          { error: "Teléfono de avisos inválido (solo dígitos, con indicativo de país)" },
          { status: 400 }
        );
      }
      patch.notify_phone = phone;
    }
    if (body.active !== undefined) {
      if (typeof body.active !== "boolean") {
        return NextResponse.json({ error: "active inválido" }, { status: 400 });
      }
      patch.active = body.active;
    }
    if (body.username !== undefined) {
      if (body.username === null || body.username === "") {
        patch.username = null;
      } else {
        const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
        if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
          return NextResponse.json(
            { error: "Usuario inválido (3 a 30: letras, números, punto, guion)" },
            { status: 400 }
          );
        }
        patch.username = username;
      }
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (password && (password.length < 6 || password.length > 100)) {
      return NextResponse.json(
        { error: "La contraseña debe tener entre 6 y 100 caracteres" },
        { status: 400 }
      );
    }

    if (Object.keys(patch).length === 0 && !password) {
      return NextResponse.json({ error: "Nada que actualizar" }, { status: 400 });
    }

    const all = await listTeamMembers(orgId);
    const target = all.find((m) => m.id === id);
    if (!target) return NextResponse.json({ error: "Miembro no encontrado" }, { status: 404 });

    // Guardas anti-bloqueo:
    // (a) no puedes desactivar tu propia cuenta (te sacarías al instante);
    // (b) la operación no puede dejar cero Admins activos con acceso.
    if (patch.active === false && target.id === auth.member.id) {
      return NextResponse.json({ error: "No puedes desactivar tu propia cuenta" }, { status: 400 });
    }
    const losesAccess =
      patch.active === false ||
      (patch.role !== undefined && patch.role !== "ADMIN") ||
      patch.username === null;
    if (losesAccess && (await isLastAdminWithAccess(target, orgId))) {
      return NextResponse.json(
        { error: "Debe quedar al menos un Admin activo con usuario y contraseña" },
        { status: 400 }
      );
    }

    // Contraseña sin usuario resultante = acceso imposible: se rechaza claro.
    const resultingUsername = patch.username !== undefined ? patch.username : target.username;
    if (password && !resultingUsername) {
      return NextResponse.json(
        { error: "Para asignar contraseña primero define el usuario" },
        { status: 400 }
      );
    }

    const member =
      Object.keys(patch).length > 0 ? await updateTeamMember(id, patch, orgId) : target;
    if (!member) return NextResponse.json({ error: "Miembro no encontrado" }, { status: 404 });
    if (password) await setMemberPassword(id, password);
    return NextResponse.json({ ok: true, member });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    if (/foreign key/i.test(message)) {
      return NextResponse.json({ error: "La cuenta seleccionada ya no existe" }, { status: 400 });
    }
    if (/duplicate key|23505|idx_team_members_username/i.test(message)) {
      return NextResponse.json({ error: "Ese usuario ya existe" }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.member.org_id;

    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: "id inválido" }, { status: 400 });

    if (id === auth.member.id) {
      return NextResponse.json({ error: "No puedes eliminar tu propia cuenta" }, { status: 400 });
    }
    const all = await listTeamMembers(orgId);
    const target = all.find((m) => m.id === id);
    if (!target) return NextResponse.json({ error: "Miembro no encontrado" }, { status: 404 });
    if (await isLastAdminWithAccess(target, orgId)) {
      return NextResponse.json(
        { error: "Debe quedar al menos un Admin activo con usuario y contraseña" },
        { status: 400 }
      );
    }

    // Los leads asignados quedan sin asignar (FK on delete set null) y las
    // reglas de enrutamiento que lo referencien se ignoran en silencio.
    await deleteTeamMember(id, orgId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
