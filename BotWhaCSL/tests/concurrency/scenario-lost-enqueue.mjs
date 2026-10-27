// Deterministic regression: a reply whose live send fails goes to the
// outbox; that insert COMMITS but its response is lost and the database
// stays down for the retries, so the pass is reported as failed. When the
// pass runs again it must see the reply already queued and NOT generate a
// second one (the customer would get two answers to the same message).
// Usage: node scenario-lost-enqueue.mjs <bundle dir>
import path from "node:path";
import { pathToFileURL } from "node:url";

const [OUT] = process.argv.slice(2);
for (const level of ["log", "warn", "error"]) console[level] = () => undefined;

const F = await import(new URL("./fakes.mjs", import.meta.url).href);
const W = await import(pathToFileURL(path.join(OUT, "wa.js")).href);
F.resetHarness({ seed: 7 });
const H = F.harness();
const ENGINE = globalThis.__botwhaReplyEngine;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Every live send fails: the reply falls back to the outbox.
let botSeq = 0;
W.configureReplyEngine({
  channels: ["whatsapp"],
  newMessageId: () => `BOTMSG-${++botSeq}`,
  send: async (target) => {
    await W.assertStillValid(target);
    throw new Error("Connection Closed");
  },
});
// The next outbox insert commits, then the database goes down.
H.failEnqueueAfterCommit = true;

const phone = "573019990001";
const convKey = `1:whatsapp:${phone}`;
await W.persistAndSchedule(
  { orgId: 1, channel: "whatsapp", externalId: phone, phone, text: `⟦k=${convKey}|m=1⟧ hola`, dedupeKey: "IN-1", sentAt: Math.floor(Date.now() / 1000) },
  { waAccountId: 1, jid: `${phone}@s.whatsapp.net`, accountPhone: "573990000001" }
);
const convId = H.messages[0].conversation_id;

// First pass: 3 failed sends (2 s + 5 s of backoff), the queue insert that
// "fails", then the pass is marked failed.
for (let i = 0; i < 300 && !ENGINE.failures.has(convId); i++) await wait(100);
const firstPassFailed = ENGINE.failures.has(convId);
H.cfg.dbFailRate = 0; // the database is back

// The pass runs again (as its backoff timer or the recovery sweep would).
W.scheduleReplyPass(convId);
await wait(200);
for (let i = 0; i < 300 && ENGINE.passQueued.size + ENGINE.passRunning.size > 0; i++) await wait(100);

const queued = H.outbox.filter((o) => o.conversation_id === convId && (o.kind === "bot" || o.kind === "bot_fixed"));
const result = {
  scenario: "lost enqueue response",
  firstPassFailed,
  llmCalls: H.llmCalls.length,
  queuedReplies: queued.length,
  ok: firstPassFailed && queued.length === 1 && H.llmCalls.length === 1,
};
console.info(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
