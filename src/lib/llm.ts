import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./system-prompt";
import { getAllChannelSettings } from "./db";
import type { Message } from "./db";

// LLM multi-proveedor: ChatGPT (OpenAI), Claude (Anthropic) o Gemini
// (Google). Los tres exponen API compatible con el SDK de OpenAI (solo
// cambia la baseURL), así que un único cliente sirve para todos.
//
// La configuración se elige en el dashboard (Canales → Inteligencia
// artificial, fila 'llm' de channel_settings). Si esa fila está apagada o
// incompleta, se usa el fallback de siempre: OPENAI_API_KEY / OPENAI_MODEL
// del .env.local del servidor.

export type LlmProvider = "openai" | "anthropic" | "gemini";

export const LLM_PROVIDERS: Record<
  LlmProvider,
  { label: string; baseURL: string | undefined; defaultModel: string }
> = {
  openai: {
    label: "ChatGPT (OpenAI)",
    baseURL: undefined, // la del SDK
    defaultModel: "gpt-4o-mini",
  },
  anthropic: {
    label: "Claude (Anthropic)",
    baseURL: "https://api.anthropic.com/v1/",
    defaultModel: "claude-sonnet-5",
  },
  gemini: {
    label: "Gemini (Google)",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultModel: "gemini-2.5-flash",
  },
};

export function isLlmProvider(value: unknown): value is LlmProvider {
  return value === "openai" || value === "anthropic" || value === "gemini";
}

export interface ResolvedLlm {
  client: OpenAI;
  provider: LlmProvider;
  model: string;
  label: string;
}

// Parámetro de tope de tokens según proveedor: los modelos nuevos de OpenAI
// rechazan max_tokens (piden max_completion_tokens); las capas compatibles
// de Anthropic y Google esperan el clásico max_tokens.
export function maxTokensParam(
  provider: LlmProvider,
  n: number
): { max_completion_tokens: number } | { max_tokens: number } {
  return provider === "openai" ? { max_completion_tokens: n } : { max_tokens: n };
}

interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
}

// Config desde la fila 'llm' del dashboard; null si está apagada/incompleta.
function fromSettings(row?: { enabled: boolean; config: Record<string, string> }): LlmConfig | null {
  if (!row?.enabled) return null;
  const provider = row.config.provider;
  const apiKey = row.config.api_key?.trim();
  if (!isLlmProvider(provider) || !apiKey) return null;
  return {
    provider,
    apiKey,
    model: row.config.model?.trim() || LLM_PROVIDERS[provider].defaultModel,
  };
}

// Fallback de siempre: variables de entorno (solo OpenAI).
function fromEnv(): LlmConfig | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    provider: "openai",
    apiKey,
    model: process.env.OPENAI_MODEL || LLM_PROVIDERS.openai.defaultModel,
  };
}

// Caché de config + cliente (por proceso): un mensaje entrante no debe
// costar una lectura extra de Supabase. Cambios del dashboard aplican en
// ≤15 s en el proceso del bot (el del dashboard invalida al guardar).
const CACHE_TTL_MS = 15_000;
let cachedAt = 0;
let cachedConfig: LlmConfig | null = null;
let cachedClient: OpenAI | null = null;
let cachedClientKey = "";

export function invalidateLlmCache(): void {
  cachedAt = 0;
}

async function resolveConfig(): Promise<LlmConfig | null> {
  const now = Date.now();
  if (now - cachedAt < CACHE_TTL_MS) return cachedConfig;
  try {
    const rows = await getAllChannelSettings();
    cachedConfig = fromSettings(rows["llm"]) ?? fromEnv();
    cachedAt = now;
  } catch {
    // Blip de Supabase (o tabla sin migrar): env o lo último conocido.
    cachedConfig = cachedConfig ?? fromEnv();
    cachedAt = now;
  }
  return cachedConfig;
}

function clientFor(config: LlmConfig): OpenAI {
  const key = `${config.provider}|${config.apiKey}`;
  if (!cachedClient || cachedClientKey !== key) {
    cachedClient = new OpenAI({
      apiKey: config.apiKey,
      baseURL: LLM_PROVIDERS[config.provider].baseURL,
    });
    cachedClientKey = key;
  }
  return cachedClient;
}

// Cliente + modelo + proveedor activos. Lanza error claro si no hay nada
// configurado (ni dashboard ni .env.local).
export async function getLlm(): Promise<ResolvedLlm> {
  const config = await resolveConfig();
  if (!config) {
    throw new Error(
      "No hay proveedor de IA configurado: conecta uno en Canales → Inteligencia artificial (o define OPENAI_API_KEY en .env.local)"
    );
  }
  return {
    client: clientFor(config),
    provider: config.provider,
    model: config.model,
    label: LLM_PROVIDERS[config.provider].label,
  };
}

// Descripción del proveedor activo para logs de arranque; null si no hay.
export async function getLlmProviderInfo(): Promise<string | null> {
  const config = await resolveConfig();
  if (!config) return null;
  return `${LLM_PROVIDERS[config.provider].label} · ${config.model}`;
}

// Prueba de conexión del dashboard: llamada mínima con la config del
// formulario (sin tocar la guardada ni el caché).
export async function verifyLlmConfig(
  config: Record<string, string>
): Promise<{ ok: boolean; detail: string }> {
  const provider = config.provider;
  if (!isLlmProvider(provider)) {
    return { ok: false, detail: "Elige un proveedor (ChatGPT, Claude o Gemini)" };
  }
  const apiKey = config.api_key?.trim();
  if (!apiKey) return { ok: false, detail: "Pega la clave API del proveedor" };
  const model = config.model?.trim() || LLM_PROVIDERS[provider].defaultModel;
  try {
    const client = new OpenAI({ apiKey, baseURL: LLM_PROVIDERS[provider].baseURL });
    const completion = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "Responde únicamente: OK" }],
      ...maxTokensParam(provider, 20),
    });
    const reply = completion.choices[0]?.message?.content?.trim();
    return {
      ok: true,
      detail: `${LLM_PROVIDERS[provider].label} respondió con el modelo ${model}${reply ? ` («${reply.slice(0, 40)}»)` : ""}`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : "Error desconocido del proveedor",
    };
  }
}

export async function generateReply(
  history: Pick<Message, "role" | "content">[],
  // Agente de IA que atiende esta conversación (Equipo → Equipo de IA):
  // su especialización se añade al prompt base sin romper la regla de
  // derivación a humano.
  agent?: { name: string; instructions: string } | null
): Promise<string> {
  const { client, model, provider } = await getLlm();

  const system = agent
    ? `${SYSTEM_PROMPT}\n\n## Rol asignado para esta conversación: ${agent.name}\n${agent.instructions}\n\n(Las reglas de arriba siguen vigentes, incluida la frase exacta de derivación a un asesor humano.)`
    : SYSTEM_PROMPT;

  // 'human' (mensajes que el operador mandó desde el dashboard) se mapea a
  // 'assistant': para el LLM son respuestas previas emitidas desde este
  // lado de la conversación.
  const messages = [
    { role: "system" as const, content: system },
    ...history.map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.content,
    })),
  ];

  // Sin temperature: varios modelos nuevos solo aceptan el valor por defecto.
  const completion = await client.chat.completions.create({
    model,
    messages,
    ...maxTokensParam(provider, 500),
  });

  const reply = completion.choices[0]?.message?.content?.trim();
  if (!reply) {
    throw new Error("El LLM devolvió una respuesta vacía");
  }
  return reply;
}
