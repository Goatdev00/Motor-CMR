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

// Todo es POR ORGANIZACIÓN: cada cliente tiene sus propias palabras clave.
export async function readKeywordTriggersDoc(orgId: number): Promise<KeywordTriggersDoc> {
  const raw = await getAppSetting<unknown>(orgId, SETTING_KEY);
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "triggers" in raw) {
    const doc = raw as { rev?: unknown; triggers?: unknown };
    return {
      rev: typeof doc.rev === "string" ? doc.rev : null,
      triggers: sanitizeTriggerList(doc.triggers),
    };
  }
  return { rev: null, triggers: sanitizeTriggerList(raw) };
}

export async function readKeywordTriggers(orgId: number): Promise<KeywordTrigger[]> {
  return (await readKeywordTriggersDoc(orgId)).triggers;
}

// Guarda y devuelve el rev nuevo (la UI lo conserva como base del próximo
// guardado).
export async function saveKeywordTriggers(
  orgId: number,
  triggers: KeywordTrigger[]
): Promise<string> {
  const rev = randomUUID();
  await setAppSetting(orgId, SETTING_KEY, { rev, triggers });
  cache.delete(orgId); // invalidar el caché de este proceso
  return rev;
}

// ── Caché para el hot path del bot ──────────────────────────
// Un mensaje entrante no debe costar una lectura extra de Supabase: se
// cachea la lista unos segundos POR ORGANIZACIÓN. El proceso del dashboard
// y el del bot son procesos distintos — cada uno tiene su caché y expira
// solo (≤15 s de retardo para que un cambio de plantillas llegue al bot).
const CACHE_TTL_MS = 15_000;
const cache = new Map<number, { at: number; triggers: KeywordTrigger[] }>();

export async function getKeywordTriggersCached(orgId: number): Promise<KeywordTrigger[]> {
  const now = Date.now();
  const hit = cache.get(orgId);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.triggers;
  try {
    const triggers = await readKeywordTriggers(orgId);
    cache.set(orgId, { at: now, triggers });
    return triggers;
  } catch (err) {
    // Blip de Supabase: se sigue con lo último conocido (o sin triggers).
    console.error("[bot] No se pudieron leer las palabras clave (se usa el caché):", err);
    return hit?.triggers ?? [];
  }
}
