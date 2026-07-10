// Integración con Google (OAuth 2.0 + Drive API v3), sin SDK: solo fetch.
// Las credenciales del cliente OAuth (client_id/client_secret) y el
// refresh_token de la cuenta conectada viven en app_settings ('google') y
// se configuran desde la pestaña Calendario del dashboard.
import { getAppSetting, setAppSetting } from "./db";

export interface GoogleSettings {
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  email?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  iconLink?: string;
}

// drive (buscar/adjuntar cualquier archivo y subir el respaldo) +
// userinfo.email (mostrar qué cuenta quedó conectada).
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
];

// Carpeta de Drive donde se guardan los respaldos del calendario.
const DRIVE_FOLDER_NAME = "AGENTE";

export async function getGoogleSettings(): Promise<GoogleSettings> {
  return (await getAppSetting<GoogleSettings>("google")) ?? {};
}

export async function saveGoogleSettings(patch: Partial<GoogleSettings>): Promise<void> {
  const current = await getGoogleSettings();
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...current, ...patch })) {
    // null/'' borran la clave (así "desconectar" elimina el refresh_token).
    if (typeof value === "string" && value !== "") merged[key] = value;
  }
  await setAppSetting("google", merged);
  clearGoogleTokenCache();
}

export function isGoogleConfigured(s: GoogleSettings): boolean {
  return Boolean(s.client_id && s.client_secret);
}

export function isGoogleConnected(s: GoogleSettings): boolean {
  return isGoogleConfigured(s) && Boolean(s.refresh_token);
}

export function buildGoogleAuthUrl(
  settings: GoogleSettings,
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: settings.client_id ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    // offline + consent: garantiza que Google devuelva un refresh_token
    // (sin consent, las reconexiones llegan sin él).
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) {
    const detail = data.error_description ?? data.error ?? `HTTP ${res.status}`;
    throw new Error(`Google OAuth: ${detail}`);
  }
  return data;
}

// Intercambio del code del callback por tokens.
export async function exchangeGoogleCode(
  settings: GoogleSettings,
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken: string | null }> {
  const data = await postToken({
    code,
    client_id: settings.client_id ?? "",
    client_secret: settings.client_secret ?? "",
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token ?? null,
  };
}

// Cache del access_token (dura ~1h; margen de 60s). Si el proceso se
// reinicia solo se pide otro con el refresh_token.
let tokenCache: { token: string; expiresAt: number } | null = null;

export function clearGoogleTokenCache(): void {
  tokenCache = null;
}

export async function getGoogleAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  const settings = await getGoogleSettings();
  if (!isGoogleConnected(settings)) {
    throw new Error(
      "No hay una cuenta de Google conectada. Conéctala desde la pestaña Calendario."
    );
  }
  const data = await postToken({
    client_id: settings.client_id as string,
    client_secret: settings.client_secret as string,
    refresh_token: settings.refresh_token as string,
    grant_type: "refresh_token",
  });
  tokenCache = {
    token: data.access_token as string,
    expiresAt: Date.now() + Math.max(0, (data.expires_in ?? 3600) - 60) * 1000,
  };
  return tokenCache.token;
}

// Revocación best-effort del grant en Google al desconectar: sin esto el
// refresh_token descartado seguía siendo válido indefinidamente (visible en
// myaccount.google.com/permissions) y la app ya no tenía copia para
// revocarlo después.
export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch {
    /* la desconexión local procede igual */
  }
}

export async function fetchGoogleEmail(accessToken: string): Promise<string | null> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { email?: string };
  return data.email ?? null;
}

// ── Drive ───────────────────────────────────────────────────

async function driveFetch(path: string, init?: RequestInit): Promise<Response> {
  const doFetch = async () => {
    const token = await getGoogleAccessToken();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(`https://www.googleapis.com${path}`, { ...init, headers });
  };
  let res = await doFetch();
  // 401 con cache vigente: Google invalidó el access_token antes de su
  // expires_in (evento de seguridad, sesión revocada). Sin esto, Drive
  // quedaba roto hasta ~1h aunque un refresh lo arreglara al instante.
  if (res.status === 401) {
    clearGoogleTokenCache();
    res = await doFetch();
  }
  return res;
}

async function driveError(res: Response, context: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  throw new Error(`Google Drive (${context}): ${body.error?.message ?? `HTTP ${res.status}`}`);
}

// Los valores en q van entre comillas simples; se escapan \ y '.
function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function searchDriveFiles(query: string): Promise<DriveFile[]> {
  const q = `name contains '${escapeDriveQuery(query)}' and trashed = false`;
  const params = new URLSearchParams({
    q,
    pageSize: "15",
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,webViewLink,iconLink)",
    // Incluye unidades compartidas si las hay.
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
  });
  const res = await driveFetch(`/drive/v3/files?${params.toString()}`);
  if (!res.ok) await driveError(res, "buscar");
  const data = (await res.json()) as { files?: DriveFile[] };
  return data.files ?? [];
}

// Carpeta 'AGENTE' en la raíz de Mi unidad; se crea si no existe.
// La búsqueda se restringe a la raíz Y a carpetas propias: sin esos filtros,
// una carpeta 'AGENTE' compartida por un tercero ganaba la búsqueda y el
// respaldo (con datos de leads) terminaba en el Drive de otra persona o la
// exportación fallaba con 403 para siempre.
export async function ensureDriveFolder(): Promise<string> {
  const q =
    `name = '${escapeDriveQuery(DRIVE_FOLDER_NAME)}' and ` +
    "mimeType = 'application/vnd.google-apps.folder' and trashed = false and " +
    "'root' in parents and 'me' in owners";
  const params = new URLSearchParams({ q, pageSize: "1", fields: "files(id)" });
  const search = await driveFetch(`/drive/v3/files?${params.toString()}`);
  if (!search.ok) await driveError(search, "buscar carpeta");
  const found = (await search.json()) as { files?: { id: string }[] };
  if (found.files?.[0]?.id) return found.files[0].id;

  const create = await driveFetch("/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: DRIVE_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
      parents: ["root"],
    }),
  });
  if (!create.ok) await driveError(create, "crear carpeta");
  const created = (await create.json()) as { id: string };
  return created.id;
}

export interface DriveUploadResult {
  id: string;
  webViewLink: string | null;
}

// Sube (o actualiza, si ya existe uno con el mismo nombre en la carpeta) un
// archivo de texto. Así los respaldos no se duplican en cada exportación.
export async function uploadTextFileToDrive(
  name: string,
  mimeType: string,
  content: string,
  folderId: string
): Promise<DriveUploadResult> {
  const q =
    `name = '${escapeDriveQuery(name)}' and '${escapeDriveQuery(folderId)}' in parents ` +
    "and trashed = false";
  const params = new URLSearchParams({ q, pageSize: "1", fields: "files(id)" });
  const search = await driveFetch(`/drive/v3/files?${params.toString()}`);
  if (!search.ok) await driveError(search, "buscar archivo");
  const found = (await search.json()) as { files?: { id: string }[] };
  const existingId = found.files?.[0]?.id ?? null;

  if (existingId) {
    const update = await driveFetch(
      `/upload/drive/v3/files/${existingId}?uploadType=media&fields=id,webViewLink`,
      { method: "PATCH", headers: { "Content-Type": mimeType }, body: content }
    );
    if (!update.ok) await driveError(update, "actualizar archivo");
    const data = (await update.json()) as { id: string; webViewLink?: string };
    return { id: data.id, webViewLink: data.webViewLink ?? null };
  }

  // Subida multipart: metadata (nombre + carpeta) + contenido en un POST.
  const boundary = "agente-drive-boundary";
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify({ name, parents: [folderId] }) +
    `\r\n--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n` +
    content +
    `\r\n--${boundary}--`;
  const create = await driveFetch(
    "/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  if (!create.ok) await driveError(create, "subir archivo");
  const data = (await create.json()) as { id: string; webViewLink?: string };
  return { id: data.id, webViewLink: data.webViewLink ?? null };
}
