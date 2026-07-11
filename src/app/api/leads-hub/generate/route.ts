import { NextResponse, type NextRequest } from "next/server";
import { getConversationById, getLeadNotes } from "@/lib/db";
import { getModel, getOpenAI } from "@/lib/llm";

export const dynamic = "force-dynamic";

// Generador de mensajes de la sección Leads: redacta con IA un correo
// (asunto + cuerpo) o un mensaje corto para WhatsApp / Instagram / Facebook /
// iMessage, usando los datos del lead como contexto. El operador siempre
// puede editar el resultado antes de enviarlo o copiarlo.

type GenChannel = "email" | "whatsapp" | "instagram" | "messenger" | "imessage";
const GEN_CHANNELS: GenChannel[] = ["email", "whatsapp", "instagram", "messenger", "imessage"];

const CHANNEL_STYLE: Record<GenChannel, string> = {
  email:
    "un CORREO comercial. Devuelve un asunto corto y un cuerpo de 3 a 6 párrafos breves, tono profesional cercano, con un llamado a la acción claro al final.",
  whatsapp:
    "un mensaje de WHATSAPP. Máximo 3 párrafos muy cortos, tono cercano y directo, sin asunto, apto para chat. Puede llevar 1-2 emojis con moderación.",
  instagram:
    "un mensaje directo de INSTAGRAM. Corto (2-4 frases), fresco y visual, sin asunto. 1-2 emojis como máximo.",
  messenger:
    "un mensaje de FACEBOOK MESSENGER. Corto (2-4 frases), cercano, sin asunto.",
  imessage:
    "un SMS/iMessage. Muy corto (1-3 frases), directo y sin relleno, sin asunto.",
};

interface GenBody {
  channel?: string;
  instruction?: string;
  leadId?: number;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as GenBody | null;
    const channel = (body?.channel ?? "") as GenChannel;
    if (!GEN_CHANNELS.includes(channel)) {
      return NextResponse.json({ error: "channel inválido" }, { status: 400 });
    }
    const instruction = body?.instruction?.trim().slice(0, 1000) ?? "";
    if (!instruction) {
      return NextResponse.json(
        { error: "Describe qué quieres decir (instrucción para la IA)" },
        { status: 400 }
      );
    }

    // Contexto del lead (opcional): campos del CRM + últimas notas.
    let leadContext = "";
    if (Number.isInteger(body?.leadId) && (body!.leadId as number) > 0) {
      const lead = await getConversationById(body!.leadId as number);
      if (lead) {
        const notes = await getLeadNotes(lead.id).catch(() => []);
        const parts = [
          lead.name ? `Nombre: ${lead.name}` : null,
          lead.company ? `Empresa: ${lead.company}` : null,
          lead.stage ? `Etapa en el CRM: ${lead.stage}` : null,
          lead.ai_summary ? `Resumen del lead: ${lead.ai_summary}` : null,
          notes.length > 0
            ? `Notas recientes: ${notes.slice(0, 3).map((n) => n.content).join(" · ").slice(0, 600)}`
            : null,
        ].filter(Boolean);
        if (parts.length > 0) leadContext = `\n\nDatos del lead:\n${parts.join("\n")}`;
      }
    }

    const system =
      "Eres el redactor comercial de Motor Advertising, una agencia de publicidad y marketing. " +
      "Escribes SIEMPRE en español, con textos listos para enviar (sin corchetes de relleno tipo [nombre] salvo las variables {{nombre}} y {{empresa}} si aplican, y sin explicaciones alrededor). " +
      `Redacta ${CHANNEL_STYLE[channel]}` +
      '\n\nResponde SOLO con JSON válido, sin markdown: {"subject": "...", "body": "..."} — en canales que no llevan asunto, subject debe ser una cadena vacía.';

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model: getModel(),
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${instruction}${leadContext}` },
      ],
      max_completion_tokens: 900,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content?.trim() ?? "";
    let subject = "";
    let text = "";
    try {
      const parsed = JSON.parse(raw) as { subject?: unknown; body?: unknown };
      subject = typeof parsed.subject === "string" ? parsed.subject.trim() : "";
      text = typeof parsed.body === "string" ? parsed.body.trim() : "";
    } catch {
      // Si el modelo no devolvió JSON, el texto crudo sirve como cuerpo.
      text = raw;
    }
    if (!text) {
      return NextResponse.json({ error: "La IA devolvió una respuesta vacía" }, { status: 502 });
    }

    return NextResponse.json({ ok: true, subject, body: text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error desconocido";
    // Falta OPENAI_API_KEY u otro problema del proveedor: mensaje tal cual.
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
