"use client";

import { useCallback, useEffect, useState } from "react";

// Divisor vertical arrastrable entre columnas: arrastra para ajustar el
// ancho, doble clic para restaurar el predeterminado.
interface Props {
  // Delta horizontal en px por movimiento (el consumidor aplica el signo
  // según de qué lado esté su columna).
  onDelta: (dx: number) => void;
  onReset?: () => void;
}

export default function Resizer({ onDelta, onReset }: Props) {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    let last = e.clientX;
    const move = (ev: PointerEvent) => {
      onDelta(ev.clientX - last);
      last = ev.clientX;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    // Sin esto, arrastrar selecciona texto de los paneles vecinos.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      title="Arrastra para ajustar el ancho · doble clic para restaurar"
      className="group relative z-10 -mx-0.5 w-1.5 shrink-0 cursor-col-resize"
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-neutral-800 transition-colors group-hover:w-[3px] group-hover:bg-emerald-600 group-active:w-[3px] group-active:bg-emerald-500" />
    </div>
  );
}

// Ancho de un panel, persistido en localStorage y con límites.
export function usePanelWidth(key: string, def: number, min: number, max: number) {
  const [width, setWidth] = useState(def);

  // localStorage no existe en el render de servidor: se lee tras montar.
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      if (Number.isFinite(saved) && saved >= min && saved <= max) setWidth(saved);
    } catch {
      /* modo privado: queda el default */
    }
  }, [key, min, max]);

  const adjust = useCallback(
    (dx: number) => {
      setWidth((prev) => {
        const next = Math.min(max, Math.max(min, prev + dx));
        try {
          localStorage.setItem(key, String(Math.round(next)));
        } catch {
          /* sin storage no se persiste */
        }
        return next;
      });
    },
    [key, min, max]
  );

  const reset = useCallback(() => {
    setWidth(def);
    try {
      localStorage.removeItem(key);
    } catch {
      /* noop */
    }
  }, [def, key]);

  return { width, adjust, reset };
}
