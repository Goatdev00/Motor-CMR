"use client";

import { useState } from "react";
import type { SessionUser } from "./LoginScreen";

// Barra lateral de navegación: reemplaza las pestañas que vivían en el
// header. Plegable a solo iconos; el estado se recuerda en localStorage.
// Abajo a la izquierda vive la sección de cuenta (usuario, rol, salir).

export type DashboardView =
  | "chats"
  | "crm"
  | "mailing"
  | "calendar"
  | "alarms"
  | "team"
  | "channels";

const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Admin",
  SUPERVISOR: "Supervisor",
  VENDEDOR: "Vendedor",
};

interface Props {
  view: DashboardView;
  onViewChange: (view: DashboardView) => void;
  collapsed: boolean;
  onToggle: () => void;
  user: SessionUser;
  onLogout: () => void;
  onChangePassword: () => void;
  // Ancho en px cuando está expandida (columna redimensionable desde el
  // divisor); plegada siempre mide w-14.
  width?: number;
  // true mientras se arrastra el divisor: pausa la transición de ancho para
  // que la columna siga al cursor sin lag.
  resizing?: boolean;
}

// Iconos propios (trazo simple, estilo minimalista) para no sumar deps.
function Icon({ path, extra }: { path: string; extra?: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0"
    >
      <path d={path} />
      {extra}
    </svg>
  );
}

const ITEMS: { key: DashboardView; label: string; icon: React.ReactNode }[] = [
  {
    key: "chats",
    label: "Chats",
    icon: <Icon path="M21 11.5a8.38 8.38 0 0 1-9 8.4 8.5 8.5 0 0 1-3.4-.7L3 21l1.8-4.6a8.38 8.38 0 0 1-1.3-4.9 8.5 8.5 0 0 1 8.5-8.5 8.38 8.38 0 0 1 9 8.5z" />,
  },
  {
    key: "crm",
    label: "CRM",
    icon: (
      <Icon
        path="M4 4h4v16H4z"
        extra={
          <>
            <path d="M10 4h4v10h-4z" />
            <path d="M16 4h4v7h-4z" />
          </>
        }
      />
    ),
  },
  {
    key: "mailing",
    label: "Mailing",
    icon: (
      <Icon
        path="M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"
        extra={<path d="m3 7 9 6 9-6" />}
      />
    ),
  },
  {
    key: "calendar",
    label: "Calendario",
    icon: (
      <Icon
        path="M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"
        extra={
          <>
            <path d="M4 10h16" />
            <path d="M8 3v4" />
            <path d="M16 3v4" />
          </>
        }
      />
    ),
  },
  {
    key: "alarms",
    label: "Alarmas",
    icon: (
      <Icon
        path="M12 5a5.5 5.5 0 0 1 5.5 5.5c0 3 .8 4.8 1.6 5.9.4.6 0 1.6-.8 1.6H5.7c-.8 0-1.2-1-.8-1.6.8-1.1 1.6-2.9 1.6-5.9A5.5 5.5 0 0 1 12 5z"
        extra={
          <>
            <path d="M12 5V3.5" />
            <path d="M10 20.5a2 2 0 0 0 4 0" />
          </>
        }
      />
    ),
  },
  {
    key: "team",
    label: "Equipo",
    icon: (
      <Icon
        path="M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11z"
        extra={
          <>
            <path d="M3.5 19.5c0-3 2.5-4.8 5.5-4.8s5.5 1.8 5.5 4.8" />
            <path d="M15.5 10.6a2.8 2.8 0 1 0-1.2-5.4" />
            <path d="M16.5 14.9c2.3.3 4 1.9 4 4.1" />
          </>
        }
      />
    ),
  },
  {
    key: "channels",
    label: "Canales",
    icon: (
      <Icon
        path="M4 8h10"
        extra={
          <>
            <circle cx="17" cy="8" r="2.2" />
            <path d="M20 16H10" />
            <circle cx="7" cy="16" r="2.2" />
          </>
        }
      />
    ),
  },
];

export default function Sidebar({
  view,
  onViewChange,
  collapsed,
  onToggle,
  user,
  onLogout,
  onChangePassword,
  width = 208,
  resizing = false,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const initial = (user.name.trim()[0] ?? "?").toUpperCase();

  return (
    <aside
      style={collapsed ? undefined : { width }}
      className={`flex shrink-0 flex-col border-r border-neutral-800 bg-neutral-900 ${
        resizing ? "" : "transition-[width] duration-200"
      } ${collapsed ? "w-14" : ""}`}
    >
      {/* Marca (tipografía del logo: bold geométrica + tramos en itálica) */}
      <div
        className="flex h-[53px] shrink-0 items-center justify-center border-b border-neutral-800 px-2"
        style={{ fontFamily: "var(--font-brand)" }}
      >
        {collapsed ? (
          <span
            title="Motor Advertising"
            className="whitespace-nowrap text-base font-extrabold italic text-neutral-100"
          >
            <span className="text-neutral-600">/</span>
            <span className="text-neutral-400">/</span>M
          </span>
        ) : (
          <h1 className="whitespace-nowrap text-[12.5px] font-extrabold uppercase leading-none text-neutral-100">
            <span className="italic">
              <span className="text-neutral-600">/</span>
              <span className="text-neutral-400">/</span>
            </span>
            MOTOR ADVERT<span className="italic">ISI</span>NG
          </h1>
        )}
      </div>

      {/* Secciones */}
      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {ITEMS.map((item) => {
          const active = view === item.key;
          return (
            <button
              key={item.key}
              onClick={() => onViewChange(item.key)}
              title={collapsed ? item.label : undefined}
              className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                collapsed ? "justify-center" : ""
              } ${
                active
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200"
              }`}
            >
              {item.icon}
              {!collapsed && <span className="truncate">{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Cuenta (abajo a la izquierda) */}
      <div className="relative border-t border-neutral-800 p-2">
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          title={collapsed ? `${user.name} · ${ROLE_LABELS[user.role] ?? user.role}` : undefined}
          className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-neutral-800/60 ${
            collapsed ? "justify-center" : ""
          }`}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white">
            {initial}
          </span>
          {!collapsed && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-neutral-100">
                {user.name}
              </span>
              <span className="block truncate text-[11px] text-neutral-500">
                {ROLE_LABELS[user.role] ?? user.role}
              </span>
            </span>
          )}
        </button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute bottom-full left-2 z-20 mb-1.5 w-48 rounded-xl border border-neutral-700 bg-neutral-950 p-1.5 shadow-2xl">
              <div className="border-b border-neutral-800 px-2.5 py-2">
                <p className="truncate text-sm font-medium text-neutral-100">{user.name}</p>
                <p className="truncate text-[11px] text-neutral-500">
                  {user.username ? `@${user.username} · ` : ""}
                  {ROLE_LABELS[user.role] ?? user.role}
                </p>
              </div>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onChangePassword();
                }}
                className="mt-1 block w-full rounded-lg px-2.5 py-1.5 text-left text-sm text-neutral-300 hover:bg-neutral-800"
              >
                Cambiar contraseña
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onLogout();
                }}
                className="block w-full rounded-lg px-2.5 py-1.5 text-left text-sm text-red-400 hover:bg-neutral-800"
              >
                Cerrar sesión
              </button>
            </div>
          </>
        )}
      </div>

      {/* Plegar / expandir */}
      <div className="border-t border-neutral-800 p-2">
        <button
          onClick={onToggle}
          title={collapsed ? "Expandir" : "Contraer"}
          className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-neutral-500 transition-colors hover:bg-neutral-800/60 hover:text-neutral-300 ${
            collapsed ? "justify-center" : ""
          }`}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`h-5 w-5 shrink-0 transition-transform ${collapsed ? "rotate-180" : ""}`}
          >
            <path d="m14 7-5 5 5 5" />
          </svg>
          {!collapsed && <span>Contraer</span>}
        </button>
      </div>
    </aside>
  );
}
