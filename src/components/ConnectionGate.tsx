"use client";

import { useCallback, useEffect, useState } from "react";
import DashboardHeader from "./DashboardHeader";
import Sidebar, { type DashboardView } from "./Sidebar";
import LoginScreen, { type SessionUser } from "./LoginScreen";
import ConversationList from "./ConversationList";
import ConversationPanel from "./ConversationPanel";
import CrmBoard from "./CrmBoard";
import ChannelSettings from "./ChannelSettings";
import MailingPanel from "./MailingPanel";
import CalendarPanel from "./CalendarPanel";
import AlarmsPanel from "./AlarmsPanel";
import TeamPanel from "./TeamPanel";
import Resizer, { usePanelWidth } from "./Resizer";

// Resumen agregado de las cuentas de WhatsApp (chip del header). La gestión
// por cuenta (QR, desvincular) vive en la pestaña Equipo.
export interface ConnectionPayload {
  connected: boolean;
  accountsConnected: number;
  accountsTotal: number;
  phone: string | null;
  error?: string;
}

const VIEW_TITLES: Record<DashboardView, string> = {
  chats: "Chats",
  crm: "CRM",
  mailing: "Mailing",
  calendar: "Calendario",
  alarms: "Alarmas",
  team: "Equipo",
  channels: "Canales",
};

const SIDEBAR_KEY = "agente-sidebar-collapsed";

// Shell del dashboard. La puerta de entrada es el LOGIN (usuario/contraseña
// gestionados por el Admin en Equipo); los QR de WhatsApp viven en Equipo.
export default function ConnectionGate() {
  // undefined = comprobando la sesión; null = sin sesión (login).
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);
  const [conn, setConn] = useState<ConnectionPayload | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [view, setView] = useState<DashboardView>("chats");
  const [collapsed, setCollapsed] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  // Ancho de la lista de conversaciones (columna redimensionable, persistido).
  const list = usePanelWidth("agente-w-list", 320, 220, 560);
  // Ancho de la barra lateral de navegación (solo expandida; plegada es fija).
  const side = usePanelWidth("agente-w-sidebar", 208, 160, 340);
  const [sideResizing, setSideResizing] = useState(false);

  // ¿Hay sesión activa? Se comprueba al montar y luego cada 60s: /api/auth/me
  // relee al miembro de la DB, así que desactivar a alguien lo saca del
  // dashboard en ≤1 min aunque su token siga firmado.
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (!active) return;
        if (res.status === 401 || res.status === 403) {
          setMe(null);
          return;
        }
        if (!res.ok) {
          // Error transitorio (Supabase caído): no cerrar la sesión visible.
          setMe((prev) => (prev === undefined ? null : prev));
          return;
        }
        const data = (await res.json()) as { member?: SessionUser };
        setMe(data.member ?? null);
      } catch {
        if (active) setMe((prev) => (prev === undefined ? null : prev));
      }
    };
    check();
    const timer = setInterval(check, 60000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  // Preferencia de barra lateral: se lee tras montar (localStorage no existe
  // durante el render de servidor).
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1");
    } catch {
      /* modo privado sin storage: queda expandida */
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      } catch {
        /* sin storage no se persiste, pero el toggle funciona */
      }
      return next;
    });
  }, []);

  // Al volver del OAuth de Google (…/api/google/callback redirige con
  // ?google=…) hay que aterrizar directo en Calendario.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("google")) setView("calendar");
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* la cookie local igual se considera cerrada */
    }
    setMe(null);
    setConn(null);
    setView("chats");
    setSelectedId(null);
  }, []);

  // Memoizado: si fuera una arrow inline, cambiaría de identidad con cada
  // poll de 2s y reiniciaría el efecto de polling de ConversationPanel
  // (borrando el borrador del operador cada 2 segundos).
  const handleDeleted = useCallback(() => setSelectedId(null), []);

  // Abrir un lead desde el kanban: selecciona la conversación y salta al chat.
  const handleOpenLead = useCallback((id: number) => {
    setSelectedId(id);
    setView("chats");
  }, []);

  // Estado agregado de WhatsApp: solo con sesión activa. Un 401 (sesión
  // expirada o revocada) devuelve al login.
  useEffect(() => {
    if (!me) return;
    let active = true;

    const poll = async () => {
      try {
        const res = await fetch("/api/connection/status", { cache: "no-store" });
        if (res.status === 401) {
          if (active) setMe(null);
          return;
        }
        const data = (await res.json()) as ConnectionPayload;
        if (active) setConn(data);
      } catch {
        if (active) {
          setConn({
            connected: false,
            accountsConnected: 0,
            accountsTotal: 0,
            phone: null,
            error: "No se pudo contactar la API del dashboard",
          });
        }
      }
    };

    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [me]);

  if (me === undefined) {
    return (
      <main className="flex h-screen items-center justify-center">
        <div className="flex items-center gap-3 text-neutral-400">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-300" />
          Cargando...
        </div>
      </main>
    );
  }

  if (me === null) {
    return <LoginScreen onLogin={setMe} />;
  }

  const connLabel = conn?.connected
    ? conn.accountsConnected === 1
      ? `Conectado${conn.phone ? ` · +${conn.phone}` : ""}`
      : `${conn.accountsConnected} cuentas conectadas`
    : "Desconectado";

  return (
    <div className="flex h-screen">
      <Sidebar
        view={view}
        onViewChange={setView}
        collapsed={collapsed}
        onToggle={toggleSidebar}
        user={me}
        onLogout={logout}
        onChangePassword={() => setPwOpen(true)}
        width={side.width}
        resizing={sideResizing}
      />
      {!collapsed && (
        <Resizer
          onDelta={side.adjust}
          onReset={side.reset}
          onDragStart={() => setSideResizing(true)}
          onDragEnd={() => setSideResizing(false)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <DashboardHeader
          connected={conn?.connected ?? false}
          connLabel={connLabel}
          title={VIEW_TITLES[view]}
        />
        {view === "crm" ? (
          <CrmBoard onOpenLead={handleOpenLead} />
        ) : view === "mailing" ? (
          <MailingPanel />
        ) : view === "calendar" ? (
          <CalendarPanel />
        ) : view === "alarms" ? (
          <AlarmsPanel />
        ) : view === "team" ? (
          <TeamPanel currentUser={me} />
        ) : view === "channels" ? (
          <ChannelSettings />
        ) : (
          <div className="flex min-h-0 flex-1 overflow-x-auto">
            <ConversationList
              selectedId={selectedId}
              onSelect={setSelectedId}
              width={list.width}
            />
            <Resizer onDelta={list.adjust} onReset={list.reset} />
            <ConversationPanel conversationId={selectedId} onDeleted={handleDeleted} />
          </div>
        )}
      </div>

      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
    </div>
  );
}

// ── Cambio de la propia contraseña ──────────────────────────

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const inputClass =
    "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-emerald-600";

  const save = async () => {
    setError(null);
    if (next.length < 6) {
      setError("La contraseña nueva debe tener al menos 6 caracteres");
      return;
    }
    if (next !== repeat) {
      setError("La confirmación no coincide");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current, next }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? "No se pudo cambiar la contraseña");
        return;
      }
      setDone(true);
      setTimeout(onClose, 1200);
    } catch {
      setError("Error de red. Reintenta.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl">
        <div className="border-b border-neutral-800 px-6 py-4">
          <h2 className="text-base font-semibold text-neutral-100">Cambiar contraseña</h2>
        </div>
        <div className="space-y-3 px-6 py-4">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-neutral-500">
              Contraseña actual
            </label>
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-neutral-500">Nueva</label>
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-neutral-500">
              Repite la nueva
            </label>
            <input
              type="password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              autoComplete="new-password"
              className={inputClass}
            />
          </div>
          {error && <p className="rounded-lg bg-red-950 p-2 text-xs text-red-400">{error}</p>}
          {done && (
            <p className="rounded-lg bg-emerald-950 p-2 text-xs text-emerald-400">
              ✓ Contraseña actualizada
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-800 px-6 py-4">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
          >
            Cancelar
          </button>
          <button
            onClick={save}
            disabled={busy || !current || !next || !repeat}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? "Guardando..." : "Guardar"}
          </button>
        </div>
      </div>
    </div>
  );
}
