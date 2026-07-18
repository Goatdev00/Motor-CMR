import { NextResponse, type NextRequest } from "next/server";
import {
  addLeadEvent,
  enqueueEmails,
  ensureLeadForEmail,
  getConversationById,
  insertInboundEmail,
  listAllChannelSettings,
  touchConversationInbound,
  updateLeadFields,
  type ChannelSettingsRow,
} from "@/lib/db";
import { parseResendInbound, verifySvixSignature } from "@/lib/inbound-email";
import { EMAIL_REGEX, htmlToText, textToHtml } from "@/lib/mailer";

export const dynamic = "force-dynamic";

// Webhook de correo entrante (Resend Inbound). Cuando alguien escribe a
// info@tu-dominio (o cualquier dirección del dominio), Resend recibe el
// correo por MX y lo entrega aquí como evento `email.received` firmado.
// Flujo: identificar la organización dueña VERIFICANDO la firma contra el
// secret de cada candidata (la que valida es la dueña) → crear/encontrar el
// lead por el remitente → guardar el correo (dedupe) → evento en la ficha →
// reenviar copia opcional al buzón del operador. Multi-organización: cada
// cliente configura su propio secret en Mailing; la URL es la misma para todos.

// La FIRMA es la prueba de propiedad. En lugar de enrutar por destinatario y
// luego verificar (lo que filtraría qué dominios están registrados con la
// diferencia 404/401, y dejaría que una org bloqueara a otra reclamando su
// dirección), se prueba la firma con el secret de cada candidata: cada
// webhook de Resend firma con el secret de SU cuenta, así que solo el de la
// organización real valida. Si ninguna valida → 401 uniforme, sin oráculo.
function resolveOwnerBySignature(
  rows: ChannelSettingsRow[],
  raw: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null }
): ChannelSettingsRow | null {
  const candidates = rows.filter(
    (r) => r.channel === "email" && (r.config?.inbound_secret ?? "").trim() !== ""
  );
  for (const c of candidates) {
    if (verifySvixSignature(c.config.inbound_secret, raw, headers)) return c;
  }
  return null;
}

// Elige, entre los destinatarios del correo, la dirección que pertenece a la
// organización dueña (su inbound_address, o cualquiera de su dominio de
// envío). Evita registrar como "recibido en" una dirección externa cuando el
// correo llegó con varios destinatarios (responder-a-todos).
function pickOwnerRecipient(owner: ChannelSettingsRow, to: string[]): string {
  const addr = owner.config?.inbound_address?.trim().toLowerCase();
  if (addr) {
    const exact = to.find((t) => t === addr);
    if (exact) return exact;
  }
  const sender = (owner.config?.from_email ?? owner.config?.user ?? "").trim().toLowerCase();
  const ownDomain = sender.split("@")[1];
  if (ownDomain) {
    const sameDomain = to.find((t) => t.split("@")[1] === ownDomain);
    if (sameDomain) return sameDomain;
  }
  return addr || to[0];
}

// Health check: abre la URL en el navegador para confirmar que es pública.
export async function GET() {
  return NextResponse.json({ ok: true, service: "inbound-email" });
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    // Un correo con adjuntos enormes no debe tumbar el proceso.
    if (raw.length > 2_000_000) {
      return NextResponse.json({ error: "payload demasiado grande" }, { status: 413 });
    }

    const body = (() => {
      try {
        return JSON.parse(raw) as { type?: string };
      } catch {
        return null;
      }
    })();
    if (!body) return NextResponse.json({ error: "JSON inválido" }, { status: 400 });

    // Otros eventos de Resend (email.sent, email.bounced…) no son de esta
    // bandeja: 200 para que no los reintente.
    if (body.type !== "email.received") {
      return NextResponse.json({ ok: true, ignored: body.type ?? "sin tipo" });
    }

    const parsed = parseResendInbound(body);
    if (!parsed) {
      return NextResponse.json({ error: "evento email.received malformado" }, { status: 400 });
    }

    // La organización dueña es la que firma con su secret (prueba de
    // propiedad). Respuesta 401 uniforme si nada valida: no se revela si el
    // destinatario está o no registrado.
    const rows = await listAllChannelSettings();
    const owner = resolveOwnerBySignature(rows, raw, {
      id: req.headers.get("svix-id"),
      timestamp: req.headers.get("svix-timestamp"),
      signature: req.headers.get("svix-signature"),
    });
    if (!owner) {
      return NextResponse.json({ error: "firma inválida" }, { status: 401 });
    }

    const orgId = owner.org_id;

    // El remitente es (o se vuelve) un lead de esta organización.
    const lead = await ensureLeadForEmail(orgId, parsed.fromEmail);

    // El display name del correo rellena el nombre SOLO si estaba vacío.
    if (parsed.fromName) {
      const convo = await getConversationById(lead.id, orgId).catch(() => null);
      if (convo && !convo.name) {
        await updateLeadFields(lead.id, { name: parsed.fromName }).catch(() => undefined);
      }
    }

    const bodyText = parsed.text || (parsed.html ? htmlToText(parsed.html, 10_000) : "");
    const matchedTo = pickOwnerRecipient(owner, parsed.to);

    const inserted = await insertInboundEmail({
      org_id: orgId,
      conversation_id: lead.id,
      // Sin Message-ID ni email_id, el id del evento Svix también es estable
      // entre reintentos.
      message_id: parsed.messageId ?? `svix:${req.headers.get("svix-id")}`,
      from_email: parsed.fromEmail,
      from_name: parsed.fromName,
      to_email: matchedTo,
      subject: parsed.subject,
      body_text: bodyText,
      body_html: parsed.html,
    });

    // Reintento de un evento ya procesado: nada que hacer.
    if (!inserted) return NextResponse.json({ ok: true, duplicate: true });

    // Efectos posteriores al guardado, TODOS best-effort: el correo ya quedó
    // en el hilo; si alguno falla, no se dispara un 500 que en el reintento
    // toparía con el dedupe y saldría sin ejecutar ninguno (los reintentos de
    // Resend re-firman con timestamp fresco, así que 500 aquí perdería estos
    // pasos para siempre).
    await touchConversationInbound(lead.id).catch((err) => {
      console.warn(`[inbound-email] no se pudo actualizar la conversación: ${err}`);
    });
    await addLeadEvent(
      lead.id,
      "email_in",
      `Correo recibido de ${parsed.fromEmail}: "${parsed.subject || "(sin asunto)"}"`
    ).catch(() => undefined);

    // Copia al buzón del operador (vía la cola de siempre). reply_to = el
    // cliente: responder desde Gmail le llega directo a él. GUARDA anti-bucle:
    // no reenviar a una dirección del MISMO dominio receptor (la copia
    // volvería a entrar por este webhook), ni si el propio remitente ya es de
    // ese dominio (un reenvío que rebotó).
    const forwardTo = owner.config.inbound_forward_to?.trim().toLowerCase() ?? "";
    const receivingDomain = matchedTo.split("@")[1] ?? "";
    const forwardDomain = forwardTo.split("@")[1] ?? "";
    const senderDomain = parsed.fromEmail.split("@")[1] ?? "";
    if (
      EMAIL_REGEX.test(forwardTo) &&
      forwardDomain !== receivingDomain &&
      senderDomain !== receivingDomain
    ) {
      await enqueueEmails([
        {
          org_id: orgId,
          to_email: forwardTo,
          subject: `[CRM] ${parsed.subject || "(sin asunto)"} — de ${parsed.fromEmail}`,
          html: parsed.html ?? textToHtml(bodyText),
          reply_to: parsed.fromEmail,
        },
      ]).catch((err) => {
        console.warn(`[inbound-email] no se pudo reenviar la copia: ${err}`);
      });
    }

    return NextResponse.json({ ok: true, leadId: lead.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    const hint = /email_inbound|does not exist/i.test(message)
      ? " — Falta la migración de recepción: re-ejecuta supabase/schema.sql completo en el SQL Editor."
      : "";
    // 500 → Resend reintenta: cuando la migración esté aplicada, el correo
    // entra solo en el siguiente reintento.
    return NextResponse.json({ error: message + hint }, { status: 500 });
  }
}
