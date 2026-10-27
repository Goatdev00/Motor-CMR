// Arranque local en UN comando (`npm run dev:local`): bot + dashboard en el
// puerto 3434 (o PORT). Antes de arrancar limpia lo que haya quedado de una
// corrida anterior: en Windows Ctrl+C deja zombis, y dos bots con la misma
// sesión entran en bucle code=440 tragándose mensajes.
// Al cerrar con Ctrl+C el bot NO se mata a la fuerza: se le pide que termine
// lo que tiene en curso (guardar lo recibido, respuestas a medio enviar) y
// solo si no lo hace en ~30 s se lo fuerza. Cerrar la ventana con la X da
// pocos segundos (Windows termina los procesos): el bot hace un cierre corto.
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";

const PORT = process.env.PORT || "3434";
// El bot se lanza con su ruta ABSOLUTA: así se distingue en la limpieza del
// bot del CRM padre, cuyo comando (`tsx scripts/start-bot.ts`) es idéntico.
const BOT = path.resolve("scripts", "start-bot.ts");
// Pedido de apagado por archivo que el bot revisa cada segundo.
const STOP_FILE = path.resolve("auth", "bot.stop");
// Marca de instancia única que el bot de ESTA copia renueva mientras corre
// (start-bot.ts): lo encuentra aunque se haya lanzado de otra forma
// (npm run start:bot en otra terminal, start:all...).
const BOT_LOCK = path.resolve("auth", "bot.lock");
const BOT_LOCK_STALE_MS = 15_000;
// La ventana en espera se va cuando el bot de la nueva lleva este tiempo
// corriendo (o, sin señal de él, tras el tope).
const STANDBY_STABLE_MS = 10_000;
const STANDBY_MAX_WAIT_MS = 120_000;
const NEXT_BIN = createRequire(import.meta.url).resolve("next/dist/bin/next");
const BOT_GRACE_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Una sola ventana de dev:local por copia ─────────────────
// La ventana que arranca anota quién es (PID + hora de inicio: Windows recicla
// los PID). La anterior, al verlo, cierra su bot y su dashboard y queda en
// espera: se va recién cuando la nueva ya levantó los suyos, y si la nueva se
// cierra o muere antes, vuelve a levantarlos ella. Así nunca quedan dos bots
// con la misma sesión, ni ninguno.
const LOCK_FILE = path.resolve("auth", "dev-local.pid");
const STARTED_FILE = path.resolve("auth", "dev-local.started");
const ME = { pid: process.pid, startedAt: Math.round(Date.now() - process.uptime() * 1000) };

function readId(file) {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (/^\d+$/.test(raw)) return { pid: Number(raw), startedAt: null }; // versión anterior del lanzador
    const id = JSON.parse(raw);
    if (typeof id?.pid !== "number") return null;
    return { pid: id.pid, startedAt: typeof id.startedAt === "number" ? id.startedAt : null };
  } catch {
    return null;
  }
}

function writeId(file, id) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(id));
}

const sameId = (a, b) =>
  !!a && !!b && a.pid === b.pid && (a.startedAt == null || b.startedAt == null || Math.abs(a.startedAt - b.startedAt) < 2000);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Otra ventana VIVA tomó el relevo.
function replaced() {
  const owner = readId(LOCK_FILE);
  return !!owner && !sameId(owner, ME) && isAlive(owner.pid);
}

function kill(pid, why) {
  console.log(`[dev-local] Matando ${why} (PID ${pid})`);
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
  } catch {
    // Ya había muerto (p.ej. cayó con el árbol de otro proceso).
  }
}

// Procesos del equipo y dueño del puerto. La salida se pide en UTF-8: con la
// página de códigos de la consola, una ruta con tildes (p.ej. C:\Users\Andrés)
// llegaba alterada y no se reconocía el bot de esta copia.
function listProcesses() {
  const out = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ` +
        `@{ procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate); ` +
        `owner = @((Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess) } ` +
        `| ConvertTo-Json -Compress -Depth 3`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }
  );
  return JSON.parse(out);
}

// Hora de inicio de un proceso del listado (PowerShell 5.1 la da como
// "/Date(ms)/"; versiones nuevas, en ISO).
function createdAt(p) {
  const v = p?.CreationDate;
  if (typeof v !== "string") return null;
  const ms = /Date\((\d+)\)/.exec(v);
  if (ms) return Number(ms[1]);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// ¿Hay un bot vivo con la marca de instancia vigente?
function botLockFresh() {
  try {
    const lock = JSON.parse(fs.readFileSync(BOT_LOCK, "utf8"));
    return typeof lock.pid === "number" && Date.now() - lock.at < BOT_LOCK_STALE_MS && isAlive(lock.pid);
  } catch {
    return false;
  }
}

// Bots de ESTA copia: los lanzados por dev:local (ruta absoluta) y el que
// tiene la marca de instancia vigente, se haya lanzado como se haya lanzado.
function botPids(procs) {
  let lockPid = null;
  try {
    const lock = JSON.parse(fs.readFileSync(BOT_LOCK, "utf8"));
    if (typeof lock.pid === "number" && Date.now() - lock.at < BOT_LOCK_STALE_MS) lockPid = lock.pid;
  } catch {
    /* sin marca */
  }
  return procs
    .filter((p) => {
      const cmd = (p.CommandLine ?? "").toLowerCase();
      return cmd.includes(BOT.toLowerCase()) || (p.ProcessId === lockPid && cmd.includes("start-bot"));
    })
    .map((p) => p.ProcessId);
}

async function cleanup() {
  let { procs, owner } = listProcesses();
  let killed = false;

  // 1) Bots de ESTA copia que sigan vivos: primero se les pide cerrar
  //    ordenadamente (archivo de apagado); si no, a la fuerza.
  if (botPids(procs).length > 0) {
    console.log("[dev-local] Hay un bot anterior corriendo: se le pide cerrar ordenadamente...");
    fs.mkdirSync(path.dirname(STOP_FILE), { recursive: true });
    fs.writeFileSync(STOP_FILE, String(Date.now()));
    for (let i = 0; i < BOT_GRACE_MS / 1000 && botPids(procs).length > 0; i++) {
      await sleep(1000);
      ({ procs, owner } = listProcesses());
    }
    for (const pid of botPids(procs)) {
      kill(pid, "bot anterior");
      killed = true;
    }
    fs.rmSync(STOP_FILE, { force: true });
  }
  const byPid = new Map(procs.map((p) => [p.ProcessId, p]));

  // 2) Lo que escuche en el puerto (p.ej. el `next dev` del CRM padre): se sube
  //    por los padres mientras sigan siendo ese mismo `next` (npx, cmd, bash…)
  //    y se mata el árbol entero, sin tocar lo que lo lanzó.
  // (Sin nadie escuchando, PowerShell devuelve `[null]`.)
  for (const pid of new Set(owner.filter(Boolean))) {
    let root = pid;
    while (/\bnext\b/i.test(byPid.get(byPid.get(root)?.ParentProcessId)?.CommandLine ?? "")) {
      root = byPid.get(root).ParentProcessId;
    }
    kill(root, `lo que ocupaba el puerto ${PORT}`);
    killed = true;
  }
  return killed;
}

const portBusy = () =>
  new Promise((resolve) => {
    const socket = net.connect(Number(PORT), "localhost");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

async function cleanupAndWaitPort() {
  if (process.platform !== "win32") return;
  let killed = false;
  try {
    killed = await cleanup();
  } catch (err) {
    console.warn("[dev-local] No se pudo revisar los procesos anteriores:", err instanceof Error ? err.message : err);
  }
  for (let i = 0; killed && i < 20 && (await portBusy()); i++) await sleep(500);
}

// ── Toma del relevo ─────────────────────────────────────────
let launched = false;
let closing = false;
let standby = false;
const previousOwner = readId(LOCK_FILE);

// Cerrar esta ventana ANTES de levantar nada deshace el relevo: la anterior,
// en espera, vuelve a levantar su bot y su dashboard.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(signal, () => {
    if (launched || standby) {
      void shutdown(0, signal);
      return;
    }
    try {
      if (sameId(readId(LOCK_FILE), ME)) {
        if (previousOwner && !sameId(previousOwner, ME)) writeId(LOCK_FILE, previousOwner);
        else fs.rmSync(LOCK_FILE, { force: true });
      }
    } catch {
      /* noop */
    }
    process.exit(0);
  });
}

writeId(LOCK_FILE, ME);
if (
  process.platform === "win32" &&
  previousOwner &&
  previousOwner.startedAt !== null &&
  !sameId(previousOwner, ME) &&
  isAlive(previousOwner.pid)
) {
  // ¿Es de verdad la ventana anterior (y no un PID reciclado por otro
  // proceso, quizá de otra instalación)? Si lo es, al ver el relevo cierra su
  // bot ordenadamente y queda en espera: se espera a que ese bot termine.
  const isPrevious = (procs) =>
    procs.some(
      (p) =>
        p.ProcessId === previousOwner.pid &&
        /dev-local\.mjs/i.test(p.CommandLine ?? "") &&
        Math.abs((createdAt(p) ?? previousOwner.startedAt) - previousOwner.startedAt) < 2000
    );
  let procs = null;
  try {
    procs = listProcesses().procs;
  } catch {
    /* sigue la limpieza normal */
  }
  if (procs && isPrevious(procs)) {
    console.log(
      `[dev-local] Otra ventana de dev:local sigue abierta (PID ${previousOwner.pid}): cierra su bot y queda en espera hasta que esta levante el suyo...`
    );
    const until = Date.now() + BOT_GRACE_MS + 15_000;
    while (procs && isPrevious(procs) && botPids(procs).length > 0 && Date.now() < until) {
      await sleep(1000);
      try {
        procs = listProcesses().procs;
      } catch {
        procs = null;
      }
    }
  }
}

await cleanupAndWaitPort();

// Un Ctrl+C o el cierre de la ventana que llegó durante la limpieza (los
// listados de procesos son síncronos) se atiende ACÁ, antes de levantar nada:
// así deshace el relevo en vez de cerrar un bot recién lanzado.
await sleep(50);

// Dos ventanas abiertas casi a la vez: arranca solo la última.
if (replaced()) process.exit(0);

// Salida de cada proceso con su prefijo de color, línea por línea.
function pipe(child, label, color) {
  const prefix = `\x1b[${color}m[${label}]\x1b[0m `;
  for (const [stream, out] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    readline.createInterface({ input: stream }).on("line", (line) => out.write(prefix + line + "\n"));
  }
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

// Si un proceso se cae (código distinto de 0) se vuelve a levantar, con
// espera creciente: un bot caído deja a todos los clientes sin respuesta.
// Un cierre con código 0 (apagado pedido) cierra todo.
const RESTART_DELAYS_MS = [5_000, 10_000, 30_000, 60_000];
function supervise(name, label, color, start) {
  const proc = { child: null, launch: null, cancelRestart: null };
  let failures = 0;
  // Reinicio programado tras una caída: se cancela al pasar a espera o al
  // cerrar (si no, tras volver de la espera lanzaba un segundo proceso).
  let restartTimer = null;
  const cancelRestart = () => {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
  };
  const launch = () => {
    cancelRestart();
    if (proc.child && !exited(proc.child)) return; // ya está corriendo
    const startedAt = Date.now();
    const child = start();
    proc.child = child;
    pipe(child, label, color);
    child.on("error", (err) => console.warn(`[dev-local] ${name}: ${err.message}`));
    child.on("exit", (code, signal) => {
      if (closing) return;
      if (code === 0) {
        void shutdown(0, `${name} se detuvo`);
        return;
      }
      if (Date.now() - startedAt > 120_000) failures = 0;
      const delay = RESTART_DELAYS_MS[Math.min(failures, RESTART_DELAYS_MS.length - 1)];
      failures++;
      console.log(`[dev-local] ${name} terminó (código ${code ?? signal}); se reinicia en ${delay / 1000} s`);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (closing) return;
        if (replaced()) void enterStandby();
        else launch();
      }, delay);
    });
  };
  proc.launch = launch;
  proc.cancelRestart = cancelRestart;
  launch();
  return proc;
}

// El bot con canal IPC: por ahí recibe el pedido de apagado ordenado.
const bot = supervise("El bot", "BOT", 33, () =>
  spawn(process.execPath, ["--import", "tsx", BOT], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: process.env,
  })
);
const web = supervise("El dashboard", "WEB", 36, () =>
  spawn(process.execPath, [NEXT_BIN, "dev", "-p", PORT], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  })
);
launched = true;
writeId(STARTED_FILE, ME);

// Cierra el bot (ordenadamente, con tope) y el dashboard.
async function stopChildren() {
  const botChild = bot.child;
  const webChild = web.child;
  // Con callback: si el canal ya se cerró (el bot está terminando), el error
  // llega acá en vez de tumbar este proceso.
  if (botChild && !exited(botChild) && botChild.connected) {
    botChild.send("shutdown", (err) => {
      if (err) console.warn("[dev-local] No se pudo pedir el cierre al bot:", err.message);
    });
  }
  if (webChild && !exited(webChild)) kill(webChild.pid, "el dashboard");
  if (botChild && !exited(botChild)) {
    const force = setTimeout(() => {
      if (!exited(botChild)) kill(botChild.pid, "el bot (no cerró a tiempo)");
    }, BOT_GRACE_MS);
    await new Promise((resolve) => botChild.once("exit", resolve));
    clearTimeout(force);
  }
}

// Cierre en curso del bot y el dashboard de esta ventana al pasar a espera.
let stoppingChildren = null;
// Esta ventana se está cerrando: la espera no vuelve a levantar nada.
let exiting = false;

async function shutdown(code, why) {
  if (closing && !standby) return;
  closing = true;
  exiting = true;
  bot.cancelRestart();
  web.cancelRestart();
  console.log(`[dev-local] ${why}: cerrando (el bot termina lo que tiene en curso, hasta ~${BOT_GRACE_MS / 1000} s)...`);
  // En espera, el bot de esta ventana puede estar todavía cerrándose: se lo
  // espera (salir antes lo mataba a mitad de su cierre ordenado).
  if (standby) await stoppingChildren;
  else await stopChildren();
  try {
    if (sameId(readId(LOCK_FILE), ME)) fs.rmSync(LOCK_FILE, { force: true });
    if (sameId(readId(STARTED_FILE), ME)) fs.rmSync(STARTED_FILE, { force: true });
  } catch {
    /* noop */
  }
  process.exit(code);
}

// Otra ventana tomó el relevo: esta cierra su bot y su dashboard y espera. Se
// va cuando la otra levantó los suyos; si la otra se cierra antes, esta
// vuelve a levantarlos.
async function enterStandby() {
  if (standby || closing) return;
  standby = true;
  closing = true; // los procesos que se cierran ahora no se relanzan
  bot.cancelRestart();
  web.cancelRestart();
  console.log("[dev-local] Otra ventana de dev:local tomó el relevo: se cierran el bot y el dashboard de esta (queda en espera)...");
  stoppingChildren = stopChildren();
  await stoppingChildren;
  // Esta ventana se va recién cuando el bot de la otra lleva unos segundos
  // corriendo: si la otra se cierra apenas arrancó, esta vuelve a levantar
  // el suyo (nunca quedan sin bot).
  let startedSince = null;
  let stableSince = null;
  for (;;) {
    await sleep(500);
    if (exiting) return;
    const owner = readId(LOCK_FILE);
    if (owner && !sameId(owner, ME) && isAlive(owner.pid)) {
      if (sameId(readId(STARTED_FILE), owner)) {
        startedSince ??= Date.now();
        stableSince = botLockFresh() ? (stableSince ?? Date.now()) : null;
        const stable = stableSince !== null && Date.now() - stableSince >= STANDBY_STABLE_MS;
        if (stable || Date.now() - startedSince >= STANDBY_MAX_WAIT_MS) {
          console.log("[dev-local] La otra ventana ya levantó el bot y el dashboard: esta se cierra.");
          process.exit(0);
        }
      } else {
        startedSince = null;
        stableSince = null;
      }
      continue;
    }
    console.log("[dev-local] La otra ventana se cerró antes de terminar el relevo: esta vuelve a levantar el bot y el dashboard.");
    writeId(LOCK_FILE, ME);
    await cleanupAndWaitPort();
    if (exiting) return;
    if (replaced()) continue; // otra ventana más lo tomó mientras tanto
    standby = false;
    closing = false;
    bot.launch();
    web.launch();
    writeId(STARTED_FILE, ME);
    return;
  }
}

setInterval(() => {
  if (!closing && !standby && replaced()) void enterStandby();
}, 500);
