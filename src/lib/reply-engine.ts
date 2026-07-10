// Motor de respuestas compartido por TODOS los canales (Baileys, Messenger,
// Instagram, WhatsApp API): persistencia, análisis de IA, derivación a
// humano y respuesta del LLM. Cada canal solo aporta cómo se envía el texto.
import {
  addLeadEvent,
  getConversationById,
  getOrCreateConversation,
  getRecentHistory,
  insertMessage,
  routeLeadForStage,
  setConversationWaAccount,
  setMode,
} from "./db";
import { generateReply } from "./llm";
import { maybeAnalyzeLead } from "./lead-analysis";
import { HANDOFF_PHRASE } from "./system-prompt";
import type { Channel } from "./channels";

// ── Dedup de mensajes entrantes ─────────────────────────────
// Los canales pueden re-entregar el mismo mensaje (Baileys tras reconectar,
// Meta reintenta webhooks sin 200). Cache FIFO en memoria de claves ya
// PERSISTIDAS: se marca solo DESPUÉS de guardar en DB, para que un fallo
// transitorio no convierta la re-entrega en pérdida definitiva.
const processedKeys = new Set<string>();
const MAX_PROCESSED = 1000;

function isDuplicate(key: string | null | undefined): boolean {
  return !!key && processedKeys.has(key);
}

function markProcessed(key: string | null | undefined): void {
  if (!key) return;
  processedKeys.add(key);
  if (processedKeys.size > MAX_PROCESSED) {
    const oldest = processedKeys.values().next().value;
    if (oldest) processedKeys.delete(oldest);
  }
}

// ── Derivación automática a humano ─────────────────────────

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // sin tildes, para comparar robusto
}

// El cliente pide explícitamente un humano ("quiero hablar con una persona",
// "que me atienda un asesor", "no quiero hablar con un bot", ...).
export function clientRequestsHuman(text: string): boolean {
  const t = normalizeText(text);
  const mentionsHuman = /\b(humano|persona|asesor(a)?|agente|operador(a)?|alguien)\b/.test(t);
  if (mentionsHuman) {
    if (
      /\b(hablar|hableme|comunica(me|r)?|contacta(r|me)?|atienda|atencion|pasa(me)?|conecta(me)?|transfiere(me)?|transferir|deriva(me)?|necesito|quiero|puedo hablar)\b/.test(t)
    ) {
      return true;
    }
    if (/\b(persona|humano|asesor)\b[\s\w]*\b(real|de verdad)\b/.test(t)) return true;
  }
  return /\bno\b[\s\w]*\b(bot|robot|maquina|ia)\b/.test(t);
}

// El LLM respondió con la frase de derivación del system prompt.
function botOfferedHandoff(reply: string): boolean {
  return normalizeText(reply).includes(normalizeText(HANDOFF_PHRASE).replace(/\.$/, ""));
}

// Cambia la conversación a modo HUMANO y deja rastro en la actividad del
// lead. Best-effort: si la DB parpadea, se loguea y el flujo sigue.
async function handOffToHuman(conversationId: number, reason: string): Promise<void> {
  console.log(`[bot] 🤝 Conversación ${conversationId} derivada a HUMANO: ${reason}`);
  try {
    await setMode(conversationId, "HUMAN");
  } catch (err) {
    console.error(`[bot] No se pudo cambiar a HUMAN la conversación ${conversationId}:`, err);
    return;
  }
  try {
    await addLeadEvent(conversationId, "handoff", reason);
  } catch (err) {
    console.error("[bot] No se pudo registrar el evento de derivación:", err);
  }
}

// ── Serialización por contacto ──────────────────────────────
// Los webhooks de Meta llegan como POSTs concurrentes: dos mensajes rápidos
// del mismo cliente correrían el pipeline en paralelo (dos respuestas del
// LLM cruzadas, carrera con la derivación a humano). Cada contacto tiene su
// cadena de promesas: sus mensajes se procesan en serie, contactos distintos
// en paralelo.
const contactChains = new Map<string, Promise<unknown>>();

export function enqueueForContact<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = contactChains.get(key) ?? Promise.resolve();
  const next = prev.then(task, task); // corre aunque la tarea anterior haya fallado
  const tail = next.then(
    () => undefined,
    () => undefined
  );
  contactChains.set(key, tail);
  // Limpieza: si nadie encadenó nada nuevo, se libera la entrada del mapa.
  void tail.then(() => {
    if (contactChains.get(key) === tail) contactChains.delete(key);
  });
  return next;
}

// ── Pipeline de entrada ─────────────────────────────────────

export interface InboundMessage {
  channel: Channel;
  // Identificador del remitente en su canal (teléfono, PSID, IGSID).
  externalId: string;
  text: string;
  name?: string | null;
  phone?: string | null;
  // Id único del mensaje en el canal, para dedup (wamid, mid, key.id).
  dedupeKey?: string | null;
  // Cuenta de WhatsApp que recibió el mensaje (solo canal 'whatsapp' con
  // varias cuentas; los canales de Meta no la usan).
  waAccountId?: number | null;
  // Envío de texto por el canal de origen (closure con el socket/token).
  send: (text: string) => Promise<void>;
}

export interface PersistedInbound {
  conversationId: number;
  // El nombre actual del lead (para que el caller decida si buscar perfil).
  name: string | null;
}

// FASE 1 — Persistencia (rápida, solo DB). El webhook la espera ANTES de
// responderle 200 a Meta: si fallara, Meta reintenta y el mensaje no se
// pierde. Devuelve null si el mensaje es un duplicado.
export async function persistInbound(msg: InboundMessage): Promise<PersistedInbound | null> {
  const key = msg.dedupeKey ? `${msg.channel}:${msg.dedupeKey}` : null;
  if (isDuplicate(key)) return null;

  console.log(`[bot] ← [${msg.channel}] ${msg.externalId}: "${msg.text.slice(0, 80)}"`);

  const convo = await getOrCreateConversation(msg.channel, msg.externalId, {
    name: msg.name ?? undefined,
    phone: msg.phone ?? undefined,
  });
  // Lead recién creado (sin mensajes previos): es el ÚNICO momento en que
  // puede dispararse la regla de enrutamiento de la etapa NUEVO — los leads
  // nacen en NUEVO sin pasar por set_stage. Best-effort.
  const isNewLead = convo.last_message_at === null;
  await insertMessage(convo.id, "user", msg.text);
  markProcessed(key);

  if (isNewLead && (convo.stage ?? "NUEVO") === "NUEVO") {
    routeLeadForStage(convo.id, "NUEVO").catch((err) =>
      console.error("[bot] No se pudo enrutar el lead nuevo:", err)
    );
  }

  // Con varias cuentas de WhatsApp: se recuerda por cuál habla el lead
  // (última que recibió su mensaje). Best-effort: no bloquea la respuesta.
  if (msg.waAccountId != null && convo.wa_account_id !== msg.waAccountId) {
    try {
      await setConversationWaAccount(convo.id, msg.waAccountId);
    } catch (err) {
      console.error("[bot] No se pudo actualizar la cuenta de la conversación:", err);
    }
  }

  // CRM: análisis de IA en segundo plano (score, resumen, próximo paso).
  // Con debounce interno; nunca bloquea ni tumba el flujo de respuesta.
  void maybeAnalyzeLead(convo.id);

  return { conversationId: convo.id, name: convo.name ?? msg.name ?? null };
}

// FASE 2 — Respuesta (modo, derivación, LLM, envío). Puede tardar segundos;
// el webhook la corre en segundo plano después del 200.
export async function respondToInbound(
  persisted: PersistedInbound,
  msg: InboundMessage
): Promise<void> {
  const conversationId = persisted.conversationId;

  // RE-LEER el modo: el toggle AI/HUMAN pudo cambiar desde el dashboard.
  const fresh = await getConversationById(conversationId);
  if (!fresh || fresh.mode !== "AI") {
    console.log(`[bot] Conversación ${conversationId} en modo HUMAN — no se responde automáticamente`);
    return;
  }

  // Derivación explícita: el cliente pidió hablar con un humano. El cambio a
  // HUMANO va PRIMERO: si el envío del acuse falla (token vencido, ventana
  // de 24h, socket caído), lo importante — que el bot se calle y el operador
  // se entere — ya quedó hecho.
  if (clientRequestsHuman(msg.text)) {
    await handOffToHuman(conversationId, "El cliente pidió hablar con un humano");
    const ack = "Claro, te comunico con un asesor humano. En un momento te atienden.";
    try {
      await msg.send(ack);
      console.log(`[bot] → [${msg.channel}] ${msg.externalId} (confirmación de derivación)`);
      await insertMessage(conversationId, "assistant", ack);
    } catch (err) {
      console.error("[bot] No se pudo enviar/guardar la confirmación de derivación:", err);
    }
    return;
  }

  // Modo AI: generar respuesta con historial reciente y responder.
  const history = await getRecentHistory(conversationId, 20);
  console.log(`[bot] Llamando al LLM con ${history.length} mensajes de contexto...`);
  const t0 = Date.now();

  let reply: string;
  try {
    reply = await generateReply(history);
  } catch (err) {
    // Si el LLM falla (429, key inválida, etc.) NO se cae el proceso: el
    // mensaje del cliente ya quedó guardado y visible en el dashboard.
    console.error("[bot] Error del LLM (no se envía respuesta automática):", err);
    return;
  }
  console.log(`[bot] LLM respondió en ${Date.now() - t0}ms`);

  // Enviar PRIMERO y persistir después: si se persistiera antes y el envío
  // fallara, quedaría un "mensaje fantasma" en el historial y en el
  // contexto del LLM sin haber llegado nunca al cliente.
  await msg.send(reply);
  console.log(`[bot] → [${msg.channel}] ${msg.externalId}`);
  try {
    await insertMessage(conversationId, "assistant", reply);
  } catch (err) {
    console.error(
      "[bot] ⚠️ La respuesta se envió pero no se pudo guardar en DB (no aparecerá en el dashboard):",
      err
    );
  }

  // El propio LLM decidió derivar (respondió la frase del system prompt).
  if (botOfferedHandoff(reply)) {
    await handOffToHuman(conversationId, "El bot derivó la conversación (no pudo resolverla)");
  }
}

// Pipeline completo serializado por contacto (lo usa el adaptador de
// Baileys; el webhook de Meta usa las dos fases por separado).
export async function handleInbound(msg: InboundMessage): Promise<void> {
  const chainKey = `${msg.channel}:${msg.externalId}`;
  await enqueueForContact(chainKey, async () => {
    const persisted = await persistInbound(msg);
    if (persisted) await respondToInbound(persisted, msg);
  });
}
