// Proceso del bot: sesiones de Baileys (una por cuenta) + loop de outbox
// multicanal + señales del dashboard.
// ⚠️ env-loader DEBE ser el primer import (ver comentario en env-loader.ts).
import "./env-loader";
import {
  addLeadEvent,
  assertCrmMigration,
  claimAlarmFire,
  enqueueNotify,
  getDueAlarms,
  isTransientDbError,
  listAllChannelSettings,
  listTeamMembers,
  listWaAccounts,
  setAlarmError,
  updateWaAccount,
  type Alarm,
  type ChannelSettingsRow,
  type WaAccount,
} from "../src/lib/db";
import path from "node:path";
import fs from "node:fs";
import { generateMessageIDV2 } from "@whiskeysockets/baileys";
import {
  authDirFor,
  getAllSessions,
  getOrCreateSession,
  getSession,
  removeSession,
  setDeliveryErrorHook,
  setInternalPhones,
} from "../src/lib/baileys/client";
import {
  beginInboundShutdown,
  flushDeferredInbound,
  hasUnsavedInbound,
  replayInboundSpool,
  restoreSpooledContacts,
} from "../src/lib/baileys/handler";
import { recoverJournal, setAsidePreviousJournal } from "../src/lib/inbound-spool";
import {
  flushOutbox,
  flushOutboxBookkeeping,
  rememberAccounts,
  resetInFlightOnce,
  sendBotReply,
  stopOutbox,
  withTimeout,
} from "../src/lib/outbox-worker";
import {
  busyChains,
  configureReplyEngine,
  drainReplies,
  flushPendingRecords,
  runRecoverySweep,
} from "../src/lib/reply-engine";
import { logRepeated } from "../src/lib/repeated-log";
import { fileRetryStore } from "../src/lib/reply-retry-store";
import { acquireInstanceLock, type InstanceLock } from "./instance-lock";
import { getLlmProviderInfo } from "../src/lib/llm";

// Red de seguridad: en redes inestables Baileys a veces rechaza promesas
// internas sin catch (p.ej. con el código de cierre "1006" del WebSocket).
// Sin esto, Node mata el proceso entero aunque nuestra lógica de reconexión
// esté sana. Se loguea fuerte y el bot sigue vivo; la reconexión y el tick
// se encargan de recuperar el estado.
process.on("unhandledRejection", (reason) => {
  console.error("[bot] ⚠️ Promesa rechazada sin catch (el bot continúa):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[bot] ⚠️ Excepción no capturada (el bot continúa):", err);
});

function assertEnv(): void {
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter(
    (k) => !process.env[k]
  );
  if (missing.length > 0) {
    console.error(`[bot] ❌ Faltan variables de entorno: ${missing.join(", ")}`);
    console.error("[bot]    Copia .env.example a .env.local y completa los valores.");
    process.exit(1);
  }
}

// Proveedor de IA activo (dashboard → Canales → Inteligencia artificial, o
// el fallback OPENAI_API_KEY del .env.local). Solo informativo: el bot
// arranca igual y las respuestas fallan con log claro si falta.
async function logLlmProvider(): Promise<void> {
  try {
    const llm = await getLlmProviderInfo();
    if (llm) {
      console.log(`[bot] LLM: ${llm}`);
    } else {
      console.warn(
        "[bot] ⚠️  Sin proveedor de IA: conéctalo en Canales → Inteligencia artificial " +
          "(o define OPENAI_API_KEY en .env.local). El bot conecta y guarda mensajes, " +
          "pero las respuestas de IA van a fallar hasta entonces."
      );
    }
  } catch {
    /* informativo: no bloquea el arranque */
  }
}

// Desvinculación pedida desde el dashboard (pestaña Equipo): cerrar sesión
// EN WHATSAPP (logout), borrar las credenciales de ESA cuenta y — si la
// cuenta debe correr — arrancar limpio con QR nuevo. El logout/clearAuth se
// ejecuta SIEMPRE, aunque la cuenta o el canal estén deshabilitados: la
// petición del operador es "suelta este teléfono", no "reinicia si puedes".
// El flag restart_requested se limpia ANTES de arrancar de nuevo; si el
// arranque falla, el reintento interno de la sesión se encarga — sin deadlock.
async function doRelink(account: WaAccount, restart: boolean): Promise<void> {
  console.log(`[bot][cuenta ${account.id}] 🔄 Desvinculación solicitada desde el dashboard...`);
  const session = getOrCreateSession(account.id, account.org_id);
  await session.stop({ logout: true });
  try {
    session.clearAuth();
  } catch (err) {
    console.error(`[bot][cuenta ${account.id}] No se pudieron borrar las credenciales:`, err);
  }
  await updateWaAccount(account.id, {
    status: "disconnected",
    qr_string: null,
    phone: null,
    restart_requested: false,
  });
  if (restart) void session.start();
}

// Mantiene el registro de sesiones alineado con la tabla wa_accounts:
// arranca las habilitadas, detiene las apagadas/borradas, aplica las
// señales de desvinculación y reconcilia el estado en la DB. El interruptor
// maestro del canal WhatsApp es POR ORGANIZACIÓN (masterByOrg).
async function reconcileSessions(
  masterByOrg: Map<number, boolean>,
  accounts: WaAccount[]
): Promise<void> {
  const byId = new Map(accounts.map((a) => [a.id, a]));

  // Cuentas eliminadas desde el dashboard: sesión fuera + credenciales
  // fuera. Con logout:true — la ruta DELETE exige que la cuenta no esté
  // 'connected' en la DB, pero el socket real puede ir por delante de la
  // fila (blip de Supabase entre 'open' y el write); sin logout, el
  // teléfono quedaría vinculado para siempre sin forma de soltarlo desde
  // acá. Sobre una sesión no autenticada el logout es un no-op tolerado.
  for (const s of getAllSessions()) {
    if (!byId.has(s.accountId)) {
      console.log(`[bot][cuenta ${s.accountId}] La cuenta fue eliminada — cerrando sesión`);
      await s.stop({ logout: true });
      try {
        s.clearAuth();
      } catch {
        /* huérfano inofensivo */
      }
      removeSession(s.accountId);
    }
  }

  for (const account of accounts) {
    const orgMaster = masterByOrg.get(account.org_id) ?? true;
    const shouldRun = orgMaster && account.enabled;
    const session = getSession(account.id);

    // La desvinculación se honra SIEMPRE (logout + credenciales borradas);
    // shouldRun solo decide si después se arranca de nuevo para el QR.
    if (account.restart_requested) {
      await doRelink(account, shouldRun);
      continue;
    }

    if (shouldRun && !session?.isActive()) {
      console.log(`[bot][cuenta ${account.id}] Iniciando sesión (${account.label}, org ${account.org_id})...`);
      void getOrCreateSession(account.id, account.org_id).start();
    } else if (!shouldRun && session?.isActive()) {
      console.log(`[bot][cuenta ${account.id}] Deshabilitada — deteniendo sesión`);
      await session.stop({ logout: false });
      await updateWaAccount(account.id, { status: "disconnected", qr_string: null, phone: null });
    }

    // Reconciliación en ambos sentidos:
    // (a) socket abierto con la DB atrasada (falló el write de 'connected');
    // (b) 'connected' huérfano en la DB con la sesión ya detenida (falló el
    //     write de 'disconnected' al apagarla) — sin esto, la UI mostraría
    //     una cuenta conectada fantasma y el DELETE la bloquearía.
    const live = getSession(account.id);
    if (live?.isOpen() && account.status !== "connected") {
      await updateWaAccount(account.id, {
        status: "connected",
        qr_string: null,
        phone: live.phone(),
      });
    } else if (!live?.isActive() && account.status === "connected") {
      await updateWaAccount(account.id, { status: "disconnected", qr_string: null, phone: null });
    }
  }
}

// Migración del layout de una sola cuenta: las credenciales vivían en la
// raíz de ./auth/; ahora cada cuenta usa ./auth/acc-<id>/. Si hay una
// sesión vieja en la raíz y la primera cuenta aún no tiene directorio, se
// mueve — así la vinculación previa sobrevive al upgrade sin pedir QR.
function migrateLegacyAuthDir(firstAccountId: number | undefined): void {
  if (!firstAccountId) return;
  const root = path.resolve(process.cwd(), "auth");
  const legacyCreds = path.join(root, "creds.json");
  const target = authDirFor(firstAccountId);
  if (!fs.existsSync(legacyCreds) || fs.existsSync(target)) return;
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(root)) {
    if (entry.startsWith("acc-")) continue;
    fs.renameSync(path.join(root, entry), path.join(target, entry));
  }
  console.log(`[bot] Credenciales migradas: ./auth/ → ./auth/acc-${firstAccountId}/`);
}

// Teléfonos internos POR ORGANIZACIÓN (cuentas propias + teléfonos de
// avisos del equipo de esa organización): el handler los ignora como
// remitentes SOLO dentro de su organización — el vendedor del cliente B
// puede ser un lead legítimo del cliente A. Los de miembros se refrescan
// cada ~30s; los de cuentas, en cada tick junto con wa_accounts.
let memberPhonesByOrg = new Map<number, string[]>();
let internalPhonesTick = 0;
let memberPhonesLoaded = false;

async function refreshInternalPhones(accounts: WaAccount[]): Promise<void> {
  // Mientras la lectura falle se reintenta en CADA tick (al arrancar, una
  // lista vacía dejaba pasar avisos internos como si fueran leads).
  if (!memberPhonesLoaded || internalPhonesTick % 15 === 0) {
    try {
      const members = await listTeamMembers();
      const byOrg = new Map<number, string[]>();
      for (const m of members) {
        if (!m.notify_phone) continue;
        const list = byOrg.get(m.org_id) ?? [];
        list.push(m.notify_phone);
        byOrg.set(m.org_id, list);
      }
      memberPhonesByOrg = byOrg;
      memberPhonesLoaded = true;
    } catch {
      /* se conserva la lista anterior */
    }
  }
  internalPhonesTick++;
  const byOrg = new Map<number, Set<string>>();
  for (const [orgId, phones] of memberPhonesByOrg) {
    byOrg.set(orgId, new Set(phones));
  }
  for (const a of accounts) {
    if (!a.phone) continue;
    let set = byOrg.get(a.org_id);
    if (!set) {
      set = new Set();
      byOrg.set(a.org_id, set);
    }
    set.add(a.phone);
  }
  setInternalPhones(byOrg);
}

// ── Alarmas (renovaciones, pagos, recordatorios) ────────────

const ALARM_KIND_LABELS: Record<string, string> = {
  SUSCRIPCION: "Renovación de suscripción",
  PAGO: "Pago",
  REUNION: "Reunión",
  TAREA: "Tarea",
  OTRO: "Recordatorio",
};

// Suma meses SIN el desborde de JS (31-ago + 1 mes = 31-sep = 1-oct, que
// derivaba la alarma de día para siempre y saltaba meses). Regla: si la
// fecha es el ÚLTIMO día de su mes, la siguiente también lo es ("fin de
// mes"); si no, se conserva el día con clamp al último del mes destino.
function addMonthsClamped(d: Date, months: number): Date {
  const lastOfCurrent = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const isEndOfMonth = d.getDate() === lastOfCurrent;
  const target = new Date(
    d.getFullYear(),
    d.getMonth() + months,
    1,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds()
  );
  const lastOfTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(isEndOfMonth ? lastOfTarget : Math.min(d.getDate(), lastOfTarget));
  return target;
}

// Próximo disparo de una alarma recurrente. Si el bot estuvo apagado varios
// periodos, avanza hasta el futuro (UN disparo por el atraso, no una ráfaga).
function nextAlarmFire(from: number, repeat: string): number | null {
  if (repeat === "NUNCA") return null;
  const now = Math.floor(Date.now() / 1000);
  let d = new Date(from * 1000);
  do {
    switch (repeat) {
      case "DIARIO":
        d.setDate(d.getDate() + 1);
        break;
      case "SEMANAL":
        d.setDate(d.getDate() + 7);
        break;
      case "MENSUAL":
        d = addMonthsClamped(d, 1);
        break;
      case "ANUAL":
        d = addMonthsClamped(d, 12);
        break;
      default:
        return null;
    }
  } while (Math.floor(d.getTime() / 1000) <= now);
  return Math.floor(d.getTime() / 1000);
}

// Dispara las alarmas vencidas: reclama (condicional: si el operador la
// reprogramó/apagó a mitad del lote, NO se dispara) y encola el aviso por
// WhatsApp (outbox notify) EN LA ORGANIZACIÓN de la alarma. El envío real
// lo hacen los workers de siempre con sus reintentos.
async function flushAlarms(): Promise<void> {
  let due: Alarm[];
  try {
    due = await getDueAlarms(10);
  } catch {
    return; // tabla sin migrar o blip: siguiente tick
  }
  for (const alarm of due) {
    const next = nextAlarmFire(alarm.next_fire_at, alarm.repeat_every);
    let claimed = false;
    try {
      claimed = await claimAlarmFire(alarm, next);
    } catch (err) {
      console.error(`[bot] No se pudo reclamar la alarma #${alarm.id}:`, err);
      // El UPDATE pudo aplicarse con la respuesta perdida (blip): si fue
      // así, la alarma avanzó sin encolar el aviso — se deja rastro visible.
      // Si el reclamo realmente falló, el próximo tick lo repite y el error
      // se limpia solo al disparar.
      try {
        await setAlarmError(alarm.id, "No se pudo confirmar el disparo (corte de red): verifica si el aviso llegó");
      } catch {
        /* siguiente tick */
      }
      continue;
    }
    if (!claimed) continue;

    const label = ALARM_KIND_LABELS[alarm.kind] ?? "Recordatorio";
    try {
      if (alarm.to_phone) {
        await enqueueNotify(
          alarm.org_id,
          alarm.to_phone,
          `AGENTE · ${label}: ${alarm.title}\n\n${alarm.message}`
        );
      } else {
        throw new Error("La alarma no tiene destino configurado");
      }
      console.log(`[bot] 🔔 Alarma #${alarm.id} "${alarm.title}" disparada (${alarm.via})`);
    } catch (err) {
      // La alarma ya avanzó (reclamo primero: nunca ráfagas duplicadas);
      // el fallo queda visible en la UI vía last_error.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bot] ⚠️ Falló el encolado de la alarma #${alarm.id}:`, msg);
      try {
        await setAlarmError(alarm.id, msg);
      } catch {
        /* siguiente tick */
      }
    }
  }
}

// Últimos valores conocidos (ante blips de Supabase se conserva el estado
// en vez de re-encender/apagar sesiones con datos a medias).
// Multi-organización: el interruptor maestro de WhatsApp y la configuración
// de canales son POR organización.
let lastKnownMasterByOrg = new Map<number, boolean>();
let lastKnownSettingsByOrg: Map<number, Record<string, ChannelSettingsRow>> | null = null;

// Agrupa las filas de channel_settings por organización.
function groupSettingsByOrg(
  rows: ChannelSettingsRow[]
): Map<number, Record<string, ChannelSettingsRow>> {
  const map = new Map<number, Record<string, ChannelSettingsRow>>();
  for (const row of rows) {
    let orgMap = map.get(row.org_id);
    if (!orgMap) {
      orgMap = {};
      map.set(row.org_id, orgMap);
    }
    orgMap[row.channel] = row;
  }
  return map;
}

// Pedido de apagado por archivo (lo usa el lanzador local para cerrar un bot
// anterior sin matarlo a la fuerza).
const STOP_FILE = path.resolve(process.cwd(), "auth", "bot.stop");

// Marca de instancia única: un solo bot por instalación (instance-lock.ts).
const LOCK_FILE = path.resolve(process.cwd(), "auth", "bot.lock");
let instanceLock: InstanceLock | null = null;

// Al arrancar: reintenta mientras el error sea de disponibilidad de la base
// (red, timeout, Supabase reiniciando); un error de verdad se propaga.
async function untilDbAvailable<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientDbError(err) || stopping) throw err;
      const delay = Math.min(30_000, 2_000 * attempt);
      console.warn(
        `[bot] ⚠️ No se pudo ${label}: la base no responde (${err instanceof Error ? err.message.slice(0, 160) : err}); reintento en ${delay / 1000}s...`
      );
      await sleep(delay);
    }
  }
}

async function main(): Promise<void> {
  assertEnv();
  instanceLock = acquireInstanceLock(LOCK_FILE, (owner) => {
    lockLost = true;
    console.error(`[bot] ❌ Otro bot (PID ${owner}) tomó la marca de instancia única mientras este estaba detenido: este se cierra.`);
    void stop("Otro bot tomó el relevo");
  });
  // Dos arranques que reemplazaron a la vez la misma marca vieja: cada uno
  // borró la del otro y creó la suya. El que la perdió se entera acá.
  await sleep(500);
  const owner = instanceLock.owner();
  if (owner !== null && owner !== process.pid) {
    console.error(`[bot] ❌ Otro bot (PID ${owner}) tomó la marca de instancia única al mismo tiempo: este no arranca.`);
    process.exit(1);
  }

  // Un pedido de apagado viejo (de un bot que ya no corre) no aplica a este.
  try {
    fs.rmSync(STOP_FILE, { force: true });
  } catch {
    /* noop */
  }
  // Pedido de apagado por archivo (lanzador local). Desde ya: si la base no
  // responde al arrancar, el bot espera a que vuelva y el pedido debe
  // atenderse igual (si no, el lanzador lo terminaba matando a la fuerza).
  stopFileTimer = setInterval(() => {
    if (stopping || !fs.existsSync(STOP_FILE)) return;
    try {
      fs.rmSync(STOP_FILE, { force: true });
    } catch {
      /* noop */
    }
    void stop("pedido de apagado");
  }, 1000);

  await logLlmProvider();
  if (stopping) return;

  // Verificación temprana: si el schema no está aplicado, avisar claro.
  // listWaAccounts también valida la migración de Equipo (multi-cuenta). Si
  // la base no responde (red caída, Supabase reiniciando) se ESPERA a que
  // vuelva: salir dejaría a todos los clientes sin respuesta.
  try {
    await untilDbAvailable("verificar la base", () => assertCrmMigration());
  } catch (err) {
    if (stopping) return; // apagado pedido mientras esperaba la base: lo cierra stop()
    console.error(`[bot] ❌ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  let bootAccounts: WaAccount[];
  try {
    bootAccounts = await untilDbAvailable("leer las cuentas de WhatsApp", () => listWaAccounts());
  } catch (err) {
    if (stopping) return;
    console.error("[bot] ❌ No se pudo leer wa_accounts en Supabase.");
    console.error("[bot]    Re-ejecuta supabase/schema.sql completo en el SQL Editor.");
    console.error(`[bot]    Detalle: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  rememberAccounts(bootAccounts);

  // Filas que quedaron 'enviando' si el proceso murió a mitad de una entrega
  // (si falla, el tick lo reintenta antes de enviar nada).
  await resetInFlightOnce();

  // Estado limpio al arrancar (un run anterior pudo dejar 'connected'
  // colgado). OJO: restart_requested NO se toca — es una ORDEN pendiente del
  // operador (desvincular), no estado derivado; borrarla aquí perdía las
  // desvinculaciones pedidas mientras el bot estaba caído y la cuenta
  // reconectaba con las credenciales viejas. El primer reconcileSessions
  // (≤2s) la honra vía doRelink.
  for (const account of bootAccounts) {
    try {
      await updateWaAccount(account.id, { status: "disconnected", qr_string: null });
    } catch (err) {
      console.warn(`[bot][cuenta ${account.id}] No se pudo limpiar el estado inicial:`, err);
    }
  }

  // Migración del layout de credenciales de una sola cuenta (./auth/creds.json
  // → ./auth/acc-<primera cuenta>/): conserva la sesión vinculada previa.
  try {
    migrateLegacyAuthDir(bootAccounts[0]?.id);
  } catch (err) {
    console.warn("[bot] No se pudo migrar el directorio auth/ antiguo:", err);
  }

  // Teléfonos internos listos ANTES de abrir sesiones: si no, los primeros
  // mensajes entre cuentas propias podrían colarse como leads.
  await refreshInternalPhones(bootAccounts);

  // Las sesiones arrancan solo si el canal WhatsApp (QR) está habilitado en
  // Canales DE SU ORGANIZACIÓN; cada cuenta tiene además su toggle en Equipo.
  const initialRows = await listAllChannelSettings().catch(() => [] as ChannelSettingsRow[]);
  const initialByOrg = groupSettingsByOrg(initialRows);
  lastKnownSettingsByOrg = initialByOrg;
  lastKnownMasterByOrg = new Map(
    [...initialByOrg.entries()].map(([orgId, rows]) => [orgId, rows["whatsapp"]?.enabled ?? true])
  );
  // Motor de respuestas: este proceso responde el canal 'whatsapp' (Baileys)
  // — Cloud API lo responde el proceso de Next. Activo ANTES de abrir las
  // sesiones: lo que llegue al conectar ya tiene quién lo responda.
  configureReplyEngine({
    channels: ["whatsapp"],
    newMessageId: () => generateMessageIDV2(),
    cannotReply: async (conv) =>
      (lastKnownMasterByOrg.get(conv.org_id) ?? true)
        ? null
        : "el canal WhatsApp está deshabilitado en su organización",
    // Mensajes del contacto aún en el respaldo en disco: se le responde
    // cuando estén todos guardados.
    inboundPending: (conv) => hasUnsavedInbound(conv.org_id, conv.channel, conv.external_id ?? conv.phone ?? ""),
    send: sendBotReply,
    // Respuestas por reintentar: un reinicio las retoma desde donde iban.
    retryStore: fileRetryStore("reply-retries.json"),
  });
  // Rechazos de WhatsApp a mensajes ya enviados: visibles en la actividad
  // del lead (antes figuraban como entregados sin llegar nunca).
  setDeliveryErrorHook((e) => {
    if (e.conversationId === null) return;
    const hint =
      e.code === "463"
        ? " (cuenta restringida o sin token de privacidad para este contacto)"
        : e.code === "479"
          ? " (sesión del contacto desactualizada)"
          : "";
    addLeadEvent(
      e.conversationId,
      "delivery_error",
      `WhatsApp rechazó un mensaje enviado a este contacto: error ${e.code}${hint}. Verifica si le llegó.`
    ).catch(() => undefined);
  });

  // Lo que el proceso anterior recibió y no alcanzó a guardar (cierre
  // forzado, corte de luz) pasa al respaldo en disco; y se anota qué
  // contactos tienen mensajes esperando ahí, para que lo nuevo de esos
  // contactos no se guarde antes. ANTES de abrir las sesiones.
  // El diario anterior se aparta primero: este proceso escribe uno nuevo y
  // vaciarlo nunca borra lo que quedaba del anterior. Si recuperarlo falla,
  // se reintenta en el ciclo del respaldo.
  try {
    setAsidePreviousJournal();
    const recovered = recoverJournal();
    if (recovered.length > 0) {
      console.log(`[bot] ${recovered.length} mensaje(s) recibido(s) antes del último cierre se recuperaron del diario en disco`);
    }
  } catch (err) {
    console.error("[bot] ⚠️ No se pudo recuperar el diario de mensajes en disco (se reintenta):", err);
  }
  try {
    const waiting = restoreSpooledContacts();
    if (waiting > 0) {
      console.log(`[bot] ${waiting} mensaje(s) esperan en el respaldo en disco; se guardan en cuanto la base responda`);
    }
  } catch (err) {
    console.error("[bot] ⚠️ No se pudo leer el respaldo de mensajes en disco:", err);
  }

  // Apagado pedido durante el arranque: no se abre ninguna sesión.
  if (stopping) return;
  const enabled = bootAccounts.filter(
    (a) => a.enabled && (lastKnownMasterByOrg.get(a.org_id) ?? true)
  );
  console.log(`[bot] ${enabled.length} cuenta(s) de WhatsApp habilitada(s)`);
  for (const account of enabled) {
    // Con desvinculación pendiente NO se arranca con las credenciales
    // viejas: el primer reconcileSessions hace logout+clearAuth y recién
    // ahí arranca limpio pidiendo QR.
    if (account.restart_requested) continue;
    void getOrCreateSession(account.id, account.org_id).start();
  }

  // Tick único cada 2s: ciclo de vida de sesiones + señales + outbox.
  // El flag `ticking` evita que un tick lento se solape.
  tickTimer = setInterval(async () => {
    if (ticking || stopping) return;
    ticking = true;
    try {
      // Toggles y configuración POR ORGANIZACIÓN — ante un blip de Supabase
      // se conserva el ÚLTIMO valor conocido (inicializar en true aquí
      // re-encendía un canal deshabilitado).
      let masterByOrg = lastKnownMasterByOrg;
      let settingsByOrg = lastKnownSettingsByOrg;
      try {
        const rows = await listAllChannelSettings();
        settingsByOrg = groupSettingsByOrg(rows);
        masterByOrg = new Map(
          [...settingsByOrg.entries()].map(([orgId, orgRows]) => [
            orgId,
            orgRows["whatsapp"]?.enabled ?? true,
          ])
        );
        lastKnownSettingsByOrg = settingsByOrg;
        lastKnownMasterByOrg = masterByOrg;
      } catch {
        /* si Supabase parpadea, se conserva el estado actual */
      }

      // Cuentas: si la lectura falla, NO se reconcilia este tick (apagar
      // sesiones con datos a medias sería peor que esperar 2s).
      try {
        const accounts = await listWaAccounts();
        rememberAccounts(accounts);
        await refreshInternalPhones(accounts);
        await reconcileSessions(masterByOrg, accounts);
      } catch {
        /* siguiente tick */
      }

      // Alarmas vencidas → encolan avisos (outbox notify).
      await flushAlarms();

      // El outbox corre SIEMPRE: WhatsApp Cloud API no depende de Baileys.
      await flushOutbox(settingsByOrg);

      // Respuestas que salieron pero no se pudieron guardar en el hilo, y
      // pausas de la IA sin confirmar.
      await flushPendingRecords();
    } catch (err) {
      logRepeated("error", "tick", "[bot] Error en tick de outbox/señales:", err);
    } finally {
      ticking = false;
    }
  }, 2000);

  // Mensajes entrantes respaldados en disco durante un corte de la base: en
  // su propio ciclo (con muchos, no frena el outbox ni las sesiones).
  spoolTimer = setInterval(async () => {
    if (replayingSpool || stopping) return;
    replayingSpool = true;
    try {
      const saved = await replayInboundSpool();
      if (saved > 0) console.log(`[bot] ${saved} mensaje(s) respaldado(s) en disco ya quedaron guardados`);
    } catch (err) {
      logRepeated("error", "spool", "[bot] Error reponiendo mensajes respaldados en disco:", err);
    } finally {
      replayingSpool = false;
    }
  }, 5000);

  // Barrido de recuperación cada 5 s (aparte del tick, que puede tardar con
  // el outbox): conversaciones en modo IA cuyo último mensaje es del cliente
  // y nadie está respondiendo — tras un reinicio, un corte o un fallo de la
  // IA. Arranca con margen para que las sesiones alcancen a conectar.
  let sweeping = false;
  sweepStartTimer = setTimeout(() => {
    sweepStartTimer = null;
    if (stopping) return;
    sweepTimer = setInterval(async () => {
      if (sweeping || stopping) return;
      sweeping = true;
      try {
        const scheduled = await runRecoverySweep();
        if (scheduled > 0) console.log(`[bot] 🔁 ${scheduled} conversación(es) sin responder retomada(s)`);
      } catch (err) {
        logRepeated("error", "sweep", "[bot] Error en el barrido de respuestas pendientes:", err);
      } finally {
        sweeping = false;
      }
    }, 5000);
  }, 15_000);

  console.log("[bot] Loop de sesiones + outbox multicanal activo (cada 2s)");
}

let tickTimer: NodeJS.Timeout | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let sweepStartTimer: NodeJS.Timeout | null = null;
let spoolTimer: NodeJS.Timeout | null = null;
let stopFileTimer: NodeJS.Timeout | null = null;
// Otro bot tomó la marca de instancia única (ver instance-lock.ts).
let lockLost = false;
let ticking = false;
let replayingSpool = false;
let stopping = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Apagado ordenado, con tope de tiempo. Lo que no alcance lo retoman, al
// volver a arrancar, el diario en disco (mensajes recibidos) y el barrido
// (respuestas). Al cerrar la ventana de la consola Windows termina el
// proceso a los pocos segundos: ahí se hace el mismo cierre, más corto (los
// límites se miden desde que empezó el apagado; si el cierre rápido llega a
// mitad de uno normal, lo acorta).
const STOP_NORMAL = { tickMs: 10_000, drainMs: 8_000, persistMs: 20_000, finalMs: 5_000 };
const STOP_QUICK = { tickMs: 1_000, drainMs: 1_000, persistMs: 3_500, finalMs: 1_500 };
let stopPlan = STOP_NORMAL;

async function stop(signal: string, quick = false): Promise<void> {
  if (quick) stopPlan = STOP_QUICK;
  if (stopping) return;
  stopping = true;
  stopOutbox();
  console.log(`\n[bot] ${signal}: cerrando ordenadamente...`);
  // Lo que llegue de aquí en más: un intento contra la base y, si falla,
  // directo al respaldo en disco.
  beginInboundShutdown();
  for (const timer of [tickTimer, sweepTimer, spoolTimer, stopFileTimer]) if (timer) clearInterval(timer);
  if (sweepStartTimer) clearTimeout(sweepStartTimer);
  const t0 = Date.now();
  const within = (ms: number) => Date.now() - t0 < ms;
  // 1) El tick en curso (una entrega a medias) y las respuestas en curso.
  while ((ticking || replayingSpool) && within(stopPlan.tickMs)) await sleep(100);
  const drainFrom = Date.now();
  await drainReplies(() =>
    Math.max(drainFrom + 300, Math.min(drainFrom + stopPlan.drainMs, t0 + stopPlan.tickMs + stopPlan.drainMs))
  ).catch(() => undefined);
  // 2) Sesiones fuera (sin logout: el próximo arranque no pide QR). Baileys
  //    suelta lo que retenía en su buffer y no entran mensajes nuevos.
  await Promise.all(getAllSessions().map((s) => s.stop({ logout: false }))).catch(() => undefined);
  // 3) Lo recibido termina de guardarse (o de respaldarse en disco). Lo que
  //    esperaba algo en memoria (aviso "no disponible" de un anuncio, @lid
  //    sin número) se resuelve ya, después de procesar lo que soltó Baileys.
  while (busyChains("intake:") > 0 && within(stopPlan.persistMs)) await sleep(100);
  flushDeferredInbound();
  while ((busyChains("intake:") > 0 || busyChains("persist:") > 0) && within(stopPlan.persistMs)) await sleep(100);
  // 4) Pendientes en memoria: un último intento (acotado: con la base caída
  //    cada consulta puede tardar).
  await withTimeout(Promise.all([flushPendingRecords(), flushOutboxBookkeeping()]), stopPlan.finalMs, "pendientes al cerrar").catch(
    () => undefined
  );
  instanceLock?.stopRenewal();
  process.exit(lockLost ? 1 : 0);
}

process.on("SIGINT", () => void stop("SIGINT recibido"));
process.on("SIGTERM", () => void stop("SIGTERM recibido"));
// Windows: cerrar la ventana de la consola (SIGHUP: unos segundos antes de
// que Windows termine el proceso) o Ctrl+Break (SIGBREAK).
process.on("SIGHUP", () => void stop("Ventana cerrada", true));
process.on("SIGBREAK", () => void stop("SIGBREAK recibido"));
// Lanzador local (dev-local): pedido de apagado por el canal IPC.
process.on("message", (msg) => {
  if (msg === "shutdown") void stop("Pedido de apagado del lanzador");
});

main().catch((err) => {
  console.error("[bot] Error fatal:", err);
  process.exit(1);
});
