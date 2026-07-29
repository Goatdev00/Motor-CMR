import { NextResponse, type NextRequest } from "next/server";
import { getAppSetting, listTeamMembers, setAppSetting } from "@/lib/db";
import { STAGE_ORDER } from "@/lib/stages";
import { requireAdmin, requireMember } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Mapa etapa → miembro asignado (app_settings 'stage_routing'). Cuando un
// lead entra a una etapa con regla, la RPC set_stage lo asigna a ese
// vendedor y le manda un aviso por WhatsApp (outbox kind='notify').
type RoutingMap = Partial<Record<string, number | null>>;

function cleanRouting(raw: unknown): RoutingMap {
  const clean: RoutingMap = {};
  if (raw && typeof raw === "object") {
    for (const stage of STAGE_ORDER) {
      const v = (raw as Record<string, unknown>)[stage];
      if (typeof v === "number" && Number.isInteger(v) && v > 0) clean[stage] = v;
    }
  }
  return clean;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireMember(req);
    if (!auth.ok) return auth.response;
    const stored = await getAppSetting<RoutingMap>(auth.orgId, "stage_routing");
    return NextResponse.json({ routing: cleanRouting(stored) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.member.org_id;
    const body = (await req.json().catch(() => null)) as { routing?: unknown } | null;
    if (!body?.routing || typeof body.routing !== "object") {
      return NextResponse.json({ error: "routing requerido" }, { status: 400 });
    }
    const input = body.routing as Record<string, unknown>;
    const clean: RoutingMap = {};
    const members = await listTeamMembers(orgId);
    const memberIds = new Set(members.map((m) => m.id));

    for (const stage of STAGE_ORDER) {
      const v = input[stage];
      if (v === undefined || v === null || v === "") continue;
      const id = Number(v);
      if (!Number.isInteger(id) || id <= 0) {
        return NextResponse.json({ error: `Miembro inválido para ${stage}` }, { status: 400 });
      }
      // Regla de un miembro que ya no existe (borrado después de guardar):
      // se descarta en silencio en vez de rechazar el PUT completo — si no,
      // borrar un miembro dejaba el enrutamiento imposible de re-guardar.
      if (!memberIds.has(id)) continue;
      clean[stage] = id;
    }

    await setAppSetting(orgId, "stage_routing", clean);
    return NextResponse.json({ ok: true, routing: clean });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
