import { NextResponse, type NextRequest } from "next/server";
import { invalidateChannelSettingsCache, testChannel } from "@/lib/meta";
import { isChannel } from "@/lib/channels";
import { getAllChannelSettings } from "@/lib/db";
import { verifyEmailConfig } from "@/lib/mailer";
import { verifyLlmConfig } from "@/lib/llm";

// Prueba de conexión: canales de Meta (tokens), cuenta de correo (SMTP) o
// proveedor de IA (llamada mínima real al modelo).

// Misma máscara que usa el GET de settings (••••XXXX).
const MASK_PREFIX = "••••";
function maskValue(value: string): string {
  return value.length <= 4 ? MASK_PREFIX : `${MASK_PREFIX}${value.slice(-4)}`;
}

// Config guardada + overrides del formulario. La máscara EXACTA del valor
// guardado significa "prueba lo persistido"; máscara + texto pegado encima
// es un error del operador y se reporta (ignorarlo hacía que la prueba
// validara el valor viejo y saliera en verde con uno nuevo incorrecto).
function mergeConfig(
  saved: Record<string, string> | undefined,
  overrides: unknown
): { merged: Record<string, string> } | { maskError: string } {
  const merged = { ...(saved ?? {}) };
  if (overrides && typeof overrides === "object") {
    for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
      if (typeof v !== "string") continue;
      const value = v.trim();
      if (!value) continue;
      const current = saved?.[k];
      if (current && value === maskValue(current)) continue; // probar lo guardado
      if (value.startsWith(MASK_PREFIX)) {
        return {
          maskError: `El campo '${k}' contiene la máscara del valor anterior con texto pegado encima — borra el campo COMPLETO y pega el valor de nuevo (no se probó nada).`,
        };
      }
      merged[k] = value;
    }
  }
  return { merged };
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
      const m = mergeConfig(row?.config, body?.config);
      if ("maskError" in m) return NextResponse.json({ ok: false, detail: m.maskError });
      const result = await verifyEmailConfig(
        row
          ? { ...row, config: m.merged }
          : { channel: "email", enabled: false, config: m.merged, updated_at: 0 }
      );
      return NextResponse.json(result);
    }

    // IA: llamada mínima real con el proveedor/clave/modelo del formulario.
    if (channel === "llm") {
      const row = (await getAllChannelSettings())["llm"];
      const m = mergeConfig(row?.config, body?.config);
      if ("maskError" in m) return NextResponse.json({ ok: false, detail: m.maskError });
      const result = await verifyLlmConfig(m.merged);
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
