"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation, LeadEvent, LeadNote, LeadStage, TeamMember } from "@/lib/db";
import { LEAD_STAGES } from "@/lib/db";
import { DEFAULT_STAGE_CONFIG, type StageConfigMap } from "@/lib/stages";

interface Props {
  lead: Conversation;
  // Pide al panel padre refrescar la conversación (para ver cambios al instante).
  onLeadChanged: () => void;
  // Ancho en px (columna redimensionable desde el divisor).
  width?: number;
}

const EVENT_LABELS: Record<string, string> = {
  stage: "Etapa",
  followup_scheduled: "Seguimiento programado",
  followup_sent: "Seguimiento enviado",
  followup_cancelled: "Seguimiento cancelado",
  followup_failed: "Seguimiento FALLIDO",
  handoff: "Derivado a humano",
  assigned: "Asignación",
  import: "Importado",
  email: "Correo enviado",
  email_in: "Correo recibido",
};

// Acepta formatos locales ("2.500.000", "1,5", "$ 3000"). Devuelve null para
// vacío, "invalid" si no es un número positivo — antes un "2.500.000" pasaba
// por Number() como NaN y la API lo guardaba como null en silencio.
function parseDealValue(raw: string): number | null | "invalid" {
  const s = raw.trim();
  if (s === "") return null;
  let t = s.replace(/[\s$]/g, "");
  if (t.includes(",") && t.includes(".")) {
    t = t.replace(/\./g, "").replace(",", ".");
  } else if (t.includes(",")) {
    t = t.replace(",", ".");
  } else if (/\.\d{3}(\.|$)/.test(t)) {
    t = t.replace(/\./g, ""); // puntos de miles estilo es-CO
  }
  const v = Number(t);
  if (!Number.isFinite(v) || v < 0) return "invalid";
  return v;
}

function timeAgo(epochSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - epochSeconds;
  if (diff < 60) return "ahora";
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  return new Date(epochSeconds * 1000).toLocaleDateString("es");
}

function formatFollowUp(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString("es", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
      {children}
    </h3>
  );
}

const inputClass =
  "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-emerald-600";

export default function LeadPanel({ lead, onLeadChanged, width = 320 }: Props) {
  const [notes, setNotes] = useState<LeadNote[]>([]);
  const [events, setEvents] = useState<LeadEvent[]>([]);
  // Nombres personalizados de las etapas (mismos que usa el kanban).
  const [stageConfig, setStageConfig] = useState<StageConfigMap>(DEFAULT_STAGE_CONFIG);
  // Miembros del equipo para el select "Asignado a".
  const [members, setMembers] = useState<TeamMember[]>([]);

  useEffect(() => {
    let active = true;
    fetch("/api/settings/stages", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { stages?: StageConfigMap } | null) => {
        if (active && data?.stages) setStageConfig(data.stages);
      })
      .catch(() => undefined);
    fetch("/api/team/members", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { members?: TeamMember[] } | null) => {
        if (active && data?.members) setMembers(data.members);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // Formulario de la ficha: se siembra SOLO al cambiar de lead para que el
  // polling del padre no borre lo que el operador está escribiendo. seededRef
  // guarda los valores sembrados: al guardar solo se envían los campos que el
  // operador MODIFICÓ (si no, un guardado pisaba con datos viejos lo que la
  // IA u otra pestaña rellenó después de abrir la ficha).
  const [form, setForm] = useState({ name: "", company: "", email: "", deal_value: "", tags: "" });
  const seededRef = useRef({ name: "", company: "", email: "", deal_value: "", tags: "" });
  const [savingForm, setSavingForm] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  // Score manual (independiente del formulario de la ficha).
  const [scoreInput, setScoreInput] = useState("");
  const [savingScore, setSavingScore] = useState(false);
  const [noteInput, setNoteInput] = useState("");
  const [fuDate, setFuDate] = useState("");
  const [fuMessage, setFuMessage] = useState("");
  const [busyFu, setBusyFu] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // typeof: robusto ante bases sin la migración CRM (campos undefined).
    const seeded = {
      name: lead.name ?? "",
      company: lead.company ?? "",
      email: lead.email ?? "",
      deal_value: typeof lead.deal_value === "number" ? String(lead.deal_value) : "",
      tags: (lead.tags ?? []).join(", "),
    };
    setForm(seeded);
    seededRef.current = seeded;
    setScoreInput(typeof lead.lead_score === "number" ? String(lead.lead_score) : "");
    setNoteInput("");
    setFuDate("");
    setFuMessage("");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.id]);

  const refetchDetail = useCallback(async () => {
    try {
      const res = await fetch(`/api/leads/${lead.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { notes: LeadNote[]; events: LeadEvent[] };
      setNotes(data.notes ?? []);
      setEvents(data.events ?? []);
    } catch {
      /* siguiente poll */
    }
  }, [lead.id]);

  useEffect(() => {
    refetchDetail();
    const timer = setInterval(refetchDetail, 10000);
    return () => clearInterval(timer);
  }, [refetchDetail]);

  const patch = async (body: Record<string, unknown>): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "No se pudo guardar");
        return false;
      }
      onLeadChanged();
      refetchDetail();
      return true;
    } catch {
      setError("Error de red al guardar");
      return false;
    }
  };

  const saveForm = async () => {
    // Solo los campos "dirty" (modificados desde el sembrado).
    const seeded = seededRef.current;
    const body: Record<string, unknown> = {};
    if (form.name !== seeded.name) body.name = form.name;
    if (form.company !== seeded.company) body.company = form.company;
    if (form.email !== seeded.email) body.email = form.email;
    if (form.tags !== seeded.tags) {
      body.tags = form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
    if (form.deal_value !== seeded.deal_value) {
      const v = parseDealValue(form.deal_value);
      if (v === "invalid") {
        setError("Valor estimado inválido: usa solo números (ej. 2500000)");
        return;
      }
      body.deal_value = v;
    }
    if (Object.keys(body).length === 0) return;

    setSavingForm(true);
    const ok = await patch(body);
    if (ok) seededRef.current = { ...form };
    setSavingForm(false);
  };

  const saveScore = async () => {
    const raw = scoreInput.trim();
    const value = raw === "" ? null : Number(raw);
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 100)) {
      setError("El score debe ser un entero entre 0 y 100");
      return;
    }
    setSavingScore(true);
    await patch({ lead_score: value });
    setSavingScore(false);
  };

  const analyze = async () => {
    setAnalyzing(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}/analyze`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Falló el análisis");
      } else {
        onLeadChanged();
        refetchDetail();
      }
    } catch {
      setError("Error de red en el análisis");
    } finally {
      setAnalyzing(false);
    }
  };

  const addNote = async () => {
    const content = noteInput.trim();
    if (!content) return;
    try {
      const res = await fetch(`/api/leads/${lead.id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        setNoteInput("");
        refetchDetail();
      }
    } catch {
      /* noop */
    }
  };

  const scheduleFu = async () => {
    const content = fuMessage.trim();
    if (!content || !fuDate) return;
    const sendAt = Math.floor(new Date(fuDate).getTime() / 1000);
    setBusyFu(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}/followup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, sendAt }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "No se pudo programar");
      } else {
        setFuDate("");
        setFuMessage("");
        onLeadChanged();
        refetchDetail();
      }
    } catch {
      setError("Error de red al programar el seguimiento. Reintenta.");
    } finally {
      setBusyFu(false);
    }
  };

  const cancelFu = async () => {
    setBusyFu(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}/followup`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "No se pudo cancelar el seguimiento");
        return;
      }
      onLeadChanged();
      refetchDetail();
    } catch {
      setError("Error de red al cancelar. Reintenta.");
    } finally {
      setBusyFu(false);
    }
  };

  const suggested = lead.ai_suggested_stage as LeadStage | null;
  const showSuggestion =
    suggested && LEAD_STAGES.includes(suggested) && suggested !== lead.stage;

  return (
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col gap-4 overflow-y-auto border-l border-neutral-800 bg-neutral-900 p-4"
    >
      {error && <p className="rounded-lg bg-red-950 p-2 text-xs text-red-400">{error}</p>}

      {/* Etapa */}
      <div className="space-y-2">
        <SectionTitle>Etapa del pipeline</SectionTitle>
        <select
          value={lead.stage ?? "NUEVO"}
          onChange={(e) => patch({ stage: e.target.value })}
          className={inputClass}
        >
          {LEAD_STAGES.map((s) => (
            <option key={s} value={s}>
              {stageConfig[s].label}
            </option>
          ))}
        </select>
        {showSuggestion && (
          <button
            onClick={() => patch({ stage: suggested })}
            className="w-full rounded-lg border border-violet-900 bg-violet-950/50 px-2.5 py-1.5 text-left text-xs text-violet-300 hover:bg-violet-950"
          >
            La IA sugiere mover a <strong>{stageConfig[suggested].label}</strong> — clic para aplicar
          </button>
        )}
      </div>

      {/* Vendedor asignado (Equipo). El cambio manual pisa la regla de
          enrutamiento por etapa hasta el próximo cambio de etapa. */}
      {members.length > 0 && (
        <div className="space-y-2">
          <SectionTitle>Asignado a</SectionTitle>
          <select
            value={lead.assigned_member_id ?? ""}
            onChange={(e) =>
              patch({ assigned_member_id: e.target.value ? Number(e.target.value) : null })
            }
            className={inputClass}
          >
            <option value="">— Sin asignar —</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.active ? "" : " (inactivo)"}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Análisis de IA */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <SectionTitle>Análisis de IA</SectionTitle>
          <button
            onClick={analyze}
            disabled={analyzing}
            className="rounded-lg border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            {analyzing ? "Analizando..." : "Analizar ahora"}
          </button>
        </div>
        {typeof lead.lead_score === "number" ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold text-neutral-100">{lead.lead_score}</span>
              <span className="text-[11px] text-neutral-500">/ 100 intención de compra</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neutral-800">
              <div
                className={`h-full rounded-full ${
                  lead.lead_score >= 70
                    ? "bg-emerald-500"
                    : lead.lead_score >= 40
                      ? "bg-amber-500"
                      : "bg-neutral-600"
                }`}
                style={{ width: `${lead.lead_score}%` }}
              />
            </div>
            {lead.ai_summary && (
              <p className="mt-2 text-xs leading-relaxed text-neutral-300">{lead.ai_summary}</p>
            )}
            {lead.ai_next_step && (
              <p className="mt-2 rounded bg-neutral-900 p-2 text-xs text-neutral-200">
                <span className="font-semibold text-neutral-400">Próximo paso: </span>
                {lead.ai_next_step}
              </p>
            )}
            {lead.ai_analyzed_at && (
              <p className="mt-1.5 text-[10px] text-neutral-600">
                Actualizado {timeAgo(lead.ai_analyzed_at)}
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-neutral-500">
            Aún sin análisis. Se genera solo cuando el cliente escribe, o pulsa
            &quot;Analizar ahora&quot;. También puedes puntuarlo tú abajo.
          </p>
        )}

        {/* Score manual: útil sobre todo en leads de correo, que no tienen
            conversación que la IA pueda analizar. Comparte campo con el de IA. */}
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={100}
            value={scoreInput}
            onChange={(e) => setScoreInput(e.target.value)}
            placeholder="0-100"
            className={`${inputClass} w-24`}
          />
          <button
            onClick={saveScore}
            disabled={savingScore}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            {savingScore ? "..." : "Fijar score manual"}
          </button>
        </div>
      </div>

      {/* Ficha */}
      <div className="space-y-2">
        <SectionTitle>Ficha del lead</SectionTitle>
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Nombre"
          className={inputClass}
        />
        <input
          value={form.company}
          onChange={(e) => setForm({ ...form, company: e.target.value })}
          placeholder="Empresa"
          className={inputClass}
        />
        <input
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          placeholder="Email"
          className={inputClass}
        />
        <input
          value={form.deal_value}
          onChange={(e) => setForm({ ...form, deal_value: e.target.value })}
          placeholder="Valor estimado ($)"
          inputMode="numeric"
          className={inputClass}
        />
        <input
          value={form.tags}
          onChange={(e) => setForm({ ...form, tags: e.target.value })}
          placeholder="Etiquetas (separadas por coma)"
          className={inputClass}
        />
        <button
          onClick={saveForm}
          disabled={savingForm}
          className="w-full rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {savingForm ? "Guardando..." : "Guardar ficha"}
        </button>
      </div>

      {/* Seguimiento programado */}
      <div className="space-y-2">
        <SectionTitle>Seguimiento automático</SectionTitle>
        {typeof lead.next_follow_up_at === "number" ? (
          <div className="rounded-lg border border-amber-900 bg-amber-950/40 p-3">
            <p className="text-xs font-medium text-amber-300">
              ⏰ Se enviará el {formatFollowUp(lead.next_follow_up_at)}
            </p>
            {lead.follow_up_note && (
              <p className="mt-1 text-xs text-neutral-300">&ldquo;{lead.follow_up_note}&rdquo;</p>
            )}
            <button
              onClick={cancelFu}
              disabled={busyFu}
              className="mt-2 rounded-lg border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
            >
              Cancelar seguimiento
            </button>
          </div>
        ) : (
          <>
            <input
              type="datetime-local"
              value={fuDate}
              onChange={(e) => setFuDate(e.target.value)}
              className={inputClass}
            />
            <textarea
              value={fuMessage}
              onChange={(e) => setFuMessage(e.target.value)}
              placeholder="Mensaje que el bot enviará por WhatsApp a esa hora..."
              rows={2}
              className={inputClass}
            />
            <button
              onClick={scheduleFu}
              disabled={busyFu || !fuDate || !fuMessage.trim()}
              className="w-full rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {busyFu ? "Programando..." : "Programar envío"}
            </button>
          </>
        )}
      </div>

      {/* Notas internas */}
      <div className="space-y-2">
        <SectionTitle>Notas internas</SectionTitle>
        <div className="flex gap-2">
          <input
            value={noteInput}
            onChange={(e) => setNoteInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addNote();
              }
            }}
            placeholder="Nueva nota (solo la ves tú)..."
            className={inputClass}
          />
          <button
            onClick={addNote}
            disabled={!noteInput.trim()}
            className="shrink-0 rounded-lg border border-neutral-700 px-3 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          >
            +
          </button>
        </div>
        <div className="max-h-40 space-y-1.5 overflow-y-auto">
          {notes.map((n) => (
            <div key={n.id} className="rounded-lg bg-neutral-950 p-2">
              <p className="text-xs text-neutral-200">{n.content}</p>
              <p className="mt-0.5 text-[10px] text-neutral-600">{timeAgo(n.created_at)}</p>
            </div>
          ))}
          {notes.length === 0 && <p className="text-xs text-neutral-600">Sin notas.</p>}
        </div>
      </div>

      {/* Actividad */}
      <div className="space-y-2">
        <SectionTitle>Actividad</SectionTitle>
        <div className="max-h-40 space-y-1 overflow-y-auto">
          {events.map((e) => (
            <p key={e.id} className="text-[11px] text-neutral-500">
              <span className="text-neutral-400">{EVENT_LABELS[e.type] ?? e.type}:</span>{" "}
              {e.detail} · {timeAgo(e.created_at)}
            </p>
          ))}
          {events.length === 0 && <p className="text-xs text-neutral-600">Sin actividad.</p>}
        </div>
      </div>
    </aside>
  );
}
