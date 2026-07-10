"use client";

import { useEffect, useState } from "react";
import type { ConversationWithPreview } from "@/lib/db";
import {
  CHANNEL_BADGE_CLASS,
  CHANNEL_LABELS,
  conversationDisplayName,
  isChannel,
} from "@/lib/channels";

function relativeTime(epochSeconds: number | null): string {
  if (!epochSeconds) return "";
  const diff = Math.floor(Date.now() / 1000) - epochSeconds;
  if (diff < 60) return "ahora";
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  return `hace ${Math.floor(diff / 86400)} d`;
}

interface Props {
  selectedId: number | null;
  onSelect: (id: number) => void;
  // Ancho en px (columna redimensionable desde el divisor).
  width?: number;
}

export default function ConversationList({ selectedId, onSelect, width = 320 }: Props) {
  const [conversations, setConversations] = useState<ConversationWithPreview[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const res = await fetch("/api/conversations", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { conversations: ConversationWithPreview[] };
        if (active) {
          setConversations(data.conversations ?? []);
          setLoaded(true);
        }
      } catch {
        /* reintenta en el próximo poll */
      }
    };

    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col border-r border-neutral-800 bg-neutral-900"
    >
      <div className="border-b border-neutral-800 px-4 py-3 text-sm font-semibold text-neutral-300">
        Conversaciones
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loaded && conversations.length === 0 && (
          <p className="p-4 text-sm text-neutral-500">
            Sin conversaciones todavía. Escríbele al número conectado desde otro
            WhatsApp para probar.
          </p>
        )}

        {conversations.map((c) => (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            className={`block w-full border-b border-neutral-800 px-4 py-3 text-left transition-colors ${
              selectedId === c.id ? "bg-neutral-800" : "hover:bg-neutral-800/60"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-neutral-100">
                {/* Punto rojo: el último mensaje es del cliente y espera respuesta */}
                {(c.last_message_role != null
                  ? c.last_message_role === "user"
                  : c.last_user_message_at !== null &&
                    c.last_user_message_at === c.last_message_at) && (
                  <span
                    title="Esperando tu respuesta"
                    className="h-2 w-2 shrink-0 rounded-full bg-red-400"
                  />
                )}
                <span className="truncate">{conversationDisplayName(c)}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {c.assigned_member_name && (
                  <span
                    title={`Asignado a ${c.assigned_member_name}`}
                    className="max-w-20 truncate rounded-full bg-neutral-800 px-1.5 py-0.5 text-[9px] font-medium text-neutral-400"
                  >
                    {c.assigned_member_name}
                  </span>
                )}
                {isChannel(c.channel) && c.channel !== "whatsapp" && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${CHANNEL_BADGE_CLASS[c.channel]}`}
                  >
                    {CHANNEL_LABELS[c.channel]}
                  </span>
                )}
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    c.mode === "AI"
                      ? "bg-emerald-950 text-emerald-400"
                      : "bg-amber-950 text-amber-400"
                  }`}
                >
                  {c.mode === "AI" ? "IA" : "HUMANO"}
                </span>
              </span>
            </div>
            <div className="mt-0.5 flex items-center justify-between gap-2">
              <span className="truncate text-xs text-neutral-400">
                {c.last_message_preview ?? "Sin mensajes"}
              </span>
              <span className="shrink-0 text-[10px] text-neutral-500">
                {relativeTime(c.last_message_at)}
              </span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}
