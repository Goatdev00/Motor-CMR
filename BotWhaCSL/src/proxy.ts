// Puerta de las APIs: toda ruta /api/* exige una sesión válida (cookie
// firmada), salvo el login/logout y los webhooks de Meta (que validan su
// propia firma X-Hub-Signature-256). Verificación stateless con Web Crypto
// (compatible con cualquier runtime del proxy); las rutas releen el miembro
// de la DB cuando necesitan rol/estado frescos.
import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "agente_session";

// Prefijos SIN sesión: login/logout (obvio), me/password (validan su propia
// cookie y devuelven su propio 401), los webhooks de Meta (firma propia) y
// la API pública del CRM (autentica con clave X-API-Key).
const PUBLIC_PREFIXES = ["/api/auth/", "/api/webhooks/", "/api/public/"];

function b64urlFromBytes(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function verifyToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    // Comparación en tiempo constante (endurecimiento contra timing).
    const expected = b64urlFromBytes(mac);
    if (expected.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    if (diff !== 0) return false;
    const payload = JSON.parse(
      atob(body.replace(/-/g, "+").replace(/_/g, "/"))
    ) as { m?: number; exp?: number };
    return (
      typeof payload.m === "number" &&
      typeof payload.exp === "number" &&
      payload.exp >= Math.floor(Date.now() / 1000)
    );
  } catch {
    return false;
  }
}

export default async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }
  const ok = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!ok) {
    return NextResponse.json({ error: "No autenticado. Inicia sesión." }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
