"use client";

import { useState } from "react";

// Sección Configuración (tuerca sobre el perfil): recursos y documentación
// del sistema. Hoy: la guía de conexión de canales (se abre embebida o en
// pestaña nueva para compartirla con clientes). Los recursos futuros se
// agregan a RESOURCES y aparecen como tarjetas.

interface Resource {
  key: string;
  title: string;
  description: string;
  // Ruta pública servida por Next (archivo en /public).
  href: string;
}

const RESOURCES: Resource[] = [
  {
    key: "guia-canales",
    title: "Guía de conexión de canales",
    description:
      "Paso a paso para conectar WhatsApp (QR y API oficial), Facebook Messenger, Instagram, el correo SMTP y la API del CRM. Lista para compartir con clientes.",
    href: "/guia-conexion-canales.html",
  },
];

export default function SettingsPanel() {
  const [viewing, setViewing] = useState<Resource | null>(null);

  if (viewing) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-neutral-800 bg-neutral-900 px-4 py-2">
          <button
            onClick={() => setViewing(null)}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
          >
            ← Volver
          </button>
          <p className="min-w-0 truncate text-sm font-medium text-neutral-200">{viewing.title}</p>
          <div className="ml-auto flex items-center gap-2">
            <a
              href={viewing.href}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
            >
              Abrir en pestaña nueva
            </a>
            <a
              href={viewing.href}
              download
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
            >
              Descargar
            </a>
          </div>
        </div>
        <iframe
          src={viewing.href}
          title={viewing.title}
          className="min-h-0 w-full flex-1 border-0 bg-[#0a0a0a]"
        />
      </main>
    );
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-sm font-semibold text-neutral-100">Recursos y documentación</h2>
        <p className="mt-1 text-xs text-neutral-400">
          Guías y material del sistema. Puedes verlos aquí mismo, abrirlos en una pestaña o
          descargarlos para enviárselos a un cliente.
        </p>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {RESOURCES.map((r) => (
            <div key={r.key} className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-950 text-emerald-400">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-5 w-5"
                  >
                    <path d="M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
                    <path d="M14 3v5h5" />
                    <path d="M9 13h6" />
                    <path d="M9 16.5h4" />
                  </svg>
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-neutral-100">{r.title}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-neutral-400">{r.description}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => setViewing(r)}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
                >
                  Ver aquí
                </button>
                <a
                  href={r.href}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
                >
                  Pestaña nueva
                </a>
                <a
                  href={r.href}
                  download
                  className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
                >
                  Descargar
                </a>
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
