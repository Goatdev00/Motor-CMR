import { NextResponse, type NextRequest } from "next/server";
import { listCalendarEvents } from "@/lib/db";
import { buildIcs } from "@/lib/calendar";
import {
  ensureDriveFolder,
  getGoogleSettings,
  isGoogleConnected,
  uploadTextFileToDrive,
} from "@/lib/google";
import { requireMember } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Respaldo del calendario en Google Drive: genera un .ics con TODOS los
// eventos y lo sube a la carpeta AGENTE (reemplaza el respaldo anterior).
// El .ics es importable en Google Calendar / Outlook / Apple Calendar.
export async function POST(req: NextRequest) {
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;
  const orgId = auth.orgId;
  try {
    const settings = await getGoogleSettings(orgId);
    if (!isGoogleConnected(settings)) {
      return NextResponse.json(
        { error: "Conecta tu cuenta de Google antes de exportar" },
        { status: 400 }
      );
    }
    // Zona horaria del navegador del operador: con ella las fechas de los
    // eventos de día completo salen exactas en el .ics.
    const body = (await req.json().catch(() => null)) as { timeZone?: unknown } | null;
    const timeZone =
      typeof body?.timeZone === "string" && body.timeZone.length <= 60 ? body.timeZone : null;
    const events = await listCalendarEvents(orgId, 0, 32503680000);
    if (events.length === 0) {
      return NextResponse.json({ error: "No hay eventos para exportar" }, { status: 400 });
    }
    const ics = buildIcs(events, timeZone);
    const folderId = await ensureDriveFolder(orgId);
    const uploaded = await uploadTextFileToDrive(
      orgId,
      "calendario-agente.ics",
      "text/calendar",
      ics,
      folderId
    );
    return NextResponse.json({ ok: true, count: events.length, link: uploaded.webViewLink });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
