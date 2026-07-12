"use client";

import { useEffect, useMemo, useState } from "react";
import {
  findMatchingTrigger,
  type KeywordMatch,
  type KeywordTrigger,
} from "@/lib/keyword-match";
import type { QuickReply } from "@/lib/db";

// Sección Plantillas: (1) plantillas de mensajes reutilizables — las mismas
// "respuestas rápidas" del botón ⚡ del chat — y (2) palabras clave con
// respuesta automática: si el cliente escribe "INFO" (u otra palabra
// configurada) en cualquier canal, el bot contesta solo con el contenido
// asignado, sin pasar por la IA.

const cardClass = "rounded-xl border border-neutral-800 bg-neutral-900 p-4";
const inputClass =
  "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-emerald-600";
const btnPrimary =
  "rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const btnGhost =
  "rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50";
const labelClass = "mb-1 block text-[11px] font-medium text-neutral-500";

export default function TemplatesPanel() {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto grid max-w-5xl gap-4">
        <KeywordTriggersCard />
        <QuickTemplatesCard />
      </div>
    </main>
  );
}

// ── Palabras clave con respuesta automática ─────────────────

// Fila editable: el id estable permite conservar la edición aunque el
// servidor devuelva la lista saneada.
function KeywordTriggersCard() {
  const [triggers, setTriggers] = useState<KeywordTrigger[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [testText, setTestText] = useState("");

  useEffect(() => {
    fetch("/api/templates/keywords", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { triggers?: KeywordTrigger[]; error?: string }) => {
        if (data.triggers) setTriggers(data.triggers);
        else setError(data.error ?? "No se pudieron cargar las palabras clave");
      })
      .catch(() => setError("No se pudieron cargar las palabras clave"));
  }, []);

  const update = (id: string, patch: Partial<KeywordTrigger>) => {
    setTriggers((prev) =>
      prev ? prev.map((t) => (t.id === id ? { ...t, ...patch } : t)) : prev
    );
    setDirty(true);
    setSavedMsg(false);
  };

  const add = () => {
    setTriggers((prev) => [
      ...(prev ?? []),
      {
        id: `nuevo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        keyword: "",
        content: "",
        match: "exacta" as KeywordMatch,
        enabled: true,
        also_human: false,
      },
    ]);
    setDirty(true);
    setSavedMsg(false);
  };

  const remove = (id: string) => {
    setTriggers((prev) => (prev ? prev.filter((t) => t.id !== id) : prev));
    setDirty(true);
    setSavedMsg(false);
  };

  const save = async () => {
    if (!triggers) return;
    setBusy(true);
    setError(null);
    setSavedMsg(false);
    try {
      const res = await fetch("/api/templates/keywords", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggers }),
      });
      const data = (await res.json().catch(() => null)) as {
        triggers?: KeywordTrigger[];
        error?: string;
      } | null;
      if (!res.ok || !data?.triggers) {
        setError(data?.error ?? "No se pudo guardar");
        return;
      }
      setTriggers(data.triggers);
      setDirty(false);
      setSavedMsg(true);
    } catch {
      setError("Error de red al guardar");
    } finally {
      setBusy(false);
    }
  };

  // Probador en vivo: usa EXACTAMENTE la misma lógica de matching que el bot.
  const testResult = useMemo(() => {
    if (!testText.trim() || !triggers) return null;
    return findMatchingTrigger(triggers, testText);
  }, [testText, triggers]);

  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-100">
            Palabras clave con respuesta automática
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-neutral-400">
            Si un cliente escribe la palabra en el chat de cualquier canal (WhatsApp, Instagram,
            Messenger, WhatsApp API), el bot responde al instante con el contenido asignado —
            sin pasar por la IA. No distingue mayúsculas, tildes ni signos: «¡INFO!» dispara
            igual que «info». Los cambios aplican solos en menos de 15 segundos.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={add} disabled={busy || triggers === null} className={btnGhost}>
            + Agregar palabra
          </button>
          <button onClick={save} disabled={busy || !dirty} className={btnPrimary}>
            {busy ? "Guardando..." : "Guardar cambios"}
          </button>
        </div>
      </div>

      {error && <p className="mt-3 rounded-lg bg-red-950 p-2 text-xs text-red-400">{error}</p>}
      {savedMsg && (
        <p className="mt-3 rounded-lg bg-emerald-950 p-2 text-xs text-emerald-400">
          ✓ Guardado — el bot ya responde con la nueva configuración
        </p>
      )}

      <div className="mt-3 space-y-2">
        {triggers === null && !error && (
          <p className="py-6 text-center text-xs text-neutral-600">Cargando...</p>
        )}
        {triggers?.map((t) => (
          <div key={t.id} className="rounded-xl border border-neutral-800 bg-neutral-950 p-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-40 flex-1">
                <label className={labelClass}>Palabra o frase</label>
                <input
                  value={t.keyword}
                  onChange={(e) => update(t.id, { keyword: e.target.value })}
                  placeholder="INFO"
                  maxLength={80}
                  className={`${inputClass} font-semibold uppercase placeholder:normal-case`}
                />
              </div>
              <div>
                <label className={labelClass}>Cuándo dispara</label>
                <select
                  value={t.match}
                  onChange={(e) => update(t.id, { match: e.target.value as KeywordMatch })}
                  className={`${inputClass} w-auto`}
                >
                  <option value="exacta">El mensaje es solo esta palabra</option>
                  <option value="contiene">El mensaje la contiene</option>
                </select>
              </div>
              <label
                className="flex cursor-pointer items-center gap-1.5 pb-2 text-xs text-neutral-400"
                title="Si está activo, responde aunque un operador haya tomado la conversación (modo humano)"
              >
                <input
                  type="checkbox"
                  checked={t.also_human}
                  onChange={(e) => update(t.id, { also_human: e.target.checked })}
                  className="h-3.5 w-3.5 accent-emerald-600"
                />
                También en modo humano
              </label>
              <div className="ml-auto flex items-center gap-2 pb-1">
                <button
                  role="switch"
                  aria-checked={t.enabled}
                  onClick={() => update(t.id, { enabled: !t.enabled })}
                  title={t.enabled ? "Activa" : "Pausada"}
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                    t.enabled ? "bg-emerald-600" : "bg-neutral-700"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                      t.enabled ? "left-[18px]" : "left-0.5"
                    }`}
                  />
                </button>
                <button
                  onClick={() => remove(t.id)}
                  className="text-xs text-red-500 underline-offset-2 hover:underline"
                >
                  Eliminar
                </button>
              </div>
            </div>
            <div className="mt-2">
              <label className={labelClass}>Respuesta del bot</label>
              <textarea
                value={t.content}
                onChange={(e) => update(t.id, { content: e.target.value })}
                rows={3}
                maxLength={2000}
                placeholder={"¡Hola! Gracias por tu interés. Aquí va la información:\n..."}
                className={inputClass}
              />
            </div>
          </div>
        ))}
        {triggers !== null && triggers.length === 0 && (
          <p className="rounded-lg bg-neutral-950 py-6 text-center text-xs text-neutral-600">
            Sin palabras clave todavía. Agrega la primera — por ejemplo, «INFO» con la
            información de tus servicios.
          </p>
        )}
      </div>

      {/* Probador */}
      {triggers !== null && triggers.length > 0 && (
        <div className="mt-4 rounded-xl border border-dashed border-neutral-700 p-3">
          <label className={labelClass}>
            Probador — escribe un mensaje como si fueras el cliente
          </label>
          <input
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            placeholder="p.ej. ¡Hola! quiero INFO por favor"
            className={inputClass}
          />
          {testText.trim() && (
            <div className="mt-2 text-xs">
              {testResult ? (
                <div className="rounded-lg bg-emerald-950 p-2.5 text-emerald-400">
                  <p className="font-semibold">
                    ✓ Dispara «{testResult.keyword}»
                    {!testResult.enabled ? " (está pausada)" : ""}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-emerald-300/80">
                    {testResult.content}
                  </p>
                </div>
              ) : (
                <p className="rounded-lg bg-neutral-950 p-2.5 text-neutral-500">
                  Ninguna palabra clave dispara con ese mensaje — el bot respondería con la IA
                  (si el chat está en modo AI). Nota: si guardaste hace poco, revisa que la
                  palabra esté activa.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Plantillas de mensajes (respuestas rápidas del chat) ────

function QuickTemplatesCard() {
  const [replies, setReplies] = useState<QuickReply[] | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/quick-replies", { cache: "no-store" });
      const data = (await res.json()) as { replies?: QuickReply[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setError(null);
      setReplies(data.replies ?? []);
    } catch {
      setError("No se pudieron cargar las plantillas");
    }
  };

  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    if (!title.trim() || !content.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/quick-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), content: content.trim() }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? "No se pudo crear la plantilla");
        return;
      }
      setTitle("");
      setContent("");
      await load();
    } catch {
      setError("Error de red al crear");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    setBusy(true);
    try {
      await fetch(`/api/quick-replies/${id}`, { method: "DELETE" });
      await load();
    } catch {
      setError("Error de red al eliminar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cardClass}>
      <h2 className="text-sm font-semibold text-neutral-100">Plantillas de mensajes</h2>
      <p className="mt-1 max-w-2xl text-xs text-neutral-400">
        Textos reutilizables para el equipo: aparecen en el botón <b>⚡</b> del chat para
        insertarlos con un clic antes de enviar. Útiles para saludos, precios, horarios o
        respuestas frecuentes que prefieres mandar a mano.
      </p>

      {error && <p className="mt-3 rounded-lg bg-red-950 p-2 text-xs text-red-400">{error}</p>}

      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        {/* Crear */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-3">
          <label className={labelClass}>Título (para encontrarla rápido)</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Precios 2026"
            maxLength={80}
            className={inputClass}
          />
          <label className={`${labelClass} mt-2`}>Contenido</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
            placeholder={"Hola, claro que sí.\nNuestros planes son..."}
            className={inputClass}
          />
          <button
            onClick={create}
            disabled={busy || !title.trim() || !content.trim()}
            className={`mt-2 ${btnPrimary}`}
          >
            {busy ? "..." : "Crear plantilla"}
          </button>
        </div>

        {/* Lista */}
        <div className="max-h-80 space-y-1.5 overflow-y-auto">
          {(replies ?? []).map((r) => (
            <div key={r.id} className="rounded-lg border border-neutral-800 bg-neutral-950 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-xs font-semibold text-neutral-200">{r.title}</p>
                <button
                  onClick={() => remove(r.id)}
                  disabled={busy}
                  className="shrink-0 text-xs text-red-500 underline-offset-2 hover:underline"
                >
                  Eliminar
                </button>
              </div>
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-neutral-500">
                {r.content}
              </p>
            </div>
          ))}
          {replies !== null && replies.length === 0 && (
            <p className="rounded-lg bg-neutral-950 py-6 text-center text-xs text-neutral-600">
              Sin plantillas todavía.
            </p>
          )}
          {replies === null && !error && (
            <p className="py-6 text-center text-xs text-neutral-600">Cargando...</p>
          )}
        </div>
      </div>
    </div>
  );
}
