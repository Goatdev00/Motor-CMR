import { NextResponse, type NextRequest } from "next/server";
import { analyzeLead } from "@/lib/lead-analysis";

interface Ctx {
  params: Promise<{ conversationId: string }>;
}

// Análisis de IA bajo demanda desde el dashboard ("Analizar ahora").
export async function POST(_req: NextRequest, { params }: Ctx) {
  try {
    const { conversationId } = await params;
    const id = Number(conversationId);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "id inválido" }, { status: 400 });
    }

    const lead = await analyzeLead(id);
    if (!lead) return NextResponse.json({ error: "Lead no encontrado" }, { status: 404 });

    return NextResponse.json({ ok: true, lead });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
