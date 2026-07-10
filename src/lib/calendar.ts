// Validación de eventos del calendario (compartida por las rutas API) y
// generación del .ics para el respaldo en Google Drive.
import type { CalendarAttachment, CalendarEvent, CalendarEventDraft } from "./db";

const MAX_ATTACHMENTS = 10;

export type EventInputResult =
  | { ok: true; draft: Partial<CalendarEventDraft> }
  | { ok: false; error: string };

function isEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 32503680000;
}

function parseAttachments(value: unknown): CalendarAttachment[] | null {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return null;
  const clean: CalendarAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { id, name, link } = item as Record<string, unknown>;
    if (typeof id !== "string" || !id.trim() || id.length > 200) return null;
    if (typeof name !== "string" || name.length > 300) return null;
    if (typeof link !== "string" || link.length > 1000) return null;
    // Solo enlaces https de Google (vienen de la API de Drive).
    if (link !== "" && !link.startsWith("https://")) return null;
    clean.push({ id: id.trim(), name, link });
  }
  return clean;
}

// partial=false: exige título y fecha de inicio (creación).
// partial=true: valida solo los campos presentes (edición).
export function parseEventInput(body: unknown, partial: boolean): EventInputResult {
  if (!body || typeof body !== "object") return { ok: false, error: "Cuerpo inválido" };
  const input = body as Record<string, unknown>;
  const draft: Partial<CalendarEventDraft> = {};

  if (input.title !== undefined) {
    if (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 200) {
      return { ok: false, error: "Título requerido (1 a 200 caracteres)" };
    }
    draft.title = input.title.trim();
  } else if (!partial) {
    return { ok: false, error: "Título requerido" };
  }

  if (input.starts_at !== undefined) {
    if (!isEpoch(input.starts_at)) return { ok: false, error: "Fecha de inicio inválida" };
    draft.starts_at = input.starts_at;
  } else if (!partial) {
    return { ok: false, error: "Fecha de inicio requerida" };
  }

  if (input.ends_at !== undefined) {
    if (input.ends_at !== null && !isEpoch(input.ends_at)) {
      return { ok: false, error: "Fecha de fin inválida" };
    }
    draft.ends_at = input.ends_at as number | null;
  }

  // El fin nunca puede quedar antes del inicio. Para poder validarlo sin
  // leer la fila actual, un PATCH que toque una de las dos fechas debe
  // traer ambas (el front siempre las manda juntas). Sin esta simetría, un
  // PATCH con solo starts_at podía dejar ends_at < starts_at persistido y
  // el evento desaparecía de todas las vistas (la consulta de solapamiento
  // no lo encuentra en ningún rango).
  if (partial && draft.starts_at !== undefined && input.ends_at === undefined) {
    return { ok: false, error: "Para cambiar la fecha de inicio envía también ends_at (puede ser null)" };
  }
  if (draft.ends_at != null) {
    if (draft.starts_at === undefined) {
      return { ok: false, error: "Para cambiar la fecha de fin envía también la de inicio" };
    }
    if (draft.ends_at < draft.starts_at) {
      return { ok: false, error: "La fecha de fin no puede ser anterior al inicio" };
    }
  }

  if (input.all_day !== undefined) {
    if (typeof input.all_day !== "boolean") return { ok: false, error: "all_day inválido" };
    draft.all_day = input.all_day;
  }

  if (input.color !== undefined) {
    if (typeof input.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(input.color)) {
      return { ok: false, error: "Color inválido (formato #rrggbb)" };
    }
    draft.color = input.color;
  }

  if (input.description !== undefined) {
    if (typeof input.description !== "string" || input.description.length > 5000) {
      return { ok: false, error: "Descripción demasiado larga (máx. 5000)" };
    }
    draft.description = input.description;
  }

  if (input.location !== undefined) {
    if (typeof input.location !== "string" || input.location.length > 300) {
      return { ok: false, error: "Lugar demasiado largo (máx. 300)" };
    }
    draft.location = input.location;
  }

  if (input.conversation_id !== undefined) {
    if (
      input.conversation_id !== null &&
      (typeof input.conversation_id !== "number" ||
        !Number.isInteger(input.conversation_id) ||
        input.conversation_id <= 0)
    ) {
      return { ok: false, error: "Lead inválido" };
    }
    draft.conversation_id = input.conversation_id as number | null;
  }

  if (input.attachments !== undefined) {
    const attachments = parseAttachments(input.attachments);
    if (!attachments) {
      return { ok: false, error: `Adjuntos inválidos (máx. ${MAX_ATTACHMENTS})` };
    }
    draft.attachments = attachments;
  }

  return { ok: true, draft };
}

// ── Exportación .ics ────────────────────────────────────────

function icsEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function icsDateTime(epochSeconds: number): string {
  // 2026-07-09T15:30:00.000Z → 20260709T153000Z
  return new Date(epochSeconds * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Para eventos de día completo el epoch guardado es la medianoche LOCAL del
// operador. Con la zona horaria del navegador (la manda el front al
// exportar) la fecha se recupera exacta vía Intl; sin ella se usa +12h
// antes de tomar la fecha UTC, correcto para offsets entre −11 y +12
// (toda América y Europa) pero no para +13/+14.
function icsDate(epochSeconds: number, timeZone: string | null): string {
  const date = new Date(epochSeconds * 1000);
  if (timeZone) {
    try {
      // en-CA formatea YYYY-MM-DD.
      return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .format(date)
        .replace(/-/g, "");
    } catch {
      /* zona inválida: cae al heurístico */
    }
  }
  return new Date((epochSeconds + 12 * 3600) * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}

// Día siguiente calculado sobre la FECHA (no sumando 86400s al epoch: en un
// día de 25h por fin de horario de verano eso cae en el mismo día).
function nextIcsDate(yyyymmdd: string): string {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10).replace(/-/g, "");
}

export function buildIcs(events: CalendarEvent[], timeZone: string | null = null): string {
  const now = icsDateTime(Math.floor(Date.now() / 1000));
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AGENTE//Calendario//ES",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:AGENTE",
  ];
  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:agente-event-${event.id}@agente`);
    lines.push(`DTSTAMP:${now}`);
    if (event.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(event.starts_at, timeZone)}`);
      // En iCalendar el DTEND de día completo es EXCLUSIVO (día siguiente).
      const lastDay = icsDate(event.ends_at ?? event.starts_at, timeZone);
      lines.push(`DTEND;VALUE=DATE:${nextIcsDate(lastDay)}`);
    } else {
      lines.push(`DTSTART:${icsDateTime(event.starts_at)}`);
      if (event.ends_at) lines.push(`DTEND:${icsDateTime(event.ends_at)}`);
    }
    lines.push(`SUMMARY:${icsEscape(event.title)}`);
    if (event.description) lines.push(`DESCRIPTION:${icsEscape(event.description)}`);
    if (event.location) lines.push(`LOCATION:${icsEscape(event.location)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
