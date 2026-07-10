"use client";

import { useState } from "react";
import {
  DEFAULT_STAGE_CONFIG,
  STAGE_ORDER,
  type StageConfigMap,
} from "@/lib/stages";
import type { LeadStage } from "@/lib/db";

interface Props {
  config: StageConfigMap;
  onClose: () => void;
  onSaved: (config: StageConfigMap) => void;
}

// Paleta curada (equivalentes vivos de Tailwind 400): el selector es propio
// y oscuro — el picker nativo del sistema no se puede tematizar.
const PALETTE = [
  "#f87171", "#fb923c", "#fbbf24", "#facc15", "#a3e635", "#4ade80",
  "#34d399", "#2dd4bf", "#22d3ee", "#38bdf8", "#60a5fa", "#818cf8",
  "#a78bfa", "#c084fc", "#e879f9", "#f472b6", "#fb7185", "#94a3b8",
];

// Editor de las etapas del pipeline: nombre visible y color del punto.
// Las claves internas no cambian (los KPIs y el auto-avance dependen de
// ellas); solo cambia cómo se ven.
export default function StageEditor({ config, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<StageConfigMap>(() => ({ ...config }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fila con el selector de color abierto (uno a la vez).
  const [pickerFor, setPickerFor] = useState<LeadStage | null>(null);

  const setStage = (stage: LeadStage, patch: Partial<{ label: string; color: string }>) => {
    setDraft((prev) => ({ ...prev, [stage]: { ...prev[stage], ...patch } }));
  };

  const save = async () => {
    for (const stage of STAGE_ORDER) {
      if (!draft[stage].label.trim()) {
        setError("Ningún nombre puede quedar vacío");
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/stages", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stages: draft }),
      });
      const data = (await res.json().catch(() => null)) as
        | { stages?: StageConfigMap; error?: string }
        | null;
      if (!res.ok || !data?.stages) {
        setError(data?.error ?? "No se pudo guardar");
        return;
      }
      onSaved(data.stages);
    } catch {
      setError("Error de red al guardar. Reintenta.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl">
        {/* Encabezado */}
        <div className="border-b border-neutral-800 px-6 py-4">
          <h2 className="text-base font-semibold text-neutral-100">Personalizar etapas</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Cambia el nombre y el color de cada grupo. Los leads no se mueven.
          </p>
        </div>

        {/* Filas de etapas */}
        <div className="space-y-2 px-6 py-4">
          {STAGE_ORDER.map((stage) => {
            const open = pickerFor === stage;
            return (
              <div key={stage} className="relative">
                <div className="flex items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2.5 focus-within:border-neutral-600">
                  {/* Punto de color → abre la paleta */}
                  <button
                    onClick={() => setPickerFor(open ? null : stage)}
                    title="Cambiar color"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-neutral-700 transition-colors hover:border-neutral-500"
                  >
                    <span
                      className="h-3.5 w-3.5 rounded-full"
                      style={{ backgroundColor: draft[stage].color }}
                    />
                  </button>
                  <input
                    value={draft[stage].label}
                    onChange={(e) => setStage(stage, { label: e.target.value })}
                    maxLength={30}
                    placeholder={DEFAULT_STAGE_CONFIG[stage].label}
                    className="min-w-0 flex-1 bg-transparent text-sm text-neutral-100 outline-none placeholder:text-neutral-600"
                  />
                </div>

                {/* Paleta oscura */}
                {open && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setPickerFor(null)} />
                    <div className="absolute left-0 top-full z-20 mt-1.5 rounded-xl border border-neutral-700 bg-neutral-950 p-2.5 shadow-2xl">
                      <div className="grid grid-cols-6 gap-1.5">
                        {PALETTE.map((color) => (
                          <button
                            key={color}
                            onClick={() => {
                              setStage(stage, { color });
                              setPickerFor(null);
                            }}
                            title={color}
                            className={`flex h-7 w-7 items-center justify-center rounded-lg transition-transform hover:scale-110 ${
                              draft[stage].color === color
                                ? "ring-2 ring-white/80 ring-offset-2 ring-offset-neutral-950"
                                : ""
                            }`}
                            style={{ backgroundColor: color }}
                          />
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            );
          })}

          {error && <p className="rounded-lg bg-red-950 p-2 text-xs text-red-400">{error}</p>}
        </div>

        {/* Pie */}
        <div className="flex items-center justify-between border-t border-neutral-800 px-6 py-4">
          <button
            onClick={() => setDraft({ ...DEFAULT_STAGE_CONFIG })}
            className="text-xs text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline"
          >
            Restaurar predeterminados
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="rounded-lg border border-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
            >
              Cancelar
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {saving ? "Guardando..." : "Guardar"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
