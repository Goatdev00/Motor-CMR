// Lógica PURA de las palabras clave (sección Plantillas): tipos, saneo y
// matching. Client-safe — sin dependencias de servidor — para que la UI use
// el mismo criterio de matching que el bot (probador en vivo del panel).

export type KeywordMatch = "exacta" | "contiene";

export interface KeywordTrigger {
  id: string;
  // Palabra o frase que dispara la respuesta (p.ej. "INFO", "precio lista").
  keyword: string;
  // Contenido que el bot envía tal cual.
  content: string;
  // 'exacta': el mensaje completo es la palabra (con tolerancia a mayúsculas,
  // tildes y signos). 'contiene': la palabra aparece en el mensaje.
  match: KeywordMatch;
  enabled: boolean;
  // true = responde incluso con la conversación en modo HUMANO (por defecto
  // solo responde en modo AI, para no interrumpir al operador).
  also_human: boolean;
}

export const MAX_TRIGGERS = 200;

// minúsculas + sin tildes + espacios colapsados (mismo criterio robusto que
// usa la derivación a humano del reply-engine).
export function normalizeKeywordText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Para el modo 'exacta': además de normalizar, se descartan signos alrededor
// ("¡INFO!", "info.", "*info*" cuentan como exacto).
function stripEdgePunctuation(s: string): string {
  return s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ¿El mensaje dispara este trigger? (sin mirar enabled/modo: eso lo decide
// el caller).
export function triggerMatches(
  trigger: Pick<KeywordTrigger, "keyword" | "match">,
  text: string
): boolean {
  const keyword = normalizeKeywordText(trigger.keyword);
  if (!keyword) return false;
  const normalized = normalizeKeywordText(text);
  if (trigger.match === "exacta") {
    return stripEdgePunctuation(normalized) === stripEdgePunctuation(keyword);
  }
  // 'contiene': la palabra/frase completa, delimitada (no como fragmento de
  // otra palabra: "info" no dispara con "informe").
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegex(keyword)}($|[^\\p{L}\\p{N}])`,
    "u"
  );
  return pattern.test(normalized);
}

// Primer trigger habilitado que matchea (el orden de la lista es prioridad).
export function findMatchingTrigger(
  triggers: KeywordTrigger[],
  text: string
): KeywordTrigger | null {
  for (const t of triggers) {
    if (!t.enabled) continue;
    if (triggerMatches(t, text)) return t;
  }
  return null;
}

// Saneo defensivo: app_settings es jsonb sin esquema; una fila corrupta o
// una versión vieja no debe tumbar el pipeline de respuestas.
function sanitizeTrigger(raw: unknown): KeywordTrigger | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const keyword = typeof r.keyword === "string" ? r.keyword.trim().slice(0, 80) : "";
  const content = typeof r.content === "string" ? r.content.trim().slice(0, 2000) : "";
  if (!keyword || !content) return null;
  return {
    id:
      typeof r.id === "string" && r.id
        ? r.id
        : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    keyword,
    content,
    match: r.match === "contiene" ? "contiene" : "exacta",
    enabled: r.enabled !== false,
    also_human: r.also_human === true,
  };
}

export function sanitizeTriggerList(raw: unknown): KeywordTrigger[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_TRIGGERS)
    .map(sanitizeTrigger)
    .filter((t): t is KeywordTrigger => t !== null);
}
