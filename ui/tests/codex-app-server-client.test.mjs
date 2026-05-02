import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];
  static autoOpen = true;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.autoOpen) queueMicrotask(() => this.open());
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(payload) {
    const message = JSON.parse(payload);
    this.sent.push(message);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", { code: 1000, reason: "closed" });
  }

  open() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open", {});
  }

  respond(message) {
    this.dispatch("message", { data: JSON.stringify(message) });
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

test("client reports open only after the initialize handshake", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  globalThis.WebSocket = FakeWebSocket;
  globalThis.window = { location: { protocol: "http:", host: "localhost" } };
  globalThis.localStorage = { getItem: () => null };
  FakeWebSocket.instances.length = 0;
  FakeWebSocket.autoOpen = true;

  t.after(() => {
    globalThis.WebSocket = previousWebSocket;
    globalThis.window = previousWindow;
    globalThis.localStorage = previousLocalStorage;
    FakeWebSocket.autoOpen = true;
  });

  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { CodexAppServerClient } = await vite.ssrLoadModule("/src/lib/codex-app-server-client.ts");
  const client = new CodexAppServerClient();
  const states = [];
  client.onConnectionChange((state) => states.push(state));

  const connected = client.connect();
  await new Promise((resolve) => setImmediate(resolve));

  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  assert.equal(client.connected, false);
  assert.deepEqual(states, []);
  assert.deepEqual(socket.sent.map((message) => message.method), ["initialize"]);

  socket.respond({
    id: socket.sent[0].id,
    result: { userAgent: "vibego-test", codexHome: "/tmp/codex", platformFamily: "test", platformOs: "test" },
  });
  await connected;

  assert.deepEqual(socket.sent.map((message) => message.method), ["initialize", "initialized"]);
  assert.deepEqual(states, ["open"]);
  assert.equal(client.connected, true);

  client.close();
  assert.equal(client.connected, false);
  const failingClient = new CodexAppServerClient();
  const failingStates = [];
  failingClient.onConnectionChange((state) => failingStates.push(state));
  const failingConnection = failingClient.connect();
  await new Promise((resolve) => setImmediate(resolve));

  const failingSocket = FakeWebSocket.instances[1];
  failingSocket.respond({
    id: failingSocket.sent[0].id,
    error: { code: -32000, message: "initialize failed" },
  });

  await assert.rejects(failingConnection, /initialize failed/);
  assert.deepEqual(failingStates, []);
  assert.equal(failingClient.connected, false);
  failingClient.close();

  const errorClient = new CodexAppServerClient();
  const errorStates = [];
  errorClient.onConnectionChange((state) => errorStates.push(state));
  const errorConnection = errorClient.connect();
  await new Promise((resolve) => setImmediate(resolve));
  const errorSocket = FakeWebSocket.instances[2];
  errorSocket.respond({
    id: errorSocket.sent[0].id,
    result: { userAgent: "vibego-test", codexHome: "/tmp/codex", platformFamily: "test", platformOs: "test" },
  });
  await errorConnection;
  assert.equal(errorClient.connected, true);

  errorSocket.dispatch("error", {});
  assert.equal(errorClient.connected, false);
  assert.deepEqual(errorStates, ["open", "error"]);
});

test("a superseded socket cannot complete a later connection", async (t) => {
  const previousWebSocket = globalThis.WebSocket;
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  globalThis.WebSocket = FakeWebSocket;
  globalThis.window = { location: { protocol: "http:", host: "localhost" } };
  globalThis.localStorage = { getItem: () => null };
  FakeWebSocket.instances.length = 0;
  FakeWebSocket.autoOpen = false;

  t.after(() => {
    globalThis.WebSocket = previousWebSocket;
    globalThis.window = previousWindow;
    globalThis.localStorage = previousLocalStorage;
    FakeWebSocket.autoOpen = true;
  });

  const vite = await createServer({ appType: "custom", server: { middlewareMode: true } });
  t.after(async () => {
    await vite.close();
  });

  const { CodexAppServerClient } = await vite.ssrLoadModule("/src/lib/codex-app-server-client.ts");
  const client = new CodexAppServerClient();
  const first = client.connect();
  await new Promise((resolve) => setImmediate(resolve));
  const oldSocket = FakeWebSocket.instances[0];
  assert.ok(oldSocket);

  const second = client.connect();
  await new Promise((resolve) => setImmediate(resolve));
  const newSocket = FakeWebSocket.instances[1];
  assert.ok(newSocket);

  oldSocket.readyState = FakeWebSocket.OPEN;
  oldSocket.dispatch("open", {});
  await assert.rejects(first, /superseded/);
  assert.deepEqual(oldSocket.sent, []);
  assert.deepEqual(newSocket.sent, []);

  newSocket.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(newSocket.sent.map((message) => message.method), ["initialize"]);
  newSocket.respond({
    id: newSocket.sent[0].id,
    result: { userAgent: "vibego-test", codexHome: "/tmp/codex", platformFamily: "test", platformOs: "test" },
  });
  await second;
  assert.deepEqual(newSocket.sent.map((message) => message.method), ["initialize", "initialized"]);
  client.close();
});
