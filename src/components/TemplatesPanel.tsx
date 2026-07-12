"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  findMatchingTrigger,
  triggerMatches,
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
  "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-emerald-600 disabled:opacity-60";
const btnPrimary =
  "rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const btnGhost =
  "rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50";
const labelClass = "mb-1 block text-[11px] font-medium text-neutral-500";

// Borrador local: los cambios sin guardar sobreviven a un cambio de pestaña
// del dashboard (el panel se desmonta al navegar a Chats/CRM/etc.).
const DRAFT_KEY = "plantillas-borrador";

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

function KeywordTriggersCard() {
  const [triggers, setTriggers] = useState<KeywordTrigger[] | null>(null);
  // rev de la versión del servidor sobre la que se edita (control de
  // concurrencia optimista: otra pestaña guardando primero da 409).
  const [rev, setRev] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ triggers: KeywordTrigger[]; rev: string | null } | null>(null);
  const [savedMsg, setSavedMsg] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [testText, setTestText] = useState("");
  // La lista puede cambiar mientras el PUT viaja; con los campos
  // deshabilitados durante el guardado no debería, pero el ref evita
  // sobrescribir ediciones si el navegador se las arregla para colarlas.
  const sentListRef = useRef<string | null>(null);

  const load = async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/templates/keywords", { cache: "no-store" });
      const data = (await res.json()) as {
        triggers?: KeywordTrigger[];
        rev?: string | null;
        error?: string;
      };
      if (!res.ok || !data.triggers) {
        setLoadError(data.error ?? "No se pudieron cargar las palabras clave");
        return;
      }
      setRev(data.rev ?? null);

      // ¿Quedó un borrador sin guardar de una visita anterior? Se restaura
      // (con aviso) en vez de perder lo escrito al cambiar de pestaña.
      let draft: KeywordTrigger[] | null = null;
      try {
        const raw = sessionStorage.getItem(DRAFT_KEY);
        if (raw) draft = JSON.parse(raw) as KeywordTrigger[];
      } catch {
        /* borrador corrupto o sin sessionStorage: se ignora */
      }
      if (draft && JSON.stringify(draft) !== JSON.stringify(data.triggers)) {
        setTriggers(draft);
        setDirty(true);
        setDraftRestored(true);
      } else {
        setTriggers(data.triggers);
        setDirty(false);
      }
    } catch {
      setLoadError("No se pudieron cargar las palabras clave");
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markDirty = (next: KeywordTrigger[]) => {
    setDirty(true);
    setSavedMsg(false);
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(next));
    } catch {
      /* sin storage el borrador no sobrevive a un cambio de pestaña */
    }
  };

  const clearDraft = () => {
    try {
      sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      /* noop */
    }
  };

  const update = (id: string, patch: Partial<KeywordTrigger>) => {
    setTriggers((prev) => {
      if (!prev) return prev;
      const next = prev.map((t) => (t.id === id ? { ...t, ...patch } : t));
      markDirty(next);
      return next;
    });
  };

  const add = () => {
    setTriggers((prev) => {
      const next = [
        ...(prev ?? []),
        {
          id: `nuevo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          keyword: "",
          content: "",
          match: "exacta" as KeywordMatch,
          enabled: true,
          also_human: false,
        },
      ];
      markDirty(next);
      return next;
    });
  };

  const remove = (id: string) => {
    setTriggers((prev) => {
      if (!prev) return prev;
      const next = prev.filter((t) => t.id !== id);
      markDirty(next);
      return next;
    });
  };

  const discardDraft = async () => {
    clearDraft();
    setDraftRestored(false);
    setDirty(false);
    setTriggers(null);
    await load();
  };

  const acceptConflict = () => {
    if (!conflict) return;
    setTriggers(conflict.triggers);
    setRev(conflict.rev);
    setConflict(null);
    setDirty(false);
    setDraftRestored(false);
    clearDraft();
  };

  const save = async () => {
    if (!triggers) return;
    setBusy(true);
    setError(null);
    setConflict(null);
    setSavedMsg(false);
    sentListRef.current = JSON.stringify(triggers);
    try {
      const res = await fetch("/api/templates/keywords", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggers, baseRev: rev }),
      });
      const data = (await res.json().catch(() => null)) as {
        triggers?: KeywordTrigger[];
        rev?: string | null;
        error?: string;
        conflict?: boolean;
      } | null;
      if (res.status === 409 && data?.conflict) {
        setConflict({ triggers: data.triggers ?? [], rev: data.rev ?? null });
        setError(data.error ?? "Alguien más guardó primero");
        return;
      }
      if (!res.ok || !data?.triggers) {
        setError(data?.error ?? "No se pudo guardar");
        return;
      }
      // Si el usuario logró editar mientras el PUT viajaba, sus cambios
      // mandan: se conserva la edición y queda pendiente de guardar.
      const editedDuringFlight =
        sentListRef.current !== null &&
        JSON.stringify(triggers) !== sentListRef.current;
      setRev(data.rev ?? null);
      if (!editedDuringFlight) {
        setTriggers(data.triggers);
        setDirty(false);
        setDraftRestored(false);
        clearDraft();
        setSavedMsg(true);
      }
    } catch {
      setError("Error de red al guardar");
    } finally {
      sentListRef.current = null;
      setBusy(false);
    }
  };

  // Probador en vivo: usa EXACTAMENTE la misma lógica de matching que el
  // bot, sobre lo que hay EN PANTALLA (incluye cambios sin guardar).
  const testResult = useMemo(() => {
    if (!testText.trim() || !triggers) return null;
    const active = findMatchingTrigger(triggers, testText);
    if (active) return { trigger: active, paused: false };
    // Ninguna activa dispara: ¿alguna PAUSADA lo haría? (aviso honesto en
    // vez de un "no dispara nada" desconcertante).
    const paused = triggers.find((t) => !t.enabled && triggerMatches(t, testText));
    return paused ? { trigger: paused, paused: true } : null;
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
            igual que «info». Los cambios aplican solos en menos de 15 segundos tras guardar.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={add} disabled={busy || triggers === null} className={btnGhost}>
            + Agregar palabra
          </button>
          <button onClick={save} disabled={busy || !dirty || triggers === null} className={btnPrimary}>
            {busy ? "Guardando..." : "Guardar cambios"}
          </button>
        </div>
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
                // Reintentar encima de la versión nueva conservando MI lista.
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
          <span>
            Recuperamos cambios sin guardar de tu visita anterior. Guárdalos o descártalos.
          </span>
          <button
            onClick={discardDraft}
            className="shrink-0 font-medium underline underline-offset-2"
          >
            Descartar borrador
          </button>
        </div>
      )}
      {savedMsg && (
        <p className="mt-3 rounded-lg bg-emerald-950 p-2 text-xs text-emerald-400">
          ✓ Guardado — el bot ya responde con la nueva configuración
        </p>
      )}
      {dirty && !savedMsg && !conflict && (
        <p className="mt-3 rounded-lg bg-neutral-950 p-2 text-xs text-amber-400/90">
          Hay cambios sin guardar — el bot sigue usando la última versión guardada.
        </p>
      )}

      {/* Los campos se bloquean durante el guardado: editar con el PUT en
          vuelo perdía lo escrito al llegar la respuesta. */}
      <fieldset disabled={busy} className="m-0 mt-3 min-w-0 border-0 p-0">
        <div className="space-y-2">
          {triggers === null && !loadError && (
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
      </fieldset>

      {/* Probador */}
      {triggers !== null && triggers.length > 0 && (
        <div className="mt-4 rounded-xl border border-dashed border-neutral-700 p-3">
          <label className={labelClass}>
            Probador — escribe un mensaje como si fueras el cliente
            {dirty ? " (prueba lo que ves en pantalla, incluye cambios sin guardar)" : ""}
          </label>
          <input
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            placeholder="p.ej. ¡Hola! quiero INFO por favor"
            className={inputClass}
          />
          {testText.trim() && (
            <div className="mt-2 text-xs">
              {testResult && !testResult.paused ? (
                <div className="rounded-lg bg-emerald-950 p-2.5 text-emerald-400">
                  <p className="font-semibold">✓ Dispara «{testResult.trigger.keyword}»</p>
                  <p className="mt-1 whitespace-pre-wrap text-emerald-300/80">
                    {testResult.trigger.content}
                  </p>
                </div>
              ) : testResult?.paused ? (
                <p className="rounded-lg bg-amber-950 p-2.5 text-amber-400">
                  «{testResult.trigger.keyword}» dispararía con este mensaje, pero está{" "}
                  <b>pausada</b> — actívala con el interruptor para que responda.
                </p>
              ) : (
                <p className="rounded-lg bg-neutral-950 p-2.5 text-neutral-500">
                  Ninguna palabra clave dispara con ese mensaje — el bot respondería con la IA
                  (si el chat está en modo AI).
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
      const res = await fetch(`/api/quick-replies/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "No se pudo eliminar la plantilla");
        return;
      }
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
