// Motor de respuestas compartido por TODOS los canales (WhatsApp por Baileys
// y WhatsApp API). Dos fases, cada una con su propia cola:
//   1. PERSISTIR (rápida, idempotente, con reintentos): cada mensaje del
//      cliente queda guardado en orden y una sola vez, aunque Supabase
//      parpadee o el canal lo re-entregue.
//   2. RESPONDER: un "pase" por conversación, serializado por conversación,
//      que mira el estado REAL del hilo en la base (palabras clave,
//      derivación, IA) y responde una sola vez a todo lo pendiente, con el
//      contexto completo de ESA persona. Un barrido periódico retoma lo que
//      haya quedado sin responder (reinicio, corte de red, fallo de la IA).
// Cada proceso responde SU canal (bot → Baileys, Next → Cloud API): nunca
// compiten por la misma conversación. El aislamiento entre clientes viene de
// que todo se direcciona por conversationId — nada se comparte entre hilos.
import {
  addLeadEvent,
  discardOutboxItem,
  enqueueBotReply,
  getConversationById,
  getOrCreateConversation,
  getRecentHistory,
  hasHumanReplyAfter,
  listQueuedBotReplies,
  insertMessageIdempotent,
  isAutomatedMessageId,
  isTransientDbError,
  listPendingAiReplies,
  routeLeadForStage,
  setConversationWaAccount,
  setMode,
  withDbRetry,
  type Conversation,
  type Message,
  type QueuedBotReply,
} from "./db";
import { generateReply, isRetryableLlmError, withLlmSlot } from "./llm";
import { maybeAnalyzeLead } from "./lead-analysis";
import { HANDOFF_PHRASE } from "./system-prompt";
import { findMatchingTrigger, getKeywordTriggersCached } from "./templates";
import { selectAgentForInbound } from "./ai-agents";
import type { Channel } from "./channels";

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

// Acuse que se envía al cliente cuando pide un humano (el chat de prueba
// lo reutiliza para simular exactamente lo mismo).
export const HANDOFF_ACK = "Claro, te comunico con un asesor humano. En un momento te atienden.";

// El LLM respondió con la frase de derivación del system prompt.
// Exportada para que el chat de prueba detecte la derivación igual que acá.
export function botOfferedHandoff(reply: string): boolean {
  return normalizeText(reply).includes(normalizeText(HANDOFF_PHRASE).replace(/\.$/, ""));
}

// Cambia la conversación a modo HUMANO (con reintentos: si no queda en
// HUMANO, el bot seguiría contestando encima del asesor) y deja rastro en la
// actividad del lead. Lanza si no se pudo cambiar el modo.
async function handOffToHuman(conversationId: number, reason: string): Promise<void> {
  console.log(`[bot] 🤝 Conversación ${conversationId} derivada a HUMANO: ${reason}`);
  await withDbRetry(() => setMode(conversationId, "HUMAN"), { attempts: 5, label: "derivar a humano" });
  addLeadEvent(conversationId, "handoff", reason).catch((err) =>
    console.error("[bot] No se pudo registrar el evento de derivación:", err)
  );
}

// ── Estado del motor ────────────────────────────────────────
// Global del proceso (no del módulo): en Next la ruta del webhook y el
// arranque (instrumentation) pueden cargar copias distintas de este
// archivo, y ambas deben ver las MISMAS colas y marcas — si no, un barrido
// y un pase en vivo podrían responder dos veces la misma conversación.
interface EngineState {
  chains: Map<string, Promise<unknown>>;
  processedKeys: Set<string>;
  config: EngineConfig | null;
  draining: boolean;
  routes: Map<number, ReplyRoute>;
  passQueued: Set<number>;
  passRunning: Set<number>;
  evaluatedUpTo: Map<number, number>;
  answeredUpTo: Map<number, number>;
  settledUpTo: Map<number, { id: number; at: number }>;
  staleDiscards: Map<number, number>;
  failures: Map<number, { count: number; firstAt: number; nextAt: number }>;
  pendingRecords: {
    conversationId: number;
    content: string;
    channelMsgId: string | null;
    coversMsgId: number | null;
    attempts: number;
  }[];
  // Hora del canal (cuándo escribió el cliente) por id de mensaje guardado.
  sentAtById: Map<number, number>;
  // Pausas de la IA (un asesor escribió desde el teléfono) que la base aún
  // no confirmó: mientras tanto el motor ya trata la conversación como
  // HUMANA, y el tick reintenta el cambio.
  pendingHandoffs: Map<number, { reason: string; at: number }>;
  // Encolados cuya confirmación se perdió (la fila pudo quedar): qué cubría,
  // con qué texto, y el id más alto del hilo que el pase conocía al
  // intentarlo. Si la fila entregada no dice qué cubrió, con esto no se
  // responde dos veces lo mismo.
  queuedAttempts: Map<number, { covers: number; afterId: number; text: string }>;
  // Conversaciones con un pase ya programado para más tarde (esperando la
  // cola o mensajes sin guardar): una sola espera por conversación.
  retryArmed: Set<number>;
  // Pases programados para más tarde (espera de la cola, reintento tras un
  // fallo): se cancelan al apagar.
  timers: Set<NodeJS.Timeout>;
  // Respuesta que pudo haber salido sin confirmación (ver unconfirmedFor).
  unconfirmed: Map<number, { key: string; covers: number; id: string; text: string; at: number }>;
  // Acuse de derivación que no alcanzó a salir (canal caído): los pases
  // siguientes lo reintentan aunque la conversación ya sea HUMANA.
  pendingAcks: Map<number, { msgId: number; at: number }>;
  // Id más alto del hilo que conoce el último pase de cada conversación (lo
  // que leyó más lo que el propio pase guardó).
  seenUpTo: Map<number, number>;
  // Conversaciones con un reintento pendiente, anotadas en disco (ver
  // RetryStore): un reinicio no pierde lo que quedó sin responder. resume:
  // las que dejó así el proceso anterior, para retomarlas al arrancar.
  journal: Map<number, RetryEntry>;
  resume: Set<number>;
  journalDirty: boolean;
}

const globalStore = globalThis as typeof globalThis & { __botwhaReplyEngine?: EngineState };
const S: EngineState = (globalStore.__botwhaReplyEngine ??= {
  chains: new Map(),
  processedKeys: new Set(),
  config: null,
  draining: false,
  routes: new Map(),
  passQueued: new Set(),
  passRunning: new Set(),
  evaluatedUpTo: new Map(),
  answeredUpTo: new Map(),
  settledUpTo: new Map(),
  staleDiscards: new Map(),
  failures: new Map(),
  pendingRecords: [],
  sentAtById: new Map(),
  pendingHandoffs: new Map(),
  queuedAttempts: new Map(),
  retryArmed: new Set(),
  timers: new Set(),
  unconfirmed: new Map(),
  pendingAcks: new Map(),
  seenUpTo: new Map(),
  journal: new Map(),
  resume: new Set(),
  journalDirty: false,
});
// Next conserva globalThis entre recargas en desarrollo: un estado creado por
// una versión anterior de este archivo puede no tener los campos nuevos.
S.queuedAttempts ??= new Map();
S.retryArmed ??= new Set();
S.timers ??= new Set();
S.unconfirmed ??= new Map();
S.pendingAcks ??= new Map();
S.seenUpTo ??= new Map();
S.journal ??= new Map();
S.resume ??= new Set();
S.journalDirty ??= false;

// Pausa la IA porque un asesor tomó la conversación por fuera del dashboard
// (escribió desde el teléfono del negocio). Si la base no responde, el motor
// igual la trata como HUMANA desde ya y el tick reintenta el cambio.
export async function pauseAiForHuman(conversationId: number, reason: string): Promise<void> {
  S.pendingHandoffs.set(conversationId, { reason, at: Date.now() });
  try {
    await withDbRetry(() => setMode(conversationId, "HUMAN"), {
      attempts: 7,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      label: "pausar IA",
    });
    S.pendingHandoffs.delete(conversationId);
    addLeadEvent(conversationId, "handoff", reason).catch(() => undefined);
  } catch (err) {
    console.error(`[bot] ⚠️ No se pudo pausar la IA de la conversación ${conversationId} (se reintenta):`, err);
  }
}

// ── Colas serializadas por clave ────────────────────────────
// Tareas con la misma clave corren en serie y en orden de llegada; claves
// distintas, en paralelo. Se usa para persistir (por contacto), responder
// (por conversación) y resolver identidades (por cuenta de WhatsApp).
const chains = S.chains;

export function enqueueForContact<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(task, task); // corre aunque la tarea anterior haya fallado
  const tail = next.then(
    () => undefined,
    () => undefined
  );
  chains.set(key, tail);
  // Limpieza: si nadie encadenó nada nuevo, se libera la entrada del mapa.
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return next;
}

// Clave de persistencia de un contacto: incluye la organización (el mismo
// número puede ser lead de dos organizaciones).
export function contactKey(orgId: number, channel: Channel, externalId: string): string {
  return `persist:${orgId}:${channel}:${externalId}`;
}

// ¿Hay trabajo en curso o en espera en esa cola?
export function isChainBusy(key: string): boolean {
  return chains.has(key);
}

// Cantidad de colas con trabajo pendiente cuyo nombre empieza con prefix
// (p.ej. "intake:" / "persist:" para esperar lo recibido antes de apagar).
export function busyChains(prefix: string): number {
  let n = 0;
  for (const key of chains.keys()) if (key.startsWith(prefix)) n++;
  return n;
}

// ¿Hay una pausa de la IA (asesor desde el teléfono) sin confirmar en la base?
export function hasPendingHandoff(conversationId: number): boolean {
  return S.pendingHandoffs.has(conversationId);
}

// ── Dedup rápido en memoria ─────────────────────────────────
// Primera línea contra re-entregas inmediatas (Baileys tras reconectar, Meta
// reintentando). La garantía real es el índice único (conversación, id del
// mensaje en su canal) de la base. Se marca DESPUÉS de guardar: un fallo
// transitorio no convierte la re-entrega en pérdida.
const processedKeys = S.processedKeys;
const MAX_PROCESSED = 5000;

function isDuplicate(key: string | null): boolean {
  return !!key && processedKeys.has(key);
}

function markProcessed(key: string | null): void {
  if (!key) return;
  processedKeys.add(key);
  if (processedKeys.size > MAX_PROCESSED) {
    const oldest = processedKeys.values().next().value;
    if (oldest) processedKeys.delete(oldest);
  }
}

// ── FASE 1: persistencia ────────────────────────────────────

export interface InboundMessage {
  // Organización dueña del canal que recibió el mensaje: el lead nace en su
  // espacio y se responde con SUS tokens/configuración.
  orgId: number;
  channel: Channel;
  // Identificador del remitente en su canal (teléfono / wa_id).
  externalId: string;
  text: string;
  name?: string | null;
  phone?: string | null;
  // Id único del mensaje en el canal (key.id, wamid): idempotencia.
  dedupeKey?: string | null;
  // Hora del mensaje según el canal (epoch s): ordena el historial por
  // cuándo escribió el cliente.
  sentAt?: number | null;
  // Cuenta de WhatsApp que recibió el mensaje (solo Baileys).
  waAccountId?: number | null;
}

export interface PersistedInbound {
  conversationId: number;
  messageId: number;
  // false = ya estaba guardado (re-entrega o reintento).
  inserted: boolean;
  // El nombre actual del lead (para que el caller decida si buscar perfil).
  name: string | null;
}

export interface PersistOptions {
  // Presupuesto de reintentos ante errores transitorios de Supabase. Baileys
  // ya confirmó la entrega al remitente (no re-envía): reintenta largo. El
  // webhook de Meta, corto: si falla, responde 500 y Meta re-entrega.
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

// Tope de largo de un mensaje guardado. Se recorta sin partir un emoji: un
// par sustituto suelto hace que la base rechace el texto en cada reintento.
const MAX_MESSAGE_CHARS = 4000;
export function clampText(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  const cut = text.slice(0, MAX_MESSAGE_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

// Guarda el mensaje del cliente. Devuelve null si es un duplicado inmediato
// (ya visto en memoria). Lanza si Supabase no responde tras los reintentos.
export async function persistInbound(
  input: InboundMessage,
  opts: PersistOptions = {}
): Promise<PersistedInbound | null> {
  const msg = { ...input, text: clampText(input.text) };
  const key = msg.dedupeKey ? `${msg.orgId}:${msg.channel}:${msg.dedupeKey}` : null;
  if (isDuplicate(key)) return null;

  console.log(
    `[bot] ← [org ${msg.orgId}] [${msg.channel}] ${msg.externalId}: "${msg.text.slice(0, 80)}"`
  );

  const retry = {
    attempts: opts.attempts ?? 4,
    baseDelayMs: opts.baseDelayMs ?? 500,
    maxDelayMs: opts.maxDelayMs ?? 8000,
  };
  const convo = await withDbRetry(
    () =>
      getOrCreateConversation(msg.orgId, msg.channel, msg.externalId, {
        name: msg.name ?? undefined,
        phone: msg.phone ?? undefined,
      }),
    { ...retry, label: `guardar mensaje de ${msg.externalId} (conversación)` }
  );
  // Lead recién creado: es el ÚNICO momento en que puede dispararse la regla
  // de enrutamiento de la etapa NUEVO — los leads nacen en NUEVO sin pasar
  // por set_stage. Cuenta el primer mensaje DEL CLIENTE: la bienvenida
  // automática de WhatsApp Business (que se guarda antes que el mensaje de un
  // anuncio) o el mensaje con que un asesor abrió el chat no lo vuelven
  // "viejo". Un lead que ya tiene responsable no se re-enruta.
  const isNewLead = convo.last_user_message_at == null && convo.assigned_member_id == null;
  // El hilo queda en orden de LLEGADA (no por la hora del canal): así un
  // mensaje atrasado nunca queda "antes" de una respuesta que no lo
  // contempló, y el pase siguiente lo responde. La hora del canal solo
  // decide si es demasiado viejo para responderlo solo (sentAtById).
  let attempts = 0;
  const { message, inserted: insertedNow } = await withDbRetry(
    () => {
      attempts++;
      return insertMessageIdempotent(convo.id, "user", msg.text, {
        channelMsgId: msg.dedupeKey ?? null,
        sentAt: msg.sentAt ?? null,
      });
    },
    { ...retry, label: `guardar mensaje de ${msg.externalId}` }
  );
  // "Ya estaba" en un REINTENTO = lo guardó nuestro intento anterior (se
  // aplicó pero la respuesta se perdió en un corte): sigue siendo nuevo.
  const inserted = insertedNow || attempts > 1;
  markProcessed(key);
  if (msg.sentAt) {
    S.sentAtById.set(message.id, msg.sentAt);
    prune(S.sentAtById);
  }

  if (inserted) {
    if (isNewLead && (convo.stage ?? "NUEVO") === "NUEVO") {
      routeLeadForStage(convo.id, "NUEVO").catch((err) =>
        console.error("[bot] No se pudo enrutar el lead nuevo:", err)
      );
    }
    // Con varias cuentas de WhatsApp: se recuerda por cuál habla el lead
    // (última que recibió su mensaje). Best-effort.
    if (msg.waAccountId != null && convo.wa_account_id !== msg.waAccountId) {
      const accountId = msg.waAccountId;
      withDbRetry(() => setConversationWaAccount(convo.id, accountId)).catch((err) =>
        console.error("[bot] No se pudo actualizar la cuenta de la conversación:", err)
      );
    }
    // CRM: análisis de IA en segundo plano (score, resumen, próximo paso).
    void maybeAnalyzeLead(convo.id);
  }

  return {
    conversationId: convo.id,
    messageId: message.id,
    inserted,
    name: convo.name ?? msg.name ?? null,
  };
}

// ── FASE 2: respuesta ───────────────────────────────────────

// Por dónde responder: la cuenta y el jid EXACTOS por los que escribió el
// cliente (Baileys: puede ser @lid). En memoria; tras un reinicio se usa la
// cuenta guardada en la conversación y su número.
export interface ReplyRoute {
  waAccountId: number | null;
  jid: string | null;
  // Número conectado de esa cuenta cuando llegó el mensaje: si la cuenta se
  // re-vincula a OTRO número, la respuesta no sale desde el número nuevo.
  accountPhone: string | null;
}

export interface ReplyTarget {
  conversation: Conversation;
  route: ReplyRoute | null;
  // Id estable del envío: los reintentos reutilizan el mismo (en Baileys,
  // WhatsApp descarta el duplicado si el primer intento sí había salido; la
  // Cloud API no admite id propio, así que allí un envío incierto no se
  // reintenta — ver cloud-api-replies).
  messageId: string;
  // Última verificación, que el canal llama JUSTO antes de enviar (después
  // de esperar una reconexión, que puede tardar): si devuelve un motivo, la
  // respuesta ya no corresponde (un asesor tomó el chat...) y no se envía.
  beforeSend?: () => Promise<string | null>;
}

// Envío por el canal; devuelve el id del mensaje en el canal (para guardarlo
// idempotente). Lanza si no pudo entregar: PermanentSendError cuando
// reintentar no tiene sentido (canal apagado, cuenta re-vinculada);
// ReplySupersededError cuando beforeSend dijo que ya no corresponde.
export type ReplySender = (target: ReplyTarget, text: string) => Promise<{ channelMsgId: string | null }>;

// Se reconocen por su `code` y no con instanceof: Next puede cargar este
// módulo en más de una copia (arranque y rutas), cada una con sus propias
// clases, y el canal configurado en una copia lanza errores de esa copia.
export class PermanentSendError extends Error {
  readonly code = "SEND_PERMANENT";
}
export class ReplySupersededError extends Error {
  readonly code = "REPLY_SUPERSEDED";
}
// El canal no confirmó si el envío salió y repetirlo podría duplicarlo
// (Cloud API: sin id propio para deduplicar). No se reintenta ni se encola.
export class UncertainSendError extends Error {
  readonly code = "SEND_UNCERTAIN";
}
const hasCode = (err: unknown, code: string): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
export const isPermanentSendError = (err: unknown): err is Error => hasCode(err, "SEND_PERMANENT");
export const isReplySupersededError = (err: unknown): err is Error => hasCode(err, "REPLY_SUPERSEDED");
export const isUncertainSendError = (err: unknown): err is Error => hasCode(err, "SEND_UNCERTAIN");
// db.ts: la base no tiene la migración que permite dejar respuestas en cola.
const isQueueUnsupportedError = (err: unknown): err is Error => hasCode(err, "QUEUE_UNSUPPORTED");

// Lo usan los canales: verificación final justo antes de enviar.
export async function assertStillValid(target: ReplyTarget): Promise<void> {
  const reason = target.beforeSend ? await target.beforeSend() : null;
  if (reason) throw new ReplySupersededError(reason);
}

interface EngineConfig {
  channels: Channel[];
  send: ReplySender;
  newMessageId: () => string;
  // Motivo por el que NO se puede responder esta conversación (canal
  // apagado...), o null. Se consulta antes de llamar a la IA.
  cannotReply?: (conv: Conversation) => Promise<string | null>;
  // ¿Hay mensajes de este contacto que el proceso todavía no guardó (p.ej.
  // en el respaldo en disco durante un corte de la base)? Mientras tanto no
  // se le responde: entre ellos puede estar la respuesta de un asesor. Se le
  // responde cuando todo lo suyo quedó guardado.
  inboundPending?: (conv: Conversation) => boolean;
  // Dónde anotar las conversaciones con un reintento pendiente (ver
  // RetryEntry). Sin esto, un reinicio solo cuenta con lo que dice el hilo.
  retryStore?: RetryStore;
}

// Conversación cuyo último pase falló (o quedó a medias al apagar). Sin la
// migración el hilo no dice qué cubrió cada respuesta: al arrancar, lo
// anterior a la última respuesta guardada se da por respondido, y lo que el
// cliente escribió justo antes de una respuesta que no lo vio quedaba sin
// responder. Con esto el proceso nuevo sabe hasta dónde se había respondido
// de verdad, y retoma el acuse de derivación y el reintento con el mismo id.
export interface RetryEntry {
  upTo: number | null; // hasta qué mensaje del cliente se había respondido
  seen: number; // id más alto del hilo que conocía ese pase
  ack?: { msgId: number; at: number };
  unconfirmed?: { key: string; covers: number; id: string; text: string; at: number };
  at: number;
}
export interface RetryStore {
  load(): Record<string, RetryEntry>;
  save(entries: Record<string, RetryEntry>): void;
}

// Activa la fase de respuesta en ESTE proceso para los canales dados.
export function configureReplyEngine(config: EngineConfig): void {
  S.config = config;
  restoreRetries(config);
}

// Lo que el proceso anterior dejó pendiente de reintentar (ver RetryEntry):
// el primer barrido programa un pase para cada una (también las HUMANAS,
// que el barrido no lista: acuse de derivación, palabras clave).
function restoreRetries(config: EngineConfig): void {
  if (!config.retryStore) return;
  let entries: Record<string, RetryEntry>;
  try {
    entries = config.retryStore.load();
  } catch (err) {
    console.error("[bot] ⚠️ No se pudo leer el registro de reintentos pendientes:", err);
    return;
  }
  const now = epochNow();
  for (const [key, e] of Object.entries(entries ?? {})) {
    const id = Number(key);
    if (!Number.isInteger(id) || !e || typeof e.at !== "number" || now - e.at > MAX_AUTOREPLY_AGE_S) continue;
    if (!S.journal.has(id)) S.journal.set(id, e);
    if (e.ack && !S.pendingAcks.has(id)) S.pendingAcks.set(id, e.ack);
    if (e.unconfirmed && !S.unconfirmed.has(id)) S.unconfirmed.set(id, e.unconfirmed);
    S.resume.add(id);
  }
  if (S.resume.size > 0) {
    console.log(`[bot] ${S.resume.size} conversación(es) con una respuesta por reintentar del cierre anterior: se retoman`);
  }
}

export function isReplyEngineConfigured(): boolean {
  return S.config !== null;
}

// Mensajes escritos hace más de este tiempo no se responden solos (llegaron
// tras un día con el bot apagado): quedan guardados y se avisa al operador.
// Antes de eso se responden aunque sea tarde — mejor tarde que nunca.
const MAX_AUTOREPLY_AGE_S = (Number(process.env.AUTO_REPLY_MAX_AGE_HOURS) || 24) * 3600;
const HISTORY_LIMIT = 20;
// Junto con el reintento propio del SDK (llm.ts): el peor caso de un
// proveedor colgado queda acotado (~3 min); más allá, el barrido reintenta
// con backoff y termina pasando la conversación a un humano.
const LLM_ATTEMPTS = 2;
const LLM_BACKOFF_MS = [4_000];
const SEND_ATTEMPTS = 3;
const SEND_BACKOFF_MS = [2_000, 5_000];
// Si el cliente sigue escribiendo mientras la IA redacta, la respuesta se
// rehace con todo el contexto — pero sin postergarla para siempre.
const MAX_STALE_DISCARDS = 2;
const CUSTOMER_KEPT_WRITING = "el cliente siguió escribiendo mientras la IA redactaba";
// Fallos seguidos de una conversación antes de pasarla a un humano.
const MAX_PASS_FAILURES = 4;
const FAILURE_HANDOFF_AFTER_MS = 5 * 60_000;
// Respuestas del bot que esperan entrega en el outbox (canal caído en el
// momento): mientras tanto el bot NO vuelve a responder esa conversación —
// la de la cola sale primero y la siguiente la tiene en contexto (si no, el
// cliente recibía dos respuestas a lo mismo, la vieja al final). La cola las
// entrega al volver el canal o las vence a los 30 min; si en 35 min nadie
// las atendió (p.ej. el proceso del bot apagado), se descartan y el bot
// responde con todo el contexto.
const QUEUED_REPLY_ABANDON_S = 35 * 60;
const QUEUED_RETRY_MS = 3_000;
const QUEUED_PENDING = "hay una respuesta en cola por entregar";
const INBOUND_PENDING = "hay mensajes de este contacto sin guardar todavía";

const routes = S.routes;
const passQueued = S.passQueued;
const passRunning = S.passRunning;
// Último mensaje del cliente ya evaluado (palabras clave / derivación).
const evaluatedUpTo = S.evaluatedUpTo;
// Último mensaje del cliente ya respondido (aunque guardar la respuesta en el
// hilo siga pendiente): el barrido no lo responde dos veces.
const answeredUpTo = S.answeredUpTo;
// Último mensaje que se decidió no responder solo (viejo, canal apagado):
// el barrido no insiste.
const settledUpTo = S.settledUpTo;
const staleDiscards = S.staleDiscards;
const failures = S.failures;
// Respuestas que YA salieron pero no se pudieron guardar en el hilo.
const pendingRecords = S.pendingRecords;

const MAX_TRACKED = 5000;
function prune<K, V>(map: Map<K, V>): void {
  if (map.size <= MAX_TRACKED) return;
  for (const key of [...map.keys()].slice(0, map.size - MAX_TRACKED)) map.delete(key);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const epochNow = () => Math.floor(Date.now() / 1000);

// Programa un pase de respuesta para la conversación. Si ya hay uno en cola
// (sin empezar) no se encola otro: ese pase verá también este mensaje.
export function scheduleReplyPass(conversationId: number, opts: { route?: ReplyRoute } = {}): void {
  if (!S.config || S.draining) return;
  if (opts.route) {
    routes.set(conversationId, opts.route);
    prune(routes);
  }
  if (passQueued.has(conversationId)) return;
  passQueued.add(conversationId);
  void enqueueForContact(`reply:${conversationId}`, async () => {
    passQueued.delete(conversationId);
    passRunning.add(conversationId);
    try {
      const settled = await runReplyPass(conversationId);
      failures.delete(conversationId);
      if (settled) journalDone(conversationId);
    } catch (err) {
      await notePassFailure(conversationId, err);
    } finally {
      passRunning.delete(conversationId);
    }
  });
}

// Filas 'human' que no son una persona contestando: seguimientos
// programados y mensajes automáticos de WhatsApp Business desde el teléfono
// del negocio (ver isAutomatedMessageId). No cubren ni cortan lo que el
// cliente escribió.
const isAutomated = (m: Message): boolean => m.role === "human" && isAutomatedMessageId(m.channel_msg_id);

// Cobertura: hasta qué mensaje del cliente respondió DE VERDAD el bot. En
// memoria se sabe exacto (cada respuesta registra lo que alcanzó a ver: una
// respuesta que se guardó DESPUÉS de un mensaje nuevo del cliente no lo
// cubre). Al ver la conversación por primera vez en este proceso (tras un
// reinicio) se lee de la base: cada respuesta guarda lo que cubrió
// (covers_msg_id); las filas sin ese dato (anteriores a la migración) se
// deducen por posición: lo anterior a ellas se da por respondido.
function initialCoverage(history: Message[]): number {
  let covered = exactCoverage(history);
  let lastUncoveredReply = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user" || isAutomated(m) || m.covers_msg_id != null) continue;
    lastUncoveredReply = i;
    break;
  }
  for (let i = 0; i < lastUncoveredReply; i++) {
    if (history[i].role === "user") covered = Math.max(covered, history[i].id);
  }
  return covered;
}

// Lo que cubren las respuestas del hilo que guardaron qué cubrían (exacto:
// también las que entregó el outbox, que este proceso no registró en vivo).
function exactCoverage(history: Message[]): number {
  let covered = 0;
  for (const m of history) {
    if (m.role !== "user" && m.covers_msg_id != null) covered = Math.max(covered, m.covers_msg_id);
  }
  return covered;
}

// Respuestas de esta conversación en el outbox. "wait": hay que esperar a que
// salgan (o venzan); "clear": quedaron abandonadas y se descartaron (lo que
// cubrían vuelve a estar pendiente); "none": no hay.
async function checkQueuedReplies(
  conversationId: number
): Promise<{ state: "wait" | "clear" | "none"; queue: QueuedBotReply[] }> {
  const queue = await withDbRetry(() => listQueuedBotReplies(conversationId), { label: "leer respuestas en cola" });
  if (queue.length === 0) return { state: "none", queue };
  const now = epochNow();
  if (!queue.every((q) => q.sent === 0 && now - q.created_at > QUEUED_REPLY_ABANDON_S)) return { state: "wait", queue };
  for (const q of queue) {
    // Condicional: si el outbox la tomó justo ahora, se espera a que termine.
    if (!(await withDbRetry(() => discardOutboxItem(q.id)))) return { state: "wait", queue };
  }
  console.warn(
    `[bot] ⚠️ ${queue.length} respuesta(s) en cola de la conversación ${conversationId} sin entregarse en ${QUEUED_REPLY_ABANDON_S / 60} min: se descartan y se responde con todo el contexto`
  );
  addLeadEvent(
    conversationId,
    "delivery_error",
    "Una respuesta automática quedó en cola sin poder entregarse: se descartó y el bot respondió de nuevo con todo el contexto."
  ).catch(() => undefined);
  return { state: "clear", queue };
}

// Hasta qué mensaje del cliente cubren las respuestas en cola: su
// covers_msg_id o, sin la migración, lo que el cliente escribió ANTES de que
// se encolaran (lo posterior esa respuesta no lo vio).
function queuedCoverage(history: Message[], queue: QueuedBotReply[]): number {
  let covered = 0;
  for (const q of queue) {
    if (q.covers_msg_id != null) {
      covered = Math.max(covered, q.covers_msg_id);
      continue;
    }
    for (const m of history) {
      if (m.role === "user" && m.created_at < q.created_at) covered = Math.max(covered, m.id);
    }
  }
  return covered;
}

// Reintento de un pase que tuvo que esperar (respuesta en cola, mensajes sin
// guardar): sin quemar llamadas a la IA mientras tanto.
// Si ya hay una programada, esa basta: su pase verá lo que llegue mientras.
function retryPassLater(conversationId: number, ms = QUEUED_RETRY_MS): void {
  if (S.retryArmed.has(conversationId)) return;
  S.retryArmed.add(conversationId);
  passLater(conversationId, ms, () => S.retryArmed.delete(conversationId));
}

function passLater(conversationId: number, ms: number, before?: () => void): void {
  const timer = setTimeout(() => {
    S.timers.delete(timer);
    before?.();
    scheduleReplyPass(conversationId);
  }, ms);
  timer.unref?.();
  S.timers.add(timer);
}

// Cancela los pases programados para más tarde (apagado; las pruebas lo usan
// para simular un reinicio). Lo pendiente lo retoma el barrido al volver.
export function clearReplyTimers(): void {
  for (const timer of S.timers) clearTimeout(timer);
  S.timers.clear();
  S.retryArmed.clear();
}

// Mensajes del cliente sin respuesta: posteriores al último mensaje de un
// asesor (lo anterior lo atendió una persona) y no cubiertos por el bot.
function pendingUserMessages(history: Message[], covered: number): Message[] {
  let lastHuman = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "human" && !isAutomated(history[i])) {
      lastHuman = i;
      break;
    }
  }
  return history.filter((m, i) => i > lastHuman && m.role === "user" && m.id > covered);
}

// Historial para la IA: los mensajes sin responder van AL FINAL (en la base
// pueden quedar antes de una respuesta que no los vio), y las respuestas
// deterministas de este pase justo después del mensaje que las disparó. Así
// lee "precio → lista de precios → ¿y hacen envíos?" y responde lo último,
// en vez de un diálogo que termina en su propia respuesta.
function historyForLlm(
  history: Message[],
  unansweredIds: Set<number>,
  replies: { afterId: number; content: string }[]
): Message[] {
  const out: Message[] = [];
  for (const m of history) {
    if (unansweredIds.has(m.id)) continue;
    out.push(m);
    for (const r of replies) {
      if (r.afterId === m.id) out.push({ ...m, id: -m.id, role: "assistant", content: r.content });
    }
  }
  for (const m of history) if (unansweredIds.has(m.id)) out.push(m);
  return out;
}

// Por la hora en que el cliente lo ESCRIBIÓ (si se conoce), no la de llegada.
function isTooOld(m: Message, nowS: number): boolean {
  return (m.sent_at ?? S.sentAtById.get(m.id) ?? m.created_at) < nowS - MAX_AUTOREPLY_AGE_S;
}

// true: la conversación quedó resuelta por ahora; false: queda esperando
// otro pase (la cola, mensajes sin guardar, una respuesta que se rehace).
async function runReplyPass(conversationId: number): Promise<boolean> {
  const config = S.config;
  if (!config) return true;
  const conv = await withDbRetry(() => getConversationById(conversationId), { label: "leer conversación" });
  if (!conv || !config.channels.includes(conv.channel)) return true; // borrada / canal de otro proceso
  // Mensajes de este contacto aún sin guardar (respaldo en disco durante un
  // corte): se le responde cuando estén todos (lo programa el respaldo).
  if (config.inboundPending?.(conv)) return false;
  const history = await withDbRetry(() => getRecentHistory(conversationId, HISTORY_LIMIT), {
    label: "leer historial",
  });
  S.seenUpTo.set(conversationId, history.reduce((max, m) => Math.max(max, m.id), 0));
  prune(S.seenUpTo);
  const known = answeredUpTo.get(conversationId) ?? journaledCoverage(conversationId, history);
  let covered = known === undefined ? initialCoverage(history) : Math.max(known, exactCoverage(history));
  let pendingUser = pendingUserMessages(history, covered);
  if (pendingUser.length > 0) {
    // Una respuesta en cola sale primero (y la siguiente la tiene en
    // contexto); mientras tanto no se genera otra.
    const { state, queue } = await checkQueuedReplies(conversationId);
    if (state === "wait") {
      // Primera vez que este proceso ve el hilo (reinicio): se fija ya lo que
      // cubre lo que está en cola. El outbox la guarda en el hilo DESPUÉS de
      // lo que el cliente siga escribiendo y, sin la migración, por posición
      // eso contaría después como respondido.
      if (known === undefined) {
        answeredUpTo.set(conversationId, Math.max(covered, queuedCoverage(history, queue)));
        prune(answeredUpTo);
      }
      retryPassLater(conversationId);
      return false;
    }
    if (state === "clear") {
      covered = initialCoverage(history);
      S.queuedAttempts.delete(conversationId);
    } else {
      // Encolado cuya confirmación se perdió en un corte (la fila pudo
      // quedar y ya haber salido): si salió, cubre lo que cubría. Con la
      // migración lo dice la propia fila (covers_msg_id, ver exactCoverage);
      // sin ella se reconoce por su texto: otra respuesta que se guardó tarde
      // no confirma este encolado.
      const attempt = S.queuedAttempts.get(conversationId);
      if (attempt) {
        S.queuedAttempts.delete(conversationId);
        // Solo una fila guardada DESPUÉS del intento (id mayor que todo lo
        // que ese pase conocía): una respuesta igual anterior — la misma
        // palabra clave a un mensaje previo — no confirma este encolado.
        const delivered = history.some(
          (m) =>
            m.role === "assistant" &&
            m.covers_msg_id == null &&
            m.id > attempt.afterId &&
            m.content === attempt.text
        );
        if (delivered) covered = Math.max(covered, attempt.covers);
      }
    }
    pendingUser = pendingUserMessages(history, covered);
  }
  answeredUpTo.set(conversationId, covered);
  prune(answeredUpTo);
  const route = routes.get(conversationId) ?? null;
  if (pendingUser.length === 0) {
    const last = history[history.length - 1];
    if (last) settledUpTo.set(conversationId, { id: last.id, at: last.created_at });
    return true;
  }
  const latest = pendingUser[pendingUser.length - 1];
  const nowS = epochNow();

  // Primera vez que este proceso ve la conversación (arranque, o se olvidó
  // por el tope de memoria): todo lo pendiente se evalúa, también en modo
  // HUMANO. Lo que el proceso anterior ya respondió está cubierto y no entra
  // en lo pendiente; lo que dejó sin evaluar (esperando la cola, p.ej.) sí.
  if (!evaluatedUpTo.has(conversationId)) {
    evaluatedUpTo.set(conversationId, 0);
    prune(evaluatedUpTo);
  }

  // 1) Palabras clave y derivación, mensaje por mensaje y en orden. Tienen
  //    prioridad sobre la IA (respuesta determinista del operador).
  // Una pausa pendiente de confirmar en la base cuenta como modo HUMANO.
  let mode = S.pendingHandoffs.has(conversationId) ? "HUMAN" : conv.mode;
  // Respuestas deterministas de este pase: para la IA van justo después del
  // mensaje que las disparó (en la base quedan después de lo que llegó en la
  // misma ráfaga), y la re-verificación las reconoce como propias.
  const deterministic: { afterId: number; content: string }[] = [];
  const ownRecordIds = new Set<number>();
  let lastDeterministicId = 0;
  // Verificación final de una respuesta determinista, que el canal hace
  // justo antes de enviarla (tras esperar una reconexión, por ejemplo): no
  // encima de un asesor, ni antes de una respuesta que espera en la cola.
  const deterministicCheck =
    (customerMsgId: number, requireAi: boolean, checkQueue: boolean) => async (): Promise<string | null> => {
      if (requireAi) {
        const now = await withDbRetry(() => getConversationById(conversationId), { label: "re-verificar conversación" });
        if (!now || now.mode !== "AI" || S.pendingHandoffs.has(conversationId)) return "un asesor tomó la conversación";
      }
      if (config.inboundPending?.(conv)) return INBOUND_PENDING;
      if (await withDbRetry(() => hasHumanReplyAfter(conversationId, customerMsgId), { label: "re-verificar asesor" })) {
        return "un asesor respondió antes de que saliera";
      }
      if (checkQueue && (await withDbRetry(() => listQueuedBotReplies(conversationId))).length > 0) {
        return QUEUED_PENDING;
      }
      return null;
    };
  // Una respuesta determinista que no salió en vivo y quedó en la cola cierra
  // el pase: lo siguiente espera a que ella salga (checkQueuedReplies) en vez
  // de apilar otra detrás — sin la migración, al salir la primera la segunda
  // parecía cubrir lo que no vio.
  let queuedNow = false;
  const waitForQueue = (evaluated: number): false => {
    evaluatedUpTo.set(conversationId, evaluated);
    retryPassLater(conversationId);
    return false;
  };
  const pending = pendingUser.filter((m) => m.id > (evaluatedUpTo.get(conversationId) ?? 0));
  if (pending.length > 0) {
    const triggers = await getKeywordTriggersCached(conv.org_id);
    for (const m of pending) {
      if (!isTooOld(m, nowS)) {
        const trigger = findMatchingTrigger(triggers, m.content);
        // Acuse de derivación de este mensaje que no alcanzó a salir.
        const ackPending = ackPendingFor(conversationId, m.id);
        if (trigger && (mode === "AI" || trigger.also_human)) {
          let recordId: number | null;
          try {
            recordId = await deliver(conv, route, trigger.content, {
              reason: `palabra clave "${trigger.keyword}"`,
              covers: m.id,
              // Sin also_human es una respuesta del bot como cualquier otra:
              // si un asesor toma el chat mientras espera, no sale.
              kind: trigger.also_human ? "bot_fixed" : "bot",
              beforeSend: deterministicCheck(m.id, !trigger.also_human, true),
              onQueued: () => (queuedNow = true),
              retryKey: `kw:${trigger.keyword}`,
            });
          } catch (err) {
            if (!isReplySupersededError(err)) throw err;
            // Por esperar (cola, mensajes sin guardar): se vuelve a evaluar
            // después. Porque un asesor tomó el chat: se da por evaluado.
            if (err.message === QUEUED_PENDING || err.message === INBOUND_PENDING) {
              retryPassLater(conversationId);
              return false;
            }
            console.log(
              `[bot] Respuesta por palabra clave "${trigger.keyword}" no enviada (conversación ${conversationId}): ${err.message}`
            );
            evaluatedUpTo.set(conversationId, m.id);
            scheduleReplyPass(conversationId);
            return false;
          }
          if (recordId !== null) ownRecordIds.add(recordId);
          deterministic.push({ afterId: m.id, content: trigger.content });
          lastDeterministicId = m.id;
          addLeadEvent(
            conversationId,
            "keyword",
            `Respuesta automática por palabra clave "${trigger.keyword}"`
          ).catch(() => undefined);
          if (queuedNow) return waitForQueue(m.id);
        } else if (ackPending ? mode !== "AI" : mode === "AI" && clientRequestsHuman(m.content)) {
          // El cambio a HUMANO va PRIMERO: si el acuse no sale, lo
          // importante (que el bot se calle y el operador se entere) ya
          // pasó. Si no sale (canal caído, sin cola), el pase falla y los
          // siguientes lo reintentan — ya en HUMANO — hasta que salga, un
          // asesor escriba o venza (ackPendingFor).
          if (!ackPending) {
            await handOffToHuman(conversationId, "El cliente pidió hablar con un humano");
            S.pendingAcks.set(conversationId, { msgId: m.id, at: epochNow() });
            prune(S.pendingAcks);
          }
          mode = "HUMAN";
          try {
            await deliver(conv, route, HANDOFF_ACK, {
              reason: "confirmación de derivación",
              covers: m.id,
              kind: "bot_fixed",
              // Ya es HUMANO a propósito: solo se verifica que un asesor no
              // haya escrito antes de que el acuse saliera.
              beforeSend: deterministicCheck(m.id, false, false),
              onQueued: () => (queuedNow = true),
              retryKey: "ack",
            });
          } catch (err) {
            if (!isReplySupersededError(err)) throw err;
            // Mensajes del contacto sin guardar: se espera (puede estar la
            // respuesta de un asesor) y el acuse sigue pendiente.
            if (err.message === INBOUND_PENDING) {
              retryPassLater(conversationId);
              return false;
            }
            S.pendingAcks.delete(conversationId);
            console.log(`[bot] Acuse de derivación no enviado (conversación ${conversationId}): ${err.message}`);
            evaluatedUpTo.set(conversationId, m.id);
            scheduleReplyPass(conversationId);
            return false;
          }
          S.pendingAcks.delete(conversationId);
          if (queuedNow) return waitForQueue(m.id);
          lastDeterministicId = m.id;
        } else if (ackPending) {
          // Un operador volvió a poner la IA antes de que el acuse saliera:
          // manda su decisión (la IA responde con todo el contexto).
          S.pendingAcks.delete(conversationId);
        }
      }
      evaluatedUpTo.set(conversationId, m.id);
    }
  }

  // 2) Respuesta de la IA a lo pendiente DESPUÉS de la última respuesta
  //    determinista (si el cliente escribió "precio" y luego otra pregunta,
  //    la palabra clave responde lo primero y la IA lo segundo), con el
  //    contexto completo.
  if (mode !== "AI") return true;
  if (latest.id <= lastDeterministicId) return true; // la palabra clave respondió lo último
  const unanswered = pendingUser.filter((m) => m.id > lastDeterministicId);
  if (isTooOld(latest, nowS)) {
    settledUpTo.set(conversationId, { id: latest.id, at: latest.created_at });
    addLeadEvent(
      conversationId,
      "auto_reply_skipped",
      `Mensajes de hace más de ${Math.round(MAX_AUTOREPLY_AGE_S / 3600)} h (el bot estaba desconectado): no se respondieron automáticamente.`
    ).catch(() => undefined);
    return true;
  }
  const blocked = config.cannotReply ? await config.cannotReply(conv) : null;
  if (blocked) {
    settledUpTo.set(conversationId, { id: latest.id, at: latest.created_at });
    console.log(`[bot] No se responde la conversación ${conversationId}: ${blocked}`);
    return true;
  }

  const selection = await selectAgentForInbound({
    orgId: conv.org_id,
    conversationId,
    text: unanswered.map((m) => m.content).join("\n"),
    stage: conv.stage ?? null,
    channel: conv.channel ?? null,
  });
  if (selection) {
    console.log(
      `[bot] 🤖 Agente "${selection.agent.name}" atiende la conversación ${conversationId} (${selection.reason}${selection.topic ? `: "${selection.topic}"` : ""})`
    );
  }
  // Una respuesta a esto mismo pudo haber salido sin confirmación: se
  // reintenta ESA (mismo texto y mismo id), no una nueva.
  const prior = unconfirmedFor(conversationId, latest.id, "ai");
  let reply: string;
  if (prior) {
    console.log(`[bot] Se reintenta la respuesta de la conversación ${conversationId} que pudo haber salido sin confirmación (mismo id)`);
    reply = prior.text;
  } else {
    const llmHistory = historyForLlm(history, new Set(unanswered.map((m) => m.id)), deterministic);
    console.log(
      `[bot] Llamando al LLM (conversación ${conversationId}, ${llmHistory.length} mensajes de contexto, ${unanswered.length} pendiente(s))...`
    );
    const t0 = Date.now();
    reply = await generateWithRetry(conv.org_id, llmHistory, selection?.agent ?? null);
    console.log(`[bot] LLM respondió en ${Date.now() - t0}ms (conversación ${conversationId})`);
  }

  // 3) Re-verificación: la IA tarda segundos (y el canal puede esperar una
  //    reconexión antes de enviar) y en ese tiempo un asesor pudo tomar la
  //    conversación o el cliente seguir escribiendo. Se verifica ahora y,
  //    otra vez, JUSTO antes de que el mensaje salga (beforeSend).
  // Si el cliente sigue escribiendo, la respuesta se rehace con todo el
  // contexto — hasta MAX_STALE_DISCARDS veces, para no postergarla siempre.
  const allowNewerCustomer = (staleDiscards.get(conversationId) ?? 0) >= MAX_STALE_DISCARDS;
  // Solo cuenta lo que llegó DESPUÉS de leer el historial (y que no sea una
  // respuesta de este mismo pase): lo anterior ya está contemplado.
  const snapshotMaxId = history.reduce((max, m) => Math.max(max, m.id), 0);
  const stillValid = async (): Promise<string | null> => {
    const now = await withDbRetry(() => getConversationById(conversationId), { label: "re-verificar conversación" });
    if (!now || now.mode !== "AI" || S.pendingHandoffs.has(conversationId)) {
      return "un asesor tomó la conversación";
    }
    if (config.inboundPending?.(now)) return INBOUND_PENDING;
    if ((await withDbRetry(() => listQueuedBotReplies(conversationId), { label: "re-verificar cola" })).length > 0) {
      return QUEUED_PENDING;
    }
    const tail = await withDbRetry(() => getRecentHistory(conversationId, HISTORY_LIMIT), {
      label: "re-verificar historial",
    });
    const arrived = tail.filter((m) => m.id > snapshotMaxId && !ownRecordIds.has(m.id));
    if (arrived.length === 0) return null;
    if (arrived.some((m) => m.role === "human" && !isAutomated(m))) return "un asesor respondió mientras la IA escribía";
    if (arrived.some((m) => m.role !== "user")) return "salió otra respuesta automática mientras la IA escribía";
    return allowNewerCustomer ? null : CUSTOMER_KEPT_WRITING;
  };
  // Siempre se programa un pase nuevo: recalcula qué quedó pendiente con el
  // hilo actualizado (si un asesor respondió o tomó el chat, no hará nada;
  // si llegó otra respuesta automática — p.ej. una palabra clave que salió
  // por la cola —, responderá lo que esa no cubría). Sin esto, lo pendiente
  // quedaba sin responder: en la base el hilo parecía respondido.
  const supersede = (reason: string): false => {
    if (reason === CUSTOMER_KEPT_WRITING) {
      staleDiscards.set(conversationId, (staleDiscards.get(conversationId) ?? 0) + 1);
      prune(staleDiscards);
      console.log(`[bot] ${reason}: se rehace la respuesta con todo el contexto (conversación ${conversationId})`);
    } else {
      console.log(`[bot] Respuesta IA descartada (conversación ${conversationId}): ${reason}`);
    }
    // Esperando a la cola o a mensajes sin guardar: el próximo pase espera
    // sin llamar a la IA; en los demás casos se recalcula ya.
    if (reason === QUEUED_PENDING || reason === INBOUND_PENDING) retryPassLater(conversationId);
    else scheduleReplyPass(conversationId);
    return false;
  };
  const verdict = await stillValid();
  if (verdict) return supersede(verdict);
  const fresh = (await withDbRetry(() => getConversationById(conversationId))) ?? conv;

  // El propio LLM decidió derivar (respondió la frase del system prompt). Si
  // la respuesta queda en cola, la derivación que sigue no debe descartarla:
  // vale igual en HUMANO, como el acuse (un asesor que escriba sí la frena).
  const handsOff = botOfferedHandoff(reply);
  try {
    await deliver(fresh, route, reply, {
      reason: selection ? `IA · agente ${selection.agent.name}` : "IA",
      covers: latest.id,
      beforeSend: stillValid,
      kind: handsOff ? "bot_fixed" : "bot",
      retryKey: "ai",
    });
  } catch (err) {
    if (isReplySupersededError(err)) return supersede(err.message);
    throw err;
  }
  staleDiscards.delete(conversationId);

  if (handsOff) {
    await handOffToHuman(conversationId, "El bot derivó la conversación (no pudo resolverla)").catch((err) =>
      console.error(`[bot] No se pudo derivar la conversación ${conversationId}:`, err)
    );
  }
  return true;
}

// IA con reintentos (límites de tasa, cortes, timeouts) y con un tope de
// llamadas simultáneas: con muchos clientes escribiendo a la vez, todos
// esperan su turno en vez de chocar contra el límite del proveedor.
async function generateWithRetry(
  orgId: number,
  history: Message[],
  agent: { name: string; instructions: string } | null
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withLlmSlot(() => generateReply(orgId, history, agent));
    } catch (err) {
      const retryable = isRetryableLlmError(err) || isTransientDbError(err);
      if (!retryable || attempt >= LLM_ATTEMPTS) throw err;
      console.warn(
        `[bot] La IA falló (intento ${attempt}/${LLM_ATTEMPTS}), reintento en ${LLM_BACKOFF_MS[attempt - 1]}ms:`,
        err instanceof Error ? err.message : err
      );
      await sleep(LLM_BACKOFF_MS[attempt - 1]);
    }
  }
}

// Envía por el canal (con reintentos sobre la conexión VIVA) y registra en
// el hilo. Si no se puede entregar ahora, la respuesta queda en el outbox y
// se entrega cuando el canal vuelva: nunca se pierde en silencio.
interface DeliverOptions {
  reason: string;
  // Último mensaje del cliente que esta respuesta cubre.
  covers?: number;
  // Verificación final que el canal hace justo antes de enviar.
  beforeSend?: () => Promise<string | null>;
  // Si queda en cola: 'bot' (IA, se descarta si un asesor toma el chat) o
  // 'bot_fixed' (palabra clave, acuse de derivación o la derivación de la
  // propia IA: vale igual en HUMANO).
  kind: "bot" | "bot_fixed";
  // Se llama si no salió en vivo y quedó en el outbox.
  onQueued?: () => void;
  // Clase de respuesta ('ai', 'kw:<palabra>', 'ack'): un reintento de la
  // misma clase para el mismo mensaje reusa id y texto (unconfirmedFor).
  retryKey: string;
}

async function deliver(
  conv: Conversation,
  route: ReplyRoute | null,
  text: string,
  opts: DeliverOptions
): Promise<number | null> {
  const { reason, covers: answeredUserMsgId, beforeSend } = opts;
  const config = S.config;
  if (!config) throw new Error("Motor de respuestas sin canal de envío configurado");
  const prior = unconfirmedFor(conv.id, answeredUserMsgId, opts.retryKey);
  const target: ReplyTarget = { conversation: conv, route, messageId: prior?.id ?? config.newMessageId(), beforeSend };
  const rememberUnconfirmed = (): void => {
    if (answeredUserMsgId === undefined) return;
    S.unconfirmed.set(conv.id, { key: opts.retryKey, covers: answeredUserMsgId, id: target.messageId, text, at: epochNow() });
    prune(S.unconfirmed);
  };
  // ¿Algún intento (de este pase o de uno anterior) pudo haber salido?
  let mayHaveGone = !!prior;
  let channelMsgId: string | null = null;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    try {
      channelMsgId = (await config.send(target, text)).channelMsgId;
      lastErr = null;
      break;
    } catch (err) {
      // Ya no corresponde enviarla (un asesor tomó el chat...): ni
      // reintento ni cola — lo decide quien llamó.
      if (isReplySupersededError(err)) {
        if (mayHaveGone) rememberUnconfirmed();
        throw err;
      }
      lastErr = err;
      mayHaveGone = true;
      if (isPermanentSendError(err) || isUncertainSendError(err)) break;
      if (attempt < SEND_ATTEMPTS) await sleep(SEND_BACKOFF_MS[attempt - 1]);
    }
  }
  // Salió, o no se puede enviar por este canal: no hay nada que reintentar
  // con este id (en los demás casos lo deciden la cola o el reintento).
  if (!lastErr || isPermanentSendError(lastErr)) S.unconfirmed.delete(conv.id);

  if (lastErr && isUncertainSendError(lastErr)) {
    // Lo más probable es que haya salido: se registra como enviada (la IA la
    // tiene en cuenta) y el operador ve el aviso por si hay que reenviarla.
    console.warn(`[bot] ⚠️ Respuesta (${reason}) de la conversación ${conv.id} sin confirmación del canal: ${lastErr.message}`);
    addLeadEvent(
      conv.id,
      "delivery_uncertain",
      "El canal no confirmó si la respuesta automática llegó (no se reenvía para no duplicarla): revisa el chat."
    ).catch(() => undefined);
    lastErr = null;
    S.unconfirmed.delete(conv.id);
  }

  if (lastErr) {
    if (isPermanentSendError(lastErr)) {
      console.error(`[bot] ⚠️ No se envía la respuesta (${reason}) de la conversación ${conv.id}: ${lastErr.message}`);
      if (answeredUserMsgId !== undefined) {
        settledUpTo.set(conv.id, { id: answeredUserMsgId, at: epochNow() });
      }
      addLeadEvent(conv.id, "delivery_error", `No se envió la respuesta automática: ${lastErr.message}`).catch(
        () => undefined
      );
      return null;
    }
    const sendError = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    console.error(
      `[bot] ⚠️ No se pudo entregar la respuesta (${reason}) de la conversación ${conv.id}; se deja en cola:`,
      sendError.message
    );
    // Si la confirmación del encolado se pierde (la fila pudo quedar), el
    // próximo pase lo sabe y no responde dos veces lo mismo.
    if (answeredUserMsgId !== undefined) {
      S.queuedAttempts.set(conv.id, { covers: answeredUserMsgId, afterId: S.seenUpTo.get(conv.id) ?? 0, text });
      prune(S.queuedAttempts);
    }
    // Con el MISMO id del intento en vivo: si ese intento sí había salido
    // (falló solo la confirmación), WhatsApp descarta el duplicado; y un
    // reintento del encolado no crea una segunda fila.
    try {
      await withDbRetry(
        () =>
          enqueueBotReply(conv.id, text, route?.waAccountId ?? conv.wa_account_id, {
            kind: opts.kind,
            coversMsgId: answeredUserMsgId ?? null,
            channelMsgId: target.messageId,
            accountPhone: route?.accountPhone ?? null,
          }),
        { attempts: 5, label: "encolar respuesta" }
      );
    } catch (err) {
      // No quedó en cola: el pase falla y se reintenta. Si algún intento sí
      // había salido, el reintento sale con el mismo id (no duplica).
      rememberUnconfirmed();
      if (!isQueueUnsupportedError(err)) throw err;
      // Sin la migración no hay cola: nada quedó en el hilo ni en el
      // outbox, así que el pase falla y se reintenta en vivo con todo lo
      // pendiente (y, si el canal sigue caído, pasa a un asesor).
      S.queuedAttempts.delete(conv.id);
      throw new Error(`${sendError.message} — ${(err as Error).message}`);
    }
    S.queuedAttempts.delete(conv.id);
    S.unconfirmed.delete(conv.id);
    opts.onQueued?.();
    if (answeredUserMsgId !== undefined) markAnswered(conv.id, answeredUserMsgId);
    addLeadEvent(
      conv.id,
      "delivery_retry",
      "La respuesta automática no se pudo entregar en el momento: quedó en cola y saldrá cuando el canal vuelva."
    ).catch(() => undefined);
    return null;
  }

  if (answeredUserMsgId !== undefined) markAnswered(conv.id, answeredUserMsgId);
  console.log(`[bot] → [${conv.channel}] conversación ${conv.id} (${reason})`);
  try {
    const { message } = await withDbRetry(
      () =>
        insertMessageIdempotent(conv.id, "assistant", text, {
          channelMsgId: channelMsgId ?? target.messageId,
          coversMsgId: answeredUserMsgId ?? null,
        }),
      { attempts: 5, label: "guardar respuesta" }
    );
    S.seenUpTo.set(conv.id, Math.max(S.seenUpTo.get(conv.id) ?? 0, message.id));
    return message.id;
  } catch (err) {
    // La respuesta YA salió: se reintenta guardarla en el próximo tick (y
    // el barrido no la repite gracias a answeredUpTo).
    console.error(`[bot] ⚠️ La respuesta se envió pero no se pudo guardar en el hilo (se reintenta):`, err);
    pendingRecords.push({
      conversationId: conv.id,
      content: text,
      channelMsgId: channelMsgId ?? target.messageId,
      coversMsgId: answeredUserMsgId ?? null,
      attempts: 0,
    });
    return null;
  }
}

// Respuestas que pudieron haber salido sin confirmación (un intento falló
// después de escribirse, o la conexión cayó a mitad) y no quedaron ni en el
// hilo ni en la cola. Si se vuelve a responder LO MISMO (el mismo mensaje del
// cliente, la misma clase de respuesta), sale con el mismo id y el mismo
// texto: WhatsApp descarta la segunda copia, en vez de que el cliente reciba
// dos respuestas distintas a lo mismo.
const UNCONFIRMED_TTL_S = 10 * 60;
// El acuse de derivación se reintenta hasta 30 min (con el mismo id).
const ACK_RETRY_TTL_S = 30 * 60;
function unconfirmedFor(conversationId: number, covers: number | undefined, key: string) {
  if (covers === undefined) return undefined;
  const u = S.unconfirmed.get(conversationId);
  const ttl = key === "ack" ? ACK_RETRY_TTL_S : UNCONFIRMED_TTL_S;
  if (!u || u.key !== key || u.covers !== covers || epochNow() - u.at > ttl) return undefined;
  return u;
}

// ¿Quedó sin salir el acuse de derivación de este mensaje? (el cliente pidió
// un asesor con el canal caído; la conversación ya es HUMANA). Pasado el
// plazo se abandona y el operador lo ve en la actividad del lead.
function ackPendingFor(conversationId: number, msgId: number): boolean {
  const p = S.pendingAcks.get(conversationId);
  if (!p || p.msgId !== msgId) return false;
  if (epochNow() - p.at <= ACK_RETRY_TTL_S) return true;
  S.pendingAcks.delete(conversationId);
  console.warn(`[bot] ⚠️ Se abandona el acuse de derivación de la conversación ${conversationId} (el canal no estuvo disponible)`);
  addLeadEvent(
    conversationId,
    "delivery_error",
    "No se pudo avisar al cliente que lo atenderá un asesor (WhatsApp no estuvo disponible): escríbele."
  ).catch(() => undefined);
  return false;
}

// ── Reintentos anotados en disco (ver RetryEntry) ───────────
// Primera vez que este proceso ve la conversación y el anterior la dejó con
// un reintento pendiente: se sigue desde donde ese se quedó, aunque en el
// hilo haya una respuesta guardada después (por posición parecería
// respondido). Si después se guardó una respuesta del bot que ese pase no
// conocía, otro pase sí terminó: manda el hilo.
function journaledCoverage(conversationId: number, history: Message[]): number | undefined {
  const e = S.journal.get(conversationId);
  if (!e || e.upTo === null) return undefined;
  if (history.some((m) => m.role === "assistant" && m.id > e.seen)) return undefined;
  return e.upTo;
}

function journalNote(ids: Iterable<number>): void {
  if (!S.config?.retryStore) return;
  const at = epochNow();
  for (const id of new Set(ids)) {
    const prev = S.journal.get(id);
    S.journal.set(id, {
      upTo: answeredUpTo.get(id) ?? prev?.upTo ?? null,
      seen: Math.max(S.seenUpTo.get(id) ?? 0, prev?.seen ?? 0),
      ack: S.pendingAcks.get(id),
      unconfirmed: S.unconfirmed.get(id),
      at,
    });
  }
  prune(S.journal);
  saveJournal();
}

function journalDone(conversationId: number): void {
  if (S.journal.delete(conversationId)) saveJournal();
}

function saveJournal(): void {
  const store = S.config?.retryStore;
  if (!store) return;
  try {
    store.save(Object.fromEntries([...S.journal].map(([id, e]) => [String(id), e])));
    S.journalDirty = false;
  } catch (err) {
    // Se reintenta en el próximo barrido.
    if (!S.journalDirty) console.error("[bot] ⚠️ No se pudo guardar el registro de reintentos pendientes:", err);
    S.journalDirty = true;
  }
}

function markAnswered(conversationId: number, messageId: number): void {
  answeredUpTo.set(conversationId, Math.max(answeredUpTo.get(conversationId) ?? 0, messageId));
  prune(answeredUpTo);
}

async function notePassFailure(conversationId: number, err: unknown): Promise<void> {
  const now = Date.now();
  const f = failures.get(conversationId) ?? { count: 0, firstAt: now, nextAt: now };
  f.count += 1;
  // Backoff: 15 s, 30 s, 60 s, 120 s... El reintento lo programa el propio
  // motor (no solo el barrido): si una respuesta anterior quedó guardada
  // DESPUÉS de mensajes nuevos del cliente, en la base la conversación
  // parece respondida y el barrido no la vería.
  const delay = Math.min(120_000, 15_000 * 2 ** (f.count - 1));
  f.nextAt = now + delay;
  failures.set(conversationId, f);
  prune(failures);
  passLater(conversationId, delay);
  journalNote([conversationId]);
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[bot] ⚠️ Falló la respuesta de la conversación ${conversationId} (intento ${f.count}):`, detail);
  // Nunca dejar a un cliente ignorado en silencio: tras varios fallos
  // seguidos (p.ej. proveedor de IA caído o clave inválida) la conversación
  // pasa a un humano, con el motivo visible en la actividad del lead.
  if (f.count >= MAX_PASS_FAILURES && now - f.firstAt >= FAILURE_HANDOFF_AFTER_MS) {
    try {
      await handOffToHuman(conversationId, `La IA no pudo responder tras varios intentos: ${detail.slice(0, 200)}`);
      failures.delete(conversationId);
    } catch {
      /* el próximo barrido lo intenta de nuevo */
    }
  }
}

// ── Barrido de recuperación ────────────────────────────────
// Conversaciones en modo IA cuyo último mensaje es del cliente: las que un
// reinicio, un corte o un fallo dejaron sin respuesta. Lo llama el tick del
// proceso cada pocos segundos.
export async function runRecoverySweep(): Promise<number> {
  const config = S.config;
  if (!config || S.draining) return 0;
  if (S.journalDirty) saveJournal();
  // Lo que el proceso anterior dejó por reintentar (ver restoreRetries).
  for (const id of [...S.resume]) {
    S.resume.delete(id);
    scheduleReplyPass(id);
  }
  prune(settledUpTo);
  const rows = await listPendingAiReplies(
    epochNow() - MAX_AUTOREPLY_AGE_S,
    100,
    config.channels.length === 1 ? config.channels[0] : null
  );
  let scheduled = 0;
  for (const r of rows) {
    const id = r.conversation_id;
    if (!config.channels.includes(r.channel)) continue;
    if (passQueued.has(id) || passRunning.has(id)) continue;
    const answered = answeredUpTo.get(id);
    if (r.last_message_id !== null && answered !== undefined && r.last_message_id <= answered) continue;
    const settled = settledUpTo.get(id);
    if (
      settled &&
      (r.last_message_id !== null ? r.last_message_id <= settled.id : (r.last_message_at ?? 0) <= settled.at)
    ) {
      continue;
    }
    const f = failures.get(id);
    if (f && Date.now() < f.nextAt) continue;
    scheduleReplyPass(id);
    scheduled++;
  }
  return scheduled;
}

// Pausas de la IA sin confirmar más viejas que esto se abandonan (si para
// entonces un operador volvió a poner la IA, no se pisa su decisión).
const PENDING_HANDOFF_TTL_MS = 10 * 60_000;

// Lo que quedó a medias por un blip de Supabase: respuestas que ya salieron
// pero no se guardaron en el hilo, y pausas de la IA sin confirmar.
export async function flushPendingRecords(): Promise<void> {
  for (const rec of pendingRecords.splice(0)) {
    try {
      await insertMessageIdempotent(rec.conversationId, "assistant", rec.content, {
        channelMsgId: rec.channelMsgId,
        coversMsgId: rec.coversMsgId,
      });
    } catch (err) {
      rec.attempts += 1;
      if (rec.attempts < 30) pendingRecords.push(rec);
      else console.error(`[bot] ⚠️ Se abandona guardar una respuesta en la conversación ${rec.conversationId}:`, err);
    }
  }
  for (const [conversationId, h] of [...S.pendingHandoffs]) {
    if (Date.now() - h.at > PENDING_HANDOFF_TTL_MS) {
      S.pendingHandoffs.delete(conversationId);
      console.error(`[bot] ⚠️ Se abandona pausar la IA de la conversación ${conversationId} (la base no respondió)`);
      continue;
    }
    try {
      await setMode(conversationId, "HUMAN");
      S.pendingHandoffs.delete(conversationId);
      addLeadEvent(conversationId, "handoff", h.reason).catch(() => undefined);
    } catch {
      /* siguiente tick */
    }
  }
}

// Apagado ordenado: no se aceptan pases nuevos y se espera a que terminen
// los que están en curso (lo que no alcance lo retoma el barrido al volver).
// `until` da la hora límite (ms) y se vuelve a leer en cada vuelta: quien
// apaga puede acortarla mientras tanto (se cierra la ventana en medio de un
// Ctrl+C). Lo pendiente en memoria lo guarda quien apaga, con su propio
// tope (flushPendingRecords).
export async function drainReplies(until: () => number): Promise<void> {
  S.draining = true;
  // Lo que esperaba un pase posterior (cola, mensajes sin guardar) o no
  // alcanzó a terminar queda anotado: el proceso nuevo lo retoma.
  const waiting = [...S.retryArmed];
  clearReplyTimers();
  while ((passQueued.size > 0 || passRunning.size > 0) && Date.now() < until()) {
    await sleep(200);
  }
  journalNote([...waiting, ...passQueued, ...passRunning]);
}
