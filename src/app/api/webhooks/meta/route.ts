import { NextResponse, type NextRequest } from "next/server";
import {
  enqueueForContact,
  persistInbound,
  respondToInbound,
  type InboundMessage,
} from "@/lib/reply-engine";
import { updateLeadFields } from "@/lib/db";
import {
  fetchProfileName,
  getChannelSettingsCached,
  getWebhookVerifyToken,
  sendChannelText,
  verifyMetaSignature,
} from "@/lib/meta";
import type { Channel } from "@/lib/channels";

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

interface MessengerEvent {
  sender?: { id?: string };
  message?: { mid?: string; text?: string; is_echo?: boolean };
}

interface WhatsAppApiMessage {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
}

interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    messaging?: MessengerEvent[];
    changes?: Array<{
      value?: {
        messages?: WhatsAppApiMessage[];
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
      };
    }>;
  }>;
}

// ── Recepción de eventos ────────────────────────────────────
// Diseño en dos fases:
// 1. PERSISTIR (rápido, solo DB) ANTES de responder el 200 — si falla,
//    Meta recibe 500 y reintenta: ningún mensaje se pierde por un deploy o
//    un hipo de Supabase.
// 2. RESPONDER (LLM + envío, tarda segundos) en segundo plano después del
//    200 — Meta exige respuesta rápida o deshabilita el webhook.
// Ambas fases van por la cadena por contacto (mensajes del mismo cliente en
// serie), y cada evento tiene su propio try/catch: un mensaje malo no
// descarta el resto del batch.
export async function POST(req: NextRequest) {
  const raw = await req.text();

  const validSignature = await verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"));
  if (!validSignature) {
    return NextResponse.json({ error: "firma inválida" }, { status: 401 });
  }

  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(raw) as MetaWebhookPayload;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  let persistErrors = 0;
  try {
    persistErrors = await persistPhase(payload);
  } catch (err) {
    console.error("[webhook] Error persistiendo eventos de Meta:", err);
    return NextResponse.json({ error: "persistencia falló" }, { status: 500 });
  }
  // Si TODO el batch falló al persistir, que Meta lo reintente completo
  // (el dedup evita duplicar los que sí alcanzaron a guardarse).
  if (persistErrors > 0) {
    return NextResponse.json({ error: `${persistErrors} eventos fallaron` }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

// Extrae los mensajes soportados del payload como InboundMessage.
function extractInbound(
  payload: MetaWebhookPayload,
  settings: Record<string, { enabled: boolean }>
): InboundMessage[] {
  const out: InboundMessage[] = [];

  if (payload.object === "page" || payload.object === "instagram") {
    const channel: Channel = payload.object === "page" ? "messenger" : "instagram";
    if (!settings[channel]?.enabled) return out;
    for (const entry of payload.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        const senderId = event.sender?.id;
        const text = event.message?.text;
        // is_echo = mensajes enviados por la propia página; se ignoran.
        if (!senderId || !text || event.message?.is_echo) continue;
        out.push({
          channel,
          externalId: senderId,
          text,
          dedupeKey: event.message?.mid ?? null,
          send: (reply) => sendChannelText(channel, senderId, reply),
        });
      }
    }
    return out;
  }

  if (payload.object === "whatsapp_business_account") {
    if (!settings["whatsapp_api"]?.enabled) return out;
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value?.messages) continue; // statuses/otros eventos: fuera de scope
        for (const message of value.messages) {
          if (message.type !== "text" || !message.from || !message.text?.body) continue;
          const from = message.from;
          out.push({
            channel: "whatsapp_api",
            externalId: from,
            phone: from,
            text: message.text.body,
            name: value.contacts?.find((c) => c.wa_id === from)?.profile?.name ?? null,
            dedupeKey: message.id ?? null,
            send: (reply) => sendChannelText("whatsapp_api", from, reply),
          });
        }
      }
    }
    return out;
  }

  console.log(`[webhook] Objeto no soportado ignorado: ${payload.object}`);
  return out;
}

// Fase 1 para todo el batch. Devuelve cuántos eventos fallaron al persistir.
async function persistPhase(payload: MetaWebhookPayload): Promise<number> {
  const settings = await getChannelSettingsCached();
  const messages = extractInbound(payload, settings);
  let failures = 0;

  for (const msg of messages) {
    const chainKey = `${msg.channel}:${msg.externalId}`;
    try {
      const persisted = await enqueueForContact(chainKey, () => persistInbound(msg));
      if (!persisted) continue; // duplicado

      // Fase 2 en segundo plano, encadenada al mismo contacto.
      void enqueueForContact(chainKey, async () => {
        // Nombre del perfil solo si aún no lo tenemos (una llamada por lead,
        // no por mensaje).
        if (!persisted.name && (msg.channel === "messenger" || msg.channel === "instagram")) {
          const name = await fetchProfileName(msg.channel, msg.externalId);
          if (name) {
            try {
              await updateLeadFields(persisted.conversationId, { name });
            } catch (err) {
              console.error("[webhook] No se pudo guardar el nombre del perfil:", err);
            }
          }
        }
        await respondToInbound(persisted, msg);
      }).catch((err) =>
        console.error(`[webhook] Error respondiendo a ${chainKey}:`, err)
      );
    } catch (err) {
      failures++;
      console.error(`[webhook] Error persistiendo mensaje de ${chainKey}:`, err);
    }
  }
  return failures;
}
