"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation, ConversationMode, Message } from "@/lib/db";
import {
  CHANNEL_BADGE_CLASS,
  CHANNEL_LABELS,
  conversationDisplayName,
  conversationSubtitle,
  isChannel,
} from "@/lib/channels";
import MessageBubble from "./MessageBubble";
import ModeToggle from "./ModeToggle";
import LeadPanel from "./LeadPanel";
import QuickReplies from "./QuickReplies";
import Resizer, { usePanelWidth } from "./Resizer";

interface Props {
  conversationId: number | null;
  onDeleted: () => void;
}

interface PanelData {
  conversation: Conversation;
  messages: Message[];
}

export default function ConversationPanel({ conversationId, onDeleted }: Props) {
  const [data, setData] = useState<PanelData | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showLead, setShowLead] = useState(true);
  // Ancho de la ficha del lead (columna redimensionable, persistido).
  const ficha = usePanelWidth("agente-w-ficha", 320, 260, 640);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastMessageIdRef = useRef<number | null>(null);

  // Guards contra respuestas obsoletas del polling:
  // - currentIdRef: descarta la respuesta de una conversación ya deseleccionada
  //   (sin esto, un fetch lento de A podía pisar los datos de B recién abierta,
  //   o un 404 viejo deseleccionaba la conversación nueva).
  // - seqRef: descarta GETs que resuelven fuera de orden; las mutaciones lo
  //   incrementan para invalidar los GETs en vuelo previos al cambio.
  const currentIdRef = useRef(conversationId);
  currentIdRef.current = conversationId;
  const seqRef = useRef(0);

  // onDeleted vive en un ref para que su identidad (que cambia con cada
  // render del padre) no recree refetch ni reinicie el efecto de polling.
  const onDeletedRef = useRef(onDeleted);
  useEffect(() => {
    onDeletedRef.current = onDeleted;
  }, [onDeleted]);

  const refetch = useCallback(async () => {
    const id = conversationId;
    if (!id) return;
    const seq = ++seqRef.current;
    try {
      const res = await fetch(`/api/messages/${id}`, { cache: "no-store" });
      if (currentIdRef.current !== id || seq !== seqRef.current) return; // obsoleta
      if (res.status === 404) {
        // La conversación fue borrada (quizás desde otra pestaña).
        onDeletedRef.current();
        return;
      }
      if (!res.ok) return;
      const payload = (await res.json()) as PanelData;
      if (currentIdRef.current !== id || seq !== seqRef.current) return;
      setData(payload);
    } catch {
      /* reintenta en el próximo poll */
    }
  }, [conversationId]);

  // Poll de mensajes cada 2s; se reinicia SOLO al cambiar de conversación.
  useEffect(() => {
    setData(null);
    setInput("");
    setSendError(null);
    setConfirmingDelete(false);
    lastMessageIdRef.current = null;
    if (!conversationId) return;

    refetch();
    const timer = setInterval(refetch, 2000);
    return () => clearInterval(timer);
  }, [conversationId, refetch]);

  // Auto-scroll al fondo solo cuando entra un mensaje nuevo.
  useEffect(() => {
    const last = data?.messages[data.messages.length - 1]?.id ?? null;
    if (last !== null && last !== lastMessageIdRef.current) {
      lastMessageIdRef.current = last;
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [data]);

  const changeMode = async (mode: ConversationMode) => {
    if (!conversationId || !data) return;
    // Optimista: refleja el cambio de inmediato; el refetch del finally
    // confirma con la verdad del servidor (o revierte si el POST falló).
    setData({ ...data, conversation: { ...data.conversation, mode } });
    seqRef.current++; // invalida GETs en vuelo con el modo anterior
    try {
      const res = await fetch(`/api/mode/${conversationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) console.error("No se pudo cambiar el modo:", res.status);
    } catch (err) {
      console.error("No se pudo cambiar el modo:", err);
    } finally {
      refetch();
    }
  };

  const sendHuman = async () => {
    const content = input.trim();
    if (!conversationId || !content || sending) return;
    setSending(true);
    setSendError(null);
    try {
      seqRef.current++; // invalida GETs en vuelo previos al envío
      const res = await fetch(`/api/messages/${conversationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        setInput("");
        await refetch();
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setSendError(body?.error ?? "No se pudo enviar el mensaje. Reintenta.");
      }
    } catch {
      setSendError("Error de red al enviar. Reintenta.");
    } finally {
      setSending(false);
    }
  };

  const deleteConversation = async () => {
    if (!conversationId || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}`, {
        method: "DELETE",
      });
      if (res.ok) onDeletedRef.current();
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  if (!conversationId) {
    return (
      <section className="flex flex-1 items-center justify-center bg-neutral-950">
        <p className="text-sm text-neutral-500">
          Selecciona una conversación para ver los mensajes
        </p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="flex flex-1 items-center justify-center bg-neutral-950">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-300" />
      </section>
    );
  }

  const { conversation, messages } = data;
  const isHuman = conversation.mode === "HUMAN";

  return (
    <div className="flex min-w-0 flex-1">
      {/* min-w: con lista (320px) + ficha (320px) abiertas, el chat no debe
          colapsar a 0 en ventanas angostas; el contenedor padre hace scroll. */}
      <section className="flex min-w-[22rem] flex-1 flex-col bg-neutral-950">
      {/* Barra superior: contacto + toggle + ficha + borrar */}
      <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900 px-4 py-2.5">
        <div className="min-w-0">
          <p className="flex items-center gap-2 truncate text-sm font-semibold text-neutral-100">
            {conversationDisplayName(conversation)}
            {isChannel(conversation.channel) && (
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${CHANNEL_BADGE_CLASS[conversation.channel]}`}
              >
                {CHANNEL_LABELS[conversation.channel]}
              </span>
            )}
            {typeof conversation.lead_score === "number" && (
              <span
                title="Score de intención de compra (IA)"
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  conversation.lead_score >= 70
                    ? "bg-emerald-950 text-emerald-400"
                    : conversation.lead_score >= 40
                      ? "bg-amber-950 text-amber-400"
                      : "bg-neutral-800 text-neutral-400"
                }`}
              >
                IA {conversation.lead_score}
              </span>
            )}
          </p>
          <p className="text-xs text-neutral-500">{conversationSubtitle(conversation)}</p>
        </div>
        <div className="flex items-center gap-3">
          <ModeToggle mode={conversation.mode} onChange={changeMode} />
          <button
            onClick={() => setShowLead(!showLead)}
            className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
              showLead
                ? "border-emerald-800 bg-emerald-950 text-emerald-400"
                : "border-neutral-700 text-neutral-300 hover:bg-neutral-800"
            }`}
          >
            Ficha
          </button>
          <button
            onClick={() => setConfirmingDelete(true)}
            className="rounded-lg border border-red-900 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950"
          >
            Borrar
          </button>
        </div>
      </div>

      {/* Mensajes */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="pt-8 text-center text-sm text-neutral-500">Sin mensajes</p>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </div>

      {/* Composer */}
      <div className="border-t border-neutral-800 bg-neutral-900 p-3">
        {isHuman ? (
          <>
            <div className="flex gap-2">
              <QuickReplies
                onInsert={(content) => setInput((prev) => (prev ? `${prev} ${content}` : content))}
              />
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendHuman();
                  }
                }}
                placeholder="Escribe como humano..."
                className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-amber-500 focus:ring-2 focus:ring-amber-950"
              />
              <button
                onClick={sendHuman}
                disabled={sending || !input.trim()}
                className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
              >
                {sending ? "Enviando..." : "Enviar"}
              </button>
            </div>
            {sendError && <p className="mt-1.5 text-xs text-red-400">{sendError}</p>}
          </>
        ) : (
          <input
            disabled
            placeholder="El bot responde automáticamente — cambia a modo Humano para escribir"
            className="w-full cursor-not-allowed rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-500 placeholder:text-neutral-500"
          />
        )}
      </div>

      {/* Diálogo de confirmación de borrado */}
      {confirmingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-lg">
            <h2 className="text-base font-semibold text-neutral-100">
              Borrar conversación
            </h2>
            <p className="mt-2 text-sm text-neutral-300">
              Se eliminarán todos los mensajes de{" "}
              <strong>{conversationDisplayName(conversation)}</strong> del dashboard.
              Esta acción no se puede deshacer (no afecta al chat del cliente).
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
                className="rounded-lg border border-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
              >
                Cancelar
              </button>
              <button
                onClick={deleteConversation}
                disabled={deleting}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? "Borrando..." : "Sí, borrar"}
              </button>
            </div>
          </div>
        </div>
      )}
      </section>

      {/* Ficha CRM del lead (con divisor para ajustar su ancho: la ficha
          está a la DERECHA, así que arrastrar a la izquierda la agranda) */}
      {showLead && (
        <>
          <Resizer onDelta={(dx) => ficha.adjust(-dx)} onReset={ficha.reset} />
          <LeadPanel lead={conversation} onLeadChanged={refetch} width={ficha.width} />
        </>
      )}
    </div>
  );
}
