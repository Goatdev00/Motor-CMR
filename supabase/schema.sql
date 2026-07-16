-- ============================================================
-- SCHEMA DEL AGENTE DE WHATSAPP (Supabase / Postgres)
-- Ejecutar UNA VEZ en: Dashboard de Supabase → SQL Editor →
-- New query → pegar todo este archivo → Run.
-- Es idempotente: correrlo de nuevo no rompe nada.
-- ============================================================

-- ── Tablas ──────────────────────────────────────────────────

create table if not exists conversations (
  id               bigint generated always as identity primary key,
  phone            text unique not null,
  name             text,
  mode             text not null default 'AI' check (mode in ('AI', 'HUMAN')),
  last_message_at  bigint,
  created_at       bigint not null default extract(epoch from now())::bigint
);

create table if not exists messages (
  id               bigint generated always as identity primary key,
  conversation_id  bigint not null references conversations(id) on delete cascade,
  role             text not null check (role in ('user', 'assistant', 'human')),
  content          text not null,
  created_at       bigint not null default extract(epoch from now())::bigint
);

create index if not exists idx_messages_conv
  on messages (conversation_id, created_at);

-- Fila única que actúa de "buzón" entre el proceso bot y el de Next.js.
-- restart_requested reemplaza al archivo flag ./data/.restart del diseño
-- original: como la DB es remota, funciona incluso si bot y dashboard
-- corren en máquinas distintas.
create table if not exists connection_state (
  id                 smallint primary key check (id = 1),
  status             text not null default 'disconnected'
                     check (status in ('disconnected', 'qr', 'connecting', 'connected')),
  qr_string          text,
  phone              text,
  restart_requested  boolean not null default false,
  updated_at         bigint not null default extract(epoch from now())::bigint
);

insert into connection_state (id, status)
values (1, 'disconnected')
on conflict (id) do nothing;

-- Cola de mensajes humanos (dashboard → bot → WhatsApp).
-- sent: 0 = pendiente, 1 = enviado, 2 = descartado tras 5 intentos fallidos.
-- Sin FK a conversations a propósito: los enviados (sent=1) quedan como
-- histórico aunque la conversación se borre.
create table if not exists outbox (
  id               bigint generated always as identity primary key,
  conversation_id  bigint not null,
  phone            text not null,
  content          text not null,
  sent             smallint not null default 0,
  attempts         integer not null default 0,
  created_at       bigint not null default extract(epoch from now())::bigint
);

create index if not exists idx_outbox_pending
  on outbox (sent, created_at);

-- ── Funciones (RPC) ─────────────────────────────────────────
-- Reemplazan las transacciones de better-sqlite3: cada función
-- corre de forma atómica dentro de Postgres.

-- Insert de mensaje + actualización de last_message_at, atómico.
create or replace function insert_message(
  p_conversation_id bigint,
  p_role text,
  p_content text
) returns messages
language plpgsql as $$
declare
  m messages;
begin
  insert into messages (conversation_id, role, content)
  values (p_conversation_id, p_role, p_content)
  returning * into m;

  update conversations
  set last_message_at = m.created_at
  where id = p_conversation_id;

  return m;
end;
$$;

-- Mensaje humano desde el dashboard: insert en messages + last_message_at +
-- encolado en outbox, TODO en una transacción. Si fueran llamadas separadas,
-- un fallo entre ambas dejaría un mensaje visible en el panel que jamás se
-- envía al cliente (o duplicados al reintentar).
create or replace function insert_human_message(
  p_conversation_id bigint,
  p_content text
) returns messages
language plpgsql as $$
declare
  m messages;
  v_phone text;
begin
  select phone into v_phone from conversations where id = p_conversation_id;
  if v_phone is null then
    raise exception 'conversation % no existe', p_conversation_id;
  end if;

  insert into messages (conversation_id, role, content)
  values (p_conversation_id, 'human', p_content)
  returning * into m;

  update conversations
  set last_message_at = m.created_at
  where id = p_conversation_id;

  insert into outbox (conversation_id, phone, content)
  values (p_conversation_id, v_phone, p_content);

  return m;
end;
$$;

-- list_conversations se define UNA sola vez en la sección CRM (más abajo).
-- Tener aquí la versión vieja rompía la idempotencia: re-ejecutar el archivo
-- sobre una base ya migrada fallaba con 42P13 (no se puede cambiar el tipo
-- de retorno de una función existente con create or replace).

-- Borrado atómico: outbox pendiente/en-envío + mensajes + conversación.
-- El outbox ya enviado (sent=1) se conserva como histórico.
create or replace function delete_conversation(p_id bigint)
returns void
language plpgsql as $$
begin
  delete from outbox where conversation_id = p_id and sent in (0, 3);
  delete from messages where conversation_id = p_id;
  delete from conversations where id = p_id;
end;
$$;

-- ============================================================
-- CRM (aditivo e idempotente: re-ejecutar este archivo completo
-- sobre una base existente aplica solo lo que falte)
-- ============================================================

-- ── Leads: columnas CRM sobre conversations ────────────────
alter table conversations add column if not exists stage text not null default 'NUEVO';
alter table conversations add column if not exists lead_score integer;
alter table conversations add column if not exists deal_value numeric;
alter table conversations add column if not exists company text;
alter table conversations add column if not exists email text;
alter table conversations add column if not exists tags text[] not null default '{}';
alter table conversations add column if not exists ai_summary text;
alter table conversations add column if not exists ai_next_step text;
alter table conversations add column if not exists ai_suggested_stage text;
alter table conversations add column if not exists ai_analyzed_at bigint;
alter table conversations add column if not exists next_follow_up_at bigint;
alter table conversations add column if not exists follow_up_note text;
alter table conversations add column if not exists last_user_message_at bigint;
alter table conversations add column if not exists stage_changed_at bigint;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'conversations_stage_check') then
    alter table conversations add constraint conversations_stage_check
      check (stage in ('NUEVO', 'CONTACTADO', 'CALIFICADO', 'PROPUESTA', 'GANADO', 'PERDIDO'));
  end if;
end $$;

-- Backfill de last_user_message_at para conversaciones previas al CRM.
update conversations c
set last_user_message_at = sub.max_created
from (
  select conversation_id, max(created_at) as max_created
  from messages where role = 'user' group by conversation_id
) sub
where sub.conversation_id = c.id and c.last_user_message_at is null;

-- ── Notas internas del lead (no se envían al cliente) ──────
create table if not exists lead_notes (
  id               bigint generated always as identity primary key,
  conversation_id  bigint not null references conversations(id) on delete cascade,
  content          text not null,
  created_at       bigint not null default extract(epoch from now())::bigint
);
create index if not exists idx_lead_notes_conv on lead_notes (conversation_id, created_at);

-- ── Historial de actividad del lead ────────────────────────
-- type: 'stage' | 'followup_scheduled' | 'followup_sent' | 'followup_cancelled'
create table if not exists lead_events (
  id               bigint generated always as identity primary key,
  conversation_id  bigint not null references conversations(id) on delete cascade,
  type             text not null,
  detail           text not null,
  created_at       bigint not null default extract(epoch from now())::bigint
);
create index if not exists idx_lead_events_conv on lead_events (conversation_id, created_at desc);

-- ── Plantillas de respuesta rápida ──────────────────────────
create table if not exists quick_replies (
  id          bigint generated always as identity primary key,
  title       text not null,
  content     text not null,
  created_at  bigint not null default extract(epoch from now())::bigint
);

-- ── Outbox: envíos programados (seguimientos automáticos) ──
-- kind: 'manual' (mensaje humano ya insertado en messages) |
--       'followup' (programado: el bot inserta el mensaje al enviarlo).
-- scheduled_at: null = enviar ya; futuro = el bot espera a esa hora.
-- sent gana un estado: 3 = 'enviando' (reclamado por el bot justo antes de
-- enviar; evita que cancelar/reprogramar borre una fila en vuelo y que un
-- fallo de marcado cause reenvíos). El bot resetea 3→0 al arrancar.
alter table outbox add column if not exists kind text not null default 'manual';
alter table outbox add column if not exists scheduled_at bigint;

-- ── insert_message ahora mantiene last_user_message_at ─────
create or replace function insert_message(
  p_conversation_id bigint,
  p_role text,
  p_content text
) returns messages
language plpgsql as $$
declare
  m messages;
begin
  insert into messages (conversation_id, role, content)
  values (p_conversation_id, p_role, p_content)
  returning * into m;

  update conversations
  set last_message_at = m.created_at,
      last_user_message_at = case when p_role = 'user' then m.created_at
                                  else last_user_message_at end
  where id = p_conversation_id;

  return m;
end;
$$;

-- ── list_conversations con campos CRM ───────────────────────
-- drop obligatorio: cambiar el tipo de retorno de una función
-- existente no se puede con create or replace.
drop function if exists list_conversations();
create or replace function list_conversations()
returns table (
  id bigint,
  phone text,
  name text,
  mode text,
  last_message_at bigint,
  created_at bigint,
  last_message_preview text,
  stage text,
  lead_score integer,
  deal_value numeric,
  company text,
  email text,
  tags text[],
  ai_summary text,
  ai_next_step text,
  ai_suggested_stage text,
  next_follow_up_at bigint,
  follow_up_note text,
  last_user_message_at bigint,
  -- rol del último mensaje: determina "esperando respuesta" sin la ambigüedad
  -- de comparar timestamps con resolución de 1 segundo
  last_message_role text
)
language sql stable as $$
  select
    c.id, c.phone, c.name, c.mode, c.last_message_at, c.created_at,
    (
      select m.content
      from messages m
      where m.conversation_id = c.id
      order by m.created_at desc, m.id desc
      limit 1
    ) as last_message_preview,
    c.stage, c.lead_score, c.deal_value, c.company, c.email, c.tags,
    c.ai_summary, c.ai_next_step, c.ai_suggested_stage,
    c.next_follow_up_at, c.follow_up_note, c.last_user_message_at,
    (
      select m.role
      from messages m
      where m.conversation_id = c.id
      order by m.created_at desc, m.id desc
      limit 1
    ) as last_message_role
  from conversations c
  order by c.last_message_at desc nulls last, c.id desc;
$$;

-- ── Cambio de etapa con evento, atómico ─────────────────────
create or replace function set_stage(p_conversation_id bigint, p_stage text)
returns void
language plpgsql as $$
declare
  old_stage text;
begin
  select stage into old_stage from conversations where id = p_conversation_id;
  if old_stage is null then
    raise exception 'conversation % no existe', p_conversation_id;
  end if;
  if old_stage = p_stage then return; end if;

  update conversations
  set stage = p_stage,
      stage_changed_at = extract(epoch from now())::bigint
  where id = p_conversation_id;

  insert into lead_events (conversation_id, type, detail)
  values (p_conversation_id, 'stage', old_stage || ' → ' || p_stage);
end;
$$;

-- ── Programar seguimiento automático, atómico ───────────────
-- Reemplaza el seguimiento pendiente anterior (uno activo por lead).
create or replace function schedule_follow_up(
  p_conversation_id bigint,
  p_content text,
  p_send_at bigint
) returns void
language plpgsql as $$
declare
  v_phone text;
begin
  select phone into v_phone from conversations where id = p_conversation_id;
  if v_phone is null then
    raise exception 'conversation % no existe', p_conversation_id;
  end if;

  delete from outbox
  where conversation_id = p_conversation_id and kind = 'followup' and sent = 0;

  insert into outbox (conversation_id, phone, content, kind, scheduled_at)
  values (p_conversation_id, v_phone, p_content, 'followup', p_send_at);

  update conversations
  set next_follow_up_at = p_send_at, follow_up_note = p_content
  where id = p_conversation_id;

  insert into lead_events (conversation_id, type, detail)
  values (p_conversation_id, 'followup_scheduled', p_content);
end;
$$;

-- Cancela solo si había algo pendiente: para ids inexistentes no revienta la
-- FK de lead_events, y no ensucia el historial con cancelaciones vacías.
create or replace function cancel_follow_up(p_conversation_id bigint)
returns void
language plpgsql as $$
declare
  v_deleted integer;
begin
  delete from outbox
  where conversation_id = p_conversation_id and kind = 'followup' and sent = 0;
  get diagnostics v_deleted = row_count;

  update conversations
  set next_follow_up_at = null, follow_up_note = null
  where id = p_conversation_id
    and (next_follow_up_at is not null or follow_up_note is not null);

  if v_deleted > 0 then
    insert into lead_events (conversation_id, type, detail)
    values (p_conversation_id, 'followup_cancelled', 'Seguimiento cancelado');
  end if;
end;
$$;

-- El bot la llama tras entregar un seguimiento programado. El clear del
-- recordatorio es CONDICIONAL al scheduled_at entregado: si el operador
-- reprogramó otro seguimiento mientras este estaba en vuelo, el recordatorio
-- nuevo NO se borra (antes quedaba un envío futuro invisible en la UI).
drop function if exists follow_up_sent(bigint);
create or replace function follow_up_sent(
  p_conversation_id bigint,
  p_scheduled_at bigint
) returns void
language plpgsql as $$
begin
  update conversations
  set next_follow_up_at = null, follow_up_note = null
  where id = p_conversation_id
    and next_follow_up_at is not distinct from p_scheduled_at;

  insert into lead_events (conversation_id, type, detail)
  values (p_conversation_id, 'followup_sent', 'Seguimiento automático enviado');
end;
$$;

-- El bot la llama cuando un seguimiento se descarta tras agotar reintentos:
-- limpia el recordatorio (condicional, igual que follow_up_sent) y deja
-- rastro visible en la actividad. Sin esto la ficha mostraba "Se enviará el
-- <fecha pasada>" para siempre.
create or replace function follow_up_failed(
  p_conversation_id bigint,
  p_scheduled_at bigint
) returns void
language plpgsql as $$
begin
  update conversations
  set next_follow_up_at = null, follow_up_note = null
  where id = p_conversation_id
    and next_follow_up_at is not distinct from p_scheduled_at;

  insert into lead_events (conversation_id, type, detail)
  values (p_conversation_id, 'followup_failed',
          'El seguimiento automático NO pudo entregarse (se agotaron los reintentos)');
end;
$$;

-- Persistencia atómica del análisis de IA. Las guardas viven en SQL para
-- eliminar las carreras read-then-write: los datos extraídos solo rellenan
-- campos vacíos (coalesce) y el auto-avance NUEVO→CONTACTADO es condicional
-- en la misma sentencia (no puede pisar una etapa que el operador acaba de
-- cambiar desde el kanban).
create or replace function apply_lead_analysis(
  p_conversation_id bigint,
  p_score integer,
  p_summary text,
  p_next_step text,
  p_suggested_stage text,
  p_name text,
  p_company text,
  p_email text
) returns void
language plpgsql as $$
begin
  update conversations
  set lead_score = p_score,
      ai_summary = p_summary,
      ai_next_step = p_next_step,
      ai_suggested_stage = p_suggested_stage,
      ai_analyzed_at = extract(epoch from now())::bigint,
      name = coalesce(name, p_name),
      company = coalesce(company, p_company),
      email = coalesce(email, p_email)
  where id = p_conversation_id;

  update conversations
  set stage = 'CONTACTADO',
      stage_changed_at = extract(epoch from now())::bigint
  where id = p_conversation_id and stage = 'NUEVO';

  if found then
    insert into lead_events (conversation_id, type, detail)
    values (p_conversation_id, 'stage', 'NUEVO → CONTACTADO (automático)');
  end if;
end;
$$;

-- ============================================================
-- MULTICANAL (aditivo e idempotente)
-- Canales: 'whatsapp' (Baileys/QR), 'whatsapp_api' (Meta Cloud API),
-- 'messenger' (Facebook), 'instagram' (DMs).
-- ============================================================

-- external_id: identificador del contacto en su canal (teléfono para
-- WhatsApp, PSID para Messenger, IGSID para Instagram). phone pasa a ser
-- opcional (en IG/FB no se conoce el número).
alter table conversations add column if not exists channel text not null default 'whatsapp';
alter table conversations add column if not exists external_id text;
update conversations set external_id = phone where external_id is null;
alter table conversations alter column phone drop not null;

do $$ begin
  if exists (select 1 from pg_constraint where conname = 'conversations_phone_key') then
    alter table conversations drop constraint conversations_phone_key;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'conversations_channel_check') then
    alter table conversations add constraint conversations_channel_check
      check (channel in ('whatsapp', 'whatsapp_api', 'messenger', 'instagram'));
  end if;
end $$;

create unique index if not exists idx_conversations_channel_ext
  on conversations (channel, external_id);

-- outbox: el canal decide cómo se envía; phone guarda el DESTINATARIO del
-- canal (teléfono o PSID/IGSID).
alter table outbox add column if not exists channel text not null default 'whatsapp';

-- Configuración de canales editable desde el dashboard (tokens de Meta,
-- toggle de Baileys, webhook). Solo accesible con service_role (RLS).
create table if not exists channel_settings (
  channel     text primary key,
  enabled     boolean not null default false,
  config      jsonb not null default '{}'::jsonb,
  updated_at  bigint not null default extract(epoch from now())::bigint
);

-- Baileys queda habilitado por defecto (compatibilidad con lo ya montado).
insert into channel_settings (channel, enabled)
values ('whatsapp', true)
on conflict (channel) do nothing;

-- insert_human_message: el outbox hereda canal y destinatario reales.
create or replace function insert_human_message(
  p_conversation_id bigint,
  p_content text
) returns messages
language plpgsql as $$
declare
  m messages;
  v_recipient text;
  v_channel text;
begin
  select coalesce(external_id, phone), channel
  into v_recipient, v_channel
  from conversations where id = p_conversation_id;
  if v_recipient is null then
    raise exception 'conversation % no existe', p_conversation_id;
  end if;

  insert into messages (conversation_id, role, content)
  values (p_conversation_id, 'human', p_content)
  returning * into m;

  update conversations
  set last_message_at = m.created_at
  where id = p_conversation_id;

  insert into outbox (conversation_id, phone, content, channel)
  values (p_conversation_id, v_recipient, p_content, v_channel);

  return m;
end;
$$;

-- schedule_follow_up: ídem.
create or replace function schedule_follow_up(
  p_conversation_id bigint,
  p_content text,
  p_send_at bigint
) returns void
language plpgsql as $$
declare
  v_recipient text;
  v_channel text;
begin
  select coalesce(external_id, phone), channel
  into v_recipient, v_channel
  from conversations where id = p_conversation_id;
  if v_recipient is null then
    raise exception 'conversation % no existe', p_conversation_id;
  end if;

  delete from outbox
  where conversation_id = p_conversation_id and kind = 'followup' and sent = 0;

  insert into outbox (conversation_id, phone, content, kind, scheduled_at, channel)
  values (p_conversation_id, v_recipient, p_content, 'followup', p_send_at, v_channel);

  update conversations
  set next_follow_up_at = p_send_at, follow_up_note = p_content
  where id = p_conversation_id;

  insert into lead_events (conversation_id, type, detail)
  values (p_conversation_id, 'followup_scheduled', p_content);
end;
$$;

-- list_conversations: expone canal y external_id.
drop function if exists list_conversations();
create or replace function list_conversations()
returns table (
  id bigint,
  phone text,
  name text,
  mode text,
  last_message_at bigint,
  created_at bigint,
  last_message_preview text,
  stage text,
  lead_score integer,
  deal_value numeric,
  company text,
  email text,
  tags text[],
  ai_summary text,
  ai_next_step text,
  ai_suggested_stage text,
  next_follow_up_at bigint,
  follow_up_note text,
  last_user_message_at bigint,
  last_message_role text,
  channel text,
  external_id text
)
language sql stable as $$
  select
    c.id, c.phone, c.name, c.mode, c.last_message_at, c.created_at,
    (
      select m.content
      from messages m
      where m.conversation_id = c.id
      order by m.created_at desc, m.id desc
      limit 1
    ) as last_message_preview,
    c.stage, c.lead_score, c.deal_value, c.company, c.email, c.tags,
    c.ai_summary, c.ai_next_step, c.ai_suggested_stage,
    c.next_follow_up_at, c.follow_up_note, c.last_user_message_at,
    (
      select m.role
      from messages m
      where m.conversation_id = c.id
      order by m.created_at desc, m.id desc
      limit 1
    ) as last_message_role,
    c.channel, c.external_id
  from conversations c
  order by c.last_message_at desc nulls last, c.id desc;
$$;

alter table channel_settings enable row level security;

-- ── Preferencias de la app (personalización desde el front) ─
-- Clave/valor genérico; hoy guarda 'stages' (nombres y colores de las
-- etapas del pipeline del CRM).
create table if not exists app_settings (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  bigint not null default extract(epoch from now())::bigint
);

alter table app_settings enable row level security;

-- ============================================================
-- MAILING (aditivo e idempotente)
-- La cuenta SMTP se guarda en channel_settings (fila 'email'); esta
-- cola la procesa el proceso bot respetando los límites configurados.
-- sent: 0 pendiente, 1 enviado, 2 fallido definitivo, 3 enviando.
-- ============================================================

create table if not exists email_queue (
  id            bigint generated always as identity primary key,
  to_email      text not null,
  to_name       text,
  subject       text not null,
  html          text not null,
  batch_id      text,
  sent          smallint not null default 0,
  attempts      integer not null default 0,
  error         text,
  scheduled_at  bigint,
  sent_at       bigint,
  created_at    bigint not null default extract(epoch from now())::bigint
);

create index if not exists idx_email_queue_pending on email_queue (sent, created_at);
create index if not exists idx_email_queue_sent_at on email_queue (sent_at);

-- Responder-a opcional por correo (sección Leads: el operador decide a qué
-- buzón llegan las respuestas de cada envío).
alter table email_queue add column if not exists reply_to text;

alter table email_queue enable row level security;

-- ============================================================
-- CALENDARIO (aditivo e idempotente)
-- Eventos creados desde la pestaña Calendario del dashboard.
-- Las fechas son epoch en segundos (como el resto del schema);
-- la zona horaria la resuelve el navegador del operador.
-- La conexión con Google (Drive) guarda credenciales y
-- refresh_token en app_settings (clave 'google').
-- ============================================================

create table if not exists calendar_events (
  id               bigint generated always as identity primary key,
  title            text not null,
  description      text not null default '',
  location         text not null default '',
  starts_at        bigint not null,
  ends_at          bigint,
  all_day          boolean not null default false,
  color            text not null default '#34d399',
  -- Evento ligado a un lead del CRM (opcional). Si el lead se borra, el
  -- evento sobrevive sin el vínculo.
  conversation_id  bigint references conversations(id) on delete set null,
  -- Archivos de Google Drive adjuntos: [{id, name, link}].
  attachments      jsonb not null default '[]'::jsonb,
  created_at       bigint not null default extract(epoch from now())::bigint,
  updated_at       bigint not null default extract(epoch from now())::bigint
);

create index if not exists idx_calendar_events_range on calendar_events (starts_at);

-- Un evento con fin anterior al inicio queda invisible para la consulta de
-- solapamiento (imposible de reabrir/arreglar desde la UI): se prohíbe a
-- nivel de datos, no solo en la validación de la API.
-- Saneo previo: si alguna fila corrupta existiera (versión anterior de la
-- API lo permitía), el ADD CONSTRAINT abortaría toda la re-ejecución.
update calendar_events set ends_at = null where ends_at < starts_at;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'calendar_events_ends_after_starts') then
    alter table calendar_events add constraint calendar_events_ends_after_starts
      check (ends_at is null or ends_at >= starts_at);
  end if;
end $$;

alter table calendar_events enable row level security;

-- ============================================================
-- EQUIPO (aditivo e idempotente)
-- Varias cuentas de WhatsApp (multi-sesión Baileys), miembros con
-- rol y enrutamiento de chats por etapa de venta. El mapa etapa →
-- miembro vive en app_settings ('stage_routing').
-- ============================================================

-- Cuentas de WhatsApp vinculables por QR. Cada una reemplaza a la vieja
-- fila única de connection_state: el bot mantiene una sesión por cuenta
-- habilitada y escribe aquí su estado/QR.
create table if not exists wa_accounts (
  id                 bigint generated always as identity primary key,
  label              text not null,
  status             text not null default 'disconnected'
                     check (status in ('disconnected', 'qr', 'connecting', 'connected')),
  qr_string          text,
  phone              text,
  enabled            boolean not null default true,
  -- Señal del dashboard: desvincular (logout + credenciales borradas + QR nuevo).
  restart_requested  boolean not null default false,
  created_at         bigint not null default extract(epoch from now())::bigint,
  updated_at         bigint not null default extract(epoch from now())::bigint
);

alter table wa_accounts enable row level security;

-- Migración desde la instalación de una sola cuenta.
insert into wa_accounts (label)
select 'Principal' where not exists (select 1 from wa_accounts);

-- Miembros del equipo. El rol es informativo (el dashboard no tiene login);
-- lo operativo es el enrutamiento: a quién se asignan los leads y a qué
-- número se le avisa (su cuenta vinculada o notify_phone).
create table if not exists team_members (
  id             bigint generated always as identity primary key,
  name           text not null,
  role           text not null default 'VENDEDOR'
                 check (role in ('ADMIN', 'SUPERVISOR', 'VENDEDOR')),
  wa_account_id  bigint references wa_accounts(id) on delete set null,
  notify_phone   text,
  active         boolean not null default true,
  created_at     bigint not null default extract(epoch from now())::bigint
);

alter table team_members enable row level security;

-- Asignación del lead y cuenta por la que habla (última que recibió su
-- mensaje; las respuestas salen por la cuenta del vendedor asignado si
-- tiene una, o por esta).
alter table conversations add column if not exists assigned_member_id bigint references team_members(id) on delete set null;
alter table conversations add column if not exists wa_account_id bigint references wa_accounts(id) on delete set null;

-- Cuenta explícita para un envío (hoy: null = resolver al enviar).
alter table outbox add column if not exists wa_account_id bigint;

-- ── Asignar un lead a un miembro (con evento + aviso por WhatsApp) ──
-- El aviso viaja como outbox kind='notify': el bot lo envía al vendedor
-- pero NO lo inserta en el hilo del cliente.
create or replace function assign_lead(
  p_conversation_id bigint,
  p_member_id bigint,
  p_reason text
) returns void
language plpgsql as $$
declare
  v_current bigint;
  v_lead_name text;
  v_lead_phone text;
  v_lead_ext text;
  v_member_name text;
  v_member_active boolean;
  v_notify text;
  v_acc_phone text;
  v_target text;
  v_display text;
begin
  select assigned_member_id, name, phone, external_id
    into v_current, v_lead_name, v_lead_phone, v_lead_ext
  from conversations where id = p_conversation_id;
  if not found then
    raise exception 'conversation % no existe', p_conversation_id;
  end if;

  -- Sin cambio real: ni evento ni aviso (el enrutamiento por etapa se
  -- dispara en cada cambio de etapa y no debe spamear al vendedor).
  if v_current is not distinct from p_member_id then return; end if;

  if p_member_id is null then
    update conversations set assigned_member_id = null where id = p_conversation_id;
    insert into lead_events (conversation_id, type, detail)
    values (p_conversation_id, 'assigned',
            'Lead sin asignar (' || coalesce(nullif(p_reason, ''), 'manual') || ')');
    return;
  end if;

  select m.name, m.active, m.notify_phone, a.phone
    into v_member_name, v_member_active, v_notify, v_acc_phone
  from team_members m
  left join wa_accounts a on a.id = m.wa_account_id
  where m.id = p_member_id;
  if not found then
    raise exception 'miembro % no existe', p_member_id;
  end if;

  update conversations set assigned_member_id = p_member_id where id = p_conversation_id;
  insert into lead_events (conversation_id, type, detail)
  values (p_conversation_id, 'assigned',
          'Asignado a ' || v_member_name ||
          case when coalesce(p_reason, '') <> '' then ' — ' || p_reason else '' end);

  -- Aviso al vendedor: a su notify_phone o al número de su cuenta vinculada.
  -- Nunca al propio teléfono del lead (si el vendedor ES el lead, no aplica).
  v_target := coalesce(nullif(v_notify, ''), v_acc_phone);
  v_display := coalesce(v_lead_name, v_lead_phone, v_lead_ext, '#' || p_conversation_id);
  if v_member_active and v_target is not null
     and v_target <> coalesce(v_lead_phone, v_lead_ext, '') then
    insert into outbox (conversation_id, phone, content, channel, kind)
    values (p_conversation_id, v_target,
            'AGENTE · Se te asignó el lead ' || v_display ||
            case when coalesce(p_reason, '') <> '' then ' (' || p_reason || ')' else '' end ||
            '. Revisa el dashboard.',
            'whatsapp', 'notify');
  end if;
end;
$$;

-- ── Enrutamiento por etapa ──────────────────────────────────
-- app_settings 'stage_routing' = {"NUEVO": 3, "PROPUESTA": 5, ...}
-- (etapa → id de miembro). Etapas sin regla conservan el asignado actual.
create or replace function route_lead_for_stage(
  p_conversation_id bigint,
  p_stage text
) returns void
language plpgsql as $$
declare
  v_member bigint;
  v_label text;
begin
  select nullif(value ->> p_stage, '')::bigint into v_member
  from app_settings where key = 'stage_routing';
  if v_member is null then return; end if;
  -- Miembro borrado o inactivo: la regla se ignora en silencio.
  if not exists (select 1 from team_members where id = v_member and active) then return; end if;

  select value -> p_stage ->> 'label' into v_label
  from app_settings where key = 'stages';

  perform assign_lead(p_conversation_id, v_member,
                      'entró a la etapa «' || coalesce(v_label, p_stage) || '»');
end;
$$;

-- ── Acceso con usuario y contraseña ─────────────────────────
-- El dashboard abre con login. Las credenciales viven en team_members
-- (hash bcrypt vía pgcrypto, generado y verificado EN Postgres — el hash
-- jamás viaja al front). La cuenta maestra es goatdev (rol ADMIN):
-- CAMBIA SU CONTRASEÑA tras el primer ingreso.
create extension if not exists pgcrypto;

alter table team_members add column if not exists username text;
alter table team_members add column if not exists password_hash text;

create unique index if not exists idx_team_members_username
  on team_members (lower(username)) where username is not null;

insert into team_members (name, role, username, password_hash)
select 'Goatdev', 'ADMIN', 'goatdev', crypt('goatdev123', gen_salt('bf'))
where not exists (
  select 1 from team_members where username is not null and lower(username) = 'goatdev'
);

-- Login: devuelve la fila del miembro si usuario+contraseña coinciden y
-- está activo; set vacío si no. Solo service_role puede ejecutarla.
create or replace function login_member(p_username text, p_password text)
returns setof team_members
language sql stable as $$
  select * from team_members
  where username is not null
    and lower(username) = lower(trim(p_username))
    and password_hash is not null
    and password_hash = crypt(p_password, password_hash)
    and active;
$$;

create or replace function set_member_password(p_member_id bigint, p_password text)
returns void
language plpgsql as $$
begin
  update team_members
  set password_hash = crypt(p_password, gen_salt('bf'))
  where id = p_member_id;
  if not found then
    raise exception 'miembro % no existe', p_member_id;
  end if;
end;
$$;

-- set_stage ahora aplica el enrutamiento tras el cambio de etapa. Gana el
-- parámetro p_route (default true): cuando el operador cambia etapa Y
-- asignado en el mismo guardado, la API lo apaga para no mandarle un aviso
-- falso al vendedor de la regla justo antes de pisar la asignación.
-- drop obligatorio: agregar un parámetro crearía una sobrecarga y dejaría
-- viva la versión vieja de dos argumentos.
drop function if exists set_stage(bigint, text);
create or replace function set_stage(
  p_conversation_id bigint,
  p_stage text,
  p_route boolean default true
) returns void
language plpgsql as $$
declare
  old_stage text;
begin
  select stage into old_stage from conversations where id = p_conversation_id;
  if old_stage is null then
    raise exception 'conversation % no existe', p_conversation_id;
  end if;
  if old_stage = p_stage then return; end if;

  update conversations
  set stage = p_stage,
      stage_changed_at = extract(epoch from now())::bigint
  where id = p_conversation_id;

  insert into lead_events (conversation_id, type, detail)
  values (p_conversation_id, 'stage', old_stage || ' → ' || p_stage);

  if p_route then
    perform route_lead_for_stage(p_conversation_id, p_stage);
  end if;
end;
$$;

-- apply_lead_analysis: el auto-avance NUEVO→CONTACTADO también enruta.
create or replace function apply_lead_analysis(
  p_conversation_id bigint,
  p_score integer,
  p_summary text,
  p_next_step text,
  p_suggested_stage text,
  p_name text,
  p_company text,
  p_email text
) returns void
language plpgsql as $$
begin
  update conversations
  set lead_score = p_score,
      ai_summary = p_summary,
      ai_next_step = p_next_step,
      ai_suggested_stage = p_suggested_stage,
      ai_analyzed_at = extract(epoch from now())::bigint,
      name = coalesce(name, p_name),
      company = coalesce(company, p_company),
      email = coalesce(email, p_email)
  where id = p_conversation_id;

  update conversations
  set stage = 'CONTACTADO',
      stage_changed_at = extract(epoch from now())::bigint
  where id = p_conversation_id and stage = 'NUEVO';

  if found then
    insert into lead_events (conversation_id, type, detail)
    values (p_conversation_id, 'stage', 'NUEVO → CONTACTADO (automático)');
    perform route_lead_for_stage(p_conversation_id, 'CONTACTADO');
  end if;
end;
$$;

-- list_conversations: expone asignación y cuenta de WhatsApp.
drop function if exists list_conversations();
create or replace function list_conversations()
returns table (
  id bigint,
  phone text,
  name text,
  mode text,
  last_message_at bigint,
  created_at bigint,
  last_message_preview text,
  stage text,
  lead_score integer,
  deal_value numeric,
  company text,
  email text,
  tags text[],
  ai_summary text,
  ai_next_step text,
  ai_suggested_stage text,
  next_follow_up_at bigint,
  follow_up_note text,
  last_user_message_at bigint,
  last_message_role text,
  channel text,
  external_id text,
  assigned_member_id bigint,
  assigned_member_name text,
  wa_account_id bigint
)
language sql stable as $$
  select
    c.id, c.phone, c.name, c.mode, c.last_message_at, c.created_at,
    (
      select m.content
      from messages m
      where m.conversation_id = c.id
      order by m.created_at desc, m.id desc
      limit 1
    ) as last_message_preview,
    c.stage, c.lead_score, c.deal_value, c.company, c.email, c.tags,
    c.ai_summary, c.ai_next_step, c.ai_suggested_stage,
    c.next_follow_up_at, c.follow_up_note, c.last_user_message_at,
    (
      select m.role
      from messages m
      where m.conversation_id = c.id
      order by m.created_at desc, m.id desc
      limit 1
    ) as last_message_role,
    c.channel, c.external_id,
    c.assigned_member_id,
    tm.name as assigned_member_name,
    c.wa_account_id
  from conversations c
  left join team_members tm on tm.id = c.assigned_member_id
  order by c.last_message_at desc nulls last, c.id desc;
$$;

-- ============================================================
-- ALARMAS + API PÚBLICA DEL CRM (aditivo e idempotente)
-- ============================================================

-- Alarmas programadas (renovaciones de suscripción, pagos, reuniones...):
-- el bot las dispara a su hora por WhatsApp (outbox kind='notify') o por
-- correo (email_queue), con recurrencia opcional.
create table if not exists alarms (
  id               bigint generated always as identity primary key,
  title            text not null,
  message          text not null default '',
  kind             text not null default 'OTRO'
                   check (kind in ('SUSCRIPCION', 'PAGO', 'REUNION', 'TAREA', 'OTRO')),
  via              text not null check (via in ('whatsapp', 'email')),
  to_phone         text,
  to_email         text,
  -- Lead relacionado (opcional, para contexto). Si se borra, la alarma queda.
  conversation_id  bigint references conversations(id) on delete set null,
  next_fire_at     bigint not null,
  repeat_every     text not null default 'NUNCA'
                   check (repeat_every in ('NUNCA', 'DIARIO', 'SEMANAL', 'MENSUAL', 'ANUAL')),
  active           boolean not null default true,
  last_fired_at    bigint,
  last_error       text,
  created_at       bigint not null default extract(epoch from now())::bigint
);

create index if not exists idx_alarms_due on alarms (active, next_fire_at);

alter table alarms enable row level security;

-- Claves de la API pública del CRM (conectar otras apps, p.ej. una landing
-- que recoge leads). Se guarda SOLO el hash SHA-256; la clave completa se
-- muestra una única vez al crearla.
create table if not exists api_keys (
  id            bigint generated always as identity primary key,
  label         text not null,
  key_hash      text not null unique,
  key_prefix    text not null,
  active        boolean not null default true,
  last_used_at  bigint,
  created_at    bigint not null default extract(epoch from now())::bigint
);

alter table api_keys enable row level security;

-- Los avisos internos (alarmas sin lead) no pertenecen a ninguna
-- conversación: conversation_id pasa a ser opcional en el outbox.
alter table outbox alter column conversation_id drop not null;

-- Canal 'api': leads inyectados por otras apps vía la API pública que no
-- traen teléfono (sin canal de respuesta; se gestionan desde el CRM).
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'conversations_channel_check') then
    alter table conversations drop constraint conversations_channel_check;
  end if;
  alter table conversations add constraint conversations_channel_check
    check (channel in ('whatsapp', 'whatsapp_api', 'messenger', 'instagram', 'api'));
end $$;

-- ── Seguridad ───────────────────────────────────────────────
-- RLS activado SIN políticas: la key anon/authenticated no puede leer
-- ni escribir nada. Solo la service_role key (que usa este proyecto
-- desde el server) tiene acceso, porque bypassa RLS.

alter table conversations enable row level security;
alter table messages enable row level security;
alter table connection_state enable row level security;
alter table outbox enable row level security;
alter table lead_notes enable row level security;
alter table lead_events enable row level security;
alter table quick_replies enable row level security;

-- Las funciones expuestas por PostgREST se ejecutan como el rol que llama;
-- revocamos EXECUTE a los roles públicos para que solo service_role pueda.
revoke execute on function insert_message(bigint, text, text) from public, anon, authenticated;
revoke execute on function insert_human_message(bigint, text) from public, anon, authenticated;
revoke execute on function list_conversations() from public, anon, authenticated;
revoke execute on function delete_conversation(bigint) from public, anon, authenticated;
revoke execute on function set_stage(bigint, text, boolean) from public, anon, authenticated;
revoke execute on function schedule_follow_up(bigint, text, bigint) from public, anon, authenticated;
revoke execute on function cancel_follow_up(bigint) from public, anon, authenticated;
revoke execute on function follow_up_sent(bigint, bigint) from public, anon, authenticated;
revoke execute on function follow_up_failed(bigint, bigint) from public, anon, authenticated;
revoke execute on function apply_lead_analysis(bigint, integer, text, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function assign_lead(bigint, bigint, text) from public, anon, authenticated;
revoke execute on function route_lead_for_stage(bigint, text) from public, anon, authenticated;
revoke execute on function login_member(text, text) from public, anon, authenticated;
revoke execute on function set_member_password(bigint, text) from public, anon, authenticated;

grant execute on function insert_message(bigint, text, text) to service_role;
grant execute on function insert_human_message(bigint, text) to service_role;
grant execute on function delete_conversation(bigint) to service_role;
grant execute on function set_stage(bigint, text, boolean) to service_role;
grant execute on function schedule_follow_up(bigint, text, bigint) to service_role;
grant execute on function cancel_follow_up(bigint) to service_role;
grant execute on function follow_up_sent(bigint, bigint) to service_role;
grant execute on function follow_up_failed(bigint, bigint) to service_role;
grant execute on function apply_lead_analysis(bigint, integer, text, text, text, text, text, text) to service_role;
grant execute on function assign_lead(bigint, bigint, text) to service_role;
grant execute on function route_lead_for_stage(bigint, text) to service_role;
grant execute on function login_member(text, text) to service_role;
grant execute on function set_member_password(bigint, text) to service_role;

-- ============================================================
-- MULTI-ORGANIZACIÓN (aditivo e idempotente)
-- Cada organización (cliente de la agencia) es un espacio aislado:
-- sus canales/tokens, sus chats, su CRM, su equipo, sus plantillas,
-- sus agentes de IA, su calendario, sus alarmas y sus colas.
-- Los datos existentes quedan en la organización 1 (la agencia).
-- messages / lead_notes / lead_events heredan la organización a
-- través de conversation_id (no llevan columna propia).
-- ============================================================

create table if not exists organizations (
  id          bigint generated always as identity primary key,
  name        text not null,
  active      boolean not null default true,
  created_at  bigint not null default extract(epoch from now())::bigint
);

alter table organizations enable row level security;

-- La organización 1 es la agencia (dueña de la plataforma).
insert into organizations (name)
select 'Motor Advertising' where not exists (select 1 from organizations);

-- org_id en todas las tablas con datos por cliente. default 1 = los datos
-- existentes migran a la agencia sin tocarlos.
alter table conversations   add column if not exists org_id bigint not null default 1 references organizations(id);
alter table team_members    add column if not exists org_id bigint not null default 1 references organizations(id);
alter table wa_accounts     add column if not exists org_id bigint not null default 1 references organizations(id);
alter table channel_settings add column if not exists org_id bigint not null default 1 references organizations(id);
alter table app_settings    add column if not exists org_id bigint not null default 1 references organizations(id);
alter table quick_replies   add column if not exists org_id bigint not null default 1 references organizations(id);
alter table alarms          add column if not exists org_id bigint not null default 1 references organizations(id);
alter table calendar_events add column if not exists org_id bigint not null default 1 references organizations(id);
alter table email_queue     add column if not exists org_id bigint not null default 1 references organizations(id);
alter table outbox          add column if not exists org_id bigint not null default 1 references organizations(id);
alter table api_keys        add column if not exists org_id bigint not null default 1 references organizations(id);

-- Claves primarias compuestas: cada organización tiene SU fila por canal y
-- SU fila por preferencia.
do $$ begin
  if exists (
    select 1 from pg_constraint
    where conname = 'channel_settings_pkey' and array_length(conkey, 1) = 1
  ) then
    alter table channel_settings drop constraint channel_settings_pkey;
    alter table channel_settings add constraint channel_settings_pkey primary key (org_id, channel);
  end if;
  if exists (
    select 1 from pg_constraint
    where conname = 'app_settings_pkey' and array_length(conkey, 1) = 1
  ) then
    alter table app_settings drop constraint app_settings_pkey;
    alter table app_settings add constraint app_settings_pkey primary key (org_id, key);
  end if;
end $$;

-- El contacto es único por organización y canal (dos clientes pueden tener
-- al mismo lead sin chocar).
drop index if exists idx_conversations_channel_ext;
create unique index if not exists idx_conversations_org_channel_ext
  on conversations (org_id, channel, external_id);

create index if not exists idx_conversations_org on conversations (org_id);
create index if not exists idx_outbox_org on outbox (org_id, sent);
create index if not exists idx_email_queue_org on email_queue (org_id, sent);

-- ── RPCs con propagación de organización ────────────────────

-- insert_human_message: el outbox hereda la organización de la conversación.
create or replace function insert_human_message(
  p_conversation_id bigint,
  p_content text
) returns messages
language plpgsql as $$
declare
  m messages;
  v_recipient text;
  v_channel text;
  v_org bigint;
begin
  select coalesce(external_id, phone), channel, org_id
  into v_recipient, v_channel, v_org
  from conversations where id = p_conversation_id;
  if v_recipient is null then
    raise exception 'conversation % no existe', p_conversation_id;
  end if;

  insert into messages (conversation_id, role, content)
  values (p_conversation_id, 'human', p_content)
  returning * into m;

  update conversations
  set last_message_at = m.created_at
  where id = p_conversation_id;

  insert into outbox (conversation_id, phone, content, channel, org_id)
  values (p_conversation_id, v_recipient, p_content, v_channel, v_org);

  return m;
end;
$$;

-- schedule_follow_up: ídem.
create or replace function schedule_follow_up(
  p_conversation_id bigint,
  p_content text,
  p_send_at bigint
) returns void
language plpgsql as $$
declare
  v_recipient text;
  v_channel text;
  v_org bigint;
begin
  select coalesce(external_id, phone), channel, org_id
  into v_recipient, v_channel, v_org
  from conversations where id = p_conversation_id;
  if v_recipient is null then
    raise exception 'conversation % no existe', p_conversation_id;
  end if;

  delete from outbox
  where conversation_id = p_conversation_id and kind = 'followup' and sent = 0;

  insert into outbox (conversation_id, phone, content, kind, scheduled_at, channel, org_id)
  values (p_conversation_id, v_recipient, p_content, 'followup', p_send_at, v_channel, v_org);

  update conversations
  set next_follow_up_at = p_send_at, follow_up_note = p_content
  where id = p_conversation_id;

  insert into lead_events (conversation_id, type, detail)
  values (p_conversation_id, 'followup_scheduled', p_content);
end;
$$;

-- assign_lead: el miembro debe ser de la MISMA organización que el lead, y
-- el aviso al vendedor hereda la organización.
create or replace function assign_lead(
  p_conversation_id bigint,
  p_member_id bigint,
  p_reason text
) returns void
language plpgsql as $$
declare
  v_current bigint;
  v_lead_name text;
  v_lead_phone text;
  v_lead_ext text;
  v_org bigint;
  v_member_name text;
  v_member_active boolean;
  v_notify text;
  v_acc_phone text;
  v_target text;
  v_display text;
begin
  select assigned_member_id, name, phone, external_id, org_id
    into v_current, v_lead_name, v_lead_phone, v_lead_ext, v_org
  from conversations where id = p_conversation_id;
  if not found then
    raise exception 'conversation % no existe', p_conversation_id;
  end if;

  if v_current is not distinct from p_member_id then return; end if;

  if p_member_id is null then
    update conversations set assigned_member_id = null where id = p_conversation_id;
    insert into lead_events (conversation_id, type, detail)
    values (p_conversation_id, 'assigned',
            'Lead sin asignar (' || coalesce(nullif(p_reason, ''), 'manual') || ')');
    return;
  end if;

  select m.name, m.active, m.notify_phone, a.phone
    into v_member_name, v_member_active, v_notify, v_acc_phone
  from team_members m
  left join wa_accounts a on a.id = m.wa_account_id
  where m.id = p_member_id and m.org_id = v_org;
  if not found then
    raise exception 'miembro % no existe en la organización %', p_member_id, v_org;
  end if;

  update conversations set assigned_member_id = p_member_id where id = p_conversation_id;
  insert into lead_events (conversation_id, type, detail)
  values (p_conversation_id, 'assigned',
          'Asignado a ' || v_member_name ||
          case when coalesce(p_reason, '') <> '' then ' — ' || p_reason else '' end);

  v_target := coalesce(nullif(v_notify, ''), v_acc_phone);
  v_display := coalesce(v_lead_name, v_lead_phone, v_lead_ext, '#' || p_conversation_id);
  if v_member_active and v_target is not null
     and v_target <> coalesce(v_lead_phone, v_lead_ext, '') then
    insert into outbox (conversation_id, phone, content, channel, kind, org_id)
    values (p_conversation_id, v_target,
            'AGENTE · Se te asignó el lead ' || v_display ||
            case when coalesce(p_reason, '') <> '' then ' (' || p_reason || ')' else '' end ||
            '. Revisa el dashboard.',
            'whatsapp', 'notify', v_org);
  end if;
end;
$$;

-- route_lead_for_stage: las reglas de enrutamiento y las etiquetas de etapa
-- son de la organización del lead.
create or replace function route_lead_for_stage(
  p_conversation_id bigint,
  p_stage text
) returns void
language plpgsql as $$
declare
  v_org bigint;
  v_member bigint;
  v_label text;
begin
  select org_id into v_org from conversations where id = p_conversation_id;
  if v_org is null then return; end if;

  select nullif(value ->> p_stage, '')::bigint into v_member
  from app_settings where key = 'stage_routing' and org_id = v_org;
  if v_member is null then return; end if;
  if not exists (
    select 1 from team_members where id = v_member and active and org_id = v_org
  ) then return; end if;

  select value -> p_stage ->> 'label' into v_label
  from app_settings where key = 'stages' and org_id = v_org;

  perform assign_lead(p_conversation_id, v_member,
                      'entró a la etapa «' || coalesce(v_label, p_stage) || '»');
end;
$$;

-- list_conversations ahora es POR organización.
drop function if exists list_conversations();
drop function if exists list_conversations(bigint);
create or replace function list_conversations(p_org_id bigint)
returns table (
  id bigint,
  phone text,
  name text,
  mode text,
  last_message_at bigint,
  created_at bigint,
  last_message_preview text,
  stage text,
  lead_score integer,
  deal_value numeric,
  company text,
  email text,
  tags text[],
  ai_summary text,
  ai_next_step text,
  ai_suggested_stage text,
  next_follow_up_at bigint,
  follow_up_note text,
  last_user_message_at bigint,
  last_message_role text,
  channel text,
  external_id text,
  assigned_member_id bigint,
  assigned_member_name text,
  wa_account_id bigint,
  org_id bigint
)
language sql stable as $$
  select
    c.id, c.phone, c.name, c.mode, c.last_message_at, c.created_at,
    (
      select m.content
      from messages m
      where m.conversation_id = c.id
      order by m.created_at desc, m.id desc
      limit 1
    ) as last_message_preview,
    c.stage, c.lead_score, c.deal_value, c.company, c.email, c.tags,
    c.ai_summary, c.ai_next_step, c.ai_suggested_stage,
    c.next_follow_up_at, c.follow_up_note, c.last_user_message_at,
    (
      select m.role
      from messages m
      where m.conversation_id = c.id
      order by m.created_at desc, m.id desc
      limit 1
    ) as last_message_role,
    c.channel, c.external_id,
    c.assigned_member_id,
    tm.name as assigned_member_name,
    c.wa_account_id,
    c.org_id
  from conversations c
  left join team_members tm on tm.id = c.assigned_member_id
  where c.org_id = p_org_id
  order by c.last_message_at desc nulls last, c.id desc;
$$;

revoke execute on function list_conversations(bigint) from public, anon, authenticated;
grant execute on function list_conversations(bigint) to service_role;
