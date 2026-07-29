"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TEAM_ROLES, type TeamMember, type TeamRole } from "@/lib/db";
import { DEFAULT_STAGE_CONFIG, STAGE_ORDER, type StageConfigMap } from "@/lib/stages";
import AiTeamSection from "./AiTeamSection";
import OrganizationsCard from "./OrganizationsCard";
import type { SessionUser } from "./LoginScreen";

const cardClass = "rounded-xl border border-neutral-800 bg-neutral-900 p-4";
const inputClass =
  "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-emerald-600";
const btnPrimary =
  "rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const btnGhost =
  "rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50";
const labelClass = "mb-1 block text-[11px] font-medium text-neutral-500";

const ROLE_LABELS: Record<TeamRole, string> = {
  ADMIN: "Admin",
  SUPERVISOR: "Supervisor",
  VENDEDOR: "Vendedor",
};

interface AccountView {
  id: number;
  label: string;
  status: "disconnected" | "qr" | "connecting" | "connected";
  phone: string | null;
  enabled: boolean;
  qrPng: string | null;
  updatedAt: number;
}

interface MemberDraft {
  name: string;
  role: TeamRole;
  wa_account_id: number | "";
  notify_phone: string;
  active: boolean;
  username: string;
  // Nueva contraseña a asignar; vacío = sin cambio (nunca se muestra la actual).
  password: string;
}

function draftFrom(m: TeamMember): MemberDraft {
  return {
    name: m.name,
    role: m.role,
    wa_account_id: m.wa_account_id ?? "",
    notify_phone: m.notify_phone ?? "",
    active: m.active,
    username: m.username ?? "",
    password: "",
  };
}

function sameDraft(a: MemberDraft, b: MemberDraft): boolean {
  return (
    a.name === b.name &&
    a.role === b.role &&
    a.wa_account_id === b.wa_account_id &&
    a.notify_phone === b.notify_phone &&
    a.active === b.active &&
    a.username === b.username &&
    a.password === b.password
  );
}

function Toggle({
  on,
  onChange,
  disabled,
  title,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-emerald-600" : "bg-neutral-700"
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
          on ? "left-[22px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

function statusChip(a: AccountView) {
  if (a.status === "connected") {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-emerald-950 px-2.5 py-1 text-xs font-medium text-emerald-400">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        Conectada{a.phone ? ` · +${a.phone}` : ""}
      </span>
    );
  }
  if (a.status === "qr") {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-amber-950 px-2.5 py-1 text-xs font-medium text-amber-400">
        <span className="h-2 w-2 rounded-full bg-amber-500" />
        Escanea el QR
      </span>
    );
  }
  if (a.status === "connecting") {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-neutral-800 px-2.5 py-1 text-xs font-medium text-neutral-400">
        <span className="h-2 w-2 animate-pulse rounded-full bg-neutral-400" />
        Conectando...
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-neutral-800 px-2.5 py-1 text-xs font-medium text-neutral-400">
      <span className="h-2 w-2 rounded-full bg-neutral-500" />
      {a.enabled ? "Desconectada" : "Deshabilitada"}
    </span>
  );
}

export default function TeamPanel({ currentUser }: { currentUser: SessionUser }) {
  const isAdmin = currentUser.role === "ADMIN";
  // Pestañas: el equipo humano (cuentas, miembros, enrutamiento) y el
  // equipo de IA (agentes especializados por tema/flujo).
  const [tab, setTab] = useState<"real" | "ia">("real");
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [drafts, setDrafts] = useState<Record<number, MemberDraft>>({});
  // Nombres de cuenta en edición: el poll de 2s reemplaza `accounts` entero
  // y pisaría lo que el operador está escribiendo; el borrador manda hasta
  // el blur.
  const [labelDrafts, setLabelDrafts] = useState<Record<number, string>>({});
  const [routing, setRouting] = useState<Record<string, number | "">>({});
  const [stageConfig, setStageConfig] = useState<StageConfigMap>(DEFAULT_STAGE_CONFIG);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  // Operaciones en vuelo por clave: un Set (no un string único) porque las
  // operaciones de entidades distintas pueden solaparse — con un solo valor,
  // el finally de la primera re-habilitaba el botón de la segunda en pleno
  // vuelo (doble submit / duplicados).
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set());
  const isBusy = (key: string) => busyKeys.has(key);

  const [newAccountLabel, setNewAccountLabel] = useState("");
  const [newMemberName, setNewMemberName] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<TeamRole>("VENDEDOR");
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  // Guard anti-respuestas-obsoletas del poll de cuentas.
  const seqRef = useRef(0);

  const loadAccounts = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const res = await fetch("/api/team/accounts", { cache: "no-store" });
      const data = (await res.json()) as { accounts?: AccountView[]; error?: string };
      if (seq !== seqRef.current) return;
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setError(null);
      setAccounts(data.accounts ?? []);
    } catch {
      /* siguiente poll */
    }
  }, []);

  // reseed: "all" re-siembra todos los borradores; un id re-siembra SOLO ese
  // (guardar un miembro no debe borrar las ediciones sin guardar de otros);
  // 0 conserva todos los borradores existentes (altas/bajas).
  const loadMembers = useCallback(async (reseed: number | "all" = "all") => {
    try {
      const res = await fetch("/api/team/members", { cache: "no-store" });
      const data = (await res.json()) as { members?: TeamMember[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const list = data.members ?? [];
      setMembers(list);
      setDrafts((prev) => {
        const next: Record<number, MemberDraft> = {};
        for (const m of list) {
          next[m.id] =
            reseed === "all" || m.id === reseed || !prev[m.id] ? draftFrom(m) : prev[m.id];
        }
        return next;
      });
    } catch {
      setError("No se pudo cargar el equipo");
    }
  }, []);

  const loadRouting = useCallback(async () => {
    try {
      const res = await fetch("/api/team/routing", { cache: "no-store" });
      const data = (await res.json()) as { routing?: Record<string, number> };
      if (res.ok && data.routing) {
        const map: Record<string, number | ""> = {};
        for (const stage of STAGE_ORDER) map[stage] = data.routing[stage] ?? "";
        setRouting(map);
      }
    } catch {
      /* opcional */
    }
  }, []);

  useEffect(() => {
    loadAccounts();
    loadMembers();
    loadRouting();
    fetch("/api/settings/stages", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { stages?: StageConfigMap } | null) => {
        if (data?.stages) setStageConfig(data.stages);
      })
      .catch(() => undefined);
    // Solo las cuentas se pollean (estado/QR en vivo); el resto se recarga
    // tras cada mutación.
    const timer = setInterval(loadAccounts, 2000);
    return () => clearInterval(timer);
  }, [loadAccounts, loadMembers, loadRouting]);

  const api = async (
    key: string,
    input: RequestInfo,
    init: RequestInit,
    after?: () => Promise<void> | void
  ): Promise<boolean> => {
    setBusyKeys((prev) => new Set(prev).add(key));
    setOkMsg(null);
    try {
      const res = await fetch(input, init);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "La operación falló");
        return false;
      }
      setError(null);
      await after?.();
      return true;
    } catch {
      setError("Error de red. Reintenta.");
      return false;
    } finally {
      // Solo se libera ESTA clave: las demás operaciones siguen en vuelo.
      setBusyKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const addAccount = async () => {
    const label = newAccountLabel.trim();
    if (!label) return;
    const ok = await api(
      "add-account",
      "/api/team/accounts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      },
      loadAccounts
    );
    if (ok) setNewAccountLabel("");
  };

  const patchAccount = (id: number, body: Record<string, unknown>, key?: string) =>
    api(key ?? `account-${id}`, `/api/team/accounts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, loadAccounts);

  const deleteAccount = async (id: number) => {
    setConfirmingDelete(null);
    await api(`del-account-${id}`, `/api/team/accounts/${id}`, { method: "DELETE" }, async () => {
      await loadAccounts();
      await loadMembers(); // su vínculo en miembros quedó en null
    });
  };

  const addMember = async () => {
    const name = newMemberName.trim();
    if (!name) return;
    const ok = await api(
      "add-member",
      "/api/team/members",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, role: newMemberRole }),
      },
      () => loadMembers(0) // el nuevo se siembra; los borradores ajenos quedan
    );
    if (ok) setNewMemberName("");
  };

  const saveMember = async (id: number) => {
    const draft = drafts[id];
    if (!draft) return;
    // Re-sembrar SOLO este miembro: las ediciones sin guardar de otros
    // miembros no se pierden.
    await api(`member-${id}`, `/api/team/members/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: draft.name,
        role: draft.role,
        wa_account_id: draft.wa_account_id === "" ? null : draft.wa_account_id,
        notify_phone: draft.notify_phone.trim() === "" ? null : draft.notify_phone.trim(),
        active: draft.active,
        username: draft.username.trim() === "" ? null : draft.username.trim(),
        // Solo si el Admin escribió una nueva (vacío = conservar la actual).
        ...(draft.password ? { password: draft.password } : {}),
      }),
    }, () => loadMembers(id));
  };

  const deleteMember = async (id: number) => {
    setConfirmingDelete(null);
    await api(`del-member-${id}`, `/api/team/members/${id}`, { method: "DELETE" }, async () => {
      await loadMembers(0); // conserva los borradores de los demás
      await loadRouting(); // sus reglas quedan huérfanas y se limpian al guardar
    });
  };

  const saveRouting = async () => {
    const clean: Record<string, number> = {};
    for (const stage of STAGE_ORDER) {
      const v = routing[stage];
      // Las reglas de miembros ya borrados se descartan (el select las
      // muestra como "Sin regla"; mandarlas bloqueaba el guardado).
      if (typeof v === "number" && (members ?? []).some((m) => m.id === v)) clean[stage] = v;
    }
    const ok = await api("routing", "/api/team/routing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routing: clean }),
    });
    if (ok) setOkMsg("Enrutamiento guardado");
  };

  const setDraft = (id: number, patch: Partial<MemberDraft>) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const accountLabel = (id: number | null): string => {
    if (id == null) return "";
    const a = accounts?.find((x) => x.id === id);
    return a ? a.label : `Cuenta #${id}`;
  };

  if (!accounts && !error) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-300" />
      </main>
    );
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        {error && <p className="rounded-lg bg-red-950 p-3 text-sm text-red-400">{error}</p>}
        {okMsg && <p className="rounded-lg bg-emerald-950 p-3 text-sm text-emerald-400">✓ {okMsg}</p>}
        {!isAdmin && (
          <p className="rounded-lg bg-amber-950 p-3 text-sm text-amber-400">
            Vista de solo lectura: solo un Admin puede modificar cuentas, miembros, enrutamiento
            y agentes de IA.
          </p>
        )}

        {/* ── Pestañas: equipo humano / equipo de IA ── */}
        <div className="inline-flex self-start overflow-hidden rounded-lg border border-neutral-700 text-xs font-medium">
          {(
            [
              ["real", "Equipo real"],
              ["ia", "Equipo de IA"],
            ] as const
          ).map(([key, label], i) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-2 transition-colors ${i > 0 ? "border-l border-neutral-700" : ""} ${
                tab === key
                  ? "bg-neutral-100 text-neutral-900"
                  : "bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "ia" ? (
          <AiTeamSection isAdmin={isAdmin} stageConfig={stageConfig} />
        ) : (
          <>
        {/* Gestión de organizaciones: SOLO Admins de la agencia (org 1) */}
        {isAdmin && (currentUser.org_id ?? 1) === 1 && <OrganizationsCard />}

        {/* ── Cuentas de WhatsApp ── */}
        <div className={`${cardClass} ${isAdmin ? "" : "pointer-events-none select-none"}`}>
          <h2 className="text-sm font-semibold text-neutral-100">Cuentas de WhatsApp</h2>
          <p className="mt-1 text-xs text-neutral-400">
            Cada cuenta se vincula escaneando su QR (WhatsApp → Dispositivos vinculados). El bot
            atiende todas a la vez; cada lead habla por la cuenta que lo recibió, o por la del
            vendedor asignado si tiene una.
          </p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(accounts ?? []).map((a) => (
              <div key={a.id} className="rounded-xl border border-neutral-800 bg-neutral-950 p-3">
                <div className="flex items-center justify-between gap-2">
                  <input
                    value={labelDrafts[a.id] ?? a.label}
                    onChange={(e) =>
                      setLabelDrafts((prev) => ({ ...prev, [a.id]: e.target.value }))
                    }
                    onBlur={() => {
                      const draft = labelDrafts[a.id];
                      setLabelDrafts((prev) => {
                        const next = { ...prev };
                        delete next[a.id];
                        return next;
                      });
                      if (draft === undefined) return;
                      const label = draft.trim();
                      if (label && label !== a.label && label.length <= 40) {
                        void patchAccount(a.id, { label });
                      }
                    }}
                    maxLength={40}
                    className="min-w-0 flex-1 bg-transparent text-sm font-medium text-neutral-100 outline-none"
                  />
                  <Toggle
                    on={a.enabled}
                    disabled={isBusy(`account-${a.id}`)}
                    title={a.enabled ? "Deshabilitar cuenta" : "Habilitar cuenta"}
                    onChange={(v) => patchAccount(a.id, { enabled: v })}
                  />
                </div>

                <div className="mt-2">{statusChip(a)}</div>

                {a.qrPng && (
                  <div className="mt-3 flex justify-center rounded-lg bg-white p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={a.qrPng} alt={`QR de ${a.label}`} className="h-44 w-44" />
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {a.status === "connected" ? (
                    <button
                      onClick={() => patchAccount(a.id, { relink: true })}
                      disabled={isBusy(`account-${a.id}`)}
                      className={btnGhost}
                    >
                      Desvincular
                    </button>
                  ) : (
                    a.enabled &&
                    a.status !== "qr" && (
                      <button
                        onClick={() => patchAccount(a.id, { relink: true })}
                        disabled={isBusy(`account-${a.id}`)}
                        className={btnGhost}
                        title="Cierra la sesión anterior (si la hay) y genera un QR nuevo"
                      >
                        Generar QR
                      </button>
                    )
                  )}
                  {confirmingDelete === `account-${a.id}` ? (
                    <span className="flex items-center gap-2 text-xs">
                      <button
                        onClick={() => deleteAccount(a.id)}
                        className="rounded-lg bg-red-600 px-2.5 py-1 font-medium text-white hover:bg-red-700"
                      >
                        Sí, eliminar
                      </button>
                      <button
                        onClick={() => setConfirmingDelete(null)}
                        className="text-neutral-500 hover:text-neutral-300"
                      >
                        Cancelar
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmingDelete(`account-${a.id}`)}
                      disabled={a.status === "connected"}
                      title={a.status === "connected" ? "Desvincula la cuenta antes de eliminarla" : undefined}
                      className="text-xs text-red-500 underline-offset-2 hover:underline disabled:opacity-40"
                    >
                      Eliminar
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 flex gap-2">
            <input
              value={newAccountLabel}
              onChange={(e) => setNewAccountLabel(e.target.value)}
              onKeyDown={(e) => {
                // El guard de busy evita duplicados por doble Enter (el
                // botón deshabilitado no protege al atajo de teclado).
                if (e.key === "Enter" && !isBusy("add-account")) void addAccount();
              }}
              maxLength={40}
              placeholder="Nombre de la cuenta (p.ej. Ventas 2)"
              className={inputClass}
            />
            <button
              onClick={addAccount}
              disabled={isBusy("add-account") || !newAccountLabel.trim()}
              className={`${btnPrimary} shrink-0`}
            >
              + Agregar cuenta
            </button>
          </div>
        </div>

        {/* ── Miembros del equipo ── */}
        <div className={`${cardClass} ${isAdmin ? "" : "pointer-events-none select-none"}`}>
          <h2 className="text-sm font-semibold text-neutral-100">Miembros del equipo</h2>
          <p className="mt-1 text-xs text-neutral-400">
            Cada miembro puede tener <strong>usuario y contraseña</strong> para entrar al
            dashboard (solo un Admin gestiona el equipo; Supervisor y Vendedor ven esta pestaña
            en solo lectura). El enrutamiento define a quién se asignan los leads y a qué
            WhatsApp se le avisa — su cuenta vinculada o el teléfono de avisos.
          </p>

          <div className="mt-3 space-y-2">
            {(members ?? []).map((m) => {
              const draft = drafts[m.id] ?? draftFrom(m);
              const dirty = !sameDraft(draft, draftFrom(m));
              return (
                <div
                  key={m.id}
                  className={`grid items-end gap-2 rounded-xl border border-neutral-800 bg-neutral-950 p-3 sm:grid-cols-2 lg:grid-cols-4 ${
                    draft.active ? "" : "opacity-60"
                  }`}
                >
                  <div>
                    <label className={labelClass}>Nombre</label>
                    <input
                      value={draft.name}
                      onChange={(e) => setDraft(m.id, { name: e.target.value })}
                      maxLength={60}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Rol</label>
                    <select
                      value={draft.role}
                      onChange={(e) => setDraft(m.id, { role: e.target.value as TeamRole })}
                      className={inputClass}
                    >
                      {TEAM_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>Usuario (para entrar)</label>
                    <input
                      value={draft.username}
                      onChange={(e) => setDraft(m.id, { username: e.target.value })}
                      maxLength={30}
                      placeholder="sin acceso"
                      autoComplete="off"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Contraseña (vacío = sin cambio)</label>
                    <input
                      type="password"
                      value={draft.password}
                      onChange={(e) => setDraft(m.id, { password: e.target.value })}
                      maxLength={100}
                      placeholder="••••••••"
                      autoComplete="new-password"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Cuenta de WhatsApp</label>
                    <select
                      value={draft.wa_account_id}
                      onChange={(e) =>
                        setDraft(m.id, {
                          wa_account_id: e.target.value ? Number(e.target.value) : "",
                        })
                      }
                      className={inputClass}
                    >
                      <option value="">— Sin cuenta —</option>
                      {(accounts ?? []).map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                          {a.phone ? ` (+${a.phone})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>Teléfono de avisos (opcional)</label>
                    <input
                      value={draft.notify_phone}
                      onChange={(e) => setDraft(m.id, { notify_phone: e.target.value })}
                      placeholder="573001112233"
                      className={inputClass}
                    />
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <Toggle
                      on={draft.active}
                      title={draft.active ? "Activo" : "Inactivo"}
                      onChange={(v) => setDraft(m.id, { active: v })}
                    />
                    {dirty && (
                      <button
                        onClick={() => saveMember(m.id)}
                        disabled={isBusy(`member-${m.id}`) || !draft.name.trim()}
                        className={btnPrimary}
                      >
                        Guardar
                      </button>
                    )}
                    {confirmingDelete === `member-${m.id}` ? (
                      <span className="flex items-center gap-1.5 text-xs">
                        <button
                          onClick={() => deleteMember(m.id)}
                          className="rounded-lg bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700"
                        >
                          Sí
                        </button>
                        <button
                          onClick={() => setConfirmingDelete(null)}
                          className="text-neutral-500 hover:text-neutral-300"
                        >
                          No
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setConfirmingDelete(`member-${m.id}`)}
                        title="Eliminar miembro"
                        className="text-xs text-red-500 underline-offset-2 hover:underline"
                      >
                        Eliminar
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {(members ?? []).length === 0 && (
              <p className="rounded-lg bg-neutral-950 py-4 text-center text-xs text-neutral-600">
                Sin miembros todavía. Agrega a tu equipo para poder asignarles leads.
              </p>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <input
              value={newMemberName}
              onChange={(e) => setNewMemberName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isBusy("add-member")) void addMember();
              }}
              maxLength={60}
              placeholder="Nombre del miembro"
              className={`${inputClass} max-w-xs`}
            />
            <select
              value={newMemberRole}
              onChange={(e) => setNewMemberRole(e.target.value as TeamRole)}
              className={`${inputClass} w-auto`}
            >
              {TEAM_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <button
              onClick={addMember}
              disabled={isBusy("add-member") || !newMemberName.trim()}
              className={btnPrimary}
            >
              + Agregar miembro
            </button>
          </div>
        </div>

        {/* ── Enrutamiento por etapa ── */}
        <div className={`${cardClass} ${isAdmin ? "" : "pointer-events-none select-none"}`}>
          <h2 className="text-sm font-semibold text-neutral-100">Enrutamiento por etapa</h2>
          <p className="mt-1 text-xs text-neutral-400">
            Cuando un lead entra a una etapa (desde el kanban, la ficha o el avance automático de
            la IA), se asigna al vendedor de la regla: recibe un aviso por WhatsApp y las
            respuestas al cliente salen por su cuenta (si tiene una conectada). Las etapas sin
            regla conservan el asignado actual.
          </p>

          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {STAGE_ORDER.map((stage) => (
              <div
                key={stage}
                className="flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2"
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: stageConfig[stage].color }}
                />
                <span className="w-24 shrink-0 truncate text-xs text-neutral-300">
                  {stageConfig[stage].label}
                </span>
                <select
                  value={routing[stage] ?? ""}
                  onChange={(e) =>
                    setRouting((prev) => ({
                      ...prev,
                      [stage]: e.target.value ? Number(e.target.value) : "",
                    }))
                  }
                  className={inputClass}
                >
                  <option value="">— Sin regla —</option>
                  {(members ?? [])
                    .filter((m) => m.active)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.wa_account_id != null ? ` · ${accountLabel(m.wa_account_id)}` : ""}
                      </option>
                    ))}
                </select>
              </div>
            ))}
          </div>

          <button
            onClick={saveRouting}
            disabled={isBusy("routing")}
            className={`mt-3 ${btnPrimary}`}
          >
            {isBusy("routing") ? "Guardando..." : "Guardar enrutamiento"}
          </button>
        </div>
          </>
        )}
      </div>
    </main>
  );
}
