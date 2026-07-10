import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import {
  addLeadEvent,
  addLeadNote,
  getOrCreateConversation,
  insertMessage,
  listConversations,
  routeLeadForStage,
  updateLeadFields,
  upgradeApiLeadToWhatsapp,
} from "@/lib/db";
import { maybeAnalyzeLead } from "@/lib/lead-analysis";
import { verifyApiKey } from "@/lib/api-keys";

export const dynamic = "force-dynamic";

// API pública del CRM: otras apps (landings, formularios, recolectores de
// leads) se conectan con una clave generada en Canales → "API del CRM".
// Autenticación: header X-API-Key (o Authorization: Bearer).

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: "Clave API inválida o revocada. Genera una en Canales → API del CRM." },
    { status: 401 }
  );
}

// Tope por clave (en memoria): una clave filtrada no puede crear leads
// ilimitados — cada lead nuevo dispara el enrutamiento y un aviso de
// WhatsApp al vendedor (riesgo de baneo del número por spam).
const RATE_LIMIT_PER_HOUR = 120;
const usage = new Map<number, { count: number; windowStart: number }>();

function overRateLimit(keyId: number): boolean {
  const now = Date.now();
  const u = usage.get(keyId);
  if (!u || now - u.windowStart > 3600_000) {
    usage.set(keyId, { count: 1, windowStart: now });
    return false;
  }
  u.count += 1;
  return u.count > RATE_LIMIT_PER_HOUR;
}

// Crear (o completar) un lead desde una app externa.
// Body: { name?, phone?, email?, company?, message?, source? } — con
// teléfono el lead nace como conversación de WhatsApp (se fusiona con el
// hilo real si el cliente escribe); sin teléfono queda en el canal 'api'.
export async function POST(req: NextRequest) {
  try {
    const key = await verifyApiKey(req);
    if (!key) return unauthorized();
    if (overRateLimit(key.id)) {
      return NextResponse.json(
        { error: `Límite de ${RATE_LIMIT_PER_HOUR} peticiones/hora por clave alcanzado` },
        { status: 429 }
      );
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "JSON inválido" }, { status: 400 });

    const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
    const company = typeof body.company === "string" ? body.company.trim().slice(0, 100) : "";
    const message = typeof body.message === "string" ? body.message.trim().slice(0, 2000) : "";
    const source = typeof body.source === "string" ? body.source.trim().slice(0, 60) : "";

    let phone: string | null = null;
    if (typeof body.phone === "string" && body.phone.trim() !== "") {
      const digits = body.phone.replace(/[\s\-+().]/g, "");
      if (!/^\d{7,15}$/.test(digits)) {
        return NextResponse.json(
          { error: "phone inválido (solo dígitos, con indicativo de país)" },
          { status: 400 }
        );
      }
      phone = digits;
    }
    let email: string | null = null;
    if (typeof body.email === "string" && body.email.trim() !== "") {
      const value = body.email.trim().toLowerCase();
      if (!EMAIL_REGEX.test(value) || value.length > 200) {
        return NextResponse.json({ error: "email inválido" }, { status: 400 });
      }
      email = value;
    }
    if (!phone && !email && !name) {
      return NextResponse.json(
        { error: "Se necesita al menos name, phone o email" },
        { status: 400 }
      );
    }

    // Con teléfono el lead vive en WhatsApp (mismo hilo si luego escribe);
    // sin teléfono, canal 'api' con el correo como identificador (dedupe) o
    // un id sintético si tampoco hay correo.
    const channel = phone ? ("whatsapp" as const) : ("api" as const);
    const externalId = phone ?? email ?? `api-${randomUUID()}`;

    // Dedupe cruzada: si este contacto ya existía solo con correo (canal
    // 'api') y ahora llega su teléfono, se asciende la MISMA fila a WhatsApp
    // en vez de crear un duplicado.
    let convo =
      phone && email ? await upgradeApiLeadToWhatsapp(email, phone) : null;
    if (!convo) {
      convo = await getOrCreateConversation(channel, externalId, {
        name: name || undefined,
        phone,
      });
    }
    const isNew = convo.last_message_at === null && convo.created_at >= Math.floor(Date.now() / 1000) - 10;

    // Los datos de contacto solo RELLENAN campos vacíos (nunca pisan lo que
    // el operador o la IA ya escribieron) — mismo contrato que el análisis.
    const fill: { email?: string; company?: string } = {};
    if (email && !convo.email) fill.email = email;
    if (company && !convo.company) fill.company = company;
    if (Object.keys(fill).length > 0) await updateLeadFields(convo.id, fill);

    if (message) {
      if (convo.channel === "api") {
        // Canal 'api': el hilo nunca alimenta al LLM (no hay inbound real),
        // así que el mensaje puede vivir en la conversación, y el análisis
        // de IA del CRM sí lo aprovecha.
        await insertMessage(convo.id, "user", message);
        void maybeAnalyzeLead(convo.id);
      } else {
        // Hilo REAL de WhatsApp: el texto de la API va como NOTA interna,
        // nunca como turno 'user' — insertarlo en el historial permitía que
        // un portador de clave inyectara "palabras del cliente" al LLM.
        await addLeadNote(convo.id, `Mensaje recibido vía API${source ? ` (${source})` : ""}: ${message}`);
      }
    }

    await addLeadEvent(
      convo.id,
      "api",
      `Lead recibido vía API${source ? ` · fuente: ${source}` : ""} (clave: ${key.label})`
    );

    // Lead nuevo en etapa NUEVO: aplica el enrutamiento del equipo
    // (asignación + aviso por WhatsApp al vendedor de la regla).
    if (isNew && (convo.stage ?? "NUEVO") === "NUEVO") {
      routeLeadForStage(convo.id, "NUEVO").catch(() => undefined);
    }

    return NextResponse.json(
      {
        ok: true,
        created: isNew,
        lead: {
          id: convo.id,
          name: convo.name ?? (name || null),
          phone: convo.phone ?? phone,
          email: convo.email ?? email,
          channel,
          stage: convo.stage ?? "NUEVO",
        },
      },
      { status: isNew ? 201 : 200 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}

// Listado de leads para integraciones de solo lectura (dashboards externos).
export async function GET(req: NextRequest) {
  try {
    const key = await verifyApiKey(req);
    if (!key) return unauthorized();

    // Campos públicos SOLAMENTE: el valor del negocio y el vendedor asignado
    // son datos internos del CRM y no salen por la API.
    const leads = (await listConversations()).slice(0, 500).map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      company: c.company,
      channel: c.channel,
      stage: c.stage,
      lead_score: c.lead_score,
      created_at: c.created_at,
      last_message_at: c.last_message_at,
    }));
    return NextResponse.json({ leads });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
