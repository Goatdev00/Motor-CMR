import { NextResponse, type NextRequest } from "next/server";
import { invalidateChannelSettingsCache, testChannel } from "@/lib/meta";
import { isChannel } from "@/lib/channels";
import { getAllChannelSettings } from "@/lib/db";
import { verifyEmailConfig } from "@/lib/mailer";

// Prueba de conexión: canales de Meta (tokens) o cuenta de correo (SMTP).
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      channel?: unknown;
      config?: unknown;
    } | null;
    const channel = body?.channel;

    // Correo: verifica credenciales SMTP con lo guardado + lo del formulario.
    if (channel === "email") {
      const row = (await getAllChannelSettings())["email"];
      const merged = { ...(row?.config ?? {}) };
      if (body?.config && typeof body.config === "object") {
        for (const [k, v] of Object.entries(body.config as Record<string, unknown>)) {
          if (typeof v !== "string") continue;
          const value = v.trim();
          if (!value || value.startsWith("••••")) continue;
          merged[k] = value;
        }
      }
      const result = await verifyEmailConfig(
        row
          ? { ...row, config: merged }
          : { channel: "email", enabled: false, config: merged, updated_at: 0 }
      );
      return NextResponse.json(result);
    }

    if (!isChannel(channel) || channel === "whatsapp") {
      return NextResponse.json({ error: "channel inválido para prueba" }, { status: 400 });
    }
    const overrides =
      body?.config && typeof body.config === "object"
        ? Object.fromEntries(
            Object.entries(body.config as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === "string"
            )
          )
        : undefined;
    // Sin cache: probar siempre con lo último guardado.
    invalidateChannelSettingsCache();
    const result = await testChannel(channel, overrides);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, detail: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
