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

// Teléfono enmascarado para la línea "Respondiendo a" (+57 ··· 4567): con el
// indicativo y los últimos 4 dígitos se distinguen homónimos de un vistazo.
// Indicativo según las zonas E.164: +1 y +7 de un dígito, los bloques de tres
// (+593, +507…) y el resto de dos. Null si no parece un teléfono.
function maskPhone(raw: string | null): string | null {
  const digits = raw?.replace(/^\+/, "") ?? "";
  if (!/^\d{7,15}$/.test(digits)) return null;
  const cc =
    digits.match(/^(?:[17]|2[1-69]\d|3[578]\d|42\d|5[09]\d|6[7-9]\d|8[0578]\d|9[679]\d)/)?.[0] ??
    digits.slice(0, 2);
  return `+${cc} ··· ${digits.slice(-4)}`;
}

// Envíos que fallaron: al volver a esa conversación (desde otro chat u otra
// vista) el composer recupera el texto y muestra el error. A nivel de
// módulo: sobrevive a que el panel se desmonte al cambiar de vista. Se
// borra recién cuando el operador edita o envía (leerlo no lo consume: en
// desarrollo React monta los efectos dos veces) o cuando el mensaje aparece
// en el hilo — el servidor lo guardó aunque la respuesta se perdiera, y
// reintentarlo lo mandaría dos veces. afterId: último mensaje del hilo al
// enviar (solo cuenta un mensaje igual POSTERIOR a ese).
const unsentDrafts = new Map<number, { text: string; error: string; afterId: number }>();
// Envíos en vuelo y quién avisar cuando terminan, también a nivel de módulo:
// si el operador sale a otra vista y vuelve mientras el envío sigue en
// curso, el panel nuevo mantiene bloqueado el composer (no se manda dos
// veces) y muestra el error si el envío falla.
const sendsInFlight = new Set<number>();
const sendListeners = new Set<(conversationId: number) => void>();

export default function ConversationPanel({ conversationId, onDeleted }: Props) {
  const [data, setData] = useState<PanelData | null>(null);
  const [input, setInput] = useState("");
  // Conversación con un envío en vuelo (no un booleano del panel: el envío
  // lento de A no debe bloquear el composer de B al cambiar de chat).
  const [sendingFor, setSendingFor] = useState<number | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [, refreshSending] = useState(0);
  // Fallo del último cambio de modo IA/Humano (el toggle ya se revirtió).
  const [modeError, setModeError] = useState<string | null>(null);
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
  // - seqRef numera cada GET: se aplica solo si es más nuevo que el último
  //   APLICADO (appliedSeqRef) y posterior a la última mutación
  //   (invalidSeqRef: envío o cambio de modo invalidan los GETs ya emitidos).
  //   Antes ganaba solo el último EMITIDO: con GETs de más de 2s cada poll
  //   descartaba al anterior y el chat se quedaba congelado.
  // - inflightRef: GETs en vuelo, abortados al cambiar de chat o desmontar.
  const currentIdRef = useRef(conversationId);
  currentIdRef.current = conversationId;
  const seqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const invalidSeqRef = useRef(0);
  const inflightRef = useRef(new Set<AbortController>());

  // onDeleted vive en un ref para que su identidad (que cambia con cada
  // render del padre) no recree refetch ni reinicie el efecto de polling.
  const onDeletedRef = useRef(onDeleted);
  useEffect(() => {
    onDeletedRef.current = onDeleted;
  }, [onDeleted]);

  const refetch = useCallback(async () => {
    const id = conversationId;
    if (!id || currentIdRef.current !== id) return;
    const seq = ++seqRef.current;
    const ctrl = new AbortController();
    inflightRef.current.add(ctrl);
    // Un GET colgado no puede frenar el polling (el siguiente poll espera a
    // que este termine): a los 15s se aborta.
    const timeout = setTimeout(() => ctrl.abort(), 15000);
    // Vigente: no abortado, de la conversación abierta, más nuevo que lo ya
    // aplicado y emitido después de la última mutación.
    const fresh = () =>
      !ctrl.signal.aborted &&
      currentIdRef.current === id &&
      seq > appliedSeqRef.current &&
      seq > invalidSeqRef.current;
    try {
      const res = await fetch(`/api/messages/${id}`, { cache: "no-store", signal: ctrl.signal });
      if (!fresh()) return; // obsoleta
      if (res.status === 404) {
        // La conversación fue borrada (quizás desde otra pestaña).
        onDeletedRef.current();
        return;
      }
      if (!res.ok) return;
      const payload = (await res.json()) as PanelData;
      if (!fresh()) return;
      appliedSeqRef.current = seq;
      setData(payload);
    } catch {
      /* abortado o error de red: reintenta en el próximo poll */
    } finally {
      clearTimeout(timeout);
      inflightRef.current.delete(ctrl);
    }
  }, [conversationId]);

  // Poll de mensajes cada 2s; se reinicia SOLO al cambiar de conversación.
  useEffect(() => {
    setData(null);
    setInput("");
    setSendError(null);
    setModeError(null);
    setConfirmingDelete(false);
    lastMessageIdRef.current = null;
    if (!conversationId) return;

    // Un envío a este chat que falló con el operador en otro: se le devuelve
    // el texto con el error en vez de perderlo en silencio.
    const draft = unsentDrafts.get(conversationId);
    if (draft) {
      setInput(draft.text);
      setSendError(draft.error);
    }

    // Los polls nunca se solapan: el siguiente se agenda 2s DESPUÉS de que
    // termine el anterior (con setInterval, si el GET tardaba más de 2s, cada
    // uno invalidaba al previo y no se aplicaba ninguno).
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refetch();
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      inflightRef.current.forEach((ctrl) => ctrl.abort());
    };
  }, [conversationId, refetch]);

  // Auto-scroll al fondo solo cuando entra un mensaje nuevo.
  useEffect(() => {
    const last = data?.messages[data.messages.length - 1]?.id ?? null;
    if (last !== null && last !== lastMessageIdRef.current) {
      lastMessageIdRef.current = last;
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [data]);

  // Un envío "fallido" que en realidad el servidor guardó (se cortó la
  // respuesta): al aparecer en el hilo se retiran el error y el texto.
  useEffect(() => {
    if (!data) return;
    const id = data.conversation.id;
    const draft = unsentDrafts.get(id);
    if (!draft) return;
    const content = draft.text.trim();
    const landed = data.messages.some((m) => m.id > draft.afterId && m.role === "human" && m.content.trim() === content);
    if (!landed) return;
    unsentDrafts.delete(id);
    if (currentIdRef.current !== id) return;
    setSendError(null);
    setInput((prev) => (prev.trim() === content ? "" : prev));
  }, [data]);

  // Al terminar un envío de ESTE chat (aunque lo haya empezado otro panel
  // antes de cambiar de vista): se actualiza el "Enviando..." y, si falló,
  // se muestra el error con el texto.
  useEffect(() => {
    const onSettled = (id: number) => {
      if (currentIdRef.current !== id) return;
      refreshSending((n) => n + 1);
      const draft = unsentDrafts.get(id);
      if (draft) {
        setSendError(draft.error);
        setInput((prev) => (prev.trim() ? prev : draft.text));
      }
    };
    sendListeners.add(onSettled);
    return () => {
      sendListeners.delete(onSettled);
    };
  }, []);

  // El operador edita: el borrador guardado ya no aplica.
  const editInput = (update: (prev: string) => string) => {
    if (conversationId) unsentDrafts.delete(conversationId);
    setInput(update);
  };

  const changeMode = async (mode: ConversationMode) => {
    const id = conversationId;
    if (!id || !data) return;
    const previous = data.conversation.mode;
    // Optimista: refleja el cambio de inmediato. Si el POST falla se revierte
    // al momento y se avisa junto al toggle (antes solo iba a la consola y la
    // pantalla podía decir "Humano" con la IA todavía respondiendo).
    setData({ ...data, conversation: { ...data.conversation, mode } });
    setModeError(null);
    invalidSeqRef.current = seqRef.current; // invalida GETs en vuelo con el modo anterior
    let ok = false;
    try {
      const res = await fetch(`/api/mode/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      ok = res.ok;
      if (!res.ok) console.error("No se pudo cambiar el modo:", res.status);
    } catch (err) {
      console.error("No se pudo cambiar el modo:", err);
    }
    if (currentIdRef.current !== id) return; // el operador ya está en otro chat
    if (ok) {
      setModeError(null);
    } else {
      // Solo si el toggle sigue mostrando el modo optimista de este chat.
      setData((prev) =>
        prev && prev.conversation.id === id && prev.conversation.mode === mode
          ? { ...prev, conversation: { ...prev.conversation, mode: previous } }
          : prev
      );
      setModeError("No se pudo cambiar el modo. Reintenta.");
    }
    // Los GETs emitidos durante el POST pudieron leer el modo anterior: se
    // descartan y el refetch confirma con la verdad del servidor.
    invalidSeqRef.current = seqRef.current;
    refetch();
  };

  const sendHuman = async () => {
    // Conversación y texto se fijan AL ENVIAR: si el operador cambia de chat
    // con el POST en vuelo, el resultado nunca toca el composer de otro chat.
    const id = conversationId;
    const text = input;
    const content = text.trim();
    if (!id || !content || sendingFor === id || sendsInFlight.has(id)) return;
    setSendingFor(id);
    setSendError(null);
    unsentDrafts.delete(id);
    const afterId = data?.conversation.id === id ? (data.messages[data.messages.length - 1]?.id ?? 0) : 0;
    // Fallo: queda guardado y, al terminar el envío, lo muestra el panel que
    // esté abierto en ESTE chat (este mismo, o uno nuevo si el operador salió
    // a otra vista y volvió); si está en otro chat, al volver.
    const fail = (error: string) => {
      unsentDrafts.set(id, { text, error, afterId });
    };
    sendsInFlight.add(id);
    try {
      invalidSeqRef.current = seqRef.current; // invalida GETs en vuelo previos al envío
      const res = await fetch(`/api/messages/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        if (currentIdRef.current === id) {
          // Se quita SOLO lo enviado: lo que el operador escribió mientras se
          // enviaba se conserva (y lo ya enviado no queda para mandarse dos
          // veces con el próximo Enter).
          setInput((prev) =>
            prev.trim() === content ? "" : prev.startsWith(text) ? prev.slice(text.length).trimStart() : prev
          );
          await refetch();
        }
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        fail(body?.error ?? "No se pudo enviar el mensaje. Reintenta.");
      }
    } catch {
      fail("Error de red al enviar. Reintenta.");
    } finally {
      sendsInFlight.delete(id);
      // Libera solo su conversación: otro chat pudo empezar su propio envío.
      setSendingFor((prev) => (prev === id ? null : prev));
      sendListeners.forEach((notify) => notify(id));
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

  // En el render del cambio de chat, data aún es la del anterior (el efecto
  // la limpia después): nunca se pinta un chat bajo la selección de otro.
  if (!data || data.conversation.id !== conversationId) {
    return (
      <section className="flex flex-1 items-center justify-center bg-neutral-950">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-300" />
      </section>
    );
  }

  const { conversation, messages } = data;
  const isHuman = conversation.mode === "HUMAN";
  const sending = sendingFor === conversationId || (conversationId !== null && sendsInFlight.has(conversationId));
  // Destinatario junto al composer: nombre + teléfono enmascarado (sin
  // nombre, el nombre visible ya es el teléfono completo).
  const recipientPhone = conversation.name
    ? maskPhone(conversation.phone ?? conversation.external_id)
    : null;

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
                title="Score de intención de compra (IA o manual)"
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  conversation.lead_score >= 70
                    ? "bg-emerald-950 text-emerald-400"
                    : conversation.lead_score >= 40
                      ? "bg-amber-950 text-amber-400"
                      : "bg-neutral-800 text-neutral-400"
                }`}
              >
                Score {conversation.lead_score}
              </span>
            )}
          </p>
          <p className="text-xs text-neutral-500">{conversationSubtitle(conversation)}</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Los leads del canal 'api' no tienen canal de salida: el toggle
              IA/Humano no aplica (nadie puede responderles desde aquí). */}
          {conversation.channel !== "api" && (
            <>
              {modeError && (
                <p className="max-w-44 text-right text-xs leading-tight text-red-400">
                  {modeError}
                </p>
              )}
              <ModeToggle mode={conversation.mode} onChange={changeMode} />
            </>
          )}
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
        {conversation.channel === "api" ? (
          // Lead inyectado por la API pública, sin teléfono: no hay por dónde
          // responderle. El chat queda de solo lectura.
          <input
            disabled
            placeholder="Lead de la API sin canal de respuesta — gestiónalo desde la ficha CRM"
            className="w-full cursor-not-allowed rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-500 placeholder:text-neutral-500"
          />
        ) : isHuman ? (
          <>
            {/* Destinatario siempre a la vista: con muchos chats a la vez, el
                operador confirma a quién le escribe antes de enviar. */}
            <p className="mb-2 truncate text-xs text-neutral-500">
              Respondiendo a{" "}
              <span className="font-medium text-neutral-200">
                {conversationDisplayName(conversation)}
              </span>
              {recipientPhone && ` · ${recipientPhone}`}
            </p>
            <div className="flex gap-2">
              <QuickReplies
                onInsert={(content) => editInput((prev) => (prev ? `${prev} ${content}` : content))}
              />
              <input
                value={input}
                onChange={(e) => {
                  const value = e.target.value;
                  editInput(() => value);
                }}
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
