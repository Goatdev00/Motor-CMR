import { NextResponse, type NextRequest } from "next/server";
import { requireMember } from "@/lib/auth";
import {
  getGoogleSettings,
  isGoogleConfigured,
  isGoogleConnected,
  revokeGoogleToken,
  saveGoogleSettings,
} from "@/lib/google";

export const dynamic = "force-dynamic";

// El client_secret nunca sale completo del servidor.
function maskSecret(value: string | undefined): string {
  if (!value) return "";
  return value.length > 4 ? `••••${value.slice(-4)}` : "••••";
}

export async function GET(req: NextRequest) {
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;
  try {
    const settings = await getGoogleSettings(auth.orgId);
    return NextResponse.json({
      configured: isGoogleConfigured(settings),
      connected: isGoogleConnected(settings),
      email: settings.email ?? null,
      client_id: settings.client_id ?? "",
      client_secret_mask: maskSecret(settings.client_secret),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}

// Guarda las credenciales del cliente OAuth (creadas por el usuario en
// Google Cloud Console). Mandar de vuelta la máscara conserva el secreto
// actual, igual que en la configuración de canales.
export async function PUT(req: NextRequest) {
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;
  const orgId = auth.orgId;
  try {
    const body = (await req.json().catch(() => null)) as {
      client_id?: unknown;
      client_secret?: unknown;
    } | null;
    const clientId = typeof body?.client_id === "string" ? body.client_id.trim() : "";
    const rawSecret = typeof body?.client_secret === "string" ? body.client_secret.trim() : "";
    if (!clientId || clientId.length > 300) {
      return NextResponse.json({ error: "client_id requerido" }, { status: 400 });
    }

    const current = await getGoogleSettings(orgId);
    // Cambiar de cliente OAuth invalida el refresh_token (está atado al
    // client_id): se descarta para que la UI pida reconectar.
    const clientChanged = current.client_id !== undefined && current.client_id !== clientId;

    let secret = rawSecret;
    if (rawSecret === maskSecret(current.client_secret)) {
      if (clientChanged) {
        // El secreto está atado a UN client_id: conservar el del cliente
        // anterior con un client_id nuevo guardaba un par que jamás puede
        // autenticar (invalid_client en cada conexión, sin pista).
        return NextResponse.json(
          { error: "Cambiaste el Client ID: pega también el Client Secret completo del cliente nuevo" },
          { status: 400 }
        );
      }
      secret = current.client_secret ?? "";
    } else if (rawSecret.startsWith("••••")) {
      // Máscara editada a mano: guardar eso rompería el OAuth en silencio.
      return NextResponse.json(
        { error: "El client_secret parece la máscara editada; pégalo completo" },
        { status: 400 }
      );
    }
    if (!secret || secret.length > 300) {
      return NextResponse.json({ error: "client_secret requerido" }, { status: 400 });
    }

    await saveGoogleSettings(orgId, {
      client_id: clientId,
      client_secret: secret,
      ...(clientChanged ? { refresh_token: "", email: "" } : {}),
    });

    const settings = await getGoogleSettings(orgId);
    return NextResponse.json({
      ok: true,
      configured: isGoogleConfigured(settings),
      connected: isGoogleConnected(settings),
      email: settings.email ?? null,
      client_id: settings.client_id ?? "",
      client_secret_mask: maskSecret(settings.client_secret),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}

// Desconecta la cuenta: revoca el grant en Google (best-effort) y descarta
// el refresh_token; las credenciales del cliente OAuth se conservan para
// poder reconectar con un clic.
export async function DELETE(req: NextRequest) {
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;
  const orgId = auth.orgId;
  try {
    const current = await getGoogleSettings(orgId);
    if (current.refresh_token) await revokeGoogleToken(current.refresh_token);
    await saveGoogleSettings(orgId, { refresh_token: "", email: "" });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
