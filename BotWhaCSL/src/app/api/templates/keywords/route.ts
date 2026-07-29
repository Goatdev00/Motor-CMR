import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { requireMember } from "@/lib/auth";
import {
  MAX_TRIGGERS,
  keywordDedupeKey,
  readKeywordTriggersDoc,
  saveKeywordTriggers,
  sanitizeTriggerList,
  type KeywordTrigger,
} from "@/lib/templates";

export const dynamic = "force-dynamic";

// Palabras clave con respuesta automática (sección Plantillas). La lista es
// corta y se edita como un todo: GET la devuelve (con su rev), PUT la
// reemplaza. El PUT compara el rev base: si otra pestaña guardó primero,
// responde 409 con la versión vigente en vez de machacarla en silencio.
// El bot relee la lista con un caché de ~15 s, así que los cambios aplican
// solos.

export async function GET(req: NextRequest) {
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;
  const orgId = auth.orgId;
  try {
    const doc = await readKeywordTriggersDoc(orgId);
    return NextResponse.json({ triggers: doc.triggers, rev: doc.rev });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;
  const orgId = auth.orgId;
  try {
    const body = (await req.json().catch(() => null)) as {
      triggers?: unknown;
      baseRev?: unknown;
    } | null;
    if (!body || !Array.isArray(body.triggers)) {
      return NextResponse.json({ error: "triggers debe ser una lista" }, { status: 400 });
    }
    if (body.triggers.length > MAX_TRIGGERS) {
      return NextResponse.json(
        { error: `Máximo ${MAX_TRIGGERS} palabras clave` },
        { status: 400 }
      );
    }

    // Filas sin keyword o sin contenido se rechazan con detalle (en vez de
    // descartarse en silencio con el saneador).
    const raw = body.triggers as Record<string, unknown>[];
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i] ?? {};
      const keyword = typeof r.keyword === "string" ? r.keyword.trim() : "";
      const content = typeof r.content === "string" ? r.content.trim() : "";
      if (!keyword) {
        return NextResponse.json(
          { error: `La fila ${i + 1} no tiene palabra clave` },
          { status: 400 }
        );
      }
      if (!content) {
        return NextResponse.json(
          { error: `La palabra "${keyword.slice(0, 30)}" no tiene respuesta asignada` },
          { status: 400 }
        );
      }
    }

    // Ids únicos y con formato controlado (el saneador les pone tope de
    // largo; aquí se regeneran los repetidos para que la UI no edite/borre
    // dos filas a la vez).
    const usedIds = new Set<string>();
    const triggers: KeywordTrigger[] = sanitizeTriggerList(
      raw.map((r) => {
        let id = typeof r.id === "string" && r.id ? r.id.slice(0, 64) : randomUUID();
        if (usedIds.has(id)) id = randomUUID();
        usedIds.add(id);
        return { ...r, id };
      })
    );

    // Duplicados EFECTIVOS: mismo criterio de normalización que el matcher
    // (tildes, mayúsculas, signos). "PROMOCIÓN" y "promocion" son la misma
    // palabra para el bot — la segunda jamás dispararía.
    const seen = new Map<string, string>();
    for (const t of triggers) {
      const key = keywordDedupeKey(t.keyword);
      const previous = seen.get(key);
      if (previous !== undefined) {
        return NextResponse.json(
          {
            error:
              previous.toLowerCase() === t.keyword.toLowerCase()
                ? `La palabra "${t.keyword}" está repetida — deja solo una`
                : `"${t.keyword}" y "${previous}" son la misma palabra para el bot (mayúsculas, tildes y signos no cuentan) — deja solo una`,
          },
          { status: 400 }
        );
      }
      seen.set(key, t.keyword);
    }

    // Control de concurrencia optimista: si otra pestaña guardó después de
    // que esta cargó la lista, no se machaca — se devuelve la versión
    // vigente para que el operador la recargue.
    const current = await readKeywordTriggersDoc(orgId);
    const baseRev = typeof body.baseRev === "string" ? body.baseRev : null;
    if (current.rev !== null && baseRev !== current.rev) {
      return NextResponse.json(
        {
          error:
            "Alguien más guardó cambios en las palabras clave mientras editabas. Revisa la versión más reciente antes de volver a guardar.",
          conflict: true,
          triggers: current.triggers,
          rev: current.rev,
        },
        { status: 409 }
      );
    }

    const rev = await saveKeywordTriggers(orgId, triggers);
    return NextResponse.json({ ok: true, triggers, rev });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
