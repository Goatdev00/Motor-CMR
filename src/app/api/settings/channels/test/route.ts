import { NextResponse, type NextRequest } from "next/server";
import { invalidateChannelSettingsCache, testChannel } from "@/lib/meta";
import { isChannel } from "@/lib/channels";
import { getAllChannelSettings } from "@/lib/db";
import { verifyEmailConfig } from "@/lib/mailer";
import { verifyLlmConfig } from "@/lib/llm";

// Prueba de conexión: canales de Meta (tokens), cuenta de correo (SMTP) o
// proveedor de IA (llamada mínima real al modelo).

// Config guardada + overrides del formulario (los valores enmascarados del
// input password significan "usa el guardado").
function mergeConfig(
  saved: Record<string, string> | undefined,
  overrides: unknown
): Record<string, string> {
  const merged = { ...(saved ?? {}) };
  if (overrides && typeof overrides === "object") {
    for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
      if (typeof v !== "string") continue;
      const value = v.trim();
      if (!value || value.startsWith("••••")) continue;
      merged[k] = value;
    }
  }
  return merged;
}

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
      const merged = mergeConfig(row?.config, body?.config);
      const result = await verifyEmailConfig(
        row
          ? { ...row, config: merged }
          : { channel: "email", enabled: false, config: merged, updated_at: 0 }
      );
      return NextResponse.json(result);
    }

    // IA: llamada mínima real con el proveedor/clave/modelo del formulario.
    if (channel === "llm") {
      const row = (await getAllChannelSettings())["llm"];
      const result = await verifyLlmConfig(mergeConfig(row?.config, body?.config));
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
