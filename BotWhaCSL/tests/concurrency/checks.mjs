// Shared verdicts over the fake DB / sends after a scenario quiesces.
// `ledger`: Map "convKey|m" -> { id (channel msg id), emitSeq, phone, orgId,
//   channel, tracked (true = must be answered unless taken over) }
// `sends`: [{ text, phone, orgId, at }] — every outbound message, any channel.
// `takeovers`: Map convKey -> epoch ms when an operator/staff took it.
import * as F from "./fakes.mjs";

export function verdict({ ledger, sends, takeovers, untaggedIds = [], faults }) {
  const H = F.harness();
  const violations = [];
  const v = (kind, detail) => violations.push({ kind, detail });
  const convKeyOf = (c) => `${c.org_id}:${c.channel}:${c.external_id}`;
  const callById = new Map(H.llmCalls.map((c) => [c.callId, c]));

  // 1) The LLM never sees another conversation's content.
  for (const c of H.llmCalls) if (c.keys.size > 1) v("LLM_SAW_FOREIGN_CONTENT", [...c.keys].join(" + "));

  // 2) Every outbound message goes to the person (and org) it belongs to.
  const aiSends = [];
  for (const s of sends) {
    const tags = F.tagsIn(s.text);
    if (tags.length !== 1) {
      v("UNRECOGNIZED_SEND", s.text.slice(0, 80));
      continue;
    }
    const { key, n } = tags[0];
    const [org, , phone] = key.split(":");
    if (s.phone !== phone) v("SENT_TO_WRONG_PERSON", `${key}|${n} -> ${s.phone}`);
    if (String(s.orgId) !== org) v("SENT_FROM_WRONG_ORG", `${key}|${n} via org ${s.orgId}`);
    const callId = Number(/#call(\d+)/.exec(s.text)?.[1]);
    if (s.text.startsWith("R⟦")) {
      const call = callById.get(callId);
      if (!call) v("REPLY_WITHOUT_LLM_CALL", s.text.slice(0, 80));
      else aiSends.push({ key, n, call, at: s.at });
    }
  }

  // 3) Stored messages: right conversation, each inbound exactly once, in
  //    arrival order.
  const stored = new Map();
  const byConv = new Map();
  for (const m of H.messages) {
    const conv = H.convById.get(m.conversation_id);
    for (const t of F.tagsIn(m.content)) {
      if (t.key !== convKeyOf(conv)) v("MESSAGE_IN_WRONG_CONVERSATION", `${t.key}|${t.n} in ${convKeyOf(conv)}`);
    }
    if (m.role === "user") {
      const t = F.tagsIn(m.content)[0];
      if (t) stored.set(`${t.key}|${t.n}`, (stored.get(`${t.key}|${t.n}`) ?? 0) + 1);
      const list = byConv.get(m.conversation_id) ?? [];
      list.push(m);
      byConv.set(m.conversation_id, list);
    }
  }
  for (const [k, n] of stored) if (n > 1) v("INBOUND_STORED_TWICE", `${k} x${n}`);
  for (const k of ledger.keys()) if (!stored.has(k)) v("INBOUND_NOT_STORED", k);
  for (const id of untaggedIds) {
    if (!H.messages.some((m) => m.channel_msg_id === id)) v("MEDIA_NOT_STORED", id);
  }
  for (const list of byConv.values()) {
    const ordered = [...list].sort((a, b) => a.created_at - b.created_at || a.id - b.id);
    // Per receiving account: two business numbers are two separate chats for
    // the customer, so there is no defined order between them.
    const prevByAcc = new Map();
    for (const m of ordered) {
      const t = F.tagsIn(m.content)[0];
      if (!t) continue;
      const info = ledger.get(`${t.key}|${t.n}`);
      const seq = info?.emitSeq;
      const prev = prevByAcc.get(info?.accountId ?? 0);
      // reorderOk: its delivery failed once and the channel re-sent it later
      // (Meta does not keep order across retries).
      if (prev && seq !== undefined && seq < prev.seq && !info?.reorderOk && !prev.reorderOk) {
        v("HISTORY_OUT_OF_ORDER", `${t.key}: m=${t.n} after m=${prev.n}`);
      }
      if (seq !== undefined) prevByAcc.set(info?.accountId ?? 0, { seq, n: t.n, reorderOk: info?.reorderOk });
    }
  }

  // 4) No double answers, replies in order, nothing after a takeover.
  const answered = new Map();
  const lastSeq = new Map();
  for (const s of aiSends) {
    const k = `${s.key}|${s.n}`;
    answered.set(k, (answered.get(k) ?? 0) + 1);
    const info = ledger.get(k);
    const seq = info?.emitSeq ?? 0;
    // Per receiving account (two business numbers = two chats).
    const orderKey = `${s.key}#${info?.accountId ?? 0}`;
    const prev = lastSeq.get(orderKey);
    if (prev && seq < prev.seq && !info?.reorderOk && !prev.reorderOk) {
      v("REPLIES_OUT_OF_ORDER", `${s.key}: reply to m=${s.n} after reply to m=${prev.n}`);
    }
    if (!prev || seq > prev.seq) lastSeq.set(orderKey, { seq, n: s.n, reorderOk: info?.reorderOk });
    const takenAt = takeovers.get(s.key);
    if (takenAt !== undefined && s.at > takenAt + 60) v("AI_REPLY_AFTER_TAKEOVER", `${k} sent ${s.at - takenAt}ms after`);
  }
  for (const [k, n] of answered) if (n > 1) v("DOUBLE_ANSWER", `${k} x${n}`);

  // 5) Coverage: every tracked message of a conversation nobody took over
  //    was in the context of some SENT reply (or got a keyword reply).
  const covered = new Set();
  for (const s of aiSends) for (const n of s.call.userNs) covered.add(`${s.key}|${n}`);
  // A keyword reply answers its trigger and what that customer wrote before
  // it in the same burst (documented engine rule): threshold per conversation.
  // (by ARRIVAL order: what reached the bot before the keyword message).
  const kwThreshold = new Map();
  for (const s of sends) {
    if (!s.text.startsWith("K⟦")) continue;
    for (const t of F.tagsIn(s.text)) {
      const seq = ledger.get(`${t.key}|${t.n}`)?.emitSeq ?? 0;
      kwThreshold.set(t.key, Math.max(kwThreshold.get(t.key) ?? 0, seq));
    }
  }
  for (const [k, info] of ledger) {
    const key = k.split("|")[0];
    if (info.emitSeq !== undefined && info.emitSeq <= (kwThreshold.get(key) ?? -1)) covered.add(k);
  }
  let uncovered = 0;
  const examples = [];
  for (const [k, info] of ledger) {
    if (!info.tracked || takeovers.has(k.split("|")[0])) continue;
    if (!covered.has(k)) {
      uncovered++;
      if (examples.length < 5) examples.push(k);
    }
  }
  if (uncovered) v("MESSAGE_NEVER_ANSWERED", `${uncovered} (e.g. ${examples.join(", ")})`);

  const CROSS = new Set(["LLM_SAW_FOREIGN_CONTENT", "SENT_TO_WRONG_PERSON", "SENT_FROM_WRONG_ORG", "MESSAGE_IN_WRONG_CONVERSATION", "UNRECOGNIZED_SEND"]);
  const byKind = {};
  for (const x of violations) (byKind[x.kind] ??= []).push(x.detail);
  return {
    faults,
    inbound: ledger.size,
    conversations: H.convById.size,
    llmCalls: H.llmCalls.length,
    aiRepliesSent: aiSends.length,
    keywordRepliesSent: sends.filter((s) => s.text.startsWith("K⟦")).length,
    outboxFallbacks: H.outbox.filter((o) => o.kind === "bot").length,
    spooledToDisk: H.spooledTotal ?? 0,
    stillSpooled: H.spooled.length,
    crossTalk: violations.filter((x) => CROSS.has(x.kind)).length,
    violations: Object.fromEntries(Object.entries(byKind).map(([k, l]) => [k, { count: l.length, examples: l.slice(0, 3) }])),
    ok: violations.length === 0,
  };
}
