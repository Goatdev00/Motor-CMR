// Adaptador de Baileys al motor de respuestas: filtra los eventos de
// WhatsApp, resuelve QUIÉN escribió (número real, también para contactos
// @lid), extrae el contenido y lo persiste en la cola de ese contacto. La
// respuesta la decide el motor (reply-engine) mirando el hilo en la base, y
// sale siempre por el socket VIVO de la cuenta — nunca por uno capturado al
// recibir, que tras una reconexión ya está muerto.
import {
  NO_MESSAGE_FOUND_ERROR_TEXT,
  WAMessageStubType,
  normalizeMessageContent,
  toNumber,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import {
  findConversation,
  findMessageSince,
  getOrCreateConversation,
  getRecentHistory,
  hasBusinessReplyBefore,
  hasLeadEventSince,
  insertMessageIdempotent,
  isTransientDbError,
  messagesKeepChannelIds,
  recentAutomatedTexts,
  withDbRetry,
  type Message,
} from "../db";
import {
  clampText,
  contactKey,
  enqueueForContact,
  hasPendingHandoff,
  pauseAiForHuman,
  persistInbound,
  scheduleReplyPass,
  type InboundMessage,
  type ReplyRoute,
} from "../reply-engine";
import {
  hasJournalToRecover,
  journalDone,
  journalInbound,
  listSpooled,
  loadAutoTexts,
  recoverJournal,
  replaySpool,
  saveAutoTexts,
  spoolInbound,
  type SpoolEntry,
} from "../inbound-spool";
import { isInternalPhone, type BaileysSession } from "./client";

// ── Contenido ───────────────────────────────────────────────
// Texto, respuestas de botones/listas y leyendas de multimedia. Lo que el
// bot no puede leer (audio, imagen sin texto, ubicación...) se guarda con
// una marca explícita: el operador lo ve en el dashboard y la IA sabe que
// no puede verlo/escucharlo (pide que lo escriban) en vez de ignorarlo.
const VIEW_ONCE_TEXT = "[Mensaje de una sola vista (no se puede ver): ábrelo en el teléfono]";

function extractContent(msg: WAMessage): string | null {
  // WhatsApp nunca entrega a un dispositivo vinculado el contenido de un
  // mensaje "de una sola vista": llega sin contenido y se guarda la marca.
  if (!msg.message && msg.key.isViewOnce) return VIEW_ONCE_TEXT;
  const m = normalizeMessageContent(msg.message);
  if (!m) return null;
  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.interactiveResponseMessage?.body?.text;
  if (text) return text;
  const withCaption = (tag: string, caption?: string | null) =>
    caption?.trim() ? `${tag} ${caption.trim()}` : tag;
  if (m.imageMessage) return withCaption("[Imagen (no se puede ver)]", m.imageMessage.caption);
  if (m.videoMessage) return withCaption("[Video (no se puede ver)]", m.videoMessage.caption);
  if (m.ptvMessage) return "[Video (no se puede ver)]";
  if (m.documentMessage) {
    const name = m.documentMessage.fileName ? `: ${m.documentMessage.fileName}` : "";
    return withCaption(`[Documento${name} (no se puede abrir)]`, m.documentMessage.caption);
  }
  if (m.audioMessage) return m.audioMessage.ptt ? "[Nota de voz (no se puede escuchar)]" : "[Audio (no se puede escuchar)]";
  if (m.stickerMessage || m.lottieStickerMessage) return "[Sticker]";
  if (m.locationMessage || m.liveLocationMessage) {
    const loc = m.locationMessage;
    const label = [loc?.name, loc?.address].filter(Boolean).join(", ");
    return label ? `[Ubicación: ${label}]` : "[Ubicación]";
  }
  if (m.contactMessage) return `[Contacto: ${m.contactMessage.displayName ?? "sin nombre"}]`;
  if (m.contactsArrayMessage) return `[Contactos: ${m.contactsArrayMessage.contacts?.length ?? 0}]`;
  // Catálogo de WhatsApp Business: un pedido o un producto que el cliente
  // envió son intención de compra — nunca se ignoran.
  if (m.orderMessage) {
    const o = m.orderMessage;
    const items = o.itemCount ? `${o.itemCount} artículo(s)` : "artículos";
    const amount = o.totalAmount1000 != null ? toNumber(o.totalAmount1000) / 1000 : null;
    const total = amount !== null && Number.isFinite(amount) ? `, total ${amount} ${o.totalCurrencyCode ?? ""}`.trimEnd() : "";
    return withCaption(`[Pedido del catálogo: ${items}${total}]`, o.message);
  }
  if (m.productMessage) {
    return withCaption(`[Producto del catálogo: ${m.productMessage.product?.title ?? "sin nombre"}]`, m.productMessage.body);
  }
  const poll = m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3;
  if (poll) {
    const options = (poll.options ?? []).map((o) => o.optionName).filter(Boolean).join(" / ");
    return `[Encuesta: ${poll.name ?? "sin título"}${options ? ` — opciones: ${options}` : ""}]`;
  }
  if (m.eventMessage) return `[Evento: ${m.eventMessage.name ?? "sin nombre"}]`;
  if (m.groupInviteMessage) return `[Invitación a un grupo: ${m.groupInviteMessage.groupName ?? "sin nombre"}]`;
  // Reacciones, ediciones, borrados, votos, etc.: no son un mensaje que haya
  // que responder.
  return null;
}

// ── Identidad ───────────────────────────────────────────────

const isPnJid = (jid: string) => jid.endsWith("@s.whatsapp.net") || jid.endsWith("@hosted");
const isLidJid = (jid: string) => jid.endsWith("@lid") || jid.endsWith("@hosted.lid");
const userOf = (jid: string) => jid.split("@")[0].split(":")[0] || null;

type LidLookup = (lid: string) => Promise<string | null>;

const lookupWith =
  (sock: WASocket): LidLookup =>
  async (lid) =>
    (await sock.signalRepository.lidMapping.getPNForLID(lid)) ?? null;

// Número de la cuenta en el socket que RECIBIÓ el mensaje (sigue valiendo
// después de que ese socket se cierra): la respuesta jamás sale desde otro
// número si la cuenta se re-vincula.
const socketPhone = (sock: WASocket): string | null => (sock.user?.id ? userOf(sock.user.id) : null);

// Número real del contacto. WhatsApp moderno entrega muchos chats 1:1 con
// JID "@lid" (número oculto): el número viene en key.remoteJidAlt; si no
// viene, se consulta el mapa LID→número que Baileys mantiene.
async function resolvePhone(lookup: LidLookup, msg: WAMessage, jid: string): Promise<string | null> {
  if (isPnJid(jid)) return userOf(jid);
  const alt = msg.key.remoteJidAlt;
  if (alt && isPnJid(alt)) return userOf(alt);
  if (isLidJid(jid)) {
    try {
      const pn = await lookup(jid);
      if (pn) return userOf(pn);
    } catch (err) {
      console.warn(`[bot] No se pudo resolver el número del contacto ${jid}:`, err);
    }
  }
  return null;
}

function sentAtOf(msg: WAMessage): number | null {
  const ts = toNumber(msg.messageTimestamp);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

const epochNow = () => Math.floor(Date.now() / 1000);

// ── Mensajes que esperan algo antes de guardarse ────────────
// Mensajes de anuncios "clic a WhatsApp" que llegan sin contenido a este
// dispositivo: Baileys pide el contenido real al teléfono y, si responde,
// lo entrega con el MISMO id unos segundos después. Se espera antes de
// guardar el aviso "no disponible" para no tapar el mensaje real. El aviso
// queda anotado en el diario desde que llega: un reinicio no lo pierde.
const PLACEHOLDER_WAIT_MS = 15_000;
const UNAVAILABLE_TEXT = "[Mensaje no disponible en este dispositivo: ábrelo en el teléfono]";
// Mensaje que no se pudo descifrar: Baileys pide que se lo reenvíen y suele
// llegar en segundos; si el reenvío no llega (el teléfono del remitente sin
// conexión), queda el aviso en el hilo en vez de perderse en silencio.
const DECRYPT_RETRY_WAIT_MS = 60_000;
// Lo mismo con un mensaje del equipo (teléfono del negocio / WhatsApp Web):
// mientras no se pueda leer, el bot no le responde a ese contacto (puede ser
// un asesor contestando); si no llega, cuenta como un asesor (o como la
// bienvenida automática, si salió pegada al primer mensaje del cliente).
const STAFF_STUB_WAIT_MS = 60_000;
const STAFF_UNREADABLE_TEXT = "[Mensaje enviado desde el WhatsApp del negocio que no se pudo leer en este dispositivo]";
// Marcas de contenido que no se pudo ver: todos esos mensajes tienen el
// mismo texto, así que nunca se aprenden como texto automático.
const isMarkerText = (text: string): boolean => text === STAFF_UNREADABLE_TEXT || text === VIEW_ONCE_TEXT;

interface PendingPlaceholder {
  timer: NodeJS.Timeout;
  // Guarda el aviso "no disponible" ya (vence la espera o se apaga el bot).
  fire: () => void;
  journalId: string | null;
}
const pendingPlaceholders = new Map<string, PendingPlaceholder>();

// Contacto @lid cuyo número aún no se conoce: el mapa LID→número suele
// llegar al rato (WhatsApp lo informa aparte). Se reintenta antes de darlo
// por perdido — sin número no hay a qué lead asociarlo sin riesgo.
const LID_RETRY_DELAYS_MS = [5_000, 30_000, 120_000];
const pendingLidRetries = new Map<string, { timer: NodeJS.Timeout; run: () => void }>();

function isUnavailableStub(msg: WAMessage): boolean {
  return (
    !msg.message &&
    msg.messageStubType === WAMessageStubType.CIPHERTEXT &&
    msg.messageStubParameters?.[0] === NO_MESSAGE_FOUND_ERROR_TEXT
  );
}

// Apagado: los avisos "no disponible" pendientes se guardan ya y los @lid
// sin número hacen su último intento (lo que no se resuelva queda en el log).
// Ya se hizo la resolución final del apagado: lo que siga sin número se
// descarta (con rastro en el log) en vez de esperar otro reintento.
let deferredFlushed = false;

export function flushDeferredInbound(): void {
  deferredFlushed = true;
  for (const p of [...pendingPlaceholders.values()]) p.fire();
  for (const p of [...pendingStaffStubs.values()]) p.fire();
  for (const [key, r] of [...pendingLidRetries]) {
    clearTimeout(r.timer);
    pendingLidRetries.delete(key);
    r.run();
  }
}

// ── Registro ────────────────────────────────────────────────

export function registerMessageHandler(sock: WASocket, session: BaileysSession): void {
  const { accountId } = session;
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    // 'notify' = recibido en vivo; 'append' = lo que llegó mientras el socket
    // estaba caído o reconectando (WhatsApp ya lo dio por entregado y no lo
    // re-envía) y los ecos de lo que envía esta misma cuenta.
    if (type !== "notify" && type !== "append") return;
    for (const msg of messages) {
      // Cola de entrada POR CUENTA: la identidad se resuelve en orden de
      // llegada (puede requerir una consulta async) y cada mensaje se encola
      // en la cola de su contacto en ese mismo orden. Contactos distintos se
      // guardan y responden en paralelo; los del mismo contacto, en orden.
      void enqueueForContact(`intake:${accountId}`, () => intake(sock, session, msg)).catch((err) =>
        console.error("[bot] Error procesando mensaje entrante:", err)
      );
    }
  });
}

// Un mensaje que Baileys reconoce pero no emite (p.ej. el aviso de "una sola
// vista" a dispositivos vinculados): client.ts lo arma desde el nodo y entra
// por la MISMA cola de entrada que el resto.
export function intakeUnemitted(sock: WASocket, session: BaileysSession, msg: WAMessage): void {
  void enqueueForContact(`intake:${session.accountId}`, () => intake(sock, session, msg)).catch((err) =>
    console.error("[bot] Error procesando mensaje entrante:", err)
  );
}

async function intake(sock: WASocket, session: BaileysSession, msg: WAMessage): Promise<void> {
  const { accountId } = session;
  const jid = msg.key.remoteJid;
  const id = msg.key.id;
  if (!jid || !id) return;

  // Solo chats 1:1 (número clásico o @lid). Grupos, difusiones, estados y
  // canales quedan fuera.
  if (!isPnJid(jid) && !isLidJid(jid)) return;
  const accountPhone = socketPhone(sock) ?? session.knownPhone();

  if (msg.key.fromMe) {
    // Eco de lo que envió esta misma cuenta (respuesta del bot, outbox).
    if (session.isOwnMessage(id)) return;
    await intakeStaffMessage(lookupWith(sock), session, msg, jid);
    return;
  }

  // Llegó el contenido real de un mensaje "no disponible": se cancela el
  // aviso pendiente y se procesa normal.
  const placeholderKey = `${accountId}:${id}`;
  const pendingPlaceholder = pendingPlaceholders.get(placeholderKey);
  if (pendingPlaceholder && msg.message) {
    clearTimeout(pendingPlaceholder.timer);
    pendingPlaceholders.delete(placeholderKey);
    journalDone(pendingPlaceholder.journalId);
  }

  const text = extractContent(msg);
  if (!text) {
    if (isUnavailableStub(msg)) {
      if (!pendingPlaceholders.has(placeholderKey)) {
        await holdPlaceholder(sock, session, msg, jid, id, placeholderKey, accountPhone);
      }
      return;
    }
    // Falla al descifrar: Baileys pidió que se lo reenvíen y el contenido
    // llegará más tarde con el MISMO id. Ya cuenta como mensaje del cliente
    // (la bienvenida automática que llegue mientras tanto se reconoce) y, si
    // el reenvío no llega, queda el aviso "no disponible".
    if (!msg.message && msg.messageStubType === WAMessageStubType.CIPHERTEXT) {
      if (!pendingPlaceholders.has(placeholderKey)) {
        await holdPlaceholder(sock, session, msg, jid, id, placeholderKey, accountPhone, DECRYPT_RETRY_WAIT_MS);
      }
      return;
    }
    // Se loguea el tipo de contenido para poder diagnosticar sin adivinar.
    const kinds = Object.keys(msg.message ?? {}).join(", ") || "(vacío)";
    console.log(`[bot] Mensaje sin contenido para responder ignorado de ${jid} — contenido: ${kinds}`);
    return;
  }
  await intakeResolved(lookupWith(sock), session, msg, jid, clampText(text), id, accountPhone, 0);
}

function buildInbound(
  session: BaileysSession,
  msg: WAMessage,
  phone: string,
  text: string,
  dedupeKey: string
): InboundMessage {
  return {
    // El lead nace en la organización dueña de la cuenta que lo recibió.
    orgId: session.orgId,
    channel: "whatsapp",
    externalId: phone,
    phone,
    name: msg.pushName ?? null,
    text,
    dedupeKey,
    sentAt: sentAtOf(msg),
    waAccountId: session.accountId,
  };
}

async function holdPlaceholder(
  sock: WASocket,
  session: BaileysSession,
  msg: WAMessage,
  jid: string,
  id: string,
  key: string,
  accountPhone: string | null,
  waitMs = PLACEHOLDER_WAIT_MS
): Promise<void> {
  const { accountId, orgId } = session;
  const phone = await resolvePhone(lookupWith(sock), msg, jid);
  let entry: SpoolEntry | null = null;
  if (phone && !isInternalPhone(phone, orgId)) {
    // Con id PROPIO: si el contenido real llega aún más tarde (con el id del
    // mensaje), se guarda y se responde como mensaje nuevo en vez de
    // descartarse como repetido.
    const inbound = buildInbound(session, msg, phone, UNAVAILABLE_TEXT, `${id}#no-disponible`);
    // Ya cuenta como mensaje del cliente: el saludo automático que el
    // teléfono del negocio manda enseguida se reconoce como automático.
    if (inbound.sentAt) rememberCustomerSentAt(orgId, phone, inbound.sentAt, inbound.dedupeKey ?? null);
    entry = { inbound, route: { waAccountId: accountId, jid, accountPhone }, spooledAt: epochNow() };
  }
  const journalId = entry ? journalInbound(entry) : null;
  const fire = (): void => {
    const pending = pendingPlaceholders.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingPlaceholders.delete(key);
    if (entry) {
      enqueuePersist(entry, journalId);
      return;
    }
    // Sin número todavía (@lid): el camino normal, con sus reintentos.
    void enqueueForContact(`intake:${accountId}`, () =>
      intakeResolved(session.pnForLid, session, msg, jid, UNAVAILABLE_TEXT, `${id}#no-disponible`, accountPhone, 0)
    ).catch((err) => console.error("[bot] Error procesando mensaje no disponible:", err));
  };
  pendingPlaceholders.set(key, { timer: setTimeout(fire, waitMs), fire, journalId });
}

async function intakeResolved(
  lookup: LidLookup,
  session: BaileysSession,
  msg: WAMessage,
  jid: string,
  text: string,
  dedupeKey: string,
  accountPhone: string | null,
  attempt: number
): Promise<void> {
  const { accountId, orgId } = session;
  const phone = await resolvePhone(lookup, msg, jid);
  if (!phone) {
    const delay = LID_RETRY_DELAYS_MS[attempt];
    const retryKey = `${accountId}:${dedupeKey}`;
    if (delay === undefined || deferredFlushed) {
      console.error(
        `[bot] ⚠️ Mensaje de ${jid} sin número resoluble tras varios intentos — no se puede asociar a un lead: "${text.slice(0, 120)}"`
      );
      return;
    }
    console.warn(`[bot] Mensaje de ${jid} sin número conocido aún; se reintenta en ${delay / 1000}s`);
    // Por la sesión VIVA: el socket que lo recibió puede haber muerto.
    const run = (): void => {
      pendingLidRetries.delete(retryKey);
      void enqueueForContact(`intake:${accountId}`, () =>
        intakeResolved(session.pnForLid, session, msg, jid, text, dedupeKey, accountPhone, deferredFlushed ? LID_RETRY_DELAYS_MS.length : attempt + 1)
      ).catch((err) => console.error("[bot] Error procesando mensaje entrante:", err));
    };
    const timer = setTimeout(run, delay);
    timer.unref?.();
    pendingLidRetries.set(retryKey, { timer, run });
    return;
  }

  // CRÍTICO con varias cuentas: los mensajes de números internos (otras
  // cuentas propias y teléfonos de avisos del equipo) NO son leads. Sin este
  // guard, la sesión B respondería con IA al aviso "se te asignó el lead X"
  // de la cuenta A (loop bot↔bot).
  if (isInternalPhone(phone, orgId)) {
    console.log(`[bot] Mensaje de un número interno (${phone}) ignorado (org ${orgId})`);
    return;
  }

  const inbound = buildInbound(session, msg, phone, text, dedupeKey);
  // La respuesta sale por la MISMA cuenta y el MISMO jid (funciona para
  // @lid), y solo si la cuenta sigue en el número al que el cliente escribió.
  const route: ReplyRoute = { waAccountId: accountId, jid, accountPhone };
  if (inbound.sentAt) rememberCustomerSentAt(orgId, phone, inbound.sentAt, inbound.dedupeKey ?? null);

  // Anotado en disco ANTES de guardarlo: si el bot se cierra a la fuerza
  // mientras tanto, se recupera al arrancar.
  const entry: SpoolEntry = { inbound, route, spooledAt: epochNow() };
  enqueuePersist(entry, journalInbound(entry));
}

// En la cola de SU contacto (no se espera: la cola de entrada sigue con el
// próximo mensaje mientras este se guarda, en orden).
function enqueuePersist(entry: SpoolEntry, journalId: string | null, onSettled?: () => void): void {
  const { inbound } = entry;
  void enqueueForContact(contactKey(inbound.orgId, inbound.channel, inbound.externalId), () => persistEntry(entry))
    .then((done) => {
      if (done) journalDone(journalId);
    })
    .catch((err) => console.error(`[bot] Error guardando el mensaje de ${inbound.externalId}:`, err))
    .finally(() => onSettled?.());
}

// ── Guardado, con respaldo en disco ─────────────────────────
// Reintentos largos (WhatsApp no re-envía). Si la base sigue caída tras
// ~1 min, el mensaje va al respaldo en disco y el bot lo re-intenta: no se
// pierde. (La reposición desde el respaldo usa spoolOnFailure=false: el
// respaldo ya lo conserva.)
// Contactos con mensajes en el respaldo: sus mensajes siguientes también van
// al respaldo (no directo a la base), para que el historial quede en el
// orden en que llegaron; y el bot no le responde a ese contacto hasta que
// todo lo suyo esté guardado (entre lo respaldado puede estar la respuesta
// de un asesor).
const spooledContacts = new Map<string, number>();
// Respuestas a programar cuando el contacto termine de reponerse.
const deferredPasses = new Map<string, { conversationId: number; route: ReplyRoute | null }[]>();

const LONG_RETRY = { attempts: 7, baseDelayMs: 1000, maxDelayMs: 30_000 };

// Apagado en curso: un solo intento contra la base y, si falla, directo al
// respaldo en disco (no hay tiempo para los reintentos largos).
let stopping = false;
export function beginInboundShutdown(): void {
  stopping = true;
}

// ¿Ese contacto tiene mensajes esperando en el respaldo?
export function hasSpooledInbound(orgId: number, channel: InboundMessage["channel"], externalId: string): boolean {
  return (spooledContacts.get(contactKey(orgId, channel, externalId)) ?? 0) > 0;
}

// ¿Ese contacto tiene mensajes recibidos que aún no están en el hilo (en el
// respaldo en disco, o uno del equipo que todavía no se pudo leer)? Entre
// ellos puede estar la respuesta de un asesor: mientras tanto no se le
// responde (ni en vivo ni desde la cola).
export function hasUnsavedInbound(orgId: number, channel: InboundMessage["channel"], externalId: string): boolean {
  const key = contactKey(orgId, channel, externalId);
  return (spooledContacts.get(key) ?? 0) > 0 || (staffGates.get(key) ?? 0) > 0;
}

// Al arrancar (antes de abrir las sesiones): qué contactos tienen mensajes
// esperando en el respaldo. Devuelve cuántos mensajes hay.
export function restoreSpooledContacts(): number {
  spooledContacts.clear();
  let n = 0;
  for (const entry of listSpooled()) {
    const key = contactKey(entry.inbound.orgId, entry.inbound.channel, entry.inbound.externalId);
    spooledContacts.set(key, (spooledContacts.get(key) ?? 0) + 1);
    rememberSpooledCustomer(entry);
    n++;
  }
  return n;
}

// Un mensaje del cliente que el proceso anterior recibió y no alcanzó a
// guardar: la bienvenida automática que llegue a ESTE proceso debe seguir
// reconociéndose como tal (si no, se la toma por un asesor).
function rememberSpooledCustomer(entry: SpoolEntry): void {
  const { inbound } = entry;
  if (entry.staff || !inbound.sentAt) return;
  rememberCustomerSentAt(inbound.orgId, inbound.externalId, inbound.sentAt, inbound.dedupeKey ?? null);
}

// Una entrada del respaldo menos para el contacto (guardada o descartada).
// Cuando no le queda ninguna, se programan sus respuestas.
export function releaseSpooledContact(inbound: InboundMessage): void {
  const key = contactKey(inbound.orgId, inbound.channel, inbound.externalId);
  const left = (spooledContacts.get(key) ?? 1) - 1;
  if (left > 0) {
    spooledContacts.set(key, left);
    return;
  }
  spooledContacts.delete(key);
  const passes = deferredPasses.get(key);
  deferredPasses.delete(key);
  for (const p of passes ?? []) {
    scheduleReplyPass(p.conversationId, { route: p.route ?? undefined });
  }
}

function spool(entry: SpoolEntry): void {
  spoolInbound({ ...entry, spooledAt: epochNow() });
  const key = contactKey(entry.inbound.orgId, entry.inbound.channel, entry.inbound.externalId);
  spooledContacts.set(key, (spooledContacts.get(key) ?? 0) + 1);
}

// Guarda un mensaje (del cliente o de un asesor). true = quedó guardado o
// respaldado (o se descartó a propósito); false = sigue pendiente.
export async function persistEntry(entry: SpoolEntry, opts: { spoolOnFailure?: boolean } = {}): Promise<boolean> {
  const spoolOnFailure = opts.spoolOnFailure ?? true;
  const { inbound } = entry;
  const key = contactKey(inbound.orgId, inbound.channel, inbound.externalId);
  if (spoolOnFailure && (spooledContacts.get(key) ?? 0) > 0) {
    try {
      spool(entry);
      return true;
    } catch (spoolErr) {
      console.error(`[bot] ❌ No se pudo respaldar en disco el mensaje de ${inbound.externalId}:`, spoolErr);
    }
  }
  const retry = !spoolOnFailure ? { attempts: 2 } : stopping ? { attempts: 1 } : LONG_RETRY;
  try {
    if (entry.staff) {
      await recordStaffMessage(entry, retry, !spoolOnFailure);
    } else {
      const persisted = await persistInbound(inbound, retry);
      if (persisted) {
        const pass = { conversationId: persisted.conversationId, route: entry.route };
        if (spoolOnFailure) {
          scheduleReplyPass(pass.conversationId, { route: pass.route ?? undefined });
        } else {
          // Reposición: la respuesta espera a que TODO lo de este contacto
          // esté guardado (releaseSpooledContact la programa).
          const list = deferredPasses.get(key) ?? [];
          list.push(pass);
          deferredPasses.set(key, list);
        }
      }
    }
    // Reposición desde el respaldo: un mensaje menos de este contacto en disco.
    if (!spoolOnFailure) releaseSpooledContact(inbound);
    return true;
  } catch (err) {
    if (!spoolOnFailure) {
      if (isTransientDbError(err)) return false; // sigue en el respaldo
      // Error de datos (no de red): reintentar no lo arregla y bloquearía al
      // contacto; se descarta con rastro en el log.
      console.error(`[bot] ⚠️ Mensaje respaldado de ${inbound.externalId} imposible de guardar; se descarta:`, err);
      releaseSpooledContact(inbound);
      return true;
    }
    console.error(
      `[bot] ⚠️ No se pudo guardar el mensaje de ${inbound.externalId}; queda respaldado en disco:`,
      err instanceof Error ? err.message : err
    );
    try {
      spool(entry);
      return true;
    } catch (spoolErr) {
      console.error(`[bot] ❌ Tampoco se pudo respaldar en disco el mensaje de ${inbound.externalId}:`, spoolErr);
      return false;
    }
  }
}

// Compatibilidad: guardar un mensaje de cliente (pruebas y llamadores viejos).
export function persistAndSchedule(
  inbound: InboundMessage,
  route: ReplyRoute | null,
  opts: { spoolOnFailure?: boolean } = {}
): Promise<boolean> {
  return persistEntry({ inbound, route, spooledAt: epochNow() }, opts);
}

// Reposición de lo respaldado en disco (la llama el bot cada pocos
// segundos). Antes, recupera diarios de arranques anteriores que no se
// pudieron recuperar al arrancar. Se intenta SIEMPRE guardar: el motor no
// responde solo lo de más de 24 h, pero el operador sí debe verlo; solo se
// descarta tras 7 días sin poder guardarlo.
const SPOOL_GIVE_UP_S = 7 * 24 * 3600;

export async function replayInboundSpool(): Promise<number> {
  if (hasJournalToRecover()) {
    try {
      const recovered = recoverJournal();
      for (const entry of recovered) {
        const key = contactKey(entry.inbound.orgId, entry.inbound.channel, entry.inbound.externalId);
        spooledContacts.set(key, (spooledContacts.get(key) ?? 0) + 1);
        rememberSpooledCustomer(entry);
      }
      if (recovered.length > 0) {
        console.log(`[bot] ${recovered.length} mensaje(s) recibido(s) antes del último cierre se recuperaron del diario en disco`);
      }
    } catch (err) {
      console.error("[bot] ⚠️ No se pudo recuperar el diario de mensajes en disco (se reintenta):", err);
    }
  }
  return replaySpool(async (entry) => {
    if (await persistEntry(entry, { spoolOnFailure: false })) return true;
    if (epochNow() - entry.spooledAt > SPOOL_GIVE_UP_S) {
      console.error(
        `[bot] ⚠️ Mensaje respaldado de ${entry.inbound.externalId} sin poder guardarse en 7 días; se descarta:`,
        entry.inbound.text.slice(0, 80)
      );
      releaseSpooledContact(entry.inbound);
      return true;
    }
    return false;
  });
}

// ── Mensajes del equipo desde el teléfono del negocio ─────────
// Lo que un asesor escribe desde el teléfono o WhatsApp Web llega como
// fromMe con un id que esta cuenta no generó. Se registra en el hilo (la IA
// y el dashboard lo ven) y la conversación pasa a modo HUMANO: el bot no
// sigue contestando encima del asesor. Pasa por el diario y el respaldo en
// disco igual que los mensajes de clientes.
// Excepción: los mensajes automáticos de WhatsApp Business (bienvenida /
// ausencia). WhatsApp manda la bienvenida 1-3 s después del mensaje que
// ABRE una conversación (lead nuevo o 14+ días sin hablar). Se registran
// como AUTOMÁTICOS ('auto:'): no pausan la IA ni cuentan como la respuesta
// de una persona. Un texto ya visto como automático en la organización se
// reconoce aunque llegue en medio de una conversación (hasta 10 s después).
// Todo lo demás lo escribió una persona.
const AUTO_OPENING_WINDOW_S = 3;
const AUTO_LEARNED_WINDOW_S = 10;
const AUTO_IDLE_S = 14 * 86400;

// Últimos mensajes de cada cliente (hora según WhatsApp e id en el canal),
// en el orden en que pasaron por la cola de entrada. Se compara con la hora
// del canal y no con la de llegada a la base: en el backlog de una
// reconexión el saludo automático llega junto al mensaje que lo disparó.
const recentCustomer = new Map<string, { sentAt: number; key: string | null }[]>();

function rememberCustomerSentAt(orgId: number, phone: string, sentAt: number, key: string | null): void {
  const mapKey = `${orgId}:${phone}`;
  const list = recentCustomer.get(mapKey) ?? [];
  recentCustomer.delete(mapKey);
  list.push({ sentAt, key });
  if (list.length > 20) list.shift();
  recentCustomer.set(mapKey, list);
  if (recentCustomer.size > 5000) {
    const oldest = recentCustomer.keys().next().value;
    if (oldest) recentCustomer.delete(oldest);
  }
}

// Último mensaje del cliente escrito ANTES de `at` (según WhatsApp).
function lastCustomerBefore(orgId: number, phone: string, at: number): { sentAt: number; key: string | null } | null {
  let best: { sentAt: number; key: string | null } | null = null;
  for (const c of recentCustomer.get(`${orgId}:${phone}`) ?? []) {
    if (c.sentAt <= at && (best === null || c.sentAt >= best.sentAt)) best = c;
  }
  return best;
}

// Textos automáticos ya vistos por organización. Sobreviven a los reinicios:
// se cargan de la base (con la migración quedan guardados como 'auto:') y
// de auth/auto-texts.json (sin ella no se guardan en la base).
const autoTexts = new Map<number, { texts: Set<string>; loaded: boolean }>();
const normalizeAuto = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
let diskAutoTexts: Record<string, string[]> | null = null;

async function knownAutoTexts(orgId: number): Promise<Set<string>> {
  let known = autoTexts.get(orgId);
  if (!known) {
    known = { texts: new Set(), loaded: false };
    autoTexts.set(orgId, known);
    diskAutoTexts ??= loadAutoTexts();
    for (const text of diskAutoTexts[String(orgId)] ?? []) {
      if (!isMarkerText(text)) known.texts.add(normalizeAuto(text));
    }
  }
  if (!known.loaded) {
    try {
      for (const text of await recentAutomatedTexts(orgId)) {
        if (!isMarkerText(text)) known.texts.add(normalizeAuto(text));
      }
      known.loaded = true;
    } catch {
      /* se intenta de nuevo en el próximo mensaje del equipo */
    }
  }
  return known.texts;
}

function learnAutoText(orgId: number, text: string): void {
  if (isMarkerText(text)) return;
  const known = autoTexts.get(orgId);
  const norm = normalizeAuto(text);
  if (!known || known.texts.has(norm)) return;
  known.texts.add(norm);
  if (known.texts.size > 50) {
    const oldest = known.texts.values().next().value;
    if (oldest) known.texts.delete(oldest);
  }
  const byOrg: Record<string, string[]> = { ...(diskAutoTexts ?? {}) };
  for (const [id, k] of autoTexts) byOrg[String(id)] = [...k.texts];
  diskAutoTexts = byOrg;
  try {
    saveAutoTexts(byOrg);
  } catch (err) {
    console.warn("[bot] No se pudieron guardar en disco los textos automáticos aprendidos:", err);
  }
}

// Mensajes del equipo que no se pudieron descifrar, a la espera del reenvío
// (por cuenta + id), y cuántos tiene pendientes cada contacto.
interface PendingStaffStub {
  timer: NodeJS.Timeout;
  fire: () => void;
  journalId: string | null;
  gateKey: string;
  phone: string;
}
const pendingStaffStubs = new Map<string, PendingStaffStub>();
const staffGates = new Map<string, number>();

function closeStaffGate(gateKey: string, orgId: number, phone: string): void {
  const left = (staffGates.get(gateKey) ?? 1) - 1;
  if (left > 0) {
    staffGates.set(gateKey, left);
    return;
  }
  staffGates.delete(gateKey);
  // Lo que el motor dejó sin responder mientras tanto.
  void withDbRetry(() => findConversation(orgId, "whatsapp", phone), { label: "conversación del contacto" })
    .then((conv) => {
      if (conv) scheduleReplyPass(conv.id);
    })
    .catch(() => undefined); // el barrido lo retoma
}

async function intakeStaffMessage(lookup: LidLookup, session: BaileysSession, msg: WAMessage, jid: string): Promise<void> {
  const { accountId, orgId } = session;
  const content = extractContent(msg);
  const unreadable = !content && !msg.message && msg.messageStubType === WAMessageStubType.CIPHERTEXT;
  const stubKey = `${accountId}:${msg.key.id}`;
  const pendingStub = pendingStaffStubs.get(stubKey);
  if (unreadable && pendingStub) return; // ya se espera su reenvío
  if (pendingStub) {
    // Llegó el reenvío que se pudo leer: se guarda normal y la espera termina
    // cuando quede guardado. Si no trae nada que guardar (una reacción, una
    // edición, un borrado...), termina ya: no era un asesor contestando.
    clearTimeout(pendingStub.timer);
    pendingStaffStubs.delete(stubKey);
    journalDone(pendingStub.journalId);
    if (!content) {
      closeStaffGate(pendingStub.gateKey, orgId, pendingStub.phone);
      return;
    }
  }
  if (!content && !unreadable) return;
  const text = clampText(content ?? STAFF_UNREADABLE_TEXT);
  const phone = await resolvePhone(lookup, msg, jid);
  if (!phone || isInternalPhone(phone, orgId)) {
    if (pendingStub) closeStaffGate(pendingStub.gateKey, orgId, pendingStub.phone);
    return;
  }
  const sentAt = sentAtOf(msg);
  // Se calcula AQUÍ, en la cola de entrada (orden de llegada): más adelante,
  // en la cola del contacto, ya pueden haberse anotado mensajes posteriores
  // del cliente.
  const customer = sentAt !== null ? lastCustomerBefore(orgId, phone, sentAt) : null;
  const entry: SpoolEntry = {
    inbound: {
      orgId,
      channel: "whatsapp",
      externalId: phone,
      phone,
      name: null,
      text,
      dedupeKey: msg.key.id ?? null,
      sentAt,
      waAccountId: accountId,
    },
    route: null,
    spooledAt: epochNow(),
    staff: { customerBefore: customer?.sentAt ?? null, customerKey: customer?.key ?? null },
  };
  if (unreadable) {
    // Con id propio: si el contenido llega más tarde, se guarda aparte.
    entry.inbound.dedupeKey = `${msg.key.id}#no-disponible`;
    const gateKey = contactKey(orgId, "whatsapp", phone);
    staffGates.set(gateKey, (staffGates.get(gateKey) ?? 0) + 1);
    const journalId = journalInbound(entry);
    const fire = (): void => {
      const pending = pendingStaffStubs.get(stubKey);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingStaffStubs.delete(stubKey);
      enqueuePersist(entry, journalId, () => closeStaffGate(gateKey, orgId, phone));
    };
    pendingStaffStubs.set(stubKey, { timer: setTimeout(fire, STAFF_STUB_WAIT_MS), fire, journalId, gateKey, phone });
    console.warn(`[bot] Mensaje del equipo a ${phone} que no se pudo leer todavía: se espera el reenvío antes de responderle`);
    return;
  }
  enqueuePersist(
    entry,
    journalInbound(entry),
    pendingStub ? () => closeStaffGate(pendingStub.gateKey, orgId, pendingStub.phone) : undefined
  );
}

async function recordStaffMessage(
  entry: SpoolEntry,
  retry: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number },
  // Repuesto desde el disco (respaldo o diario): el intento en vivo no
  // terminó, así que una fila que ya existe puede ser SU insert, y su pausa
  // de la IA nunca corrió.
  fromDisk = false
): Promise<void> {
  const { inbound } = entry;
  const { orgId, externalId: phone, text } = inbound;
  const sentAt = inbound.sentAt ?? null;
  let customerBefore = entry.staff?.customerBefore ?? null;
  let customerKey = entry.staff?.customerKey ?? null;
  let conv = await withDbRetry(() => findConversation(orgId, "whatsapp", phone), retry);
  // Sin memoria del mensaje del cliente (p.ej. el bot se reinició entre ese
  // mensaje y este): el último del cliente anterior a este, según la base.
  if (conv && customerBefore === null && sentAt !== null) {
    const convId = conv.id;
    for (const m of await withDbRetry(() => getRecentHistory(convId, 20), retry)) {
      const at = m.sent_at ?? m.created_at;
      if (m.role === "user" && at <= sentAt && (customerBefore === null || at >= customerBefore)) {
        customerBefore = at;
        customerKey = m.channel_msg_id ?? null;
      }
    }
  }
  const delta = sentAt !== null && customerBefore !== null ? sentAt - customerBefore : null;
  const learned = !isMarkerText(text) && (await knownAutoTexts(orgId)).has(normalizeAuto(text));
  // ¿Puede ser automático? Pegado a un mensaje del cliente.
  const candidate =
    delta !== null && delta >= 0 && (delta <= AUTO_OPENING_WINDOW_S || (learned && delta < AUTO_LEARNED_WINDOW_S));

  if (!conv) {
    // Sin conversación: un asesor INICIÓ el chat desde el teléfono del
    // negocio y el lead nace en modo HUMANO (si no, cuando el contacto
    // respondiera, la IA le contestaría en medio de la conversación del
    // asesor). Salvo que sea el saludo automático al primer mensaje de un
    // lead que aún no se guardó (p.ej. un anuncio cuyo contenido tarda).
    conv = await withDbRetry(
      () => getOrCreateConversation(orgId, "whatsapp", phone, { phone, ...(candidate ? {} : { mode: "HUMAN" as const }) }),
      { ...retry, label: "crear la conversación del mensaje del asesor" }
    );
  }
  const conversation = conv;
  // Una pausa de la IA aún sin confirmar en la base ya cuenta como HUMANO.
  const mode = hasPendingHandoff(conversation.id) ? "HUMAN" : conversation.mode;
  let automated = false;
  if (mode === "AI" && candidate) {
    // ¿Ese mensaje del cliente abrió la conversación? (sin nada del negocio
    // en los 14 días previos a él, como cuenta WhatsApp para su bienvenida)
    automated =
      learned ||
      !(await withDbRetry(() => hasBusinessReplyBefore(conversation.id, customerKey, AUTO_IDLE_S, customerBefore), retry));
  }
  const channelMsgId = inbound.dedupeKey ? (automated ? `auto:${inbound.dedupeKey}` : inbound.dedupeKey) : null;
  // Desde el disco y sin la migración (guardar no deduplica): si el intento
  // anterior ya lo había guardado, no se guarda otra copia y cuenta como
  // "ya estaba" (ver la derivación más abajo).
  let earlier: Message | null = null;
  if (fromDisk && !automated && !(await withDbRetry(() => messagesKeepChannelIds(), retry))) {
    const since = Math.min(sentAt ?? entry.spooledAt, entry.spooledAt) - 120;
    earlier = await withDbRetry(() => findMessageSince(conversation.id, "human", text, since), retry);
  }
  let attempts = 0;
  const { inserted, message } = earlier
    ? { inserted: false, message: earlier }
    : await withDbRetry(
        () => {
          attempts++;
          return insertMessageIdempotent(conversation.id, "human", text, { channelMsgId });
        },
        { ...retry, label: "guardar mensaje del asesor" }
      );
  // Automático: no pausa la IA. Su texto se aprende aunque ya estuviera (sin
  // la migración ni siquiera se guarda en la base).
  if (automated) {
    learnAutoText(orgId, text);
    console.log(
      `[bot] Mensaje automático del teléfono del negocio a ${phone}: no pausa la IA (salió ${delta}s después del cliente)`
    );
    return;
  }
  // "Ya estaba" en el PRIMER intento = re-entrega de algo ya procesado; en
  // un reintento = lo guardó nuestro intento anterior (respuesta perdida en
  // un corte) y hay que seguir: si no, la IA no se pausaría.
  if (!inserted && attempts === 1 && !fromDisk) return;
  // Desde el disco, ya guardado: si la pausa de entonces SÍ se aplicó (hay
  // una derivación registrada desde ese mensaje), no se repite — un operador
  // pudo haber devuelto la conversación a la IA después.
  if (
    !inserted &&
    fromDisk &&
    message &&
    mode === "AI" &&
    (await withDbRetry(() => hasLeadEventSince(conversation.id, "handoff", message.created_at), retry))
  ) {
    return;
  }
  console.log(`[bot] ✍️ Un asesor escribió a ${phone} desde el teléfono del negocio (conversación ${conversation.id})`);
  if (mode === "AI") {
    await pauseAiForHuman(
      conversation.id,
      "Un asesor respondió desde el WhatsApp del negocio (teléfono o WhatsApp Web): la IA se pausó en esta conversación."
    );
  }
}
