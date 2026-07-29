import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin, requireMember } from "@/lib/auth";
import { AGENCY_ORG_ID } from "@/lib/db";
import {
  DEFAULT_GENERAL_PROMPT,
  MAX_PROMPT_LENGTH,
  readBotPrompts,
  saveGeneralPrompt,
  savePrincipalPrompt,
} from "@/lib/prompts";

export const dynamic = "force-dynamic";

// Prompts del bot. GET: cualquier miembro (el panel muestra el estado).
// PUT: solo Admin — el 'principal' lo edita cada organización; el 'general'
// SOLO la agencia (organización 1), porque aplica a todos los clientes.
// El bot toma los cambios en ≤15 s por su caché.

export async function GET(req: NextRequest) {
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;
  try {
    const prompts = await readBotPrompts(auth.orgId);
    return NextResponse.json({
      general: prompts.general,
      generalDefault: DEFAULT_GENERAL_PROMPT,
      principal: prompts.principal,
      canEditGeneral: auth.member.role === "ADMIN" && auth.orgId === AGENCY_ORG_ID,
      maxLength: MAX_PROMPT_LENGTH,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const orgId = auth.member.org_id;
  try {
    const body = (await req.json().catch(() => null)) as {
      principal?: unknown;
      general?: unknown;
    } | null;
    if (!body || (body.principal === undefined && body.general === undefined)) {
      return NextResponse.json({ error: "Nada que guardar" }, { status: 400 });
    }

    if (body.principal !== undefined) {
      if (typeof body.principal !== "string" || body.principal.length > MAX_PROMPT_LENGTH) {
        return NextResponse.json(
          { error: `El prompt principal debe ser texto de máximo ${MAX_PROMPT_LENGTH} caracteres` },
          { status: 400 }
        );
      }
      await savePrincipalPrompt(orgId, body.principal);
    }

    if (body.general !== undefined) {
      if (orgId !== AGENCY_ORG_ID) {
        return NextResponse.json(
          { error: "Solo la agencia puede editar el prompt general de la plataforma" },
          { status: 403 }
        );
      }
      if (typeof body.general !== "string" || body.general.length > MAX_PROMPT_LENGTH) {
        return NextResponse.json(
          { error: `El prompt general debe ser texto de máximo ${MAX_PROMPT_LENGTH} caracteres` },
          { status: 400 }
        );
      }
      await saveGeneralPrompt(body.general);
    }

    const prompts = await readBotPrompts(orgId);
    return NextResponse.json({ ok: true, general: prompts.general, principal: prompts.principal });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
