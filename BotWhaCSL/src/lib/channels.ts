// Definición de canales compartida entre server y client (sin dependencias
// de servidor: los componentes React importan de aquí sin arrastrar nada).

// 'api': leads inyectados por otras apps vía la API pública del CRM que
// llegan sin teléfono — no tienen canal de respuesta (se gestionan desde el
// CRM: notas, etapa, correo). Con teléfono se crean como 'whatsapp' para
// que el hilo se fusione cuando el cliente escriba.
export type Channel = "whatsapp" | "whatsapp_api" | "messenger" | "instagram" | "api";

export const CHANNELS: Channel[] = ["whatsapp", "whatsapp_api", "messenger", "instagram", "api"];

export const CHANNEL_LABELS: Record<Channel, string> = {
  whatsapp: "WhatsApp (QR)",
  whatsapp_api: "WhatsApp API",
  messenger: "Messenger",
  instagram: "Instagram",
  api: "API externa",
};

// Chips de canal para listas/kanban (tema oscuro).
export const CHANNEL_BADGE_CLASS: Record<Channel, string> = {
  whatsapp: "bg-emerald-950 text-emerald-400",
  whatsapp_api: "bg-teal-950 text-teal-400",
  messenger: "bg-blue-950 text-blue-400",
  instagram: "bg-fuchsia-950 text-fuchsia-400",
  api: "bg-orange-950 text-orange-400",
};

export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as string[]).includes(value);
}

// Nombre visible de una conversación: nombre → teléfono → id del canal.
// En Messenger/Instagram no se conoce el teléfono; el external_id (PSID/IGSID)
// se recorta solo para no ensuciar la UI.
export function conversationDisplayName(c: {
  name?: string | null;
  phone?: string | null;
  channel?: string | null;
  external_id?: string | null;
}): string {
  if (c.name) return c.name;
  if (c.phone) return `+${c.phone}`;
  if (c.external_id) return `${c.external_id.slice(0, 12)}…`;
  return "(sin nombre)";
}

// Línea secundaria bajo el nombre (teléfono o canal + id).
export function conversationSubtitle(c: {
  phone?: string | null;
  channel?: string | null;
  external_id?: string | null;
}): string {
  if (c.phone) return `+${c.phone}`;
  const label = isChannel(c.channel ?? "") ? CHANNEL_LABELS[c.channel as Channel] : c.channel ?? "";
  return c.external_id ? `${label} · ${c.external_id.slice(0, 16)}` : label;
}
