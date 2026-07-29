// Personalización de las etapas del pipeline (client-safe, sin deps de
// servidor). Las CLAVES de etapa son fijas — la lógica del CRM depende de
// ellas (tasa de cierre usa GANADO/PERDIDO, el auto-avance usa NUEVO) —
// pero el nombre visible y el color del punto se personalizan desde el
// dashboard y se guardan en app_settings ('stages').
import type { LeadStage } from "./db";

export interface StageStyle {
  label: string;
  color: string; // hex #rrggbb
}

export type StageConfigMap = Record<LeadStage, StageStyle>;

export const STAGE_ORDER: LeadStage[] = [
  "NUEVO",
  "CONTACTADO",
  "CALIFICADO",
  "PROPUESTA",
  "GANADO",
  "PERDIDO",
];

export const DEFAULT_STAGE_CONFIG: StageConfigMap = {
  NUEVO: { label: "Nuevo", color: "#38bdf8" },
  CONTACTADO: { label: "Contactado", color: "#818cf8" },
  CALIFICADO: { label: "Calificado", color: "#a78bfa" },
  PROPUESTA: { label: "Propuesta", color: "#fbbf24" },
  GANADO: { label: "Ganado", color: "#34d399" },
  PERDIDO: { label: "Perdido", color: "#f87171" },
};

// Config guardada (parcial/vieja) → mapa completo con defaults de respaldo.
export function mergeStageConfig(partial: unknown): StageConfigMap {
  const merged: StageConfigMap = { ...DEFAULT_STAGE_CONFIG };
  if (partial && typeof partial === "object") {
    for (const stage of STAGE_ORDER) {
      const entry = (partial as Record<string, { label?: unknown; color?: unknown }>)[stage];
      if (!entry || typeof entry !== "object") continue;
      const label =
        typeof entry.label === "string" && entry.label.trim() !== ""
          ? entry.label.trim().slice(0, 30)
          : merged[stage].label;
      const color =
        typeof entry.color === "string" && /^#[0-9a-fA-F]{6}$/.test(entry.color)
          ? entry.color
          : merged[stage].color;
      merged[stage] = { label, color };
    }
  }
  return merged;
}
