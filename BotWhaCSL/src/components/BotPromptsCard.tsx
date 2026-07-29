"use client";

import { useEffect, useState } from "react";

// Prompts del bot (Equipo → Equipo de IA): las indicaciones que definen cómo
// responde la IA, en tres niveles que se COMPONEN en cada respuesta:
//   1. General (plataforma) — solo lo edita la agencia; aplica a todos.
//   2. Principal (este negocio) — la personalidad/contexto del bot del
//      cliente; lo edita el Admin de cada organización.
//   3. Agente activo — las "Instrucciones" de cada agente de IA (tarjeta de
//      abajo) se suman cuando ese agente atiende.
// La regla de derivación a humano se añade SIEMPRE al final y no es editable.

const cardClass = "rounded-xl border border-neutral-800 bg-neutral-900 p-4";
const inputClass =
  "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-emerald-600 disabled:opacity-60";
const btnPrimary =
  "rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const labelClass = "mb-1 block text-[11px] font-medium text-neutral-500";

interface Props {
  isAdmin: boolean;
}

export default function BotPromptsCard({ isAdmin }: Props) {
  const [general, setGeneral] = useState("");
  const [generalDefault, setGeneralDefault] = useState("");
  const [principal, setPrincipal] = useState("");
  const [canEditGeneral, setCanEditGeneral] = useState(false);
  const [maxLength, setMaxLength] = useState(6000);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState(false);
  // Generador con IA del prompt principal: frase corta + estado de carga.
  const [genBrief, setGenBrief] = useState("");
  const [generating, setGenerating] = useState(false);

  const generatePrincipal = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/prompts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "principal", brief: genBrief, draft: principal }),
      });
      const data = (await res.json().catch(() => null)) as {
        prompt?: string;
        error?: string;
      } | null;
      if (!res.ok || !data?.prompt) {
        setError(data?.error ?? "No se pudo generar el prompt");
        return;
      }
      setPrincipal(data.prompt);
      setDirty(true);
      setSavedMsg(false);
    } catch {
      setError("Error de red al generar el prompt");
    } finally {
      setGenerating(false);
    }
  };

  const load = async () => {
    setError(null);
    try {
      const res = await fetch("/api/prompts", { cache: "no-store" });
      const data = (await res.json()) as {
        general?: string;
        generalDefault?: string;
        principal?: string;
        canEditGeneral?: boolean;
        maxLength?: number;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setGeneral(data.general ?? "");
      setGeneralDefault(data.generalDefault ?? "");
      setPrincipal(data.principal ?? "");
      setCanEditGeneral(data.canEditGeneral ?? false);
      setMaxLength(data.maxLength ?? 6000);
      setDirty(false);
      setLoaded(true);
    } catch {
      setError("No se pudieron cargar los prompts");
    }
  };

  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSavedMsg(false);
    try {
      const body: Record<string, string> = { principal };
      if (canEditGeneral) body.general = general;
      const res = await fetch("/api/prompts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? "No se pudo guardar");
        return;
      }
      setDirty(false);
      setSavedMsg(true);
    } catch {
      setError("Error de red al guardar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-100">Prompts del bot</h2>
          <p className="mt-1 max-w-2xl text-xs text-neutral-400">
            Las indicaciones que gobiernan a la IA, en tres niveles que se combinan en cada
            respuesta: el <b>general</b> de la plataforma, el <b>principal</b> de este negocio,
            y las <b>instrucciones del agente</b> que atienda (tarjeta de abajo). La regla de
            derivación a un asesor humano se añade siempre y no es editable — así el pase a
            humano nunca se rompe. Los cambios aplican solos en menos de 15 segundos.
          </p>
        </div>
        {isAdmin && (
          <button onClick={save} disabled={busy || !dirty || !loaded} className={btnPrimary}>
            {busy ? "Guardando..." : "Guardar prompts"}
          </button>
        )}
      </div>

      {error && <p className="mt-3 rounded-lg bg-red-950 p-2 text-xs text-red-400">{error}</p>}
      {savedMsg && (
        <p className="mt-3 rounded-lg bg-emerald-950 p-2 text-xs text-emerald-400">
          ✓ Guardado — el bot ya responde con los prompts nuevos
        </p>
      )}
      {dirty && !savedMsg && (
        <p className="mt-3 rounded-lg bg-neutral-950 p-2 text-xs text-amber-400/90">
          Hay cambios sin guardar — el bot sigue usando la última versión guardada.
        </p>
      )}

      <fieldset disabled={busy || !isAdmin} className="m-0 mt-3 min-w-0 border-0 p-0">
        <div className="grid gap-3 lg:grid-cols-2">
          <div>
            <label className={labelClass}>
              Prompt principal de tu bot (quién es, qué vende, cómo atiende, precios, horarios…)
            </label>
            <textarea
              value={principal}
              onChange={(e) => {
                setPrincipal(e.target.value);
                setDirty(true);
                setSavedMsg(false);
              }}
              rows={10}
              maxLength={maxLength}
              placeholder={
                "Eres el asistente de ventas de Motor Advertising, agencia de publicidad.\nServicios: pauta digital, branding, producción audiovisual...\nTu objetivo es calificar al lead y agendar una llamada.\nSi preguntan precios: la pauta parte de $X/mes..."
              }
              className={`${inputClass} font-mono text-xs`}
            />
            <p className="mt-1 text-[11px] text-neutral-600">
              {principal.length}/{maxLength} · Este prompt es SOLO de tu organización.
            </p>
            {/* Generador con IA: describe el negocio en una frase y la IA
                redacta el prompt completo (usa lo ya escrito como borrador). */}
            <div className="mt-1.5 flex gap-2">
              <input
                value={genBrief}
                onChange={(e) => setGenBrief(e.target.value)}
                maxLength={600}
                placeholder="Describe tu negocio en una frase (p.ej. «agencia de publicidad que vende pauta y branding a pymes»)"
                className={`${inputClass} text-xs`}
              />
              <button
                onClick={generatePrincipal}
                disabled={generating || busy || (!genBrief.trim() && !principal.trim())}
                title="La IA redacta un prompt completo con lo que escribas aquí. Si ya hay texto, lo usa como base y lo completa."
                className="shrink-0 rounded-lg border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
              >
                {generating ? "Generando..." : "✨ Generar con IA"}
              </button>
            </div>
          </div>
          <div>
            <label className={labelClass}>
              Prompt general de la plataforma{" "}
              {canEditGeneral ? "(lo editas tú — aplica a TODOS los clientes)" : "(solo lectura — lo define la agencia)"}
            </label>
            <textarea
              value={canEditGeneral ? general : general || generalDefault}
              onChange={(e) => {
                if (!canEditGeneral) return;
                setGeneral(e.target.value);
                setDirty(true);
                setSavedMsg(false);
              }}
              readOnly={!canEditGeneral}
              rows={10}
              maxLength={maxLength}
              placeholder={generalDefault}
              className={`${inputClass} font-mono text-xs ${canEditGeneral ? "" : "opacity-70"}`}
            />
            <p className="mt-1 text-[11px] text-neutral-600">
              {canEditGeneral
                ? `${general.length}/${maxLength} · Vacío = usa el predeterminado que se muestra como guía.`
                : "Reglas base compartidas por todos los bots de la plataforma."}
            </p>
          </div>
        </div>
      </fieldset>
    </div>
  );
}
