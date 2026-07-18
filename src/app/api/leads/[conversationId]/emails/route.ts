import { NextResponse, type NextRequest } from "next/server";
import { getAllChannelSettings, getConversationById, listLeadEmails } from "@/lib/db";
import { htmlToText } from "@/lib/mailer";
import { requireMember } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Hilo de correos de un lead para la vista conversacional del CRM: todos los
// correos que se le han enviado (o están en cola), con su estado. El cuerpo
// llega como texto plano legible; el html crudo no se expone. Solo salientes:
// la app aún no recibe correos entrantes (eso lo hace Cloudflare/Gmail).

interface Ctx {
  params: Promise<{ conversationId: string }>;
}

// sent: 0 pendiente/encolado, 1 enviado, 2 fallido, 3 enviando.
const STATUS: Record<number, string> = {
  0: "pending",
  1: "sent",
  2: "failed",
  3: "sending",
};

export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    const auth = await requireMember(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.orgId;

    const { conversationId } = await params;
    const id = Number(conversationId);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "id inválido" }, { status: 400 });
    }

    const lead = await getConversationById(id, orgId);
    if (!lead) return NextResponse.json({ error: "Lead no encontrado" }, { status: 404 });

    // La dirección "de" para etiquetar los globos (nombre + correo remitente
    // de la cuenta SMTP configurada), y si se puede enviar correo ahora.
    const settings = await getAllChannelSettings(orgId);
    const emailCfg = settings["email"];
    const fromEmail = emailCfg?.config?.from_email?.trim() || emailCfg?.config?.user?.trim() || null;
    const fromName = emailCfg?.config?.from_name?.trim() || null;
    const accountReady = Boolean(
      emailCfg?.enabled && emailCfg.config?.host && emailCfg.config?.user
    );

    const emails = lead.email
      ? (await listLeadEmails(orgId, lead.email)).map((e) => ({
          id: e.id,
          subject: e.subject,
          body: htmlToText(e.html),
          status: STATUS[e.sent] ?? "pending",
          error: e.error,
          reply_to: e.reply_to ?? null,
          created_at: e.created_at,
          sent_at: e.sent_at,
        }))
      : [];

    return NextResponse.json({
      emails,
      leadEmail: lead.email ?? null,
      from: { name: fromName, email: fromEmail },
      accountReady,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
