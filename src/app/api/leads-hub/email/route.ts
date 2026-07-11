import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import {
  addLeadEvent,
  enqueueEmails,
  getAllChannelSettings,
  getSupabase,
  setAppSetting,
  type EmailDraft,
} from "@/lib/db";
import { EMAIL_REGEX, renderTemplate, textToHtml } from "@/lib/mailer";

export const dynamic = "force-dynamic";

// Envío de correo desde la sección Leads: a leads seleccionados (por id) o a
// una dirección suelta. A diferencia de Mailing, aquí cada envío lleva su
// "Responder a" (Reply-To) decidido en la interfaz; el valor puede guardarse
// como predeterminado (app_settings) para prellenar la próxima vez.

// Clave en app_settings del Responder-a predeterminado (misma que usa
// /api/leads-hub/settings).
const REPLY_TO_SETTING = "leads_reply_to";

interface SendBody {
  leadIds?: number[];
  to?: string;
  subject?: string;
  body?: string;
  isHtml?: boolean;
  replyTo?: string;
  saveReplyToDefault?: boolean;
}

export async function POST(req: NextRequest) {
  try {
    const settings = await getAllChannelSettings();
    const emailRow = settings["email"];
    if (!emailRow?.enabled || !emailRow.config?.host || !emailRow.config?.user) {
      return NextResponse.json(
        { error: "Configura y habilita la cuenta de correo primero (pestaña Mailing)" },
        { status: 400 }
      );
    }

    const body = (await req.json().catch(() => null)) as SendBody | null;
    const subject = body?.subject?.trim() ?? "";
    const rawBody = body?.body ?? "";
    if (!subject) return NextResponse.json({ error: "Asunto requerido" }, { status: 400 });
    if (!rawBody.trim()) return NextResponse.json({ error: "Contenido requerido" }, { status: 400 });

    const replyTo = body?.replyTo?.trim().toLowerCase() ?? "";
    if (replyTo && !EMAIL_REGEX.test(replyTo)) {
      return NextResponse.json({ error: "El correo de 'Responder a' es inválido" }, { status: 400 });
    }

    const html = body?.isHtml ? rawBody : textToHtml(rawBody);
    const batchId = crypto.randomUUID();
    const drafts: EmailDraft[] = [];
    // Ids de leads por draft (mismo índice) para registrar el evento después.
    const draftLeadIds: (number | null)[] = [];

    const leadIds = (body?.leadIds ?? []).filter(
      (id): id is number => Number.isInteger(id) && id > 0
    );

    if (leadIds.length > 0) {
      const sb = getSupabase();
      const { data, error } = await sb
        .from("conversations")
        .select("id, name, company, email, stage")
        .in("id", leadIds.slice(0, 2000));
      if (error) {
        return NextResponse.json({ error: `Supabase: ${error.message}` }, { status: 500 });
      }
      const seen = new Set<string>();
      let withoutEmail = 0;
      for (const lead of (data ?? []) as {
        id: number;
        name: string | null;
        company: string | null;
        email: string | null;
        stage: string;
      }[]) {
        const to = lead.email?.trim().toLowerCase() ?? "";
        if (!EMAIL_REGEX.test(to)) {
          withoutEmail++;
          continue;
        }
        if (seen.has(to)) continue;
        seen.add(to);
        const vars = { nombre: lead.name, empresa: lead.company, email: to, etapa: lead.stage };
        drafts.push({
          to_email: to,
          to_name: lead.name,
          subject: renderTemplate(subject, vars),
          html: renderTemplate(html, vars),
          batch_id: batchId,
          ...(replyTo ? { reply_to: replyTo } : {}),
        });
        draftLeadIds.push(lead.id);
      }
      if (drafts.length === 0) {
        return NextResponse.json(
          {
            error:
              withoutEmail > 0
                ? `Ninguno de los leads seleccionados tiene un correo válido (${withoutEmail} sin correo)`
                : "No se encontraron los leads seleccionados",
          },
          { status: 400 }
        );
      }
    } else {
      const to = body?.to?.trim().toLowerCase() ?? "";
      if (!EMAIL_REGEX.test(to)) {
        return NextResponse.json({ error: "Correo destinatario inválido" }, { status: 400 });
      }
      drafts.push({
        to_email: to,
        subject: renderTemplate(subject, { email: to }),
        html: renderTemplate(html, { email: to }),
        batch_id: batchId,
        ...(replyTo ? { reply_to: replyTo } : {}),
      });
      draftLeadIds.push(null);
    }

    try {
      await enqueueEmails(drafts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Columna reply_to sin migrar: mensaje claro en vez de un error críptico.
      if (replyTo && /reply_to/i.test(msg)) {
        return NextResponse.json(
          {
            error:
              "La base de datos no tiene la columna reply_to todavía: re-ejecuta supabase/schema.sql en el SQL Editor de Supabase (o envía sin 'Responder a').",
          },
          { status: 400 }
        );
      }
      throw err;
    }

    // Rastro en el historial de cada lead (mejor esfuerzo: si falla no
    // deshace el encolado).
    const detail = `Correo encolado: "${subject}"${replyTo ? ` · responder a ${replyTo}` : ""}`;
    await Promise.all(
      draftLeadIds
        .filter((id): id is number => id !== null)
        .map((id) => addLeadEvent(id, "email", detail).catch(() => undefined))
    );

    if (body?.saveReplyToDefault && replyTo) {
      await setAppSetting(REPLY_TO_SETTING, replyTo).catch(() => undefined);
    }

    return NextResponse.json({ ok: true, queued: drafts.length, batchId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
