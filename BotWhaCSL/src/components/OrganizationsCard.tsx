"use client";

import { useEffect, useState } from "react";

// Gestión de organizaciones (SOLO visible para los Admin de la agencia,
// organización 1): cada organización es el espacio aislado de un cliente —
// sus canales/tokens, sus chats, su CRM, su equipo. Crear una organización
// crea también su primer usuario Admin, con el que el cliente entra.

const cardClass = "rounded-xl border border-neutral-800 bg-neutral-900 p-4";
const inputClass =
  "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-emerald-600";
const btnPrimary =
  "rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const labelClass = "mb-1 block text-[11px] font-medium text-neutral-500";

interface OrgRow {
  id: number;
  name: string;
  active: boolean;
  created_at: number;
  members: number;
}

export default function OrganizationsCard() {
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Alta: organización + su primer admin.
  const [name, setName] = useState("");
  const [adminName, setAdminName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const load = async () => {
    try {
      const res = await fetch("/api/orgs", { cache: "no-store" });
      const data = (await res.json()) as { orgs?: OrgRow[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setError(null);
      setOrgs(data.orgs ?? []);
    } catch {
      setError("No se pudieron cargar las organizaciones");
    }
  };

  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const res = await fetch("/api/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, adminName, username, password }),
      });
      const data = (await res.json().catch(() => null)) as {
        org?: { name: string };
        admin?: { username: string };
        error?: string;
      } | null;
      if (!res.ok) {
        setError(data?.error ?? "No se pudo crear la organización");
        return;
      }
      setOkMsg(
        `✓ Organización "${data?.org?.name}" creada. Su acceso: usuario "${data?.admin?.username}" con la contraseña definida — entrégaselos al cliente.`
      );
      setName("");
      setAdminName("");
      setUsername("");
      setPassword("");
      await load();
    } catch {
      setError("Error de red al crear");
    } finally {
      setBusy(false);
    }
  };

  const canCreate =
    name.trim() !== "" && adminName.trim() !== "" && username.trim() !== "" && password.length >= 6;

  return (
    <div className={cardClass}>
      <h2 className="text-sm font-semibold text-neutral-100">Organizaciones (clientes)</h2>
      <p className="mt-1 max-w-2xl text-xs text-neutral-400">
        Cada organización es el espacio <b>aislado</b> de un cliente: sus canales y tokens
        (Instagram, Messenger, WhatsApp, correo, IA), sus chats, su CRM, su equipo, sus
        plantillas y agentes. Al crearla defines su primer usuario Admin — con ese acceso el
        cliente entra y solo ve lo suyo.
      </p>

      {error && <p className="mt-3 rounded-lg bg-red-950 p-2 text-xs text-red-400">{error}</p>}
      {okMsg && <p className="mt-3 rounded-lg bg-emerald-950 p-2 text-xs text-emerald-400">{okMsg}</p>}

      {/* Lista */}
      <div className="mt-3 space-y-1.5">
        {(orgs ?? []).map((o) => (
          <div
            key={o.id}
            className="flex items-center justify-between gap-3 rounded-lg bg-neutral-950 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-neutral-200">
                {o.name}
                {o.id === 1 && (
                  <span className="ml-2 rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400">
                    Agencia
                  </span>
                )}
              </p>
              <p className="text-[11px] text-neutral-500">
                #{o.id} · {o.members} miembro{o.members === 1 ? "" : "s"}
              </p>
            </div>
          </div>
        ))}
        {orgs === null && !error && (
          <p className="py-4 text-center text-xs text-neutral-600">Cargando...</p>
        )}
      </div>

      {/* Alta */}
      <div className="mt-4 rounded-xl border border-neutral-800 bg-neutral-950 p-3">
        <p className="mb-2 text-xs font-medium text-neutral-300">Crear organización (cliente nuevo)</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Nombre del negocio</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="Tienda Deportiva XYZ"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Nombre del administrador</label>
            <input
              value={adminName}
              onChange={(e) => setAdminName(e.target.value)}
              maxLength={60}
              placeholder="María Pérez"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Usuario de acceso (único en la plataforma)</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={30}
              placeholder="tiendaxyz"
              autoComplete="off"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Contraseña inicial (mínimo 6)</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={100}
              placeholder="••••••••"
              autoComplete="new-password"
              className={inputClass}
            />
          </div>
        </div>
        <button onClick={create} disabled={busy || !canCreate} className={`mt-2 ${btnPrimary}`}>
          {busy ? "Creando..." : "+ Crear organización"}
        </button>
      </div>
    </div>
  );
}
