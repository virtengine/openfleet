import { createServer } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";

import { TuiWsBridge } from "../../tui/lib/ws-bridge.mjs";
import { waitFor } from "./render-helpers.mjs";

describe("tui websocket bridge integration", () => {
  let httpServer;
  let wsServer;
  let port;
  let originalWebSocket;

  beforeEach(async () => {
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = WebSocket;

    httpServer = createServer();
    wsServer = new WebSocketServer({ server: httpServer, path: "/ws" });

    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    port = httpServer.address().port;
  });

  afterEach(async () => {
    globalThis.WebSocket = originalWebSocket;
    await new Promise((resolve) => wsServer.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
    vi.restoreAllMocks();
  });

  it("subscribes and maps canonical events to legacy listeners", async () => {
    const receivedMessages = [];
    wsServer.on("connection", (socket) => {
      socket.on("message", (raw) => {
        receivedMessages.push(JSON.parse(String(raw)));
        socket.send(JSON.stringify({
          type: "monitor:stats",
          payload: { tokensIn: 12, tokensOut: 8, tokensTotal: 20 },
        }));
        socket.send(JSON.stringify({
          type: "session:event",
          payload: {
            event: { kind: "state", reason: "session-started" },
            session: { id: "session-1", status: "active", title: "Bridge session" },
          },
        }));
        socket.send(JSON.stringify({
          type: "tasks:update",
          payload: {
            reason: "task-created",
            patch: { id: "task-1", title: "Wire the bridge", status: "todo" },
          },
        }));
      });
    });

    const bridge = new TuiWsBridge({
      host: "127.0.0.1",
      port,
      configDir: process.cwd(),
      WebSocketImpl: WebSocket,
    });

    const onStats = vi.fn();
    const onStart = vi.fn();
    const onTaskCreate = vi.fn();
    bridge.on("stats", onStats);
    bridge.on("session:start", onStart);
    bridge.on("task:create", onTaskCreate);

    bridge.connect();

    await waitFor(() => receivedMessages.length > 0);
    await waitFor(() => onStats.mock.calls.length > 0);
    await waitFor(() => onStart.mock.calls.length > 0);
    await waitFor(() => onTaskCreate.mock.calls.length > 0);

    expect(receivedMessages[0]).toEqual({
      type: "subscribe",
      channels: ["monitor", "stats", "sessions", "tasks", "workflows", "tui"],
    });
    expect(onStats).toHaveBeenCalledWith({ tokensIn: 12, tokensOut: 8, tokensTotal: 20 });
    expect(onStart).toHaveBeenCalledWith({ id: "session-1", status: "active", title: "Bridge session" });
    expect(onTaskCreate).toHaveBeenCalledWith({ id: "task-1", title: "Wire the bridge", status: "todo" });

    bridge.disconnect();
  });
});
