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
// Flujo: enrutar a la organización dueña del destinatario → verificar la
// firma con SU Signing Secret → crear/encontrar el lead por el remitente →
// guardar el correo (dedupe) → evento en la ficha → reenviar copia opcional
// al buzón del operador. Multi-organización: cada cliente configura su
// propio secret en Mailing; la URL del endpoint es la misma para todos.

// Enrutamiento del evento: ¿de qué organización es este destinatario?
// 1) config.inbound_address coincide exacto con algún destinatario.
// 2) el dominio del remitente configurado (from_email/user) coincide con el
//    dominio de algún destinatario.
// 3) una sola organización tiene la recepción configurada → es ella.
function resolveOrgForInbound(
  rows: ChannelSettingsRow[],
  to: string[]
): ChannelSettingsRow | null {
  const candidates = rows.filter(
    (r) => r.channel === "email" && (r.config?.inbound_secret ?? "").trim() !== ""
  );
  if (candidates.length === 0) return null;

  const toSet = new Set(to.map((t) => t.toLowerCase()));
  const toDomains = new Set(
    to.map((t) => t.split("@")[1]?.toLowerCase()).filter(Boolean)
  );

  const exact = candidates.filter((r) => {
    const addr = r.config?.inbound_address?.trim().toLowerCase();
    return Boolean(addr && toSet.has(addr));
  });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null; // dirección repetida entre orgs: ambiguo

  const byDomain = candidates.filter((r) => {
    const sender = (r.config?.from_email ?? r.config?.user ?? "").trim().toLowerCase();
    const domain = sender.split("@")[1];
    return Boolean(domain && toDomains.has(domain));
  });
  if (byDomain.length === 1) return byDomain[0];
  if (byDomain.length > 1) return null;

  return candidates.length === 1 ? candidates[0] : null;
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

    const rows = await listAllChannelSettings();
    const owner = resolveOrgForInbound(rows, parsed.to);
    if (!owner) {
      // Sin organización dueña no hay secret con qué verificar: se descarta.
      console.warn(`[inbound-email] destinatario sin organización: ${parsed.to.join(", ")}`);
      return NextResponse.json({ error: "destinatario no registrado" }, { status: 404 });
    }

    // La firma se verifica con el secret de la organización enrutada. Sin
    // esto, cualquiera podría inyectar correos falsos al CRM de un cliente.
    const ok = verifySvixSignature(owner.config.inbound_secret, raw, {
      id: req.headers.get("svix-id"),
      timestamp: req.headers.get("svix-timestamp"),
      signature: req.headers.get("svix-signature"),
    });
    if (!ok) {
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
    const matchedTo =
      parsed.to.find(
        (t) => t === owner.config.inbound_address?.trim().toLowerCase()
      ) ?? parsed.to[0];

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

    await touchConversationInbound(lead.id);
    await addLeadEvent(
      lead.id,
      "email_in",
      `Correo recibido de ${parsed.fromEmail}: "${parsed.subject || "(sin asunto)"}"`
    ).catch(() => undefined);

    // Copia al buzón del operador (mejor esfuerzo, vía la cola de siempre).
    // reply_to = el cliente: responder desde Gmail le llega directo a él.
    // GUARDA anti-bucle: jamás reenviar hacia el mismo dominio que recibe —
    // la copia volvería a entrar por este webhook y se reenviaría infinito.
    const forwardTo = owner.config.inbound_forward_to?.trim().toLowerCase() ?? "";
    const receivingDomain = matchedTo.split("@")[1] ?? "";
    if (EMAIL_REGEX.test(forwardTo) && forwardTo.split("@")[1] !== receivingDomain) {
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
