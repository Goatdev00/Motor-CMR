import { NextResponse, type NextRequest } from "next/server";
import { findMatchingTrigger, readKeywordTriggers } from "@/lib/templates";
import { readAiAgentsDoc } from "@/lib/ai-agents";
import { selectAgent } from "@/lib/agent-match";
import { HANDOFF_ACK, botOfferedHandoff, clientRequestsHuman } from "@/lib/reply-engine";
import { generateReply } from "@/lib/llm";
import { requireMember } from "@/lib/auth";
import { LEAD_STAGES, type LeadStage, type MessageRole } from "@/lib/db";
import { isChannel } from "@/lib/channels";

export const dynamic = "force-dynamic";

// Chat de prueba: simula el pipeline REAL de respuesta (mismo orden que
// respondToInbound en reply-engine) sin tocar canales ni el CRM — nada se
// envía ni se guarda. Devuelve, además de la respuesta, POR QUÉ respondió
// así (palabra clave, modo humano, derivación, agente activo), para que el
// operador valide su configuración conversando como si fuera el cliente.
//
// Orden de decisión (idéntico al motor real):
//   1. Palabra clave (Plantillas) — dispara en modo AI, o en HUMANO si la
//      palabra tiene "también en modo humano".
//   2. Modo HUMANO sin palabra clave → el bot calla.
//   3. El cliente pide un humano → acuse + pasaría a modo HUMANO.
//   4. Agente de IA (tema / continuidad / flujo) → LLM con especialización.
//   5. Si el LLM respondió la frase de derivación → pasaría a modo HUMANO.

interface TestChatBody {
  text?: string;
  history?: { role?: string; content?: string }[];
  stage?: string;
  channel?: string;
  mode?: string;
  stickyAgentId?: string | null;
}

export async function POST(req: NextRequest) {
  // El simulador usa la configuración (palabras clave, agentes, IA) de la
  // organización del usuario logueado.
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;
  const orgId = auth.orgId;
  try {
    const body = (await req.json().catch(() => null)) as TestChatBody | null;
    const text = typeof body?.text === "string" ? body.text.trim().slice(0, 4000) : "";
    if (!text) {
      return NextResponse.json({ error: "Escribe un mensaje para probar" }, { status: 400 });
    }
    const stage: LeadStage = LEAD_STAGES.includes(body?.stage as LeadStage)
      ? (body!.stage as LeadStage)
      : "NUEVO";
    const channel = isChannel(body?.channel) ? body!.channel! : "whatsapp";
    const mode = body?.mode === "HUMAN" ? "HUMAN" : "AI";
    const stickyAgentId =
      typeof body?.stickyAgentId === "string" && body.stickyAgentId
        ? body.stickyAgentId.slice(0, 64)
        : null;

    // Historial simulado (lo mantiene el navegador): mismo tope que el motor
    // real (últimos 20 turnos).
    const history: { role: MessageRole; content: string }[] = (body?.history ?? [])
      .filter(
        (m): m is { role: string; content: string } =>
          typeof m?.content === "string" &&
          m.content.trim() !== "" &&
          (m.role === "user" || m.role === "assistant")
      )
      .slice(-19)
      .map((m) => ({ role: m.role as MessageRole, content: m.content.slice(0, 4000) }));

    // 1. Palabra clave.
    const triggers = await readKeywordTriggers(orgId);
    const trigger = findMatchingTrigger(triggers, text);
    if (trigger && (mode === "AI" || trigger.also_human)) {
      return NextResponse.json({
        reply: trigger.content,
        source: "keyword",
        detail: {
          keyword: trigger.keyword,
          alsoHuman: trigger.also_human && mode === "HUMAN",
        },
        stickyAgentId,
      });
    }

    // 2. Modo humano: el bot calla.
    if (mode !== "AI") {
      return NextResponse.json({ reply: null, source: "silent-human", stickyAgentId });
    }

    // 3. El cliente pide un humano.
    if (clientRequestsHuman(text)) {
      return NextResponse.json({
        reply: HANDOFF_ACK,
        source: "handoff-client",
        stickyAgentId,
      });
    }

    // 4. Agente de IA + LLM real.
    const { agents } = await readAiAgentsDoc(orgId);
    const selection =
      agents.length > 0
        ? selectAgent(agents, { text, stage, channel, stickyId: stickyAgentId })
        : null;

    const reply = await generateReply(
      orgId,
      [...history, { role: "user", content: text }],
      selection?.agent ?? null
    );

    // 5. ¿El LLM derivó a humano?
    const handoffByBot = botOfferedHandoff(reply);

    return NextResponse.json({
      reply,
      source: "llm",
      detail: selection
        ? {
            agentId: selection.agent.id,
            agentName: selection.agent.name,
            agentEmoji: selection.agent.emoji,
            reason: selection.reason,
            topic: selection.topic ?? null,
          }
        : null,
      handoffByBot,
      stickyAgentId: selection?.agent.id ?? stickyAgentId,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
