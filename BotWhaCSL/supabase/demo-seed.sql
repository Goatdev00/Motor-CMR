-- ============================================================
--  DATOS DE DEMOSTRACIÓN (opcional) — BotWha CSL
-- ============================================================
--  Ejecutar en el SQL Editor DESPUÉS de schema.sql, solo para
--  demos: carga leads, chats, notas, calendario y una alarma de
--  ejemplo para que el dashboard no se vea vacío.
--
--  Es inofensivo e idempotente: si ya existe cualquier
--  conversación en la base, no hace nada. Para la instalación
--  real del cliente simplemente NO lo ejecutes (o borra los
--  leads de demo desde el propio dashboard).
--
--  Nota: no crea filas en el outbox ni programa envíos reales;
--  aunque conectes un WhatsApp, nada de esto dispara mensajes
--  (la única alarma queda programada a 30 días, desactívala o
--  bórrala desde la pestaña Alarmas cuando termine la demo).
-- ============================================================

do $$
declare
  v_now     bigint := extract(epoch from now())::bigint;
  v_today0  bigint := extract(epoch from date_trunc('day', now()))::bigint;
  v_admin   bigint;
  v_maria   bigint;
  v_carlos  bigint;
  v_laura   bigint;
  v_pedro   bigint;
  v_ana     bigint;
  v_jorge   bigint;
begin
  if exists (select 1 from conversations) then
    raise notice 'Ya hay conversaciones en la base: seed de demo omitido.';
    return;
  end if;

  select id into v_admin from team_members where username = 'admin' limit 1;

  -- ── Lead 1: calificado, esperando respuesta (punto rojo) ──
  insert into conversations
    (phone, name, mode, channel, external_id, stage, lead_score, deal_value,
     company, email, tags, ai_summary, ai_next_step, ai_analyzed_at,
     last_message_at, last_user_message_at, stage_changed_at)
  values
    ('573001234567', 'María Fernández', 'AI', 'whatsapp', '573001234567',
     'CALIFICADO', 82, 2500000, 'Clínica Dental Sonría',
     'maria@clinicasonria.co', '{urgente}',
     'Dueña de clínica dental, busca automatizar la agenda de citas y responder pacientes fuera de horario. Presupuesto aprobado, decide esta semana.',
     'Enviar video corto de la agenda automática y proponer llamada de 15 min.',
     v_now - 3600, v_now - 1800, v_now - 1800, v_now - 86400)
  returning id into v_maria;

  insert into messages (conversation_id, role, content, created_at) values
    (v_maria, 'user',      'Hola, vi su publicidad. ¿El bot puede agendar citas solo?', v_now - 172800),
    (v_maria, 'assistant', '¡Hola María! Sí: el asistente responde 24/7, califica al paciente y agenda la cita en el calendario del consultorio. ¿Cuántas citas manejan al día aproximadamente?', v_now - 172740),
    (v_maria, 'user',      'Unas 25 entre las dos sedes. ¿Y si el paciente pide hablar con una persona?', v_now - 172680),
    (v_maria, 'assistant', 'En ese caso el bot deriva el chat a tu equipo de inmediato y deja de responder — ustedes retoman la conversación desde el panel. ¿Te muestro cómo se ve?', v_now - 172620),
    (v_maria, 'user',      'Sí, me interesa. ¿Me pueden compartir precios para dos sedes?', v_now - 1800);

  insert into lead_notes (conversation_id, content, created_at) values
    (v_maria, 'Tiene 2 sedes (Chapinero y Cedritos). Le urge para la temporada de ortodoncia.', v_now - 90000);

  -- ── Lead 2: propuesta enviada, en modo humano, asignado ──
  insert into conversations
    (phone, name, mode, channel, external_id, stage, lead_score, deal_value,
     company, email, tags, ai_summary, ai_next_step, ai_analyzed_at,
     next_follow_up_at, follow_up_note, assigned_member_id,
     last_message_at, stage_changed_at)
  values
    ('573109876543', 'Carlos Ruiz', 'HUMAN', 'whatsapp', '573109876543',
     'PROPUESTA', 74, 4800000, 'Ferretería El Tornillo',
     'carlos@eltornillo.com.co', '{mayorista}',
     'Distribuidor mayorista, recibe ~80 pedidos por WhatsApp al día y pierde ventas por demora. Ya revisó la propuesta, negocia forma de pago.',
     'Confirmar si aprueba pago trimestral y agendar arranque.',
     v_now - 7200, v_today0 + 86400 + 36000,
     'Preguntar por la propuesta ajustada con pago trimestral',
     v_admin, v_now - 7200, v_now - 172800)
  returning id into v_carlos;

  insert into messages (conversation_id, role, content, created_at) values
    (v_carlos, 'user',      'Buenas, ¿me pueden cotizar el sistema para pedidos?', v_now - 432000),
    (v_carlos, 'assistant', '¡Claro Carlos! Cuéntame: ¿cuántos pedidos al día reciben por WhatsApp y cuántas personas los atienden?', v_now - 431940),
    (v_carlos, 'user',      'Como 80 pedidos y somos 3 atendiendo, no damos abasto.', v_now - 431880),
    (v_carlos, 'human',     'Carlos, te habla Juan de Motor. Te acabo de enviar la propuesta al correo con los 3 planes. El que más les sirve es el Pro: el bot toma el pedido completo y ustedes solo confirman despacho.', v_now - 172800),
    (v_carlos, 'user',      'La revisé, se ve bien. ¿Se puede pagar trimestral?', v_now - 86400),
    (v_carlos, 'human',     'Sí, te ajusto la propuesta con pago trimestral y te la paso mañana.', v_now - 7200);

  insert into lead_notes (conversation_id, content, created_at) values
    (v_carlos, 'Decisor directo (dueño). Prefiere pagos trimestrales. No tocar precios de lista.', v_now - 86000);

  insert into lead_events (conversation_id, type, detail, created_at) values
    (v_carlos, 'stage', 'Contactado → Propuesta', v_now - 172800),
    (v_carlos, 'followup_scheduled', 'Seguimiento programado para mañana 10:00', v_now - 7000);

  -- ── Lead 3: llegó por WhatsApp API (canal oficial) ──
  insert into conversations
    (phone, name, mode, channel, external_id, stage, lead_score,
     company, ai_summary, ai_next_step, ai_analyzed_at, last_message_at)
  values
    ('573201112233', 'Laura Gómez', 'AI', 'whatsapp_api', '573201112233',
     'CONTACTADO', 45, 'Boutique Lala',
     'Tienda de ropa pequeña, pregunta precios pero aún compara opciones.',
     'Compartir caso de éxito de retail y resolver la duda del costo mensual.',
     v_now - 10800, v_now - 10800)
  returning id into v_laura;

  insert into messages (conversation_id, role, content, created_at) values
    (v_laura, 'user',      'Hola! ¿Cuánto vale el asistente para una tienda de ropa?', v_now - 14400),
    (v_laura, 'assistant', '¡Hola Laura! Depende del volumen de chats. Para una boutique el plan inicial suele ser suficiente: responde tallas, precios y disponibilidad, y te pasa los pedidos listos. ¿Manejan catálogo en Instagram o solo WhatsApp?', v_now - 14340),
    (v_laura, 'user',      'Solo WhatsApp por ahora. Déjame pensarlo y te escribo.', v_now - 10800);

  -- ── Lead 4: nuevo, sin analizar, esperando respuesta ──
  insert into conversations
    (phone, name, mode, channel, external_id, stage,
     last_message_at, last_user_message_at)
  values
    ('573155554444', 'Pedro Martínez', 'AI', 'whatsapp', '573155554444',
     'NUEVO', v_now - 600, v_now - 600)
  returning id into v_pedro;

  insert into messages (conversation_id, role, content, created_at) values
    (v_pedro, 'user', 'Buenas tardes, me pasaron este número. ¿Ustedes hacen bots para restaurantes?', v_now - 600);

  -- ── Lead 5: cerrado ganado ──
  insert into conversations
    (phone, name, mode, channel, external_id, stage, lead_score, deal_value,
     company, email, ai_summary, ai_next_step, ai_analyzed_at,
     last_message_at, stage_changed_at)
  values
    ('573187776655', 'Ana Torres', 'HUMAN', 'whatsapp', '573187776655',
     'GANADO', 91, 3200000, 'Academia Inglés Ya',
     'ana@inglesya.edu.co',
     'Academia de idiomas, cerró plan anual para matrículas y recordatorios de clase.',
     'Iniciar onboarding: conectar número y cargar prompt del negocio.',
     v_now - 172800, v_now - 172800, v_now - 172800)
  returning id into v_ana;

  insert into messages (conversation_id, role, content, created_at) values
    (v_ana, 'user',  '¿Cómo sería el arranque si firmamos hoy?', v_now - 259200),
    (v_ana, 'human', 'Firmando hoy, mañana mismo conectamos su número y en 2 días el asistente queda respondiendo matrículas. Te paso el contrato.', v_now - 258000),
    (v_ana, 'user',  'Listo, firmado y pagado. ¡Arranquemos!', v_now - 172900),
    (v_ana, 'human', '¡Bienvenida Ana! 🎉 Mañana te escribe el equipo de onboarding.', v_now - 172800);

  insert into lead_events (conversation_id, type, detail, created_at) values
    (v_ana, 'stage', 'Propuesta → Ganado', v_now - 172800);

  -- ── Lead 6: entró por la API pública del CRM (formulario web) ──
  insert into conversations
    (phone, name, mode, channel, external_id, stage, email, company, tags,
     last_message_at)
  values
    (null, 'Jorge Peláez', 'AI', 'api', 'web-000123',
     'NUEVO', 'jorge@constructorapelaez.co', 'Constructora Peláez', '{web}',
     v_now - 3600)
  returning id into v_jorge;

  insert into messages (conversation_id, role, content, created_at) values
    (v_jorge, 'user', '[Formulario web] Quiero información del plan empresarial para el área comercial.', v_now - 3600);

  -- ── Respuestas rápidas (botón ⚡ del chat) ──
  insert into quick_replies (title, content) values
    ('Saludo',    '¡Hola! Gracias por escribirnos 😊 ¿En qué te podemos ayudar hoy?'),
    ('Precios',   'Te comparto nuestros planes: Inicial, Pro y Empresarial. ¿Cuántas conversaciones al día manejan aprox. para recomendarte el ideal?'),
    ('Despedida', '¡Gracias por tu tiempo! Cualquier duda quedamos atentos por este medio. 🙌');

  -- ── Calendario ──
  insert into calendar_events (title, description, location, starts_at, ends_at, all_day, color, conversation_id) values
    ('Llamada con Carlos Ruiz — propuesta ajustada',
     'Confirmar pago trimestral y fecha de arranque.', 'Google Meet',
     v_today0 + 86400 + 54000, v_today0 + 86400 + 57600, false, '#60a5fa', v_carlos),
    ('Demo en vivo — Clínica Sonría',
     'Mostrar agenda automática y derivación a humano.', 'Oficina cliente',
     v_today0 + 259200 + 36000, v_today0 + 259200 + 41400, false, '#34d399', v_maria),
    ('Onboarding Academia Inglés Ya',
     'Conectar número y cargar prompt del negocio.', '',
     v_today0 + 172800, null, true, '#f59e0b', v_ana);

  -- ── Alarma de ejemplo (a 30 días: no dispara durante la demo) ──
  insert into alarms (title, message, kind, via, to_phone, next_fire_at, repeat_every, active) values
    ('Renovación hosting del cliente',
     'Recordatorio: renovar el hosting y pasar factura.',
     'PAGO', 'whatsapp', '573000000000', v_now + 2592000, 'MENSUAL', true);

  raise notice 'Datos de demostración cargados: 6 leads, chats, notas, 3 eventos de calendario y 1 alarma.';
end $$;
