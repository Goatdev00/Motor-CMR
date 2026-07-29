// Prompts del bot en tres niveles (server-only: toca Supabase):
//
//   1. GENERAL (plataforma): reglas base para TODOS los bots de TODOS los
//      clientes. Vive en app_settings de la organización 1 (la agencia) y
//      solo la agencia lo edita.
//   2. PRINCIPAL (organización): la personalidad y el negocio del bot de
//      CADA cliente. Vive en app_settings de su organización.
//   3. AGENTE (Equipo de IA): la especialización del agente activo — se
//      añade en generateReply, no aquí.
//
// La instrucción de DERIVACIÓN A HUMANO se añade SIEMPRE al final y no es
// editable: la detección del motor (botOfferedHandoff) depende de la frase
// exacta, y un prompt editado no debe poder romperla.
import { AGENCY_ORG_ID, getAppSetting, setAppSetting } from "./db";
import { HANDOFF_PHRASE } from "./system-prompt";

export const MAX_PROMPT_LENGTH = 6000;

// General por defecto (si la agencia no ha escrito uno propio).
export const DEFAULT_GENERAL_PROMPT = `
Eres un asistente virtual amable. Responde en español neutro,
en mensajes breves de 2 a 4 líneas. No uses emojis.
`.trim();

// Instrucción FIJA de derivación (no editable desde el dashboard).
const HANDOFF_INSTRUCTION = `
Si el usuario pide algo que no puedes resolver, responde exactamente:
"${HANDOFF_PHRASE}"
`.trim();

const GENERAL_KEY = "global_prompt"; // solo en la organización 1
const PRINCIPAL_KEY = "bot_prompt"; // por organización

function cleanPrompt(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().slice(0, MAX_PROMPT_LENGTH) : "";
}

export interface BotPrompts {
  // Texto del prompt general GUARDADO ("" = usando el predeterminado).
  general: string;
  // Prompt principal de la organización ("" = sin personalizar).
  principal: string;
}

export async function readBotPrompts(orgId: number): Promise<BotPrompts> {
  const [generalDoc, principalDoc] = await Promise.all([
    getAppSetting<{ text?: unknown }>(AGENCY_ORG_ID, GENERAL_KEY),
    getAppSetting<{ text?: unknown }>(orgId, PRINCIPAL_KEY),
  ]);
  return {
    general: cleanPrompt(generalDoc?.text),
    principal: cleanPrompt(principalDoc?.text),
  };
}

export async function saveGeneralPrompt(text: string): Promise<void> {
  await setAppSetting(AGENCY_ORG_ID, GENERAL_KEY, { text: cleanPrompt(text) });
  cache.clear(); // el general afecta a TODAS las organizaciones
}

export async function savePrincipalPrompt(orgId: number, text: string): Promise<void> {
  await setAppSetting(orgId, PRINCIPAL_KEY, { text: cleanPrompt(text) });
  cache.delete(orgId);
}

// Prompt de sistema compuesto (general + principal + derivación). El bloque
// del agente activo lo añade generateReply encima de esto.
export function composeSystemPrompt(prompts: BotPrompts): string {
  const parts = [prompts.general || DEFAULT_GENERAL_PROMPT];
  if (prompts.principal) {
    parts.push(`## Sobre este negocio y cómo debes actuar\n${prompts.principal}`);
  }
  parts.push(HANDOFF_INSTRUCTION);
  return parts.join("\n\n");
}

// ── Caché para el hot path del bot (mismo patrón que Plantillas) ──
const CACHE_TTL_MS = 15_000;
const cache = new Map<number, { at: number; prompt: string }>();

export async function getSystemPromptCached(orgId: number): Promise<string> {
  const now = Date.now();
  const hit = cache.get(orgId);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.prompt;
  try {
    const prompt = composeSystemPrompt(await readBotPrompts(orgId));
    cache.set(orgId, { at: now, prompt });
    return prompt;
  } catch (err) {
    // Blip de Supabase: lo último conocido o el default (el bot no se calla
    // por no poder leer el prompt).
    console.error("[bot] No se pudo leer el prompt del bot (se usa el caché):", err);
    return hit?.prompt ?? composeSystemPrompt({ general: "", principal: "" });
  }
}
