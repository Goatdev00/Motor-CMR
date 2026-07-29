// Cliente de la Graph API de Meta: envío de mensajes por WhatsApp Cloud
// API, verificación de firma de webhooks y pruebas de conexión. La
// configuración (tokens) vive en channel_settings POR ORGANIZACIÓN: cada
// cliente de la agencia conecta su propio canal. El webhook y el App Secret
// son de la app de Meta de la AGENCIA (modelo "proveedor de tecnología"):
// una sola app, muchos clientes conectados.
import crypto from "node:crypto";
import {
  AGENCY_ORG_ID,
  getAllChannelSettings,
  listAllChannelSettings,
  type ChannelSettingsRow,
} from "./db";
import type { Channel } from "./channels";

const GRAPH = "https://graph.facebook.com/v21.0";

// Cache corto: el webhook y el outbox leen settings en cada mensaje; 15s de
// TTL evita golpear Supabase sin retrasar demasiado un cambio de token.
const CACHE_TTL_MS = 15_000;
const orgCache = new Map<number, { at: number; rows: Record<string, ChannelSettingsRow> }>();
let allCache: { at: number; rows: ChannelSettingsRow[] } | null = null;

export async function getChannelSettingsCached(
  orgId: number
): Promise<Record<string, ChannelSettingsRow>> {
  const hit = orgCache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
  const rows = await getAllChannelSettings(orgId);
  orgCache.set(orgId, { at: Date.now(), rows });
  return rows;
}

// Filas de TODAS las organizaciones (webhook: enrutar eventos y validar
// firmas; bot: toggles por organización).
export async function getAllOrgsChannelSettingsCached(): Promise<ChannelSettingsRow[]> {
  if (allCache && Date.now() - allCache.at < CACHE_TTL_MS) return allCache.rows;
  const rows = await listAllChannelSettings();
  allCache = { at: Date.now(), rows };
  return rows;
}

export function invalidateChannelSettingsCache(): void {
  orgCache.clear();
  allCache = null;
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

// Envía texto por WhatsApp Cloud API CON LOS TOKENS DE LA ORGANIZACIÓN
// dueña de la conversación. Para 'whatsapp' (Baileys) NO usar esto: ese
// envío requiere el socket del proceso bot.
export async function sendChannelText(
  orgId: number,
  channel: Channel,
  recipientId: string,
  text: string
): Promise<void> {
  const rows = await getChannelSettingsCached(orgId);
  switch (channel) {
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

// Valida X-Hub-Signature-256 contra el app_secret configurado. Si no hay
// ningún secreto guardado, se acepta (recomendado configurarlo en
// producción).
export async function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null
): Promise<boolean> {
  // El webhook es de la app de Meta de la AGENCIA (una sola app para todos
  // los clientes): su secreto vive en la organización 1.
  const rows = await getChannelSettingsCached(AGENCY_ORG_ID);
  const secrets = [rows["meta_webhook"]?.config?.app_secret].filter((s): s is string => !!s);
  if (secrets.length === 0) return true;
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const received = signatureHeader.slice("sha256=".length);
  for (const secret of secrets) {
    const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    try {
      if (timingSafeEqualHex(expected, received)) return true;
    } catch {
      /* firma malformada: probar el siguiente secreto */
    }
  }
  return false;
}

function timingSafeEqualHex(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function getWebhookVerifyToken(): Promise<string | null> {
  const rows = await getChannelSettingsCached(AGENCY_ORG_ID);
  return rows["meta_webhook"]?.config?.verify_token ?? null;
}

// ── Enrutamiento de eventos del webhook a su organización ───
// La app de Meta es una sola (de la agencia), pero cada evento trae el ID
// del DESTINATARIO: el phone_number_id (WhatsApp API). Se busca la
// organización cuyo canal tiene ese ID registrado en su config. Fallback:
// si UNA sola organización tiene el canal habilitado, es suya; si no, la
// agencia (org 1) con aviso en logs.
export async function resolveOrgForEvent(
  channel: "whatsapp_api",
  recipientId: string
): Promise<number> {
  const rows = await getAllOrgsChannelSettingsCached();
  const idKey = "phone_number_id";
  const channelRows = rows.filter((r) => r.channel === channel);

  // Match por ID registrado. Si dos organizaciones tienen el mismo ID (una
  // config vieja deshabilitada tras migrar un cliente), gana la HABILITADA.
  const matches = channelRows.filter((r) => !!recipientId && r.config?.[idKey] === recipientId);
  const match = matches.find((r) => r.enabled) ?? matches[0];
  if (match) return match.org_id;

  // Fallback de organización única: SOLO cuentan las habilitadas cuyo ID
  // aún no se conoce — si una fila tiene un ID registrado DISTINTO al del
  // evento, se sabe positivamente que el evento no es suyo.
  const candidates = channelRows.filter((r) => r.enabled && !r.config?.[idKey]);
  if (candidates.length === 1) return candidates[0].org_id;

  console.warn(
    `[webhook] Evento de ${channel} para '${recipientId}' sin organización identificable ` +
      `(${candidates.length} organizaciones con el canal activo sin ID registrado) — se asigna ` +
      `a la agencia. Configura el phone_number_id del canal en la organización correcta.`
  );
  return AGENCY_ORG_ID;
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
  orgId: number,
  channel: Channel,
  overrides?: Record<string, string>
): Promise<{ ok: boolean; detail: string }> {
  let rows = await getChannelSettingsCached(orgId);
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
        org_id: orgId,
      },
    };
  }
  try {
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
