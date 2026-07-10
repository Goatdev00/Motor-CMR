"use client";

import type { ConversationMode } from "@/lib/db";

interface Props {
  mode: ConversationMode;
  onChange: (mode: ConversationMode) => void;
  disabled?: boolean;
}

export default function ModeToggle({ mode, onChange, disabled }: Props) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-neutral-700 text-sm font-medium">
      <button
        onClick={() => mode !== "AI" && onChange("AI")}
        disabled={disabled}
        className={`px-3 py-1.5 transition-colors disabled:opacity-50 ${
          mode === "AI"
            ? "bg-emerald-500 text-white"
            : "bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
        }`}
      >
        IA
      </button>
      <button
        onClick={() => mode !== "HUMAN" && onChange("HUMAN")}
        disabled={disabled}
        className={`border-l border-neutral-700 px-3 py-1.5 transition-colors disabled:opacity-50 ${
          mode === "HUMAN"
            ? "bg-amber-500 text-white"
            : "bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
        }`}
      >
        Humano
      </button>
    </div>
  );
}
