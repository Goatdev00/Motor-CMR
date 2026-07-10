"use client";

import { useEffect, useState } from "react";
import { LEAD_STAGES, type LeadStage } from "@/lib/db";
import { DEFAULT_STAGE_CONFIG, type StageConfigMap } from "@/lib/stages";

const cardClass = "rounded-xl border border-neutral-800 bg-neutral-900 p-4";
const inputClass =
  "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-emerald-600";
const btnPrimary =
  "rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const btnGhost =
  "rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50";
const labelClass = "mb-1 block text-[11px] font-medium text-neutral-500";

interface EmailItem {
  id: number;
  to_email: string;
  subject: string;
  sent: number;
  attempts: number;
  error: string | null;
  created_at: number;
  sent_at: number | null;
}

interface StatusPayload {
  stats?: { pending: number; sentLastDay: number; failed: number };
  recent?: EmailItem[];
  error?: string;
}

const ACCOUNT_FIELDS: { key: string; label: string; placeholder: string; secret?: boolean }[] = [
  { key: "host", label: "Servidor SMTP", placeholder: "smtp.gmail.com" },
  { key: "port", label: "Puerto (465 SSL / 587 STARTTLS)", placeholder: "465" },
  { key: "user", label: "Usuario / correo", placeholder: "ventas@tudominio.com" },
  { key: "password", label: "Contraseña (en Gmail: contraseña de aplicación)", placeholder: "••••••••", secret: true },
  { key: "from_name", label: "Nombre del remitente (opcional)", placeholder: "Motor Advertising" },
  { key: "from_email", label: "Correo remitente (opcional, default: usuario)", placeholder: "ventas@tudominio.com" },
  { key: "max_per_hour", label: "Límite por hora (opcional, vacío = sin límite)", placeholder: "p.ej. 100" },
  { key: "max_per_day", label: "Límite por día (opcional, vacío = sin límite)", placeholder: "p.ej. 500" },
];

function statusChip(item: EmailItem) {
  if (item.sent === 1) return <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400">Enviado</span>;
  if (item.sent === 2) return <span title={item.error ?? ""} className="rounded bg-red-950 px-1.5 py-0.5 text-[10px] font-semibold text-red-400">Fallido</span>;
  return <span className="rounded bg-amber-950 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">Pendiente</span>;
}

export default function MailingPanel() {
  // ── Cuenta ──
  const [enabled, setEnabled] = useState(false);
  const [account, setAccount] = useState<Record<string, string>>({});
  const [accountBusy, setAccountBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

  // ── Redactar ──
  const [mode, setMode] = useState<"single" | "leads" | "manual">("single");
  const [to, setTo] = useState("");
  const [stages, setStages] = useState<LeadStage[]>([]);
  const [manualList, setManualList] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [isHtml, setIsHtml] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; text: string } | null>(null);

  // ── Estado ──
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [stageConfig, setStageConfig] = useState<StageConfigMap>(DEFAULT_STAGE_CONFIG);
  const [error, setError] = useState<string | null>(null);

  const loadAccount = async () => {
    try {
      const res = await fetch("/api/settings/channels", { cache: "no-store" });
      const data = (await res.json()) as {
        settings?: Record<string, { enabled: boolean; config: Record<string, string> }>;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setError(null);
      setEnabled(data.settings?.["email"]?.enabled ?? false);
      setAccount({ ...(data.settings?.["email"]?.config ?? {}) });
    } catch {
      setError("No se pudo cargar la configuración");
    }
  };

  useEffect(() => {
    loadAccount();
    fetch("/api/settings/stages", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { stages?: StageConfigMap } | null) => {
        if (data?.stages) setStageConfig(data.stages);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/mailing/status", { cache: "no-store" });
        const data = (await res.json()) as StatusPayload;
        if (active) setStatus(data);
      } catch {
        /* siguiente poll */
      }
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const saveAccount = async (nextEnabled: boolean) => {
    setAccountBusy(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/channels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "email", enabled: nextEnabled, config: account }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) setError(data?.error ?? "No se pudo guardar");
      else {
        setError(null);
        await loadAccount();
      }
    } catch {
      setError("Error de red al guardar");
    } finally {
      setAccountBusy(false);
    }
  };

  const testAccount = async () => {
    setAccountBusy(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/channels/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "email", config: account }),
      });
      const data = (await res.json()) as { ok?: boolean; detail?: string; error?: string };
      setTestResult({ ok: data.ok === true, detail: data.detail ?? data.error ?? "sin detalle" });
    } catch {
      setTestResult({ ok: false, detail: "Error de red" });
    } finally {
      setAccountBusy(false);
    }
  };

  const send = async () => {
    setSending(true);
    setSendResult(null);
    try {
      const res = await fetch("/api/mailing/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          to,
          stages,
          manualList,
          subject,
          body: bodyText,
          isHtml,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { queued?: number; error?: string }
        | null;
      if (!res.ok || !data?.queued) {
        setSendResult({ ok: false, text: data?.error ?? "No se pudo encolar" });
      } else {
        setSendResult({
          ok: true,
          text: `✓ ${data.queued} correo${data.queued === 1 ? "" : "s"} en cola — el bot los envía respetando tus límites`,
        });
        setSubject("");
        setBodyText("");
        setTo("");
        setManualList("");
      }
    } catch {
      setSendResult({ ok: false, text: "Error de red al enviar" });
    } finally {
      setSending(false);
    }
  };

  const toggleStage = (s: LeadStage) => {
    setStages((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  const canSend =
    subject.trim() !== "" &&
    bodyText.trim() !== "" &&
    (mode === "single" ? to.trim() !== "" : mode === "manual" ? manualList.trim() !== "" : true);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-2">
        {error && (
          <p className="rounded-lg bg-red-950 p-3 text-sm text-red-400 lg:col-span-2">{error}</p>
        )}

        {/* ── Cuenta de correo ── */}
        <div className={cardClass}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-neutral-100">Cuenta de correo (SMTP)</h2>
              <p className="mt-1 text-xs text-neutral-400">
                Gmail (con contraseña de aplicación), Outlook o tu dominio. Los límites son
                opcionales: si los dejas vacíos, no se aplica ninguno.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={enabled}
              disabled={accountBusy}
              onClick={() => {
                setEnabled(!enabled);
                saveAccount(!enabled);
              }}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                enabled ? "bg-emerald-600" : "bg-neutral-700"
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                  enabled ? "left-[22px]" : "left-0.5"
                }`}
              />
            </button>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {ACCOUNT_FIELDS.map((f) => (
              <div key={f.key} className={f.key === "host" || f.key === "user" ? "sm:col-span-2" : ""}>
                <label className={labelClass}>{f.label}</label>
                <input
                  type={f.secret ? "password" : "text"}
                  value={account[f.key] ?? ""}
                  onChange={(e) => setAccount((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  autoComplete="off"
                  className={inputClass}
                />
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button onClick={() => saveAccount(enabled)} disabled={accountBusy} className={btnPrimary}>
              {accountBusy ? "..." : "Guardar cuenta"}
            </button>
            <button onClick={testAccount} disabled={accountBusy} className={btnGhost}>
              Probar conexión
            </button>
          </div>
          {testResult && (
            <p
              className={`mt-2 rounded-lg p-2 text-xs ${
                testResult.ok ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"
              }`}
            >
              {testResult.ok ? "✓ " : "✕ "}
              {testResult.detail}
            </p>
          )}
        </div>

        {/* ── Redactar ── */}
        <div className={cardClass}>
          <h2 className="text-sm font-semibold text-neutral-100">Redactar</h2>
          <p className="mt-1 text-xs text-neutral-400">
            Variables de personalización: {"{{nombre}}"}, {"{{empresa}}"}, {"{{email}}"},{" "}
            {"{{etapa}}"} (se llenan con los datos del lead).
          </p>

          {/* Destinatarios */}
          <div className="mt-3 inline-flex overflow-hidden rounded-lg border border-neutral-700 text-xs font-medium">
            {(
              [
                ["single", "Un correo"],
                ["leads", "Masivo a leads"],
                ["manual", "Lista manual"],
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

          <div className="mt-3 space-y-2">
            {mode === "single" && (
              <div>
                <label className={labelClass}>Para</label>
                <input
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="cliente@correo.com"
                  className={inputClass}
                />
              </div>
            )}
            {mode === "leads" && (
              <div>
                <label className={labelClass}>
                  Etapas (vacío = todos los leads con email)
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {LEAD_STAGES.map((s) => (
                    <button
                      key={s}
                      onClick={() => toggleStage(s)}
                      className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        stages.includes(s)
                          ? "bg-emerald-600 text-white"
                          : "border border-neutral-700 text-neutral-400 hover:bg-neutral-800"
                      }`}
                    >
                      {stageConfig[s].label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {mode === "manual" && (
              <div>
                <label className={labelClass}>
                  Correos (separados por coma o salto de línea)
                </label>
                <textarea
                  value={manualList}
                  onChange={(e) => setManualList(e.target.value)}
                  rows={3}
                  placeholder={"uno@correo.com\ndos@correo.com"}
                  className={inputClass}
                />
              </div>
            )}

            <div>
              <label className={labelClass}>Asunto</label>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Hola {{nombre}}, tenemos algo para {{empresa}}"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Contenido</label>
              <textarea
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                rows={8}
                placeholder={isHtml ? "<h1>Hola {{nombre}}</h1><p>...</p>" : "Hola {{nombre}},\n\n..."}
                className={`${inputClass} font-mono text-xs`}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-neutral-400">
              <input
                type="checkbox"
                checked={isHtml}
                onChange={(e) => setIsHtml(e.target.checked)}
                className="h-3.5 w-3.5 accent-emerald-600"
              />
              El contenido es HTML (si no, el texto se convierte a HTML automáticamente)
            </label>

            <button onClick={send} disabled={sending || !canSend} className={`w-full ${btnPrimary}`}>
              {sending ? "Encolando..." : "Enviar"}
            </button>
            {sendResult && (
              <p
                className={`rounded-lg p-2 text-xs ${
                  sendResult.ok ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"
                }`}
              >
                {sendResult.text}
              </p>
            )}
          </div>
        </div>

        {/* ── Estado de la cola ── */}
        <div className={`${cardClass} lg:col-span-2`}>
          <h2 className="text-sm font-semibold text-neutral-100">Cola de envíos</h2>
          {status?.error ? (
            <p className="mt-2 rounded-lg bg-red-950 p-2 text-xs text-red-400">{status.error}</p>
          ) : (
            <>
              <div className="mt-3 flex flex-wrap gap-3">
                {[
                  ["Pendientes", status?.stats?.pending, "bg-amber-400"],
                  ["Enviados (24 h)", status?.stats?.sentLastDay, "bg-emerald-400"],
                  ["Fallidos", status?.stats?.failed, "bg-red-400"],
                ].map(([label, value, dot]) => (
                  <div
                    key={label as string}
                    className="min-w-32 flex-1 rounded-xl border border-neutral-800 bg-neutral-950 px-4 py-3"
                  >
                    <p className="flex items-center gap-1.5 text-xs text-neutral-400">
                      <span className={`h-2 w-2 rounded-full ${dot}`} />
                      {label}
                    </p>
                    <p className="mt-1 text-xl font-semibold text-neutral-100">{value ?? "—"}</p>
                  </div>
                ))}
              </div>

              <div className="mt-3 max-h-56 space-y-1 overflow-y-auto">
                {(status?.recent ?? []).map((e) => (
                  <div
                    key={e.id}
                    className="flex items-center justify-between gap-3 rounded-lg bg-neutral-950 px-3 py-1.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs text-neutral-200">{e.to_email}</p>
                      <p className="truncate text-[11px] text-neutral-500">{e.subject}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {e.error && e.sent === 2 && (
                        <span className="max-w-48 truncate text-[10px] text-red-500" title={e.error}>
                          {e.error}
                        </span>
                      )}
                      {statusChip(e)}
                    </div>
                  </div>
                ))}
                {(status?.recent ?? []).length === 0 && (
                  <p className="py-3 text-center text-xs text-neutral-600">Sin envíos todavía.</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
