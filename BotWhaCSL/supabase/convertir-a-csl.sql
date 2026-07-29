-- ============================================================
--  CONVERSIÓN A BotWha CSL
-- ============================================================
--  Úsalo SOLO si ejecutaste por error el schema.sql del proyecto
--  padre (BotWha) en vez de BotWhaCSL/supabase/schema.sql: deja la
--  base exactamente con la forma del schema CSL sin perder datos.
--  Es idempotente. Ejecutar en el SQL Editor y después (opcional)
--  el demo-seed.sql.
-- ============================================================

-- 1) Fuera las tablas de mailing/correo y la vestigial connection_state.
drop table if exists email_queue cascade;
drop table if exists email_inbound cascade;
drop table if exists connection_state cascade;

-- 2) Alarmas: solo vía WhatsApp, sin destino de correo.
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'alarms_via_check') then
    alter table alarms drop constraint alarms_via_check;
  end if;
  -- Filas heredadas con via='email' quedarían huérfanas: se apagan antes
  -- de estrechar el check (en una base recién creada no hay ninguna).
  update alarms set via = 'whatsapp', active = false where via = 'email';
  alter table alarms add constraint alarms_via_check check (via in ('whatsapp'));
end $$;
alter table alarms drop column if exists to_email;

-- 3) Canales: solo WhatsApp (Baileys), WhatsApp Cloud API y la API del CRM.
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'conversations_channel_check') then
    alter table conversations drop constraint conversations_channel_check;
  end if;
  alter table conversations add constraint conversations_channel_check
    check (channel in ('whatsapp', 'whatsapp_api', 'api'));
end $$;

-- Filas de configuración de canales eliminados (si el dashboard padre no
-- llegó a usarse, no existen; por si acaso).
delete from channel_settings where channel in ('messenger', 'instagram', 'email');

-- 4) Acceso: la cuenta maestra pasa de goatdev a admin/admin123
--    (cámbiale la contraseña tras el primer login).
update team_members
set name = 'Administrador',
    username = 'admin',
    password_hash = crypt('admin123', gen_salt('bf'))
where lower(username) = 'goatdev';
