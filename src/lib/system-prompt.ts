// Frase EXACTA de derivación: el handler del bot la detecta en las
// respuestas para cambiar automáticamente la conversación a modo HUMANO.
// Si la cambias aquí, la detección sigue funcionando (comparten constante).
export const HANDOFF_PHRASE = "Déjame derivarte con un asesor humano.";

// LEGADO: el prompt del bot ya NO vive aquí. Se edita desde el dashboard
// (Equipo → Equipo de IA → "Prompts del bot") por organización, y se compone
// en src/lib/prompts.ts (general de la plataforma + principal del negocio +
// la instrucción fija de derivación con HANDOFF_PHRASE).
