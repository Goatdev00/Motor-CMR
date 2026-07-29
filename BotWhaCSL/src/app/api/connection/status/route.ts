import { NextResponse, type NextRequest } from "next/server";
import { listWaAccounts } from "@/lib/db";
import { requireMember } from "@/lib/auth";

// Sin esto Next puede cachear el GET como estático y el polling no ve cambios.
export const dynamic = "force-dynamic";

// Resumen agregado de las cuentas de WhatsApp (para el chip del header).
// La gestión por cuenta (QR, desvincular, etc.) vive en /api/team/accounts.
export async function GET(req: NextRequest) {
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;
  const orgId = auth.orgId;
  try {
    const accounts = await listWaAccounts(orgId);
    const connected = accounts.filter((a) => a.status === "connected");
    return NextResponse.json({
      connected: connected.length > 0,
      accountsConnected: connected.length,
      accountsTotal: accounts.filter((a) => a.enabled).length,
      // Con una sola cuenta conectada se muestra su número; con varias, el
      // conteo (el detalle por cuenta está en la pestaña Equipo).
      phone: connected.length === 1 ? connected[0].phone : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    const hint = /does not exist|schema cache/i.test(message)
      ? " — Parece que falta la migración de Equipo: re-ejecuta supabase/schema.sql completo en el SQL Editor de Supabase."
      : "";
    return NextResponse.json(
      { connected: false, accountsConnected: 0, accountsTotal: 0, phone: null, error: message + hint },
      { status: 500 }
    );
  }
}
