// Frase EXACTA de derivación: el handler del bot la detecta en las
// respuestas para cambiar automáticamente la conversación a modo HUMANO.
// Si la cambias aquí, la detección sigue funcionando (comparten constante).
export const HANDOFF_PHRASE = "Déjame derivarte con un asesor humano.";

// Personaliza este prompt con la información de TU negocio.
// El bot lo usa como instrucción de sistema en cada llamada al LLM.
// Ver README → "Personalizar el system prompt".
export const SYSTEM_PROMPT = `
Eres un asistente virtual amable. Responde en español neutro,
en mensajes breves de 2 a 4 líneas. No uses emojis.
Si el usuario pide algo que no puedes resolver, responde exactamente:
"${HANDOFF_PHRASE}"
`.trim();
