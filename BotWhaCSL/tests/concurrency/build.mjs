// Bundles the REAL production modules with esbuild, redirecting only their
// I/O dependencies to fakes.mjs:
//   wa.js  = Baileys handler + reply engine + outbox worker (what the bot
//            process runs; only the Baileys client registry is faked)
//   api.js = Meta webhook route + reply engine + cloud-api-replies (Next)
// Usage: node build.mjs <BotWhaCSL root> <out dir>
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [ROOT, OUT] = process.argv.slice(2);
const require = createRequire(path.join(ROOT, "package.json"));
const esbuild = require("esbuild");

const FAKES = pathToFileURL(path.join(import.meta.dirname, "fakes.mjs")).href;
const BAILEYS = pathToFileURL(
  path.join(ROOT, "node_modules", "@whiskeysockets", "baileys", "lib", "index.js")
).href;

// Specifiers (as written in the source) whose module is replaced by fakes.
const FAKED = new Set([
  "./db",
  "../db",
  "@/lib/db",
  "./llm",
  "./lead-analysis",
  "./templates",
  "./ai-agents",
  "./client",
  "./baileys/client",
  "../inbound-spool",
  "./reply-retry-store",
  "./meta",
  "@/lib/meta",
  "next/server",
]);

const redirect = {
  name: "harness-redirect",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point") return undefined;
      if (args.path === "@whiskeysockets/baileys") return { path: BAILEYS, external: true };
      if (FAKED.has(args.path)) return { path: FAKES, external: true };
      return undefined;
    });
  },
};

const lib = (p) => path.join(ROOT, "src", "lib", p).replace(/\\/g, "/");
const entryWa = path.join(OUT, "entry-wa.ts");
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
  entryWa,
  `export { registerMessageHandler, persistAndSchedule, restoreSpooledContacts, releaseSpooledContact, replayInboundSpool, hasSpooledInbound, hasUnsavedInbound, intakeUnemitted, flushDeferredInbound, beginInboundShutdown } from "${lib("baileys/handler")}";\n` +
    `export { configureReplyEngine, runRecoverySweep, flushPendingRecords, drainReplies, PermanentSendError, assertStillValid, ReplySupersededError, enqueueForContact, contactKey, hasPendingHandoff, scheduleReplyPass, clearReplyTimers } from "${lib("reply-engine")}";\n` +
    `export { flushOutbox, flushOutboxBookkeeping, sendBotReply, rememberAccounts, resetInFlightOnce, stopOutbox, OUTBOX_TIMING } from "${lib("outbox-worker")}";\n`
);

const result = await esbuild.build({
  absWorkingDir: ROOT,
  entryPoints: {
    wa: entryWa,
    api: path.join(ROOT, "src", "app", "api", "webhooks", "meta", "route.ts"),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: OUT,
  plugins: [redirect],
  logLevel: "warning",
  metafile: true,
});

const inputs = Object.keys(result.metafile.inputs).filter((p) => !p.includes("entry-wa")).sort();
console.log("real modules bundled:\n  " + inputs.join("\n  "));
