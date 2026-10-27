// Readiness of a WhatsApp account after (re)connecting, against the REAL
// src/lib/baileys/client.ts with a fake Baileys socket:
//  1) WhatsApp's "all sent" marker arrives while Baileys is still processing
//     offline messages: the account must NOT be ready until every offline
//     message was delivered (a reply could go out over an advisor's answer
//     still in that backlog).
//  2) WhatsApp holds the backlog in batches of 100 and Baileys asks only for
//     the first: when the backlog goes quiet without the marker, the next
//     batch is requested (otherwise the rest waits on the server for hours).
//  3) Sends only go out on a ready connection, and only on the one that was
//     validated (not on a newer connection whose backlog hasn't arrived).
//  4) After the session stopped, an @lid contact still resolves to its number
//     (shutdown's final attempt for messages waiting on it).
//  5) A "view once" notice that Baileys acknowledges without emitting reaches
//     the handler and does not hold the backlog open.
//  6) Inside a reconnect backlog, that notice reaches the handler AFTER the
//     earlier messages Baileys was still holding, only once although
//     WhatsApp re-sends it, and with the chat id without the device.
// Usage: node client-ready.mjs <BotWhaCSL root> <out dir>
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [ROOT, OUT] = process.argv.slice(2);
const require = createRequire(path.join(ROOT, "package.json"));
const esbuild = require("esbuild");
const FAKES = pathToFileURL(path.join(import.meta.dirname, "client-fakes.mjs")).href;

fs.mkdirSync(OUT, { recursive: true });
await esbuild.build({
  absWorkingDir: ROOT,
  entryPoints: { client: path.join(ROOT, "src", "lib", "baileys", "client.ts") },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: OUT,
  logLevel: "warning",
  plugins: [
    {
      name: "client-fakes",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === "entry-point") return undefined;
          if (["@whiskeysockets/baileys", "../db", "./handler"].includes(args.path)) return { path: FAKES, external: true };
          if (args.path === "pino") return { path: "pino", namespace: "pino-fake" };
          return undefined;
        });
        b.onLoad({ filter: /.*/, namespace: "pino-fake" }, () => ({
          contents: "export default () => ({ level: 'silent', child() { return this; }, info() {}, warn() {}, error() {}, debug() {}, trace() {} });",
          loader: "js",
        }));
      },
    },
  ],
});

for (const level of ["log", "warn", "error"]) console[level] = () => undefined;
const F = await import(FAKES);
const C = await import(pathToFileURL(path.join(OUT, "client.js")).href);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (ok, msg) => {
  if (!ok) problems.push(msg);
};

// ── 1) Marker before the offline messages are processed ──────
{
  const s = C.getOrCreateSession(1, 1);
  await s.start();
  const sock = F.sockets.at(-1);
  sock.ev.emit("connection.update", { connection: "open" });
  sock.ws.emit("CB:ib,,offline_preview", {});
  for (const id of ["A", "B", "C"]) sock.ws.emit("CB:message,offline", { attrs: { id, offline: "1" } });
  sock.ev.emit("connection.update", { receivedPendingNotifications: true });
  await wait(400);
  check(!s.isReady(), "1: ready although Baileys had not delivered any of the 3 offline messages");
  await s.send("57301@s.whatsapp.net", "hola").then(
    () => problems.push("1: a message went out before the account was ready"),
    () => undefined
  );
  sock.ev.emit("messages.upsert", { type: "append", messages: [{ key: { id: "A" } }, { key: { id: "B" } }] });
  await wait(400);
  check(!s.isReady(), "1: ready with one offline message still undelivered");
  sock.ev.emit("messages.upsert", { type: "append", messages: [{ key: { id: "C" } }] });
  await wait(400);
  check(s.isReady(), "1: not ready after every offline message was delivered");
  const epoch = s.readyEpoch();
  await s.send("57301@s.whatsapp.net", "hola", { readyEpoch: epoch }).catch(() => problems.push("1: send on the ready connection failed"));
  check(sock.sentMessages.length === 1, "1: expected exactly 1 message sent");

  // ── 3) A send validated on this connection never goes out on the next ──
  sock.end();
  await wait(50);
  check(!s.isReady(), "3: still ready after the connection closed");
  await wait(5500); // reconnect delay (5 s) in client.ts
  const sock2 = F.sockets.at(-1);
  check(sock2 !== sock, "3: no new socket after the close");
  sock2.ev.emit("connection.update", { connection: "open" });
  await s.send("57301@s.whatsapp.net", "tarde", { readyEpoch: epoch }).then(
    () => problems.push("3: a send validated on the old connection went out on the new one"),
    () => undefined
  );
  sock2.ev.emit("connection.update", { receivedPendingNotifications: true });
  await wait(400);
  check(s.isReady(), "3: new connection with nothing pending did not become ready");
  await s.send("57301@s.whatsapp.net", "tarde", { readyEpoch: epoch }).then(
    () => problems.push("3: old-connection send went out on the ready new connection"),
    () => undefined
  );
  check(s.readyEpoch() !== epoch, "3: the connection epoch did not change on reconnect");
  await s.stop();
}

// ── 2) Backlog held in batches of 100 ────────────────────────
{
  const s = C.getOrCreateSession(2, 1);
  await s.start();
  const sock = F.sockets.at(-1);
  sock.ev.emit("connection.update", { connection: "open" });
  sock.ws.emit("CB:ib,,offline_preview", {});
  const deliver = (from, to) => {
    for (let i = from; i < to; i++) sock.ws.emit("CB:message,offline", { attrs: { id: `M${i}`, offline: "1" } });
    sock.ev.emit("messages.upsert", {
      type: "append",
      messages: Array.from({ length: to - from }, (_, k) => ({ key: { id: `M${from + k}` } })),
    });
  };
  deliver(0, 100);
  await wait(3000);
  check(!s.isReady(), "2: ready while WhatsApp still held more batches (no end marker yet)");
  check(sock.sentNodes.length === 0, "2: asked for the next batch too early");
  await wait(3000); // > 5 s quiet
  const asked = sock.sentNodes.filter((n) => n.tag === "ib" && n.content?.[0]?.tag === "offline_batch").length;
  check(asked === 1, `2: expected 1 request for the next batch after 5 s quiet, got ${asked}`);
  deliver(100, 140);
  sock.ev.emit("connection.update", { receivedPendingNotifications: true });
  await wait(400);
  check(s.isReady(), "2: not ready after the rest arrived and the end marker came");
  await s.stop();
}

// ── 2b) No marker and nothing more: ready after the quiet window ──
// Meanwhile Baileys holds the offline messages it already processed in its
// initial event buffer (released only by the marker, a live message or its
// 30 s timeout): they must reach the handler BEFORE the account is ready.
{
  const s = C.getOrCreateSession(3, 1);
  await s.start();
  const sock = F.sockets.at(-1);
  sock.ev.buffer();
  sock.ev.emit("connection.update", { connection: "open" });
  let readyWhenReleased = null;
  sock.ev.on("messages.upsert", () => {
    readyWhenReleased ??= s.isReady();
  });
  sock.ws.emit("CB:message,offline", { attrs: { id: "X1", offline: "1" } });
  sock.ev.emit("messages.upsert", { type: "append", messages: [{ key: { id: "X1" } }] });
  await wait(9000);
  check(s.isReady(), "2b: never became ready without an end marker");
  check(
    readyWhenReleased === false,
    readyWhenReleased === null
      ? "2b: the offline messages held in Baileys' buffer were never released"
      : "2b: the offline messages held in Baileys' buffer were released only after the account was ready"
  );
  // ── 4) Shutdown: an @lid contact still resolves through the last socket's
  //    mapping (the final attempt for messages waiting on their number).
  await s.stop();
  const pn = await s.pnForLid("880000001@lid");
  check(pn === "573001112233:0@s.whatsapp.net", `4: @lid lookup after stop returned ${pn}`);
}

// ── 5) A "view once" notice Baileys acknowledges without emitting ──
// It must reach the handler (stored with a marker) and must not hold the
// backlog open until the quiet window.
{
  const s = C.getOrCreateSession(5, 1);
  await s.start();
  const sock = F.sockets.at(-1);
  sock.ev.emit("connection.update", { connection: "open" });
  sock.ws.emit("CB:ib,,offline_preview", {});
  const node = {
    tag: "message",
    attrs: { id: "VO-F1", from: "573001112233@s.whatsapp.net", t: String(Math.floor(Date.now() / 1000)), offline: "1" },
    content: [{ tag: "unavailable", attrs: { type: "view_once_unavailable_fanout" } }],
  };
  sock.ws.emit("CB:message,offline", node);
  sock.ws.emit("CB:message", node);
  sock.ev.emit("connection.update", { receivedPendingNotifications: true });
  await wait(400);
  check(
    F.unemitted.some((m) => m.key.id === "VO-F1" && m.key.isViewOnce),
    "5: the view-once notice Baileys does not emit never reached the handler"
  );
  check(s.isReady(), "5: the account kept waiting for a view-once notice Baileys never delivers");
  await s.stop();
}

// ── 6) The notice inside a backlog: order, re-send, chat id ──
{
  const s = C.getOrCreateSession(6, 1);
  await s.start();
  const sock = F.sockets.at(-1);
  sock.ev.buffer(); // Baileys' initial buffer on a logged-in session
  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const m of messages) F.intakeOrder.push(m.key.id);
  });
  sock.ev.emit("connection.update", { connection: "open" });
  sock.ws.emit("CB:ib,,offline_preview", {});
  // An earlier offline message: Baileys processed it and holds it.
  sock.ws.emit("CB:message,offline", { attrs: { id: "E6", offline: "1" } });
  sock.ev.emit("messages.upsert", { type: "append", messages: [{ key: { id: "E6", remoteJid: "573001112233@s.whatsapp.net" } }] });
  const node = {
    tag: "message",
    attrs: { id: "VO-6", from: "573001112233:7@s.whatsapp.net", t: String(Math.floor(Date.now() / 1000)), offline: "1" },
    content: [{ tag: "unavailable", attrs: { type: "view_once_unavailable_fanout" } }],
  };
  sock.ws.emit("CB:message,offline", node);
  sock.ws.emit("CB:message", node);
  sock.ws.emit("CB:message", node); // re-sent by WhatsApp
  // The "all sent" marker: Baileys releases its buffer and reports it.
  sock.ev.flush();
  sock.ev.emit("connection.update", { receivedPendingNotifications: true });
  await wait(600);
  const at = (id) => F.intakeOrder.indexOf(id);
  check(at("E6") >= 0 && at("VO-6") > at("E6"), `6: the view-once notice reached the handler before an earlier message (${F.intakeOrder.join(", ")})`);
  check(F.intakeOrder.filter((id) => id === "VO-6").length === 1, "6: the re-sent view-once notice reached the handler twice");
  const vo = F.unemitted.find((m) => m.key.id === "VO-6");
  check(vo?.key.remoteJid === "573001112233@s.whatsapp.net", `6: the notice's chat id kept the device (${vo?.key.remoteJid})`);
  check(s.isReady(), "6: the account did not become ready");
  await s.stop();
}

const result = { scenario: "client readiness (backlog, batches, connection epoch, view-once)", problems, ok: problems.length === 0 };
console.info(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
