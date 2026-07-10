import { NextResponse, type NextRequest } from "next/server";
import { getAppSetting, setAppSetting } from "@/lib/db";
import {
  exchangeGoogleCode,
  fetchGoogleEmail,
  getGoogleSettings,
  saveGoogleSettings,
} from "@/lib/google";

export const dynamic = "force-dynamic";

// Vuelta del consentimiento de Google. Siempre redirige al dashboard con
// ?google=<resultado>: la pestaña Calendario muestra el aviso.
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const back = (result: string) => NextResponse.redirect(new URL(`/?google=${result}`, url.origin));

  try {
    if (url.searchParams.get("error")) return back("denied");

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return back("error");

    // Anti-CSRF: el state debe coincidir con el guardado al iniciar el
    // flujo y no tener más de 10 minutos.
    const saved = await getAppSetting<{ state?: string; created_at?: number }>(
      "google_oauth_state"
    );
    const age = Math.floor(Date.now() / 1000) - (saved?.created_at ?? 0);
    if (!saved?.state || saved.state !== state || age > 600) return back("error");
    await setAppSetting("google_oauth_state", {});

    const settings = await getGoogleSettings();
    const redirectUri = `${url.origin}/api/google/callback`;
    const { accessToken, refreshToken } = await exchangeGoogleCode(settings, code, redirectUri);
    // prompt=consent garantiza refresh_token; si aun así no llega, mejor
    // avisar que guardar una conexión que morirá en una hora.
    if (!refreshToken) return back("error");

    const email = await fetchGoogleEmail(accessToken);
    await saveGoogleSettings({ refresh_token: refreshToken, email: email ?? "" });
    return back("connected");
  } catch (err) {
    console.error("[google] callback:", err instanceof Error ? err.message : err);
    return back("error");
  }
}
