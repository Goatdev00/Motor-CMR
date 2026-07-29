"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationWithPreview } from "@/lib/db";
import {
  CHANNEL_BADGE_CLASS,
  CHANNEL_LABELS,
  conversationDisplayName,
  isChannel,
  type Channel,
} from "@/lib/channels";
import { DEFAULT_STAGE_CONFIG, type StageConfigMap } from "@/lib/stages";

// Sección Leads: reúne todo lo que entra por la API pública del CRM y lo que
// el operador importa de archivos CSV/Excel, y desde aquí se contacta a cada
// lead (o a una selección) por correo — con "Responder a" configurable — o
// generando mensajes para WhatsApp, Instagram, Facebook e iMessage.

const inputClass =
  "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-emerald-600";
const btnPrimary =
  "rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50";
const btnGhost =
  "rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50";
const labelClass = "mb-1 block text-[11px] font-medium text-neutral-500";

type Filter = "todos" | "importados" | "api" | "con_email" | "con_telefono";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "todos", label: "Todos" },
  { key: "importados", label: "Importados" },
  { key: "api", label: "Vía API" },
  { key: "con_email", label: "Con correo" },
  { key: "con_telefono", label: "Con teléfono" },
];

// Canales del compositor. 'messenger' se muestra como Facebook; iMessage no
// tiene envío directo desde el servidor (se genera y se copia).
type ComposeChannel = "email" | "whatsapp" | "instagram" | "messenger" | "imessage";

const COMPOSE_TABS: { key: ComposeChannel; label: string }[] = [
  { key: "email", label: "Correo" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "instagram", label: "Instagram" },
  { key: "messenger", label: "Facebook" },
  { key: "imessage", label: "iMessage" },
];

interface Props {
  // Saltar al hilo del lead en la pestaña Chats (canales con conversación).
  onOpenLead?: (id: number) => void;
}

export default function LeadsHubPanel({ onOpenLead }: Props) {
  const [leads, setLeads] = useState<ConversationWithPreview[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("todos");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [stageConfig, setStageConfig] = useState<StageConfigMap>(DEFAULT_STAGE_CONFIG);
  const [defaultReplyTo, setDefaultReplyTo] = useState("");

  const [importOpen, setImportOpen] = useState(false);
  // Compositor: leads objetivo (1 = individual con todos los canales;
  // varios = correo masivo).
  const [composeTargets, setComposeTargets] = useState<ConversationWithPreview[] | null>(null);

  const loadLeads = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations", { cache: "no-store" });
      const data = (await res.json()) as {
        conversations?: ConversationWithPreview[];
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setError(null);
      setLeads(data.conversations ?? []);
    } catch {
      setError("No se pudo cargar la lista de leads");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadLeads();
    const timer = setInterval(loadLeads, 10000);
    return () => clearInterval(timer);
  }, [loadLeads]);

  useEffect(() => {
    fetch("/api/settings/stages", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { stages?: StageConfigMap } | null) => {
        if (data?.stages) setStageConfig(data.stages);
      })
      .catch(() => undefined);
    fetch("/api/leads-hub/settings", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { replyTo?: string } | null) => {
        if (data?.replyTo) setDefaultReplyTo(data.replyTo);
      })
      .catch(() => undefined);
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads.filter((l) => {
      if (filter === "importados" && !(l.tags ?? []).includes("importado")) return false;
      if (filter === "api" && l.channel !== "api") return false;
      if (filter === "con_email" && !l.email) return false;
      if (filter === "con_telefono" && !l.phone) return false;
      if (!q) return true;
      return [l.name, l.company, l.email, l.phone]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q));
    });
  }, [leads, filter, search]);

  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allVisibleSelected = visible.length > 0 && visible.every((l) => selected.has(l.id));
  const toggleAllVisible = () => {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const l of visible) next.delete(l.id);
        return next;
      }
      return new Set([...prev, ...visible.map((l) => l.id)]);
    });
  };

  const selectedLeads = useMemo(
    () => leads.filter((l) => selected.has(l.id)),
    [leads, selected]
  );
  const selectedWithEmail = selectedLeads.filter((l) => !!l.email).length;

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-3">
        {error && <p className="rounded-lg bg-red-950 p-3 text-sm text-red-400">{error}</p>}

        {/* ── Barra de acciones ── */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  filter === f.key
                    ? "bg-emerald-600 text-white"
                    : "border border-neutral-700 text-neutral-400 hover:bg-neutral-800"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar nombre, empresa, correo o teléfono..."
            className={`${inputClass} max-w-xs flex-1`}
          />
          <div className="ml-auto flex items-center gap-2">
            {selected.size > 0 && (
              <button
                onClick={() => setComposeTargets(selectedLeads)}
                className={btnPrimary}
                title={`${selectedWithEmail} de ${selected.size} seleccionados tienen correo`}
              >
                ✉ Correo a {selected.size} seleccionado{selected.size === 1 ? "" : "s"}
              </button>
            )}
            <button onClick={() => setImportOpen(true)} className={btnGhost}>
              ⬆ Importar CSV/Excel
            </button>
          </div>
        </div>

        {/* ── Tabla ── */}
        <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-neutral-800 bg-neutral-900">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="sticky top-0 z-10 bg-neutral-900 text-[11px] uppercase tracking-wide text-neutral-500">
              <tr className="border-b border-neutral-800">
                <th className="w-8 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    className="h-3.5 w-3.5 accent-emerald-600"
                  />
                </th>
                <th className="px-3 py-2.5 font-medium">Lead</th>
                <th className="px-3 py-2.5 font-medium">Contacto</th>
                <th className="px-3 py-2.5 font-medium">Canal</th>
                <th className="px-3 py-2.5 font-medium">Etapa</th>
                <th className="px-3 py-2.5 font-medium">Origen</th>
                <th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((l) => {
                const channel = isChannel(l.channel) ? (l.channel as Channel) : "api";
                const imported = (l.tags ?? []).includes("importado");
                const stage = stageConfig[l.stage] ?? { label: l.stage, color: "#a3a3a3" };
                return (
                  <tr
                    key={l.id}
                    className="border-b border-neutral-800/60 transition-colors hover:bg-neutral-800/40"
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(l.id)}
                        onChange={() => toggleSelected(l.id)}
                        className="h-3.5 w-3.5 accent-emerald-600"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <p className="font-medium text-neutral-100">{conversationDisplayName(l)}</p>
                      {l.company && <p className="text-xs text-neutral-500">{l.company}</p>}
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-300">
                      {l.email && <p className="truncate">{l.email}</p>}
                      {l.phone && <p className="text-neutral-500">+{l.phone}</p>}
                      {!l.email && !l.phone && <p className="text-neutral-600">—</p>}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${CHANNEL_BADGE_CLASS[channel]}`}
                      >
                        {CHANNEL_LABELS[channel]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5 text-xs text-neutral-300">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: stage.color }}
                        />
                        {stage.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-500">
                      {imported ? "Archivo" : l.channel === "api" ? "API" : "Conversación"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1.5">
                        {l.channel !== "api" && onOpenLead && (
                          <button
                            onClick={() => onOpenLead(l.id)}
                            className="rounded-lg border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
                            title="Abrir el hilo en Chats"
                          >
                            Chat
                          </button>
                        )}
                        <button
                          onClick={() => setComposeTargets([l])}
                          className="rounded-lg bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-900 hover:bg-white"
                        >
                          Contactar
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {loaded && visible.length === 0 && (
            <p className="py-10 text-center text-sm text-neutral-600">
              {leads.length === 0
                ? "Sin leads todavía. Importa un CSV/Excel o conecta tus formularios a la API del CRM (Canales → API del CRM)."
                : "Ningún lead coincide con el filtro."}
            </p>
          )}
          {!loaded && (
            <p className="py-10 text-center text-sm text-neutral-600">Cargando...</p>
          )}
        </div>

        <p className="text-[11px] text-neutral-600">
          {visible.length} lead{visible.length === 1 ? "" : "s"}
          {selected.size > 0 ? ` · ${selected.size} seleccionado${selected.size === 1 ? "" : "s"}` : ""}
          {" · "}Los leads de la API pública y los importados de archivos aparecen aquí junto a las
          conversaciones de los canales.
        </p>
      </div>

      {importOpen && (
        <ImportModal
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false);
            loadLeads();
          }}
        />
      )}
      {composeTargets && composeTargets.length > 0 && (
        <ComposeModal
          targets={composeTargets}
          defaultReplyTo={defaultReplyTo}
          onReplyToSaved={setDefaultReplyTo}
          onClose={() => setComposeTargets(null)}
        />
      )}
    </main>
  );
}

// ── Importador CSV / Excel ──────────────────────────────────

type MapField = "ignorar" | "name" | "phone" | "email" | "company" | "note";

const MAP_OPTIONS: { key: MapField; label: string }[] = [
  { key: "ignorar", label: "Ignorar" },
  { key: "name", label: "Nombre" },
  { key: "phone", label: "Teléfono" },
  { key: "email", label: "Correo" },
  { key: "company", label: "Empresa" },
  { key: "note", label: "Nota" },
];

// Adivina el campo por el encabezado de la columna (es/en).
function guessField(header: string): MapField {
  const h = header.toLowerCase();
  if (/(tel|phone|cel|whats|m[oó]vil|movil)/.test(h)) return "phone";
  if (/(mail|correo)/.test(h)) return "email";
  if (/(empresa|company|negocio|marca)/.test(h)) return "company";
  if (/(nombre|name|contacto|cliente)/.test(h)) return "name";
  if (/(nota|note|mensaje|coment|observ|descrip)/.test(h)) return "note";
  return "ignorar";
}

function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<MapField[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File) => {
    setError(null);
    setResult(null);
    try {
      // Import perezoso: SheetJS solo se descarga al usar el importador.
      const XLSX = await import("xlsx");
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) throw new Error("El archivo no tiene hojas");
      const table = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        defval: "",
        raw: false,
      });
      const nonEmpty = table
        .map((r) => (r ?? []).map((c) => String(c ?? "").trim()))
        .filter((r) => r.some((c) => c !== ""));
      if (nonEmpty.length < 2) {
        throw new Error("El archivo necesita una fila de encabezados y al menos una de datos");
      }
      const [head, ...body] = nonEmpty;
      setFileName(file.name);
      setHeaders(head);
      setRows(body);
      setMapping(head.map(guessField));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo leer el archivo");
      setFileName(null);
      setHeaders([]);
      setRows([]);
    }
  };

  const mappedCount = mapping.filter((m) => m !== "ignorar").length;

  const doImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = rows.map((r) => {
        const lead: Record<string, string> = {};
        mapping.forEach((field, i) => {
          if (field === "ignorar") return;
          const value = (r[i] ?? "").trim();
          if (!value) return;
          // Varias columnas al mismo campo (p.ej. dos de notas): se concatenan.
          lead[field] = lead[field] ? `${lead[field]} · ${value}` : value;
        });
        return lead;
      });
      const res = await fetch("/api/leads-hub/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: payload, source: fileName }),
      });
      const data = (await res.json().catch(() => null)) as {
        created?: number;
        merged?: number;
        skipped?: number;
        error?: string;
      } | null;
      if (!res.ok) {
        setError(data?.error ?? "No se pudo importar");
        return;
      }
      setResult(
        `✓ ${data?.created ?? 0} lead(s) nuevos, ${data?.merged ?? 0} ya existentes actualizados, ${data?.skipped ?? 0} filas descartadas (sin datos de contacto).`
      );
      setTimeout(onImported, 1600);
    } catch {
      setError("Error de red al importar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl">
        <div className="border-b border-neutral-800 px-6 py-4">
          <h2 className="text-base font-semibold text-neutral-100">Importar leads</h2>
          <p className="mt-0.5 text-xs text-neutral-400">
            CSV o Excel (.xlsx). La primera fila debe traer los encabezados; abajo puedes ajustar
            qué columna es cada campo.
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4">
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
              }}
            />
            <button onClick={() => fileRef.current?.click()} className={btnGhost}>
              Elegir archivo...
            </button>
            <span className="truncate text-xs text-neutral-400">
              {fileName ?? "Ningún archivo elegido"}
            </span>
          </div>

          {headers.length > 0 && (
            <>
              <div className="overflow-x-auto rounded-lg border border-neutral-800">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-neutral-800 bg-neutral-950">
                      {headers.map((h, i) => (
                        <th key={i} className="min-w-32 px-2 py-2 align-top">
                          <p className="mb-1 truncate font-medium text-neutral-300" title={h}>
                            {h || `Columna ${i + 1}`}
                          </p>
                          <select
                            value={mapping[i]}
                            onChange={(e) =>
                              setMapping((prev) =>
                                prev.map((m, j) => (j === i ? (e.target.value as MapField) : m))
                              )
                            }
                            className="w-full rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-[11px] text-neutral-200 outline-none focus:border-emerald-600"
                          >
                            {MAP_OPTIONS.map((o) => (
                              <option key={o.key} value={o.key}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 5).map((r, ri) => (
                      <tr key={ri} className="border-b border-neutral-800/60 last:border-0">
                        {headers.map((_, ci) => (
                          <td key={ci} className="max-w-48 truncate px-2 py-1.5 text-neutral-400">
                            {r[ci] ?? ""}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-neutral-500">
                {rows.length} fila{rows.length === 1 ? "" : "s"} de datos
                {rows.length > 5 ? " (se muestran las primeras 5)" : ""}. Con teléfono, el lead
                queda listo para WhatsApp; sin teléfono queda como lead de correo.
              </p>
            </>
          )}

          {error && <p className="rounded-lg bg-red-950 p-2 text-xs text-red-400">{error}</p>}
          {result && (
            <p className="rounded-lg bg-emerald-950 p-2 text-xs text-emerald-400">{result}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-800 px-6 py-4">
          <button onClick={onClose} disabled={busy} className={btnGhost}>
            Cerrar
          </button>
          <button
            onClick={doImport}
            disabled={busy || rows.length === 0 || mappedCount === 0}
            className={btnPrimary}
          >
            {busy ? "Importando..." : `Importar ${rows.length || ""} fila${rows.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Compositor multicanal ───────────────────────────────────

function ComposeModal({
  targets,
  defaultReplyTo,
  onReplyToSaved,
  onClose,
}: {
  targets: ConversationWithPreview[];
  defaultReplyTo: string;
  onReplyToSaved: (v: string) => void;
  onClose: () => void;
}) {
  const bulk = targets.length > 1;
  const lead = targets[0];

  const [tab, setTab] = useState<ComposeChannel>("email");
  const [instruction, setInstruction] = useState("");
  const [generating, setGenerating] = useState(false);
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [replyTo, setReplyTo] = useState(defaultReplyTo);
  const [saveDefault, setSaveDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // El texto generado se conserva al cambiar de pestaña (para pegar el mismo
  // mensaje en otro canal), pero el aviso de resultado se limpia.
  const switchTab = (t: ComposeChannel) => {
    setTab(t);
    setNotice(null);
    setCopied(false);
  };

  const generate = async () => {
    setGenerating(true);
    setNotice(null);
    try {
      const res = await fetch("/api/leads-hub/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: tab,
          instruction,
          leadId: bulk ? undefined : lead.id,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        subject?: string;
        body?: string;
        error?: string;
      } | null;
      if (!res.ok || !data?.body) {
        setNotice({ ok: false, text: data?.error ?? "No se pudo generar" });
        return;
      }
      if (tab === "email" && data.subject) setSubject(data.subject);
      setBodyText(data.body);
    } catch {
      setNotice({ ok: false, text: "Error de red al generar" });
    } finally {
      setGenerating(false);
    }
  };

  const sendEmail = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/leads-hub/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadIds: targets.map((t) => t.id),
          subject,
          body: bodyText,
          replyTo,
          saveReplyToDefault: saveDefault,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        queued?: number;
        error?: string;
      } | null;
      if (!res.ok || !data?.queued) {
        setNotice({ ok: false, text: data?.error ?? "No se pudo encolar" });
        return;
      }
      if (saveDefault && replyTo) onReplyToSaved(replyTo);
      setNotice({
        ok: true,
        text: `✓ ${data.queued} correo${data.queued === 1 ? "" : "s"} en cola — las respuestas llegarán a ${replyTo || "la cuenta remitente"}`,
      });
    } catch {
      setNotice({ ok: false, text: "Error de red al enviar" });
    } finally {
      setBusy(false);
    }
  };

  // WhatsApp / Instagram / Facebook: envío directo solo si el lead ya habla
  // por ese canal (el hilo existe). WhatsApp además exige teléfono.
  const canSendDirect =
    !bulk &&
    ((tab === "whatsapp" && lead.channel === "whatsapp" && !!lead.phone) ||
      (tab === "instagram" && lead.channel === "instagram") ||
      (tab === "messenger" && lead.channel === "messenger"));

  const sendDirect = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/messages/${lead.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: bodyText }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setNotice({ ok: false, text: data?.error ?? "No se pudo enviar" });
        return;
      }
      setNotice({ ok: true, text: "✓ Mensaje en camino (el bot lo entrega en segundos)" });
    } catch {
      setNotice({ ok: false, text: "Error de red al enviar" });
    } finally {
      setBusy(false);
    }
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(bodyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setNotice({ ok: false, text: "No se pudo copiar (permiso del navegador)" });
    }
  };

  const emailTargets = targets.filter((t) => !!t.email).length;
  const title = bulk
    ? `Contactar ${targets.length} leads`
    : `Contactar a ${conversationDisplayName(lead)}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl">
        <div className="border-b border-neutral-800 px-6 py-4">
          <h2 className="text-base font-semibold text-neutral-100">{title}</h2>
          {!bulk && (
            <p className="mt-0.5 text-xs text-neutral-400">
              {[lead.company, lead.email, lead.phone ? `+${lead.phone}` : null]
                .filter(Boolean)
                .join(" · ") || "Sin datos de contacto"}
            </p>
          )}
          {bulk && (
            <p className="mt-0.5 text-xs text-neutral-400">
              Envío masivo por correo · {emailTargets} de {targets.length} tienen correo
            </p>
          )}
        </div>

        {/* Pestañas de canal (en masivo solo Correo) */}
        <div className="flex flex-wrap gap-1.5 border-b border-neutral-800 px-6 py-3">
          {COMPOSE_TABS.filter((t) => !bulk || t.key === "email").map((t) => (
            <button
              key={t.key}
              onClick={() => switchTab(t.key)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                tab === t.key
                  ? "bg-neutral-100 text-neutral-900"
                  : "border border-neutral-700 text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4">
          {/* Generador IA */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-3">
            <label className={labelClass}>Generar con IA (describe qué quieres decir)</label>
            <div className="flex gap-2">
              <input
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && instruction.trim() && !generating) generate();
                }}
                placeholder="p.ej. presentar nuestros servicios de pauta digital y proponer una llamada"
                className={inputClass}
              />
              <button
                onClick={generate}
                disabled={generating || !instruction.trim()}
                className={`${btnPrimary} shrink-0`}
              >
                {generating ? "Generando..." : "✨ Generar"}
              </button>
            </div>
            {!bulk && (
              <p className="mt-1.5 text-[11px] text-neutral-600">
                La IA usa los datos del lead (nombre, empresa, etapa, notas) como contexto.
              </p>
            )}
          </div>

          {tab === "email" && (
            <>
              <div>
                <label className={labelClass}>Asunto</label>
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Hola {{nombre}}, tenemos algo para {{empresa}}"
                  className={inputClass}
                />
              </div>
            </>
          )}

          <div>
            <label className={labelClass}>
              {tab === "email" ? "Contenido del correo" : "Mensaje"}
            </label>
            <textarea
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              rows={tab === "email" ? 9 : 6}
              placeholder={
                tab === "email"
                  ? "Hola {{nombre}},\n\n..."
                  : "Escribe o genera el mensaje..."
              }
              className={inputClass}
            />
            {tab === "email" && (
              <p className="mt-1 text-[11px] text-neutral-600">
                Variables: {"{{nombre}}"}, {"{{empresa}}"}, {"{{email}}"}, {"{{etapa}}"} — se
                llenan con los datos de cada lead.
              </p>
            )}
          </div>

          {tab === "email" && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-3">
              <label className={labelClass}>
                Responder a (las respuestas de los clientes llegan a este buzón)
              </label>
              <input
                value={replyTo}
                onChange={(e) => setReplyTo(e.target.value)}
                placeholder="motoradvertisingservice@gmail.com"
                className={inputClass}
              />
              <label className="mt-2 flex items-center gap-2 text-xs text-neutral-400">
                <input
                  type="checkbox"
                  checked={saveDefault}
                  onChange={(e) => setSaveDefault(e.target.checked)}
                  className="h-3.5 w-3.5 accent-emerald-600"
                />
                Guardar como predeterminado para próximos envíos
              </label>
            </div>
          )}

          {/* Acciones según canal */}
          {tab !== "email" && !canSendDirect && !bulk && (
            <p className="rounded-lg bg-neutral-950 p-2.5 text-xs text-neutral-400">
              {tab === "imessage"
                ? "iMessage no se puede enviar desde el servidor: genera el texto, cópialo y mándalo desde tu iPhone/Mac."
                : tab === "whatsapp"
                  ? lead.phone
                    ? "Este lead aún no tiene hilo de WhatsApp con el bot: copia el texto o ábrelo en WhatsApp Web con el botón."
                    : "Este lead no tiene teléfono: agrega su número en el CRM para contactarlo por WhatsApp."
                  : `Este lead no llegó por ${tab === "instagram" ? "Instagram" : "Facebook"}: solo se puede responder a quien ya escribió por ese canal. Copia el texto y mándalo desde la app.`}
            </p>
          )}

          {notice && (
            <p
              className={`rounded-lg p-2 text-xs ${
                notice.ok ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"
              }`}
            >
              {notice.text}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-neutral-800 px-6 py-4">
          <button onClick={onClose} disabled={busy} className={btnGhost}>
            Cerrar
          </button>
          {tab !== "email" && (
            <button onClick={copyText} disabled={!bodyText.trim()} className={btnGhost}>
              {copied ? "✓ Copiado" : "Copiar texto"}
            </button>
          )}
          {tab === "whatsapp" && !bulk && lead.phone && (
            <a
              href={`https://wa.me/${lead.phone}?text=${encodeURIComponent(bodyText)}`}
              target="_blank"
              rel="noreferrer"
              className={`${btnGhost} ${bodyText.trim() ? "" : "pointer-events-none opacity-50"}`}
            >
              Abrir en WhatsApp
            </a>
          )}
          {tab === "imessage" && !bulk && lead.phone && (
            <a
              href={`sms:+${lead.phone}?body=${encodeURIComponent(bodyText)}`}
              className={`${btnGhost} ${bodyText.trim() ? "" : "pointer-events-none opacity-50"}`}
            >
              Abrir en Mensajes
            </a>
          )}
          {tab === "email" && (
            <button
              onClick={sendEmail}
              disabled={
                busy ||
                !subject.trim() ||
                !bodyText.trim() ||
                (bulk ? emailTargets === 0 : !lead.email)
              }
              className={btnPrimary}
              title={
                bulk
                  ? `Se enviará a los ${emailTargets} seleccionados con correo`
                  : lead.email
                    ? `Se enviará a ${lead.email}`
                    : "El lead no tiene correo"
              }
            >
              {busy
                ? "Encolando..."
                : bulk
                  ? `Enviar a ${emailTargets} con correo`
                  : "Enviar correo"}
            </button>
          )}
          {canSendDirect && (
            <button onClick={sendDirect} disabled={busy || !bodyText.trim()} className={btnPrimary}>
              {busy ? "Enviando..." : `Enviar por ${COMPOSE_TABS.find((t) => t.key === tab)?.label}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
