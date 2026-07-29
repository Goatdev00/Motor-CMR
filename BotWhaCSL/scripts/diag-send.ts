// Diagnóstico de entrega de WhatsApp (uso puntual, no forma parte del bot).
// Se conecta con la MISMA sesión del bot (auth/acc-2), envía un mensaje de
// prueba y escucha los acuses del protocolo:
//   status 2 = el SERVIDOR de WhatsApp lo aceptó
//   status 3 = ENTREGADO al teléfono del destinatario
//   status 4 = LEÍDO
// Si nunca pasa de 2, WhatsApp acepta el mensaje pero no lo entrega
// (sesión/dispositivo marcado). ⚠️ El bot debe estar DETENIDO al correr esto.
import makeWASocket, {
  Browsers,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";

const TO_PHONE = process.argv[2] ?? "573205095533";
const TO_JID = `${TO_PHONE}@s.whatsapp.net`;

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState("auth/acc-2");
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.macOS("Desktop"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: pino({ level: "warn" }) as any,
  });
  sock.ev.on("creds.update", saveCreds);

  let sent = false;
  sock.ev.on("connection.update", (u) => {
    const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } })?.output
      ?.statusCode;
    console.log(
      `[diag] conexión: ${u.connection ?? "(sin cambio)"}` +
        (code ? ` — código de cierre ${code} (${u.lastDisconnect?.error?.message})` : "")
    );
    if (u.connection === "open" && !sent) {
      sent = true;
      void sendProbe();
    }
    if (u.connection === "close" && !sent) {
      console.log("[diag] La conexión cerró antes de poder enviar.");
      process.exit(1);
    }
  });

  sock.ev.on("messages.update", (updates) => {
    for (const up of updates) {
      if (!up.key.fromMe) continue;
      const status = up.update?.status;
      const label =
        status === 2 ? "2 = aceptado por el SERVIDOR" :
        status === 3 ? "3 = ✅ ENTREGADO al teléfono" :
        status === 4 ? "4 = ✅✅ LEÍDO" :
        String(status);
      console.log(`[diag] ack del mensaje ${up.key.id}: ${label}`);
    }
  });

  async function sendProbe() {
    console.log(`[diag] Conectado. Enviando prueba a ${TO_JID} ...`);
    try {
      const res = await sock.sendMessage(TO_JID, {
        text: "[Diagnóstico 2] Prueba de entrega directa — si te llega, responde OK",
      });
      console.log(
        `[diag] sendMessage resolvió — id=${res?.key?.id} statusInicial=${res?.status}`
      );
    } catch (err) {
      console.error("[diag] ❌ sendMessage lanzó error:", err);
      process.exit(1);
    }
    // 45s escuchando acks; sin logout (la sesión sigue siendo del bot).
    setTimeout(() => {
      console.log("[diag] Fin de la escucha (45 s). Cierro sin desvincular.");
      process.exit(0);
    }, 45000);
  }
}

main().catch((err) => {
  console.error("[diag] fatal:", err);
  process.exit(1);
});
