import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import {
  addLeadEvent,
  addLeadNote,
  getOrCreateConversation,
  updateLeadFields,
  upgradeApiLeadToWhatsapp,
} from "@/lib/db";
import { EMAIL_REGEX } from "@/lib/mailer";
import { requireMember } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Importación de leads desde la sección Leads del dashboard: el navegador
// parsea el CSV/Excel (SheetJS) y manda las filas ya mapeadas. Misma lógica
// de dedupe que la API pública: con teléfono el lead nace como conversación
// de WhatsApp (se fusiona con el hilo real si el cliente escribe); sin
// teléfono queda en el canal 'api' con el correo como identificador.

interface ImportRow {
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  company?: unknown;
  note?: unknown;
}

const MAX_ROWS = 2000;

function cleanText(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.trim().slice(0, max) : "";
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireMember(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.orgId;

    const body = (await req.json().catch(() => null)) as {
      rows?: ImportRow[];
      source?: string;
    } | null;
    if (!body || !Array.isArray(body.rows) || body.rows.length === 0) {
      return NextResponse.json({ error: "No hay filas para importar" }, { status: 400 });
    }
    if (body.rows.length > MAX_ROWS) {
      return NextResponse.json(
        { error: `Máximo ${MAX_ROWS} filas por importación (llegaron ${body.rows.length})` },
        { status: 400 }
      );
    }
    const source = cleanText(body.source, 80) || "archivo";

    let created = 0;
    let merged = 0;
    let skipped = 0;

    for (const row of body.rows) {
      const name = cleanText(row.name, 100);
      const company = cleanText(row.company, 100);
      const note = cleanText(row.note, 2000);

      let phone: string | null = null;
      const rawPhone =
        typeof row.phone === "number" ? String(row.phone) : cleanText(row.phone, 40);
      if (rawPhone) {
        const digits = rawPhone.replace(/[\s\-+().]/g, "");
        if (/^\d{7,15}$/.test(digits)) phone = digits;
      }

      let email: string | null = null;
      const rawEmail = cleanText(row.email, 200).toLowerCase();
      if (rawEmail && EMAIL_REGEX.test(rawEmail)) email = rawEmail;

      // Sin ningún dato de contacto ni nombre, la fila no sirve de nada.
      if (!phone && !email && !name) {
        skipped++;
        continue;
      }

      const channel = phone ? ("whatsapp" as const) : ("api" as const);
      const externalId = phone ?? email ?? `import-${randomUUID()}`;

      // Dedupe cruzada (igual que la API pública): correo ya existente en el
      // canal 'api' + teléfono nuevo = se asciende la MISMA fila a WhatsApp.
      let convo = phone && email ? await upgradeApiLeadToWhatsapp(orgId, email, phone) : null;
      if (!convo) {
        convo = await getOrCreateConversation(orgId, channel, externalId, {
          name: name || undefined,
          phone,
        });
      }
      const isNew =
        convo.last_message_at === null &&
        convo.created_at >= Math.floor(Date.now() / 1000) - 10;

      // Los datos del archivo solo RELLENAN campos vacíos (nunca pisan lo
      // que el operador o la IA ya escribieron). La etiqueta 'importado'
      // permite filtrar estos leads en la sección.
      const fill: { email?: string; company?: string; tags?: string[] } = {};
      if (email && !convo.email) fill.email = email;
      if (company && !convo.company) fill.company = company;
      const tags = Array.isArray(convo.tags) ? convo.tags : [];
      if (!tags.includes("importado")) fill.tags = [...tags, "importado"];
      if (Object.keys(fill).length > 0) await updateLeadFields(convo.id, fill);

      if (note) await addLeadNote(convo.id, `Nota del archivo importado: ${note}`);
      await addLeadEvent(convo.id, "import", `Lead importado de ${source}`);

      if (isNew) created++;
      else merged++;
    }

    return NextResponse.json({ ok: true, created, merged, skipped });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
