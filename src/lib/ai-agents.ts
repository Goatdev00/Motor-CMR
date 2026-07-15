// Equipo de IA (multiagentes): capa de PERSISTENCIA, caché y continuidad
// (server-only: toca Supabase). La lógica pura de selección vive en
// agent-match.ts (client-safe) para que el probador del panel use el mismo
// criterio que el bot.
//
// Almacenamiento: app_settings (clave 'ai_agents', jsonb) — sin migración.
// Forma: { rev, agents } (el rev detecta guardados concurrentes, mismo
// patrón que las palabras clave de Plantillas).
import { randomUUID } from "crypto";
import { getAppSetting, setAppSetting } from "./db";
import { sanitizeAgentList, selectAgent, type AgentSelection, type AiAgent } from "./agent-match";

export { MAX_AGENTS, sanitizeAgentList, type AiAgent } from "./agent-match";

const SETTING_KEY = "ai_agents";

export interface AiAgentsDoc {
  rev: string | null;
  agents: AiAgent[];
}

export async function readAiAgentsDoc(): Promise<AiAgentsDoc> {
  const raw = await getAppSetting<unknown>(SETTING_KEY);
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "agents" in raw) {
    const doc = raw as { rev?: unknown; agents?: unknown };
    return {
      rev: typeof doc.rev === "string" ? doc.rev : null,
      agents: sanitizeAgentList(doc.agents),
    };
  }
  return { rev: null, agents: sanitizeAgentList(raw) };
}

export async function saveAiAgents(agents: AiAgent[]): Promise<string> {
  const rev = randomUUID();
  await setAppSetting(SETTING_KEY, { rev, agents });
  cache = { at: 0, agents: null };
  return rev;
}

// ── Caché para el hot path del bot (mismo patrón que Plantillas) ──
const CACHE_TTL_MS = 15_000;
let cache: { at: number; agents: AiAgent[] | null } = { at: 0, agents: null };

export async function getAiAgentsCached(): Promise<AiAgent[]> {
  const now = Date.now();
  if (cache.agents && now - cache.at < CACHE_TTL_MS) return cache.agents;
  try {
    const { agents } = await readAiAgentsDoc();
    cache = { at: now, agents };
    return agents;
  } catch (err) {
    console.error("[bot] No se pudieron leer los agentes de IA (se usa el caché):", err);
    return cache.agents ?? [];
  }
}

// ── Continuidad por conversación ────────────────────────────
// Un lead que activó un agente por tema sigue con ese agente en los
// mensajes siguientes (aunque ya no repita la palabra del tema), hasta que
// otro tema dispare. En memoria por proceso: cada conversación llega
// siempre por el mismo proceso (Baileys → bot, Meta → dashboard); si el
// proceso se reinicia solo se pierde la continuidad, y el comodín/tema la
// recupera con naturalidad.
const MAX_STICKY = 2000;
const stickyAgents = new Map<number, string>();

function rememberSticky(conversationId: number, agentId: string): void {
  // Reinsertar mantiene el orden LRU-ish del Map para la poda FIFO.
  stickyAgents.delete(conversationId);
  stickyAgents.set(conversationId, agentId);
  if (stickyAgents.size > MAX_STICKY) {
    const oldest = stickyAgents.keys().next().value;
    if (oldest !== undefined) stickyAgents.delete(oldest);
  }
}

// Agente para un mensaje entrante (o null = prompt base de siempre).
export async function selectAgentForInbound(input: {
  conversationId: number;
  text: string;
  stage: string | null;
  channel: string | null;
}): Promise<AgentSelection | null> {
  const agents = await getAiAgentsCached();
  if (agents.length === 0) return null;
  const selection = selectAgent(agents, {
    text: input.text,
    stage: input.stage,
    channel: input.channel,
    stickyId: stickyAgents.get(input.conversationId) ?? null,
  });
  if (selection) rememberSticky(input.conversationId, selection.agent.id);
  return selection;
}
