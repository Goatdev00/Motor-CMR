// The bot's REAL outbox (src/lib/outbox-worker) with follow-ups and restarts,
// deterministic, against the REAL handler, reply engine and sender:
//  O1) A row left 'sending' by a restart AFTER it was written to the thread
//      is not written twice nor reported as uncertain (WhatsApp API: settled;
//      WhatsApp: re-sent with the same id).
//  O2) With the migration, a follow-up that had to wait (account down) still
//      clears the lead's reminder once delivered.
//  O3) Without the migration, a follow-up that comes due while the AI is
//      answering the customer waits for that reply (it would be stored as an
//      advisor message and cancel it).
//  O4) With the migration, a reply queued on a disconnected account survives
//      an operator switching the chat to HUMAN and back while it waits.
// Usage: node scenario-outbox.mjs <bundle dir> [--verbose]
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const [OUT] = args.filter((a) => !a.startsWith("--"));
for (const level of ["log", "warn", "error"]) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    if (VERBOSE) orig(...a);
  };
}

const F = await import(new URL("./fakes.mjs", import.meta.url).href);
const W = await import(pathToFileURL(path.join(OUT, "wa.js")).href);
F.resetHarness({ seed: 9 });
const H = F.harness();
const ENGINE = globalThis.__botwhaReplyEngine;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

// Two accounts of org 1 (same contract as client.ts).
const sends = [];
function makeSession(accountId, phone) {
  const listeners = {};
  const own = new Set();
  const sock = {
    ev: { on: (evt, fn) => (listeners[evt] ??= []).push(fn) },
    emit: (evt, data) => (listeners[evt] ?? []).forEach((fn) => fn(data)),
    user: { id: `${phone}:5@s.whatsapp.net` },
    signalRepository: { lidMapping: { getPNForLID: async () => null } },
  };
  const s = {
    accountId,
    orgId: 1,
    open: true,
    ready: true,
    epoch: 1,
    sock,
    isOwnMessage: (id) => own.has(id),
    phone: () => (s.open ? phone : null),
    knownPhone: () => phone,
    isOpen: () => s.open,
    isReady: () => s.open && s.ready,
    readyEpoch: () => (s.open && s.ready ? s.epoch : null),
    waitReady: async (ms) => {
      const deadline = Date.now() + ms;
      while (!(s.open && s.ready)) {
        if (Date.now() > deadline) throw new Error(`Socket de la cuenta ${accountId} no disponible`);
        await wait(20);
      }
      return s.epoch;
    },
    pnForLid: async () => null,
    send: async (jid, text, opts = {}) => {
      if (!s.open || !s.ready || (opts.readyEpoch !== undefined && opts.readyEpoch !== s.epoch)) {
        throw new Error(`Socket de la cuenta ${accountId} no disponible por ahora`);
      }
      const id = opts.messageId;
      own.add(id);
      // WhatsApp discards a message whose id the customer already got.
      if (!sends.some((x) => x.id === id && x.jid === jid)) sends.push({ jid, text, id, accountId, at: Date.now() });
      return id;
    },
  };
  W.registerMessageHandler(sock, s);
  H.sessions.set(accountId, s);
  return s;
}
const A = makeSession(1, "573990000001");
const B = makeSession(2, "573990000002");
const down = (s = A) => {
  s.open = false;
  s.ready = false;
};
const up = (s = A) => {
  s.epoch++;
  s.open = true;
  s.ready = true;
};
const customer = (phone, id, text, s = A, ts = nowS()) =>
  s.sock.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id }, message: { conversation: text }, messageTimestamp: ts }],
  });

Object.assign(W.OUTBOX_TIMING, {
  replyWaitOpenMs: 1000,
  deliveryTimeoutMs: 10_000,
  warmingDeferS: 1,
  downDeferS: 1,
  unsavedDeferS: 1,
  orderDeferS: 1,
  channelOffDeferS: 1,
  followupDeferS: 1,
});
let botSeq = 0;
W.configureReplyEngine({
  channels: ["whatsapp"],
  newMessageId: () => `BOT-${++botSeq}`,
  inboundPending: (conv) => W.hasUnsavedInbound(conv.org_id, conv.channel, conv.external_id),
  send: W.sendBotReply,
});
const SETTINGS = new Map([[1, { whatsapp: { enabled: true }, whatsapp_api: { enabled: true } }]]);

const problems = [];
const convOf = (phone, channel = "whatsapp") => H.conversations.get(`1|${channel}|${phone}`);
const sendsTo = (phone) => sends.filter((x) => x.jid.startsWith(phone));
const tagOf = (phone) => (n) => `⟦k=1:whatsapp:${phone}|m=${n}⟧`;
const repliesTo = (phone, n) => sendsTo(phone).filter((x) => x.text.startsWith(`R${tagOf(phone)(n)}`));
const queuedFor = (phone) => H.outbox.filter((o) => o.phone === phone);
const until = async (cond, maxMs) => {
  const deadline = Date.now() + maxMs;
  while (!cond() && Date.now() < deadline) await wait(50);
  return cond();
};
const outboxRow = (fields) => ({
  id: ++H.outboxSeq,
  covers_msg_id: null,
  channel_msg_id: null,
  account_phone: null,
  wa_account_id: null,
  sent: 0,
  attempts: 0,
  scheduled_at: null,
  created_at: nowS(),
  org_id: 1,
  ...fields,
});
const newConversation = async (phone, channel = "whatsapp") => {
  const conv = await F.withDbRetry(() => F.getOrCreateConversation(1, channel, phone, { phone }), { attempts: 20 });
  const live = H.convById.get(conv.id);
  if (channel === "whatsapp") live.wa_account_id = 1;
  return live;
};

// ── O1) Boot: rows left 'sending' after they were written to the thread ──
// (runs first: the outbox resets in-flight rows once, on its first flush)
{
  H.compat = true; // the thread insert is not idempotent without the migration
  const t = nowS() - 30;
  const api = await newConversation("573019200001", "whatsapp_api");
  const wa = await newConversation("573019200002");
  api.next_follow_up_at = t;
  wa.next_follow_up_at = t;
  // Both follow-ups were delivered and written to the thread; the bot stopped
  // before marking them sent.
  H.outbox.push(
    outboxRow({ conversation_id: api.id, phone: "573019200001", content: "SEGUIMIENTO-API", channel: "whatsapp_api", kind: "followup", sent: 3, scheduled_at: t, created_at: t }),
    outboxRow({ conversation_id: wa.id, phone: "573019200002", content: "SEGUIMIENTO-WA", channel: "whatsapp", kind: "followup", sent: 3, scheduled_at: t, created_at: t })
  );
  await F.withDbRetry(() => F.insertMessage(api.id, "human", "SEGUIMIENTO-API"), { attempts: 20 });
  await F.withDbRetry(() => F.insertMessage(wa.id, "human", "SEGUIMIENTO-WA"), { attempts: 20 });
  for (let i = 0; i < 5; i++) await W.flushOutbox(SETTINGS);
  for (const [conv, text] of [
    [api, "SEGUIMIENTO-API"],
    [wa, "SEGUIMIENTO-WA"],
  ]) {
    const rows = H.messages.filter((m) => m.conversation_id === conv.id && m.content === text).length;
    if (rows !== 1) problems.push(`O1: ${text} is ${rows} times in the thread (expected 1)`);
    if (H.events.some((e) => e.conversationId === conv.id && e.type === "delivery_uncertain")) {
      problems.push(`O1: ${text} was reported as possibly not delivered, although it was in the thread`);
    }
    if (conv.next_follow_up_at != null) problems.push(`O1: the reminder of ${text} was not cleared`);
  }
  const row = H.outbox.find((o) => o.content === "SEGUIMIENTO-WA");
  if (row?.sent !== 1) problems.push(`O1: the WhatsApp follow-up ended at sent=${row?.sent}`);
  H.compat = false;
}

let outboxBusy = false;
const outboxTimer = setInterval(async () => {
  if (outboxBusy || H.cfg.dbFailRate >= 1) return;
  outboxBusy = true;
  try {
    await W.flushOutbox(SETTINGS);
  } catch {
    /* next tick, like the bot */
  } finally {
    outboxBusy = false;
  }
}, 300);
const sweepTimer = setInterval(() => void W.runRecoverySweep().catch(() => undefined), 300);
const spoolTimer = setInterval(() => void W.replayInboundSpool().catch(() => undefined), 200);

async function quiesce(maxMs = 60_000) {
  const deadline = Date.now() + maxMs;
  let stable = 0;
  let last = "";
  while (Date.now() < deadline) {
    await wait(100);
    const busy =
      ENGINE.passQueued.size +
      ENGINE.passRunning.size +
      ENGINE.failures.size +
      H.outbox.filter((o) => o.sent === 0 || o.sent === 3).length;
    const sig = `${sends.length}|${H.messages.length}|${busy}`;
    if (busy === 0 && sig === last) {
      if (++stable >= 20) return true;
    } else stable = 0;
    last = sig;
  }
  return false;
}

// ── O2) Migrated: a follow-up that waited still clears the reminder ──
{
  const phone = "573019200003";
  const conv = await newConversation(phone);
  const t = nowS() - 5;
  conv.next_follow_up_at = t;
  down();
  H.outbox.push(outboxRow({ conversation_id: conv.id, phone, content: "SEGUIMIENTO-2", channel: "whatsapp", kind: "followup", scheduled_at: t, created_at: t }));
  // The account is down: the row is deferred (its scheduled time moves).
  await until(() => (H.outbox.find((o) => o.content === "SEGUIMIENTO-2")?.scheduled_at ?? t) > t, 10_000);
  up();
  await until(() => sendsTo(phone).length > 0, 15_000);
  await quiesce();
  if (sendsTo(phone).filter((x) => x.text === "SEGUIMIENTO-2").length !== 1) problems.push("O2: the follow-up was not delivered once");
  if (conv.next_follow_up_at != null) problems.push("O2: the delivered follow-up left the lead's reminder set");
}

// ── O3) Compat: a follow-up due while the AI is answering waits for it ──
{
  H.compat = true;
  const phone = "573019200004";
  const tag = tagOf(phone);
  const conv = await newConversation(phone);
  H.cfg.llmMin = 2500;
  H.cfg.llmMax = 2500;
  customer(phone, "O3-1", `${tag(1)} ¿cuánto cuesta el plan anual?`);
  await until(() => H.llmCalls.some((c) => c.lastKey === `1:whatsapp:${phone}`), 10_000);
  // The follow-up the operator scheduled comes due now.
  H.outbox.push(outboxRow({ conversation_id: conv.id, phone, content: "SEGUIMIENTO-3", channel: "whatsapp", kind: "followup", scheduled_at: nowS(), created_at: nowS() }));
  await quiesce();
  H.cfg.llmMin = 5;
  H.cfg.llmMax = 40;
  const reply = repliesTo(phone, 1);
  const followup = sendsTo(phone).filter((x) => x.text === "SEGUIMIENTO-3");
  if (reply.length !== 1) problems.push(`O3: the customer's question got ${reply.length} replies (the follow-up cancelled it)`);
  if (followup.length !== 1) problems.push(`O3: the follow-up was sent ${followup.length} times`);
  if (reply[0] && followup[0] && followup[0].at < reply[0].at) problems.push("O3: the follow-up went out before the reply");
  H.compat = false;
}

// ── O4) Migrated: HUMAN and back while a reply waits for its account ──
{
  const phone = "573019200005";
  const tag = tagOf(phone);
  down(A); // B stays online: rows of A are fetched (and judged) meanwhile
  customer(phone, "O4-1", `${tag(1)} hola, ¿tienen envíos?`);
  if (!(await until(() => queuedFor(phone).length > 0, 30_000))) problems.push("O4: the reply was not queued");
  const conv = H.convById.get(convOf(phone).id);
  conv.mode = "HUMAN";
  await wait(2500);
  conv.mode = "AI";
  await wait(500);
  up(A);
  await quiesce();
  if (repliesTo(phone, 1).length !== 1) {
    problems.push(`O4: the queued reply was delivered ${repliesTo(phone, 1).length} times (discarded while the chat was briefly HUMAN)`);
  }
}

clearInterval(outboxTimer);
clearInterval(sweepTimer);
clearInterval(spoolTimer);
const result = { scenario: "outbox: follow-ups, restarts and queued replies", problems, ok: problems.length === 0 };
console.info(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
