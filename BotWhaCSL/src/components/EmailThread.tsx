"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Vista conversacional de los correos de un lead (canal 'api' / leads de
// correo). Los correos enviados van como globos a la derecha (con su estado
// en la cola) y los RECIBIDOS — cuando la recepción con Resend Inbound está
// configurada (guía §7) — como globos a la izquierda. Incluye redactor con
// generador de IA para responder sin salir de la conversación.

interface LeadEmail {
  key: string;
  direction: "in" | "out";
  subject: string;
  body: string;
  status: string; // out: sent | pending | sending | failed · in: received
  error: string | null;
  reply_to: string | null;
  from_name: string | null;
  from_email: string | null;
  created_at: number;
  sent_at: number | null;
}

interface ThreadData {
  emails: LeadEmail[];
  leadEmail: string | null;
  from: { name: string | null; email: string | null };
  accountReady: boolean;
  inboundReady: boolean;
  inboundAddress: string | null;
}

interface Props {
  conversationId: number;
  // Aviso al padre para refrescar la ficha (eventos/score) tras enviar.
  onSent: () => void;
}

const STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  sent: { label: "Enviado", cls: "bg-emerald-950 text-emerald-400" },
  pending: { label: "En cola", cls: "bg-amber-950 text-amber-400" },
  sending: { label: "Enviando", cls: "bg-blue-950 text-blue-400" },
  failed: { label: "Fallido", cls: "bg-red-950 text-red-400" },
};

function formatWhen(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString("es", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function EmailThread({ conversationId, onSent }: Props) {
  const [data, setData] = useState<ThreadData | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  // Generador con IA: frase de qué decir + estado de carga.
  const [genInstr, setGenInstr] = useState("");
  const [genBusy, setGenBusy] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef<string | null>(null);
  // Descarta respuestas de una conversación ya deseleccionada (polling).
  const currentIdRef = useRef(conversationId);
  currentIdRef.current = conversationId;

  const refetch = useCallback(async () => {
    const id = conversationId;
    try {
      const res = await fetch(`/api/leads/${id}/emails`, { cache: "no-store" });
      if (currentIdRef.current !== id) return;
      if (!res.ok) return;
      const payload = (await res.json()) as ThreadData;
      if (currentIdRef.current !== id) return;
      setData(payload);
    } catch {
      /* siguiente poll */
    }
  }, [conversationId]);

  useEffect(() => {
    setData(null);
    setSubject("");
    setBody("");
    setError(null);
    setOkMsg(null);
    setGenInstr("");
    lastIdRef.current = null;
    refetch();
    const timer = setInterval(refetch, 4000);
    return () => clearInterval(timer);
  }, [conversationId, refetch]);

  // Auto-scroll al fondo cuando entra un correo nuevo (enviado o recibido).
  useEffect(() => {
    const last = data?.emails[data.emails.length - 1]?.key ?? null;
    if (last !== null && last !== lastIdRef.current) {
      lastIdRef.current = last;
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [data]);

  const generate = async () => {
    setGenBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/leads-hub/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: "email",
          instruction: genInstr,
          leadId: conversationId,
          draft: { subject, body },
        }),
      });
      const payload = (await res.json().catch(() => null)) as {
        subject?: string;
        body?: string;
        error?: string;
      } | null;
      if (!res.ok || !payload?.body) {
        setError(payload?.error ?? "No se pudo generar el correo");
        return;
      }
      if (payload.subject) setSubject(payload.subject);
      setBody(payload.body);
    } catch {
      setError("Error de red al generar");
    } finally {
      setGenBusy(false);
    }
  };

  const send = async () => {
    if (!subject.trim() || !body.trim() || sending) return;
    setSending(true);
    setError(null);
    setOkMsg(null);
    try {
      const res = await fetch("/api/leads-hub/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadIds: [conversationId], subject, body }),
      });
      const payload = (await res.json().catch(() => null)) as
        | { queued?: number; error?: string }
        | null;
      if (!res.ok || !payload?.queued) {
        setError(payload?.error ?? "No se pudo enviar el correo");
        return;
      }
      setSubject("");
      setBody("");
      setGenInstr("");
      setOkMsg("✓ Correo en cola — el bot lo envía respetando tus límites");
      await refetch();
      onSent();
    } catch {
      setError("Error de red al enviar");
    } finally {
      setSending(false);
    }
  };

  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center bg-neutral-950">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-300" />
      </div>
    );
  }

  const noEmail = !data.leadEmail;
  const fromLabel = data.from.email
    ? `${data.from.name ? `${data.from.name} · ` : ""}${data.from.email}`
    : "tu cuenta de correo";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-neutral-950">
      {/* Hilo */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {data.emails.length === 0 && (
          <p className="pt-8 text-center text-sm text-neutral-500">
            {noEmail
              ? "Este lead no tiene correo. Agrégalo en la ficha para poder escribirle."
              : "Aún no le has enviado correos. Redáctale el primero abajo."}
          </p>
        )}
        {data.emails.map((e) => {
          if (e.direction === "in") {
            // Recibido: globo a la izquierda, estilo neutro (como habla el cliente).
            return (
              <div key={e.key} className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl border border-neutral-700 bg-neutral-800 px-3.5 py-2.5 shadow-sm">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="rounded bg-violet-950 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-300">
                      Recibido
                    </span>
                    <span className="truncate text-[10px] text-neutral-500">
                      {e.from_name ? `${e.from_name} · ` : ""}
                      {e.from_email}
                    </span>
                  </div>
                  <p className="text-sm font-semibold text-neutral-100">{e.subject || "(sin asunto)"}</p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-neutral-300">
                    {e.body}
                  </p>
                  <p className="mt-1.5 text-right text-[10px] text-neutral-500">
                    {formatWhen(e.created_at)}
                  </p>
                </div>
              </div>
            );
          }
          const chip = STATUS_CHIP[e.status] ?? STATUS_CHIP.pending;
          return (
            <div key={e.key} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl border border-sky-900 bg-sky-950/50 px-3.5 py-2.5 shadow-sm">
                <div className="mb-1 flex items-center gap-2">
                  <span className="rounded bg-sky-900/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300">
                    Correo
                  </span>
                  <span
                    title={e.status === "failed" && e.error ? e.error : undefined}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${chip.cls}`}
                  >
                    {chip.label}
                  </span>
                </div>
                <p className="text-sm font-semibold text-neutral-100">{e.subject || "(sin asunto)"}</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-neutral-300">
                  {e.body}
                </p>
                <p className="mt-1.5 text-right text-[10px] text-neutral-500">
                  {e.reply_to ? `responder a ${e.reply_to} · ` : ""}
                  {formatWhen(e.sent_at ?? e.created_at)}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Redactor de correo */}
      <div className="border-t border-neutral-800 bg-neutral-900 p-3">
        {!data.accountReady && (
          <p className="mb-2 rounded-lg bg-amber-950/60 p-2 text-[11px] text-amber-300">
            La cuenta de correo no está activa: configúrala en <b>Mailing</b> para que los envíos
            salgan.
          </p>
        )}
        <fieldset disabled={noEmail} className="m-0 min-w-0 border-0 p-0">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Asunto"
            className="mb-2 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-sky-600 disabled:opacity-50"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder={
              noEmail ? "Agrega un correo en la ficha para escribirle…" : "Escribe el correo…"
            }
            className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-sky-600 disabled:opacity-50"
          />
          <div className="mt-2 flex gap-2">
            <input
              value={genInstr}
              onChange={(e) => setGenInstr(e.target.value)}
              maxLength={600}
              placeholder="✨ ¿Qué quieres decirle? (la IA redacta el correo)"
              className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-sky-600 disabled:opacity-50"
            />
            <button
              onClick={generate}
              disabled={genBusy || (!genInstr.trim() && !body.trim() && !subject.trim())}
              title="La IA redacta un correo profesional con lo que escribas. Si ya hay texto, lo mejora."
              className="shrink-0 rounded-lg border border-neutral-700 px-3 py-2 text-xs font-medium text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
            >
              {genBusy ? "Generando..." : "Generar con IA"}
            </button>
            <button
              onClick={send}
              disabled={sending || !subject.trim() || !body.trim()}
              className="shrink-0 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
            >
              {sending ? "Enviando..." : "Enviar correo"}
            </button>
          </div>
        </fieldset>
        {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
        {okMsg && <p className="mt-1.5 text-xs text-emerald-400">{okMsg}</p>}
        <p className="mt-1.5 text-[10px] text-neutral-600">
          {data.inboundReady ? (
            <>
              Enviarás desde {fromLabel}. Lo que el cliente escriba a{" "}
              {data.inboundAddress ?? "tu dominio"} aparece aquí como “Recibido” (los adjuntos no
              se muestran).
            </>
          ) : (
            <>
              Enviarás desde {fromLabel}. Las respuestas del cliente aún llegan solo a tu buzón —
              activa la recepción en Mailing (guía §7) para verlas también aquí.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
