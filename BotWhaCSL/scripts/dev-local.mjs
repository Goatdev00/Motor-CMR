// Arranque local en UN comando (`npm run dev:local`): bot + dashboard en el
// puerto 3434 (o PORT). Antes de arrancar limpia lo que haya quedado de una
// corrida anterior: en Windows Ctrl+C deja zombis, y dos bots con la misma
// sesión entran en bucle code=440 tragándose mensajes.
import { execFileSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import concurrently from "concurrently";

const PORT = process.env.PORT || "3434";
// El bot se lanza con su ruta ABSOLUTA: así se distingue en la limpieza del
// bot del CRM padre, cuyo comando (`tsx scripts/start-bot.ts`) es idéntico.
const BOT = path.resolve("scripts", "start-bot.ts");

function kill(pid, why) {
  console.log(`[dev-local] Matando ${why} (PID ${pid})`);
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
  } catch {
    // Ya había muerto (p.ej. cayó con el árbol de otro proceso).
  }
}

function cleanup() {
  const out = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `@{ procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine); ` +
        `owner = @((Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess) } ` +
        `| ConvertTo-Json -Compress -Depth 3`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const { procs, owner } = JSON.parse(out);
  const byPid = new Map(procs.map((p) => [p.ProcessId, p]));
  let killed = false;

  // 1) Bots de ESTA copia que sigan vivos.
  for (const p of procs) {
    if (p.CommandLine?.toLowerCase().includes(BOT.toLowerCase())) {
      kill(p.ProcessId, "bot anterior");
      killed = true;
    }
  }

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

if (process.platform === "win32" && cleanup()) {
  for (let i = 0; i < 20 && (await portBusy()); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

const { result } = concurrently(
  [
    { command: `tsx "${BOT}"`, name: "BOT", prefixColor: "yellow" },
    { command: `next dev -p ${PORT}`, name: "WEB", prefixColor: "cyan" },
  ],
  { killOthersOn: ["failure", "success"] }
);
result.then(
  () => process.exit(0),
  () => process.exit(1)
);
