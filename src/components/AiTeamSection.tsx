"use client";

import { useEffect, useMemo, useState } from "react";
import { selectAgent, type AiAgent } from "@/lib/agent-match";
import { STAGE_ORDER, type StageConfigMap } from "@/lib/stages";
import type { LeadStage } from "@/lib/db";
import { CHANNEL_LABELS, type Channel } from "@/lib/channels";

// Equipo de IA (multiagentes): agentes especializados que atienden según el
// TEMA del mensaje del cliente o el FLUJO (etapa del CRM / canal). El bot
// suma las instrucciones del agente activo a su prompt base; las reglas de
// derivación a humano y las palabras clave de Plantillas siguen mandando.

const cardClass = "rounded-xl border border-neutral-800 bg-neutral-900 p-4";
const inputClass =
  "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-emerald-600 disabled:opacity-60";
const btnPrimary =
  "rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const btnGhost =
  "rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50";
const labelClass = "mb-1 block text-[11px] font-medium text-neutral-500";

// Canales con respuesta del bot ('api' no tiene canal de salida).
const REPLY_CHANNELS: Channel[] = ["whatsapp", "whatsapp_api", "messenger", "instagram"];

const DRAFT_KEY = "equipo-ia-borrador";

interface Props {
  isAdmin: boolean;
  stageConfig: StageConfigMap;
}

export default function AiTeamSection({ isAdmin, stageConfig }: Props) {
  const [agents, setAgents] = useState<AiAgent[] | null>(null);
  const [rev, setRev] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ agents: AiAgent[]; rev: string | null } | null>(null);
  const [savedMsg, setSavedMsg] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  // Probador
  const [testText, setTestText] = useState("");
  const [testStage, setTestStage] = useState<LeadStage>("NUEVO");
  const [testChannel, setTestChannel] = useState<Channel>("whatsapp");

  const load = async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/team/agents", { cache: "no-store" });
      const data = (await res.json()) as {
        agents?: AiAgent[];
        rev?: string | null;
        error?: string;
      };
      if (!res.ok || !data.agents) {
        setLoadError(data.error ?? "No se pudo cargar el equipo de IA");
        return;
      }
      setRev(data.rev ?? null);

      let draft: AiAgent[] | null = null;
      if (isAdmin) {
        try {
          const raw = sessionStorage.getItem(DRAFT_KEY);
          if (raw) draft = JSON.parse(raw) as AiAgent[];
        } catch {
          /* sin borrador */
        }
      }
      if (draft && JSON.stringify(draft) !== JSON.stringify(data.agents)) {
        setAgents(draft);
        setDirty(true);
        setDraftRestored(true);
      } else {
        setAgents(data.agents);
        setDirty(false);
      }
    } catch {
      setLoadError("No se pudo cargar el equipo de IA");
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markDirty = (next: AiAgent[]) => {
    setDirty(true);
    setSavedMsg(false);
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(next));
    } catch {
      /* noop */
    }
  };

  const clearDraft = () => {
    try {
      sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      /* noop */
    }
  };

  const update = (id: string, patch: Partial<AiAgent>) => {
    setAgents((prev) => {
      if (!prev) return prev;
      const next = prev.map((a) => (a.id === id ? { ...a, ...patch } : a));
      markDirty(next);
      return next;
    });
  };

  const add = () => {
    setAgents((prev) => {
      const next = [
        ...(prev ?? []),
        {
          id: `nuevo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: "",
          emoji: "🤖",
          instructions: "",
          topics: [],
          stages: [],
          channels: [],
          enabled: true,
        },
      ];
      markDirty(next);
      return next;
    });
  };

  const remove = (id: string) => {
    setAgents((prev) => {
      if (!prev) return prev;
      const next = prev.filter((a) => a.id !== id);
      markDirty(next);
      return next;
    });
  };

  const move = (id: string, dir: -1 | 1) => {
    setAgents((prev) => {
      if (!prev) return prev;
      const i = prev.findIndex((a) => a.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      markDirty(next);
      return next;
    });
  };

  const discardDraft = async () => {
    clearDraft();
    setDraftRestored(false);
    setDirty(false);
    setAgents(null);
    await load();
  };

  const acceptConflict = () => {
    if (!conflict) return;
    setAgents(conflict.agents);
    setRev(conflict.rev);
    setConflict(null);
    setDirty(false);
    setDraftRestored(false);
    clearDraft();
  };

  const save = async () => {
    if (!agents) return;
    setBusy(true);
    setError(null);
    setConflict(null);
    setSavedMsg(false);
    try {
      const res = await fetch("/api/team/agents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agents, baseRev: rev }),
      });
      const data = (await res.json().catch(() => null)) as {
        agents?: AiAgent[];
        rev?: string | null;
        error?: string;
        conflict?: boolean;
      } | null;
      if (res.status === 409 && data?.conflict) {
        setConflict({ agents: data.agents ?? [], rev: data.rev ?? null });
        setError(data.error ?? "Alguien más guardó primero");
        return;
      }
      if (!res.ok || !data?.agents) {
        setError(data?.error ?? "No se pudo guardar");
        return;
      }
      setRev(data.rev ?? null);
      setAgents(data.agents);
      setDirty(false);
      setDraftRestored(false);
      clearDraft();
      setSavedMsg(true);
    } catch {
      setError("Error de red al guardar");
    } finally {
      setBusy(false);
    }
  };

  // Probador: misma lógica de selección que usa el bot (sin continuidad,
  // que depende de la conversación real).
  const testResult = useMemo(() => {
    if (!testText.trim() || !agents || agents.length === 0) return null;
    return selectAgent(agents, {
      text: testText,
      stage: testStage,
      channel: testChannel,
      stickyId: null,
    });
  }, [testText, testStage, testChannel, agents]);

  const toggleInList = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

  return (
    <>
      <div className={cardClass}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-100">Equipo de IA (multiagentes)</h2>
            <p className="mt-1 max-w-2xl text-xs text-neutral-400">
              Agentes especializados que atienden la conversación según el <b>tema</b> del
              mensaje del cliente o el <b>flujo</b> (etapa del CRM, canal). El primero de la
              lista que aplique responde — el orden es la prioridad. Un agente <b>sin temas</b>{" "}
              es el comodín de su flujo: atiende todo lo que caiga en sus filtros. Cuando un
              lead activa un agente por tema, ese agente lo sigue atendiendo hasta que otro
              tema dispare. Los cambios aplican solos en menos de 15 segundos tras guardar.
            </p>
          </div>
          {isAdmin && (
            <div className="flex items-center gap-2">
              <button onClick={add} disabled={busy || agents === null} className={btnGhost}>
                + Crear agente
              </button>
              <button
                onClick={save}
                disabled={busy || !dirty || agents === null}
                className={btnPrimary}
              >
                {busy ? "Guardando..." : "Guardar cambios"}
              </button>
            </div>
          )}
        </div>

        {loadError && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-red-950 p-2 text-xs text-red-400">
            <span>{loadError}</span>
            <button onClick={load} className="shrink-0 font-medium underline underline-offset-2">
              Reintentar
            </button>
          </div>
        )}
        {error && !conflict && (
          <p className="mt-3 rounded-lg bg-red-950 p-2 text-xs text-red-400">{error}</p>
        )}
        {conflict && (
          <div className="mt-3 space-y-2 rounded-lg bg-amber-950 p-3 text-xs text-amber-300">
            <p>{error}</p>
            <div className="flex gap-2">
              <button
                onClick={acceptConflict}
                className="rounded-lg bg-amber-600 px-2.5 py-1 font-medium text-white hover:bg-amber-700"
              >
                Cargar la versión más reciente (descarta lo mío)
              </button>
              <button
                onClick={() => {
                  setRev(conflict.rev);
                  setConflict(null);
                }}
                className="rounded-lg border border-amber-700 px-2.5 py-1 font-medium hover:bg-amber-900"
              >
                Mantener lo mío y volver a guardar
              </button>
            </div>
          </div>
        )}
        {draftRestored && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-sky-950 p-2 text-xs text-sky-300">
            <span>Recuperamos cambios sin guardar de tu visita anterior. Guárdalos o descártalos.</span>
            <button onClick={discardDraft} className="shrink-0 font-medium underline underline-offset-2">
              Descartar borrador
            </button>
          </div>
        )}
        {savedMsg && (
          <p className="mt-3 rounded-lg bg-emerald-950 p-2 text-xs text-emerald-400">
            ✓ Guardado — el bot ya atiende con este equipo
          </p>
        )}
        {dirty && !savedMsg && !conflict && (
          <p className="mt-3 rounded-lg bg-neutral-950 p-2 text-xs text-amber-400/90">
            Hay cambios sin guardar — el bot sigue usando la última versión guardada.
          </p>
        )}

        <fieldset
          disabled={busy || !isAdmin}
          className={`m-0 mt-3 min-w-0 border-0 p-0 ${isAdmin ? "" : "opacity-90"}`}
        >
          <div className="space-y-3">
            {agents === null && !loadError && (
              <p className="py-6 text-center text-xs text-neutral-600">Cargando...</p>
            )}
            {agents?.map((a, idx) => (
              <div key={a.id} className="rounded-xl border border-neutral-800 bg-neutral-950 p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="w-14">
                    <label className={labelClass}>Emoji</label>
                    <input
                      value={a.emoji}
                      onChange={(e) => update(a.id, { emoji: e.target.value })}
                      maxLength={8}
                      className={`${inputClass} text-center`}
                    />
                  </div>
                  <div className="min-w-40 flex-1">
                    <label className={labelClass}>Nombre del agente</label>
                    <input
                      value={a.name}
                      onChange={(e) => update(a.id, { name: e.target.value })}
                      placeholder="p.ej. Asesor de pauta digital"
                      maxLength={40}
                      className={inputClass}
                    />
                  </div>
                  <div className="ml-auto flex items-center gap-1.5 pb-1">
                    <button
                      onClick={() => move(a.id, -1)}
                      disabled={idx === 0}
                      title="Subir prioridad"
                      className="rounded border border-neutral-700 px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => move(a.id, 1)}
                      disabled={idx === (agents?.length ?? 0) - 1}
                      title="Bajar prioridad"
                      className="rounded border border-neutral-700 px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      role="switch"
                      aria-checked={a.enabled}
                      onClick={() => update(a.id, { enabled: !a.enabled })}
                      title={a.enabled ? "Activo" : "Pausado"}
                      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                        a.enabled ? "bg-emerald-600" : "bg-neutral-700"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                          a.enabled ? "left-[18px]" : "left-0.5"
                        }`}
                      />
                    </button>
                    <button
                      onClick={() => remove(a.id)}
                      className="text-xs text-red-500 underline-offset-2 hover:underline"
                    >
                      Eliminar
                    </button>
                  </div>
                </div>

                <div className="mt-2">
                  <label className={labelClass}>
                    Instrucciones (qué sabe, cómo responde, qué ofrece)
                  </label>
                  <textarea
                    value={a.instructions}
                    onChange={(e) => update(a.id, { instructions: e.target.value })}
                    rows={4}
                    maxLength={4000}
                    placeholder={
                      "Eres el especialista en pauta digital de Motor Advertising.\nConoces los planes X y Y, sus precios y tiempos.\nTu objetivo es agendar una llamada de diagnóstico..."
                    }
                    className={inputClass}
                  />
                </div>

                <div className="mt-2 grid gap-2 lg:grid-cols-3">
                  <div>
                    <label className={labelClass}>
                      Temas que lo activan (separados por coma; vacío = comodín)
                    </label>
                    <input
                      value={a.topics.join(", ")}
                      onChange={(e) =>
                        update(a.id, {
                          topics: e.target.value
                            .split(",")
                            .map((t) => t.trim())
                            .filter((t) => t !== ""),
                        })
                      }
                      placeholder="pauta, publicidad, campañas"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Etapas del CRM (vacío = todas)</label>
                    <div className="flex flex-wrap gap-1">
                      {STAGE_ORDER.map((s) => (
                        <button
                          key={s}
                          onClick={() => update(a.id, { stages: toggleInList(a.stages, s) })}
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
                            a.stages.includes(s)
                              ? "bg-emerald-600 text-white"
                              : "border border-neutral-700 text-neutral-400 hover:bg-neutral-800"
                          }`}
                        >
                          {stageConfig[s].label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className={labelClass}>Canales (vacío = todos)</label>
                    <div className="flex flex-wrap gap-1">
                      {REPLY_CHANNELS.map((c) => (
                        <button
                          key={c}
                          onClick={() => update(a.id, { channels: toggleInList(a.channels, c) })}
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
                            a.channels.includes(c)
                              ? "bg-emerald-600 text-white"
                              : "border border-neutral-700 text-neutral-400 hover:bg-neutral-800"
                          }`}
                        >
                          {CHANNEL_LABELS[c]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {agents !== null && agents.length === 0 && (
              <p className="rounded-lg bg-neutral-950 py-6 text-center text-xs text-neutral-600">
                Sin agentes todavía. Crea el primero — por ejemplo, un especialista en precios
                que se active con los temas «precio, costo, cotización».
              </p>
            )}
          </div>
        </fieldset>
      </div>

      {/* Probador */}
      {agents !== null && agents.length > 0 && (
        <div className={cardClass}>
          <h3 className="text-sm font-semibold text-neutral-100">
            Probador — ¿qué agente atendería?
          </h3>
          <p className="mt-1 text-xs text-neutral-400">
            Simula un mensaje de cliente con su etapa y canal. Usa la misma lógica que el bot
            {dirty ? " (prueba lo que ves en pantalla, incluye cambios sin guardar)" : ""}.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-4">
            <input
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
              placeholder="p.ej. ¿qué planes de pauta manejan?"
              className={`${inputClass} sm:col-span-2`}
            />
            <select
              value={testStage}
              onChange={(e) => setTestStage(e.target.value as LeadStage)}
              className={inputClass}
            >
              {STAGE_ORDER.map((s) => (
                <option key={s} value={s}>
                  Etapa: {stageConfig[s].label}
                </option>
              ))}
            </select>
            <select
              value={testChannel}
              onChange={(e) => setTestChannel(e.target.value as Channel)}
              className={inputClass}
            >
              {REPLY_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  Canal: {CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          {testText.trim() && (
            <div className="mt-2 text-xs">
              {testResult ? (
                <p className="rounded-lg bg-emerald-950 p-2.5 text-emerald-400">
                  ✓ Atiende <b>{testResult.agent.emoji} {testResult.agent.name}</b>{" "}
                  {testResult.reason === "tema"
                    ? `— activado por el tema «${testResult.topic}»`
                    : "— comodín de este flujo (sin tema específico)"}
                </p>
              ) : (
                <p className="rounded-lg bg-neutral-950 p-2.5 text-neutral-500">
                  Ningún agente aplica — el bot respondería con su personalidad base de siempre.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
