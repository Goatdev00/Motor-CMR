import { NextResponse, type NextRequest } from "next/server";
import {
  getAllChannelSettings,
  getConversationById,
  listInboundEmails,
  listLeadEmails,
} from "@/lib/db";
import { htmlToText } from "@/lib/mailer";
import { requireMember } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Hilo de correos de un lead para la vista conversacional del CRM:
// - Salientes: los de la cola de envíos (email_queue) a su dirección.
// - Entrantes: los recibidos por el webhook de Resend Inbound (email_inbound).
// Se devuelven fusionados en orden cronológico con su dirección ('in'/'out');
// el cuerpo llega como texto plano legible (el html crudo no se expone).

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
    // Recepción configurada = el hilo también muestra respuestas del cliente.
    const inboundReady = Boolean(emailCfg?.config?.inbound_secret);
    const inboundAddress = emailCfg?.config?.inbound_address?.trim() || null;

    const outbound = lead.email
      ? (await listLeadEmails(orgId, lead.email)).map((e) => ({
          key: `out-${e.id}`,
          direction: "out" as const,
          subject: e.subject,
          body: htmlToText(e.html),
          status: STATUS[e.sent] ?? "pending",
          error: e.error,
          reply_to: e.reply_to ?? null,
          from_name: null as string | null,
          from_email: null as string | null,
          created_at: e.created_at,
          sent_at: e.sent_at,
        }))
      : [];

    // Tabla email_inbound sin migrar → el hilo sigue funcionando solo con
    // los salientes (el webhook ya avisa de la migración por su lado).
    const inbound = (await listInboundEmails(id).catch(() => [])).map((e) => ({
      key: `in-${e.id}`,
      direction: "in" as const,
      subject: e.subject,
      body: e.body_text || (e.body_html ? htmlToText(e.body_html) : ""),
      status: "received",
      error: null as string | null,
      reply_to: null as string | null,
      from_name: e.from_name,
      from_email: e.from_email,
      created_at: e.created_at,
      sent_at: null as number | null,
    }));

    // Orden cronológico. El desempate debe ser ANTISIMÉTRICO (cmp(a,b) ===
    // -cmp(b,a)) o Array.sort se comporta indefinido y puede invertir grupos
    // empatados: como created_at es epoch en SEGUNDOS, dos correos del mismo
    // segundo empatan. Al empatar: primero los salientes, luego los entrantes;
    // dentro de la misma dirección, por el id numérico del key (out-<id>/in-<id>).
    const seq = (k: string) => Number(k.split("-")[1]) || 0;
    const emails = [...outbound, ...inbound].sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at - b.created_at;
      if (a.direction !== b.direction) return a.direction === "out" ? -1 : 1;
      return seq(a.key) - seq(b.key);
    });

    return NextResponse.json({
      emails,
      leadEmail: lead.email ?? null,
      from: { name: fromName, email: fromEmail },
      accountReady,
      inboundReady,
      inboundAddress,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
