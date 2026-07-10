# Agente de WhatsApp con IA (Baileys + OpenRouter + Supabase + Next.js)

Bot de WhatsApp que se conecta a un número real vía **Baileys** (WhatsApp Web,
sin Meta API ni Twilio) y responde con un LLM vía la **API de OpenAI**.
Incluye un
**dashboard** para ver conversaciones, intervenir manualmente y alternar cada
chat entre modo **IA** (responde el bot) y modo **Humano** (respondes tú desde
el navegador). La data vive en **Supabase** (Postgres).

## Arquitectura

```
 Cliente (WhatsApp)                        Tú (navegador)
        │                                        │
        ▼                                        ▼
┌────────────────┐                     ┌──────────────────┐
│  Proceso BOT   │                     │  Next.js (:3000) │
│  (Baileys)     │                     │  dashboard + API │
│  start-bot.ts  │                     └────────┬─────────┘
└──────┬─────────┘                              │
       │        lee/escribe                     │ lee/escribe
       └──────────────► SUPABASE ◄──────────────┘
                 (conversations, messages,
                  connection_state, outbox)
```

Son **dos procesos separados** que no comparten memoria: se comunican a
través de dos tablas "buzón" en Supabase:

- `connection_state` — el bot publica ahí su estado (`qr`, `connected`, ...)
  y el string del QR; el dashboard lo pollea cada 2 s. El botón "Desconectar"
  deja una señal (`restart_requested`) que el bot recoge para cerrar sesión
  y regenerar el QR.
- `outbox` — los mensajes que escribes en modo Humano se encolan ahí; el bot
  los lee cada 2 s y los envía por Baileys.

La **sesión de WhatsApp** (credenciales de Baileys) se guarda en la carpeta
local `./auth/` de la máquina donde corre el bot. Tras el primer escaneo de QR
no se vuelve a pedir mientras la sesión siga viva en el teléfono.

---

## Montaje paso a paso

### Requisitos previos

- **Node.js 20.9+** (recomendado 22). Verifica con `node --version`.
- Una cuenta gratuita en [Supabase](https://supabase.com).
- Una API key de [OpenAI](https://platform.openai.com/api-keys) con créditos.
- Un teléfono con WhatsApp para vincular el número del bot.

### Paso 1 — Crear el proyecto en Supabase

1. Entra a <https://supabase.com/dashboard> y crea un proyecto nuevo
   (**New project**). Nombre libre (ej. `agente-whatsapp`), región cercana
   (para Colombia: `East US`), y guarda la contraseña de DB que te pida
   (no la vas a necesitar para este proyecto, pero guárdala).
2. Espera ~2 minutos a que el proyecto quede activo.
3. Ve a **SQL Editor** (menú izquierdo) → **New query** → pega TODO el
   contenido de [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
   Debe terminar con "Success. No rows returned".
4. Ve a **Project Settings → API** (o **API Keys**) y copia:
   - **Project URL** → será tu `SUPABASE_URL`
   - **service_role** key (la secreta, NO la `anon`) → será tu
     `SUPABASE_SERVICE_ROLE_KEY`

> ⚠️ La `service_role` key da acceso total a la base. Solo vive en
> `.env.local` del servidor; nunca la pongas en código de frontend ni la
> subas a git (ya está en `.gitignore`).

### Paso 2 — API key de OpenAI

Crea una key en <https://platform.openai.com/api-keys> y ponla en
`OPENAI_API_KEY`. Modelo por defecto: `gpt-4o-mini` (~US$0.15 por millón de
tokens; centavos al mes para uso normal). La cuenta debe tener créditos
(el error 429/insufficient_quota significa que se agotaron).

### Paso 3 — Configurar variables de entorno

```bash
# En la raíz del proyecto
copy .env.example .env.local     # Windows
# cp .env.example .env.local     # macOS/Linux
```

Edita `.env.local` con tus valores reales:

```
SUPABASE_URL=https://tuproyecto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

### Paso 4 — Instalar dependencias

```bash
npm install
```

(Sin better-sqlite3 ya no hay compilación nativa: tarda segundos.)

### Paso 5 — Levantar todo

Abre **dos terminales** en la raíz del proyecto:

```bash
# Terminal 1: el bot de WhatsApp
npm run start:bot

# Terminal 2: el dashboard
npm run dev
```

(O un solo comando para producción: `npm run start:all` — requiere haber
corrido `npm run build` antes, porque usa `next start`.)

### Paso 6 — Iniciar sesión y escanear el QR

1. Abre <http://localhost:3000> e **inicia sesión** con la cuenta maestra:
   usuario `goatdev`, contraseña `goatdev123` (cámbiala después desde el
   menú de cuenta, abajo a la izquierda). Luego entra a la pestaña
   **Equipo**: verás la cuenta "Principal" con su QR (el bot debe estar
   corriendo para generarlo).
2. En tu teléfono: **WhatsApp → Configuración → Dispositivos vinculados →
   Vincular un dispositivo** → escanea.
3. El chip de la cuenta pasa a **Conectada** en unos segundos (ver code 515
   en Troubleshooting — es normal).
4. En reinicios posteriores del bot NO se pide QR: cada sesión queda
   guardada en `./auth/acc-<id>/`.
5. ¿Más números? **"+ Agregar cuenta"** en la misma pestaña: cada cuenta
   tiene su propio QR y el bot las atiende todas a la vez.

### Paso 7 — Probar

Escríbele al número conectado **desde otro WhatsApp**. Deberías ver:

- El mensaje aparece en el dashboard (lista izquierda + panel).
- En modo **IA** (default) el bot responde solo en unos segundos.
- Cambia el toggle a **Humano**: el bot deja de responder y se habilita el
  input para escribir tú. Tus mensajes salen firmados como "Humano" (ámbar).
- **Borrar** elimina la conversación del dashboard (con confirmación).
- **Desvincular** (pestaña Equipo, por cuenta) cierra esa sesión de WhatsApp
  y regenera su QR.

---

## CRM integrado

El dashboard incluye un CRM orientado a **cierre de leads** (pestaña **CRM**
del header; cada conversación de WhatsApp es un lead):

- **Pipeline kanban** con 6 etapas (Nuevo → Contactado → Calificado →
  Propuesta → Ganado / Perdido), arrastrar y soltar, y KPIs arriba: valor del
  pipeline abierto, ganado, tasa de cierre, leads sin responder y score
  promedio.
- **Score de IA por lead (0-100)**: tras cada mensaje del cliente (con
  debounce de 90 s) el bot analiza la conversación con el LLM y guarda score
  de intención de compra, resumen, **próximo paso recomendado** y etapa
  sugerida; además extrae nombre/empresa/email y rellena SOLO campos vacíos.
  También bajo demanda con "Analizar ahora" en la ficha.
- **Seguimientos programados**: desde la ficha eliges fecha/hora y mensaje, y
  **el bot lo envía solo por WhatsApp** a esa hora (aunque el dashboard esté
  cerrado). Uno activo por lead; cancelable; si falla la entrega queda
  registrado en la actividad.
- **Ficha del lead** (botón "Ficha" en el chat): etapa, valor estimado,
  empresa, email, etiquetas, notas internas e historial de actividad.
- **Plantillas de respuesta rápida** en el composer del modo Humano.
- **Alertas de "sin responder"**: punto rojo en la lista y chip en el kanban
  cuando el último mensaje es del cliente.
- **Derivación automática a humano**: si el cliente pide hablar con una
  persona ("quiero hablar con un asesor", "no quiero un bot"...) el bot
  confirma, pasa el chat a modo HUMANO y se calla; lo mismo si el propio LLM
  responde la frase de derivación del system prompt (constante
  `HANDOFF_PHRASE` en `src/lib/system-prompt.ts`). Queda registrado en la
  actividad del lead ("Derivado a humano").
- El botón **"Entrar al dashboard sin conectar"** de la pantalla de QR
  permite usar el CRM y el historial sin vincular WhatsApp; los envíos quedan
  en cola y salen cuando el bot conecte.

> ⚠️ Al actualizar a esta versión: **re-ejecuta `supabase/schema.sql`
> completo** en el SQL Editor (es idempotente). Sin eso, el bot se niega a
> arrancar y `/api/crm` devuelve un error explicándolo.

## Canales: WhatsApp (QR), WhatsApp API, Messenger e Instagram

El agente es **multicanal**. En el dashboard → pestaña **Canales** activas
cada uno e ingresas los tokens (todo desde el front; se guardan en Supabase):

| Canal | Cómo funciona | Qué necesitas |
| --- | --- | --- |
| **WhatsApp (QR)** | Baileys, no oficial, escaneando QR | Solo el teléfono. Toggle on/off desde Canales |
| **WhatsApp API** | Meta Cloud API oficial, por webhooks | App de Meta + número registrado en WhatsApp Business Platform (⚠️ distinto al del QR) + `Phone Number ID` + `Access Token` |
| **Messenger** | Mensajes de tu página de Facebook | `Page Access Token` con `pages_messaging` |
| **Instagram** | DMs de tu cuenta profesional vinculada a la página | `Page Access Token` con `instagram_manage_messages` |

Los cuatro comparten TODO: dashboard, CRM, análisis de IA, seguimientos
programados, plantillas y derivación a humano. Cada conversación muestra su
badge de canal.

### Configurar los canales de Meta (una vez)

1. Crea una app en <https://developers.facebook.com> (tipo Business) y
   agrégale los productos **Messenger** y/o **WhatsApp**.
2. Genera los tokens (Messenger → Instagram/Facebook → tu página) y pégalos
   en el dashboard → **Canales** → tarjeta correspondiente → **Guardar** →
   **Probar conexión**.
3. **Webhook**: Meta necesita una URL pública HTTPS. En local, abre un túnel:
   `cloudflared tunnel --url http://localhost:3000` (o ngrok) y usa
   `https://TU-TUNEL/api/webhooks/meta`. En la tarjeta Webhook del dashboard
   genera el **Verify Token** y guárdalo; registra URL + token en la app de
   Meta (Webhooks) y suscribe el campo `messages` en los objetos **Page**,
   **Instagram** y **WhatsApp Business Account**.
4. En modo desarrollo de la app de Meta solo pueden escribir los
   administradores/testers; para atender al público general debes pasar la
   **App Review** de Meta (pages_messaging / instagram_manage_messages) y,
   para Instagram, la verificación del negocio.

Notas de arquitectura: los mensajes de Meta entran por el webhook (proceso
web) y la IA responde ahí mismo por la Graph API; los envíos manuales y
seguimientos de TODOS los canales salen por el outbox, que procesa el bot —
**el proceso `npm run start:bot` debe correr siempre** (es el worker de
envíos), aunque Baileys esté deshabilitado. Meta impone una **ventana de
24 h** para responder mensajes: un seguimiento programado más allá de la
ventana puede ser rechazado por Meta (queda registrado como fallido en la
actividad del lead).

## Mailing

Pestaña **Mailing** del dashboard: conecta una cuenta de correo por **SMTP**
(Gmail con contraseña de aplicación, Outlook o dominio propio) y envía:

- **Correos individuales** personalizados, en texto o **HTML**.
- **Correos masivos**: a los leads del CRM que tengan email (con filtro por
  etapa) o a una lista pegada. Variables de personalización:
  `{{nombre}}`, `{{empresa}}`, `{{email}}`, `{{etapa}}`.

Los envíos van a una **cola** (`email_queue`) que procesa el proceso bot a
ritmo seguro (~60/min máx) con reintentos y backoff. Los **límites por hora
y por día son opcionales**: si los configuras en la cuenta se respetan
contando lo ya enviado en la ventana; vacíos = sin límite. "Probar conexión"
valida las credenciales SMTP sin enviar nada.

> Gmail: activa la verificación en 2 pasos y crea una "contraseña de
> aplicación" (myaccount.google.com/apppasswords); la contraseña normal no
> funciona por SMTP. Para volumen alto considera un dominio propio con
> SPF/DKIM configurados — enviar masivos desde Gmail daña la entregabilidad.

## Equipo (multi-cuenta + acceso + enrutamiento por etapa)

**Acceso al dashboard**: la app abre con login. La cuenta maestra es
`goatdev` / `goatdev123` (rol Admin — **cámbiale la contraseña**). Desde
Equipo, un Admin le da a cada miembro su **usuario y contraseña** y su rol:
Admin gestiona todo; Supervisor y Vendedor usan el dashboard pero ven
Equipo en solo lectura. Cada quien tiene su menú de cuenta abajo a la
izquierda (cambiar contraseña, cerrar sesión). Las contraseñas se guardan
con hash bcrypt en Postgres y nunca salen de la base.

Pestaña **Equipo** de la barra lateral, con tres bloques:

- **Cuentas de WhatsApp**: conecta **varios números por QR** (hasta 6). El
  bot mantiene una sesión por cuenta habilitada; cada tarjeta muestra su
  estado, su QR cuando toca vincular, y botones de desvincular/eliminar.
  Cada lead "pertenece" a la cuenta que recibió su mensaje.
- **Miembros del equipo**: personas con **rol** (Admin / Supervisor /
  Vendedor — informativo, el dashboard no tiene login), opcionalmente
  vinculadas a una cuenta de WhatsApp y/o con un **teléfono de avisos**.
- **Enrutamiento por etapa**: regla *etapa del pipeline → vendedor*. Cuando
  un lead entra a esa etapa (kanban, ficha o avance automático de la IA):
  1. queda **asignado** al vendedor (visible en Chats, en la ficha del lead
     y en su historial de actividad);
  2. el vendedor recibe un **aviso por WhatsApp** ("Se te asignó el lead…")
     en su cuenta vinculada o su teléfono de avisos;
  3. las **respuestas al cliente salen por la cuenta del vendedor** (si
     tiene una conectada) — el chat "se redirige" a su número.

La asignación manual se hace desde la ficha del lead ("Asignado a") y pisa
la regla hasta el próximo cambio de etapa. Los avisos internos nunca se
mezclan con el hilo del cliente, y los mensajes entre cuentas propias se
ignoran (sin loops bot↔bot).

## Alarmas

Pestaña **Alarmas**: avisos programados que el bot envía a su hora por
**WhatsApp** (por cualquiera de tus cuentas conectadas, sin tocar el hilo
del lead) o por **correo** (usa la cuenta SMTP de Mailing):

- Tipos: **Suscripción, Pago, Reunión, Tarea, Otro** — p.ej. "renovación
  del plan mensual" o "recordar el pago del hosting".
- Destino: número/correo manual, un **miembro del equipo** (su WhatsApp) o
  un **lead del CRM** (su teléfono/correo).
- **Recurrencia opcional**: una vez, diaria, semanal, mensual o anual. Si
  el bot estuvo apagado, dispara una vez y se reprograma hacia el futuro
  (sin ráfagas atrasadas).
- Cada alarma muestra su próximo disparo, el último envío y cualquier error.

## API del CRM (conectar otras apps)

En **Canales → "API del CRM"** generas claves (solo Admin) para que otras
aplicaciones se conecten — p.ej. una landing o app que recoge leads:

- `POST /api/public/leads` con header `X-API-Key` crea (o completa) un
  lead: `{name, phone, email, company, message, source}`. Con teléfono, el
  lead nace como conversación de WhatsApp (si luego escribe, es el mismo
  hilo) y **dispara el enrutamiento del equipo** (asignación + aviso al
  vendedor). Sin teléfono queda en el canal "API externa" (solo CRM).
- `GET /api/public/leads` lista los leads (integraciones de solo lectura).
- La clave completa se muestra **una sola vez** al generarla (en la base
  queda solo su hash); revócala cuando quieras desde la misma tarjeta.
- El ejemplo `curl` listo para copiar está en la propia tarjeta.

## Calendario (+ Google Drive)

Pestaña **Calendario** del dashboard (la navegación vive en la **barra
lateral izquierda**, plegable con el botón "Contraer"). Incluye:

- **Vistas Mes / Semana / Agenda** (agenda = próximos 30 días). Clic en un
  día crea un evento; clic en un evento lo edita; **arrastra** un evento a
  otro día para moverlo (conserva la hora).
- Eventos con color (paleta propia oscura), hora o **día completo**, lugar,
  descripción, **lead del CRM vinculado** y archivos de **Google Drive
  adjuntos**.
- Los **seguimientos automáticos** programados desde el CRM aparecen en el
  calendario como recordatorios ámbar (solo lectura: se gestionan desde la
  ficha del lead).

### Conectar Google Drive (opcional, una vez)

Todo se configura desde el botón **"Google Drive"** del calendario:

1. En [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
   crea un proyecto → pantalla de consentimiento OAuth (tipo **Externo**,
   agrega tu correo como **usuario de prueba**) → Credenciales → **ID de
   cliente de OAuth** → tipo **Aplicación web**.
2. En "URI de redirección autorizados" registra la URI que muestra el modal
   (botón Copiar), p.ej. `http://localhost:3000/api/google/callback`.
3. Habilita la **API de Google Drive** en el proyecto (APIs y servicios →
   Biblioteca → Google Drive API → Habilitar).
4. Pega el Client ID y el Client Secret en el modal → "Guardar credenciales"
   → **"Conectar con Google"** → autoriza tu cuenta.

Con la cuenta conectada puedes **buscar y adjuntar archivos de tu Drive** a
los eventos, y **"Guardar respaldo en Drive"** sube el calendario completo
como `calendario-agente.ics` a la carpeta AGENTE (importable en Google
Calendar: Configuración → Importar y exportar → Importar).

> Google mostrará el aviso "app no verificada" porque el cliente OAuth es
> tuyo y está en modo prueba: pulsa "Configuración avanzada" → continuar.
> Es tu propia app accediendo a tu propio Drive.

## Personalizar el system prompt

Edita [`src/lib/system-prompt.ts`](src/lib/system-prompt.ts) con las
instrucciones de TU negocio (tono, qué vende, horarios, qué debe derivar a un
humano, etc.) y reinicia el proceso del bot (`Ctrl+C` y `npm run start:bot`).

## Cambiar de modelo

Cambia `OPENAI_MODEL` en `.env.local` (p.ej. `gpt-4o-mini`, `gpt-4.1-mini`)
y reinicia el proceso del bot.

---

## Deploy en producción (EasyPanel / Railway, sin Docker)

Ya están incluidos `Procfile`, `nixpacks.toml` y `.nvmrc` (Node 22).

1. Sube el repo a GitHub (sin `.env.local` — ya está ignorado).
2. Crea la app apuntando al repo; Nixpacks detecta Node y usa
   `npm run start:all` como comando de arranque.
3. Configura las 4 variables de entorno del Paso 3 en el panel.
4. **Volumen persistente obligatorio**: monta `/app/auth`. Sin él, cada
   redespliegue borra la sesión de Baileys y toca re-escanear el QR.
   (La data de conversaciones vive en Supabase, así que ya no hace falta
   el volumen `/app/data` del diseño original.)

### 🔴 SEGURIDAD antes de exponer a internet

El dashboard tiene **login con usuario y contraseña** (todas las APIs
exigen sesión; solo el webhook de Meta queda abierto y valida su propia
firma). Antes de desplegar público:

1. **Cambia la contraseña de la cuenta maestra `goatdev`** (menú de cuenta,
   abajo a la izquierda → Cambiar contraseña). El default `goatdev123` es
   público en este README.
2. Sirve el dominio por **HTTPS** (EasyPanel/Caddy lo dan gratis): sin TLS
   la cookie de sesión y las contraseñas viajan en claro.
3. Usa contraseñas fuertes para cada miembro del equipo.

Capas extra opcionales: Cloudflare Access o basic auth en el proxy.

> Nota sobre revocación: la sesión es un token firmado de 7 días. Al
> desactivar a un miembro pierde la gestión de Equipo al instante y la UI
> lo expulsa en ≤1 minuto, pero un token robado podría seguir leyendo datos
> vía API hasta expirar. Si necesitas cortar el acceso YA: cambia la
> `SUPABASE_SERVICE_ROLE_KEY` (rota el proyecto de Supabase) — invalida
> todas las sesiones firmadas.

---

## Troubleshooting

| Síntoma | Causa | Solución |
| --- | --- | --- |
| `code=405` al conectar | Versión del protocolo WA desactualizada | Ya mitigado: el bot llama `fetchLatestBaileysVersion()` en cada arranque. Si persiste, actualiza Baileys: `npm i @whiskeysockets/baileys@latest` |
| `code=440` en loop | WhatsApp ve el dispositivo como desconocido o hay sesiones viejas | Ya se usa `Browsers.macOS('Desktop')` y backoff de 15 s. En el teléfono: Dispositivos vinculados → borra dispositivos de pruebas anteriores. Si persiste en VPS, cambia de IP o espera 24 h |
| `code=515` justo tras escanear | **Es normal**: señal de pairing exitoso | El bot reconecta solo en ~2 s y queda conectado |
| Error 429 / insufficient_quota del LLM | La cuenta de OpenAI se quedó sin créditos | Recarga en https://platform.openai.com/settings/organization/billing |
| El QR no aparece en el navegador | El proceso bot no corre, o `.env.local` incompleto | Revisa la terminal del bot; la pantalla de QR muestra el error tras 10 s |
| `connection_state está vacía` | No se ejecutó el schema | Corre `supabase/schema.sql` en el SQL Editor |
| `Node.js detected but native WebSocket not found` | supabase-js exige WebSocket nativo (Node 22+) | Ya mitigado: se le pasa la implementación de `ws` vía `realtime.transport` en `db.ts`. Si reaparece, actualiza a Node 22 (`nvm install 22`) |
| Procesos zombie en Windows (puerto ocupado, bot duplicado) | `Ctrl+C` no siempre mata a los hijos de `tsx`/`next` | `tasklist \| findstr node` y luego `taskkill /F /PID <pid>` |
| El bot responde dos veces | Dos procesos bot corriendo a la vez | Mata los duplicados (ver fila anterior). Nunca corras dos `start:bot` contra la misma DB |

## Mejoras aplicadas sobre el diseño original

- **Supabase en lugar de SQLite**: capa `db.ts` async, transacciones vía
  funciones Postgres (`insert_message`, `delete_conversation`), y el bot y el
  dashboard pueden correr incluso en máquinas distintas.
- **RLS activado sin políticas** + revoke de las funciones RPC: la key `anon`
  no puede leer nada; solo la `service_role` del server accede.
- **Señal de reinicio por DB** (`connection_state.restart_requested`) en vez
  del archivo `./data/.restart`: evita depender de un filesystem compartido y
  los locks de Windows (es el bot quien borra `./auth/`, no la API web).
- **Logout automático limpio**: si cierras sesión desde el teléfono
  (code 401), el bot borra credenciales y regenera QR solo, sin quedarse muerto.
- **Dedup de mensajes entrantes** (cache de ids): Baileys puede re-entregar
  mensajes tras una reconexión; sin esto el bot contestaba doble.
- **Outbox con límite de reintentos** (5 intentos → descartado): un mensaje
  con número inválido ya no se reintenta infinitamente cada 2 s.
- **Backoff diferenciado por código**: 440 → 15 s, 515 → 2 s, resto → 5 s.
- **`export const dynamic = "force-dynamic"`** en los GET de la API: sin esto
  Next puede cachear la respuesta y el polling no ve cambios.
- **Errores del LLM no tumban el bot**: si la API de OpenAI falla (429/key
  mala) el mensaje del cliente queda guardado y visible en el dashboard.
- Se eliminó el script `next lint` (removido en Next.js 16) y la dependencia
  de compiladores nativos en el deploy (python3/gcc eran para better-sqlite3).

Además, una revisión multi-agente (5 revisores + panel de verificación por
hallazgo) confirmó y se corrigieron estos bugs del diseño base:

- **Ciclo de vida del socket serializado** (contador de generación + guard de
  socket obsoleto): sin esto, pulsar "Desconectar" disparaba una carrera en la
  que el handler del socket viejo borraba las credenciales del nuevo y dejaba
  el QR regenerándose en loop; también podían quedar dos sockets vivos
  respondiendo doble (440 en bucle).
- **Mensaje humano atómico** (RPC `insert_human_message`): guardar y encolar
  en la misma transacción; antes un blip de Supabase entre ambas llamadas
  dejaba mensajes visibles en el panel que nunca llegaban al cliente.
- **Outbox robusto**: no quema intentos cuando la conexión está caída (antes
  una caída de ~10 s descartaba mensajes humanos en silencio) y no reenvía si
  el mensaje ya salió pero falló el marcado (antes: hasta 5 copias al cliente).
- **Mensajes temporales**: se usa `normalizeMessageContent` de Baileys; antes
  los chats con "mensajes temporales" activados quedaban mudos.
- **Soporte de JIDs `@lid`** (número oculto, cada vez más común en WhatsApp):
  el número real se extrae de `key.senderPn`; antes esos chats se descartaban
  en silencio y el bot parecía muerto. Los mensajes filtrados ahora se loguean.
- **Dedup correcto**: el id del mensaje se marca como procesado solo después
  de persistirlo; antes, un fallo transitorio de Supabase perdía el mensaje
  para siempre.
- **Respuesta del bot**: se envía primero y se guarda después; antes un fallo
  de envío dejaba "mensajes fantasma" en el historial y en el contexto del LLM.
- **UI**: callbacks memoizados (el borrador del operador se borraba cada 2 s),
  guards contra respuestas de polling fuera de orden o de conversaciones ya
  cerradas, errores visibles al enviar/desconectar, y aviso cuando el estado
  del QR lleva >90 s sin actualizarse (bot caído).
- **auth/ compatible con volúmenes**: se borra el contenido, no el directorio
  (en producción es un punto de montaje y `rm` fallaba con EBUSY dejando el
  bot muerto).

El CRM pasó por su propia revisión multi-agente (116 agentes, 31 hallazgos
confirmados y corregidos), destacando: schema re-ejecutable sin errores
(única definición de `list_conversations`), outbox con **reclamo condicional**
(`sent=3` "enviando": cancelar/reprogramar un seguimiento ya no puede cruzarse
con una entrega en vuelo ni generar mensajes fantasma), análisis de IA
**atómico en SQL** (no pisa etapas ni datos que el operador acaba de cambiar),
"Guardar ficha" envía solo campos modificados, y validación del valor
estimado con formatos locales ("2.500.000").

## Mejoras pendientes (v2)

- Soporte de imágenes salientes (enviar PNG de productos).
- Function calling real con `tools` de OpenRouter.
- WebSocket / Supabase Realtime en lugar de polling cada 2 s.
- Autenticación básica en el dashboard (middleware de Next.js).
- Soporte de grupos (@g.us).
- Transcripción de audios entrantes.
