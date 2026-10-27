# BotWha CSL — CRM de WhatsApp con IA (Baileys + OpenAI + Supabase + Next.js)

**BotWha CSL** es la instalación personalizada para su empresa del CRM de
WhatsApp con IA de Motor Advertising. El bot se conecta a un número real de
WhatsApp de dos formas: vía **Baileys** (WhatsApp Web, escaneando un QR, sin
Twilio) o vía la **WhatsApp Cloud API oficial de Meta** (webhook + Graph
API), y responde con un LLM vía la **API de OpenAI**. Incluye un
**dashboard** para ver conversaciones, intervenir manualmente y alternar cada
chat entre modo **IA** (responde el bot) y modo **Humano** (respondes tú desde
el navegador). La data vive en **Supabase** (Postgres).

## Arquitectura

```
 Cliente (WhatsApp)                        Tú (navegador)
        │                                        │
        ▼                                        ▼
┌────────────────┐                     ┌──────────────────┐
│  Proceso BOT   │                     │  Next.js (:3013) │
│  (Baileys)     │                     │  dashboard + API │
│  start-bot.ts  │                     └────────┬─────────┘
└──────┬─────────┘                              │
       │        lee/escribe                     │ lee/escribe
       └──────────────► SUPABASE ◄──────────────┘
                 (conversations, messages,
                  wa_accounts, outbox)
```

Son **dos procesos separados** que no comparten memoria: se comunican a
través de dos tablas "buzón" en Supabase:

- `wa_accounts` — una fila por cuenta de WhatsApp: el bot publica ahí su
  estado (`qr`, `connected`, ...) y el string del QR; el dashboard lo pollea
  cada 2 s desde la pestaña **Equipo**. El botón "Desvincular" deja una señal
  (`restart_requested`) que el bot recoge para cerrar sesión y regenerar el
  QR.
- `outbox` — los mensajes que escribes en modo Humano se encolan ahí; el bot
  los lee cada 2 s y los envía por Baileys.

La **sesión de WhatsApp** (credenciales de Baileys) se guarda en la carpeta
local `./auth/` de la máquina donde corre el bot. Tras el primer escaneo de QR
no se vuelve a pedir mientras la sesión siga viva en el teléfono.

> ⚠️ **Nunca dentro de OneDrive/Dropbox/Drive**: el bot reescribe los
> archivos de sesión constantemente y la sincronización los corrompe — los
> mensajes "se envían" pero no llegan, y al final la sesión muere. Si el
> proyecto vive en una carpeta sincronizada, crea `auth/` como *junction* a
> una carpeta local, p.ej.:
> `New-Item -ItemType Junction -Path .\auth -Target "$env:LOCALAPPDATA\BotWhaCSL-auth"`

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
   - *Opcional, solo para demos*: ejecuta también
     [`supabase/demo-seed.sql`](supabase/demo-seed.sql) para cargar leads,
     chats, calendario y una alarma de ejemplo (no hace nada si la base ya
     tiene datos).
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

> Esta variable es el proveedor **por defecto**. Una vez montado el
> dashboard también puedes configurar el proveedor de IA (OpenAI, Anthropic
> o Gemini), su api key y el modelo desde **Canales → tarjeta
> "Inteligencia artificial (IA)"** — si esa tarjeta está activa, manda ella
> y no hace falta tocar el `.env.local`.

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

En Windows, para desarrollo local, `npm run dev:local` levanta bot +
dashboard en <http://localhost:3434> (o el puerto de `PORT`) y antes mata
el bot anterior de esta copia y lo que ocupe ese puerto, así nunca quedan
dos bots con la misma sesión. Si se abre `dev:local` otra vez, la ventana
anterior cierra su bot ordenadamente y se va cuando la nueva ya levantó el
suyo y lleva unos segundos corriendo (si la nueva se cierra antes, la
anterior vuelve a levantarlo). Además el bot se niega a arrancar si ya hay
otro corriendo para esta instalación, se haya lanzado como se haya lanzado
(`auth/bot.lock`); y si un bot estuvo congelado (p.ej. la consola en modo
selección) y otro tomó su lugar, al volver se cierra solo.

### Paso 6 — Iniciar sesión y escanear el QR

1. Abre <http://localhost:3013> e **inicia sesión** con la cuenta inicial:
   usuario `admin`, contraseña `admin123` (**cámbiala tras el primer
   login** desde el menú de cuenta, abajo a la izquierda). Luego entra a la
   pestaña **Equipo**: verás la cuenta "Principal" con su QR (el bot debe
   estar corriendo para generarlo).
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
de la barra lateral; cada conversación de WhatsApp es un lead):

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
- **El dashboard funciona sin WhatsApp vinculado**: tras iniciar sesión
  puedes usar el CRM y el historial aunque ninguna cuenta esté conectada;
  los envíos quedan en cola y salen cuando una cuenta conecte (los QR viven
  en la pestaña **Equipo**, por cuenta).

> ⚠️ Al actualizar a esta versión: **re-ejecuta `supabase/schema.sql`
> completo** en el SQL Editor (es idempotente). Sin eso, el bot se niega a
> arrancar y `/api/crm` devuelve un error explicándolo.

## Canales: WhatsApp (QR), WhatsApp API y API del CRM

En el dashboard → pestaña **Canales** activas cada canal e ingresas los
tokens (todo desde el front; se guardan en Supabase):

| Canal | Cómo funciona | Qué necesitas |
| --- | --- | --- |
| **WhatsApp (QR)** | Baileys, no oficial, escaneando QR | Solo el teléfono. Toggle on/off desde Canales |
| **WhatsApp API** | Meta Cloud API oficial, por webhooks (`/api/webhooks/meta`) | App de Meta + número registrado en WhatsApp Business Platform (⚠️ distinto al del QR) + `Phone Number ID` + `Access Token` |
| **API del CRM** | Otras apps crean/consultan leads por HTTP | Una clave generada en Canales → "API del CRM" (ver sección más abajo) |

Todos comparten TODO: dashboard, CRM, análisis de IA, seguimientos
programados, plantillas y derivación a humano. Cada conversación muestra su
badge de canal.

### Configurar WhatsApp API (una vez)

1. Crea una app en <https://developers.facebook.com> (tipo Business) y
   agrégale el producto **WhatsApp**.
2. Registra tu número en WhatsApp Business Platform, copia el
   `Phone Number ID` y genera un `Access Token` permanente; pégalos en el
   dashboard → **Canales** → tarjeta **WhatsApp Business (API oficial de
   Meta)** → **Guardar** → **Probar conexión**.
3. **Webhook**: Meta necesita una URL pública HTTPS. En local, abre un túnel:
   `cloudflared tunnel --url http://localhost:3013` (o ngrok) y usa
   `https://TU-TUNEL/api/webhooks/meta`. En la tarjeta **Webhook de Meta
   (WhatsApp API)** del dashboard genera el **Verify Token** y pega el
   **App Secret** de tu app (Meta → Configuración de la app → Básica →
   Clave secreta de la app) y guarda; registra URL + token en la app de
   Meta (Webhooks) y suscribe el campo `messages` en el objeto **WhatsApp
   Business Account**. **Sin App Secret el webhook rechaza todo** (responde
   503): sin la firma, cualquiera podría inyectar mensajes falsos de
   clientes. Solo para pruebas locales existe
   `META_WEBHOOK_ALLOW_UNSIGNED=1` en `.env.local` (ignorada en producción).
4. En modo desarrollo de la app de Meta solo pueden escribir los números de
   prueba y los administradores/testers; para atender al público general
   debes completar la **verificación del negocio** de Meta y publicar la app.

Notas de arquitectura: los mensajes de WhatsApp API entran por el webhook
(proceso web), que solo los guarda y responde 200 al instante; la IA
responde en segundo plano en ese mismo proceso por la Graph API. Los envíos
manuales, seguimientos y respuestas que quedaron en cola de TODOS los canales
salen por el outbox, que procesa el bot — **el proceso `npm run start:bot`
debe correr siempre** (es el worker de envíos), aunque Baileys esté
deshabilitado. Meta impone una **ventana de 24 h** para responder mensajes:
un seguimiento programado más allá de la ventana puede ser rechazado por Meta
(queda registrado como fallido en la actividad del lead).

## Muchos clientes a la vez: contexto aislado y nada se pierde

El bot atiende a muchas personas en paralelo sin mezclar conversaciones:
cada mensaje se guarda en el hilo de SU contacto (organización + canal +
número) y cada respuesta se arma solo con el historial de ese hilo y se
envía al mismo chat por el que escribió el cliente. Además:

- **Ráfagas**: si alguien manda varios mensajes seguidos, el bot responde
  una vez con todo el contexto (no una respuesta por mensaje ni repetidas).
  Si el cliente sigue escribiendo mientras la IA redacta, la respuesta se
  rehace con lo nuevo. Si en la ráfaga aparece una **palabra clave**, su
  respuesta automática cuenta como respuesta a lo escrito antes en esa
  ráfaga, y la IA responde lo que el cliente escriba después.
- **Nada se pierde**: guardar un mensaje es idempotente y con reintentos.
  Cada mensaje recibido se anota primero en un diario en disco
  (`auth/inbound-journal.jsonl`): si el bot se cierra a la fuerza o se corta
  la luz antes de guardarlo, se recupera al arrancar. Si Supabase está caído
  más de ~1 min, el mensaje queda respaldado en `auth/inbound-spool.jsonl` y
  se guarda (en orden) cuando la base vuelve. Si la IA o el envío fallan, se
  reintenta; si la cuenta sigue caída, la respuesta queda en cola y sale al
  reconectar, con el mismo id (WhatsApp descarta una segunda copia); si no
  sale en 30 min, la conversación pasa a un asesor. Tras un reinicio, el
  bot retoma solo las conversaciones que quedaron sin responder; las que
  estaba reintentando (también el aviso de derivación a un asesor) quedan
  anotadas en `auth/reply-retries.json`, con hasta dónde se había respondido.
- **Al reconectar**, el bot primero recibe TODO lo que llegó mientras estaba
  desconectado (si WhatsApp lo retiene en lotes, pide los siguientes) y
  recién después responde: así ve la respuesta que un asesor pudo haber dado
  desde el teléfono, y los mensajes nuevos del cliente. Un envío nunca sale
  por una conexión nueva sin haber recibido antes lo pendiente de ella.
- **Respuestas en cola primero**: si una respuesta quedó en cola (canal
  caído) y el cliente vuelve a escribir, primero sale la de la cola y la
  siguiente ya la tiene en cuenta (nada de responder dos veces lo mismo).
  Los mensajes a un mismo cliente (del dashboard o en cola) salen en el
  orden en que se escribieron, aunque alguno haya tenido que esperar.
- **Nunca encima de un humano**: si un asesor toma la conversación
  (dashboard) mientras la IA redacta, la respuesta de la IA no sale; las
  respuestas por palabra clave y el aviso de derivación también se
  verifican justo antes de salir. Lo que el equipo escribe desde el
  **teléfono del negocio o WhatsApp Web** queda en el hilo (con el mismo
  respaldo en disco que los mensajes de clientes) y pausa la IA. Un chat que
  un asesor **inicia** desde el teléfono crea el lead en modo HUMANO. La
  bienvenida automática de WhatsApp Business (la que sale 1-3 s después del
  primer mensaje de un lead, también en anuncios "clic a WhatsApp") queda
  marcada como automática y no pausa la IA; su texto se aprende
  (`auth/auto-texts.json`) para reconocerla aunque salga unos segundos más
  tarde. Cualquier otro mensaje del teléfono cuenta como un asesor; una
  reacción o una edición no.
- **WhatsApp API (Meta)**: un envío que Meta no alcanzó a confirmar no se
  repite (podría llegar dos veces); queda registrado con un aviso en la
  actividad del lead. Los mensajes a un número no registrado en Canales se
  guardan (en la organización de la agencia) y pasan a un asesor, sin
  respuesta automática.
- **Multimedia**: se leen las leyendas de fotos/videos/documentos; notas de
  voz, imágenes sin texto, ubicaciones, contactos, pedidos y productos del
  catálogo, encuestas y formularios quedan registrados con una marca y la
  IA pide que lo escriban.
- **Apagado ordenado**: con `npm run dev:local`, **Ctrl+C** le pide al bot
  terminar lo que tiene en curso antes de salir (hasta ~30 s). Cerrar la
  ventana con la X le da solo unos segundos (Windows termina los procesos):
  el bot hace un cierre corto y lo que no alcance lo retoma al volver a
  arrancar. Para cerrar, mejor Ctrl+C.
- **Visibilidad**: en la actividad de cada lead quedan los rechazos de
  WhatsApp/Meta (p.ej. error 463), las respuestas que quedaron en cola y
  las derivaciones automáticas.

**Migración (una vez):** ejecuta en el SQL Editor de Supabase la sección
**"BLINDAJE DEL PIPELINE DE MENSAJES"** del final de `supabase/schema.sql`
(o el archivo completo: es idempotente). El bot funciona sin ella, pero con
ella es *imposible* guardar o responder dos veces un mensaje re-entregado, y
las respuestas que no salen en el momento quedan **en cola**: sin ella no
se pueden dejar en cola de forma segura (no habría cómo saber, tras un
reinicio, qué mensaje respondía cada una), así que si WhatsApp está caído
varios minutos el bot reintenta en vivo y, si no puede, la conversación
pasa a un asesor.

Ajustes opcionales en `.env.local`: `AUTO_REPLY_MAX_AGE_HOURS` (por defecto
24: mensajes escritos hace más que esto — p.ej. con el bot apagado un día —
se guardan pero no se responden solos) y `LLM_MAX_CONCURRENCY` (por defecto
6 llamadas simultáneas a la IA por proceso).

## Equipo (multi-cuenta + acceso + enrutamiento por etapa)

**Acceso al dashboard**: la app abre con login. La cuenta inicial es
`admin` / `admin123` (rol Admin — **cámbiale la contraseña tras el primer
login**). Desde Equipo, un Admin le da a cada miembro su **usuario y
contraseña** y su rol: Admin gestiona todo; Supervisor y Vendedor usan el
dashboard pero ven Equipo en solo lectura. Cada quien tiene su menú de cuenta
abajo a la izquierda (cambiar contraseña, cerrar sesión). Las contraseñas se
guardan con hash bcrypt en Postgres y nunca salen de la base.

Pestaña **Equipo** de la barra lateral, con tres bloques:

- **Cuentas de WhatsApp**: conecta **varios números por QR** (hasta 6). El
  bot mantiene una sesión por cuenta habilitada; cada tarjeta muestra su
  estado, su QR cuando toca vincular, y botones de desvincular/eliminar.
  Cada lead "pertenece" a la cuenta que recibió su mensaje.
- **Miembros del equipo**: personas con **rol** (Admin / Supervisor /
  Vendedor), opcionalmente vinculadas a una cuenta de WhatsApp y/o con un
  **teléfono de avisos**.
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
del lead):

- Tipos: **Suscripción, Pago, Reunión, Tarea, Otro** — p.ej. "renovación
  del plan mensual" o "recordar el pago del hosting".
- Destino: número manual, un **miembro del equipo** (su WhatsApp) o un
  **lead del CRM** (su teléfono).
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
   (botón Copiar), p.ej. `http://localhost:3013/api/google/callback`.
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

## Personalizar los prompts del bot

Desde el dashboard: pestaña **Equipo → Equipo de IA → Prompts del bot**.
Ahí editas el **prompt principal** con las instrucciones de TU negocio
(tono, qué vende, horarios, qué debe derivar a un humano, etc.), con un
generador de prompts con IA incluido. Los cambios aplican sin reiniciar
nada. La frase exacta de derivación a humano vive en
[`src/lib/system-prompt.ts`](src/lib/system-prompt.ts) (`HANDOFF_PHRASE`).

## Cambiar de modelo

Desde el dashboard: **Canales → tarjeta "Inteligencia artificial (IA)"**
(proveedor, api key y modelo). Si esa tarjeta está apagada, el bot usa el
fallback del `.env.local`: cambia `OPENAI_MODEL` (p.ej. `gpt-4o-mini`,
`gpt-4.1-mini`) y reinicia el proceso del bot.

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

1. **Cambia la contraseña de la cuenta inicial `admin`** (menú de cuenta,
   abajo a la izquierda → Cambiar contraseña). El default `admin123` es
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
| El QR no aparece | El proceso bot no corre, o `.env.local` incompleto | Revisa la terminal del bot y el estado de la cuenta en la pestaña **Equipo** (botón "Generar QR" de la tarjeta de la cuenta) |
| El bot avisa que falta la migración del CRM al arrancar | No se ejecutó el schema | Corre `supabase/schema.sql` completo en el SQL Editor |
| `Node.js detected but native WebSocket not found` | supabase-js exige WebSocket nativo (Node 22+) | Ya mitigado: se le pasa la implementación de `ws` vía `realtime.transport` en `db.ts`. Si reaparece, actualiza a Node 22 (`nvm install 22`) |
| Procesos zombie en Windows (puerto ocupado, bot duplicado) | `Ctrl+C` no siempre mata a los hijos de `tsx`/`next` | `tasklist \| findstr node` y luego `taskkill /F /PID <pid>` |
| El bot responde dos veces | Dos procesos bot corriendo a la vez | Mata los duplicados (ver fila anterior). Nunca corras dos `start:bot` contra la misma DB |
| Las respuestas se ven en el dashboard pero NO llegan al WhatsApp del cliente | (a) Dos bots con la misma sesión (en la terminal del bot verás `code=440` en bucle), o (b) la carpeta `auth/` está en OneDrive y la sesión se corrompió | (a) Deja UNA sola instancia (`tasklist \| findstr node` + `taskkill`). (b) Saca `auth/` de OneDrive (junction, ver Arquitectura), en el teléfono cierra los dispositivos vinculados muertos y re-escanea el QR desde Equipo |
