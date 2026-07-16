"use client";

import { useEffect, useState } from "react";

interface SettingsRow {
  enabled: boolean;
  config: Record<string, string>;
}
type SettingsMap = Record<string, SettingsRow>;

interface FieldDef {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
}

const META_CARDS: {
  channel: string;
  title: string;
  description: string;
  fields: FieldDef[];
}[] = [
  {
    channel: "whatsapp_api",
    title: "WhatsApp Business (API oficial de Meta)",
    description:
      "Cloud API con webhooks. Requiere un número registrado en Meta (no puede ser el mismo número que uses con el QR).",
    fields: [
      { key: "phone_number_id", label: "Phone Number ID", placeholder: "1234567890..." },
      { key: "access_token", label: "Access Token", placeholder: "EAAG...", secret: true },
    ],
  },
  {
    channel: "messenger",
    title: "Facebook Messenger",
    description: "Mensajes de tu página de Facebook. Requiere el token de la página con pages_messaging.",
    fields: [
      { key: "page_access_token", label: "Page Access Token", placeholder: "EAAG...", secret: true },
    ],
  },
  {
    channel: "instagram",
    title: "Instagram (DMs)",
    description:
      "Mensajes directos de tu cuenta profesional vinculada a la página. Requiere instagram_manage_messages.",
    fields: [
      { key: "page_access_token", label: "Page Access Token", placeholder: "EAAG...", secret: true },
    ],
  },
];

const cardClass = "rounded-xl border border-neutral-800 bg-neutral-900 p-4";
const inputClass =
  "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-emerald-600";
const btnPrimary =
  "rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const btnGhost =
  "rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50";

interface ApiKeyItem {
  id: number;
  label: string;
  key_prefix: string;
  active: boolean;
  last_used_at: number | null;
  created_at: number;
}

// Conecta tu CRM como API a otras apps (p.ej. una landing que recoge
// leads): claves con hash en DB, endpoint público /api/public/leads.
function ApiKeysCard() {
  const [keys, setKeys] = useState<ApiKeyItem[] | null>(null);
  const [label, setLabel] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);
  // El origin se lee tras montar: usar window en el render producía un
  // hydration mismatch (el servidor renderiza sin origin).
  const [endpoint, setEndpoint] = useState("/api/public/leads");

  useEffect(() => {
    setEndpoint(`${window.location.origin}/api/public/leads`);
  }, []);

  const load = async () => {
    try {
      const res = await fetch("/api/apikeys", { cache: "no-store" });
      const data = (await res.json()) as { keys?: ApiKeyItem[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setError(null);
      setKeys(data.keys ?? []);
    } catch {
      setError("No se pudieron cargar las claves");
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    if (!label.trim()) return;
    setBusy(true);
    setNewKey(null);
    try {
      const res = await fetch("/api/apikeys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      });
      const data = (await res.json().catch(() => null)) as { key?: string; error?: string } | null;
      if (!res.ok || !data?.key) {
        setError(data?.error ?? "No se pudo generar la clave");
        return;
      }
      setError(null);
      setNewKey(data.key);
      setLabel("");
      await load();
    } catch {
      setError("Error de red al generar");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: number) => {
    setConfirming(null);
    setBusy(true);
    let failMsg: string | null = null;
    try {
      const res = await fetch(`/api/apikeys/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        failMsg = data?.error ?? "No se pudo revocar";
      }
    } catch {
      failMsg = "Error de red al revocar";
    }
    setBusy(false);
    // load() limpia `error` en su camino feliz: el fallo se fija después.
    await load();
    if (failMsg) setError(failMsg);
  };

  const copyKey = async () => {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* el usuario puede seleccionar el texto */
    }
  };

  return (
    <div className={`${cardClass} md:col-span-2`}>
      <h2 className="text-sm font-semibold text-neutral-100">API del CRM (conectar otras apps)</h2>
      <p className="mt-1 text-xs text-neutral-400">
        Conecta tu CRM a otras aplicaciones — por ejemplo, una landing o app que recoge leads
        puede <strong>crearlos aquí directamente</strong>. Genera una clave (solo Admin), pégala
        en tu otra app como header <code className="font-mono">X-API-Key</code> y usa el
        endpoint. Con teléfono, el lead nace en WhatsApp y dispara el enrutamiento del equipo.
      </p>

      {/* Claves existentes */}
      <div className="mt-3 space-y-1.5">
        {(keys ?? []).map((k) => (
          <div key={k.id} className="flex items-center justify-between gap-3 rounded-lg bg-neutral-950 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-neutral-200">{k.label}</p>
              <p className="truncate font-mono text-[11px] text-neutral-500">
                {k.key_prefix}…
                {k.last_used_at
                  ? ` · último uso ${new Date(k.last_used_at * 1000).toLocaleString("es")}`
                  : " · sin usar"}
              </p>
            </div>
            {confirming === k.id ? (
              <span className="flex shrink-0 items-center gap-1.5 text-xs">
                <button
                  onClick={() => revoke(k.id)}
                  className="rounded-lg bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700"
                >
                  Sí, revocar
                </button>
                <button onClick={() => setConfirming(null)} className="text-neutral-500 hover:text-neutral-300">
                  No
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirming(k.id)}
                disabled={busy}
                className="shrink-0 text-xs text-red-500 underline-offset-2 hover:underline"
              >
                Revocar
              </button>
            )}
          </div>
        ))}
        {keys !== null && keys.length === 0 && (
          <p className="rounded-lg bg-neutral-950 py-3 text-center text-xs text-neutral-600">
            Sin claves todavía.
          </p>
        )}
      </div>

      {/* Generar */}
      <div className="mt-3 flex gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={60}
          placeholder="Nombre (p.ej. Landing de leads)"
          className={inputClass}
        />
        <button onClick={create} disabled={busy || !label.trim()} className={`${btnPrimary} shrink-0`}>
          Generar clave
        </button>
      </div>

      {newKey && (
        <div className="mt-2 rounded-lg border border-emerald-900 bg-emerald-950/50 p-3">
          <p className="text-xs font-medium text-emerald-400">
            Clave generada — cópiala AHORA: no se volverá a mostrar.
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-neutral-950 px-2.5 py-1.5 font-mono text-xs text-neutral-200">
              {newKey}
            </code>
            <button onClick={copyKey} className={btnGhost}>
              {copied ? "✓ Copiado" : "Copiar"}
            </button>
          </div>
        </div>
      )}

      {/* Documentación */}
      <div className="mt-3">
        <label className="mb-1 block text-[11px] font-medium text-neutral-500">
          Endpoint (POST crea/completa un lead · GET lista los leads)
        </label>
        <code className="block truncate rounded-lg border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-xs text-neutral-300">
          {endpoint}
        </code>
        <pre className="mt-2 overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950 p-3 text-[11px] leading-relaxed text-neutral-400">
{`curl -X POST ${endpoint} \\
  -H "X-API-Key: agente_..." \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Juan Pérez","phone":"573001112233","email":"juan@x.com","source":"landing","message":"Quiero información"}'`}
        </pre>
      </div>

      {error && <p className="mt-2 rounded-lg bg-red-950 p-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}

function Toggle({
  on,
  onChange,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-emerald-600" : "bg-neutral-700"
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
          on ? "left-[22px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

export default function ChannelSettings() {
  const [settings, setSettings] = useState<SettingsMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Formularios locales por tarjeta (no se pisan al recargar settings).
  const [forms, setForms] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // reseedChannel: al recargar tras guardar, solo se re-siembra el form del
  // canal guardado — sin esto, guardar una tarjeta borraba lo que estuvieras
  // escribiendo en las demás.
  const load = async (reseedChannel?: string | "all") => {
    try {
      const res = await fetch("/api/settings/channels", { cache: "no-store" });
      const data = (await res.json()) as { settings?: SettingsMap; error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setError(null);
      setSettings(data.settings ?? {});
      if (reseedChannel === "all") {
        const seeded: Record<string, Record<string, string>> = {};
        for (const [k, v] of Object.entries(data.settings ?? {})) seeded[k] = { ...v.config };
        setForms(seeded);
      } else if (reseedChannel && data.settings?.[reseedChannel]) {
        setForms((prev) => ({ ...prev, [reseedChannel]: { ...data.settings![reseedChannel].config } }));
      }
    } catch {
      setError("No se pudo cargar la configuración");
    }
  };

  useEffect(() => {
    load("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Guarda los CAMPOS del formulario (botón Guardar de cada tarjeta).
  const save = async (channel: string, enabled: boolean) => {
    setBusy(channel);
    setSavedMsg(null);
    try {
      const res = await fetch("/api/settings/channels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, enabled, config: forms[channel] ?? {} }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? "No se pudo guardar");
      } else {
        setSavedMsg(`Guardado: ${channel}`);
        await load(channel);
      }
    } catch {
      setError("Error de red al guardar");
    } finally {
      setBusy(null);
    }
  };

  // El toggle SOLO cambia enabled (sin config): flipearlo jamás guarda ni
  // borra tokens a medio escribir. Con rollback si el servidor falla.
  const toggleEnabled = async (channel: string, enabled: boolean) => {
    if (busy) return;
    setBusy(channel);
    setSavedMsg(null);
    setSettings((prev) => (prev ? { ...prev, [channel]: { ...prev[channel], enabled } } : prev));
    try {
      const res = await fetch("/api/settings/channels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, enabled }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "No se pudo cambiar el estado del canal");
        await load(); // revertir el optimista con la verdad del servidor
      }
    } catch {
      setError("Error de red al cambiar el canal");
      await load();
    } finally {
      setBusy(null);
    }
  };

  const test = async (channel: string) => {
    setBusy(`test:${channel}`);
    try {
      // Se envía el formulario actual: se prueba lo que estás VIENDO (los
      // valores enmascarados usan el token guardado).
      const res = await fetch("/api/settings/channels/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, config: forms[channel] ?? {} }),
      });
      const data = (await res.json()) as { ok?: boolean; detail?: string; error?: string };
      setTestResult((prev) => ({
        ...prev,
        [channel]: { ok: data.ok === true, detail: data.detail ?? data.error ?? "sin detalle" },
      }));
    } catch {
      setTestResult((prev) => ({ ...prev, [channel]: { ok: false, detail: "Error de red" } }));
    } finally {
      setBusy(null);
    }
  };

  const setField = (channel: string, key: string, value: string) => {
    setForms((prev) => ({ ...prev, [channel]: { ...(prev[channel] ?? {}), [key]: value } }));
    // Editar un campo invalida el resultado de la última prueba: un "✓ verde"
    // viejo junto a un token recién cambiado era una trampa.
    setTestResult((prev) => {
      if (!(channel in prev)) return prev;
      const next = { ...prev };
      delete next[channel];
      return next;
    });
  };

  // En los campos secretos, al enfocar se selecciona todo: así pegar
  // REEMPLAZA la máscara (••••XXXX) en vez de quedar pegado detrás de ella.
  const selectAllOnFocus = (e: React.FocusEvent<HTMLInputElement>) => e.target.select();

  if (!settings) {
    return (
      <main className="flex flex-1 items-center justify-center">
        {error ? (
          <p className="max-w-lg rounded-lg bg-red-950 p-4 text-sm text-red-400">{error}</p>
        ) : (
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-300" />
        )}
      </main>
    );
  }

  const webhookUrl =
    typeof window !== "undefined" ? `${window.location.origin}/api/webhooks/meta` : "/api/webhooks/meta";
  const baileys = settings["whatsapp"];

  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto grid max-w-5xl gap-4 md:grid-cols-2">
        {error && (
          <p className="md:col-span-2 rounded-lg bg-red-950 p-3 text-sm text-red-400">{error}</p>
        )}
        {savedMsg && (
          <p className="md:col-span-2 rounded-lg bg-emerald-950 p-3 text-sm text-emerald-400">
            ✓ {savedMsg}
          </p>
        )}

        {/* WhatsApp por QR (Baileys) — interruptor maestro del canal */}
        <div className={cardClass}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-neutral-100">WhatsApp (QR / Baileys)</h2>
              <p className="mt-1 text-xs text-neutral-400">
                Interruptor maestro del canal: apagarlo detiene TODAS las sesiones por QR. Las
                cuentas (vincular, QR, desvincular) se gestionan en la pestaña{" "}
                <strong>Equipo</strong>. No oficial: para producción seria considera la API.
              </p>
            </div>
            <Toggle
              on={baileys?.enabled ?? true}
              onChange={(v) => toggleEnabled("whatsapp", v)}
              disabled={busy !== null}
            />
          </div>
        </div>

        {/* Proveedor de IA (el cerebro de las respuestas) */}
        {(() => {
          const row = settings["llm"];
          const provider = forms["llm"]?.provider || "openai";
          const providerMeta: Record<string, { key: string; model: string; help: string }> = {
            openai: {
              key: "sk-...",
              model: "gpt-4o-mini",
              help: "Clave en platform.openai.com → API keys. Modelos: gpt-4o-mini (rápido y económico), gpt-4o.",
            },
            anthropic: {
              key: "sk-ant-...",
              model: "claude-sonnet-5",
              help: "Clave en console.anthropic.com → API keys. Modelos: claude-sonnet-5 (equilibrado), claude-haiku-4-5 (rápido y económico).",
            },
            gemini: {
              key: "AIza...",
              model: "gemini-2.5-flash",
              help: "Clave en aistudio.google.com → Get API key. Modelos: gemini-2.5-flash (rápido y económico), gemini-2.5-pro.",
            },
          };
          const meta = providerMeta[provider] ?? providerMeta.openai;
          const result = testResult["llm"];
          return (
            <div className={cardClass}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-neutral-100">
                    Inteligencia artificial (IA)
                  </h2>
                  <p className="mt-1 text-xs text-neutral-400">
                    El cerebro de las respuestas del bot, el análisis de leads y los
                    generadores. Elige el proveedor y pega su clave.{" "}
                    <strong>Apagado</strong> = se usa la clave OPENAI_API_KEY del archivo
                    .env.local del servidor (como hasta ahora).
                  </p>
                </div>
                <Toggle
                  on={row?.enabled ?? false}
                  onChange={(v) => toggleEnabled("llm", v)}
                  disabled={busy !== null}
                />
              </div>

              <div className="mt-3 space-y-2">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-neutral-500">
                    Proveedor
                  </label>
                  <select
                    value={provider}
                    onChange={(e) => setField("llm", "provider", e.target.value)}
                    className={inputClass}
                  >
                    <option value="openai">ChatGPT (OpenAI)</option>
                    <option value="anthropic">Claude (Anthropic)</option>
                    <option value="gemini">Gemini (Google)</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-neutral-500">
                    Clave API
                  </label>
                  <input
                    type="password"
                    value={forms["llm"]?.api_key ?? ""}
                    onChange={(e) => setField("llm", "api_key", e.target.value)}
                    onFocus={selectAllOnFocus}
                    placeholder={meta.key}
                    autoComplete="off"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-neutral-500">
                    Modelo (opcional — vacío usa el recomendado)
                  </label>
                  <input
                    value={forms["llm"]?.model ?? ""}
                    onChange={(e) => setField("llm", "model", e.target.value)}
                    placeholder={meta.model}
                    className={inputClass}
                  />
                  <p className="mt-1 text-[11px] text-neutral-600">{meta.help}</p>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => save("llm", row?.enabled ?? false)}
                  disabled={busy === "llm"}
                  className={btnPrimary}
                >
                  {busy === "llm" ? "Guardando..." : "Guardar"}
                </button>
                <button
                  onClick={() => test("llm")}
                  disabled={busy === "test:llm"}
                  className={btnGhost}
                >
                  {busy === "test:llm" ? "Probando..." : "Probar conexión"}
                </button>
              </div>
              {result && (
                <p
                  className={`mt-2 rounded-lg p-2 text-xs ${
                    result.ok ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"
                  }`}
                >
                  {result.ok ? "✓ " : "✕ "}
                  {result.detail}
                </p>
              )}
            </div>
          );
        })()}

        {/* Canales de Meta */}
        {META_CARDS.map((card) => {
          const row = settings[card.channel];
          const result = testResult[card.channel];
          return (
            <div key={card.channel} className={cardClass}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-neutral-100">{card.title}</h2>
                  <p className="mt-1 text-xs text-neutral-400">{card.description}</p>
                </div>
                <Toggle
                  on={row?.enabled ?? false}
                  onChange={(v) => toggleEnabled(card.channel, v)}
                  disabled={busy !== null}
                />
              </div>

              <div className="mt-3 space-y-2">
                {card.fields.map((f) => (
                  <div key={f.key}>
                    <label className="mb-1 block text-[11px] font-medium text-neutral-500">
                      {f.label}
                    </label>
                    <input
                      type={f.secret ? "password" : "text"}
                      value={forms[card.channel]?.[f.key] ?? ""}
                      onChange={(e) => setField(card.channel, f.key, e.target.value)}
                      onFocus={f.secret ? selectAllOnFocus : undefined}
                      placeholder={f.placeholder}
                      autoComplete="off"
                      className={inputClass}
                    />
                  </div>
                ))}
              </div>

              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => save(card.channel, row?.enabled ?? false)}
                  disabled={busy === card.channel}
                  className={btnPrimary}
                >
                  {busy === card.channel ? "Guardando..." : "Guardar"}
                </button>
                <button
                  onClick={() => test(card.channel)}
                  disabled={busy === `test:${card.channel}`}
                  className={btnGhost}
                >
                  {busy === `test:${card.channel}` ? "Probando..." : "Probar conexión"}
                </button>
              </div>
              {result && (
                <p
                  className={`mt-2 rounded-lg p-2 text-xs ${
                    result.ok ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"
                  }`}
                >
                  {result.ok ? "✓ " : "✕ "}
                  {result.detail}
                </p>
              )}
            </div>
          );
        })}

        {/* API pública del CRM (conectar otras apps) */}
        <ApiKeysCard />

        {/* Webhook compartido de Meta */}
        <div className={`${cardClass} md:col-span-2`}>
          <h2 className="text-sm font-semibold text-neutral-100">Webhook de Meta (compartido)</h2>
          <p className="mt-1 text-xs text-neutral-400">
            Meta envía los mensajes entrantes a esta URL. Debe ser <strong>pública HTTPS</strong>:
            en local usa un túnel (p.ej. <code className="font-mono">cloudflared tunnel --url http://localhost:3000</code>)
            y registra la URL resultante + <code className="font-mono">/api/webhooks/meta</code> en
            tu app de Meta (developers.facebook.com → Webhooks), suscribiendo el campo
            <code className="font-mono"> messages</code> en los objetos Page, Instagram y WhatsApp
            Business Account.
          </p>

          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <div className="md:col-span-2">
              <label className="mb-1 block text-[11px] font-medium text-neutral-500">
                URL del webhook (esta instancia)
              </label>
              <code className="block truncate rounded-lg border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-xs text-neutral-300">
                {webhookUrl}
              </code>
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-neutral-500">
                Verify Token (invéntalo tú; el mismo va en Meta)
              </label>
              <div className="flex gap-2">
                <input
                  value={forms["meta_webhook"]?.verify_token ?? ""}
                  onChange={(e) => setField("meta_webhook", "verify_token", e.target.value)}
                  placeholder="una-clave-secreta"
                  className={inputClass}
                />
                <button
                  onClick={() =>
                    // getRandomValues funciona también en contextos no-HTTPS
                    // (p.ej. abrir el dashboard por IP en la red local);
                    // crypto.randomUUID no existe ahí.
                    setField(
                      "meta_webhook",
                      "verify_token",
                      Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
                        b.toString(16).padStart(2, "0")
                      ).join("")
                    )
                  }
                  className={btnGhost}
                >
                  Generar
                </button>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-neutral-500">
                App Secret (opcional, valida la firma de Meta)
              </label>
              <input
                type="password"
                value={forms["meta_webhook"]?.app_secret ?? ""}
                onChange={(e) => setField("meta_webhook", "app_secret", e.target.value)}
                onFocus={selectAllOnFocus}
                placeholder="de Meta → App settings → Basic"
                autoComplete="off"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-neutral-500">
                App Secret de Instagram (opcional — apps nuevas con token IGAA…)
              </label>
              <input
                type="password"
                value={forms["meta_webhook"]?.ig_app_secret ?? ""}
                onChange={(e) => setField("meta_webhook", "ig_app_secret", e.target.value)}
                onFocus={selectAllOnFocus}
                placeholder="del caso de uso de Instagram → Configuración"
                autoComplete="off"
                className={inputClass}
              />
            </div>
          </div>

          <button
            onClick={() => save("meta_webhook", true)}
            disabled={busy === "meta_webhook"}
            className={`mt-3 ${btnPrimary}`}
          >
            {busy === "meta_webhook" ? "Guardando..." : "Guardar webhook"}
          </button>
        </div>
      </div>
    </main>
  );
}
