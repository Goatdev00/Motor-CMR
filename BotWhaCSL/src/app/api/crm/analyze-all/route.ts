import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/db";
import { analyzeLead } from "@/lib/lead-analysis";
import { requireMember } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Análisis general del pipeline con IA. Anti-sobregasto de tokens: solo se
// analizan leads con mensajes NUEVOS desde su último análisis
// (ai_analyzed_at < last_message_at) o nunca analizados. El resto se salta.
export async function POST(req: NextRequest) {
  try {
    const auth = await requireMember(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.orgId;

    const sb = getSupabase();
    const { data, error } = await sb
      .from("conversations")
      .select("id, ai_analyzed_at, last_message_at")
      .eq("org_id", orgId);
    if (error) {
      return NextResponse.json({ error: `Supabase: ${error.message}` }, { status: 500 });
    }

    const rows = (data ?? []) as {
      id: number;
      ai_analyzed_at: number | null;
      last_message_at: number | null;
    }[];

    const pending = rows.filter(
      (r) =>
        r.last_message_at !== null &&
        (r.ai_analyzed_at === null || r.ai_analyzed_at < r.last_message_at)
    );
    const skipped = rows.length - pending.length;

    // Secuencial a propósito: no saturar la API de OpenAI ni la DB.
    let analyzed = 0;
    let failed = 0;
    for (const lead of pending) {
      try {
        await analyzeLead(lead.id);
        analyzed++;
      } catch (err) {
        failed++;
        console.error(`[crm] Falló el análisis del lead ${lead.id}:`, err);
      }
    }

    return NextResponse.json({ ok: true, analyzed, skipped, failed });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
