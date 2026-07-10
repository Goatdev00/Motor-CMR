"use client";

interface Props {
  // Título de la sección activa (la navegación vive en la barra lateral).
  title: string;
  connected: boolean;
  // Texto del chip: "Conectado · +57..." o "2 cuentas conectadas".
  connLabel: string;
}

// Header simple: título + estado agregado de las cuentas de WhatsApp.
// Conectar/desvincular cuentas se hace desde la pestaña Equipo.
export default function DashboardHeader({ title, connected, connLabel }: Props) {
  return (
    <header className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900 px-6 py-3">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold">{title}</h1>
        {connected ? (
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-950 px-2.5 py-1 text-xs font-medium text-emerald-400">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            {connLabel}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 rounded-full bg-neutral-800 px-2.5 py-1 text-xs font-medium text-neutral-400">
            <span className="h-2 w-2 rounded-full bg-neutral-500" />
            {connLabel}
          </span>
        )}
      </div>
    </header>
  );
}
