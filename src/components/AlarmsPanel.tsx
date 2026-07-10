"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ALARM_KINDS,
  ALARM_REPEATS,
  type Alarm,
  type AlarmKind,
  type AlarmRepeat,
  type TeamMember,
} from "@/lib/db";

const cardClass = "rounded-xl border border-neutral-800 bg-neutral-900 p-4";
const inputClass =
  "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-emerald-600";
const btnPrimary =
  "rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const btnGhost =
  "rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50";
const labelClass = "mb-1 block text-[11px] font-medium text-neutral-500";

const KIND_LABELS: Record<AlarmKind, string> = {
  SUSCRIPCION: "Suscripción",
  PAGO: "Pago",
  REUNION: "Reunión",
  TAREA: "Tarea",
  OTRO: "Otro",
};
const KIND_CHIP: Record<AlarmKind, string> = {
  SUSCRIPCION: "bg-violet-950 text-violet-400",
  PAGO: "bg-amber-950 text-amber-400",
  REUNION: "bg-sky-950 text-sky-400",
  TAREA: "bg-emerald-950 text-emerald-400",
  OTRO: "bg-neutral-800 text-neutral-400",
};
const REPEAT_LABELS: Record<AlarmRepeat, string> = {
  NUNCA: "Una vez",
  DIARIO: "Cada día",
  SEMANAL: "Cada semana",
  MENSUAL: "Cada mes",
  ANUAL: "Cada año",
};

interface LeadOption {
  id: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  external_id: string | null;
}

interface AccountOption {
  id: number;
  label: string;
  phone: string | null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function epochToInput(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function inputToEpoch(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function fmtDateTime(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString("es", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AlarmsPanel() {
  const [alarms, setAlarms] = useState<Alarm[] | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [leads, setLeads] = useState<LeadOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<Alarm | "new" | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/alarms", { cache: "no-store" });
      const data = (await res.json()) as { alarms?: Alarm[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setError(null);
      setAlarms(data.alarms ?? []);
    } catch {
      /* siguiente poll */
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    // Catálogos para el selector de destino (best-effort).
    fetch("/api/team/members", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { members?: TeamMember[] } | null) => d?.members && setMembers(d.members))
      .catch(() => undefined);
    fetch("/api/team/accounts", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { accounts?: AccountOption[] } | null) => d?.accounts && setAccounts(d.accounts))
      .catch(() => undefined);
    fetch("/api/crm", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { leads?: LeadOption[] } | null) => d?.leads && setLeads(d.leads))
      .catch(() => undefined);
    return () => clearInterval(timer);
  }, [load]);

  const toggleActive = async (alarm: Alarm) => {
    // Re-armar una alarma de un solo disparo ya vencida la re-enviaría en
    // segundos: se exige reprogramar desde Editar (el server también lo
    // rechaza; este guard da el mensaje sin round-trip).
    if (!alarm.active && alarm.repeat_every === "NUNCA" && alarm.next_fire_at <= Math.floor(Date.now() / 1000)) {
      setError("Esa alarma de un solo disparo ya pasó: usa Editar y ponle una fecha futura.");
      return;
    }
    setBusy(true);
    let failMsg: string | null = null;
    try {
      const res = await fetch(`/api/alarms/${alarm.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !alarm.active }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        failMsg = data?.error ?? "No se pudo cambiar la alarma";
      }
    } catch {
      failMsg = "Error de red";
    }
    setBusy(false);
    // Recargar primero: el camino feliz de load() limpia `error`; el fallo
    // se fija DESPUÉS para que no lo borre.
    await load();
    if (failMsg) setError(failMsg);
  };

  const remove = async (id: number) => {
    setConfirming(null);
    setBusy(true);
    let failMsg: string | null = null;
    try {
      const res = await fetch(`/api/alarms/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        failMsg = data?.error ?? "No se pudo eliminar";
      }
    } catch {
      failMsg = "Error de red";
    }
    setBusy(false);
    await load();
    if (failMsg) setError(failMsg);
  };

  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto flex max-w-4xl flex-col gap-3">
        {error && <p className="rounded-lg bg-red-950 p-3 text-sm text-red-400">{error}</p>}

        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-neutral-100">Alarmas</h2>
            <p className="text-xs text-neutral-500">
              Avisos programados por WhatsApp o correo: renovaciones de suscripción, pagos,
              reuniones, tareas… con recurrencia opcional. El bot los envía a su hora.
            </p>
          </div>
          <button onClick={() => setModal("new")} className={btnPrimary}>
            + Nueva alarma
          </button>
        </div>

        <div className="space-y-2">
          {(alarms ?? []).map((a) => (
            <div
              key={a.id}
              className={`${cardClass} flex flex-wrap items-center gap-3 ${a.active ? "" : "opacity-60"}`}
            >
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${KIND_CHIP[a.kind]}`}>
                {KIND_LABELS[a.kind]}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-neutral-100">{a.title}</p>
                <p className="truncate text-xs text-neutral-500">
                  {a.via === "whatsapp" ? `WhatsApp +${a.to_phone}` : `Correo ${a.to_email}`}
                  {" · "}
                  {a.active ? `Próxima: ${fmtDateTime(a.next_fire_at)}` : "Apagada"}
                  {" · "}
                  {REPEAT_LABELS[a.repeat_every]}
                  {a.last_fired_at ? ` · Último envío: ${fmtDateTime(a.last_fired_at)}` : ""}
                </p>
                {a.last_error && (
                  <p className="truncate text-xs text-red-500" title={a.last_error}>
                    Falló el último disparo: {a.last_error}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  role="switch"
                  aria-checked={a.active}
                  disabled={busy}
                  onClick={() => toggleActive(a)}
                  title={a.active ? "Apagar" : "Encender"}
                  className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${
                    a.active ? "bg-emerald-600" : "bg-neutral-700"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                      a.active ? "left-[22px]" : "left-0.5"
                    }`}
                  />
                </button>
                <button onClick={() => setModal(a)} className={btnGhost}>
                  Editar
                </button>
                {confirming === a.id ? (
                  <span className="flex items-center gap-1.5 text-xs">
                    <button
                      onClick={() => remove(a.id)}
                      className="rounded-lg bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700"
                    >
                      Sí
                    </button>
                    <button onClick={() => setConfirming(null)} className="text-neutral-500 hover:text-neutral-300">
                      No
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirming(a.id)}
                    className="text-xs text-red-500 underline-offset-2 hover:underline"
                  >
                    Eliminar
                  </button>
                )}
              </div>
            </div>
          ))}
          {alarms !== null && alarms.length === 0 && (
            <p className="rounded-xl border border-neutral-800 bg-neutral-900 py-10 text-center text-sm text-neutral-600">
              Sin alarmas todavía. Crea una con “+ Nueva alarma” — p.ej. la renovación mensual de
              una suscripción o el recordatorio de un pago.
            </p>
          )}
        </div>
      </div>

      {modal && (
        <AlarmModal
          alarm={modal === "new" ? null : modal}
          members={members}
          accounts={accounts}
          leads={leads}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            load();
          }}
        />
      )}
    </main>
  );
}

// ════════════════════════════════════════════════════════════
// Modal de alarma (crear / editar)
// ════════════════════════════════════════════════════════════

type DestMode = "manual" | "member" | "lead";

interface ModalProps {
  alarm: Alarm | null;
  members: TeamMember[];
  accounts: AccountOption[];
  leads: LeadOption[];
  onClose: () => void;
  onSaved: () => void;
}

function AlarmModal({ alarm, members, accounts, leads, onClose, onSaved }: ModalProps) {
  const [title, setTitle] = useState(alarm?.title ?? "");
  const [kind, setKind] = useState<AlarmKind>(alarm?.kind ?? "SUSCRIPCION");
  const [message, setMessage] = useState(alarm?.message ?? "");
  const [via, setVia] = useState<"whatsapp" | "email">(alarm?.via ?? "whatsapp");
  // Una alarma que ya venía ligada a un lead abre en modo lead.
  const [destMode, setDestMode] = useState<DestMode>(alarm?.conversation_id ? "lead" : "manual");
  const [memberId, setMemberId] = useState<number | "">("");
  const [leadId, setLeadId] = useState<number | "">(alarm?.conversation_id ?? "");
  const [manual, setManual] = useState(alarm ? (alarm.via === "whatsapp" ? alarm.to_phone ?? "" : alarm.to_email ?? "") : "");
  const [when, setWhen] = useState(
    epochToInput(alarm?.next_fire_at ?? Math.floor(Date.now() / 1000) + 3600)
  );
  const [repeat, setRepeat] = useState<AlarmRepeat>(alarm?.repeat_every ?? "NUNCA");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // El teléfono de aviso de un miembro: su notify_phone o el número de su
  // cuenta de WhatsApp vinculada.
  const memberPhone = (m: TeamMember): string | null =>
    m.notify_phone ?? accounts.find((a) => a.id === m.wa_account_id)?.phone ?? null;

  const resolveDest = (): { to_phone?: string; to_email?: string; conversation_id?: number | null; err?: string } => {
    if (destMode === "member") {
      const m = members.find((x) => x.id === memberId);
      if (!m) return { err: "Elige un miembro" };
      if (via === "whatsapp") {
        const phone = memberPhone(m);
        if (!phone) return { err: `${m.name} no tiene WhatsApp configurado (cuenta o teléfono de avisos)` };
        return { to_phone: phone };
      }
      return { err: "Los miembros no tienen correo registrado: usa destino manual" };
    }
    if (destMode === "lead") {
      const l = leads.find((x) => x.id === leadId);
      if (!l) return { err: "Elige un lead" };
      if (via === "whatsapp") {
        const phone = l.phone ?? (/^\d{7,15}$/.test(l.external_id ?? "") ? l.external_id : null);
        if (!phone) return { err: "Ese lead no tiene teléfono" };
        return { to_phone: phone, conversation_id: l.id };
      }
      if (!l.email) return { err: "Ese lead no tiene correo" };
      return { to_email: l.email, conversation_id: l.id };
    }
    if (!manual.trim()) return { err: via === "whatsapp" ? "Escribe el número" : "Escribe el correo" };
    return via === "whatsapp" ? { to_phone: manual.trim() } : { to_email: manual.trim() };
  };

  const save = async () => {
    setError(null);
    const nextFireAt = inputToEpoch(when);
    if (!title.trim()) return setError("El título es obligatorio");
    if (!message.trim()) return setError("El mensaje es obligatorio");
    if (!nextFireAt) return setError("La fecha es obligatoria");
    const dest = resolveDest();
    if (dest.err) return setError(dest.err);

    setSaving(true);
    try {
      // Al editar: solo se re-arma si ya estaba activa o si el operador
      // puso una fecha futura (editar una alarma apagada con fecha pasada
      // NO debe re-dispararla en silencio). El lead vinculado se limpia al
      // cambiar el destino a manual/miembro.
      const rearm = alarm ? alarm.active || nextFireAt > Math.floor(Date.now() / 1000) : false;
      const payload = {
        title: title.trim(),
        message: message.trim(),
        kind,
        via,
        to_phone: dest.to_phone ?? null,
        to_email: dest.to_email ?? null,
        conversation_id: dest.conversation_id ?? null,
        next_fire_at: nextFireAt,
        repeat_every: repeat,
        ...(alarm && rearm ? { active: true } : {}),
      };
      const res = await fetch(alarm ? `/api/alarms/${alarm.id}` : "/api/alarms", {
        method: alarm ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? "No se pudo guardar");
        return;
      }
      onSaved();
    } catch {
      setError("Error de red al guardar");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl">
        <div className="border-b border-neutral-800 px-6 py-4">
          <h2 className="text-base font-semibold text-neutral-100">
            {alarm ? "Editar alarma" : "Nueva alarma"}
          </h2>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Título</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
                placeholder="Renovación plan mensual"
                autoFocus
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Tipo</label>
              <select value={kind} onChange={(e) => setKind(e.target.value as AlarmKind)} className={inputClass}>
                {ALARM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={labelClass}>Mensaje del aviso</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Hola, tu suscripción vence mañana. ¿Renovamos?"
              className={inputClass}
            />
          </div>

          {/* Canal */}
          <div className="flex items-center gap-3">
            <div className="inline-flex overflow-hidden rounded-lg border border-neutral-700 text-xs font-medium">
              {(
                [
                  ["whatsapp", "WhatsApp"],
                  ["email", "Correo"],
                ] as const
              ).map(([key, label], i) => (
                <button
                  key={key}
                  onClick={() => setVia(key)}
                  className={`px-3 py-1.5 transition-colors ${i > 0 ? "border-l border-neutral-700" : ""} ${
                    via === key
                      ? "bg-neutral-100 text-neutral-900"
                      : "bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <select
              value={destMode}
              onChange={(e) => setDestMode(e.target.value as DestMode)}
              className={`${inputClass} w-auto`}
            >
              <option value="manual">{via === "whatsapp" ? "Número manual" : "Correo manual"}</option>
              <option value="member">Miembro del equipo</option>
              <option value="lead">Lead del CRM</option>
            </select>
          </div>

          {/* Destino */}
          {destMode === "manual" && (
            <div>
              <label className={labelClass}>{via === "whatsapp" ? "Número (con indicativo)" : "Correo"}</label>
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder={via === "whatsapp" ? "573001112233" : "cliente@correo.com"}
                className={inputClass}
              />
            </div>
          )}
          {destMode === "member" && (
            <div>
              <label className={labelClass}>Miembro</label>
              <select
                value={memberId}
                onChange={(e) => setMemberId(e.target.value ? Number(e.target.value) : "")}
                className={inputClass}
              >
                <option value="">— Elegir —</option>
                {members
                  .filter((m) => m.active)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {memberPhone(m) ? ` (+${memberPhone(m)})` : " (sin WhatsApp)"}
                    </option>
                  ))}
              </select>
            </div>
          )}
          {destMode === "lead" && (
            <div>
              <label className={labelClass}>Lead</label>
              <select
                value={leadId}
                onChange={(e) => setLeadId(e.target.value ? Number(e.target.value) : "")}
                className={inputClass}
              >
                <option value="">— Elegir —</option>
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name ?? l.phone ?? l.email ?? `Lead #${l.id}`}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Fecha y hora</label>
              <input
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                className={`${inputClass} [color-scheme:dark]`}
              />
            </div>
            <div>
              <label className={labelClass}>Repetición</label>
              <select
                value={repeat}
                onChange={(e) => setRepeat(e.target.value as AlarmRepeat)}
                className={inputClass}
              >
                {ALARM_REPEATS.map((r) => (
                  <option key={r} value={r}>
                    {REPEAT_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p className="text-xs text-neutral-600">
            WhatsApp: sale por cualquiera de tus cuentas conectadas (no toca el hilo del lead).
            Correo: usa la cuenta SMTP de la pestaña Mailing.
          </p>

          {error && <p className="rounded-lg bg-red-950 p-2 text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-800 px-6 py-4">
          <button onClick={onClose} disabled={saving} className={btnGhost}>
            Cancelar
          </button>
          <button onClick={save} disabled={saving} className={btnPrimary}>
            {saving ? "Guardando..." : "Guardar"}
          </button>
        </div>
      </div>
    </div>
  );
}
