// Deterministic edge cases found in review, run against the REAL handler and
// reply engine:
//  A) Click-to-WhatsApp ad lead: the first message arrives without content
//     (stub), the WhatsApp Business greeting goes out, then the real content
//     arrives. The lead must stay with the AI (greeting recorded as
//     automated) and get answered.
//  B) A reply is queued while the account is down; the customer writes again
//     during the outage. On reconnect the queued reply goes out FIRST and the
//     next reply answers only what is new: no double answer, in order.
//  C) The database is down while a customer writes and an advisor answers
//     from the business phone: both go to the disk spool; when the database
//     comes back the advisor's message is stored, the AI is paused and never
//     answers over the advisor.
//  D) A reply waits in the queue (account down) and, during a database
//     outage, an advisor answers from the phone: the queued reply must not go
//     out while the advisor's message is still in the disk spool.
//  E) A new lead opens with a "view once" photo: stored with a marker, the
//     greeting is automated, the AI answers.
//  F) Without the migration, the bot restarts between a lead's message (only
//     in the disk spool) and the greeting: the lead stays with the AI.
//  G) An advisor's message this device cannot decrypt yet holds the AI back
//     until it can be read (then it pauses the AI).
//  H) Replaying from disk an advisor message whose pause already happened
//     does not pause the AI again over the operator's decision.
// The bot's REAL outbox and sender (src/lib/outbox-worker) run throughout.
// Usage: node scenario-edge.mjs <bundle dir> [--verbose]
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
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const B = await import(pathToFileURL(path.join(ROOT, "node_modules", "@whiskeysockets", "baileys", "lib", "index.js")).href);
F.resetHarness({ seed: 3 });
const H = F.harness();
const ENGINE = globalThis.__botwhaReplyEngine;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

// One fake account (same contract as client.ts).
const sends = [];
const listeners = {};
const own = new Set();
const sock = {
  ev: { on: (evt, fn) => (listeners[evt] ??= []).push(fn) },
  emit: (evt, data) => (listeners[evt] ?? []).forEach((fn) => fn(data)),
  user: { id: "573990000001:5@s.whatsapp.net" },
  signalRepository: { lidMapping: { getPNForLID: async () => null } },
};
const session = {
  accountId: 1,
  orgId: 1,
  open: true,
  ready: true,
  epoch: 1,
  buffered: [],
  isOwnMessage: (id) => own.has(id),
  phone: () => (session.open ? "573990000001" : null),
  knownPhone: () => "573990000001",
  isOpen: () => session.open,
  isReady: () => session.open && session.ready,
  readyEpoch: () => (session.open && session.ready ? session.epoch : null),
  waitReady: async (ms) => {
    const deadline = Date.now() + ms;
    while (!(session.open && session.ready)) {
      if (Date.now() > deadline) throw new Error("Socket de la cuenta 1 no disponible");
      await wait(20);
    }
    return session.epoch;
  },
  pnForLid: async () => null,
  send: async (jid, text, opts = {}) => {
    if (!session.open || !session.ready || (opts.readyEpoch !== undefined && opts.readyEpoch !== session.epoch)) {
      throw new Error("Socket de la cuenta 1 no disponible por ahora");
    }
    const id = opts.messageId;
    own.add(id);
    if (!sends.some((x) => x.id === id && x.jid === jid)) sends.push({ jid, text, id, at: Date.now() });
    return id;
  },
};
W.registerMessageHandler(sock, session);
const deliver = (messages, type = "notify") => {
  if (!session.isReady()) session.buffered.push(...messages);
  else sock.emit("messages.upsert", { type, messages });
};

H.sessions.set(1, session); // the client.ts registry the real outbox and sender use

// The REAL sender and outbox of the bot process (src/lib/outbox-worker): a
// 1 s tick, and a row whose account is down waits 3 s (shorter than prod).
Object.assign(W.OUTBOX_TIMING, {
  replyWaitOpenMs: 1000,
  deliveryTimeoutMs: 10_000,
  warmingDeferS: 1,
  downDeferS: 3,
  unsavedDeferS: 1,
  orderDeferS: 1,
  channelOffDeferS: 1,
});
let botSeq = 0;
W.configureReplyEngine({
  channels: ["whatsapp"],
  newMessageId: () => `BOT-${++botSeq}`,
  inboundPending: (conv) => W.hasUnsavedInbound(conv.org_id, conv.channel, conv.external_id),
  send: W.sendBotReply,
});
let outboxBusy = false;
const outboxTimer = setInterval(async () => {
  if (outboxBusy) return;
  outboxBusy = true;
  try {
    await W.flushOutbox(null);
  } catch {
    /* next tick, like the bot */
  } finally {
    outboxBusy = false;
  }
}, 1000);
const spoolTimer = setInterval(() => void W.replayInboundSpool().catch(() => undefined), 200);
const sweepTimer = setInterval(() => void W.runRecoverySweep().catch(() => undefined), 300);

async function quiesce(maxMs = 60_000) {
  const deadline = Date.now() + maxMs;
  let stable = 0;
  let last = "";
  while (Date.now() < deadline) {
    await wait(100);
    const busy =
      ENGINE.passQueued.size + ENGINE.passRunning.size + H.spooled.length + H.outbox.filter((o) => o.sent === 0 || o.sent === 3).length;
    const sig = `${sends.length}|${H.messages.length}|${busy}`;
    if (busy === 0 && sig === last) {
      if (++stable >= 20) return true;
    } else stable = 0;
    last = sig;
  }
  return false;
}

const problems = [];
const convOf = (phone) => H.conversations.get(`1|whatsapp|${phone}`);
const rows = (phone) => H.messages.filter((m) => m.conversation_id === convOf(phone)?.id);
const sendsTo = (phone) => sends.filter((x) => x.jid.startsWith(phone));

// ── A) Ad lead + greeting ────────────────────────────────────
{
  const phone = "573019000001";
  const jid = `${phone}@s.whatsapp.net`;
  const t = nowS();
  deliver([
    {
      key: { remoteJid: jid, fromMe: false, id: "CTWA-1" },
      messageStubType: B.WAMessageStubType.CIPHERTEXT,
      messageStubParameters: [B.NO_MESSAGE_FOUND_ERROR_TEXT],
      messageTimestamp: t,
      pushName: "Lead anuncio",
    },
  ]);
  await wait(50);
  deliver([{ key: { remoteJid: jid, fromMe: true, id: "GREETING-1" }, message: { conversation: "¡Hola! Gracias por escribirnos" }, messageTimestamp: t + 1 }]);
  await wait(300);
  deliver([{ key: { remoteJid: jid, fromMe: false, id: "CTWA-1" }, message: { conversation: `⟦k=1:whatsapp:${phone}|m=1⟧ Quiero info del plan` }, messageTimestamp: t, pushName: "Lead anuncio" }]);
  await quiesce();
  const conv = convOf(phone);
  if (!conv) problems.push("A: no conversation");
  else {
    if (conv.mode !== "AI") problems.push(`A: conversation is ${conv.mode} (the greeting took the lead away from the AI)`);
    const r = rows(phone);
    if (!r.some((m) => m.channel_msg_id === "auto:GREETING-1")) problems.push(`A: greeting not recorded as automated: ${JSON.stringify(r.map((m) => [m.role, m.channel_msg_id]))}`);
    if (!r.some((m) => m.role === "user" && m.channel_msg_id === "CTWA-1")) problems.push("A: real ad message not stored");
    if (r.some((m) => m.channel_msg_id === "CTWA-1#no-disponible")) problems.push("A: placeholder stored although the content arrived");
    if (sendsTo(phone).length !== 1) problems.push(`A: expected 1 AI reply, got ${sendsTo(phone).length}`);
    // A new lead is routed by the NUEVO stage rule exactly once, although
    // the greeting was stored before the customer's first message.
    const routed = H.routed.filter((x) => x.conversationId === conv.id && x.stage === "NUEVO").length;
    if (routed !== 1) problems.push(`A: new ad lead routed ${routed} times by the NUEVO stage rule (expected 1)`);
  }
}

// ── B) Queued reply, then a new message during the outage ───
{
  const phone = "573019000002";
  const jid = `${phone}@s.whatsapp.net`;
  const t = nowS();
  session.open = false;
  session.ready = false;
  // Q1 reaches the bot just before it drops (the live reply cannot go out).
  sock.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: jid, fromMe: false, id: "Q1" }, message: { conversation: `⟦k=1:whatsapp:${phone}|m=1⟧ ¿precio del plan básico?` }, messageTimestamp: t }],
  });
  // Wait until the reply was queued (3 live attempts fail).
  for (let i = 0; i < 300 && !H.outbox.some((o) => o.phone === phone); i++) await wait(100);
  if (!H.outbox.some((o) => o.phone === phone)) problems.push("B: reply was not queued");
  // Q2 arrives while still offline; on reconnect it comes in the backlog.
  deliver([{ key: { remoteJid: jid, fromMe: false, id: "Q2" }, message: { conversation: `⟦k=1:whatsapp:${phone}|m=2⟧ ¿me responden?` }, messageTimestamp: t + 30 }], "append");
  // Reconnect right after the outbox deferred the queued reply (as it does
  // with an account that is down): the live reply to Q2 would win the race.
  for (let i = 0; i < 100; i++) {
    const row = H.outbox.find((o) => o.phone === phone);
    if (row?.scheduled_at && row.scheduled_at * 1000 - Date.now() > 1000) break;
    await wait(50);
  }
  session.epoch++;
  session.open = true;
  await wait(50);
  const backlog = session.buffered.splice(0);
  if (backlog.length) sock.emit("messages.upsert", { type: "append", messages: backlog });
  session.ready = true;
  await quiesce();
  const s = sendsTo(phone);
  const replyTo = (n) => s.filter((x) => x.text.startsWith(`R⟦k=1:whatsapp:${phone}|m=${n}⟧`));
  if (replyTo(1).length !== 1) problems.push(`B: reply to the first question sent ${replyTo(1).length} times`);
  if (replyTo(2).length !== 1) problems.push(`B: reply to the second message sent ${replyTo(2).length} times`);
  if (replyTo(1)[0] && replyTo(2)[0] && replyTo(1)[0].at > replyTo(2)[0].at) problems.push("B: queued reply went out AFTER the newer one");
  if (s.length !== 2) problems.push(`B: expected 2 replies, got ${s.length}: ${s.map((x) => x.text.slice(0, 40)).join(" | ")}`);
  // The reply to the second message must have been written knowing the
  // queued one (otherwise it answers the first question again).
  const call2 = H.llmCalls.filter((c) => c.lastKey === `1:whatsapp:${phone}` && c.lastN === 2 && !c.failed).at(-1);
  if (call2 && !call2.assistantNs.includes(1)) problems.push("B: the reply to the second message was written without the queued reply in context (it answers the first question again)");
}

// ── C) Advisor writes while the database is down ─────────────
{
  const phone = "573019000003";
  const jid = `${phone}@s.whatsapp.net`;
  const t = nowS();
  H.cfg.dbFailRate = 1;
  deliver([{ key: { remoteJid: jid, fromMe: false, id: "C1" }, message: { conversation: `⟦k=1:whatsapp:${phone}|m=1⟧ necesito ayuda` }, messageTimestamp: t }]);
  await wait(100);
  deliver([{ key: { remoteJid: jid, fromMe: true, id: "ADVISOR-1" }, message: { conversation: "Hola, soy Ana, ya te ayudo" }, messageTimestamp: t + 40 }]);
  // Both end up in the spool (the customer's after its retries, the
  // advisor's because the contact already has spooled messages).
  for (let i = 0; i < 200 && H.spooled.length < 2; i++) await wait(100);
  if (H.spooled.length < 2) problems.push(`C: expected 2 spooled messages, got ${H.spooled.length}`);
  // The database comes back but the advisor's message still fails a few
  // times: the customer's message is stored first and, meanwhile, the
  // recovery sweep must NOT answer it.
  H.failHumanInserts = 6;
  H.cfg.dbFailRate = 0;
  await quiesce();
  const conv = convOf(phone);
  const r = rows(phone);
  if (!r.some((m) => m.role === "human" && m.channel_msg_id === "ADVISOR-1")) problems.push("C: advisor message lost");
  if (conv?.mode !== "HUMAN") problems.push(`C: AI not paused (mode ${conv?.mode})`);
  if (sendsTo(phone).length > 0) problems.push(`C: the AI answered over the advisor (${sendsTo(phone).length} send(s))`);
}

// ── D) Queued reply + advisor answers during a database outage ──
{
  const phone = "573019000004";
  const jid = `${phone}@s.whatsapp.net`;
  const t = nowS();
  session.open = false;
  session.ready = false;
  sock.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: jid, fromMe: false, id: "D1" }, message: { conversation: `⟦k=1:whatsapp:${phone}|m=1⟧ ¿siguen abiertos?` }, messageTimestamp: t }],
  });
  for (let i = 0; i < 300 && !H.outbox.some((o) => o.phone === phone); i++) await wait(100);
  if (!H.outbox.some((o) => o.phone === phone)) problems.push("D: reply was not queued");
  // The database goes down; the account comes back and the advisor answers
  // from the phone: the advisor's message ends up in the disk spool.
  H.cfg.dbFailRate = 1;
  session.epoch++;
  session.open = true;
  session.ready = true;
  deliver([{ key: { remoteJid: jid, fromMe: true, id: "ADVISOR-D" }, message: { conversation: "Hola, te escribe Luis, sí abrimos" }, messageTimestamp: t + 60 }]);
  for (let i = 0; i < 200 && H.spooled.length < 1; i++) await wait(100);
  if (H.spooled.length < 1) problems.push("D: the advisor's message did not reach the disk spool");
  // The database is back, but storing the advisor's message still fails for
  // a while: meanwhile the outbox runs and must not send the queued reply.
  H.failHumanUntil = Date.now() + 3000;
  H.cfg.dbFailRate = 0;
  await quiesce();
  const conv = convOf(phone);
  const r = rows(phone);
  if (!r.some((m) => m.role === "human" && m.channel_msg_id === "ADVISOR-D")) problems.push("D: advisor message lost");
  if (conv?.mode !== "HUMAN") problems.push(`D: AI not paused (mode ${conv?.mode})`);
  if (sendsTo(phone).length > 0) problems.push(`D: the queued reply went out over the advisor (${sendsTo(phone).length} send(s))`);
}

// ── E) A new lead's first message is a "view once" photo ─────
// (a linked device never gets its content): it is stored with a marker, the
// WhatsApp Business greeting that follows is automated, and the AI answers.
{
  const phone = "573019000005";
  const jid = `${phone}@s.whatsapp.net`;
  const t = nowS();
  deliver([{ key: { remoteJid: jid, fromMe: false, id: "VO-1", isViewOnce: true }, messageTimestamp: t, pushName: "Lead vista única" }]);
  await wait(100);
  deliver([{ key: { remoteJid: jid, fromMe: true, id: "GREETING-VO" }, message: { conversation: "¡Hola! Gracias por escribirnos" }, messageTimestamp: t + 2 }]);
  await wait(300);
  deliver([{ key: { remoteJid: jid, fromMe: false, id: "VO-2" }, message: { conversation: `⟦k=1:whatsapp:${phone}|m=2⟧ ¿vieron la foto?` }, messageTimestamp: t + 20, pushName: "Lead vista única" }]);
  await quiesce();
  const conv = convOf(phone);
  if (!conv) problems.push("E: no conversation (the view-once message was lost)");
  else {
    if (conv.mode !== "AI") problems.push(`E: conversation is ${conv.mode} (the greeting after a view-once was taken for an advisor)`);
    const r = rows(phone);
    if (!r.some((m) => m.role === "user" && m.channel_msg_id === "VO-1")) problems.push("E: the view-once message was not stored");
    if (!r.some((m) => m.channel_msg_id === "auto:GREETING-VO")) problems.push("E: greeting not recorded as automated");
    if (sendsTo(phone).length < 1) problems.push("E: the lead got no AI reply");
  }
}

// ── F) Without the migration: the bot restarts between a new lead's message
//       (only in the disk spool) and the WhatsApp Business greeting ──
{
  H.compat = true;
  const phone = "573019000006";
  const jid = `${phone}@s.whatsapp.net`;
  const t = nowS() - 30; // written before the restart
  // The previous process received it (journal → spool at boot) but never
  // stored it.
  F.spoolInbound({
    inbound: { orgId: 1, channel: "whatsapp", externalId: phone, phone, name: "Lead reinicio", text: `⟦k=1:whatsapp:${phone}|m=1⟧ hola, info`, dedupeKey: "RS-1", sentAt: t, waAccountId: 1 },
    route: { waAccountId: 1, jid, accountPhone: "573990000001" },
    spooledAt: t,
  });
  W.restoreSpooledContacts();
  // The greeting reaches THIS process, in its reconnect backlog.
  deliver([{ key: { remoteJid: jid, fromMe: true, id: "GREETING-RS" }, message: { conversation: "¡Hola! Gracias por escribirnos" }, messageTimestamp: t + 2 }], "append");
  await quiesce();
  const conv = convOf(phone);
  if (!conv) problems.push("F: no conversation");
  else {
    if (conv.mode !== "AI") problems.push(`F: conversation is ${conv.mode} (the greeting after a restart was taken for an advisor)`);
    if (sendsTo(phone).length !== 1) problems.push(`F: expected 1 AI reply, got ${sendsTo(phone).length}`);
  }
  H.compat = false;
}

// ── G) An advisor's message that this device cannot decrypt yet ──
// The AI must not answer the customer until it can be read: it may be the
// advisor answering from the phone.
{
  const phone = "573019000007";
  const jid = `${phone}@s.whatsapp.net`;
  const t = nowS();
  deliver([{ key: { remoteJid: jid, fromMe: false, id: "G1" }, message: { conversation: `⟦k=1:whatsapp:${phone}|m=1⟧ hola` }, messageTimestamp: t }]);
  await quiesce();
  const before = sendsTo(phone).length;
  deliver([
    { key: { remoteJid: jid, fromMe: false, id: "G2" }, message: { conversation: `⟦k=1:whatsapp:${phone}|m=2⟧ ¿y el precio?` }, messageTimestamp: t + 40 },
    { key: { remoteJid: jid, fromMe: true, id: "ADVISOR-G" }, messageStubType: B.WAMessageStubType.CIPHERTEXT, messageStubParameters: ["Bad MAC"], messageTimestamp: t + 45 },
  ]);
  await wait(2500);
  if (sendsTo(phone).length > before) problems.push("G: the AI answered while an advisor's message was still unreadable");
  // The re-send arrives, readable.
  deliver([{ key: { remoteJid: jid, fromMe: true, id: "ADVISOR-G" }, message: { conversation: "Hola, soy Ana" }, messageTimestamp: t + 45 }]);
  await quiesce();
  if (!rows(phone).some((m) => m.role === "human" && m.channel_msg_id === "ADVISOR-G")) problems.push("G: the advisor's message was not stored");
  if (convOf(phone)?.mode !== "HUMAN") problems.push(`G: AI not paused (mode ${convOf(phone)?.mode})`);
  if (sendsTo(phone).length > before) problems.push("G: the AI answered over the advisor");
}

// ── H) Replayed from disk: an advisor message whose pause already happened ──
// The operator handed the chat back to the AI; replaying the same entry must
// not pause it again.
{
  const phone = "573019000008";
  const t = nowS();
  const conv = await F.withDbRetry(() => F.getOrCreateConversation(1, "whatsapp", phone, { phone }), { attempts: 20 });
  await F.withDbRetry(() => F.insertMessageIdempotent(conv.id, "user", `⟦k=1:whatsapp:${phone}|m=1⟧ hola`, { channelMsgId: "H1", sentAt: t }), { attempts: 20 });
  await F.withDbRetry(() => F.insertMessageIdempotent(conv.id, "human", "Hola, soy Luis", { channelMsgId: "ADVISOR-H" }), { attempts: 20 });
  H.events.push({ conversationId: conv.id, type: "handoff", detail: "pausa", at: nowS() });
  H.convById.get(conv.id).mode = "AI";
  F.spoolInbound({
    inbound: { orgId: 1, channel: "whatsapp", externalId: phone, phone, name: null, text: "Hola, soy Luis", dedupeKey: "ADVISOR-H", sentAt: t + 60, waAccountId: 1 },
    route: null,
    spooledAt: t,
    staff: { customerBefore: null, customerKey: null },
  });
  W.restoreSpooledContacts();
  await quiesce();
  if (convOf(phone)?.mode !== "AI") problems.push("H: replaying an already-handled advisor message paused the AI again (overriding the operator)");
}

if (process.env.DEBUG_EDGE) {
  process.stderr.write(`SENDS ${JSON.stringify(sends.map((x) => [x.jid.slice(0, 12), x.text.slice(0, 34), x.at % 100000]))}\n`);
  process.stderr.write(`OUTBOX ${JSON.stringify(H.outbox.map((o) => [o.id, o.phone, o.sent, o.kind, o.covers_msg_id, o.created_at]))}\n`);
}
clearInterval(outboxTimer);
clearInterval(spoolTimer);
clearInterval(sweepTimer);
if (H.journal.size > 0) problems.push(`journal not drained (${H.journal.size})`);
const result = {
  scenario: "edge cases (ad greeting, queued reply order, advisor during outage, queued reply vs spooled advisor, view-once, greeting after restart, unreadable advisor message, replay from disk)",
  problems,
  ok: problems.length === 0,
};
console.info(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
