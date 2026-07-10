import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./system-prompt";
import type { Message } from "./db";

// LLM vía API de OpenAI directa. Modelo en OPENAI_MODEL (default gpt-4o-mini).
//
// Cliente perezoso: se crea en el primer uso, cuando .env.local ya fue
// cargado por scripts/env-loader.ts (ver la nota sobre hoisting de imports).

const DEFAULT_MODEL = "gpt-4o-mini";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Falta OPENAI_API_KEY en .env.local");
  }
  client = new OpenAI({ apiKey });
  return client;
}

// Cliente y modelo para otros usos del LLM (p.ej. análisis de leads del CRM).
export function getOpenAI(): OpenAI {
  return getClient();
}

export function getModel(): string {
  return process.env.OPENAI_MODEL || DEFAULT_MODEL;
}

// Descripción del proveedor activo para logs de arranque; null si no hay key.
export function getLlmProviderInfo(): string | null {
  if (process.env.OPENAI_API_KEY) {
    return `OpenAI (${process.env.OPENAI_MODEL || DEFAULT_MODEL})`;
  }
  return null;
}

export async function generateReply(
  history: Pick<Message, "role" | "content">[]
): Promise<string> {
  const openai = getClient();
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;

  // 'human' (mensajes que el operador mandó desde el dashboard) se mapea a
  // 'assistant': para el LLM son respuestas previas emitidas desde este
  // lado de la conversación.
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    ...history.map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.content,
    })),
  ];

  // max_completion_tokens (no max_tokens): los modelos nuevos de OpenAI
  // (gpt-5/o-series) rechazan el parámetro viejo. Tampoco se fija
  // temperature: varios modelos nuevos solo aceptan el valor por defecto.
  const completion = await openai.chat.completions.create({
    model,
    messages,
    max_completion_tokens: 500,
  });

  const reply = completion.choices[0]?.message?.content?.trim();
  if (!reply) {
    throw new Error("El LLM devolvió una respuesta vacía");
  }
  return reply;
}
