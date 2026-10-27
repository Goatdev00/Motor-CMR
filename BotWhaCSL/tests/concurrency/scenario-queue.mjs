// Replies that cannot go out live (account down) and the bot's REAL outbox
// (src/lib/outbox-worker), deterministic, against the REAL handler, reply
// engine and sender:
//  Q1) Without the BLINDAJE migration nothing is queued (a queued reply could
//      not say which message it answers): the reply is retried live, also
//      across a restart, and every message gets exactly one answer.
//  Q2) With the migration, a message stored while a reply waits in the queue
//      is answered after a restart (the queued reply says what it covers).
//  Q3) While a reply waits in the queue, new customer messages do not start
//      one more 3 s polling loop each.
//  Q4) A reply whose enqueue really failed is not taken as delivered because
//      another bot reply was stored later (both modes).
//  Q5) Two keyword replies while the account is down: both arrive, in order
//      (both modes); in HUMAN mode too, across a restart (also without the
//      migration: the restart resumes the retry it had pending).
//  Q6) A queued reply stuck on a disconnected account that an advisor already
//      answered does not hold back the advisor's message (another account).
//  Q7) After a restart, a queued reply that went out but is not yet in the
//      thread is not answered a second time.
//  Q8) Two messages to the same customer whose ids and creation times
//      disagree never block each other.
//  Q9) Queued replies expire even when no WhatsApp session is open.
//  Q10) A reply that reached the customer although its send failed is
//      retried with the same id and text, never as a second, different reply.
//  Q11) Without the migration, a customer who asks for a human while the
//      account is down gets the acknowledgement once the account is back
//      (also across a restart), and never over an advisor who wrote first.
//  Q12) Without the migration, a restart while a reply is being retried does
//      not leave that message unanswered, although a bot reply to an earlier
//      message was stored after it.
//  Q13) With the migration, the AI's own handoff reply that had to wait in
//      the queue is delivered (the handoff it triggers does not discard it).
//  Q14) Without the migration, the same keyword twice: the second reply,
//      whose enqueue failed, is not taken as delivered because of the first
//      one (same text).
// Usage: node scenario-queue.mjs <bundle dir> [--verbose]
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
F.resetHarness({ seed: 5 });
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
      // Test hook: the message went out but the send still failed (the
      // connection dropped before the confirmation).
      if (s.deliverThenFail > 0) {
        s.deliverThenFail--;
        throw new Error("Connection Closed");
      }
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

// The REAL sender and outbox of the bot process, with shorter waits.
Object.assign(W.OUTBOX_TIMING, {
  replyWaitOpenMs: 1000,
  deliveryTimeoutMs: 10_000,
  warmingDeferS: 1,
  downDeferS: 1,
  unsavedDeferS: 1,
  orderDeferS: 1,
  channelOffDeferS: 1,
});
let botSeq = 0;
// The retry journal on "disk" (reply-retry-store.ts in production): what a
// restart keeps.
const retryDisk = {
  data: "{}",
  load() {
    return JSON.parse(this.data);
  },
  save(entries) {
    this.data = JSON.stringify(entries);
  },
};
const ENGINE_CONFIG = {
  channels: ["whatsapp"],
  newMessageId: () => `BOT-${++botSeq}`,
  inboundPending: (conv) => W.hasUnsavedInbound(conv.org_id, conv.channel, conv.external_id),
  send: W.sendBotReply,
  retryStore: retryDisk,
};
W.configureReplyEngine(ENGINE_CONFIG);
const ACK = "Claro, te comunico con un asesor humano. En un momento te atienden.";
let outboxBusy = false;
let outboxPaused = false;
const outboxTimer = setInterval(async () => {
  if (outboxBusy || outboxPaused || H.cfg.dbFailRate >= 1) return;
  outboxBusy = true;
  try {
    await W.flushOutbox(null);
  } catch {
    /* next tick, like the bot */
  } finally {
    outboxBusy = false;
  }
}, 300);
const spoolTimer = setInterval(() => void W.replayInboundSpool().catch(() => undefined), 200);
const sweepTimer = setInterval(() => void W.runRecoverySweep().catch(() => undefined), 300);

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
      H.spooled.length +
      H.outbox.filter((o) => o.sent === 0 || o.sent === 3).length;
    const sig = `${sends.length}|${H.messages.length}|${busy}`;
    if (busy === 0 && sig === last) {
      if (++stable >= 20) return true;
    } else stable = 0;
    last = sig;
  }
  return false;
}
const until = async (cond, maxMs) => {
  const deadline = Date.now() + maxMs;
  while (!cond() && Date.now() < deadline) await wait(50);
  return cond();
};

// What a restart loses: everything the engine keeps in memory, including the
// passes it had scheduled for later. What it keeps: the retry journal on
// disk, which the new process reads when it configures the engine.
function simulateRestart() {
  W.clearReplyTimers();
  for (const key of [
    "answeredUpTo",
    "evaluatedUpTo",
    "settledUpTo",
    "queuedAttempts",
    "staleDiscards",
    "failures",
    "routes",
    "sentAtById",
    "pendingAcks",
    "unconfirmed",
    "seenUpTo",
    "journal",
    "resume",
  ]) {
    ENGINE[key]?.clear();
  }
  W.configureReplyEngine(ENGINE_CONFIG);
}

const problems = [];
const convOf = (phone) => H.conversations.get(`1|whatsapp|${phone}`);
const sendsTo = (phone) => sends.filter((x) => x.jid.startsWith(phone));
const repliesTo = (phone, n) => sendsTo(phone).filter((x) => x.text.startsWith(`R⟦k=1:whatsapp:${phone}|m=${n}⟧`));
const queuedFor = (phone) => H.outbox.filter((o) => o.phone === phone);
const tagOf = (phone) => (n) => `⟦k=1:whatsapp:${phone}|m=${n}⟧`;

// ── Q1) Compat: nothing queued, answered live, also across a restart ──
{
  H.compat = true;
  const phone = "573019100001";
  const tag = tagOf(phone);
  down();
  customer(phone, "Q1-1", `${tag(1)} ¿tienen envíos?`);
  // The live attempts fail and there is no queue: the pass fails.
  if (!(await until(() => ENGINE.failures.has(convOf(phone)?.id), 30_000))) problems.push("Q1: the failed reply was not reported as a failed pass");
  if (queuedFor(phone).length > 0) problems.push("Q1: a reply was queued without the migration");
  simulateRestart();
  customer(phone, "Q1-2", `${tag(2)} ¿hola? ¿y a Medellín?`);
  await until(() => H.messages.some((m) => m.content.startsWith(tag(2))), 5000);
  await wait(500);
  up();
  await quiesce();
  const s = sendsTo(phone);
  if (repliesTo(phone, 2).length !== 1 || s.length !== 1) {
    problems.push(`Q1: expected one live reply to the latest message, got ${s.map((x) => x.text.slice(0, 32)).join(" | ") || "none"}`);
  }
  if (queuedFor(phone).length > 0) problems.push("Q1: something reached the queue");
  H.compat = false;
}

// ── Q2) Migrated: a message stored while the reply waits, then a restart ──
{
  const phone = "573019100002";
  const tag = tagOf(phone);
  down();
  customer(phone, "Q2-1", `${tag(1)} ¿tienen envíos?`);
  if (!(await until(() => queuedFor(phone).length > 0, 30_000))) problems.push("Q2: the reply was not queued");
  customer(phone, "Q2-2", `${tag(2)} ¿hola?`);
  await until(() => H.messages.some((m) => m.content.startsWith(tag(2))), 5000);
  await wait(500);
  simulateRestart();
  up();
  await quiesce();
  if (repliesTo(phone, 1).length !== 1) problems.push(`Q2: queued reply to the first message sent ${repliesTo(phone, 1).length} times`);
  if (repliesTo(phone, 2).length !== 1) problems.push(`Q2: the message stored while the reply was queued got ${repliesTo(phone, 2).length} replies (expected 1)`);
}

// ── Q3) One wait per conversation while a reply is queued ────
{
  const phone = "573019100003";
  const tag = tagOf(phone);
  down();
  customer(phone, "Q3-1", `${tag(1)} hola`);
  if (!(await until(() => queuedFor(phone).length > 0, 30_000))) problems.push("Q3: the reply was not queued");
  for (let n = 2; n <= 6; n++) {
    customer(phone, `Q3-${n}`, `${tag(n)} ?`);
    await wait(100);
  }
  await wait(1000);
  const c0 = H.queueChecks;
  await wait(6200);
  const polls = H.queueChecks - c0;
  if (polls > 4) problems.push(`Q3: ${polls} queue checks in 6 s while waiting (the retries multiplied with each message)`);
  up();
  await quiesce();
  const s = sendsTo(phone);
  if (repliesTo(phone, 1).length !== 1) problems.push(`Q3: reply to the first message sent ${repliesTo(phone, 1).length} times`);
  if (repliesTo(phone, 6).length !== 1 || s.length !== 2) {
    problems.push(`Q3: expected the queued reply plus one reply to the latest message, got ${s.map((x) => x.text.slice(0, 32)).join(" | ")}`);
  }
}

// ── Q4) A failed enqueue is not "delivered" by a reply stored later ──
for (const compat of [false, true]) {
  H.compat = compat;
  const label = compat ? "Q4 (sin migración)" : "Q4";
  const phone = compat ? "573019100005" : "573019100004";
  const tag = tagOf(phone);
  // The first reply goes out but cannot be stored in the thread yet.
  H.failAssistantInserts = 5;
  customer(phone, `${label}-1`, `${tag(1)} quiero cotizar`);
  if (!(await until(() => repliesTo(phone, 1).length === 1 && H.failAssistantInserts === 0, 10_000))) {
    problems.push(`${label}: the first reply did not go out`);
  }
  await wait(300);
  // The account drops; the next reply fails live and then cannot be queued.
  down();
  H.failEnqueues = 5;
  customer(phone, `${label}-2`, `${tag(2)} ¿y el precio?`);
  if (!(await until(() => ENGINE.failures.has(convOf(phone)?.id), 30_000))) problems.push(`${label}: the reply that could not be queued did not fail its pass`);
  H.failEnqueues = 0;
  await wait(300);
  // The database is back: the first reply gets stored now (after the
  // failed enqueue). Then the account reconnects and the pass is retried.
  await W.flushPendingRecords();
  up();
  W.scheduleReplyPass(convOf(phone).id);
  await quiesce();
  if (queuedFor(phone).length > 0) problems.push(`${label}: something reached the queue although every enqueue failed`);
  if (repliesTo(phone, 2).length !== 1) problems.push(`${label}: the message whose reply could not be queued got ${repliesTo(phone, 2).length} replies (expected 1)`);
  H.compat = false;
}

// ── Q5) Two keyword replies with the account down ────────────
async function twoKeywords({ phone, compat, human, restart, label }) {
  H.compat = compat;
  H.triggers = [
    { keyword: "precio", content: "Lista de precios", also_human: human },
    { keyword: "horario", content: "Horario de atención", also_human: human },
  ];
  const tag = tagOf(phone);
  if (human) {
    const conv = await F.withDbRetry(() => F.getOrCreateConversation(1, "whatsapp", phone, { phone }), { attempts: 20 });
    H.convById.get(conv.id).mode = "HUMAN";
  }
  // Both messages arrive while the database is down (disk spool): the pass
  // that answers them sees both at once, with the account still down.
  down();
  H.cfg.dbFailRate = 1;
  customer(phone, `${label}-1`, `${tag(1)} precio`);
  await wait(50);
  customer(phone, `${label}-2`, `${tag(2)} horario`);
  if (!(await until(() => H.spooled.length >= 2, 20_000))) problems.push(`${label}: expected 2 spooled messages, got ${H.spooled.length}`);
  H.cfg.dbFailRate = 0;
  // The first keyword reply cannot go out live (queued, or with no queue the
  // pass fails and is retried).
  await until(() => queuedFor(phone).length > 0 || ENGINE.failures.has(convOf(phone)?.id), 30_000);
  // Long enough for a second reply to pile up behind it, if the pass kept going.
  await wait(12_000);
  if (restart) simulateRestart();
  up();
  await quiesce(90_000);
  const k = (n) => sendsTo(phone).filter((x) => x.text.startsWith(`K${tag(n)}`));
  if (k(1).length !== 1) problems.push(`${label}: keyword reply to "precio" sent ${k(1).length} times`);
  if (k(2).length !== 1) problems.push(`${label}: keyword reply to "horario" sent ${k(2).length} times`);
  if (k(1)[0] && k(2)[0] && k(1)[0].at > k(2)[0].at) problems.push(`${label}: keyword replies out of order`);
  H.compat = false;
  H.triggers = [];
}
await twoKeywords({ phone: "573019100006", compat: true, human: false, restart: false, label: "Q5 (sin migración)" });
await twoKeywords({ phone: "573019100007", compat: false, human: false, restart: false, label: "Q5" });
await twoKeywords({ phone: "573019100008", compat: false, human: true, restart: true, label: "Q5 (HUMANO, reinicio)" });
await twoKeywords({ phone: "573019100020", compat: true, human: true, restart: true, label: "Q5 (sin migración, HUMANO, reinicio)" });

// ── Q6) A superseded queued reply on a down account does not hold back the advisor ──
{
  const phone = "573019100009";
  const tag = tagOf(phone);
  // The lead is assigned to a salesperson whose account is B; the customer
  // wrote to A, which drops: the AI reply is queued on A.
  H.members = [{ id: 7, name: "Vendedor", active: true, wa_account_id: 2, role: "SELLER" }];
  down(A);
  customer(phone, "Q6-1", `${tag(1)} hola`, A);
  if (!(await until(() => queuedFor(phone).length > 0, 30_000))) problems.push("Q6: the reply was not queued");
  const conv = H.convById.get(convOf(phone).id);
  conv.assigned_member_id = 7;
  // The salesperson answers from the dashboard (goes out through B).
  await F.withDbRetry(() => F.insertHumanMessage(conv.id, "VENDEDOR: hola, te atiendo yo"), { attempts: 20 });
  const t = Date.now();
  await until(() => sendsTo(phone).some((x) => x.text.startsWith("VENDEDOR")), 15_000);
  const sent = sendsTo(phone).find((x) => x.text.startsWith("VENDEDOR"));
  if (!sent) problems.push("Q6: the advisor's message was held back behind the queued reply of the disconnected account");
  else if (sent.accountId !== 2) problems.push(`Q6: the advisor's message went out through account ${sent.accountId}`);
  else if (sent.at - t > 8000) problems.push(`Q6: the advisor's message waited ${Math.round((sent.at - t) / 1000)} s`);
  if (sendsTo(phone).some((x) => x.text.startsWith("R"))) problems.push("Q6: the AI reply went out after the advisor answered");
  up(A);
  await quiesce();
  if (sendsTo(phone).some((x) => x.text.startsWith("R"))) problems.push("Q6: the AI reply went out after the advisor answered");
  H.members = [];
}

// ── Q7) Restart: the queued reply went out but is not in the thread yet ──
{
  const phone = "573019100010";
  const tag = tagOf(phone);
  down();
  customer(phone, "Q7-1", `${tag(1)} hola`);
  if (!(await until(() => queuedFor(phone).length > 0, 30_000))) problems.push("Q7: the reply was not queued");
  simulateRestart();
  // When the outbox delivers it, storing it in the thread fails for a while.
  H.failAssistantInserts = 1_000;
  up();
  await until(() => sendsTo(phone).length > 0, 15_000);
  // Meanwhile the engine (no memory of this conversation) looks at it.
  W.scheduleReplyPass(convOf(phone).id);
  await wait(3000);
  H.failAssistantInserts = 0;
  await quiesce();
  if (repliesTo(phone, 1).length !== 1) problems.push(`Q7: the message was answered ${repliesTo(phone, 1).length} times (the delivered reply was not in the thread yet)`);
}

// ── Q8) Ids and creation times that disagree never block each other ──
{
  const phone = "573019100011";
  const conv = await F.withDbRetry(() => F.getOrCreateConversation(1, "whatsapp", phone, { phone }), { attempts: 20 });
  H.convById.get(conv.id).mode = "HUMAN";
  H.convById.get(conv.id).wa_account_id = 1;
  const t = nowS();
  // Two operator messages; the second row got the EARLIER creation time.
  const row = (content, created_at) => ({
    id: ++H.outboxSeq,
    conversation_id: conv.id,
    phone,
    content,
    channel: "whatsapp",
    org_id: 1,
    kind: "manual",
    covers_msg_id: null,
    channel_msg_id: null,
    account_phone: null,
    wa_account_id: null,
    sent: 0,
    attempts: 0,
    scheduled_at: null,
    created_at,
  });
  W.OUTBOX_TIMING.orderDeferS = 0;
  H.outbox.push(row("OP-1 primero", t), row("OP-2 segundo", t - 5));
  await until(() => sendsTo(phone).length >= 2, 10_000);
  W.OUTBOX_TIMING.orderDeferS = 1;
  const texts = sendsTo(phone).map((x) => x.text);
  if (texts.length !== 2 || texts[0] !== "OP-1 primero") problems.push(`Q8: operator messages ${texts.length ? `out of order: ${texts.join(" | ")}` : "never sent (blocked each other)"}`);
}

// ── Q10) A reply that went out although its send failed is not answered
//        again with a different message (without the migration: no queue) ──
{
  H.compat = true;
  const phone = "573019100013";
  const tag = tagOf(phone);
  A.deliverThenFail = 1;
  customer(phone, "Q10-1", `${tag(1)} ¿abren el domingo?`);
  // The first attempt reaches the customer but fails; then the account drops.
  await until(() => sendsTo(phone).length === 1, 10_000);
  down();
  if (!(await until(() => ENGINE.failures.has(convOf(phone)?.id), 30_000))) problems.push("Q10: the unconfirmed reply did not fail its pass");
  up();
  W.scheduleReplyPass(convOf(phone).id);
  await quiesce();
  const s = sendsTo(phone);
  if (s.length !== 1) problems.push(`Q10: the customer got ${s.length} replies to the same message: ${s.map((x) => x.text.slice(0, 32)).join(" | ")}`);
  const recorded = H.messages.filter((m) => m.conversation_id === convOf(phone)?.id && m.role === "assistant");
  if (recorded.length !== 1) problems.push(`Q10: ${recorded.length} replies recorded in the thread (expected 1)`);
  else if (s[0] && recorded[0].content !== s[0].text) problems.push("Q10: the thread records a reply different from the one the customer got");
  H.compat = false;
}

// ── Q9) Queued replies expire with no WhatsApp session open ───
{
  const phone = "573019100012";
  const tag = tagOf(phone);
  down(A);
  down(B);
  customer(phone, "Q9-1", `${tag(1)} hola`);
  if (!(await until(() => queuedFor(phone).length > 0, 30_000))) problems.push("Q9: the reply was not queued");
  W.OUTBOX_TIMING.botReplyTtlS = 2;
  W.OUTBOX_TIMING.staleSweepEveryS = 0;
  await until(() => queuedFor(phone).every((o) => o.sent === 2), 15_000);
  W.OUTBOX_TIMING.botReplyTtlS = 30 * 60;
  W.OUTBOX_TIMING.staleSweepEveryS = 30;
  if (!queuedFor(phone).every((o) => o.sent === 2)) problems.push("Q9: the queued reply never expired while no session was open");
  await wait(500);
  if (convOf(phone)?.mode !== "HUMAN") problems.push("Q9: the conversation was not handed to an advisor when its reply expired");
  up(A);
  up(B);
  await quiesce();
  if (sendsTo(phone).length > 0) problems.push("Q9: the expired reply went out anyway");
}

// ── Q11) Compat: the handoff acknowledgement with the account down ──
for (const variant of ["plain", "advisor", "restart"]) {
  H.compat = true;
  const phone = { plain: "573019100014", advisor: "573019100015", restart: "573019100016" }[variant];
  const label = `Q11 (${variant})`;
  const tag = tagOf(phone);
  down();
  customer(phone, `${label}-1`, `${tag(1)} quiero hablar con un asesor`);
  if (!(await until(() => ENGINE.failures.has(convOf(phone)?.id), 30_000))) problems.push(`${label}: the unsent acknowledgement did not fail its pass`);
  if (convOf(phone)?.mode !== "HUMAN") problems.push(`${label}: the conversation did not go to an advisor`);
  if (variant === "advisor") {
    await F.withDbRetry(() => F.insertHumanMessage(convOf(phone).id, "ASESOR: hola, soy Ana"), { attempts: 20 });
  }
  if (variant === "restart") simulateRestart();
  up();
  await quiesce(90_000);
  const acks = sendsTo(phone).filter((x) => x.text === ACK).length;
  const want = variant === "advisor" ? 0 : 1;
  if (acks !== want) problems.push(`${label}: acknowledgement sent ${acks} times (expected ${want})`);
  if (variant === "advisor" && !sendsTo(phone).some((x) => x.text.startsWith("ASESOR"))) {
    problems.push(`${label}: the advisor's message did not go out`);
  }
  if (sendsTo(phone).some((x) => x.text.startsWith("R"))) problems.push(`${label}: the AI answered a customer who asked for a human`);
  H.compat = false;
}

// ── Q12) Compat: restart while a reply is retried, with a bot reply to an
//         earlier message of the burst stored after it ──
{
  H.compat = true;
  H.triggers = [{ keyword: "precio", content: "Lista de precios", also_human: false }];
  const phone = "573019100017";
  const tag = tagOf(phone);
  // Both messages are stored before the pass runs (database down: disk
  // spool), and the account drops right after the keyword reply goes out:
  // that reply lands in the thread AFTER the second message.
  const send = A.send;
  A.send = async (jid, text, opts) => {
    const r = await send(jid, text, opts);
    if (jid.startsWith(phone) && text.startsWith("K")) down();
    return r;
  };
  H.cfg.dbFailRate = 1;
  customer(phone, "Q12-1", `${tag(1)} precio`);
  await wait(50);
  customer(phone, "Q12-2", `${tag(2)} ¿y hacen envíos?`);
  if (!(await until(() => H.spooled.length >= 2, 20_000))) problems.push(`Q12: expected 2 spooled messages, got ${H.spooled.length}`);
  H.cfg.dbFailRate = 0;
  if (!(await until(() => ENGINE.failures.has(convOf(phone)?.id), 40_000))) problems.push("Q12: the AI reply that could not go out did not fail its pass");
  A.send = send;
  simulateRestart();
  up();
  await quiesce(90_000);
  const k = sendsTo(phone).filter((x) => x.text.startsWith(`K${tag(1)}`)).length;
  if (k !== 1) problems.push(`Q12: keyword reply sent ${k} times`);
  if (repliesTo(phone, 2).length !== 1) {
    problems.push(`Q12: the message whose reply was being retried at the restart got ${repliesTo(phone, 2).length} replies (expected 1)`);
  }
  H.triggers = [];
  H.compat = false;
}

// ── Q13) Migrated: the AI's own handoff reply waits in the queue ──
{
  const phone = "573019100018";
  const tag = tagOf(phone);
  H.llmReply = () => "Déjame derivarte con un asesor humano.";
  down();
  customer(phone, "Q13-1", `${tag(1)} necesito algo muy específico`);
  if (!(await until(() => queuedFor(phone).length > 0, 30_000))) problems.push("Q13: the reply was not queued");
  await until(() => convOf(phone)?.mode === "HUMAN", 5000);
  if (convOf(phone)?.mode !== "HUMAN") problems.push("Q13: the conversation was not handed to an advisor");
  H.llmReply = null;
  up();
  await quiesce();
  const n = sendsTo(phone).filter((x) => x.text.startsWith("Déjame derivarte")).length;
  if (n !== 1) problems.push(`Q13: the queued handoff reply was delivered ${n} times (expected 1)`);
}

// ── Q14) Compat: the same keyword twice, the second enqueue fails ──
{
  H.compat = true;
  H.fixedKeywordText = true;
  H.triggers = [{ keyword: "precio", content: "Lista de precios", also_human: false }];
  const phone = "573019100019";
  const tag = tagOf(phone);
  customer(phone, "Q14-1", `${tag(1)} precio`);
  if (!(await until(() => sendsTo(phone).length === 1, 10_000))) problems.push("Q14: the first keyword reply did not go out");
  await wait(500);
  down();
  H.failEnqueues = 5;
  customer(phone, "Q14-2", `${tag(2)} precio por favor`);
  if (!(await until(() => ENGINE.failures.has(convOf(phone)?.id), 30_000))) problems.push("Q14: the second keyword reply did not fail its pass");
  H.failEnqueues = 0;
  up();
  await quiesce();
  const n = sendsTo(phone).filter((x) => x.text === "Lista de precios").length;
  if (n !== 2) problems.push(`Q14: ${n} keyword replies for two "precio" messages (expected 2)`);
  if (sendsTo(phone).some((x) => x.text.startsWith("R"))) problems.push("Q14: the AI answered a keyword message");
  H.triggers = [];
  H.fixedKeywordText = false;
  H.compat = false;
}

if (process.env.DEBUG_QUEUE) {
  process.stderr.write(`SENDS ${JSON.stringify(sends.map((x) => [x.jid.slice(0, 12), x.accountId, x.text.slice(0, 34), x.at % 100000]))}\n`);
  process.stderr.write(`OUTBOX ${JSON.stringify(H.outbox.map((o) => [o.id, o.phone, o.sent, o.kind, o.covers_msg_id, o.created_at, o.scheduled_at]))}\n`);
}
clearInterval(outboxTimer);
clearInterval(spoolTimer);
clearInterval(sweepTimer);
if (H.journal.size > 0) problems.push(`journal not drained (${H.journal.size})`);
const result = { scenario: "replies that cannot go out live, and the real outbox", problems, ok: problems.length === 0 };
console.info(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
