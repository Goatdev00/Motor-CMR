// Runs scenarios over several seeds and fault modes in parallel child
// processes (each scenario is its own process, like production).
// Usage: node batch.mjs <bundle dir> <scenario file> <modes e.g. 0,1,2> <seeds e.g. 1-8> [concurrency]
import { spawn } from "node:child_process";
import path from "node:path";

const [OUT, SCENARIO, modesArg, seedsArg, concArg] = process.argv.slice(2);
const modes = modesArg.split(",");
const [s0, s1] = seedsArg.split("-").map(Number);
const jobs = [];
for (const mode of modes) for (let s = s0; s <= (s1 ?? s0); s++) jobs.push({ mode, seed: s });
const CONC = Number(concArg ?? 4);

function run(job) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, SCENARIO), OUT, String(job.seed), job.mode], {
      cwd: import.meta.dirname,
      env: { ...process.env, DEBUG_PHONES: "" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      try {
        resolve({ job, code, r: JSON.parse(out.slice(out.indexOf("{"))) });
      } catch {
        resolve({ job, code, r: null, err: (err || out).slice(-600) });
      }
    });
  });
}

const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      results.push(await run(job));
    }
  })
);
results.sort((a, b) => a.job.mode.localeCompare(b.job.mode) || a.job.seed - b.job.seed);
let failed = 0;
for (const { job, r, err } of results) {
  if (!r) {
    failed++;
    console.log(`mode ${job.mode} seed ${job.seed}: CRASH ${err}`);
    continue;
  }
  if (!r.ok) failed++;
  console.log(
    `mode ${job.mode} seed ${String(job.seed).padStart(2)}: ${r.ok ? "OK  " : "FAIL"} inbound=${r.inbound} ai=${r.aiRepliesSent} kw=${r.keywordRepliesSent} outbox=${r.outboxFallbacks} spooled=${r.spooledToDisk ?? r.spooled ?? 0} crossTalk=${r.crossTalk} ${r.seconds}s${r.ok ? "" : " " + JSON.stringify(r.violations)}`
  );
}
console.log(`\n${results.length - failed}/${results.length} runs passed`);
process.exit(failed ? 1 : 0);
