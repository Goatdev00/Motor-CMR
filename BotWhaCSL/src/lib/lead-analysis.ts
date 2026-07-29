// Análisis de leads por IA: puntúa la intención de compra (0-100), resume la
// conversación, recomienda el próximo paso para cerrar y extrae datos de
// contacto. Lo usa el bot (automático, con debounce) y la API del dashboard
// (botón "Analizar ahora").
import { getLlm, maxTokensParam } from "./llm";
import {
  getConversationById,
  getRecentHistory,
  persistLeadAnalysis,
  LEAD_STAGES,
  type Conversation,
  type LeadStage,
} from "./db";

const ANALYSIS_PROMPT = `
Eres un analista de ventas experto. Vas a leer una conversación de WhatsApp
entre un negocio (roles "assistant" y "human") y un prospecto (rol "user").

Devuelve SOLO un objeto JSON válido, sin texto adicional, con esta forma:
{
  "score": <entero 0-100: probabilidad de que este lead compre. 0-30 frío,
            31-69 tibio, 70-100 caliente>,
  "etapa_sugerida": <una de: "NUEVO","CONTACTADO","CALIFICADO","PROPUESTA","GANADO","PERDIDO">,
  "resumen": <2-3 frases: qué busca el prospecto, objeciones y estado actual>,
  "proximo_paso": <UNA acción concreta y accionable para avanzar el cierre,
                   p.ej. "Enviar cotización de X y proponer llamada el martes">,
  "datos": {
    "nombre": <nombre del prospecto si lo mencionó, si no null>,
    "empresa": <empresa si la mencionó, si no null>,
    "email": <email si lo dio, si no null>
  }
}
`.trim();

interface AnalysisResult {
  score: number;
  etapa_sugerida: string;
  resumen: string;
  proximo_paso: string;
  datos?: { nombre?: string | null; empresa?: string | null; email?: string | null };
}

// Ejecuta el análisis y lo persiste sobre el lead. Devuelve la conversación
// actualizada. Lanza si el LLM o la DB fallan (el caller decide qué hacer).
export async function analyzeLead(conversationId: number): Promise<Conversation | null> {
  const convo = await getConversationById(conversationId);
  if (!convo) return null;

  const history = await getRecentHistory(conversationId, 30);
  if (history.length === 0) return convo;

  const transcript = history
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n");

  const { client, model, provider } = await getLlm(convo.org_id);
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: ANALYSIS_PROMPT },
      { role: "user", content: `Conversación:\n${transcript}` },
    ],
    // La capa compatible de Anthropic no soporta response_format; el prompt
    // ya exige JSON y el parse de abajo valida (con error claro si no).
    ...(provider === "anthropic" ? {} : { response_format: { type: "json_object" as const } }),
    ...maxTokensParam(provider, 500),
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("El análisis de IA devolvió vacío");

  let parsed: AnalysisResult;
  try {
    parsed = JSON.parse(raw) as AnalysisResult;
  } catch {
    throw new Error(`El análisis de IA no devolvió JSON válido: ${raw.slice(0, 120)}`);
  }

  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
  const suggested = LEAD_STAGES.includes(parsed.etapa_sugerida as LeadStage)
    ? parsed.etapa_sugerida
    : "CONTACTADO";

  await persistLeadAnalysis(conversationId, {
    lead_score: score,
    ai_summary: String(parsed.resumen ?? "").slice(0, 600),
    ai_next_step: String(parsed.proximo_paso ?? "").slice(0, 400),
    ai_suggested_stage: suggested,
    name: parsed.datos?.nombre ?? undefined,
    company: parsed.datos?.empresa ?? undefined,
    email: parsed.datos?.email ?? undefined,
  });

  return getConversationById(conversationId);
}

// Versión con debounce para el bot: como el análisis corre tras CADA mensaje
// del cliente, se limita a una vez por conversación cada ANALYSIS_COOLDOWN_MS
// para no quemar tokens en ráfagas de mensajes.
const ANALYSIS_COOLDOWN_MS = 90_000;
const lastAnalysisAt = new Map<number, number>();

export async function maybeAnalyzeLead(conversationId: number): Promise<void> {
  if (!process.env.OPENAI_API_KEY) return;
  const last = lastAnalysisAt.get(conversationId) ?? 0;
  if (Date.now() - last < ANALYSIS_COOLDOWN_MS) return;
  lastAnalysisAt.set(conversationId, Date.now());

  try {
    const updated = await analyzeLead(conversationId);
    if (updated) {
      console.log(
        `[bot] 🧠 Lead ${conversationId} analizado: score=${updated.lead_score} etapa_sugerida=${updated.ai_suggested_stage}`
      );
    }
  } catch (err) {
    console.error(`[bot] Falló el análisis de IA del lead ${conversationId}:`, err);
  }
}
