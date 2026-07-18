// Capa de datos sobre Supabase (Postgres).
// Reemplaza al better-sqlite3 del diseño original: todos los helpers son
// async y la "memoria compartida" entre el proceso bot y el de Next.js
// es la base remota (connection_state + outbox).
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
  // canal (teléfono en WhatsApp, PSID en Messenger, IGSID en Instagram).
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
  // mensaje). Null en canales de Meta o datos previos a la migración.
  wa_account_id: number | null;
  // ── Multi-organización ──
  // Organización (cliente de la agencia) dueña de este lead.
  org_id: number;
}

// Organización = espacio aislado de un cliente de la agencia (canales,
// chats, CRM, equipo, plantillas, agentes, colas). La organización 1 es la
// agencia dueña de la plataforma.
export const AGENCY_ORG_ID = 1;

export interface Organization {
  id: number;
  name: string;
  active: boolean;
  created_at: number;
}

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
}

// Cuenta de WhatsApp (multi-sesión Baileys). Reemplaza a connection_state:
// el bot mantiene una sesión por cuenta habilitada y escribe aquí su estado.
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
  // Destinatario en su canal: teléfono (WhatsApp) o PSID/IGSID (Meta).
  phone: string;
  channel: Channel;
  content: string;
  sent: number;
  attempts: number;
  // 'manual': mensaje humano ya insertado en messages al hacer POST.
  // 'followup': programado; el bot inserta el mensaje al momento de enviarlo.
  // 'notify': aviso interno a un vendedor; NUNCA se inserta en el hilo.
  kind: "manual" | "followup" | "notify";
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

function fail(context: string, message: string): never {
  throw new Error(`Supabase (${context}): ${message}`);
}

// ── Conversaciones ──────────────────────────────────────────

export async function getOrCreateConversation(
  orgId: number,
  channel: Channel,
  externalId: string,
  opts?: { name?: string | null; phone?: string | null }
): Promise<Conversation> {
  const sb = getSupabase();

  const { data: existing, error: selError } = await sb
    .from("conversations")
    .select("*")
    .eq("org_id", orgId)
    .eq("channel", channel)
    .eq("external_id", externalId)
    .maybeSingle();
  if (selError) fail("select conversation", selError.message);

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
    fail("insert conversation", insError.message);
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
  if (error) fail("select conversation by id", error.message);
  return (data as Conversation | null) ?? null;
}

export async function listConversations(orgId: number): Promise<ConversationWithPreview[]> {
  const sb = getSupabase();
  const { data, error } = await sb.rpc("list_conversations", { p_org_id: orgId });
  if (error) fail("list_conversations", error.message);
  return (data ?? []) as ConversationWithPreview[];
}

// ── Organizaciones (multi-cliente) ──────────────────────────

export async function listOrganizations(): Promise<Organization[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("organizations")
    .select("*")
    .order("id", { ascending: true });
  if (error) fail("list organizations", error.message);
  return (data ?? []) as Organization[];
}

export async function createOrganization(name: string): Promise<Organization> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("organizations")
    .insert({ name })
    .select()
    .single();
  if (error) fail("create organization", error.message);
  return data as Organization;
}

export async function setMode(conversationId: number, mode: ConversationMode): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("conversations")
    .update({ mode })
    .eq("id", conversationId);
  if (error) fail("set mode", error.message);
}

export async function deleteConversation(id: number): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.rpc("delete_conversation", { p_id: id });
  if (error) fail("delete_conversation", error.message);
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
  if (error) fail("insert_message", error.message);
  return data as Message;
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
  if (error) fail("get messages", error.message);
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
  if (error) fail("list wa_accounts", error.message);
  return (data ?? []) as WaAccount[];
}

export async function createWaAccount(orgId: number, label: string): Promise<WaAccount> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("wa_accounts")
    .insert({ label, org_id: orgId })
    .select()
    .single();
  if (error) fail("create wa_account", error.message);
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
  if (error) fail("update wa_account", error.message);
}

export async function deleteWaAccount(id: number, orgId?: number): Promise<void> {
  const sb = getSupabase();
  let query = sb.from("wa_accounts").delete().eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { error } = await query;
  if (error) fail("delete wa_account", error.message);
}

// ── Miembros del equipo ─────────────────────────────────────

// orgId: filtra por organización (dashboard). Sin orgId devuelve TODOS —
// solo el proceso bot (teléfonos internos y resolución de cuentas).
export async function listTeamMembers(orgId?: number): Promise<TeamMember[]> {
  const sb = getSupabase();
  let query = sb.from("team_members").select(TEAM_MEMBER_COLUMNS);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { data, error } = await query.order("id", { ascending: true });
  if (error) fail("list team_members", error.message);
  return (data ?? []) as unknown as TeamMember[];
}

export async function getTeamMemberById(id: number): Promise<TeamMember | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("team_members")
    .select(TEAM_MEMBER_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) fail("get team_member", error.message);
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
  if (error) fail("create team_member", error.message);
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
  if (error) fail("update team_member", error.message);
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
  if (error) fail("login_member", error.message);
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
  if (error) fail("list admin access", error.message);
  return ((data ?? []) as { id: number }[]).map((r) => r.id);
}

export async function setMemberPassword(id: number, password: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.rpc("set_member_password", {
    p_member_id: id,
    p_password: password,
  });
  if (error) fail("set_member_password", error.message);
}

export async function deleteTeamMember(id: number, orgId?: number): Promise<void> {
  const sb = getSupabase();
  let query = sb.from("team_members").delete().eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { error } = await query;
  if (error) fail("delete team_member", error.message);
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
  if (error) fail("assign_lead", error.message);
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
  if (error) fail("set conversation wa_account", error.message);
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
  if (error) fail("insert_human_message", error.message);
  return data as Message;
}

// excludeChannels: canales que ahora mismo no pueden entregar (p.ej.
// 'whatsapp' con Baileys caído) se excluyen de la consulta — si no, 20 items
// atascados de WhatsApp taparían los envíos de Meta (inanición por el limit).
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
  const { data, error } = await query
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit);
  if (error) fail("get pending outbox", error.message);
  return (data ?? []) as OutboxItem[];
}

export async function markOutboxSent(id: number): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from("outbox").update({ sent: 1 }).eq("id", id);
  if (error) fail("mark outbox sent", error.message);
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
  if (error) fail("claim outbox", error.message);
  return (data ?? []).length > 0;
}

// Libera un reclamo tras un fallo de envío. Si el fallo fue "real"
// (countAttempt=true) suma un intento con BACKOFF creciente (30s × intento,
// vía scheduled_at) y al llegar a maxAttempts descarta (sent=2); sin el
// backoff, 5 ticks de 2s quemaban los intentos en ~10s ante un hipo
// transitorio de la API de Meta. Las caídas de conexión de Baileys no
// queman intentos ni esperan. Devuelve true si el ítem quedó descartado.
export async function releaseOutboxFailure(
  item: OutboxItem,
  countAttempt: boolean,
  maxAttempts = 5
): Promise<boolean> {
  const sb = getSupabase();
  const attempts = countAttempt ? item.attempts + 1 : item.attempts;
  const discarded = attempts >= maxAttempts;
  const patch: Record<string, unknown> = { attempts, sent: discarded ? 2 : 0 };
  if (!discarded && countAttempt) {
    patch.scheduled_at = epoch() + 30 * attempts;
  }
  const { error } = await sb.from("outbox").update(patch).eq("id", item.id);
  if (error) fail("release outbox", error.message);
  return discarded;
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
  if (error) fail("defer outbox", error.message);
}

export async function resetInFlightOutbox(): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from("outbox").update({ sent: 0 }).eq("sent", 3);
  if (error) fail("reset outbox in-flight", error.message);
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
  if (error) fail("update lead", error.message);
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
  if (error) fail("set_stage", error.message);
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
  if (error) fail("route_lead_for_stage", error.message);
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
  if (error) fail("apply_lead_analysis", error.message);
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
  if (error) fail("get lead notes", error.message);
  return (data ?? []) as LeadNote[];
}

export async function addLeadNote(conversationId: number, content: string): Promise<LeadNote> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("lead_notes")
    .insert({ conversation_id: conversationId, content })
    .select()
    .single();
  if (error) fail("add lead note", error.message);
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
  if (error) fail("add lead event", error.message);
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
  if (error) fail("get lead events", error.message);
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
  if (error) fail("schedule_follow_up", error.message);
}

export async function cancelFollowUp(conversationId: number): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.rpc("cancel_follow_up", { p_conversation_id: conversationId });
  if (error) fail("cancel_follow_up", error.message);
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
  if (error) fail("follow_up_sent", error.message);
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
  if (error) fail("follow_up_failed", error.message);
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
  const { error: emailError } = await sb.from("email_queue").select("id").limit(1);
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
    emailError ??
    calendarError ??
    teamError ??
    accountsError ??
    loginError ??
    alarmsError ??
    orgsError ??
    orgColError;
  if (firstError) {
    throw new Error(
      "La base no tiene las migraciones CRM/multicanal al día. " +
        "Re-ejecuta supabase/schema.sql completo en el SQL Editor de Supabase. " +
        `Detalle: ${firstError.message}`
    );
  }
}

// ── Configuración de canales (editable desde el dashboard) ──

// channel_settings guarda filas por canal ('whatsapp', 'whatsapp_api',
// 'messenger', 'instagram') y una pseudo-fila 'meta_webhook' con el
// verify_token/app_secret compartidos del webhook de Meta.
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
  if (error) fail("get channel_settings", error.message);
  const map: Record<string, ChannelSettingsRow> = {};
  for (const row of (data ?? []) as ChannelSettingsRow[]) map[row.channel] = row;
  return map;
}

// TODAS las filas de todas las organizaciones: la usan el bot (toggles por
// organización) y el webhook de Meta (enrutar cada evento a su organización
// por page_id / IG user id / phone_number_id).
export async function listAllChannelSettings(): Promise<ChannelSettingsRow[]> {
  const sb = getSupabase();
  const { data, error } = await sb.from("channel_settings").select("*");
  if (error) fail("list channel_settings", error.message);
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
  if (error) fail("upsert channel_settings", error.message);
}

// ── Mailing: cola de correos ────────────────────────────────
// sent: 0 pendiente, 1 enviado, 2 fallido definitivo, 3 enviando.

export interface EmailQueueItem {
  id: number;
  to_email: string;
  to_name: string | null;
  subject: string;
  html: string;
  batch_id: string | null;
  sent: number;
  attempts: number;
  error: string | null;
  scheduled_at: number | null;
  sent_at: number | null;
  created_at: number;
  // Reply-To opcional (sección Leads). undefined si la columna aún no existe
  // en la DB (schema.sql sin re-ejecutar): el envío sale sin la cabecera.
  reply_to?: string | null;
  // Organización del envío: decide con QUÉ cuenta SMTP sale y a qué límites
  // por hora/día se descuenta.
  org_id: number;
}

export interface EmailDraft {
  to_email: string;
  to_name?: string | null;
  subject: string;
  html: string;
  batch_id?: string | null;
  reply_to?: string | null;
  org_id: number;
}

export async function enqueueEmails(drafts: EmailDraft[]): Promise<number> {
  if (drafts.length === 0) return 0;
  const sb = getSupabase();
  // Inserción por lotes (Supabase acepta arrays; 200 por tanda de sobra).
  for (let i = 0; i < drafts.length; i += 200) {
    const chunk = drafts.slice(i, i + 200);
    const { error } = await sb.from("email_queue").insert(chunk);
    if (error) fail("enqueue emails", error.message);
  }
  return drafts.length;
}

export async function getPendingEmails(limit: number): Promise<EmailQueueItem[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("email_queue")
    .select("*")
    .eq("sent", 0)
    .or(`scheduled_at.is.null,scheduled_at.lte.${epoch()}`)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit);
  if (error) fail("get pending emails", error.message);
  return (data ?? []) as EmailQueueItem[];
}

// Reclamo condicional (mismo patrón que el outbox de mensajes).
export async function claimEmail(id: number): Promise<boolean> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("email_queue")
    .update({ sent: 3 })
    .eq("id", id)
    .eq("sent", 0)
    .select("id");
  if (error) fail("claim email", error.message);
  return (data ?? []).length > 0;
}

export async function markEmailSent(id: number): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("email_queue")
    .update({ sent: 1, sent_at: epoch(), error: null })
    .eq("id", id);
  if (error) fail("mark email sent", error.message);
}

// Fallo con backoff (60s × intento); al 3er intento queda fallido definitivo.
export async function releaseEmailFailure(
  item: EmailQueueItem,
  errorMessage: string,
  maxAttempts = 3
): Promise<boolean> {
  const sb = getSupabase();
  const attempts = item.attempts + 1;
  const discarded = attempts >= maxAttempts;
  const patch: Record<string, unknown> = {
    attempts,
    sent: discarded ? 2 : 0,
    error: errorMessage.slice(0, 500),
  };
  if (!discarded) patch.scheduled_at = epoch() + 60 * attempts;
  const { error } = await sb.from("email_queue").update(patch).eq("id", item.id);
  if (error) fail("release email", error.message);
  return discarded;
}

// Difiere un correo pendiente SIN quemar intentos (organización con Mailing
// apagado o límite alcanzado: sus filas no deben taponar el lote global).
export async function deferEmail(id: number, seconds: number): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("email_queue")
    .update({ scheduled_at: epoch() + seconds })
    .eq("id", id)
    .eq("sent", 0);
  if (error) fail("defer email", error.message);
}

export async function resetInFlightEmails(): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from("email_queue").update({ sent: 0 }).eq("sent", 3);
  if (error) fail("reset emails in-flight", error.message);
}

// Enviados desde un instante (para los límites por hora/día opcionales).
// Por organización: los límites son de la cuenta SMTP de cada cliente.
export async function countEmailsSentSince(since: number, orgId: number): Promise<number> {
  const sb = getSupabase();
  const { count, error } = await sb
    .from("email_queue")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("sent", 1)
    .gte("sent_at", since);
  if (error) fail("count emails sent", error.message);
  return count ?? 0;
}

export interface EmailStats {
  pending: number;
  sentLastDay: number;
  failed: number;
}

export async function getEmailStats(orgId: number): Promise<EmailStats> {
  const sb = getSupabase();
  const [pending, sentDay, failed] = await Promise.all([
    sb
      .from("email_queue")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("sent", 0),
    sb
      .from("email_queue")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("sent", 1)
      .gte("sent_at", epoch() - 86400),
    sb
      .from("email_queue")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("sent", 2),
  ]);
  const firstError = pending.error ?? sentDay.error ?? failed.error;
  if (firstError) fail("email stats", firstError.message);
  return {
    pending: pending.count ?? 0,
    sentLastDay: sentDay.count ?? 0,
    failed: failed.count ?? 0,
  };
}

export async function listRecentEmails(orgId: number, limit = 20): Promise<EmailQueueItem[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("email_queue")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) fail("list recent emails", error.message);
  return (data ?? []) as EmailQueueItem[];
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
  via: "whatsapp" | "email";
  to_phone: string | null;
  to_email: string | null;
  conversation_id: number | null;
  next_fire_at: number;
  repeat_every: AlarmRepeat;
  active: boolean;
  last_fired_at: number | null;
  last_error: string | null;
  created_at: number;
  // Organización dueña: sus avisos salen por SUS canales (WhatsApp/SMTP).
  org_id: number;
}

export interface AlarmDraft {
  title: string;
  message: string;
  kind: AlarmKind;
  via: "whatsapp" | "email";
  to_phone?: string | null;
  to_email?: string | null;
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
  if (error) fail("list alarms", error.message);
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
      to_email: draft.to_email ?? null,
      conversation_id: draft.conversation_id ?? null,
      next_fire_at: draft.next_fire_at,
      repeat_every: draft.repeat_every,
    })
    .select()
    .single();
  if (error) fail("create alarm", error.message);
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
    "to_email",
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
  if (error) fail("update alarm", error.message);
  return (data as Alarm | null) ?? null;
}

export async function getAlarmById(id: number, orgId?: number): Promise<Alarm | null> {
  const sb = getSupabase();
  let query = sb.from("alarms").select("*").eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { data, error } = await query.maybeSingle();
  if (error) fail("get alarm", error.message);
  return (data as Alarm | null) ?? null;
}

export async function deleteAlarm(id: number, orgId?: number): Promise<void> {
  const sb = getSupabase();
  let query = sb.from("alarms").delete().eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { error } = await query;
  if (error) fail("delete alarm", error.message);
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
  if (error) fail("get due alarms", error.message);
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
  if (error) fail("claim alarm", error.message);
  return (data ?? []).length > 0;
}

// Difiere una alarma vencida que NO puede dispararse aún (p.ej. correo sin
// SMTP configurado): sin esto ocupaba el lote de vencidas para siempre y
// bloqueaba las alarmas de otras organizaciones. Condicional al next_fire_at
// conocido: si el operador la reprogramó en paralelo, su cambio manda.
export async function deferAlarm(alarm: Alarm, seconds: number): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("alarms")
    .update({ next_fire_at: epoch() + seconds })
    .eq("id", alarm.id)
    .eq("next_fire_at", alarm.next_fire_at)
    .eq("active", true);
  if (error) fail("defer alarm", error.message);
}

export async function setAlarmError(id: number, message: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("alarms")
    .update({ last_error: message.slice(0, 500) })
    .eq("id", id);
  if (error) fail("set alarm error", error.message);
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
  if (error) fail("enqueue notify", error.message);
}

// Dedupe cruzada de la API pública: un lead que llegó primero solo con
// correo (canal 'api') y ahora llega con teléfono se ASCIENDE a WhatsApp en
// la misma fila (conserva mensajes/notas/etapa) en vez de duplicarse.
// Devuelve null si no había fila que ascender o si ya existe una
// conversación de WhatsApp con ese teléfono (unique 23505).
export async function upgradeApiLeadToWhatsapp(
  orgId: number,
  email: string,
  phone: string
): Promise<Conversation | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("conversations")
    .update({ channel: "whatsapp", external_id: phone, phone })
    .eq("org_id", orgId)
    .eq("channel", "api")
    .eq("external_id", email)
    .select()
    .maybeSingle();
  if (error) {
    if (error.code === "23505") return null;
    fail("upgrade api lead", error.message);
  }
  return (data as Conversation | null) ?? null;
}

// Al ENVIAR un correo (Mailing o Leads), el destinatario es un lead que se
// está contactando: debe existir en el CRM para poder darle seguimiento.
// Busca por correo en cualquier canal (prioriza el de actividad más
// reciente) y, si no existe, lo crea en el canal 'api' con la etiqueta
// 'mailing' para poder filtrarlo en la sección Leads.
export async function ensureLeadForEmail(
  orgId: number,
  email: string
): Promise<{ id: number; isNew: boolean }> {
  const sb = getSupabase();
  const { data: byEmail, error: e1 } = await sb
    .from("conversations")
    .select("id")
    .eq("org_id", orgId)
    .eq("email", email)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (e1) fail("find lead by email", e1.message);
  if (byEmail) return { id: (byEmail as { id: number }).id, isNew: false };

  // Leads 'api' viejos creados con el correo como external_id pero con la
  // columna email vacía: son el mismo lead — se rellena y se reutiliza.
  const { data: byExt, error: e2 } = await sb
    .from("conversations")
    .select("id, email")
    .eq("org_id", orgId)
    .eq("channel", "api")
    .eq("external_id", email)
    .maybeSingle();
  if (e2) fail("find lead by external_id", e2.message);
  if (byExt) {
    const row = byExt as { id: number; email: string | null };
    if (!row.email) await updateLeadFields(row.id, { email }).catch(() => undefined);
    return { id: row.id, isNew: false };
  }

  const convo = await getOrCreateConversation(orgId, "api", email);
  const tags = Array.isArray(convo.tags) ? convo.tags : [];
  await updateLeadFields(convo.id, {
    email,
    ...(tags.includes("mailing") ? {} : { tags: [...tags, "mailing"] }),
  }).catch(() => undefined);
  // Si getOrCreateConversation devolvió una fila vieja (carrera), su email
  // vacío igual delata que nunca se había contactado por correo.
  return { id: convo.id, isNew: !convo.email };
}

// Correos del lead para el hilo conversacional: todos los de la cola
// dirigidos a su dirección (dedupe por email = 1 lead por org, así que basta
// filtrar por org_id + to_email). Orden cronológico. No trae el html completo
// de golpe si son muchos; el resumen a texto se hace en la ruta.
export interface LeadEmailRow {
  id: number;
  to_email: string;
  subject: string;
  html: string;
  sent: number;
  error: string | null;
  reply_to?: string | null;
  scheduled_at: number | null;
  sent_at: number | null;
  created_at: number;
}

export async function listLeadEmails(
  orgId: number,
  email: string,
  limit = 100
): Promise<LeadEmailRow[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("email_queue")
    .select("id, to_email, subject, html, sent, error, reply_to, scheduled_at, sent_at, created_at")
    .eq("org_id", orgId)
    .eq("to_email", email.trim().toLowerCase())
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit);
  if (error) {
    // reply_to sin migrar: reintenta sin esa columna (mismo apaño que el resto).
    if (/reply_to/i.test(error.message)) {
      const retry = await sb
        .from("email_queue")
        .select("id, to_email, subject, html, sent, error, scheduled_at, sent_at, created_at")
        .eq("org_id", orgId)
        .eq("to_email", email.trim().toLowerCase())
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(limit);
      if (retry.error) fail("list lead emails", retry.error.message);
      return (retry.data ?? []) as LeadEmailRow[];
    }
    fail("list lead emails", error.message);
  }
  return (data ?? []) as LeadEmailRow[];
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
  if (error) fail("list api_keys", error.message);
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
  if (error) fail("create api_key", error.message);
  return data as unknown as ApiKeyRow;
}

export async function deleteApiKey(id: number, orgId?: number): Promise<void> {
  const sb = getSupabase();
  let query = sb.from("api_keys").delete().eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { error } = await query;
  if (error) fail("delete api_key", error.message);
}

export async function findApiKeyByHash(keyHash: string): Promise<ApiKeyRow | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("api_keys")
    .select(API_KEY_COLUMNS)
    .eq("key_hash", keyHash)
    .eq("active", true)
    .maybeSingle();
  if (error) fail("find api_key", error.message);
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
  if (error) fail("get app_settings", error.message);
  return (data?.value as T) ?? null;
}

export async function setAppSetting(orgId: number, key: string, value: unknown): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("app_settings")
    .upsert({ org_id: orgId, key, value, updated_at: epoch() }, { onConflict: "org_id,key" });
  if (error) fail("set app_settings", error.message);
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
  if (error) fail("list calendar events", error.message);
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
  if (error) fail("create calendar event", error.message);
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
  if (error) fail("update calendar event", error.message);
  return (data as CalendarEvent | null) ?? null;
}

export async function deleteCalendarEvent(id: number, orgId?: number): Promise<void> {
  const sb = getSupabase();
  let query = sb.from("calendar_events").delete().eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { error } = await query;
  if (error) fail("delete calendar event", error.message);
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
  if (error) fail("list follow-ups", error.message);
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
  if (error) fail("list quick replies", error.message);
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
  if (error) fail("create quick reply", error.message);
  return data as QuickReply;
}

export async function deleteQuickReply(id: number, orgId?: number): Promise<void> {
  const sb = getSupabase();
  let query = sb.from("quick_replies").delete().eq("id", id);
  if (orgId !== undefined) query = query.eq("org_id", orgId);
  const { error } = await query;
  if (error) fail("delete quick reply", error.message);
}
