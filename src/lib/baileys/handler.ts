// Adaptador de Baileys al motor de respuestas compartido: filtra los eventos
// de WhatsApp (grupos, multimedia, mensajes propios), extrae el texto y el
// número, y delega el pipeline (IA, CRM, derivación) a reply-engine.
import {
  normalizeMessageContent,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { handleInbound } from "../reply-engine";
import { isInternalPhone } from "./client";

function extractText(msg: WAMessage): string | null {
  // normalizeMessageContent desenvuelve ephemeralMessage (mensajes
  // temporales, muy comunes), viewOnceMessage, etc. Sin esto, esos chats
  // quedaban mudos: el texto venía envuelto y se trataba como multimedia.
  const m = normalizeMessageContent(msg.message);
  if (!m) return null;
  // Solo texto en v1: audio/imagen/sticker quedan fuera del scope.
  return m.conversation || m.extendedTextMessage?.text || null;
}

// WhatsApp moderno entrega muchos chats 1:1 con JID "@lid" (número oculto)
// en vez del clásico "<numero>@s.whatsapp.net". En esos casos el número real
// viene en msg.key.senderPn. Sin este manejo, los mensajes de esos contactos
// se descartaban en silencio y el bot parecía "muerto".
function resolvePhone(msg: WAMessage, jid: string): string | null {
  if (jid.endsWith("@s.whatsapp.net")) {
    return jid.split("@")[0].split(":")[0] || null;
  }
  const pn = msg.key.senderPn;
  if (pn) return pn.split("@")[0].split(":")[0] || null;
  return null;
}

export function registerMessageHandler(sock: WASocket, accountId: number): void {
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // Solo mensajes nuevos en tiempo real; 'append'/'replace' son sync de historial.
    if (type !== "notify") return;
    for (const msg of messages) {
      try {
        await handleIncoming(sock, msg, accountId);
      } catch (err) {
        console.error("[bot] Error procesando mensaje entrante:", err);
      }
    }
  });
}

async function handleIncoming(sock: WASocket, msg: WAMessage, accountId: number): Promise<void> {
  // Ignorar mensajes propios (enviados desde el teléfono del usuario).
  if (msg.key.fromMe) return;

  // Solo chats 1:1: @s.whatsapp.net clásico o @lid (número oculto).
  // Grupos (@g.us), broadcast y newsletter quedan fuera del scope v1.
  const jid = msg.key.remoteJid;
  if (!jid) return;
  if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@lid")) {
    console.log(`[bot] Mensaje ignorado (chat no soportado en v1): ${jid}`);
    return;
  }

  // Extraer texto; si no hay (multimedia/protocolo), ignorar.
  const text = extractText(msg);
  if (!text) {
    // Se loguea el tipo de contenido para poder diagnosticar sin adivinar.
    const kinds = Object.keys(msg.message ?? {}).join(", ") || "(vacío)";
    console.log(`[bot] Mensaje sin texto ignorado de ${jid} — contenido: ${kinds}`);
    return;
  }

  const phone = resolvePhone(msg, jid);
  if (!phone) {
    console.warn(`[bot] ⚠️ Mensaje @lid sin senderPn — no se puede mapear a un número (jid=${jid})`);
    return;
  }

  // CRÍTICO con varias cuentas: los mensajes de números internos (otras
  // cuentas propias — abiertas o no — y teléfonos de avisos del equipo) NO
  // son leads. Sin este guard, la sesión B respondería con IA al aviso "se
  // te asignó el lead X" de la cuenta A (loop bot↔bot), y la respuesta de
  // un vendedor a su aviso crearía un lead basura atendido por la IA.
  if (isInternalPhone(phone)) {
    console.log(`[bot] Mensaje de un número interno (${phone}) ignorado`);
    return;
  }

  await handleInbound({
    channel: "whatsapp",
    externalId: phone,
    phone,
    name: msg.pushName ?? undefined,
    text,
    dedupeKey: msg.key.id,
    waAccountId: accountId,
    // La respuesta sale por el MISMO jid del mensaje (funciona para @lid).
    send: async (reply) => {
      await sock.sendMessage(jid, { text: reply });
    },
  });
}
