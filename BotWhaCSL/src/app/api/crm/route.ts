import { NextResponse, type NextRequest } from "next/server";
import { listConversations } from "@/lib/db";
import { requireMember } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Tablero CRM: todos los leads con sus campos de pipeline. El dashboard
// agrupa por etapa y calcula las métricas en el cliente.
export async function GET(req: NextRequest) {
  try {
    const auth = await requireMember(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.orgId;

    const leads = await listConversations(orgId);
    // Si la función list_conversations de la DB es la versión pre-CRM,
    // devuelve filas sin `stage`: mejor un error claro que un tablero vacío.
    if (leads.length > 0 && leads[0].stage === undefined) {
      return NextResponse.json(
        {
          error:
            "La base de datos no tiene la migración del CRM. Re-ejecuta supabase/schema.sql completo en el SQL Editor de Supabase y recarga.",
        },
        { status: 500 }
      );
    }
    return NextResponse.json({ leads });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    const hint = /stage|lead_|column|schema|does not exist/i.test(message)
      ? " — Parece que falta la migración del CRM: re-ejecuta supabase/schema.sql completo en el SQL Editor de Supabase."
      : "";
    return NextResponse.json({ error: message + hint }, { status: 500 });
  }
}
