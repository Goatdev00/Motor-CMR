// Outbox del proceso bot: entrega lo que espera en la tabla outbox (mensajes
// del dashboard, avisos internos, seguimientos programados y respuestas
// automáticas que quedaron en cola) y envía por WhatsApp (Baileys) las
// respuestas del motor. Lo usa scripts/start-bot.ts; las pruebas de
// concurrencia lo ejecutan tal cual contra una base en memoria.
import crypto from "node:crypto";
import {
  addLeadEvent,
  claimOutboxItem,
  deferLaterOutboxForRecipient,
  deferOutboxItem,
  deferOutboxUntil,
  discardOutboxItem,
  getConversationById,
  getOutboxSentState,
  getPendingOutbox,
  getRecentHistory,
  hasBotReplyCovering,
  hasHumanReplyAfter,
  hasHumanReplySince,
  findMessageSince,
  insertMessageIdempotent,
  isDataError,
  listStaleBotReplies,
  listTeamMembers,
  markFollowUpFailed,
  markFollowUpSent,
  markOutboxSent,
  olderPendingOutboxTime,
  releaseOutboxFailure,
  resetInFlightOutbox,
  unclaimOutboxItem,
  type ChannelSettingsRow,
  type OutboxItem,
  type TeamMember,
  type WaAccount,
} from "./db";
import { anySessionOpen, getAllSessions, getOpenSession, getSession, type BaileysSession } from "./baileys/client";
import { hasUnsavedInbound } from "./baileys/handler";
import {
  PermanentSendError,
  assertStillValid,
  contactKey,
  enqueueForContact,
  hasPendingHandoff,
  pauseAiForHuman,
  scheduleReplyPass,
  type ReplyTarget,
} from "./reply-engine";
import { isUncertainDelivery, sendChannelText } from "./meta";

// Tiempos del outbox (las pruebas los acortan).
export const OUTBOX_TIMING = {
  // Respuesta automática que no salió en este tiempo: ya no se envía (el
  // cliente esperó demasiado) y la conversación pasa a un asesor.
  botReplyTtlS: 30 * 60,
  // Tope de una entrega en curso (después puede salir igual).
  deliveryTimeoutMs: 30_000,
  // Procesar lo ya recibido de un contacto antes de responderle: en vivo y,
  // más corto, en el outbox (el tick no debe quedar frenado).
  inboundDrainMs: 10_000,
  outboxDrainMs: 3_000,
  // Espera de una reconexión breve antes de responder en vivo.
  replyWaitOpenMs: 30_000,
  // Esperas de una fila que no puede salir ahora (sin quemar intentos).
  warmingDeferS: 5,
  downDeferS: 30,
  unsavedDeferS: 5,
  orderDeferS: 2,
  channelOffDeferS: 30,
  followupDeferS: 15,
  // Cada cuánto se buscan respuestas en cola vencidas fuera del lote.
  staleSweepEveryS: 30,
};

// Cinturón anti-duplicados: ids que YA salieron pero cuyo UPDATE sent=1
// falló (blip de Supabase). No se reenvían; solo se reintenta el marcado en
// ticks siguientes.
const sentUnrecorded = new Set<number>();

// Liberaciones de reclamos que fallaron (blip): se reintentan cada tick en
// vez de dejar la fila 'enviando' sin dueño hasta el próximo reinicio.
interface ReleaseRequest {
  item: OutboxItem;
  countAttempt: boolean;
  maxAttempts: number;
  deferSeconds: number;
  reason: string;
}
const pendingRelease = new Map<number, ReleaseRequest>();
// Reclamos cuya respuesta se perdió (no se sabe si se aplicaron): se revisa
// la fila y, si quedó 'enviando' sin dueño, vuelve a pendiente.
const claimUncertain = new Map<number, OutboxItem>();

// Pasos post-entrega que registran el envío en el hilo: seguimientos (rol
// 'human') y respuestas automáticas que salieron por la cola (rol
// 'assistant'). Si Supabase falla justo ahí, se reintenta en ticks
// siguientes (hasta 30 min) en vez de perderse: una respuesta que salió y no
// quedó en el hilo se respondería de nuevo tras un reinicio.
interface DeliveryFinalize {
  conversationId: number;
  content: string;
  role: "human" | "assistant";
  channelMsgId: string;
  coversMsgId: number | null;
  // Solo seguimientos: se limpia el recordatorio del lead.
  followup: boolean;
  scheduledAt: number | null;
  messageInserted: boolean;
  sentMarked?: boolean;
  failingSince: number | null;
}
const pendingFinalize = new Map<number, DeliveryFinalize>();
// Filas de WhatsApp que un cierre dejó 'enviando' y volvieron a pendiente:
// pudieron haber quedado ya en el hilo (ver alreadyInThread).
const resetAtBoot = new Set<number>();
const FINALIZE_GIVE_UP_MS = 30 * 60_000;

// Destinatarios con un envío atrasado (reintento con espera): sus envíos
// siguientes esperan lo mismo, para que el cliente los lea en orden. En
// memoria además de en la base: si diferir en la base falla, el orden se
// conserva igual.
const heldRecipients = new Map<string, number>();

const recipientKeyOf = (item: OutboxItem) => `${item.org_id}:${item.channel}:${item.phone}`;
const isBotKind = (item: OutboxItem) => item.kind === "bot" || item.kind === "bot_fixed";
// Mensajes del operador y respuestas en cola: salen en el orden en que se
// crearon, por destinatario (los seguimientos conservan su hora y los avisos
// internos no son del cliente).
const keepsOrder = (item: OutboxItem) => item.kind === "manual" || isBotKind(item);
const nowEpoch = () => Math.floor(Date.now() / 1000);

// El lote viene ordenado por hora programada (lo nunca diferido primero): una
// fila nueva de un destinatario puede venir antes que una suya más vieja que
// se difirió. Dentro del lote, cada destinatario se reordena por id (orden de
// creación, el mismo que usan las verificaciones contra la base),
// conservando los turnos que ocupaban sus filas.
function oldestFirstPerRecipient(items: OutboxItem[]): OutboxItem[] {
  const byKey = new Map<string, OutboxItem[]>();
  for (const it of items) {
    if (!keepsOrder(it)) continue;
    const key = recipientKeyOf(it);
    const list = byKey.get(key);
    if (list) list.push(it);
    else byKey.set(key, [it]);
  }
  for (const list of byKey.values()) list.sort((a, b) => a.id - b.id);
  const next = new Map<string, number>();
  return items.map((it) => {
    if (!keepsOrder(it)) return it;
    const key = recipientKeyOf(it);
    const i = next.get(key) ?? 0;
    next.set(key, i + 1);
    return byKey.get(key)?.[i] ?? it;
  });
}

function holdRecipient(item: OutboxItem, until: number): void {
  const key = recipientKeyOf(item);
  heldRecipients.set(key, Math.max(until, heldRecipients.get(key) ?? 0));
}

function isHeld(item: OutboxItem): boolean {
  const key = recipientKeyOf(item);
  const until = heldRecipients.get(key);
  if (until === undefined) return false;
  if (until > nowEpoch()) return true;
  heldRecipients.delete(key);
  return false;
}

async function finalizeDelivery(outboxId: number, f: DeliveryFinalize): Promise<void> {
  if (!f.messageInserted) {
    await insertMessageIdempotent(f.conversationId, f.role, f.content, {
      channelMsgId: f.channelMsgId,
      coversMsgId: f.coversMsgId,
    });
    f.messageInserted = true; // no duplicar el mensaje si el paso 2 falla
  }
  if (f.followup) {
    // Ya en el hilo: se marca enviado ANTES de limpiar el recordatorio
    // (follow_up_sent lo limpia si no queda otro seguimiento pendiente, y
    // esta fila 'enviando' todavía contaría como uno).
    if (!f.sentMarked) {
      await markOutboxSent(outboxId);
      f.sentMarked = true;
    }
    await markFollowUpSent(f.conversationId, f.scheduledAt);
  }
  pendingFinalize.delete(outboxId);
}

// ¿El envío ya quedó en el hilo? (mismo rol y texto, guardado después de que
// se encoló): una fila que un cierre dejó 'enviando' justo después de
// registrarla no se registra dos veces ni se avisa como dudosa.
async function alreadyInThread(item: OutboxItem): Promise<boolean> {
  if (item.conversation_id == null) return false;
  const role = isBotKind(item) ? "assistant" : "human";
  return (await findMessageSince(item.conversation_id, role, item.content, item.created_at)) !== null;
}

// Id de WhatsApp determinista por fila del outbox: si un envío se repite
// (reinicio entre el envío y el marcado, timeout que sí había salido), sale
// con el MISMO id y WhatsApp descarta el duplicado en el teléfono del
// cliente. created_at evita chocar con ids de otra base (p.ej. una demo).
// Las respuestas automáticas en cola usan el id de su intento en vivo: si
// ese intento sí había salido, WhatsApp descarta la segunda copia.
function outboxMessageId(item: OutboxItem): string {
  if (isBotKind(item) && item.channel_msg_id) return item.channel_msg_id;
  const hash = crypto.createHash("sha256").update(`outbox:${item.id}:${item.created_at}`).digest("hex");
  return "3EB0" + hash.toUpperCase().slice(0, 18);
}

// Tras liberar o diferir una fila: los envíos posteriores al mismo
// destinatario esperan (orden), y si se descartó se avisa — un seguimiento
// fallido se marca en el lead; una respuesta automática que nunca llegó
// pasa la conversación a un asesor (el motor ya la daba por respondida).
async function afterRelease(
  item: OutboxItem,
  result: { discarded: boolean; retryAt: number | null },
  reason: string
): Promise<void> {
  if (result.retryAt !== null) {
    holdRecipient(item, result.retryAt);
    await deferLaterOutboxForRecipient(item, result.retryAt).catch(() => undefined);
  }
  if (!result.discarded) return;
  console.error(`[bot] ⚠️ Outbox #${item.id} descartado: ${reason.slice(0, 200)}`);
  const convId = item.conversation_id;
  if (convId == null || item.kind === "notify") return;
  if (item.kind === "followup") {
    await markFollowUpFailed(convId, item.scheduled_at).catch((err) =>
      console.error(`[bot] No se pudo registrar el fallo del seguimiento:`, err)
    );
    return;
  }
  addLeadEvent(convId, "delivery_error", `No se pudo entregar un mensaje: ${reason.slice(0, 200)}`).catch(
    () => undefined
  );
  if (isBotKind(item)) {
    void pauseAiForHuman(convId, "La respuesta automática no se pudo entregar: la conversación pasó a un asesor.");
  }
}

async function release(req: ReleaseRequest): Promise<void> {
  try {
    const result = await releaseOutboxFailure(req.item, req.countAttempt, req.maxAttempts, req.deferSeconds);
    pendingRelease.delete(req.item.id);
    await afterRelease(req.item, result, req.reason);
  } catch (err) {
    // Se reintenta la liberación en el próximo tick (no queda huérfana).
    pendingRelease.set(req.item.id, req);
    console.error(`[bot] No se pudo liberar outbox #${req.item.id} (se reintenta):`, err);
  }
}

// Reintentos diferidos de ticks anteriores (también al apagar).
export async function flushOutboxBookkeeping(): Promise<void> {
  for (const id of [...sentUnrecorded]) {
    try {
      await markOutboxSent(id);
      sentUnrecorded.delete(id);
    } catch {
      /* siguiente tick */
    }
  }
  for (const req of [...pendingRelease.values()]) await release(req);
  for (const id of [...claimUncertain.keys()]) {
    try {
      if ((await getOutboxSentState(id)) === 3) await unclaimOutboxItem(id);
      claimUncertain.delete(id);
    } catch {
      /* siguiente tick */
    }
  }
  for (const [id, f] of [...pendingFinalize]) {
    try {
      await finalizeDelivery(id, f);
    } catch (err) {
      f.failingSince ??= Date.now();
      // Solo se abandona ante un error de datos (p.ej. conversación borrada)
      // o tras 30 min de base caída.
      if (!isDataError(err) && Date.now() - f.failingSince <= FINALIZE_GIVE_UP_MS) continue;
      pendingFinalize.delete(id);
      console.error(`[bot] ⚠️ Se abandona registrar en el hilo el envío #${id}:`, err);
    }
    // Registrado (o abandonado): ya puede marcarse como enviado.
    await markSent(id);
  }
}

// ── Resolución de la cuenta de WhatsApp para un envío ───────
// Prioridad: cuenta explícita del item → cuenta del vendedor asignado (así
// el chat "se redirige" al vendedor según la etapa) → cuenta por la que
// habla el lead. Si esas cuentas están caídas se ESPERA (sin quemar
// intentos): salir por otro número de la empresa confundía al cliente, que
// recibía el mensaje desde un número al que nunca escribió. Solo un lead
// sin cuenta conocida (p.ej. creado por la API) sale por cualquier cuenta
// lista de su organización; los avisos internos, por cualquiera. TODAS las
// resoluciones quedan confinadas a la organización del envío. "Lista" =
// conectada Y con los mensajes pendientes de la desconexión ya recibidos.
// Por qué no hay cuenta para enviar:
//  - warming: conectada, recibiendo lo pendiente (segundos): se reintenta
//    en el próximo tick;
//  - down: caída o reconectando: la fila espera 30 s (sin quemar intentos);
//  - gone: la cuenta designada ya no existe: cuenta intentos y termina
//    descartada con aviso, en vez de esperar para siempre.
class WaUnavailableError extends Error {
  constructor(
    message: string,
    readonly kind: "warming" | "down" | "gone"
  ) {
    super(message);
  }
}

// Cuentas que existen en wa_accounts (id → organización), según la última
// lectura del tick. Sin sesión NO significa eliminada: una cuenta apagada
// (o de una organización con WhatsApp apagado) no tiene sesión y sus envíos
// deben esperar, no descartarse.
let knownAccounts: Map<number, number> | null = null;

export function rememberAccounts(accounts: WaAccount[]): void {
  knownAccounts = new Map(accounts.map((a) => [a.id, a.org_id]));
}

function accountsOfOrg(orgId: number): number[] {
  return knownAccounts ? [...knownAccounts].filter(([, org]) => org === orgId).map(([id]) => id) : [];
}

function unavailable(accountIds: number[], orgId: number, message: string): WaUnavailableError {
  const sessions = accountIds.map((id) => getSession(id)).filter((s) => s && s.orgId === orgId);
  if (sessions.some((s) => s?.isOpen())) return new WaUnavailableError(message, "warming");
  // Solo "eliminada" si la lista de cuentas está cargada y ya no la tiene.
  const exists = !knownAccounts || accountIds.some((id) => knownAccounts?.get(id) === orgId);
  return new WaUnavailableError(message, exists ? "down" : "gone");
}

async function resolveWaSession(
  item: OutboxItem,
  getMembers: () => Promise<Map<number, TeamMember>>
): Promise<BaileysSession> {
  const readyOf = (accountId: number) => {
    const s = getSession(accountId);
    return s?.isReady() && s.orgId === item.org_id ? s : null;
  };
  const orgAccounts = () => accountsOfOrg(item.org_id);
  if (item.wa_account_id != null) {
    const s = readyOf(item.wa_account_id);
    if (s) return s;
    throw unavailable([item.wa_account_id], item.org_id, `La cuenta de WhatsApp ${item.wa_account_id} no disponible por ahora`);
  }
  if (item.kind === "notify" || item.conversation_id == null) {
    // Avisos internos: mejor desde una cuenta distinta del destinatario; si
    // la única lista ES la del destinatario, sale igual (chat consigo mismo).
    let self: BaileysSession | null = null;
    for (const s of getAllSessions()) {
      if (s.orgId !== item.org_id || !s.isReady()) continue;
      if (s.phone() !== item.phone) return s;
      self ??= s;
    }
    if (self) return self;
    throw unavailable(
      orgAccounts(),
      item.org_id,
      `Ninguna cuenta de WhatsApp lista en la organización ${item.org_id} (no disponible por ahora)`
    );
  }
  let conv: Awaited<ReturnType<typeof getConversationById>>;
  try {
    conv = await getConversationById(item.conversation_id);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new WaUnavailableError(`Conversación ${item.conversation_id} no disponible momentáneamente: ${detail}`, "down");
  }
  if (!conv) throw new WaUnavailableError(`La conversación ${item.conversation_id} ya no existe`, "gone");
  const candidates: number[] = [];
  if (conv.assigned_member_id != null) {
    const member = (await getMembers()).get(conv.assigned_member_id);
    if (member?.active && member.wa_account_id != null) candidates.push(member.wa_account_id);
  }
  if (conv.wa_account_id != null) candidates.push(conv.wa_account_id);
  for (const accountId of candidates) {
    const s = readyOf(accountId);
    if (s) return s;
  }
  if (candidates.length > 0) {
    throw unavailable(
      candidates,
      item.org_id,
      `La cuenta de WhatsApp del lead (${candidates.join(", ")}) no disponible por ahora`
    );
  }
  const any = getOpenSession(null, item.org_id);
  if (any) return any;
  throw unavailable(
    orgAccounts(),
    item.org_id,
    `Ninguna cuenta de WhatsApp lista en la organización ${item.org_id} (no disponible por ahora)`
  );
}

// Envío según canal: WhatsApp por la sesión ya resuelta; WhatsApp Cloud API
// por HTTPS (Graph API) con los tokens de la organización del envío.
// Devuelve el id del mensaje en el canal.
async function deliverOutboxItem(
  item: OutboxItem,
  session: BaileysSession | null,
  readyEpoch: number | undefined,
  // Configuración de canales de su organización leída en el tick.
  channelRows: Record<string, ChannelSettingsRow> | undefined
): Promise<string | null> {
  if (item.channel === "whatsapp") {
    if (!session) throw new Error(`Outbox #${item.id}: sin cuenta de WhatsApp (no disponible por ahora)`);
    return session.send(`${item.phone}@s.whatsapp.net`, item.content, {
      messageId: outboxMessageId(item),
      // Los avisos a vendedores no son del lead: un rechazo no va a su ficha.
      conversationId: item.kind === "notify" ? null : item.conversation_id,
      // Por la MISMA conexión que se validó (si se reconectó, espera).
      readyEpoch,
    });
  }
  return sendChannelText(item.org_id, item.channel, item.phone, item.content, channelRows);
}

// Se agotó la espera de un envío que sigue en curso (puede salir igual).
class DeliveryTimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeliveryTimeoutError(`${label}: timed out tras ${ms / 1000}s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// Lo que ya llegó por esa cuenta para ese contacto (p.ej. el backlog de una
// reconexión, que puede traer la respuesta de un asesor desde el teléfono o
// más mensajes del cliente) termina de procesarse ANTES de decidir si una
// respuesta automática sigue valiendo. false = no terminó a tiempo.
// En el outbox, más corto: la fila se reintenta en el próximo tick y el tick
// no debe quedar frenado (sesiones, alarmas, demás envíos).

async function drainInbound(
  accountId: number,
  orgId: number,
  phone: string,
  timeoutMs = OUTBOX_TIMING.inboundDrainMs
): Promise<boolean> {
  try {
    await withTimeout(
      (async () => {
        await enqueueForContact(`intake:${accountId}`, async () => undefined);
        await enqueueForContact(contactKey(orgId, "whatsapp", phone), async () => undefined);
      })(),
      timeoutMs,
      "procesar lo recibido"
    );
    return true;
  } catch {
    return false;
  }
}

// ¿Se puede intentar la entrega ahora? (canales que no son WhatsApp por
// Baileys: WhatsApp API habilitado en SU organización).
function isDeliverable(
  item: OutboxItem,
  settingsByOrg: Map<number, Record<string, ChannelSettingsRow>> | null
): boolean {
  if (item.channel === "api") return false; // sin canal de respuesta, nunca
  const row = settingsByOrg?.get(item.org_id)?.[item.channel];
  return row?.enabled ?? false;
}

// Caídas de conexión de Baileys (incluye códigos de cierre del WebSocket que
// llegan como número suelto, p.ej. 1006).
const CONNECTION_ISSUE = /connection closed|connection was lost|timed out|no disponible|^\s*10(0\d|1[0-5])\s*$/i;

async function expireBotReply(item: OutboxItem): Promise<void> {
  // Primero la derivación (el motor la da por hecha aunque la base tarde en
  // confirmarla) y después el descarte: si el descarte falla, el próximo
  // tick lo repite.
  if (item.conversation_id != null) {
    const conv = await getConversationById(item.conversation_id).catch(() => null);
    if (conv?.mode !== "HUMAN") {
      void pauseAiForHuman(
        item.conversation_id,
        `La respuesta automática no se pudo entregar en ${OUTBOX_TIMING.botReplyTtlS / 60} min (canal desconectado): la conversación pasó a un asesor.`
      );
    }
  }
  try {
    if (await discardOutboxItem(item.id)) {
      console.error(
        `[bot] ⚠️ Respuesta automática #${item.id} vencida sin entregarse (canal caído más de ${OUTBOX_TIMING.botReplyTtlS / 60} min): la conversación pasa a un asesor`
      );
    }
  } catch (err) {
    console.error(`[bot] No se pudo vencer la respuesta automática #${item.id}:`, err);
  }
}

// ¿Una respuesta automática en cola sigue valiendo? No, si mientras
// esperaba un asesor tomó la conversación (modo HUMANO, pausa aún sin
// confirmar en la base, o un asesor escribió después del mensaje del cliente
// que responde — también mientras el envío en vivo se reintentaba, antes de
// encolarla), ni si otra respuesta del bot ya cubrió lo mismo. Las
// deterministas ('bot_fixed': acuse de derivación, palabra clave que vale
// también en HUMANO) no dependen del modo.
async function queuedBotReplyVerdict(item: OutboxItem, { ignoreMode = false } = {}): Promise<string | null> {
  if (item.conversation_id == null) return null;
  const conv = await getConversationById(item.conversation_id);
  if (!conv) return "la conversación ya no existe";
  if (!ignoreMode && item.kind === "bot" && (conv.mode !== "AI" || hasPendingHandoff(conv.id))) {
    return "un asesor tomó la conversación";
  }
  const covers = item.covers_msg_id ?? null;
  const advisorWrote =
    covers !== null ? await hasHumanReplyAfter(conv.id, covers) : await hasHumanReplySince(conv.id, item.created_at);
  if (advisorWrote) return "un asesor respondió mientras esperaba";
  if (item.kind === "bot" && (await hasBotReplyCovering(conv.id, covers, item.created_at))) {
    return "otra respuesta del bot ya cubrió lo mismo";
  }
  return null;
}

// Respuesta en cola cuya cuenta o canal no está disponible: si ya no
// corresponde (un asesor escribió, la conversación pasó a HUMANO, otra
// respuesta la cubrió) se descarta ya. Esperando a su cuenta retenía los
// mensajes posteriores a ese cliente — que pueden salir por otra cuenta —
// hasta su vencimiento. true = ya no está pendiente. Solo por motivos
// definitivos: el modo HUMANO puede volver a IA antes de que vuelva la
// cuenta (y el motor ya la dio por respondida); eso lo decide la
// verificación al entregarla.
async function discardIfSuperseded(item: OutboxItem): Promise<boolean> {
  let verdict: string | null;
  try {
    verdict = await queuedBotReplyVerdict(item, { ignoreMode: true });
  } catch {
    return false;
  }
  if (!verdict) return false;
  try {
    if (await discardOutboxItem(item.id)) {
      console.log(`[bot] Respuesta automática en cola #${item.id} descartada: ${verdict}`);
    }
    return true;
  } catch {
    return false;
  }
}

// Una fila de WhatsApp sin cuenta lista: según el motivo, se reintenta en
// el próximo tick, espera 30 s o cuenta un intento (cuenta inexistente).
async function handleUnavailable(item: OutboxItem, err: unknown): Promise<void> {
  const kind = err instanceof WaUnavailableError ? err.kind : "down";
  const reason = err instanceof Error ? err.message : String(err);
  // Recibiendo lo pendiente (segundos): espera corta. Caída: 30 s. Ninguna
  // vuelve al frente del lote mientras tanto (se difiere en la base).
  const wait = kind === "warming" ? OUTBOX_TIMING.warmingDeferS : OUTBOX_TIMING.downDeferS;
  try {
    if (kind === "gone") {
      const result = await releaseOutboxFailure(item, true, 5, 0, { claimed: false });
      await afterRelease(item, result, reason);
      return;
    }
    await deferOutboxItem(item.id, wait);
  } catch {
    /* siguiente tick (el destinatario queda retenido igual) */
  }
  await afterRelease(item, { discarded: false, retryAt: nowEpoch() + wait }, reason);
}

// Respuestas automáticas en cola que vencieron sin que su fila entrara a un
// lote (p.ej. sin ninguna sesión de WhatsApp abierta, ese canal ni se
// consulta): vencen igual a su hora y la conversación pasa a un asesor, en
// vez de quedar esperando para siempre.
let lastStaleSweep = 0;
async function expireStaleBotReplies(): Promise<void> {
  const now = nowEpoch();
  if (now - lastStaleSweep < OUTBOX_TIMING.staleSweepEveryS) return;
  lastStaleSweep = now;
  let stale: OutboxItem[];
  try {
    stale = await listStaleBotReplies(now - OUTBOX_TIMING.botReplyTtlS, 50);
  } catch {
    return; // siguiente vuelta
  }
  for (const item of stale) {
    if (stopping) return;
    await expireBotReply(item);
  }
}

let inFlightReset = false;

// Apagado: el envío en curso termina y no se toma ninguno más.
let stopping = false;
export function stopOutbox(): void {
  stopping = true;
}

// Filas que quedaron 'enviando' si el proceso anterior murió a mitad de una
// entrega. Las de WhatsApp vuelven a pendiente (salen con el mismo id). Las
// de WhatsApp API pudieron haber salido: se dan por enviadas, con aviso al
// operador, y se reflejan en el hilo. Hasta lograrlo no se reclama nada.
export async function resetInFlightOnce(): Promise<boolean> {
  if (inFlightReset) return true;
  let settled: OutboxItem[];
  try {
    const result = await resetInFlightOutbox();
    settled = result.settled;
    for (const id of result.reset) resetAtBoot.add(id);
    inFlightReset = true;
  } catch (err) {
    console.warn("[bot] No se pudo resetear el outbox en vuelo (se reintenta):", err instanceof Error ? err.message : err);
    return false;
  }
  for (const item of settled) {
    // Ya en el hilo: el envío se había confirmado y solo faltó marcarlo (el
    // cierre llegó entre ambos pasos). Sin aviso ni otra copia en el hilo.
    const recorded =
      item.conversation_id != null &&
      (item.kind === "followup" || isBotKind(item)) &&
      (await alreadyInThread(item).catch(() => false));
    if (!recorded) {
      console.warn(
        `[bot] ⚠️ Outbox #${item.id} [${item.channel}] quedó a medio enviar en el cierre anterior: se da por enviado (no se reenvía para no duplicarlo)`
      );
    }
    if (item.conversation_id == null || item.kind === "notify") continue;
    if (!recorded) {
      addLeadEvent(
        item.conversation_id,
        "delivery_uncertain",
        "WhatsApp API no confirmó si un mensaje llegó (el bot se reinició durante el envío; no se reenvía para no duplicarlo): revisa el chat."
      ).catch(() => undefined);
    }
    if (item.kind === "followup" || isBotKind(item)) {
      const f: DeliveryFinalize = {
        conversationId: item.conversation_id,
        content: item.content,
        role: isBotKind(item) ? "assistant" : "human",
        channelMsgId: item.kind === "followup" ? `followup:${item.id}` : `outbox:${item.id}`,
        coversMsgId: isBotKind(item) ? (item.covers_msg_id ?? null) : null,
        followup: item.kind === "followup",
        scheduledAt: item.scheduled_at,
        messageInserted: recorded,
        failingSince: null,
      };
      pendingFinalize.set(item.id, f);
      await finalizeDelivery(item.id, f).catch(() => undefined);
    }
  }
  return true;
}

export async function flushOutbox(
  settingsByOrg: Map<number, Record<string, ChannelSettingsRow>> | null
): Promise<void> {
  // Filas que quedaron 'enviando' si el proceso anterior murió a mitad de
  // una entrega (si falló al arrancar, se reintenta; mientras tanto no se
  // reclama nada nuevo).
  if (!(await resetInFlightOnce())) return;

  // Exclusiones GLOBALES de la consulta (inanición por limit): 'api' nunca
  // entrega, y 'whatsapp' solo si no hay NINGUNA sesión abierta en ninguna
  // organización. El detalle por organización/cuenta lo decide la
  // resolución de la cuenta.
  const disabledChannels = new Set<string>();
  if (!anySessionOpen()) disabledChannels.add("whatsapp");
  disabledChannels.add("api");

  // Miembros del equipo: se cargan una sola vez por flush y solo si algún
  // envío de WhatsApp los necesita (resolución de la cuenta del asignado).
  let membersPromise: Promise<Map<number, TeamMember>> | null = null;
  const getMembers = () => {
    if (!membersPromise) {
      membersPromise = listTeamMembers()
        .then((list) => new Map(list.map((m) => [m.id, m])))
        .catch(() => new Map<number, TeamMember>());
    }
    return membersPromise;
  };

  await flushOutboxBookkeeping();
  await expireStaleBotReplies();

  const pending = oldestFirstPerRecipient(await getPendingOutbox(20, [...disabledChannels]));
  // Destinatarios con un envío atrasado o a medias en este lote: sus envíos
  // siguientes esperan, para que el cliente los lea en orden.
  const blocked = new Set<string>();
  for (const req of pendingRelease.values()) blocked.add(recipientKeyOf(req.item));
  for (const item of claimUncertain.values()) blocked.add(recipientKeyOf(item));
  // Cuentas que no terminaron de procesar lo recibido a tiempo en este tick.
  const stalledAccounts = new Set<number>();

  for (const item of pending) {
    if (stopping) return;
    const recipientKey = recipientKeyOf(item);
    if (
      sentUnrecorded.has(item.id) ||
      pendingFinalize.has(item.id) ||
      pendingRelease.has(item.id) ||
      claimUncertain.has(item.id)
    ) {
      blocked.add(recipientKey);
      continue;
    }
    if (item.kind !== "notify" && (blocked.has(recipientKey) || isHeld(item))) {
      // Retenida en memoria: la espera queda también en la fila. Así sale del
      // frente del lote (20 retenidas lo taponaban) y el orden sobrevive a un
      // reinicio.
      const until = heldRecipients.get(recipientKey);
      if (until !== undefined && until > nowEpoch() && keepsOrder(item) && (item.scheduled_at ?? 0) < until) {
        await deferOutboxUntil(item.id, until).catch(() => undefined);
      }
      continue;
    }

    // Respuesta automática que esperó demasiado: ya no se envía.
    if (isBotKind(item) && nowEpoch() - item.created_at > OUTBOX_TIMING.botReplyTtlS) {
      await expireBotReply(item);
      continue;
    }

    // Cuenta/canal por el que sale, ANTES de reclamar: lo que no puede salir
    // ahora no se reclama ni tapona el lote.
    let session: BaileysSession | null = null;
    // Conexión validada como lista: si la cuenta se reconecta antes del
    // envío, no sale por la conexión nueva sin recibir su backlog.
    let readyEpoch: number | undefined;
    if (item.channel === "whatsapp") {
      try {
        session = await resolveWaSession(item, getMembers);
        readyEpoch = session.readyEpoch() ?? undefined;
      } catch (err) {
        if (isBotKind(item) && (await discardIfSuperseded(item))) continue;
        blocked.add(recipientKey);
        await handleUnavailable(item, err);
        continue;
      }
    } else if (!isDeliverable(item, settingsByOrg)) {
      if (isBotKind(item) && (await discardIfSuperseded(item))) continue;
      // Su organización no puede entregar ahora: se difiere 30 s para que no
      // tapone el lote de las demás (sin quemar intentos).
      blocked.add(recipientKey);
      await deferOutboxItem(item.id, OUTBOX_TIMING.channelOffDeferS).catch(() => undefined);
      await afterRelease(item, { discarded: false, retryAt: nowEpoch() + OUTBOX_TIMING.channelOffDeferS }, "canal no disponible");
      continue;
    }

    if (isBotKind(item)) {
      // Nunca desde OTRO número: si la cuenta se re-vinculó a un número
      // distinto del que el cliente escribió, la respuesta no sale.
      const expectedPhone = item.account_phone;
      const currentPhone = session?.phone();
      if (session && expectedPhone && currentPhone && currentPhone !== expectedPhone) {
        try {
          if (await discardOutboxItem(item.id)) {
            await afterRelease(
              item,
              { discarded: true, retryAt: null },
              `la cuenta ${session.accountId} ahora está vinculada a otro número (${currentPhone}); el cliente escribió a ${expectedPhone}`
            );
          }
        } catch {
          blocked.add(recipientKey);
        }
        continue;
      }
      // Lo recibido de ese contacto (backlog incluido) se procesa antes de
      // decidir: puede traer la respuesta de un asesor desde el teléfono. Si
      // la cuenta no termina a tiempo, sus demás respuestas esperan al
      // próximo tick (sin frenar este).
      if (session) {
        if (stalledAccounts.has(session.accountId)) {
          blocked.add(recipientKey);
          continue;
        }
        if (!(await drainInbound(session.accountId, item.org_id, item.phone, OUTBOX_TIMING.outboxDrainMs))) {
          stalledAccounts.add(session.accountId);
          blocked.add(recipientKey);
          continue;
        }
      }
      // Mensajes del contacto aún sin guardar (respaldo en disco, o uno del
      // equipo que todavía no se pudo leer — puede ser la respuesta de un
      // asesor desde el teléfono): la respuesta espera a que todo lo suyo
      // quede guardado, igual que en el motor. Se difiere en la base para no
      // tapar el lote.
      if (hasUnsavedInbound(item.org_id, item.channel, item.phone)) {
        blocked.add(recipientKey);
        await deferOutboxItem(item.id, OUTBOX_TIMING.unsavedDeferS).catch(() => undefined);
        await afterRelease(
          item,
          { discarded: false, retryAt: nowEpoch() + OUTBOX_TIMING.unsavedDeferS },
          "mensajes del contacto aún sin guardar"
        );
        continue;
      }
      let verdict: string | null;
      try {
        verdict = await queuedBotReplyVerdict(item);
      } catch {
        blocked.add(recipientKey);
        continue; // siguiente tick
      }
      if (verdict) {
        try {
          if (await discardOutboxItem(item.id)) {
            console.log(`[bot] Respuesta automática en cola #${item.id} descartada: ${verdict}`);
          }
        } catch {
          blocked.add(recipientKey);
        }
        continue;
      }
    }

    // Seguimiento programado mientras la IA responde (o reintenta) una
    // pregunta del cliente: espera a esa respuesta.
    if (item.kind === "followup") {
      let wait: boolean;
      try {
        wait = await followUpShouldWait(item);
      } catch {
        blocked.add(recipientKey);
        continue; // siguiente tick
      }
      if (wait) {
        blocked.add(recipientKey);
        await deferOutboxItem(item.id, OUTBOX_TIMING.followupDeferS).catch(() => undefined);
        await afterRelease(
          item,
          { discarded: false, retryAt: nowEpoch() + OUTBOX_TIMING.followupDeferS },
          "el cliente espera una respuesta del bot"
        );
        continue;
      }
    }

    // Orden por destinatario contra la base: si queda uno ANTERIOR suyo sin
    // salir (diferido, a medio liberar, de antes de un reinicio), este pasa
    // detrás de él. Los envíos van de a uno: en una ráfaga normal el anterior
    // ya salió y este sale en el mismo tick.
    if (keepsOrder(item)) {
      let older: number | null | undefined;
      try {
        older = await olderPendingOutboxTime(item);
      } catch {
        blocked.add(recipientKey);
        continue; // siguiente tick
      }
      if (older !== undefined) {
        blocked.add(recipientKey);
        // Detrás del anterior (en un empate desempata la antigüedad) y fuera
        // del grupo de los nunca diferidos.
        await deferOutboxUntil(item.id, Math.max(older ?? 0, nowEpoch() + OUTBOX_TIMING.orderDeferS)).catch(() => undefined);
        continue;
      }
    }

    // Reclamo condicional (sent=0 → 3): si el operador canceló o reprogramó
    // el seguimiento (o borró la conversación) mientras este lote estaba en
    // memoria, la fila ya no está pendiente y NO se envía.
    let claimed = false;
    try {
      claimed = await claimOutboxItem(item.id);
    } catch (err) {
      // El UPDATE pudo aplicarse con la respuesta perdida: se revisa la fila
      // en el próximo tick (si quedó 'enviando' sin dueño, vuelve a 0).
      console.error(`[bot] No se pudo reclamar outbox #${item.id}:`, err);
      claimUncertain.set(item.id, item);
      blocked.add(recipientKey);
      continue;
    }
    if (!claimed) {
      console.log(`[bot] Outbox #${item.id} ya no está pendiente (cancelado/reprogramado); no se envía`);
      continue;
    }

    let channelMsgId: string | null = null;
    let uncertain: string | null = null;
    try {
      channelMsgId = await withTimeout(
        deliverOutboxItem(item, session, readyEpoch, settingsByOrg?.get(item.org_id)),
        OUTBOX_TIMING.deliveryTimeoutMs,
        `Envío outbox #${item.id}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (item.channel !== "whatsapp" && (isUncertainDelivery(err) || err instanceof DeliveryTimeoutError)) {
        // Cloud API: pudo haber salido (o salir todavía) y repetirlo lo
        // duplicaría. Se da por enviado y el operador ve el aviso.
        uncertain = msg;
      } else {
        console.error(`[bot] Falló envío de outbox #${item.id} [${item.channel}]:`, err);
        blocked.add(recipientKey);
        // Para WhatsApp no queman intentos las caídas de conexión de la
        // cuenta emisora (la fila espera 30 s); para WhatsApp API todo fallo
        // cuenta (con espera creciente).
        const connection = item.channel === "whatsapp" && CONNECTION_ISSUE.test(msg);
        await release({
          item,
          countAttempt: !connection,
          maxAttempts: 5,
          deferSeconds: connection ? OUTBOX_TIMING.downDeferS : 0,
          reason: msg,
        });
        continue;
      }
    }

    console.log(
      `[bot] → Outbox #${item.id}${item.kind === "notify" ? " (aviso a vendedor)" : isBotKind(item) ? " (respuesta automática en cola)" : ""} ${uncertain ? "enviado SIN confirmación" : "enviado"} a ${item.phone}`
    );
    if (uncertain && item.conversation_id != null && item.kind !== "notify") {
      addLeadEvent(
        item.conversation_id,
        "delivery_uncertain",
        "WhatsApp API no confirmó si un mensaje llegó (no se reenvía para no duplicarlo): revisa el chat."
      ).catch(() => undefined);
    }

    // Seguimiento programado (CRM) o respuesta automática que salió por la
    // cola: al entregarse recién se refleja en el hilo (y el seguimiento
    // limpia el recordatorio del lead). Los 'manual' ya fueron insertados en
    // messages por la API; los 'notify' son avisos internos y NUNCA tocan el
    // hilo del cliente.
    if ((item.kind === "followup" || isBotKind(item)) && item.conversation_id != null) {
      if (item.kind === "followup") console.log(`[bot] ⏰ Seguimiento programado entregado a ${item.phone}`);
      const f: DeliveryFinalize = {
        conversationId: item.conversation_id,
        content: item.content,
        role: isBotKind(item) ? "assistant" : "human",
        // Seguimientos con id propio: el motor los reconoce como envíos
        // programados (no como un asesor contestando).
        channelMsgId:
          item.kind === "followup" ? `followup:${item.id}` : (channelMsgId ?? outboxMessageId(item)),
        coversMsgId: isBotKind(item) ? (item.covers_msg_id ?? null) : null,
        followup: item.kind === "followup",
        scheduledAt: item.scheduled_at,
        messageInserted: false,
        failingSince: null,
      };
      // Reenvío (mismo id) de una fila que un cierre dejó 'enviando': si ya
      // había quedado en el hilo, no se guarda otra copia.
      if (resetAtBoot.delete(item.id) && (await alreadyInThread(item).catch(() => false))) f.messageInserted = true;
      pendingFinalize.set(item.id, f);
      try {
        await finalizeDelivery(item.id, f);
      } catch (err) {
        f.failingSince = Date.now();
        console.error(`[bot] Registro en el hilo del envío #${item.id} pendiente de reintento:`, err);
      }
    }
    // Recién con el envío en el hilo la fila deja de estar 'enviando': hasta
    // entonces el motor la ve en cola y no vuelve a responder lo mismo (tras
    // un reinicio no tiene otra forma de saber que salió). Si el registro
    // quedó pendiente, el marcado lo hace la reposición al completarlo.
    if (!pendingFinalize.has(item.id)) await markSent(item.id);
    // Respuesta en cola ya entregada: lo que el cliente escribió mientras
    // tanto se responde ahora (sin esperar al reintento ni al barrido).
    if (isBotKind(item) && item.channel === "whatsapp" && item.conversation_id != null) {
      scheduleReplyPass(item.conversation_id);
    }
  }
}

// Seguimiento programado de una conversación con la IA cuyo último mensaje
// es del cliente: la IA lo está respondiendo (o reintentando) y el
// seguimiento espera a esa respuesta, hasta 10 min. Si saliera antes, sin la
// migración quedaría en el hilo como un mensaje de asesor: la respuesta en
// vuelo se descartaba y la pregunta quedaba como atendida.
const FOLLOWUP_WAIT_MAX_S = 10 * 60;
async function followUpShouldWait(item: OutboxItem): Promise<boolean> {
  if (item.conversation_id == null) return false;
  const conv = await getConversationById(item.conversation_id);
  if (!conv || conv.mode !== "AI" || hasPendingHandoff(conv.id)) return false;
  const last = (await getRecentHistory(conv.id, 1)).at(-1);
  return !!last && last.role === "user" && nowEpoch() - last.created_at < FOLLOWUP_WAIT_MAX_S;
}

// El mensaje YA salió: no debe reenviarse aunque el marcado falle (se
// reintenta solo el marcado).
async function markSent(id: number): Promise<void> {
  try {
    await markOutboxSent(id);
  } catch (err) {
    sentUnrecorded.add(id);
    console.error(`[bot] ⚠️ Outbox #${id} se envió pero no se pudo marcar como enviado; se reintentará solo el marcado:`, err);
  }
}

// ── Respuestas automáticas por WhatsApp (Baileys) ───────────
// Siempre por la cuenta VIVA a la que escribió el cliente (esperando una
// reconexión breve), al MISMO jid por el que escribió (funciona para @lid) y
// nunca desde otro número: si la cuenta se re-vinculó a un número distinto,
// la respuesta no sale.
export async function sendBotReply(target: ReplyTarget, text: string): Promise<{ channelMsgId: string | null }> {
  const conv = target.conversation;
  const accountId = target.route?.waAccountId ?? conv.wa_account_id;
  const session = accountId != null ? getSession(accountId) : getOpenSession(null, conv.org_id);
  if (!session || session.orgId !== conv.org_id) {
    throw new Error(`Cuenta de WhatsApp ${accountId ?? "(ninguna)"} no disponible para la conversación ${conv.id}`);
  }
  // Conectada Y con lo pendiente de la desconexión ya recibido. El envío sale
  // solo por ESTA conexión: si se reconecta antes, se reintenta (y se vuelve
  // a recibir lo pendiente y a validar).
  const readyEpoch = await session.waitReady(OUTBOX_TIMING.replyWaitOpenMs);
  const expectedPhone = target.route?.accountPhone;
  const currentPhone = session.phone();
  if (expectedPhone && currentPhone && currentPhone !== expectedPhone) {
    throw new PermanentSendError(
      `la cuenta ${session.accountId} ahora está vinculada a otro número (${currentPhone}); el cliente escribió a ${expectedPhone}`
    );
  }
  const recipient = conv.external_id ?? conv.phone;
  const jid = target.route?.jid ?? (recipient ? `${recipient}@s.whatsapp.net` : null);
  if (!jid) throw new PermanentSendError("la conversación no tiene número de destino");
  // Lo que ya llegó de este contacto (p.ej. el backlog de la reconexión) se
  // procesa antes de la verificación final.
  if (recipient && !(await drainInbound(session.accountId, conv.org_id, recipient))) {
    throw new Error(`Cuenta ${session.accountId} no disponible por ahora (procesando lo recibido de ${recipient})`);
  }
  // Verificación final DESPUÉS de esperar la reconexión: si mientras tanto un
  // asesor tomó el chat, la respuesta no sale.
  await assertStillValid(target);
  const id = await session.send(jid, text, { messageId: target.messageId, conversationId: conv.id, readyEpoch });
  return { channelMsgId: id };
}

