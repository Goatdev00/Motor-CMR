// Cliente de la Graph API de Meta: envío de mensajes por Messenger,
// Instagram DM y WhatsApp Cloud API, verificación de firma de webhooks y
// pruebas de conexión. La configuración (tokens) vive en channel_settings
// (Supabase) y se edita desde la pestaña "Canales" del dashboard.
import crypto from "node:crypto";
import { getAllChannelSettings, type ChannelSettingsRow } from "./db";
import type { Channel } from "./channels";

const GRAPH = "https://graph.facebook.com/v21.0";
// API de Instagram con "inicio de sesión de Instagram" (apps nuevas de Meta):
// mismo contrato de mensajería pero en otro host y con tokens IGAA….
const IG_GRAPH = "https://graph.instagram.com/v21.0";

// Los tokens de página empiezan por EAA…; los del inicio de sesión de
// Instagram por IGAA…. Según el tipo, los DMs de Instagram se hablan con
// graph.facebook.com (plataforma Messenger, apps antiguas) o con
// graph.instagram.com (apps nuevas).
function instagramApiBase(token: string): string {
  return token.startsWith("IG") ? IG_GRAPH : GRAPH;
}

// Cache corto: el webhook y el outbox leen settings en cada mensaje; 15s de
// TTL evita golpear Supabase sin retrasar demasiado un cambio de token.
let cache: { at: number; rows: Record<string, ChannelSettingsRow> } | null = null;
const CACHE_TTL_MS = 15_000;

export async function getChannelSettingsCached(): Promise<Record<string, ChannelSettingsRow>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  const rows = await getAllChannelSettings();
  cache = { at: Date.now(), rows };
  return rows;
}

export function invalidateChannelSettingsCache(): void {
  cache = null;
}

function requireConfig(
  rows: Record<string, ChannelSettingsRow>,
  channel: string,
  key: string
): string {
  const value = rows[channel]?.config?.[key];
  if (!value) {
    throw new Error(
      `El canal '${channel}' no tiene configurado '${key}'. Complétalo en el dashboard → Canales.`
    );
  }
  return value;
}

async function graphFetch(url: string, init: RequestInit, context: string): Promise<unknown> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => null)) as
    | { error?: { message?: string; code?: number } }
    | null;
  if (!res.ok) {
    const detail = body?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Meta (${context}): ${detail}`);
  }
  return body;
}

// ── Envío de texto por canal ────────────────────────────────

async function sendPageMessage(
  pageToken: string,
  recipientId: string,
  text: string,
  base: string = GRAPH
): Promise<void> {
  await graphFetch(
    `${base}/me/messages?access_token=${encodeURIComponent(pageToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text },
      }),
    },
    "send"
  );
}

async function sendWhatsAppApiMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  text: string
): Promise<void> {
  await graphFetch(
    `${GRAPH}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    },
    "send whatsapp_api"
  );
}

// Envía texto por cualquier canal de Meta. Para 'whatsapp' (Baileys) NO usar
// esto: ese envío requiere el socket del proceso bot.
export async function sendChannelText(
  channel: Channel,
  recipientId: string,
  text: string
): Promise<void> {
  const rows = await getChannelSettingsCached();
  switch (channel) {
    case "messenger":
      await sendPageMessage(requireConfig(rows, "messenger", "page_access_token"), recipientId, text);
      return;
    case "instagram": {
      const token = requireConfig(rows, "instagram", "page_access_token");
      await sendPageMessage(token, recipientId, text, instagramApiBase(token));
      return;
    }
    case "whatsapp_api":
      await sendWhatsAppApiMessage(
        requireConfig(rows, "whatsapp_api", "phone_number_id"),
        requireConfig(rows, "whatsapp_api", "access_token"),
        recipientId,
        text
      );
      return;
    default:
      throw new Error(`sendChannelText no soporta el canal '${channel}'`);
  }
}

// ── Webhook ─────────────────────────────────────────────────

// Valida X-Hub-Signature-256 con el app_secret configurado. Si no hay
// app_secret guardado, se acepta (recomendado configurarlo en producción).
export async function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null
): Promise<boolean> {
  const rows = await getChannelSettingsCached();
  const appSecret = rows["meta_webhook"]?.config?.app_secret;
  if (!appSecret) return true;
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
  } catch {
    return false;
  }
}

export async function getWebhookVerifyToken(): Promise<string | null> {
  const rows = await getChannelSettingsCached();
  return rows["meta_webhook"]?.config?.verify_token ?? null;
}

// Nombre del contacto, best-effort (para la lista y el CRM).
export async function fetchProfileName(
  channel: Channel,
  userId: string
): Promise<string | null> {
  try {
    const rows = await getChannelSettingsCached();
    const token =
      channel === "instagram"
        ? rows["instagram"]?.config?.page_access_token
        : rows["messenger"]?.config?.page_access_token;
    if (!token) return null;
    const base = channel === "instagram" ? instagramApiBase(token) : GRAPH;
    const fields = channel === "instagram" ? "name,username" : "first_name,last_name,name";
    const body = (await graphFetch(
      `${base}/${userId}?fields=${fields}&access_token=${encodeURIComponent(token)}`,
      {},
      "profile"
    )) as { name?: string; username?: string; first_name?: string; last_name?: string };
    return (
      body.name ||
      body.username ||
      [body.first_name, body.last_name].filter(Boolean).join(" ") ||
      null
    );
  } catch {
    return null;
  }
}

// ── Prueba de conexión desde el dashboard ───────────────────

// Misma máscara que usa la API de settings al devolver secretos (••••XXXX).
const MASK_PREFIX = "••••";
function maskValue(value: string): string {
  return value.length <= 4 ? MASK_PREFIX : `${MASK_PREFIX}${value.slice(-4)}`;
}

// overrides: valores del formulario aún no guardados. La máscara EXACTA del
// valor guardado significa "prueba lo persistido"; pero máscara + texto
// pegado encima es un error del operador (pegó sin borrar el campo) y se
// reporta — ignorarlo en silencio hacía que la prueba validara el token
// VIEJO y saliera en verde con un token nuevo incorrecto.
export async function testChannel(
  channel: Channel,
  overrides?: Record<string, string>
): Promise<{ ok: boolean; detail: string }> {
  let rows = await getChannelSettingsCached();
  if (overrides) {
    const merged: Record<string, string> = { ...(rows[channel]?.config ?? {}) };
    for (const [k, v] of Object.entries(overrides)) {
      const value = v.trim();
      if (!value) continue;
      const current = rows[channel]?.config?.[k];
      if (current && value === maskValue(current)) continue; // probar lo guardado
      if (value.startsWith(MASK_PREFIX)) {
        return {
          ok: false,
          detail: `El campo '${k}' contiene la máscara del valor anterior con texto pegado encima — borra el campo COMPLETO y pega el valor de nuevo (no se probó nada).`,
        };
      }
      merged[k] = value;
    }
    rows = {
      ...rows,
      [channel]: {
        channel,
        enabled: rows[channel]?.enabled ?? false,
        config: merged,
        updated_at: rows[channel]?.updated_at ?? 0,
      },
    };
  }
  try {
    if (channel === "instagram") {
      const token = requireConfig(rows, "instagram", "page_access_token");
      // Token IGAA… (API de Instagram con inicio de sesión de Instagram):
      // se valida contra graph.instagram.com — es el camino de apps nuevas.
      if (token.startsWith("IG")) {
        const body = (await graphFetch(
          `${IG_GRAPH}/me?fields=username,name&access_token=${encodeURIComponent(token)}`,
          {},
          "test"
        )) as { username?: string; name?: string };
        return {
          ok: true,
          detail: `Conectado a Instagram como @${body.username ?? "?"}${body.name ? ` (${body.name})` : ""}`,
        };
      }
      // Token de página (EAA…): cae al flujo de la plataforma Messenger.
    }
    if (channel === "messenger" || channel === "instagram") {
      const token = requireConfig(rows, channel, "page_access_token");
      try {
        const body = (await graphFetch(
          `${GRAPH}/me?access_token=${encodeURIComponent(token)}`,
          {},
          "test"
        )) as { name?: string; id?: string };
        return { ok: true, detail: `Conectado como "${body.name ?? body.id}"` };
      } catch {
        // Leer la página (GET /me) exige pages_read_engagement o funciones
        // que pasan por revisión de Meta — pero el bot NO lee la página:
        // envía mensajes (pages_messaging). Los tokens generados desde los
        // "casos de uso" nuevos suelen traer solo lo de mensajería, así que
        // se valida contra el endpoint de mensajería antes de dar error.
        await graphFetch(
          `${GRAPH}/me/messenger_profile?access_token=${encodeURIComponent(token)}`,
          {},
          "test"
        );
        return {
          ok: true,
          detail:
            "Token válido para mensajería. (No permite leer el nombre de la página — falta pages_read_engagement — pero eso no afecta el envío ni la recepción de mensajes.)",
        };
      }
    }
    if (channel === "whatsapp_api") {
      const phoneNumberId = requireConfig(rows, "whatsapp_api", "phone_number_id");
      const token = requireConfig(rows, "whatsapp_api", "access_token");
      const body = (await graphFetch(
        `${GRAPH}/${phoneNumberId}?fields=display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${token}` } },
        "test"
      )) as { display_phone_number?: string; verified_name?: string };
      return {
        ok: true,
        detail: `Número ${body.display_phone_number ?? "?"} (${body.verified_name ?? "sin nombre"})`,
      };
    }
    return { ok: false, detail: "Canal no soportado para prueba" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "Error desconocido" };
  }
}
