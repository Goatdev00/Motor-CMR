// Respuestas automáticas por palabra clave (sección Plantillas): capa de
// PERSISTENCIA y caché (server-only: toca Supabase). La lógica pura de
// matching y los tipos viven en keyword-match.ts (client-safe) para que la
// UI use exactamente el mismo criterio que el bot.
//
// Almacenamiento: app_settings (clave 'keyword_triggers', jsonb) — sin
// migración de schema. Forma actual: { rev, triggers } — el rev cambia en
// cada guardado y permite detectar que otra pestaña guardó primero (el PUT
// lo compara y devuelve 409 en vez de machacar). Se tolera la forma legada
// (array a secas) de versiones previas.
import { randomUUID } from "crypto";
import { getAppSetting, setAppSetting } from "./db";
import { sanitizeTriggerList, type KeywordTrigger } from "./keyword-match";

export {
  MAX_TRIGGERS,
  findMatchingTrigger,
  keywordDedupeKey,
  sanitizeTriggerList,
  triggerMatches,
  type KeywordMatch,
  type KeywordTrigger,
} from "./keyword-match";

const SETTING_KEY = "keyword_triggers";

export interface KeywordTriggersDoc {
  // null = forma legada sin rev (o sin datos): el primer guardado lo estrena.
  rev: string | null;
  triggers: KeywordTrigger[];
}

export async function readKeywordTriggersDoc(): Promise<KeywordTriggersDoc> {
  const raw = await getAppSetting<unknown>(SETTING_KEY);
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "triggers" in raw) {
    const doc = raw as { rev?: unknown; triggers?: unknown };
    return {
      rev: typeof doc.rev === "string" ? doc.rev : null,
      triggers: sanitizeTriggerList(doc.triggers),
    };
  }
  return { rev: null, triggers: sanitizeTriggerList(raw) };
}

export async function readKeywordTriggers(): Promise<KeywordTrigger[]> {
  return (await readKeywordTriggersDoc()).triggers;
}

// Guarda y devuelve el rev nuevo (la UI lo conserva como base del próximo
// guardado).
export async function saveKeywordTriggers(triggers: KeywordTrigger[]): Promise<string> {
  const rev = randomUUID();
  await setAppSetting(SETTING_KEY, { rev, triggers });
  cache = { at: 0, triggers: null }; // invalidar el caché de este proceso
  return rev;
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
