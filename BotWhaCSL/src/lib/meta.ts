// Cliente de la Graph API de Meta: envío de mensajes por WhatsApp Cloud
// API, verificación de firma de webhooks y pruebas de conexión. La
// configuración (tokens) vive en channel_settings POR ORGANIZACIÓN: cada
// cliente de la agencia conecta su propio canal. El webhook y el App Secret
// son de la app de Meta de la AGENCIA (modelo "proveedor de tecnología"):
// una sola app, muchos clientes conectados.
import crypto from "node:crypto";
import diagnosticsChannel from "node:diagnostics_channel";
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
// Global del proceso: Next carga este módulo en más de una copia (arranque y
// rutas) y guardar la configuración debe invalidar la caché de TODAS.
const CACHE_TTL_MS = 15_000;
const cache = ((globalThis as typeof globalThis & {
  __botwhaChannelSettingsCache?: {
    org: Map<number, { at: number; rows: Record<string, ChannelSettingsRow> }>;
    all: { at: number; rows: ChannelSettingsRow[] } | null;
  };
}).__botwhaChannelSettingsCache ??= { org: new Map(), all: null });

export async function getChannelSettingsCached(
  orgId: number
): Promise<Record<string, ChannelSettingsRow>> {
  const hit = cache.org.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
  const rows = await getAllChannelSettings(orgId);
  cache.org.set(orgId, { at: Date.now(), rows });
  return rows;
}

// Filas de TODAS las organizaciones (webhook: enrutar eventos y validar
// firmas; bot: toggles por organización).
export async function getAllOrgsChannelSettingsCached(): Promise<ChannelSettingsRow[]> {
  if (cache.all && Date.now() - cache.all.at < CACHE_TTL_MS) return cache.all.rows;
  const rows = await listAllChannelSettings();
  cache.all = { at: Date.now(), rows };
  return rows;
}

export function invalidateChannelSettingsCache(): void {
  cache.org.clear();
  cache.all = null;
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

// La Graph API no acepta un id propio para deduplicar envíos: si la conexión
// se corta DESPUÉS de mandar el pedido (timeout, conexión reseteada), Meta
// pudo haberlo aceptado y reintentar duplicaría el mensaje al cliente. Solo
// es seguro reintentar si el pedido nunca salió: la conexión no llegó a
// establecerse (DNS, TCP, TLS, certificado) o fetch lo rechazó antes.
const NEVER_CONNECTED = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|ENETUNREACH|EHOSTUNREACH/;

// undici (el fetch de Node) publica en este canal todo fallo de la fase de
// conexión, siempre ANTES de escribir el pedido, con el mismo objeto de
// error que luego llega como causa del "fetch failed". Global del proceso:
// Next carga este módulo en más de una copia.
const connectFailures = ((globalThis as typeof globalThis & {
  __botwhaConnectFailures?: WeakSet<object>;
}).__botwhaConnectFailures ??= (() => {
  const failures = new WeakSet<object>();
  diagnosticsChannel.subscribe("undici:client:connectError", (message) => {
    const error = (message as { error?: unknown }).error;
    if (error && typeof error === "object") failures.add(error);
  });
  return failures;
})());

function neverSent(err: unknown, detail: string): boolean {
  // Rechazado antes de tocar la red (cabecera o URL inválida, p.ej. un
  // carácter invisible en el token): los fallos de red son "fetch failed".
  if (err instanceof TypeError && err.message !== "fetch failed") return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    if (connectFailures.has(cause)) return true;
    // Respaldo por si el canal no publicara: señales que solo da la conexión.
    const c = cause as { syscall?: string; errors?: unknown; message?: string; code?: string };
    if (c.syscall === "connect" || Array.isArray(c.errors)) return true;
    if (/before secure TLS connection was established|bad port/i.test(c.message ?? "")) return true;
    if (/^ERR_(SSL|TLS)_|CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO/.test(c.code ?? "")) return true;
  }
  return NEVER_CONNECTED.test(detail);
}

export class MetaUncertainError extends Error {
  readonly code = "META_UNCERTAIN";
}

// ¿El envío quedó en duda (pudo haber salido)? Por `code`: Next puede cargar
// este módulo en más de una copia, con clases distintas.
export function isUncertainDelivery(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "META_UNCERTAIN";
}

async function graphFetch(url: string, init: RequestInit, context: string): Promise<unknown> {
  // Con timeout: un envío colgado no debe bloquear la cola de un contacto.
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = `${err instanceof Error ? err.message : String(err)} ${cause?.code ?? ""} ${cause?.message ?? ""}`;
    if (init.method === "POST" && !neverSent(err, detail)) {
      throw new MetaUncertainError(`Meta (${context}): sin confirmación de envío (${detail.trim()})`);
    }
    throw err;
  }
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

// Devuelve el wamid del mensaje enviado (o null si Meta no lo informó).
async function sendWhatsAppApiMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  text: string
): Promise<string | null> {
  const body = (await graphFetch(
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
  )) as { messages?: { id?: string }[] } | null;
  return body?.messages?.[0]?.id ?? null;
}

// Envía texto por WhatsApp Cloud API CON LOS TOKENS DE LA ORGANIZACIÓN
// dueña de la conversación. Para 'whatsapp' (Baileys) NO usar esto: ese
// envío requiere el socket del proceso bot. Devuelve el wamid.
export async function sendChannelText(
  orgId: number,
  channel: Channel,
  recipientId: string,
  text: string,
  // Configuración ya leída (outbox del bot: la del tick). Una lectura de la
  // base no debe quedar dentro del tope de tiempo de una entrega: vencerse
  // ahí no significa "pudo haber salido".
  preloaded?: Record<string, ChannelSettingsRow>
): Promise<string | null> {
  const rows = preloaded ?? (await getChannelSettingsCached(orgId));
  switch (channel) {
    case "whatsapp_api":
      return sendWhatsAppApiMessage(
        requireConfig(rows, "whatsapp_api", "phone_number_id"),
        requireConfig(rows, "whatsapp_api", "access_token"),
        recipientId,
        text
      );
    default:
      throw new Error(`sendChannelText no soporta el canal '${channel}'`);
  }
}

// ¿La organización tiene el canal habilitado? (las respuestas automáticas
// no salen por un canal apagado).
export async function isChannelEnabled(orgId: number, channel: Channel): Promise<boolean> {
  const rows = await getChannelSettingsCached(orgId);
  return !!rows[channel]?.enabled;
}

// ── Webhook ─────────────────────────────────────────────────

// Valida X-Hub-Signature-256 contra el app_secret configurado. Sin App
// Secret el webhook se RECHAZA ("unconfigured"): aceptar sin firma permitía
// que cualquiera inyectara mensajes falsos de clientes (y que el bot les
// respondiera). Solo para pruebas locales existe la variable
// META_WEBHOOK_ALLOW_UNSIGNED=1, ignorada en producción.
export async function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null
): Promise<"ok" | "invalid" | "unconfigured"> {
  // El webhook es de la app de Meta de la AGENCIA (una sola app para todos
  // los clientes): su secreto vive en la organización 1.
  const rows = await getChannelSettingsCached(AGENCY_ORG_ID);
  const secrets = [rows["meta_webhook"]?.config?.app_secret].filter((s): s is string => !!s);
  if (secrets.length === 0) {
    const allowUnsigned =
      process.env.META_WEBHOOK_ALLOW_UNSIGNED === "1" && process.env.NODE_ENV !== "production";
    return allowUnsigned ? "ok" : "unconfigured";
  }
  if (!signatureHeader?.startsWith("sha256=")) return "invalid";
  const received = signatureHeader.slice("sha256=".length);
  for (const secret of secrets) {
    const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    try {
      if (timingSafeEqualHex(expected, received)) return "ok";
    } catch {
      /* firma malformada: probar el siguiente secreto */
    }
  }
  return "invalid";
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
// si UNA sola organización tiene el canal habilitado SIN ID registrado, es
// suya. Si no se puede identificar devuelve null: el webhook guarda el
// mensaje en la agencia SIN respuesta automática (responderlo saldría desde
// OTRO número, no desde el que el cliente escribió).
export async function resolveOrgForEvent(
  channel: "whatsapp_api",
  recipientId: string
): Promise<number | null> {
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
    `[webhook] ⚠️ Evento de ${channel} para '${recipientId}' sin organización identificable ` +
      `(${candidates.length} organizaciones con el canal activo sin ID registrado) — se guarda en la agencia sin respuesta automática. ` +
      `Registra ese phone_number_id en el canal de la organización correcta.`
  );
  return null;
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
