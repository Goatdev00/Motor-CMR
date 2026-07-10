// Claves de la API pública del CRM. La clave completa (agente_ + 40 hex)
// solo existe en el momento de crearla: en la DB queda su SHA-256 y un
// prefijo para reconocerla en la UI.
import { createHash, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { findApiKeyByHash, touchApiKey, type ApiKeyRow } from "./db";

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = `agente_${randomBytes(20).toString("hex")}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 15) };
}

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

// Autentica una request de la API pública: header X-API-Key (o Bearer).
export async function verifyApiKey(req: NextRequest): Promise<ApiKeyRow | null> {
  const header =
    req.headers.get("x-api-key") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  const raw = header.trim();
  if (!raw.startsWith("agente_") || raw.length < 20 || raw.length > 100) return null;
  const row = await findApiKeyByHash(hashApiKey(raw));
  if (!row) return null;
  void touchApiKey(row.id).catch(() => undefined);
  return row;
}
