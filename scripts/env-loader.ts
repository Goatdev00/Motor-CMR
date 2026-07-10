// Carga .env.local (y .env como fallback) en process.env.
// Módulo de SOLO side effects, sin exports.
//
// ⚠️ CRÍTICO: debe ser el PRIMER import de scripts/start-bot.ts.
// ES modules hoistean todos los imports al inicio del archivo: si otro
// módulo lee process.env en su top-level antes de que esto corra, ve
// undefined. Al ser un módulo separado importado primero, se ejecuta
// antes que el resto (los imports corren en orden de declaración).
import path from "node:path";
import fs from "node:fs";

for (const file of [".env.local", ".env"]) {
  const envPath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(envPath)) continue;

  const text = fs.readFileSync(envPath, "utf-8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // No pisar variables ya definidas (permite override desde la shell).
    if (!(key in process.env)) process.env[key] = value;
  }
}
