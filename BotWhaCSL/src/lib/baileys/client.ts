// Multi-sesión de Baileys: una sesión por cuenta de la tabla wa_accounts.
// Cada sesión conserva el endurecimiento del ciclo de vida del diseño
// original (contador de generación, timers visibles, guard de sockets
// obsoletos), pero con el estado encapsulado por cuenta en vez de a nivel
// de módulo.
import makeWASocket, {
  type BinaryNode,
  Browsers,
  DisconnectReason,
  WAMessageStatus,
  decodeMessageNode,
  fetchLatestBaileysVersion,
  getBinaryNodeChild,
  generateMessageIDV2,
  isLidUser,
  jidNormalizedUser,
  useMultiFileAuthState,
  type proto,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { Boom } from "@hapi/boom";
import pino from "pino";
import path from "node:path";
import fs from "node:fs";
import { updateWaAccount, withDbRetry } from "../db";
import { logRepeated } from "../repeated-log";
import { intakeUnemitted, registerMessageHandler } from "./handler";

// Baileys exige un logger pino; silencioso para no ensuciar la consola.
const logger = pino({ level: "silent" });

// Versión de WhatsApp Web: se consulta una vez (con timeout) y se reutiliza
// en cada reconexión. Antes cada reconexión esperaba una petición HTTPS sin
// timeout y la cuenta seguía caída mientras tanto (y lo que llegaba en ese
// lapso entraba como backlog).
const VERSION_TTL_MS = 6 * 3600_000;
let cachedVersion: { version: [number, number, number]; at: number } | null = null;

// fetchLatestBaileysVersion no lanza: ante un fallo devuelve la versión que
// trae Baileys con error/isLatest=false. Solo se cachea una consulta
// EXITOSA; si falla se usa la última buena (o la de Baileys) y se reintenta
// en la próxima reconexión.
async function getWaVersion(tag: string): Promise<[number, number, number] | undefined> {
  if (cachedVersion && Date.now() - cachedVersion.at < VERSION_TTL_MS) return cachedVersion.version;
  try {
    const fetched = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout (5s)")), 5000)),
    ]);
    if (fetched.isLatest && !fetched.error) {
      cachedVersion = { version: fetched.version, at: Date.now() };
      return fetched.version;
    }
    logRepeated("warn", "wa-version", `${tag} No se pudo confirmar la última versión de WA (se reintenta al reconectar):`, fetched.error);
    return cachedVersion?.version ?? fetched.version;
  } catch (err) {
    logRepeated(
      "warn",
      "wa-version",
      `${tag} No se pudo obtener la última versión de WA; se usa ${cachedVersion ? "la ya conocida" : "la de Baileys"}:`,
      err
    );
    return cachedVersion?.version;
  }
}

// WhatsApp rechazó la versión (405): la próxima reconexión la consulta de nuevo.
function forgetWaVersion(): void {
  cachedVersion = null;
}

// Aviso de un envío que WhatsApp RECHAZÓ después de aceptarlo el socket
// (ack con error, p.ej. 463 por falta de tctoken): sin esto la respuesta
// figuraba como enviada y el cliente nunca la recibía.
export interface DeliveryError {
  accountId: number;
  orgId: number;
  messageId: string;
  jid: string | null;
  conversationId: number | null;
  code: string;
}
let deliveryErrorHook: ((e: DeliveryError) => void) | null = null;
export function setDeliveryErrorHook(fn: (e: DeliveryError) => void): void {
  deliveryErrorHook = fn;
}

export interface SendOptions {
  // Id estable del mensaje: los reintentos reutilizan el mismo y WhatsApp
  // descarta el duplicado si el intento anterior sí había salido.
  messageId?: string;
  // Conversación del envío (para asociarle un rechazo de WhatsApp).
  conversationId?: number | null;
  // Conexión que se validó como lista (waitReady/readyEpoch): si entre la
  // validación y el envío la cuenta se reconectó, el envío NO sale (hay que
  // recibir lo pendiente de la conexión nueva y volver a validar).
  readyEpoch?: number;
}

// auth/acc-<id>: credenciales por cuenta. Se borra solo el CONTENIDO al
// desvincular (en producción auth/ puede ser un volumen montado y rmSync
// sobre el punto de montaje falla con EBUSY).
export function authDirFor(accountId: number): string {
  return path.resolve(process.cwd(), "auth", `acc-${accountId}`);
}

export interface BaileysSession {
  readonly accountId: number;
  // Organización dueña de la cuenta: sus leads nacen en su espacio y los
  // envíos jamás salen por cuentas de otra organización.
  readonly orgId: number;
  /** Arranca (con reintento cada 5s si falla el arranque en sí). */
  start(): Promise<void>;
  /** Detiene el socket e invalida arranques/reintentos en vuelo. */
  stop(opts?: { logout?: boolean }): Promise<void>;
  /** Hay socket vivo, un arranque en curso o un reintento programado. */
  isActive(): boolean;
  /** El socket está abierto (conectado a WhatsApp). */
  isOpen(): boolean;
  /**
   * Abierto Y con lo pendiente de la desconexión ya recibido: recién ahí el
   * bot puede responder (el backlog puede traer la respuesta que un asesor
   * dio desde el teléfono, o más mensajes del cliente).
   */
  isReady(): boolean;
  phone(): string | null;
  /** Último número con el que estuvo conectada (persiste tras desconectarse). */
  knownPhone(): string | null;
  /** Borra las credenciales de ESTA cuenta (contenido del dir, no el dir). */
  clearAuth(): void;
  /** Envía por el socket VIVO y listo; devuelve el id del mensaje. */
  send(jid: string, text: string, opts?: SendOptions): Promise<string>;
  /**
   * Espera (acotado) a que la cuenta esté lista (isReady); lanza si no llega.
   * Devuelve la conexión validada (pasarla a send como readyEpoch).
   */
  waitReady(timeoutMs: number): Promise<number>;
  /** Conexión lista actual (para send), o null si no está lista. */
  readyEpoch(): number | null;
  /** ¿Este mensaje lo envió esta cuenta (eco propio de Baileys)? */
  isOwnMessage(id: string): boolean;
  /** Número (jid) de un contacto @lid según el socket VIVO; null si no se sabe. */
  pnForLid(lid: string): Promise<string | null>;
}

// Memoria acotada por cuenta de lo enviado.
const OWN_IDS_MAX = 5000;
const SENT_STORE_MAX = 3000;
const SENT_STORE_TTL_MS = 24 * 3600_000;
const REPORTED_ERRORS_MAX = 1000;
// Backlog de una reconexión: WhatsApp envía primero lo que llegó con la
// cuenta caída (nodos "offline"), por lotes de 100, y al final avisa que
// terminó. Baileys procesa esos nodos de a uno (descifrar, guardar claves) y
// los va entregando: el aviso puede llegar con varios aún en cola. La cuenta
// queda lista cuando llegó el aviso y Baileys entregó TODOS los mensajes
// offline recibidos (seguidos por id); si el aviso no llega, cuando el
// backlog lleva un rato quieto; y siempre tras un tope.
const BACKLOG_QUIET_MS = 8_000;
const BACKLOG_SETTLE_MAX_MS = 5 * 60_000;
// Baileys pide solo el PRIMER lote de 100: si había más, el resto quedaba
// en el servidor hasta la próxima conexión (horas). Si el backlog queda
// quieto sin el aviso de fin, se pide el lote siguiente; se deja de pedir
// tras dos pedidos seguidos que no trajeron nada (o un tope).
const OFFLINE_BATCH_QUIET_MS = 5_000;
const OFFLINE_BATCH_MAX_REQUESTS = 50;
const OFFLINE_BATCH_MAX_EMPTY = 2;

// ¿Dos jids son el mismo contacto? Compara número con número: un @lid se
// traduce con el mapa LID→número que mantiene Baileys.
async function sameContact(sock: WASocket, a: string | null | undefined, b: string): Promise<boolean> {
  const na = a ? jidNormalizedUser(a) : "";
  const nb = jidNormalizedUser(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const toPn = async (jid: string): Promise<string | null> => {
    if (!isLidUser(jid)) return jid;
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
      return pn ? jidNormalizedUser(pn) : null;
    } catch {
      return null;
    }
  };
  const [pa, pb] = await Promise.all([toPn(na), toPn(nb)]);
  return !!pa && pa === pb;
}

function createSession(accountId: number, orgId: number): BaileysSession {
  let sockRef: WASocket | null = null;
  // Mapa LID→número del último socket (en disco: sirve aunque ya se cerró).
  let lastLidStore: WASocket["signalRepository"]["lidMapping"] | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let startingCount = 0;
  let socketOpen = false;
  let connectedPhone: string | null = null;
  let lastKnownPhone: string | null = null;
  // Lo pendiente de la desconexión ya llegó (ver isReady).
  let backlogDone = false;
  let backlogWatch: NodeJS.Timeout | null = null;
  // Conexión actual (sube con cada socket nuevo) y progreso de SU backlog:
  // mensajes offline recibidos de WhatsApp que Baileys aún no entregó (por
  // id), si llegó el aviso de fin, y los pedidos de lotes siguientes.
  let connEpoch = 0;
  let offlinePending = new Set<string>();
  let offlineMarker = false;
  let offlinePreview = false;
  let lastOfflineProgress = 0;
  let backlogStartedAt = 0;
  let batchRequests = 0;
  let emptyBatches = 0;
  let framesSinceBatch = 0;
  // Avisos "de una sola vista" (ver el gancho CB:message) que llegaron
  // mientras Baileys retenía lo recibido: salen detrás de eso al soltarlo, no
  // antes que mensajes anteriores que él todavía procesa. Y los ya
  // entregados: WhatsApp re-envía el aviso si la conexión cae antes de
  // confirmarlo.
  let heldFanouts: { sock: WASocket; msg: WAMessage }[] = [];
  const seenFanouts = new Set<string>();
  // Ids de lo que ESTA cuenta envió (respuestas, outbox, avisos): Baileys los
  // re-emite como eco fromMe. Lo que llega fromMe con OTRO id lo escribió el
  // equipo desde el teléfono del negocio o WhatsApp Web.
  const ownIds = new Set<string>();
  // Lo enviado (últimas 24 h): destinatario y conversación se registran ANTES
  // de enviar (un rechazo puede llegar antes de que sendMessage resuelva) y el
  // contenido al terminar. Baileys pide el contenido para re-cifrar cuando el
  // teléfono del cliente no pudo descifrar un mensaje (si no, al cliente le
  // queda "Esperando el mensaje"). Vive en la cuenta, no en el socket:
  // sobrevive a las reconexiones.
  const sentStore = new Map<
    string,
    { message: proto.IMessage | null; at: number; conversationId: number | null; jid: string }
  >();
  // Rechazos ya avisados (pueden llegar por dos vías: ver más abajo).
  const reportedErrors = new Set<string>();

  function rememberOwn(id: string): void {
    ownIds.delete(id);
    ownIds.add(id);
    if (ownIds.size > OWN_IDS_MAX) {
      const oldest = ownIds.values().next().value;
      if (oldest) ownIds.delete(oldest);
    }
  }

  function registerSend(id: string, jid: string, conversationId: number | null): void {
    const now = Date.now();
    const prev = sentStore.get(id);
    sentStore.delete(id);
    sentStore.set(id, { message: prev?.message ?? null, at: now, conversationId, jid });
    for (const [key, value] of sentStore) {
      if (sentStore.size <= SENT_STORE_MAX && now - value.at < SENT_STORE_TTL_MS) break;
      sentStore.delete(key);
    }
  }

  function reportDeliveryError(id: string, remoteJid: string | null | undefined, code: string): void {
    if (reportedErrors.has(id)) return;
    reportedErrors.add(id);
    if (reportedErrors.size > REPORTED_ERRORS_MAX) {
      const oldest = reportedErrors.values().next().value;
      if (oldest) reportedErrors.delete(oldest);
    }
    const sent = sentStore.get(id);
    console.error(`${tag} ⚠️ WhatsApp rechazó el mensaje ${id} (error ${code}) para ${remoteJid ?? sent?.jid}`);
    deliveryErrorHook?.({
      accountId,
      orgId,
      messageId: id,
      jid: remoteJid ?? sent?.jid ?? null,
      conversationId: sent?.conversationId ?? null,
      code,
    });
  }

  // Solo al destinatario del mensaje (o a otro dispositivo de esta misma
  // cuenta, que lo pide con el chat del destinatario): sin este control,
  // cualquiera que conociera un id podía pedir que se le re-cifrara.
  async function getSentMessage(sock: WASocket, key: WAMessageKey): Promise<proto.IMessage | undefined> {
    const entry = key.id ? sentStore.get(key.id) : undefined;
    if (!entry?.message) return undefined;
    if (await sameContact(sock, key.remoteJid, entry.jid)) return entry.message;
    console.warn(`${tag} Pedido de reenvío del mensaje ${key.id} desde ${key.remoteJid}, que no es su destinatario: ignorado`);
    return undefined;
  }

  function clearBacklogTimers(): void {
    if (backlogWatch) clearInterval(backlogWatch);
    backlogWatch = null;
  }

  // Vigila el backlog de la conexión recién abierta: pide los lotes
  // siguientes si WhatsApp los retiene, y da la cuenta por lista cuando todo
  // lo pendiente llegó Y Baileys lo entregó (de messages.upsert pasa, en
  // orden, a la cola de entrada del handler).
  function watchBacklog(sock: WASocket): void {
    if (backlogWatch || backlogDone) return;
    backlogStartedAt = Date.now();
    lastOfflineProgress = Math.max(lastOfflineProgress, backlogStartedAt);
    backlogWatch = setInterval(() => {
      if (sockRef !== sock || !socketOpen) return;
      const now = Date.now();
      const quiet = now - lastOfflineProgress;
      // Lote siguiente: hubo vista previa del backlog, falta el aviso de fin
      // y no llega nada hace unos segundos.
      if (
        offlinePreview &&
        !offlineMarker &&
        quiet >= OFFLINE_BATCH_QUIET_MS &&
        batchRequests < OFFLINE_BATCH_MAX_REQUESTS &&
        emptyBatches < OFFLINE_BATCH_MAX_EMPTY
      ) {
        if (batchRequests > 0 && framesSinceBatch === 0) emptyBatches++;
        if (emptyBatches < OFFLINE_BATCH_MAX_EMPTY) {
          batchRequests++;
          framesSinceBatch = 0;
          lastOfflineProgress = now;
          console.log(`${tag} Pidiendo a WhatsApp el siguiente lote de mensajes pendientes (${batchRequests})`);
          sock
            .sendNode({ tag: "ib", attrs: {}, content: [{ tag: "offline_batch", attrs: { count: "100" } }] })
            .catch((err) => console.warn(`${tag} No se pudo pedir el lote siguiente:`, err));
          return;
        }
      }
      const drained = offlinePending.size === 0;
      const done = (offlineMarker && drained) || quiet >= BACKLOG_QUIET_MS || now - backlogStartedAt >= BACKLOG_SETTLE_MAX_MS;
      if (!done) return;
      // Sin el aviso de fin, Baileys retiene en su buffer inicial todo lo
      // offline que ya procesó (solo lo suelta el aviso, un mensaje en vivo o
      // su timeout de 30 s): se suelta AHORA, antes de dar la cuenta por
      // lista. Es síncrono: el handler encola esos mensajes en la cola de
      // entrada en el acto, y quien valide una respuesta los espera.
      flushEvents(sock);
      clearBacklogTimers();
      if (offlineMarker && drained) {
        console.log(`${tag} Mensajes pendientes recibidos: la cuenta ya puede responder`);
      } else {
        console.warn(
          `${tag} Backlog sin aviso de fin o incompleto (${offlinePending.size} mensaje(s) sin entregar por Baileys): la cuenta responde igual`
        );
      }
      backlogDone = true;
    }, 100);
  }

  // Al cerrarse un socket, Baileys DESTRUYE su buffer de eventos (end() →
  // ev.destroy()): lo retenido ahí — mensajes del backlog que WhatsApp ya dio
  // por entregados y no re-envía — se perdería. Se suelta antes, síncrono.
  function flushEvents(sock: WASocket): void {
    try {
      sock.ev.flush();
    } catch (err) {
      console.error(`${tag} No se pudo vaciar el buffer de eventos:`, err);
    }
    const mine = heldFanouts.filter((h) => h.sock === sock);
    if (mine.length === 0) return;
    heldFanouts = heldFanouts.filter((h) => h.sock !== sock);
    mine.sort((a, b) => Number(a.msg.messageTimestamp ?? 0) - Number(b.msg.messageTimestamp ?? 0));
    for (const h of mine) intakeUnemitted(h.sock, session, h.msg);
  }
  // Último estado escrito en la DB: evita leer la fila para decidir si el
  // evento 'connecting' puede escribirse (no degradar desde qr/connected).
  let lastStatus: "disconnected" | "qr" | "connecting" | "connected" = "disconnected";
  // Contador de generación: serializa el ciclo de vida. Cada start toma una
  // generación nueva; los starts en vuelo de generaciones viejas se abortan
  // y los handlers de sockets viejos se ignoran comparando contra sockRef.
  let generation = 0;

  const tag = `[bot][cuenta ${accountId}]`;

  // Escrituras de estado numeradas: un reintento viejo (p.ej. un QR ya
  // reemplazado) no pisa una escritura más nueva.
  let statusSeq = 0;

  async function writeStatus(patch: {
    status?: "disconnected" | "qr" | "connecting" | "connected";
    qr_string?: string | null;
    phone?: string | null;
  }): Promise<void> {
    const seq = ++statusSeq;
    // Con reintentos ante cortes de red (si no, el dashboard mostraba un QR
    // vencido hasta el siguiente). lastStatus se actualiza DESPUÉS del write:
    // si Supabase falla, el marcador local no se adelanta a lo que la DB dice.
    await withDbRetry(
      async () => {
        if (seq === statusSeq) await updateWaAccount(accountId, patch);
      },
      { attempts: 4, baseDelayMs: 500 }
    );
    if (seq === statusSeq && patch.status) lastStatus = patch.status;
  }

  function clearAuth(): void {
    const dir = authDirFor(accountId);
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }

  function scheduleReconnect(delay: number): void {
    if (stopped || reconnectTimer) return;
    console.log(`${tag} Reintentando conexión en ${Math.round(delay / 1000)}s...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped) return;
      // Cleanup del socket viejo. Anular sockRef ANTES de end(): end() emite
      // connection.update close síncrono y el handler debe ignorarlo.
      const old = sockRef;
      sockRef = null;
      socketOpen = false;
      backlogDone = false;
      clearBacklogTimers();
      if (old) {
        flushEvents(old);
        try {
          old.end(undefined);
        } catch {
          /* noop */
        }
      }
      void startWithRetry();
    }, delay);
  }

  async function startInner(gen: number): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(authDirFor(accountId));

    // CRÍTICO: WhatsApp rechaza versiones desactualizadas con code 405.
    const version = await getWaVersion(tag);

    // Un stop/start más nuevo tomó el control durante los awaits de arriba.
    if (gen !== generation || stopped) return;

    let self: WASocket | null = null;
    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      // CRÍTICO: un browser custom dispara code 440 (connectionReplaced).
      browser: Browsers.macOS("Desktop"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // Re-cifrado de lo enviado cuando su destinatario lo pide.
      getMessage: async (key) => (self ? getSentMessage(self, key) : undefined),
    });
    self = sock;

    sockRef = sock;
    lastLidStore = sock.signalRepository.lidMapping;
    socketOpen = false;
    backlogDone = false;
    clearBacklogTimers();
    connEpoch++;
    offlinePending = new Set();
    offlineMarker = false;
    offlinePreview = false;
    lastOfflineProgress = 0;
    batchRequests = 0;
    emptyBatches = 0;
    framesSinceBatch = 0;

    sock.ev.on("creds.update", saveCreds);

    // Progreso del backlog: cada nodo offline que llega de WhatsApp (los
    // mensajes, por id) y cada mensaje que Baileys ya entregó (los offline
    // salen como 'append').
    for (const kind of ["message", "receipt", "notification", "call"]) {
      sock.ws.on(`CB:${kind},offline`, (node: BinaryNode) => {
        if (sockRef !== sock) return;
        lastOfflineProgress = Date.now();
        framesSinceBatch++;
        // WhatsApp sigue entregando: solo cortan los pedidos vacíos SEGUIDOS
        // (y una respuesta tardía reactiva los pedidos).
        emptyBatches = 0;
        if (kind === "message" && node.attrs?.id) offlinePending.add(node.attrs.id);
      });
    }
    sock.ws.on("CB:ib,,offline_preview", () => {
      if (sockRef !== sock) return;
      offlinePreview = true;
      lastOfflineProgress = Date.now();
    });
    // Mensajes "de una sola vista": WhatsApp avisa a los dispositivos
    // vinculados que existen pero nunca les da el contenido. Con el aviso
    // 'view_once_unavailable_fanout' Baileys solo confirma la recepción y no
    // emite nada: se arma el mensaje desde el nodo y entra como los demás (si
    // no, el mensaje del cliente desaparecía sin rastro).
    sock.ws.on("CB:message", (node: BinaryNode) => {
      if (sockRef !== sock) return;
      const unavailable = getBinaryNodeChild(node, "unavailable");
      if (unavailable?.attrs?.type !== "view_once_unavailable_fanout" || getBinaryNodeChild(node, "enc")) return;
      const me = sock.authState.creds.me;
      if (!me?.id) return;
      try {
        const { fullMessage } = decodeMessageNode(node, me.id, me.lid ?? "");
        fullMessage.key.isViewOnce = true;
        // Como lo que Baileys emite (cleanMessage): el chat sin el dispositivo.
        const { key } = fullMessage;
        if (key.remoteJid) key.remoteJid = jidNormalizedUser(key.remoteJid) || key.remoteJid;
        if (key.participant) key.participant = jidNormalizedUser(key.participant) || key.participant;
        if (key.id && offlinePending.delete(key.id)) lastOfflineProgress = Date.now();
        if (key.id) {
          if (seenFanouts.has(key.id)) return;
          seenFanouts.add(key.id);
          if (seenFanouts.size > 1000) seenFanouts.delete(seenFanouts.values().next().value as string);
        }
        if (backlogDone) intakeUnemitted(sock, session, fullMessage);
        else heldFanouts.push({ sock, msg: fullMessage });
      } catch (err) {
        console.warn(`${tag} No se pudo leer el aviso de un mensaje de una sola vista:`, err);
      }
    });
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (sockRef !== sock || type !== "append") return;
      for (const m of messages) {
        if (m.key.id && offlinePending.delete(m.key.id)) lastOfflineProgress = Date.now();
      }
    });

    // Sin guard de socket obsoleto: también al cerrarse uno viejo (reconexión,
    // stop) hay que soltar lo que retenía.
    sock.ev.on("connection.update", ({ connection }) => {
      if (connection === "close") flushEvents(sock);
    });

    // Rechazos de WhatsApp a mensajes que el socket ya había aceptado (p.ej.
    // 463). Llegan por dos vías: como actualización suelta, o fusionados por
    // Baileys en el eco del propio envío cuando ambos coinciden en su buffer
    // (lo normal en un rechazo rápido o durante el backlog de una reconexión).
    sock.ev.on("messages.update", (updates) => {
      for (const { key, update } of updates) {
        if (update.status !== WAMessageStatus.ERROR || !key.id || !key.fromMe) continue;
        reportDeliveryError(key.id, key.remoteJid, String(update.messageStubParameters?.[0] ?? "desconocido"));
      }
    });
    sock.ev.on("messages.upsert", ({ messages }) => {
      for (const msg of messages) {
        const id = msg.key.id;
        if (!id || !msg.key.fromMe || msg.status !== WAMessageStatus.ERROR || !ownIds.has(id)) continue;
        reportDeliveryError(id, msg.key.remoteJid, String(msg.messageStubParameters?.[0] ?? "desconocido"));
      }
    });

    sock.ev.on("connection.update", async (update) => {
      // Ignorar eventos de sockets obsoletos (reinicios, logout intencional).
      if (sockRef !== sock) return;

      const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;
      // WhatsApp terminó de ENVIAR lo que llegó con la cuenta caída (Baileys
      // puede seguir procesándolo: ver watchBacklog).
      if (receivedPendingNotifications === true) {
        offlineMarker = true;
        lastOfflineProgress = Date.now();
      }
      try {
        if (qr) {
          console.log(`${tag} QR generado — escanéalo desde el dashboard (pestaña Equipo)`);
          await writeStatus({ status: "qr", qr_string: qr, phone: null });
        }

        if (connection === "connecting") {
          // Solo desde 'disconnected' (primer arranque): NO degradar desde
          // 'qr' ni desde 'connected'.
          if (lastStatus === "disconnected") {
            await writeStatus({ status: "connecting" });
          }
        }

        if (connection === "open") {
          // sock.user.id tiene formato "573001112233:7@s.whatsapp.net".
          const rawId = sock.user?.id ?? "";
          const phone = rawId.split(":")[0].split("@")[0] || null;
          socketOpen = true;
          connectedPhone = phone;
          if (phone) lastKnownPhone = phone;
          console.log(`${tag} ✅ Conectado como ${phone ?? "(desconocido)"}`);
          // Hasta recibir lo pendiente de la desconexión, no responde.
          watchBacklog(sock);
          // Si este write falla por un blip de Supabase, el tick del bot lo
          // reconcilia (ve isOpen() && status != connected y reescribe).
          await writeStatus({ status: "connected", qr_string: null, phone });
        }

        if (connection === "close") {
          socketOpen = false;
          connectedPhone = null;
          backlogDone = false;
          clearBacklogTimers();
          const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
          console.log(`${tag} Conexión cerrada (code=${code ?? "desconocido"})`);
          // 405 = WhatsApp rechazó la versión: se consulta de nuevo al reconectar.
          if (code === 405) forgetWaVersion();

          if (code === DisconnectReason.loggedOut) {
            // Sesión cerrada desde el teléfono: credenciales inválidas.
            // El reconnect se programa ANTES del write a DB para que un
            // fallo de Supabase no deje la sesión muerta sin reintento.
            console.log(`${tag} Sesión cerrada desde el teléfono. Regenerando QR...`);
            try {
              clearAuth();
            } catch (err) {
              console.error(`${tag} No se pudieron borrar las credenciales:`, err);
            }
            scheduleReconnect(3000);
            await writeStatus({ status: "disconnected", qr_string: null, phone: null });
            return;
          }

          // Cualquier otro code: NO tocar el estado en DB (si estábamos
          // 'connected', el dashboard sigue mostrando connected mientras se
          // reconecta en transparente; un QR nuevo sobreescribe el estado).
          // 440 (connectionReplaced) → backoff largo; 515 (restartRequired)
          // es la señal normal post-pairing → reconectar rápido.
          const delay = code === 440 ? 15000 : code === 515 ? 2000 : 5000;
          scheduleReconnect(delay);
        }
      } catch (err) {
        console.error(`${tag} Error en connection.update:`, err);
      }
    });

    registerMessageHandler(sock, session);
  }

  async function start(): Promise<void> {
    const gen = ++generation;
    stopped = false;
    startingCount++;
    try {
      await startInner(gen);
    } finally {
      startingCount--;
    }
  }

  // Arranque con reintento: si start lanza (fs con locks, red caída),
  // reintenta cada 5s mientras no haya un stop más nuevo. El timer es
  // visible para isActive (sin eso, el tick dispararía arranques dobles).
  async function startWithRetry(): Promise<void> {
    try {
      await start();
    } catch (err) {
      console.error(`${tag} Error al iniciar, reintento en 5s:`, err);
      if (retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!stopped) void startWithRetry();
      }, 5000);
    }
  }

  async function stop(opts?: { logout?: boolean }): Promise<void> {
    stopped = true;
    generation++;
    // Quien detiene la sesión escribe 'disconnected' en la DB por fuera de
    // writeStatus (start-bot); sin este reset, al re-habilitar la cuenta el
    // guard de 'connecting' seguiría creyendo el estado viejo y el dashboard
    // mostraría "Desconectado" durante toda la fase de conexión.
    lastStatus = "disconnected";
    // Una escritura de estado aún reintentándose (QR, conectado) ya no aplica.
    statusSeq++;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    const old = sockRef;
    // Anular ANTES de logout/end: ambos emiten close síncrono y el handler
    // debe ver este socket como obsoleto.
    sockRef = null;
    socketOpen = false;
    connectedPhone = null;
    backlogDone = false;
    clearBacklogTimers();
    if (!old) return;
    // Lo que Baileys retenía en su buffer se entrega antes de cerrar.
    flushEvents(old);
    if (opts?.logout) {
      try {
        await old.logout();
      } catch {
        /* la sesión puede estar ya muerta */
      }
    }
    try {
      old.end(undefined);
    } catch {
      /* noop */
    }
  }

  const session: BaileysSession = {
    accountId,
    orgId,
    start: startWithRetry,
    stop,
    isActive: () => sockRef !== null || startingCount > 0 || reconnectTimer !== null || retryTimer !== null,
    isOpen: () => socketOpen,
    isReady: () => socketOpen && backlogDone,
    phone: () => connectedPhone,
    knownPhone: () => lastKnownPhone,
    clearAuth,
    // Siempre por el socket VIVO de la cuenta (nunca uno capturado al
    // recibir: tras una reconexión ese socket está muerto).
    send: async (jid: string, text: string, opts: SendOptions = {}) => {
      const sock = sockRef;
      // Solo por una conexión lista y, si se indicó, la MISMA que se validó:
      // tras reconectar hay que recibir lo pendiente y volver a validar.
      if (!sock || !socketOpen || !backlogDone || (opts.readyEpoch !== undefined && opts.readyEpoch !== connEpoch)) {
        throw new Error(
          `Socket de la cuenta ${accountId} no disponible por ahora (desconectado, reconectado o recibiendo lo pendiente)`
        );
      }
      const messageId = opts.messageId ?? generateMessageIDV2(sock.user?.id);
      // ANTES de enviar: Baileys emite el eco (fromMe) antes de que
      // sendMessage resuelva — el handler debe reconocerlo como propio — y un
      // rechazo puede llegar antes también.
      rememberOwn(messageId);
      registerSend(messageId, jid, opts.conversationId ?? null);
      const sent = await sock.sendMessage(jid, { text }, { messageId });
      const entry = sentStore.get(messageId);
      if (sent?.message && entry) entry.message = sent.message;
      return messageId;
    },
    waitReady: async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (!(socketOpen && backlogDone)) {
        if (stopped || Date.now() >= deadline) {
          throw new Error(
            socketOpen
              ? `Cuenta ${accountId} no disponible por ahora (recibiendo los mensajes pendientes tras ${Math.round(timeoutMs / 1000)}s)`
              : `Socket de la cuenta ${accountId} no disponible (sin conexión tras ${Math.round(timeoutMs / 1000)}s)`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return connEpoch;
    },
    readyEpoch: () => (socketOpen && backlogDone ? connEpoch : null),
    isOwnMessage: (id: string) => ownIds.has(id),
    pnForLid: async (lid: string) => {
      // Con la sesión detenida (último intento del apagado) o reconectando,
      // el mapa del último socket: se lee de disco y sigue respondiendo.
      const store = sockRef?.signalRepository.lidMapping ?? lastLidStore;
      if (!store) return null;
      try {
        return (await store.getPNForLID(lid)) ?? null;
      } catch {
        return null;
      }
    },
  };
  return session;
}

// ── Registro de sesiones (una por cuenta) ───────────────────

const sessions = new Map<number, BaileysSession>();

export function getOrCreateSession(accountId: number, orgId: number): BaileysSession {
  let s = sessions.get(accountId);
  if (!s) {
    s = createSession(accountId, orgId);
    sessions.set(accountId, s);
  }
  return s;
}

export function getSession(accountId: number): BaileysSession | undefined {
  return sessions.get(accountId);
}

export function getAllSessions(): BaileysSession[] {
  return [...sessions.values()];
}

// El caller debe stop() antes de remover (el registro no detiene nada solo).
export function removeSession(accountId: number): void {
  sessions.delete(accountId);
}

// orgId (opcional): considerar solo las sesiones de esa organización.
export function anySessionOpen(orgId?: number): boolean {
  for (const s of sessions.values()) {
    if (orgId !== undefined && s.orgId !== orgId) continue;
    if (s.isOpen()) return true;
  }
  return false;
}

// Sesión lista (abierta y con el backlog recibido) preferida: la de la
// cuenta pedida; si no está lista (o no se pidió ninguna), la primera lista
// DE LA MISMA ORGANIZACIÓN. Null si no hay ninguna. El filtro por
// organización es de seguridad: un lead de un cliente JAMÁS debe recibir
// mensajes desde el WhatsApp de otro cliente.
export function getOpenSession(
  preferredId?: number | null,
  orgId?: number
): BaileysSession | null {
  if (preferredId != null) {
    const s = sessions.get(preferredId);
    if (s?.isReady() && (orgId === undefined || s.orgId === orgId)) return s;
  }
  for (const s of sessions.values()) {
    if (orgId !== undefined && s.orgId !== orgId) continue;
    if (s.isReady()) return s;
  }
  return null;
}

// Números de las cuentas DE UNA ORGANIZACIÓN (el último con el que cada una
// estuvo conectada, aunque ahora esté caída o apagada): el handler los usa
// para ignorar mensajes entre cuentas propias (los avisos a vendedores
// dispararían un loop de respuestas bot↔bot entre dos sesiones nuestras).
export function getConnectedPhones(orgId: number): Set<string> {
  const phones = new Set<string>();
  for (const s of sessions.values()) {
    if (s.orgId !== orgId) continue;
    const p = s.knownPhone();
    if (p) phones.add(p);
  }
  return phones;
}

// Números "internos" que NUNCA son leads, POR ORGANIZACIÓN: los de las
// cuentas de esa organización (según la DB, aunque su sesión esté cerrada)
// y los teléfonos de avisos de SU equipo. Segmentado por organización: el
// número del vendedor del cliente B puede ser un lead legítimo del cliente
// A — un set global lo descartaba. El bot lo refresca en su tick.
let internalPhonesByOrg = new Map<number, Set<string>>();

export function setInternalPhones(byOrg: Map<number, Set<string>>): void {
  internalPhonesByOrg = byOrg;
}

export function isInternalPhone(phone: string, orgId: number): boolean {
  return (
    (internalPhonesByOrg.get(orgId)?.has(phone) ?? false) ||
    getConnectedPhones(orgId).has(phone)
  );
}
