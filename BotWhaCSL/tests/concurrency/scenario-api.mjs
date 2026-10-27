// Next process scenario: the REAL Meta webhook route + reply engine +
// cloud-api-replies under many simultaneous customers: concurrent POSTs,
// multi-contact batches, Meta retries (also after a 500), failed-delivery
// statuses, unknown phone_number_id, bursts, keyword, media, operator
// takeovers, orphans recovered by the sweep, re-deliveries after a
// simulated restart, and injected faults.
// Usage: node scenario-api.mjs <bundle dir> [seed] [faults 0|1|2] [--verbose]
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const [OUT, seedArg, faultsArg] = args.filter((a) => !a.startsWith("--"));
const SEED = Number(seedArg ?? 1);
const HARSH = faultsArg === "2";
const FAULTS = faultsArg === "1" || HARSH;

const logCounts = { log: 0, warn: 0, error: 0 };
for (const level of ["log", "warn", "error"]) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    logCounts[level]++;
    if (VERBOSE) orig(...a);
  };
}

const F = await import(new URL("./fakes.mjs", import.meta.url).href);
const { verdict } = await import(new URL("./checks.mjs", import.meta.url).href);
const { POST } = await import(pathToFileURL(path.join(OUT, "api.js")).href);

F.resetHarness({
  seed: SEED,
  llmFailRate: HARSH ? 0.3 : FAULTS ? 0.15 : 0,
  sendFailRate: HARSH ? 0.3 : FAULTS ? 0.08 : 0,
  dbFailRate: HARSH ? 0.1 : FAULTS ? 0.03 : 0,
});
const H = F.harness();
const rand = F.rand;

const phoneOf = (i) => `5731${1000000 + i}`;
const PNID = { 1: "PNID_ORG1", 2: "PNID_ORG2" };
const ledger = new Map();
const keyOfId = new Map();
const nextM = new Map();
const newTag = (convKey) => {
  const m = (nextM.get(convKey) ?? 0) + 1;
  nextM.set(convKey, m);
  return m;
};
const untaggedIds = [];
const allowUntaggedPhones = new Set();

const payload = (pnid, items, statuses = []) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: pnid },
            contacts: items.map((x) => ({ wa_id: x.from, profile: { name: `Api ${x.from}` } })),
            messages: items.map((x) => ({ from: x.from, id: x.id, timestamp: String(Math.floor(Date.now() / 1000)), ...x.body })),
            ...(statuses.length ? { statuses } : {}),
          },
        },
      ],
    },
  ],
});

function msg(org, i, j, extra = "") {
  const convKey = `${org}:whatsapp_api:${phoneOf(i)}`;
  const m = newTag(convKey);
  const id = `wamid.IN-${org}-${i}-${j}`;
  const tag = `⟦k=${convKey}|m=${m}⟧`;
  const body = rand() < 0.1 ? { type: "image", image: { caption: `${tag} foto` } } : { type: "text", text: { body: `${tag} hola${extra}` } };
  ledger.set(`${convKey}|${m}`, { id, phone: phoneOf(i), orgId: org, channel: "whatsapp_api", tracked: true });
  keyOfId.set(id, `${convKey}|${m}`);
  return { from: phoneOf(i), id, body };
}

const timeline = [];
for (let i = 0; i < 36; i++) {
  const org = i % 3 === 0 ? 2 : 1;
  const count = 3 + Math.floor(rand() * 4);
  let when = Math.floor(rand() * 300);
  for (let j = 0; j < count; j++) {
    const item = msg(org, i, j, i % 7 === 0 && j === 1 ? " precio" : "");
    when += rand() < 0.3 ? Math.floor(rand() * 4) : 5 + Math.floor(rand() * 120);
    const p = payload(PNID[org], [item]);
    timeline.push({ at: when, p });
    if (rand() < 0.15) timeline.push({ at: when + 30 + Math.floor(rand() * 300), p }); // Meta retry
  }
}
// One POST carrying 5 different contacts at once.
{
  const items = [];
  for (let i = 100; i < 105; i++) items.push(msg(1, i, 0));
  timeline.push({ at: 40, p: payload(PNID[1], items) });
}
// Voice notes (no tags): stored and answered.
for (let i = 200; i < 203; i++) {
  const id = `wamid.AUDIO-${i}`;
  untaggedIds.push(id);
  allowUntaggedPhones.add(phoneOf(i));
  timeline.push({ at: 60 + i, p: payload(PNID[1], [{ from: phoneOf(i), id, body: { type: "audio", audio: { voice: true } } }]) });
}
// Unknown phone_number_id: stored (never lost) under the agency (org 1),
// handed to a person and never answered automatically.
{
  const convKey = `1:whatsapp_api:${phoneOf(300)}`;
  const m = newTag(convKey);
  ledger.set(`${convKey}|${m}`, { id: "wamid.UNKNOWN-1", phone: phoneOf(300), orgId: 1, channel: "whatsapp_api", tracked: false });
  keyOfId.set("wamid.UNKNOWN-1", `${convKey}|${m}`);
  timeline.push({ at: 70, p: payload("PNID_UNKNOWN", [{ from: phoneOf(300), id: "wamid.UNKNOWN-1", body: { type: "text", text: { body: `⟦k=${convKey}|m=${m}⟧ hola` } } }]) });
}
// Failed-delivery statuses for an existing contact.
timeline.push({ at: 900, p: payload(PNID[1], [], [{ id: "wamid.OUT-x", status: "failed", recipient_id: phoneOf(1), errors: [{ code: 131047, title: "Re-engagement message" }] }]) });

// Orphans: saved before a "crash", never answered — the sweep must do it.
for (let i = 250; i < 253; i++) {
  const convKey = `1:whatsapp_api:${phoneOf(i)}`;
  const conv = await F.withDbRetry(() => F.getOrCreateConversation(1, "whatsapp_api", phoneOf(i), { phone: phoneOf(i) }), { attempts: 50 });
  const m = newTag(convKey);
  const id = `wamid.ORPHAN-${i}`;
  await F.withDbRetry(() => F.insertMessageIdempotent(conv.id, "user", `⟦k=${convKey}|m=${m}⟧ huérfano`, { channelMsgId: id }), { attempts: 50 });
  ledger.set(`${convKey}|${m}`, { id, phone: phoneOf(i), orgId: 1, channel: "whatsapp_api", tracked: true, emitSeq: 0 });
}
H.triggers = [{ keyword: "precio", content: "LISTA DE PRECIOS", also_human: false }];

// The bot process's REAL outbox (src/lib/outbox-worker) delivers what this
// process queued, through the (fake) Graph API: still valid, per-recipient
// order, and a send Meta did not confirm is never repeated.
const W = await import(pathToFileURL(path.join(OUT, "wa.js")).href);
Object.assign(W.OUTBOX_TIMING, {
  deliveryTimeoutMs: 10_000,
  warmingDeferS: 1,
  downDeferS: 1,
  unsavedDeferS: 1,
  orderDeferS: 1,
  channelOffDeferS: 1,
});
const apiSettings = (org) => ({ whatsapp_api: { org_id: org, channel: "whatsapp_api", enabled: true, config: {} } });
const settingsByOrg = new Map([
  [1, apiSettings(1)],
  [2, apiSettings(2)],
]);
let outboxBusy = false;
const outboxTimer = setInterval(async () => {
  if (outboxBusy) return;
  outboxBusy = true;
  try {
    await W.flushOutbox(settingsByOrg);
  } catch {
    /* next tick, like the bot */
  } finally {
    outboxBusy = false;
  }
}, 150);

// ── Fire (Meta re-delivers a POST that got a non-200) ──────────
let emitCounter = 0;
const stamp = (p) => {
  for (const m of p.entry[0].changes[0].value.messages ?? []) {
    const info = ledger.get(keyOfId.get(m.id));
    if (info && info.emitSeq === undefined) info.emitSeq = ++emitCounter; // first accepted delivery = arrival
  }
};
const latencies = [];
let non200 = 0;
async function deliver(p, attempt = 1) {
  const raw = JSON.stringify(p);
  const t = Date.now();
  const res = await POST({ text: async () => raw, headers: { get: () => "sha256=x" } });
  latencies.push(Date.now() - t);
  if (res.status === 200) {
    stamp(p);
    return;
  }
  non200++;
  for (const m of p.entry[0].changes[0].value.messages ?? []) {
    const info = ledger.get(keyOfId.get(m.id));
    if (info) info.reorderOk = true;
  }
  if (attempt < 20) {
    await new Promise((r) => setTimeout(r, 200 + Math.floor(rand() * 300)));
    return deliver(p, attempt + 1);
  }
}
const takeovers = new Map([[`1:whatsapp_api:${phoneOf(300)}`, 0]]);
const t0 = Date.now();
if (HARSH) {
  setTimeout(() => (H.cfg.dbFailRate = 1), 500);
  setTimeout(() => (H.cfg.dbFailRate = 0.1), 2500);
}
for (const i of [4, 11, 19]) {
  setTimeout(() => {
    const org = i % 3 === 0 ? 2 : 1;
    const conv = H.conversations.get(`${org}|whatsapp_api|${phoneOf(i)}`);
    if (!conv) return;
    conv.mode = "HUMAN";
    takeovers.set(`${org}:whatsapp_api:${phoneOf(i)}`, Date.now());
  }, 150 + Math.floor(rand() * 600));
}
// Simulated server restart: dedupe memory lost, Meta re-delivers 10 POSTs.
setTimeout(() => {
  globalThis.__botwhaReplyEngine?.processedKeys.clear();
  for (const ev of timeline.slice(0, 10)) void deliver(ev.p);
}, 1300);
await Promise.all(timeline.map((ev) => new Promise((r) => setTimeout(() => deliver(ev.p).then(r, r), ev.at))));

// ── Quiesce ───────────────────────────────────────────────────
const ENGINE = globalThis.__botwhaReplyEngine;
const deadline = Date.now() + (HARSH ? 420_000 : 180_000);
let lastSig = "";
let stableSince = Date.now();
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
  const busy = ENGINE.passQueued.size + ENGINE.passRunning.size + ENGINE.failures.size + ENGINE.pendingRecords.length + H.outbox.filter((o) => o.sent === 0 || o.sent === 3).length;
  const sig = `${H.apiSends.length}|${H.llmCalls.length}|${H.messages.length}|${busy}`;
  if (sig !== lastSig || busy > 0) {
    lastSig = sig;
    stableSince = Date.now();
  } else if (Date.now() - stableSince > 6000) break; // > the 5 s sweep interval
}
const timedOut = Date.now() >= deadline;
clearInterval(outboxTimer);

const sends = H.apiSends
  .map((s) => ({ text: s.text, phone: s.to, orgId: s.orgId, at: s.at }))
  .filter((s) => !(F.tagsIn(s.text).length === 0 && allowUntaggedPhones.has(s.phone)));
for (const ph of (process.env.DEBUG_PHONES ?? "").split(",").filter(Boolean)) {
  for (const c of H.convById.values()) {
    if (c.external_id !== ph) continue;
    process.stderr.write(`CONV ${c.id} org ${c.org_id} ${ph} mode=${c.mode} failures=${JSON.stringify(ENGINE.failures.get(c.id) ?? null)} covered=${ENGINE.answeredUpTo.get(c.id)} evaluated=${ENGINE.evaluatedUpTo.get(c.id)} settled=${JSON.stringify(ENGINE.settledUpTo.get(c.id) ?? null)}
`);
    for (const m of H.messages.filter((m) => m.conversation_id === c.id)) process.stderr.write(`  #${m.id} ${m.role} ins=${m.inserted_at - t0} ${m.content.slice(0, 50)} [${m.channel_msg_id}]
`);
    for (const o of H.outbox.filter((o) => o.conversation_id === c.id)) process.stderr.write(`  outbox #${o.id} sent=${o.sent} ${o.content.slice(0, 40)}
`);
  }
}
const result = verdict({ ledger, sends, takeovers, untaggedIds, faults: FAULTS });
const extra = [];
{
  const conv = H.conversations.get(`1|whatsapp_api|${phoneOf(300)}`);
  if (!H.messages.some((m) => m.channel_msg_id === "wamid.UNKNOWN-1")) extra.push("UNKNOWN_PNID_NOT_STORED");
  if (conv?.mode !== "HUMAN") extra.push("UNKNOWN_PNID_NOT_HANDED_TO_A_PERSON");
  if (H.apiSends.some((s) => s.to === phoneOf(300))) extra.push("UNKNOWN_PNID_ANSWERED");
}
const failedConv = H.conversations.get(`1|whatsapp_api|${phoneOf(1)}`);
if (failedConv && !H.events.some((e) => e.conversationId === failedConv.id && e.type === "delivery_error")) extra.push("FAILED_STATUS_NOT_RECORDED");
for (const i of [200, 201, 202]) if (!H.apiSends.some((s) => s.to === phoneOf(i))) extra.push(`VOICE_NOTE_NOT_ANSWERED ${phoneOf(i)}`);
if (timedOut) extra.push("DID_NOT_QUIESCE");
if (extra.length) {
  result.ok = false;
  result.violations.SCENARIO = { count: extra.length, examples: extra.slice(0, 6) };
}
latencies.sort((a, b) => a - b);
result.webhookLatencyMs = { p50: latencies[Math.floor(latencies.length / 2)], p95: latencies[Math.floor(latencies.length * 0.95)], max: latencies.at(-1) };
result.webhookNon200 = non200;
result.seconds = Math.round((Date.now() - t0) / 100) / 10;
result.errorsLogged = logCounts.error;
console.info(JSON.stringify({ scenario: "whatsapp_api (webhook)", seed: SEED, ...result }, null, 2));
process.exit(result.ok ? 0 : 1);
