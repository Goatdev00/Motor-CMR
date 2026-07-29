// Sesiones del dashboard: token firmado (HMAC-SHA256) guardado en una
// cookie httpOnly. El secreto de firma es la SUPABASE_SERVICE_ROLE_KEY —
// ya es secreta, vive solo en el servidor y existe en todos los entornos,
// así que no hace falta configurar nada nuevo.
//
// El token es stateless: {m: memberId, exp} + firma. El proxy lo verifica
// sin tocar la DB (rápido, corre en cada request a /api/*); las rutas que
// necesitan datos frescos (rol, activo) releen el miembro con requireMember.
import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getTeamMemberById, type TeamMember } from "./db";

export const SESSION_COOKIE = "agente_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

function getSecret(): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY (firma de sesiones)");
  return secret;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface SessionPayload {
  m: number;
  exp: number;
}

export function signSession(memberId: number): string {
  const payload: SessionPayload = {
    m: memberId,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", getSecret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySessionToken(token: string | undefined | null): number | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(createHmac("sha256", getSecret()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64").toString("utf8")) as SessionPayload;
    if (typeof payload.m !== "number" || typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.m;
  } catch {
    return null;
  }
}

// Miembro de la sesión, releído de la DB (rol y activo FRESCOS: desactivar
// a alguien lo saca de verdad, no cuando expire su token).
export async function getSessionMember(req: NextRequest): Promise<TeamMember | null> {
  const memberId = verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (memberId === null) return null;
  const member = await getTeamMemberById(memberId);
  if (!member || !member.active) return null;
  return member;
}

// Guardia para las mutaciones de Equipo: solo un Admin gestiona cuentas,
// miembros, roles, credenciales y enrutamiento.
export async function requireAdmin(
  req: NextRequest
): Promise<{ ok: true; member: TeamMember } | { ok: false; response: NextResponse }> {
  const member = await getSessionMember(req);
  if (!member) {
    return {
      ok: false,
      response: NextResponse.json({ error: "No autenticado. Inicia sesión." }, { status: 401 }),
    };
  }
  if (member.role !== "ADMIN") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Solo un Admin puede modificar el equipo" },
        { status: 403 }
      ),
    };
  }
  return { ok: true, member };
}

// Guardia estándar multi-organización: TODA ruta con datos por cliente la
// usa para saber QUÉ organización ve este usuario. Relee el miembro de la
// DB (rol/activo/org frescos).
export async function requireMember(
  req: NextRequest
): Promise<{ ok: true; member: TeamMember; orgId: number } | { ok: false; response: NextResponse }> {
  const member = await getSessionMember(req);
  if (!member) {
    return {
      ok: false,
      response: NextResponse.json({ error: "No autenticado. Inicia sesión." }, { status: 401 }),
    };
  }
  return { ok: true, member, orgId: member.org_id };
}
