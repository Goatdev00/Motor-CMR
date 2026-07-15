import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { requireAdmin } from "@/lib/auth";
import {
  MAX_AGENTS,
  readAiAgentsDoc,
  saveAiAgents,
  sanitizeAgentList,
  type AiAgent,
} from "@/lib/ai-agents";

export const dynamic = "force-dynamic";

// Equipo de IA (multiagentes). GET: cualquier sesión (el panel lo muestra
// en solo lectura a no-admins). PUT: solo Admin, reemplaza la lista completa
// con control de concurrencia optimista (rev → 409 si otra pestaña guardó
// primero, mismo patrón que las palabras clave). El bot toma los cambios en
// ≤15 s por su caché.

export async function GET() {
  try {
    const doc = await readAiAgentsDoc();
    return NextResponse.json({ agents: doc.agents, rev: doc.rev });
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

    const body = (await req.json().catch(() => null)) as {
      agents?: unknown;
      baseRev?: unknown;
    } | null;
    if (!body || !Array.isArray(body.agents)) {
      return NextResponse.json({ error: "agents debe ser una lista" }, { status: 400 });
    }
    if (body.agents.length > MAX_AGENTS) {
      return NextResponse.json({ error: `Máximo ${MAX_AGENTS} agentes` }, { status: 400 });
    }

    // Validación con detalle (el saneador descartaría filas en silencio).
    const raw = body.agents as Record<string, unknown>[];
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i] ?? {};
      const name = typeof r.name === "string" ? r.name.trim() : "";
      const instructions = typeof r.instructions === "string" ? r.instructions.trim() : "";
      if (!name) {
        return NextResponse.json(
          { error: `El agente de la fila ${i + 1} no tiene nombre` },
          { status: 400 }
        );
      }
      if (!instructions) {
        return NextResponse.json(
          { error: `El agente "${name.slice(0, 30)}" no tiene instrucciones` },
          { status: 400 }
        );
      }
    }

    // Ids únicos (una UI con ids repetidos editaría/borraría dos filas a la
    // vez) y nombres sin duplicar (para que los logs y el probador sean
    // inequívocos).
    const usedIds = new Set<string>();
    const agents: AiAgent[] = sanitizeAgentList(
      raw.map((r) => {
        let id = typeof r.id === "string" && r.id ? r.id.slice(0, 64) : randomUUID();
        if (usedIds.has(id)) id = randomUUID();
        usedIds.add(id);
        return { ...r, id };
      })
    );
    const seenNames = new Set<string>();
    for (const a of agents) {
      const key = a.name.trim().toLowerCase();
      if (seenNames.has(key)) {
        return NextResponse.json(
          { error: `Hay dos agentes llamados "${a.name}" — usa nombres distintos` },
          { status: 400 }
        );
      }
      seenNames.add(key);
    }

    const current = await readAiAgentsDoc();
    const baseRev = typeof body.baseRev === "string" ? body.baseRev : null;
    if (current.rev !== null && baseRev !== current.rev) {
      return NextResponse.json(
        {
          error:
            "Alguien más guardó cambios en el equipo de IA mientras editabas. Revisa la versión más reciente antes de volver a guardar.",
          conflict: true,
          agents: current.agents,
          rev: current.rev,
        },
        { status: 409 }
      );
    }

    const rev = await saveAiAgents(agents);
    return NextResponse.json({ ok: true, agents, rev });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
