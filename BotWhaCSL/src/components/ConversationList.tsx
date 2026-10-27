"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationWithPreview } from "@/lib/db";
import {
  CHANNEL_BADGE_CLASS,
  CHANNEL_LABELS,
  conversationDisplayName,
  conversationSubtitle,
  isChannel,
} from "@/lib/channels";

// Motivos para congelar el orden de la lista: puntero encima, botón
// presionado o foco de teclado en una fila.
type HoldReason = "hover" | "press" | "keyboard";

// Respiro antes de aplicar el orden nuevo al soltar la lista: en pantallas
// táctiles el click llega DESPUÉS del pointerleave, y reordenar en ese hueco
// mandaría el click a la fila que quedó bajo el dedo. De paso, rozar el borde
// con el puntero no hace saltar la lista.
const UNFREEZE_DELAY_MS = 400;

// Tope por GET: los polls no se solapan, así que uno colgado dejaría la lista
// sin actualizar; al vencer se aborta y el próximo tick reintenta.
const POLL_TIMEOUT_MS = 15000;

function relativeTime(epochSeconds: number | null): string {
  if (!epochSeconds) return "";
  const diff = Math.floor(Date.now() / 1000) - epochSeconds;
  if (diff < 60) return "ahora";
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  return `hace ${Math.floor(diff / 86400)} d`;
}

// Pista corta del número ("··· 1234") para distinguir clientes de WhatsApp
// con el mismo nombre de perfil. Sin nombre no hace falta: el nombre visible
// ya es el número completo.
function phoneHint(c: ConversationWithPreview): string | null {
  if (!c.name || (c.channel !== "whatsapp" && c.channel !== "whatsapp_api")) return null;
  const digits = (c.phone || c.external_id || "").replace(/\D/g, "");
  return digits.length >= 4 ? `··· ${digits.slice(-4)}` : null;
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
  // Filas tal como se veían al congelar el orden (null = orden en vivo). Con
  // muchos clientes escribiendo, el poll reordenaba la lista cada 2s y una
  // fila podía moverse entre que el operador apuntaba y hacía click: se abría
  // el chat de OTRO cliente. Mientras quede un motivo activo (holdsRef) el
  // orden no cambia; el contenido de cada fila sí se refresca.
  const [frozen, setFrozen] = useState<ConversationWithPreview[] | null>(null);
  const holdsRef = useRef<Record<HoldReason, boolean>>({
    hover: false,
    press: false,
    keyboard: false,
  });
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard de secuencia: una respuesta vieja del poll nunca pisa una más nueva.
  const seqRef = useRef(0);

  useEffect(() => {
    let active = true;
    // GET en vuelo (null = ninguno): los polls no se solapan.
    let inFlight: AbortController | null = null;

    const poll = async () => {
      if (inFlight) return; // el anterior sigue en vuelo: este tick se salta
      const ctrl = new AbortController();
      inFlight = ctrl;
      const timeout = setTimeout(() => ctrl.abort(), POLL_TIMEOUT_MS);
      const seq = ++seqRef.current;
      try {
        const res = await fetch("/api/conversations", { cache: "no-store", signal: ctrl.signal });
        if (!res.ok) return;
        const data = (await res.json()) as { conversations: ConversationWithPreview[] };
        if (!active || seq !== seqRef.current) return; // respuesta obsoleta
        const list = data.conversations ?? [];
        setConversations(list);
        // Congelada sin filas en pantalla (el puntero ya estaba encima antes
        // de la primera carga): no hay nada que proteger, se fija lo que llega.
        setFrozen((prev) => (prev?.length === 0 ? list : prev));
        setLoaded(true);
      } catch {
        /* reintenta en el próximo poll (también si venció el tope) */
      } finally {
        clearTimeout(timeout);
        inFlight = null;
      }
    };

    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(timer);
      inFlight?.abort();
    };
  }, []);

  // Suelta un motivo; sin ninguno activo, el orden nuevo se aplica tras el
  // respiro (volver a la lista antes de que venza lo cancela).
  const release = useCallback((reason: HoldReason) => {
    const holds = holdsRef.current;
    if (!holds[reason]) return;
    holds[reason] = false;
    if (holds.hover || holds.press || holds.keyboard || releaseTimerRef.current) return;
    releaseTimerRef.current = setTimeout(() => {
      releaseTimerRef.current = null;
      setFrozen(null);
    }, UNFREEZE_DELAY_MS);
  }, []);

  // El botón puede soltarse fuera de la lista (arrastre): pointerup se
  // escucha en window. Al desmontar se descarta el descongelado pendiente.
  useEffect(() => {
    const onUp = () => release("press");
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    };
  }, [release]);

  // Filas en pantalla: congelada, el orden es el del momento de congelar pero
  // el contenido (preview, punto rojo, nombre) es el del último poll. Una
  // conversación borrada mientras tanto queda como fila apagada, para que las
  // de abajo no suban bajo el puntero.
  const freshById = new Map(conversations.map((c) => [c.id, c]));
  const rows = frozen ? frozen.map((c) => freshById.get(c.id) ?? c) : conversations;
  // Las conversaciones NUEVAS esperan a que se descongele (insertarlas arriba
  // empujaría todas las filas bajo el puntero); el encabezado las cuenta.
  const heldCount = frozen
    ? conversations.length - frozen.filter((c) => freshById.has(c.id)).length
    : 0;

  const hold = (reason: HoldReason) => {
    holdsRef.current[reason] = true;
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
    // Se congela lo que está en pantalla; si ya estaba congelada, sigue igual.
    setFrozen((prev) => prev ?? rows);
  };

  return (
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col border-r border-neutral-800 bg-neutral-900"
    >
      <div className="flex items-center justify-between gap-2 border-b border-neutral-800 px-4 py-3 text-sm font-semibold text-neutral-300">
        Conversaciones
        {heldCount > 0 && (
          <span
            title="Conversaciones nuevas: aparecen arriba al sacar el puntero de la lista"
            className="rounded-full bg-red-950 px-2 py-0.5 text-[10px] leading-none text-red-400"
          >
            +{heldCount} {heldCount === 1 ? "nueva" : "nuevas"}
          </span>
        )}
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        // pointerenter/over y, de respaldo, pointermove: si la lista aparece
        // bajo un puntero quieto (p.ej. al abrir un lead desde el CRM) el
        // enter no siempre llega; el primer movimiento igual congela.
        onPointerOver={() => {
          if (!holdsRef.current.hover) hold("hover");
        }}
        onPointerMove={() => {
          if (!holdsRef.current.hover) hold("hover");
        }}
        onPointerLeave={(e) => {
          // Sin botones apretados se suelta también un press "colgado"
          // (soltar la barra de scroll no siempre emite pointerup).
          if (e.buttons === 0) release("press");
          release("hover");
        }}
        onPointerDown={() => hold("press")}
        onFocus={(e) => {
          // Solo el foco de TECLADO congela: el que deja un click se queda en
          // la fila y congelaría la lista hasta hacer click en otro lado.
          let keyboard = true;
          try {
            keyboard = e.target.matches(":focus-visible");
          } catch {
            /* navegador sin :focus-visible: cualquier foco congela */
          }
          if (keyboard) hold("keyboard");
        }}
        onBlur={() => release("keyboard")}
      >
        {loaded && conversations.length === 0 && (
          <p className="p-4 text-sm text-neutral-500">
            Sin conversaciones todavía. Escríbele al número conectado desde otro
            WhatsApp para probar.
          </p>
        )}

        {rows.map((c) => {
          const gone = !freshById.has(c.id);
          const hint = phoneHint(c);
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              disabled={gone}
              title={gone ? "Conversación eliminada" : undefined}
              className={`block w-full border-b border-neutral-800 px-4 py-3 text-left transition-colors disabled:opacity-40 ${
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
                  {hint && (
                    <span
                      title={conversationSubtitle(c)}
                      className="shrink-0 text-[10px] font-normal text-neutral-500"
                    >
                      {hint}
                    </span>
                  )}
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
          );
        })}
      </div>
    </aside>
  );
}
