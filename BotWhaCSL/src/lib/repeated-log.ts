// Errores que se repiten mientras dura un corte (sin internet, base caída):
// se registra el primero y después, como mucho, uno por minuto con la cuenta
// de los omitidos. Sin esto, un corte de horas llenaba la consola y el
// registro con decenas de miles de líneas iguales (el bot sigue reintentando
// igual; solo cambia cuánto se escribe).
const WINDOW_MS = 60_000;
const seen = new Map<string, { at: number; omitted: number }>();

export function logRepeated(level: "warn" | "error", context: string, message: string, err?: unknown): void {
  const detail = err === undefined ? "" : err instanceof Error ? err.message : String(err);
  const key = `${context}|${detail.slice(0, 80)}`;
  const now = Date.now();
  const prev = seen.get(key);
  if (prev && now - prev.at < WINDOW_MS) {
    prev.omitted++;
    return;
  }
  seen.set(key, { at: now, omitted: 0 });
  if (seen.size > 500) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  const omitted = prev?.omitted ? ` (+${prev.omitted} igual(es) en el último minuto)` : "";
  console[level](`${message}${detail ? ` ${detail}` : ""}${omitted}`);
}
