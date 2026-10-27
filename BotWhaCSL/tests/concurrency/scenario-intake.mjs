// Messages written from the business phone, against the REAL handler, reply
// engine and outbox:
//  I1) An advisor message this device could not decrypt arrives again as a
//      reaction (nothing to store): it does not become a phantom advisor
//      message that pauses the AI a minute later.
//  I2) Without the migration, the WhatsApp Business greeting is learned (so a
//      slower one is recognized too) and remembered across a restart.
//  I3) Without the migration, replaying from disk an advisor message that the
//      earlier attempt already stored does not store it twice nor pause the
//      AI again over the operator's decision.
//  I4) An unreadable automatic greeting does not teach its generic marker:
//      a later unreadable advisor message still pauses the AI.
// Usage: node scenario-intake.mjs <bundle dir> [--verbose]
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
const WA_URL = pathToFileURL(path.join(OUT, "wa.js")).href;
const W = await import(WA_URL);
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const B = await import(pathToFileURL(path.join(ROOT, "node_modules", "@whiskeysockets", "baileys", "lib", "index.js")).href);
F.resetHarness({ seed: 11 });
const H = F.harness();
const ENGINE = globalThis.__botwhaReplyEngine;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

// One account (same contract as client.ts). A restart registers a new socket
// on a fresh copy of the handler module (its memory is lost; the disk stays).
const sends = [];
const own = new Set();
function makeAccount(mod) {
  const listeners = {};
  const sock = {
    ev: { on: (evt, fn) => (listeners[evt] ??= []).push(fn) },
    emit: (evt, data) => (listeners[evt] ?? []).forEach((fn) => fn(data)),
    user: { id: "573990000001:5@s.whatsapp.net" },
    signalRepository: { lidMapping: { getPNForLID: async () => null } },
  };
  const session = {
    accountId: 1,
    orgId: 1,
    isOwnMessage: (id) => own.has(id),
    phone: () => "573990000001",
    knownPhone: () => "573990000001",
    isOpen: () => true,
    isReady: () => true,
    readyEpoch: () => 1,
    waitReady: async () => 1,
    pnForLid: async () => null,
    send: async (jid, text, opts = {}) => {
      const id = opts.messageId;
      own.add(id);
      if (!sends.some((x) => x.id === id && x.jid === jid)) sends.push({ jid, text, id, at: Date.now() });
      return id;
    },
  };
  mod.registerMessageHandler(sock, session);
  H.sessions.set(1, session);
  return (messages) => sock.emit("messages.upsert", { type: "notify", messages });
}
let deliver = makeAccount(W);

Object.assign(W.OUTBOX_TIMING, { replyWaitOpenMs: 1000, deliveryTimeoutMs: 10_000, unsavedDeferS: 1, orderDeferS: 1 });
let botSeq = 0;
// The handler module of the running "process" (a restart swaps it).
let M = W;
const configureEngine = () =>
  M.configureReplyEngine({
    channels: ["whatsapp"],
    newMessageId: () => `BOT-${++botSeq}`,
    inboundPending: (conv) => M.hasUnsavedInbound(conv.org_id, conv.channel, conv.external_id),
    send: M.sendBotReply,
  });
configureEngine();
const spoolTimer = setInterval(() => void M.replayInboundSpool().catch(() => undefined), 200);
const sweepTimer = setInterval(() => void M.runRecoverySweep().catch(() => undefined), 300);

async function quiesce(maxMs = 30_000) {
  const deadline = Date.now() + maxMs;
  let stable = 0;
  let last = "";
  while (Date.now() < deadline) {
    await wait(100);
    const busy = ENGINE.passQueued.size + ENGINE.passRunning.size + H.spooled.length;
    const sig = `${sends.length}|${H.messages.length}|${busy}`;
    if (busy === 0 && sig === last) {
      if (++stable >= 15) return true;
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

const problems = [];
const convOf = (phone) => H.conversations.get(`1|whatsapp|${phone}`);
const rows = (phone) => H.messages.filter((m) => m.conversation_id === convOf(phone)?.id);
const sendsTo = (phone) => sends.filter((x) => x.jid.startsWith(phone));
const tagOf = (phone) => (n) => `⟦k=1:whatsapp:${phone}|m=${n}⟧`;
const repliesTo = (phone, n) => sendsTo(phone).filter((x) => x.text.startsWith(`R${tagOf(phone)(n)}`));
const fromCustomer = (phone, id, text, ts) => ({
  key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id },
  message: { conversation: text },
  messageTimestamp: ts,
});
const fromBusiness = (phone, id, text, ts) => ({
  key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: true, id },
  message: { conversation: text },
  messageTimestamp: ts,
});
const unreadableFromBusiness = (phone, id, ts) => ({
  key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: true, id },
  messageStubType: B.WAMessageStubType.CIPHERTEXT,
  messageStubParameters: ["Bad MAC"],
  messageTimestamp: ts,
});
const GREETING = "¡Hola! Gracias por escribirnos. En breve te atendemos.";

// ── I1) An unreadable advisor message whose re-send is a reaction ──
{
  const phone = "573019300001";
  const tag = tagOf(phone);
  const t = nowS() - 120;
  deliver([fromCustomer(phone, "I1-1", `${tag(1)} hola`, t)]);
  await quiesce();
  deliver([fromCustomer(phone, "I1-2", `${tag(2)} ¿y el precio?`, t + 40), unreadableFromBusiness(phone, "ADV-I1", t + 45)]);
  await wait(1500);
  // The phone re-sends it, readable: it was a thumbs-up on the customer's message.
  deliver([
    {
      key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: true, id: "ADV-I1" },
      message: { reactionMessage: { key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id: "I1-2" }, text: "👍" } },
      messageTimestamp: t + 45,
    },
  ]);
  if (!(await until(() => repliesTo(phone, 2).length > 0, 10_000))) {
    problems.push("I1: the customer's question was not answered after the reaction arrived (the AI stayed held back)");
  }
  await quiesce();
  if (convOf(phone)?.mode !== "AI") problems.push(`I1: the reaction paused the AI (mode ${convOf(phone)?.mode})`);
  if (rows(phone).some((m) => m.role === "human")) problems.push("I1: a phantom advisor message was stored for the reaction");
}

// ── I2) Compat: the greeting is learned, and remembered after a restart ──
{
  H.compat = true;
  const lead = async (phone, greetingDelayS) => {
    const tag = tagOf(phone);
    const t = nowS() - 30;
    deliver([fromCustomer(phone, `${phone}-1`, `${tag(1)} hola, quiero información`, t)]);
    await until(() => !!convOf(phone), 5000);
    deliver([fromBusiness(phone, `${phone}-G`, GREETING, t + greetingDelayS)]);
    await quiesce();
  };
  // First lead: the greeting goes out 2 s after the lead's first message
  // (recognized by timing) — the bot learns its text.
  await lead("573019300002", 2);
  // Second lead: the phone is slow, the greeting goes out 6 s later.
  await lead("573019300003", 6);
  if (convOf("573019300003")?.mode !== "AI") problems.push("I2: a slower greeting was taken for an advisor (the bot had not learned it)");
  if (repliesTo("573019300003", 1).length !== 1) problems.push(`I2: the second lead got ${repliesTo("573019300003", 1).length} replies`);
  // Restart: a fresh handler (no memory), same disk.
  M = await import(`${WA_URL}?restart=1`);
  Object.assign(M.OUTBOX_TIMING, W.OUTBOX_TIMING);
  deliver = makeAccount(M);
  configureEngine();
  await lead("573019300004", 6);
  if (convOf("573019300004")?.mode !== "AI") problems.push("I2: after a restart the learned greeting was forgotten (lead went to an advisor)");
  if (repliesTo("573019300004", 1).length !== 1) problems.push(`I2: after a restart the lead got ${repliesTo("573019300004", 1).length} replies`);
  H.compat = false;
}

// ── I3) Compat: replaying from disk an advisor message already stored ──
{
  H.compat = true;
  const phone = "573019300005";
  const t = nowS();
  const conv = await F.withDbRetry(() => F.getOrCreateConversation(1, "whatsapp", phone, { phone }), { attempts: 20 });
  await F.withDbRetry(() => F.insertMessageIdempotent(conv.id, "user", `${tagOf(phone)(1)} hola`, { channelMsgId: "I3-1", sentAt: t }), { attempts: 20 });
  // The earlier attempt stored it and paused the AI; then the operator handed
  // the chat back to the AI.
  await F.withDbRetry(() => F.insertMessageIdempotent(conv.id, "human", "Hola, soy Luis", { channelMsgId: "ADV-I3" }), { attempts: 20 });
  H.events.push({ conversationId: conv.id, type: "handoff", detail: "pausa", at: nowS() });
  H.convById.get(conv.id).mode = "AI";
  F.spoolInbound({
    inbound: { orgId: 1, channel: "whatsapp", externalId: phone, phone, name: null, text: "Hola, soy Luis", dedupeKey: "ADV-I3", sentAt: t + 60, waAccountId: 1 },
    route: null,
    spooledAt: t + 60,
    staff: { customerBefore: null, customerKey: null },
  });
  M.restoreSpooledContacts();
  await until(() => H.spooled.length === 0, 10_000);
  await quiesce();
  if (convOf(phone)?.mode !== "AI") problems.push("I3: replaying the advisor message paused the AI again (overriding the operator)");
  const copies = rows(phone).filter((m) => m.role === "human" && m.content === "Hola, soy Luis").length;
  if (copies !== 1) problems.push(`I3: the advisor message is ${copies} times in the thread`);
  H.compat = false;
}

// ── I4) An unreadable greeting does not teach its marker ──
// (last: it fires the pending unreadable messages the way a shutdown does)
{
  // A new lead whose greeting cannot be decrypted (stored with the marker,
  // recognized as the greeting by timing).
  const a = "573019300006";
  const t = nowS() - 60;
  deliver([fromCustomer(a, "I4-1", `${tagOf(a)(1)} hola`, t), unreadableFromBusiness(a, "I4-G", t + 1)]);
  await until(() => !!convOf(a), 5000);
  await wait(500);
  M.flushDeferredInbound();
  await quiesce();
  // An ongoing conversation: an advisor answers from the phone 5 s after the
  // customer, and this device cannot read it either.
  const b = "573019300007";
  const tb = nowS() - 30;
  deliver([fromCustomer(b, "I4-B1", `${tagOf(b)(1)} hola`, tb)]);
  await quiesce();
  deliver([fromCustomer(b, "I4-B2", `${tagOf(b)(2)} ¿me ayudas con mi pedido?`, tb + 20), unreadableFromBusiness(b, "I4-ADV", tb + 25)]);
  await wait(500);
  M.flushDeferredInbound();
  await quiesce();
  if (convOf(b)?.mode !== "HUMAN") problems.push(`I4: an unreadable advisor message was taken as automated (mode ${convOf(b)?.mode})`);
  if (repliesTo(b, 2).length > 0) problems.push("I4: the AI answered over the advisor");
}

clearInterval(spoolTimer);
clearInterval(sweepTimer);
const result = { scenario: "messages from the business phone (stubs, greetings, replays)", problems, ok: problems.length === 0 };
console.info(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
