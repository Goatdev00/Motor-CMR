"use client";

import { useEffect, useRef, useState } from "react";
import type { QuickReply } from "@/lib/db";

interface Props {
  onInsert: (content: string) => void;
}

// Dropdown de plantillas para el composer en modo Humano: insertar con un
// clic, crear nuevas y borrar. Se cargan al abrir (no en cada poll).
export default function QuickReplies({ onInsert }: Props) {
  const [open, setOpen] = useState(false);
  const [replies, setReplies] = useState<QuickReply[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/quick-replies", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { replies: QuickReply[] };
      setReplies(data.replies ?? []);
    } catch {
      /* noop */
    }
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  // Cerrar al hacer clic fuera.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const create = async () => {
    const t = title.trim();
    const c = content.trim();
    if (!t || !c) return;
    try {
      const res = await fetch("/api/quick-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t, content: c }),
      });
      if (res.ok) {
        setTitle("");
        setContent("");
        setCreating(false);
        load();
      }
    } catch {
      /* noop */
    }
  };

  const remove = async (id: number) => {
    try {
      await fetch(`/api/quick-replies/${id}`, { method: "DELETE" });
      load();
    } catch {
      /* noop */
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        title="Plantillas de respuesta rápida"
        className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
      >
        Plantillas
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-40 mb-2 w-80 rounded-xl border border-neutral-700 bg-neutral-900 p-2 shadow-xl">
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {replies === null && <p className="p-2 text-xs text-neutral-500">Cargando...</p>}
            {replies?.length === 0 && (
              <p className="p-2 text-xs text-neutral-500">
                Sin plantillas. Crea la primera con “+ Nueva”.
              </p>
            )}
            {replies?.map((r) => (
              <div
                key={r.id}
                className="group flex items-start justify-between gap-2 rounded-lg p-2 hover:bg-neutral-800"
              >
                <button
                  onClick={() => {
                    onInsert(r.content);
                    setOpen(false);
                  }}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="text-xs font-semibold text-neutral-200">{r.title}</p>
                  <p className="truncate text-[11px] text-neutral-500">{r.content}</p>
                </button>
                <button
                  onClick={() => remove(r.id)}
                  title="Borrar plantilla"
                  className="hidden shrink-0 text-xs text-red-400 hover:text-red-300 group-hover:block"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <div className="mt-1 border-t border-neutral-800 pt-2">
            {creating ? (
              <div className="space-y-1.5">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Título (ej: Saludo inicial)"
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 outline-none placeholder:text-neutral-600"
                />
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Texto del mensaje..."
                  rows={2}
                  className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 outline-none placeholder:text-neutral-600"
                />
                <div className="flex gap-1.5">
                  <button
                    onClick={create}
                    disabled={!title.trim() || !content.trim()}
                    className="flex-1 rounded-lg bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Guardar
                  </button>
                  <button
                    onClick={() => setCreating(false)}
                    className="rounded-lg border border-neutral-700 px-2 py-1 text-xs text-neutral-300"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full rounded-lg px-2 py-1.5 text-left text-xs text-emerald-400 hover:bg-neutral-800"
              >
                + Nueva plantilla
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
