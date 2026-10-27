import { NextResponse, type NextRequest } from "next/server";
import {
  AGENCY_ORG_ID,
  addLeadEvent,
  findConversation,
  getOrCreateConversation,
  setMode,
  withDbRetry,
} from "@/lib/db";
import {
  contactKey,
  enqueueForContact,
  persistInbound,
  scheduleReplyPass,
  type InboundMessage,
} from "@/lib/reply-engine";
import { startCloudApiReplies } from "@/lib/cloud-api-replies";
import {
  getAllOrgsChannelSettingsCached,
  getWebhookVerifyToken,
  resolveOrgForEvent,
  verifyMetaSignature,
} from "@/lib/meta";

export const dynamic = "force-dynamic";

// ── Verificación del webhook (la hace Meta al suscribirlo) ──
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  const expected = await getWebhookVerifyToken().catch(() => null);
  if (mode === "subscribe" && expected && token === expected && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return NextResponse.json({ error: "verify_token inválido o sin configurar" }, { status: 403 });
}

// ── Tipos mínimos de los eventos que consumimos ─────────────

interface WhatsAppApiMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string; filename?: string };
  audio?: { voice?: boolean };
  location?: { name?: string; address?: string };
  contacts?: Array<{ name?: { formatted_name?: string } }>;
  interactive?: {
    type?: string;
    button_reply?: { title?: string };
    list_reply?: { title?: string };
    nfm_reply?: { name?: string; body?: string };
  };
  button?: { text?: string };
  order?: { text?: string; product_items?: Array<{ quantity?: number }> };
}

interface WhatsAppApiStatus {
  id?: string;
  status?: string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}

interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        // phone_number_id del DESTINATARIO: la llave para enrutar el evento
        // a su organización.
        metadata?: { phone_number_id?: string; display_phone_number?: string };
        messages?: WhatsAppApiMessage[];
        statuses?: WhatsAppApiStatus[];
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
      };
    }>;
  }>;
}

// Texto del mensaje; lo que el bot no puede leer se guarda con una marca
// explícita (el operador lo ve y la IA pide que lo escriban). null = no es
// un mensaje que haya que guardar (reacciones, eventos del sistema).
function messageText(m: WhatsAppApiMessage): string | null {
  const withCaption = (tag: string, caption?: string) => (caption?.trim() ? `${tag} ${caption.trim()}` : tag);
  switch (m.type) {
    case "text":
      return m.text?.body || null;
    case "interactive":
      if (m.interactive?.type === "nfm_reply") {
        return withCaption(`[Formulario enviado${m.interactive.nfm_reply?.name ? `: ${m.interactive.nfm_reply.name}` : ""}]`, m.interactive.nfm_reply?.body);
      }
      return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || null;
    case "button":
      return m.button?.text || null;
    case "image":
      return withCaption("[Imagen (no se puede ver)]", m.image?.caption);
    case "video":
      return withCaption("[Video (no se puede ver)]", m.video?.caption);
    case "document": {
      const name = m.document?.filename ? `: ${m.document.filename}` : "";
      return withCaption(`[Documento${name} (no se puede abrir)]`, m.document?.caption);
    }
    case "audio":
      return m.audio?.voice ? "[Nota de voz (no se puede escuchar)]" : "[Audio (no se puede escuchar)]";
    case "sticker":
      return "[Sticker]";
    case "location": {
      const label = [m.location?.name, m.location?.address].filter(Boolean).join(", ");
      return label ? `[Ubicación: ${label}]` : "[Ubicación]";
    }
    case "contacts":
      return `[Contacto: ${m.contacts?.[0]?.name?.formatted_name ?? "sin nombre"}]`;
    // Pedido del catálogo: intención de compra, nunca se ignora.
    case "order": {
      const items = (m.order?.product_items ?? []).reduce((n, p) => n + (p.quantity ?? 1), 0);
      return withCaption(`[Pedido del catálogo: ${items || "varios"} producto(s)]`, m.order?.text);
    }
    // Encuestas, mensajes de una sola vista y otros tipos que la Cloud API no
    // entrega: el cliente escribió algo, el operador debe verlo.
    case "unsupported":
    case "unknown":
      return "[Mensaje de un tipo que WhatsApp API no entrega: ábrelo en el teléfono]";
    default:
      return null;
  }
}

// Mensaje a un número de WhatsApp API que no está registrado en ninguna
// organización (Canales → WhatsApp API → phone_number_id).
interface Unrouted {
  recipientId: string;
  displayPhone: string | null;
}

// ── Recepción de eventos ────────────────────────────────────
// El webhook SOLO persiste (idempotente; en orden por contacto, contactos
// en paralelo) y responde 200 rápido, como exige Meta. La respuesta al
// cliente la arma el motor en segundo plano mirando el hilo en la base; si
// el servidor se reinicia antes de responder, el barrido la retoma. Si la
// persistencia falla: 500 y Meta re-entrega (la idempotencia evita
// duplicar lo que sí alcanzó a guardarse).
export async function POST(req: NextRequest) {
  const raw = await req.text();

  let signature: "ok" | "invalid" | "unconfigured";
  try {
    signature = await verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"));
  } catch (err) {
    // No es una firma inválida: la base no respondió. 503 y Meta re-entrega.
    console.error("[webhook] No se pudo leer el App Secret para validar la firma:", err);
    return NextResponse.json({ error: "configuración no disponible por ahora" }, { status: 503 });
  }
  if (signature === "unconfigured") {
    console.error(
      "[webhook] ❌ Webhook de Meta rechazado: falta el App Secret (Canales → Webhook de Meta). " +
        "Sin él cualquiera podría inyectar mensajes falsos."
    );
    return NextResponse.json({ error: "App Secret de Meta sin configurar" }, { status: 503 });
  }
  if (signature !== "ok") {
    return NextResponse.json({ error: "firma inválida" }, { status: 401 });
  }

  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(raw) as MetaWebhookPayload;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  startCloudApiReplies();

  let events: Awaited<ReturnType<typeof extractEvents>>;
  try {
    events = await extractEvents(payload);
  } catch (err) {
    console.error("[webhook] Error leyendo eventos de Meta:", err);
    return NextResponse.json({ error: "persistencia falló" }, { status: 500 });
  }
  const { messages } = events;

  // Encolado SINCRÓNICO en orden: los mensajes de un mismo contacto se
  // guardan en orden; los de contactos distintos, en paralelo.
  const results = await Promise.allSettled(
    messages.map(({ inbound, unrouted }) =>
      enqueueForContact(contactKey(inbound.orgId, inbound.channel, inbound.externalId), async () => {
        // A un número no registrado: se guarda (no se pierde) pero NO se
        // responde solo — saldría desde otro número. La conversación pasa a
        // un asesor ANTES de guardar el mensaje (el barrido no lo ve en IA).
        if (unrouted) await holdUnrouted(inbound);
        const persisted = await persistInbound(inbound, { attempts: 3, baseDelayMs: 300, maxDelayMs: 1500 });
        if (persisted?.inserted && unrouted) noteUnrouted(persisted.conversationId, unrouted);
        return persisted;
      })
    )
  );
  let failures = 0;
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      failures++;
      console.error(`[webhook] Error persistiendo mensaje de ${messages[i].inbound.externalId}:`, r.reason);
    } else if (r.value && !messages[i].unrouted) {
      scheduleReplyPass(r.value.conversationId);
    }
  });

  // Envíos que Meta no pudo entregar: DESPUÉS de los mensajes (una falla
  // aquí no los frena). Si no se pudieron registrar, 500 y Meta re-entrega
  // el evento (los mensajes ya guardados no se duplican).
  try {
    await recordFailedDeliveries(events.failed);
  } catch (err) {
    console.error("[webhook] No se pudieron registrar envíos fallidos:", err);
    failures++;
  }

  if (failures > 0) {
    return NextResponse.json({ error: `${failures} eventos fallaron` }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

async function holdUnrouted(inbound: InboundMessage): Promise<void> {
  const retry = { attempts: 3, baseDelayMs: 300 };
  const conv = await withDbRetry(
    () =>
      getOrCreateConversation(inbound.orgId, inbound.channel, inbound.externalId, {
        name: inbound.name ?? undefined,
        phone: inbound.phone ?? undefined,
        mode: "HUMAN",
      }),
    retry
  );
  if (conv.mode !== "HUMAN") await withDbRetry(() => setMode(conv.id, "HUMAN"), retry);
}

function noteUnrouted(conversationId: number, u: Unrouted): void {
  const number = u.displayPhone ?? u.recipientId;
  console.warn(`[webhook] ⚠️ Mensaje al número ${number} (no registrado): conversación ${conversationId} en manos de un asesor`);
  addLeadEvent(
    conversationId,
    "handoff",
    `El cliente escribió al número de WhatsApp API ${number} (phone_number_id ${u.recipientId}), que no está registrado en Canales: no se respondió automáticamente. Regístralo en la organización correcta.`
  ).catch(() => undefined);
}

interface FailedDelivery {
  orgId: number;
  recipient: string;
  detail: string;
}

// Extrae los mensajes como InboundMessage (organización resuelta por el
// phone_number_id del destinatario) y los envíos que Meta reporta fallidos.
async function extractEvents(
  payload: MetaWebhookPayload
): Promise<{ messages: { inbound: InboundMessage; unrouted: Unrouted | null }[]; failed: FailedDelivery[] }> {
  const messages: { inbound: InboundMessage; unrouted: Unrouted | null }[] = [];
  const failed: FailedDelivery[] = [];
  if (payload.object !== "whatsapp_business_account") {
    console.log(`[webhook] Objeto no soportado ignorado: ${payload.object}`);
    return { messages, failed };
  }
  const allRows = await getAllOrgsChannelSettingsCached();

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages && !value?.statuses) continue;
      const recipientId = value.metadata?.phone_number_id ?? "";
      const resolved = await resolveOrgForEvent("whatsapp_api", recipientId);
      // Sin organización identificable: los mensajes NO se descartan (Meta no
      // los re-envía): se guardan en la agencia, sin respuesta automática.
      const unrouted: Unrouted | null =
        resolved === null ? { recipientId, displayPhone: value.metadata?.display_phone_number ?? null } : null;
      const orgId = resolved ?? AGENCY_ORG_ID;
      // Con el canal apagado los mensajes SE GUARDAN igual (el operador los
      // ve); solo no hay respuesta automática.
      if (!unrouted && !allRows.some((r) => r.org_id === orgId && r.channel === "whatsapp_api" && r.enabled)) {
        console.warn(
          `[webhook] Mensajes de whatsapp_api para '${recipientId}' con el canal deshabilitado en la organización ${orgId}: se guardan sin respuesta automática.`
        );
      }

      if (!unrouted) {
        for (const status of value.statuses ?? []) {
          if (status.status !== "failed" || !status.recipient_id) continue;
          const error = status.errors?.[0];
          failed.push({
            orgId,
            recipient: status.recipient_id,
            detail: `${error?.title ?? error?.message ?? "error desconocido"}${error?.code ? ` (código ${error.code})` : ""}`,
          });
        }
      }

      for (const message of value.messages ?? []) {
        const text = message.from ? messageText(message) : null;
        if (!message.from) continue;
        if (!text) {
          if (message.type !== "reaction") {
            console.log(`[webhook] Mensaje de tipo '${message.type}' de ${message.from} sin contenido para guardar: ignorado`);
          }
          continue;
        }
        const from = message.from;
        const sentAt = Number(message.timestamp);
        messages.push({
          inbound: {
            orgId,
            channel: "whatsapp_api",
            externalId: from,
            phone: from,
            text,
            name: value.contacts?.find((c) => c.wa_id === from)?.profile?.name ?? null,
            dedupeKey: message.id ?? null,
            sentAt: Number.isFinite(sentAt) && sentAt > 0 ? sentAt : null,
          },
          unrouted,
        });
      }
    }
  }
  return { messages, failed };
}

// Meta informa de forma asíncrona los envíos que no pudo entregar (p.ej.
// fuera de la ventana de 24 h): queda visible en la actividad del lead en
// vez de figurar como enviado.
async function recordFailedDeliveries(failed: FailedDelivery[]): Promise<void> {
  for (const f of failed) {
    const conv = await withDbRetry(() => findConversation(f.orgId, "whatsapp_api", f.recipient), {
      attempts: 3,
      baseDelayMs: 300,
    });
    if (!conv) continue;
    console.error(`[webhook] ⚠️ Meta no entregó un mensaje a ${f.recipient}: ${f.detail}`);
    await withDbRetry(
      () => addLeadEvent(conv.id, "delivery_error", `WhatsApp no entregó un mensaje: ${f.detail}`),
      { attempts: 3, baseDelayMs: 300 }
    );
  }
}
