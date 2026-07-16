import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  AGENCY_ORG_ID,
  createOrganization,
  createTeamMember,
  listOrganizations,
  listTeamMembers,
  setMemberPassword,
} from "@/lib/db";

export const dynamic = "force-dynamic";

// Gestión de organizaciones (clientes de la agencia). SOLO los Admin de la
// organización 1 (la agencia) pueden ver y crear espacios de clientes.
// Crear una organización crea también su PRIMER usuario Admin, con el que
// el cliente entra y gestiona su propio equipo.

function requireAgencyAdmin(auth: Awaited<ReturnType<typeof requireAdmin>>) {
  if (!auth.ok) return auth.response;
  if (auth.member.org_id !== AGENCY_ORG_ID) {
    return NextResponse.json(
      { error: "Solo la agencia puede gestionar organizaciones" },
      { status: 403 }
    );
  }
  return null;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    const denied = requireAgencyAdmin(auth);
    if (denied) return denied;

    const orgs = await listOrganizations();
    // Conteo de miembros por organización (para la tarjeta).
    const members = await listTeamMembers();
    const counts = new Map<number, number>();
    for (const m of members) counts.set(m.org_id, (counts.get(m.org_id) ?? 0) + 1);

    return NextResponse.json({
      orgs: orgs.map((o) => ({ ...o, members: counts.get(o.id) ?? 0 })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    const denied = requireAgencyAdmin(auth);
    if (denied) return denied;

    const body = (await req.json().catch(() => null)) as {
      name?: unknown;
      adminName?: unknown;
      username?: unknown;
      password?: unknown;
    } | null;
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
    const adminName =
      typeof body?.adminName === "string" ? body.adminName.trim().slice(0, 60) : "";
    const username =
      typeof body?.username === "string" ? body.username.trim().toLowerCase().slice(0, 30) : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!name) return NextResponse.json({ error: "Nombre de la organización requerido" }, { status: 400 });
    if (!adminName) return NextResponse.json({ error: "Nombre del administrador requerido" }, { status: 400 });
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
      return NextResponse.json(
        { error: "Usuario inválido (3-30 caracteres: letras, números, . _ -)" },
        { status: 400 }
      );
    }
    if (password.length < 6) {
      return NextResponse.json(
        { error: "La contraseña debe tener al menos 6 caracteres" },
        { status: 400 }
      );
    }

    // El usuario es único en TODA la plataforma (el login no pregunta la
    // organización): validar antes para dar un error claro.
    const existing = await listTeamMembers();
    if (existing.some((m) => m.username?.toLowerCase() === username)) {
      return NextResponse.json(
        { error: `El usuario "${username}" ya existe — elige otro` },
        { status: 400 }
      );
    }

    const org = await createOrganization(name);
    const admin = await createTeamMember(org.id, {
      name: adminName,
      role: "ADMIN",
      username,
    });
    await setMemberPassword(admin.id, password);

    return NextResponse.json({ ok: true, org, admin: { id: admin.id, username } }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
