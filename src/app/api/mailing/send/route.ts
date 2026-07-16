import { NextResponse, type NextRequest } from "next/server";
import { enqueueEmails, getSupabase, type EmailDraft } from "@/lib/db";
import { EMAIL_REGEX, renderTemplate, textToHtml } from "@/lib/mailer";
import { getAllChannelSettings } from "@/lib/db";
import { LEAD_STAGES, type LeadStage } from "@/lib/db";
import { requireMember } from "@/lib/auth";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";

interface SendBody {
  mode?: "single" | "leads" | "manual";
  to?: string;
  stages?: string[];
  manualList?: string;
  subject?: string;
  body?: string;
  isHtml?: boolean;
}

// Encola correos (individual, masivo a leads del CRM, o lista manual).
// El envío real lo hace el proceso bot respetando los límites configurados.
// Soporta variables {{nombre}}, {{empresa}}, {{email}}, {{etapa}}.
export async function POST(req: NextRequest) {
  try {
    const auth = await requireMember(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.orgId;

    // La cuenta debe estar configurada y habilitada antes de encolar.
    const settings = await getAllChannelSettings(orgId);
    const emailRow = settings["email"];
    if (!emailRow?.enabled || !emailRow.config?.host || !emailRow.config?.user) {
      return NextResponse.json(
        { error: "Configura y habilita la cuenta de correo primero (sección Cuenta)" },
        { status: 400 }
      );
    }

    const body = (await req.json().catch(() => null)) as SendBody | null;
    const subject = body?.subject?.trim() ?? "";
    const rawBody = body?.body ?? "";
    if (!subject) return NextResponse.json({ error: "Asunto requerido" }, { status: 400 });
    if (!rawBody.trim()) return NextResponse.json({ error: "Contenido requerido" }, { status: 400 });

    const html = body?.isHtml ? rawBody : textToHtml(rawBody);
    const batchId = crypto.randomUUID();
    const drafts: EmailDraft[] = [];

    if (body?.mode === "single") {
      const to = body.to?.trim().toLowerCase() ?? "";
      if (!EMAIL_REGEX.test(to)) {
        return NextResponse.json({ error: "Correo destinatario inválido" }, { status: 400 });
      }
      drafts.push({
        org_id: orgId,
        to_email: to,
        subject: renderTemplate(subject, { email: to }),
        html: renderTemplate(html, { email: to }),
        batch_id: batchId,
      });
    } else if (body?.mode === "leads") {
      // Masivo a leads del CRM que tengan email; filtro opcional por etapas.
      const stages = (body.stages ?? []).filter((s): s is LeadStage =>
        LEAD_STAGES.includes(s as LeadStage)
      );
      const sb = getSupabase();
      let query = sb
        .from("conversations")
        .select("id, name, company, email, stage")
        .eq("org_id", orgId)
        .not("email", "is", null);
      if (stages.length > 0) query = query.in("stage", stages);
      const { data, error } = await query;
      if (error) return NextResponse.json({ error: `Supabase: ${error.message}` }, { status: 500 });

      const seen = new Set<string>();
      for (const lead of (data ?? []) as {
        name: string | null;
        company: string | null;
        email: string | null;
        stage: string;
      }[]) {
        const to = lead.email?.trim().toLowerCase() ?? "";
        if (!EMAIL_REGEX.test(to) || seen.has(to)) continue;
        seen.add(to);
        const vars = {
          nombre: lead.name,
          empresa: lead.company,
          email: to,
          etapa: lead.stage,
        };
        drafts.push({
          org_id: orgId,
          to_email: to,
          to_name: lead.name,
          subject: renderTemplate(subject, vars),
          html: renderTemplate(html, vars),
          batch_id: batchId,
        });
      }
      if (drafts.length === 0) {
        return NextResponse.json(
          { error: "Ningún lead tiene email (o ninguno en las etapas elegidas)" },
          { status: 400 }
        );
      }
    } else if (body?.mode === "manual") {
      // Lista pegada: correos separados por coma, punto y coma o saltos.
      const seen = new Set<string>();
      const invalid: string[] = [];
      for (const raw of (body.manualList ?? "").split(/[\s,;]+/)) {
        const to = raw.trim().toLowerCase();
        if (!to) continue;
        if (!EMAIL_REGEX.test(to)) {
          invalid.push(to);
          continue;
        }
        if (seen.has(to)) continue;
        seen.add(to);
        drafts.push({
          org_id: orgId,
          to_email: to,
          subject: renderTemplate(subject, { email: to }),
          html: renderTemplate(html, { email: to }),
          batch_id: batchId,
        });
      }
      if (invalid.length > 0) {
        return NextResponse.json(
          { error: `Correos inválidos: ${invalid.slice(0, 5).join(", ")}${invalid.length > 5 ? "…" : ""}` },
          { status: 400 }
        );
      }
      if (drafts.length === 0) {
        return NextResponse.json({ error: "La lista no tiene correos" }, { status: 400 });
      }
    } else {
      return NextResponse.json({ error: "mode inválido" }, { status: 400 });
    }

    const queued = await enqueueEmails(drafts);
    return NextResponse.json({ ok: true, queued, batchId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
