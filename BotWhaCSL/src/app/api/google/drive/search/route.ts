import { NextResponse, type NextRequest } from "next/server";
import { requireMember } from "@/lib/auth";
import { getGoogleSettings, isGoogleConnected, searchDriveFiles } from "@/lib/google";

export const dynamic = "force-dynamic";

// Busca archivos en el Drive de la cuenta conectada DE LA ORGANIZACIÓN
// (para adjuntarlos a eventos del calendario).
export async function GET(req: NextRequest) {
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;
  const orgId = auth.orgId;
  try {
    const settings = await getGoogleSettings(orgId);
    if (!isGoogleConnected(settings)) {
      return NextResponse.json(
        { error: "Conecta tu cuenta de Google desde la pestaña Calendario" },
        { status: 400 }
      );
    }
    const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 100);
    if (!q) return NextResponse.json({ files: [] });
    const files = await searchDriveFiles(orgId, q);
    return NextResponse.json({ files });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
