// Equipo de IA (multiagentes): lógica PURA de selección de agente.
// Client-safe — sin dependencias de servidor — para que el probador del
// panel Equipo use exactamente el mismo criterio que el bot.
//
// Un agente se activa por TEMA (palabras/frases que aparecen en el mensaje
// del cliente) o por FLUJO (etapa del CRM y/o canal). Sin temas, el agente
// es "comodín" de su flujo: atiende cualquier mensaje que caiga en sus
// filtros. El orden de la lista es la prioridad.
import { normalizeKeywordText } from "./keyword-match";
import type { LeadStage } from "./db";
import type { Channel } from "./channels";

export interface AiAgent {
  id: string;
  name: string;
  // Emoji o inicial para la tarjeta (solo visual).
  emoji: string;
  // Instrucciones de especialización: se AÑADEN al prompt base del bot
  // cuando este agente atiende la conversación.
  instructions: string;
  // Temas que lo activan (matching de frase completa, sin tildes ni
  // mayúsculas — mismo criterio que las palabras clave de Plantillas).
  // Vacío = comodín: se activa por sus filtros de flujo.
  topics: string[];
  // Filtros de flujo. Vacío = sin restricción.
  stages: LeadStage[];
  channels: Channel[];
  enabled: boolean;
}

export const MAX_AGENTS = 50;

export type AgentSelectionReason = "tema" | "continuidad" | "flujo";

export interface AgentSelection {
  agent: AiAgent;
  reason: AgentSelectionReason;
  // Tema que disparó (solo reason === 'tema').
  topic?: string;
}

function flowMatches(agent: AiAgent, stage: string | null, channel: string | null): boolean {
  if (agent.stages.length > 0 && (!stage || !agent.stages.includes(stage as LeadStage))) {
    return false;
  }
  if (
    agent.channels.length > 0 &&
    (!channel || !agent.channels.includes(channel as Channel))
  ) {
    return false;
  }
  return true;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ¿El tema aparece en el mensaje? Palabra/frase completa (sin tildes ni
// mayúsculas) con tolerancia a plurales simples: el tema "precio" dispara
// con "precios", "campaña" con "campañas", "cotización" con "cotizaciones".
// Sigue sin disparar como fragmento: "info" no matchea "informe".
function topicMatches(topic: string, text: string): boolean {
  const keyword = normalizeKeywordText(topic);
  if (!keyword) return false;
  const normalized = normalizeKeywordText(text);
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegex(keyword)}(?:es|s)?($|[^\\p{L}\\p{N}])`,
    "u"
  );
  return pattern.test(normalized);
}

function matchedTopic(agent: AiAgent, text: string): string | null {
  for (const topic of agent.topics) {
    if (topicMatches(topic, text)) return topic;
  }
  return null;
}

// Selección para un mensaje. stickyId = agente que ya venía atendiendo la
// conversación (continuidad: un lead que preguntó por un tema sigue con ese
// agente hasta que otro tema dispare).
export function selectAgent(
  agents: AiAgent[],
  input: {
    text: string;
    stage: string | null;
    channel: string | null;
    stickyId?: string | null;
  }
): AgentSelection | null {
  const candidates = agents.filter(
    (a) => a.enabled && flowMatches(a, input.stage, input.channel)
  );

  // 1. Tema del mensaje actual (en orden de prioridad).
  for (const agent of candidates) {
    const topic = matchedTopic(agent, input.text);
    if (topic) return { agent, reason: "tema", topic };
  }

  // 2. Continuidad: el agente que venía atendiendo, si sigue vigente.
  if (input.stickyId) {
    const sticky = candidates.find((a) => a.id === input.stickyId);
    if (sticky) return { agent: sticky, reason: "continuidad" };
  }

  // 3. Comodín de flujo: primer candidato sin temas.
  const wildcard = candidates.find((a) => a.topics.length === 0);
  return wildcard ? { agent: wildcard, reason: "flujo" } : null;
}

// Saneo defensivo (app_settings es jsonb sin esquema).
function sanitizeAgent(raw: unknown): AiAgent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim().slice(0, 40) : "";
  const instructions =
    typeof r.instructions === "string" ? r.instructions.trim().slice(0, 4000) : "";
  if (!name || !instructions) return null;
  const topics = Array.isArray(r.topics)
    ? r.topics
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim().slice(0, 60))
        .filter((t) => t !== "")
        .slice(0, 30)
    : [];
  const stages = Array.isArray(r.stages)
    ? r.stages.filter((s): s is LeadStage => typeof s === "string").slice(0, 10)
    : [];
  const channels = Array.isArray(r.channels)
    ? r.channels.filter((c): c is Channel => typeof c === "string").slice(0, 10)
    : [];
  return {
    id:
      typeof r.id === "string" && r.id
        ? r.id.slice(0, 64)
        : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    emoji: typeof r.emoji === "string" ? r.emoji.trim().slice(0, 8) : "",
    instructions,
    topics,
    stages,
    channels,
    enabled: r.enabled !== false,
  };
}

export function sanitizeAgentList(raw: unknown): AiAgent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_AGENTS)
    .map(sanitizeAgent)
    .filter((a): a is AiAgent => a !== null);
}
