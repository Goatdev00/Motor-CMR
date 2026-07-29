"use client";

import { useEffect, useState, type ReactNode } from "react";

// Tarjeta contraíble para los paneles de configuración (Canales, Mailing):
// las que ya quedaron configuradas arrancan CONTRAÍDAS (solo el encabezado
// con su chip "✓ Configurado") para despejar la vista; clic en el título
// expande/contrae. `completed` suele llegar tras cargar del servidor, por
// eso el estado inicial se fija UNA sola vez cuando `ready` pasa a true; de
// ahí en adelante manda el usuario. Lo que esté en headerRight (p.ej. el
// interruptor del canal) queda fuera del área clicable y sigue operable aun
// con la tarjeta contraída.
export default function CollapsibleCard({
  title,
  description,
  completed,
  ready = true,
  headerRight,
  className = "",
  children,
}: {
  title: string;
  description?: ReactNode;
  completed: boolean;
  ready?: boolean;
  headerRight?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!ready || initialized) return;
    setInitialized(true);
    setOpen(!completed);
  }, [ready, initialized, completed]);

  return (
    <div
      className={`self-start rounded-xl border border-neutral-800 bg-neutral-900 p-4 ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? "Contraer" : "Expandir"}
          className="min-w-0 flex-1 text-left"
        >
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-neutral-100">
            {/* Chevron minimal (línea fina gris), gira hacia abajo al expandir. */}
            <svg
              viewBox="0 0 16 16"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`h-3 w-3 shrink-0 text-neutral-600 transition-transform ${
                open ? "rotate-90" : ""
              }`}
            >
              <path d="M6 4l4 4-4 4" />
            </svg>
            {title}
            {completed && (
              <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400">
                ✓ Configurado
              </span>
            )}
          </h2>
          {open && description && <p className="mt-1 text-xs text-neutral-400">{description}</p>}
        </button>
        {headerRight && <div className="shrink-0">{headerRight}</div>}
      </div>
      {open && children}
    </div>
  );
}
