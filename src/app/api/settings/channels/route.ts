import { NextResponse, type NextRequest } from "next/server";
import { getAllChannelSettings, upsertChannelSettings } from "@/lib/db";
import { invalidateChannelSettingsCache } from "@/lib/meta";
import { invalidateLlmCache } from "@/lib/llm";
import { isChannel } from "@/lib/channels";

export const dynamic = "force-dynamic";

// Filas configurables: los 4 canales + webhook de Meta + cuenta de correo +
// proveedor de IA (llm).
const SETTING_KEYS = [
  "whatsapp",
  "whatsapp_api",
  "messenger",
  "instagram",
  "meta_webhook",
  "email",
  "llm",
];

// Campos secretos: al leer se enmascaran (••••XXXX); al guardar, un valor
// enmascarado significa "no lo cambies".
const SECRET_FIELDS = new Set(["page_access_token", "access_token", "app_secret", "password", "api_key"]);
const MASK_PREFIX = "••••";

// Secretos de ≤4 caracteres: máscara sin sufijo (si no, se devolverían enteros).
function maskValue(value: string): string {
  return value.length <= 4 ? MASK_PREFIX : `${MASK_PREFIX}${value.slice(-4)}`;
}

export async function GET() {
  try {
    const rows = await getAllChannelSettings();
    const out: Record<string, { enabled: boolean; config: Record<string, string> }> = {};
    for (const key of SETTING_KEYS) {
      const row = rows[key];
      const config: Record<string, string> = {};
      for (const [k, v] of Object.entries(row?.config ?? {})) {
        config[k] = SECRET_FIELDS.has(k) && v ? maskValue(v) : v;
      }
      out[key] = { enabled: row?.enabled ?? (key === "whatsapp" ? true : false), config };
    }
    return NextResponse.json({ settings: out });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    const hint = /channel_settings|does not exist/i.test(message)
      ? " — Falta la migración multicanal: re-ejecuta supabase/schema.sql completo en el SQL Editor."
      : "";
    return NextResponse.json({ error: message + hint }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      channel?: unknown;
      enabled?: unknown;
      config?: unknown;
    } | null;
    const channel = body?.channel;
    if (typeof channel !== "string" || !SETTING_KEYS.includes(channel)) {
      return NextResponse.json({ error: "channel inválido" }, { status: 400 });
    }
    if (
      channel !== "meta_webhook" &&
      channel !== "email" &&
      channel !== "llm" &&
      !isChannel(channel)
    ) {
      return NextResponse.json({ error: "channel inválido" }, { status: 400 });
    }
    const enabled = body?.enabled === true;

    // Merge: la máscara EXACTA del valor guardado significa "sin cambios";
    // string vacío borra el campo. Un valor que empiece por la máscara pero
    // traiga más contenido (token pegado detrás de la máscara en un input
    // password) se rechaza con error en vez de descartarse en silencio.
    const existing = (await getAllChannelSettings())[channel];
    const config: Record<string, string> = { ...(existing?.config ?? {}) };
    if (body?.config && typeof body.config === "object") {
      for (const [k, v] of Object.entries(body.config as Record<string, unknown>)) {
        if (typeof v !== "string") continue;
        const value = v.trim();
        const current = existing?.config?.[k];
        if (current && value === maskValue(current)) continue; // sin cambios
        if (value.startsWith(MASK_PREFIX)) {
          return NextResponse.json(
            {
              error: `El campo '${k}' contiene la máscara del valor anterior. Borra el contenido del campo y pega el valor completo.`,
            },
            { status: 400 }
          );
        }
        if (value === "") delete config[k];
        else config[k] = value;
      }
    }

    await upsertChannelSettings(channel, enabled, config);
    invalidateChannelSettingsCache();
    // El proveedor de IA se cachea aparte en este proceso (el del bot expira
    // solo en ≤15 s).
    if (channel === "llm") invalidateLlmCache();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
