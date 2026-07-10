import { NextResponse, type NextRequest } from "next/server";
import { getGoogleSettings, isGoogleConnected, searchDriveFiles } from "@/lib/google";

export const dynamic = "force-dynamic";

// Busca archivos en el Drive de la cuenta conectada (para adjuntarlos a
// eventos del calendario).
export async function GET(req: NextRequest) {
  try {
    const settings = await getGoogleSettings();
    if (!isGoogleConnected(settings)) {
      return NextResponse.json(
        { error: "Conecta tu cuenta de Google desde la pestaña Calendario" },
        { status: 400 }
      );
    }
    const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 100);
    if (!q) return NextResponse.json({ files: [] });
    const files = await searchDriveFiles(q);
    return NextResponse.json({ files });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
