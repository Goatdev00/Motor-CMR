// ── SOLO DESARROLLO ─────────────────────────────────────────────────────
// Simula un correo ENTRANTE de Resend contra tu dashboard en localhost, para
// probar la recepción (bandeja info@ del CRM) sin túnel ni correos reales:
// Resend no puede alcanzar localhost, así que este script hace de Resend.
//
// Firma el evento email.received igual que Resend (estándar Svix) usando el
// Signing Secret que guardaste en Mailing → Recepción, así pasa la misma
// verificación de firma que un correo real. Luego lo verás como globo
// "Recibido" en el hilo del lead.
//
// Uso (desde la raíz del proyecto, con el dashboard corriendo):
//   node scripts/dev-inbound-email.mjs
//   node scripts/dev-inbound-email.mjs "Juan Pérez <juan@ejemplo.com>" "Consulta" "Hola, quiero info de la pauta."
//
// Variables opcionales:
//   BASE_URL   (default http://localhost:3000)   ORG_ID (default 1)
// ────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "package.json"));
const { createClient } = require("@supabase/supabase-js");
const NodeWebSocket = require("ws");

// .env.local → SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env.local");
  process.exit(1);
}

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const ORG_ID = Number(process.env.ORG_ID ?? "1");
const [fromArg, subjectArg, bodyArg] = process.argv.slice(2);
const from = fromArg ?? "Cliente de Prueba <cliente.prueba@ejemplo.com>";
const subject = subjectArg ?? "Correo de prueba (recepción local)";
const text = bodyArg ?? "Hola, este es un correo entrante de prueba para ver la bandeja del CRM.";

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: NodeWebSocket },
});

// El secret y la dirección de recepción salen de lo que guardaste en Mailing.
const { data: row, error } = await sb
  .from("channel_settings")
  .select("config")
  .eq("org_id", ORG_ID)
  .eq("channel", "email")
  .maybeSingle();
if (error) {
  console.error("No se pudo leer la configuración:", error.message);
  process.exit(1);
}
const secret = row?.config?.inbound_secret?.trim();
const address = row?.config?.inbound_address?.trim();
if (!secret) {
  console.error(
    "No hay Signing Secret de recepción configurado.\n" +
      "Ve a Mailing → «Recepción — bandeja del CRM», pon la dirección (p.ej. info@tudominio.co)\n" +
      "y un Signing Secret (el de Resend, o cualquier whsec_... para pruebas), y Guarda cuenta."
  );
  process.exit(1);
}
const to = address || "info@tudominio.co";

// Payload igual que un evento email.received de Resend.
const payload = {
  type: "email.received",
  data: {
    email_id: `dev-${crypto.randomUUID()}`,
    from,
    to: [to],
    subject,
    text,
  },
};
const raw = JSON.stringify(payload);

// Firma Svix v1: HMAC-SHA256( `${id}.${ts}.${raw}` ) con la clave = base64 del
// secret (sin el prefijo whsec_).
const svixId = `msg_dev_${Date.now()}`;
const svixTs = Math.floor(Date.now() / 1000).toString();
const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
const signature =
  "v1," + crypto.createHmac("sha256", key).update(`${svixId}.${svixTs}.${raw}`).digest("base64");

const res = await fetch(`${BASE_URL}/api/webhooks/email`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "svix-id": svixId,
    "svix-timestamp": svixTs,
    "svix-signature": signature,
  },
  body: raw,
}).catch((e) => {
  console.error(`No se pudo contactar ${BASE_URL} — ¿está el dashboard corriendo?\n`, e.message);
  process.exit(1);
});

const out = await res.json().catch(() => ({}));
if (res.ok && out.ok) {
  console.log(`✓ Correo entrante inyectado (${res.status}).`);
  console.log(`  De: ${from}`);
  console.log(`  Para: ${to}`);
  console.log(`  Asunto: ${subject}`);
  if (out.leadId) console.log(`  → Lead #${out.leadId}: ábrelo en el CRM y verás el globo "Recibido".`);
  if (out.duplicate) console.log("  (duplicate: ya se había procesado un evento con ese id)");
} else {
  console.error(`✕ El webhook respondió ${res.status}:`, JSON.stringify(out));
  if (res.status === 401) {
    console.error("  Firma inválida: el Signing Secret del script no coincide con el de Mailing.");
  }
  process.exit(1);
}
