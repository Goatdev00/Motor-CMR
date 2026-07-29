"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CalendarAttachment, CalendarEvent, FollowUpEntry } from "@/lib/db";

// ── Estilos compartidos (mismos patrones que el resto del dashboard) ──
const inputClass =
  "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-emerald-600";
const btnPrimary =
  "rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const btnGhost =
  "rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50";
const labelClass = "mb-1 block text-[11px] font-medium text-neutral-500";

// Misma paleta oscura curada del editor de etapas.
const PALETTE = [
  "#f87171", "#fb923c", "#fbbf24", "#facc15", "#a3e635", "#4ade80",
  "#34d399", "#2dd4bf", "#22d3ee", "#38bdf8", "#60a5fa", "#818cf8",
  "#a78bfa", "#c084fc", "#e879f9", "#f472b6", "#fb7185", "#94a3b8",
];

const MONTHS_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const WEEKDAYS_ES = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];

type CalView = "month" | "week" | "agenda";

interface LeadOption {
  id: number;
  name: string | null;
  phone: string | null;
  external_id: string | null;
  company: string | null;
}

interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  client_id: string;
  client_secret_mask: string;
  error?: string;
}

// ── Fechas (todo en hora local del operador) ────────────────

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

// Semana empezando en lunes (getDay: 0=domingo).
function mondayOf(d: Date): Date {
  return addDays(startOfDay(d), -((d.getDay() + 6) % 7));
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function epochToDateTimeInput(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "YYYY-MM-DDTHH:mm" (datetime-local) se interpreta como hora LOCAL.
function dateTimeInputToEpoch(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

// "YYYY-MM-DD" a secas lo parsearía como UTC: se arma la fecha local a mano.
function dateInputToEpoch(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  return Math.floor(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() / 1000);
}

function fmtTime(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDayLong(d: Date): string {
  const names = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  return `${names[d.getDay()]} ${d.getDate()} de ${MONTHS_ES[d.getMonth()]}`;
}

function leadLabel(lead: { name: string | null; phone: string | null; external_id: string | null; id: number }): string {
  return lead.name ?? lead.phone ?? lead.external_id ?? `Lead #${lead.id}`;
}

// ════════════════════════════════════════════════════════════
// Panel principal
// ════════════════════════════════════════════════════════════

export default function CalendarPanel() {
  const [view, setView] = useState<CalView>("month");
  // Fecha de referencia de la vista (cualquier día del mes/semana visible).
  const [cursor, setCursor] = useState<Date>(() => startOfDay(new Date()));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [followups, setFollowups] = useState<FollowUpEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [leads, setLeads] = useState<LeadOption[]>([]);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [googleOpen, setGoogleOpen] = useState(false);
  // null = cerrado; sin id = crear; con id = editar.
  const [modal, setModal] = useState<{ event: CalendarEvent | null; defaultStart: number } | null>(null);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);

  // Rango visible según la vista (mes: rejilla de 6 semanas desde lunes).
  const range = useMemo(() => {
    if (view === "month") {
      const first = mondayOf(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
      return { from: first, days: 42 };
    }
    if (view === "week") return { from: mondayOf(cursor), days: 7 };
    return { from: startOfDay(new Date()), days: 30 };
  }, [view, cursor]);

  // Guard anti-respuestas-obsoletas (mismo patrón que ConversationPanel).
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    const from = Math.floor(range.from.getTime() / 1000);
    const to = Math.floor(addDays(range.from, range.days).getTime() / 1000);
    try {
      const res = await fetch(`/api/calendar/events?from=${from}&to=${to}`, { cache: "no-store" });
      const data = (await res.json()) as {
        events?: CalendarEvent[];
        followups?: FollowUpEntry[];
        error?: string;
      };
      if (seq !== seqRef.current) return;
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setError(null);
      setEvents(data.events ?? []);
      setFollowups(data.followups ?? []);
    } catch {
      if (seq === seqRef.current) setError("No se pudo cargar el calendario");
    }
  }, [range]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);

  // Nunca deja `google` con campos undefined: un 500 de /api/google (p.ej.
  // migración pendiente) producía un GoogleStatus malformado y el modal
  // crasheaba en el render con client_id.trim().
  const loadGoogle = useCallback(async () => {
    const fallback = (msg: string): GoogleStatus => ({
      configured: false,
      connected: false,
      email: null,
      client_id: "",
      client_secret_mask: "",
      error: msg,
    });
    try {
      const res = await fetch("/api/google", { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as Partial<GoogleStatus> | null;
      if (!res.ok || !data) {
        setGoogle(fallback(data?.error ?? `No se pudo cargar el estado de Google (HTTP ${res.status})`));
        return;
      }
      setGoogle({
        configured: data.configured === true,
        connected: data.connected === true,
        email: data.email ?? null,
        client_id: data.client_id ?? "",
        client_secret_mask: data.client_secret_mask ?? "",
      });
    } catch {
      // Conserva el último estado bueno si lo hay; si no, uno seguro.
      setGoogle((prev) => prev ?? fallback("No se pudo contactar la API. Reintenta."));
    }
  }, []);

  useEffect(() => {
    loadGoogle();
    // Leads para poder ligar eventos (nombre en el select del modal).
    fetch("/api/crm", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { leads?: LeadOption[] } | null) => {
        if (data?.leads) setLeads(data.leads);
      })
      .catch(() => undefined);

    // Aviso al volver del OAuth de Google (?google=connected|denied|error).
    const params = new URLSearchParams(window.location.search);
    const result = params.get("google");
    if (result) {
      setBanner(
        result === "connected"
          ? { ok: true, text: "Cuenta de Google conectada correctamente" }
          : result === "denied"
            ? { ok: false, text: "Conexión cancelada: no diste permiso a la cuenta de Google" }
            : { ok: false, text: "No se pudo conectar la cuenta de Google. Revisa las credenciales y reintenta." }
      );
      window.history.replaceState(null, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Índices por día (expande eventos de varios días a cada celda que tocan).
  // La expansión se RECORTA al rango visible: sin el recorte, un evento más
  // largo que el tope de iteraciones gastaba el presupuesto en días fuera
  // de pantalla y desaparecía de los meses posteriores a su inicio.
  const { eventsByDay, followupsByDay } = useMemo(() => {
    const evMap = new Map<string, CalendarEvent[]>();
    const fuMap = new Map<string, FollowUpEntry[]>();
    const rangeStart = range.from;
    const rangeEnd = addDays(range.from, range.days - 1);
    for (const ev of events) {
      const evStart = startOfDay(new Date(ev.starts_at * 1000));
      const evEnd = startOfDay(new Date((ev.ends_at ?? ev.starts_at) * 1000));
      const start = evStart > rangeStart ? evStart : rangeStart;
      const end = evEnd < rangeEnd ? evEnd : rangeEnd;
      for (let d = start, i = 0; d <= end && i < 62; d = addDays(d, 1), i++) {
        const key = dayKey(d);
        if (!evMap.has(key)) evMap.set(key, []);
        evMap.get(key)!.push(ev);
      }
    }
    for (const fu of followups) {
      const key = dayKey(new Date(fu.next_follow_up_at * 1000));
      if (!fuMap.has(key)) fuMap.set(key, []);
      fuMap.get(key)!.push(fu);
    }
    return { eventsByDay: evMap, followupsByDay: fuMap };
  }, [events, followups, range]);

  const navigate = (dir: -1 | 1) => {
    setCursor((prev) =>
      view === "month"
        ? new Date(prev.getFullYear(), prev.getMonth() + dir, 1)
        : addDays(prev, dir * 7)
    );
  };

  const openCreate = (day: Date, hour = 9) => {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
    setModal({ event: null, defaultStart: Math.floor(start.getTime() / 1000) });
  };

  // Desplaza un epoch N días conservando la HORA DE PARED local: sumar
  // deltaDays*86400 corría la hora (y el día, en eventos de día completo)
  // al cruzar un cambio de horario de verano.
  const shiftDaysLocal = (epoch: number, deltaDays: number): number => {
    const d = new Date(epoch * 1000);
    const shifted = new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate() + deltaDays,
      d.getHours(),
      d.getMinutes(),
      d.getSeconds()
    );
    return Math.floor(shifted.getTime() / 1000);
  };

  // Soltar un evento en otro día: conserva la hora, desplaza inicio y fin.
  // El delta se calcula desde el DÍA DEL CHIP arrastrado (un evento
  // multi-día tiene un chip por día; medir desde el inicio del evento movía
  // de más los chips intermedios).
  const onDropOnDay = async (e: React.DragEvent, day: Date) => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData("application/x-cal-event"));
    const ev = events.find((x) => x.id === id);
    if (!ev) return;
    const sourceDayMs = Number(e.dataTransfer.getData("application/x-cal-day"));
    const originMs = Number.isFinite(sourceDayMs) && sourceDayMs > 0
      ? sourceDayMs
      : startOfDay(new Date(ev.starts_at * 1000)).getTime();
    const deltaDays = Math.round((day.getTime() - originMs) / 86400000);
    if (deltaDays === 0) return;
    const starts_at = shiftDaysLocal(ev.starts_at, deltaDays);
    const ends_at = ev.ends_at === null ? null : shiftDaysLocal(ev.ends_at, deltaDays);
    let failMsg: string | null = null;
    try {
      const res = await fetch(`/api/calendar/events/${ev.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starts_at, ends_at }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        failMsg = data?.error ?? "No se pudo mover el evento";
      }
    } catch {
      failMsg = "Error de red al mover el evento";
    }
    // Recargar primero: el camino de éxito de load() limpia `error`, así
    // que el mensaje del fallo se fija DESPUÉS para que no lo borre.
    await load();
    if (failMsg) setError(`${failMsg} — el evento vuelve a su fecha original`);
  };

  const title =
    view === "month"
      ? `${MONTHS_ES[cursor.getMonth()]} ${cursor.getFullYear()}`
      : view === "week"
        ? `${mondayOf(cursor).getDate()} – ${addDays(mondayOf(cursor), 6).getDate()} de ${MONTHS_ES[addDays(mondayOf(cursor), 6).getMonth()]} ${addDays(mondayOf(cursor), 6).getFullYear()}`
        : "Próximos 30 días";

  const todayKey = dayKey(new Date());

  // ── Chips reutilizados por las vistas mes y semana ──
  // `day` es la celda donde vive el chip: es el origen del drag&drop.
  const eventChip = (ev: CalendarEvent, withTime: boolean, day: Date) => (
    <button
      key={`ev-${ev.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-cal-event", String(ev.id));
        e.dataTransfer.setData("application/x-cal-day", String(day.getTime()));
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={(e) => {
        e.stopPropagation();
        setModal({ event: ev, defaultStart: ev.starts_at });
      }}
      title={ev.title}
      className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] leading-4 text-neutral-100 transition-opacity hover:opacity-80"
      style={{ backgroundColor: `${ev.color}26`, borderLeft: `2px solid ${ev.color}` }}
    >
      {withTime && !ev.all_day ? (
        <span className="mr-1 text-neutral-400">{fmtTime(ev.starts_at)}</span>
      ) : null}
      {ev.title}
    </button>
  );

  const followupChip = (fu: FollowUpEntry) => (
    <div
      key={`fu-${fu.id}`}
      title={`Seguimiento automático · ${leadLabel(fu)}${fu.follow_up_note ? ` — ${fu.follow_up_note}` : ""}`}
      className="block w-full truncate rounded border-l-2 border-amber-500 bg-amber-950/40 px-1.5 py-0.5 text-[11px] leading-4 text-amber-300"
    >
      <span className="mr-1 text-amber-500/80">{fmtTime(fu.next_follow_up_at)}</span>
      Seguimiento · {leadLabel(fu)}
    </div>
  );

  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto flex max-w-6xl flex-col gap-3">
        {banner && (
          <p
            className={`flex items-center justify-between rounded-lg p-3 text-sm ${
              banner.ok ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"
            }`}
          >
            {banner.text}
            <button onClick={() => setBanner(null)} className="ml-3 text-xs opacity-70 hover:opacity-100">
              ✕
            </button>
          </p>
        )}
        {error && <p className="rounded-lg bg-red-950 p-3 text-sm text-red-400">{error}</p>}

        {/* ── Barra de herramientas ── */}
        <div className="flex flex-wrap items-center gap-2">
          {view !== "agenda" && (
            <div className="flex items-center gap-1">
              <button onClick={() => navigate(-1)} className={btnGhost} title="Anterior">
                ‹
              </button>
              <button onClick={() => setCursor(startOfDay(new Date()))} className={btnGhost}>
                Hoy
              </button>
              <button onClick={() => navigate(1)} className={btnGhost} title="Siguiente">
                ›
              </button>
            </div>
          )}
          <h2 className="text-base font-semibold capitalize text-neutral-100">{title}</h2>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="inline-flex overflow-hidden rounded-lg border border-neutral-700 text-xs font-medium">
              {(
                [
                  ["month", "Mes"],
                  ["week", "Semana"],
                  ["agenda", "Agenda"],
                ] as const
              ).map(([key, label], i) => (
                <button
                  key={key}
                  onClick={() => setView(key)}
                  className={`px-3 py-1.5 transition-colors ${i > 0 ? "border-l border-neutral-700" : ""} ${
                    view === key
                      ? "bg-neutral-100 text-neutral-900"
                      : "bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <button
              onClick={() => {
                // Refresca el estado al abrir: si la carga inicial falló,
                // este es el camino de reintento.
                loadGoogle();
                setGoogleOpen(true);
              }}
              className={`${btnGhost} flex items-center gap-2`}
            >
              <span
                className={`h-2 w-2 rounded-full ${google?.connected ? "bg-emerald-500" : "bg-neutral-600"}`}
              />
              Google Drive
            </button>
            <button onClick={() => openCreate(cursor)} className={btnPrimary}>
              + Nuevo evento
            </button>
          </div>
        </div>

        {/* ── Vista MES ── */}
        {view === "month" && (
          <div className="overflow-hidden rounded-xl border border-neutral-800">
            <div className="grid grid-cols-7 border-b border-neutral-800 bg-neutral-900">
              {WEEKDAYS_ES.map((d) => (
                <div key={d} className="px-2 py-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {Array.from({ length: 42 }, (_, i) => {
                const day = addDays(range.from, i);
                const key = dayKey(day);
                const inMonth = day.getMonth() === cursor.getMonth();
                const dayEvents = eventsByDay.get(key) ?? [];
                const dayFollowups = followupsByDay.get(key) ?? [];
                // "+N más" cuenta lo realmente oculto: se muestran hasta 1
                // seguimiento y 2-3 eventos, no siempre 3 elementos.
                const shownFu = Math.min(dayFollowups.length, 1);
                const shownEv = Math.min(dayEvents.length, dayFollowups.length > 0 ? 2 : 3);
                const extra = dayEvents.length + dayFollowups.length - shownFu - shownEv;
                return (
                  <div
                    key={key}
                    onClick={() => openCreate(day)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => onDropOnDay(e, day)}
                    className={`min-h-28 cursor-pointer border-b border-r border-neutral-800/70 p-1.5 transition-colors hover:bg-neutral-900/60 ${
                      inMonth ? "bg-neutral-950" : "bg-neutral-950/40"
                    }`}
                  >
                    <div className="mb-1 flex justify-end">
                      <span
                        className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                          key === todayKey
                            ? "bg-emerald-600 font-semibold text-white"
                            : inMonth
                              ? "text-neutral-400"
                              : "text-neutral-700"
                        }`}
                      >
                        {day.getDate()}
                      </span>
                    </div>
                    <div className="space-y-0.5">
                      {dayFollowups.slice(0, 1).map(followupChip)}
                      {dayEvents.slice(0, shownEv).map((ev) => eventChip(ev, true, day))}
                      {extra > 0 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setCursor(day);
                            setView("week");
                          }}
                          className="block w-full truncate rounded px-1.5 text-left text-[11px] text-neutral-500 hover:text-neutral-300"
                        >
                          +{extra} más
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Vista SEMANA ── */}
        {view === "week" && (
          <div className="overflow-hidden rounded-xl border border-neutral-800">
            <div className="grid grid-cols-7">
              {Array.from({ length: 7 }, (_, i) => {
                const day = addDays(range.from, i);
                const key = dayKey(day);
                const dayEvents = eventsByDay.get(key) ?? [];
                const dayFollowups = followupsByDay.get(key) ?? [];
                return (
                  <div key={key} className={`border-r border-neutral-800/70 last:border-r-0 ${key === todayKey ? "bg-emerald-950/20" : "bg-neutral-950"}`}>
                    <div className="border-b border-neutral-800 bg-neutral-900 px-2 py-1.5 text-center">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                        {WEEKDAYS_ES[i]}
                      </p>
                      <p className={`text-sm font-semibold ${key === todayKey ? "text-emerald-400" : "text-neutral-200"}`}>
                        {day.getDate()}
                      </p>
                    </div>
                    <div
                      onClick={() => openCreate(day)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => onDropOnDay(e, day)}
                      className="min-h-72 cursor-pointer space-y-1 p-1.5 transition-colors hover:bg-neutral-900/40"
                    >
                      {dayFollowups.map(followupChip)}
                      {dayEvents
                        .slice()
                        .sort((a, b) => a.starts_at - b.starts_at)
                        .map((ev) => eventChip(ev, true, day))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Vista AGENDA ── */}
        {view === "agenda" && (
          <div className="space-y-3">
            {Array.from({ length: 30 }, (_, i) => addDays(range.from, i))
              .filter((day) => (eventsByDay.get(dayKey(day)) ?? []).length > 0 || (followupsByDay.get(dayKey(day)) ?? []).length > 0)
              .map((day) => {
                const key = dayKey(day);
                const dayEvents = (eventsByDay.get(key) ?? []).slice().sort((a, b) => a.starts_at - b.starts_at);
                const dayFollowups = followupsByDay.get(key) ?? [];
                return (
                  <div key={key} className="rounded-xl border border-neutral-800 bg-neutral-900 p-3">
                    <p className={`mb-2 text-xs font-semibold uppercase tracking-wide ${key === todayKey ? "text-emerald-400" : "text-neutral-400"}`}>
                      {key === todayKey ? "Hoy · " : ""}
                      {fmtDayLong(day)}
                    </p>
                    <div className="space-y-1">
                      {dayFollowups.map((fu) => (
                        <div key={`fu-${fu.id}`} className="flex items-center gap-3 rounded-lg bg-neutral-950 px-3 py-2">
                          <span className="w-12 shrink-0 text-xs text-amber-500">{fmtTime(fu.next_follow_up_at)}</span>
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500" />
                          <div className="min-w-0">
                            <p className="truncate text-sm text-amber-300">Seguimiento automático · {leadLabel(fu)}</p>
                            {fu.follow_up_note && (
                              <p className="truncate text-xs text-neutral-500">{fu.follow_up_note}</p>
                            )}
                          </div>
                        </div>
                      ))}
                      {dayEvents.map((ev) => (
                        <button
                          key={`ev-${ev.id}`}
                          onClick={() => setModal({ event: ev, defaultStart: ev.starts_at })}
                          className="flex w-full items-center gap-3 rounded-lg bg-neutral-950 px-3 py-2 text-left transition-colors hover:bg-neutral-800/60"
                        >
                          <span className="w-12 shrink-0 text-xs text-neutral-400">
                            {ev.all_day ? "Día" : fmtTime(ev.starts_at)}
                          </span>
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: ev.color }} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-neutral-100">{ev.title}</p>
                            {(ev.location || ev.description) && (
                              <p className="truncate text-xs text-neutral-500">
                                {[ev.location, ev.description].filter(Boolean).join(" — ")}
                              </p>
                            )}
                          </div>
                          {ev.attachments.length > 0 && (
                            <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                              {ev.attachments.length} adjunto{ev.attachments.length === 1 ? "" : "s"}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            {events.length === 0 && followups.length === 0 && (
              <p className="rounded-xl border border-neutral-800 bg-neutral-900 py-10 text-center text-sm text-neutral-600">
                Nada agendado en los próximos 30 días. Crea un evento con “+ Nuevo evento”.
              </p>
            )}
          </div>
        )}
      </div>

      {modal && (
        <EventModal
          event={modal.event}
          defaultStart={modal.defaultStart}
          leads={leads}
          googleConnected={google?.connected ?? false}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            load();
          }}
        />
      )}

      {googleOpen && google && (
        <GoogleDriveModal
          status={google}
          onClose={() => setGoogleOpen(false)}
          onChanged={loadGoogle}
        />
      )}
    </main>
  );
}

// ════════════════════════════════════════════════════════════
// Modal de evento (crear / editar)
// ════════════════════════════════════════════════════════════

interface EventModalProps {
  event: CalendarEvent | null;
  defaultStart: number;
  leads: LeadOption[];
  googleConnected: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function EventModal({ event, defaultStart, leads, googleConnected, onClose, onSaved }: EventModalProps) {
  const [title, setTitle] = useState(event?.title ?? "");
  const [allDay, setAllDay] = useState(event?.all_day ?? false);
  const [start, setStart] = useState(epochToDateTimeInput(event?.starts_at ?? defaultStart));
  const [end, setEnd] = useState(event?.ends_at ? epochToDateTimeInput(event.ends_at) : "");
  const [color, setColor] = useState(event?.color ?? "#34d399");
  const [description, setDescription] = useState(event?.description ?? "");
  const [location, setLocation] = useState(event?.location ?? "");
  const [conversationId, setConversationId] = useState<number | null>(event?.conversation_id ?? null);
  const [attachments, setAttachments] = useState<CalendarAttachment[]>(event?.attachments ?? []);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Búsqueda en Drive
  const [driveQuery, setDriveQuery] = useState("");
  const [driveResults, setDriveResults] = useState<{ id: string; name: string; webViewLink?: string }[]>([]);
  const [driveBusy, setDriveBusy] = useState(false);
  const [driveError, setDriveError] = useState<string | null>(null);

  const searchDrive = async () => {
    if (!driveQuery.trim()) return;
    setDriveBusy(true);
    setDriveError(null);
    try {
      const res = await fetch(`/api/google/drive/search?q=${encodeURIComponent(driveQuery.trim())}`, {
        cache: "no-store",
      });
      const data = (await res.json()) as {
        files?: { id: string; name: string; webViewLink?: string }[];
        error?: string;
      };
      if (!res.ok) setDriveError(data.error ?? "No se pudo buscar");
      else setDriveResults(data.files ?? []);
    } catch {
      setDriveError("Error de red al buscar en Drive");
    } finally {
      setDriveBusy(false);
    }
  };

  const addAttachment = (file: { id: string; name: string; webViewLink?: string }) => {
    setAttachments((prev) =>
      prev.some((a) => a.id === file.id) || prev.length >= 10
        ? prev
        : [...prev, { id: file.id, name: file.name, link: file.webViewLink ?? "" }]
    );
  };

  const save = async () => {
    setError(null);
    if (!title.trim()) {
      setError("El título es obligatorio");
      return;
    }
    const starts_at = allDay ? dateInputToEpoch(start) : dateTimeInputToEpoch(start);
    if (!starts_at) {
      setError("La fecha de inicio es obligatoria");
      return;
    }
    let ends_at: number | null = null;
    if (end) {
      ends_at = allDay ? dateInputToEpoch(end) : dateTimeInputToEpoch(end);
      if (ends_at !== null && ends_at < starts_at) {
        setError("La fecha de fin no puede ser anterior al inicio");
        return;
      }
      if (ends_at === starts_at) ends_at = null;
    }

    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        starts_at,
        ends_at,
        all_day: allDay,
        color,
        description,
        location,
        conversation_id: conversationId,
        attachments,
      };
      const res = await fetch(event ? `/api/calendar/events/${event.id}` : "/api/calendar/events", {
        method: event ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? "No se pudo guardar el evento");
        return;
      }
      onSaved();
    } catch {
      setError("Error de red al guardar");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!event) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/calendar/events/${event.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "No se pudo eliminar");
        return;
      }
      onSaved();
    } catch {
      setError("Error de red al eliminar");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl">
        <div className="border-b border-neutral-800 px-6 py-4">
          <h2 className="text-base font-semibold text-neutral-100">
            {event ? "Editar evento" : "Nuevo evento"}
          </h2>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4">
          <div>
            <label className={labelClass}>Título</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              placeholder="Reunión con cliente"
              autoFocus
              className={inputClass}
            />
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-neutral-400">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => setAllDay(e.target.checked)}
                className="h-3.5 w-3.5 accent-emerald-600"
              />
              Todo el día
            </label>

            {/* Color: paleta oscura propia */}
            <div className="relative">
              <button
                onClick={() => setPickerOpen(!pickerOpen)}
                title="Color del evento"
                className="flex h-7 w-7 items-center justify-center rounded-lg border border-neutral-700 transition-colors hover:border-neutral-500"
              >
                <span className="h-3.5 w-3.5 rounded-full" style={{ backgroundColor: color }} />
              </button>
              {pickerOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setPickerOpen(false)} />
                  <div className="absolute left-0 top-full z-20 mt-1.5 rounded-xl border border-neutral-700 bg-neutral-950 p-2.5 shadow-2xl">
                    <div className="grid grid-cols-6 gap-1.5">
                      {PALETTE.map((c) => (
                        <button
                          key={c}
                          onClick={() => {
                            setColor(c);
                            setPickerOpen(false);
                          }}
                          title={c}
                          className={`flex h-7 w-7 items-center justify-center rounded-lg transition-transform hover:scale-110 ${
                            color === c ? "ring-2 ring-white/80 ring-offset-2 ring-offset-neutral-950" : ""
                          }`}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Inicio</label>
              <input
                type={allDay ? "date" : "datetime-local"}
                value={allDay ? start.slice(0, 10) : start}
                onChange={(e) => setStart(allDay ? `${e.target.value}T09:00` : e.target.value)}
                className={`${inputClass} [color-scheme:dark]`}
              />
            </div>
            <div>
              <label className={labelClass}>Fin (opcional)</label>
              <input
                type={allDay ? "date" : "datetime-local"}
                value={allDay ? end.slice(0, 10) : end}
                onChange={(e) => setEnd(e.target.value ? (allDay ? `${e.target.value}T09:00` : e.target.value) : "")}
                className={`${inputClass} [color-scheme:dark]`}
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>Lead vinculado (opcional)</label>
            <select
              value={conversationId ?? ""}
              onChange={(e) => setConversationId(e.target.value ? Number(e.target.value) : null)}
              className={inputClass}
            >
              <option value="">— Sin lead —</option>
              {leads.map((lead) => (
                <option key={lead.id} value={lead.id}>
                  {leadLabel(lead)}
                  {lead.company ? ` · ${lead.company}` : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass}>Lugar (opcional)</label>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              maxLength={300}
              placeholder="Oficina / Meet / dirección"
              className={inputClass}
            />
          </div>

          <div>
            <label className={labelClass}>Descripción (opcional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={5000}
              className={inputClass}
            />
          </div>

          {/* Adjuntos de Google Drive */}
          <div>
            <label className={labelClass}>Archivos de Google Drive</label>
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {attachments.map((a) => (
                  <span
                    key={a.id}
                    className="flex items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-950 px-2.5 py-1 text-[11px] text-neutral-300"
                  >
                    {a.link ? (
                      <a href={a.link} target="_blank" rel="noreferrer" className="max-w-40 truncate hover:text-emerald-400 hover:underline">
                        {a.name}
                      </a>
                    ) : (
                      <span className="max-w-40 truncate">{a.name}</span>
                    )}
                    <button
                      onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                      className="text-neutral-500 hover:text-red-400"
                      title="Quitar"
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            {googleConnected ? (
              <>
                <div className="flex gap-2">
                  <input
                    value={driveQuery}
                    onChange={(e) => setDriveQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        searchDrive();
                      }
                    }}
                    placeholder="Buscar en tu Drive…"
                    className={inputClass}
                  />
                  <button onClick={searchDrive} disabled={driveBusy || !driveQuery.trim()} className={btnGhost}>
                    {driveBusy ? "..." : "Buscar"}
                  </button>
                </div>
                {driveError && <p className="mt-1 text-xs text-red-400">{driveError}</p>}
                {driveResults.length > 0 && (
                  <div className="mt-2 max-h-32 space-y-0.5 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950 p-1">
                    {driveResults.map((f) => (
                      <button
                        key={f.id}
                        onClick={() => addAttachment(f)}
                        className="block w-full truncate rounded px-2 py-1 text-left text-xs text-neutral-300 hover:bg-neutral-800"
                        title={f.name}
                      >
                        + {f.name}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-neutral-600">
                Conecta tu cuenta de Google (botón “Google Drive” del calendario) para adjuntar archivos.
              </p>
            )}
          </div>

          {error && <p className="rounded-lg bg-red-950 p-2 text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex items-center justify-between border-t border-neutral-800 px-6 py-4">
          {event ? (
            confirmingDelete ? (
              <div className="flex items-center gap-2">
                <button onClick={remove} disabled={saving} className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                  Sí, eliminar
                </button>
                <button onClick={() => setConfirmingDelete(false)} disabled={saving} className="text-xs text-neutral-500 hover:text-neutral-300">
                  Cancelar
                </button>
              </div>
            ) : (
              <button onClick={() => setConfirmingDelete(true)} className="text-xs text-red-500 underline-offset-2 hover:underline">
                Eliminar evento
              </button>
            )
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button onClick={onClose} disabled={saving} className={btnGhost}>
              Cancelar
            </button>
            <button onClick={save} disabled={saving} className={btnPrimary}>
              {saving ? "Guardando..." : "Guardar"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// Modal de Google Drive (credenciales, conexión, respaldo .ics)
// ════════════════════════════════════════════════════════════

interface GoogleModalProps {
  status: GoogleStatus;
  onClose: () => void;
  onChanged: () => void;
}

function GoogleDriveModal({ status, onClose, onChanged }: GoogleModalProps) {
  const [clientId, setClientId] = useState(status.client_id);
  const [clientSecret, setClientSecret] = useState(status.client_secret_mask);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [exportResult, setExportResult] = useState<{ ok: boolean; text: string; link?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const redirectUri =
    typeof window !== "undefined" ? `${window.location.origin}/api/google/callback` : "";

  const copyRedirect = async () => {
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard bloqueado: el usuario puede seleccionar el texto */
    }
  };

  const saveCredentials = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/google", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
      });
      const data = (await res.json().catch(() => null)) as
        | { error?: string; client_secret_mask?: string }
        | null;
      if (!res.ok) {
        setMessage({ ok: false, text: data?.error ?? "No se pudo guardar" });
        return;
      }
      if (data?.client_secret_mask) setClientSecret(data.client_secret_mask);
      setMessage({ ok: true, text: "Credenciales guardadas. Ahora pulsa “Conectar con Google”." });
      onChanged();
    } catch {
      setMessage({ ok: false, text: "Error de red al guardar" });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/google", { method: "DELETE" });
      if (!res.ok) {
        setMessage({ ok: false, text: "No se pudo desconectar" });
        return;
      }
      setMessage({ ok: true, text: "Cuenta desconectada" });
      onChanged();
    } catch {
      setMessage({ ok: false, text: "Error de red" });
    } finally {
      setBusy(false);
    }
  };

  const exportToDrive = async () => {
    setBusy(true);
    setExportResult(null);
    try {
      const res = await fetch("/api/calendar/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Con la zona horaria del navegador, las fechas de los eventos de
        // día completo salen exactas en el .ics para cualquier zona.
        body: JSON.stringify({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; count?: number; link?: string | null; error?: string }
        | null;
      if (!res.ok || !data?.ok) {
        setExportResult({ ok: false, text: data?.error ?? "No se pudo exportar" });
      } else {
        setExportResult({
          ok: true,
          text: `Respaldo guardado en Drive (carpeta AGENTE, ${data.count} evento${data.count === 1 ? "" : "s"}).`,
          link: data.link ?? undefined,
        });
      }
    } catch {
      setExportResult({ ok: false, text: "Error de red al exportar" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl">
        <div className="border-b border-neutral-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-neutral-100">Google Drive</h2>
            {status.connected && (
              <span className="flex items-center gap-1.5 rounded-full bg-emerald-950 px-2.5 py-1 text-xs font-medium text-emerald-400">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                {status.email ?? "Conectado"}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-neutral-500">
            Conecta tu cuenta para adjuntar archivos de Drive a los eventos y guardar respaldos
            del calendario (.ics, importable en Google Calendar).
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {status.error && (
            <p className="rounded-lg bg-red-950 p-2 text-xs text-red-400">{status.error}</p>
          )}

          {/* Credenciales OAuth */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              1 · Credenciales (Google Cloud)
            </h3>
            <ol className="mt-1.5 list-inside list-decimal space-y-0.5 text-xs text-neutral-500">
              <li>
                En{" "}
                <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" className="text-emerald-500 hover:underline">
                  console.cloud.google.com
                </a>{" "}
                crea un proyecto → “Credenciales” → “ID de cliente de OAuth” (aplicación web).
              </li>
              <li>En la pantalla de consentimiento agrega tu correo como usuario de prueba.</li>
              <li>Registra esta URI de redirección autorizada:</li>
            </ol>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-xs text-neutral-300">
                {redirectUri}
              </code>
              <button onClick={copyRedirect} className={btnGhost}>
                {copied ? "✓ Copiado" : "Copiar"}
              </button>
            </div>

            <div className="mt-2 space-y-2">
              <div>
                <label className={labelClass}>Client ID</label>
                <input
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="xxxxx.apps.googleusercontent.com"
                  autoComplete="off"
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Client Secret</label>
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="GOCSPX-..."
                  autoComplete="off"
                  className={inputClass}
                />
              </div>
              <button onClick={saveCredentials} disabled={busy || !clientId.trim() || !clientSecret.trim()} className={btnGhost}>
                Guardar credenciales
              </button>
            </div>
          </div>

          {/* Conexión */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              2 · Cuenta
            </h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <a
                href="/api/google/auth"
                className={`${btnPrimary} ${!status.configured ? "pointer-events-none opacity-50" : ""}`}
              >
                {status.connected ? "Reconectar con Google" : "Conectar con Google"}
              </a>
              {status.connected && (
                <button onClick={disconnect} disabled={busy} className={btnGhost}>
                  Desconectar cuenta
                </button>
              )}
            </div>
            {!status.configured && (
              <p className="mt-1.5 text-xs text-neutral-600">Guarda primero las credenciales del paso 1.</p>
            )}
          </div>

          {/* Respaldo */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              3 · Respaldo del calendario
            </h3>
            <p className="mt-1 text-xs text-neutral-500">
              Sube todos los eventos como <span className="text-neutral-300">calendario-agente.ics</span> a
              la carpeta AGENTE de tu Drive (reemplaza el respaldo anterior).
            </p>
            <button onClick={exportToDrive} disabled={busy || !status.connected} className={`${btnGhost} mt-2`}>
              {busy ? "..." : "Guardar respaldo en Drive"}
            </button>
            {exportResult && (
              <p className={`mt-2 rounded-lg p-2 text-xs ${exportResult.ok ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"}`}>
                {exportResult.text}
                {exportResult.link && (
                  <>
                    {" "}
                    <a href={exportResult.link} target="_blank" rel="noreferrer" className="underline">
                      Ver en Drive
                    </a>
                  </>
                )}
              </p>
            )}
          </div>

          {message && (
            <p className={`rounded-lg p-2 text-xs ${message.ok ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"}`}>
              {message.text}
            </p>
          )}
        </div>

        <div className="flex justify-end border-t border-neutral-800 px-6 py-4">
          <button onClick={onClose} className={btnGhost}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
