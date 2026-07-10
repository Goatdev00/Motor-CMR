"use client";

import { useEffect, useRef, useState } from "react";
import type { ConversationWithPreview, LeadStage } from "@/lib/db";
import {
  CHANNEL_BADGE_CLASS,
  CHANNEL_LABELS,
  conversationDisplayName,
  isChannel,
} from "@/lib/channels";
import {
  DEFAULT_STAGE_CONFIG,
  STAGE_ORDER,
  type StageConfigMap,
} from "@/lib/stages";
import StageEditor from "./StageEditor";

interface Props {
  onOpenLead: (id: number) => void;
}

function money(v: number): string {
  return `$${v.toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;
}

function relativeTime(epochSeconds: number | null): string {
  if (!epochSeconds) return "";
  const diff = Math.floor(Date.now() / 1000) - epochSeconds;
  if (diff < 60) return "ahora";
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  return `${Math.floor(diff / 86400)} d`;
}

// Tiempo restante hasta un timestamp futuro ("en 3 h", "en 20 min", "ya").
function untilTime(epochSeconds: number): string {
  const diff = epochSeconds - Math.floor(Date.now() / 1000);
  if (diff <= 0) return "ya";
  if (diff < 3600) return `en ${Math.max(1, Math.round(diff / 60))} min`;
  if (diff < 86400) return `en ${Math.round(diff / 3600)} h`;
  return `en ${Math.round(diff / 86400)} d`;
}

// El lead está "esperando respuesta" si el último mensaje del hilo es del
// cliente. Se usa el rol del último mensaje (preciso); el fallback por
// igualdad de timestamps cubre bases sin la última migración.
function isWaiting(l: ConversationWithPreview): boolean {
  if (l.last_message_role !== undefined && l.last_message_role !== null) {
    return l.last_message_role === "user";
  }
  return l.last_user_message_at !== null && l.last_user_message_at === l.last_message_at;
}

function scoreBadgeClass(score: number): string {
  if (score >= 70) return "bg-emerald-950 text-emerald-400";
  if (score >= 40) return "bg-amber-950 text-amber-400";
  return "bg-neutral-800 text-neutral-400";
}

// Tile de KPI: número en tinta neutra, etiqueta muda, acento solo como marca.
function StatTile({
  label,
  value,
  sub,
  dot,
}: {
  label: string;
  value: string;
  sub?: string;
  dot?: string;
}) {
  return (
    <div className="min-w-36 flex-1 rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs text-neutral-400">
        {dot && <span className={`h-2 w-2 rounded-full ${dot}`} />}
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold text-neutral-100">{value}</p>
      {sub && <p className="text-[11px] text-neutral-500">{sub}</p>}
    </div>
  );
}

export default function CrmBoard({ onOpenLead }: Props) {
  const [leads, setLeads] = useState<ConversationWithPreview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Nombres y colores de las etapas (personalizables desde el editor).
  const [stageConfig, setStageConfig] = useState<StageConfigMap>(DEFAULT_STAGE_CONFIG);
  const [editingStages, setEditingStages] = useState(false);
  const [analyzingAll, setAnalyzingAll] = useState(false);
  const [analyzeResult, setAnalyzeResult] = useState<string | null>(null);
  const dragId = useRef<number | null>(null);

  // Análisis general con IA. El endpoint salta los leads sin mensajes nuevos
  // desde su último análisis (manual o automático): no re-gasta tokens.
  const analyzeAll = async () => {
    if (analyzingAll) return;
    setAnalyzingAll(true);
    setAnalyzeResult(null);
    try {
      const res = await fetch("/api/crm/analyze-all", { method: "POST" });
      const data = (await res.json().catch(() => null)) as
        | { analyzed?: number; skipped?: number; failed?: number; error?: string }
        | null;
      if (!res.ok || !data) {
        setAnalyzeResult(`Error: ${data?.error ?? "no se pudo analizar"}`);
      } else {
        setAnalyzeResult(
          `✓ ${data.analyzed} analizados · ${data.skipped} ya al día` +
            (data.failed ? ` · ${data.failed} fallidos` : "")
        );
      }
      refetch();
    } catch {
      setAnalyzeResult("Error de red al analizar");
    } finally {
      setAnalyzingAll(false);
    }
  };
  // Guard de secuencia: descarta respuestas del poll que resuelven después
  // de una mutación (sin esto, mover una tarjeta "rebotaba" hasta 5s cuando
  // un GET viejo en vuelo pisaba el estado optimista).
  const seqRef = useRef(0);

  const refetch = async () => {
    const seq = ++seqRef.current;
    try {
      const res = await fetch("/api/crm", { cache: "no-store" });
      const data = (await res.json()) as { leads?: ConversationWithPreview[]; error?: string };
      if (seq !== seqRef.current) return; // respuesta obsoleta
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setError(null);
      setLeads(data.leads ?? []);
    } catch {
      /* reintenta en el próximo poll */
    }
  };

  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (active) await refetch();
    };
    poll();
    const timer = setInterval(poll, 5000);
    // Config de etapas: una vez al montar (si falla, quedan los defaults).
    fetch("/api/settings/stages", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { stages?: StageConfigMap } | null) => {
        if (active && data?.stages) setStageConfig(data.stages);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const moveStage = async (id: number, stage: LeadStage) => {
    // Optimista (setLeads funcional) + invalidación de GETs en vuelo.
    seqRef.current++;
    setLeads((prev) =>
      prev ? prev.map((l) => (l.id === id && l.stage !== stage ? { ...l, stage } : l)) : prev
    );
    try {
      await fetch(`/api/leads/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage }),
      });
    } finally {
      refetch();
    }
  };

  if (error) {
    return (
      <main className="flex flex-1 items-center justify-center p-6">
        <p className="max-w-lg rounded-lg bg-red-950 p-4 text-sm text-red-400">Error: {error}</p>
      </main>
    );
  }

  if (!leads) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-300" />
      </main>
    );
  }

  const open = leads.filter((l) => l.stage !== "GANADO" && l.stage !== "PERDIDO");
  const won = leads.filter((l) => l.stage === "GANADO");
  const lost = leads.filter((l) => l.stage === "PERDIDO");
  const openValue = open.reduce((s, l) => s + (l.deal_value ?? 0), 0);
  const wonValue = won.reduce((s, l) => s + (l.deal_value ?? 0), 0);
  const closed = won.length + lost.length;
  const closeRate = closed > 0 ? Math.round((won.length / closed) * 100) : null;
  const waiting = open.filter(isWaiting);
  const scored = open.filter((l) => l.lead_score !== null);
  const avgScore =
    scored.length > 0
      ? Math.round(scored.reduce((s, l) => s + (l.lead_score ?? 0), 0) / scored.length)
      : null;

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      {/* KPIs */}
      <div className="flex flex-wrap gap-3">
        <StatTile
          label="Pipeline abierto"
          value={money(openValue)}
          sub={`${open.length} leads activos`}
        />
        <StatTile label="Ganado" value={money(wonValue)} sub={`${won.length} cierres`} dot="bg-emerald-400" />
        <StatTile
          label="Tasa de cierre"
          value={closeRate === null ? "—" : `${closeRate}%`}
          sub={closed > 0 ? `${won.length} de ${closed} definidos` : "sin cierres aún"}
        />
        <StatTile
          label="Sin responder"
          value={String(waiting.length)}
          sub="esperan tu respuesta"
          dot={waiting.length > 0 ? "bg-red-400" : "bg-neutral-600"}
        />
        <StatTile
          label="Score promedio (IA)"
          value={avgScore === null ? "—" : String(avgScore)}
          sub={scored.length > 0 ? `${scored.length} leads analizados` : "aún sin análisis"}
        />
        <button
          onClick={analyzeAll}
          disabled={analyzingAll}
          title="Analiza con IA solo los leads con mensajes nuevos desde su último análisis"
          className="flex min-w-36 flex-1 flex-col items-start justify-center rounded-xl border border-neutral-700 bg-neutral-800 px-4 py-3 text-left transition-colors hover:bg-neutral-700 disabled:opacity-60"
        >
          <span className="text-xs text-neutral-400">Análisis general</span>
          <span className="mt-1 text-sm font-semibold text-neutral-200">
            {analyzingAll ? "Analizando..." : "Analizar con IA"}
          </span>
          <span className="text-[11px] text-neutral-500">solo leads con mensajes nuevos</span>
        </button>
      </div>
      {analyzeResult && (
        <p
          className={`rounded-lg p-2 text-xs ${
            analyzeResult.startsWith("✓")
              ? "bg-emerald-950 text-emerald-400"
              : "bg-red-950 text-red-400"
          }`}
        >
          {analyzeResult}
        </p>
      )}

      {/* Encabezado del kanban + personalización de etapas */}
      <div className="flex items-center justify-end">
        <button
          onClick={() => setEditingStages(true)}
          className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          ✎ Personalizar etapas
        </button>
      </div>

      {/* Kanban */}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
        {STAGE_ORDER.map((stageKey) => {
          const cfg = stageConfig[stageKey];
          const items = leads.filter((l) => l.stage === stageKey);
          const value = items.reduce((s, l) => s + (l.deal_value ?? 0), 0);
          return (
            <div
              key={stageKey}
              className="flex w-64 shrink-0 flex-col rounded-xl border border-neutral-800 bg-neutral-900/60"
              onDragOver={(e) => {
                // Solo aceptar arrastres de tarjetas de lead (no texto,
                // imágenes o archivos del escritorio).
                if (e.dataTransfer.types.includes("application/x-lead-id")) e.preventDefault();
              }}
              onDrop={(e) => {
                if (!e.dataTransfer.types.includes("application/x-lead-id")) return;
                e.preventDefault();
                const id = Number(e.dataTransfer.getData("application/x-lead-id"));
                if (Number.isInteger(id) && id > 0) moveStage(id, stageKey);
                dragId.current = null;
              }}
            >
              <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-neutral-300">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: cfg.color }}
                  />
                  {cfg.label}
                  <span className="text-neutral-500">({items.length})</span>
                </span>
                {value > 0 && <span className="text-[11px] text-neutral-500">{money(value)}</span>}
              </div>

              <div className="min-h-24 flex-1 space-y-2 overflow-y-auto p-2">
                {items.map((l) => {
                  const waitingLead = isWaiting(l);
                  return (
                    <div
                      key={l.id}
                      draggable
                      onDragStart={(e) => {
                        dragId.current = l.id;
                        e.dataTransfer.setData("application/x-lead-id", String(l.id));
                      }}
                      onDragEnd={() => (dragId.current = null)}
                      onClick={() => onOpenLead(l.id)}
                      className="cursor-pointer rounded-lg border border-neutral-800 bg-neutral-900 p-2.5 transition-colors hover:border-neutral-600"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-neutral-100">
                          {conversationDisplayName(l)}
                        </span>
                        {l.lead_score !== null && (
                          <span
                            title="Score de intención de compra (IA)"
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${scoreBadgeClass(l.lead_score)}`}
                          >
                            IA {l.lead_score}
                          </span>
                        )}
                      </div>
                      {l.company && (
                        <p className="truncate text-[11px] text-neutral-500">{l.company}</p>
                      )}
                      {l.last_message_preview && (
                        <p className="mt-1 truncate text-xs text-neutral-400">
                          {l.last_message_preview}
                        </p>
                      )}
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px]">
                        {isChannel(l.channel) && l.channel !== "whatsapp" && (
                          <span
                            className={`rounded px-1.5 py-0.5 font-semibold ${CHANNEL_BADGE_CLASS[l.channel]}`}
                          >
                            {CHANNEL_LABELS[l.channel]}
                          </span>
                        )}
                        {l.deal_value !== null && (
                          <span className="text-neutral-300">{money(l.deal_value)}</span>
                        )}
                        {waitingLead && (
                          <span className="flex items-center gap-1 text-red-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                            sin responder · {relativeTime(l.last_user_message_at)}
                          </span>
                        )}
                        {l.next_follow_up_at && (
                          <span className="text-amber-400" title={l.follow_up_note ?? ""}>
                            ⏰ seguimiento {untilTime(l.next_follow_up_at)}
                          </span>
                        )}
                        {l.tags.slice(0, 3).map((t) => (
                          <span key={t} className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-400">
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {items.length === 0 && (
                  <p className="px-2 py-4 text-center text-[11px] text-neutral-600">
                    Arrastra leads aquí
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {editingStages && (
        <StageEditor
          config={stageConfig}
          onClose={() => setEditingStages(false)}
          onSaved={(cfg) => {
            setStageConfig(cfg);
            setEditingStages(false);
          }}
        />
      )}
    </main>
  );
}
