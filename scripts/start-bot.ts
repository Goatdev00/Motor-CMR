// Proceso del bot: sesiones de Baileys (una por cuenta) + loop de outbox
// multicanal + cola de correos + señales del dashboard.
// ⚠️ env-loader DEBE ser el primer import (ver comentario en env-loader.ts).
import "./env-loader";
import {
  assertCrmMigration,
  claimAlarmFire,
  claimEmail,
  claimOutboxItem,
  countEmailsSentSince,
  enqueueEmails,
  enqueueNotify,
  getConversationById,
  getDueAlarms,
  getPendingEmails,
  getPendingOutbox,
  insertMessage,
  listAllChannelSettings,
  listTeamMembers,
  listWaAccounts,
  markEmailSent,
  markFollowUpFailed,
  markFollowUpSent,
  markOutboxSent,
  releaseEmailFailure,
  releaseOutboxFailure,
  resetInFlightEmails,
  resetInFlightOutbox,
  setAlarmError,
  updateWaAccount,
  type Alarm,
  type ChannelSettingsRow,
  type OutboxItem,
  type TeamMember,
  type WaAccount,
} from "../src/lib/db";
import path from "node:path";
import fs from "node:fs";
import { parseEmailConfig, sendEmail, textToHtml } from "../src/lib/mailer";
import {
  anySessionOpen,
  authDirFor,
  getAllSessions,
  getOpenSession,
  getOrCreateSession,
  getSession,
  removeSession,
  setInternalPhones,
  type BaileysSession,
} from "../src/lib/baileys/client";
import { sendChannelText } from "../src/lib/meta";
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

// Teléfonos internos (cuentas propias + teléfonos de avisos del equipo):
// el handler los ignora como remitentes. Los de miembros se refrescan cada
// ~30s; los de cuentas, en cada tick junto con wa_accounts.
let memberNotifyPhones: string[] = [];
let internalPhonesTick = 0;

async function refreshInternalPhones(accounts: WaAccount[]): Promise<void> {
  if (internalPhonesTick % 15 === 0) {
    try {
      const members = await listTeamMembers();
      memberNotifyPhones = members
        .map((m) => m.notify_phone)
        .filter((p): p is string => !!p);
    } catch {
      /* se conserva la lista anterior */
    }
  }
  internalPhonesTick++;
  const phones = new Set<string>(memberNotifyPhones);
  for (const a of accounts) if (a.phone) phones.add(a.phone);
  setInternalPhones(phones);
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
// WhatsApp (outbox notify) o correo (email_queue) EN LA ORGANIZACIÓN de la
// alarma. El envío real lo hacen los workers de siempre con sus reintentos.
async function flushAlarms(
  settingsByOrg: Map<number, Record<string, ChannelSettingsRow>> | null
): Promise<void> {
  let due: Alarm[];
  try {
    due = await getDueAlarms(10);
  } catch {
    return; // tabla sin migrar o blip: siguiente tick
  }
  for (const alarm of due) {
    // Alarma por correo sin cuenta SMTP configurada/activada EN SU
    // organización: NO se reclama (dispararía "en falso" con la cola
    // muerta). Queda vencida con el error visible; en cuanto Mailing esté
    // listo, el disparo sale solo.
    if (alarm.via === "email" && settingsByOrg) {
      const row = settingsByOrg.get(alarm.org_id)?.["email"];
      if (!row?.enabled || parseEmailConfig(row) === null) {
        const msg = "La cuenta de correo (pestaña Mailing) no está configurada o está apagada";
        if (alarm.last_error !== msg) {
          try {
            await setAlarmError(alarm.id, msg);
          } catch {
            /* siguiente tick */
          }
        }
        continue;
      }
    }

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
      if (alarm.via === "whatsapp" && alarm.to_phone) {
        await enqueueNotify(
          alarm.org_id,
          alarm.to_phone,
          `AGENTE · ${label}: ${alarm.title}\n\n${alarm.message}`
        );
      } else if (alarm.via === "email" && alarm.to_email) {
        await enqueueEmails([
          {
            to_email: alarm.to_email,
            subject: `AGENTE · ${label}: ${alarm.title}`,
            html: textToHtml(alarm.message),
            org_id: alarm.org_id,
          },
        ]);
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

// Cinturón anti-duplicados: ids que YA salieron por WhatsApp pero cuyo
// UPDATE sent=1 falló (blip de Supabase). No se reenvían; solo se reintenta
// el marcado en ticks siguientes.
const sentUnrecorded = new Set<number>();

// Pasos post-entrega de un seguimiento (registrar el mensaje en el hilo +
// limpiar el recordatorio). Si Supabase parpadea justo ahí, se reintenta en
// ticks siguientes (máx 5) en vez de perderse.
interface FollowupFinalize {
  conversationId: number;
  content: string;
  scheduledAt: number | null;
  messageInserted: boolean;
  attempts: number;
}
const pendingFinalize = new Map<number, FollowupFinalize>();

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

// ── Worker de la cola de correos (Mailing) ──────────────────
// Ritmo base: hasta 2 correos por tick de 2s POR ORGANIZACIÓN. Cada correo
// sale por la cuenta SMTP de SU organización, y los límites por hora/día
// (opcionales) se cuentan por organización.
async function flushEmailQueue(
  settingsByOrg: Map<number, Record<string, ChannelSettingsRow>>
): Promise<void> {
  // Lote generoso: se agrupa por organización y cada una toma hasta 2.
  const pending = await getPendingEmails(40);
  if (pending.length === 0) return;

  const byOrg = new Map<number, typeof pending>();
  for (const item of pending) {
    const list = byOrg.get(item.org_id) ?? [];
    list.push(item);
    byOrg.set(item.org_id, list);
  }

  for (const [orgId, items] of byOrg) {
    const row = settingsByOrg.get(orgId)?.["email"];
    if (!row?.enabled) continue; // esta organización no tiene Mailing activo
    const config = parseEmailConfig(row);
    if (!config) continue; // cuenta incompleta: no hay nada que hacer

    let allowance = 2;
    const now = Math.floor(Date.now() / 1000);
    if (config.maxPerHour !== null) {
      const sentLastHour = await countEmailsSentSince(now - 3600, orgId);
      allowance = Math.min(allowance, config.maxPerHour - sentLastHour);
    }
    if (allowance > 0 && config.maxPerDay !== null) {
      const sentLastDay = await countEmailsSentSince(now - 86400, orgId);
      allowance = Math.min(allowance, config.maxPerDay - sentLastDay);
    }
    if (allowance <= 0) continue; // límite alcanzado: se retoma al liberarse

    for (const item of items.slice(0, allowance)) {
      let claimed = false;
      try {
        claimed = await claimEmail(item.id);
      } catch (err) {
        console.error(`[bot] No se pudo reclamar email #${item.id}:`, err);
        continue;
      }
      if (!claimed) continue;

      try {
        await sendEmail(config, {
          to: item.to_email,
          toName: item.to_name,
          subject: item.subject,
          html: item.html,
          replyTo: item.reply_to ?? null,
        });
        await markEmailSent(item.id);
        console.log(`[bot] ✉️  Email #${item.id} (org ${orgId}) enviado a ${item.to_email}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[bot] Falló email #${item.id} a ${item.to_email}:`, message);
        try {
          const discarded = await releaseEmailFailure(item, message);
          if (discarded) {
            console.error(`[bot] ⚠️ Email #${item.id} descartado tras agotar reintentos`);
          }
        } catch (relErr) {
          console.error(`[bot] No se pudo liberar email #${item.id}:`, relErr);
        }
      }
    }
  }
}

async function finalizeFollowup(outboxId: number, f: FollowupFinalize): Promise<void> {
  if (!f.messageInserted) {
    await insertMessage(f.conversationId, "human", f.content);
    f.messageInserted = true; // no duplicar el mensaje si el paso 2 falla
  }
  await markFollowUpSent(f.conversationId, f.scheduledAt);
  pendingFinalize.delete(outboxId);
}

// ── Resolución de la cuenta de WhatsApp para un envío ───────
// Prioridad: cuenta explícita del item → cuenta del vendedor asignado (así
// el chat "se redirige" al vendedor según la etapa) → cuenta por la que
// habla el lead → cualquier cuenta conectada. Cada eslabón se prueba en
// orden (getOpenSession(preferred) cae a "cualquiera" por sí solo, lo que
// saltaría la cuenta del lead si la del vendedor está caída). Siempre se
// entrega si hay alguna sesión abierta: mejor salir por otra cuenta que no
// salir.
async function resolveWaSession(
  item: OutboxItem,
  getMembers: () => Promise<Map<number, TeamMember>>
): Promise<BaileysSession | null> {
  // TODAS las resoluciones quedan confinadas a la organización del envío:
  // un lead de un cliente jamás recibe mensajes desde el WhatsApp de otro.
  if (item.wa_account_id != null) return getOpenSession(item.wa_account_id, item.org_id);
  if (item.kind === "notify" || item.conversation_id == null) {
    return getOpenSession(null, item.org_id);
  }
  try {
    const conv = await getConversationById(item.conversation_id);
    if (conv) {
      const candidates: number[] = [];
      if (conv.assigned_member_id != null) {
        const member = (await getMembers()).get(conv.assigned_member_id);
        if (member?.active && member.wa_account_id != null) {
          candidates.push(member.wa_account_id);
        }
      }
      if (conv.wa_account_id != null) candidates.push(conv.wa_account_id);
      for (const accountId of candidates) {
        const s = getSession(accountId);
        if (s?.isOpen() && s.orgId === item.org_id) return s;
      }
    }
  } catch {
    /* fallback a cualquier sesión abierta de la organización */
  }
  return getOpenSession(null, item.org_id);
}

// Envío según canal: WhatsApp usa la sesión resuelta; los canales de Meta
// van por HTTPS (Graph API) con los tokens de la organización del envío.
async function deliverOutboxItem(
  item: OutboxItem,
  getMembers: () => Promise<Map<number, TeamMember>>
): Promise<void> {
  if (item.channel === "whatsapp") {
    const session = await resolveWaSession(item, getMembers);
    if (!session) {
      throw new Error(`Ninguna cuenta de WhatsApp conectada en la organización ${item.org_id}`);
    }
    await session.send(`${item.phone}@s.whatsapp.net`, item.content);
    return;
  }
  await sendChannelText(item.org_id, item.channel, item.phone, item.content);
}

// ¿Se puede intentar la entrega ahora? (evita reclamar filas que no van a
// poder enviarse: sin sesiones de WhatsApp de SU organización o canal de
// Meta deshabilitado en SU organización).
function isDeliverable(
  item: OutboxItem,
  settingsByOrg: Map<number, Record<string, ChannelSettingsRow>> | null
): boolean {
  if (item.channel === "api") return false; // sin canal de respuesta, nunca
  if (item.channel === "whatsapp") return anySessionOpen(item.org_id);
  const row = settingsByOrg?.get(item.org_id)?.[item.channel];
  return row?.enabled ?? false;
}

async function flushOutbox(
  settingsByOrg: Map<number, Record<string, ChannelSettingsRow>> | null
): Promise<void> {
  // Exclusiones GLOBALES de la consulta (inanición por limit): 'api' nunca
  // entrega, y 'whatsapp' solo si no hay NINGUNA sesión abierta en ninguna
  // organización. El detalle por organización lo decide isDeliverable.
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

  // Reintentos diferidos de ticks anteriores.
  for (const id of [...sentUnrecorded]) {
    try {
      await markOutboxSent(id);
      sentUnrecorded.delete(id);
    } catch {
      /* siguiente tick */
    }
  }
  for (const [id, f] of [...pendingFinalize]) {
    try {
      await finalizeFollowup(id, f);
    } catch (err) {
      f.attempts += 1;
      if (f.attempts >= 5) {
        pendingFinalize.delete(id);
        console.error(
          `[bot] ⚠️ Se abandona la finalización del seguimiento #${id} (¿conversación borrada?):`,
          err
        );
      }
    }
  }

  const pending = await getPendingOutbox(20, [...disabledChannels]);
  for (const item of pending) {
    if (sentUnrecorded.has(item.id) || pendingFinalize.has(item.id)) continue;
    if (!isDeliverable(item, settingsByOrg)) continue; // su organización no puede entregar ahora

    // Reclamo condicional (sent=0 → 3): si el operador canceló o reprogramó
    // el seguimiento (o borró la conversación) mientras este lote estaba en
    // memoria, la fila ya no está pendiente y NO se envía.
    let claimed = false;
    try {
      claimed = await claimOutboxItem(item.id);
    } catch (err) {
      console.error(`[bot] No se pudo reclamar outbox #${item.id}:`, err);
      continue;
    }
    if (!claimed) {
      console.log(`[bot] Outbox #${item.id} ya no está pendiente (cancelado/reprogramado); no se envía`);
      continue;
    }

    try {
      await deliverOutboxItem(item, getMembers);
    } catch (err) {
      console.error(`[bot] Falló envío de outbox #${item.id} [${item.channel}]:`, err);
      // Liberar el reclamo. Para WhatsApp solo cuenta como intento un fallo
      // "real" (p.ej. jid inválido): ni las caídas de conexión de la cuenta
      // emisora ni la ausencia de sesiones queman intentos — con varias
      // cuentas, anySessionOpen() puede ser true mientras la emisora se cayó
      // a mitad del envío. Para canales de Meta todo fallo cuenta.
      try {
        const msg = err instanceof Error ? err.message : String(err);
        const connectionIssue = /connection closed|connection was lost|timed out|no disponible/i.test(msg);
        const countAttempt =
          item.channel === "whatsapp" ? anySessionOpen(item.org_id) && !connectionIssue : true;
        const discarded = await releaseOutboxFailure(item, countAttempt);
        if (discarded) {
          console.error(`[bot] ⚠️ Outbox #${item.id} descartado tras agotar reintentos`);
          if (item.kind === "followup" && item.conversation_id != null) {
            try {
              await markFollowUpFailed(item.conversation_id, item.scheduled_at);
            } catch (fuErr) {
              console.error(`[bot] No se pudo registrar el fallo del seguimiento:`, fuErr);
            }
          }
        }
      } catch (relErr) {
        // Queda en sent=3; el reset del próximo arranque lo devuelve a pendiente.
        console.error(`[bot] No se pudo liberar outbox #${item.id}:`, relErr);
      }
      continue;
    }

    console.log(
      `[bot] → Outbox #${item.id}${item.kind === "notify" ? " (aviso a vendedor)" : ""} enviado a ${item.phone}`
    );
    try {
      await markOutboxSent(item.id);
    } catch (err) {
      // El mensaje YA salió: no debe reenviarse aunque el marcado falle.
      sentUnrecorded.add(item.id);
      console.error(
        `[bot] ⚠️ Outbox #${item.id} se envió pero no se pudo marcar como enviado; se reintentará solo el marcado:`,
        err
      );
    }

    // Seguimiento programado (CRM): al entregarse recién se refleja en el
    // hilo del dashboard y se limpia el recordatorio del lead. Los 'manual'
    // ya fueron insertados en messages por la API; los 'notify' son avisos
    // internos y NUNCA tocan el hilo del cliente.
    if (item.kind === "followup" && item.conversation_id != null) {
      console.log(`[bot] ⏰ Seguimiento programado entregado a ${item.phone}`);
      const f: FollowupFinalize = {
        conversationId: item.conversation_id,
        content: item.content,
        scheduledAt: item.scheduled_at,
        messageInserted: false,
        attempts: 0,
      };
      pendingFinalize.set(item.id, f);
      try {
        await finalizeFollowup(item.id, f);
      } catch (err) {
        console.error(`[bot] Finalización del seguimiento #${item.id} pendiente de reintento:`, err);
      }
    }
  }
}

async function main(): Promise<void> {
  assertEnv();
  await logLlmProvider();

  // Verificación temprana: si el schema no está aplicado, avisar claro.
  // listWaAccounts también valida la migración de Equipo (multi-cuenta).
  try {
    await assertCrmMigration();
  } catch (err) {
    console.error(`[bot] ❌ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  let bootAccounts: WaAccount[];
  try {
    bootAccounts = await listWaAccounts();
  } catch (err) {
    console.error("[bot] ❌ No se pudo leer wa_accounts en Supabase.");
    console.error("[bot]    Re-ejecuta supabase/schema.sql completo en el SQL Editor.");
    console.error(`[bot]    Detalle: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Filas que quedaron 'enviando' si el proceso murió a mitad de una entrega.
  try {
    await resetInFlightOutbox();
  } catch (err) {
    console.warn("[bot] No se pudo resetear el outbox en vuelo:", err);
  }
  try {
    await resetInFlightEmails();
  } catch (err) {
    console.warn("[bot] No se pudo resetear la cola de correos en vuelo:", err);
  }

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

  // Tick único cada 2s: ciclo de vida de sesiones + señales + outbox +
  // correos. El flag `ticking` evita que un tick lento se solape.
  let ticking = false;
  setInterval(async () => {
    if (ticking) return;
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
        await refreshInternalPhones(accounts);
        await reconcileSessions(masterByOrg, accounts);
      } catch {
        /* siguiente tick */
      }

      // Alarmas vencidas → encolan avisos (outbox notify / email_queue).
      await flushAlarms(settingsByOrg);

      // El outbox corre SIEMPRE: los canales de Meta no dependen de Baileys.
      await flushOutbox(settingsByOrg);

      // Cola de correos (Mailing), con límites por organización.
      if (settingsByOrg) await flushEmailQueue(settingsByOrg);
    } catch (err) {
      console.error("[bot] Error en tick de outbox/señales:", err);
    } finally {
      ticking = false;
    }
  }, 2000);

  console.log("[bot] Loop de sesiones + outbox multicanal activo (cada 2s)");
}

async function stop(signal: string): Promise<void> {
  console.log(`\n[bot] ${signal} recibido, cerrando...`);
  try {
    // Sin logout: las sesiones siguen vivas en WhatsApp y el próximo
    // arranque NO pide QR.
    await Promise.all(getAllSessions().map((s) => s.stop({ logout: false })));
  } catch {
    /* noop */
  }
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

main().catch((err) => {
  console.error("[bot] Error fatal:", err);
  process.exit(1);
});
