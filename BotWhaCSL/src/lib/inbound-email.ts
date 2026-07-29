// Recepción de correo (Resend Inbound): verificación de la firma del webhook
// y parseo defensivo del evento `email.received`. Resend firma sus webhooks
// con el estándar Svix (HMAC-SHA256): cabeceras svix-id / svix-timestamp /
// svix-signature y un Signing Secret `whsec_...` que el operador pega en la
// pestaña Mailing. Sin firma válida, el evento se rechaza: el endpoint es
// público y cualquiera podría inyectar "correos" falsos al CRM.
import crypto from "node:crypto";

// Tolerancia de reloj para el timestamp firmado (anti-replay).
const TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export function verifySvixSignature(
  secret: string,
  rawBody: string,
  headers: SvixHeaders
): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;

  // Timestamp fuera de la ventana = posible replay de un evento capturado.
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TOLERANCE_SECONDS) return false;

  // La clave es el base64 que sigue al prefijo whsec_.
  let key: Buffer;
  try {
    key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  } catch {
    return false;
  }
  if (key.length === 0) return false;

  const signedContent = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", key).update(signedContent).digest();

  // La cabecera puede traer varias firmas separadas por espacio: "v1,xxx v1,yyy".
  for (const part of headers.signature.split(/\s+/)) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    let candidate: Buffer;
    try {
      candidate = Buffer.from(sig, "base64");
    } catch {
      continue;
    }
    if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) {
      return true;
    }
  }
  return false;
}

// ── Parseo del evento email.received ────────────────────────

export interface ParsedInboundEmail {
  fromEmail: string;
  fromName: string | null;
  to: string[];
  subject: string;
  text: string;
  html: string | null;
  messageId: string | null;
}

// "Juan Pérez <juan@x.com>" | "juan@x.com" | { email, name } → { email, name }.
function parseAddress(raw: unknown): { email: string; name: string | null } | null {
  if (raw && typeof raw === "object") {
    const obj = raw as { email?: unknown; name?: unknown; address?: unknown };
    const email = typeof obj.email === "string" ? obj.email : typeof obj.address === "string" ? obj.address : "";
    if (EMAIL_SHAPE.test(email.trim())) {
      return {
        email: email.trim().toLowerCase(),
        name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : null,
      };
    }
    return null;
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const angled = s.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>$/);
  if (angled) {
    const email = angled[2].trim().toLowerCase();
    if (!EMAIL_SHAPE.test(email)) return null;
    // El display name puede venir entre comillas.
    const name = angled[1].trim().replace(/^"|"$/g, "").trim();
    return { email, name: name || null };
  }
  if (EMAIL_SHAPE.test(s)) return { email: s.toLowerCase(), name: null };
  return null;
}

// Igual de laxo que EMAIL_REGEX de mailer.ts (sin importar código de server
// SMTP aquí): algo@algo.tld.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const clip = (raw: unknown, max: number): string =>
  typeof raw === "string" ? raw.slice(0, max) : "";

// Devuelve null si el cuerpo no es un email.received utilizable.
export function parseResendInbound(body: unknown): ParsedInboundEmail | null {
  if (!body || typeof body !== "object") return null;
  const evt = body as { type?: unknown; data?: unknown };
  if (evt.type !== "email.received") return null;
  const data = (evt.data ?? {}) as Record<string, unknown>;

  const from = parseAddress(data.from);
  if (!from) return null;

  const rawTo = Array.isArray(data.to) ? data.to : [data.to];
  const to = rawTo
    .map((t) => parseAddress(t)?.email)
    .filter((t): t is string => Boolean(t));

  // Sin destinatario no hay a qué organización enrutar el correo.
  if (to.length === 0) return null;

  const html = clip(data.html, 100_000) || null;
  let text = clip(data.text, 10_000);
  if (!text && html) {
    // Algunos correos llegan solo con html: se degrada a texto en la ruta
    // (htmlToText vive en mailer.ts, capa de servidor).
    text = "";
  }

  // Dedupe: id del email en Resend, o el Message-ID de las cabeceras.
  let messageId: string | null = typeof data.email_id === "string" ? data.email_id : null;
  if (!messageId && Array.isArray(data.headers)) {
    for (const h of data.headers as { name?: unknown; value?: unknown }[]) {
      if (typeof h?.name === "string" && h.name.toLowerCase() === "message-id" && typeof h.value === "string") {
        messageId = h.value.slice(0, 300);
        break;
      }
    }
  }

  return {
    fromEmail: from.email,
    fromName: from.name,
    to,
    subject: clip(data.subject, 300),
    text,
    html,
    messageId,
  };
}
