// Minimal stand-ins for what src/lib/baileys/client.ts imports: a fake
// Baileys socket (ws + ev event emitters, sendNode recorder), the db calls it
// makes, and the handler registration. Used by client-ready.mjs.
import { EventEmitter } from "node:events";

export const sockets = [];

export const Browsers = { macOS: () => ["Mac OS", "Desktop", "14.4.1"] };
export const DisconnectReason = { loggedOut: 401 };
export const WAMessageStatus = { ERROR: 0 };
export async function fetchLatestBaileysVersion() {
  return { version: [2, 3000, 1], isLatest: true };
}
let idSeq = 0;
export function generateMessageIDV2() {
  return `3EB0FAKE${++idSeq}`;
}
export const getBinaryNodeChild = (node, tag) =>
  Array.isArray(node?.content) ? node.content.find((c) => c.tag === tag) : undefined;
// Same shape as Baileys' decodeMessageNode for a 1:1 message.
export function decodeMessageNode(node) {
  return {
    fullMessage: {
      key: { remoteJid: node.attrs.from, fromMe: false, id: node.attrs.id },
      messageTimestamp: Number(node.attrs.t),
    },
  };
}
export const isLidUser = (jid) => !!jid?.endsWith("@lid");
export const jidNormalizedUser = (jid) => (jid ? jid.replace(/:\d+@/, "@") : "");
export async function useMultiFileAuthState() {
  return { state: {}, saveCreds() {} };
}

export default function makeWASocket() {
  const ws = new EventEmitter();
  const ev = new EventEmitter();
  // Like Baileys' event buffer: while buffering (its initial buffer on a
  // logged-in session), everything but connection updates is held until
  // flush().
  const emit = ev.emit.bind(ev);
  const held = [];
  let buffering = false;
  ev.buffer = () => {
    buffering = true;
  };
  ev.isBuffering = () => buffering;
  ev.flush = () => {
    if (!buffering) return false;
    buffering = false;
    for (const [evt, data] of held.splice(0)) emit(evt, data);
    return true;
  };
  ev.emit = (evt, data) => {
    if (buffering && evt !== "connection.update") {
      held.push([evt, data]);
      return true;
    }
    return emit(evt, data);
  };
  const sock = {
    ws,
    ev,
    user: { id: "573990000001:5@s.whatsapp.net" },
    authState: { creds: { me: { id: "573990000001:5@s.whatsapp.net" } } },
    sentNodes: [],
    sentMessages: [],
    async sendNode(node) {
      sock.sentNodes.push(node);
    },
    async sendMessage(jid, content, opts) {
      sock.sentMessages.push({ jid, text: content.text, id: opts?.messageId });
      return { message: { conversation: content.text } };
    },
    end() {
      ev.emit("connection.update", { connection: "close", lastDisconnect: { error: undefined } });
    },
    async logout() {},
    signalRepository: {
      lidMapping: { getPNForLID: async (lid) => (lid === "880000001@lid" ? "573001112233:0@s.whatsapp.net" : null) },
    },
  };
  sockets.push(sock);
  return sock;
}

// ../db
export async function updateWaAccount() {}
export async function withDbRetry(fn) {
  return fn();
}

// ./handler
export function registerMessageHandler() {}
// Messages client.ts builds from raw nodes (Baileys does not emit them).
export const unemitted = [];
// Order in which messages reach the handler: the ones Baileys emits (a test
// listener adds them) and the ones client.ts builds.
export const intakeOrder = [];
export function intakeUnemitted(_sock, _session, msg) {
  unemitted.push(msg);
  intakeOrder.push(msg.key.id);
}
