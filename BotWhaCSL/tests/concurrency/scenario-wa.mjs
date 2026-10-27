// Bot process scenario: the REAL Baileys handler + reply engine under many
// simultaneous customers, with reconnects, offline backlogs, LID contacts,
// re-deliveries after a simulated restart, staff typing from the business
// phone, operator takeovers, orphaned conversations recovered by the sweep,
// media, and injected faults (LLM 429s, failed sends, Supabase blips).
// Usage: node scenario-wa.mjs <bundle dir> [seed] [faults 0|1] [--verbose]
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
const W = await import(pathToFileURL(path.join(OUT, "wa.js")).href);

F.resetHarness({
  seed: SEED,
  llmFailRate: HARSH ? 0.3 : FAULTS ? 0.15 : 0,
  sendFailRate: HARSH ? 0.3 : FAULTS ? 0.08 : 0,
  dbFailRate: HARSH ? 0.1 : FAULTS ? 0.03 : 0,
});
const H = F.harness();
const rand = F.rand;
const ENGINE = globalThis.__botwhaReplyEngine;

const ACCOUNTS = [
  { id: 1, org: 1, phone: "573990000001" },
  { id: 2, org: 1, phone: "573990000002" },
  { id: 3, org: 2, phone: "573990000003" },
];
const phoneOf = (i) => `5730${1000000 + i}`;
const lidOf = (i) => `${880000000 + i}@lid`;
const lidIndex = new Map();
for (let i = 0; i < 300; i++) lidIndex.set(lidOf(i), i);
const phoneOfJid = (jid) => {
  if (jid.endsWith("@lid")) return phoneOf(lidIndex.get(jid));
  return jid.split("@")[0].split(":")[0];
};

// ── Fake Baileys sessions (real handler.ts registered on each socket) ──
const sessions = new Map();
const sends = [];
let ownSeq = 0;
function makeSession(account) {
  const listeners = {};
  const own = new Set();
  const sock = {
    ev: { on: (evt, fn) => (listeners[evt] ??= []).push(fn) },
    emit: (evt, data) => (listeners[evt] ?? []).forEach((fn) => fn(data)),
    signalRepository: {
      lidMapping: {
        getPNForLID: async (lid) => {
          await F.sleep(0, 15);
          const i = lidIndex.get(lid);
          return i === undefined ? null : `${phoneOf(i)}:0@s.whatsapp.net`;
        },
      },
    },
  };
  // WhatsApp de cada cliente descarta un mensaje con un id que ya recibió.
  const delivered = new Set();
  const s = {
    accountId: account.id,
    orgId: account.org,
    open: true,
    // Like Baileys after a reconnect: open first, offline backlog delivered
    // a bit later, and only then "ready" (client.ts isReady). epoch: the
    // connection (a send validated on one connection never goes out on the
    // next one).
    ready: true,
    epoch: 1,
    buffered: [],
    isOwnMessage: (id) => own.has(id),
    phone: () => (s.open ? account.phone : null),
    knownPhone: () => account.phone,
    isOpen: () => s.open,
    isReady: () => s.open && s.ready,
    waitReady: async (ms) => {
      const deadline = Date.now() + ms;
      while (!(s.open && s.ready)) {
        if (Date.now() > deadline) throw new Error(`Socket de la cuenta ${account.id} no disponible`);
        await new Promise((r) => setTimeout(r, 20));
      }
      return s.epoch;
    },
    readyEpoch: () => (s.open && s.ready ? s.epoch : null),
    pnForLid: (lid) => sock.signalRepository.lidMapping.getPNForLID(lid),
    send: async (jid, text, opts = {}) => {
      if (!s.open || !s.ready || (opts.readyEpoch !== undefined && opts.readyEpoch !== s.epoch)) {
        throw new Error(`Socket de la cuenta ${account.id} no disponible por ahora`);
      }
      const id = opts.messageId ?? `OWN-${account.id}-${++ownSeq}`;
      own.add(id);
      await F.sleep(H.cfg.sendMin, H.cfg.sendMax);
      const fail = !s.open || (H.cfg.sendFailRate && rand() < H.cfg.sendFailRate);
      // Half the failures happen AFTER the stanza went out (only the ack was
      // lost): a retry must reuse the id so the customer gets one copy.
      if (fail && (!s.open || rand() < 0.5)) throw new Error("Connection Closed");
      const key = `${phoneOfJid(jid)}|${id}`;
      if (!delivered.has(key)) {
        delivered.add(key);
        sends.push({ text, phone: phoneOfJid(jid), orgId: account.org, accountId: account.id, at: Date.now(), id });
        // Baileys re-emits our own message as a fromMe 'append' upsert.
        process.nextTick(() =>
          sock.emit("messages.upsert", {
            type: "append",
            messages: [{ key: { remoteJid: jid, fromMe: true, id }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) }],
          })
        );
      }
      if (fail) throw new Error("Connection Closed");
      return id;
    },
    sock,
  };
  W.registerMessageHandler(sock, s);
  return s;
}
for (const a of ACCOUNTS) {
  const s = makeSession(a);
  sessions.set(a.id, s);
  H.sessions.set(a.id, s); // the client.ts registry the real outbox and sender use
}

// The REAL sender and outbox of the bot process (src/lib/outbox-worker),
// with shorter waits.
Object.assign(W.OUTBOX_TIMING, {
  replyWaitOpenMs: 1500,
  deliveryTimeoutMs: 10_000,
  warmingDeferS: 1,
  downDeferS: 1,
  unsavedDeferS: 1,
  orderDeferS: 1,
  channelOffDeferS: 1,
});
let botSeq = 0;
W.configureReplyEngine({
  channels: ["whatsapp"],
  newMessageId: () => `BOTMSG-${++botSeq}`,
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
}, 150);

// Disk-spool replay, like the bot's spool interval: the REAL handler
// orchestration (per-contact order, replies only once a contact is fully
// stored, staff messages included).
let replaying = false; // rounds never overlap
const spoolTimer = setInterval(async () => {
  if (replaying) return;
  replaying = true;
  try {
    await W.replayInboundSpool();
  } finally {
    replaying = false;
  }
}, 400);

// Recovery sweep, like the bot's 5 s interval (faster here).
let sweeping = false;
const sweepTimer = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    await W.flushPendingRecords();
    await W.runRecoverySweep();
  } catch {
    /* next round */
  } finally {
    sweeping = false;
  }
}, 300);

// ── Traffic ───────────────────────────────────────────────────
const ledger = new Map();
const nextM = new Map();
const newTag = (convKey) => {
  const m = (nextM.get(convKey) ?? 0) + 1;
  nextM.set(convKey, m);
  return m;
};
const untaggedIds = [];
const allowUntaggedPhones = new Set();
const timeline = [];
const base = Math.floor(Date.now() / 1000) - 5000;

function custMsg({ acc, i, text, addressing, id }) {
  const phone = phoneOf(i);
  let key;
  if (addressing === "pn") key = { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id };
  else if (addressing === "lid-alt") key = { remoteJid: lidOf(i), remoteJidAlt: `${phone}@s.whatsapp.net`, fromMe: false, id };
  else key = { remoteJid: lidOf(i), fromMe: false, id }; // LID without alt: mapping lookup
  return { key, message: typeof text === "string" ? { conversation: text } : text, pushName: `Cliente ${i}` };
}
const keyOfId = new Map();
function track(acc, i, m, id, extra = {}) {
  const convKey = `${acc.org}:whatsapp:${phoneOf(i)}`;
  ledger.set(`${convKey}|${m}`, { id, phone: phoneOf(i), orgId: acc.org, accountId: acc.id, channel: "whatsapp", tracked: true, ...extra });
  keyOfId.set(id, `${convKey}|${m}`);
}
// Real arrival order: stamped when the upsert is actually emitted.
let emitCounter = 0;
function stamp(msgs) {
  for (const msg of msgs) {
    const info = ledger.get(keyOfId.get(msg.key.id));
    if (info && info.emitSeq === undefined) info.emitSeq = ++emitCounter;
    if ((process.env.DEBUG_PHONES ?? "").split(",").some((p) => p && msg.key.remoteJid.includes(p.slice(-4)))) process.stderr.write(`EMIT t=${Date.now() - t0} ${msg.key.id} seq=${info?.emitSeq}
`);
  }
}
const ADDR = ["pn", "lid-alt", "lid"];

// Live traffic: 45 contacts, 3-6 messages each; contacts 0..9 also write to
// account 2 (same org: same conversation) and account 3 (other org).
for (let i = 0; i < 45; i++) {
  const accs = i < 10 ? [1, 2, 3] : i % 4 === 0 ? [3] : [1];
  const count = 3 + Math.floor(rand() * 4);
  let when = Math.floor(rand() * 400);
  for (let j = 0; j < count; j++) {
    const acc = ACCOUNTS.find((a) => a.id === accs[j % accs.length]);
    const convKey = `${acc.org}:whatsapp:${phoneOf(i)}`;
    const m = newTag(convKey);
    const id = `WAMID-${acc.id}-${i}-${j}`;
    const tag = `⟦k=${convKey}|m=${m}⟧`;
    const text = rand() < 0.1 ? { imageMessage: { caption: `${tag} foto` } } : `${tag} hola soy ${i}${i % 7 === 0 && j === 1 ? " precio" : ""}`;
    const msg = custMsg({ acc, i, text, addressing: ADDR[Math.floor(rand() * 3)], id });
    track(acc, i, m, id);
    // bursts: 30% of messages arrive 0-3 ms after the previous one
    when += rand() < 0.3 ? Math.floor(rand() * 4) : 5 + Math.floor(rand() * 120);
    timeline.push({ at: when, acc: acc.id, type: "notify", msgs: [msg] });
    if (rand() < 0.1) timeline.push({ at: when + 20 + Math.floor(rand() * 300), acc: acc.id, type: "notify", msgs: [msg] }); // re-delivery
  }
}

// Offline backlog: one 'append' upsert per account with 2 messages from each
// of 5 contacts; their next live message arrives while it is being handled.
for (const acc of ACCOUNTS) {
  const first = 100 + 10 * acc.id;
  const batch = [];
  for (let i = first; i < first + 5; i++) {
    const convKey = `${acc.org}:whatsapp:${phoneOf(i)}`;
    for (let j = 0; j < 2; j++) {
      const m = newTag(convKey);
      const id = `BACKLOG-${acc.id}-${i}-${j}`;
      batch.push(custMsg({ acc, i, text: `⟦k=${convKey}|m=${m}⟧ backlog`, addressing: ADDR[j % 3], id }));
      track(acc, i, m, id);
    }
  }
  timeline.push({ at: 50, acc: acc.id, type: "append", msgs: batch });
  for (let i = first; i < first + 5; i++) {
    const convKey = `${acc.org}:whatsapp:${phoneOf(i)}`;
    const m = newTag(convKey);
    const id = `LIVE-${acc.id}-${i}`;
    timeline.push({ at: 51 + (i - first), acc: acc.id, type: "notify", msgs: [custMsg({ acc, i, text: `⟦k=${convKey}|m=${m}⟧ live`, addressing: "pn", id })] });
    track(acc, i, m, id);
  }
}

// Media-only contacts (voice notes): stored and answered, no tags.
for (let i = 200; i < 204; i++) {
  const acc = ACCOUNTS[0];
  const id = `AUDIO-${i}`;
  untaggedIds.push(id);
  allowUntaggedPhones.add(phoneOf(i));
  timeline.push({ at: 80 + i, acc: acc.id, type: "notify", msgs: [custMsg({ acc, i, text: { audioMessage: { ptt: true } }, addressing: "pn", id })] });
}

// Sort, then give channel timestamps in arrival order.
timeline.sort((a, b) => a.at - b.at);
let seq = 0;
const tsOfId = new Map();
for (const ev of timeline) {
  for (const msg of ev.msgs) {
    if (!tsOfId.has(msg.key.id)) tsOfId.set(msg.key.id, base + ++seq);
    msg.messageTimestamp = tsOfId.get(msg.key.id);
  }
}

// Staff from the business phone: 4 human replies (+60 s after the customer)
// that must pause the AI; 3 WhatsApp Business greetings (+2 s after the
// FIRST message of a new contact, as WhatsApp sends them) and 1 known
// automated text in the middle of a conversation (+5 s): recorded as
// automated, no pause.
const staffHuman = [11, 13, 17, 19];
const staffAuto = [21, 23, 25];
const staffAutoMid = 27;
const lastTsOf = (i) => {
  let ts = 0;
  for (const [k, info] of ledger) if (info.phone === phoneOf(i) && info.orgId === 1) ts = Math.max(ts, tsOfId.get(info.id));
  return ts;
};
const lastAtOf = (i) => Math.max(...timeline.filter((e) => e.msgs.some((m) => !m.key.fromMe && m.key.id.includes(`-${i}-`))).map((e) => e.at));
const firstAtOf = (i) => Math.min(...timeline.filter((e) => e.msgs.some((m) => !m.key.fromMe && m.key.id.includes(`-${i}-`))).map((e) => e.at));
const firstTsOf = (i) => {
  let ts = Infinity;
  for (const [, info] of ledger) if (info.phone === phoneOf(i) && info.orgId === 1) ts = Math.min(ts, tsOfId.get(info.id) ?? Infinity);
  return ts;
};
const staffMsg = (i, id, text, ts) => ({
  key: { remoteJid: `${phoneOf(i)}@s.whatsapp.net`, fromMe: true, id },
  message: { conversation: text },
  messageTimestamp: ts,
});
const custAt = (acc, i, at, ts, label) => {
  const convKey = `${acc.org}:whatsapp:${phoneOf(i)}`;
  const m = newTag(convKey);
  const id = `${label}-${i}-${m}`;
  track(acc, i, m, id);
  const msg = custMsg({ acc, i, text: `⟦k=${convKey}|m=${m}⟧ ${label.toLowerCase()}`, addressing: "pn", id });
  msg.messageTimestamp = ts;
  timeline.push({ at, acc: acc.id, type: "notify", msgs: [msg] });
};
for (const i of staffHuman) {
  timeline.push({ at: lastAtOf(i) + 150, acc: 1, type: "notify", msgs: [staffMsg(i, `STAFF-${i}`, "STAFF: te atiendo yo", lastTsOf(i) + 60)] });
}
for (const i of staffAuto) {
  timeline.push({
    at: firstAtOf(i) + 1,
    acc: 1,
    type: "notify",
    msgs: [staffMsg(i, `STAFF-AUTO-${i}`, "AUTO: gracias por escribir", firstTsOf(i) + 2)],
  });
}
timeline.push({
  at: lastAtOf(staffAutoMid) + 1,
  acc: 1,
  type: "notify",
  msgs: [staffMsg(staffAutoMid, `STAFF-AUTO-${staffAutoMid}`, "AUTO: gracias por escribir", lastTsOf(staffAutoMid) + 5)],
});
// With the conversation already HUMAN, an advisor answering 2 s after the
// customer is still a person: recorded, never taken for an automated greeting.
{
  const at = lastAtOf(13);
  const ts = lastTsOf(13);
  custAt(ACCOUNTS[0], 13, at + 250, ts + 70, "AFTER");
  timeline.push({ at: at + 300, acc: 1, type: "notify", msgs: [staffMsg(13, "STAFF2-13", "STAFF: ya te confirmo", ts + 72)] });
}
// An advisor starts a chat from the business phone with a NEW contact: the
// lead is born HUMAN and the AI never answers the contact's reply.
timeline.push({ at: 100, acc: 1, type: "notify", msgs: [staffMsg(230, "STAFF-230", "STAFF: hola, te escribo de la tienda", base + 900)] });
custAt(ACCOUNTS[0], 230, 400, base + 950, "REPLY");
// A customer writes just before account 1 drops; an advisor answers from the
// phone while the bot is offline: it arrives in the reconnect backlog and
// the reply the AI prepared must not go out over it.
custAt(ACCOUNTS[0], 260, 290, base + 1000, "PREDROP");
timeline.push({ at: 600, acc: 1, type: "notify", msgs: [staffMsg(260, "STAFF-260", "STAFF: te atiendo yo", base + 1030)] });
// Automated greeting inside a backlog, between two customer messages: it is
// recorded as automated (no pause) and the customer still gets answered.
custAt(ACCOUNTS[0], 270, 350, base + 1100, "BURST");
timeline.push({ at: 351, acc: 1, type: "notify", msgs: [staffMsg(270, "STAFF-AUTO-270", "AUTO: gracias por escribir", base + 1102)] });
custAt(ACCOUNTS[0], 270, 360, base + 1105, "BURST");
timeline.sort((a, b) => a.at - b.at);

// Orphans: user messages saved before a "crash", no reply scheduled — the
// recovery sweep must answer each exactly once.
for (let i = 250; i < 255; i++) {
  const acc = ACCOUNTS[0];
  const convKey = `1:whatsapp:${phoneOf(i)}`;
  const conv = await F.withDbRetry(() => F.getOrCreateConversation(1, "whatsapp", phoneOf(i), { phone: phoneOf(i) }), { attempts: 50 });
  H.convById.get(conv.id).wa_account_id = 1;
  const m = newTag(convKey);
  const id = `ORPHAN-${i}`;
  await F.withDbRetry(() => F.insertMessageIdempotent(conv.id, "user", `⟦k=${convKey}|m=${m}⟧ huérfano`, { channelMsgId: id, createdAt: base - 10 }), { attempts: 20 });
  track(acc, i, m, id, { emitSeq: 0 });
}

// A previous session already recorded the business's automated greeting
// text (another contact): it is a KNOWN automated text from the start, so
// the mid-conversation copy is recognized even if, under faults, the other
// greetings of this run are classified later.
{
  const conv = await F.withDbRetry(() => F.getOrCreateConversation(1, "whatsapp", phoneOf(290), { phone: phoneOf(290) }), { attempts: 50 });
  await F.withDbRetry(
    () => F.insertMessageIdempotent(conv.id, "human", "AUTO: gracias por escribir", { channelMsgId: "auto:STAFF-PREV-290", createdAt: base - 100 }),
    { attempts: 20 }
  );
}

H.triggers = [{ keyword: "precio", content: "LISTA DE PRECIOS", also_human: false }];

// ── Fire ──────────────────────────────────────────────────────
const takeovers = new Map();
const opTakeovers = [5, 31, 37, 41];
const t0 = Date.now();
// Staff messages that reached the bot inside a reconnect backlog: the
// takeover counts from that moment (the bot must not answer over them once
// it has them, even before they are stored).
const backlogStaffAt = new Map();
const done = timeline.map(
  (ev) =>
    new Promise((resolve) =>
      setTimeout(() => {
        const s = sessions.get(ev.acc);
        // Disconnected or still receiving its backlog: Baileys holds it.
        if (!s.isReady()) s.buffered.push(...ev.msgs);
        else {
          stamp(ev.msgs);
          s.sock.emit("messages.upsert", { type: ev.type, messages: ev.msgs });
        }
        resolve();
      }, ev.at)
    )
);
// Account 1 drops 300→1100 ms: what arrives meanwhile comes back as a
// single 'append' backlog after reconnecting.
setTimeout(() => {
  const s = sessions.get(1);
  s.open = false;
  s.ready = false;
}, 300);
if (HARSH) {
  // Supabase completely down for 4 s; account 1 stays down 3.7 s (longer
  // than the reply wait): replies must go through the outbox fallback.
  setTimeout(() => (H.cfg.dbFailRate = 1), 600);
  setTimeout(() => (H.cfg.dbFailRate = 0.1), 4600);
}
// Reconnect like Baileys + client.ts: a NEW connection (epoch) opens, the
// offline backlog comes out a few messages at a time, and the account is
// ready only once all of it was delivered.
function reconnect(s) {
  s.epoch++;
  s.open = true;
  const flushChunk = () => {
    const chunk = s.buffered.splice(0, 3);
    if (chunk.length === 0) {
      s.ready = true;
      return;
    }
    stamp(chunk);
    for (const m of chunk) {
      if (m.key.fromMe && m.key.id.startsWith("STAFF")) backlogStaffAt.set(m.key.remoteJid, Date.now());
    }
    s.sock.emit("messages.upsert", { type: "append", messages: chunk });
    setTimeout(flushChunk, 5 + Math.floor(rand() * 20));
  };
  setTimeout(flushChunk, 40 + Math.floor(rand() * 80));
}
setTimeout(() => reconnect(sessions.get(1)), HARSH ? 4000 : 1100);
// Account 2 blips 700→900 ms: replies validated on the old connection must
// not go out on the new one before its backlog arrives.
setTimeout(() => {
  const s = sessions.get(2);
  s.open = false;
  s.ready = false;
}, 700);
setTimeout(() => reconnect(sessions.get(2)), 900);
// Operator takeovers from the dashboard at random moments.
for (const i of opTakeovers) {
  setTimeout(async () => {
    const conv = H.conversations.get(`1|whatsapp|${phoneOf(i)}`) ?? H.conversations.get(`2|whatsapp|${phoneOf(i)}`);
    if (!conv) return;
    conv.mode = "HUMAN";
    takeovers.set(`${conv.org_id}:whatsapp:${phoneOf(i)}`, Date.now());
  }, 200 + Math.floor(rand() * 900));
}
// Simulated restart: in-memory dedupe lost, what the journal on disk holds
// (received, not yet stored) is recovered into the spool exactly like
// recoverJournal + restoreSpooledContacts at boot — while the "old" copies
// are still in flight, so every message may be persisted twice and must be
// stored once — and WhatsApp re-delivers 12 already-processed messages as
// offline backlog.
let journalRecovered = 0;
setTimeout(() => {
  ENGINE.processedKeys.clear();
  for (const entry of H.journal.values()) {
    F.spoolInbound(structuredClone(entry));
    journalRecovered++;
  }
  W.restoreSpooledContacts();
  // Only messages that were really delivered once (stamped), never ones
  // still waiting in a disconnected account's buffer.
  const delivered = (m) => ledger.get(keyOfId.get(m.key.id))?.emitSeq !== undefined && !sessions.get(1).buffered.includes(m);
  const redeliver = timeline
    .filter((e) => e.type === "notify" && !e.msgs[0].key.fromMe)
    .flatMap((e) => e.msgs)
    .filter(delivered)
    .slice(0, 12);
  const batch = redeliver.filter((m) => m.key.id.startsWith("WAMID-1-") || m.key.id.startsWith("LIVE-1"));
  const s1 = sessions.get(1);
  // A disconnected account receives nothing: it arrives with its backlog.
  if (!s1.isReady()) s1.buffered.push(...batch);
  else s1.sock.emit("messages.upsert", { type: "append", messages: batch });
}, 1500);
await Promise.all(done);

// ── Quiesce: no activity, nothing queued or backing off ────────
const deadline = Date.now() + (HARSH ? 420_000 : 150_000);
let lastSig = "";
let stableSince = Date.now();
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
  const stillNeeded = [...ENGINE.failures.keys()].filter((id) => {
    const c = H.convById.get(id);
    const last = H.messages.filter((m) => m.conversation_id === id).sort((a, b) => b.created_at - a.created_at || b.id - a.id)[0];
    return c?.mode === "AI" && last?.role === "user";
  }).length;
  const busy = H.spooled.length + ENGINE.passQueued.size + ENGINE.passRunning.size + ENGINE.failures.size + 0 * stillNeeded + H.outbox.filter((o) => o.sent === 0 || o.sent === 3).length + ENGINE.pendingRecords.length;
  const sig = `${sends.length}|${H.llmCalls.length}|${H.messages.length}|${busy}`;
  if (sig !== lastSig || busy > 0) {
    lastSig = sig;
    stableSince = Date.now();
  } else if (Date.now() - stableSince > 1500) break;
}
const timedOut = Date.now() >= deadline;
clearInterval(outboxTimer);
clearInterval(spoolTimer);
clearInterval(sweepTimer);

// Staff takeovers count from the moment the human row was stored — or, if
// it came in a reconnect backlog, from the moment the bot received it.
for (const m of H.messages) {
  if (m.role === "human" && m.channel_msg_id?.startsWith("STAFF-")) {
    const conv = H.convById.get(m.conversation_id);
    const key = `${conv.org_id}:whatsapp:${conv.external_id}`;
    const received = backlogStaffAt.get(`${conv.external_id}@s.whatsapp.net`) ?? Infinity;
    takeovers.set(key, Math.min(takeovers.get(key) ?? Infinity, m.inserted_at ?? t0, received));
  }
}

// Optional diagnostics: DEBUG_PHONES=57301000014,57301000028
for (const ph of (process.env.DEBUG_PHONES ?? "").split(",").filter(Boolean)) {
  for (const c of H.convById.values()) {
    if (c.external_id !== ph) continue;
    process.stderr.write(`CONV ${c.id} org ${c.org_id} ${ph} mode=${c.mode} acc=${c.wa_account_id} failures=${JSON.stringify(ENGINE.failures.get(c.id) ?? null)} covered=${ENGINE.answeredUpTo.get(c.id)} evaluated=${ENGINE.evaluatedUpTo.get(c.id)}
`);
    for (const m of H.messages.filter((m) => m.conversation_id === c.id)) process.stderr.write(`  #${m.id} ${m.role} emit=${ledger.get(keyOfId.get(m.channel_msg_id))?.emitSeq} ins=${m.inserted_at - t0} ${m.content.slice(0, 50)} [${m.channel_msg_id}]
`);
    for (const o of H.outbox.filter((o) => o.conversation_id === c.id)) process.stderr.write(`  outbox #${o.id} sent=${o.sent} ${o.content.slice(0, 40)}
`);
  }
}
const result = verdict({
  ledger,
  sends: sends.filter((s) => !(F.tagsIn(s.text).length === 0 && allowUntaggedPhones.has(s.phone))),
  takeovers,
  untaggedIds,
  faults: FAULTS,
});

// Scenario-specific checks.
const extra = [];
for (const i of staffHuman) {
  const conv = H.conversations.get(`1|whatsapp|${phoneOf(i)}`);
  if (!conv) continue;
  if (!H.messages.some((m) => m.conversation_id === conv.id && m.role === "human")) extra.push(`STAFF_REPLY_NOT_RECORDED ${phoneOf(i)}`);
  if (conv.mode !== "HUMAN") extra.push(`STAFF_REPLY_DID_NOT_PAUSE_AI ${phoneOf(i)}`);
}
// Automated greetings: recorded as automated ('auto:'), never as a person,
// and they do not pause the AI.
for (const i of [...staffAuto, staffAutoMid, 270]) {
  const conv = H.conversations.get(`1|whatsapp|${phoneOf(i)}`);
  if (!conv) continue;
  const rows = H.messages.filter((m) => m.conversation_id === conv.id && m.role === "human");
  if (rows.some((m) => !m.channel_msg_id?.startsWith("auto:"))) extra.push(`AUTOMATED_GREETING_TAKEN_AS_HUMAN ${phoneOf(i)}`);
  if (!rows.length) extra.push(`AUTOMATED_GREETING_NOT_RECORDED ${phoneOf(i)}`);
  if (conv.mode !== "AI" && !opTakeovers.includes(i)) extra.push(`AUTOMATED_GREETING_PAUSED_AI ${phoneOf(i)}`);
}
// In HUMAN mode a fast advisor reply is a person, not a greeting.
{
  const conv = H.conversations.get(`1|whatsapp|${phoneOf(13)}`);
  if (conv && !H.messages.some((m) => m.conversation_id === conv.id && m.channel_msg_id === "STAFF2-13")) {
    extra.push("FAST_ADVISOR_REPLY_NOT_RECORDED_AS_HUMAN");
  }
}
// Advisor-initiated chat: born HUMAN, the AI never answers it.
{
  const conv = H.conversations.get(`1|whatsapp|${phoneOf(230)}`);
  if (!conv) extra.push("ADVISOR_CHAT_NOT_CREATED");
  else {
    if (conv.mode !== "HUMAN") extra.push("ADVISOR_CHAT_NOT_HUMAN");
    if (!H.messages.some((m) => m.conversation_id === conv.id && m.channel_msg_id === "STAFF-230")) extra.push("ADVISOR_FIRST_MESSAGE_NOT_RECORDED");
  }
  if (sends.some((s) => s.phone === phoneOf(230))) extra.push("AI_ANSWERED_ADVISOR_CHAT");
}
const echoes = H.messages.filter(
  (m) => m.role === "human" && !/^(auto:)?STAFF/.test(m.channel_msg_id ?? "")
);
if (echoes.length) extra.push(`OWN_ECHO_RECORDED_AS_STAFF x${echoes.length}`);
// Nothing received may stay only in the journal (it would be lost on a crash
// only if it is ALSO not stored — checked by INBOUND_NOT_STORED).
if (H.journal.size > 0) extra.push(`JOURNAL_NOT_DRAINED x${H.journal.size}`);
for (const i of [200, 201, 202, 203]) {
  if (!sends.some((s) => s.phone === phoneOf(i))) extra.push(`VOICE_NOTE_NOT_ANSWERED ${phoneOf(i)}`);
}
if (timedOut) extra.push("DID_NOT_QUIESCE");
if (extra.length) {
  result.ok = false;
  result.violations.SCENARIO = { count: extra.length, examples: extra.slice(0, 6) };
}
result.journalRecovered = journalRecovered;
result.seconds = Math.round((Date.now() - t0) / 100) / 10;
result.errorsLogged = logCounts.error;
console.info(JSON.stringify({ scenario: "whatsapp (bot)", seed: SEED, ...result }, null, 2));
process.exit(result.ok ? 0 : 1);
