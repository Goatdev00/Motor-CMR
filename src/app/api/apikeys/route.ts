import { NextResponse, type NextRequest } from "next/server";
import { createApiKey, listApiKeys } from "@/lib/db";
import { generateApiKey } from "@/lib/api-keys";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

function migrationHint(message: string): string {
  return /does not exist|schema cache/i.test(message)
    ? message +
        " — Parece que falta la migración de la API: re-ejecuta supabase/schema.sql completo en el SQL Editor de Supabase."
    : message;
}

// Claves de la API pública (solo prefijos; el hash nunca sale de la DB).
export async function GET() {
  try {
    const keys = await listApiKeys();
    return NextResponse.json({ keys });
  } catch (err) {
    return NextResponse.json(
      { error: migrationHint(err instanceof Error ? err.message : "Error desconocido") },
      { status: 500 }
    );
  }
}

// Genera una clave nueva. La clave COMPLETA se devuelve una única vez:
// después solo existe su hash.
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as { label?: unknown } | null;
    const label = typeof body?.label === "string" ? body.label.trim() : "";
    if (!label || label.length > 60) {
      return NextResponse.json({ error: "Nombre requerido (1 a 60 caracteres)" }, { status: 400 });
    }
    if ((await listApiKeys()).length >= 10) {
      return NextResponse.json({ error: "Máximo 10 claves API" }, { status: 400 });
    }

    const { key, hash, prefix } = generateApiKey();
    const row = await createApiKey(label, hash, prefix);
    return NextResponse.json({ ok: true, key, row });
  } catch (err) {
    return NextResponse.json(
      { error: migrationHint(err instanceof Error ? err.message : "Error desconocido") },
      { status: 500 }
    );
  }
}
