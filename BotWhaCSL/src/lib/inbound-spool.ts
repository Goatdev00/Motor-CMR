// Respaldo en disco (solo proceso bot) de los mensajes entrantes. WhatsApp
// le confirma la entrega al cliente ANTES de que el bot guarde el mensaje y
// no lo re-envía: lo que solo vive en memoria se pierde si el proceso muere
// o si la base no responde. Dos archivos en auth/ (junto a las sesiones):
//  - Diario (inbound-journal.jsonl): cada mensaje se anota al recibirlo y se
//    marca hecho al quedar guardado (o respaldado). Al arrancar, lo que quedó
//    sin marcar — bot cerrado a la fuerza, corte de luz — pasa al respaldo.
//    Guardarlo dos veces no duplica nada (índice único por id del canal).
//  - Respaldo (inbound-spool.jsonl): lo que no se pudo guardar; el bot lo
//    re-intenta hasta que la base vuelva, en el orden en que llegó.
// Incluye los mensajes que un asesor escribe desde el teléfono del negocio:
// perderlos haría que la IA siguiera contestando encima del asesor.
import fs from "node:fs";
import path from "node:path";
import type { InboundMessage, ReplyRoute } from "./reply-engine";

export interface SpoolEntry {
  inbound: InboundMessage;
  route: ReplyRoute | null;
  spooledAt: number;
  // Presente si lo escribió un asesor desde el teléfono del negocio (se
  // guarda como 'human' y pausa la IA). customerBefore/customerKey: hora
  // (según WhatsApp) e id en el canal del último mensaje del cliente
  // anterior a él (para reconocer la bienvenida automática).
  staff?: { customerBefore: number | null; customerKey?: string | null };
}

const DIR = path.resolve(process.cwd(), "auth");
const SPOOL_FILE = path.join(DIR, "inbound-spool.jsonl");
// Lo que se está re-intentando ahora: siempre más viejo que SPOOL_FILE.
const WORK_FILE = `${SPOOL_FILE}.replay`;
const JOURNAL_FILE = path.join(DIR, "inbound-journal.jsonl");
// Diarios de arranques anteriores apartados para recuperar.
const RECOVER_PREFIX = "inbound-journal.jsonl.";
const RECOVER_SUFFIX = ".recover";
let replaying = false;

function readLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

// Escritura atómica (temporal + rename): un corte a mitad no deja el
// archivo a medias.
function writeLines(file: string, lines: string[]): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, lines.length ? lines.join("\n") + "\n" : "", "utf8");
  fs.renameSync(tmp, file);
}

function parseEntry(line: string): SpoolEntry | null {
  try {
    return JSON.parse(line) as SpoolEntry;
  } catch {
    console.error("[bot] ⚠️ Línea corrupta en el respaldo de mensajes; se descarta:", line.slice(0, 200));
    return null;
  }
}

export const contactOfEntry = (entry: SpoolEntry): string =>
  `${entry.inbound.orgId}:${entry.inbound.channel}:${entry.inbound.externalId}`;

export function spoolInbound(entry: SpoolEntry): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(SPOOL_FILE, JSON.stringify(entry) + "\n", "utf8");
}

// Todo lo respaldado, en orden (al arrancar: qué contactos tienen mensajes
// esperando, para que los nuevos no se guarden antes que esos).
export function listSpooled(): SpoolEntry[] {
  return [...readLines(WORK_FILE), ...readLines(SPOOL_FILE)]
    .map(parseEntry)
    .filter((e): e is SpoolEntry => e !== null);
}

// Re-intenta lo respaldado. `persist` devuelve true si quedó guardado (o se
// descartó a propósito); `lastOfContact` indica que es el último mensaje de
// ese contacto en esta vuelta. El archivo se renombra antes de procesarlo:
// lo que se respalde mientras tanto va a un archivo nuevo y no se pisa.
export async function replaySpool(
  persist: (entry: SpoolEntry, lastOfContact: boolean) => Promise<boolean>
): Promise<number> {
  if (replaying) return 0;
  if (!fs.existsSync(WORK_FILE) && !fs.existsSync(SPOOL_FILE)) return 0;
  replaying = true;
  let saved = 0;
  try {
    // Un WORK_FILE de una vuelta interrumpida se procesa primero: es más
    // viejo que lo que haya en SPOOL_FILE.
    if (!fs.existsSync(WORK_FILE)) fs.renameSync(SPOOL_FILE, WORK_FILE);
    const lines = readLines(WORK_FILE);
    const entries = lines.map(parseEntry);
    const lastIndex = new Map<string, number>();
    entries.forEach((e, i) => {
      if (e) lastIndex.set(contactOfEntry(e), i);
    });
    const failed: string[] = [];
    // Si un mensaje de un contacto falla, los SIGUIENTES de ese contacto no
    // se intentan en esta vuelta: guardarlos antes desordenaría su historial.
    const blocked = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const contact = contactOfEntry(entry);
      if (blocked.has(contact)) {
        failed.push(lines[i]);
        continue;
      }
      let ok = false;
      try {
        ok = await persist(entry, lastIndex.get(contact) === i);
      } catch {
        ok = false;
      }
      if (ok) saved++;
      else {
        failed.push(lines[i]);
        blocked.add(contact);
      }
    }
    // Lo que falló va ANTES de lo respaldado mientras tanto (más nuevo). De
    // un tirón, sin esperas en el medio: nada se intercala.
    const rest = [...failed, ...readLines(SPOOL_FILE)];
    if (rest.length > 0) writeLines(SPOOL_FILE, rest);
    else if (fs.existsSync(SPOOL_FILE)) fs.unlinkSync(SPOOL_FILE);
    fs.unlinkSync(WORK_FILE);
  } finally {
    replaying = false;
  }
  return saved;
}

// ── Diario de lo recibido ───────────────────────────────────

const journalPending = new Map<string, string>(); // id → línea
let journalSeq = 0;
let journalLines = 0;
let journalFailing = false;
const JOURNAL_COMPACT_EVERY = 2000;
// Próxima compactación: se reprograma tras cada una (con muchos pendientes,
// compactar en cada marca sería cuadrático y frenaría al bot).
let journalCompactAt = JOURNAL_COMPACT_EVERY;

// Anota un mensaje recibido. Devuelve su marca (para journalDone) o null si
// el disco no respondió: el mensaje sigue su camino igual.
export function journalInbound(entry: SpoolEntry): string | null {
  const id = `${Date.now().toString(36)}-${(journalSeq++).toString(36)}`;
  const line = JSON.stringify({ j: id, e: entry });
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(JOURNAL_FILE, line + "\n", "utf8");
    journalFailing = false;
  } catch (err) {
    if (!journalFailing) console.error("[bot] ⚠️ No se pudo anotar un mensaje en el diario en disco:", err);
    journalFailing = true;
    return null;
  }
  journalPending.set(id, line);
  journalLines++;
  return id;
}

// El mensaje ya quedó guardado en la base (o en el respaldo).
export function journalDone(id: string | null): void {
  if (!id || !journalPending.delete(id)) return;
  try {
    if (journalPending.size === 0) {
      fs.writeFileSync(JOURNAL_FILE, "", "utf8");
      journalLines = 0;
      journalCompactAt = JOURNAL_COMPACT_EVERY;
    } else if (journalLines >= journalCompactAt) {
      writeLines(JOURNAL_FILE, [...journalPending.values()]);
      journalLines = journalPending.size;
      journalCompactAt = journalPending.size + JOURNAL_COMPACT_EVERY;
    } else {
      fs.appendFileSync(JOURNAL_FILE, JSON.stringify({ d: id }) + "\n", "utf8");
      journalLines++;
    }
  } catch (err) {
    console.error("[bot] ⚠️ No se pudo actualizar el diario en disco:", err);
  }
}

// Al arrancar, ANTES de anotar nada: el diario del proceso anterior se
// aparta (renombrado) para que este proceso empiece uno nuevo — vaciar el
// nuevo nunca borra lo que quedaba del anterior.
export function setAsidePreviousJournal(): void {
  if (fs.existsSync(JOURNAL_FILE) && fs.statSync(JOURNAL_FILE).size > 0) {
    fs.renameSync(JOURNAL_FILE, path.join(DIR, `${RECOVER_PREFIX}${Date.now()}${RECOVER_SUFFIX}`));
  }
}

// ¿Quedan diarios apartados sin recuperar (p.ej. falló el disco al arrancar)?
export function hasJournalToRecover(): boolean {
  return fs.existsSync(DIR) && fs.readdirSync(DIR).some((f) => f.startsWith(RECOVER_PREFIX) && f.endsWith(RECOVER_SUFFIX));
}

// Lo que los procesos anteriores recibieron y no alcanzaron a guardar pasa al
// respaldo, en orden. Cada diario apartado se borra recién cuando todo lo
// suyo quedó respaldado: si algo falla, se reintenta más tarde. Devuelve las
// entradas que pasaron al respaldo.
export function recoverJournal(): SpoolEntry[] {
  if (!fs.existsSync(DIR)) return [];
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.startsWith(RECOVER_PREFIX) && f.endsWith(RECOVER_SUFFIX))
    .sort();
  const recovered: SpoolEntry[] = [];
  for (const file of files) {
    const full = path.join(DIR, file);
    const pending = new Map<string, SpoolEntry>();
    for (const line of readLines(full)) {
      try {
        const rec = JSON.parse(line) as { j?: string; e?: SpoolEntry; d?: string };
        if (rec.j && rec.e) pending.set(rec.j, rec.e);
        else if (rec.d) pending.delete(rec.d);
      } catch {
        /* última línea cortada por el cierre forzado */
      }
    }
    const entries = [...pending.values()];
    // Si el disco falla a mitad, el archivo apartado queda y se repite entero
    // más tarde: lo ya respaldado se duplica en el respaldo, no en la base
    // (guardar es idempotente).
    for (const entry of entries) spoolInbound(entry);
    fs.unlinkSync(full);
    recovered.push(...entries);
  }
  return recovered;
}

// Textos de los mensajes automáticos de WhatsApp Business ya reconocidos,
// por organización (ver knownAutoTexts en el handler). Sin la migración
// "BLINDAJE" esos mensajes no se guardan en la base: sin este archivo un
// reinicio los olvidaba y una bienvenida lenta pasaba por un asesor.
const AUTO_TEXTS_FILE = path.join(DIR, "auto-texts.json");

export function loadAutoTexts(): Record<string, string[]> {
  try {
    if (!fs.existsSync(AUTO_TEXTS_FILE)) return {};
    return JSON.parse(fs.readFileSync(AUTO_TEXTS_FILE, "utf8")) as Record<string, string[]>;
  } catch (err) {
    console.error("[bot] ⚠️ auto-texts.json ilegible; se ignora:", err);
    return {};
  }
}

export function saveAutoTexts(byOrg: Record<string, string[]>): void {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${AUTO_TEXTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(byOrg), "utf8");
  fs.renameSync(tmp, AUTO_TEXTS_FILE);
}
