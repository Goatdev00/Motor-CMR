// Prueba de concurrencia del pipeline de mensajes (npm run test:concurrency).
// Empaqueta el código REAL (handler de Baileys, motor de respuestas, webhook
// de Meta) reemplazando solo Supabase, la IA y los envíos por dobles en
// memoria, y lo somete a muchos clientes escribiendo a la vez — ráfagas,
// reconexiones, re-entregas, cortes de la base, fallos de la IA, asesores
// que toman el chat — verificando: cero cruces entre clientes, cada mensaje
// guardado una vez y en orden, todo respondido, sin respuestas dobles y
// nada enviado después de que un asesor tomó la conversación.
//   node tests/concurrency/run.mjs           (rápida: sin fallas y con fallas)
//   node tests/concurrency/run.mjs --full    (además fallas extremas, más semillas; varios minutos)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = import.meta.dirname;
const root = path.resolve(here, "..", "..");
const full = process.argv.includes("--full");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "botwhacsl-concurrency-"));

const step = (args) => spawnSync(process.execPath, args, { cwd: here, stdio: "inherit" }).status ?? 1;

let status = step([path.join(here, "build.mjs"), root, out]);
if (status === 0) {
  console.log("\n== Regresión: encolado cuya confirmación se perdió (no debe responder dos veces)");
  status |= step([path.join(here, "scenario-lost-enqueue.mjs"), out]);
  console.log("\n== Casos límite: anuncio + saludo automático, respuesta en cola y orden, asesor con la base caída");
  status |= step([path.join(here, "scenario-edge.mjs"), out]);
  console.log("\n== Respuestas en cola: reinicio sin la migración, una sola espera, encolado fallido, palabras clave");
  status |= step([path.join(here, "scenario-queue.mjs"), out]);
  console.log("\n== Outbox: seguimientos, reinicio a mitad de una entrega, cola con cambio de modo");
  status |= step([path.join(here, "scenario-outbox.mjs"), out]);
  console.log("\n== Mensajes del teléfono del negocio: reacciones, bienvenida aprendida, repeticiones desde el disco");
  status |= step([path.join(here, "scenario-intake.mjs"), out]);
  console.log("\n== Instancia única del bot: bot congelado, dos arranques a la vez");
  status |= step([path.join(here, "instance-lock.mjs"), root]);
  console.log("\n== Cuenta lista tras reconectar: backlog completo, lotes de WhatsApp, conexión validada");
  status |= step([path.join(here, "client-ready.mjs"), root, path.join(out, "client")]);
  const modes = full ? "0,1,2" : "0,1";
  const seeds = full ? "1-8" : "1-3";
  console.log(`\n== WhatsApp (proceso bot) · modos ${modes} · semillas ${seeds}`);
  status |= step([path.join(here, "batch.mjs"), out, "scenario-wa.mjs", modes, seeds, "4"]);
  console.log(`\n== WhatsApp Cloud API (webhook, proceso Next) · modos ${modes} · semillas ${seeds}`);
  status |= step([path.join(here, "batch.mjs"), out, "scenario-api.mjs", modes, seeds, "4"]);
}
fs.rmSync(out, { recursive: true, force: true });
process.exit(status ? 1 : 0);
