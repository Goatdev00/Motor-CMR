"use client";

import type { Message } from "@/lib/db";

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString("es", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// user: izquierda, blanco con borde. assistant: derecha, verde.
// human (operador desde el dashboard): derecha, ámbar.
export default function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";

  const bubbleClass = isUser
    ? "bg-neutral-800 border border-neutral-700 text-neutral-100"
    : message.role === "assistant"
      ? "bg-emerald-600 text-white"
      : "bg-amber-500 text-white";

  const timeClass = isUser ? "text-neutral-400" : "text-white/70";

  return (
    <div className={`flex ${isUser ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[70%] rounded-2xl px-3.5 py-2 shadow-sm ${bubbleClass}`}>
        {message.role === "human" && (
          <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/80">
            Humano
          </p>
        )}
        <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
        <p className={`mt-1 text-right text-[10px] ${timeClass}`}>
          {formatTime(message.created_at)}
        </p>
      </div>
    </div>
  );
}
