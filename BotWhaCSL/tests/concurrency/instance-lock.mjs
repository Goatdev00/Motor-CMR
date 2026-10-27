// The bot's single-instance lock (scripts/instance-lock.ts) with real
// processes, on a lock file in a temporary folder:
//  L1) A bot frozen for 20 s (console in selection mode, debugger) loses the
//      lock to a new one; when it wakes up it gives up instead of overwriting
//      the lock: never two bots on the same session.
//  L2) Two bots starting at once over a lock left by a dead bot: only one
//      keeps running.
// Usage: node instance-lock.mjs <BotWhaCSL root> [lock module to test instead]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [ROOT, MODULE] = process.argv.slice(2);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botwhacsl-lock-"));
const LOCK = path.join(dir, "auth", "bot.lock");
const LOCK_MODULE = pathToFileURL(MODULE ?? path.join(ROOT, "scripts", "instance-lock.ts")).href;
const worker = path.join(dir, "worker.mjs");
fs.writeFileSync(
  worker,
  `import { acquireInstanceLock } from ${JSON.stringify(LOCK_MODULE)};
const [file, freezeMs, lifeMs] = process.argv.slice(2).map((v, i) => (i === 0 ? v : Number(v)));
const lock = acquireInstanceLock(file, (owner) => {
  console.log("LOST " + owner);
  process.exit(3);
});
console.log("ACQUIRED " + process.pid);
setTimeout(() => {
  if (freezeMs > 0) {
    const end = Date.now() + freezeMs;
    while (Date.now() < end) {} // frozen: no timers, no lock renewal
    console.log("RESUMED");
  }
}, 1000);
setTimeout(() => {
  lock.stopRenewal();
  process.exit(0);
}, lifeMs);
`
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
function start(freezeMs, lifeMs) {
  // cwd = the project: that is where `tsx` resolves.
  const child = spawn(process.execPath, ["--import", "tsx", worker, LOCK, String(freezeMs), String(lifeMs)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.out = "";
  child.stdout.on("data", (d) => (child.out += d));
  child.stderr.on("data", (d) => (child.out += d));
  child.done = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return child;
}
const lockPid = () => {
  try {
    return JSON.parse(fs.readFileSync(LOCK, "utf8")).pid;
  } catch {
    return null;
  }
};
const problems = [];

// ── L1) A frozen bot loses the lock and gives up when it wakes up ──
{
  const a = start(20_000, 60_000);
  await wait(17_500); // A's last renewal is now > 15 s old
  const b = start(0, 40_000);
  await wait(3_000);
  if (!/ACQUIRED/.test(b.out)) problems.push(`L1: the new bot could not take the lock of the frozen one: ${b.out.trim()}`);
  const codeA = await Promise.race([a.done, wait(15_000).then(() => "running")]);
  if (codeA !== 3) problems.push(`L1: the bot that woke up did not give up the lock (exit ${codeA}): ${a.out.trim()}`);
  await wait(3_500);
  if (lockPid() !== b.pid) problems.push(`L1: the lock names ${lockPid()}, not the new bot ${b.pid}`);
  if (!alive(b.pid)) problems.push(`L1: the new bot is gone: ${b.out.trim()}`);
  for (const c of [a, b]) if (alive(c.pid)) c.kill();
  await Promise.all([a.done, b.done]);
}

// ── L2) Two bots start at once over a dead bot's lock ──
{
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => dead.on("exit", r));
  fs.writeFileSync(LOCK, JSON.stringify({ pid: dead.pid, at: Date.now() }));
  const c = start(0, 30_000);
  const d = start(0, 30_000);
  await wait(9_000);
  const running = [c, d].filter((x) => alive(x.pid));
  if (running.length !== 1) problems.push(`L2: ${running.length} bots kept running (expected 1): ${c.out.trim()} | ${d.out.trim()}`);
  else if (lockPid() !== running[0].pid) problems.push(`L2: the lock names ${lockPid()}, not the bot still running`);
  for (const x of [c, d]) if (alive(x.pid)) x.kill();
  await Promise.all([c.done, d.done]);
}

fs.rmSync(dir, { recursive: true, force: true });
const result = { scenario: "single-instance lock (frozen bot, simultaneous start)", problems, ok: problems.length === 0 };
console.info(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
