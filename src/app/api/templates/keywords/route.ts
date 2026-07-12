import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import {
  MAX_TRIGGERS,
  readKeywordTriggers,
  saveKeywordTriggers,
  sanitizeTriggerList,
  type KeywordTrigger,
} from "@/lib/templates";

export const dynamic = "force-dynamic";

// Palabras clave con respuesta automática (sección Plantillas). La lista es
// corta y se edita como un todo: GET la devuelve, PUT la reemplaza. El bot
// la relee con un caché de ~15 s, así que los cambios aplican solos.

export async function GET() {
  try {
    const triggers = await readKeywordTriggers();
    return NextResponse.json({ triggers });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { triggers?: unknown } | null;
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

    const triggers: KeywordTrigger[] = sanitizeTriggerList(
      raw.map((r) => ({ ...r, id: typeof r.id === "string" && r.id ? r.id : randomUUID() }))
    );

    // Aviso de duplicados exactos (misma palabra normalizada dos veces).
    const seen = new Set<string>();
    for (const t of triggers) {
      const k = t.keyword.toLowerCase();
      if (seen.has(k)) {
        return NextResponse.json(
          { error: `La palabra "${t.keyword}" está repetida — deja solo una` },
          { status: 400 }
        );
      }
      seen.add(k);
    }

    await saveKeywordTriggers(triggers);
    return NextResponse.json({ ok: true, triggers });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
