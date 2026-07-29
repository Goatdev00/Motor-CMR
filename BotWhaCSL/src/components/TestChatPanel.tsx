"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_STAGE_CONFIG, STAGE_ORDER, type StageConfigMap } from "@/lib/stages";
import { CHANNEL_LABELS, type Channel } from "@/lib/channels";
import type { LeadStage } from "@/lib/db";

// Chat de prueba: el operador conversa COMO SI FUERA EL CLIENTE y el bot
// responde con el pipeline real (palabras clave → modo → derivación →
// agente de IA → LLM), anotando en cada respuesta por qué respondió así.
// Nada se envía a canales reales ni se guarda en el CRM.

const inputClass =
  "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-emerald-600 disabled:opacity-60";
const selectClass =
  "rounded-lg border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-200 outline-none focus:border-emerald-600";

const REPLY_CHANNELS: Channel[] = ["whatsapp", "whatsapp_api", "messenger", "instagram"];

interface ChatItem {
  id: number;
  kind: "client" | "bot" | "note";
  text: string;
  // Chip bajo la burbuja del bot: por qué respondió así.
  annotation?: string;
}

interface TestChatResponse {
  reply?: string | null;
  source?: "keyword" | "silent-human" | "handoff-client" | "llm";
  detail?: {
    keyword?: string;
    alsoHuman?: boolean;
    agentId?: string;
    agentName?: string;
    agentEmoji?: string;
    reason?: "tema" | "continuidad" | "flujo";
    topic?: string | null;
  } | null;
  handoffByBot?: boolean;
  stickyAgentId?: string | null;
  error?: string;
}

let nextId = 1;

export default function TestChatPanel() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<"AI" | "HUMAN">("AI");
  const [stage, setStage] = useState<LeadStage>("NUEVO");
  const [channel, setChannel] = useState<Channel>("whatsapp");
  const [stickyAgentId, setStickyAgentId] = useState<string | null>(null);
  const [stickyAgentLabel, setStickyAgentLabel] = useState<string | null>(null);
  const [stageConfig, setStageConfig] = useState<StageConfigMap>(DEFAULT_STAGE_CONFIG);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/settings/stages", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { stages?: StageConfigMap } | null) => {
        if (data?.stages) setStageConfig(data.stages);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items, sending]);

  const push = (item: Omit<ChatItem, "id">) => {
    setItems((prev) => [...prev, { ...item, id: nextId++ }]);
  };

  const reset = () => {
    setItems([]);
    setStickyAgentId(null);
    setStickyAgentLabel(null);
    setMode("AI");
    setError(null);
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    setError(null);
    push({ kind: "client", text });
    setSending(true);
    try {
      // Historial para el LLM: burbujas reales (cliente ↔ bot), sin notas.
      const history = items
        .filter((i) => i.kind !== "note")
        .map((i) => ({ role: i.kind === "client" ? "user" : "assistant", content: i.text }));

      const res = await fetch("/api/test-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, history, stage, channel, mode, stickyAgentId }),
      });
      const data = (await res.json().catch(() => null)) as TestChatResponse | null;
      if (!res.ok || !data) {
        setError(data?.error ?? "No se pudo obtener la respuesta de prueba");
        return;
      }

      if (data.source === "keyword" && data.reply) {
        push({
          kind: "bot",
          text: data.reply,
          annotation: `⚡ Palabra clave «${data.detail?.keyword ?? ""}»${
            data.detail?.alsoHuman ? " · respondió aunque el chat está en modo humano" : ""
          }`,
        });
      } else if (data.source === "silent-human") {
        push({
          kind: "note",
          text: "🔇 El bot no responde: el chat está en modo humano (y ninguna palabra clave con «también en modo humano» disparó). Un operador respondería a mano.",
        });
      } else if (data.source === "handoff-client" && data.reply) {
        push({
          kind: "bot",
          text: data.reply,
          annotation: "🤝 Detectó que el cliente pide un humano",
        });
        push({
          kind: "note",
          text: "🤝 La conversación pasaría a modo HUMANO — el bot deja de responder. (El selector de modo se cambió solo; vuélvelo a IA si quieres seguir probando.)",
        });
        setMode("HUMAN");
      } else if (data.source === "llm" && data.reply) {
        const d = data.detail;
        const annotation = d?.agentName
          ? `🤖 ${d.agentEmoji ?? ""} ${d.agentName} · ${
              d.reason === "tema"
                ? `activado por el tema «${d.topic}»`
                : d.reason === "continuidad"
                  ? "continuidad (venía atendiendo este chat)"
                  : "comodín del flujo"
            }`
          : "🧠 Personalidad base del bot (ningún agente aplicó)";
        push({ kind: "bot", text: data.reply, annotation });
        if (d?.agentName) {
          setStickyAgentLabel(`${d.agentEmoji ?? ""} ${d.agentName}`.trim());
        }
        if (data.handoffByBot) {
          push({
            kind: "note",
            text: "🤝 El bot usó la frase de derivación — la conversación pasaría a modo HUMANO.",
          });
          setMode("HUMAN");
        }
      }
      if (data.stickyAgentId !== undefined) setStickyAgentId(data.stickyAgentId ?? null);
      if (!data.stickyAgentId) setStickyAgentLabel(null);
    } catch {
      setError("Error de red — ¿el dashboard sigue corriendo?");
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      {/* Controles de simulación */}
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-4 py-2.5">
        <span className="text-xs font-medium text-neutral-400">Simular:</span>
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value as Channel)}
          className={selectClass}
        >
          {REPLY_CHANNELS.map((c) => (
            <option key={c} value={c}>
              Canal: {CHANNEL_LABELS[c]}
            </option>
          ))}
        </select>
        <select
          value={stage}
          onChange={(e) => setStage(e.target.value as LeadStage)}
          className={selectClass}
        >
          {STAGE_ORDER.map((s) => (
            <option key={s} value={s}>
              Etapa: {stageConfig[s].label}
            </option>
          ))}
        </select>
        <div className="inline-flex overflow-hidden rounded-lg border border-neutral-700 text-xs font-medium">
          {(
            [
              ["AI", "Modo IA"],
              ["HUMAN", "Modo humano"],
            ] as const
          ).map(([key, label], i) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              className={`px-3 py-1.5 transition-colors ${i > 0 ? "border-l border-neutral-700" : ""} ${
                mode === key
                  ? "bg-neutral-100 text-neutral-900"
                  : "bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {stickyAgentLabel && (
          <span className="rounded-full bg-emerald-950 px-2.5 py-1 text-[11px] font-medium text-emerald-400">
            Atiende: {stickyAgentLabel}
          </span>
        )}
        <button
          onClick={reset}
          className="ml-auto rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          ↺ Reiniciar chat
        </button>
      </div>

      {/* Hilo */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {items.length === 0 && (
          <div className="mx-auto mt-10 max-w-md rounded-xl border border-dashed border-neutral-700 p-4 text-center text-xs leading-relaxed text-neutral-500">
            <p className="text-sm font-medium text-neutral-300">
              Escribe como si fueras el cliente
            </p>
            <p className="mt-2">
              El bot responde con tu configuración real: palabras clave de Plantillas, agentes
              del Equipo de IA, detección de «quiero un humano» y la IA de siempre. Cada
              respuesta indica <b>por qué</b> respondió así.
            </p>
            <p className="mt-2 text-neutral-600">
              Nada se envía a clientes reales ni queda guardado en el CRM.
            </p>
          </div>
        )}
        {items.map((item) =>
          item.kind === "note" ? (
            <p
              key={item.id}
              className="mx-auto max-w-lg rounded-lg bg-neutral-900 px-3 py-2 text-center text-[11px] leading-relaxed text-neutral-400"
            >
              {item.text}
            </p>
          ) : (
            <div
              key={item.id}
              className={`flex ${item.kind === "client" ? "justify-end" : "justify-start"}`}
            >
              <div className="max-w-[75%]">
                <div
                  className={`whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                    item.kind === "client"
                      ? "rounded-br-sm bg-emerald-700 text-white"
                      : "rounded-bl-sm bg-neutral-800 text-neutral-100"
                  }`}
                >
                  {item.text}
                </div>
                {item.annotation && (
                  <p className="mt-1 px-1 text-[11px] text-neutral-500">{item.annotation}</p>
                )}
              </div>
            </div>
          )
        )}
        {sending && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-neutral-800 px-3.5 py-2 text-sm text-neutral-400">
              <span className="inline-flex gap-1">
                <span className="animate-bounce">·</span>
                <span className="animate-bounce [animation-delay:120ms]">·</span>
                <span className="animate-bounce [animation-delay:240ms]">·</span>
              </span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="border-t border-neutral-800 bg-neutral-900 p-3">
        {error && (
          <p className="mb-2 rounded-lg bg-red-950 p-2 text-xs text-red-400">{error}</p>
        )}
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Escribe como el cliente... (p.ej. «INFO», «¿qué precios manejan?», «quiero hablar con una persona»)"
            className={inputClass}
            disabled={sending}
          />
          <button
            onClick={send}
            disabled={sending || !draft.trim()}
            className="shrink-0 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Enviar
          </button>
        </div>
      </div>
    </main>
  );
}
