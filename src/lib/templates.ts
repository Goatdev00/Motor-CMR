// Respuestas automáticas por palabra clave (sección Plantillas): capa de
// PERSISTENCIA y caché (server-only: toca Supabase). La lógica pura de
// matching y los tipos viven en keyword-match.ts (client-safe) para que la
// UI use exactamente el mismo criterio que el bot.
//
// Almacenamiento: app_settings (clave 'keyword_triggers', jsonb) — sin
// migración de schema. La lista es corta (decenas), así que el bot la lee
// con un caché en memoria de pocos segundos por proceso.
import { getAppSetting, setAppSetting } from "./db";
import { sanitizeTriggerList, type KeywordTrigger } from "./keyword-match";

export {
  MAX_TRIGGERS,
  findMatchingTrigger,
  sanitizeTriggerList,
  triggerMatches,
  type KeywordMatch,
  type KeywordTrigger,
} from "./keyword-match";

const SETTING_KEY = "keyword_triggers";

export async function readKeywordTriggers(): Promise<KeywordTrigger[]> {
  const raw = await getAppSetting<unknown>(SETTING_KEY);
  return sanitizeTriggerList(raw);
}

export async function saveKeywordTriggers(triggers: KeywordTrigger[]): Promise<void> {
  await setAppSetting(SETTING_KEY, triggers);
  cache = { at: 0, triggers: null }; // invalidar el caché de este proceso
}

// ── Caché para el hot path del bot ──────────────────────────
// Un mensaje entrante no debe costar una lectura extra de Supabase: se
// cachea la lista unos segundos. El proceso del dashboard y el del bot son
// procesos distintos — cada uno tiene su caché y expira solo (≤15 s de
// retardo para que un cambio de plantillas llegue al bot).
const CACHE_TTL_MS = 15_000;
let cache: { at: number; triggers: KeywordTrigger[] | null } = { at: 0, triggers: null };

export async function getKeywordTriggersCached(): Promise<KeywordTrigger[]> {
  const now = Date.now();
  if (cache.triggers && now - cache.at < CACHE_TTL_MS) return cache.triggers;
  try {
    const triggers = await readKeywordTriggers();
    cache = { at: now, triggers };
    return triggers;
  } catch (err) {
    // Blip de Supabase: se sigue con lo último conocido (o sin triggers).
    console.error("[bot] No se pudieron leer las palabras clave (se usa el caché):", err);
    return cache.triggers ?? [];
  }
}
