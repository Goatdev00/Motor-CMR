// In-memory stand-ins for everything the reply pipeline touches outside its
// own logic: Supabase (with the real unique keys and ordering), the LLM, the
// Meta Graph API, the Baileys client registry, the disk spool and Next.
// State lives on globalThis so every bundle in this process shares it.

const H = (globalThis.__H ??= {
  cfg: {},
  rng: null,
  convSeq: 0,
  msgSeq: 0,
  outboxSeq: 0,
  conversations: new Map(), // "org|channel|ext" -> conv
  convById: new Map(),
  messages: [], // {id, conversation_id, role, content, created_at, channel_msg_id}
  outbox: [],
  llmCalls: [],
  waSends: [],
  apiSends: [],
  events: [],
  spooled: [],
  journal: new Map(), // id -> entry (received, not yet persisted/spooled)
  journalSeq: 0,
  internalPhones: new Set(),
  triggers: [],
  dbOps: 0,
});

const DEFAULT_CFG = {
  seed: 1,
  dbMin: 0,
  dbMax: 5,
  llmMin: 5,
  llmMax: 40,
  sendMin: 0,
  sendMax: 6,
  llmFailRate: 0,
  sendFailRate: 0,
  dbFailRate: 0,
};

export function harness() {
  return H;
}

export function resetHarness(cfg = {}) {
  H.cfg = { ...DEFAULT_CFG, ...cfg };
  H.rng = mulberry32(H.cfg.seed);
  H.convSeq = 0;
  H.msgSeq = 0;
  H.outboxSeq = 0;
  H.conversations.clear();
  H.convById.clear();
  H.messages.length = 0;
  H.outbox.length = 0;
  H.llmCalls.length = 0;
  H.waSends.length = 0;
  H.apiSends.length = 0;
  H.events.length = 0;
  H.spooled.length = 0;
  H.spooledTotal = 0;
  H.journal.clear();
  H.journalSeq = 0;
  H.internalPhones.clear();
  H.triggers = [];
  H.routed = [];
  // compat: the database without the "BLINDAJE" migration (no covers_msg_id
  // on messages/outbox, no channel_msg_id on outbox, no enqueue dedupe).
  H.compat = false;
  H.failHumanInserts = 0;
  H.failHumanUntil = 0;
  H.failAssistantInserts = 0;
  H.failEnqueues = 0;
  H.queueChecks = 0;
  // Baileys sessions by account id (the client.ts registry the outbox and the
  // bot's sender use), team members, and the outbox backoff scale.
  H.sessions = new Map();
  H.members = [];
  H.outboxBackoffScale = 1 / 30;
  // Test hooks: a fixed LLM reply (e.g. the handoff phrase) and keyword
  // replies with the operator's exact text (no per-message tag).
  H.llmReply = null;
  H.fixedKeywordText = false;
  // auth/auto-texts.json (inbound-spool.ts): survives a simulated restart.
  H.autoTextsDisk = {};
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rand() {
  if (!H.rng) H.rng = mulberry32(1);
  return H.rng();
}

export function sleep(min, max = min) {
  const ms = min + Math.floor(rand() * (max - min + 1));
  return new Promise((r) => setTimeout(r, ms));
}

const nowS = () => Math.floor(Date.now() / 1000);
const copy = (o) => (o ? { ...o } : o);

async function dbOp(label) {
  H.dbOps++;
  await sleep(H.cfg.dbMin, H.cfg.dbMax);
  if (H.cfg.dbFailRate && rand() < H.cfg.dbFailRate) {
    throw new Error(`Supabase (${label}): TypeError: fetch failed`);
  }
}

// Every simulated customer text carries "⟦k=<convKey>|m=<n>⟧".
export const TAG_RE = /⟦k=([^|⟧]+)\|m=(\d+)⟧/g;
export function tagsIn(text) {
  return [...String(text).matchAll(TAG_RE)].map((m) => ({ key: m[1], n: Number(m[2]) }));
}

// ── db ────────────────────────────────────────────────────────
const TRANSIENT = /fetch failed|timed? ?out|ECONNRESET/i;
export function isTransientDbError(err) {
  return TRANSIENT.test(err instanceof Error ? err.message : String(err));
}
export function isDataError() {
  return false;
}
export const AGENCY_ORG_ID = 1;
export function isAutomatedMessageId(id) {
  return !!id && (id.startsWith("followup:") || id.startsWith("auto:"));
}
const isAutomatedRow = (m) => m.role === "human" && isAutomatedMessageId(m.channel_msg_id);

// Same contract as the real one, 20x faster (same budget relative to the
// simulated outages).
export async function withDbRetry(fn, opts = {}) {
  const attempts = opts.attempts ?? 4;
  const base = (opts.baseDelayMs ?? 500) / 20;
  const max = (opts.maxDelayMs ?? 8000) / 20;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !isTransientDbError(err)) throw err;
      await new Promise((r) => setTimeout(r, Math.min(max, base * 2 ** (i - 1))));
    }
  }
}

export async function getOrCreateConversation(orgId, channel, externalId, opts) {
  await dbOp("get or create conversation");
  const k = `${orgId}|${channel}|${externalId}`;
  let c = H.conversations.get(k);
  if (!c) {
    c = {
      id: ++H.convSeq,
      org_id: orgId,
      channel,
      external_id: externalId,
      phone: opts?.phone ?? null,
      name: opts?.name ?? null,
      mode: opts?.mode ?? "AI",
      stage: "NUEVO",
      wa_account_id: null,
      assigned_member_id: null,
      last_message_at: null,
      last_user_message_at: null,
    };
    H.conversations.set(k, c);
    H.convById.set(c.id, c);
  } else if (opts?.name && !c.name) {
    c.name = opts.name;
  }
  return copy(c);
}

export async function findConversation(orgId, channel, externalId) {
  await dbOp("find conversation");
  return copy(H.conversations.get(`${orgId}|${channel}|${externalId}`) ?? null);
}

export async function getConversationById(id) {
  await dbOp("conversation by id");
  return copy(H.convById.get(id) ?? null);
}

function rawInsert(conversationId, role, content, channelMsgId, createdAt, extra = {}) {
  const conv = H.convById.get(conversationId);
  if (!conv) throw new Error(`Supabase (insert): conversation ${conversationId} not found`);
  const at = Math.min(createdAt ?? nowS(), nowS());
  const m = {
    id: ++H.msgSeq,
    conversation_id: conversationId,
    role,
    content,
    created_at: at,
    channel_msg_id: channelMsgId ?? null,
    sent_at: extra.sentAt == null ? null : Math.min(extra.sentAt, nowS()),
    covers_msg_id: extra.coversMsgId ?? null,
    inserted_at: Date.now(),
  };
  H.messages.push(m);
  conv.last_message_at = Math.max(conv.last_message_at ?? 0, at);
  if (role === "user") conv.last_user_message_at = Math.max(conv.last_user_message_at ?? 0, at);
  return m;
}

export async function insertMessage(conversationId, role, content) {
  await dbOp("insert_message");
  return copy(rawInsert(conversationId, role, content, null, null));
}

// Real unique key: (conversation_id, channel_msg_id). A failure can happen
// AFTER the row was written (lost response), exactly like the real network.
export async function insertMessageIdempotent(conversationId, role, content, opts = {}) {
  await dbOp("insert_message_v2");
  // Targeted test hooks: the next N advisor ('human') inserts fail, or all
  // of them until a given time; the next N bot ('assistant') inserts fail.
  if (role === "human" && (H.failHumanInserts > 0 || Date.now() < (H.failHumanUntil ?? 0))) {
    if (H.failHumanInserts > 0) H.failHumanInserts--;
    throw new Error("Supabase (insert_message_v2): TypeError: fetch failed (fake, asesor)");
  }
  if (role === "assistant" && H.failAssistantInserts > 0) {
    H.failAssistantInserts--;
    throw new Error("Supabase (insert_message_v2): TypeError: fetch failed (fake, respuesta)");
  }
  if (H.compat) {
    // Like db.ts without the migration: insert_message (no channel id, no
    // sent_at, no covers, no dedupe) and automated business messages are
    // not stored at all.
    if (role === "human" && opts.channelMsgId?.startsWith("auto:")) return { message: null, inserted: false };
    const m = rawInsert(conversationId, role, content, null, null, {});
    return { message: copy(m), inserted: true };
  }
  const id = opts.channelMsgId ?? null;
  if (id) {
    const existing = H.messages.find((m) => m.conversation_id === conversationId && m.channel_msg_id === id);
    if (existing) return { message: copy(existing), inserted: false };
  }
  const m = rawInsert(conversationId, role, content, id, opts.createdAt ?? null, opts);
  if (H.cfg.dbFailRate && rand() < H.cfg.dbFailRate / 2) {
    throw new Error("Supabase (insert_message_v2): TypeError: fetch failed (respuesta perdida)");
  }
  return { message: copy(m), inserted: true };
}

export async function getRecentHistory(conversationId, limit = 20) {
  await dbOp("history");
  return H.messages
    .filter((m) => m.conversation_id === conversationId)
    .sort((a, b) => b.created_at - a.created_at || b.id - a.id)
    .slice(0, limit)
    .reverse()
    .map(copy);
}

export async function setMode(conversationId, mode) {
  await dbOp("set mode");
  const c = H.convById.get(conversationId);
  if (c) c.mode = mode;
}

export async function setConversationWaAccount(conversationId, accountId) {
  await dbOp("set wa account");
  const c = H.convById.get(conversationId);
  if (c) c.wa_account_id = accountId;
}

export async function addLeadEvent(conversationId, type, detail) {
  H.events.push({ conversationId, type, detail, at: nowS() });
}

export async function hasLeadEventSince(conversationId, type, since) {
  await dbOp("lead event since");
  return H.events.some((e) => e.conversationId === conversationId && e.type === type && (e.at ?? 0) >= since);
}

export async function routeLeadForStage(conversationId, stage) {
  H.routed.push({ conversationId, stage });
}

// Real unique key on outbox.channel_msg_id: a retry after a lost response
// does not enqueue the reply twice.
export async function enqueueBotReply(conversationId, content, waAccountId, opts = {}) {
  await dbOp("enqueue bot reply");
  // Targeted test hook: the next N enqueues fail before anything is written.
  if (H.failEnqueues > 0) {
    H.failEnqueues--;
    throw new Error("Supabase (enqueue bot reply): TypeError: fetch failed (fake)");
  }
  const conv = H.convById.get(conversationId);
  if (H.compat) {
    // db.ts: the insert fails on the missing columns and nothing is written.
    const err = new Error("sin la migración BLINDAJE (supabase/schema.sql) las respuestas automáticas no se pueden dejar en cola");
    err.code = "QUEUE_UNSUPPORTED";
    throw err;
  }
  if (opts.channelMsgId && H.outbox.some((o) => o.channel_msg_id === opts.channelMsgId)) return;
  H.outbox.push({
    id: ++H.outboxSeq,
    conversation_id: conversationId,
    phone: conv.external_id,
    content,
    channel: conv.channel,
    org_id: conv.org_id,
    kind: opts.kind ?? "bot",
    covers_msg_id: opts.coversMsgId ?? null,
    channel_msg_id: opts.channelMsgId ?? null,
    account_phone: opts.accountPhone ?? null,
    wa_account_id: waAccountId ?? conv.wa_account_id,
    sent: 0,
    attempts: 0,
    scheduled_at: null,
    created_at: nowS(),
  });
  // Targeted test hook: this insert committed, then the database went down.
  if (H.failEnqueueAfterCommit) {
    H.failEnqueueAfterCommit = false;
    H.cfg.dbFailRate = 1;
    throw new Error("Supabase (enqueue bot reply): TypeError: fetch failed (respuesta perdida)");
  }
  if (H.cfg.dbFailRate && rand() < H.cfg.dbFailRate / 2) {
    throw new Error("Supabase (enqueue bot reply): TypeError: fetch failed (respuesta perdida)");
  }
}

export async function getPendingBotCovers(conversationId) {
  await dbOp("pending bot covers");
  const covers = H.outbox
    .filter((o) => o.conversation_id === conversationId && (o.kind === "bot" || o.kind === "bot_fixed") && (o.sent === 0 || o.sent === 3))
    .map((o) => o.covers_msg_id)
    .filter((c) => c != null);
  return covers.length ? Math.max(...covers) : null;
}

export async function listQueuedBotReplies(conversationId) {
  await dbOp("queued bot replies");
  H.queueChecks++;
  return H.outbox
    .filter((o) => o.conversation_id === conversationId && (o.kind === "bot" || o.kind === "bot_fixed") && (o.sent === 0 || o.sent === 3))
    .sort((a, b) => a.id - b.id)
    .map((o) => ({ id: o.id, sent: o.sent, kind: o.kind, created_at: o.created_at, covers_msg_id: o.covers_msg_id ?? null }));
}

export async function discardOutboxItem(id) {
  await dbOp("discard outbox");
  const o = H.outbox.find((x) => x.id === id);
  if (!o || o.sent !== 0) return false;
  o.sent = 2;
  return true;
}

export async function hasHumanReplyAfter(conversationId, afterId) {
  await dbOp("human reply after");
  return H.messages.some((m) => m.conversation_id === conversationId && m.role === "human" && m.id > afterId && !isAutomatedRow(m));
}

export async function hasBusinessReplyBefore(conversationId, customerChannelMsgId, windowS, customerSentAt = null) {
  await dbOp("business reply before");
  const anchor =
    customerChannelMsgId && !H.compat
      ? H.messages.find((m) => m.conversation_id === conversationId && m.channel_msg_id === customerChannelMsgId)
      : null;
  const until = anchor ? null : customerSentAt;
  const since = (anchor?.created_at ?? until ?? nowS()) - windowS;
  return H.messages.some(
    (m) =>
      m.conversation_id === conversationId &&
      (m.role === "assistant" || (m.role === "human" && !isAutomatedRow(m))) &&
      m.created_at >= since &&
      (until == null || m.created_at < until) &&
      (!anchor || m.id < anchor.id)
  );
}

export async function recentAutomatedTexts(orgId) {
  await dbOp("automated texts");
  if (H.compat) return [];
  return H.messages
    .filter((m) => m.channel_msg_id?.startsWith("auto:") && H.convById.get(m.conversation_id)?.org_id === orgId)
    .map((m) => m.content);
}

export async function hasHumanReplySince(conversationId, since) {
  await dbOp("human reply since");
  return H.messages.some((m) => m.conversation_id === conversationId && m.role === "human" && m.created_at >= since && !isAutomatedRow(m));
}

export async function listPendingAiReplies(since, limit = 100, channel = null) {
  await dbOp("pending replies");
  const out = [];
  const after = (m, lu) => m.created_at > lu.created_at || (m.created_at === lu.created_at && m.id > lu.id);
  for (const c of H.convById.values()) {
    if (c.mode !== "AI") continue;
    if (channel ? c.channel !== channel : c.channel === "api") continue;
    if (H.outbox.some((o) => o.conversation_id === c.id && (o.kind === "bot" || o.kind === "bot_fixed") && (o.sent === 0 || o.sent === 3))) continue;
    if (H.compat) {
      // db.ts without the migration: by conversation columns, no message id.
      if (c.last_user_message_at == null || c.last_user_message_at < since) continue;
      if ((c.last_message_at ?? 0) > c.last_user_message_at) continue;
      out.push({ conversation_id: c.id, org_id: c.org_id, channel: c.channel, last_message_id: null, last_message_at: c.last_user_message_at });
      continue;
    }
    // pending_ai_replies (schema.sql).
    if ((c.last_message_at ?? 0) < since) continue;
    const rows = H.messages.filter((m) => m.conversation_id === c.id);
    const lu = rows.filter((m) => m.role === "user").sort((a, b) => b.created_at - a.created_at || b.id - a.id)[0];
    if (!lu) continue;
    if (rows.some((m) => m.role === "human" && !isAutomatedRow(m) && after(m, lu))) continue;
    if (rows.some((m) => m.role === "assistant" && after(m, lu) && (m.covers_msg_id == null || m.covers_msg_id >= lu.id))) continue;
    out.push({ conversation_id: c.id, org_id: c.org_id, channel: c.channel, last_message_id: lu.id, last_message_at: lu.created_at });
  }
  return out.sort((a, b) => b.last_message_at - a.last_message_at).slice(0, limit);
}

// ── outbox (scripts/start-bot via src/lib/outbox-worker) ──────
// Same rules as db.ts: pending = sent 0 and due; never-deferred rows first,
// then by scheduled time; conditional claims/discards/releases.
export async function getPendingOutbox(limit = 20, excludeChannels = []) {
  await dbOp("pending outbox");
  const now = nowS();
  return H.outbox
    .filter((o) => o.sent === 0 && (o.scheduled_at == null || o.scheduled_at <= now) && !excludeChannels.includes(o.channel))
    .sort(
      (a, b) =>
        (a.scheduled_at == null ? -1 : 1) - (b.scheduled_at == null ? -1 : 1) ||
        (a.scheduled_at ?? 0) - (b.scheduled_at ?? 0) ||
        a.created_at - b.created_at ||
        a.id - b.id
    )
    .slice(0, limit)
    .map(copy);
}
const outboxRow = (id) => H.outbox.find((o) => o.id === id);
export async function claimOutboxItem(id) {
  await dbOp("claim outbox");
  const o = outboxRow(id);
  if (!o || o.sent !== 0) return false;
  o.sent = 3;
  return true;
}
export async function markOutboxSent(id) {
  await dbOp("mark outbox sent");
  const o = outboxRow(id);
  if (o) o.sent = 1;
}
export async function releaseOutboxFailure(item, countAttempt, maxAttempts = 5, deferSeconds = 0, opts = {}) {
  await dbOp("release outbox");
  const o = outboxRow(item.id);
  if (!o || o.sent !== (opts.claimed === false ? 0 : 3)) return { discarded: false, retryAt: null };
  const attempts = countAttempt ? item.attempts + 1 : item.attempts;
  const discarded = attempts >= maxAttempts;
  let retryAt = null;
  if (!discarded && countAttempt) retryAt = nowS() + Math.max(1, Math.round(30 * attempts * H.outboxBackoffScale));
  else if (!discarded && deferSeconds > 0) retryAt = nowS() + deferSeconds;
  o.attempts = attempts;
  o.sent = discarded ? 2 : 0;
  if (retryAt !== null) o.scheduled_at = retryAt;
  return { discarded, retryAt };
}
export async function deferOutboxItem(id, seconds) {
  await dbOp("defer outbox");
  const o = outboxRow(id);
  if (o && o.sent === 0) o.scheduled_at = nowS() + seconds;
}
export async function deferOutboxUntil(id, until) {
  await dbOp("defer outbox until");
  const o = outboxRow(id);
  if (o && o.sent === 0 && (o.scheduled_at == null || o.scheduled_at < until)) o.scheduled_at = until;
}
const ORDERED_KINDS = ["manual", "bot", "bot_fixed"];
const sameRecipient = (o, item) => o.org_id === item.org_id && o.channel === item.channel && o.phone === item.phone;
export async function deferLaterOutboxForRecipient(item, until) {
  await dbOp("defer later outbox");
  for (const o of H.outbox) {
    if (sameRecipient(o, item) && o.id > item.id && o.sent === 0 && ORDERED_KINDS.includes(o.kind) && (o.scheduled_at == null || o.scheduled_at < until)) {
      o.scheduled_at = until;
    }
  }
}
export async function olderPendingOutboxTime(item) {
  await dbOp("older pending outbox");
  const older = H.outbox.filter(
    (o) => sameRecipient(o, item) && o.id < item.id && (o.sent === 0 || o.sent === 3) && ORDERED_KINDS.includes(o.kind)
  );
  if (older.length === 0) return undefined;
  const times = older.map((o) => o.scheduled_at).filter((t) => t != null);
  return times.length ? Math.max(...times) : null;
}
export async function getOutboxSentState(id) {
  await dbOp("outbox state");
  return outboxRow(id)?.sent ?? null;
}
export async function unclaimOutboxItem(id) {
  await dbOp("unclaim outbox");
  const o = outboxRow(id);
  if (o && o.sent === 3) o.sent = 0;
}
export async function resetInFlightOutbox() {
  await dbOp("reset outbox in-flight");
  const settled = [];
  const reset = [];
  for (const o of H.outbox) {
    if (o.sent !== 3) continue;
    if (o.channel === "whatsapp") {
      o.sent = 0;
      reset.push(o.id);
    } else {
      o.sent = 1;
      settled.push(copy(o));
    }
  }
  return { settled, reset };
}
export async function findMessageSince(conversationId, role, content, since) {
  await dbOp("message since");
  const found = [...H.messages]
    .reverse()
    .find((m) => m.conversation_id === conversationId && m.role === role && m.created_at >= since && m.content === content);
  return copy(found ?? null);
}
export async function messagesKeepChannelIds() {
  await dbOp("messages channel ids");
  return !H.compat;
}
export async function listStaleBotReplies(before, limit = 50) {
  await dbOp("stale bot replies");
  return H.outbox
    .filter((o) => o.sent === 0 && (o.kind === "bot" || o.kind === "bot_fixed") && o.created_at < before)
    .sort((a, b) => a.id - b.id)
    .slice(0, limit)
    .map(copy);
}
export async function hasBotReplyCovering(conversationId, coversMsgId, createdAfter) {
  await dbOp("bot reply covering");
  return H.messages.some(
    (m) =>
      m.conversation_id === conversationId &&
      m.role === "assistant" &&
      (coversMsgId !== null && !H.compat ? (m.covers_msg_id ?? -1) >= coversMsgId : m.created_at > createdAfter)
  );
}
// follow_up_sent: clears the lead's reminder on an exact match of the
// scheduled time or, with the migration, also when no follow-up of that
// conversation is still pending (0) or being sent (3).
export async function markFollowUpSent(conversationId, scheduledAt) {
  await dbOp("follow up sent");
  const conv = H.convById.get(conversationId);
  if (!conv) return;
  const nonePending = !H.outbox.some(
    (o) => o.conversation_id === conversationId && o.kind === "followup" && (o.sent === 0 || o.sent === 3)
  );
  if (conv.next_follow_up_at === scheduledAt || (!H.compat && nonePending)) conv.next_follow_up_at = null;
  H.events.push({ conversationId, type: "followup_sent", detail: "Seguimiento automático enviado", at: nowS() });
}
export async function markFollowUpFailed() {}
export async function listTeamMembers() {
  await dbOp("team members");
  return H.members.map(copy);
}
// A dashboard message: the 'human' row and its 'manual' outbox row, in one
// transaction (insert_human_message).
export async function insertHumanMessage(conversationId, content) {
  await dbOp("insert_human_message");
  const conv = H.convById.get(conversationId);
  const m = rawInsert(conversationId, "human", content, null, null, {});
  H.outbox.push({
    id: ++H.outboxSeq,
    conversation_id: conversationId,
    phone: conv.external_id,
    content,
    channel: conv.channel,
    org_id: conv.org_id,
    kind: "manual",
    covers_msg_id: null,
    channel_msg_id: null,
    account_phone: null,
    wa_account_id: null,
    sent: 0,
    attempts: 0,
    scheduled_at: null,
    created_at: nowS(),
  });
  return copy(m);
}

// ── llm ───────────────────────────────────────────────────────
// Answers the LAST user message in the history and records every
// conversation key it saw, so the runner can prove no foreign content
// ever reached the model.
export async function generateReply(orgId, history) {
  const keys = new Set();
  const userNs = [];
  const assistantNs = [];
  let last = null;
  for (const m of history) {
    for (const t of tagsIn(m.content)) {
      keys.add(t.key);
      if (m.role === "user") {
        userNs.push(t.n);
        last = t;
      } else if (m.role === "assistant") assistantNs.push(t.n);
    }
  }
  const callId = H.llmCalls.length + 1;
  const call = { callId, orgId, keys, userNs, assistantNs, lastN: last?.n ?? null, lastKey: last?.key ?? null, at: Date.now() };
  H.llmCalls.push(call);
  await sleep(H.cfg.llmMin, H.cfg.llmMax);
  if (H.cfg.llmFailRate && rand() < H.cfg.llmFailRate) {
    call.failed = true;
    throw new Error("429 Rate limit reached (fake)");
  }
  if (H.llmReply) return H.llmReply(last, callId);
  return last ? `R⟦k=${last.key}|m=${last.n}⟧ #call${callId}` : `R(sin contexto) #call${callId}`;
}

// Same semaphore as llm.ts withLlmSlot (cap of simultaneous LLM calls).
const llmSlots = { active: 0, waiters: [], max: 6 };
export async function withLlmSlot(fn) {
  if (llmSlots.active < llmSlots.max) llmSlots.active++;
  else await new Promise((resolve) => llmSlots.waiters.push(resolve));
  H.llmPeak = Math.max(H.llmPeak ?? 0, llmSlots.active);
  try {
    return await fn();
  } finally {
    const next = llmSlots.waiters.shift();
    if (next) next();
    else llmSlots.active--;
  }
}

export function isRetryableLlmError(err) {
  return /429|timed? ?out|fetch failed/i.test(err instanceof Error ? err.message : String(err));
}

export async function getLlm() {
  throw new Error("getLlm not available in harness");
}

// ── lead analysis / templates / ai-agents ─────────────────────
export function maybeAnalyzeLead() {
  return Promise.resolve();
}
export async function getKeywordTriggersCached() {
  return H.triggers;
}
// Keyword replies echo the tag of the message that triggered them, so the
// runner can verify who received them.
export function findMatchingTrigger(triggers, text) {
  for (const t of triggers) {
    if (String(text).toLowerCase().includes(t.keyword)) {
      if (H.fixedKeywordText) return t;
      const tag = tagsIn(text)[0];
      return { ...t, content: `K⟦k=${tag?.key}|m=${tag?.n}⟧ ${t.content}` };
    }
  }
  return null;
}
export async function selectAgentForInbound() {
  return null;
}

// ── inbound spool (disk) ──────────────────────────────────────
export function spoolInbound(entry) {
  H.spooledTotal = (H.spooledTotal ?? 0) + 1;
  H.spooled.push(entry);
}
// reply-retry-store.ts: the retry journal "on disk", private to this process
// (parallel runs must not share it).
export function fileRetryStore() {
  let data = "{}";
  return {
    load: () => JSON.parse(data),
    save: (entries) => {
      data = JSON.stringify(entries);
    },
  };
}
export function loadAutoTexts() {
  return JSON.parse(JSON.stringify(H.autoTextsDisk ?? {}));
}
export function saveAutoTexts(byOrg) {
  H.autoTextsDisk = JSON.parse(JSON.stringify(byOrg));
}
export function listSpooled() {
  return [...H.spooled];
}
// Same contract as inbound-spool.ts replaySpool: entries in order, a failed
// one blocks the rest of its contact this round, failures stay ahead of
// whatever was spooled meanwhile.
let replayingSpool = false;
export async function replaySpool(persist) {
  if (replayingSpool || H.spooled.length === 0) return 0;
  replayingSpool = true;
  let saved = 0;
  try {
    const work = H.spooled.splice(0);
    const contactOf = (e) => `${e.inbound.orgId}:${e.inbound.channel}:${e.inbound.externalId}`;
    const lastIndex = new Map();
    work.forEach((e, i) => lastIndex.set(contactOf(e), i));
    const failed = [];
    const blocked = new Set();
    for (let i = 0; i < work.length; i++) {
      const e = work[i];
      const c = contactOf(e);
      if (blocked.has(c)) {
        failed.push(e);
        continue;
      }
      let ok = false;
      try {
        ok = await persist(e, lastIndex.get(c) === i);
      } catch {
        ok = false;
      }
      if (ok) saved++;
      else {
        failed.push(e);
        blocked.add(c);
      }
    }
    H.spooled.unshift(...failed);
  } finally {
    replayingSpool = false;
  }
  return saved;
}
export function hasJournalToRecover() {
  return false;
}
export function recoverJournal() {
  return [];
}
export function setAsidePreviousJournal() {}
// Journal of received messages (inbound-spool.ts): what a hard kill would
// leave behind is exactly what is still in H.journal.
export function journalInbound(entry) {
  const id = `J${++H.journalSeq}`;
  H.journal.set(id, structuredClone(entry));
  return id;
}
export function journalDone(id) {
  if (id) H.journal.delete(id);
}

// ── baileys client registry (what handler.ts and the outbox import) ──
export function isInternalPhone(phone) {
  return H.internalPhones.has(phone);
}
export function getSession(accountId) {
  return H.sessions.get(accountId) ?? null;
}
export function getAllSessions() {
  return [...H.sessions.values()];
}
export function anySessionOpen() {
  return [...H.sessions.values()].some((s) => s.isOpen());
}
// Same contract as client.ts: a READY session (the preferred one, else any
// of the organization).
export function getOpenSession(preferredId, orgId) {
  if (preferredId != null) {
    const s = H.sessions.get(preferredId);
    if (s?.isReady() && (orgId === undefined || s.orgId === orgId)) return s;
  }
  for (const s of H.sessions.values()) {
    if (orgId !== undefined && s.orgId !== orgId) continue;
    if (s.isReady()) return s;
  }
  return null;
}

// ── meta (only what the webhook route / cloud-api-replies import) ──
const PNID_TO_ORG = { PNID_ORG1: 1, PNID_ORG2: 2 };
export async function verifyMetaSignature() {
  return "ok";
}
export async function getWebhookVerifyToken() {
  return "verify";
}
export async function getAllOrgsChannelSettingsCached() {
  return [
    { org_id: 1, channel: "whatsapp_api", enabled: true },
    { org_id: 2, channel: "whatsapp_api", enabled: true },
  ];
}
export async function resolveOrgForEvent(_channel, recipientId) {
  return PNID_TO_ORG[recipientId] ?? null;
}
export async function isChannelEnabled() {
  return true;
}
export function isUncertainDelivery(err) {
  return typeof err === "object" && err !== null && err.code === "META_UNCERTAIN";
}
let wamidSeq = 0;
// Failures: half are explicit rejections (nothing sent), half are timeouts
// AFTER Meta accepted the message (sent, but unconfirmed): retrying those
// would duplicate the message.
export async function sendChannelText(orgId, channel, to, text) {
  await sleep(H.cfg.sendMin, H.cfg.sendMax);
  const fail = H.cfg.sendFailRate && rand() < H.cfg.sendFailRate;
  if (fail && rand() < 0.5) throw new Error("Meta (send whatsapp_api): HTTP 500 (fake)");
  const wamid = `wamid.OUT-${++wamidSeq}`;
  H.apiSends.push({ orgId, channel, to, text, wamid, at: Date.now() });
  if (fail) {
    const err = new Error("Meta (send whatsapp_api): sin confirmación de envío (timeout, fake)");
    err.code = "META_UNCERTAIN";
    throw err;
  }
  return wamid;
}

// ── next/server ───────────────────────────────────────────────
export class NextResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
  }
  static json(body, init = {}) {
    return new NextResponse(body, init);
  }
}
