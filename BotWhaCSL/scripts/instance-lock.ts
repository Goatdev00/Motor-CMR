// Una sola instancia del bot por instalación (misma carpeta auth/): dos bots
// con la misma sesión de WhatsApp se desconectan uno al otro (code=440) y se
// pierden mensajes. El bot vivo renueva su marca cada pocos segundos; otro que
// arranque mientras tanto (start:bot en otra terminal, dev:local, start:all)
// se niega a hacerlo. dev:local la usa para encontrar y cerrar el anterior.
// Si el bot vivo estuvo detenido más de 15 s (la consola en modo selección,
// un depurador, el equipo suspendido), otro puede tomarla: el primero lo ve
// en su próxima renovación y se cierra, en vez de pisarla.
import fs from "node:fs";
import path from "node:path";

const LOCK_BEAT_MS = 3_000;
const LOCK_STALE_MS = 15_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface InstanceLock {
  // PID que figura en la marca (null si no hay o no se puede leer).
  owner(): number | null;
  // Deja de renovarla (al apagar).
  stopRenewal(): void;
}

// Toma la marca, o termina el proceso si otro bot vivo la tiene. onLost: otro
// bot la tomó mientras este estaba detenido (este debe cerrarse).
export function acquireInstanceLock(file: string, onLost: (owner: number) => void): InstanceLock {
  let timer: NodeJS.Timeout | null = null;
  const owner = (): number | null => {
    try {
      const lock = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
      return typeof lock.pid === "number" ? lock.pid : null;
    } catch {
      return null;
    }
  };
  // ¿Otro bot vivo tiene la marca? (una marca que se está escribiendo justo
  // ahora cuenta como tomada).
  const heldByOther = (): number | null => {
    let raw: string;
    let mtimeMs: number;
    try {
      raw = fs.readFileSync(file, "utf8");
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
    try {
      const lock = JSON.parse(raw) as { pid?: unknown; at?: unknown };
      if (typeof lock.pid !== "number" || typeof lock.at !== "number") throw new Error("marca inválida");
      if (lock.pid === process.pid) return null;
      return processAlive(lock.pid) && Date.now() - lock.at < LOCK_STALE_MS ? lock.pid : null;
    } catch {
      return Date.now() - mtimeMs < 5_000 ? -1 : null;
    }
  };
  const renew = (): void => {
    const current = owner();
    if (current !== null && current !== process.pid && processAlive(current)) {
      if (timer) clearInterval(timer);
      timer = null;
      onLost(current);
      return;
    }
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }));
    } catch {
      /* siguiente renovación */
    }
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Creación exclusiva: de dos bots que arrancan a la vez, gana uno.
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      timer = setInterval(renew, LOCK_BEAT_MS);
      process.on("exit", () => {
        if (owner() === process.pid) fs.rmSync(file, { force: true });
      });
      return {
        owner,
        stopRenewal: () => {
          if (timer) clearInterval(timer);
          timer = null;
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const other = heldByOther();
    if (other !== null) {
      console.error(
        `[bot] ❌ Ya hay un bot corriendo para esta instalación${other > 0 ? ` (PID ${other})` : ""}. Ciérralo antes de iniciar otro: dos bots con la misma sesión de WhatsApp pierden mensajes.`
      );
      process.exit(1);
    }
    // Marca de un bot que ya no corre: se reemplaza.
    fs.rmSync(file, { force: true });
  }
  console.error("[bot] ❌ No se pudo tomar la marca de instancia única (auth/bot.lock).");
  process.exit(1);
}
