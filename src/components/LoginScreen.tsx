"use client";

import { useState } from "react";
import type { TeamRole } from "@/lib/db";

// Usuario de la sesión activa (lo que devuelve /api/auth/login y /me).
export interface SessionUser {
  id: number;
  name: string;
  role: TeamRole;
  username: string | null;
}

interface Props {
  onLogin: (user: SessionUser) => void;
}

// Puerta de entrada del dashboard: usuario y contraseña (los gestiona el
// Admin en la pestaña Equipo). La cuenta maestra inicial es goatdev.
export default function LoginScreen({ onLogin }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json().catch(() => null)) as
        | { member?: SessionUser; error?: string }
        | null;
      if (!res.ok || !data?.member) {
        setError(data?.error ?? "No se pudo iniciar sesión");
        return;
      }
      onLogin(data.member);
    } catch {
      setError("Error de red. ¿El servidor está corriendo?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex h-screen items-center justify-center p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-neutral-800 bg-neutral-900 p-8 shadow-2xl"
      >
        <div className="mb-6 text-center" style={{ fontFamily: "var(--font-brand)" }}>
          <h1 className="whitespace-nowrap text-lg font-extrabold uppercase text-neutral-100">
            <span className="italic">
              <span className="text-neutral-600">/</span>
              <span className="text-neutral-400">/</span>
            </span>
            MOTOR ADVERT<span className="italic">ISI</span>NG
          </h1>
          <p className="mt-1.5 text-[10px] font-medium tracking-[0.3em] text-neutral-500">
            Your brand. Our engine.
          </p>
          <p className="mt-4 text-xs text-neutral-500">Inicia sesión para entrar al panel</p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-neutral-500">Usuario</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-emerald-600"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-neutral-500">Contraseña</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-emerald-600"
            />
          </div>

          {error && <p className="rounded-lg bg-red-950 p-2.5 text-xs text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={busy || !username.trim() || !password}
            className="w-full rounded-lg bg-emerald-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? "Entrando..." : "Entrar"}
          </button>
        </div>
      </form>
    </main>
  );
}
