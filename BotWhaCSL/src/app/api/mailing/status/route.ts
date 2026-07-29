import { NextResponse, type NextRequest } from "next/server";
import { getEmailStats, listRecentEmails } from "@/lib/db";
import { requireMember } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Estado de la cola de correos para la pestaña Mailing (poll del dashboard).
export async function GET(req: NextRequest) {
  try {
    const auth = await requireMember(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.orgId;

    const [stats, recent] = await Promise.all([getEmailStats(orgId), listRecentEmails(orgId, 20)]);
    // El html completo no se necesita en la lista; se recorta para el poll.
    const items = recent.map((e) => ({
      id: e.id,
      to_email: e.to_email,
      subject: e.subject,
      sent: e.sent,
      attempts: e.attempts,
      error: e.error,
      created_at: e.created_at,
      sent_at: e.sent_at,
    }));
    return NextResponse.json({ stats, recent: items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    const hint = /email_queue|does not exist/i.test(message)
      ? " — Falta la migración de mailing: re-ejecuta supabase/schema.sql completo en el SQL Editor."
      : "";
    return NextResponse.json({ error: message + hint }, { status: 500 });
  }
}
