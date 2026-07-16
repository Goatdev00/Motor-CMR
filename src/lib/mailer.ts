// Envío de correo por SMTP (nodemailer). La cuenta se configura desde el
// dashboard (pestaña Mailing) y se guarda en channel_settings (fila 'email'):
// host, port, user, password, from_name, from_email y límites OPCIONALES
// (max_per_hour, max_per_day). Funciona con Gmail (contraseña de
// aplicación), Outlook, Resend (dominio propio: smtp.resend.com, usuario
// 'resend', contraseña = API key) o cualquier SMTP propio.
import nodemailer from "nodemailer";
import type { ChannelSettingsRow } from "./db";

export interface EmailConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  fromName: string | null;
  fromEmail: string;
  maxPerHour: number | null;
  maxPerDay: number | null;
}

// Extrae y valida la config de la fila 'email'. null si está incompleta.
export function parseEmailConfig(row: ChannelSettingsRow | undefined): EmailConfig | null {
  const cfg = row?.config ?? {};
  const host = cfg.host?.trim();
  const user = cfg.user?.trim();
  const password = cfg.password;
  if (!host || !user || !password) return null;

  const port = Number(cfg.port) || 465;
  const parseLimit = (raw: string | undefined): number | null => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  };

  return {
    host,
    port,
    user,
    password,
    fromName: cfg.from_name?.trim() || null,
    fromEmail: cfg.from_email?.trim() || user,
    maxPerHour: parseLimit(cfg.max_per_hour),
    maxPerDay: parseLimit(cfg.max_per_day),
  };
}

function buildTransport(config: EmailConfig) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // 465 = TLS implícito; 587/25 = STARTTLS.
    secure: config.port === 465,
    auth: { user: config.user, pass: config.password },
  });
}

export async function sendEmail(
  config: EmailConfig,
  opts: {
    to: string;
    toName?: string | null;
    subject: string;
    html: string;
    // Buzón al que llegan las respuestas (cabecera Reply-To). null/vacío =
    // responden al remitente, como siempre.
    replyTo?: string | null;
  }
): Promise<void> {
  const transport = buildTransport(config);
  try {
    await transport.sendMail({
      from: config.fromName
        ? { name: config.fromName, address: config.fromEmail }
        : config.fromEmail,
      to: opts.toName ? { name: opts.toName, address: opts.to } : opts.to,
      subject: opts.subject,
      html: opts.html,
      replyTo: opts.replyTo || undefined,
    });
  } finally {
    transport.close();
  }
}

export function isResendHost(host: string): boolean {
  return /(^|\.)resend\.com$/i.test(host.trim());
}

// Validación real contra la API de Resend (la contraseña SMTP ES el API
// key): el verify() SMTP solo comprueba el login, así que un dominio sin
// verificar o un remitente ajeno al dominio daban verde y luego todos los
// envíos fallaban. Devuelve null si el key es "solo envío" (no puede listar
// dominios): en ese caso se sigue con el verify SMTP normal.
async function verifyResend(config: EmailConfig): Promise<{ ok: boolean; detail: string } | null> {
  if (!EMAIL_REGEX.test(config.fromEmail)) {
    return {
      ok: false,
      detail:
        "Con Resend el usuario SMTP es literalmente 'resend': completa «Correo remitente» " +
        "con una dirección de tu dominio verificado (p.ej. hola@tudominio.co)",
    };
  }
  let res: Response;
  try {
    res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${config.password}` },
    });
  } catch {
    return { ok: false, detail: "No se pudo contactar la API de Resend (¿sin internet?)" };
  }
  const body = (await res.json().catch(() => ({}))) as {
    name?: string;
    message?: string;
    data?: { name?: string; status?: string }[];
  };
  if (res.status === 401 || res.status === 403) {
    // Los API key con permiso "solo envío" no pueden listar dominios; el key
    // sirve igual para enviar, así que no es un fallo.
    if (/restricted/i.test(body.name ?? "")) return null;
    return {
      ok: false,
      detail: "Resend rechazó el API key — revisa que lo copiaste completo (empieza por re_)",
    };
  }
  if (!res.ok) {
    return { ok: false, detail: `Resend: ${body.message ?? `HTTP ${res.status}`}` };
  }
  const fromDomain = config.fromEmail.split("@")[1]?.toLowerCase() ?? "";
  const match = (body.data ?? []).find((d) => d.name?.toLowerCase() === fromDomain);
  if (!match) {
    return {
      ok: false,
      detail: `El dominio ${fromDomain} no está agregado en Resend — agrégalo en resend.com → Domains y verifica los registros DNS`,
    };
  }
  if (match.status !== "verified") {
    return {
      ok: false,
      detail: `El dominio ${fromDomain} está «${match.status}» en Resend — faltan los registros DNS o aún no propagan (revisa resend.com → Domains)`,
    };
  }
  return { ok: true, detail: `API key válido y dominio ${fromDomain} verificado en Resend` };
}

// Prueba de conexión ("Probar conexión" del dashboard): valida credenciales
// contra el servidor SMTP sin enviar nada. Con Resend, además valida el API
// key y el estado del dominio contra su API.
export async function verifyEmailConfig(
  row: ChannelSettingsRow | undefined
): Promise<{ ok: boolean; detail: string }> {
  const config = parseEmailConfig(row);
  if (!config) {
    return { ok: false, detail: "Completa host, usuario y contraseña primero" };
  }
  let resendDetail: string | null = null;
  if (isResendHost(config.host)) {
    const resend = await verifyResend(config);
    if (resend && !resend.ok) return resend;
    resendDetail = resend?.detail ?? null;
  }
  const transport = buildTransport(config);
  try {
    await transport.verify();
    return {
      ok: true,
      detail: resendDetail ?? `Conectado a ${config.host} como ${config.user}`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "Error desconocido" };
  } finally {
    transport.close();
  }
}

// Personalización: {{nombre}}, {{empresa}}, {{email}} y {{etapa}} se
// reemplazan por los datos del lead (vacío si no hay dato).
export function renderTemplate(
  template: string,
  vars: { nombre?: string | null; empresa?: string | null; email?: string | null; etapa?: string | null }
): string {
  return template
    .replace(/\{\{\s*nombre\s*\}\}/gi, vars.nombre ?? "")
    .replace(/\{\{\s*empresa\s*\}\}/gi, vars.empresa ?? "")
    .replace(/\{\{\s*email\s*\}\}/gi, vars.email ?? "")
    .replace(/\{\{\s*etapa\s*\}\}/gi, vars.etapa ?? "");
}

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Texto plano → HTML simple (párrafos y saltos), para quien no escribe HTML.
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
}
