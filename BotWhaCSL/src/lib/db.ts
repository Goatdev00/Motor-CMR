// Capa de datos sobre Supabase (Postgres).
// Reemplaza al better-sqlite3 del diseño original: todos los helpers son
// async y la "memoria compartida" entre el proceso bot y el de Next.js
// es la base remota (wa_accounts + outbox).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { WebSocketLikeConstructor } from "@supabase/realtime-js";
import { WebSocket as NodeWebSocket } from "ws";
import type { Channel } from "./channels";

export type ConversationMode = "AI" | "HUMAN";
export type MessageRole = "user" | "assistant" | "human";
export type ConnectionStatus = "disconnected" | "qr" | "connecting" | "connected";

export type LeadStage =
  | "NUEVO"
  | "CONTACTADO"
  | "CALIFICADO"
  | "PROPUESTA"
  | "GANADO"
  | "PERDIDO";

export const LEAD_STAGES: LeadStage[] = [
  "NUEVO",
  "CONTACTADO",
  "CALIFICADO",
  "PROPUESTA",
  "GANADO",
  "PERDIDO",
];

export interface Conversation {
  id: number;
  // Canal por el que habla este lead; external_id es su identificador en el
  // canal (teléfono en WhatsApp — Baileys o Cloud API —, correo en 'api').
  channel: Channel;
  external_id: string | null;
  phone: string | null;
  name: string | null;
  mode: ConversationMode;
  last_message_at: number | null;
  created_at: number;
  // ── CRM ──
  stage: LeadStage;
  lead_score: number | null;
  deal_value: number | null;
  company: string | null;
  email: string | null;
  tags: string[];
  ai_summary: string | null;
  ai_next_step: string | null;
  ai_suggested_stage: string | null;
  ai_analyzed_at: number | null;
  next_follow_up_at: number | null;
  follow_up_note: string | null;
  last_user_message_at: number | null;
  stage_changed_at: number | null;
  // ── Equipo ──
  assigned_member_id: number | null;
  // Cuenta de WhatsApp por la que habla este lead (última que recibió su
  // mensaje). Null en WhatsApp Cloud API o datos previos a la migración.
  wa_account_id: number | null;
  // ── Multi-organización ──
  // Organización (cliente de la agencia) dueña de este lead.
  org_id: number;
}

// Organización = espacio aislado en la base de datos (canales, chats, CRM,
// equipo, plantillas, agentes). En esta instalación existe una sola: la 1,
// la de la empresa dueña del dashboard.
export const AGENCY_ORG_ID = 1;

export interface LeadNote {
  id: number;
  conversation_id: number;
  content: string;
  created_at: number;
}

export interface LeadEvent {
  id: number;
  conversation_id: number;
  type: string;
  detail: string;
  created_at: number;
}

export interface QuickReply {
  id: number;
  title: string;
  content: string;
  created_at: number;
}

export interface ConversationWithPreview extends Conversation {
  last_message_preview: string | null;
  // Rol del último mensaje del hilo; 'user' = el lead espera respuesta.
  last_message_role: MessageRole | null;
  assigned_member_name: string | null;
}

export interface Message {
  id: number;
  conversation_id: number;
  role: MessageRole;
  content: string;
  created_at: number;
  // Id del mensaje en su canal (key.id de Baileys, wamid de Meta, o el id
  // que el bot generó al enviar). Null en filas previas a la migración.
  channel_msg_id?: string | null;
  // Cuándo lo escribió el cliente según el canal (solo entrantes).
  sent_at?: number | null;
  // Respuestas del bot: último mensaje del cliente que esa respuesta vio.
  covers_msg_id?: number | null;
}

// Cuenta de WhatsApp (multi-sesión Baileys): el bot mantiene una sesión por
// cuenta habilitada y escribe aquí su estado.
export interface WaAccount {
  id: number;
  label: string;
  status: ConnectionStatus;
  qr_string: string | null;
  phone: string | null;
  enabled: boolean;
  restart_requested: boolean;
  created_at: number;
  updated_at: number;
  org_id: number;
}

export type TeamRole = "ADMIN" | "SUPERVISOR" | "VENDEDOR";
export const TEAM_ROLES: TeamRole[] = ["ADMIN", "SUPERVISOR", "VENDEDOR"];

export interface TeamMember {
  id: number;
  name: string;
  role: TeamRole;
  wa_account_id: number | null;
  notify_phone: string | null;
  active: boolean;
  // Usuario de acceso al dashboard (null = sin acceso). El password_hash
  // NUNCA sale de esta capa: los selects son explícitos sin esa columna.
  username: string | null;
  created_at: number;
  // Organización a la que pertenece (y cuyo espacio ve al entrar).
  org_id: number;
}

// Columnas públicas de team_members (todas menos password_hash).
const TEAM_MEMBER_COLUMNS =
  "id, name, role, wa_account_id, notify_phone, active, username, created_at, org_id";

export interface OutboxItem {
  id: number;
  // Null en avisos internos sin lead (p.ej. alarmas a un miembro del equipo).
  conversation_id: number | null;
  // Destinatario en su canal: teléfono (WhatsApp por Baileys o Cloud API).
  phone: string;
  channel: Channel;
  content: string;
  sent: number;
  attempts: number;
  // 'manual': mensaje humano ya insertado en messages al hacer POST.
  // 'followup': programado; el bot inserta el mensaje al momento de enviarlo.
  // 'notify': aviso interno a un vendedor; NUNCA se inserta en el hilo.
  // 'bot': respuesta de la IA que no se pudo entregar en el momento; el bot
  // la inserta en el hilo (rol 'assistant') recién al entregarla.
  // 'bot_fixed': ídem para respuestas deterministas (palabra clave, acuse
  // de derivación), que siguen valiendo aunque la conversación esté en
  // modo HUMANO.
  kind: "manual" | "followup" | "notify" | "bot" | "bot_fixed";
  // Respuestas del bot en cola: último mensaje del cliente que cubren.
  covers_msg_id?: number | null;
  // Respuestas del bot en cola: id con el que se intentó enviar en vivo. Se
  // reutiliza al entregarla (WhatsApp descarta el duplicado si el intento en
  // vivo sí había salido) y hace idempotente el encolado.
  channel_msg_id?: string | null;
  // Respuestas del bot en cola: número de la cuenta al que escribió el
  // cliente. Si la cuenta se re-vinculó a otro número, no sale.
  account_phone?: string | null;
  scheduled_at: number | null;
  // Cuenta de WhatsApp explícita para este envío (null = resolver al enviar).
  wa_account_id: number | null;
  created_at: number;
  // Organización del envío: decide con QUÉ tokens/cuentas sale.
  org_id: number;
}

// Singleton perezoso: no crea el cliente en tiempo de import (permite que
// `next build` corra sin variables de entorno) y falla con mensaje claro
// en el primer uso real si faltan.
let client: SupabaseClient | null = null;
const DB_REQUEST_TIMEOUT_MS = 20_000;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY. " +
        "Copia .env.example a .env.local y completa los valores."
    );
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Tope por petición: una conexión colgada (red inestable) no debe
    // bloquear una cola indefinidamente; withDbRetry reintenta.
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(DB_REQUEST_TIMEOUT_MS)])
            : AbortSignal.timeout(DB_REQUEST_TIMEOUT_MS),
        }),
    },
    // Node < 22 no trae WebSocket nativo y supabase-js lanza
    // "Node.js detected but native WebSocket not found" al crear el cliente
    // (aunque no usemos Realtime). Se le pasa la implementación de `ws`
    // (compatible en runtime; el cast salva la diferencia de firmas TS).
    realtime: { transport: NodeWebSocket as unknown as WebSocketLikeConstructor },
  });
  return client;
}

function epoch(): number {
  return Math.floor(Date.now() / 1000);
}

// El error conserva el código (SQLSTATE de Postgres o PGRSTxxx de PostgREST)
// y los detalles: sin ellos, una caída real de Supabase ("Database
// connection error", Postgres reiniciando) se confundía con un error de
// datos y no se reintentaba.
type DbErrorLike = { message?: string; code?: string; details?: string | null };

function fail(context: string, err: string | DbErrorLike): never {
  if (typeof err === "string") throw new Error(`Supabase (${context}): ${err}`);
  const code = err.code ? ` [${err.code}]` : "";
  const details = err.details ? ` — ${String(err.details).slice(0, 200)}` : "";
  throw new Error(`Supabase (${context}): ${err.message ?? ""}${code}${details}`);
}

// ── Errores transitorios y reintentos ───────────────────────
// supabase-js solo reintenta los GET ante errores de red: los inserts, RPCs
// y updates fallan a la primera ("TypeError: fetch failed"). withDbRetry los
// reintenta con backoff SOLO si el error es de red o de disponibilidad del
// servidor — nunca ante errores de datos (reintentar un unique_violation no
// lo arregla).
const TRANSIENT_DB_ERROR = new RegExp(
  [
    // Red / cliente HTTP
    "fetch failed|network|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR|\\bterminated\\b|timed? ?out|timing out|aborted|AbortError|TimeoutError",
    // Gateway / Kong / PostgREST reiniciando
    "Bad Gateway|Service Unavailable|Gateway Time-?out|Too Many Requests|rate limit|upstream|ring-balancer|Retrying",
    // Postgres no disponible (reinicio, arranque, sin conexiones)
    "terminating connection|starting up|shutting down|too many connections|connection (?:refused|reset|closed)",
    // Códigos: PostgREST sin base (PGRST000-003), SQLSTATE de conexión (08),
    // recursos (53), operador (57P0x, 57014) y conflictos de serialización.
    "\\[(?:PGRST00[0-3]|08\\w{3}|53\\w{3}|57P0[1-3]|57014|40001|40P01)\\]",
  ].join("|"),
  "i"
);
// Respuesta 5xx sin cuerpo: supabase-js deja el mensaje vacío.
const EMPTY_DB_ERROR = /^Supabase \([^)]*\):\s*(?:\[|$)/;

export function isTransientDbError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}`
      : String(err);
  return TRANSIENT_DB_ERROR.test(msg) || (err instanceof Error && EMPTY_DB_ERROR.test(err.message));
}

// Error de DATOS (no de red): reintentarlo nunca lo arregla. Clases SQLSTATE
// 22 (dato inválido) y 23 (restricción), salvo el unique_violation.
export function isDataError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\[23505\]/.test(msg)) return false;
  return /\[(?:22\w{3}|23\w{3})\]|violates|invalid input syntax|value too long|null value in column/i.test(msg);
}

export async function withDbRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number; label?: string } = {}
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8000;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !isTransientDbError(err)) throw err;
      const delay = Math.min(max, base * 2 ** (i - 1));
      if (opts.label) {
        console.warn(
          `[db] ${opts.label}: error transitorio (intento ${i}/${attempts}), reintento en ${delay}ms —`,
          err instanceof Error ? err.message : err
        );
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ¿La función RPC no existe en la base? (migración de schema.sql sin correr)
function isMissingFunction(error: { code?: string; message?: string }, fn: string): boolean {
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return !!error.message?.includes(fn) && /could not find|does not exist|schema cache/i.test(error.message);
}

// Las RPC de la sección "BLINDAJE" de schema.sql: si la base aún no las
// tiene se usa el camino compatible y se vuelve a probar cada 5 min —
// ejecutar la migración las activa sin reiniciar nada.
const MIGRATION_RETRY_MS = 5 * 60_000;
const missingRpcSince = new Map<string, number>();

function shouldTryRpc(fn: string): boolean {
  const since = missingRpcSince.get(fn);
  return since === undefined || Date.now() - since > MIGRATION_RETRY_MS;
}

function markRpcMissing(fn: string): void {
  if (!missingRpcSince.has(fn)) {
    console.warn(
      `[db] ⚠️ La base no tiene ${fn} (sección "BLINDAJE" de supabase/schema.sql): ` +
        "se usa el modo compatible. Ejecuta esa sección en el SQL Editor de Supabase."
    );
  }
  missingRpcSince.set(fn, Date.now());
}

// ── Conversaciones ──────────────────────────────────────────

export async function getOrCreateConversation(
  orgId: number,
  channel: Channel,
  externalId: string,
  // mode: solo al CREARLA (p.ej. HUMANO si la inició un asesor).
  opts?: { name?: string | null; phone?: string | null; mode?: ConversationMode }
): Promise<Conversation> {
  const sb = getSupabase();

  const { data: existing, error: selError } = await sb
    .from("conversations")
    .select("*")
    .eq("org_id", orgId)
    .eq("channel", channel)
    .eq("external_id", externalId)
    .maybeSingle();
  if (selError) fail("select conversation", selError);

  if (existing) {
    // Actualiza el nombre solo si llegó uno y aún no teníamos.
    if (opts?.name && !existing.name) {
      const { data: updated } = await sb
        .from("conversations")
        .update({ name: opts.name })
        .eq("id", existing.id)
        .select()
        .single();
      return (updated ?? { ...existing, name: opts.name }) as Conversation;
    }
    return existing as Conversation;
  }

  const { data: created, error: insError } = await sb
    .from("conversations")
    .insert({
      org_id: orgId,
      channel,
      external_id: externalId,
      phone: opts?.phone ?? null,
      name: opts?.name ?? null,
      ...(opts?.mode ? { mode: opts.mode } : {}),
    })
    .select()
    .single();

  if (insError) {
    // 23505 = unique_violation: otro proceso la creó entre el SELECT y el
    // INSERT (carrera bot vs webhook). Releer y devolver la existente.
    if (insError.code === "23505") {
      const { data: retry, error: retryError } = await sb
        .from("conversations")
        .select("*")
        .eq("org_id", orgId)
        .eq("channel", channel)
        .eq("external_id", externalId)
        .single();
      if (retryError || !retry) fail("retry select conversation", retryError?.message ?? "no encontrada");
      return retry as Conversation;
    }
    fail("insert conversation", insError);
  }
  return created as Conversation;
}

// orgId (opcional): si se pasa, la conversación debe pertenecer a esa
// organización — las rutas del dashboard SIEMPRE deben pasarlo para que un
// usuario no alcance leads de otro cliente por id.
export async function getConversationById(
  id: number,
  orgId?: number
): Promise<Conversation | null> {
  const sb = getSupabase();
  let query = sb.from("conversations").select("*").eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { data, error } = await query.maybeSingle();
  if (error) fail("select conversation by id", error);
  return (data as Conversation | null) ?? null;
}

// Busca SIN crear (p.ej. mensajes que el equipo escribe desde el teléfono
// del negocio: se registran solo en leads que ya existen).
export async function findConversation(
  orgId: number,
  channel: Channel,
  externalId: string
): Promise<Conversation | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("conversations")
    .select("*")
    .eq("org_id", orgId)
    .eq("channel", channel)
    .eq("external_id", externalId)
    .maybeSingle();
  if (error) fail("find conversation", error);
  return (data as Conversation | null) ?? null;
}

export async function listConversations(orgId: number): Promise<ConversationWithPreview[]> {
  const sb = getSupabase();
  const { data, error } = await sb.rpc("list_conversations", { p_org_id: orgId });
  if (error) fail("list_conversations", error);
  return (data ?? []) as ConversationWithPreview[];
}

export async function setMode(conversationId: number, mode: ConversationMode): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("conversations")
    .update({ mode })
    .eq("id", conversationId);
  if (error) fail("set mode", error);
}

export async function deleteConversation(id: number): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.rpc("delete_conversation", { p_id: id });
  if (error) fail("delete_conversation", error);
}

// ── Mensajes ────────────────────────────────────────────────

// Atómico vía función Postgres: insert + UPDATE last_message_at.
export async function insertMessage(
  conversationId: number,
  role: MessageRole,
  content: string
): Promise<Message> {
  const sb = getSupabase();
  const { data, error } = await sb.rpc("insert_message", {
    p_conversation_id: conversationId,
    p_role: role,
    p_content: content,
  });
  if (error) fail("insert_message", error);
  return data as Message;
}

export interface InsertMessageResult {
  message: Message;
  // false = ya estaba guardado (re-entrega del canal o reintento tras un
  // corte en el que el insert sí se aplicó pero la respuesta se perdió).
  inserted: boolean;
}

// Insert IDEMPOTENTE por (conversación, id del mensaje en su canal). Guarda
// además la hora del canal (sentAt: cuándo escribió el cliente) y, en las
// respuestas del bot, hasta qué mensaje del cliente cubren (coversMsgId).
// Sin la migración "BLINDAJE" cae a insert_message (sin esas garantías).
export async function insertMessageIdempotent(
  conversationId: number,
  role: MessageRole,
  content: string,
  opts: {
    channelMsgId?: string | null;
    createdAt?: number | null;
    sentAt?: number | null;
    coversMsgId?: number | null;
  } = {}
): Promise<InsertMessageResult> {
  const sb = getSupabase();
  if (shouldTryRpc("insert_message_v2")) {
    const { data, error } = await sb.rpc("insert_message_v2", {
      p_conversation_id: conversationId,
      p_role: role,
      p_content: content,
      p_channel_msg_id: opts.channelMsgId ?? null,
      p_created_at: opts.createdAt ?? null,
      p_sent_at: opts.sentAt ?? null,
      p_covers_msg_id: opts.coversMsgId ?? null,
    });
    if (!error) {
      missingRpcSince.delete("insert_message_v2");
      const result = data as { message: Message; inserted: boolean };
      return { message: result.message, inserted: result.inserted };
    }
    if (!isMissingFunction(error, "insert_message_v2")) fail("insert_message_v2", error);
    markRpcMissing("insert_message_v2");
  }
  // Modo compatible: sin channel_msg_id, un mensaje automático del teléfono
  // del negocio ('auto:<id>') quedaría como un 'human' más y el motor lo
  // tomaría por la respuesta de un asesor (el mensaje del cliente que lo
  // disparó nunca se respondería). Sin la migración no se guarda.
  if (role === "human" && opts.channelMsgId?.startsWith("auto:")) {
    return { message: null as unknown as Message, inserted: false };
  }
  return { message: await insertMessage(conversationId, role, content), inserted: true };
}

// Últimos N mensajes en orden cronológico ASCENDENTE.
// Consulta DESC con límite + reverse en JS: usa el índice y evita
// ordenar toda la tabla.
export async function getMessages(conversationId: number, limit = 50): Promise<Message[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) fail("get messages", error);
  return ((data ?? []) as Message[]).reverse();
}

export async function getRecentHistory(conversationId: number, limit = 20): Promise<Message[]> {
  return getMessages(conversationId, limit);
}

// ── Cuentas de WhatsApp (buzón bot ↔ dashboard) ─────────────

// orgId: filtra por organización (dashboard). Sin orgId devuelve TODAS —
// solo el proceso bot, que atiende las cuentas de todos los clientes.
export async function listWaAccounts(orgId?: number): Promise<WaAccount[]> {
  const sb = getSupabase();
  let query = sb.from("wa_accounts").select("*");
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { data, error } = await query.order("id", { ascending: true });
  if (error) fail("list wa_accounts", error);
  return (data ?? []) as WaAccount[];
}

export async function createWaAccount(orgId: number, label: string): Promise<WaAccount> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("wa_accounts")
    .insert({ label, org_id: orgId })
    .select()
    .single();
  if (error) fail("create wa_account", error);
  return data as WaAccount;
}

// PRESERVA los campos no provistos (mismo contrato que tenía
// setConnectionState): pasar solo {status: 'connecting'} NO borra el
// qr_string previo; solo `null` explícito borra.
export async function updateWaAccount(
  id: number,
  patch: {
    label?: string;
    enabled?: boolean;
    status?: ConnectionStatus;
    qr_string?: string | null;
    phone?: string | null;
    restart_requested?: boolean;
  },
  // Las rutas del dashboard lo pasan (aislamiento); el bot opera por id.
  orgId?: number
): Promise<void> {
  const sb = getSupabase();
  const update: Record<string, unknown> = { updated_at: epoch() };
  if (patch.label !== undefined) update.label = patch.label;
  if (patch.enabled !== undefined) update.enabled = patch.enabled;
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.qr_string !== undefined) update.qr_string = patch.qr_string;
  if (patch.phone !== undefined) update.phone = patch.phone;
  if (patch.restart_requested !== undefined) update.restart_requested = patch.restart_requested;
  let query = sb.from("wa_accounts").update(update).eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { error } = await query;
  if (error) fail("update wa_account", error);
}

export async function deleteWaAccount(id: number, orgId?: number): Promise<void> {
  const sb = getSupabase();
  let query = sb.from("wa_accounts").delete().eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { error } = await query;
  if (error) fail("delete wa_account", error);
}

// ── Miembros del equipo ─────────────────────────────────────

// orgId: filtra por organización (dashboard). Sin orgId devuelve TODOS —
// solo el proceso bot (teléfonos internos y resolución de cuentas).
export async function listTeamMembers(orgId?: number): Promise<TeamMember[]> {
  const sb = getSupabase();
  let query = sb.from("team_members").select(TEAM_MEMBER_COLUMNS);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { data, error } = await query.order("id", { ascending: true });
  if (error) fail("list team_members", error);
  return (data ?? []) as unknown as TeamMember[];
}

export async function getTeamMemberById(id: number): Promise<TeamMember | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("team_members")
    .select(TEAM_MEMBER_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) fail("get team_member", error);
  return (data as unknown as TeamMember | null) ?? null;
}

export async function createTeamMember(
  orgId: number,
  input: {
    name: string;
    role: TeamRole;
    wa_account_id?: number | null;
    notify_phone?: string | null;
    username?: string | null;
  }
): Promise<TeamMember> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("team_members")
    .insert({
      org_id: orgId,
      name: input.name,
      role: input.role,
      wa_account_id: input.wa_account_id ?? null,
      notify_phone: input.notify_phone ?? null,
      username: input.username ?? null,
    })
    .select(TEAM_MEMBER_COLUMNS)
    .single();
  if (error) fail("create team_member", error);
  return data as unknown as TeamMember;
}

export async function updateTeamMember(
  id: number,
  patch: {
    name?: string;
    role?: TeamRole;
    wa_account_id?: number | null;
    notify_phone?: string | null;
    active?: boolean;
    username?: string | null;
  },
  orgId?: number
): Promise<TeamMember | null> {
  const sb = getSupabase();
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.role !== undefined) update.role = patch.role;
  if (patch.wa_account_id !== undefined) update.wa_account_id = patch.wa_account_id;
  if (patch.notify_phone !== undefined) update.notify_phone = patch.notify_phone;
  if (patch.active !== undefined) update.active = patch.active;
  if (patch.username !== undefined) update.username = patch.username;
  let query = sb.from("team_members").update(update).eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { data, error } = await query.select(TEAM_MEMBER_COLUMNS).maybeSingle();
  if (error) fail("update team_member", error);
  return (data as unknown as TeamMember | null) ?? null;
}

// ── Acceso (login) ──────────────────────────────────────────
// La verificación de contraseña vive en Postgres (pgcrypto/bcrypt): el hash
// jamás llega a Node. Devuelve el miembro sin password_hash, o null.
export async function loginMember(
  username: string,
  password: string
): Promise<TeamMember | null> {
  const sb = getSupabase();
  const { data, error } = await sb.rpc("login_member", {
    p_username: username,
    p_password: password,
  });
  if (error) fail("login_member", error);
  const rows = (data ?? []) as Array<TeamMember & { password_hash?: string }>;
  if (rows.length === 0) return null;
  const { password_hash: _hash, ...member } = rows[0];
  return member as TeamMember;
}

// Ids de los Admins que realmente pueden entrar (activos, con usuario Y
// contraseña). Un admin con usuario pero sin contraseña no puede loguearse:
// contarlo como "con acceso" permitía quedarse sin nadie que pudiera entrar.
export async function listAdminAccessIds(orgId: number): Promise<number[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("team_members")
    .select("id")
    .eq("org_id", orgId)
    .eq("active", true)
    .eq("role", "ADMIN")
    .not("username", "is", null)
    .not("password_hash", "is", null);
  if (error) fail("list admin access", error);
  return ((data ?? []) as { id: number }[]).map((r) => r.id);
}

export async function setMemberPassword(id: number, password: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.rpc("set_member_password", {
    p_member_id: id,
    p_password: password,
  });
  if (error) fail("set_member_password", error);
}

export async function deleteTeamMember(id: number, orgId?: number): Promise<void> {
  const sb = getSupabase();
  let query = sb.from("team_members").delete().eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { error } = await query;
  if (error) fail("delete team_member", error);
}

// Asignación de un lead (evento + aviso por WhatsApp, atómico en SQL).
export async function assignLead(
  conversationId: number,
  memberId: number | null,
  reason: string
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.rpc("assign_lead", {
    p_conversation_id: conversationId,
    p_member_id: memberId,
    p_reason: reason,
  });
  if (error) fail("assign_lead", error);
}

// La cuenta por la que habla el lead (última que recibió su mensaje).
export async function setConversationWaAccount(
  conversationId: number,
  accountId: number
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("conversations")
    .update({ wa_account_id: accountId })
    .eq("id", conversationId);
  if (error) fail("set conversation wa_account", error);
}

// ── Outbox (mensajes humanos del dashboard) ─────────────────

// Mensaje humano del dashboard: insert en messages + encolado en outbox en
// una sola transacción (función Postgres). Atómico: o queda visible Y
// encolado, o nada.
export async function insertHumanMessage(
  conversationId: number,
  content: string
): Promise<Message> {
  const sb = getSupabase();
  const { data, error } = await sb.rpc("insert_human_message", {
    p_conversation_id: conversationId,
    p_content: content,
  });
  if (error) fail("insert_human_message", error);
  return data as Message;
}

// excludeChannels: canales que ahora mismo no pueden entregar (p.ej.
// 'whatsapp' con Baileys caído) se excluyen de la consulta — si no, 20 items
// atascados de WhatsApp taparían los envíos de la Cloud API (inanición por
// el limit).
export async function getPendingOutbox(
  limit = 20,
  excludeChannels: string[] = []
): Promise<OutboxItem[]> {
  const sb = getSupabase();
  let query = sb
    .from("outbox")
    .select("*")
    .eq("sent", 0)
    // Los programados (seguimientos/backoff) solo cuando llega su hora.
    .or(`scheduled_at.is.null,scheduled_at.lte.${epoch()}`);
  if (excludeChannels.length > 0) {
    query = query.not("channel", "in", `(${excludeChannels.join(",")})`);
  }
  // Primero lo nunca diferido (por antigüedad) y después lo diferido o
  // programado, por su hora: las filas de una cuenta caída, que se difieren
  // una y otra vez, no vuelven a tapar el lote y nunca dejan sin turno a las
  // de otras cuentas, canales u organizaciones. Este orden NO es el de cada
  // destinatario (una fila nueva sin diferir va antes que una vieja
  // diferida): ese lo cuida el bot antes de enviar (olderPendingOutboxTime).
  const { data, error } = await query
    .order("scheduled_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit);
  if (error) fail("get pending outbox", error);
  return (data ?? []) as OutboxItem[];
}

export async function markOutboxSent(id: number): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from("outbox").update({ sent: 1 }).eq("id", id);
  if (error) fail("mark outbox sent", error);
}

// Reclamo condicional justo antes de enviar: pasa la fila a sent=3
// ('enviando') SOLO si sigue pendiente. Devuelve false si el operador la
// canceló/reprogramó (o borró la conversación) mientras el lote estaba en
// memoria — en ese caso NO debe enviarse.
export async function claimOutboxItem(id: number): Promise<boolean> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("outbox")
    .update({ sent: 3 })
    .eq("id", id)
    .eq("sent", 0)
    .select("id");
  if (error) fail("claim outbox", error);
  return (data ?? []).length > 0;
}

// Libera un reclamo tras un fallo de envío. Si el fallo fue "real"
// (countAttempt=true) suma un intento con BACKOFF creciente (30s × intento,
// vía scheduled_at) y al llegar a maxAttempts descarta (sent=2); sin el
// backoff, 5 ticks de 2s quemaban los intentos en ~10s ante un hipo
// transitorio de la API de Meta. Las caídas de conexión de Baileys no
// queman intentos ni esperan. Devuelve si el ítem quedó descartado y, si se
// reprogramó con backoff, hasta cuándo (epoch s).
export async function releaseOutboxFailure(
  item: OutboxItem,
  countAttempt: boolean,
  maxAttempts = 5,
  // Sin contar intento (cuenta caída): igual se pospone, para que la fila no
  // vuelva al frente del lote en cada tick y tapone a todas las demás.
  deferSeconds = 0,
  // claimed=false: la fila sigue pendiente (no se llegó a reclamar).
  opts: { claimed?: boolean } = {}
): Promise<{ discarded: boolean; retryAt: number | null }> {
  const sb = getSupabase();
  const attempts = countAttempt ? item.attempts + 1 : item.attempts;
  const discarded = attempts >= maxAttempts;
  const patch: Record<string, unknown> = { attempts, sent: discarded ? 2 : 0 };
  let retryAt: number | null = null;
  if (!discarded && countAttempt) {
    retryAt = epoch() + 30 * attempts;
    patch.scheduled_at = retryAt;
  } else if (!discarded && deferSeconds > 0) {
    retryAt = epoch() + deferSeconds;
    patch.scheduled_at = retryAt;
  }
  // Condicional (sigue 'enviando' o pendiente): si el operador canceló o
  // reprogramó la fila mientras tanto, liberar no debe revivirla.
  const { data, error } = await sb
    .from("outbox")
    .update(patch)
    .eq("id", item.id)
    .eq("sent", opts.claimed === false ? 0 : 3)
    .select("id");
  if (error) fail("release outbox", error);
  // Nada que liberar (la fila cambió por fuera): sin consecuencias.
  if ((data ?? []).length === 0) return { discarded: false, retryAt: null };
  return { discarded, retryAt };
}

// Descarta (sent=2) una fila aún pendiente. Condicional: si ya se reclamó
// o se envió, no se toca. Devuelve true si la descartó.
export async function discardOutboxItem(id: number): Promise<boolean> {
  const sb = getSupabase();
  const { data, error } = await sb.from("outbox").update({ sent: 2 }).eq("id", id).eq("sent", 0).select("id");
  if (error) fail("discard outbox", error);
  return (data ?? []).length > 0;
}

// Tras un fallo con backoff, los envíos POSTERIORES al mismo destinatario
// esperan lo mismo: si no, salían antes que el atrasado y el cliente los
// leía desordenados. Solo mensajes del operador y respuestas en cola: los
// seguimientos conservan su hora (follow_up_sent la usa para limpiar el
// recordatorio del lead).
export async function deferLaterOutboxForRecipient(item: OutboxItem, until: number): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("outbox")
    .update({ scheduled_at: until })
    .eq("org_id", item.org_id)
    .eq("channel", item.channel)
    .eq("phone", item.phone)
    .gt("id", item.id)
    .eq("sent", 0)
    .in("kind", ["manual", "bot", "bot_fixed"])
    .or(`scheduled_at.is.null,scheduled_at.lt.${until}`);
  if (error) fail("defer later outbox", error);
}

// Un envío ANTERIOR al mismo destinatario que sigue pendiente o saliendo
// (mensajes del operador y respuestas en cola, como el diferido conjunto):
// undefined = no hay; si no, la hora más tardía a la que está programado
// (null = sin hora). El bot no envía uno posterior antes que él: el orden se
// verifica contra la base, así sobrevive a un reinicio y a un diferido que no
// se pudo escribir.
export async function olderPendingOutboxTime(item: OutboxItem): Promise<number | null | undefined> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("outbox")
    .select("scheduled_at")
    .eq("org_id", item.org_id)
    .eq("channel", item.channel)
    .eq("phone", item.phone)
    .lt("id", item.id)
    .in("sent", [0, 3])
    .in("kind", ["manual", "bot", "bot_fixed"])
    .order("scheduled_at", { ascending: false, nullsFirst: false })
    .limit(1);
  if (error) fail("older pending outbox", error);
  const row = (data ?? [])[0] as { scheduled_at: number | null } | undefined;
  return row === undefined ? undefined : row.scheduled_at;
}

// Pospone una fila pendiente hasta `until` (solo si la atrasa: nunca la
// adelanta).
export async function deferOutboxUntil(id: number, until: number): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("outbox")
    .update({ scheduled_at: until })
    .eq("id", id)
    .eq("sent", 0)
    .or(`scheduled_at.is.null,scheduled_at.lt.${until}`);
  if (error) fail("defer outbox until", error);
}

// Respuestas automáticas en cola creadas antes de `before` (epoch s) y aún
// pendientes: las que vencieron sin que el bot llegara a intentarlas.
export async function listStaleBotReplies(before: number, limit = 50): Promise<OutboxItem[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("outbox")
    .select("*")
    .eq("sent", 0)
    .in("kind", ["bot", "bot_fixed"])
    .lt("created_at", before)
    .order("id", { ascending: true })
    .limit(limit);
  if (error) fail("stale bot replies", error);
  return (data ?? []) as OutboxItem[];
}

// Estado actual de una fila del outbox (null si ya no existe).
export async function getOutboxSentState(id: number): Promise<number | null> {
  const sb = getSupabase();
  const { data, error } = await sb.from("outbox").select("sent").eq("id", id).maybeSingle();
  if (error) fail("outbox state", error);
  return (data as { sent: number } | null)?.sent ?? null;
}

// Devuelve a pendiente una fila que quedó 'enviando' sin dueño (reclamo cuya
// respuesta se perdió en un corte): condicional, solo si sigue en 3.
export async function unclaimOutboxItem(id: number): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from("outbox").update({ sent: 0 }).eq("id", id).eq("sent", 3);
  if (error) fail("unclaim outbox", error);
}

// Respuesta automática que no se pudo entregar en el momento (socket caído
// más allá de la espera, Graph API caída): queda en el outbox con la cuenta
// por la que escribió el cliente, y el tick la entrega cuando el canal
// vuelva — recién ahí se inserta en el hilo como 'assistant'.
// Requiere la migración "BLINDAJE": sin covers_msg_id una respuesta en cola
// no dice qué mensaje del cliente responde, y ni el outbox al entregarla ni
// el motor tras un reinicio pueden saber qué quedó sin responder. Sin ella no
// se encola (QUEUE_UNSUPPORTED): el motor reintenta en vivo y, si el canal
// sigue caído, la conversación pasa a un asesor.
const BLINDAJE_OUTBOX_COLUMNS = ["covers_msg_id", "channel_msg_id", "account_phone"];

export class QueueUnsupportedError extends Error {
  readonly code = "QUEUE_UNSUPPORTED";
}

export async function enqueueBotReply(
  conversationId: number,
  content: string,
  waAccountId: number | null,
  opts: {
    kind?: "bot" | "bot_fixed";
    coversMsgId?: number | null;
    // Id con el que se intentó en vivo: idempotencia del encolado y del envío.
    channelMsgId?: string | null;
    // Número de la cuenta al que escribió el cliente.
    accountPhone?: string | null;
  } = {}
): Promise<void> {
  const sb = getSupabase();
  const conv = await getConversationById(conversationId);
  if (!conv) fail("enqueue bot reply", `conversation ${conversationId} no existe`);
  const recipient = conv.external_id ?? conv.phone;
  if (!recipient) fail("enqueue bot reply", `conversation ${conversationId} sin destinatario`);
  const row: Record<string, unknown> = {
    conversation_id: conversationId,
    phone: recipient,
    content,
    channel: conv.channel,
    org_id: conv.org_id,
    kind: opts.kind ?? "bot",
    wa_account_id: waAccountId ?? conv.wa_account_id,
  };
  // Siempre presentes (aunque sean null): sin la migración el insert falla
  // por la columna y no queda ninguna fila a medias.
  row.covers_msg_id = opts.coversMsgId ?? null;
  row.channel_msg_id = opts.channelMsgId ?? null;
  row.account_phone = opts.accountPhone ?? null;
  const { error } = await sb.from("outbox").insert(row);
  if (!error) return;
  // Reintento de un encolado que SÍ se había aplicado (la respuesta se
  // perdió en un corte): ya está en la cola y no se duplica.
  if (error.code === "23505" && row.channel_msg_id) return;
  if (BLINDAJE_OUTBOX_COLUMNS.some((c) => isMissingColumn(error, c) && (error.message ?? "").includes(c))) {
    throw new QueueUnsupportedError(
      "sin la migración BLINDAJE (supabase/schema.sql) las respuestas automáticas no se pueden dejar en cola"
    );
  }
  fail("enqueue bot reply", error);
}

// Filas de un rol en la conversación con la marca del canal (para distinguir
// envíos automáticos). Sin la migración "BLINDAJE" la columna no existe: se
// leen sin ella y toda fila 'human' cuenta como una persona (mejor de más
// que de menos: en la duda, el bot no habla encima).
async function roleRows(
  conversationId: number,
  roles: MessageRole[],
  filter: { sinceCreatedAt?: number; beforeCreatedAt?: number; afterId?: number; beforeId?: number },
  context: string
): Promise<{ role: MessageRole; channel_msg_id?: string | null }[]> {
  const sb = getSupabase();
  const query = (columns: string) => {
    let q = sb.from("messages").select(columns).eq("conversation_id", conversationId).in("role", roles);
    if (filter.sinceCreatedAt !== undefined) q = q.gte("created_at", filter.sinceCreatedAt);
    if (filter.beforeCreatedAt !== undefined) q = q.lt("created_at", filter.beforeCreatedAt);
    if (filter.afterId !== undefined) q = q.gt("id", filter.afterId);
    if (filter.beforeId !== undefined) q = q.lt("id", filter.beforeId);
    return q.limit(50);
  };
  const { data, error } = await query("id, role, channel_msg_id");
  if (!error) return (data ?? []) as unknown as { role: MessageRole; channel_msg_id?: string | null }[];
  if (!isMissingColumn(error, "channel_msg_id")) fail(context, error);
  const compat = await query("id, role");
  if (compat.error) fail(context, compat.error);
  return (compat.data ?? []) as unknown as { role: MessageRole }[];
}

const isPerson = (m: { role: MessageRole; channel_msg_id?: string | null }) =>
  m.role === "human" && !isAutomatedMessageId(m.channel_msg_id);

// ¿Un asesor escribió en la conversación desde `since` (epoch s)? Los
// seguimientos programados y los mensajes automáticos del teléfono del
// negocio no cuentan: no son una persona atendiendo.
export async function hasHumanReplySince(conversationId: number, since: number): Promise<boolean> {
  return (await roleRows(conversationId, ["human"], { sinceCreatedAt: since }, "human reply since")).some(isPerson);
}

// ¿Un asesor escribió DESPUÉS del mensaje `afterMsgId` (p.ej. el del cliente
// que cubre una respuesta automática)?
export async function hasHumanReplyAfter(conversationId: number, afterMsgId: number): Promise<boolean> {
  return (await roleRows(conversationId, ["human"], { afterId: afterMsgId }, "human reply after")).some(isPerson);
}

// ¿El negocio (bot o una persona) escribió en los `windowS` segundos ANTES
// del mensaje del cliente cuyo id en el canal es `customerChannelMsgId`? Sin
// respuestas en ese lapso, ese mensaje ABRE la conversación (como cuenta
// WhatsApp Business para mandar su bienvenida). Se ancla en la posición del
// mensaje en el hilo, no en relojes. Si no se lo encuentra (aún no está
// guardado, o la base no tiene la migración "BLINDAJE" y no guarda ids del
// canal), cuenta lo anterior a la hora en que el cliente lo escribió
// (`customerSentAt`): la respuesta del bot a ESE mensaje, si ya se guardó,
// no lo vuelve una conversación "en curso".
export async function hasBusinessReplyBefore(
  conversationId: number,
  customerChannelMsgId: string | null,
  windowS: number,
  customerSentAt: number | null = null
): Promise<boolean> {
  const sb = getSupabase();
  let anchor: { id: number; created_at: number } | null = null;
  if (customerChannelMsgId) {
    const { data, error } = await sb
      .from("messages")
      .select("id, created_at")
      .eq("conversation_id", conversationId)
      .eq("channel_msg_id", customerChannelMsgId)
      .maybeSingle();
    if (error && !isMissingColumn(error, "channel_msg_id")) fail("customer message", error);
    if (!error && data) anchor = data as { id: number; created_at: number };
  }
  const until = anchor ? undefined : (customerSentAt ?? undefined);
  const rows = await roleRows(
    conversationId,
    ["assistant", "human"],
    {
      sinceCreatedAt: (anchor?.created_at ?? until ?? epoch()) - windowS,
      beforeCreatedAt: until,
      beforeId: anchor?.id,
    },
    "business reply before"
  );
  return rows.some((m) => m.role === "assistant" || isPerson(m));
}

// Textos que ya se registraron como mensaje automático de WhatsApp Business
// en la organización (vacío sin la migración "BLINDAJE").
export async function recentAutomatedTexts(orgId: number): Promise<string[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("messages")
    .select("content, conversations!inner(org_id)")
    .like("channel_msg_id", "auto:%")
    .eq("conversations.org_id", orgId)
    .order("id", { ascending: false })
    .limit(50);
  if (error) {
    if (isMissingColumn(error, "channel_msg_id")) return [];
    fail("automated texts", error);
  }
  return ((data ?? []) as unknown as { content: string }[]).map((m) => m.content);
}

// Filas 'human' que no escribió una persona en ese momento: seguimientos
// programados (followup:<outbox>) y mensajes automáticos de WhatsApp
// Business desde el teléfono del negocio (auto:<id>).
export function isAutomatedMessageId(channelMsgId: string | null | undefined): boolean {
  return !!channelMsgId && (channelMsgId.startsWith("followup:") || channelMsgId.startsWith("auto:"));
}

function isMissingColumn(error: { code?: string; message?: string }, column: string): boolean {
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    (!!error.message?.includes(column) && /does not exist|could not find/i.test(error.message))
  );
}

// Respuestas del bot de una conversación que esperan entrega en el outbox
// (pendientes o saliendo). Sin la migración no hay covers_msg_id.
export interface QueuedBotReply {
  id: number;
  sent: number;
  kind: OutboxItem["kind"];
  created_at: number;
  covers_msg_id?: number | null;
}

export async function listQueuedBotReplies(conversationId: number): Promise<QueuedBotReply[]> {
  const sb = getSupabase();
  const query = (columns: string) =>
    sb
      .from("outbox")
      .select(columns)
      .eq("conversation_id", conversationId)
      .in("kind", ["bot", "bot_fixed"])
      .in("sent", [0, 3])
      .order("id", { ascending: true });
  const { data, error } = await query("id, sent, kind, created_at, covers_msg_id");
  if (!error) return (data ?? []) as unknown as QueuedBotReply[];
  if (!isMissingColumn(error, "covers_msg_id")) fail("queued bot replies", error);
  const compat = await query("id, sent, kind, created_at");
  if (compat.error) fail("queued bot replies", compat.error);
  return (compat.data ?? []) as unknown as QueuedBotReply[];
}

// ¿Ya hay en el hilo una respuesta del bot que cubre hasta `coversMsgId`
// (o, sin ese dato, una respuesta guardada después de `createdAfter`)?
export async function hasBotReplyCovering(
  conversationId: number,
  coversMsgId: number | null,
  createdAfter: number
): Promise<boolean> {
  const sb = getSupabase();
  if (coversMsgId !== null) {
    const { data, error } = await sb
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("role", "assistant")
      .gte("covers_msg_id", coversMsgId)
      .limit(1);
    if (!error) return (data ?? []).length > 0;
    if (!isMissingColumn(error, "covers_msg_id")) fail("bot reply covering", error);
  }
  const { data, error } = await sb
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .gt("created_at", createdAfter)
    .limit(1);
  if (error) fail("bot reply covering", error);
  return (data ?? []).length > 0;
}

export interface PendingReply {
  conversation_id: number;
  org_id: number;
  channel: Channel;
  // Último mensaje del hilo (del cliente). Null en el modo compatible.
  last_message_id: number | null;
  last_message_at: number | null;
}

// Conversaciones en modo IA cuyo último mensaje es del cliente, con
// actividad desde `since` (epoch s): el barrido del bot las retoma tras un
// reinicio o un fallo. Sin la migración "BLINDAJE" se usa un superconjunto
// por columnas — el pase de respuesta verifica el último mensaje real.
export async function listPendingAiReplies(
  since: number,
  limit = 100,
  channel: Channel | null = null
): Promise<PendingReply[]> {
  const sb = getSupabase();
  if (shouldTryRpc("pending_ai_replies")) {
    const { data, error } = await sb.rpc("pending_ai_replies", {
      p_since: since,
      p_limit: limit,
      p_channel: channel,
    });
    if (!error) {
      missingRpcSince.delete("pending_ai_replies");
      return (data ?? []) as PendingReply[];
    }
    if (!isMissingFunction(error, "pending_ai_replies")) fail("pending_ai_replies", error);
    markRpcMissing("pending_ai_replies");
  }
  // Las más recientes primero y con margen: el filtro por columnas es un
  // superconjunto y no debe dejar afuera a las recientes.
  const { data, error } = await sb
    .from("conversations")
    .select("id, org_id, channel, last_message_at, last_user_message_at")
    .eq("mode", "AI")
    .in("channel", channel ? [channel] : ["whatsapp", "whatsapp_api"])
    .gte("last_user_message_at", since)
    .order("last_user_message_at", { ascending: false })
    .limit(Math.max(limit * 5, 500));
  if (error) fail("pending replies", error);
  const rows = (data ?? []) as Array<{
    id: number;
    org_id: number;
    channel: Channel;
    last_message_at: number | null;
    last_user_message_at: number | null;
  }>;
  const candidates = rows.filter(
    (r) => r.last_user_message_at !== null && (r.last_message_at ?? 0) <= r.last_user_message_at
  );
  if (candidates.length === 0) return [];
  const { data: queued, error: queuedError } = await sb
    .from("outbox")
    .select("conversation_id")
    .in("kind", ["bot", "bot_fixed"])
    .in("sent", [0, 3])
    .in(
      "conversation_id",
      candidates.map((c) => c.id)
    );
  if (queuedError) fail("pending replies (outbox)", queuedError);
  const busy = new Set(((queued ?? []) as { conversation_id: number }[]).map((q) => q.conversation_id));
  return candidates
    .filter((c) => !busy.has(c.id))
    .slice(0, limit)
    .map((c) => ({
      conversation_id: c.id,
      org_id: c.org_id,
      channel: c.channel,
      last_message_id: null,
      last_message_at: c.last_user_message_at,
    }));
}

// Al arrancar el bot: filas que quedaron 'enviando' (sent=3) porque el
// proceso murió en medio de una entrega vuelven a pendiente.
// Difiere un envío pendiente unos segundos SIN quemar intentos. El bot lo
// usa cuando la organización del item no puede entregar ahora (sesión caída
// o canal apagado): sin esto, esos items taponaban el limit del lote y
// causaban inanición para las DEMÁS organizaciones.
export async function deferOutboxItem(id: number, seconds: number): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("outbox")
    .update({ scheduled_at: epoch() + seconds })
    .eq("id", id)
    .eq("sent", 0);
  if (error) fail("defer outbox", error);
}

// Al arrancar el bot: filas que quedaron 'enviando' (sent=3) porque el
// proceso anterior murió en medio de una entrega. WhatsApp (Baileys) vuelve
// a pendiente: el reintento sale con el MISMO id y WhatsApp descarta el
// duplicado. WhatsApp API no admite id propio y pudo haber salido: NUNCA se
// reenvía — se da por enviada y se devuelve para avisar al operador.
// settled: las de WhatsApp API (se dan por enviadas); reset: ids de las de
// WhatsApp que vuelven a pendiente.
export async function resetInFlightOutbox(): Promise<{ settled: OutboxItem[]; reset: number[] }> {
  const sb = getSupabase();
  const { data: resetRows, error } = await sb
    .from("outbox")
    .update({ sent: 0 })
    .eq("sent", 3)
    .eq("channel", "whatsapp")
    .select("id");
  if (error) fail("reset outbox in-flight", error);
  const { data, error: settleError } = await sb
    .from("outbox")
    .update({ sent: 1 })
    .eq("sent", 3)
    .neq("channel", "whatsapp")
    .select("*");
  if (settleError) fail("settle outbox in-flight", settleError);
  return {
    settled: (data ?? []) as OutboxItem[],
    reset: ((resetRows ?? []) as { id: number }[]).map((r) => r.id),
  };
}

// Mensaje del hilo con este rol y texto guardado desde `since`, o null (un
// envío del outbox que un cierre dejó a medio marcar, un mensaje repuesto
// desde el disco que el intento anterior ya había guardado). El texto se
// compara acá y no en el filtro: puede ser largo para la URL de la consulta.
export async function findMessageSince(
  conversationId: number,
  role: MessageRole,
  content: string,
  since: number
): Promise<Message | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("role", role)
    .gte("created_at", since)
    .order("id", { ascending: false })
    .limit(20);
  if (error) fail("message since", error);
  return ((data ?? []) as Message[]).find((m) => m.content === content) ?? null;
}

// ¿La tabla messages guarda el id del canal? (sección "BLINDAJE"). Sin eso
// guardar dos veces lo mismo no se deduplica. Se averigua una vez y, mientras
// falte, de nuevo cada 5 min (como las RPC).
let channelIdsProbe: { keeps: boolean; at: number } | null = null;
export async function messagesKeepChannelIds(): Promise<boolean> {
  if (channelIdsProbe && (channelIdsProbe.keeps || Date.now() - channelIdsProbe.at < MIGRATION_RETRY_MS)) {
    return channelIdsProbe.keeps;
  }
  const { error } = await getSupabase().from("messages").select("channel_msg_id").limit(1);
  if (error && !isMissingColumn(error, "channel_msg_id")) fail("messages channel ids", error);
  channelIdsProbe = { keeps: !error, at: Date.now() };
  return channelIdsProbe.keeps;
}

// ── CRM: leads ──────────────────────────────────────────────

// Campos del lead editables desde el dashboard (whitelist).
export interface LeadPatch {
  name?: string | null;
  deal_value?: number | null;
  company?: string | null;
  email?: string | null;
  tags?: string[];
  // Score manual (0-100). Comparte columna con el score de IA: fijarlo a
  // mano pisa el de IA y viceversa (el operador manda con "Analizar"/manual).
  lead_score?: number | null;
}

export async function updateLeadFields(id: number, patch: LeadPatch): Promise<Conversation> {
  const sb = getSupabase();
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.deal_value !== undefined) update.deal_value = patch.deal_value;
  if (patch.company !== undefined) update.company = patch.company;
  if (patch.email !== undefined) update.email = patch.email;
  if (patch.tags !== undefined) update.tags = patch.tags;
  if (patch.lead_score !== undefined) update.lead_score = patch.lead_score;
  if (Object.keys(update).length === 0) {
    const current = await getConversationById(id);
    if (!current) fail("update lead", "conversación no encontrada");
    return current;
  }
  const { data, error } = await sb
    .from("conversations")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  if (error) fail("update lead", error);
  return data as Conversation;
}

// Cambio de etapa atómico (actualiza + registra evento en el historial).
// route=false apaga el enrutamiento por etapa (cuando el operador cambia
// etapa y asignado en el mismo guardado, su elección manual manda).
export async function setStage(id: number, stage: LeadStage, route = true): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.rpc("set_stage", {
    p_conversation_id: id,
    p_stage: stage,
    p_route: route,
  });
  if (error) fail("set_stage", error);
}

// Aplica la regla de enrutamiento de una etapa (asignación + aviso). El
// reply-engine la usa para leads NUEVOS: la regla de la etapa NUEVO no
// tendría otro disparador (los leads nacen en NUEVO sin pasar por set_stage).
export async function routeLeadForStage(conversationId: number, stage: LeadStage): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.rpc("route_lead_for_stage", {
    p_conversation_id: conversationId,
    p_stage: stage,
  });
  if (error) fail("route_lead_for_stage", error);
}

// Resultado del análisis de IA que se persiste sobre el lead. Los datos de
// contacto detectados solo rellenan campos VACÍOS (nunca pisan lo que el
// operador escribió a mano).
export interface LeadAnalysisPatch {
  lead_score: number;
  ai_summary: string;
  ai_next_step: string;
  ai_suggested_stage: string;
  name?: string;
  company?: string;
  email?: string;
}

// Atómico vía RPC: las guardas "solo rellenar vacíos" (coalesce) y el
// auto-avance NUEVO→CONTACTADO condicional viven en SQL. Hacerlo en JS con
// read-then-write permitía que la IA pisara datos recién escritos a mano o
// revirtiera una etapa que el operador acababa de mover en el kanban.
export async function persistLeadAnalysis(id: number, patch: LeadAnalysisPatch): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.rpc("apply_lead_analysis", {
    p_conversation_id: id,
    p_score: patch.lead_score,
    p_summary: patch.ai_summary,
    p_next_step: patch.ai_next_step,
    p_suggested_stage: patch.ai_suggested_stage,
    p_name: patch.name ?? null,
    p_company: patch.company ?? null,
    p_email: patch.email ?? null,
  });
  if (error) fail("apply_lead_analysis", error);
}

// ── CRM: notas y actividad ──────────────────────────────────

export async function getLeadNotes(conversationId: number): Promise<LeadNote[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("lead_notes")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(50);
  if (error) fail("get lead notes", error);
  return (data ?? []) as LeadNote[];
}

export async function addLeadNote(conversationId: number, content: string): Promise<LeadNote> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("lead_notes")
    .insert({ conversation_id: conversationId, content })
    .select()
    .single();
  if (error) fail("add lead note", error);
  return data as LeadNote;
}

// Registra un evento en la actividad del lead (usado p.ej. por la
// derivación automática a humano).
export async function addLeadEvent(
  conversationId: number,
  type: string,
  detail: string
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("lead_events")
    .insert({ conversation_id: conversationId, type, detail });
  if (error) fail("add lead event", error);
}

// ¿Hay un evento de ese tipo en la actividad del lead desde `since` (epoch s)?
export async function hasLeadEventSince(conversationId: number, type: string, since: number): Promise<boolean> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("lead_events")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("type", type)
    .gte("created_at", since)
    .limit(1);
  if (error) fail("lead event since", error);
  return (data ?? []).length > 0;
}

export async function getLeadEvents(conversationId: number): Promise<LeadEvent[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("lead_events")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(30);
  if (error) fail("get lead events", error);
  return (data ?? []) as LeadEvent[];
}

// ── CRM: seguimientos programados ───────────────────────────

export async function scheduleFollowUp(
  conversationId: number,
  content: string,
  sendAt: number
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.rpc("schedule_follow_up", {
    p_conversation_id: conversationId,
    p_content: content,
    p_send_at: sendAt,
  });
  if (error) fail("schedule_follow_up", error);
}

export async function cancelFollowUp(conversationId: number): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.rpc("cancel_follow_up", { p_conversation_id: conversationId });
  if (error) fail("cancel_follow_up", error);
}

// El bot la llama tras entregar un seguimiento. El scheduled_at hace el
// clear del recordatorio condicional: si el operador ya reprogramó otro,
// ese nuevo recordatorio no se toca.
export async function markFollowUpSent(
  conversationId: number,
  scheduledAt: number | null
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.rpc("follow_up_sent", {
    p_conversation_id: conversationId,
    p_scheduled_at: scheduledAt,
  });
  if (error) fail("follow_up_sent", error);
}

// El bot la llama cuando un seguimiento se descarta tras agotar reintentos.
export async function markFollowUpFailed(
  conversationId: number,
  scheduledAt: number | null
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.rpc("follow_up_failed", {
    p_conversation_id: conversationId,
    p_scheduled_at: scheduledAt,
  });
  if (error) fail("follow_up_failed", error);
}

// Verificación de arranque del bot: si las migraciones CRM/multicanal no
// están aplicadas, getPendingOutbox fallaría en cada tick (o los items
// saldrían sin canal y se descartarían) y los mensajes del dashboard nunca
// llegarían, sin síntoma en la UI.
export async function assertCrmMigration(): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("outbox")
    .select("scheduled_at, channel")
    .limit(1);
  const { error: convError } = await sb
    .from("conversations")
    .select("external_id, channel")
    .limit(1);
  const { error: settingsError } = await sb.from("channel_settings").select("channel").limit(1);
  const { error: calendarError } = await sb.from("calendar_events").select("id").limit(1);
  const { error: teamError } = await sb
    .from("conversations")
    .select("assigned_member_id, wa_account_id")
    .limit(1);
  const { error: accountsError } = await sb.from("wa_accounts").select("id").limit(1);
  const { error: loginError } = await sb.from("team_members").select("username").limit(1);
  const { error: alarmsError } = await sb.from("alarms").select("id").limit(1);
  const { error: orgsError } = await sb.from("organizations").select("id").limit(1);
  const { error: orgColError } = await sb.from("conversations").select("org_id").limit(1);
  const firstError =
    error ??
    convError ??
    settingsError ??
    calendarError ??
    teamError ??
    accountsError ??
    loginError ??
    alarmsError ??
    orgsError ??
    orgColError;
  if (firstError) {
    // Solo un error de esquema (tabla/columna inexistente) significa que falta
    // la migración. Un corte de red o la base reiniciando NO: se lanza tal
    // cual (transitorio) para que el arranque espere en vez de salir con un
    // diagnóstico falso.
    const missingSchema =
      ["42P01", "42703", "PGRST200", "PGRST204", "PGRST205"].includes(firstError.code ?? "") ||
      /does not exist|schema cache|could not find/i.test(firstError.message ?? "");
    if (!missingSchema) fail("verificación de migraciones", firstError);
    throw new Error(
      "La base no tiene las migraciones CRM/multicanal al día. " +
        "Re-ejecuta supabase/schema.sql completo en el SQL Editor de Supabase. " +
        `Detalle: ${firstError.message}`
    );
  }
}

// ── Configuración de canales (editable desde el dashboard) ──

// channel_settings guarda filas por canal ('whatsapp', 'whatsapp_api') y una
// pseudo-fila 'meta_webhook' con el verify_token/app_secret del webhook de
// Meta (WhatsApp Cloud API).
export interface ChannelSettingsRow {
  channel: string;
  enabled: boolean;
  config: Record<string, string>;
  updated_at: number;
  org_id: number;
}

// Configuración de canales DE UNA organización (tokens propios del cliente).
export async function getAllChannelSettings(
  orgId: number
): Promise<Record<string, ChannelSettingsRow>> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("channel_settings")
    .select("*")
    .eq("org_id", orgId);
  if (error) fail("get channel_settings", error);
  const map: Record<string, ChannelSettingsRow> = {};
  for (const row of (data ?? []) as ChannelSettingsRow[]) map[row.channel] = row;
  return map;
}

// TODAS las filas de todas las organizaciones: la usan el bot (toggles por
// organización) y el webhook de Meta (enrutar cada evento de WhatsApp Cloud
// API a su organización por phone_number_id).
export async function listAllChannelSettings(): Promise<ChannelSettingsRow[]> {
  const sb = getSupabase();
  const { data, error } = await sb.from("channel_settings").select("*");
  if (error) fail("list channel_settings", error);
  return (data ?? []) as ChannelSettingsRow[];
}

export async function upsertChannelSettings(
  orgId: number,
  channel: string,
  enabled: boolean,
  config: Record<string, string>
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from("channel_settings").upsert(
    {
      org_id: orgId,
      channel,
      enabled,
      config,
      updated_at: epoch(),
    },
    { onConflict: "org_id,channel" }
  );
  if (error) fail("upsert channel_settings", error);
}

// ── Alarmas (renovaciones, pagos, recordatorios) ────────────

export type AlarmKind = "SUSCRIPCION" | "PAGO" | "REUNION" | "TAREA" | "OTRO";
export type AlarmRepeat = "NUNCA" | "DIARIO" | "SEMANAL" | "MENSUAL" | "ANUAL";
export const ALARM_KINDS: AlarmKind[] = ["SUSCRIPCION", "PAGO", "REUNION", "TAREA", "OTRO"];
export const ALARM_REPEATS: AlarmRepeat[] = ["NUNCA", "DIARIO", "SEMANAL", "MENSUAL", "ANUAL"];

export interface Alarm {
  id: number;
  title: string;
  message: string;
  kind: AlarmKind;
  via: "whatsapp";
  to_phone: string | null;
  conversation_id: number | null;
  next_fire_at: number;
  repeat_every: AlarmRepeat;
  active: boolean;
  last_fired_at: number | null;
  last_error: string | null;
  created_at: number;
  // Organización dueña: sus avisos salen por SUS cuentas de WhatsApp.
  org_id: number;
}

export interface AlarmDraft {
  title: string;
  message: string;
  kind: AlarmKind;
  via: "whatsapp";
  to_phone?: string | null;
  conversation_id?: number | null;
  next_fire_at: number;
  repeat_every: AlarmRepeat;
}

export async function listAlarms(orgId: number): Promise<Alarm[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("alarms")
    .select("*")
    .eq("org_id", orgId)
    .order("active", { ascending: false })
    .order("next_fire_at", { ascending: true })
    .limit(200);
  if (error) fail("list alarms", error);
  return (data ?? []) as Alarm[];
}

export async function createAlarm(orgId: number, draft: AlarmDraft): Promise<Alarm> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("alarms")
    .insert({
      org_id: orgId,
      title: draft.title,
      message: draft.message,
      kind: draft.kind,
      via: draft.via,
      to_phone: draft.to_phone ?? null,
      conversation_id: draft.conversation_id ?? null,
      next_fire_at: draft.next_fire_at,
      repeat_every: draft.repeat_every,
    })
    .select()
    .single();
  if (error) fail("create alarm", error);
  return data as Alarm;
}

export async function updateAlarm(
  id: number,
  patch: Partial<AlarmDraft> & { active?: boolean },
  orgId?: number
): Promise<Alarm | null> {
  const sb = getSupabase();
  const update: Record<string, unknown> = {};
  for (const key of [
    "title",
    "message",
    "kind",
    "via",
    "to_phone",
    "conversation_id",
    "next_fire_at",
    "repeat_every",
    "active",
  ] as const) {
    if (patch[key] !== undefined) update[key] = patch[key];
  }
  // Reprogramar o reactivar limpia el último error (arranque limpio).
  if (patch.next_fire_at !== undefined || patch.active === true) update.last_error = null;
  let query = sb.from("alarms").update(update).eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { data, error } = await query.select().maybeSingle();
  if (error) fail("update alarm", error);
  return (data as Alarm | null) ?? null;
}

export async function getAlarmById(id: number, orgId?: number): Promise<Alarm | null> {
  const sb = getSupabase();
  let query = sb.from("alarms").select("*").eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { data, error } = await query.maybeSingle();
  if (error) fail("get alarm", error);
  return (data as Alarm | null) ?? null;
}

export async function deleteAlarm(id: number, orgId?: number): Promise<void> {
  const sb = getSupabase();
  let query = sb.from("alarms").delete().eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { error } = await query;
  if (error) fail("delete alarm", error);
}

export async function getDueAlarms(limit = 10): Promise<Alarm[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("alarms")
    .select("*")
    .eq("active", true)
    .lte("next_fire_at", epoch())
    .order("next_fire_at", { ascending: true })
    .limit(limit);
  if (error) fail("get due alarms", error);
  return (data ?? []) as Alarm[];
}

// Reclamo condicional del disparo: avanza la alarma SOLO si nadie la tocó
// (mismo next_fire_at). Devuelve false si el operador la reprogramó/apagó
// mientras el lote estaba en memoria — en ese caso NO debe dispararse.
export async function claimAlarmFire(
  alarm: Alarm,
  nextFireAt: number | null
): Promise<boolean> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("alarms")
    .update({
      last_fired_at: epoch(),
      next_fire_at: nextFireAt ?? alarm.next_fire_at,
      active: nextFireAt !== null,
      last_error: null,
    })
    .eq("id", alarm.id)
    .eq("next_fire_at", alarm.next_fire_at)
    .eq("active", true)
    .select("id");
  if (error) fail("claim alarm", error);
  return (data ?? []).length > 0;
}

export async function setAlarmError(id: number, message: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("alarms")
    .update({ last_error: message.slice(0, 500) })
    .eq("id", id);
  if (error) fail("set alarm error", error);
}

// Aviso interno por WhatsApp (outbox kind='notify', sin conversación).
// orgId decide por QUÉ cuentas de WhatsApp sale el aviso.
export async function enqueueNotify(orgId: number, phone: string, content: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from("outbox").insert({
    conversation_id: null,
    phone,
    content,
    channel: "whatsapp",
    kind: "notify",
    org_id: orgId,
  });
  if (error) fail("enqueue notify", error);
}

// Lead de la API pública que llegó solo con correo (canal 'api'). Solo
// LECTURA: el correo de un formulario no está verificado, así que nunca se
// usa para reasignar ese lead (con su historial y sus notas) al WhatsApp de
// quien envíe el mismo correo — eso le entregaba los datos de una persona a
// otra. El operador decide si son el mismo contacto.
export async function findApiLeadByEmail(
  orgId: number,
  email: string
): Promise<Conversation | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("conversations")
    .select("*")
    .eq("org_id", orgId)
    .eq("channel", "api")
    .eq("external_id", email)
    .maybeSingle();
  if (error) fail("find api lead", error);
  return (data as Conversation | null) ?? null;
}

// ── Claves de la API pública del CRM ────────────────────────

export interface ApiKeyRow {
  id: number;
  label: string;
  key_prefix: string;
  active: boolean;
  last_used_at: number | null;
  created_at: number;
  // Los leads creados con esta clave nacen en esta organización.
  org_id: number;
}

// El hash jamás sale de esta capa (selects explícitos).
const API_KEY_COLUMNS = "id, label, key_prefix, active, last_used_at, created_at, org_id";

export async function listApiKeys(orgId: number): Promise<ApiKeyRow[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("api_keys")
    .select(API_KEY_COLUMNS)
    .eq("org_id", orgId)
    .order("id", { ascending: true });
  if (error) fail("list api_keys", error);
  return (data ?? []) as unknown as ApiKeyRow[];
}

export async function createApiKey(
  orgId: number,
  label: string,
  keyHash: string,
  keyPrefix: string
): Promise<ApiKeyRow> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("api_keys")
    .insert({ org_id: orgId, label, key_hash: keyHash, key_prefix: keyPrefix })
    .select(API_KEY_COLUMNS)
    .single();
  if (error) fail("create api_key", error);
  return data as unknown as ApiKeyRow;
}

export async function deleteApiKey(id: number, orgId?: number): Promise<void> {
  const sb = getSupabase();
  let query = sb.from("api_keys").delete().eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { error } = await query;
  if (error) fail("delete api_key", error);
}

export async function findApiKeyByHash(keyHash: string): Promise<ApiKeyRow | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("api_keys")
    .select(API_KEY_COLUMNS)
    .eq("key_hash", keyHash)
    .eq("active", true)
    .maybeSingle();
  if (error) fail("find api_key", error);
  return (data as unknown as ApiKeyRow | null) ?? null;
}

export async function touchApiKey(id: number): Promise<void> {
  const sb = getSupabase();
  // Best-effort: no bloquea la request si falla.
  await sb.from("api_keys").update({ last_used_at: epoch() }).eq("id", id);
}

// ── Preferencias de la app (app_settings) ───────────────────

// Preferencias POR organización (etapas, enrutamiento, plantillas de
// palabras clave, agentes de IA, credenciales de Google, responder-a...).
export async function getAppSetting<T>(orgId: number, key: string): Promise<T | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("app_settings")
    .select("value")
    .eq("org_id", orgId)
    .eq("key", key)
    .maybeSingle();
  if (error) fail("get app_settings", error);
  return (data?.value as T) ?? null;
}

export async function setAppSetting(orgId: number, key: string, value: unknown): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("app_settings")
    .upsert({ org_id: orgId, key, value, updated_at: epoch() }, { onConflict: "org_id,key" });
  if (error) fail("set app_settings", error);
}

// ── Calendario ──────────────────────────────────────────────

// Archivo de Google Drive adjunto a un evento.
export interface CalendarAttachment {
  id: string;
  name: string;
  link: string;
}

export interface CalendarEvent {
  id: number;
  title: string;
  description: string;
  location: string;
  starts_at: number;
  ends_at: number | null;
  all_day: boolean;
  color: string;
  conversation_id: number | null;
  attachments: CalendarAttachment[];
  created_at: number;
  updated_at: number;
}

export interface CalendarEventDraft {
  title: string;
  description?: string;
  location?: string;
  starts_at: number;
  ends_at?: number | null;
  all_day?: boolean;
  color?: string;
  conversation_id?: number | null;
  attachments?: CalendarAttachment[];
}

// Eventos que se solapan con [from, to): empiezan antes del fin del rango y
// terminan (o empiezan, si no tienen fin) dentro o después del inicio.
export async function listCalendarEvents(
  orgId: number,
  from: number,
  to: number
): Promise<CalendarEvent[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("calendar_events")
    .select("*")
    .eq("org_id", orgId)
    .lt("starts_at", to)
    .or(`ends_at.gte.${from},and(ends_at.is.null,starts_at.gte.${from})`)
    .order("starts_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(500);
  if (error) fail("list calendar events", error);
  return (data ?? []) as CalendarEvent[];
}

export async function createCalendarEvent(
  orgId: number,
  draft: CalendarEventDraft
): Promise<CalendarEvent> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("calendar_events")
    .insert({
      org_id: orgId,
      title: draft.title,
      description: draft.description ?? "",
      location: draft.location ?? "",
      starts_at: draft.starts_at,
      ends_at: draft.ends_at ?? null,
      all_day: draft.all_day ?? false,
      color: draft.color ?? "#34d399",
      conversation_id: draft.conversation_id ?? null,
      attachments: draft.attachments ?? [],
    })
    .select()
    .single();
  if (error) fail("create calendar event", error);
  return data as CalendarEvent;
}

// Devuelve null si el evento ya no existe (la ruta responde 404).
export async function updateCalendarEvent(
  id: number,
  patch: Partial<CalendarEventDraft>,
  orgId?: number
): Promise<CalendarEvent | null> {
  const sb = getSupabase();
  const update: Record<string, unknown> = { updated_at: epoch() };
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.description !== undefined) update.description = patch.description;
  if (patch.location !== undefined) update.location = patch.location;
  if (patch.starts_at !== undefined) update.starts_at = patch.starts_at;
  if (patch.ends_at !== undefined) update.ends_at = patch.ends_at;
  if (patch.all_day !== undefined) update.all_day = patch.all_day;
  if (patch.color !== undefined) update.color = patch.color;
  if (patch.conversation_id !== undefined) update.conversation_id = patch.conversation_id;
  if (patch.attachments !== undefined) update.attachments = patch.attachments;
  let query = sb.from("calendar_events").update(update).eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { data, error } = await query.select().maybeSingle();
  if (error) fail("update calendar event", error);
  return (data as CalendarEvent | null) ?? null;
}

export async function deleteCalendarEvent(id: number, orgId?: number): Promise<void> {
  const sb = getSupabase();
  let query = sb.from("calendar_events").delete().eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { error } = await query;
  if (error) fail("delete calendar event", error);
}

// Seguimientos programados del CRM dentro de un rango: el calendario los
// muestra como recordatorios (de solo lectura; se gestionan desde la ficha
// del lead).
export interface FollowUpEntry {
  id: number;
  name: string | null;
  phone: string | null;
  external_id: string | null;
  channel: Channel;
  next_follow_up_at: number;
  follow_up_note: string | null;
}

export async function listFollowUpsBetween(
  orgId: number,
  from: number,
  to: number
): Promise<FollowUpEntry[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("conversations")
    .select("id, name, phone, external_id, channel, next_follow_up_at, follow_up_note")
    .eq("org_id", orgId)
    .gte("next_follow_up_at", from)
    .lt("next_follow_up_at", to)
    .order("next_follow_up_at", { ascending: true })
    .limit(200);
  if (error) fail("list follow-ups", error);
  return (data ?? []) as FollowUpEntry[];
}

// ── CRM: plantillas de respuesta rápida ─────────────────────

export async function listQuickReplies(orgId: number): Promise<QuickReply[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("quick_replies")
    .select("*")
    .eq("org_id", orgId)
    .order("title", { ascending: true });
  if (error) fail("list quick replies", error);
  return (data ?? []) as QuickReply[];
}

export async function createQuickReply(
  orgId: number,
  title: string,
  content: string
): Promise<QuickReply> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("quick_replies")
    .insert({ org_id: orgId, title, content })
    .select()
    .single();
  if (error) fail("create quick reply", error);
  return data as QuickReply;
}

export async function deleteQuickReply(id: number, orgId?: number): Promise<void> {
  const sb = getSupabase();
  let query = sb.from("quick_replies").delete().eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { error } = await query;
  if (error) fail("delete quick reply", error);
}
