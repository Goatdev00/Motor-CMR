// Respuestas automáticas de WhatsApp Cloud API en el proceso de Next:
// configura el motor (reply-engine) para el canal 'whatsapp_api' y arranca
// el barrido que retoma lo que quedó sin responder (reinicio del servidor,
// corte, fallo de la IA). Lo llama el arranque del servidor
// (instrumentation.ts) y, por si acaso, el webhook. Idempotente.
import { randomUUID } from "node:crypto";
import {
  PermanentSendError,
  UncertainSendError,
  assertStillValid,
  configureReplyEngine,
  flushPendingRecords,
  isReplyEngineConfigured,
  runRecoverySweep,
} from "./reply-engine";
import { getAllOrgsChannelSettingsCached, isChannelEnabled, isUncertainDelivery, sendChannelText } from "./meta";
import { logRepeated } from "./repeated-log";
import { fileRetryStore } from "./reply-retry-store";

const SWEEP_INTERVAL_MS = 5000;
const store = globalThis as typeof globalThis & { __botwhaCloudApiSweep?: NodeJS.Timeout };

export function startCloudApiReplies(): void {
  if (!isReplyEngineConfigured()) {
    configureReplyEngine({
      channels: ["whatsapp_api"],
      newMessageId: () => randomUUID(),
      // Respuestas por reintentar: un reinicio del servidor las retoma.
      retryStore: fileRetryStore("reply-retries-api.json"),
      cannotReply: async (conv) =>
        (await isChannelEnabled(conv.org_id, "whatsapp_api"))
          ? null
          : "el canal WhatsApp API está deshabilitado",
      send: async (target, text) => {
        const { conversation } = target;
        const recipient = conversation.external_id ?? conversation.phone;
        if (!recipient) throw new PermanentSendError("la conversación no tiene número de destino");
        if (!(await isChannelEnabled(conversation.org_id, "whatsapp_api"))) {
          throw new PermanentSendError("el canal WhatsApp API está deshabilitado");
        }
        await assertStillValid(target);
        try {
          const wamid = await sendChannelText(conversation.org_id, "whatsapp_api", recipient, text);
          return { channelMsgId: wamid };
        } catch (err) {
          // Pudo haber salido: reintentarlo duplicaría el mensaje al cliente.
          if (isUncertainDelivery(err)) throw new UncertainSendError((err as Error).message);
          throw err;
        }
      },
    });
  }
  if (store.__botwhaCloudApiSweep) return;
  let sweeping = false;
  store.__botwhaCloudApiSweep = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      // Sin ninguna organización con Cloud API activa no hay nada que barrer.
      const rows = await getAllOrgsChannelSettingsCached();
      if (!rows.some((r) => r.channel === "whatsapp_api" && r.enabled)) return;
      await flushPendingRecords();
      await runRecoverySweep();
    } catch (err) {
      logRepeated("error", "cloud-sweep", "[webhook] Error en el barrido de respuestas pendientes:", err);
    } finally {
      sweeping = false;
    }
  }, SWEEP_INTERVAL_MS);
  store.__botwhaCloudApiSweep.unref?.();
}
