import { NextResponse, type NextRequest } from "next/server";
import QRCode from "qrcode";
import { createWaAccount, listWaAccounts } from "@/lib/db";
import { requireAdmin, requireMember } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Más sesiones simultáneas de Baileys consumen memoria y aumentan el riesgo
// de baneos; un tope sano para un equipo de ventas.
const MAX_ACCOUNTS = 6;

function migrationHint(message: string): string {
  return /does not exist|schema cache/i.test(message)
    ? message +
        " — Parece que falta la migración de Equipo: re-ejecuta supabase/schema.sql completo en el SQL Editor de Supabase."
    : message;
}

// Cuentas de WhatsApp con su estado en vivo. El QR se entrega como data URL
// listo para <img> (igual que hacía la pantalla de conexión original).
export async function GET(req: NextRequest) {
  try {
    const auth = await requireMember(req);
    if (!auth.ok) return auth.response;
    const rows = await listWaAccounts(auth.orgId);
    const accounts = await Promise.all(
      rows.map(async (a) => {
        // Defensivo: mostrar el QR si qr_string existe AUNQUE el status sea
        // 'connecting' (races del bot con estados intermedios).
        const showQr = !!a.qr_string && (a.status === "qr" || a.status === "connecting");
        const qrPng = showQr
          ? await QRCode.toDataURL(a.qr_string as string, { width: 280, margin: 2 })
          : null;
        return {
          id: a.id,
          label: a.label,
          status: showQr ? "qr" : a.status,
          phone: a.phone,
          enabled: a.enabled,
          qrPng,
          updatedAt: a.updated_at,
        };
      })
    );
    return NextResponse.json({ accounts });
  } catch (err) {
    return NextResponse.json(
      { error: migrationHint(err instanceof Error ? err.message : "Error desconocido") },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.member.org_id;
    const body = (await req.json().catch(() => null)) as { label?: unknown } | null;
    const label = typeof body?.label === "string" ? body.label.trim() : "";
    if (!label || label.length > 40) {
      return NextResponse.json({ error: "Nombre requerido (1 a 40 caracteres)" }, { status: 400 });
    }
    const existing = await listWaAccounts(orgId);
    if (existing.length >= MAX_ACCOUNTS) {
      return NextResponse.json(
        { error: `Máximo ${MAX_ACCOUNTS} cuentas de WhatsApp` },
        { status: 400 }
      );
    }
    const account = await createWaAccount(orgId, label);
    return NextResponse.json({ ok: true, account });
  } catch (err) {
    return NextResponse.json(
      { error: migrationHint(err instanceof Error ? err.message : "Error desconocido") },
      { status: 500 }
    );
  }
}
