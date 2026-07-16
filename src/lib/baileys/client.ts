// Multi-sesión de Baileys: una sesión por cuenta de la tabla wa_accounts.
// Cada sesión conserva el endurecimiento del ciclo de vida del diseño
// original (contador de generación, timers visibles, guard de sockets
// obsoletos), pero con el estado encapsulado por cuenta en vez de a nivel
// de módulo.
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { Boom } from "@hapi/boom";
import pino from "pino";
import path from "node:path";
import fs from "node:fs";
import { updateWaAccount } from "../db";
import { registerMessageHandler } from "./handler";

// Baileys exige un logger pino; silencioso para no ensuciar la consola.
const logger = pino({ level: "silent" });

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
  /** El socket está realmente abierto (para enviar hay que mirar esto). */
  isOpen(): boolean;
  phone(): string | null;
  /** Borra las credenciales de ESTA cuenta (contenido del dir, no el dir). */
  clearAuth(): void;
  send(jid: string, text: string): Promise<void>;
}

function createSession(accountId: number, orgId: number): BaileysSession {
  let sockRef: WASocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let startingCount = 0;
  let socketOpen = false;
  let connectedPhone: string | null = null;
  // Último estado escrito en la DB: evita leer la fila para decidir si el
  // evento 'connecting' puede escribirse (no degradar desde qr/connected).
  let lastStatus: "disconnected" | "qr" | "connecting" | "connected" = "disconnected";
  // Contador de generación: serializa el ciclo de vida. Cada start toma una
  // generación nueva; los starts en vuelo de generaciones viejas se abortan
  // y los handlers de sockets viejos se ignoran comparando contra sockRef.
  let generation = 0;

  const tag = `[bot][cuenta ${accountId}]`;

  async function writeStatus(patch: {
    status?: "disconnected" | "qr" | "connecting" | "connected";
    qr_string?: string | null;
    phone?: string | null;
  }): Promise<void> {
    // lastStatus se actualiza DESPUÉS del write: si Supabase falla, el
    // marcador local no se adelanta a lo que la DB realmente dice.
    await updateWaAccount(accountId, patch);
    if (patch.status) lastStatus = patch.status;
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
      if (old) {
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
    let version: [number, number, number] | undefined;
    try {
      const fetched = await fetchLatestBaileysVersion();
      version = fetched.version;
    } catch (err) {
      console.warn(`${tag} No se pudo obtener la última versión de WA; se usa la de Baileys:`, err);
    }

    // Un stop/start más nuevo tomó el control durante los awaits de arriba.
    if (gen !== generation || stopped) return;

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      // CRÍTICO: un browser custom dispara code 440 (connectionReplaced).
      browser: Browsers.macOS("Desktop"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    sockRef = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      // Ignorar eventos de sockets obsoletos (reinicios, logout intencional).
      if (sockRef !== sock) return;

      const { connection, lastDisconnect, qr } = update;
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
          console.log(`${tag} ✅ Conectado como ${phone ?? "(desconocido)"}`);
          // Si este write falla por un blip de Supabase, el tick del bot lo
          // reconcilia (ve isOpen() && status != connected y reescribe).
          await writeStatus({ status: "connected", qr_string: null, phone });
        }

        if (connection === "close") {
          socketOpen = false;
          connectedPhone = null;
          const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
          console.log(`${tag} Conexión cerrada (code=${code ?? "desconocido"})`);

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

    registerMessageHandler(sock, accountId, orgId);
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
    if (!old) return;
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

  return {
    accountId,
    orgId,
    start: startWithRetry,
    stop,
    isActive: () => sockRef !== null || startingCount > 0 || reconnectTimer !== null || retryTimer !== null,
    isOpen: () => socketOpen,
    phone: () => connectedPhone,
    clearAuth,
    send: async (jid: string, text: string) => {
      const sock = sockRef;
      if (!sock || !socketOpen) throw new Error(`Socket de la cuenta ${accountId} no disponible`);
      await sock.sendMessage(jid, { text });
    },
  };
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

// Sesión abierta preferida: la de la cuenta pedida; si no está abierta (o
// no se pidió ninguna), la primera abierta DE LA MISMA ORGANIZACIÓN. Null
// si no hay ninguna. El filtro por organización es de seguridad: un lead de
// un cliente JAMÁS debe recibir mensajes desde el WhatsApp de otro cliente.
export function getOpenSession(
  preferredId?: number | null,
  orgId?: number
): BaileysSession | null {
  if (preferredId != null) {
    const s = sessions.get(preferredId);
    if (s?.isOpen() && (orgId === undefined || s.orgId === orgId)) return s;
  }
  for (const s of sessions.values()) {
    if (orgId !== undefined && s.orgId !== orgId) continue;
    if (s.isOpen()) return s;
  }
  return null;
}

// Números de las cuentas conectadas: el handler los usa para ignorar
// mensajes entre cuentas propias (los avisos a vendedores dispararían un
// loop de respuestas bot↔bot entre dos sesiones nuestras).
export function getConnectedPhones(): Set<string> {
  const phones = new Set<string>();
  for (const s of sessions.values()) {
    const p = s.phone();
    if (s.isOpen() && p) phones.add(p);
  }
  return phones;
}

// Números "internos" que NUNCA son leads: los de TODAS las cuentas (según
// la DB, aunque su sesión esté cerrada en este instante — un mensaje puede
// entregarse en diferido con la emisora ya desconectada) y los teléfonos de
// avisos de los miembros del equipo (si el vendedor responde al aviso desde
// su WhatsApp personal, no debe nacer un lead basura con respuestas de IA).
// El bot lo refresca en su tick.
let internalPhones = new Set<string>();

export function setInternalPhones(phones: Set<string>): void {
  internalPhones = phones;
}

export function isInternalPhone(phone: string): boolean {
  return internalPhones.has(phone) || getConnectedPhones().has(phone);
}
