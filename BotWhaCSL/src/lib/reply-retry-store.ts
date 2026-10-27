// Registro en disco de las conversaciones con una respuesta por reintentar
// (ver RetryEntry en reply-engine): un archivo por proceso en auth/, junto a
// las sesiones y al respaldo de mensajes entrantes.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RetryEntry, RetryStore } from "./reply-engine";

export function fileRetryStore(name: string): RetryStore {
  const file = path.resolve(process.cwd(), "auth", name);
  // Base a la que se refiere lo anotado: si la instalación pasa a otro
  // proyecto de Supabase, lo de la anterior (ids de conversación de otra
  // base) no se aplica.
  const db = crypto.createHash("sha256").update(process.env.SUPABASE_URL ?? "").digest("hex").slice(0, 12);
  return {
    load() {
      if (!fs.existsSync(file)) return {};
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8")) as { db?: string; entries?: Record<string, RetryEntry> };
        return data.db === db ? (data.entries ?? {}) : {};
      } catch (err) {
        console.error(`[bot] ⚠️ ${file} ilegible; se ignora:`, err);
        return {};
      }
    },
    // Escritura atómica (temporal + rename): un corte a mitad no lo deja a
    // medias.
    save(entries) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ db, entries }), "utf8");
      fs.renameSync(tmp, file);
    },
  };
}
